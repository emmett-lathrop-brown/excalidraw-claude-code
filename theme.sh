#!/usr/bin/env bash
# Excalidraw × Claude Code × VSCode — theme launcher. Host dep: Docker only.
#
# A "theme" is an isolated Excalidraw canvas + chat sidecar (each its own
# container set + port) plus a workspace folder whose project-scoped .mcp.json
# points Claude Code at it.
# Open each theme's workspace in its own VSCode window → 1 window = 1 theme.
#
# Architecture per theme:
#   excalidraw-<name>         canvas container (internal, no public port)
#   excalidraw-chat-<name>    nginx+chat sidecar (publishes the theme port,
#                              injects chat overlay into the canvas HTML)
#   excalidraw-net-<name>     docker network connecting the two
#
# Usage:
#   ./theme.sh start [name] [--port N] [--dir PATH]   start a theme (default name: main)
#   ./theme.sh stop  [name]                           stop & remove a theme (default: main)
#   ./theme.sh stop-all                               stop & remove all themes
#   ./theme.sh list                                   list themes and their URLs
#   ./theme.sh help                                   show this help
set -euo pipefail
cd "$(dirname "$0")"

REPO_DIR="$(pwd)"
CANVAS_IMAGE="ghcr.io/yctimlin/mcp_excalidraw-canvas:latest"
MCP_IMAGE="ghcr.io/yctimlin/mcp_excalidraw:latest"
CHAT_IMAGE="excalidraw-chat:local"
CHAT_DIR="${REPO_DIR}/chat"
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

chat_public_port() { # $1=chat proxy container name → its published host port for 8080/tcp
  docker inspect -f '{{with (index .NetworkSettings.Ports "8080/tcp")}}{{(index . 0).HostPort}}{{end}}' "$1" 2>/dev/null || true
}

