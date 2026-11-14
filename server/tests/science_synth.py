"""TEST-ONLY synthetic SPHEREx-like frames. Never imported by application code.

Frames mimic the real Level-2 conventions verified on DR1 headers: MJy/sr
images, (MJy/sr)^2 variance, uint32 FLAGS with DR1 bit definitions, TAN WCS with
~6.15 arcsec pixels and a rotated PC matrix, PSF FWHM ~9 arcsec.
"""

from __future__ import annotations

import numpy as np
from astropy.wcs import WCS
from scipy.special import erf

from spherex.science import flags as fl

PIX_ARCSEC = 6.15
FWHM_ARCSEC = 9.0


def make_wcs(ra0: float, dec0: float, shape=(25, 25), rot_deg: float = 17.0, pix_arcsec: float = PIX_ARCSEC) -> WCS:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra0, dec0]
    w.wcs.crpix = [(shape[1] + 1) / 2, (shape[0] + 1) / 2]
    s = pix_arcsec / 3600
    c, sn = np.cos(np.radians(rot_deg)), np.sin(np.radians(rot_deg))
    w.wcs.cd = [[-s * c, s * sn], [s * sn, s * c]]
    return w


def gaussian_pixels(shape, x0, y0, sigma):
    yy, xx = np.indices(shape)
    r2 = np.sqrt(2) * sigma
    fx = 0.5 * (erf((xx + 0.5 - x0) / r2) - erf((xx - 0.5 - x0) / r2))
    fy = 0.5 * (erf((yy + 0.5 - y0) / r2) - erf((yy - 0.5 - y0) / r2))
    return fx * fy


def gaussian_epsf(fwhm_px: float, oversample: int = 5, n: int = 33) -> np.ndarray:
    """Effective PSF = Gaussian convolved with the native pixel, sampled every 1/oversample px."""
    c = (n - 1) / 2
    off = (np.arange(n) - c) / oversample  # native-pixel offsets
    s = np.sqrt(2) * fwhm_px / 2.3548
    f1 = 0.5 * (erf((off + 0.5) / s) - erf((off - 0.5) / s))
    psf = f1[:, None] * f1[None, :]
    return psf / psf.sum()


def make_frame(ra0=150.0, dec0=2.0, *, sources=(), mjd=60800.0, detector=6, lambda_um=4.5,
               bandwidth_um=0.04, shape=(25, 25), sky=0.5, noise=0.02, seed=0, flags=None,
               frame_id=None, with_epsf=True, rot_deg=17.0, saturate_above=None):
    """sources: iterable of (ra, dec, flux_mJy). Returns a ScienceFrame dict."""
    rng = np.random.default_rng(seed)
    wcs = make_wcs(ra0, dec0, shape, rot_deg)
    omega = np.radians(PIX_ARCSEC / 3600) ** 2
    sigma_px = FWHM_ARCSEC / PIX_ARCSEC / 2.3548
    img = np.full(shape, float(sky))
    for ra, dec, flux_mjy in sources:
        x, y = wcs.world_to_pixel_values(ra, dec)
        img += gaussian_pixels(shape, float(x), float(y), sigma_px) * (flux_mjy * 1e-9) / omega
    var = np.full(shape, noise ** 2) + 1e-4 * np.clip(img - sky, 0, None)
    img = img + rng.normal(0, np.sqrt(var))
    fl_arr = np.zeros(shape, np.uint32) if flags is None else np.asarray(flags, np.uint32)
    if saturate_above is not None:
        fl_arr = fl_arr | np.where(img > saturate_above, np.uint32(1 << 1), np.uint32(0))
    frame = {
        "id": frame_id or f"synthetic_{mjd:.3f}_D{detector}", "collection": "SYNTHETIC-TEST",
        "mjd": float(mjd), "detector": detector, "lambda_um": lambda_um, "bandwidth_um": bandwidth_um,
        "image": img, "variance": var, "flags": fl_arr, "flag_definitions": fl.default_definitions(),
        "wcs": wcs, "wavelength_map": np.full(shape, lambda_um), "bandwidth_map": np.full(shape, bandwidth_um),
        "psf_fwhm_arcsec": FWHM_ARCSEC, "epsf": gaussian_epsf(FWHM_ARCSEC / PIX_ARCSEC) if with_epsf else None,
        "epsf_oversample": 5, "provenance": {"obs_id": "synthetic", "url": "test://synthetic"},
    }
    return frame
