#!/usr/bin/env bash
# Pull-based CD for the PRISM science backend (NASA Space Apps 2026).
# Polls GitHub; when the tracked branch moves (or the container is down),
# rebuilds server/ and swaps the container, rolling back if /health fails.
set -euo pipefail

REPO_URL="https://github.com/el-raton-vaquero/SphereXTM"
BRANCH="${BRANCH:-prism}"
BASE=/opt/spaceapps
SRC="$BASE/repo"
STATE="$BASE/deployed_sha"
NAME=spaceapps_backend
PORT=8710
IMAGE=spaceapps-backend

exec 9>"$BASE/deploy.lock"
flock -n 9 || { echo "another deploy running"; exit 0; }

if [ ! -d "$SRC/.git" ]; then
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$SRC"
fi
cd "$SRC"
git fetch --quiet origin "$BRANCH"
REMOTE_SHA=$(git rev-parse "origin/$BRANCH")
DEPLOYED_SHA=$(cat "$STATE" 2>/dev/null || echo none)
RUNNING=$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)

if [ "$REMOTE_SHA" = "$DEPLOYED_SHA" ] && [ "$RUNNING" = "true" ]; then
  exit 0
fi

echo "deploying $BRANCH@$REMOTE_SHA (was $DEPLOYED_SHA, running=$RUNNING)"
git checkout --quiet --force "$REMOTE_SHA"

docker build --quiet --target runtime -t "$IMAGE:$REMOTE_SHA" server >/dev/null

mkdir -p "$BASE/data"
chown -R 10001:10001 "$BASE/data"

PREV_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null || true)

run_container() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped \
    -p 127.0.0.1:$PORT:8000 \
    -v "$BASE/data:/data" \
    -e SPHEREX_DATA_DIR=/data/m101 \
    -e PRISM_CACHE_DIR=/data/prism-cache \
    -e PRISM_SCIENCE_CACHE=/data/prism-science-cache \
    -e PRISM_CORS_ORIGINS="${PRISM_CORS_ORIGINS:-*}" \
    --memory 6g --cpus 6 \
    "$1" >/dev/null
}

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# One-time real M101 preparation for the classic /frames endpoint (best effort).
if [ ! -f "$BASE/data/m101/.prepared" ]; then
  if docker run --rm -v "$BASE/data:/data" -e SPHEREX_DATA_DIR=/data/m101 "$IMAGE:$REMOTE_SHA" \
       python -m spherex.prepare --output /data/m101; then
    touch "$BASE/data/m101/.prepared"
  else
    echo "WARN: M101 preparation failed; classic /frames will report unavailable"
  fi
fi

run_container "$IMAGE:$REMOTE_SHA"
if healthy; then
  echo "$REMOTE_SHA" > "$STATE"
  echo "deploy OK $REMOTE_SHA"
  # keep only the 3 newest spaceapps-backend images (never touches other projects)
  docker images "$IMAGE" --format '{{.Repository}}:{{.Tag}}' | tail -n +4 | xargs -r docker rmi >/dev/null 2>&1 || true
else
  echo "deploy FAILED health check for $REMOTE_SHA"
  docker logs --tail 50 "$NAME" || true
  if [ -n "$PREV_IMAGE" ]; then
    echo "rolling back to $PREV_IMAGE"
    run_container "$PREV_IMAGE"
  fi
  exit 1
fi
