# Project current state

**Snapshot date:** 2026-11-13 UTC (session started with stated date 2026-11-12).

**Source:** `JorgeLR0610/SphereX_SpaceApps`, branch `ux-redesign` based on `milestone3` (`2d70739`). Earlier milestone notes below retain historical evidence.

**Verification level:** source inspection, installed/locked Python dependencies, offline tests, live IRSA queries/downloads, FITS inspection, rendered comparison, verified FastAPI endpoints (`/health` and `GET /frames`), Next.js `/api/*` rewrite proxy, Turbopack build/lint, and authentic headless Chromium E2E browser testing verifying real SPHEREx QR3 M101 observation playback and synthetic demo mode.

## Project goal
NASA Space Apps Challenge 2026, challenge *Planet X and SPHEREx*: help people explore SPHEREx infrared sky observations over time and visually identify interesting apparent changes/moving objects. The MVP should compare genuine SPHEREx observations in one sky region, on different dates, ideally using comparable spectral bands, with clear provenance. Discovery of a new planet is neither assumed nor required for the proposed engineering plan.

## Repository layout — observed
- `frontend/SPHEREx Time Machine (versión simplificada).html` — separate standalone simulated demo.
- `frontend/` — Next.js application (package lists `next@16.4.6`, React `19.3.0`, TypeScript).
- `frontend/app/page.tsx`, `components/*` — rich viewer, header/search, temporal controls, frame viewer, spectra, guided tour, map/context, etc.
- `frontend/store/useSpherexStore.ts` — UI state, frame fetch, spectrum fetch, modes, selection and playback.
- `frontend/lib/mockData.ts` — **synthetic** epochs/frames/pixel data and spectral values.
- `frontend/lib/apiAdapter.ts` — `MockSpherexAPI` (default) and `RealSpherexAPI` (HTTP client).
- `frontend/lib/types.ts` — shared frontend types and request/response structures.
- `frontend/lib/coneSearch.ts` — mocked local catalog and additional cone-search logic; review before claiming a real catalog result.
- `frontend/AGENTS.md` — existing Next.js generated agent rules. Preserve it.
- `frontend/README.md` — mostly create-next-app starter text.
- `server/` — scientific service package (`server/spherex/`) and FastAPI application (`spherex.api:app`).
- `server/spherex/` — modular packages for `archive`, `fits`, `alignment`, `models`, `service`, `prepare`, and `api`.
- `server/scripts/validate_irsa.py`, `server/tests/` — standalone CLI (delegating to `spherex.*`), 44 automated tests across `test_data_validation.py`, `test_modules.py`, and `test_api.py`.
- `docs/data-validation.md` — executed queries, real FITS provenance, accepted
  M101 pair, negative WISE-field result, method and limitations.
- `docs/assets/m1-m101-comparison.png` — small measured-data comparison; bulk FITS,
  downloaded caches and generated local outputs are ignored, not committed.

## Behavior confirmed by reading source
- `NEXT_PUBLIC_USE_REAL_API=true` switches the adapter from mock to HTTP mode; when unset, the frontend now opens real M101. Explicit `false` opens synthetic data; URL `api=real` / `api=mock` overrides the environment.
- Real API client defaults to relative base `/api`, requesting `GET /api/frames?ra=...&dec=...&fov=...` and `GET /api/spectrum?ra=...&dec=...&fov=...&x=...&y=...`.
- Mock frames currently mimic **four epochs x six detectors** (24 frames), with fake observation dates (including future 2026-12), moving objects, wavelengths, flags, and noise. These are demonstration outputs, **not SPHEREx measurements**.
- `Frame.pixelData` is a browser `Float32Array`; raw JSON array conversion is required for a simple HTTP contract.
- The WCS TypeScript type is simplified (`crpix`, `crval`, scalar `cdelt`, `size`). Real FITS WCS may require rotation/projection and reprojection onto a common output grid.
- Real M101 integration has been browser-verified; this is a visualization comparison, not validated photometry or motion detection.
- Cone search has a SIMBAD HTTP branch and automatic mock fallback; it is not
  SPHEREx observation discovery. Its live operation was not tested in this task.

## M1 behavior verified by execution
- Official current releases are DR1 + QR3. SIA2 discovery and IBE cutout downloads
  work; QR2 is superseded. Spectral wavelength varies within each detector.
