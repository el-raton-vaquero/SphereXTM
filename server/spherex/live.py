"""PRISM live discovery, download and reprojection of SPHEREx Level 2 frames for ANY RA/Dec.

Pipeline (all real data, never synthetic):

1. SIA2 discovery on IRSA (``spherex_dr1`` / ``spherex_qr3``) for a tiny cone at the
   requested position; deduplicated per (obs_id, detector).
2. For every selected product, a *native sub-image* (IMAGE, FLAGS, VARIANCE and the
   WCS-WAVE lookup table) is read with HTTP byte-range requests from the public AWS
   mirror listed in the SIA ``cloud_access`` column (bucket ``nasa-irsa-spherex``).
   SPHEREx Level 2 files are uncompressed MEFs, so only the needed rows of three
   image HDUs plus small headers are transferred (~0.1-1 MB instead of the ~4 MB
   IRSA cutout that always includes the ePSF table). If the mirror fails, the
   official IRSA cutout service is used as a fallback and the method is recorded.
3. The sub-image keeps its native celestial TAN-SIP WCS (only CRPIX shifted, exactly
   like the IRSA cutout service does) and spectral WCS 'W'. It is reprojected onto a
   common north-up TAN grid centred on the request (bilinear for surface brightness,
   nearest neighbour for the FLAGS bitmask).

Everything is bounded: request timeouts, retries, a concurrency limit, a maximum
number of frames, an overall deadline and a size-limited disk cache under
``server/outputs/prism-cache`` (override with ``PRISM_CACHE_DIR``).
"""

from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import http.client
import io
import json
import math
import os
from pathlib import Path
import threading
import time
from typing import Callable
from urllib.parse import urlencode, urlsplit
import warnings

from astropy.coordinates import SkyCoord
from astropy import units as u
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import FITSFixedWarning, WCS
import numpy as np
from reproject import reproject_interp

from spherex.archive import (COLLECTIONS, INFORMATIONAL_FLAGS, MAX_FILE_BYTES, MAX_QUERY_BYTES,
                             SIA_URL, cutout_url, fetch_bytes, parse_sia)

# --------------------------------------------------------------------------- limits
NATIVE_PIXSCALE_ARCSEC = 6.15
FOV_MIN, FOV_MAX, FOV_DEFAULT = 1.0, 20.0, 4.0
MAX_FRAMES_LIMIT, MAX_FRAMES_DEFAULT = 160, 60
SEASON_GAP_DAYS = 60.0
SIA_CONE_DEG = 0.002            # ~7 arcsec: products whose footprint touches the centre
SIA_TTL_SECONDS = 24 * 3600
HTTP_TIMEOUT = 20.0
HTTP_RETRIES = 3
DEFAULT_WORKERS = int(os.environ.get("PRISM_WORKERS", "8"))
DEFAULT_DEADLINE = float(os.environ.get("PRISM_DEADLINE_SECONDS", "150"))
MAX_CACHE_BYTES = int(os.environ.get("PRISM_CACHE_MAX_BYTES", str(1024**3)))
MAX_ROWS_BYTES = 12 * 1024**2   # per HDU row read (bounded even at FOV_MAX)
S3_HOST = "nasa-irsa-spherex.s3.amazonaws.com"
S3_BUCKET = "nasa-irsa-spherex"
FITS_BLOCK = 2880

# Bits that make a pixel value meaningless (no usable measurement). Every other flag
# is preserved in flags_b64 so that the UI can show/mask it explicitly.
HARD_INVALID_FLAGS = {"NONFUNC", "MISSING_DATA", "HOT", "COLD", "DICHROIC", "PHANMISS"}
SATURATION_FLAGS = {"OVERFLOW", "NONLINEAR", "BLOOM"}
CENTER_RADIUS_PX = 2.0

CITATION = (
    "This publication makes use of data products from the Spectro-Photometer for the "
    "History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is "
    "a joint project of the Jet Propulsion Laboratory and the California Institute of "
    "Technology, and is funded by the National Aeronautics and Space Administration. "
    "Data retrieved from NASA/IPAC Infrared Science Archive (IRSA)."
)

LIMITATIONS = [
    "Each SPHEREx frame samples a source at ONE wavelength (linear variable filter); "
    "brightness changes between frames can be colour, not time variability.",
    "Pixels are reprojected with bilinear interpolation; no PSF homogenisation.",
    "lambda_um/bandwidth_um come from the approximate spectral WCS 'W' at the request centre.",
    "Images include zodiacal light (ZODI extension not subtracted).",
    "Quality flags are reported, not hidden; only hard-invalid bits are NaN-masked.",
]


class LiveError(Exception):
    """Transparent, user-facing failure. Never replaced by synthetic data."""

    def __init__(self, status_code: int, error_type: str, detail: str, **extra):
        super().__init__(detail)
        self.status_code = status_code
        self.error_type = error_type
        self.detail = detail
        self.extra = extra

    def to_dict(self) -> dict:
        return {"detail": self.detail, "error_type": self.error_type, **self.extra}


# --------------------------------------------------------------------------- cache
def cache_root() -> Path:
    env = os.environ.get("PRISM_CACHE_DIR")
    root = Path(env) if env else Path(__file__).resolve().parent.parent / "outputs" / "prism-cache"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _sha(*parts) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()[:24]


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_bytes(data)
    # Windows refuses os.replace while another thread has the target open or is
    # replacing it; the cache is best-effort, so retry briefly and then skip caching.
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.02 * (attempt + 1))
    tmp.unlink(missing_ok=True)


_prune_lock = threading.Lock()


