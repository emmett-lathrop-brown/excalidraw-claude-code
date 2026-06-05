import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket as WSClient } from 'ws';

const UPSTREAM = process.env.UPSTREAM;
if (!UPSTREAM) throw new Error('UPSTREAM env var required (e.g. http://canvas:3000)');
const upstreamURL = new URL(UPSTREAM);

const PORT = Number(process.env.PORT) || 8080;
const DATA_FILE = process.env.CHAT_DATA_FILE || '/data/chat.json';
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

const CLIENT_JS_PATH = path.resolve('/app/client/chat.js');
const THEME_NAME = process.env.THEME_NAME || '';
const INJECT_TAG =
  `<script>window.__excalidrawTheme=${JSON.stringify(THEME_NAME)};</script>` +
  `<script defer src="/__chat/chat.js"></script>`;

// ---------- Chat state ----------
let state = { threads: [] };
try { state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
const newId = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const wss = new WebSocketServer({ noServer: true });
const broadcast = (msg) => {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};

const json = (res, code, body) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

const readJson = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
});

// ---------- Chat API ----------
async function handleChatAPI(req, res, url) {
  if (url.pathname === '/__chat/chat.js' && req.method === 'GET') {
    try {
      const code = fs.readFileSync(CLIENT_JS_PATH);
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(code);
    } catch (e) {
      res.statusCode = 500;
      res.end('client script missing');
    }
    return true;
  }

  if (url.pathname === '/__chat/api/threads' && req.method === 'GET') {
    json(res, 200, state.threads);
    return true;
  }

  if (url.pathname === '/__chat/api/threads' && req.method === 'POST') {
    const body = await readJson(req);
    const thread = {
      id: newId('thr'),
      x: Number(body.x) || 0,
      y: Number(body.y) || 0,
      sceneX: body.sceneX ?? null,
      sceneY: body.sceneY ?? null,
      elementId: body.elementId ?? null,
      anchorX: body.anchorX ?? null,
      anchorY: body.anchorY ?? null,
      messages: [],
      createdAt: Date.now(),
    };
    state.threads.push(thread);
    save();
    broadcast({ type: 'thread_created', thread });
    json(res, 201, thread);
    return true;
  }

  const mMsg = url.pathname.match(/^\/__chat\/api\/threads\/([^/]+)\/messages$/);
  if (mMsg && req.method === 'POST') {
    const tid = mMsg[1];
    const thr = state.threads.find((t) => t.id === tid);
    if (!thr) { json(res, 404, { error: 'thread not found' }); return true; }
    const body = await readJson(req);
    if (!body.text || typeof body.text !== 'string') { json(res, 400, { error: 'text required' }); return true; }
    const msg = { id: newId('msg'), author: body.author || 'user', text: body.text, ts: Date.now() };
    thr.messages.push(msg);
    save();
    broadcast({ type: 'message_added', threadId: tid, message: msg });
    json(res, 201, msg);
    return true;
  }

  const mThread = url.pathname.match(/^\/__chat\/api\/threads\/([^/]+)$/);
  if (mThread && req.method === 'DELETE') {
    const tid = mThread[1];
    const before = state.threads.length;
    state.threads = state.threads.filter((t) => t.id !== tid);
    if (state.threads.length === before) { json(res, 404, { error: 'thread not found' }); return true; }
    save();
    broadcast({ type: 'thread_deleted', threadId: tid });
    json(res, 204, {});
    return true;
  }

  if (mThread && req.method === 'PATCH') {
    const tid = mThread[1];
    const thr = state.threads.find((t) => t.id === tid);
    if (!thr) { json(res, 404, { error: 'thread not found' }); return true; }
    const body = await readJson(req);
    if (typeof body.x === 'number') thr.x = body.x;
    if (typeof body.y === 'number') thr.y = body.y;
    if (body.sceneX !== undefined) thr.sceneX = body.sceneX;
    if (body.sceneY !== undefined) thr.sceneY = body.sceneY;
    if (body.elementId !== undefined) thr.elementId = body.elementId;
    if (body.anchorX !== undefined) thr.anchorX = body.anchorX;
    if (body.anchorY !== undefined) thr.anchorY = body.anchorY;
    save();
    broadcast({ type: 'thread_updated', thread: thr });
    json(res, 200, thr);
    return true;
  }

  if (url.pathname.startsWith('/__chat/')) {
    json(res, 404, { error: 'not found', path: url.pathname });
    return true;
  }
  return false;
}