- WISE candidate field (RA 133.7951°, Dec −7.2451°): DR1 258 rows, QR3 zero,
  45 detector-6 candidates. A 24-product sample yielded a closely wavelength-
  matched 370.396-day pair, but only 78.667% common valid coverage after padded
  download/reprojection, below the unchanged 80% acceptance threshold.
- M101 (RA 210.80227°, Dec 54.34895°): DR1 249 rows, QR3 130, 84 detector-2
  candidates. A 24-product sample yielded QR3 observations `2026W20_2A_0464_3`
  and `2026W26_1A_0500_1`, **37.681 days apart**, at approximate local wavelengths
  **1.489543 / 1.489986 µm**. Their 30×30 common-grid comparison retained
  **85.444%** valid, wavelength-matched pixels and was visually inspected.
- `DATE-OBS`/`MJD-OBS` are checked against discovery metadata; `DATE` is HDU
  creation time. Celestial TAN-SIP WCS is preserved; spectral WCS uses its lookup
  table without SIP. Quality flags, variance, ZODI, ePSF and units were inspected.
- `uv sync --locked` passed; `uv run --locked pytest -q` passed **25 tests**, no warnings.
  M101 live execution and cached replay returned exit 0; WISE runs returned
  explicit negative status (exit 2). Transient cutout HTTP 503s were recorded and
  recovered on a later run. No synthetic archive fallback was used.
- A subsequent live request failed with `Network is unreachable`. Explicit
  `--offline` replay of saved responses/hash-verified real cutouts reproduced
  both results. This mode is labelled and never silently substitutes data.
  Completed-run manifests are retained alongside the latest result.
- This establishes a **visualization-level** real-data comparison, not precision
  spectral equivalence, photometry, object identification, motion or discovery.

## Known gaps / integration risks
1. Precision quantitative processing remains unvalidated: current wavelength
   matching uses approximate visualization WCS-WAVE, not calibrated CWAVE/CBAND.
2. No validated moving-object detection/showcase. M101 demonstrates a matched
   static field; the initial WISE field did not pass the chosen coverage threshold.
3. Resolved in M2/M3: FastAPI and Next.js `/api/*` rewrite are implemented.
4. Resolved in M2/M3: real responses deserialize to typed frontend pixel buffers.
5. No validated spectrum extraction. A plotted synthetic spectrum must not be presented as observed data.
6. Epoch count, detector count, spatial resolution and coverage cannot be hardcoded from the mock when using real products.
7. Scientific noise, masks/quality flags, FITS units, WCS transforms and alignment require explicit handling.
8. Real-data latency, offline fallback, file sizes and request failure states require UI treatment.
9. Backend tests and local full-stack browser checks exist; a publicly deployed demo remains unverified.
10. A separate FITS-data redistribution license was not established; the official
    acknowledgement is documented. Do not assume the documentation site's BSD
    license applies to data. No bulk FITS data are included.

Installed locally for M1: Python 3.14.10 / uv 0.13.5, Astropy 8.0.2, NumPy 2.5.4,
Matplotlib 3.11.2, Reproject 0.21.0 and pytest 9.2.0 in `server/.venv`. Frontend
`node_modules` was absent during M1; installed Next.js 16.4.6 dependencies are present during M3.5.

## Decisions agreed / proposed
- **Agreed in discussion:** move toward a monorepo; preserve existing Next.js frontend, add independent scientific backend.
- **Partially implemented:** Python + Astropy + NumPy + Reproject feasibility
  script, using direct bounded SIA2 HTTP queries. FastAPI and service modules
  remain M2; PyVO/astroquery are not needed by the current spike.
- **Recommended:** real image acquisition and validation first, API and frontend integration second, real spectrum and automated detection only if time remains.
- **Non-goal:** suggesting Planet X has been found; showing simulated or catalog-predicted motion without a visible label.

## Current milestone
**M0: Frontend simulation prototype exists. M1: Real-data visualization feasibility
established for M101; WISE-field negative result documented. M2: Minimal scientific
API implemented and verified with FastAPI (`/health` and `GET /frames`). M3: Full Next.js ↔ FastAPI integration COMPLETED and VERIFIED. 47 backend tests pass; frontend lints cleanly; Next.js builds successfully; headless Chromium E2E browser tests pass with authentic screenshots captured.**

Next work is M4 (Scientific Polish & Honest Moving Target Demonstration) and M5 (Calibrated WCS/Wavelengths & Real Spectral Extraction).
See `docs/data-validation.md` and `server/README.md` for exact tested commands.

