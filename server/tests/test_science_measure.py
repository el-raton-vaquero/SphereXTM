"""Photometry, centroids, variability and goggles on synthetic (test-only) frames."""

import numpy as np

from science_synth import PIX_ARCSEC, make_frame
from spherex.science import centroid, goggles, photometry, variability

RA, DEC = 150.0, 2.0


def test_pixel_solid_angle():
    f = make_frame()
    omega = photometry.pixel_solid_angle_sr(f["wcs"], 12, 12)
    assert abs(omega / np.radians(PIX_ARCSEC / 3600) ** 2 - 1) < 1e-3
    assert abs(photometry.pixel_scale_arcsec(f["wcs"], 3, 4) - PIX_ARCSEC) < 0.01


def test_flux_recovered_with_aperture_correction():
    f = make_frame(sources=[(RA, DEC, 2.0)], noise=0.005)
    p = photometry.forced_photometry(f, RA, DEC)
    assert p["status"] == "ok" and p["unit"] == "mJy"
    assert abs(p["flux"] - 2.0) < max(3 * p["err"], 0.04)
    assert 1.05 < p["aperture_correction"] < 1.4  # a 9" radius aperture misses PSF wings
    nocorr = photometry.forced_photometry(dict(f, epsf=None), RA, DEC)
    assert nocorr["aperture_correction"] == 1.0 and nocorr["flux"] < p["flux"]


def test_error_bars_are_calibrated():
    pulls = []
    for seed in range(60):
        f = make_frame(sources=[(RA, DEC, 0.3)], noise=0.05, seed=seed)
        p = photometry.forced_photometry(f, RA, DEC)
        pulls.append((p["flux"] - 0.3) / p["err"])
    pulls = np.array(pulls)
    assert abs(pulls.mean()) < 0.5 and 0.6 < pulls.std() < 1.4


def test_saturation_artifacts_and_coverage():
    f = make_frame(sources=[(RA, DEC, 5.0)], saturate_above=1.0)
    p = photometry.forced_photometry(f, RA, DEC)
    assert p["saturated"] and "OVERFLOW" in p["flags"] and not photometry.usable(p)
    flags = np.zeros((25, 25), np.uint32)
    flags[12, 12] = 1 << 22
    g = photometry.forced_photometry(make_frame(sources=[(RA, DEC, 1.0)], flags=flags), RA, DEC)
    assert g["artifact_flags"] == ["GHOST"] and not photometry.usable(g)
    img_nan = make_frame(sources=[(RA, DEC, 1.0)])
    img_nan["image"][11:14, 11:14] = np.nan
    assert photometry.forced_photometry(img_nan, RA, DEC)["status"] == "incomplete"
    assert photometry.forced_photometry(make_frame(), RA + 0.1, DEC)["status"] == "off_frame"


def test_series_assigns_seasons_and_tracks():
    frames = [make_frame(sources=[(RA, DEC, 1.0)], mjd=m, seed=i) for i, m in enumerate([60800, 60802, 60990])]
    pts = photometry.photometry_series(frames, RA, DEC, position_fn=lambda m: (RA, DEC))
    assert [p["season"] for p in pts] == [0, 0, 1] and pts[0]["position"]["tracked"]


def test_centroid_recovers_subpixel_offset():
    dra = 2.5 / 3600 / np.cos(np.radians(DEC))  # 2.5 arcsec East
    f = make_frame(sources=[(RA + dra, DEC + 1.5 / 3600, 3.0)], noise=0.005)
    c = centroid.centroid_frame(f, RA, DEC)
    assert c["status"] == "ok"
    xi, eta = centroid.tangent_offsets_arcsec(c["ra"], c["dec"], RA, DEC)
    assert abs(xi - 2.5) < 0.5 and abs(eta - 1.5) < 0.5
    assert 0 < c["err_ra_arcsec"] < 0.5


def test_centroid_refuses_saturated_core():
    f = make_frame(sources=[(RA, DEC, 5.0)], saturate_above=1.0)
    assert centroid.centroid_frame(f, RA, DEC)["status"] == "saturated"


