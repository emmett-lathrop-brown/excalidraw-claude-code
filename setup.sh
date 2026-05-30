#!/usr/bin/env bash
# Excalidraw + Claude Code + VSCode — one-shot setup.
# Host dependency is Docker only (Node is NOT required): the canvas and the
# MCP server both run as containers, and even the ~/.claude.json edit falls
# back to a throwaway Node container when the host has no node.
set -euo pipefail

cd "$(dirname "$0")"

CANVAS_PORT="${CANVAS_PORT:-3000}"
CANVAS_URL="http://127.0.0.1:${CANVAS_PORT}"
MCP_IMAGE="ghcr.io/yctimlin/mcp_excalidraw:latest"

echo "▶ checking prerequisites…"
command -v docker >/dev/null 2>&1 || { echo "✗ docker not found — install Docker Desktop: https://www.docker.com/"; exit 1; }

echo "▶ starting Excalidraw canvas on :${CANVAS_PORT} (Docker, restart=unless-stopped)…"
if docker compose version >/dev/null 2>&1; then
  CANVAS_PORT="${CANVAS_PORT}" docker compose up -d
else
  CANVAS_PORT="${CANVAS_PORT}" docker-compose up -d
fi

echo "▶ pre-pulling the MCP image so the first Claude launch is instant…"
docker pull "${MCP_IMAGE}" >/dev/null && echo "  pulled ${MCP_IMAGE}"

echo "▶ waiting for canvas to answer…"
up=""
for _ in $(seq 1 30); do
  if curl -sf "${CANVAS_URL}/health" >/dev/null 2>&1 || curl -sf "${CANVAS_URL}" >/dev/null 2>&1; then
    up=1; break
  fi
  sleep 1
done
[ -n "$up" ] && echo "  canvas up: ${CANVAS_URL}" || echo "  ⚠ canvas not responding yet — check 'docker compose logs canvas'"

echo "▶ registering MCP server (Docker) in ~/.claude.json…"
if command -v node >/dev/null 2>&1; then
  node ./register-mcp.mjs "${CANVAS_PORT}"
else
  # No host Node: run the registration inside the (already-pulled) MCP image,
  # which ships Node. Writes ~/.claude.json as the host user via the bind mount.
  docker run --rm --entrypoint node \
    -e HOME=/host -v "${HOME}":/host \
    -v "${PWD}":/work -w /work \
    --user "$(id -u):$(id -g)" \
    "${MCP_IMAGE}" register-mcp.mjs "${CANVAS_PORT}"
fi

cat <<EOF

✅ done — host dependency is Docker only (Node not required). Next:
   1) open ${CANVAS_URL} in your browser
   2) reload Claude Code (VSCode: "Reload Window") to load the 'excalidraw' MCP

   stop the canvas later with:  docker compose down
EOF
