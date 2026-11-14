"""Prepared, pinned field comparisons. No discovery or downloads in HTTP paths.

The catalog candidate registry is NOT an image registry. Only pairs promoted from
the checked-in M4 evidence are eligible here. M101 keeps its original preparation
and /frames behavior. M4 acquisition is a separate, opt-in CLI.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS
import numpy as np

from spherex import service
from spherex.alignment import align_pair, pair_score, save_comparison
from spherex.archive import MAX_FILE_BYTES, download_cutout, utc_now, write_json
from spherex.fits import inspect_cutout
from spherex.models import DatasetModel
from spherex.research import local_diagnostic
from spherex.targets import predict

DATA = Path(__file__).with_name("data")
REGISTRY = DATA / "datasets.json"
EVIDENCE = DATA / "dataset-evidence.json"


def registry():
    entries = json.loads(REGISTRY.read_text())
    if len({e["id"] for e in entries}) != len(entries):
        raise ValueError("Duplicate dataset identity")
    return {e["id"]: e for e in entries}


def evidence_for(entry):
    evidence = json.loads(EVIDENCE.read_text())["datasets"][entry["id"]]
    if (evidence["pair"]["status"] != "comparable_pair_validated"
            or evidence["pair"]["obs_ids"] != entry["observationIds"]
            or [p["obs_id"] for p in evidence["products"]] != entry["observationIds"]
            or any(o["detector"] != entry["detector"] for o in evidence["observations"])
            or abs(evidence["center"]["ra_deg"] - entry["ra"]) > 1e-10
            or abs(evidence["center"]["dec_deg"] - entry["dec"]) > 1e-10):
        raise ValueError("Registry does not match the promoted M4 evidence")
    return evidence


def dataset_root():
    return Path(os.environ.get("SPHEREX_DATASETS_DIR", Path(__file__).resolve().parents[1] / "outputs/datasets"))


def dataset_dir(entry):
    return service.get_default_data_dir() if entry["id"] == "m101" else dataset_root() / entry["id"]


def sha256(path):
    path = Path(path)
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("Dataset artifact exceeds the 16 MiB verification budget")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(65536):
            digest.update(chunk)
    return digest.hexdigest()


def verify(entry, path=None):
    """Validate tiny prepared artifacts on each read; never trust a status flag alone."""
    path = Path(path) if path is not None else dataset_dir(entry)
    usable, reason = service.verify_dataset_usability(path)
    if not usable:
        return False, reason
    try:
        manifest = json.loads((path / "manifest.json").read_text())
        comp = manifest["comparison"]
        observations = comp["observations"]
        if [o["obs_id"] for o in observations] != entry["observationIds"]:
            raise ValueError("Observation identities differ from registered pair")
        if any(o["detector"] != entry["detector"] for o in observations):
            raise ValueError("Wrong detector")
        if entry["id"] != "m101":
            evidence = evidence_for(entry)
            if manifest["dataset_id"] != entry["id"] or manifest["evidence_sha256"] != sha256(EVIDENCE):
                raise ValueError("Dataset evidence identity changed; prepare again")
            if manifest["aligned_sha256"] != sha256(path / "aligned.fits"):
                raise ValueError("Aligned FITS checksum mismatch")
            for actual, expected, product in zip(observations, evidence["observations"],
                                                 evidence["products"], strict=True):
                if (actual["source_sha256"] != product["sha256"]
                        or actual["access_url"] != product["url"].split("?")[0]
                        or actual["date_obs_utc"] != expected["date_obs_utc"]
                        or abs(actual["mjd_obs"] - expected["mjd_obs"]) > 1e-8):
                    raise ValueError("Source provenance mismatch")
                for key in ("wavelength_um_approx", "bandwidth_um_approx"):
                    if not np.isclose(actual[key], expected[key], atol=1e-8, rtol=0):
                        raise ValueError("Spectral metadata mismatch")
                if (actual["predicted_local"]["native_valid"] != expected["predicted_local"]["native_valid"]
                        or actual["predicted_local"]["native_flag_names"] != expected["predicted_local"]["native_flag_names"]):
                    raise ValueError("Predicted source quality differs from M4 evidence")
        if (comp["time_separation_days"] < 30 or comp["spectrally_matched_fraction_of_grid"] < .8
                or comp.get("matched_max_offset_in_bandwidths", 1) > .25):
            raise ValueError("Scientific threshold not met")
        with fits.open(path / "aligned.fits", memmap=False) as hdus:
            mask = hdus["VALID"].data
            if not np.isin(mask, [0, 1]).all():
                raise ValueError("Nonbinary mask")
            if not np.isclose(mask.mean(), comp["spectrally_matched_fraction_of_grid"], atol=1e-8):
                raise ValueError("Mask and coverage disagree")
            for index, observation in enumerate(observations, 1):
                hdu = hdus[f"IMAGE{index}"]
                if hdu.header["OBSID"] != observation["obs_id"]:
                    raise ValueError("FITS observation identity mismatch")
                if not np.isfinite(hdu.data[mask == 1]).all() or not np.isnan(hdu.data[mask == 0]).all():
                    raise ValueError("Invalid science/mask relationship")
                if hdu.header["BUNIT"] != "MJy / sr":
                    raise ValueError("Unexpected units")
                grid = WCS(hdu.header)
                expected_grid = WCS(fits.Header.fromstring(comp["output_wcs_header"], sep="\n"))
                if (not all(np.allclose(getattr(grid.wcs, key), getattr(expected_grid.wcs, key),
                                        atol=1e-10, rtol=0)
                            for key in ("crpix", "crval", "cdelt"))
                        or not np.allclose(grid.wcs.get_pc(), expected_grid.wcs.get_pc(), atol=1e-10)
                        or grid.wcs.radesys != "ICRS"):
                    raise ValueError("Grid does not match manifest WCS")
                if (grid.wcs.ctype[0] != "RA---TAN" or grid.wcs.ctype[1] != "DEC--TAN"
                        or grid.wcs.cdelt[0] >= 0 or grid.wcs.cdelt[1] <= 0
                        or not np.isclose(abs(grid.wcs.cdelt[0]), grid.wcs.cdelt[1])
                        or abs(grid.wcs.crval[0] - entry["ra"]) > 1e-8
                        or abs(grid.wcs.crval[1] - entry["dec"]) > 1e-8):
                    raise ValueError("Unsupported or displaced WCS")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return False, str(exc)
    return True, None


def summary(entry):
    usable, reason = verify(entry)
    return DatasetModel(**{k: entry[k] for k in DatasetModel.model_fields
                           if k in entry}, available=usable,
                        status="prepared" if usable else "unavailable", reason=reason)


def catalog_predictions(entry, comp, path):
    evidence = evidence_for(entry)
    target = evidence["target"]
    with fits.open(path / "aligned.fits", memmap=False) as hdus:
        grid = WCS(hdus["IMAGE1"].header)
        mask = hdus["VALID"].data.astype(bool)
        height, width = mask.shape
    positions = []
    coords = []
    for i, obs in enumerate(comp["observations"]):
        coord = predict(target, obs["mjd_obs"])
        coords.append(coord)
        x, fits_y = map(float, grid.world_to_pixel(coord))
        y = height - 1 - fits_y
        in_bounds = -.5 <= x < width-.5 and -.5 <= fits_y < height-.5
        valid = bool(mask[int(np.floor(fits_y+.5)), int(np.floor(x+.5))]) if in_bounds else False
        positions.append({
            "obsId": obs["obs_id"], "epochIndex": i, "mjd": obs["mjd_obs"],
            "date": obs["date_obs_utc"], "ra": float(coord.ra.deg), "dec": float(coord.dec.deg),
            "x": x, "y": y, "inBounds": in_bounds, "commonMaskValid": valid,
            "nativeValid": obs["predicted_local"]["native_valid"],
            "nativeFlagNames": obs["predicted_local"]["native_flag_names"],
        })
    return {
        "kind": "catalog_predicted", "motionMeasured": False,
        "reference": target["identifier"], "references": target["references"],
        "astrometry": target,
        "limitations": target.get("limitations", []) + [
            "No observer annual parallax, orbits or covariance propagation",
            ("Unknown radial velocity explicitly assumed zero; not a measured velocity"
             if target.get("radial_velocity_kms") is None else "Catalog radial velocity included in space-motion propagation"),
            "Pixel coordinates: zero-based centers, north-up screen; add 0.5 for SVG cell centers",
        ],
        "displacementArcsec": float(coords[0].separation(coords[1]).arcsec),
        "positions": positions,
    }


def frames(dataset_id):
    entry = registry().get(dataset_id)
    if entry is None:
        raise KeyError(dataset_id)
    ready = summary(entry)
    if not ready.available:
        raise ValueError(ready.reason)
    path = dataset_dir(entry)
    response = service.load_aligned_frames(target_name=entry["name"], data_dir=path)
    response.target.description = entry["description"]
    response.target.category = {"reference": "Standard", "exploratory": "Brown Dwarf",
                                "instrumental_limit": "High Proper Motion"}[entry["classification"]]
    response.dataset = ready.model_dump()
    with fits.open(path / "aligned.fits", memmap=False) as hdus:
        header = hdus["IMAGE1"].header
        response.wcs.screenCrpix = [float(header["CRPIX1"]) - 1,
                                   hdus["IMAGE1"].shape[0] - float(header["CRPIX2"])]
    response.provenance.update(
        dataset_id=dataset_id,
        collections=sorted({f.provenance["collection"] for f in response.frames}),
        limitations=response.provenance["limitations"] + entry["warnings"],
        motion_measured=False,
    )
    if entry["target_id"]:
        comp = json.loads((path / "manifest.json").read_text())["comparison"]
        response.catalogPredictions = catalog_predictions(entry, comp, path)
        for frame, observation in zip(response.frames, comp["observations"], strict=True):
            frame.provenance.update(source_sha256=observation["source_sha256"],
                                    retrieved_utc=observation["retrieved_utc"],
                                    predicted_local=observation["predicted_local"])
    return response


def prepare(dataset_id, output=None, research_dir=None, offline=False, timeout=30):
    """Download ONLY two pinned products, or import a verified M4 cache; no SIA."""
    entry = registry()[dataset_id]
    if dataset_id == "m101":
        raise ValueError("Use the unchanged python -m spherex.prepare for M101")
    output = Path(output) if output is not None else dataset_dir(entry)
    if verify(entry, output)[0]:
        return output
    evidence = evidence_for(entry)
    output.mkdir(parents=True, exist_ok=True)
    observations, downloads = [], []
    for product, expected in zip(evidence["products"], evidence["observations"], strict=True):
        if research_dir is not None:
            source = Path(research_dir) / entry["target_id"] / f"d{entry['detector']}"
            key = hashlib.sha256(product["url"].encode()).hexdigest()[:20]
            source_path = source / f"{key}.fits"
            if source_path.exists() and not (output / source_path.name).exists():
                if sha256(source_path) != product["sha256"]:
                    raise ValueError("Research cache differs from pinned source hash")
                # download_cutout performs sidecar checks as well, even offline.
                download_cutout(product["url"], source, timeout, offline=True)
                shutil.copyfile(source_path, output / source_path.name)
                shutil.copyfile(source_path.with_suffix(".json"), output / source_path.with_suffix(".json").name)
        path, provenance = download_cutout(product["url"], output, timeout, offline=offline)
        if provenance["sha256"] != product["sha256"] or path.stat().st_size != product["bytes"]:
            raise ValueError("IRSA product does not match the M4-pinned bytes")
        predicted = predict(evidence["target"], expected["mjd_obs"])
        row = {"obs_id": expected["obs_id"], "t_min": str(expected["mjd_obs"]),
               "energy_bandpassname": f"SPHEREx-D{entry['detector']}",
               "obs_collection": expected["collection"], "access_url": product["url"].split("?")[0]}
        obs = inspect_cutout(path, row, predicted)
        obs.metadata.update(source_sha256=provenance["sha256"], retrieved_utc=provenance["retrieved_utc"])
        obs.metadata["predicted_local"] = local_diagnostic(obs, path, predicted)
        observations.append(obs)
        downloads.append(provenance)
    a, b = observations
    if pair_score(a.metadata, b.metadata, 30, .25) is None:
        raise ValueError("Pinned pair fails unchanged spectral/time criteria")
    grid, arrays, matched, metrics = align_pair(a, b, SkyCoord(entry["ra"], entry["dec"], unit="deg"), 3, .25)
    if metrics["spectrally_matched_fraction_of_grid"] < .8:
        raise ValueError("Pinned pair fails unchanged 80% common coverage threshold")
    if not np.isclose(metrics["spectrally_matched_fraction_of_grid"],
                      evidence["pair"]["spectrally_matched_fraction_of_grid"], atol=1e-8):
        raise ValueError("Coverage does not reproduce M4 evidence")
    # Publish complete aligned FITS + manifest last, never an intermediate candidate.
    with tempfile.TemporaryDirectory(dir=output) as staging:
        stage = Path(staging)
        display = save_comparison(stage, a, b, grid, arrays, matched)
        manifest = {
            "status": "visualization_pair_validated", "dataset_id": dataset_id,
            "data_kind": "observed_spherex", "prepared_utc": utc_now(),
            "evidence_source": "docs/m4-evidence.json", "evidence_sha256": sha256(EVIDENCE),
            "offline": offline, "downloads": downloads,
            "comparison": {**metrics, **display, "observations": [o.metadata for o in observations]},
            "aligned_sha256": sha256(stage / "aligned.fits"),
        }
        write_json(stage / "manifest.json", manifest)
        valid, reason = verify(entry, stage)
        if not valid:
            raise ValueError(reason)
        for name in ("aligned.fits", "comparison.png", "manifest.json"):
            os.replace(stage / name, output / name)
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, choices=[k for k in registry() if k != "m101"])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--research-dir", type=Path)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args(argv)
    if not 1 <= args.timeout <= 180:
        parser.error("timeout must be between 1 and 180 seconds")
    try:
        path = prepare(args.dataset, args.output, args.research_dir, args.offline, args.timeout)
        print(f"Prepared {args.dataset}: {path}")
        return 0
    except (OSError, ValueError, RuntimeError, KeyError) as exc:
        print(f"Unavailable {args.dataset}: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
