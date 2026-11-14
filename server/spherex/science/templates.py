"""Spectral templates for the classifier (f_nu shapes; normalisation is fitted).

Families
--------
- ``brown_dwarf``: OBSERVED JWST NIRSpec PRISM spectra of T6.5-Y1 dwarfs from
  Beiler et al. 2024 (ApJ 973, 107), CC-BY-4.0, in data/templates/ (see README).
  Coverage ~0.97-5.3 um.
- ``star``: IDEALISED blackbodies (Planck f_nu). Not stellar atmospheres: real
  M dwarfs have strong H2O/CO bands, so a blackbody is only a continuum proxy.
- ``asteroid_toy``: TOY model = reflected sunlight (5778 K blackbody times a flat
  reflectance) + thermal blackbody, two non-negative amplitudes. Clearly a toy:
  no phase function, beaming, or emissivity.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

TEMPLATE_DIR = Path(__file__).resolve().parents[1] / "data" / "templates"
H_OVER_K_UM = 14387.769  # h c / k in um K


def planck_fnu(lam_um: np.ndarray, temp_k: float) -> np.ndarray:
    """Planck B_nu shape (arbitrary normalisation) at wavelengths in um."""
    lam = np.asarray(lam_um, float)
    x = H_OVER_K_UM / (lam * temp_k)
    with np.errstate(over="ignore"):
        return (1.0 / lam ** 3) / np.expm1(np.minimum(x, 700.0))


@dataclass
class Template:
    id: str
    cls: str
    label: str
    components: list[Callable[[np.ndarray], np.ndarray]]  # each returns f_nu shape (NaN outside coverage)
    teff: float | None = None
    spectral_type: str | None = None
    kind: str = "observed"  # observed | idealized | toy
    reference: str | None = None
    lambda_range_um: tuple[float, float] = (0.0, np.inf)
    meta: dict = field(default_factory=dict)

    @property
    def n_params(self) -> int:
        return len(self.components)


def _tabulated(lam: np.ndarray, flux: np.ndarray) -> Callable[[np.ndarray], np.ndarray]:
    order = np.argsort(lam)
    lam, flux = lam[order], flux[order]

    def f(x):
        return np.interp(np.asarray(x, float), lam, flux, left=np.nan, right=np.nan)

    return f


def _read_csv(path: Path) -> tuple[dict, np.ndarray]:
    meta, rows = {}, []
    for line in path.read_text().splitlines():
        if line.startswith("#"):
            k, _, v = line[1:].partition(":")
            meta[k.strip()] = v.strip()
        elif line and not line.startswith("lambda"):
            rows.append([float(x) for x in line.split(",")])
    return meta, np.array(rows)


def brown_dwarf_templates() -> list[Template]:
    out = []
    for path in sorted(TEMPLATE_DIR.glob("bd_*.csv")):
        meta, arr = _read_csv(path)
        lam, flux = arr[:, 0], arr[:, 1]
        out.append(Template(
            id=meta["template_id"], cls="brown_dwarf",
            label=f"{meta['object']} ({meta['spectral_type']}, observed JWST)",
            components=[_tabulated(lam, flux)], teff=float(meta["teff_k"]),
            spectral_type=meta["spectral_type"], kind="observed", reference=meta["reference"],
            lambda_range_um=(float(lam.min()), float(lam.max())), meta=meta))
    return out


STAR_TEFFS = (2500, 3000, 3500, 4500, 5800, 7500, 10000)
ASTEROID_THERMAL_T = (180, 230, 280)


def star_templates() -> list[Template]:
    return [Template(id=f"bb_{t}k", cls="star", label=f"Blackbody {t} K (idealized)",
                     components=[lambda x, t=t: planck_fnu(x, t)], teff=float(t), kind="idealized",
                     reference="Planck law; not a stellar atmosphere model")
            for t in STAR_TEFFS]


def asteroid_templates() -> list[Template]:
    sun = lambda x: planck_fnu(x, 5778.0)  # noqa: E731
    return [Template(id=f"asteroid_toy_t{t}", cls="asteroid_toy",
                     label=f"Asteroid TOY: reflected sunlight + {t} K thermal",
                     components=[sun, lambda x, t=t: planck_fnu(x, t)], teff=float(t), kind="toy",
                     reference="Toy model (flat reflectance x 5778 K blackbody + thermal blackbody)")
            for t in ASTEROID_THERMAL_T]


def default_templates() -> list[Template]:
    return brown_dwarf_templates() + star_templates() + asteroid_templates()


def band_average(template_fn: Callable[[np.ndarray], np.ndarray], lam_um: np.ndarray,
                 bw_um: np.ndarray, n_sub: int = 9) -> np.ndarray:
    """Top-hat band average of a template over [lam - bw/2, lam + bw/2]; NaN if any sample is outside coverage."""
    lam = np.asarray(lam_um, float)[:, None]
    bw = np.nan_to_num(np.asarray(bw_um, float), nan=0.0)[:, None]
    offs = (np.arange(n_sub) + 0.5) / n_sub - 0.5
    return np.mean(template_fn(lam + bw * offs[None, :]), axis=1)