def prune_cache(root: Path | None = None, limit: int | None = None) -> int:
    """Delete oldest cache files until the cache fits in ``limit`` bytes. Returns bytes freed."""
    root = root or cache_root()
    limit = MAX_CACHE_BYTES if limit is None else limit
    with _prune_lock:
        files = [p for p in root.rglob("*") if p.is_file() and not p.name.endswith(".lock")]
        sizes = {p: p.stat().st_size for p in files}
        total = sum(sizes.values())
        freed = 0
        for path in sorted(files, key=lambda p: p.stat().st_mtime):
            if total <= limit:
                break
            try:
                path.unlink()
            except OSError:
                continue
            total -= sizes[path]
            freed += sizes[path]
        return freed


# --------------------------------------------------------------------------- grid
@dataclass
class Grid:
    ra: float
    dec: float
    fov_arcmin: float
    n: int
    pixscale_arcsec: float
    wcs: WCS  # FITS orientation (row 0 = South); JSON arrays are flipped to North-up

    def to_json(self) -> dict:
        s = self.pixscale_arcsec / 3600.0
        c = (self.n + 1) / 2.0
        return {
            "n": self.n,
            "pixscale_arcsec": self.pixscale_arcsec,
            "fov_arcmin": self.n * self.pixscale_arcsec / 60.0,
            "wcs": {
                "ctype": ["RA---TAN", "DEC--TAN"],
                "crval": [self.ra, self.dec],
                "crpix": [c, c],
                # Matrix for the JSON array orientation: column index -> East is left
                # (RA decreases with x), row index -> North is row 0 (Dec decreases with y).
                "cd": [[-s, 0.0], [0.0, -s]],
                "pixel_convention": "1-based FITS pixel centres; x = column (0 = East edge), "
                                    "y = row (0 = North edge) of the delivered array",
            },
            "north_up": True,
            "east_left": True,
        }


def make_grid(ra: float, dec: float, fov_arcmin: float,
              pixscale_arcsec: float = NATIVE_PIXSCALE_ARCSEC) -> Grid:
    n = max(9, int(round(fov_arcmin * 60.0 / pixscale_arcsec)))
    if n % 2 == 0:
        n += 1  # odd n puts the requested position on a pixel centre
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]
    wcs.wcs.cdelt = [-pixscale_arcsec / 3600.0, pixscale_arcsec / 3600.0]
    return Grid(ra, dec, fov_arcmin, n, pixscale_arcsec, wcs)


# --------------------------------------------------------------------------- discovery
def sia_url(ra: float, dec: float, collection: str, radius_deg: float = SIA_CONE_DEG) -> str:
    return SIA_URL + "?" + urlencode({"COLLECTION": collection,
                                      "POS": f"circle {ra:.7f} {dec:.7f} {radius_deg}",
                                      "MAXREC": 2000})


SIA_ATTEMPTS = 4


def discover(ra: float, dec: float, collections=COLLECTIONS, timeout: float = 60.0,
             fetch=fetch_bytes, use_cache: bool = True,
             retry_sleep: float = 1.5) -> tuple[list[dict], list[str], bool, list[dict]]:
    """Return (rows, query_urls, all_from_cache, collection_errors).

    IRSA intermittently answers HTTP 502/503; each collection is retried with backoff.
    If some collections still fail, the others are returned and the failures are
    reported explicitly (a failed query is never treated as "no observations").
    Raises LiveError if every collection fails.
    """
    rows, urls, cached_all, errors = [], [], True, []
    for collection in collections:
        if collection not in COLLECTIONS:
            raise LiveError(422, "unsupported_collection",
                            f"Unsupported collection {collection!r}; allowed: {list(COLLECTIONS)}")
        url = sia_url(ra, dec, collection)
        urls.append(url)
        path = cache_root() / "sia" / f"{_sha(url)}.xml"
        if use_cache and path.exists() and time.time() - path.stat().st_mtime < SIA_TTL_SECONDS:
            try:
                rows.extend(parse_sia(path.read_bytes()))
                continue
            except Exception:  # noqa: BLE001 - corrupt cache: refetch
                pass
        cached_all = False
        last = None
        for attempt in range(SIA_ATTEMPTS):
            try:
                data = fetch(url, MAX_QUERY_BYTES, timeout)
                parsed = parse_sia(data)
            except Exception as exc:  # noqa: BLE001 - retried, then surfaced transparently
                last = exc
                if attempt + 1 < SIA_ATTEMPTS:
                    time.sleep(retry_sleep * (2 ** attempt))
                continue
            _atomic_write(path, data)  # only validated, complete responses are cached
            rows.extend(parsed)
            last = None
            break
        if last is not None:
            errors.append({"collection": collection, "query_url": url,
                           "error": f"{type(last).__name__}: {last}"})
    if errors and len(errors) == len(collections):
        raise LiveError(502, "archive_unavailable",
                        "IRSA SIA2 discovery failed for every requested collection "
                        "(archive/network error, not absence of data).",
                        collection_errors=errors, query_urls=urls)
    return dedupe_rows(rows), urls, cached_all, errors


def dedupe_rows(rows: list[dict]) -> list[dict]:
    """One product per (obs_id, detector); DR1 (reviewed release) wins over QR3."""
    rank = {"spherex_dr1": 0, "spherex_qr3": 1}
    best: dict[tuple, dict] = {}
    for row in rows:
        if row.get("dataproduct_subtype") not in (None, "science"):
            continue
        key = (row["obs_id"], row["energy_bandpassname"])
        old = best.get(key)
        if old is None or rank.get(row["obs_collection"], 9) < rank.get(old["obs_collection"], 9):
            best[key] = row
    return sorted(best.values(), key=lambda r: (float(r["t_min"]), r["energy_bandpassname"]))


def detector_of(row: dict) -> int:
    return int(row["energy_bandpassname"].rsplit("D", 1)[1])


