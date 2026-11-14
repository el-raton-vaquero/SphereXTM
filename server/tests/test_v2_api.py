"""HTTP contract tests for the PRISM /v2 router (offline; live.search is stubbed)."""
from __future__ import annotations

import json

from fastapi.testclient import TestClient
import pytest

from spherex import live, targets_v2, v2
from spherex.api import app

client = TestClient(app)


def test_targets_registry_has_six_catalog_resolved_presets():
    res = client.get("/v2/targets")
    assert res.status_code == 200
    targets = res.json()["targets"]
    assert [t["id"] for t in targets] == ["barnard", "eps-indi-b", "wise-0855", "rw-aur", "r-dra", "m101"]
    for t in targets:
        assert 0 <= t["ra"] < 360 and -90 <= t["dec"] <= 90
        assert t["category"] and t["blurb"] and t["why"]
        assert t["position"]["kind"] == "catalog_predicted"
        assert t["catalog"]["source"].startswith(("Gaia DR3", "SIMBAD"))
        assert t["catalog"]["epoch"] in ("J2016.0", "J2000.0")
        assert "pm_arcsec_yr" in t["expected"] and "saturated" in t["expected"]
    by_id = {t["id"]: t for t in targets}
    assert abs(by_id["barnard"]["expected"]["pm_arcsec_yr"] - 10.39) < 0.05
    assert by_id["eps-indi-b"]["catalog"]["source"] == "Gaia DR3 6412596012146801152"


def test_display_position_is_propagated_from_catalog_epoch():
    reg = targets_v2.load_registry()
    barnard = next(t for t in reg["targets"] if t["id"] == "barnard")
    ra, dec = targets_v2.propagate(barnard["catalog"], targets_v2.DISPLAY_EPOCH_MJD)
    assert abs(ra - barnard["ra"]) < 1e-9 and abs(dec - barnard["dec"]) < 1e-9
    # ~9.9 yr x 10.36"/yr northward from J2016.0
    assert 95 < (dec - barnard["catalog"]["dec_deg"]) * 3600 < 110


def test_search_passes_parameters_and_returns_payload(monkeypatch):
    seen = {}

    def fake_search(ra, dec, fov, max_frames, collections, **_):
        seen.update(ra=ra, dec=dec, fov=fov, max_frames=max_frames, collections=collections)
        return {"query": {"ra": ra}, "frames": [], "cache": "live"}

    monkeypatch.setattr(live, "search", fake_search)
    res = client.get("/v2/search", params={"ra": 133.79, "dec": -7.24, "fov": 6,
                                           "max_frames": 20, "collections": "spherex_dr1"})
    assert res.status_code == 200 and res.json()["cache"] == "live"
    assert seen == {"ra": 133.79, "dec": -7.24, "fov": 6.0, "max_frames": 20,
                    "collections": ("spherex_dr1",)}


@pytest.mark.parametrize("params", [
    {"ra": 400, "dec": 0}, {"ra": 10, "dec": 95}, {"ra": 10, "dec": 0, "fov": 0.5},
    {"ra": 10, "dec": 0, "fov": 21}, {"ra": 10, "dec": 0, "max_frames": 161},
])
def test_search_validation_422(params):
    assert client.get("/v2/search", params=params).status_code == 422


def test_search_rejects_unknown_collection():
    res = client.get("/v2/search", params={"ra": 1, "dec": 1, "collections": "spherex_qr2"})
    assert res.status_code == 422 and res.json()["error_type"] == "unsupported_collection"


def test_search_live_error_is_transparent(monkeypatch):
    def fail(*a, **k):
        raise live.LiveError(502, "archive_unavailable", "IRSA SIA2 query failed: HTTP 502",
                             query_url="https://irsa.ipac.caltech.edu/SIA?x")

    monkeypatch.setattr(live, "search", fail)
    res = client.get("/v2/search", params={"ra": 1, "dec": 1})
    assert res.status_code == 502
    body = res.json()
    assert body["error_type"] == "archive_unavailable" and "frames" not in body


