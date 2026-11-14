"""Typed interfaces between the science package and whoever supplies frames.

The science functions never download anything themselves (except the catalog
clients in gaia.py / skybot.py). They operate on ``ScienceFrame`` dicts, which
the integrator builds from real SPHEREx Level-2 products. Synthetic frames are
only ever built inside tests.
"""

from __future__ import annotations

from typing import Any, Protocol, TypedDict

import numpy as np
from astropy.wcs import WCS


class Provenance(TypedDict, total=False):
    url: str
    obs_id: str
    collection: str


class ScienceFrame(TypedDict, total=False):
    """One SPHEREx observation of a patch of sky.

    Required keys: ``id``, ``mjd``, ``detector``, ``image``, ``wcs``.
    Strongly recommended: ``variance`` (errors), ``flags`` (+ ``flag_definitions``),
    ``wavelength_map`` (or ``lambda_um``), ``bandwidth_map`` (or ``bandwidth_um``).

    Arrays use the standard FITS/numpy convention of the frame's own WCS
    (``image[y, x]``, zero-based pixel centres). Photometric errors are only
    valid on NATIVE (non-reprojected) pixels: interpolation correlates noise.
    """

    id: str
    collection: str
    mjd: float
    detector: int
    lambda_um: float  # wavelength at the cutout centre [um]
    bandwidth_um: float  # bandwidth at the cutout centre [um]
    image: np.ndarray  # surface brightness [MJy/sr]
    variance: np.ndarray  # [(MJy/sr)^2]
    flags: np.ndarray  # uint32 bitmask
    flag_definitions: dict[int, str]  # bit -> MSKN name, read from the FLAGS header
    wcs: WCS  # celestial WCS (TAN-SIP for native products)
    wavelength_map: np.ndarray | None  # per-pixel central wavelength [um]
    bandwidth_map: np.ndarray | None  # per-pixel bandwidth [um]
    psf_fwhm_arcsec: float  # PSF_FWHM header keyword
    epsf: np.ndarray | None  # oversampled effective PSF (EPSF HDU zone nearest target)
    epsf_oversample: int  # OVSMPX of the EPSF HDU
    provenance: Provenance
    extra: dict[str, Any]


class GetFrames(Protocol):
    """Frame supplier used by routes.py.

    Must return REAL observations covering (ra, dec), at most ``max_frames``,
    or raise an exception with a human-readable message. Never synthetic data.
    """

    def __call__(self, ra: float, dec: float, fov_arcmin: float, max_frames: int) -> list[ScienceFrame]:
        ...


REQUIRED_FRAME_KEYS = ("id", "mjd", "detector", "image", "wcs")


def validate_frame(frame: ScienceFrame) -> None:
    """Raise ValueError if a frame lacks required keys or has inconsistent shapes."""
    missing = [k for k in REQUIRED_FRAME_KEYS if k not in frame]
    if missing:
        raise ValueError(f"Frame lacks required keys: {missing}")
    shape = np.shape(frame["image"])
    if len(shape) != 2:
        raise ValueError("Frame image must be 2-D")
    for key in ("variance", "flags", "wavelength_map", "bandwidth_map"):
        arr = frame.get(key)
        if arr is not None and np.shape(arr) != shape:
            raise ValueError(f"Frame {key} shape {np.shape(arr)} != image shape {shape}")
