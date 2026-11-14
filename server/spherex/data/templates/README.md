# Spectral templates (PRISM classifier)

Small, versioned template files used by `spherex/science/templates.py`.

## Observed brown-dwarf spectra (`bd_*.csv`)

| File | Object | SpT | T_eff (K, 1 R_Jup) |
|---|---|---|---|
| `bd_t6p5_sdss1346.csv` | SDSSp J1346-00 | T6.5 | 1011 |
| `bd_t8_wise1959.csv` | WISEPA J1959-33 | T8 | 734 |
| `bd_t9_wise2102.csv` | WISE J2102-44 | T9 | 552 |
| `bd_y0_wise0359.csv` | WISE J0359-54 | Y0 | 453 |
| `bd_y1_cwise1446.csv` | CWISEP J1446-23 | Y1 | 364 |

- **Data**: JWST NIRSpec PRISM spectra (merged with MIRI LRS beyond 5 um, removed
  here) behind Figs. 5-7 of Beiler, S. A., Cushing, M. C., Kirkpatrick, J. D., et al.
  2024, *ApJ* 973, 107, "Precise Bolometric Luminosities and Effective
  Temperatures of 23 late-T and Y dwarfs Obtained with JWST",
  doi:[10.3847/1538-4357/ad6301](https://doi.org/10.3847/1538-4357/ad6301).
- **Archive**: Zenodo, doi:[10.5281/zenodo.14976898](https://doi.org/10.5281/zenodo.14976898)
  (published 2025-03-05). **Licence: CC-BY-4.0** (attribution above).
- **Spectral types and T_eff**: Table 4 of the paper (arXiv:2407.08518v2), column
  "T_eff^RJup" (nominal 1 Jupiter radius).
- **Processing**: rows copied verbatim (wavelength um, flux density Jy, error Jy,
  resolving power), only lambda <= 5.3 um kept. No resampling or smoothing.
  The md5 of each source file is in the CSV header. Rebuild with
  `uv run --locked python -m spherex.science.tools.build_templates <dir with .mrt files>`.
- **Coverage**: ~0.97-5.3 um (NIRSpec PRISM). SPHEREx points below ~1.0 um are
  outside the brown-dwarf templates and are excluded from the common fit set.
- **Resolution**: R ~ 30-300, comparable to SPHEREx (R ~ 35-130), so no further
  degradation is applied; the classifier band-averages each template over each
  SPHEREx point's bandwidth.

Missing from this set: L and early-T dwarfs, M dwarfs, and Y dwarfs colder than Y1
(WISE 0855-0714, estimated at 225-260 K by Luhman 2014, is much colder than any
template here). A best
match can therefore only be "closest within this set".

## Analytic families (no files)

- `star`: Planck blackbodies (2500-10000 K). **Idealized**, not stellar atmospheres.
- `asteroid_toy`: reflected 5778 K blackbody (flat reflectance) plus a thermal
  blackbody (180/230/280 K), two non-negative amplitudes. **Toy model**: no phase
  function, beaming or emissivity.
