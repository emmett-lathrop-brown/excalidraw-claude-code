#!/usr/bin/env bash
# Excalidraw × Claude Code × VSCode — theme launcher. Host dep: Docker only.
#
# A "theme" is an isolated Excalidraw canvas (its own container + port) plus a
# workspace folder whose project-scoped .mcp.json points Claude Code at it.
# Open each theme's workspace in its own VSCode window → 1 window = 1 theme.
#
# Usage:
#   ./theme.sh start [name] [--port N] [--dir PATH]   start a theme (default name: main)
#   ./theme.sh stop  [name]                           stop & remove a theme (default: main)
#   ./theme.sh stop-all                               stop & remove all themes
#   ./theme.sh list                                   list themes and their URLs
#   ./theme.sh help                                   show this help
set -euo pipefail
cd "$(dirname "$0")"

CANVAS_IMAGE="ghcr.io/yctimlin/mcp_excalidraw-canvas:latest"
MCP_IMAGE="ghcr.io/yctimlin/mcp_excalidraw:latest"
THEMES_HOME="${EXCALIDRAW_THEMES_HOME:-$HOME/excalidraw-themes}"
DEFAULT_THEME="main"

die() { echo "✗ $*" >&2; exit 1; }
need_docker() { command -v docker >/dev/null 2>&1 || die "docker not found — install Docker Desktop: https://www.docker.com/"; }

free_port() { # echo first free TCP port >= $1
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    while lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do p=$((p + 1)); done
  fi
  echo "$p"
}

container_port() { # $1=container name → its published host port for 3000/tcp
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

cmd_start() {
  need_docker
  local name="$DEFAULT_THEME" port="" dir=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) port="${2:-}"; shift 2 ;;
      --dir)  dir="${2:-}";  shift 2 ;;
      -*)     die "unknown flag: $1" ;;
      *)      name="$1";     shift ;;
    esac
  done

  local cname="excalidraw-${name}"
  # reuse the theme's existing port if its container is already around
  local existing; existing="$(container_port "$cname")"
  [ -n "$existing" ] && port="$existing"
  [ -n "$port" ] || port="$(free_port 3000)"

  local url="http://127.0.0.1:${port}"
  local ws="${dir:-$THEMES_HOME/$name}"
  mkdir -p "$ws"

  echo "▶ theme '${name}' → port ${port}"
  if docker ps -a --format '{{.Names}}' | grep -qx "$cname"; then
    docker start "$cname" >/dev/null && echo "  (re)started container ${cname}"
  else
    docker run -d -p "${port}:3000" --restart unless-stopped --name "$cname" "$CANVAS_IMAGE" >/dev/null
    echo "  created container ${cname} on :${port}"
  fi

  echo "▶ pre-pulling MCP image…"
  docker pull "${MCP_IMAGE}" >/dev/null && echo "  pulled ${MCP_IMAGE}"

  write_mcp_json "${ws}/.mcp.json" "${port}"
  printf 'Excalidraw theme: %s\nCanvas: %s\n' "$name" "$url" > "${ws}/README.md"
  echo "  wrote ${ws}/.mcp.json (project-scoped MCP → :${port})"

  wait_canvas "$url" && echo "  canvas up: $url" || echo "  ⚠ canvas slow — 'docker logs ${cname}'"

  # tilde-shorten the workspace path for a clean, copy-pasteable line
  local ws_disp="$ws"
  case "$ws" in "$HOME"/*) ws_disp="~${ws#$HOME}" ;; esac

  printf '\ncode %s\n%s\n' "$ws_disp" "$url"
}

cmd_stop() {
  need_docker
  local name="${1:-$DEFAULT_THEME}"
  if docker rm -f "excalidraw-${name}" >/dev/null 2>&1; then
    echo "stopped & removed theme '${name}'"
  else
    echo "no theme '${name}' is running"
  fi
}

cmd_stop_all() {
  need_docker
  local names; names="$(docker ps -a --filter "name=excalidraw-" --format '{{.Names}}')"
  [ -n "$names" ] || { echo "no themes running"; return; }
  while IFS= read -r cname; do
    [ -n "$cname" ] || continue
    docker rm -f "$cname" >/dev/null 2>&1 && echo "stopped & removed theme '${cname#excalidraw-}'"
  done <<< "$names"
}

cmd_list() {
  need_docker
  local rows; rows="$(docker ps -a --filter "name=excalidraw-" --format '{{.Names}}|{{.Status}}|{{.Ports}}')"
  [ -n "$rows" ] || { echo "no themes yet — start one with './theme.sh start <name>'"; return; }
  printf '%-16s %-24s %s\n' "THEME" "STATUS" "URL"
  while IFS='|' read -r nm st ports; do
    [ -n "$nm" ] || continue
    local theme="${nm#excalidraw-}" p
    p="$(printf '%s' "$ports" | grep -oE '0\.0\.0\.0:[0-9]+' | head -1 | cut -d: -f2)"
    printf '%-16s %-24s %s\n' "$theme" "$st" "${p:+http://127.0.0.1:$p}"
  done <<< "$rows"
}

usage() {
  cat <<'EOF'
Excalidraw × Claude Code × VSCode — theme launcher (Docker only)

A theme = its own canvas (container + port) + a workspace whose project-scoped
.mcp.json points Claude Code at it. 1 VSCode window = 1 theme.

Usage:
  ./theme.sh start [name] [--port N] [--dir PATH]   start a theme (default name: main)
  ./theme.sh stop  [name]                           stop & remove a theme (default: main)
  ./theme.sh stop-all                               stop & remove all themes
  ./theme.sh list                                   list themes and their URLs
  ./theme.sh help                                   show this help

Examples:
  ./theme.sh start                 # default theme 'main'
  ./theme.sh start food           # theme 'food' on an auto-picked port
  ./theme.sh start travel
  ./theme.sh list
  ./theme.sh stop travel
  ./theme.sh stop-all

Then: open the printed workspace folder in a new VSCode window, open the canvas
URL in a browser, and approve the project MCP via /mcp (first time only).
EOF
}

case "${1:-help}" in
  start)          shift; cmd_start "$@" ;;
  stop)           shift; cmd_stop "${1:-}" ;;
  stop-all)       cmd_stop_all ;;
  list|ls)        cmd_list ;;
  help|-h|--help) usage ;;
  # gentle migration from the old flag-style interface
  --theme)        shift; echo "ℹ '--theme X' is now 'start X'"; cmd_start "$@" ;;
  --list)         echo "ℹ '--list' is now 'list'"; cmd_list ;;
  --stop)         shift; echo "ℹ '--stop X' is now 'stop X'"; cmd_stop "${1:-}" ;;
  *)              die "unknown command: $1  (try './theme.sh help')" ;;
esac
