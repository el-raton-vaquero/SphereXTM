"""Wire the science package (spherex.science) into the PRISM /v2 router.

Imported automatically by :mod:`spherex.v2` at startup. It registers the
``gaia``, ``skybot``, ``spectrum`` and ``verdict`` providers by delegating to the
science route handlers, and supplies them with REAL native-pixel frames read by
:mod:`spherex.live` (HTTP byte ranges from the public AWS mirror, IRSA cutout
service as fallback) instead of the slower ~4 MB IRSA cutouts.

The ePSF needed for the aperture correction is read as ONE row (~8.7 kB) of the
product's EPSF binary table, so the transfer stays small. If that row cannot be
read the frame has no ePSF and photometry reports uncorrected aperture flux
(stated per point in ``aperture_correction_method``) — nothing is invented.
"""
from __future__ import annotations

import json
import math
import threading
import time
from collections import OrderedDict
from typing import Any

import numpy as np
from astropy.io import fits
from fastapi import HTTPException

from spherex import live
from spherex.science import flags as fl
from spherex.science.frames import _spectral_maps
from spherex.science.routes import build_router
from spherex.science.types import ScienceFrame
from spherex.v2 import register_provider

EPSF_ROW_DTYPE = np.dtype([
    ("BINX", ">i4"), ("BINY", ">i4"), ("XCENTER", ">f4"), ("YCENTER", ">f4"),
    ("XWIDTH", ">f4"), ("YWIDTH", ">f4"), ("NSTAR", ">i4"), ("NEFF_MEAN", ">f4"),
    ("CWAVE", ">f4"), ("CBAND", ">f4"), ("EPSF", ">f8", (33, 33)),
])
DETECTOR_PX = 2040
NATIVE_HALF_PX = 10
FRAMES_PER_ANALYSIS = 80  # same for spectrum and verdict so the memo is shared


# --------------------------------------------------------------------------- ePSF
def _epsf_layout(client: live.RangeClient, path: str, layout: dict) -> dict | None:
    """Offset/shape of the EPSF table (walks the ZODI header after VARIANCE; cached)."""
    cpath = live.cache_root() / "epsf" / f"{live._sha(path)}.json"
    if cpath.exists():
        try:
            return json.loads(cpath.read_text())
        except ValueError:
            pass
    vh = fits.Header.fromstring(layout["hdus"]["VARIANCE"]["header"])
    offset = layout["hdus"]["VARIANCE"]["data_offset"] + live._data_bytes(vh)
    for _ in range(3):
        buf, _ = client.get(path, offset, offset + 48 * 1024 - 1)
        parsed = live._parse_header(buf, 0)
        if parsed is None:
            return None
        header, hlen = parsed
        if header.get("EXTNAME") == "EPSF":
            info = {"data_offset": offset + hlen, "row_bytes": int(header["NAXIS1"]),
                    "n_rows": int(header["NAXIS2"]), "ovsmpx": int(header.get("OVSMPX", 5))}
            if info["row_bytes"] != EPSF_ROW_DTYPE.itemsize:
                return None
            cpath.parent.mkdir(parents=True, exist_ok=True)
            cpath.write_text(json.dumps(info))
            return info
        offset += hlen + live._data_bytes(header)
    return None


def _read_epsf_row(client, path, info, index) -> np.ndarray:
    start = info["data_offset"] + index * info["row_bytes"]
    data, _ = client.get(path, start, start + info["row_bytes"] - 1)
    return np.frombuffer(data, dtype=EPSF_ROW_DTYPE, count=1)[0]