## M3.5 — Simplified observatory (2026-11-13)

Implemented on `ux-redesign`: real M101 by default, concise Spanish purpose,
large central viewer, primary blink/date/difference controls, three-step inline
guide, contextual scientific limitations and progressive disclosure. Unsupported
real tools are hidden and synthetic experiences remain explicitly separate.
API schemas, scientific backend and M1/M2 processing are unchanged.

Frontend lint passes with one existing font warning; production build passes.
All 47 backend tests pass (one Starlette deprecation warning). Chromium CDP
checks verify real/synthetic playback, difference, advanced tools, export,
keyboard help, unavailable region and synthetic embed; desktop/mobile screenshots
are in `docs/assets/ux-*.png`. See `docs/ux-redesign.md` for exact commands,
limitations and evidence. No visitor usability study or discovery claim.

## SphereXTM integration — 2026-11-14

On `merge-repos`, baseline `f6d1204`, selectively integrated SphereXTM source
`1c8b3486d8893c7438ffaa3545b4f60a018735c3`. One store, data loader and masked pixel
pipeline serve the updated graphite/orange observatory, dynamic curtain, exports
and independent educational experience. Interactive synthetic spectra and cone
chart are available in advanced tools. No scientific backend or schema changes.

Dependency installation, TypeScript, lint (one font warning), production build,
47 backend tests, new pixel/cache/race tests and authentic Chromium desktop/mobile
checks executed successfully. Both direct/proxied health and M101 endpoints return
real cached data. See `docs/frontend-integration.md` for attribution, commands,
captures and limits, including partial English coverage and unverified live
catalog services. Earlier milestone sections are historical snapshots.

### Fidelidad al frontend de pruebaSpaceApps

La interfaz adopta ahora la distribución del frontend fuente: cabecera compacta,
visor y controles a la izquierda, ficha con métricas/desplegables a la derecha,
y apilado móvil. La portada no tiene el botón provisional externo; incluye M101
real y ejemplos explícitamente simulados. M101 real sigue abriendo por defecto.
Cortina se puede arrastrar o mover por teclado. Se preservan backend, contrato,
máscaras, épocas disponibles y procedencia científica.

TypeScript, lint/build, 47 pruebas backend y pruebas frontend pasan. Se realizó
comparación Chromium con ambos frontends ejecutados y capturas de escritorio/móvil.
Ver `docs/frontend-integration.md`, sección de fidelidad visual, y
`docs/assets/reference-layout-*.png` / `original-reference-*.png`.

## Resolución de merge en Main — 2026-11-14

Se combinaron `1c8b348` y `201c2f5` resolviendo los 13 conflictos del traslado
`spherexproto/` → `frontend/`. Se conserva diseño original, backend científico,
estado/renderizado compartidos, máscaras, traducciones y separación de orígenes.
Los metadatos educativos y su CLI se trasladan a frontend; el diagnóstico cónico
heredado queda archivado fuera de rutas públicas. El CSS se regeneró.

Ver `docs/merge-resolution.md` para decisiones y evidencia: instalación de
dependencias, lint/TypeScript/build, pruebas frontend, CLI aislado, 47 pruebas
backend con caché auténtica externa y Chromium real/mock escritorio/móvil.
Este clon no incluye los FITS: sin SPHEREX_DATA_DIR o preparación local, los
endpoints reales retornan indisponibilidad y tres pruebas de dataset fallan.
El merge queda resuelto en el índice, pendiente del commit del usuario.

## Docker Compose — 2026-11-14

Implementado arranque de producción con `docker compose up -d`: preparación
M101 automática, FastAPI y Next.js standalone. La caché usa volumen nombrado;
FastAPI lo monta en solo lectura, el proxy interno usa `backend:8000`, y solo se
publica el frontend :3000 (configurable con FRONTEND_PORT). Los servicios usan
UID/GID 10001. Los locks científicos y el contrato JSON no cambiaron.

Verificado realmente tras activar Docker: construcción de imágenes, primera
adquisición real en volumen vacío, healthchecks, dos frames M101 por el proxy,
fallos controlados sin fallback, persistencia por hashes tras restart/down/up y
Chromium E2E real/mock escritorio/móvil. Data-init reutiliza caché válida y termina
en 0; un fallo de preparación bloquea los servidores dependientes. Pruebas locales:
lint/TypeScript/frontend y 47 científicas pasan con las advertencias existentes.

