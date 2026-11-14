"""Gaia DR3 cone search (ESA Gaia archive TAP) and position prediction.

Positions returned by ``propagate`` are CATALOG PREDICTIONS, never detections.

Propagation model
-----------------
1. Space motion from the Gaia reference epoch (J2016.0 TCB) to each epoch with
   ``erfa.pmsafe`` - the same SOFA/ERFA routine used internally by astropy's
   ``SkyCoord.apply_space_motion`` - including perspective acceleration when the
   parallax and radial velocity are known (missing RV -> 0 km/s, stated).
2. Annual parallax for an observer at the geocentre (SPHEREx is in low Earth
   orbit; the ~7000 km offset is negligible for stars): the barycentric
   direction u is displaced to ``normalize(u - parallax_rad * b_earth[AU])``
   using astropy's built-in solar-system ephemeris for b_earth.
   Aberration is NOT applied: SPHEREx WCS solutions are astrometric (fit to
   reference catalogs), so the astrometric place is the comparable quantity.
3. A 1-sigma position uncertainty per epoch from the catalog errors, ignoring
   correlations (Gaia covariances are not propagated - stated in output).

Sources with 2-parameter solutions (no PM/parallax) are kept at their
reference position and labelled.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from urllib.parse import urlencode
import warnings

import erfa
import numpy as np
from astropy import units as u
from astropy.coordinates import get_body_barycentric
from astropy.time import Time

from spherex.science import http

TAP_SYNC = "https://gea.esac.esa.int/tap-server/tap/sync"
TABLE = "gaiadr3.gaia_source"
GAIA_REF_EPOCH_JYEAR = 2016.0
CITATION = ("Gaia Collaboration, Vallenari et al. 2023, A&A 674, A1 (Gaia DR3); "
            "ESA Gaia Archive https://gea.esac.esa.int/archive/")
COLUMNS = ("source_id", "ra", "dec", "ra_error", "dec_error", "ref_epoch", "pmra", "pmdec",
           "pmra_error", "pmdec_error", "parallax", "parallax_error", "radial_velocity",
           "phot_g_mean_mag", "ruwe", "astrometric_params_solved")
MAX_RADIUS_ARCMIN = 30.0
FASTEST_PM_ARCSEC_YR = 10.5  # Barnard's Star, ~10.39 arcsec/yr (Gaia DR3), rounded up
INNER_MARGIN_ARCSEC = 30.0
PROPAGATION_CAVEATS = [
    "Predicted positions from Gaia DR3 astrometry (epoch J2016.0); not SPHEREx detections.",
    "Gaia covariances are not propagated; per-epoch errors combine catalog sigmas in quadrature.",
    "Missing radial velocity is assumed 0 km/s.",
    "Geocentric annual parallax included; aberration not applied (astrometric place).",
    "Gaia is incomplete for very red, faint objects (e.g. Y dwarfs such as WISE 0855).",
]


def build_adql(ra: float, dec: float, radius_arcmin: float, max_years: float,
               max_rows: int = 2000) -> str:
    """Cone around (ra, dec); fast movers are searched in a larger circle.

    Stars that can move > INNER_MARGIN_ARCSEC between J2016 and the latest epoch
    are found with a radius enlarged by FASTEST_PM * years, filtered on pm.
    """
    r_inner = radius_arcmin / 60 + INNER_MARGIN_ARCSEC / 3600
    years = max(abs(max_years), 1.0)
    r_outer = radius_arcmin / 60 + FASTEST_PM_ARCSEC_YR * years / 3600
    pm_min = 1000 * INNER_MARGIN_ARCSEC / years  # mas/yr
    cols = ", ".join(COLUMNS)
    pt = "POINT('ICRS', ra, dec)"
    return (f"SELECT TOP {int(max_rows)} {cols} FROM {TABLE} WHERE "
            f"1=CONTAINS({pt}, CIRCLE('ICRS', {ra:.8f}, {dec:.8f}, {r_inner:.8f})) OR "
            f"(pm > {pm_min:.3f} AND 1=CONTAINS({pt}, CIRCLE('ICRS', {ra:.8f}, {dec:.8f}, {r_outer:.8f}))) "
            "ORDER BY phot_g_mean_mag ASC")


def parse_tap_json(raw: bytes | str) -> list[dict]:
    import json

    data = json.loads(raw)
    names = [m["name"] for m in data["metadata"]]
    rows = []
    for values in data["data"]:
        row = dict(zip(names, values, strict=True))
        row["source_id"] = str(row["source_id"])  # 64-bit ids exceed JS safe integers
        rows.append(row)
    return rows


def cone_query(ra: float, dec: float, radius_arcmin: float, *, max_mjd: float | None = None,
               max_rows: int = 2000, timeout: float = 40.0, cache_dir: Path | None = None,
               fetch: http.Fetch | None = None) -> dict:
    """Run (or replay from cache) the ADQL cone query. Raises RuntimeError on failure."""
    if not (0 < radius_arcmin <= MAX_RADIUS_ARCMIN):
        raise ValueError(f"radius_arcmin must be in (0, {MAX_RADIUS_ARCMIN}]")
    if not (0 <= ra < 360 and -90 <= dec <= 90):
        raise ValueError("Invalid ICRS coordinates")
    target_jyear = Time(max_mjd if max_mjd is not None else Time.now().mjd, format="mjd").jyear
    years = target_jyear - GAIA_REF_EPOCH_JYEAR
    adql = build_adql(ra, dec, radius_arcmin, years, max_rows)
    url = TAP_SYNC + "?" + urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": adql})
    key = http.cache_key("gaia", adql)
    cached = http.cache_read(cache_dir, key, None)  # DR3 is static
    if cached is not None:
        return cached | {"cache": "cached"}
    raw = (fetch or http.http_get)(url, timeout)
    result = {"rows": parse_tap_json(raw), "adql": adql, "url": url, "retrieved_utc": _utc_now(),
              "truncated": False}
    result["truncated"] = len(result["rows"]) >= max_rows
    http.cache_write(cache_dir, key, result)
    return result | {"cache": "live"}


def _utc_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _num(value, default=np.nan) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if np.isfinite(out) else default


def propagate_arrays(rows: Sequence[dict], mjds: Sequence[float], *, include_parallax: bool = True
                     ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (ra[N,M], dec[N,M], err_arcsec[N,M]) predicted at UTC MJDs."""
    mjds = np.atleast_1d(np.asarray(mjds, float))
    n = len(rows)
    if n == 0 or mjds.size == 0:
        return (np.empty((n, mjds.size)),) * 3
    ra = np.radians([_num(r["ra"]) for r in rows])
    dec = np.radians([_num(r["dec"]) for r in rows])
    pmra = np.array([_num(r.get("pmra"), 0.0) for r in rows])  # mu_alpha* mas/yr
    pmdec = np.array([_num(r.get("pmdec"), 0.0) for r in rows])
    plx = np.array([_num(r.get("parallax"), 0.0) for r in rows])  # mas
    rv = np.array([_num(r.get("radial_velocity"), 0.0) for r in rows])
    has_5p = np.array([np.isfinite(_num(r.get("pmra"))) for r in rows])
    plx_used = np.where(has_5p & (plx > 0), plx, 0.0)
    ref_epochs = np.array([_num(r.get("ref_epoch"), GAIA_REF_EPOCH_JYEAR) for r in rows])

    mas = np.pi / (180 * 3600 * 1000)
    pmr = pmra * mas / np.cos(dec)  # d(alpha)/dt, rad/yr (ERFA convention)
    pmd = pmdec * mas
    t_ref = Time(ref_epochs, format="jyear", scale="tcb").tdb
    t_new = Time(mjds, format="mjd", scale="utc").tdb
    with np.errstate(all="ignore"), warnings.catch_warnings():
        # ERFA warns "distance overridden" for parallax 0 (no-distance sources): expected.
        warnings.simplefilter("ignore", erfa.ErfaWarning)
        ra2, dec2, *_ = erfa.pmsafe(
            ra[:, None], dec[:, None], pmr[:, None], pmd[:, None], (plx_used / 1000)[:, None],
            rv[:, None], t_ref.jd1[:, None], t_ref.jd2[:, None], t_new.jd1[None, :], t_new.jd2[None, :])
    # Stars without 5-parameter astrometry stay at their reference position.
    ra2 = np.where(has_5p[:, None], ra2, ra[:, None])
    dec2 = np.where(has_5p[:, None], dec2, dec[:, None])

    if include_parallax:
        b = get_body_barycentric("earth", t_new).xyz.to_value(u.au)  # (3, M)
        vec = np.stack([np.cos(dec2) * np.cos(ra2), np.cos(dec2) * np.sin(ra2), np.sin(dec2)])
        p_rad = (plx_used * mas)[None, :, None]
        vec = vec - p_rad * b[:, None, :]
        vec /= np.linalg.norm(vec, axis=0)
        ra2 = np.arctan2(vec[1], vec[0])
        dec2 = np.arcsin(np.clip(vec[2], -1, 1))

    dt_yr = (t_new.jd1[None, :] + t_new.jd2[None, :] - t_ref.jd1[:, None] - t_ref.jd2[:, None]) / 365.25
    sig = lambda key: np.array([_num(r.get(key), 0.0) for r in rows])[:, None]  # noqa: E731
    err_mas = np.sqrt(sig("ra_error") ** 2 + sig("dec_error") ** 2
                      + (dt_yr ** 2) * (sig("pmra_error") ** 2 + sig("pmdec_error") ** 2)
                      + (sig("parallax_error") ** 2 if include_parallax else 0.0))
    return np.degrees(ra2) % 360, np.degrees(dec2), err_mas / 1000.0


