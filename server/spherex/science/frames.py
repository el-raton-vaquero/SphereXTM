"""Build ScienceFrame dicts from REAL SPHEREx Level-2 cutouts.

- ``load_native_frame``: read one IRSA cutout (IMAGE/FLAGS/VARIANCE/EPSF + spectral
  WCS 'W'), keeping native pixels so photometric errors stay valid.
- ``ArchiveFrameSource``: a bounded default ``GetFrames`` implementation reusing
  spherex.archive (SIA2 discovery, IBE cutouts, hash-verified cache). The V2
  integrator may replace it with a faster supplier; the science code only needs
  the ScienceFrame contract (types.py).
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
from pathlib import Path
import threading
from urllib.parse import urlencode

from astropy import units as u
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
import numpy as np
import warnings

from spherex import archive
from spherex.science import flags as fl
from spherex.science import http
from spherex.science.types import ScienceFrame


def _spectral_maps(header: fits.Header, hdus: fits.HDUList, shape) -> tuple[np.ndarray | None, np.ndarray | None]:
    """Per-pixel wavelength/bandwidth from the alternate 'W' WCS (WAVE-TAB lookup).

    Follows spherex.fits / IRSA tutorials: SIP terms are removed for the spectral WCS only.
    """
    try:
        spec = header.copy()
        for key in list(spec):
            if key.startswith(("A_", "B_", "AP_", "BP_")):
                del spec[key]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FITSFixedWarning)
            sw = WCS(spec, fobj=hdus, key="W")
        sw.sip = None
        yy, xx = np.indices(shape)
        wave, width = sw.pixel_to_world(xx, yy)
        return wave.to_value(u.um), width.to_value(u.um)
    except Exception:  # noqa: BLE001 - missing spectral WCS is reported as None
        return None, None


def _epsf_zone(hdus: fits.HDUList, header: fits.Header, x: float, y: float) -> tuple[np.ndarray | None, int, dict]:
    """EPSF of the zone nearest the detector position of cutout pixel (x, y).

    Detector coordinates come from the LINEAR alternate WCS 'A' of the cutout
    (detector = cutout_pixel_1based - CRPIXnA). The EPSF header notes that MWIR
    (D4-D6) PSFs are x-flipped to the sky view; a circular-aperture enclosed
    fraction is invariant to that flip, only the zone choice could differ by one zone.
    """
    if "EPSF" not in hdus:
        return None, 5, {}
    t = hdus["EPSF"].data
    ov = int(hdus["EPSF"].header.get("OVSMPX", 5))
    try:
        det_x = (x + 1) - float(header["CRPIX1A"])
        det_y = (y + 1) - float(header["CRPIX2A"])
    except KeyError:
        det_x = det_y = None
    if det_x is None:
        return None, ov, {}
    d2 = (t["XCENTER"] - det_x) ** 2 + (t["YCENTER"] - det_y) ** 2
    i = int(np.argmin(d2))
    psf = np.array(t["EPSF"][i], float)
    return psf, ov, {"zone": [int(t["BINX"][i]), int(t["BINY"][i])], "cwave_um": float(t["CWAVE"][i]),
                     "source": "EPSF HDU", "detector_xy": [det_x, det_y]}


def load_native_frame(path: Path | str, provenance: dict | None = None,
                      target_radec: tuple[float, float] | None = None) -> ScienceFrame:
    path = Path(path)
    with fits.open(path, memmap=False) as hdus:
        for name in ("IMAGE", "FLAGS", "VARIANCE"):
            if name not in hdus:
                raise ValueError(f"{path.name}: missing HDU {name}")
        h = hdus["IMAGE"].header
        if u.Unit(h["BUNIT"]) != u.MJy / u.sr:
            raise ValueError(f"{path.name}: unexpected BUNIT {h['BUNIT']}")
        image = hdus["IMAGE"].data.astype(float)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FITSFixedWarning)
            wcs = WCS(h).celestial
        if target_radec is not None:
            x, y = (float(v) for v in wcs.world_to_pixel_values(*target_radec))
        else:
            y, x = (np.array(image.shape) - 1) / 2
        wave, width = _spectral_maps(h, hdus, image.shape)
        epsf, ov, epsf_meta = _epsf_zone(hdus, h, x, y)
        ix = int(np.clip(round(x), 0, image.shape[1] - 1))
        iy = int(np.clip(round(y), 0, image.shape[0] - 1))
        frame: ScienceFrame = {
            "id": str(h.get("OBSID", path.stem)) + f"_D{int(h['DETECTOR'])}",
            "collection": (provenance or {}).get("collection"),
            "mjd": float(h["MJD-OBS"]),
            "detector": int(h["DETECTOR"]),
            "image": image,
            "variance": hdus["VARIANCE"].data.astype(float),
            "flags": hdus["FLAGS"].data.astype(np.int64).astype(np.uint32),
            "flag_definitions": fl.definitions_from_header(hdus["FLAGS"].header),
            "wcs": wcs,
            "wavelength_map": wave,
            "bandwidth_map": width,
            "lambda_um": float(wave[iy, ix]) if wave is not None else None,
            "bandwidth_um": float(width[iy, ix]) if width is not None else None,
            "psf_fwhm_arcsec": float(h.get("PSF_FWHM", np.nan)),
            "epsf": epsf,
            "epsf_oversample": ov,
            "provenance": {"obs_id": str(h.get("OBSID")), "file": path.name,
                           "pipeline_version": hdus[0].header.get("VERSION"), **(provenance or {})},
            "extra": {"epsf": epsf_meta, "date_obs": h.get("DATE-OBS")},
        }
    return frame


class ArchiveFrameSource:
    """Default GetFrames: SIA2 discovery + IBE cutouts, bounded and cached.

    Bounds: ``max_frames`` (caller, capped at 200), per-request timeout, ``workers``
    parallel downloads, and an LRU-evicted cutout cache of ``max_cache_bytes``.
    Each IRSA cutout is ~4 MB regardless of size because the EPSF table is included.
    """

    def __init__(self, cache_dir: Path | None = None, collections=("spherex_dr1",),
                 cutout_arcmin: float = 2.0, workers: int = 6, timeout: float = 45.0,
                 max_cache_bytes: int = 1536 * 1024**2):
        self.cache_dir = Path(cache_dir) if cache_dir else http.default_cache_dir() / "cutouts"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.collections = tuple(collections)
        self.cutout_arcmin = cutout_arcmin
        self.workers = workers
        self.timeout = timeout
        self.max_cache_bytes = max_cache_bytes
        self._lock = threading.Lock()

    def discover(self, ra: float, dec: float) -> tuple[list[dict], list[str]]:
        rows, urls = [], []
        for coll in self.collections:
            q = archive.SIA_URL + "?" + urlencode({"COLLECTION": coll, "POS": f"circle {ra} {dec} 0.0005",
                                                   "MAXREC": "2000"})
            urls.append(q)
            rows += archive.parse_sia(archive.fetch_bytes(q, archive.MAX_QUERY_BYTES, self.timeout))
        seen, unique = set(), []
        for r in rows:
            if r["access_url"] not in seen:
                seen.add(r["access_url"])
                unique.append(r)
        return unique, urls

    @staticmethod
    def select(rows: list[dict], max_frames: int) -> list[dict]:
        """Evenly spaced in time within each detector, detectors interleaved."""
        by_det: dict[str, list[dict]] = {}
        for r in sorted(rows, key=lambda r: float(r["t_min"])):
            by_det.setdefault(r["energy_bandpassname"], []).append(r)
        per = max(1, max_frames // max(1, len(by_det)))
        chosen = []
        for det_rows in by_det.values():
            if len(det_rows) <= per:
                chosen += det_rows
            else:
                idx = np.unique(np.linspace(0, len(det_rows) - 1, per).round().astype(int))
                chosen += [det_rows[i] for i in idx]
        return sorted(chosen, key=lambda r: float(r["t_min"]))[:max_frames]

    def _evict(self, reserve: int) -> None:
        with self._lock:
            files = sorted(self.cache_dir.glob("*/*.fits"), key=lambda p: p.stat().st_mtime)
            total = sum(p.stat().st_size for p in files)
            while files and total + reserve > self.max_cache_bytes:
                p = files.pop(0)
                total -= p.stat().st_size
                p.unlink(missing_ok=True)
                p.with_suffix(".json").unlink(missing_ok=True)

    def _one(self, row: dict, ra: float, dec: float, size: float):
        url = archive.cutout_url(row["access_url"], ra, dec, size)
        shard = self.cache_dir / hashlib.sha256(url.encode()).hexdigest()[:1]
        shard.mkdir(exist_ok=True)
        path, meta = archive.download_cutout(url, shard, self.timeout)
        path.touch()
        frame = load_native_frame(path, {"url": url, "access_url": row["access_url"], "obs_id": row["obs_id"],
                                         "collection": row.get("obs_collection")}, (ra, dec))
        frame["extra"]["cached"] = meta.get("cached", False)
        return frame

    def fetch(self, ra: float, dec: float, fov_arcmin: float, max_frames: int) -> tuple[list[ScienceFrame], dict]:
        max_frames = int(min(max(1, max_frames), 200))
        rows, query_urls = self.discover(ra, dec)
        chosen = self.select(rows, max_frames)
        size = float(min(max(fov_arcmin, self.cutout_arcmin), 6.0))
        self._evict(reserve=len(chosen) * 5 * 1024**2)
        frames, failures = [], []
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            futures = [(r, pool.submit(self._one, r, ra, dec, size)) for r in chosen]
            for r, fut in futures:
                try:
                    frames.append(fut.result())
                except Exception as exc:  # noqa: BLE001 - reported, never replaced by fake data
                    failures.append({"obs_id": r["obs_id"], "error": str(exc)[:300]})
        if chosen and not frames:
            raise RuntimeError(f"All {len(chosen)} cutout downloads failed; first error: {failures[0]['error']}")
        report = {"n_available": len(rows), "n_selected": len(chosen), "n_loaded": len(frames),
                  "failures": failures, "query_urls": query_urls,
                  "n_cached": sum(1 for f in frames if f["extra"].get("cached"))}
        return frames, report

    def __call__(self, ra: float, dec: float, fov_arcmin: float, max_frames: int) -> list[ScienceFrame]:
        return self.fetch(ra, dec, fov_arcmin, max_frames)[0]