Ver `docs/docker.md` para comandos, evidencia, respaldo y límites. Capturas en
`docs/assets/docker-*.png`. No se incorporaron FITS ni cachés al repositorio.

## M4 — Target feasibility research — 2026-11-14

Implemented the approved scientific research slice in `server/spherex/research.py`,
`targets.py` and the referenced `data/m4-targets.json` registry. This supersedes
prior speculative M4 overlay/UI scope for this delivery. Frontend, HTTP contract,
M101 processing/service, dependency locks and Docker startup are unchanged.

Executed bounded DR1/QR3 queries and real FITS inspection for Barnard and WISE
0855, plus the optional Lalande 21185 sample after verifying its Gaia row.
Epsilon Indi B is explicitly blocked: required 2MASS position/epoch lookup
returned HTTP 502; no assumed position was sent to SIA2. Luhman 16 was not selected.

Five field pairs pass the unchanged >=30 day, >=80% common spectral coverage,
<=0.25 bandwidth offset and <=1.2 bandwidth ratio thresholds. This is **not a
validated moving-target demonstration**: Barnard's predicted positions have
OVERFLOW/BLOOM flags (D2 also SUR_ERROR); WISE D6 has valid pixels and predicted
8.204 arcsec displacement, but weak exploratory contrast/native sigma (~1.39,
1.11), with source identity/confusion unvalidated. WISE D5 displacements are
<0.1 PSF FWHM. Lalande has no passing pair in its 12-product sample and invalid
predicted native pixels in all 11 inspected products.

The final samples attempted 108 products, inspected 93, and recorded 15 download
failures. Campaign status remains incomplete, not archive absence. The separate
M4 cache retains 95 products / 379,759,680 bytes, including two from an interrupted
initial alternative invocation; budget accounting includes them. A process lock
now prevents simultaneous campaigns in one output directory. All five accepted
pair IDs, matched fractions and predicted displacements reproduced exactly in
explicit hash-verified offline replay. Per-run manifests retain live errors;
latest offline runs transparently report unavailable cached products.

67 scientific tests pass (20 new M4 tests), with the existing Starlette/httpx
warning. M101 was prepared with its unchanged CLI; its real `/frames` response
is HTTP 200 with the original QR3 pair and 769/900 valid pixels. No frontend or
Docker checks were rerun for this science-only change. See
`docs/m4-target-feasibility.md`, `docs/m4-evidence-live.json`,
`docs/m4-evidence.json` and the scientific README for commands, exact queries,
IDs, astrometry, figures, limitations and proposed future dataset registry.
FITS/cache outputs remain ignored and no new endpoints were added.

## PRISM backend-live — 2026-11-14

New `server/spherex/live.py`, `v2.py`, `targets_v2.py`, `filelock.py`,
`scripts/precompute_snapshots.py`; router mounted in `spherex.api` (`/frames`
unchanged). Contract: `docs/api-contract.md` → "PRISM v2". `research.py` now uses a
cross-platform lock (msvcrt/flock), so `tests/test_research.py` runs on Windows.

Live `/v2/search` works for any RA/Dec: SIA2 (DR1+QR3, retried) → byte-range reads on
the public AWS mirror (bit-identical to an IRSA cutout for one verified D6 product;
~1.6 MB per frame vs ~4 MB cutouts) → north-up TAN grid. Measured over HTTP: M31,
60 frames, fov 4′, cold 27.0 s; repeat 1.2 s from disk cache. SSE stream verified.
Presets resolved from Gaia DR3 / SIMBAD (CDS host 404 → Harvard mirror) and propagated
to MJD 61000. `/v2/gaia|skybot|spectrum|verdict` answer 501 until providers register.

Snapshots generated live (`frontend/public/snapshots`, 160 frames each, fov 4′,
n=39, ~2.8 MB, all six detectors, 0 failed frames): Barnard 3 seasons (160/160
saturated at centre), eps Ind B 4 seasons (1 saturated), WISE 0855 3 seasons (0),
RW Aur 3 (152), R Dra 3 (159), M101 3 (0). Saturation is reported, not hidden.
Full pytest: 104 passed (M101 dataset prepared locally with `spherex.prepare`).
Known Windows issue outside this workstream: `scripts/validate_irsa.py` prints "λ",
which raises UnicodeEncodeError on a cp1252 console and records a spurious rejection
(the observation is still kept); run with `PYTHONUTF8=1`.

