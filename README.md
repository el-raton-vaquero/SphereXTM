# StarChord — SPHEREx, seen and heard

**Every SPHEREx frame is a different colour.** StarChord separates colour from motion and
tells you whether what moved is known (Gaia DR3, SkyBoT), an artifact (SPHEREx FLAGS) or
unexplained. It uses real SPHEREx observations (NASA/IPAC IRSA, DR1 + QR3). Catalogue
predictions are labelled as predictions; anything computed or modelled (ephemerides,
historical skies, phone pointing, sonification) is labelled as such; nothing synthetic is
mixed with real data. It makes no discovery claims. English is the default language;
a Spanish toggle is on every page.

| Route | What it is |
|---|---|
| `/` | Landing: a real Earth (NASA Blue Marble day map, city lights at night, an archival cloud layer, lit by the real Sun), the Moon, the SPHEREx orbit, 9 096 real bright stars (BSC5) and an illustrative survey sweep. Type a target or pick one and fly to it; "Four ways in" links to the four sections. |
| `/explore` | Explorer (formerly `/prism`, which redirects here keeping its query string): the series of real SPHEREx frames of any RA/Dec or named target played like a short film, co-add, matched-λ difference, molecule goggles, 3D cube, the real spectrum under a probe, the motion measured in your browser and the backend's evidence-based archive checks. A **Listen** tab plays that real spectrum. |
| `/sky` | Sky time machine (computed): choose a date (−3000 to 3000) and a speed (real time to 100 years/s), trajectories of the Sun, Moon and planets, epoch presets (700 years ago, the pyramids, SN 1054, Galileo, year 1, year 3000), phone motion, Cardboard stereo and WebXR headsets. Plays the colours of the visible stars as music. Links: `?epoch=ago700`, `?epoch=<year>`, `?date=YYYY-MM-DD[THH:MM]`, `?ra=&dec=` (turn towards a position), `?lat=&lon=`. |
| `/symphony` | Star symphony: pick a real SPHEREx field and move a circle over it; the spectrum inside the circle (102 bands, 0.75–5 µm) is played live. |
| `/look` | Look up: on a phone, the camera plus GPS and orientation sensors work out where you are pointing and show the real SPHEREx all-sky view of that patch (pointing labelled approximate); on a desktop, what is above you now (computed). |

`/classic` and the stand-alone `/cosmos/cube` demo were removed; `/classic`, `/cosmos` and
`/cosmos/cube` redirect.

### How the star symphony maps data to sound

The input is real: SPHEREx surface brightness measured in real frames (one wavelength per frame),
or, on `/sky`, a computed colour spectrum of the visible stars that is labelled "computed".
Everything after that is an **artistic mapping**, and the UI says so:

- The samples are grouped into **102 bands**: the six SPHEREx detectors (D1 0.75–1.09 µm …
  D6 4.42–5.00 µm), each split into 17 log-spaced steps. This is an approximation of the
  SPHEREx channels, used only to group samples into notes and never as calibration.
- Each band's wavelength sets its **pitch** (short → high, about four octaves), snapped to a
  **pentatonic scale**. A pentatonic scale has no semitone steps, so any combination of notes
  sounds consonant.
- Each band's normalised brightness sets its **volume** and **note length**. Bright bands ring
  longer and hold the beat; very faint bands become rests.
- The **colour** of the spectrum (D1–D2 against D5–D6) picks the key and the drone: blue and hot
  plays E major pentatonic, neutral plays D suspended, red and cold or dusty plays A minor pentatonic.
- Absorption features inside the range (H₂O ice ~3.0 µm, CO₂ 4.27 µm, CO 4.67 µm, CH₄ 3.3 µm,
  PAH 3.3 µm emission) change the timbre, so an icy region's spectrum makes its own melody.
- Moving the circle (or the probe in `/explore`, or the sky in `/sky`) changes the spectrum, and
  the music follows in real time. Saturated points are dropped.

The core is in `frontend/lib/symphony/core.ts` (pure, tested by `npm run test:symphony`).

### Scientific integrity

- SPHEREx pixels come only from IRSA (live, through the backend) or from the saved real
  snapshots in `frontend/public/snapshots/`. Nothing synthetic is ever shown as SPHEREx.
- Catalogue predictions (Gaia DR3, SIMBAD, SkyBoT) are labelled as predictions.
- Computed or modelled content is labelled in the UI. This covers the `/sky` positions
  (astronomy-engine ephemerides plus linear proper motion, approximate far from today), the
  `/look` pointing (from phone sensors, approximate), the "above me" chart, the landing sweep
  (illustrative) and the clouds (one archival field, not live weather). Every sonification is
  labelled "artistic mapping".
