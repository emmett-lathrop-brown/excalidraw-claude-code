// Stdio MCP server for the chat sidecar.
// Lets Claude Code list/read pinned chat threads and post replies natively.
// Invoked per-call by Claude Code via `docker run -i --rm` (see .mcp.json).
import readline from 'node:readline';
import http from 'node:http';

const CHAT_API_BASE = process.env.CHAT_API_BASE;
if (!CHAT_API_BASE) {
  process.stderr.write('[mcp] CHAT_API_BASE env var required\n');
  process.exit(1);
}

function apiRequest(method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(CHAT_API_BASE + urlPath);
    const body = bodyObj == null ? null : JSON.stringify(bodyObj);
    const headers = { Accept: 'application/json' };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method,
      headers,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }); }
        catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const summarizeThread = (t) => ({
  thread_id: t.id,
  element_id: t.elementId,
  anchored_to_element: !!t.elementId,
  scene_position: t.sceneX != null ? { x: t.sceneX, y: t.sceneY } : null,
  message_count: t.messages?.length ?? 0,
  last_message: t.messages?.length
    ? { author: t.messages.at(-1).author, text: t.messages.at(-1).text, ts: t.messages.at(-1).ts }
    : null,
  created_at: t.createdAt,
});

const tools = {
  list_chat_threads: {
    description:
      'List every pinned chat thread on the canvas. Each thread is a Figma-style pin the user dropped. ' +
      'Use this first to find threads the user has been writing in. Pins anchored to a shape include element_id.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      const r = await apiRequest('GET', '/threads');
      if (r.status !== 200) throw new Error(`upstream ${r.status}`);
      return { threads: (r.json || []).map(summarizeThread) };
    },
  },

  get_chat_thread: {
    description:
      'Read the full message history of one thread, including author and timestamp for each message. ' +
      'Use this when the user just wrote in a pin and you need the conversation context.',
    inputSchema: {
      type: 'object',
      properties: { thread_id: { type: 'string', description: 'ID returned by list_chat_threads' } },
      required: ['thread_id'],
    },
    async handler({ thread_id }) {
      const r = await apiRequest('GET', '/threads');
      if (r.status !== 200) throw new Error(`upstream ${r.status}`);
      const thread = (r.json || []).find((t) => t.id === thread_id);
      if (!thread) throw new Error(`thread not found: ${thread_id}`);
      return thread;
    },
  },

  post_chat_message: {
    description:
      'Post a reply into a chat thread as "claude code". The user sees it as a violet bubble. ' +
      'Use this after you act on a request (e.g. updated a shape) so the user gets confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        text: { type: 'string', description: 'Message body. Markdown is rendered (code blocks, bold, links).' },
      },
      required: ['thread_id', 'text'],
    },
    async handler({ thread_id, text }) {
      const r = await apiRequest('POST', `/threads/${encodeURIComponent(thread_id)}/messages`, {
        author: 'claude',
        text,
      });
      if (r.status < 200 || r.status >= 300) throw new Error(`upstream ${r.status}`);
      return r.json;
    },
  },
};

// ---------- JSON-RPC stdio loop ----------
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  try {
    let result;
    if (method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'excalidraw-chat', version: '0.1.0' },
      };
    } else if (method === 'tools/list') {
      result = {
        tools: Object.entries(tools).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      };
    } else if (method === 'tools/call') {
      const tool = tools[params?.name];
      if (!tool) throw new Error(`unknown tool: ${params?.name}`);
      const data = await tool.handler(params.arguments || {});
      result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      return;
    } else if (method === 'shutdown' || method === 'exit') {
      if (id !== undefined) send({ jsonrpc: '2.0', id, result: null });
      process.exit(0);
    } else {
      throw new Error(`unknown method: ${method}`);
    }

    if (id !== undefined) send({ jsonrpc: '2.0', id, result });
  } catch (err) {
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message || String(err) } });
    }
  }
});

process.stderr.write(`[mcp] excalidraw-chat ready (api=${CHAT_API_BASE})\n`);