## PRISM integration — 2026-11-14

Branch `prism` now contains backend-live, science, explorer-ui and cosmos-3d (merged with
`--no-ff`). The only conflict was in `frontend/public/snapshots/*`. Those files were then
regenerated with the integrated pipeline.

**Routes.** `/` is the 3D landing (real BSC5 stars, SPHEREx orbit, sweep pattern labelled
illustrative). `/prism` is the explorer. `/classic` is the previous observatory (its
links and embed URLs were updated). `/cosmos` redirects to `/`, and `/cosmos/cube` is
the cube demo. Fonts are loaded once in `app/layout.tsx` via `next/font`.

**Backend wiring.** `server/spherex/v2_providers.py` registers the science handlers
(`spherex.science.routes`) as the `/v2/gaia|skybot|spectrum|verdict` providers. It feeds
them native-pixel frames from `spherex.live`: S3 byte ranges, with the IRSA cutout
service as fallback. The ePSF comes from one ~8.7 kB EPSF table row, so frames without
it report an uncorrected aperture flux and say so. Spectrum and verdict share one
memoised download per position (80 frames, 21×21 native px), and concurrent requests
wait on it. The Next proxy timeout is 180 s.

**Measured end-to-end through the Next proxy** (WISE 0855, `next start` + uvicorn):
- `/api/v2/search`, 60 frames: 200 in 22 s, 3 seasons, D1–D6.
- `/api/v2/spectrum` and `/api/v2/verdict` sent concurrently: both 200 after ~47–49 s.
  80/80 frames loaded, 67 with ePSF. Best template Y1 (χ²ᵣ 1.15; the coldest available,
  and WISE 0855 is colder). Verdict known_star, confidence 0.8 (heuristic).
- `/api/v2/gaia`: 26 sources. `/api/v2/skybot`: 0 objects, 0 failed epochs.

**Snapshots** (`frontend/public/snapshots`, live IRSA + Gaia + SkyBoT, fov 4′, 160 frames
each, 0 failed frames, 3.0–3.4 MB each). Each file is `{kind:'prism-snapshot', search,
gaia, spectrum, verdict}`.

| Target | Frames used / available | Seasons | Saturated at centre | Verdict |
|---|---|---|---|---|
| Barnard | 160/358 | 3 | 160 | known_star 0.75 (saturated 80/80; no classification) |
| Eps Ind B | 160/463 | 4 | 1 | variable 0.9 (see below) |
| WISE 0855 | 160/258 | 3 | 0 | known_star 0.8 |
| RW Aur | 160/335 | 3 | 152 | known_star 0.65 |
| R Dra | 160/540 | 3 | 159 | known_star 0.75 (0 usable flux points) |
| M101 | 160/376 | 3 | 0 | known_star 0.45 (see below) |

Notes on the table:
- **Eps Ind B:** measured shift 6.34″ against 6.31″ predicted (consistent within 3σ). The
  ~6% inter-season flux change is flagged as "variable", but it may be systematic: 17/79
  frames are flagged HALO/TRANSIENT near ε Indi A, and T6.5 is the best template at a poor
  χ²ᵣ of 129 (the target is an unresolved T1+T6 binary).
- **M101:** the Gaia DR3 counterpart on the nucleus has no significant parallax or proper
  motion. The verdict now lowers confidence and says the source may be extragalactic.

**Static hosting.** On Vercel without a backend (`VERCEL` set, no
`SPHEREX_API_INTERNAL_URL` / `NEXT_PUBLIC_PRISM_API_BASE`), the build has no `/api` proxy
and `NEXT_PUBLIC_PRISM_LIVE=0`. The six presets load from the snapshots, labelled as
snapshots. Any other position shows "La búsqueda en vivo necesita el servidor
científico". This was verified with headless Chrome and showed no exceptions. See
`docs/deploy.md`.

**Checks.**
- Backend `uv run --locked pytest -q`: 151 passed.
- Frontend `npm run lint`: 0 problems. `tsc --noEmit`: clean. `npm run build`: passed.

**Known limitations.**
- Cold spectrum/verdict take ~40–50 s, which is over the 30 s goal.
- λ comes from WCS-WAVE, not calibrated CWAVE. There is no PSF homogenisation and no ZODI
  subtraction.