def select_rows(rows: list[dict], max_frames: int) -> list[dict]:
    """Deterministic, time-uniform sample spread evenly over detectors."""
    if len(rows) <= max_frames:
        return list(rows)
    by_det: dict[int, list[dict]] = {}
    for row in rows:
        by_det.setdefault(detector_of(row), []).append(row)
    quota = {d: 0 for d in by_det}
    remaining = max_frames
    while remaining > 0:
        progressed = False
        for det in sorted(by_det):
            if remaining and quota[det] < len(by_det[det]):
                quota[det] += 1
                remaining -= 1
                progressed = True
        if not progressed:
            break
    picked = []
    for det, items in by_det.items():
        k = quota[det]
        items = sorted(items, key=lambda r: float(r["t_min"]))
        idx = np.unique(np.round(np.linspace(0, len(items) - 1, k)).astype(int)) if k else []
        picked.extend(items[i] for i in idx)
    return sorted(picked, key=lambda r: (float(r["t_min"]), r["energy_bandpassname"]))


def assign_seasons(mjds: list[float], gap: float = SEASON_GAP_DAYS) -> tuple[list[int], list[dict]]:
    """Cluster observation times; a new season starts after a gap > ``gap`` days."""
    order = np.argsort(mjds)
    labels = [0] * len(mjds)
    seasons: list[dict] = []
    prev = None
    for i in order:
        t = mjds[i]
        if prev is None or t - prev > gap:
            seasons.append({"index": len(seasons), "start_mjd": t, "end_mjd": t, "n_frames": 0})
        s = seasons[-1]
        s["end_mjd"] = t
        s["n_frames"] += 1
        labels[i] = s["index"]
        prev = t
    return labels, seasons


# --------------------------------------------------------------------------- HTTP ranges
class RangeClient:
    """Thread-local keep-alive HTTPS connections for byte-range GETs on the S3 mirror."""

    def __init__(self, host: str = S3_HOST, timeout: float = HTTP_TIMEOUT):
        self.host = host
        self.timeout = timeout
        self._local = threading.local()
        self.bytes_transferred = 0
        self.requests = 0
        self._lock = threading.Lock()

    def _conn(self) -> http.client.HTTPSConnection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = http.client.HTTPSConnection(self.host, timeout=self.timeout)
            self._local.conn = conn
        return conn

    def _reset(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except OSError:
                pass
        self._local.conn = None

    def get(self, path: str, start: int | None = None, end: int | None = None,
            suffix: int | None = None) -> tuple[bytes, int | None]:
        """Return (bytes, total_size). ``start``/``end`` inclusive, or ``suffix`` last bytes."""
        if suffix is not None:
            rng = f"bytes=-{suffix}"
            expect = suffix
        else:
            rng = f"bytes={start}-{end}"
            expect = end - start + 1
        if expect > MAX_ROWS_BYTES + 4 * FITS_BLOCK * 16:
            raise ValueError(f"Range request of {expect} bytes exceeds bound")
        last = None
        for attempt in range(HTTP_RETRIES):
            try:
                conn = self._conn()
                conn.request("GET", path, headers={"Range": rng, "User-Agent": "prism-spherex/1"})
                resp = conn.getresponse()
                body = resp.read()
                if resp.status != 206:
                    raise OSError(f"HTTP {resp.status} for range {rng}")
                total = None
                cr = resp.getheader("Content-Range")
                if cr and "/" in cr:
                    total = int(cr.rsplit("/", 1)[1])
                with self._lock:
                    self.bytes_transferred += len(body)
                    self.requests += 1
                return body, total
            except (OSError, http.client.HTTPException) as exc:
                last = exc
                self._reset()
                time.sleep(0.3 * (attempt + 1))
        raise RuntimeError(f"S3 range read failed: {path} {rng}: {last}")


def _parse_header(buf: bytes, offset: int = 0) -> tuple[fits.Header, int] | None:
    """Parse a FITS header starting at ``offset`` in ``buf``; return (header, padded length)."""
    i = offset
    while i + 80 <= len(buf):
        if buf[i:i + 8] == b"END     ":
            length = i + 80 - offset
            padded = int(math.ceil(length / FITS_BLOCK)) * FITS_BLOCK
            text = buf[offset:i + 80].decode("ascii", errors="replace")
            return fits.Header.fromstring(text), padded
        i += 80
    return None


def _data_bytes(header: fits.Header) -> int:
    naxis = int(header.get("NAXIS", 0))
    if naxis == 0:
        return 0
    n = abs(int(header["BITPIX"])) // 8
    for k in range(1, naxis + 1):
        n *= int(header[f"NAXIS{k}"])
    n = int(header.get("GCOUNT", 1)) * (n + int(header.get("PCOUNT", 0)))
    return int(math.ceil(n / FITS_BLOCK)) * FITS_BLOCK


def s3_path_for(row: dict) -> str:
    try:
        aws = json.loads(row.get("cloud_access") or "{}")["aws"]
    except (KeyError, ValueError, TypeError) as exc:
        raise ValueError("Product has no AWS cloud_access entry") from exc
    if aws.get("bucket_name") != S3_BUCKET or not str(aws.get("key", "")).endswith(".fits"):
        raise ValueError("Unexpected cloud_access location")
    return "/" + aws["key"]


def read_layout(client: RangeClient, path: str) -> dict:
    """Headers/offsets of IMAGE, FLAGS, VARIANCE and the WCS-WAVE table (cached on disk)."""
    cpath = cache_root() / "layout" / f"{_sha(path)}.json"
    if cpath.exists():
        try:
            return json.loads(cpath.read_text())
        except ValueError:
            pass
    head, total = client.get(path, 0, 64 * 1024 - 1)
    if not head.startswith(b"SIMPLE  ="):
        raise ValueError("S3 object is not a FITS file")
    layout: dict = {"size": total, "hdus": {}}
    parsed = _parse_header(head, 0)
    if parsed is None:
        raise ValueError("Primary header too large")
    primary, plen = parsed
    offset = plen + _data_bytes(primary)
    buf, buf_start = head, 0
    for name in ("IMAGE", "FLAGS", "VARIANCE"):
        rel = offset - buf_start
        parsed = _parse_header(buf, rel) if 0 <= rel < len(buf) else None
        if parsed is None:
            buf, _ = client.get(path, offset, offset + 48 * 1024 - 1)
            buf_start = offset
            parsed = _parse_header(buf, 0)
            if parsed is None:
                raise ValueError(f"{name} header not found")
        header, hlen = parsed
        if header.get("EXTNAME") != name:
            raise ValueError(f"Expected {name} HDU, found {header.get('EXTNAME')}")
        layout["hdus"][name] = {"header": header.tostring(), "data_offset": offset + hlen}
        offset = offset + hlen + _data_bytes(header)
    # WCS-WAVE is the final, tiny binary table; read the file tail.
    tail_len = 8 * FITS_BLOCK
    tail, total2 = client.get(path, suffix=tail_len)
    size = total or total2
    tail_start = size - len(tail)
    found = None
    for pos in range(len(tail) - FITS_BLOCK, -1, -FITS_BLOCK):
        if (tail_start + pos) % FITS_BLOCK:
            continue
        if tail[pos:pos + 8] == b"XTENSION":
            parsed = _parse_header(tail, pos)
            if parsed and parsed[0].get("EXTNAME") == "WCS-WAVE":
                found = (pos, parsed)
                break
    if found is None:
        raise ValueError("WCS-WAVE table not found in file tail")
    pos, (wheader, wlen) = found
    nbytes = _data_bytes(wheader)
    wdata = tail[pos + wlen:pos + wlen + nbytes]
    if len(wdata) != nbytes:
        raise ValueError("Truncated WCS-WAVE table")
    layout["wave"] = {"header": wheader.tostring(),
                      "data_b64": base64.b64encode(wdata).decode()}
    layout["size"] = size
    _atomic_write(cpath, json.dumps(layout).encode())
    return layout


@dataclass
class NativeCutout:
    """Native-resolution sub-image of one SPHEREx Level 2 product (no resampling)."""
    row: dict
    image: np.ndarray        # float32 MJy/sr
    flags: np.ndarray        # uint32 bitmask
    variance: np.ndarray     # float32 (MJy/sr)^2
    header: fits.Header      # IMAGE header with CRPIX shifted to the sub-image
    flags_header: fits.Header
    wave_hdul: fits.HDUList  # [Primary, WCS-WAVE] for the spectral WCS lookup
    method: str
    transfer_bytes: int
    origin_xy: tuple[int, int] = (0, 0)
    extra: dict = field(default_factory=dict)

    @property
    def wcs(self) -> WCS:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FITSFixedWarning)
            return WCS(self.header)

    def spectral_wcs(self) -> WCS:
        header = self.header.copy()
        for key in list(header):
            if key.startswith(("A_", "B_", "AP_", "BP_")):
                del header[key]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FITSFixedWarning)
            spectral = WCS(header, fobj=self.wave_hdul, key="W")
        spectral.sip = None
        return spectral

    def flag_names(self) -> dict[int, str]:
        return {int(k[4:]): str(self.flags_header[k])
                for k in self.flags_header if k.startswith("MSKN")}


