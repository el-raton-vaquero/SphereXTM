# Frontend ↔ scientific API contract

This documents the scientific API contract implemented in Milestone M2 (`server/spherex/api.py`). Source of truth: `frontend/lib/types.ts`, `server/spherex/models.py`.

## Transport and routing
- FastAPI service runs locally on port 8000: `uv run --locked uvicorn spherex.api:app --host 127.0.0.1 --port 8000`.
- Next.js development server runs on port 3000 with transparent reverse rewrite proxy in `frontend/next.config.ts`:
  ```ts
  async rewrites() {
    return [{ source: '/api/:path*', destination: 'http://127.0.0.1:8000/:path*' }];
  }
  ```
- Client calls `/api/frames` directly with same-origin relative URLs, requiring no CORS headers.
- Mode dispatching: `RealSpherexAPI` is active when `NEXT_PUBLIC_USE_REAL_API=true` or query parameter `api=real` is present. Synthetic demo mode is enforced with `api=mock`. M3.5 defaults to real mode when the environment variable is unset; explicit `NEXT_PUBLIC_USE_REAL_API=false` selects simulation. URL parameters override the environment. The UI origin switch starts a fresh observatory URL with an explicit `api` value.
- Endpoints:
  - `GET /api/health`: Health status, version, and confirmation of cached dataset usability.
  - `GET /api/frames?ra=<deg>&dec=<deg>&fov=<arcmin>`: Returns real, WCS-aligned observations.
  - `GET /api/spectrum`: Single-band Level 2 notice returned; 102-band spectral cubes deferred to M5.

### `GET /frames?ra=<deg>&dec=<deg>&fov=<arcmin>`
- `ra`: degrees, [0, 360); `dec`: degrees, [-90,90]; `fov`: requested field of view in arcminutes, range [1, 30].
- **Response Type:** `FramesResponse` compatible with `frontend/lib/types.ts`:
  - `target`: `Target` `{ra, dec, name, category, description}`
  - `wcs`: `WCS` `{crpix: [15, 15], crval: [210.80227, 54.34895], cdelt: 0.0017088, size: [30, 30]}`
  - `fovArcmin`: number (e.g. 3.0)
  - `epochs`: list of `{epoch, date, mjd}`
  - `frames`: list of `Frame`:
    - `id`: observation ID (e.g. `2026W20_2A_0464_3`)
    - `mjd`, `date`: UTC observation timestamps (from `MJD-OBS`/`DATE-OBS`)
    - `epochIndex`: integer (0, 1, ...)
    - `detector`: integer (1 to 6; M101 uses Detector 2)
    - `band`: `{lambda_um, width_um, detector, index}`
    - `flags`: `["contaminated_edge"]`
    - `width`, `height`: 30, 30
    - `pixelData`: row-major numeric array (length 900) of surface brightness in `MJy / sr`. Deserialized by `RealSpherexAPI` into a client-side `Float32Array`. Invalid pixels are serialized as `0.0` (never `NaN` or `null`).
    - `validMask`: row-major binary array (length 900) where `1` = scientifically valid, `0` = excluded/masked.
    - `stats`: `{min, max, median, mean, std}` computed strictly over valid pixels.
    - `units`: `"MJy / sr"`
    - `provenance`: observation metadata and archive collection.
  - `validMask`: shared grid validity mask (769 valid pixels, 85.44%).
  - `provenance`: mission citation, observation IDs, time separation (37.68 days), matched spectral metrics, and scientific limitations.

### Orientation and Coordinates
- In astronomical FITS files (`aligned.fits`), row 0 is South (`CDELT2 > 0`, `origin='lower'`).
- In API JSON (`pixelData`), rows are serialized North-up (`np.flipud(fits_array)`), matching web canvas coordinates and `frontend/lib/wcs.ts` tangent projection (`y = 0` corresponds to North, `x = 0` corresponds to East).

### Errors and Data Safety
- HTTP 422: Parameter validation error (out-of-bounds coordinates, non-numeric values).
- HTTP 404: Region not supported in MVP (only verified M101 region is supported).
- HTTP 503: Data unavailable on server (e.g. cached FITS products not prepared on disk).

## Contract integration checklist
- [x] Backend implemented with FastAPI (`server/spherex/api.py`).
- [x] Shape/order/finite pixel values and NaN-free masking tested.
- [x] WCS orientation and alignment verified with known coordinates (row 0 = North).
- [x] Variable epochs supported (2 verified epochs for M101).
- [x] Response provenance, units, and validity masks included in schema.
- [x] M3: Reverse proxy rewrite configured between Next.js and FastAPI (`next.config.ts`).
- [x] M3: Frontend adapter converts numeric array into `Float32Array`.
- [x] M3: Single-band Level 2 status and M5 spectral cube deferral clearly communicated in UI.

## SphereXTM frontend integration (2026-11-14)

HTTP shapes and proxy are unchanged. The integrated client validates dimensions,
epoch references and mask lengths and converts pixel arrays to Float32Array.
Request cancellation/sequence checks discard outdated results; bounded client
cache keys contain origin and full query values. SpectrumViewer remains synthetic
only. Catalog queries are separate external context, never SPHEREx detections.

## Docker Compose

