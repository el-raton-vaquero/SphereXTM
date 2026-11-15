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
| `/` | 3D celestial sphere: real stars (BSC5), the SPHEREx orbit and an illustrative sweep. Pick a target and fly to it. |
| `/explore` | Explorer (formerly `/prism`, which redirects here with its query string): north-up reprojected frame sequence, time × λ pad, co-add, matched-λ difference, molecular goggles, 3D cube, forced-photometry spectrum and an evidence-based verdict. |
| `/sky` | Sky time machine: date + speed, trajectories, the sky of 700 years ago, VR (in progress; positions are computed). |
| `/symphony` | Star symphony: the 102 SPHEREx bands as music (in progress; an artistic mapping of real data). |
| `/look` | Look up: phone camera + orientation to find the SPHEREx view of where you point; on desktop, what is above you (in progress). |
| `/cosmos/cube` | Stand-alone spectral cube of real frames. |

`/classic` was removed; old `/classic` and `/cosmos` links redirect.

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