def angular_sep_arcsec(ra1, dec1, ra2, dec2) -> np.ndarray:
    ra1, dec1, ra2, dec2 = (np.radians(np.asarray(v, float)) for v in (ra1, dec1, ra2, dec2))
    s = (np.sin((dec2 - dec1) / 2) ** 2 + np.cos(dec1) * np.cos(dec2) * np.sin((ra2 - ra1) / 2) ** 2)
    return np.degrees(2 * np.arcsin(np.sqrt(np.clip(s, 0, 1)))) * 3600


def predict_sources(ra: float, dec: float, radius_arcmin: float, mjds: Sequence[float], *,
                    max_sources: int = 300, include_parallax: bool = True,
                    cache_dir: Path | None = None, fetch: http.Fetch | None = None,
                    timeout: float = 40.0) -> dict:
    """V2 /gaia payload: Gaia DR3 sources inside the cone at any requested epoch."""
    mjds = [float(m) for m in mjds] or [float(Time.now().mjd)]
    query = cone_query(ra, dec, radius_arcmin, max_mjd=max(mjds), cache_dir=cache_dir,
                       fetch=fetch, timeout=timeout)
    rows = query["rows"]
    pra, pdec, perr = propagate_arrays(rows, mjds, include_parallax=include_parallax)
    sep = angular_sep_arcsec(ra, dec, pra, pdec) if rows else np.empty((0, len(mjds)))
    inside = (sep <= radius_arcmin * 60).any(axis=1) if rows else np.zeros(0, bool)
    sources = []
    for i in np.flatnonzero(inside)[:max_sources]:
        r = rows[i]
        sources.append({
            "source_id": r["source_id"],
            "ra": _num(r["ra"]), "dec": _num(r["dec"]),
            "ref_epoch": _num(r.get("ref_epoch"), GAIA_REF_EPOCH_JYEAR),
            "pmra": _opt(r.get("pmra")), "pmdec": _opt(r.get("pmdec")),
            "parallax": _opt(r.get("parallax")),
            "radial_velocity": _opt(r.get("radial_velocity")),
            "phot_g_mean_mag": _opt(r.get("phot_g_mean_mag")),
            "ruwe": _opt(r.get("ruwe")),
            "astrometry": "5/6-parameter" if np.isfinite(_num(r.get("pmra"))) else
                          "2-parameter (position fixed at reference epoch)",
            "positions": [{"mjd": m, "ra": float(pra[i, j]), "dec": float(pdec[i, j]),
                           "err_arcsec": float(perr[i, j])} for j, m in enumerate(mjds)],
            "kind": "catalog_predicted",
        })
    return {
        "sources": sources,
        "n_sources_total": int(inside.sum()),
        "truncated": bool(query["truncated"] or inside.sum() > max_sources),
        "kind": "catalog_predicted",
        "caveats": PROPAGATION_CAVEATS,
        "provenance": {"citation": CITATION, "adql": query["adql"], "query_url": query["url"],
                       "retrieved_utc": query["retrieved_utc"], "table": TABLE},
        "cache": query["cache"],
    }


