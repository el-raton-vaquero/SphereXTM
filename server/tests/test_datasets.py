"""M4.5 identity, availability, HTTP and WCS regression checks.

Live-data tests use prepared REAL artifacts; no synthetic sky is evidence here.
"""
import json
from pathlib import Path
import shutil

from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS
from fastapi.testclient import TestClient
import numpy as np
import pytest

from spherex import datasets, service
from spherex.api import app


def test_registry_is_separate_and_pinned_to_checked_in_m4_evidence():
    entries = datasets.registry()
    assert list(entries) == ["m101", "wise0855-d6", "barnard-d2", "barnard-d6"]
    source = Path(__file__).resolve().parents[2] / "docs/m4-evidence.json"
    packaged = json.loads(datasets.EVIDENCE.read_text())
    assert packaged["source_sha256"] == datasets.sha256(source)
    original = json.loads(source.read_text())
    for entry in entries.values():
        if not entry["target_id"]:
            continue
        evidence = datasets.evidence_for(entry)
        candidate = next(c for c in original["candidates"] if c["target"]["id"] == entry["target_id"])
        detector = next(d for d in candidate["detectors"] if d["detector"] == entry["detector"])
        assert evidence["pair"] in detector["accepted"]
        assert all(p in detector["products"] for p in evidence["products"])
        assert evidence["target"] == candidate["target"]


def test_inventory_and_unavailable_have_no_remote_or_synthetic_fallback(tmp_path, monkeypatch):
    monkeypatch.setenv("SPHEREX_DATASETS_DIR", str(tmp_path / "cases"))
    monkeypatch.setenv("SPHEREX_DATA_DIR", str(tmp_path / "m101"))
    import spherex.archive as archive
    monkeypatch.setattr(archive, "fetch_bytes", lambda *args: pytest.fail("HTTP requested archive data"))
    client = TestClient(app)
    inventory = client.get("/datasets")
    assert inventory.status_code == 200
    assert len(inventory.json()) == 4
    assert all(d["status"] == "unavailable" and not d["available"] for d in inventory.json())
    for entry in inventory.json():
        result = client.get(f"/datasets/{entry['id']}/frames")
        assert result.status_code == 503
        assert "frames" not in result.json()
    assert client.get("/datasets/not-a-case/frames").status_code == 404


def test_offline_preparation_missing_cache_is_explicit_and_m101_untouched(tmp_path, monkeypatch):
    import spherex.archive as archive
    monkeypatch.setattr(archive, "fetch_bytes", lambda *args: pytest.fail("Offline made a request"))
    original = service.get_default_data_dir() / "aligned.fits"
    before = datasets.sha256(original) if original.exists() else None
    assert datasets.main(["--dataset", "wise0855-d6", "--offline", "--output", str(tmp_path)]) == 2
    assert not (tmp_path / "manifest.json").exists()
    if before:
        assert datasets.sha256(original) == before


@pytest.fixture
def real_cases():
    for entry in datasets.registry().values():
        if not datasets.verify(entry)[0]:
            pytest.skip("Prepare M101 and M4.5 cases before running real dataset checks")
    return datasets.registry()


@pytest.mark.dataset
@pytest.mark.parametrize("id,count", [("m101", 769), ("wise0855-d6", 761),
                                     ("barnard-d2", 802), ("barnard-d6", 730)])
def test_real_http_identity_mask_and_contract(real_cases, id, count):
    entry = real_cases[id]
    response = TestClient(app).get(f"/datasets/{id}/frames")
    assert response.status_code == 200
    data = response.json()
    assert [f["id"] for f in data["frames"]] == entry["observationIds"]
    assert data["dataset"]["id"] == id
    assert data["provenance"]["data_origin"] == "observed_spherex"
    assert data["provenance"]["motion_measured"] is False
    assert data["wcs"]["screenCrpix"] == [14.5, 14.5]
    assert sum(data["validMask"]) == count
    with fits.open(datasets.dataset_dir(entry) / "aligned.fits") as hdus:
        for index, frame in enumerate(data["frames"], 1):
            values = np.array(frame["pixelData"]).reshape(30, 30)
            valid = np.array(frame["validMask"]).reshape(30, 30).astype(bool)
            expected = np.flipud(hdus[f"IMAGE{index}"].data)
            np.testing.assert_allclose(values[valid], expected[valid])
            assert (values[~valid] == 0).all()
            assert np.isfinite(values).all()
            assert frame["detector"] == entry["detector"]
            assert frame["movingTargetPixel"] is None


