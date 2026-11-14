import numpy as np

from spherex.science import classify, templates, verdict


def make_points(fn, lam, rel_err=0.03, seed=0, scale=1.0, bw_frac=1 / 60, **extra):
    rng = np.random.default_rng(seed)
    bw = lam * bw_frac
    model = templates.band_average(fn, lam, bw) * scale
    err = rel_err * np.abs(model) + 1e-6 * np.nanmax(np.abs(model))
    flux = model + rng.normal(0, err)
    return [{"status": "ok", "lambda_um": float(l), "bandwidth_um": float(b), "flux": float(f), "err": float(e),
             "saturated": False, "artifact_flags": [], "mjd": 60800.0, "detector": 6, "snr": float(f / e),
             **extra} for l, b, f, e in zip(lam, bw, flux, err)]


def test_templates_load_with_provenance():
    bd = templates.brown_dwarf_templates()
    assert len(bd) == 5
    assert {t.spectral_type for t in bd} == {"T6.5", "T8", "T9", "Y0", "Y1"}
    for t in bd:
        assert "Beiler" in t.reference and t.meta["licence"] == "CC-BY-4.0"
        assert t.lambda_range_um[0] < 1.05 and t.lambda_range_um[1] > 5.0
    assert all(t.kind == "idealized" for t in templates.star_templates())
    assert all(t.kind == "toy" and t.n_params == 2 for t in templates.asteroid_templates())


def test_planck_peak_wien():
    lam = np.linspace(0.3, 20, 20000)
    # f_nu peak: lambda_max * T = 5100 um K (Wien law in frequency form, ~5.1e3)
    peak = lam[np.argmax(templates.planck_fnu(lam, 3000))]
    assert abs(peak * 3000 - 5100) < 60


def test_brown_dwarf_spectrum_classified_as_brown_dwarf():
    y0 = [t for t in templates.brown_dwarf_templates() if t.spectral_type == "Y0"][0]
    lam = np.linspace(1.0, 5.0, 80)
    res = classify.classify(make_points(y0.components[0], lam, scale=3e6))
    assert res["best"]["class"] == "brown_dwarf"
    assert res["best"]["spectral_type"] in ("Y0", "Y1", "T9")
    assert abs(sum(r["prob"] for r in res["ranking"]) - 1) < 1e-9
    assert res["method"] == "template chi2 with scale fit" and res["caveats"]


def test_blackbody_star_classified_as_star():
    lam = np.linspace(0.8, 5.0, 80)
    res = classify.classify(make_points(lambda x: templates.planck_fnu(x, 3500), lam, seed=1))
    assert res["best"]["class"] == "star" and res["best"]["teff"] in (3000.0, 3500.0, 4500.0)


def test_too_few_points_and_exclusions():
    lam = np.linspace(1.0, 5.0, 4)
    res = classify.classify(make_points(lambda x: templates.planck_fnu(x, 3500), lam))
    assert res["best"] is None
    pts = make_points(lambda x: templates.planck_fnu(x, 3500), np.linspace(1, 5, 30))
    for p in pts[:10]:
        p["saturated"] = True
    res = classify.classify(pts)
    assert res["n_points"] == 20 and any("excluded" in c for c in res["caveats"])


def det_points(n=6, **kw):
    return [{"status": "ok", "flux": 5.0, "err": 0.1, "snr": 50.0, "lambda_um": 4.5, "bandwidth_um": 0.04,
             "saturated": False, "artifact_flags": [], "mjd": 60800 + i, "detector": 6, **kw} for i in range(n)]


def gaia_match():
    return {"source": {"source_id": "123", "phot_g_mean_mag": 12.0, "pmra": 1.0, "pmdec": 2.0, "parallax": 1.0},
            "position": {"mjd": 60800, "ra": 1, "dec": 1}, "separation_arcsec": 1.0}


def ids(res):
    return {c["id"]: c for c in res["checks"]}


def test_verdict_known_star_with_saturation_penalty():
    pts = det_points()
    res = verdict.evaluate(points=pts, gaia_match=gaia_match())
    assert res["verdict"] == "known_star" and res["confidence"] == 0.9
    assert ids(res)["gaia"]["status"] == "pass" and ids(res)["saturation"]["status"] == "pass"
    sat = verdict.evaluate(points=det_points(saturated=True), gaia_match=gaia_match())
    assert sat["verdict"] == "known_star" and sat["confidence"] < 0.9
    assert ids(sat)["saturation"]["status"] == "fail"
    assert set(res) >= {"checks", "verdict", "confidence", "summary"}
    for c in res["checks"]:
        assert c["status"] in ("pass", "warn", "fail", "na") and c["evidence_source"]


def test_verdict_asteroid_artifact_candidate_inconclusive():
    sb = {"epochs": [{"mjd": 60801.0, "objects": [{"name": "2013 CD139", "class": "MB>Outer", "vmag": 21,
                                                   "separation_arcsec": 4.0}]}]}
    assert verdict.evaluate(points=det_points(2), skybot=sb)["verdict"] == "known_asteroid"
    art = verdict.evaluate(points=det_points(artifact_flags=["GHOST"]))
    assert art["verdict"] == "artifact" and ids(art)["artifacts"]["status"] == "fail"
    cand = verdict.evaluate(points=det_points(), skybot={"epochs": [{"mjd": 1, "objects": []}]})
    assert cand["verdict"] == "candidate" and cand["confidence"] < 0.5
    assert "not a discovery" in cand["summary"]
    assert ids(cand)["gaia"]["status"] == "warn" and ids(cand)["skybot"]["status"] == "warn"
    assert verdict.evaluate(points=[])["verdict"] == "inconclusive"
    failed = verdict.evaluate(points=det_points(), gaia_error="HTTP 503",
                              skybot={"epochs": [{"mjd": 1, "error": "timeout", "objects": None}]})
    assert ids(failed)["gaia"]["status"] == "na" and ids(failed)["skybot"]["status"] == "na"


def test_verdict_variable_known_source():
    var = {"status": "ok", "variable": True, "p_constant": 1e-9, "amplitude_fraction": 0.4}
    res = verdict.evaluate(points=det_points(), gaia_match=gaia_match(), variability=var)
    assert res["verdict"] == "variable" and ids(res)["variability"]["status"] == "warn"


def test_confusion_and_registry_identification():
    nb = [{"source_id": "575", "phot_g_mean_mag": 16.3, "separation_arcsec": 8.7}]
    reg = {"name": "WISE 0855-0714", "separation_arcsec": 0.2, "reference": "Luhman 2014"}
    res = verdict.evaluate(points=det_points(), registry_match=reg, neighbours=nb)
    c = ids(res)
    assert c["confusion"]["status"] == "warn" and "575" in c["confusion"]["detail"]
    assert c["gaia"]["status"] == "warn" and c["registry"]["status"] == "pass"
    assert res["verdict"] == "known_star" and "WISE 0855" in res["summary"] and res["confidence"] < 0.9
    clean = verdict.evaluate(points=det_points(), gaia_match=gaia_match(), neighbours=[])
    assert ids(clean)["confusion"]["status"] == "pass"