wait_canvas() { # $1=url
  for _ in $(seq 1 30); do
    if curl -sf "$1/health" >/dev/null 2>&1 || curl -sf "$1" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

build_chat_image() {
  if docker image inspect "$CHAT_IMAGE" >/dev/null 2>&1; then return 0; fi
  [ -d "$CHAT_DIR" ] || die "chat sidecar dir not found: $CHAT_DIR"
  echo "▶ building chat sidecar image (${CHAT_IMAGE})…"
  docker build -q -t "$CHAT_IMAGE" "$CHAT_DIR" >/dev/null && echo "  built ${CHAT_IMAGE}"
}

write_mcp_json() { # $1=file $2=netname $3=canvas_container $4=chat_container
  cat > "$1" <<JSON
{
  "mcpServers": {
    "excalidraw": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--network", "$2",
        "-e", "EXPRESS_SERVER_URL=http://$3:3000",
        "-e", "ENABLE_CANVAS_SYNC=true",
        "$MCP_IMAGE"
      ]
    },
    "excalidraw-chat": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--network", "$2",
        "-e", "CHAT_API_BASE=http://$4:8080/__chat/api",
        "$CHAT_IMAGE",
        "node", "/app/server/mcp.js"
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

  local cname="excalidraw-${name}"            # canvas
  local ccname="excalidraw-chat-${name}"      # chat sidecar
  local netname="excalidraw-net-${name}"
  local data_dir="${THEMES_HOME}/${name}/.chat-data"

  # reuse the theme's existing public port if its chat proxy is already around
  local existing; existing="$(chat_public_port "$ccname")"
  [ -n "$existing" ] && port="$existing"
  [ -n "$port" ] || port="$(free_port 3000)"

  local url="http://127.0.0.1:${port}"
  local ws="${dir:-$THEMES_HOME/$name}"
  mkdir -p "$ws" "$data_dir"

  build_chat_image

  echo "▶ theme '${name}' → port ${port}"

  # Network for canvas ↔ chat sidecar ↔ MCP (all resolve by container name)
  docker network inspect "$netname" >/dev/null 2>&1 || \
    docker network create "$netname" >/dev/null

  # Canvas (internal — no published port)
  if docker ps -a --format '{{.Names}}' | grep -qx "$cname"; then
    docker start "$cname" >/dev/null && echo "  (re)started canvas ${cname}"
  else
    docker run -d --network "$netname" --restart unless-stopped \
      --name "$cname" "$CANVAS_IMAGE" >/dev/null
    echo "  created canvas ${cname} (internal)"
  fi

  # Chat sidecar (public port → nginx → canvas + chat API/WS)
  if docker ps -a --format '{{.Names}}' | grep -qx "$ccname"; then
    docker start "$ccname" >/dev/null && echo "  (re)started chat sidecar ${ccname}"
  else
    docker run -d --network "$netname" -p "${port}:8080" \
      -e "UPSTREAM=http://${cname}:3000" \
      -e "THEME_NAME=${name}" \
      -v "${data_dir}:/data" \
      --restart unless-stopped --name "$ccname" \
      "$CHAT_IMAGE" >/dev/null
    echo "  created chat sidecar ${ccname} on :${port}"
  fi

  echo "▶ pre-pulling MCP image…"
  docker pull "${MCP_IMAGE}" >/dev/null && echo "  pulled ${MCP_IMAGE}"

  write_mcp_json "${ws}/.mcp.json" "${netname}" "${cname}" "${ccname}"
  printf 'Excalidraw theme: %s\nCanvas (with chat): %s\n' "$name" "$url" > "${ws}/README.md"
  echo "  wrote ${ws}/.mcp.json (project-scoped MCP → excalidraw + excalidraw-chat)"

  wait_canvas "$url" && echo "  canvas up: $url" || echo "  ⚠ canvas slow — 'docker logs ${ccname}'"

  # tilde-shorten the workspace path for a clean, copy-pasteable line
  local ws_disp="$ws"
  case "$ws" in "$HOME"/*) ws_disp="~${ws#$HOME}" ;; esac

  printf '\ncode %s\n%s\n' "$ws_disp" "$url"
}

cmd_stop() {
  need_docker
  local name="${1:-$DEFAULT_THEME}"
  local cname="excalidraw-${name}"
  local ccname="excalidraw-chat-${name}"
  local netname="excalidraw-net-${name}"
  local removed=0
  docker rm -f "$ccname" >/dev/null 2>&1 && removed=1
  docker rm -f "$cname"  >/dev/null 2>&1 && removed=1
  docker network rm "$netname" >/dev/null 2>&1 || true
  if [ "$removed" = "1" ]; then
    echo "stopped & removed theme '${name}'"
  else
    echo "no theme '${name}' is running"
  fi
}

cmd_restart() {
  need_docker
  local name="${1:-$DEFAULT_THEME}"
  echo "▶ restarting theme '${name}'"
  cmd_stop "$name" >/dev/null
  cmd_start "$name"
}

cmd_stop_all() {
  need_docker
  local names; names="$(docker ps -a --filter "name=excalidraw-" --format '{{.Names}}')"
  [ -n "$names" ] || { echo "no themes running"; return; }
  while IFS= read -r cname; do
    [ -n "$cname" ] || continue
    docker rm -f "$cname" >/dev/null 2>&1 && echo "removed ${cname}"
  done <<< "$names"
  local nets; nets="$(docker network ls --filter "name=excalidraw-net-" --format '{{.Name}}')"
  while IFS= read -r nn; do
    [ -n "$nn" ] || continue
    docker network rm "$nn" >/dev/null 2>&1 || true
  done <<< "$nets"
}

cmd_list() {
  need_docker
  local rows; rows="$(docker ps -a --filter "name=excalidraw-chat-" --format '{{.Names}}|{{.Status}}|{{.Ports}}')"
  [ -n "$rows" ] || { echo "no themes yet — start one with './theme.sh start <name>'"; return; }
  printf '%-14s %-20s %-10s %-5s %s\n' "THEME" "STATUS" "HEALTH" "PINS" "URL"
  while IFS='|' read -r nm st ports; do
    [ -n "$nm" ] || continue
    local theme="${nm#excalidraw-chat-}" p health url pins
    p="$(printf '%s' "$ports" | grep -oE '0\.0\.0\.0:[0-9]+' | head -1 | cut -d: -f2)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}—{{end}}' "$nm" 2>/dev/null || echo '—')"
    url="${p:+http://127.0.0.1:$p}"
    pins='—'
    if [ -n "$url" ]; then
      pins="$(curl -sf --max-time 1 "${url}/__chat/healthz" 2>/dev/null \
        | sed -nE 's/.*"threads":[[:space:]]*([0-9]+).*/\1/p')"
      [ -n "$pins" ] || pins='?'
    fi
    printf '%-14s %-20s %-10s %-5s %s\n' "$theme" "$st" "$health" "$pins" "$url"
  done <<< "$rows"
}

usage() {
  cat <<'EOF'
Excalidraw × Claude Code × VSCode — theme launcher (Docker only)

A theme = canvas + chat sidecar (own containers + port) + a workspace whose
project-scoped .mcp.json points Claude Code at it. 1 VSCode window = 1 theme.

Usage:
  ./theme.sh start   [name] [--port N] [--dir PATH]  start a theme (default name: main)
  ./theme.sh stop    [name]                          stop & remove a theme (default: main)
  ./theme.sh restart [name]                          stop and start again (preserves data via snapshot)
  ./theme.sh stop-all                                stop & remove all themes
  ./theme.sh list                                    list themes (status, health, pin count, URL)
  ./theme.sh help                                    show this help

Examples:
  ./theme.sh start                 # default theme 'main'
  ./theme.sh start food            # theme 'food' on an auto-picked port
  ./theme.sh start travel
  ./theme.sh list
  ./theme.sh stop travel
  ./theme.sh stop-all

Then: open the printed workspace folder in a new VSCode window, open the canvas
URL in a browser, and approve the project MCP via /mcp (first time only).

Chat: right-click on the canvas to drop a pin & start a thread. Drag pins to
move them, right-click pin to delete, 📋 (top-right) for the pin list.
EOF
}

case "${1:-help}" in
  start)          shift; cmd_start "$@" ;;
  stop)           shift; cmd_stop "${1:-}" ;;
  restart)        shift; cmd_restart "${1:-}" ;;
  stop-all)       cmd_stop_all ;;
  list|ls)        cmd_list ;;
  help|-h|--help) usage ;;
  # gentle migration from the old flag-style interface
  --theme)        shift; echo "ℹ '--theme X' is now 'start X'"; cmd_start "$@" ;;
  --list)         echo "ℹ '--list' is now 'list'"; cmd_list ;;
  --stop)         shift; echo "ℹ '--stop X' is now 'stop X'"; cmd_stop "${1:-}" ;;
  *)              die "unknown command: $1  (try './theme.sh help')" ;;
esac