- Classifier templates go no colder than Y1 and no warmer than T6.5 for brown dwarfs.
  Stars are blackbodies and the asteroid model is a toy.
- The verdict confidence is a heuristic.
- SkyBoT samples at most 12 epochs.
- The 3D sweep is illustrative.
- `/classic` "real" mode needs the backend and the M101 dataset.
- The C: drive has only ~2–3 GB free.

## PRISM review fixes — 2026-11-14

Fixes after the browser-QA, science and design reviews (branch `prism`, not pushed).

**Backend.**
- `/v2/search/stream` sends a named `progress` event at once and `Cache-Control: no-cache,
  no-transform` + `Content-Encoding: identity`; through the Next proxy events now arrive
  incrementally (first at ~1.8 s) instead of all at the end.
- Identical concurrent searches share one download (`v2.shared_search`), so the plain
  `/search` fallback never doubles the work.
- `/v2/spectrum` and `/v2/verdict` run on a 2-slot executor separate from search; a request
  whose client disconnects while queued is dropped; finished results are memoised.
- Classifier: no best fit unless >= 6 points at S/N >= 3 on >= 3 detectors
  (`classification.best = null`, `detected: false`, caveat "not significantly detected").
  Fits, variability and band depths use one flux scale (EPSF-corrected points when any exist).
- Verdict: `known_star` / `variable` only when SPHEREx sees the source (clean detections in
  >= 10% of frames, or a motion consistent with the catalogue) near the propagated position.
  Otherwise `inconclusive` with the counterpart as context. Confidence drops for artifacts,
  few detections, few matched pairs and chi2_red > 10; `tentative` marks weak variability.
  A measured motion consistent with a >= 1 px prediction counts as stellar evidence.
- Band depths outside [-1, 1] or < 3 sigma are `not_significant`; 3% systematic added.