- Local time on `/sky` uses each city's real time zone from 1970 on (Mexico City is UTC−6). For
  earlier dates and custom coordinates it uses UTC + round(longitude / 15 h), because civil time
  zones did not exist then.
- See [docs/scientific-integrity.md](docs/scientific-integrity.md).

### Credits

- SPHEREx data: NASA/JPL-Caltech, served by NASA/IPAC IRSA (DR1, QR3). The SPHEREx all-sky HiPS
  on `/look` is courtesy NASA/JPL-Caltech, with the HiPS built by CDS, Strasbourg.
- Earth, Moon and Milky Way textures: NASA Goddard Scientific Visualization Studio (Blue Marble
  NG, Black Marble 2012, CGI Moon Kit/LRO, Deep Star Maps 2020 with Gaia DR2 by ESA/Gaia/DPAC).
  Details are in `frontend/public/cosmos/README.md`.
- Stars: Yale Bright Star Catalogue 5th ed. (Hoffleit & Warren 1991, CDS V/50), with proper
  motions from the CfA TDC copy. Constellation figures are from d3-celestial (Olaf Frohn,
  BSD-3). See `frontend/public/sky/README.md`.
- Ephemerides: astronomy-engine (Don Cross, MIT). Name resolution: CDS Sesame. Catalogues: Gaia
  DR3 (ESA), SIMBAD (CDS), SkyBoT (IMCCE).
- Fonts: Fraunces, Figtree and JetBrains Mono (SIL Open Font License), from Google Fonts.
- Logos: `frontend/public/brand/` is the slot for the official StarChord logos (see its README).

API v2 (FastAPI, `server/`): `/v2/targets`, `/v2/search` (+ `/v2/search/stream` SSE),
`/v2/gaia`, `/v2/skybot`, `/v2/spectrum` and `/v2/verdict` (both take `lang=en|es`).
They are described in [docs/api-contract.md](docs/api-contract.md).

### Quick start

```sh
cd server && uv sync --locked && uv run --locked uvicorn spherex.api:app --port 8000
cd frontend && npm ci && npm run dev        # http://localhost:3000
```

Without the server the frontend shows the real snapshots of the six targets
(`frontend/public/snapshots`). To regenerate them:
`cd server && PYTHONUTF8=1 uv run --locked python scripts/precompute_snapshots.py`, then
`uv run --locked python scripts/localize_snapshots.py` (adds the English/Spanish text).
Deployment (frontend on Vercel, backend in a container) is in [docs/deploy.md](docs/deploy.md).

Translations live in `frontend/lib/i18n/en.ts` and `es.ts` (`useLocale()` hook); brand
assets go in `frontend/public/brand/` (see its README).

**Honest limits:**
- Expected motions in DR1 are ~0.5–1.4 px.
- Barnard, RW Aur and R Dra saturate: StarChord flags it, it does not hide it.
- Cold searches take ~20–50 s because they download real data.
- λ comes from WCS-WAVE (approximate).
- The verdict confidence is a heuristic.
- The detailed status is in [docs/current-state.md](docs/current-state.md).

---

## Original M101 pipeline

The `/frames` endpoint still serves the original WCS-aligned M101 comparison (two real
QR3 observations 37.7 days apart) used by the early milestones; its browser view
(`/classic`) was retired in favour of `/explore`.

- `frontend/`: Next.js / React UI (explorer, 3D landing, new sections).
- `server/`: authoritative Python / FastAPI / Astropy scientific service.
- `docs/`: API contract, scientific limitations and verification evidence.

## Arranque con Docker

```sh
docker compose up -d
```

Abre http://localhost:3000. La primera ejecución prepara automáticamente las
observaciones reales de M101 y necesita internet. Los datos quedan en un volumen
persistente; no se incluyen en las imágenes. Si IRSA falla, el error es explícito
y no se sustituye por una simulación. `data-init` debe finalizar con código 0.

[Guía Docker](docs/docker.md): puertos, logs, reconstrucción, respaldo y recuperación.

## Desarrollo sin Docker

Start the scientific service:

```sh
cd server
uv sync --locked
uv run --locked python -m spherex.prepare --output outputs/m101
uv run --locked uvicorn spherex.api:app --host 127.0.0.1 --port 8000
```

Start the frontend in another terminal:

```sh
cd frontend
npm ci
npm run build
npm run start
```

Visit http://localhost:3000/explore. FITS products are prepared locally and are not
included in Git. Offline replay needs an existing verified cache; errors never silently
substitute simulation.

[Integration report](docs/frontend-integration.md) contains exact source commit,
migration decisions, testing commands, screenshots and limitations.
[API contract](docs/api-contract.md) and [scientific rules](docs/scientific-integrity.md)
describe the measured data and interpretation limits.