def _shift_header(header: fits.Header, x0: int, y0: int, nx: int, ny: int) -> fits.Header:
    h = header.copy()
    h["NAXIS1"], h["NAXIS2"] = nx, ny
    for suffix in ("", "A", "W"):
        if f"CRPIX1{suffix}" in h:
            h[f"CRPIX1{suffix}"] = float(h[f"CRPIX1{suffix}"]) - x0
            h[f"CRPIX2{suffix}"] = float(h[f"CRPIX2{suffix}"]) - y0
    return h


def _wave_hdul(layout_wave: dict) -> fits.HDUList:
    header = fits.Header.fromstring(layout_wave["header"])
    raw = base64.b64decode(layout_wave["data_b64"])
    blob = (fits.PrimaryHDU().header.tostring().encode() + header.tostring().encode() + raw)
    return fits.open(io.BytesIO(blob), memmap=False, lazy_load_hdus=False)


def native_box(header: fits.Header, ra: float, dec: float, half_px: int) -> tuple[int, int, int, int, float, float]:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        wcs = WCS(header)
    x, y = (float(v) for v in wcs.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg)))
    nx, ny = int(header["NAXIS1"]), int(header["NAXIS2"])
    if not (np.isfinite(x) and np.isfinite(y)):
        raise ValueError("Requested position does not project onto this frame")
    x0 = max(0, int(math.floor(x)) - half_px)
    x1 = min(nx - 1, int(math.ceil(x)) + half_px)
    y0 = max(0, int(math.floor(y)) - half_px)
    y1 = min(ny - 1, int(math.ceil(y)) + half_px)
    if x0 > x1 or y0 > y1:
        raise ValueError("Requested field does not overlap this frame")
    return x0, x1, y0, y1, x, y


_DTYPES = {8: ">u1", 16: ">i2", 32: ">i4", 64: ">i8", -32: ">f4", -64: ">f8"}


def image_shape(header: fits.Header) -> tuple[int, int]:
    """(ny, nx) of an image HDU, compressed (ZIMAGE) or not."""
    if header.get("ZIMAGE"):
        return int(header["ZNAXIS2"]), int(header["ZNAXIS1"])
    return int(header["NAXIS2"]), int(header["NAXIS1"])


def read_rows_plain(client: RangeClient, path: str, header: fits.Header, data_offset: int,
                    y0: int, y1: int) -> np.ndarray:
    nx = int(header["NAXIS1"])
    dtype = _DTYPES[int(header["BITPIX"])]
    bpp = np.dtype(dtype).itemsize
    start = data_offset + y0 * nx * bpp
    end = data_offset + (y1 + 1) * nx * bpp - 1
    if end - start + 1 > MAX_ROWS_BYTES:
        raise ValueError("Requested field too large for bounded row read")
    data, _ = client.get(path, start, end)
    arr = np.frombuffer(data, dtype=dtype).reshape(y1 - y0 + 1, nx)
    if header.get("BSCALE", 1) != 1 or header.get("BZERO", 0) != 0:
        arr = arr * float(header.get("BSCALE", 1)) + float(header.get("BZERO", 0))
    return arr