El esquema HTTP no cambia. `SPHEREX_API_INTERNAL_URL` selecciona el destino
servidor del rewrite durante `next build`; predeterminado local
`http://127.0.0.1:8000`, en Compose `http://backend:8000`. El navegador sigue
consultando `/api/*` en el mismo origen. FastAPI no publica un puerto al host.
La inicialización del volumen científico precede al backend y frontend; fallos
de adquisición no se reemplazan con datos sintéticos. Ver `docs/docker.md`.

## PRISM v2 (`/v2/*`, 2026-11-14)

Router: `server/spherex/v2.py`, mounted in `spherex.api:app` next to the unchanged
`/frames`. The browser calls `/api/v2/...` through the existing Next.js rewrite.

- `GET /v2/targets` — six presets (`barnard`, `eps-indi-b`, `wise-0855`, `rw-aur`,
  `r-dra`, `m101`) from `server/spherex/data/prism-targets.json`, resolved from
  Gaia DR3 TAP (Barnard; eps Ind B = Gaia DR3 6412596012146801152, cross-identified in
  SIMBAD; R Dra) or SIMBAD TAP (WISE 0855, RW Aur, M101). `ra/dec` are
  **catalog-predicted** positions propagated with `SkyCoord.apply_space_motion` to
  MJD 61000 (2025-11-21); raw astrometry, epoch, query and bibcode are in `catalog`.
  `expected` is a prior, not a measurement.
  Refresh: `uv run --locked python -m spherex.targets_v2 --refresh`.
- `GET /v2/search?ra&dec&fov=4&max_frames=60&collections=spherex_dr1,spherex_qr3`
  (fov 1–20 arcmin, max_frames 1–160). Returns `query, grid{n, pixscale_arcsec,
  wcs{crval, crpix, cd}, north_up}, frames[], seasons[], detectors[],
  provenance{citation, collections, query_urls, generated_utc, errors,
  collection_errors, transfer_bytes, ...}, pixel_encoding, units, cache`.
  - `pixels_b64`: little-endian float32 n×n, row 0 = North, column 0 = East, MJy/sr.
    NaN only where there is no usable measurement (outside footprint, non-finite,
    variance ≤ 0, or NONFUNC/MISSING_DATA/HOT/COLD/DICHROIC/PHANMISS). All other
    flags (OVERFLOW, TRANSIENT, GHOST, CROSSTALK, PERSIST, SOURCE…) stay in
    `flags_b64` (uint32, nearest native pixel), decoded per frame via `flag_bits`.
  - `grid.wcs.cd` is expressed for the delivered north-up array: `[[-s,0],[0,-s]]`,
    `crpix` 1-based.
  - Per frame: `id, obs_id, collection, mjd, date, season, detector, lambda_um,
    bandwidth_um` (spectral WCS 'W' at the request centre), `saturated_at_center`
    (OVERFLOW/NONLINEAR/BLOOM within 2 native px), `center_flags`, `valid_fraction`,
    `clean_fraction`, `psf_fwhm_arcsec`, `provenance{url, obs_id, method, transfer_bytes}`.
  - Seasons: a gap > 60 days starts a new season.
  - Errors (`{detail, error_type, ...}`): 422 invalid parameters/collection; 404
    `no_coverage` (completed SIA query, zero products); 502 `archive_unavailable` /
    `download_failed`. Partial collection failures → `provenance.collection_errors`;
    per-frame failures → `provenance.errors`. Never substituted with synthetic data.
- `GET /v2/search/stream` — same parameters, `text/event-stream`: `progress` events
  (`stage`: discovery → discovered → frames{done,total,failed} → done), then one
  `result` (full search JSON) or `error` event.
- `GET /v2/gaia`, `/v2/skybot`, `/v2/spectrum`, `/v2/verdict` — dispatch to functions
  registered with `spherex.v2.register_provider(name, fn)` (a module
  `spherex.v2_providers` is auto-imported if present). Unregistered → HTTP 501
  `not_implemented`. Signatures: `gaia(ra, dec, radius_arcmin, mjd: list[float])`,
  `skybot(ra, dec, radius_arcmin, mjd)`, `spectrum(ra, dec, aperture_arcsec)`,
  `verdict(ra, dec, fov)`. For photometry, `spherex.live.native_frames()` returns
  native IMAGE/FLAGS/VARIANCE cutouts with celestial and spectral WCS.

Snapshots: `frontend/public/snapshots/<id>.json` (same schema, `cache: "snapshot"`,
plus `target`, `snapshot`, and `gaia/spectrum/verdict` only if providers exist) and
`index.json`, generated from live IRSA by `server/scripts/precompute_snapshots.py`.

Transfer: SIA `cloud_access` → HTTP byte ranges on the public AWS mirror
`nasa-irsa-spherex` (IMAGE/VARIANCE rows, RICE row-tile FLAGS, WCS-WAVE tail). Verified
bit-identical (image, flags, variance, celestial and spectral WCS) to the IRSA cutout
service for DR1 `2025W46_1A_0076_2` D6; the cutout service is the automatic fallback.
Disk cache `server/outputs/prism-cache` (`PRISM_CACHE_DIR`, `PRISM_CACHE_MAX_BYTES`,
default 1 GiB). IRSA SIA2 intermittently returns HTTP 502/503; queries are retried
with backoff.
