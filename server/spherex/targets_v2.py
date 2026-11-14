"""PRISM preset targets resolved from real catalogs (Gaia DR3 TAP / SIMBAD TAP).

The committed registry ``data/prism-targets.json`` is produced by::

    uv run --locked python -m spherex.targets_v2 --refresh

Each entry keeps the raw catalog astrometry (with its reference epoch and bibcode)
and a *display position* propagated with ``SkyCoord.apply_space_motion`` (proper
motion + parallax distance + RV when known) to ``DISPLAY_EPOCH``, inside the SPHEREx
DR1 span. That position is a catalog PREDICTION used to centre the field; it is not
a SPHEREx measurement.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import io
import json
from pathlib import Path
from urllib.parse import urlencode

from astropy import units as u
from astropy.coordinates import Distance, SkyCoord
from astropy.time import Time
import numpy as np

from spherex.archive import fetch_bytes

REGISTRY = Path(__file__).with_name("data") / "prism-targets.json"
DISPLAY_EPOCH_MJD = 61000.0  # 2025-11-21 UTC, inside SPHEREx DR1 coverage
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
# The CDS host answered HTTP 404 for sim-tap from this network on 2026-11-14; the
# official SIMBAD mirror at Harvard CfA serves the same TAP schema.
SIMBAD_TAPS = ("https://simbad.cds.unistra.fr/simbad/sim-tap/sync",
               "https://simbad.harvard.edu/simbad/sim-tap/sync")

PRESETS = [
    {
        "id": "barnard", "name": "Barnard's Star", "category": "high_proper_motion",
        "catalog": "gaia", "gaia_source_id": "4472832130942575872", "simbad_id": "NAME Barnard's star",
        "expected": {"saturated": True, "best_detectors": [1, 2, 3],
                     "basis": "K ~ 4.5 mag; M4 study found OVERFLOW/BLOOM flags at predicted positions"},
        "blurb": "La estrella con mayor movimiento propio conocido: ~10.4\"/año.",
        "why": "Se mueve ~1.7 px por año de SPHEREx, pero satura el detector: PRISM lo muestra con banderas, no lo oculta.",
        "en": {"blurb": "Largest known proper motion: ~10.4\"/yr.",
               "why": "Moves ~1.7 px per SPHEREx year but saturates the detector; PRISM flags it instead of hiding it."},
    },
    {
        "id": "eps-indi-b", "name": "Epsilon Indi B", "category": "brown_dwarf",
        "catalog": "gaia", "gaia_source_id": "6412596012146801152", "simbad_id": "* eps Ind B",
        "expected": {"saturated": False, "best_detectors": [2, 3, 4],
                     "basis": "T-dwarf binary ~7.3' from the bright star eps Ind A (ghost/crosstalk risk)"},
        "blurb": "Par de enanas marrones T a 12 años luz; ~4.7\"/año.",
        "why": "Movimiento menor que un píxel por temporada y vecina brillante (eps Ind A): prueba de artefactos.",
        "en": {"blurb": "T-dwarf pair 12 light-years away; ~4.7\"/yr.",
               "why": "Sub-pixel motion per season next to a bright star (eps Ind A): an artifact test."},
    },
    {
        "id": "wise-0855", "name": "WISE 0855-0714", "category": "brown_dwarf",
        "catalog": "simbad", "simbad_id": "WISE J085510.83-071442.5",
        "expected": {"saturated": False, "best_detectors": [5, 6],
                     "basis": "Y dwarf, [4.5]=13.9 vs [3.6]=17.4 (Luhman 2014): only long-wave detectors"},
        "blurb": "La enana marrón más fría conocida (~285 K); ~8.2\"/año.",
        "why": "Invisible por debajo de ~3.5 µm: aparece sólo en D5/D6. Color y movimiento separados.",
        "en": {"blurb": "Coldest known brown dwarf (~285 K); ~8.2\"/yr.",
               "why": "Invisible below ~3.5 um: only D5/D6 see it. Colour and motion, separated."},
    },
    {
        "id": "rw-aur", "name": "RW Aurigae", "category": "variable_star",
        "catalog": "simbad", "simbad_id": "V* RW Aur",
        "expected": {"saturated": True, "best_detectors": [4, 5, 6],
                     "basis": "Bright T Tauri star (K ~ 7); saturation expected in several detectors"},
        "blurb": "Estrella T Tauri joven con apagones irregulares.",
        "why": "Variable real: cambia de brillo entre temporadas, no de posición.",
        "en": {"blurb": "Young T Tauri star with irregular dimmings.",
               "why": "A true variable: brightness changes between seasons, not position."},
    },
    {
        "id": "r-dra", "name": "R Draconis", "category": "variable_star",
        "catalog": "gaia", "gaia_source_id": "1648328016354496384", "simbad_id": "V* R Dra",
        "expected": {"saturated": True, "best_detectors": [1, 2],
                     "basis": "Mira variable, near-IR very bright; saturation expected"},
        "blurb": "Variable Mira con periodo de ~245 días.",
        "why": "Un periodo cabe en el lapso de SPHEREx: el brillo cambia mucho entre temporadas.",
        "en": {"blurb": "Mira variable with a ~245-day period.",
               "why": "One period fits within the SPHEREx span: large brightness changes between seasons."},
    },
    {
        "id": "m101", "name": "M101 (Pinwheel Galaxy)", "category": "reference_field",
        "catalog": "simbad", "simbad_id": "M 101",
        "expected": {"saturated": False, "best_detectors": [1, 2, 3, 4, 5, 6],
                     "basis": "Extended galaxy; static reference field (the existing /frames demo)"},
        "blurb": "Galaxia espiral: un campo de control estático.",
        "why": "Nada debería moverse aquí. Sirve para calibrar qué parece cambio y no lo es.",
        "en": {"blurb": "Spiral galaxy: a static control field.",
               "why": "Nothing should move here. Calibrates what looks like change but is not."},
    },
]


def _tap(url: str, query: str, timeout: float) -> list[dict]:
    full = url + "?" + urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv",
                                  "QUERY": query})
    data = fetch_bytes(full, 2 * 1024**2, timeout)
    return list(csv.DictReader(io.StringIO(data.decode())))


def _num(value) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if np.isfinite(v) else None


def resolve_gaia(source_id: str, timeout: float = 30.0) -> dict:
    query = ("SELECT source_id,ra,dec,ref_epoch,ra_error,dec_error,pmra,pmdec,parallax,"
             "parallax_error,radial_velocity,phot_g_mean_mag FROM gaiadr3.gaia_source "
             f"WHERE source_id={int(source_id)}")
    rows = _tap(GAIA_TAP, query, timeout)
    if len(rows) != 1 or rows[0]["source_id"] != str(source_id):
        raise ValueError(f"Expected one Gaia DR3 row for {source_id}")
    r = rows[0]
    return {"source": f"Gaia DR3 {source_id}", "service": GAIA_TAP, "query": query,
            "reference": "Gaia Collaboration 2023, A&A 674, A1 (Gaia DR3)",
            "ra_deg": float(r["ra"]), "dec_deg": float(r["dec"]),
            "epoch": f"J{float(r['ref_epoch']):.1f}", "epoch_jyear": float(r["ref_epoch"]),
            "pmra_masyr": _num(r["pmra"]), "pmdec_masyr": _num(r["pmdec"]),
            "parallax_mas": _num(r["parallax"]), "rv_kms": _num(r["radial_velocity"]),
            "phot_g_mean_mag": _num(r["phot_g_mean_mag"])}


def resolve_simbad(identifier: str, timeout: float = 30.0) -> dict:
    ident = identifier.replace("'", "''")
    query = ("SELECT b.main_id,b.ra,b.dec,b.coo_bibcode,b.pmra,b.pmdec,b.pm_bibcode,"
             "b.plx_value,b.plx_bibcode,b.rvz_radvel,b.otype FROM basic AS b JOIN ident AS i "
             f"ON i.oidref=b.oid WHERE i.id='{ident}'")
    last = None
    for url in SIMBAD_TAPS:
        try:
            rows = _tap(url, query, timeout)
        except Exception as exc:  # noqa: BLE001 - try the mirror, then report
            last = exc
            continue
        if len(rows) != 1:
            raise ValueError(f"Expected one SIMBAD row for {identifier}, got {len(rows)}")
        r = rows[0]
        return {"source": f"SIMBAD {r['main_id']}", "service": url, "query": query,
                "reference": f"coordinates {r['coo_bibcode']}; proper motion {r['pm_bibcode'] or 'n/a'}",
                "ra_deg": float(r["ra"]), "dec_deg": float(r["dec"]),
                # SIMBAD basic.ra/dec are ICRS at epoch J2000.
                "epoch": "J2000.0", "epoch_jyear": 2000.0,
                "pmra_masyr": _num(r["pmra"]), "pmdec_masyr": _num(r["pmdec"]),
                "parallax_mas": _num(r["plx_value"]), "rv_kms": _num(r["rvz_radvel"]),
                "otype": r["otype"]}
    raise RuntimeError(f"SIMBAD TAP unavailable: {last}")


def propagate(cat: dict, mjd: float) -> tuple[float, float]:
    """Apply space motion (PM, parallax distance, RV if known) to ``mjd``."""
    pmra, pmdec = cat.get("pmra_masyr"), cat.get("pmdec_masyr")
    if pmra is None or pmdec is None:
        return cat["ra_deg"], cat["dec_deg"]
    plx = cat.get("parallax_mas")
    kwargs = {}
    if plx and plx > 0:
        kwargs["distance"] = Distance(parallax=plx * u.mas)
        kwargs["radial_velocity"] = (cat.get("rv_kms") or 0.0) * u.km / u.s
    coord = SkyCoord(ra=cat["ra_deg"] * u.deg, dec=cat["dec_deg"] * u.deg,
                     pm_ra_cosdec=pmra * u.mas / u.yr, pm_dec=pmdec * u.mas / u.yr,
                     obstime=Time(cat["epoch_jyear"], format="jyear", scale="tcb"),
                     frame="icrs", **kwargs)
    moved = coord.apply_space_motion(new_obstime=Time(mjd, format="mjd", scale="utc"))
    return float(moved.ra.deg), float(moved.dec.deg)


def build_entry(preset: dict, cat: dict) -> dict:
    ra, dec = propagate(cat, DISPLAY_EPOCH_MJD)
    pm = None
    if cat.get("pmra_masyr") is not None and cat.get("pmdec_masyr") is not None:
        pm = float(np.hypot(cat["pmra_masyr"], cat["pmdec_masyr"]) / 1000.0)
    expected = dict(preset["expected"])
    expected["pm_arcsec_yr"] = pm
    expected["kind"] = "prior expectation, not a measurement"
    return {
        "id": preset["id"], "name": preset["name"], "ra": ra, "dec": dec,
        "category": preset["category"], "blurb": preset["blurb"], "why": preset["why"],
        "en": preset["en"], "expected": expected,
        "position": {"kind": "catalog_predicted", "frame": "ICRS",
                     "epoch_mjd": DISPLAY_EPOCH_MJD,
                     "epoch_utc": Time(DISPLAY_EPOCH_MJD, format="mjd").isot,
                     "method": "astropy SkyCoord.apply_space_motion (PM + parallax distance; RV if known, else 0)"},
        "catalog": cat,
    }


def resolve_all(timeout: float = 30.0) -> dict:
    targets = []
    for preset in PRESETS:
        if preset["catalog"] == "gaia":
            cat = resolve_gaia(preset["gaia_source_id"], timeout)
            cat["simbad_crossid"] = preset["simbad_id"]
        else:
            cat = resolve_simbad(preset["simbad_id"], timeout)
        targets.append(build_entry(preset, cat))
    return {"generated_utc": datetime.now(timezone.utc).isoformat(),
            "display_epoch_mjd": DISPLAY_EPOCH_MJD, "targets": targets}


def load_registry() -> dict:
    return json.loads(REGISTRY.read_text(encoding="utf-8"))


def public_targets() -> dict:
    reg = load_registry()
    return {"targets": reg["targets"], "generated_utc": reg["generated_utc"],
            "display_epoch_mjd": reg["display_epoch_mjd"]}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="re-resolve from Gaia/SIMBAD")
    parser.add_argument("--timeout", type=float, default=30.0)
    args = parser.parse_args(argv)
    if not args.refresh:
        print(json.dumps(public_targets(), indent=2))
        return 0
    data = resolve_all(args.timeout)
    REGISTRY.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    for t in data["targets"]:
        print(f"{t['id']:12s} {t['ra']:.6f} {t['dec']:+.6f}  {t['catalog']['source']} ({t['catalog']['epoch']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
