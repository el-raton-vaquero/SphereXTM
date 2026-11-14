"""Optional FastAPI router: /v2/gaia, /v2/skybot, /v2/spectrum, /v2/verdict.

Mount from v2.py (owned by the backend-live workstream):

    from spherex.science.routes import build_router
    app.include_router(build_router(get_frames=my_get_frames))

``get_frames`` must follow ``spherex.science.types.GetFrames`` and return REAL,
NATIVE-pixel frames. If omitted, ``ArchiveFrameSource`` (IRSA cutouts) is used.
Errors are returned transparently (HTTP 4xx/5xx with a JSON ``detail``); no
synthetic fallback exists here.
"""

from __future__ import annotations

from datetime import datetime, timezone
import math
from pathlib import Path
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query
import numpy as np

from spherex.science import centroid, classify, gaia, goggles, photometry, skybot, variability, verdict
from spherex.science.seasons import season_table
from spherex.science.types import GetFrames

SPHEREX_CITATION = ("SPHEREx Level-2 spectral images, NASA/IPAC Infrared Science Archive (IRSA), "
                    "https://irsa.ipac.caltech.edu/Missions/spherex.html")
HIGH_PM_MAS_YR = 100.0
MATCH_RADIUS_ARCSEC = 9.0


def sanitize(obj: Any) -> Any:
    """JSON-safe copy: numpy -> python, NaN/inf -> None, drops arrays/WCS objects."""
    if isinstance(obj, dict):
        return {str(k): sanitize(v) for k, v in obj.items() if not isinstance(v, np.ndarray) and k != "wcs"}
    if isinstance(obj, (list, tuple)):
        return [sanitize(v) for v in obj]
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        f = float(obj)
        return f if math.isfinite(f) else None
    if obj is None or isinstance(obj, (str, int)):
        return obj
    return str(obj)


def parse_mjds(text: str | None, max_n: int) -> list[float]:
    if not text:
        return []
    try:
        vals = [float(t) for t in text.split(",") if t.strip()]
    except ValueError as exc:
        raise HTTPException(422, "mjd must be a comma-separated list of numbers") from exc
    if len(vals) > max_n:
        raise HTTPException(422, f"At most {max_n} MJD values")
    if any(not (40000 < v < 80000) for v in vals):
        raise HTTPException(422, "MJD out of range (40000-80000)")
    return vals


def _utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _registry_match(ra: float, dec: float, mjd: float) -> dict | None:
    """Literature targets in spherex/data/m4-targets.json (predicted, not detected)."""
    try:
        from spherex.targets import load_targets, predict
    except Exception:  # noqa: BLE001
        return None
    best = None
    for t in load_targets().values():
        if t.get("status") != "verified":
            continue
        try:
            c = predict(t, mjd)
        except Exception:  # noqa: BLE001 - incomplete registry rows are skipped
            continue
        sep = float(gaia.angular_sep_arcsec(ra, dec, c.ra.deg, c.dec.deg))
        if sep <= 30.0 and (best is None or sep < best["separation_arcsec"]):
            best = {"name": t["name"], "identifier": t.get("identifier"), "separation_arcsec": sep,
                    "reference": (t.get("references") or [None])[0], "kind": "catalog_predicted"}
    return best if best and best["separation_arcsec"] <= MATCH_RADIUS_ARCSEC else None


