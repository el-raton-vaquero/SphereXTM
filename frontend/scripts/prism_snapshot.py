"""Build a PRISM cached snapshot (/snapshots/<id>.json) from REAL SPHEREx data.

Dev/offline tool for the /prism explorer. It reuses the verified server modules
(`spherex.archive`, `spherex.fits`) and writes a JSON file whose `search` member
follows the V2 `/v2/search` contract, plus optional `gaia`, `spectrum` and
`verdict` members. Nothing here is synthetic: every pixel comes from an IRSA
Level-2 cutout, every catalog position from Gaia DR3 TAP (labelled predicted),
and every photometric point from forced aperture photometry on the cutout.
When a step cannot be computed it is omitted or marked 'na' - never invented.

Run from server/ so the `spherex` package and the locked env resolve:

    uv run --locked python ../frontend/scripts/prism_snapshot.py \
        --id wise-0855 --registry wise0855 --fov 4 --max-frames 60 \
        --out ../frontend/public/snapshots/wise-0855.json

FITS cutouts are cached under --cache (default: server/outputs/prism-cache,
ignored by git).
"""
from __future__ import annotations

import argparse
import base64
import csv
from concurrent.futures import ThreadPoolExecutor, as_completed
import io
import json
import math
from pathlib import Path
import sys
from urllib.parse import urlencode

from astropy import units as u
from astropy.coordinates import Distance, SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.wcs.utils import proj_plane_pixel_scales
import numpy as np
from reproject import reproject_interp

from spherex.archive import (MAX_QUERY_BYTES, SIA_URL, cutout_url, download_cutout,
                             fetch_bytes, parse_sia, utc_now)
from spherex.alignment import common_grid
from spherex.fits import inspect_cutout

CITATION = ("This work uses data from SPHEREx, a joint project of NASA JPL and Caltech, "
            "obtained from the NASA/IPAC Infrared Science Archive (IRSA).")
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
PIXSCALE = 6.15
SEASON_GAP_DAYS = 60.0


def b64(array: np.ndarray, dtype: str) -> str:
    return base64.b64encode(np.ascontiguousarray(array.astype(dtype)).tobytes()).decode()


def flag_bits(header: fits.Header) -> dict[str, int]:
    return {str(header[k]): int(k[4:]) for k in header if k.startswith("MSKN")}


def flag_names(value: int, bits: dict[str, int]) -> list[str]:
    return sorted(name for name, bit in bits.items() if value & (1 << bit))


def query_sia(ra: float, dec: float, collections: list[str], timeout: float) -> tuple[list[dict], list[str]]:
    rows, urls = [], []
    for collection in collections:
        url = SIA_URL + "?" + urlencode({"COLLECTION": collection,
                                         "POS": f"circle {ra} {dec} 0.01",
                                         "RESPONSEFORMAT": "VOTable"})
        urls.append(url)
        try:
            found = parse_sia(fetch_bytes(url, MAX_QUERY_BYTES, timeout))
        except Exception as exc:  # recorded, never replaced
            print(f"SIA {collection} failed: {exc}", file=sys.stderr)
            continue
        rows += [r for r in found if r.get("dataproduct_subtype") == "science"]
    seen, unique = set(), []
    for row in sorted(rows, key=lambda r: float(r["t_min"])):
        key = (row["obs_id"], row["energy_bandpassname"])
        if key not in seen:
            seen.add(key)
            unique.append(row)
    return unique, urls