def test_motion_vs_prediction():
    # 8 arcsec/yr northward mover observed in two seasons ~1 yr apart.
    def pos(m):
        return RA, DEC + 8.0 / 3600 * (m - 60800) / 365.25

    frames = []
    for i, m in enumerate([60800, 60801, 60802, 61165, 61166, 61167]):
        frames.append(make_frame(sources=[(*pos(m), 3.0)], mjd=m, seed=i, noise=0.005))
    cents = [centroid.centroid_frame(f, *pos(f["mjd"])) for f in frames]
    seasons = centroid.season_positions(cents, ra0=RA, dec0=DEC)
    assert len(seasons) == 2
    res = centroid.motion_test(seasons, pos)
    assert res["significant_motion"] and res["consistent_with_prediction"]
    assert abs(res["measured"]["ddec_arcsec"] - 8.0) < 1.5
    wrong = centroid.motion_test(seasons, lambda m: (RA, DEC))  # predicts no motion
    assert wrong["consistent_with_prediction"] is False
    assert centroid.motion_test(seasons[:1])["status"] == "na"


def _season_points(flux_b, seed0=0):
    pts = []
    for s, (mjd0, flux) in enumerate([(60800, 1.0), (61000, flux_b)]):
        for k, lam in enumerate(np.linspace(3.9, 4.9, 10)):
            f = make_frame(sources=[(RA, DEC, flux)], mjd=mjd0 + k * 0.1, lambda_um=lam, bandwidth_um=0.04,
                           seed=seed0 + 100 * s + k, noise=0.004)
            pts.append(photometry.forced_photometry(f, RA, DEC) | {"season": s})
    return pts


def test_variability_constant_and_variable():
    const = variability.compare_seasons(_season_points(1.0))
    assert const["status"] == "ok" and not const["variable"]
    var = variability.compare_seasons(_season_points(1.6))
    assert var["variable"] and abs(var["amplitude_fraction"] - 0.6) < 0.1
    one = variability.compare_seasons([p for p in _season_points(1.0) if p["season"] == 0])
    assert one["status"] == "na"


def test_goggles_recipes_and_depth():
    data = goggles.load_recipes()
    assert {r["id"] for r in data["recipes"]} == {"ch4", "h2o", "co2", "co"}
    rec = goggles.recipe("ch4")
    lam = np.linspace(2.9, 4.1, 60)
    flux = np.where((lam >= 3.2) & (lam <= 3.45), 0.6, 1.0)  # 40% absorption, flat continuum
    res = goggles.band_depth(lam, flux, np.full(lam.size, 1e-4), rec)
    assert abs(float(res["depth"]) - 0.4) < 1e-9 and float(res["err"]) > 0
    stack = [{"image": np.full((4, 5), v), "lambda_um": l} for l, v in zip(lam, flux)]
    maps = goggles.band_depth_maps(stack, ["ch4"])
    assert maps["ch4"]["depth"].shape == (4, 5) and np.allclose(maps["ch4"]["depth"], 0.4)
    empty = goggles.band_depth(np.array([1.0, 1.1]), np.array([1.0, 1.0]), None, rec)
    assert np.isnan(empty["depth"])


def test_centroid_with_fixed_neighbour_is_not_dragged():
    # Faint target at the query position, brighter neighbour 8.7" away (WISE 0855-like blend).
    nb = (RA + 7.0 / 3600 / np.cos(np.radians(DEC)), DEC + 5.2 / 3600)
    f = make_frame(sources=[(RA, DEC, 0.6), (*nb, 2.0)], noise=0.003)
    naive = centroid.centroid_frame(f, RA, DEC)
    fixed = centroid.centroid_frame(f, RA, DEC, neighbours=[nb])

    def off(c):
        return float(np.hypot(*centroid.tangent_offsets_arcsec(c["ra"], c["dec"], RA, DEC)))

    assert fixed["n_neighbours_fitted"] == 1 and off(fixed) < 1.0
    assert off(naive) > off(fixed)


def test_psf_fit_deblends_neighbour():
    nb = (RA + 7.0 / 3600 / np.cos(np.radians(DEC)), DEC + 5.2 / 3600)
    f = make_frame(sources=[(RA, DEC, 0.5), (*nb, 3.0)], noise=0.003)
    p = photometry.forced_photometry(f, RA, DEC, neighbours=[nb])
    assert p["flux_method"] == "psf_fit_deblended"
    assert abs(p["flux"] - 0.5) < max(3 * p["err"], 0.03)
    assert p["aperture_flux"] > 0.7  # aperture alone is contaminated by the neighbour
    assert abs(p["psf_fit"]["neighbour_fluxes"][0] - 3.0) < 0.15
    # Gaussian fallback when no EPSF is supplied
    g = photometry.forced_photometry(dict(f, epsf=None), RA, DEC, neighbours=[nb])
    assert g["psf_fit"]["psf_model"].startswith("Gaussian") and abs(g["flux"] - 0.5) < 0.05
