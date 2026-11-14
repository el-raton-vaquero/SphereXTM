"""Integration wiring between /v2 and spherex.science (offline)."""
import numpy as np
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from spherex import live, v2, v2_providers
from spherex.api import app


def test_science_providers_are_registered():
    for name in v2.PROVIDER_NAMES:
        assert v2.PROVIDERS.get(name) is not None, name


def test_upstream_failure_is_transparent_502(monkeypatch):
    def boom(**_):
        raise HTTPException(502, {"error": "SPHEREx frames unavailable: test", "source": "IRSA"})

    monkeypatch.setitem(v2_providers._ENDPOINTS, "/v2/verdict", boom)
    res = TestClient(app).get("/v2/verdict", params={"ra": 10, "dec": 10, "fov": 4})
    assert res.status_code == 502
    body = res.json()
    assert body["error_type"] == "upstream_unavailable" and "unavailable" in body["detail"]
    assert body["source"] == "IRSA"


def test_spectrum_rejects_out_of_range_aperture():
    res = TestClient(app).get("/v2/spectrum", params={"ra": 10, "dec": 10, "aperture_arcsec": 45})
    assert res.status_code == 422


def test_skybot_flattens_single_epoch(monkeypatch):
    monkeypatch.setitem(v2_providers._ENDPOINTS, "/v2/skybot", lambda **kw: {
        "epochs": [{"mjd": 61000.0, "objects": [{"name": "Ceres", "ra": 1.0, "dec": 2.0}]}], "n_failed": 0})
    out = v2_providers.skybot(ra=1.0, dec=2.0, radius_arcmin=1.0, mjd=61000.0)
    assert out["objects"][0]["name"] == "Ceres" and out["mjd"] == 61000.0


def test_epsf_row_dtype_matches_spherex_table():
    # TFORMs of the DR1 EPSF table: 2J, 4E, J, 3E, 1089D -> NAXIS1 = 8752 bytes.
    assert v2_providers.EPSF_ROW_DTYPE.itemsize == 8752
    row = np.zeros(1, v2_providers.EPSF_ROW_DTYPE)[0]
    assert row["EPSF"].shape == (33, 33)


def test_no_coverage_is_404_not_empty(monkeypatch, tmp_path):
    monkeypatch.setenv("PRISM_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(live, "discover", lambda *a, **k: ([], ["https://irsa.ipac.caltech.edu/SIA?x"], False, []))
    monkeypatch.setattr(live, "native_frames", lambda *a, **k: ([], [], []))
    with pytest.raises(HTTPException) as exc:
        v2_providers.LiveFrameSource().fetch(1.0, 2.0, 2.0, 10)
    assert exc.value.status_code == 404