**Snapshots** recomputed with `precompute_snapshots.py --extras-only` (same frames):
Eps Indi B `variable` (tentative, 0.5; moved 6.34″ vs 6.31″ predicted); Barnard, WISE 0855,
RW Aur, R Dra and M101 `inconclusive` 0.3 ("catalogued here, but SPHEREx does not confirm
it": saturated, or too few clean detections).

**Frontend.**
- Presets render their real snapshot at once (2.5–12 s in headless Chrome, was 30–96 s);
  "Consultar en vivo" queries live on demand. Arbitrary positions go live (Orion: 20 s).
- Matched-λ blink anchored to the chosen λ; 0%-valid frames skipped.
- Spectrum: "sin detección" state, empty state when < 6 usable points (raw points behind a
  toggle), template labels in the ranking, uncorrected-aperture points faded, client
  estimate flags saturation over the whole aperture (OVERFLOW/NONLINEAR/BLOOM).
- Verdict: Spanish check labels and `summary_es` (details stay English, said so), label
  "Fuente catalogada / Known catalogued source", elapsed-time loading state.
- Headline "se movió X″ ± σ · predicho Y″" from browser centroids on co-adds (labelled; orange
  only when >= 3σ and within 2σ of the prediction). Faint movers open in co-add.
- Gaia rings default to G < 17 or < 60″ (toggle "todas"); probe requests debounced.
- Keyboard: sky image focusable (arrows move the probe, Esc resets), scrub pad is a slider.
- `--p-ink-3` → #8f8a81 (AA); ticks use `--p-tick`. Greek letters keep their case.
- `/classic` links hidden without the science server; without the proxy `/classic` uses its
  labelled simulation mode. Landing Sesame queries mirrors in parallel (8 s).

**Checks.** `uv run --locked pytest -q`: 156 passed. `npm run lint`: clean. `npm run build`:
passed. Headless Chrome (live build and `VERCEL=1` build): no JS exceptions, no horizontal
scroll at 390 px. Key screenshots in `docs/assets/prism-*.png`.

**Still open.** Cold spectrum/verdict ~45–70 s. The browser headline (WISE 0855: 7.65″ ± 1.56″
vs 8.07″) and the backend verdict (WISE 0855 inconclusive: backend season centroids usable in
only 1 season) use different methods and can disagree; both are labelled. Verdict details are
English only. Static-mode preset blurbs come from `lib/prism/presets.ts`, not `/v2/targets`.

## StarChord foundation — 2026-11-14 (branch `prism`)

The product is renamed **PRISM → StarChord** (user-visible strings, metadata, docs, API
title; env vars `NEXT_PUBLIC_PRISM_API_BASE` / `PRISM_*` and internal identifiers such as
`lib/prism/`, `components/prism/`, `.prism-root` are unchanged for deploy compatibility).

**Routes.** `/` 3D landing · `/explore` explorer (moved from `app/prism`; `/prism`,
`/prism/*` → `/explore` keeping the query; `/classic` → `/explore`; `/cosmos` → `/`, all
in `next.config.ts` `redirects()`) · `/sky`, `/symphony`, `/look` placeholder pages
(`components/site/ComingSoon.tsx`) for the feature work · `/cosmos/cube`.
`/classic` and everything only it used (store, mock data, render engine, cone search,
Tailwind build, standalone HTML demo, classic scripts/diagnostics) are deleted.

**i18n.** One module, `frontend/lib/i18n/` (`en.ts` default, `es.ts` typed against it,
`index.ts` with `useLocale()` → `{ locale, t, setLocale, toggleLocale }`, `withLang()`,
`pickLocalized()`). Locale: `?lang=` > localStorage `starchord.lang` > `en`. All component
strings go through it, including per-target texts (namespace `targets`).

**Backend language.** `/v2/verdict` and `/v2/spectrum` take `lang=en|es`
(`spherex/science/i18n.py`; fields only added, see `docs/api-contract.md`). Snapshots carry
the same `*_en/*_es` fields (`server/scripts/localize_snapshots.py`). Verdict details are
now Spanish too (the earlier "details stay English" limitation is resolved for every
template; unknown upstream error texts stay English and are marked `lang="en"`).

**Design.** Fonts Fraunces (display) / Figtree (body, 15px base) / JetBrains Mono (data)
via `next/font/google`; type-scale tokens `--p-fs-*` in `app/prism-tokens.css`; small
labels ≥ 11.5px. Brand slot `components/brand/BrandMark.tsx` (text wordmark;
`BRAND_HAS_LOGO` flips to `public/brand/logo.svg`), shared `SiteNav`/`SiteHeader`,
`app/icon.svg` placeholder favicon. `astronomy-engine` (MIT) added for computed
ephemerides.

**Checks.** `npx tsc --noEmit` and `npm run lint` clean; `npm run build` passes (9 routes);
`uv run --locked pytest -q`: 163 passed (7 new i18n tests, incl. every saved snapshot
sentence). Headless Chrome on the production build: landing, `/explore` (EN and
`?lang=es`, real WISE 0855 snapshot with Spanish verdict details), `/sky` placeholder;
redirects return 307 with the query preserved.

## StarChord feature integration — 2026-11-15 (branch `prism`)

Merged (no conflicts) the five feature branches on top of the foundation: real-Earth landing
(`components/cosmos/*`, NASA SVS textures in `public/cosmos/`), `/sky` time machine
(`components/sky`, `lib/sky`, `public/sky/`), `/symphony` (`components/symphony`, `lib/symphony`),
`/explore` redesign (`components/prism/*`, `lib/prism/probeSpectrum.ts`) and `/look`
(`components/look`, `lib/look`). Provenance lives in each `public/<dir>/README.md` and
`components/look/README.md`. Wiring done by the integrator:
- `<SymphonyDock>` is mounted in the explorer's Listen tab (`components/symphony/ExploreSymphony.tsx`,
  real SPHEREx probe spectrum, saturated points dropped, provenance `spherex`) and in the /sky side
  panel (`components/symphony/SkySymphony.tsx`, visible-sky colour approximation, provenance
  `computed`, retuned at most ~1/s).
- `/sky` honours `?epoch=<preset id>`, `?epoch=<year>` (the year of "700 years ago" maps to that
  preset; other years open the same calendar day at night) and `?date=YYYY-MM-DD[THH:MM]`
  (approximate local time; night if no time given). `/symphony` links to `/sky?epoch=1326`.
- Landing: "Four ways in" entry list (right column on wide screens, 2×2 in the panel on phones).
- Verified: `uv run --locked pytest -q` (163 passed), lint, tsc, `test:symphony` 16/16, static
  Vercel build (`VERCEL=1`, `NEXT_PUBLIC_PRISM_API_BASE` set): `/prism?…` → 307 `/explore?…`
  keeping the query, `/classic` → `/explore`, snapshots served; /sky dock shows "Visible sky ·
  1326-11-15 UTC · 556 stars" as computed; /explore Listen dock shows M101 as real SPHEREx.