def read_rows_tiled(client: RangeClient, path: str, header: fits.Header, data_offset: int,
                    y0: int, y1: int) -> np.ndarray:
    """Rows of a tile-compressed image with one-row tiles (ZTILE2=1, ZTILE1=ZNAXIS1).

    Reads only the needed 32-bit heap descriptors and the compressed heap bytes, then
    lets astropy decompress a re-packed table containing exactly those tiles.
    """
    if not (int(header.get("ZTILE2", 0)) == 1
            and int(header.get("ZTILE1", 0)) == int(header["ZNAXIS1"])
            and int(header.get("TFIELDS", 0)) == 1
            and str(header.get("TFORM1", "")).upper().startswith(("1PB", "PB"))
            and int(header["NAXIS1"]) == 8):
        raise ValueError("Unsupported tile-compression layout for row reads")
    nrows = y1 - y0 + 1
    desc_raw, _ = client.get(path, data_offset + y0 * 8, data_offset + (y1 + 1) * 8 - 1)
    desc = np.frombuffer(desc_raw, dtype=">i4").reshape(nrows, 2).astype(np.int64)
    lengths, offsets = desc[:, 0], desc[:, 1]
    theap = int(header.get("THEAP", int(header["NAXIS1"]) * int(header["NAXIS2"])))
    lo, hi = int(offsets.min()), int((offsets + lengths).max())
    if hi - lo > MAX_ROWS_BYTES:
        raise ValueError("Compressed heap span too large")
    heap, _ = client.get(path, data_offset + theap + lo, data_offset + theap + hi - 1)
    new_desc = np.stack([lengths, offsets - lo], axis=1).astype(">i4").tobytes()
    h = header.copy()
    h["NAXIS2"] = nrows
    h["ZNAXIS2"] = nrows
    h["PCOUNT"] = len(heap)
    for key in ("THEAP", "CHECKSUM", "DATASUM"):
        if key in h:
            del h[key]
    body = new_desc + heap
    body += b"\0" * ((-len(body)) % FITS_BLOCK)
    blob = fits.PrimaryHDU().header.tostring().encode() + h.tostring().encode() + body
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with fits.open(io.BytesIO(blob), memmap=False) as hdul:
            data = np.array(hdul[1].data)
    if data.shape != (nrows, int(header["ZNAXIS1"])):
        raise ValueError("Decompressed tile shape mismatch")
    return data


def read_rows(client: RangeClient, path: str, header: fits.Header, data_offset: int,
              y0: int, y1: int) -> np.ndarray:
    if header.get("ZIMAGE"):
        return read_rows_tiled(client, path, header, data_offset, y0, y1)
    return read_rows_plain(client, path, header, data_offset, y0, y1)


def plain_image_header(header: fits.Header) -> fits.Header:
    """Image-style header for a possibly compressed HDU (for WCS / flag definitions)."""
    if not header.get("ZIMAGE"):
        return header
    h = header.copy()
    h["NAXIS1"], h["NAXIS2"] = int(header["ZNAXIS1"]), int(header["ZNAXIS2"])
    h["BITPIX"] = int(header["ZBITPIX"])
    return h


def load_native_s3(row: dict, ra: float, dec: float, half_px: int,
                   client: RangeClient) -> NativeCutout:
    path = s3_path_for(row)
    before = client.bytes_transferred
    layout = read_layout(client, path)
    img_raw = fits.Header.fromstring(layout["hdus"]["IMAGE"]["header"])
    img_h = plain_image_header(img_raw)
    shape = image_shape(img_raw)
    x0, x1, y0, y1, _, _ = native_box(img_h, ra, dec, half_px)
    arrays = {}
    for name in ("IMAGE", "FLAGS", "VARIANCE"):
        info = layout["hdus"][name]
        h = fits.Header.fromstring(info["header"])
        if image_shape(h) != shape:
            raise ValueError(f"Unexpected {name} shape")
        block = read_rows(client, path, h, info["data_offset"], y0, y1)[:, x0:x1 + 1]
        arrays[name] = (block, plain_image_header(h))
    image = arrays["IMAGE"][0].astype(np.float32)
    flags = arrays["FLAGS"][0].astype(np.int64).astype(np.uint32)
    variance = arrays["VARIANCE"][0].astype(np.float32)
    header = _shift_header(img_h, x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    return NativeCutout(row, image, flags, variance, header, arrays["FLAGS"][1],
                        _wave_hdul(layout["wave"]), "s3-range",
                        client.bytes_transferred - before, (x0, y0),
                        {"s3_url": f"https://{S3_HOST}{path}"})


def load_native_cutout_service(row: dict, ra: float, dec: float, half_px: int,
                               timeout: float = 60.0, fetch=fetch_bytes) -> NativeCutout:
    """Fallback: official IRSA cutout service (larger: always includes the ePSF table)."""
    size_arcmin = (2 * half_px + 3) * NATIVE_PIXSCALE_ARCSEC / 60.0
    url = cutout_url(row["access_url"], ra, dec, size_arcmin)
    data = fetch(url, MAX_FILE_BYTES, timeout)
    if not data.startswith(b"SIMPLE  ="):
        raise ValueError("Cutout response is not FITS")
    with fits.open(io.BytesIO(data), memmap=False) as hdul:
        for name in ("IMAGE", "FLAGS", "VARIANCE", "WCS-WAVE"):
            if name not in hdul:
                raise ValueError(f"Cutout lacks {name}")
        header = hdul["IMAGE"].header.copy()
        wave = fits.HDUList([fits.PrimaryHDU(), fits.BinTableHDU(hdul["WCS-WAVE"].data.copy(),
                                                                 header=hdul["WCS-WAVE"].header.copy())])
        return NativeCutout(row, hdul["IMAGE"].data.astype(np.float32),
                            hdul["FLAGS"].data.astype(np.int64).astype(np.uint32),
                            hdul["VARIANCE"].data.astype(np.float32), header,
                            hdul["FLAGS"].header.copy(), wave, "irsa-cutout", len(data),
                            (0, 0), {"cutout_url": url})


def load_native(row: dict, ra: float, dec: float, half_px: int,
                client: RangeClient | None = None) -> NativeCutout:
    """S3 byte ranges first; IRSA cutout service on failure. Raises with both reasons."""
    client = client or RangeClient()
    try:
        return load_native_s3(row, ra, dec, half_px, client)
    except ValueError as exc:
        if "does not overlap" in str(exc) or "does not project" in str(exc):
            raise
        first = exc
    except RuntimeError as exc:
        first = exc
    try:
        cut = load_native_cutout_service(row, ra, dec, half_px)
        cut.extra["s3_error"] = f"{type(first).__name__}: {first}"
        return cut
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"S3 failed ({first}); IRSA cutout failed ({exc})") from exc