def choose(rows: list[dict], limit: int) -> list[dict]:
    """Deterministic stratified sample: per detector, evenly spaced in time."""
    by_det: dict[str, list[dict]] = {}
    for row in rows:
        by_det.setdefault(row["energy_bandpassname"], []).append(row)
    quota = max(1, limit // max(1, len(by_det)))
    chosen = []
    for det in sorted(by_det):
        items = by_det[det]
        if len(items) <= quota:
            chosen += items
        else:
            idx = np.unique(np.linspace(0, len(items) - 1, quota).round().astype(int))
            chosen += [items[i] for i in idx]
    return sorted(chosen, key=lambda r: float(r["t_min"]))[:limit]


def seasons_of(mjds: list[float]) -> list[int]:
    order = np.argsort(mjds)
    labels = [0] * len(mjds)
    season, last = 0, None
    for i in order:
        if last is not None and mjds[i] - last > SEASON_GAP_DAYS:
            season += 1
        labels[i] = season
        last = mjds[i]
    return labels


def photometry(path: Path, coord: SkyCoord, aperture_arcsec: float, bits: dict[str, int]):
    """Forced aperture photometry with local median annulus. Returns mJy and err."""
    with fits.open(path, memmap=False) as hdus:
        from astropy.wcs import WCS
        wcs = WCS(hdus["IMAGE"].header)
        image = hdus["IMAGE"].data.astype(float)
        var = hdus["VARIANCE"].data.astype(float)
        flags = hdus["FLAGS"].data.astype(np.int64)
    x, y = (float(v) for v in wcs.world_to_pixel(coord))
    scale = proj_plane_pixel_scales(wcs) * 3600
    omega = float(np.prod(scale)) * (u.arcsec ** 2).to(u.sr)
    yy, xx = np.indices(image.shape)
    r = np.hypot(xx - x, yy - y) * float(np.mean(scale))
    ap = r <= aperture_arcsec
    ann = (r >= aperture_arcsec + 9) & (r <= aperture_arcsec + 27)
    good = np.isfinite(image) & np.isfinite(var) & (var > 0)
    if ap.sum() == 0 or (ap & ~good).any() or (ann & good).sum() < 8:
        return None
    bg_pixels = image[ann & good]
    bg = float(np.median(bg_pixels))
    bg_err = 1.2533 * float(np.std(bg_pixels)) / math.sqrt(len(bg_pixels))
    n = int(ap.sum())
    flux = float(np.sum(image[ap] - bg)) * omega * 1e9  # MJy -> mJy
    err = math.sqrt(float(np.sum(var[ap])) + (n * bg_err) ** 2) * omega * 1e9
    ored = int(np.bitwise_or.reduce(flags[ap].ravel()))
    names = flag_names(ored, bits)
    return {"flux": flux, "err": err, "flags": names,
            "saturated": "OVERFLOW" in names, "n_pix": n}


def gaia_sources(ra: float, dec: float, radius_deg: float, mjds: list[float], timeout: float):
    adql = ("SELECT TOP 400 source_id,ra,dec,ref_epoch,pmra,pmdec,parallax,parallax_over_error,phot_g_mean_mag "
            "FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT('ICRS',ra,dec),"
            f"CIRCLE('ICRS',{ra},{dec},{radius_deg})) AND phot_g_mean_mag < 20 ORDER BY phot_g_mean_mag")
    url = GAIA_TAP + "?" + urlencode({"REQUEST": "doQuery", "LANG": "ADQL",
                                      "FORMAT": "csv", "QUERY": adql})
    text = fetch_bytes(url, MAX_QUERY_BYTES, timeout).decode()
    out = []
    times = Time(sorted(set(mjds)), format="mjd", scale="utc")
    for row in csv.DictReader(io.StringIO(text)):
        def num(key):
            return float(row[key]) if row.get(key) not in (None, "") else None
        pmra, pmdec, plx = num("pmra"), num("pmdec"), num("parallax")
        has_motion = pmra is not None and pmdec is not None
        kwargs = {}
        if has_motion:
            kwargs = dict(pm_ra_cosdec=pmra * u.mas / u.yr, pm_dec=pmdec * u.mas / u.yr,
                          distance=Distance(parallax=(plx if plx and plx > 0.05 else 0.05) * u.mas),
                          radial_velocity=0 * u.km / u.s)
        c = SkyCoord(ra=float(row["ra"]) * u.deg, dec=float(row["dec"]) * u.deg, frame="icrs",
                     obstime=Time(float(row["ref_epoch"]), format="jyear", scale="tcb"), **kwargs)
        if has_motion:
            moved = c.apply_space_motion(new_obstime=times)
            positions = [{"mjd": float(t.mjd), "ra": float(p.ra.deg), "dec": float(p.dec.deg)}
                         for t, p in zip(times, moved)]
        else:
            positions = [{"mjd": float(t.mjd), "ra": float(c.ra.deg), "dec": float(c.dec.deg)}
                         for t in times]
        out.append({"source_id": row["source_id"], "ra": float(row["ra"]), "dec": float(row["dec"]),
                    "ref_epoch": float(row["ref_epoch"]), "pmra": pmra, "pmdec": pmdec,
                    "parallax": plx, "parallax_over_error": num("parallax_over_error"),
                    "phot_g_mean_mag": num("phot_g_mean_mag"),
                    "propagated": has_motion, "positions": positions})
    return out, url


def is_stellar(src: dict | None) -> bool:
    """Significant Gaia parallax (>5 sigma, >0.5 mas): a star, not e.g. a galaxy nucleus with a spurious solution."""
    return bool(src and src.get("parallax") is not None and (src.get("parallax_over_error") or 0) > 5
                and src["parallax"] > 0.5)


def reverdict(path: Path, timeout: float) -> None:
    """Refresh parallax significance for the matched Gaia source and recompute the verdict in place."""
    snap = json.loads(path.read_text(encoding="utf-8"))
    check = next(c for c in snap["verdict"]["checks"] if c["id"] == "gaia")
    if check["status"] != "pass":
        return
    sid = check["detail"].split()[2]
    src = next(x for x in snap["gaia"]["sources"] if x["source_id"] == sid)
    if src.get("parallax_over_error") is None:
        adql = f"SELECT source_id,parallax_over_error FROM gaiadr3.gaia_source WHERE source_id={int(sid)}"
        url = GAIA_TAP + "?" + urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql})
        row = next(csv.DictReader(io.StringIO(fetch_bytes(url, MAX_QUERY_BYTES, timeout).decode())))
        src["parallax_over_error"] = float(row["parallax_over_error"]) if row["parallax_over_error"] else None
    v = snap["verdict"]
    if v["verdict"] in ("known_star", "inconclusive"):
        stellar = is_stellar(src)
        sat = next(c for c in v["checks"] if c["id"] == "saturation")["status"] == "fail"
        v["verdict"], v["confidence"] = ("known_star", 0.6 if sat else 0.75) if stellar else ("inconclusive", 0.4)
        note = ("" if stellar else "A Gaia DR3 source without significant parallax is at the position: catalogued, "
                "but not necessarily a star. ")
        v["summary"] = note + ("Rule-based summary of the checks above computed by the snapshot generator; "
                               "checks marked 'na' were not evaluated. Not a discovery claim.")
        v["method"] = "prism_snapshot.py rules v1"
    path.write_text(json.dumps(snap, allow_nan=False, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(path.name, v["verdict"], src.get("parallax"), src.get("parallax_over_error"), file=sys.stderr)


def registry_center(registry_id: str, mjd: float) -> tuple[dict, SkyCoord]:
    from spherex.targets import REGISTRY, predict
    # Read as UTF-8 explicitly (targets.load_targets uses the platform default, cp1252 on Windows).
    target = {t["id"]: t for t in json.loads(REGISTRY.read_text(encoding="utf-8"))}[registry_id]
    return target, predict(target, mjd)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--id", required=True)
    p.add_argument("--name")
    p.add_argument("--ra", type=float)
    p.add_argument("--dec", type=float)
    p.add_argument("--registry", help="server/spherex/data/m4-targets.json id; centre = prediction at mid-survey")
    p.add_argument("--pm-ra", type=float, help="linear track: pm_ra_cosdec mas/yr (with --pm-dec), position given at --pm-mjd")
    p.add_argument("--pm-dec", type=float)
    p.add_argument("--pm-mjd", type=float, default=60900.0)
    p.add_argument("--pm-source", default="SIMBAD via CDS Sesame")
    p.add_argument("--fov", type=float, default=4.0)
    p.add_argument("--max-frames", type=int, default=60)
    p.add_argument("--aperture", type=float, default=9.0)
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--timeout", type=float, default=60)
    p.add_argument("--collections", default="spherex_dr1,spherex_qr3")
    p.add_argument("--cache", default="outputs/prism-cache")
    p.add_argument("--out", required=True)
    p.add_argument("--reverdict", action="store_true", help="only refresh the Gaia-parallax verdict rule of an existing --out file")
    args = p.parse_args(argv)
    if args.reverdict:
        reverdict(Path(args.out), args.timeout)
        return 0

    registry = None
    if args.registry:
        registry, center = registry_center(args.registry, 60900.0)
        ra, dec = float(center.ra.deg), float(center.dec.deg)
        name = args.name or registry["name"]
    else:
        ra, dec, name = args.ra, args.dec, args.name or args.id
    coord = SkyCoord(ra * u.deg, dec * u.deg)
    track = None
    if registry:
        from spherex.targets import predict

        def track(mjd):
            q = predict(registry, mjd)
            return SkyCoord(q.ra, q.dec)
    elif args.pm_ra is not None and args.pm_dec is not None:
        def track(mjd):
            yr = (mjd - args.pm_mjd) / 365.25
            return SkyCoord((ra + args.pm_ra / 3.6e6 * yr / math.cos(math.radians(dec))) * u.deg,
                            (dec + args.pm_dec / 3.6e6 * yr) * u.deg)
        registry = {"id": args.id, "name": name, "identifier": None,
                    "references": [args.pm_source],
                    "limitations": ["Linear proper motion only; parallax, RV and orbital motion not modelled."],
                    "pm_ra_cosdec_masyr": args.pm_ra, "pm_dec_masyr": args.pm_dec}
    collections = args.collections.split(",")
    rows, query_urls = query_sia(ra, dec, collections, args.timeout)
    print(f"{len(rows)} science rows", file=sys.stderr)
    chosen = choose(rows, args.max_frames)
    cache = Path(args.cache) / args.id  # per-target dir: archive.py caps each dir at 256 MiB
    cache.mkdir(parents=True, exist_ok=True)
    size = args.fov * 1.5

    def fetch(row):
        url = cutout_url(row["access_url"], ra, dec, size)
        path, meta = download_cutout(url, cache, args.timeout)
        return row, path, url

    downloaded, failures = [], []
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(fetch, r) for r in chosen]
        for fut in as_completed(futures):
            try:
                downloaded.append(fut.result())
            except Exception as exc:
                failures.append(str(exc)[:200])
                print("download failed:", str(exc)[:200], file=sys.stderr)
    grid, shape = common_grid(coord, args.fov, PIXSCALE)
    n = shape[0]
    frames, points, bits_all = [], [], {}
    for row, path, url in sorted(downloaded, key=lambda t: float(t[0]["t_min"])):
        try:
            obs = inspect_cutout(path, row, coord)
        except Exception as exc:
            failures.append(f"{row['obs_id']}: {exc}"[:200])
            continue
        with fits.open(path, memmap=False) as hdus:
            raw_flags = hdus["FLAGS"].data.astype(np.float64)
            bits = flag_bits(hdus["FLAGS"].header)
            var = hdus["VARIANCE"].data.astype(float)
        bits_all.update(bits)
        good = np.isfinite(obs.image) & np.isfinite(var) & (var > 0)
        image = np.where(good, obs.image, np.nan)
        proj, foot = reproject_interp((image, obs.wcs), grid, shape_out=shape)
        fproj, _ = reproject_interp((raw_flags, obs.wcs), grid, shape_out=shape, order="nearest-neighbor")
        proj = np.where(foot > 0, proj, np.nan)
        fproj = np.where(np.isfinite(fproj), fproj, 0).astype(np.uint32)
        # API orientation: row 0 = North (FITS origin is lower = South).
        pix, flg = np.flipud(proj), np.flipud(fproj)
        c = n // 2
        core = flg[c - 1:c + 2, c - 1:c + 2]
        overflow = 1 << bits.get("OVERFLOW", 1)
        md = obs.metadata
        frame = {
            "id": f"{md['obs_id']}_D{md['detector']}",
            "collection": md["collection"], "mjd": md["mjd_obs"],
            "date": md["date_obs_utc"], "season": 0, "detector": md["detector"],
            "lambda_um": md["wavelength_um_approx"], "bandwidth_um": md["bandwidth_um_approx"],
            "pixels_b64": b64(pix, "<f4"), "flags_b64": b64(flg, "<u4"),
            "saturated_at_center": bool(np.any(core & overflow)),
            "valid_fraction": float(np.isfinite(pix).mean()),
            "center_flags": flag_names(int(np.bitwise_or.reduce(core.ravel())), bits),
            "provenance": {"url": url, "obs_id": md["obs_id"],
                           "access_url": row["access_url"]},
        }
        frames.append(frame)
        phot_coord = coord
        if track:  # follow the catalogue-predicted track so proper motion is not read as fading
            phot_coord = track(md["mjd_obs"])
        phot = photometry(path, phot_coord, args.aperture, bits)
        if phot:
            points.append({"lambda_um": md["wavelength_um_approx"], "flux": phot["flux"],
                           "err": phot["err"], "unit": "mJy", "mjd": md["mjd_obs"], "season": 0,
                           "detector": md["detector"], "frame_id": frame["id"],
                           "flags": phot["flags"], "saturated": phot["saturated"]})
    if not frames:
        print("No usable frames; refusing to write an empty snapshot", file=sys.stderr)
        return 2
    labels = seasons_of([f["mjd"] for f in frames])
    for f, s in zip(frames, labels):
        f["season"] = s
    season_of = {f["id"]: f["season"] for f in frames}
    for pt in points:
        pt["season"] = season_of[pt["frame_id"]]
    seasons = []
    for s in sorted(set(labels)):
        ms = [f["mjd"] for f in frames if f["season"] == s]
        seasons.append({"index": s, "start_mjd": min(ms), "end_mjd": max(ms), "n_frames": len(ms)})
    detectors = []
    for d in sorted({f["detector"] for f in frames}):
        ls = [f["lambda_um"] for f in frames if f["detector"] == d]
        detectors.append({"detector": d, "n_frames": len(ls), "lambda_min": min(ls), "lambda_max": max(ls)})
    cd = grid.wcs.cdelt
    generated = utc_now()
    search = {
        "query": {"ra": ra, "dec": dec, "fov": args.fov, "max_frames": args.max_frames,
                  "collections": collections},
        "grid": {"n": n, "pixscale_arcsec": PIXSCALE,
                 "wcs": {"crval": [ra, dec], "crpix": [float(grid.wcs.crpix[0]), float(grid.wcs.crpix[1])],
                         "cd": [[float(cd[0]), 0.0], [0.0, float(cd[1])]]},
                 "north_up": True},
        "frames": frames, "seasons": seasons, "detectors": detectors,
        "flag_bits": bits_all,
        "provenance": {"citation": CITATION, "collections": collections, "query_urls": query_urls,
                       "generated_utc": generated, "n_rows_found": len(rows),
                       "n_selected": len(chosen), "failures": failures,
                       "processing": ("IRSA IBE cutout -> reproject_interp (bilinear) onto north-up TAN grid; "
                                      "NaN = no coverage, non-finite IMAGE or VARIANCE<=0; FLAGS reprojected "
                                      "nearest-neighbour and NOT applied to pixels; lambda = WCS-WAVE at "
                                      "target (approximate, not calibrated CWAVE)."),
                       "generator": "frontend/scripts/prism_snapshot.py"},
        "cache": "cached",
    }
    snapshot = {"kind": "prism-snapshot", "version": 1, "id": args.id, "name": name,
                "generated_utc": generated, "search": search}

    # Gaia DR3 (predicted positions per frame epoch).
    radius = args.fov / 60 * 0.75 + (0.04 if registry else 0.01)
    try:
        sources, gaia_url = gaia_sources(ra, dec, radius, [f["mjd"] for f in frames], args.timeout)
        snapshot["gaia"] = {"sources": sources, "kind": "catalog_predicted",
                            "provenance": {"query_url": gaia_url, "catalog": "Gaia DR3",
                                           "method": "astropy SkyCoord.apply_space_motion (pm + parallax, RV=0)"}}
    except Exception as exc:
        snapshot["gaia_error"] = str(exc)[:300]
        sources = []
    if track:
        snapshot["catalog_target"] = {
            "id": registry["id"], "name": registry["name"], "identifier": registry.get("identifier"),
            "kind": "catalog_predicted", "references": registry.get("references", []),
            "limitations": registry.get("limitations", []),
            "pm_ra_cosdec_masyr": registry.get("pm_ra_cosdec_masyr"),
            "pm_dec_masyr": registry.get("pm_dec_masyr"),
            "positions": [{"mjd": f["mjd"], "ra": float(c.ra.deg), "dec": float(c.dec.deg)}
                          for f in frames for c in [track(f["mjd"])]],
        }

    # Spectrum: measured points only; classification left to the live backend.
    by_season: dict[str, list[dict]] = {}
    for pt in points:
        by_season.setdefault(str(pt["season"]), []).append(pt)
    snapshot["spectrum"] = {
        "query": {"ra": ra, "dec": dec, "aperture_arcsec": args.aperture,
                  "tracking": "catalogue-predicted position per frame epoch" if registry else "fixed position"},
        "points": points, "by_season": by_season, "classification": None,
        "method": (f"forced aperture photometry, radius {args.aperture} arcsec (pixel-centre inclusion), "
                   "median background annulus +9..+27 arcsec, errors from VARIANCE; no aperture correction"),
        "caveats": ["Each frame samples ONE wavelength at this position (linear variable filter).",
                    "No aperture/PSF correction: fluxes are aperture-limited, not total.",
                    "Saturated (OVERFLOW) points are not reliable fluxes.",
                    "Template classification is not computed in cached snapshots."],
    }

    # Verdict: only checks computable from the data above; the rest are 'na'.
    checks = []
    total = len(frames)

    def frac(name):
        return sum(1 for f in frames if name in f["center_flags"]) / total
    sat = frac("OVERFLOW")
    checks.append({"id": "saturation", "label": "OVERFLOW / saturation at position",
                   "status": "fail" if sat > 0.5 else "warn" if sat > 0 else "pass",
                   "detail": f"{sat * 100:.0f}% of {total} frames flag OVERFLOW in the central 3x3 px",
                   "evidence_source": "SPHEREx L2 FLAGS"})
    for name in ("GHOST", "CROSSTALK", "PERSIST", "TRANSIENT"):
        fr = frac(name)
        checks.append({"id": name.lower(), "label": f"{name} flag at position",
                       "status": "warn" if fr > 0.2 else "pass",
                       "detail": f"{fr * 100:.0f}% of frames", "evidence_source": "SPHEREx L2 FLAGS"})
    match = None
    if sources:
        mid = float(np.median([f["mjd"] for f in frames]))
        reference = coord
        if track:
            reference = track(mid)  # compare at the same epoch, not the fixed field centre
        best = None
        for s in sources:
            pos = min(s["positions"], key=lambda q: abs(q["mjd"] - mid))
            sep = SkyCoord(pos["ra"] * u.deg, pos["dec"] * u.deg).separation(reference).arcsec
            if best is None or sep < best[0]:
                best = (sep, s)
        if best and best[0] < 6.0:
            match = best
    if "gaia" in snapshot:
        checks.append({"id": "gaia", "label": "Gaia DR3 source at propagated position",
                       "status": "pass" if match else "warn",
                       "detail": (f"Gaia DR3 {match[1]['source_id']} G={match[1]['phot_g_mean_mag']:.2f} at {match[0]:.1f} arcsec"
                                  if match else "No Gaia DR3 source (G<20) within 6 arcsec of the centre at mid-epoch"),
                       "evidence_source": "Gaia DR3 TAP (predicted)"})
    else:
        checks.append({"id": "gaia", "label": "Gaia DR3 source at propagated position", "status": "na",
                       "detail": "Gaia query failed", "evidence_source": "Gaia DR3 TAP"})
    checks.append({"id": "skybot", "label": "Known solar-system object (SkyBoT)", "status": "na",
                   "detail": "Not queried for cached snapshots", "evidence_source": "IMCCE SkyBoT"})
    checks.append({"id": "motion", "label": "Measured centroid shift vs predicted", "status": "na",
                   "detail": "Centroiding is computed by the live /v2/verdict service", "evidence_source": "-"})
    # Variability: only compare points from different seasons at MATCHED wavelength
    # (|dlambda| <= half the narrower bandwidth), so the LVF colour change is not mistaken for variability.
    bw_of = {f["id"]: f["bandwidth_um"] for f in frames}
    good_pts = [p for p in points if not p["saturated"] and p["err"] > 0]
    pairs = []
    for i, a in enumerate(good_pts):
        for b in good_pts[i + 1:]:
            if a["season"] == b["season"]:
                continue
            half = min(bw_of[a["frame_id"]], bw_of[b["frame_id"]]) / 2
            if abs(a["lambda_um"] - b["lambda_um"]) > half:
                continue
            sig = abs(a["flux"] - b["flux"]) / math.hypot(a["err"], b["err"])
            rel = abs(a["flux"] - b["flux"]) / max(abs(a["flux"]), abs(b["flux"]), 1e-9)
            pairs.append((sig, rel, a, b))
    strong = [q for q in pairs if q[0] > 5 and q[1] > 0.2]
    strong_dets = {q[2]["detector"] for q in strong}
    # Require agreement in >=2 detectors; a single-detector excess is more likely a local artefact.
    variable = len(strong) >= 2 and len(strong_dets) >= 2
    blend_note = ""
    if registry and strong:
        # The aperture follows a moving track: static field sources entering/leaving it mimic variability.
        blend_note = "; aperture follows the predicted track, so blending with field sources can mimic change"
        variable = False
    if pairs:
        top = max(pairs, key=lambda q: q[0])
        var_detail = (f"{len(pairs)} wavelength-matched cross-season pairs; {len(strong)} differ >5 sigma and >20%; "
                      f"max {top[0]:.1f} sigma at {top[2]['lambda_um']:.3f} um (D{top[2]['detector']})" + blend_note)
    else:
        var_detail = "No unsaturated wavelength-matched point pairs across seasons"
    checks.append({"id": "variability", "label": "Photometric change between seasons",
                   "status": "warn" if (variable or strong) else "pass" if pairs else "na",
                   "detail": var_detail, "evidence_source": "Forced photometry on SPHEREx frames"})
    checks.append({"id": "spectral_class", "label": "Spectral class (template fit)", "status": "na",
                   "detail": "Not computed in cached snapshots", "evidence_source": "-"})
    stellar = is_stellar(match[1] if match else None)
    if variable:
        verdict, conf = "variable", 0.5
    elif stellar:
        verdict, conf = "known_star", 0.75 if sat < 0.5 else 0.6
    else:
        verdict, conf = "inconclusive", 0.4 if match else 0.3
    snapshot["verdict"] = {
        "checks": checks, "verdict": verdict, "confidence": conf,
        "summary": (("A Gaia DR3 source without significant parallax is at the "
                     "position: catalogued, but not necessarily a star. " if match and not stellar else "")
                    + "Rule-based summary of the checks above computed by the snapshot generator; "
                    "checks marked 'na' were not evaluated. Not a discovery claim."),
        "method": "prism_snapshot.py rules v1",
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(encoding="utf-8", data=json.dumps(snapshot, allow_nan=False, separators=(",", ":"), ensure_ascii=False))
    print(f"wrote {out} ({out.stat().st_size / 1e6:.2f} MB): {len(frames)} frames, "
          f"{len(points)} phot points, {len(sources)} gaia, failures={len(failures)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
