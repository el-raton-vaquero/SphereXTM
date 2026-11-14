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

## M4.5 — Datasets científicos preparados (2026-11-14)

Se preservan `/frames` (M101 y sus parámetros) y `/health` (`m101_cached`).
Los endpoints nuevos no realizan búsquedas, descargas ni alineación por petición:

- `GET /datasets`: array de `DatasetModel` con `id`, `name`, `description`,
  `classification` (`reference`, `exploratory`, `instrumental_limit`),
  `classificationLabel`, `detector`, `ra`, `dec`, `fovArcmin`,
  `observationIds`, `warnings`, `available`, `status` (`prepared`/`unavailable`)
  y `reason` nullable. Incluye los casos no preparados; HTTP 200 no afirma que
  todas sus imágenes estén disponibles.
- `GET /datasets/{id}/frames`: `FramesResponse` compatible, más `dataset`
  (la entrada anterior) y `catalogPredictions` opcional. IDs:
  `m101`, `wise0855-d6`, `barnard-d2`, `barnard-d6`.
- ID desconocido: **404**. Caso conocido sin archivos verificados o con
  discrepancia de identidad/checksum/WCS/máscaras: **503**, sin frames sintéticos.
- El frontend consume `/api/datasets*` por el rewrite existente. `?api=real&dataset=<id>`
  selecciona explícitamente un caso y permite compartirlo.

`catalogPredictions` nunca se transmite como `movingTargetPixel`. Tiene:

```text
kind: "catalog_predicted"
motionMeasured: false
reference, references[], astrometry, limitations[]
displacementArcsec: desplazamiento de catálogo entre las dos épocas, no medido
positions[]:
  obsId, epochIndex, mjd, date        # corresponden a ese frame
  ra, dec                          # posición ICRS aproximada propagada
  x, y                             # centro de píxel cero-based; pantalla Norte arriba
  inBounds, commonMaskValid, nativeValid, nativeFlagNames[]
```

Se usa el WCS TAN completo del FITS alineado, incluyendo el cambio de origen:
`y_screen = height - 1 - y_fits`. Para un SVG cuyo borde de celda comienza en cero,
la marca se dibuja en `(x+0.5,y+0.5)`. Cada imagen muestra solo la predicción de
su época; diferencia/apilado pueden mostrar ambas, sin trayectoria medida.
Las marcas no cambian `validMask`; una posición predicha sobre máscara sigue
siendo inválida.

Extensión WCS aditiva: `screenCrpix?: [x,y] | null` indica la referencia exacta de
centros cero-based después de `flipud`. Los endpoints de datasets la proporcionan;
`crpix` heredado no cambia. Los clientes nuevos usan `screenCrpix ?? crpix`, y los
clientes antiguos pueden ignorar la extensión. Los metadatos de cada frame M4
añaden `source_sha256`, `retrieved_utc` y `predicted_local`; la procedencia del
conjunto añade `dataset_id`, colecciones efectivas y `motion_measured:false`.

Las máscaras siguen siendo binarias y compartidas, filas Norte arriba, valores
inválidos cero en JSON, estadísticos solo sobre valores válidos. Fechas FITS sin
sufijo `Z` se interpretan como UTC explícitamente, nunca como hora local.
Detalles de preparación/evidencia: `docs/m45-scientific-cases.md`.