def build_router(get_frames: GetFrames | None = None, *, cache_dir: Path | None = None,
                 prefix: str = "/v2") -> APIRouter:
    from spherex.science import http

    cache = Path(cache_dir) if cache_dir else http.default_cache_dir()
    state: dict[str, Any] = {"get_frames": get_frames}
    router = APIRouter(prefix=prefix, tags=["science"])

    def frames_for(ra: float, dec: float, fov: float, max_frames: int):
        if state["get_frames"] is None:
            from spherex.science.frames import ArchiveFrameSource

            state["get_frames"] = ArchiveFrameSource(cache_dir=cache / "cutouts")
        src = state["get_frames"]
        try:
            if hasattr(src, "fetch"):
                return src.fetch(ra, dec, fov, max_frames)
            return src(ra, dec, fov, max_frames), {}
        except ValueError as exc:
            raise HTTPException(422, {"error": str(exc), "source": "frames"}) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, {"error": f"SPHEREx frames unavailable: {exc}", "source": "IRSA"}) from exc

    @router.get("/gaia")
    def gaia_endpoint(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                      radius_arcmin: float = Query(2.0, gt=0, le=gaia.MAX_RADIUS_ARCMIN),
                      mjd: str | None = Query(None, description="comma-separated UTC MJDs (<= 400)"),
                      max_sources: int = Query(300, ge=1, le=2000)):
        mjds = parse_mjds(mjd, 400)
        try:
            out = gaia.predict_sources(ra, dec, radius_arcmin, mjds, max_sources=max_sources, cache_dir=cache)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, {"error": str(exc), "source": "Gaia TAP"}) from exc
        return sanitize(out | {"query": {"ra": ra, "dec": dec, "radius_arcmin": radius_arcmin, "mjd": mjds}})

    @router.get("/skybot")
    def skybot_endpoint(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                        radius_arcmin: float = Query(2.0, gt=0, le=skybot.MAX_RADIUS_ARCMIN),
                        mjd: str = Query(..., description="one or more comma-separated UTC MJDs (<= 12)")):
        mjds = parse_mjds(mjd, 12)
        if not mjds:
            raise HTTPException(422, "mjd is required")
        out = skybot.cone_search_epochs(ra, dec, radius_arcmin, mjds, max_queries=12, cache_dir=cache)
        if out["n_failed"] == len(out["epochs"]):
            raise HTTPException(502, {"error": out["epochs"][0]["error"], "source": "IMCCE SkyBoT"})
        return sanitize(out | {"query": {"ra": ra, "dec": dec, "radius_arcmin": radius_arcmin, "mjd": mjds}})

    def _gaia_context(ra, dec, mjds, radius_arcmin):
        try:
            g = gaia.predict_sources(ra, dec, radius_arcmin, mjds, cache_dir=cache)
            return g, gaia.nearest_match(g["sources"], ra, dec, None, MATCH_RADIUS_ARCSEC), None
        except Exception as exc:  # noqa: BLE001 - reported as an 'na' check
            return None, None, str(exc)

    def _tracking(match):
        if not match:
            return None, {"tracked": False}
        s = match["source"]
        pm = math.hypot(s.get("pmra") or 0.0, s.get("pmdec") or 0.0)
        if pm < HIGH_PM_MAS_YR:
            return None, {"tracked": False, "gaia_source_id": s["source_id"], "pm_mas_yr": pm}
        return gaia.source_predictor(s), {"tracked": True, "gaia_source_id": s["source_id"], "pm_mas_yr": pm,
                                          "note": "aperture follows the Gaia-predicted position (prediction)"}

    @router.get("/spectrum")
    def spectrum_endpoint(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                          aperture_arcsec: float = Query(photometry.DEFAULT_APERTURE_ARCSEC, ge=3, le=30),
                          max_frames: int = Query(120, ge=1, le=200),
                          track: bool = Query(True, description="follow a high-PM Gaia match")):
        t0 = time.monotonic()
        frames, report = frames_for(ra, dec, 2.0, max_frames)
        mjds = sorted({round(float(f["mjd"]), 5) for f in frames})
        g, match, gerr = _gaia_context(ra, dec, mjds, 1.0) if (track and frames) else (None, None, None)
        pos_fn, tracking = _tracking(match)
        points = photometry.photometry_series(frames, ra, dec, position_fn=pos_fn, aperture_arcsec=aperture_arcsec)
        seasons = season_table([p["mjd"] for p in points]) if points else []
        by_season = {}
        for s in seasons:
            sp = [p for p in points if p.get("season") == s["index"]]
            by_season[str(s["index"])] = s | {"n_points": len(sp), "n_usable": sum(photometry.usable(p) for p in sp)}
        out = {
            "query": {"ra": ra, "dec": dec, "aperture_arcsec": aperture_arcsec, "max_frames": max_frames},
            "unit": photometry.UNIT, "points": points, "by_season": by_season,
            "classification": classify.classify(points), "goggles": goggles.band_depth_points(points),
            "tracking": tracking | ({"gaia_error": gerr} if gerr else {}),
            "provenance": {"citation": SPHEREX_CITATION, "frames": report, "generated_utc": _utc(),
                           "method": "forced circular aperture, sigma-clipped median annulus background, "
                                     "VARIANCE errors, EPSF aperture correction"},
            "elapsed_s": time.monotonic() - t0,
        }
        return sanitize(out)

    @router.get("/verdict")
    def verdict_endpoint(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                         fov: float = Query(2.0, ge=1.0, le=6.0), max_frames: int = Query(80, ge=4, le=200)):
        t0 = time.monotonic()
        frames, report = frames_for(ra, dec, fov, max_frames)
        mjds = sorted({round(float(f["mjd"]), 5) for f in frames})
        g, match, gerr = _gaia_context(ra, dec, mjds, max(fov / 2, 1.0)) if frames else (None, None, None)
        pos_fn, tracking = _tracking(match)
        points = photometry.photometry_series(frames, ra, dec, position_fn=pos_fn)
        cents = [centroid.centroid_frame(f, *(pos_fn(f["mjd"]) if pos_fn else (ra, dec))) for f in frames]
        seasons = centroid.season_positions(cents, ra0=ra, dec0=dec)
        predictor = gaia.source_predictor(match["source"]) if match else None
        motion = centroid.motion_test(seasons, predictor)
        var = variability.compare_seasons(points)
        cls = classify.classify(points)
        # SkyBoT epochs: brightest detections first (an asteroid shows up in few frames), then even sampling.
        det = sorted((p for p in points if photometry.usable(p)), key=lambda p: -(p.get("snr") or 0))
        epochs = [p["mjd"] for p in det[:8]] + mjds[:: max(1, len(mjds) // 4)]
        sb = skybot.cone_search_epochs(ra, dec, 1.0, epochs, max_queries=12, cache_dir=cache) if epochs else None
        reg = _registry_match(ra, dec, float(np.median(mjds))) if mjds else None
        result = verdict.evaluate(points=points, gaia_match=match, gaia_error=gerr, skybot=sb, motion=motion,
                                  variability=var, classification=cls, registry_match=reg,
                                  match_radius_arcsec=MATCH_RADIUS_ARCSEC)
        result["evidence"] = {
            "n_frames": len(frames), "tracking": tracking, "season_positions": seasons,
            "centroids": cents, "motion": motion, "variability": var, "classification": cls,
            "skybot": sb, "registry_match": reg,
            "gaia": None if g is None else {"match": match, "provenance": g["provenance"],
                                            "n_sources": g["n_sources_total"]},
        }
        result["query"] = {"ra": ra, "dec": dec, "fov": fov, "max_frames": max_frames}
        result["provenance"] = {"citation": SPHEREX_CITATION, "frames": report, "generated_utc": _utc()}
        result["elapsed_s"] = time.monotonic() - t0
        return sanitize(result)

    return router
