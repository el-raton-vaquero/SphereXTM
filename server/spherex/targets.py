"""Small, referenced M4 catalog registry; positions here are predictions, never detections."""
from __future__ import annotations

import json
from pathlib import Path

from astropy import units as u
from astropy.coordinates import Distance, SkyCoord
from astropy.time import Time
import numpy as np

REGISTRY = Path(__file__).with_name('data') / 'm4-targets.json'


def load_targets() -> dict[str, dict]:
    return {target['id']: target for target in json.loads(REGISTRY.read_text(encoding="utf-8"))}


def predict(target: dict, mjd: float) -> SkyCoord:
    """ICRS space motion. No observer annual parallax, orbit, or covariance propagation.

    Position epoch is distinct from equinox (ICRS has no equinox). pm_ra_cosdec
    is mu_alpha*, not d(alpha)/dt. Missing RV explicitly means zero km/s.
    """
    values = [target[k] for k in ('ra_deg', 'dec_deg', 'epoch',
                                 'pm_ra_cosdec_masyr', 'pm_dec_masyr', 'parallax_mas')]
    if not np.isfinite(values).all() or target['parallax_mas'] <= 0:
        raise ValueError('Invalid catalog astrometry')
    coord = SkyCoord(ra=target['ra_deg'] * u.deg, dec=target['dec_deg'] * u.deg,
                     distance=Distance(parallax=target['parallax_mas'] * u.mas),
                     pm_ra_cosdec=target['pm_ra_cosdec_masyr'] * u.mas/u.yr,
                     pm_dec=target['pm_dec_masyr'] * u.mas/u.yr,
                     radial_velocity=(target.get('radial_velocity_kms') or 0) * u.km/u.s,
                     obstime=Time(target['epoch'], format=target['epoch_format'],
                                  scale=target['epoch_scale']), frame='icrs')
    return coord.apply_space_motion(new_obstime=Time(mjd, format='mjd', scale='utc'))


def sky_position(coord: SkyCoord) -> dict:
    return {'ra_deg': float(coord.ra.deg), 'dec_deg': float(coord.dec.deg),
            'kind': 'catalog_predicted', 'frame': 'ICRS'}


def trajectory_region(target: dict, start_mjd: float, end_mjd: float) -> tuple[SkyCoord, float]:
    """One small cone enclosing a sampled trajectory plus a 36 arcsec margin.

    Returns a fixed sky center for ALL cutouts and comparisons, not per-epoch
    recentering. Margin covers annual parallax and stated anchor/orbit errors.
    """
    if not (np.isfinite([start_mjd, end_mjd]).all() and 0 < end_mjd-start_mjd <= 1000):
        raise ValueError('Trajectory interval must be positive and <=1000 days')
    center = predict(target, (start_mjd + end_mjd) / 2)
    radius = max(center.separation(predict(target, t)).deg
                 for t in np.linspace(start_mjd, end_mjd, 17)) + 0.01
    if radius > 0.03:
        raise ValueError('Trajectory exceeds bounded 0.03 degree discovery cone')
    # Strip distance/differentials for straightforward WCS use.
    return SkyCoord(center.ra, center.dec, frame='icrs'), float(radius)