// ---------- Upstream proxy with HTML injection ----------
function proxyToUpstream(req, res) {
  const proxyReq = http.request({
    hostname: upstreamURL.hostname,
    port: upstreamURL.port || 80,
    method: req.method,
    path: req.url,
    headers: {
      ...req.headers,
      host: upstreamURL.host,
      'accept-encoding': 'identity', // disable compression so we can inject
    },
  }, (proxyRes) => {
    const ct = proxyRes.headers['content-type'] || '';
    const isHTML = ct.includes('text/html');
    const headers = { ...proxyRes.headers };
    // Strip length — we'll rewrite the body
    delete headers['content-length'];
    delete headers['content-encoding'];
    delete headers['transfer-encoding'];

    if (isHTML) {
      // Buffer the response, inject script, send
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        if (body.includes('</head>')) {
          body = body.replace('</head>', `${INJECT_TAG}</head>`);
        } else if (body.includes('</body>')) {
          body = body.replace('</body>', `${INJECT_TAG}</body>`);
        }
        const buf = Buffer.from(body, 'utf8');
        headers['content-length'] = String(buf.length);
        res.writeHead(proxyRes.statusCode || 200, headers);
        res.end(buf);
      });
      proxyRes.on('error', (err) => {
        console.error('proxyRes error:', err);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    } else {
      // Stream through unmodified
      res.writeHead(proxyRes.statusCode || 200, headers);
      proxyRes.pipe(res);
    }
  });
  proxyReq.on('error', (err) => {
    console.error('upstream error:', err.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`upstream error: ${err.message}`);
  });
  req.pipe(proxyReq);
}

// ---------- Upstream WebSocket proxy ----------
function proxyWebSocketUpgrade(req, socket, head) {
  const target = new URL(req.url, UPSTREAM);
  const upstreamHeaders = { ...req.headers, host: upstreamURL.host };
  const upstreamReq = http.request({
    hostname: upstreamURL.hostname,
    port: upstreamURL.port || 80,
    path: req.url,
    method: 'GET',
    headers: upstreamHeaders,
  });
  upstreamReq.on('upgrade', (upRes, upSocket) => {
    const lines = [
      `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`,
      ...Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`),
      '',
      '',
    ];
    socket.write(lines.join('\r\n'));
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
  });
  upstreamReq.on('error', () => socket.destroy());
  upstreamReq.end();
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const handled = await handleChatAPI(req, res, url);
    if (handled) return;
    proxyToUpstream(req, res);
  } catch (err) {
    console.error('handler error:', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/__chat/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    // Forward all other WebSocket upgrades (e.g. canvas backend sync) to upstream
    proxyWebSocketUpgrade(req, socket, head);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[chat] listening on :${PORT}, upstream=${UPSTREAM}, data=${DATA_FILE}`);
});

// ---------- Canvas snapshot persistence ----------
// The upstream canvas keeps elements in memory only — quit/restart wipes them.
// We periodically snapshot canvas elements to disk and restore on cold start
// when the canvas comes up empty. Browser localStorage stays the source of
// truth for *interactive* edits; this just gives us a server-side safety net.
const SNAPSHOT_FILE = path.join(path.dirname(DATA_FILE), 'canvas-snapshot.json');

function upstreamRequest(method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj == null ? null : JSON.stringify(bodyObj);
    const headers = { Accept: 'application/json' };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({
      hostname: upstreamURL.hostname,
      port: upstreamURL.port || 80,
      path: urlPath,
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

async function snapshotSave() {
  try {
    const [elRes, fileRes] = await Promise.all([
      upstreamRequest('GET', '/api/elements', null),
      upstreamRequest('GET', '/api/files', null),
    ]);
    const elements = elRes.json?.elements;
    const filesObj = fileRes.json?.files || {};
    if (!Array.isArray(elements) || elements.length === 0) return; // don't overwrite with empty
    const files = Object.values(filesObj);
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ elements, files }));
  } catch {
    // canvas may be down — ignore, try again next tick
  }
}

async function snapshotRestoreIfEmpty() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return;
  let saved;
  try { saved = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); }
  catch { return; }
  // Back-compat: older snapshots were a plain elements array.
  const elements = Array.isArray(saved) ? saved : saved.elements;
  const files = Array.isArray(saved) ? [] : (saved.files || []);
  if (!Array.isArray(elements) || elements.length === 0) return;

  // Wait up to 60s for canvas to respond
  for (let i = 0; i < 60; i++) {
    try {
      const r = await upstreamRequest('GET', '/api/elements', null);
      if (r.status === 200) {
        const existing = r.json?.elements;
        if (Array.isArray(existing) && existing.length > 0) {
          console.log(`[chat] canvas already has ${existing.length} elements; skipping snapshot restore`);
          return;
        }
        // Push files FIRST so image elements have their binary when they appear
        if (files.length > 0) {
          const fpush = await upstreamRequest('POST', '/api/files', { files });
          if (fpush.status >= 200 && fpush.status < 300) {
            console.log(`[chat] restored ${files.length} files from snapshot`);
          } else {
            console.warn(`[chat] file restore failed: status=${fpush.status}`);
          }
        }
        const push = await upstreamRequest('POST', '/api/elements/sync', {
          elements,
          source: 'chat-sidecar-snapshot-restore',
        });
        if (push.status >= 200 && push.status < 300) {
          console.log(`[chat] restored ${elements.length} canvas elements from snapshot`);
        } else {
          console.warn(`[chat] snapshot restore failed: status=${push.status}`);
        }
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.warn('[chat] canvas not reachable after 60s; snapshot restore skipped');
}

// Kick off after a brief delay so the proxy is listening first
setTimeout(snapshotRestoreIfEmpty, 2000);
setInterval(snapshotSave, 30_000);