# --------------------------------------------------------------------------- processing
def validate_times(header: fits.Header, row: dict) -> float:
    if header.get("TIMESYS") != "UTC":
        raise ValueError("Only UTC timestamps supported")
    mjd = float(header["MJD-OBS"])
    if abs(Time(header["DATE-OBS"], scale="utc").mjd - mjd) > 1e-6:
        raise ValueError("FITS DATE-OBS / MJD-OBS disagree")
    if abs(float(row["t_min"]) - mjd) > 1e-4 or header.get("OBSID") != row["obs_id"]:
        raise ValueError("FITS header and SIA metadata disagree")
    if f"SPHEREx-D{int(header['DETECTOR'])}" != row["energy_bandpassname"]:
        raise ValueError("FITS detector and SIA metadata disagree")
    if u.Unit(header["BUNIT"]) != u.MJy / u.sr:
        raise ValueError(f"Unexpected units {header['BUNIT']}")
    return mjd


def _finite_or_none(value) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def flag_bits(names_by_bit: dict[int, str], wanted: set[str]) -> int:
    return sum(1 << bit for bit, name in names_by_bit.items() if name in wanted)


def decode_flags(value: int, names_by_bit: dict[int, str]) -> list[str]:
    return [name for bit, name in sorted(names_by_bit.items()) if value & (1 << bit)]


def process_frame(cut: NativeCutout, grid: Grid) -> dict:
    """Reproject one native cutout onto the common grid. Returns arrays + metadata."""
    header, row = cut.header, cut.row
    mjd = validate_times(header, row)
    names = cut.flag_names()
    if not names:
        raise ValueError("Missing FLAGS bit definitions; cannot assume pixels are clean")
    wcs = cut.wcs
    coord = SkyCoord(grid.ra * u.deg, grid.dec * u.deg)
    xc, yc = (float(v) for v in wcs.world_to_pixel(coord))
    hard = np.uint32(flag_bits(names, HARD_INVALID_FLAGS))
    usable = (np.isfinite(cut.image) & np.isfinite(cut.variance) & (cut.variance > 0)
              & ((cut.flags & hard) == 0))
    image = np.where(usable, cut.image, np.nan).astype(np.float64)
    shape = (grid.n, grid.n)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        pix, foot = reproject_interp((image, wcs), grid.wcs, shape_out=shape, order="bilinear")
        fl, ffoot = reproject_interp((cut.flags.astype(np.float64), wcs), grid.wcs,
                                     shape_out=shape, order="nearest-neighbor")
    pix = np.where((foot > 0) & np.isfinite(pix), pix, np.nan).astype(np.float32)
    fl = np.where((ffoot > 0) & np.isfinite(fl), fl, 0).astype(np.uint32)
    # Centre diagnostics on NATIVE pixels (no interpolation).
    yy, xx = np.indices(cut.image.shape)
    near = (xx - xc) ** 2 + (yy - yc) ** 2 <= CENTER_RADIUS_PX ** 2
    inside = bool(near.any()) and -0.5 <= xc < cut.image.shape[1] - 0.5 \
        and -0.5 <= yc < cut.image.shape[0] - 0.5
    center_bits = int(np.bitwise_or.reduce(cut.flags[near])) if near.any() else 0
    saturated = bool(center_bits & flag_bits(names, SATURATION_FLAGS))
    lam = bw = None
    try:
        spectral = cut.spectral_wcs()
        w, b = spectral.pixel_to_world(xc, yc)
        lam, bw = float(w.to_value(u.um)), float(b.to_value(u.um))
        if not (np.isfinite(lam) and np.isfinite(bw)):
            lam = bw = None
    except Exception:  # noqa: BLE001 - reported as null, never invented
        lam = bw = None
    informational = np.uint32(flag_bits(names, INFORMATIONAL_FLAGS))
    finite = np.isfinite(pix)
    clean = finite & ((fl & ~informational) == 0)
    return {
        "pixels": np.flipud(pix),          # row 0 = North
        "flags": np.flipud(fl),
        "meta": {
            "id": f"{row['obs_id']}_D{detector_of(row)}",
            "obs_id": row["obs_id"],
            "collection": row["obs_collection"],
            "mjd": mjd,
            "date": header["DATE-OBS"],
            "detector": int(header["DETECTOR"]),
            "lambda_um": lam,
            "bandwidth_um": bw,
            "exptime_s": _finite_or_none(header.get("XPOSURE", row.get("t_exptime"))),
            "saturated_at_center": saturated,
            "center_in_frame": inside,
            "center_flags": decode_flags(center_bits, names),
            "valid_fraction": float(finite.mean()),
            "clean_fraction": float(clean.mean()),
            "psf_fwhm_arcsec": _finite_or_none(header.get("PSF_FWHM")),
            "flag_bits": {name: bit for bit, name in sorted(names.items())},
            "provenance": {
                "url": row["access_url"],
                "obs_id": row["obs_id"],
                "obs_publisher_did": row.get("obs_publisher_did"),
                "method": cut.method,
                "transfer_bytes": cut.transfer_bytes,
                "native_origin_xy": list(cut.origin_xy),
                "native_center_xy": [xc, yc],
                **{k: v for k, v in cut.extra.items()},
            },
        },
    }


