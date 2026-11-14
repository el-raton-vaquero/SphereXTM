# SPHEREx Time Machine — PRISM

**Cada cuadro de SPHEREx es de un color distinto.** PRISM separa el color del movimiento
y te dice si lo que se movió es conocido (Gaia DR3, SkyBoT), un artefacto (FLAGS de
SPHEREx) o algo sin explicar. Usa observaciones reales de SPHEREx (NASA/IPAC IRSA, DR1 +
QR3). Las predicciones de catálogo se etiquetan como predicciones, y nada sintético se
mezcla con datos reales. No afirma descubrimientos.

| Ruta | Qué es |
|---|---|
| `/` | Esfera celeste 3D: estrellas reales (BSC5), órbita de SPHEREx y barrido ilustrativo. Elige un objetivo y vuela a él. |
| `/prism` | Explorador: secuencia de cuadros reprojectados al norte, pad tiempo × λ, co-suma, diferencia a λ emparejada, gafas moleculares, cubo 3D, espectro por fotometría forzada y veredicto con evidencia. |
| `/classic` | Observatorio original (M101 real o simulación etiquetada). |

API v2 (FastAPI, `server/`): `/v2/targets`, `/v2/search` (+ `/v2/search/stream` SSE),
`/v2/gaia`, `/v2/skybot`, `/v2/spectrum` y `/v2/verdict`. Están descritas en
[docs/api-contract.md](docs/api-contract.md).

### Arranque rápido de PRISM

```sh
cd server && uv sync --locked && uv run --locked uvicorn spherex.api:app --port 8000
cd frontend && npm ci && npm run dev        # http://localhost:3000
```

Sin el servidor, el frontend muestra las instantáneas reales de los seis objetivos
(`frontend/public/snapshots`). Para regenerarlas:
`cd server && PYTHONUTF8=1 uv run --locked python scripts/precompute_snapshots.py`.
El despliegue (frontend en Vercel, backend en contenedor) está en
[docs/deploy.md](docs/deploy.md).

**Límites honestos:**
- Los movimientos esperados en DR1 son de ~0.5–1.4 px.
- Barnard, RW Aur y R Dra saturan: PRISM lo marca, no lo oculta.
- Las búsquedas en frío tardan ~20–50 s porque descargan datos reales.
- λ viene de WCS-WAVE (aproximado).
- La confianza del veredicto es heurística.
- El estado detallado está en [docs/current-state.md](docs/current-state.md).

---

## Observatorio clásico (M101)

Compare authentic infrared observations of M101 from two dates, or explore a
separate educational simulation. This application does not claim detection of
Planet X or confirmed moving objects.

- `frontend/`: Next.js / React, integrated SphereXTM visuals, blink, difference,
  curtain comparison, scientific provenance and educational tools.
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

Visit http://localhost:3000/classic?api=real for authentic M101 data or
http://localhost:3000/classic?api=mock for simulation. Real mode is the default. FITS
products are prepared locally and are not included in Git. Offline replay needs
an existing verified cache; errors never silently substitute simulation.

[Integration report](docs/frontend-integration.md) contains exact source commit,
migration decisions, testing commands, screenshots and limitations.
[API contract](docs/api-contract.md) and [scientific rules](docs/scientific-integrity.md)
describe the measured data and interpretation limits.
