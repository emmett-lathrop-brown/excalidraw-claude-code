#!/usr/bin/env bash
# Excalidraw + Claude Code + VSCode — one-shot setup.
# Starts the canvas (Docker, persistent) and registers the MCP (npx).
set -euo pipefail

cd "$(dirname "$0")"

CANVAS_PORT="${CANVAS_PORT:-3000}"
CANVAS_URL="http://127.0.0.1:${CANVAS_PORT}"

echo "▶ checking prerequisites…"
command -v docker >/dev/null 2>&1 || { echo "✗ docker not found — install Docker Desktop: https://www.docker.com/"; exit 1; }
command -v node   >/dev/null 2>&1 || { echo "✗ node not found — install Node.js (needed for npx): https://nodejs.org/"; exit 1; }

echo "▶ starting Excalidraw canvas on :${CANVAS_PORT} (Docker, restart=unless-stopped)…"
if docker compose version >/dev/null 2>&1; then
  CANVAS_PORT="${CANVAS_PORT}" docker compose up -d
else
  CANVAS_PORT="${CANVAS_PORT}" docker-compose up -d
fi

echo "▶ waiting for canvas to answer…"
up=""
for _ in $(seq 1 30); do
  if curl -sf "${CANVAS_URL}/health" >/dev/null 2>&1 || curl -sf "${CANVAS_URL}" >/dev/null 2>&1; then
    up=1; break
  fi
  sleep 1
done
[ -n "$up" ] && echo "  canvas up: ${CANVAS_URL}" || echo "  ⚠ canvas not responding yet — check 'docker compose logs canvas'"

echo "▶ registering MCP server in ~/.claude.json…"
node "./register-mcp.mjs" "${CANVAS_URL}"

cat <<EOF

✅ done. Next:
   1) open ${CANVAS_URL} in your browser
   2) reload Claude Code (VSCode: "Reload Window") to load the 'excalidraw' MCP

   stop the canvas later with:  docker compose down
EOF
