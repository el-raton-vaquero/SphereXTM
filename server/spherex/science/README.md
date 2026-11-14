# `spherex.science`: PRISM science models

Pure, unit-tested functions behind `/v2/gaia`, `/v2/skybot`, `/v2/spectrum` and
`/v2/verdict`. No synthetic data is ever produced here. Synthetic frames live only
in `server/tests/science_synth.py`.

| Module | What it does |
|---|---|
| `types.py` | `ScienceFrame` TypedDict + `GetFrames` Protocol (the integration contract) |
| `flags.py` | FLAGS decoding from `MSKN/MSKM` header keywords; DR1 transcription as fallback; categories |
| `seasons.py` | Season clustering (gap > 60 d) |
| `gaia.py` | Gaia DR3 TAP cone (+ fast-mover branch), disk cache, PM + RV + annual-parallax propagation |
| `skybot.py` | IMCCE SkyBoT cone search at epochs (geocentric), cache, per-epoch errors |
| `photometry.py` | Forced aperture photometry (mJy, VARIANCE errors, ePSF aperture correction) + forced PSF-fit deblending |
| `centroid.py` | Pixel-integrated Gaussian centroids (neighbours fixed), season positions, measured vs predicted motion |
| `variability.py` | Season-to-season chi2 at matched wavelengths (same detector, delta-lambda < 0.5 bandwidth) |
| `goggles.py` + `recipes/goggles.json` | Band-depth indices for CH4, H2O, CO2 and CO (maps or point sets) |
| `templates.py` | Beiler+2024 JWST brown dwarfs (observed), blackbodies (idealized), asteroid toy |
| `classify.py` | Scale fit, reduced chi2, Akaike weights (non-exhaustive template set, stated) |
| `verdict.py` | Evidence checks -> verdict + heuristic confidence |
| `frames.py` | `load_native_frame` (real IRSA cutout -> ScienceFrame), `ArchiveFrameSource` (default GetFrames) |
| `routes.py` | Optional FastAPI router to mount |
| `tools/validate_real.py` | End-to-end run against live IRSA/Gaia/SkyBoT |

## How v2.py should mount it

```python
from spherex.science.routes import build_router
app.include_router(build_router(get_frames=None))   # default: ArchiveFrameSource (IRSA cutouts)
# or, with the integrator's faster supplier:
app.include_router(build_router(get_frames=my_supplier, cache_dir=Path("cache/science")))
```

`get_frames(ra, dec, fov_arcmin, max_frames) -> list[ScienceFrame]` must return
**real, native-pixel** frames. Interpolated or reprojected pixels give wrong
photometric errors. If the supplier also has
`.fetch(...) -> (frames, report_dict)`, the report is echoed in `provenance.frames`.
On failure it raises, and the router answers HTTP 502 with
`{"detail": {"error", "source"}}`. There is no fallback.

`ScienceFrame` (see `types.py`): `id, mjd, detector, image [MJy/sr], wcs`
(required); `variance [(MJy/sr)^2], flags (uint32), flag_definitions {bit: name}`
(from `definitions_from_header(FLAGS header)`), `wavelength_map/bandwidth_map [um]`
(or scalar `lambda_um/bandwidth_um`), `psf_fwhm_arcsec`,
`epsf` (33x33 zone from the EPSF HDU) + `epsf_oversample`, `provenance`.
`load_native_frame(path, provenance, target_radec)` builds exactly this from an
IRSA cutout, including the per-pixel wavelength from the alternate `W` WCS and
the EPSF zone nearest the target, located through the cutout's `CRPIXnA`
detector offsets.

## Function signatures (direct use without the router)

```python
gaia.predict_sources(ra, dec, radius_arcmin, mjds, *, max_sources=300, cache_dir=None) -> dict  # /v2/gaia
gaia.propagate_arrays(rows, mjds, include_parallax=True) -> (ra[N,M], dec[N,M], err_arcsec[N,M])
gaia.nearest_match(sources, ra, dec, mjd|None, radius_arcsec) -> dict|None
gaia.source_predictor(source) -> Callable[[mjd], (ra, dec)]
skybot.cone_search(ra, dec, radius_arcmin, mjd, *, cache_dir=None) -> dict
skybot.cone_search_epochs(ra, dec, radius_arcmin, mjds, max_queries=12) -> dict              # /v2/skybot
photometry.forced_photometry(frame, ra, dec, *, aperture_arcsec=9, neighbours=()) -> point dict
photometry.photometry_series(frames, ra, dec, *, position_fn=None, neighbours_fn=None) -> [points]
centroid.centroid_frame(frame, ra, dec, *, neighbours=()) -> dict
centroid.season_positions(centroids, *, ra0, dec0) -> [season dicts]
centroid.motion_test(seasons, predictor=None) -> dict
variability.compare_seasons(points) -> dict
goggles.band_depth_maps(stack, recipe_ids=None) / goggles.band_depth_points(points)
classify.classify(points) -> {best, ranking, by_class, method, caveats, ...}
verdict.evaluate(points=..., gaia_match=..., gaia_error=..., skybot=..., motion=..., variability=...,
                 classification=..., registry_match=..., neighbours=...) -> {checks, verdict, confidence, summary, summary_es}
```