def source_predictor(source: dict, *, include_parallax: bool = True):
    """Callable mjd -> (ra, dec) predicted for one /gaia source dict."""
    row = {"ra": source["ra"], "dec": source["dec"], "ref_epoch": source.get("ref_epoch", GAIA_REF_EPOCH_JYEAR),
           "pmra": source.get("pmra"), "pmdec": source.get("pmdec"), "parallax": source.get("parallax"),
           "radial_velocity": source.get("radial_velocity")}

    def predict(mjd: float) -> tuple[float, float]:
        ra, dec, _ = propagate_arrays([row], [mjd], include_parallax=include_parallax)
        return float(ra[0, 0]), float(dec[0, 0])

    return predict


def _opt(value):
    v = _num(value)
    return None if not np.isfinite(v) else v


def nearest_match(sources: list[dict], ra: float, dec: float, mjd: float | None, radius_arcsec: float) -> dict | None:
    """Closest predicted source to (ra, dec): at the epoch nearest ``mjd``, or at
    any listed epoch when ``mjd`` is None. None if beyond ``radius_arcsec``."""
    best, best_sep = None, np.inf
    for s in sources:
        cands = s["positions"] if mjd is None else [min(s["positions"], key=lambda p: abs(p["mjd"] - mjd))]
        for pos in cands:
            sep = float(angular_sep_arcsec(ra, dec, pos["ra"], pos["dec"]))
            if sep < best_sep:
                best, best_sep = (s, pos), sep
    if best is None or best_sep > radius_arcsec:
        return None
    return {"source": best[0], "position": best[1], "separation_arcsec": best_sep}