def _b64(arr: np.ndarray, dtype: str) -> str:
    return base64.b64encode(np.ascontiguousarray(arr, dtype=dtype).tobytes()).decode()


def frame_cache_key(row: dict, grid: Grid) -> str:
    return _sha("frame-v1", row["access_url"], f"{grid.ra:.7f}", f"{grid.dec:.7f}",
                grid.n, grid.pixscale_arcsec)


def half_px_for(grid: Grid) -> int:
    # Covers the rotated grid (half diagonal) plus interpolation margin.
    return int(math.ceil(grid.n * grid.pixscale_arcsec / NATIVE_PIXSCALE_ARCSEC * 0.72)) + 3


def get_frame(row: dict, grid: Grid, client: RangeClient, use_cache: bool = True) -> tuple[dict, bool]:
    key = frame_cache_key(row, grid)
    root = cache_root() / "frames"
    npz, meta_path = root / f"{key}.npz", root / f"{key}.json"
    if use_cache and npz.exists() and meta_path.exists():
        try:
            with np.load(npz) as data:
                pixels, flags = data["pixels"], data["flags"]
            meta = json.loads(meta_path.read_text())
            if pixels.shape == (grid.n, grid.n):
                return {"pixels": pixels, "flags": flags, "meta": meta}, True
        except (OSError, ValueError, KeyError):
            pass
    cut = load_native(row, grid.ra, grid.dec, half_px_for(grid), client)
    result = process_frame(cut, grid)
    buf = io.BytesIO()
    np.savez_compressed(buf, pixels=result["pixels"], flags=result["flags"])
    _atomic_write(npz, buf.getvalue())
    _atomic_write(meta_path, json.dumps(result["meta"]).encode())
    return result, False


# --------------------------------------------------------------------------- search
def validate_params(ra: float, dec: float, fov: float, max_frames: int) -> None:
    if not (np.isfinite(ra) and 0.0 <= ra < 360.0):
        raise LiveError(422, "invalid_ra", "ra must be in [0, 360) degrees")
    if not (np.isfinite(dec) and -90.0 <= dec <= 90.0):
        raise LiveError(422, "invalid_dec", "dec must be in [-90, 90] degrees")
    if not (FOV_MIN <= fov <= FOV_MAX):
        raise LiveError(422, "invalid_fov", f"fov must be in [{FOV_MIN}, {FOV_MAX}] arcmin")
    if not (1 <= max_frames <= MAX_FRAMES_LIMIT):
        raise LiveError(422, "invalid_max_frames", f"max_frames must be in [1, {MAX_FRAMES_LIMIT}]")