@pytest.mark.dataset
@pytest.mark.parametrize("id", ["wise0855-d6", "barnard-d2", "barnard-d6"])
def test_real_predictions_transform_and_quality_not_detection(real_cases, id):
    entry = real_cases[id]
    response = datasets.frames(id)
    predictions = response.catalogPredictions
    evidence = datasets.evidence_for(entry)
    assert predictions["kind"] == "catalog_predicted"
    assert predictions["motionMeasured"] is False
    assert predictions["displacementArcsec"] == pytest.approx(evidence["pair"]["predicted_displacement_arcsec"], abs=1e-7)
    with fits.open(datasets.dataset_dir(entry) / "aligned.fits") as hdus:
        wcs = WCS(hdus["IMAGE1"].header)
        mask = hdus["VALID"].data
        for i, position in enumerate(predictions["positions"]):
            assert position["mjd"] == response.frames[i].mjd
            assert position["obsId"] == response.frames[i].id
            sky = wcs.pixel_to_world(position["x"], 29 - position["y"])
            expected = SkyCoord(position["ra"], position["dec"], unit="deg")
            assert sky.separation(expected).arcsec < 1e-7
            valid = bool(mask[round(29-position["y"]), round(position["x"])])
            assert valid == position["commonMaskValid"]
            assert position["nativeValid"] == (id == "wise0855-d6")
            if id.startswith("barnard"):
                assert not position["commonMaskValid"]
                assert {"BLOOM", "OVERFLOW"} <= set(position["nativeFlagNames"])


@pytest.mark.dataset
def test_m101_legacy_endpoint_is_unchanged(real_cases):
    client = TestClient(app)
    legacy = client.get("/frames?ra=210.80227&dec=54.34895&fov=3").json()
    selected = client.get("/datasets/m101/frames").json()
    assert legacy["dataset"] is None
    assert legacy["catalogPredictions"] is None
    assert selected["catalogPredictions"] is None
    assert legacy["frames"] == selected["frames"]
    assert legacy["epochs"] == selected["epochs"]
    assert legacy["validMask"] == selected["validMask"]


@pytest.mark.dataset
@pytest.mark.parametrize("mutation", ["identity", "provenance", "mask", "wcs", "checksum"])
def test_corrupt_prepared_cases_are_unavailable(real_cases, tmp_path, monkeypatch, mutation):
    entry = real_cases["wise0855-d6"]
    path = tmp_path / entry["id"]
    path.mkdir()
    for name in ("manifest.json", "aligned.fits"):
        shutil.copyfile(datasets.dataset_dir(entry) / name, path / name)
    manifest = json.loads((path / "manifest.json").read_text())
    if mutation == "identity":
        manifest["comparison"]["observations"][0]["obs_id"] = "NOT_THE_PINNED_PAIR"
    elif mutation == "provenance":
        manifest["comparison"]["observations"][0]["source_sha256"] = "wrong"
    elif mutation in ("mask", "wcs"):
        with fits.open(path / "aligned.fits", mode="update") as hdus:
            if mutation == "mask":
                hdus["VALID"].data[0, 0] = 2
            else:
                hdus["IMAGE1"].header["CDELT2"] *= -1
        manifest["aligned_sha256"] = datasets.sha256(path / "aligned.fits")
    else:
        manifest["aligned_sha256"] = "wrong"
    (path / "manifest.json").write_text(json.dumps(manifest))
    monkeypatch.setenv("SPHEREX_DATASETS_DIR", str(tmp_path))
    assert not datasets.summary(entry).available
    assert TestClient(app).get(f"/datasets/{entry['id']}/frames").status_code == 503


@pytest.mark.dataset
def test_exact_pair_can_be_reprepared_without_research_campaign(real_cases, tmp_path):
    entry = real_cases["wise0855-d6"]
    source = Path(__file__).resolve().parents[1] / "outputs/m4"
    if not source.exists():
        pytest.skip("Original M4 cache needed for import test")
    result = datasets.prepare(entry["id"], tmp_path, research_dir=source, offline=True)
    assert result == tmp_path
    assert datasets.verify(entry, tmp_path)[0]
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    evidence = datasets.evidence_for(entry)
    assert len(manifest["downloads"]) == 2
    assert manifest["comparison"]["spectrally_matched_fraction_of_grid"] == evidence["pair"]["spectrally_matched_fraction_of_grid"]
