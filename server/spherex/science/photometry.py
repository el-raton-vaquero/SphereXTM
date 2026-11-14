"""Forced circular-aperture photometry with a local background annulus.

Units: SPHEREx Level-2 IMAGE is surface brightness in MJy/sr and VARIANCE is in
(MJy/sr)^2 (verified in DR1 headers: BUNIT 'MJy / sr' and 'MJy2 / sr2'). A
pixel's flux density is I * Omega_pix, with Omega_pix the pixel solid angle from
the local WCS Jacobian (TAN-SIP aware). Results are reported in mJy
(1 MJy = 1e9 mJy).

Errors: sum of per-pixel VARIANCE (times weight^2 * Omega^2) plus the error of
the background level (1.2533 * std / sqrt(n) for a median). Valid on native,
non-reprojected pixels only.

Aperture correction: if the frame provides the EPSF zone nearest the target
(EPSF HDU, oversampled by OVSMPX), the expected captured fraction is computed by
evaluating the effective PSF at every aperture pixel's offset from the source
(``epsf_aperture_fraction``) and the total flux is reported. The EPSF is
truncated (KEEPNAT native pixels), so "total" means flux inside that footprint.
Missing (invalid) aperture pixels are excluded consistently from both the
measurement and the expected fraction.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

import numpy as np
from astropy.stats import sigma_clipped_stats

from spherex.science import flags as fl
from spherex.science.seasons import assign_seasons
from spherex.science.types import ScienceFrame, validate_frame

MJY_TO_MJY = 1e9  # MJy -> mJy
UNIT = "mJy"
DEFAULT_APERTURE_ARCSEC = 9.0


def pixel_solid_angle_sr(wcs, x: float, y: float) -> float:
    """Solid angle of the pixel centred at zero-based (x, y) from the local Jacobian."""
    px = np.array([x - 0.5, x + 0.5, x, x], float)
    py = np.array([y, y, y - 0.5, y + 0.5], float)
    ra, dec = (np.radians(v) for v in wcs.pixel_to_world_values(px, py))
    cosd = np.cos(np.mean(dec))
    dra = lambda a, b: (a - b + np.pi) % (2 * np.pi) - np.pi  # noqa: E731
    jx = (dra(ra[1], ra[0]) * cosd, dec[1] - dec[0])
    jy = (dra(ra[3], ra[2]) * cosd, dec[3] - dec[2])
    return float(abs(jx[0] * jy[1] - jx[1] * jy[0]))


def pixel_scale_arcsec(wcs, x: float, y: float) -> float:
    return float(np.degrees(np.sqrt(pixel_solid_angle_sr(wcs, x, y))) * 3600)


def circular_weights(shape: tuple[int, int], x0: float, y0: float, r: float, sub: int = 10) -> np.ndarray:
    """Fractional overlap of each pixel with a circle (sub x sub supersampling)."""
    w = np.zeros(shape, float)
    ny, nx = shape
    x_lo, x_hi = max(0, int(np.floor(x0 - r - 1))), min(nx, int(np.ceil(x0 + r + 2)))
    y_lo, y_hi = max(0, int(np.floor(y0 - r - 1))), min(ny, int(np.ceil(y0 + r + 2)))
    if x_lo >= x_hi or y_lo >= y_hi:
        return w
    off = (np.arange(sub) + 0.5) / sub - 0.5
    for iy in range(y_lo, y_hi):
        dy = iy + off[:, None] - y0
        for ix in range(x_lo, x_hi):
            dx = ix + off[None, :] - x0
            w[iy, ix] = np.mean(dx * dx + dy * dy <= r * r)
    return w


def annulus_mask(shape: tuple[int, int], x0: float, y0: float, r_in: float, r_out: float) -> np.ndarray:
    yy, xx = np.indices(shape)
    rr = np.hypot(xx - x0, yy - y0)
    return (rr >= r_in) & (rr <= r_out)


def epsf_aperture_fraction(epsf: np.ndarray, oversample: int, weights: np.ndarray, x0: float, y0: float) -> float:
    """Expected fraction of a point source's flux captured by ``weights`` at (x0, y0).

    An effective PSF (Anderson & King 2000) gives the flux falling in a native pixel
    whose centre is offset (dx, dy) from the source. The expected aperture sum is
    therefore sum_i w_i * ePSF(dx_i, dy_i), and the total is the same sum over the
    whole pixel lattice covered by the (truncated) ePSF. This reproduces exactly how
    the aperture is measured, including the sub-pixel phase of the source.
    """
    from scipy.ndimage import map_coordinates

    epsf = np.nan_to_num(np.asarray(epsf, float))
    c = (np.array(epsf.shape) - 1) / 2
    half = int(np.floor(c.min() / oversample))
    ix0, iy0 = int(round(x0)), int(round(y0))
    gy, gx = np.mgrid[iy0 - half - 1: iy0 + half + 2, ix0 - half - 1: ix0 + half + 2]

    def sample(px, py):
        return map_coordinates(epsf, [c[0] + (py - y0) * oversample, c[1] + (px - x0) * oversample],
                               order=1, mode="constant", cval=0.0)

    total = float(sample(gx.ravel(), gy.ravel()).sum())
    if not np.isfinite(total) or total <= 0:
        raise ValueError("EPSF has no positive flux")
    yy, xx = np.nonzero(weights > 0)
    return float((weights[yy, xx] * sample(xx, yy)).sum() / total)


def _frame_masks(frame: ScienceFrame) -> dict[str, np.ndarray]:
    image = np.asarray(frame["image"], float)
    var = np.asarray(frame["variance"], float) if frame.get("variance") is not None else None
    flags = (np.asarray(frame["flags"]).astype(np.uint32) if frame.get("flags") is not None
             else np.zeros(image.shape, np.uint32))
    defs = frame.get("flag_definitions") or fl.default_definitions()
    cats = fl.masks_by_category(defs)
    source_bits = sum(1 << b for b, n in defs.items() if n == "SOURCE")
    valid = np.isfinite(image) & ((flags & np.uint32(cats["bad"])) == 0)
    if var is not None:
        valid &= np.isfinite(var) & (var > 0)
    return {
        "image": image, "var": var, "flags": flags, "defs": defs, "valid": valid,
        "sat": (flags & np.uint32(cats["saturation"])) != 0,
        "art": (flags & np.uint32(cats["artifact"])) != 0,
        "src": (flags & np.uint32(source_bits)) != 0,
    }


def local_background(m: dict, x0: float, y0: float, r_in: float, r_out: float, min_pixels: int = 8) -> dict:
    """Sigma-clipped median of clean annulus pixels (drops SOURCE pixels when enough remain)."""
    ann = annulus_mask(m["image"].shape, x0, y0, r_in, r_out)
    clean = ann & m["valid"] & ~m["sat"] & ~m["art"]
    use = clean & ~m["src"]
    excluded_source = True
    if use.sum() < min_pixels:
        use, excluded_source = clean, False
    n = int(use.sum())
    if n < min_pixels:
        return {"ok": False, "n": n, "reason": f"only {n} clean annulus pixels (< {min_pixels})"}
    _, med, std = sigma_clipped_stats(m["image"][use], sigma=3.0, maxiters=5)
    return {"ok": True, "level": float(med), "error": float(1.2533 * std / np.sqrt(n)), "std": float(std),
            "n": n, "excluded_source_pixels": excluded_source}


def forced_photometry(frame: ScienceFrame, ra: float, dec: float, *,
                      aperture_arcsec: float = DEFAULT_APERTURE_ARCSEC,
                      annulus_arcsec: tuple[float, float] | None = None,
                      min_coverage: float = 0.95) -> dict:
    """Aperture photometry at a fixed sky position on one native frame.

    Returns a dict with ``status`` in {'ok', 'off_frame', 'incomplete', 'no_background'};
    ``flux``/``err`` are None unless status == 'ok'. Saturated apertures keep their
    (biased-low) numbers but carry ``saturated: True`` so callers can exclude them.
    """
    validate_frame(frame)
    m = _frame_masks(frame)
    wcs = frame["wcs"]
    x0, y0 = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
    omega = pixel_solid_angle_sr(wcs, x0, y0) if np.isfinite([x0, y0]).all() else np.nan
    scale = float(np.degrees(np.sqrt(omega)) * 3600) if np.isfinite(omega) else np.nan
    fwhm = float(frame.get("psf_fwhm_arcsec") or 2 * scale)
    r_ap = aperture_arcsec / scale
    if annulus_arcsec is None:
        r_in_as = max(2.5 * aperture_arcsec, 2.0 * fwhm)
        annulus_arcsec = (r_in_as, r_in_as + max(15.0, 2.5 * scale))
    r_in, r_out = (a / scale for a in annulus_arcsec)
    lam, bw = _wavelength_at(frame, x0, y0)
    base = {
        "frame_id": frame["id"], "collection": frame.get("collection"), "mjd": float(frame["mjd"]),
        "detector": int(frame["detector"]), "lambda_um": lam, "bandwidth_um": bw, "unit": UNIT,
        "x": x0, "y": y0, "aperture_arcsec": aperture_arcsec, "annulus_arcsec": list(annulus_arcsec),
        "pixel_scale_arcsec": scale, "flux": None, "err": None, "flags": [], "saturated": False,
        "provenance": frame.get("provenance", {}),
    }
    ny, nx = m["image"].shape
    if not (np.isfinite([x0, y0]).all() and r_ap <= x0 <= nx - 1 - r_ap and r_ap <= y0 <= ny - 1 - r_ap):
        return base | {"status": "off_frame"}
    w = circular_weights(m["image"].shape, x0, y0, r_ap)
    in_ap = w > 0
    names = sorted({n for v in np.unique(m["flags"][in_ap]) for n in fl.decode(int(v), m["defs"])})
    saturated = bool((m["sat"] & in_ap).any())
    coverage = float((w * m["valid"]).sum() / w.sum())
    out = base | {"flags": names, "saturated": saturated, "coverage": coverage,
                  "artifact_flags": sorted(n for n in names if fl.category(n) == "artifact")}
    if coverage < min_coverage:
        return out | {"status": "incomplete"}
    bg = local_background(m, x0, y0, r_in, r_out)
    if not bg["ok"]:
        return out | {"status": "no_background", "detail": bg["reason"]}
    wv = w * m["valid"]
    net = np.where(m["valid"], m["image"] - bg["level"], 0.0)
    flux_mjy = float((wv * net).sum() * omega)
    var_terms = 0.0
    if m["var"] is not None:
        var_terms = float((wv ** 2 * np.where(m["valid"], m["var"], 0.0)).sum())
    var_mjy = (var_terms + wv.sum() ** 2 * bg["error"] ** 2) * omega ** 2
    corr = 1.0
    corr_note = "none (no EPSF supplied): flux is aperture flux, not total"
    if frame.get("epsf") is not None:
        frac = epsf_aperture_fraction(frame["epsf"], int(frame.get("epsf_oversample", 5)), wv, x0, y0)
        if frac > 0.05:
            corr = 1.0 / frac
            corr_note = "EPSF enclosed-energy (truncated EPSF footprint)"
    flux = flux_mjy * MJY_TO_MJY * corr
    err = float(np.sqrt(var_mjy)) * MJY_TO_MJY * corr
    return out | {
        "status": "ok", "flux": flux, "err": err, "snr": flux / err if err > 0 else None,
        "aperture_flux_uncorrected": flux_mjy * MJY_TO_MJY, "aperture_correction": corr,
        "aperture_correction_method": corr_note, "background_mjy_sr": bg["level"],
        "background_err_mjy_sr": bg["error"], "background_pixels": bg["n"],
        "pixel_solid_angle_sr": omega,
    }


def _wavelength_at(frame: ScienceFrame, x: float, y: float) -> tuple[float | None, float | None]:
    lam = frame.get("lambda_um")
    bw = frame.get("bandwidth_um")
    ix, iy = int(round(x)) if np.isfinite(x) else -1, int(round(y)) if np.isfinite(y) else -1
    for key, cur in (("wavelength_map", "lam"), ("bandwidth_map", "bw")):
        arr = frame.get(key)
        if arr is not None and 0 <= iy < arr.shape[0] and 0 <= ix < arr.shape[1] and np.isfinite(arr[iy, ix]):
            if cur == "lam":
                lam = float(arr[iy, ix])
            else:
                bw = float(arr[iy, ix])
    return (None if lam is None else float(lam)), (None if bw is None else float(bw))


PositionFn = Callable[[float], tuple[float, float]]


def photometry_series(frames: Sequence[ScienceFrame], ra: float, dec: float, *,
                      position_fn: PositionFn | None = None, **kwargs) -> list[dict]:
    """Forced photometry on every frame. ``position_fn(mjd) -> (ra, dec)`` tracks a
    catalog-predicted moving position (e.g. a high proper-motion star) instead of a
    fixed point; the tracked position is reported per point."""
    points = []
    for f in frames:
        pra, pdec = position_fn(float(f["mjd"])) if position_fn else (ra, dec)
        p = forced_photometry(f, pra, pdec, **kwargs)
        p["position"] = {"ra": pra, "dec": pdec, "tracked": position_fn is not None}
        points.append(p)
    if points:
        seasons = assign_seasons([p["mjd"] for p in points])
        for p, s in zip(points, seasons):
            p["season"] = s
    return points


def usable(point: dict) -> bool:
    """Point suitable for spectral fitting / variability: measured, unsaturated, no artifacts."""
    return (point.get("status") == "ok" and not point.get("saturated")
            and not point.get("artifact_flags") and point.get("lambda_um") is not None
            and point.get("err") is not None and point["err"] > 0 and np.isfinite(point["flux"]))
