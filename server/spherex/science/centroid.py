"""Sub-pixel centroids per frame, per-season positions, and measured vs predicted shifts.

Per frame: least-squares fit of a PIXEL-INTEGRATED circular Gaussian (sigma fixed
from PSF_FWHM, which is appropriate for the undersampled ~1.5 px SPHEREx PSF) with
free amplitude and centre, weighted by VARIANCE, after subtracting the local
annulus background. The parameter covariance (scaled by reduced chi2 when > 1)
gives the centroid error. Saturated cores are refused, not fitted.

Per season: inverse-variance weighted mean of frame centroids in tangent-plane
offsets; the error is max(formal, scatter/sqrt(n)) combined in quadrature with an
astrometric floor.

``ASTROMETRIC_FLOOR_ARCSEC`` is an ASSUMPTION (not a documented SPHEREx figure):
a per-season systematic for WCS errors between detectors/epochs. Change it when a
documented value is verified.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

import numpy as np
from scipy.optimize import least_squares
from scipy.special import erf
from scipy.stats import chi2 as chi2_dist

from spherex.science.photometry import _frame_masks, local_background, pixel_scale_arcsec
from spherex.science.seasons import assign_seasons
from spherex.science.types import ScienceFrame, validate_frame

ASTROMETRIC_FLOOR_ARCSEC = 0.3  # assumption, see module docstring
SQRT2 = np.sqrt(2.0)
P_3SIGMA = 0.0027  # two-sided 3-sigma equivalent


def _pixel_integrated_gaussian(xx, yy, amp, xc, yc, sigma):
    fx = 0.5 * (erf((xx + 0.5 - xc) / (SQRT2 * sigma)) - erf((xx - 0.5 - xc) / (SQRT2 * sigma)))
    fy = 0.5 * (erf((yy + 0.5 - yc) / (SQRT2 * sigma)) - erf((yy - 0.5 - yc) / (SQRT2 * sigma)))
    return amp * fx * fy


def tangent_offsets_arcsec(ra, dec, ra0, dec0):
    """Gnomonic (xi, eta) offsets in arcsec of (ra, dec) about (ra0, dec0); xi points East."""
    ra, dec, ra0, dec0 = (np.radians(np.asarray(v, float)) for v in (ra, dec, ra0, dec0))
    cosc = np.sin(dec0) * np.sin(dec) + np.cos(dec0) * np.cos(dec) * np.cos(ra - ra0)
    xi = np.cos(dec) * np.sin(ra - ra0) / cosc
    eta = (np.cos(dec0) * np.sin(dec) - np.sin(dec0) * np.cos(dec) * np.cos(ra - ra0)) / cosc
    k = np.degrees(1) * 3600
    return xi * k, eta * k


def from_tangent_offsets(xi_as, eta_as, ra0, dec0):
    xi, eta = np.radians(np.asarray(xi_as, float) / 3600), np.radians(np.asarray(eta_as, float) / 3600)
    ra0, dec0 = np.radians(ra0), np.radians(dec0)
    rho = np.hypot(xi, eta)
    c = np.arctan(rho)
    with np.errstate(invalid="ignore", divide="ignore"):
        dec = np.where(rho == 0, dec0, np.arcsin(np.cos(c) * np.sin(dec0) + eta * np.sin(c) * np.cos(dec0) / np.where(rho == 0, 1, rho)))
        ra = ra0 + np.arctan2(xi * np.sin(c), rho * np.cos(dec0) * np.cos(c) - eta * np.sin(dec0) * np.sin(c))
    return np.degrees(ra) % 360, np.degrees(dec)


def centroid_frame(frame: ScienceFrame, ra: float, dec: float, *, half_box: int = 2,
                   min_snr: float = 5.0, neighbours: Sequence[tuple[float, float]] = ()) -> dict:
    """Fit the source nearest (ra, dec) in one native frame.

    ``neighbours``: (ra, dec) of known nearby sources (e.g. Gaia predictions at this
    epoch) fitted simultaneously with FIXED positions and free non-negative
    amplitudes, so a blended neighbour does not drag the target centroid.
    """
    validate_frame(frame)
    m = _frame_masks(frame)
    wcs = frame["wcs"]
    x0, y0 = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
    base = {"frame_id": frame["id"], "mjd": float(frame["mjd"]), "detector": int(frame["detector"]),
            "ra": None, "dec": None, "err_ra_arcsec": None, "err_dec_arcsec": None}
    ny, nx = m["image"].shape
    ix, iy = int(round(x0)), int(round(y0))
    if not (half_box <= ix < nx - half_box and half_box <= iy < ny - half_box):
        return base | {"status": "off_frame"}
    scale = pixel_scale_arcsec(wcs, x0, y0)
    sigma = float(frame.get("psf_fwhm_arcsec") or 1.5 * scale) / scale / 2.3548
    sl = (slice(iy - half_box, iy + half_box + 1), slice(ix - half_box, ix + half_box + 1))
    core = (slice(iy - 1, iy + 2), slice(ix - 1, ix + 2))
    if m["sat"][core].any():
        return base | {"status": "saturated"}
    r_in = max(4.0, 4 * sigma * 2.3548 / 2)
    bg = local_background(m, x0, y0, r_in, r_in + 3.0)
    if not bg["ok"]:
        return base | {"status": "no_background"}
    yy, xx = np.mgrid[sl]
    data = m["image"][sl] - bg["level"]
    good = m["valid"][sl] & ~m["sat"][sl]
    if good.sum() < 6:
        return base | {"status": "incomplete"}
    var = (m["var"][sl] if m["var"] is not None else np.full(data.shape, np.nanvar(data[good])))
    var = var + bg["error"] ** 2
    xs, ys, d, s = xx[good], yy[good], data[good], np.sqrt(var[good])
    amp0 = max(float(np.nansum(np.clip(d, 0, None))), 1e-12)
    nb_xy = []
    for nra, ndec in neighbours:
        nx_, ny_ = (float(v) for v in wcs.world_to_pixel_values(nra, ndec))
        if abs(nx_ - x0) <= half_box + 3 and abs(ny_ - y0) <= half_box + 3:
            nb_xy.append((nx_, ny_))
    k = len(nb_xy)

    def resid(p):
        model = _pixel_integrated_gaussian(xs, ys, p[0], p[1], p[2], sigma)
        for j, (nx_, ny_) in enumerate(nb_xy):
            model = model + _pixel_integrated_gaussian(xs, ys, p[3 + j], nx_, ny_, sigma)
        return (model - d) / s

    fit = least_squares(resid, [amp0, x0, y0] + [amp0 / 2] * k,
                        bounds=([0, x0 - half_box, y0 - half_box] + [0] * k,
                                [np.inf, x0 + half_box, y0 + half_box] + [np.inf] * k))
    dof = max(1, d.size - 3 - k)
    chi2_red = float(2 * fit.cost / dof)
    try:
        cov = np.linalg.inv(fit.jac.T @ fit.jac) * max(1.0, chi2_red)
    except np.linalg.LinAlgError:
        return base | {"status": "fit_failed"}
    amp, xc, yc = fit.x[:3]
    snr = float(amp / np.sqrt(cov[0, 0])) if cov[0, 0] > 0 else 0.0
    cov = cov[:3, :3]
    at_bound = (abs(xc - x0) > half_box - 1e-3) or (abs(yc - y0) > half_box - 1e-3)
    # Propagate pixel covariance to (xi, eta) through the local WCS Jacobian.
    rac, decc = (float(v) for v in wcs.pixel_to_world_values(xc, yc))
    jx = tangent_offsets_arcsec(*wcs.pixel_to_world_values(xc + 0.5, yc), rac, decc)
    jx0 = tangent_offsets_arcsec(*wcs.pixel_to_world_values(xc - 0.5, yc), rac, decc)
    jy = tangent_offsets_arcsec(*wcs.pixel_to_world_values(xc, yc + 0.5), rac, decc)
    jy0 = tangent_offsets_arcsec(*wcs.pixel_to_world_values(xc, yc - 0.5), rac, decc)
    J = np.array([[jx[0] - jx0[0], jy[0] - jy0[0]], [jx[1] - jx0[1], jy[1] - jy0[1]]])
    sky_cov = J @ cov[1:, 1:] @ J.T
    status = "ok" if snr >= min_snr and not at_bound else ("low_snr" if snr < min_snr else "at_box_edge")
    return base | {
        "status": status, "ra": rac, "dec": decc, "x": float(xc), "y": float(yc),
        "err_ra_arcsec": float(np.sqrt(sky_cov[0, 0])), "err_dec_arcsec": float(np.sqrt(sky_cov[1, 1])),
        "corr": float(sky_cov[0, 1] / np.sqrt(sky_cov[0, 0] * sky_cov[1, 1])),
        "snr": snr, "chi2_red": chi2_red, "pixel_scale_arcsec": scale, "n_neighbours_fitted": k,
        "method": "pixel-integrated Gaussian, sigma fixed from PSF_FWHM"
                  + (f"; {k} known neighbour(s) fitted at fixed positions" if k else ""),
    }


def season_positions(centroids: Sequence[dict], *, ra0: float, dec0: float,
                     floor_arcsec: float = ASTROMETRIC_FLOOR_ARCSEC) -> list[dict]:
    """Combine status=='ok' frame centroids into one position per season."""
    good = [c for c in centroids if c.get("status") == "ok"]
    if not good:
        return []
    labels = assign_seasons([c["mjd"] for c in good])
    out = []
    for s in sorted(set(labels)):
        cs = [c for c, lab in zip(good, labels) if lab == s]
        xi, eta = tangent_offsets_arcsec([c["ra"] for c in cs], [c["dec"] for c in cs], ra0, dec0)
        ex = np.array([c["err_ra_arcsec"] for c in cs])
        ey = np.array([c["err_dec_arcsec"] for c in cs])
        wx, wy = 1 / ex ** 2, 1 / ey ** 2
        mx, my = float((wx * xi).sum() / wx.sum()), float((wy * eta).sum() / wy.sum())
        fx, fy = float(1 / np.sqrt(wx.sum())), float(1 / np.sqrt(wy.sum()))
        n = len(cs)
        sx = float(np.std(xi, ddof=1) / np.sqrt(n)) if n > 1 else 0.0
        sy = float(np.std(eta, ddof=1) / np.sqrt(n)) if n > 1 else 0.0
        errx = float(np.hypot(max(fx, sx), floor_arcsec))
        erry = float(np.hypot(max(fy, sy), floor_arcsec))
        ra_s, dec_s = from_tangent_offsets(mx, my, ra0, dec0)
        out.append({"season": s, "n_frames": n, "mjd_mean": float(np.mean([c["mjd"] for c in cs])),
                    "ra": float(ra_s), "dec": float(dec_s), "xi_arcsec": mx, "eta_arcsec": my,
                    "err_ra_arcsec": errx, "err_dec_arcsec": erry,
                    "detectors": sorted({c["detector"] for c in cs}),
                    "error_model": f"max(formal, scatter/sqrt(n)) (+) floor {floor_arcsec} arcsec (assumed)"})
    return out


Predictor = Callable[[float], tuple[float, float]]


def motion_test(seasons: Sequence[dict], predictor: Predictor | None = None, *,
                pixel_scale_arcsec: float = 6.15, min_frames: int = 3) -> dict:
    """Measured shift between the first and last well-sampled season vs a catalog prediction.

    Seasons with fewer than ``min_frames`` good centroids are skipped when at least
    two seasons meet it. Returns status 'na' with a reason if fewer than two
    seasons have positions.
    ``significant_motion``: measured shift differs from zero at > 3 sigma (2 dof).
    ``consistent_with_prediction``: residual (measured - predicted) within 3 sigma.
    """
    rich = [s for s in seasons if s["n_frames"] >= min_frames]
    use = rich if len(rich) >= 2 else list(seasons)
    if len(use) < 2:
        return {"status": "na", "reason": f"{len(use)} season(s) with usable centroids; need 2"}
    a, b = use[0], use[-1]
    ra0, dec0 = a["ra"], a["dec"]
    bx, by = tangent_offsets_arcsec(b["ra"], b["dec"], ra0, dec0)
    sx, sy = np.hypot(a["err_ra_arcsec"], b["err_ra_arcsec"]), np.hypot(a["err_dec_arcsec"], b["err_dec_arcsec"])
    chi2_zero = float((bx / sx) ** 2 + (by / sy) ** 2)
    p_zero = float(chi2_dist.sf(chi2_zero, 2))
    out = {
        "status": "ok", "season_a": a["season"], "season_b": b["season"],
        "mjd_a": a["mjd_mean"], "mjd_b": b["mjd_mean"], "dt_days": b["mjd_mean"] - a["mjd_mean"],
        "measured": {"dra_cosdec_arcsec": float(bx), "ddec_arcsec": float(by),
                     "total_arcsec": float(np.hypot(bx, by)), "err_ra_arcsec": float(sx),
                     "err_dec_arcsec": float(sy), "total_pixels": float(np.hypot(bx, by) / pixel_scale_arcsec)},
        "chi2_vs_zero": chi2_zero, "p_vs_zero": p_zero, "significant_motion": p_zero < P_3SIGMA,
        "predicted": None, "consistent_with_prediction": None,
    }
    if predictor is not None:
        pa, pb = predictor(a["mjd_mean"]), predictor(b["mjd_mean"])
        px, py = tangent_offsets_arcsec(pb[0], pb[1], pa[0], pa[1])
        rx, ry = bx - px, by - py
        chi2_res = float((rx / sx) ** 2 + (ry / sy) ** 2)
        p_res = float(chi2_dist.sf(chi2_res, 2))
        out["predicted"] = {"dra_cosdec_arcsec": float(px), "ddec_arcsec": float(py),
                            "total_arcsec": float(np.hypot(px, py)),
                            "total_pixels": float(np.hypot(px, py) / pixel_scale_arcsec),
                            "kind": "catalog_predicted"}
        out["residual"] = {"dra_cosdec_arcsec": float(rx), "ddec_arcsec": float(ry), "chi2": chi2_res, "p": p_res}
        out["consistent_with_prediction"] = p_res >= P_3SIGMA
    return out
