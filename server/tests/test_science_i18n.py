"""English/Spanish rendering of verdict and spectrum sentences (spherex.science.i18n + /v2 lang)."""

import copy
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from spherex import v2
from spherex.api import app
from spherex.science import classify, i18n, templates, verdict

from test_science_classify_verdict import det_points, gaia_match, make_points

SNAPSHOTS = Path(__file__).resolve().parents[2] / "frontend" / "public" / "snapshots"


def _verdicts():
    """A spread of real evaluate() outputs covering every check template."""
    sb_hit = {"epochs": [{"mjd": 60801.0, "objects": [{"name": "2013 CD139", "class": "MB>Outer", "vmag": 21,
                                                       "separation_arcsec": 4.0}]}]}
    sb_none = {"epochs": [{"mjd": 1, "objects": []}, {"mjd": 2, "error": "timeout", "objects": None}]}
    nb = [{"source_id": "575", "phot_g_mean_mag": 16.3, "separation_arcsec": 8.7}]
    reg = {"name": "WISE 0855-0714", "separation_arcsec": 0.2, "reference": "Luhman 2014"}
    motion_pred = {"status": "ok", "season_a": 1, "season_b": 3, "consistent_with_prediction": True,
                   "significant_motion": True,
                   "measured": {"total_arcsec": 9.1, "total_pixels": 1.48, "err_ra_arcsec": 0.4, "err_dec_arcsec": 0.5},
                   "predicted": {"total_arcsec": 9.0}}
    motion_free = {"status": "ok", "season_a": 1, "season_b": 2, "significant_motion": False,
                   "measured": {"total_arcsec": 0.3, "total_pixels": 0.05, "err_ra_arcsec": 0.4, "err_dec_arcsec": 0.4}}
    var_yes = {"status": "ok", "variable": True, "p_constant": 1e-9, "amplitude_fraction": 0.4}
    var_no = {"status": "ok", "variable": False, "p_constant": 0.42}
    cls_ok = classify.classify(make_points(lambda x: templates.planck_fnu(x, 3500), np.linspace(0.8, 5, 40)))
    sat = det_points(10, saturated=True) + det_points(2)
    return [
        verdict.evaluate(points=[]),
        verdict.evaluate(points=det_points(), gaia_match=gaia_match(), neighbours=nb, skybot=sb_none,
                         motion=motion_pred, variability=var_yes, classification=cls_ok),
        verdict.evaluate(points=det_points(2), skybot=sb_hit, registry_match=reg, motion=motion_free,
                         variability=var_no, gaia_error="HTTP 503"),
        verdict.evaluate(points=det_points(artifact_flags=["GHOST"]), neighbours=[],
                         motion={"status": "na", "reason": "1 season(s) with usable centroids; need 2"},
                         variability={"status": "na", "reason": "fewer than 3 wavelength-matched pairs between seasons"}),
        verdict.evaluate(points=sat, gaia_match=gaia_match()),
    ]


def test_every_generated_check_sentence_has_spanish():
    for res in _verdicts():
        out = i18n.localize_verdict(res, "es")
        for c in out["checks"]:
            assert c.get("detail_es"), c["detail_en"]
            assert c.get("evidence_source_es"), c["evidence_source_en"]
            assert c["label"] == i18n.CHECK_LABELS_ES[c["id"]]
            assert c["detail"] == c["detail_es"]
        assert out["summary"] == out["summary_es"] and out["summary_en"] == res["summary"]
        assert out["lang"] == "es"


def test_classification_caveats_and_method_translate():
    lam = np.linspace(0.8, 5, 40)
    for pts in (make_points(lambda x: templates.planck_fnu(x, 3500), lam), det_points(3), []):
        res = {"points": pts, "classification": classify.classify(pts)}
        out = i18n.localize_spectrum(res, "es")
        c = out["classification"]
        assert len(c["caveats_es"]) == len(c["caveats_en"]) == len(res["classification"]["caveats"])
        assert c["caveats"] == c["caveats_es"] and c["method"] == c["method_es"]


def test_english_default_keeps_original_text_and_does_not_mutate():
    res = _verdicts()[1]
    before = copy.deepcopy(res)
    out = i18n.localize_verdict(res)
    assert res == before  # providers memoise results: never mutate
    assert out["lang"] == "en"
    for c, orig in zip(out["checks"], res["checks"]):
        assert c["label"] == orig["label"] and c["detail"] == orig["detail"]
        assert c["detail_en"] == orig["detail"] and c["detail_es"]
    assert out["summary"] == res["summary"]
    # Shape only grows.
    assert set(res) <= set(out)
    assert all(set(o) <= set(c) for o, c in zip(res["checks"], out["checks"]))


def test_unknown_sentence_stays_english_without_es_field():
    payload = {"checks": [{"id": "gaia", "label": "Gaia DR3 counterpart", "status": "na",
                           "detail": "Something nobody templated.", "evidence_source": "-"}],
               "summary": "x", "summary_es": "y", "verdict": "inconclusive", "confidence": 0.1}
    c = i18n.localize_verdict(payload, "es")["checks"][0]
    assert c["detail"] == "Something nobody templated." and "detail_es" not in c
    assert c["label"] == "Contrapartida en Gaia DR3"
    assert i18n.translate_es("") is None and i18n.translate_es(None) is None


def test_localizing_twice_is_stable():
    res = _verdicts()[2]
    es = i18n.localize_verdict(res, "es")
    back = i18n.localize_verdict(es, "en")
    assert [c["detail"] for c in back["checks"]] == [c["detail"] for c in res["checks"]]
    assert back["summary"] == res["summary"]


@pytest.mark.skipif(not SNAPSHOTS.exists(), reason="frontend snapshots not present")
def test_saved_snapshot_sentences_all_translate():
    files = [p for p in SNAPSHOTS.glob("*.json") if p.name != "index.json"]
    assert files
    for p in files:
        snap = json.loads(p.read_text(encoding="utf-8"))
        v = snap.get("verdict")
        if v:
            for c in i18n.localize_verdict(v, "es")["checks"]:
                assert c.get("detail_es"), (p.name, c["detail_en"])
        s = snap.get("spectrum")
        if s and s.get("classification"):
            c = i18n.localize_spectrum(s, "es")["classification"]
            assert "caveats_es" in c, p.name


def test_v2_endpoints_accept_lang(monkeypatch):
    client = TestClient(app)
    base = _verdicts()[1]
    spec = {"points": [], "classification": classify.classify([])}
    monkeypatch.setattr(v2, "PROVIDERS", {})
    v2.register_provider("verdict", lambda **kw: base)
    v2.register_provider("spectrum", lambda **kw: spec)
    q = {"ra": 1, "dec": 1}
    en = client.get("/v2/verdict", params=q).json()
    es = client.get("/v2/verdict", params={**q, "lang": "es"}).json()
    assert en["lang"] == "en" and en["summary"] == base["summary"]
    assert es["lang"] == "es" and es["summary"] == base["summary_es"]
    assert es["checks"][0]["label"] == i18n.CHECK_LABELS_ES[es["checks"][0]["id"]]
    assert es["checks"][0]["detail_en"] == base["checks"][0]["detail"]
    s_es = client.get("/v2/spectrum", params={**q, "lang": "es"}).json()
    assert s_es["classification"]["caveats"] == s_es["classification"]["caveats_es"]
    assert client.get("/v2/verdict", params={**q, "lang": "fr"}).status_code == 422
