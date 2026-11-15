# Deploying PRISM

PRISM has two parts:

| Part | Path | What it needs |
|---|---|---|
| Frontend (Next.js 16) | `frontend/` | Any Next.js host. Vercel works with no extra config. |
| Science server (FastAPI) | `server/` | A long-running Python 3.14 process with outbound HTTPS to IRSA, AWS S3 (`nasa-irsa-spherex`), Gaia TAP (ESA) and SkyBoT (IMCCE), plus a writable cache directory (~1 GiB). |

The frontend works **without** the science server. In that case it serves only the six
real cached snapshots in `frontend/public/snapshots/`, labelled as cached snapshots.
Searching any other position shows the message "La búsqueda en vivo necesita el
servidor científico" / "Live search needs the science server". Nothing synthetic
replaces the missing live data.

## 1. Frontend on Vercel

1. Import the GitHub repository in Vercel (New Project → Import Git Repository).
2. Set **Root Directory** to `frontend`. Vercel then detects Next.js. The default build
   command (`npm run build`, which runs `build-css.js` and then `next build`) and the
   default install command (`npm ci`) are correct.
3. Environment variables are optional:

| Variable | Effect |
|---|---|
| *(none)* | Static mode: snapshots only, no `/api` proxy, live search shows the "needs the science server" message. |
| `SPHEREX_API_INTERNAL_URL=https://<backend>` | Next proxies `/api/*` to the backend, so the browser calls `/api/v2/...` on the same origin. |
| `NEXT_PUBLIC_PRISM_API_BASE=https://<backend>/v2` | The browser calls the backend directly. The backend already sends `Access-Control-Allow-Origin: *`. Use this if proxied server-sent events (`/v2/search/stream`) are buffered or time out. |
| `NEXT_PUBLIC_PRISM_LIVE=0` or `1` | Forces live mode off or on, overriding the automatic choice. |

`next.config.ts` decides at build time. Live mode is on when either backend variable is
set, or when the build is not on Vercel (local `npm run dev` and `npm start` proxy to
`http://127.0.0.1:8000`). After changing any variable, redeploy so it takes effect.

**CI/CD.** With the Git integration, Vercel builds a preview deployment for every push
or pull request and deploys `main` (or the production branch you choose) to
production. No `vercel.json` is needed, because the root directory is a project setting.

**CLI alternative**, from `frontend/`:

```sh
npx vercel@latest link        # once; choose the project, root = this folder
npx vercel@latest             # preview deployment
npx vercel@latest --prod      # production deployment
npx vercel@latest git connect # connect the GitHub repository for automatic deploys
```

What runs where on Vercel: `/`, `/sky`, `/symphony`, `/look` and `/cosmos/cube` are
static. `/explore` is rendered on demand. `/prism` (→ `/explore`, query string kept),
`/classic` (→ `/explore`) and `/cosmos` (→ `/`) are redirects from `next.config.ts`. The snapshots (~3–3.5 MB each, ~20 MB in total) are
static files.

## 2. Science server

The image is `server/Dockerfile`, the same one `compose.yaml` uses. Anything that runs a
container with a public HTTPS URL works, for example Render, Fly.io, Railway, Google
Cloud Run or a Hugging Face Docker Space. Requirements:

- Port 8000. The command is `python -m uvicorn spherex.api:app --host 0.0.0.0 --port 8000`.
- A writable cache directory. The image sets `PRISM_CACHE_DIR=/tmp/prism-cache` and
  `PRISM_SCIENCE_CACHE=/tmp/prism-science-cache`. Optional tuning:
  `PRISM_CACHE_MAX_BYTES` (default 1 GiB), `PRISM_WORKERS` (default 8) and
  `PRISM_DEADLINE_SECONDS` (default 150).
- Long requests. A cold `/v2/search` with 60 frames took 27–28 s on the development
  connection. A cold `/v2/spectrum` with 80 frames took about 40 s, and `/v2/verdict`
  then took about 20 s because it reuses the frames already downloaded. Platforms with a
  30 s request limit will cut off cold requests, so choose one that allows at least
  120 s.
- The original `/frames` (classic M101) endpoint also needs the prepared M101 dataset
  (`python -m spherex.prepare --output /data/m101`, the `data-init` service in compose).
  PRISM's `/v2/*` routes do not need it.

Check the deployment:

```sh
curl https://<backend>/health
curl "https://<backend>/v2/targets"
curl "https://<backend>/v2/search?ra=133.760021&dec=-7.242203&fov=4&max_frames=20"
```

Then set `SPHEREX_API_INTERNAL_URL` (or `NEXT_PUBLIC_PRISM_API_BASE`) in Vercel and
redeploy the frontend.

## 3. Everything locally

```sh
cd server && uv run --locked uvicorn spherex.api:app --port 8000
cd frontend && npm ci && npm run build && npm start    # http://localhost:3000
```

Or run `docker compose up -d`, which starts the classic M101 dataset, the backend and
the frontend.

## Refreshing the snapshots

```sh
cd server
PYTHONUTF8=1 uv run --locked python scripts/precompute_snapshots.py --fov 4 --max-frames 160
```

This fetches live data from IRSA, Gaia and SkyBoT, writes
`frontend/public/snapshots/<id>.json` and `index.json`, and keeps each file under 4 MB
by reducing the frame count if needed. Commit the new files and push, and Vercel
redeploys.

## Current production

The live demo runs on the tailnet server `central` (Docker backend behind a
Cloudflare tunnel at https://spaceapps.candymart.store) with the frontend on
Vercel (https://spherex-prism.vercel.app). Both auto-deploy from branch `prism`
through pull-based systemd timers; see [`deploy/central/README.md`](../deploy/central/README.md).
