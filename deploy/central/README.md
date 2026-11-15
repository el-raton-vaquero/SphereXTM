# Production on `central` (pull-based CD)

What runs the public demo:

| Piece | Where |
|---|---|
| Science API (FastAPI, Docker `spaceapps_backend`) | `central`, `127.0.0.1:8710` |
| Public URL | https://spaceapps.candymart.store via Cloudflare named tunnel (`spaceapps-tunnel.service`) |
| Frontend | Vercel project `listar` → https://listar-spherex.vercel.app (also listar-sky / listar-app / listar-xi .vercel.app); legacy project `spherex-prism` → https://spherex-prism.vercel.app, deployed on every push too |

## How a push becomes a deploy

Two systemd timers poll GitHub branch `prism` every 60 s:

- `spaceapps-deploy.timer` → `deploy.sh`: when the branch moves (or the container is down),
  builds `server/` (`--target runtime`), swaps the container, checks `/health`
  and rolls back to the previous image if it fails. Keeps the 3 newest images.
- `spaceapps-deploy-frontend.timer` → `deploy-frontend.sh`: runs
  `vercel deploy --prod` from `frontend/` with a token read from
  `/opt/spaceapps/vercel.token` (root-only, **never committed**).

So `git push origin prism` is live in ~1–2 minutes. Logs:
`journalctl -u spaceapps-deploy -u spaceapps-deploy-frontend -f`.

Vercel env (production + preview):
`NEXT_PUBLIC_PRISM_API_BASE=https://spaceapps.candymart.store/v2`,
`SPHEREX_API_INTERNAL_URL=https://spaceapps.candymart.store`.

## Install from scratch

```
install -m 755 deploy.sh deploy-frontend.sh /opt/spaceapps/
cp *.service *.timer /etc/systemd/system/
# tunnel: put creds.json + config.yml (see tunnel-config.example.yml) in /opt/spaceapps/tunnel/
systemctl daemon-reload
systemctl enable --now spaceapps-tunnel spaceapps-deploy.timer spaceapps-deploy-frontend.timer
```