def epsf_for(cut: live.NativeCutout, x: float, y: float, client: live.RangeClient) -> tuple[np.ndarray | None, int, dict]:
    """ePSF zone nearest detector position of cutout pixel (x, y), read by byte range."""
    s3 = cut.extra.get("s3_url")
    if not s3:
        return None, 5, {"source": "unavailable (cutout-service fallback frame)"}
    path = s3.split(live.S3_HOST, 1)[1]
    try:
        layout = live.read_layout(client, path)
        info = _epsf_layout(client, path, layout)
        if not info:
            return None, 5, {"source": "unavailable (EPSF table not found)"}
        det_x = (x + 1) - float(cut.header["CRPIX1A"])
        det_y = (y + 1) - float(cut.header["CRPIX2A"])
        nb = int(round(math.sqrt(info["n_rows"])))
        bx = int(np.clip(det_x // (DETECTOR_PX / nb), 0, nb - 1))
        by = int(np.clip(det_y // (DETECTOR_PX / nb), 0, nb - 1))
        for index in (by * nb + bx, bx * nb + by):
            row = _read_epsf_row(client, path, info, index)
            if abs(row["XCENTER"] - det_x) <= row["XWIDTH"] / 2 + 1 and abs(row["YCENTER"] - det_y) <= row["YWIDTH"] / 2 + 1:
                return (np.array(row["EPSF"], float), info["ovsmpx"],
                        {"zone": [int(row["BINX"]), int(row["BINY"])], "cwave_um": float(row["CWAVE"]),
                         "source": "EPSF HDU row (S3 byte range)", "detector_xy": [det_x, det_y]})
        return None, 5, {"source": "unavailable (no EPSF zone matched the detector position)"}
    except Exception as exc:  # noqa: BLE001 - reported, photometry then stays uncorrected
        return None, 5, {"source": f"unavailable ({type(exc).__name__}: {exc})"}


# --------------------------------------------------------------------------- frames
def to_science_frame(cut: live.NativeCutout, ra: float, dec: float, client: live.RangeClient) -> ScienceFrame:
    header = cut.header
    wcs = cut.wcs.celestial
    x, y = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
    wave, width = _spectral_maps(header, cut.wave_hdul, cut.image.shape)
    epsf, ov, epsf_meta = epsf_for(cut, x, y, client)
    ix = int(np.clip(round(x), 0, cut.image.shape[1] - 1))
    iy = int(np.clip(round(y), 0, cut.image.shape[0] - 1))
    row = cut.row
    det = int(header["DETECTOR"])
    return {
        "id": f"{row['obs_id']}_D{det}",
        "collection": row.get("obs_collection"),
        "mjd": float(header["MJD-OBS"]),
        "detector": det,
        "image": cut.image.astype(float),
        "variance": cut.variance.astype(float),
        "flags": cut.flags,
        "flag_definitions": fl.definitions_from_header(cut.flags_header),
        "wcs": wcs,
        "wavelength_map": wave,
        "bandwidth_map": width,
        "lambda_um": float(wave[iy, ix]) if wave is not None else None,
        "bandwidth_um": float(width[iy, ix]) if width is not None else None,
        "psf_fwhm_arcsec": float(header.get("PSF_FWHM", np.nan)),
        "epsf": epsf,
        "epsf_oversample": ov,
        "provenance": {"obs_id": row["obs_id"], "collection": row.get("obs_collection"),
                       "access_url": row.get("access_url"), "method": cut.method, **cut.extra},
        "extra": {"epsf": epsf_meta, "date_obs": header.get("DATE-OBS")},
    }


class LiveFrameSource:
    """GetFrames supplier backed by spherex.live (small byte-range transfers).

    Keeps the last few results in memory so /v2/spectrum and /v2/verdict on the same
    position share one download.
    """

    def __init__(self, memo_size: int = 6):
        self._memo: OrderedDict[tuple, tuple[list[ScienceFrame], dict]] = OrderedDict()
        self._memo_size = memo_size
        self._lock = threading.Lock()

    def fetch(self, ra: float, dec: float, fov_arcmin: float, max_frames: int) -> tuple[list[ScienceFrame], dict]:
        # One fixed native box (21x21 px, ~2.15 arcmin) covers the photometry annulus and
        # the centroid fit, so /v2/spectrum and /v2/verdict can share one download.
        half_px = NATIVE_HALF_PX
        max_frames = int(min(max(1, max_frames), live.MAX_FRAMES_LIMIT))
        key = (round(ra, 6), round(dec, 6), half_px, max_frames)
        with self._lock:
            if key in self._memo:
                self._memo.move_to_end(key)
                frames, report = self._memo[key]
                return frames, report | {"memo": True}
        t0 = time.monotonic()
        try:
            rows, urls, _, coll_errors = live.discover(ra, dec)
            cuts, errors, _ = live.native_frames(ra, dec, half_px=half_px, max_frames=max_frames)
        except live.LiveError as exc:
            status = 422 if exc.status_code == 422 else 502
            raise HTTPException(status, {"error": exc.detail, "error_type": exc.error_type,
                                         "source": "IRSA"}) from exc
        if not rows:
            raise HTTPException(404, {"error": "No SPHEREx frames cover this position "
                                               "(completed SIA2 query).", "error_type": "no_coverage",
                                      "query_urls": urls})
        client = live.RangeClient()
        frames, failures = [], list(errors)
        for cut in cuts:
            try:
                frames.append(to_science_frame(cut, ra, dec, client))
            except Exception as exc:  # noqa: BLE001 - reported, never replaced
                failures.append({"obs_id": cut.row.get("obs_id"), "error": f"{type(exc).__name__}: {exc}"})
        if not frames:
            raise HTTPException(502, {"error": f"All selected frames failed to load; first: "
                                               f"{failures[0]['error'] if failures else 'unknown'}",
                                      "source": "IRSA/AWS"})
        report = {
            "n_available": len(rows), "n_selected": min(len(rows), max_frames), "n_loaded": len(frames),
            "failures": failures[:50], "n_failed": len(failures), "query_urls": urls,
            "collection_errors": coll_errors, "half_px": half_px,
            "n_with_epsf": sum(1 for f in frames if f["epsf"] is not None),
            "method": "spherex.live native byte-range cutouts (IRSA cutout service fallback)",
            "elapsed_s": round(time.monotonic() - t0, 2),
        }
        with self._lock:
            self._memo[key] = (frames, report)
            while len(self._memo) > self._memo_size:
                self._memo.popitem(last=False)
        return frames, report

    def __call__(self, ra, dec, fov_arcmin, max_frames):
        return self.fetch(ra, dec, fov_arcmin, max_frames)[0]


FRAME_SOURCE = LiveFrameSource()
_SCIENCE_CACHE = live.cache_root() / "science"
_SCIENCE_CACHE.mkdir(parents=True, exist_ok=True)
_router = build_router(get_frames=FRAME_SOURCE, cache_dir=_SCIENCE_CACHE)
_ENDPOINTS = {route.path: route.endpoint for route in _router.routes}


def _invoke(path: str, **kwargs) -> dict:
    try:
        return _ENDPOINTS[path](**kwargs)
    except HTTPException as exc:
        detail = exc.detail
        if isinstance(detail, dict):
            message = str(detail.get("error") or detail)
            extra = {k: v for k, v in detail.items() if k not in ("error", "error_type")}
            error_type = detail.get("error_type") or ("invalid_parameter" if exc.status_code == 422
                                                      else "upstream_unavailable")
        else:
            message, extra = str(detail), {}
            error_type = "invalid_parameter" if exc.status_code == 422 else "upstream_unavailable"
        raise live.LiveError(exc.status_code, error_type, message, **extra) from exc


def gaia(ra: float, dec: float, radius_arcmin: float, mjd: list[float]) -> dict:
    return _invoke("/v2/gaia", ra=ra, dec=dec, radius_arcmin=min(radius_arcmin, 15.0),
                   mjd=",".join(f"{m:.6f}" for m in mjd[:400]), max_sources=300)


def skybot(ra: float, dec: float, radius_arcmin: float, mjd: float) -> dict:
    out: dict[str, Any] = _invoke("/v2/skybot", ra=ra, dec=dec, radius_arcmin=radius_arcmin, mjd=f"{mjd:.6f}")
    epoch = (out.get("epochs") or [{}])[0]
    return out | {"mjd": mjd, "objects": epoch.get("objects") or []}


def spectrum(ra: float, dec: float, aperture_arcsec: float) -> dict:
    if not (3.0 <= aperture_arcsec <= 30.0):
        raise live.LiveError(422, "invalid_parameter", "aperture_arcsec must be in [3, 30]")
    return _invoke("/v2/spectrum", ra=ra, dec=dec, aperture_arcsec=aperture_arcsec,
                   max_frames=FRAMES_PER_ANALYSIS, track=True)


def verdict(ra: float, dec: float, fov: float) -> dict:
    return _invoke("/v2/verdict", ra=ra, dec=dec, fov=float(min(max(fov, 1.0), 6.0)),
                   max_frames=FRAMES_PER_ANALYSIS)


for _name, _fn in (("gaia", gaia), ("skybot", skybot), ("spectrum", spectrum), ("verdict", verdict)):
    register_provider(_name, _fn)