def search(ra: float, dec: float, fov: float = FOV_DEFAULT, max_frames: int = MAX_FRAMES_DEFAULT,
           collections=COLLECTIONS, progress: Callable[[dict], None] | None = None,
           workers: int = DEFAULT_WORKERS, deadline_s: float = DEFAULT_DEADLINE,
           use_cache: bool = True, pixscale_arcsec: float = NATIVE_PIXSCALE_ARCSEC,
           include_arrays: bool = True) -> dict:
    """Full /v2/search response. Raises LiveError for transparent failures."""
    validate_params(ra, dec, fov, max_frames)
    started = time.monotonic()
    emit = progress or (lambda _e: None)
    collections = tuple(dict.fromkeys(collections))
    emit({"stage": "discovery", "message": "Querying IRSA SIA2", "collections": list(collections)})
    rows, query_urls, sia_cached, collection_errors = discover(ra, dec, collections, use_cache=use_cache)
    if not rows:
        if collection_errors:
            raise LiveError(502, "archive_unavailable",
                            "Some IRSA SIA2 queries failed and the rest returned no products; "
                            "absence of data cannot be concluded.",
                            collection_errors=collection_errors, query_urls=query_urls)
        raise LiveError(404, "no_coverage",
                        "IRSA SIA2 returned no SPHEREx Level 2 products covering this position "
                        f"in {list(collections)} (a completed query, not a network failure).",
                        query_urls=query_urls)
    selected = select_rows(rows, max_frames)
    emit({"stage": "discovered", "n_available": len(rows), "n_selected": len(selected)})
    grid = make_grid(ra, dec, fov, pixscale_arcsec)
    client = RangeClient()
    results: list[dict] = []
    errors: list[dict] = []
    n_cached = 0
    done = 0
    pool = ThreadPoolExecutor(max_workers=max(1, min(workers, 16)))
    try:
        futures = {pool.submit(get_frame, row, grid, client, use_cache): row for row in selected}
        try:
            for fut in as_completed(futures, timeout=max(1.0, deadline_s - (time.monotonic() - started))):
                row = futures[fut]
                done += 1
                try:
                    res, cached = fut.result()
                    n_cached += int(cached)
                    results.append(res)
                except Exception as exc:  # noqa: BLE001 - per-frame failures are reported
                    errors.append({"obs_id": row["obs_id"], "detector": detector_of(row),
                                   "url": row["access_url"],
                                   "error": f"{type(exc).__name__}: {exc}"})
                emit({"stage": "frames", "done": done, "total": len(selected),
                      "failed": len(errors), "elapsed_s": round(time.monotonic() - started, 2)})
        except TimeoutError:
            for fut, row in futures.items():
                if not fut.done():
                    fut.cancel()
                    errors.append({"obs_id": row["obs_id"], "detector": detector_of(row),
                                   "url": row["access_url"],
                                   "error": f"Deadline of {deadline_s:.0f} s exceeded"})
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    if not results:
        raise LiveError(502, "download_failed",
                        "All selected SPHEREx products failed to download or process; "
                        "no data is shown instead of substituting anything.",
                        errors=errors[:20], query_urls=query_urls)
    results.sort(key=lambda r: (r["meta"]["mjd"], r["meta"]["detector"]))
    labels, seasons = assign_seasons([r["meta"]["mjd"] for r in results])
    frames = []
    for res, season in zip(results, labels, strict=True):
        meta = dict(res["meta"])
        meta["season"] = season
        if include_arrays:
            meta["pixels_b64"] = _b64(res["pixels"], "<f4")
            meta["flags_b64"] = _b64(res["flags"], "<u4")
        frames.append(meta)
    detectors = []
    for det in sorted({f["detector"] for f in frames}):
        lams = [f["lambda_um"] for f in frames if f["detector"] == det and f["lambda_um"] is not None]
        detectors.append({"detector": det,
                          "n_frames": sum(1 for f in frames if f["detector"] == det),
                          "lambda_min": min(lams) if lams else None,
                          "lambda_max": max(lams) if lams else None})
    elapsed = time.monotonic() - started
    all_cached = sia_cached and n_cached == len(results)
    response = {
        "query": {"ra": ra, "dec": dec, "fov": fov, "max_frames": max_frames,
                  "collections": list(collections)},
        "grid": grid.to_json(),
        "frames": frames,
        "seasons": seasons,
        "detectors": detectors,
        "pixel_encoding": {
            "pixels_b64": "little-endian float32, n*n, row-major, row 0 = North, column 0 = East; "
                          "unit MJy/sr; NaN = no usable measurement",
            "flags_b64": "little-endian uint32 SPHEREx FLAGS bitmask (nearest native pixel), "
                         "same orientation; see frame.flag_bits",
            "nan_policy": "NaN where outside the frame footprint, non-finite, variance <= 0 or "
                          f"flagged {sorted(HARD_INVALID_FLAGS)}; all other flags are kept and reported",
            "saturation_flags": sorted(SATURATION_FLAGS),
        },
        "units": {"pixels": "MJy/sr", "lambda_um": "um", "bandwidth_um": "um", "mjd": "d (UTC)"},
        "provenance": {
            "citation": CITATION,
            "archive": "NASA/IPAC Infrared Science Archive (IRSA)",
            "collections": list(collections),
            "query_urls": query_urls,
            "n_available": len(rows),
            "n_selected": len(selected),
            "n_returned": len(frames),
            "selection": "deterministic time-uniform sample per detector, round-robin across detectors",
            "transfer": "HTTP byte ranges on AWS mirror s3://nasa-irsa-spherex (fallback: IRSA cutout service)",
            "transfer_bytes": client.bytes_transferred,
            "transfer_requests": client.requests,
            "errors": errors,
            "collection_errors": collection_errors,
            "limitations": LIMITATIONS,
            "generated_utc": datetime.now(timezone.utc).isoformat(),
            "elapsed_s": round(elapsed, 2),
            "real_data": True,
        },
        "cache": "cached" if all_cached else "live",
    }
    emit({"stage": "done", "n_frames": len(frames), "failed": len(errors),
          "elapsed_s": round(elapsed, 2)})
    try:
        prune_cache()
    except OSError:
        pass
    return response


def native_frames(ra: float, dec: float, half_px: int = 8, max_frames: int = MAX_FRAMES_LIMIT,
                  collections=COLLECTIONS, workers: int = DEFAULT_WORKERS,
                  deadline_s: float = DEFAULT_DEADLINE) -> tuple[list[NativeCutout], list[dict], list[str]]:
    """Native (non-resampled) cutouts around a position, for forced photometry/verdicts.

    Returns (cutouts sorted by time, per-frame errors, SIA query URLs). Each cutout keeps
    IMAGE (MJy/sr), FLAGS, VARIANCE, celestial WCS (``.wcs``) and spectral WCS
    (``.spectral_wcs()``). Frames whose metadata disagree with SIA are dropped with an error.
    """
    if not (1 <= half_px <= 64):
        raise LiveError(422, "invalid_half_px", "half_px must be in [1, 64]")
    validate_params(ra, dec, FOV_DEFAULT, max(1, min(max_frames, MAX_FRAMES_LIMIT)))
    rows, urls, _, _ = discover(ra, dec, collections)
    selected = select_rows(rows, max_frames)
    client = RangeClient()
    out, errors = [], []
    with ThreadPoolExecutor(max_workers=max(1, min(workers, 16))) as pool:
        futures = {pool.submit(load_native, row, ra, dec, half_px, client): row for row in selected}
        try:
            for fut in as_completed(futures, timeout=deadline_s):
                row = futures[fut]
                try:
                    cut = fut.result()
                    validate_times(cut.header, row)
                    out.append(cut)
                except Exception as exc:  # noqa: BLE001
                    errors.append({"obs_id": row["obs_id"], "detector": detector_of(row),
                                   "error": f"{type(exc).__name__}: {exc}"})
        except TimeoutError:
            for fut, row in futures.items():
                if not fut.done():
                    fut.cancel()
                    errors.append({"obs_id": row["obs_id"], "detector": detector_of(row),
                                   "error": "deadline exceeded"})
    out.sort(key=lambda c: (float(c.header["MJD-OBS"]), int(c.header["DETECTOR"])))
    return out, errors, urls


def decode_pixels(b64: str, n: int) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b64), dtype="<f4").reshape(n, n)


def decode_flags_array(b64: str, n: int) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b64), dtype="<u4").reshape(n, n)
