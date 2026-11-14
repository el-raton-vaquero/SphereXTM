"""Gaia + SkyBoT clients, with recorded/handwritten replies (no network)."""

import json

from astropy import units as u
from astropy.coordinates import Distance, SkyCoord
from astropy.time import Time
import numpy as np
import pytest

from spherex.science import gaia, skybot

# Barnard's Star, Gaia DR3 4472832130942575872 (values as returned by the live
# TAP query on 2026-11-14 and recorded in spherex/data/m4-targets.json).
BARNARD = {"source_id": "4472832130942575872", "ra": 269.44850252543836, "dec": 4.739420051112412,
           "ra_error": 0.026, "dec_error": 0.029, "ref_epoch": 2016.0,
           "pmra": -801.5509783684709, "pmdec": 10362.394206546573, "pmra_error": 0.032, "pmdec_error": 0.036,
           "parallax": 546.975939730948, "parallax_error": 0.04, "radial_velocity": -110.46822,
           "phot_g_mean_mag": 8.19, "ruwe": 1.1, "astrometric_params_solved": 31}


def tap_reply(rows):
    names = list(gaia.COLUMNS)
    return json.dumps({"metadata": [{"name": n} for n in names],
                       "data": [[r.get(n) for n in names] for r in rows]}).encode()


def test_adql_has_fast_mover_branch():
    q = gaia.build_adql(10.0, -5.0, 2.0, 10.0)
    assert "pm >" in q and q.count("CIRCLE") == 2 and "gaiadr3.gaia_source" in q


def test_space_motion_matches_astropy_without_parallax():
    mjd = 61000.0
    ra, dec, err = gaia.propagate_arrays([BARNARD], [mjd], include_parallax=False)
    c = SkyCoord(ra=BARNARD["ra"] * u.deg, dec=BARNARD["dec"] * u.deg,
                 distance=Distance(parallax=BARNARD["parallax"] * u.mas),
                 pm_ra_cosdec=BARNARD["pmra"] * u.mas / u.yr, pm_dec=BARNARD["pmdec"] * u.mas / u.yr,
                 radial_velocity=BARNARD["radial_velocity"] * u.km / u.s,
                 obstime=Time(2016.0, format="jyear", scale="tcb"))
    p = c.apply_space_motion(new_obstime=Time(mjd, format="mjd", scale="utc"))
    sep = gaia.angular_sep_arcsec(ra[0, 0], dec[0, 0], p.ra.deg, p.dec.deg)
    assert sep < 0.002  # < 2 mas
    assert 0 < err[0, 0] < 0.01


def test_annual_parallax_amplitude():
    star = dict(BARNARD, pmra=0.0, pmdec=0.0, radial_velocity=None, parallax=1000.0, ra=270.0, dec=66.56)
    mjds = np.linspace(61000, 61365, 25)
    ra, dec, _ = gaia.propagate_arrays([star], mjds)
    ra0, dec0, _ = gaia.propagate_arrays([star], mjds, include_parallax=False)
    sep = gaia.angular_sep_arcsec(ra, dec, ra0, dec0)[0]
    # Near the ecliptic pole the parallactic ellipse is ~a circle of radius = parallax
    # times the Earth-Sun distance (0.983-1.017 au, orbital eccentricity).
    assert 0.97 < sep.min() < 0.99 and 1.01 < sep.max() < 1.03


def test_two_parameter_source_stays_fixed():
    row = {"source_id": "1", "ra": 10.0, "dec": 20.0, "ref_epoch": 2016.0, "pmra": None, "pmdec": None,
           "parallax": None}
    ra, dec, _ = gaia.propagate_arrays([row], [61000.0])
    assert abs(ra[0, 0] - 10.0) < 1e-12 and abs(dec[0, 0] - 20.0) < 1e-12


def test_predict_sources_uses_cache(tmp_path):
    calls = []

    def fetch(url, timeout):
        calls.append(url)
        return tap_reply([BARNARD, dict(BARNARD, source_id="2", ra=269.40, dec=4.80, pmra=1.0, pmdec=1.0,
                                        parallax=0.5, radial_velocity=None, phot_g_mean_mag=15.0)])

    mjds = [60912.714, 61270.867]
    out = gaia.predict_sources(269.4462, 4.7686, 2.0, mjds, cache_dir=tmp_path, fetch=fetch)
    assert out["cache"] == "live" and out["kind"] == "catalog_predicted"
    ids = [s["source_id"] for s in out["sources"]]
    assert "4472832130942575872" in ids and "2" not in ids  # source 2 lies ~4 arcmin away
    b = out["sources"][0]
    assert b["kind"] == "catalog_predicted"
    # Moves ~10.4"/yr north: Dec increases between the two epochs by ~10 arcsec.
    d_dec = (b["positions"][1]["dec"] - b["positions"][0]["dec"]) * 3600
    assert 9.5 < d_dec < 11.0
    again = gaia.predict_sources(269.4462, 4.7686, 2.0, mjds, cache_dir=tmp_path, fetch=fetch)
    assert again["cache"] == "cached" and len(calls) == 1
    m = gaia.nearest_match(out["sources"], b["positions"][0]["ra"], b["positions"][0]["dec"], None, 9.0)
    assert m["source"]["source_id"] == "4472832130942575872" and m["separation_arcsec"] < 1e-6
    pred = gaia.source_predictor(b)(mjds[1])
    assert gaia.angular_sep_arcsec(*pred, b["positions"][1]["ra"], b["positions"][1]["dec"]) < 1e-6


def test_gaia_rejects_bad_radius():
    with pytest.raises(ValueError):
        gaia.cone_query(10, 10, 0, fetch=lambda u, t: b"")


SKYBOT_SAMPLE = (
    '[{"Num":396101,"Name":"2013 CD139","RA (hms)":"13 19 47.7326","DEC (dms)":"-10 00 42.953",'
    '"Class":"MB>Outer","VMag (mag)":21,"Err (arcsec)":0.043,"d (arcsec)":186.233,'
    '"dRA (arcsec\\/h)":-24.244,"dDEC (arcsec\\/h)":5.5161,"dg (ua)":1.928,"dh (ua)":2.887}]')


def test_skybot_parse_real_shape():
    objs = skybot.parse(SKYBOT_SAMPLE)
    assert objs[0]["name"] == "2013 CD139" and objs[0]["number"] == 396101
    assert abs(objs[0]["ra"] - (13 + 19 / 60 + 47.7326 / 3600) * 15) < 1e-6
    assert objs[0]["dec"] < -10 and objs[0]["dra_arcsec_per_h"] == -24.244
    assert skybot.parse("# Flag: 0\n# No solar system object was found in the FOV") == []
    with pytest.raises(RuntimeError):
        skybot.parse("<html>500 Internal error</html>")


def test_skybot_epochs_keep_errors(tmp_path):
    def fetch(url, timeout):
        if "2460800" in url:
            raise RuntimeError("HTTP 503")
        return SKYBOT_SAMPLE.encode()

    out = skybot.cone_search_epochs(200.0, -10.0, 5.0, [60799.5, 60900.0], cache_dir=tmp_path, fetch=fetch)
    errs = [e for e in out["epochs"] if e.get("error")]
    assert out["n_failed"] == 1 and errs[0]["objects"] is None
    ok = [e for e in out["epochs"] if not e.get("error")][0]
    assert ok["objects"][0]["kind"] == "ephemeris_predicted"
    assert "-ep=2460900.5" in ok["query_url"]
