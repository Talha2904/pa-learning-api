#!/usr/bin/env bash
# Deploys Lumen (PA Learning) on the VPS. Run from anywhere:
#
#   cd /opt/apps/lms/backend && git pull --ff-only && bash scripts/deploy-lms.sh
#
# Pulls both repos, applies the database changes listed below, rebuilds the
# images, checks the frontend's nginx config, then restarts ONLY the backend
# and frontend containers (never `down`, never nginx or other apps) and waits
# until both answer. Stops at the first failure. Never touches .env files.
set -euo pipefail

LMS=/opt/apps/lms
SITE=https://lms.intellizum.cloud

# Database changes to apply. Each must be safe to run more than once
# (create ... if not exists / on conflict do nothing).
MIGRATIONS=(
  20261126000100_ai_settings.sql
)

step() { printf '\n==> %s\n' "$1"; }

step "Pulling code"
git -C "$LMS/frontend" pull --ff-only
git -C "$LMS/backend" pull --ff-only

cd "$LMS"

step "Applying database changes (via the running backend's connection)"
for m in "${MIGRATIONS[@]}"; do
  echo "  - $m"
  docker compose exec -T backend node --input-type=module -e '
    import pg from "pg";
    let sql = "";
    for await (const chunk of process.stdin) sql += chunk;
    if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set in the backend container"); process.exit(1); }
    const ssl = process.env.DATABASE_SSL === "disable" ? false
      : process.env.DATABASE_SSL === "verify" ? true : { rejectUnauthorized: false };
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl });
    await client.connect();
    try { await client.query(sql); } finally { await client.end(); }
    console.log("    applied");
  ' < "$LMS/backend/supabase/migrations/$m"
done

step "Building images"
docker compose build backend frontend

step "Checking the frontend nginx config"
docker compose run --rm --no-deps frontend nginx -t

step "Restarting backend and frontend only"
docker compose up -d --no-deps --force-recreate backend frontend

step "Waiting for the backend to answer"
for i in $(seq 1 30); do
  if docker exec lms_backend wget -qO- http://localhost:4000/health >/dev/null 2>&1; then echo "  backend healthy"; break; fi
  if [ "$i" = 30 ]; then echo "  backend did not become healthy - recent logs:"; docker logs --tail 50 lms_backend; exit 1; fi
  sleep 2
done

step "Checking the site"
code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/dashboard")
echo "  $SITE/dashboard -> $code"
[ "$code" = 200 ] || { echo "  unexpected status"; exit 1; }

docker ps --filter "name=lms_"
printf '\nDeploy finished.\n'
