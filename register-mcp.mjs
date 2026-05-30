// Idempotently register the Excalidraw MCP server (Docker) in ~/.claude.json.
// The MCP runs as a throwaway container — no host Node needed at runtime.
// Usage: node register-mcp.mjs [canvasPort]
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";

const port = process.argv[2] || "3000";
const path = `${homedir()}/.claude.json`;

const config = existsSync(path)
  ? JSON.parse(readFileSync(path, "utf8"))
  : {};

// Back up before touching an existing config.
if (existsSync(path)) copyFileSync(path, `${path}.bak`);

config.mcpServers ??= {};
config.mcpServers.excalidraw = {
  command: "docker",
  args: [
    "run", "-i", "--rm",
    // reach the canvas container published on the host's port
    "--add-host=host.docker.internal:host-gateway",
    "-e", `EXPRESS_SERVER_URL=http://host.docker.internal:${port}`,
    "-e", "ENABLE_CANVAS_SYNC=true",
    "ghcr.io/yctimlin/mcp_excalidraw:latest",
  ],
};

writeFileSync(path, JSON.stringify(config, null, 2));
console.log(`  registered mcpServers.excalidraw → docker run mcp_excalidraw (canvas: host.docker.internal:${port})`);
