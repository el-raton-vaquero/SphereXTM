#!/usr/bin/env bash
# Pull-based CD for the PRISM frontend: deploys frontend/ to Vercel production
# whenever the tracked branch moves. Token is read from a root-only file.
set -euo pipefail

REPO_URL="https://github.com/el-raton-vaquero/SphereXTM"
BRANCH="${BRANCH:-prism}"
BASE=/opt/spaceapps
SRC="$BASE/repo-frontend"
STATE="$BASE/deployed_frontend_sha"
export VERCEL_ORG_ID=team_q7Pwvanon3s6keeiEw3K0HaP
export VERCEL_PROJECT_ID=prj_iyMNvdj4yAuE6FawGQ4Ly9WNMxfz

exec 8>"$BASE/deploy-frontend.lock"
flock -n 8 || { echo "another frontend deploy running"; exit 0; }

if [ ! -d "$SRC/.git" ]; then
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$SRC"
fi
cd "$SRC"
git fetch --quiet origin "$BRANCH"
REMOTE_SHA=$(git rev-parse "origin/$BRANCH")
DEPLOYED_SHA=$(cat "$STATE" 2>/dev/null || echo none)
[ "$REMOTE_SHA" = "$DEPLOYED_SHA" ] && exit 0

git checkout --quiet --force "$REMOTE_SHA"
git clean -fdq -e frontend/.vercel
echo "frontend deploying $BRANCH@$REMOTE_SHA (was $DEPLOYED_SHA)"
cd frontend
URL=$(vercel deploy --prod --yes --token "$(cat "$BASE/vercel.token")" \
      --meta githubCommitSha="$REMOTE_SHA" 2>"$BASE/vercel-last.log")
echo "$REMOTE_SHA" > "$STATE"
echo "frontend deploy OK $REMOTE_SHA -> $URL"
