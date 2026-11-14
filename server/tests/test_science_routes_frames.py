"""Router contract with synthetic (test-only) frames and stubbed catalog replies."""

import json

from astropy.io import fits
from astropy.table import Table
from fastapi import FastAPI
from fastapi.testclient import TestClient
import numpy as np
import pytest

from science_synth import make_frame
from spherex.science import flags as fl
from spherex.science import http
from spherex.science.frames import load_native_frame
from spherex.science.routes import build_router, sanitize
from test_science_catalogs import SKYBOT_SAMPLE, tap_reply

RA, DEC = 150.0, 2.0


def synthetic_frames(ra, dec, fov, max_frames):
    out = []
    lams = np.linspace(1.0, 5.0, 12)
    for s, mjd0 in enumerate([60800, 60990]):
        for k, lam in enumerate(lams):
            out.append(make_frame(ra, dec, sources=[(ra, dec, 2.0)], mjd=mjd0 + 0.2 * k, lambda_um=float(lam),
                                  bandwidth_um=float(lam / 50), detector=1 + k // 2, seed=100 * s + k, noise=0.005))
    return out[:max_frames]


@pytest.fixture
def client(tmp_path, monkeypatch):
    def fake_get(url, timeout=30, limit=0):
        if "gea.esac.esa.int" in url:
            return tap_reply([{"source_id": "999", "ra": RA, "dec": DEC, "ref_epoch": 2016.0, "pmra": 0.0,
                               "pmdec": 0.0, "parallax": 0.0, "phot_g_mean_mag": 14.0}])
        if "imcce" in url:
            return SKYBOT_SAMPLE.encode()  # object 186" away: outside the match radius
        raise AssertionError(url)

    monkeypatch.setattr(http, "http_get", fake_get)
    app = FastAPI()
    app.include_router(build_router(synthetic_frames, cache_dir=tmp_path))
    return TestClient(app)


def test_gaia_and_skybot_endpoints(client):
    r = client.get("/v2/gaia", params={"ra": RA, "dec": DEC, "radius_arcmin": 1, "mjd": "60800,60990"})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "catalog_predicted" and body["sources"][0]["source_id"] == "999"
    assert len(body["sources"][0]["positions"]) == 2 and "adql" in body["provenance"]
    r = client.get("/v2/skybot", params={"ra": RA, "dec": DEC, "radius_arcmin": 5, "mjd": "60800"})
    assert r.status_code == 200 and r.json()["epochs"][0]["objects"][0]["name"] == "2013 CD139"
    assert client.get("/v2/gaia", params={"ra": RA, "dec": DEC, "mjd": "abc"}).status_code == 422
    assert client.get("/v2/skybot", params={"ra": 400, "dec": DEC, "mjd": "60800"}).status_code == 422


def test_spectrum_endpoint_contract(client):
    r = client.get("/v2/spectrum", params={"ra": RA, "dec": DEC, "aperture_arcsec": 9})
    assert r.status_code == 200
    body = r.json()
    json.dumps(body, allow_nan=False)
    assert body["unit"] == "mJy" and len(body["points"]) == 24
    p = body["points"][0]
    for key in ("lambda_um", "flux", "err", "unit", "mjd", "season", "detector", "frame_id", "flags", "saturated"):
        assert key in p
    assert abs(p["flux"] - 2.0) < 0.15
    assert set(body["by_season"]) == {"0", "1"}
    assert body["classification"]["method"] == "template chi2 with scale fit"
    assert {g["id"] for g in body["goggles"]} == {"ch4", "h2o", "co2", "co"}


def test_verdict_endpoint_contract(client):
    r = client.get("/v2/verdict", params={"ra": RA, "dec": DEC, "fov": 2})
    assert r.status_code == 200
    body = r.json()
    json.dumps(body, allow_nan=False)
    assert body["verdict"] == "known_star"  # stub Gaia source at the position
    assert 0 <= body["confidence"] <= 1
    checks = {c["id"]: c for c in body["checks"]}
    assert {"saturation", "artifacts", "detection", "gaia", "skybot", "motion", "variability", "spectrum"} <= set(checks)
    assert checks["motion"]["status"] in ("pass", "warn")  # stationary source, two seasons
    assert checks["skybot"]["status"] == "warn"


def test_frame_failure_is_transparent(tmp_path):
    def broken(ra, dec, fov, n):
        raise RuntimeError("IRSA timeout")

    app = FastAPI()
    app.include_router(build_router(broken, cache_dir=tmp_path))
    r = TestClient(app).get("/v2/spectrum", params={"ra": RA, "dec": DEC})
    assert r.status_code == 502 and "IRSA timeout" in r.json()["detail"]["error"]


def test_sanitize():
    out = sanitize({"a": np.float32(np.nan), "b": np.int64(3), "c": np.array([1]), "d": [np.inf, 1.5], "e": np.bool_(True)})
    assert out == {"a": None, "b": 3, "d": [None, 1.5], "e": True}


def test_load_native_frame_from_mef(tmp_path):
    """MEF with the DR1 layout (IMAGE/FLAGS/VARIANCE/EPSF, A-WCS detector offsets)."""
    f = make_frame()
    hdr = f["wcs"].to_header()
    hdr["BUNIT"] = "MJy / sr"
    hdr["MJD-OBS"] = 60800.5
    hdr["DETECTOR"] = 6
    hdr["OBSID"] = "2025W19_1B_0116_1"
    hdr["PSF_FWHM"] = 9.0
    hdr["CRPIX1A"], hdr["CRPIX2A"] = -349.0, -139.0
    fh = fits.Header()
    for bit, (name, desc) in fl.DR1_FLAG_DEFINITIONS.items():
        fh[f"MSKN{bit:04d}"] = name
        fh[f"MSKM{bit:04d}"] = 1 << bit
    flags = np.zeros((25, 25), np.int32)
    flags[3, 4] = 2
    zones = Table({"BINX": [0, 3], "BINY": [0, 1], "XCENTER": [48.0, 340.0], "YCENTER": [48.0, 145.0],
                   "CWAVE": [4.5, 4.6], "EPSF": [np.zeros((33, 33)), np.ones((33, 33))]})
    eh = fits.BinTableHDU(zones, name="EPSF")
    eh.header["OVSMPX"] = 5
    path = tmp_path / "x.fits"
    fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(f["image"].astype(np.float32), hdr, name="IMAGE"),
                  fits.ImageHDU(flags, fh, name="FLAGS"),
                  fits.ImageHDU(f["variance"].astype(np.float32), name="VARIANCE"), eh]).writeto(path)
    frame = load_native_frame(path, {"collection": "spherex_dr1"})
    assert frame["detector"] == 6 and frame["mjd"] == 60800.5 and frame["collection"] == "spherex_dr1"
    assert frame["flag_definitions"][1] == "OVERFLOW" and frame["flags"][3, 4] == 2
    # cutout centre (12, 12) -> detector (13 + 349, 13 + 139) = (362, 152): zone (3, 1)
    assert frame["extra"]["epsf"]["zone"] == [3, 1] and frame["epsf"].sum() == 33 * 33
    assert frame["wavelength_map"] is None  # no spectral WCS in this test file