def test_search_stream_emits_progress_then_result(monkeypatch):
    def fake_search(ra, dec, fov, max_frames, collections, progress=None, **_):
        progress({"stage": "discovery"})
        progress({"stage": "frames", "done": 1, "total": 1})
        return {"frames": [], "cache": "live"}

    monkeypatch.setattr(live, "search", fake_search)
    with client.stream("GET", "/v2/search/stream", params={"ra": 1, "dec": 1}) as res:
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/event-stream")
        # Proxies (Next's rewrite) must not gzip/buffer the stream.
        assert "no-transform" in res.headers["cache-control"]
        text = "".join(res.iter_text())
    events = [blk for blk in text.split("\n\n") if blk.startswith("event:")]
    names = [blk.split("\n")[0].split(": ")[1] for blk in events]
    # An immediate named progress event resets the browser's silence timer.
    assert names == ["progress", "progress", "progress", "result"]
    assert json.loads(events[-1].split("data: ", 1)[1])["cache"] == "live"


def test_search_stream_reports_errors(monkeypatch):
    def fail(*a, **k):
        raise live.LiveError(404, "no_coverage", "no products")

    monkeypatch.setattr(live, "search", fail)
    with client.stream("GET", "/v2/search/stream", params={"ra": 1, "dec": 1}) as res:
        text = "".join(res.iter_text())
    assert "event: error" in text and "no_coverage" in text


@pytest.mark.parametrize("path,params", [
    ("/v2/gaia", {"ra": 1, "dec": 1, "radius_arcmin": 2, "mjd": "60900,61000"}),
    ("/v2/skybot", {"ra": 1, "dec": 1, "radius_arcmin": 2, "mjd": 60900}),
    ("/v2/spectrum", {"ra": 1, "dec": 1}),
    ("/v2/verdict", {"ra": 1, "dec": 1, "fov": 4}),
])
def test_unregistered_providers_are_501_not_fake(path, params, monkeypatch):
    monkeypatch.setattr(v2, "PROVIDERS", {})
    res = client.get(path, params=params)
    assert res.status_code == 501 and res.json()["error_type"] == "not_implemented"


def test_registered_provider_is_called(monkeypatch):
    monkeypatch.setattr(v2, "PROVIDERS", {})
    v2.register_provider("gaia", lambda **kw: {"sources": [], "echo": kw["mjd"]})
    res = client.get("/v2/gaia", params={"ra": 1, "dec": 1, "mjd": "60900,61000"})
    assert res.status_code == 200 and res.json()["echo"] == [60900.0, 61000.0]
    with pytest.raises(ValueError):
        v2.register_provider("nope", lambda **kw: {})


def test_gaia_mjd_validation(monkeypatch):
    monkeypatch.setattr(v2, "PROVIDERS", {})
    res = client.get("/v2/gaia", params={"ra": 1, "dec": 1, "mjd": "abc"})
    assert res.status_code == 422


def test_legacy_frames_route_still_mounted():
    paths = set(app.openapi()["paths"])
    assert {"/frames", "/health", "/v2/search", "/v2/search/stream", "/v2/targets"} <= paths
    assert client.get("/frames", params={"ra": 999, "dec": 0}).status_code == 422


def test_concurrent_identical_searches_share_one_download(monkeypatch):
    import threading
    import time

    calls = []

    def slow_search(ra, dec, fov, max_frames, collections, progress=None, **_):
        calls.append(1)
        time.sleep(0.3)
        return {"frames": [], "cache": "live"}

    monkeypatch.setattr(live, "search", slow_search)
    results = []

    def run():
        results.append(client.get("/v2/search", params={"ra": 5, "dec": 5}).status_code)

    threads = [threading.Thread(target=run) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results == [200, 200, 200]
    assert len(calls) == 1
