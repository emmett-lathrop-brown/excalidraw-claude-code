// Idempotently register the Excalidraw MCP server in ~/.claude.json.
// Usage: node register-mcp.mjs [canvasUrl]
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";

const canvasUrl = process.argv[2] || "http://127.0.0.1:3000";
const path = `${homedir()}/.claude.json`;

const config = existsSync(path)
  ? JSON.parse(readFileSync(path, "utf8"))
  : {};

// Back up before touching an existing config.
if (existsSync(path)) copyFileSync(path, `${path}.bak`);

config.mcpServers ??= {};
config.mcpServers.excalidraw = {
  command: "npx",
  args: ["-y", "mcp-excalidraw-server@1.0.7"],
  env: {
    EXPRESS_SERVER_URL: canvasUrl,
    ENABLE_CANVAS_SYNC: "true",
  },
};

writeFileSync(path, JSON.stringify(config, null, 2));
console.log(`  registered mcpServers.excalidraw → npx mcp-excalidraw-server (canvas: ${canvasUrl})`);