A spectrum point carries `lambda_um, bandwidth_um, flux, err, unit ('mJy'), mjd,
season, detector, frame_id, flags [names], saturated, artifact_flags, status,
flux_method ('aperture' | 'psf_fit_deblended'), aperture_flux, aperture_correction,
psf_fit, position {ra, dec, tracked}, provenance`. Statuses other than `ok`
(`off_frame | incomplete | no_background`) carry `flux = null`.

## Response additions beyond the V2 contract

- Gaia `source_id` is a **string** (64-bit ids exceed JS safe integers). Each
  position has `err_arcsec`, and every source and payload has `kind: 'catalog_predicted'`.
- `/v2/spectrum` adds `goggles`, `tracking` (which prediction the aperture
  follows) and `blend_neighbours`.
- `/v2/verdict` adds `summary_es`, `stats`, `evidence` (centroids, season
  positions, motion, variability, classification, SkyBoT epochs, Gaia provenance)
  and the checks `confusion` and `registry`.
- Check status semantics are documented at the top of `verdict.py`.
  `known_star` covers any catalogued non-SSO point source, brown dwarfs included.

## Methods, assumptions and caveats (shown to users)

- **Flags**: bit names come from the FITS header. Categories: saturation
  (OVERFLOW, NONLINEAR, BLOOM); artifact (TRANSIENT, PERSIST, OUTLIER, CROSSTALK,
  GHOST*, STREAK, SNOWBALL, HALO); informational (SOURCE, FULLSAMPLE). Everything
  else, including unknown bits, is bad, as in `spherex.archive`.
- **Flux**: I [MJy/sr] times the pixel solid angle from the local WCS Jacobian,
  converted to mJy. The ePSF aperture correction evaluates the ePSF at each
  aperture pixel's offset. "Total" means inside the truncated ePSF footprint
  (KEEPNAT).
- **Deblending**: Gaia neighbours within 2 px are included when G <= G_target + 4,
  or G <= 19 when the target has no Gaia counterpart (a heuristic). They are
  fitted at fixed predicted positions.
- **Astrometry**: per-season error = max(formal, scatter/sqrt(n)) in quadrature with
  `ASTROMETRIC_FLOOR_ARCSEC = 0.3`. That floor is an **assumption**, not a
  documented SPHEREx figure. Motion uses the first and last seasons with >= 3
  good centroids.
- **Gaia**: geocentric annual parallax included; aberration not applied; covariances
  not propagated; RV missing -> 0. Gaia misses Y dwarfs.
- **SkyBoT**: geocentric ephemerides; LEO parallax ~1 px for near objects; only
  sampled epochs are queried (brightest detections first).
- **Classification**: relative preference within a small set. Points from different
  epochs are combined, and a 3% calibration error is assumed.
- **Registry tracking** (`spherex/data/m4-targets.json`) uses `spherex.targets.predict`,
  which has no annual parallax (<= 0.55 arcsec for these targets).

## Real-data validation (2026-11-14, live services)

`uv run --locked python -m spherex.science.tools.validate_real --cache <dir> --target <id> --max-frames N`

**WISE 0855-0714** (36 DR1 frames out of 258; aperture tracked from the Luhman 2014
registry entry):
- Gaia has no counterpart within 4 arcsec. Gaia DR3 5756956644387831296 (G = 16.3)
  lies 8.7 arcsec away and was deblended.
- Fluxes at 0.77-3.9 um are consistent with zero (|S/N| < 2, except one
  OUTLIER-flagged frame).
- At 4.19-4.75 um it is detected at 0.41-0.66 mJy (S/N 3.4-6.2).
- Best template: Y1 (CWISEP J1446-23), reduced chi2 1.5, relative weight 0.84.
  That is "the coldest available", not a spectral type.
- Motion: n/a (only one season with S/N >= 5 centroids). Verdict: `known_star`
  via the literature registry, with a confusion warning.
- Before deblending, aperture photometry was dominated by the neighbour, which
  produced a spurious "asteroid toy" fit. This is why deblending exists.

**Barnard's Star** (23 frames): every frame is OVERFLOW/BLOOM/SUR_ERROR at the
aperture, so no photometry, centroid or class is produced. The verdict is
`known_star` (Gaia DR3 4472832130942575872) at 0.60, with saturation `fail`.
Some IRSA cutout downloads failed with HTTP errors during the runs and were
reported in `provenance.frames.failures`.

Live Gaia check: Barnard propagated to MJD 60912.714 gives
RA 269.4462089, Dec +4.7672440. That is ~0.5 arcsec from the parallax-free
`spherex.targets.predict`, consistent with its 0.547 arcsec parallax.
