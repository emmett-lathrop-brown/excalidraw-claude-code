#!/usr/bin/env bash
# Excalidraw + Claude Code + VSCode — setup / multi-theme launcher.
# Host dependency is Docker only (Node not required).
#
#   ./setup.sh                       default canvas :3000 + global ~/.claude.json MCP
#   ./setup.sh --theme facet         per-theme canvas (own port) + workspace .mcp.json
#   ./setup.sh --theme travel --port 3005 [--dir <path>]
#   ./setup.sh --list                list running theme canvases
#   ./setup.sh --stop facet          stop & remove a theme canvas
#   ./setup.sh --help
#
# Multi-theme model: 1 VSCode window = 1 theme. Each theme gets its own
# canvas container on its own port and a workspace folder containing a
# project-scoped .mcp.json that points Claude Code at that port. Open each
# theme folder in a separate VSCode window — sessions stay isolated.
set -euo pipefail
cd "$(dirname "$0")"

CANVAS_IMAGE="ghcr.io/yctimlin/mcp_excalidraw-canvas:latest"
MCP_IMAGE="ghcr.io/yctimlin/mcp_excalidraw:latest"
THEMES_HOME="${EXCALIDRAW_THEMES_HOME:-$HOME/excalidraw-themes}"

need_docker() {
  command -v docker >/dev/null 2>&1 || { echo "✗ docker not found — install Docker Desktop: https://www.docker.com/"; exit 1; }
}

compose() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi; }

free_port() { # echo first free TCP port >= $1
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    while lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do p=$((p+1)); done
  fi
  echo "$p"
}

container_port() { # $1=name → its published host port for 3000/tcp (empty if none)
  docker inspect -f '{{with (index .NetworkSettings.Ports "3000/tcp")}}{{(index . 0).HostPort}}{{end}}' "$1" 2>/dev/null || true
}

wait_canvas() { # $1=url
  for _ in $(seq 1 30); do
    if curl -sf "$1/health" >/dev/null 2>&1 || curl -sf "$1" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

write_mcp_json() { # $1=file $2=port
  cat > "$1" <<JSON
{
  "mcpServers": {
    "excalidraw": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--add-host=host.docker.internal:host-gateway",
        "-e", "EXPRESS_SERVER_URL=http://host.docker.internal:$2",
        "-e", "ENABLE_CANVAS_SYNC=true",
        "$MCP_IMAGE"
      ]
    }
  }
}
JSON
}

# ── default (single, global) ────────────────────────────────────────────────
cmd_default() {
  need_docker
  local port="${CANVAS_PORT:-3000}" url
  url="http://127.0.0.1:${port}"
  echo "▶ starting default canvas on :${port} (docker compose)…"
  CANVAS_PORT="${port}" compose up -d
  echo "▶ pre-pulling MCP image…"; docker pull "${MCP_IMAGE}" >/dev/null && echo "  pulled ${MCP_IMAGE}"
  wait_canvas "$url" && echo "  canvas up: $url" || echo "  ⚠ canvas slow — 'docker compose logs canvas'"
  echo "▶ registering MCP in ~/.claude.json…"
  if command -v node >/dev/null 2>&1; then
    node ./register-mcp.mjs "${port}"
  else
    docker run --rm --entrypoint node -e HOME=/host -v "${HOME}":/host \
      -v "${PWD}":/work -w /work --user "$(id -u):$(id -g)" \
      "${MCP_IMAGE}" register-mcp.mjs "${port}"
  fi
  cat <<EOF

✅ done (default, global). Next:
   1) open ${url} in your browser
   2) reload Claude Code (VSCode: "Reload Window")
EOF
}

# ── per-theme ───────────────────────────────────────────────────────────────
cmd_theme() {
  need_docker
  local name="$1" port="${2:-}" dir="${3:-}"
  [ -n "$name" ] || { echo "✗ --theme needs a name"; exit 1; }
  local cname="excalidraw-${name}"

  # reuse the theme's existing port if its container is already around
  local existing; existing="$(container_port "$cname")"
  if [ -n "$existing" ]; then port="$existing"; fi
  [ -n "$port" ] || port="$(free_port 3000)"

  local url="http://127.0.0.1:${port}"
  local ws="${dir:-$THEMES_HOME/$name}"
  mkdir -p "$ws"

  echo "▶ theme '${name}' → port ${port}, workspace ${ws}"
  if docker ps -a --format '{{.Names}}' | grep -qx "$cname"; then
    docker start "$cname" >/dev/null && echo "  (re)started container ${cname}"
  else
    docker run -d -p "${port}:3000" --restart unless-stopped --name "$cname" "$CANVAS_IMAGE" >/dev/null
    echo "  created container ${cname} on :${port}"
  fi

  echo "▶ pre-pulling MCP image…"; docker pull "${MCP_IMAGE}" >/dev/null && echo "  pulled ${MCP_IMAGE}"

  write_mcp_json "${ws}/.mcp.json" "${port}"
  echo "  wrote ${ws}/.mcp.json (project-scoped MCP → :${port})"
  printf 'Excalidraw theme workspace: %s\nCanvas: %s   MCP: project .mcp.json\n' "$name" "$url" > "${ws}/README.md"

  wait_canvas "$url" && echo "  canvas up: $url" || echo "  ⚠ canvas slow — 'docker logs ${cname}'"

  cat <<EOF

✅ theme '${name}' ready. Next:
   1) open the workspace in a NEW VSCode window:  code "${ws}"
   2) open the canvas in your browser:            ${url}
   3) in that window's Claude Code, run /mcp and APPROVE the project 'excalidraw' server (first time only)

   each theme = its own window + its own canvas. Repeat with another name for another theme.
EOF
}

cmd_list() {
  need_docker
  echo "running / known theme canvases:"
  docker ps -a --filter "name=excalidraw-" --format '  {{.Names}}\t{{.Status}}\t{{.Ports}}' || true
}

cmd_stop() {
  need_docker
  local name="$1"; [ -n "$name" ] || { echo "✗ --stop needs a theme name"; exit 1; }
  docker rm -f "excalidraw-${name}" >/dev/null 2>&1 && echo "stopped & removed excalidraw-${name}" || echo "no container excalidraw-${name}"
}

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; }

# ── arg parsing ─────────────────────────────────────────────────────────────
case "${1:-}" in
  ""|--default)         cmd_default ;;
  -h|--help)            usage ;;
  --list)               cmd_list ;;
  --stop)               cmd_stop "${2:-}" ;;
  --theme)
    shift
    THEME=""; PORT=""; DIR=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --port) PORT="${2:-}"; shift 2 ;;
        --dir)  DIR="${2:-}";  shift 2 ;;
        *)      THEME="$1";    shift ;;
      esac
    done
    cmd_theme "$THEME" "$PORT" "$DIR"
    ;;
  *) echo "unknown option: $1"; echo; usage; exit 1 ;;
esac
