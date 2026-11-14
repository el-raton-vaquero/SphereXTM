"""Known solar-system objects in a cone at an epoch: IMCCE SkyBoT cone search.

Berthier et al. 2006, ASP Conf. Ser. 351, 367 ("SkyBoT, a new VO service to
identify Solar System objects"); service https://ssp.imcce.fr/webservices/skybot/

Positions are EPHEMERIS PREDICTIONS for a geocentric observer (IAU code 500).
SPHEREx is in low Earth orbit (~700 km altitude): topocentric parallax for a main-belt
asteroid at 1.5 au is ~(7000 km / 1.5 au) ~ 6 arcsec, i.e. ~1 SPHEREx pixel, so a
match radius of >= 2 pixels is used by default and this caveat is reported.
"""

from __future__ import annotations

from collections.abc import Sequence
import json
from pathlib import Path
from urllib.parse import urlencode

from astropy.coordinates import Angle
from astropy.time import Time
import astropy.units as u

from spherex.science import http

CONE_URL = "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php"
CITATION = "Berthier et al. 2006, ASP Conf. Ser. 351, 367 (IMCCE SkyBoT)"
MAX_RADIUS_ARCMIN = 60.0
CAVEATS = [
    "Ephemeris predictions for a geocentric observer; SPHEREx (LEO) parallax can shift "
    "nearby objects by ~1 pixel (6.15 arcsec).",
    "Only objects with known orbits are returned; absence is not proof of no moving object.",
    "dRA rate is reported as given by SkyBoT.",
]
NO_OBJECT_MARKERS = ("No solar system object", "no solar system object")


def build_url(ra: float, dec: float, radius_arcmin: float, mjd: float) -> str:
    jd = Time(mjd, format="mjd", scale="utc").jd
    params = {"-ep": f"{jd:.6f}", "-ra": f"{ra:.7f}", "-dec": f"{dec:.7f}",
              "-rd": f"{radius_arcmin / 60:.6f}", "-mime": "json", "-output": "all",
              "-loc": "500", "-filter": "0", "-objFilter": "111", "-from": "PRISM"}
    return CONE_URL + "?" + urlencode(params)


def parse(raw: bytes | str) -> list[dict]:
    """Parse SkyBoT JSON; an explicit 'no object' reply returns []; anything else raises."""
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    stripped = text.strip()
    if not stripped or any(m in stripped for m in NO_OBJECT_MARKERS):
        return []
    try:
        data = json.loads(stripped)
    except ValueError as exc:
        raise RuntimeError(f"Unexpected SkyBoT reply: {stripped[:200]!r}") from exc
    if isinstance(data, dict):  # error envelope or single object
        if "Name" not in data:
            raise RuntimeError(f"SkyBoT error: {str(data)[:200]}")
        data = [data]
    objects = []
    for row in data:
        ra = Angle(row["RA (hms)"], unit=u.hourangle).deg
        dec = Angle(row["DEC (dms)"], unit=u.deg).deg
        objects.append({
            "name": row.get("Name"),
            "number": row.get("Num"),
            "class": row.get("Class"),
            "ra": float(ra), "dec": float(dec),
            "vmag": _f(row.get("VMag (mag)")),
            "position_error_arcsec": _f(row.get("Err (arcsec)")),
            "separation_arcsec": _f(row.get("d (arcsec)")),
            "dra_arcsec_per_h": _f(row.get("dRA (arcsec/h)")),
            "ddec_arcsec_per_h": _f(row.get("dDEC (arcsec/h)")),
            "geocentric_distance_au": _f(row.get("dg (ua)")),
            "heliocentric_distance_au": _f(row.get("dh (ua)")),
            "kind": "ephemeris_predicted",
        })
    return objects


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def cone_search(ra: float, dec: float, radius_arcmin: float, mjd: float, *, timeout: float = 30.0,
                cache_dir: Path | None = None, fetch: http.Fetch | None = None) -> dict:
    if not (0 < radius_arcmin <= MAX_RADIUS_ARCMIN):
        raise ValueError(f"radius_arcmin must be in (0, {MAX_RADIUS_ARCMIN}]")
    url = build_url(ra, dec, radius_arcmin, mjd)
    key = http.cache_key("skybot", url)
    cached = http.cache_read(cache_dir, key, 30 * 86400)  # ephemerides refine; refresh monthly
    if cached is not None:
        return cached | {"cache": "cached"}
    raw = (fetch or http.http_get)(url, timeout)
    result = {"mjd": float(mjd), "objects": parse(raw), "query_url": url,
              "retrieved_utc": Time.now().isot, "observer": "500 (geocentre)"}
    http.cache_write(cache_dir, key, result)
    return result | {"cache": "live"}


def cone_search_epochs(ra: float, dec: float, radius_arcmin: float, mjds: Sequence[float], *,
                       max_queries: int = 12, workers: int = 4, **kwargs) -> dict:
    """Query up to ``max_queries`` epochs (evenly sampled) in parallel.

    Errors are returned per epoch, never converted into "no objects".
    """
    from concurrent.futures import ThreadPoolExecutor

    mjds = sorted({float(m) for m in mjds})
    if len(mjds) > max_queries:
        idx = [round(i * (len(mjds) - 1) / (max_queries - 1)) for i in range(max_queries)]
        mjds = [mjds[i] for i in sorted(set(idx))]

    def one(m):
        try:
            return cone_search(ra, dec, radius_arcmin, m, **kwargs)
        except Exception as exc:  # noqa: BLE001 - surfaced to caller
            return {"mjd": m, "error": str(exc), "objects": None}

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        epochs = list(pool.map(one, mjds))
    return {"epochs": epochs, "citation": CITATION, "caveats": CAVEATS,
            "kind": "ephemeris_predicted",
            "n_failed": sum(1 for e in epochs if e.get("error"))}
