/* Excalidraw chat sidecar overlay
 * Right-click on canvas → create thread → side panel chat
 */
(function () {
  if (window.__excalidrawChatLoaded) return;
  window.__excalidrawChatLoaded = true;

  // Wait until <body> exists before doing any DOM mutation.
  if (!document.body) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      // body should exist by interactive/complete; try once more on next tick
      setTimeout(boot, 0);
    }
    return;
  }
  boot();

  function boot() {
    if (window.__excalidrawChatBooted) return;
    window.__excalidrawChatBooted = true;
    runChat();
  }

  function runChat() {

  const API = '/__chat/api';
  const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__chat/ws`;

  /** @type {Map<string, {thread: any, el: HTMLElement}>} */
  const pins = new Map();
  let activeThreadId = null;

  // ---------- DOM helpers ----------
  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Excalidraw state access (via React fiber) ----------
  // The canvas image we use doesn't expose window.excalidrawAPI, so we read
  // appState / scene.elements directly from the React fiber attached to the
  // canvas element.
  function walkFiber(visit) {
    const canvases = document.querySelectorAll('canvas');
    if (!canvases.length) return null;
    const c = canvases[canvases.length - 1];
    const fiberKey = Object.keys(c).find((k) => k.startsWith('__reactFiber'));
    if (!fiberKey) return null;
    let fiber = c[fiberKey];
    let depth = 0;
    while (fiber && depth < 100) {
      const r = visit(fiber, depth);
      if (r !== undefined) return r;
      fiber = fiber.return;
      depth++;
    }
    return null;
  }

  function getAppState() {
    return walkFiber((f) => {
      if (f.memoizedProps?.appState) return f.memoizedProps.appState;
      if (f.stateNode?.state?.appState) return f.stateNode.state.appState;
    });
  }

  function getSceneElements() {
    return walkFiber((f) => {
      const els = f.stateNode?.scene?.elements;
      if (Array.isArray(els)) return els;
    });
  }

  // Excalidraw stores image binaries client-side (IndexedDB / React state) and
  // never pushes them to the backend on its own. We dig them out of the React
  // fiber and POST to /api/files so the canvas-snapshot can capture images.
  function getSceneFiles() {
    return walkFiber((f) => {
      const files = f.stateNode?.files;
      if (files && typeof files === 'object' && !Array.isArray(files)) return files;
    });
  }

  const syncedFileIds = new Set();
  async function syncFilesToBackend() {
    const files = getSceneFiles();
    if (!files) return;
    const pending = [];
    for (const [id, f] of Object.entries(files)) {
      if (!syncedFileIds.has(id) && f?.dataURL) {
        pending.push({
          id,
          dataURL: f.dataURL,
          mimeType: f.mimeType || 'image/png',
          created: f.created || Date.now(),
        });
      }
    }
    if (pending.length === 0) return;
    try {
      await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: pending }),
      });
      for (const f of pending) syncedFileIds.add(f.id);
      console.log(`[chat] pushed ${pending.length} file(s) to backend`);
    } catch (err) {
      console.error('[chat] file sync failed', err);
    }
  }

  // viewport ↔ scene transforms
  function viewportToScene(clientX, clientY) {
    const s = getAppState();
    if (!s) return null;
    const zoom = s.zoom?.value ?? 1;
    return {
      sceneX: (clientX - (s.offsetLeft ?? 0)) / zoom - (s.scrollX ?? 0),
      sceneY: (clientY - (s.offsetTop ?? 0)) / zoom - (s.scrollY ?? 0),
    };
  }

  function sceneToViewport(sceneX, sceneY) {
    const s = getAppState();
    if (!s) return null;
    const zoom = s.zoom?.value ?? 1;
    return {
      x: (sceneX + (s.scrollX ?? 0)) * zoom + (s.offsetLeft ?? 0),
      y: (sceneY + (s.scrollY ?? 0)) * zoom + (s.offsetTop ?? 0),
    };
  }

  // Back-compat alias used elsewhere.
  function toSceneCoords(clientX, clientY) {
    return viewportToScene(clientX, clientY);
  }

  function elementAt(sceneX, sceneY) {
    const els = getSceneElements();
    if (!els) return null;
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.isDeleted) continue;
      // Bounding-box hit-test (good enough; ignores rotation)
      if (sceneX >= e.x && sceneX <= e.x + e.width &&
          sceneY >= e.y && sceneY <= e.y + e.height) {
        return e.id;
      }
    }
    return null;
  }

  function getElementById(id) {
    const els = getSceneElements();
    if (!els) return null;
    return els.find((e) => e.id === id && !e.isDeleted) || null;
  }

  // ---------- Theme badge ----------
  // Lets you tell at a glance which theme this window is showing.
  // Theme name is injected by the chat sidecar before this script loads.
  const themeName = (typeof window !== 'undefined' ? window.__excalidrawTheme : '') || '';
  if (themeName) {
    const badge = h('div', {
      id: 'excalidraw-theme-badge',
      title: `theme: ${themeName}`,
      style: {
        position: 'fixed',
        bottom: '14px',
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '4px 12px',
        background: '#0f172a',
        color: '#f8fafc',
        borderRadius: '999px',
        fontSize: '12px',
        fontWeight: '600',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        letterSpacing: '0.02em',
        zIndex: 9997,
        pointerEvents: 'none',
        boxShadow: '0 2px 6px rgba(0,0,0,.15)',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        opacity: '0.92',
      },
    }, `🎨 ${themeName}`);
    document.body.appendChild(badge);
  }

  // ---------- Overlay (pins) ----------
  const overlay = h('div', {
    id: 'excalidraw-chat-overlay',
    style: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9998 },
  });
  document.body.appendChild(overlay);

  // Pick the best viewport coords for a thread:
  //   1. If pinned to an element (elementId), follow that element's position
  //      with the stored offset so the pin moves with the shape.
  //   2. Otherwise, project stored scene coords into the current viewport.
  //   3. Final fallback: stored viewport coords (legacy pins).
  function pinViewport(thread) {
    if (thread.elementId) {
      const el = getElementById(thread.elementId);
      if (el) {
        const ax = thread.anchorX != null ? thread.anchorX : 0.5;
        const ay = thread.anchorY != null ? thread.anchorY : 0.5;
        const sx = el.x + el.width * ax;
        const sy = el.y + el.height * ay;
        const v = sceneToViewport(sx, sy);
        if (v) return v;
      }
    }
    if (thread.sceneX != null && thread.sceneY != null) {
      const v = sceneToViewport(thread.sceneX, thread.sceneY);
      if (v) return v;
    }
    return { x: thread.x, y: thread.y };
  }

  // Pin color reflects who spoke last in the thread.
  function pinColorFor(thread) {
    const last = thread.messages?.length ? thread.messages[thread.messages.length - 1].author : null;
    if (last === 'claude' || last === 'claude-code') return '#8b5cf6'; // violet = Claude
    if (last === 'me' || last === 'user') return '#3b82f6';            // blue   = me
    return '#f59e0b';                                                   // amber  = empty/legacy
  }

  function renderPin(thread) {
    const existing = pins.get(thread.id);
    if (existing) existing.el.remove();

    const v = pinViewport(thread);
    const color = pinColorFor(thread);

    const badge = h('span', {
      style: {
        transform: 'rotate(45deg)',
        fontSize: '12px',
        fontWeight: '700',
        color: '#fff',
        userSelect: 'none',
      },
    }, String(thread.messages?.length ?? 0));

    const pin = h(
      'div',
      {
        class: 'excalidraw-chat-pin',
        title: 'クリック=チャットを開く / ドラッグ=移動 / 右クリック=メニュー',
        style: {
          position: 'absolute',
          left: `${v.x}px`,
          top: `${v.y}px`,
          width: '26px',
          height: '26px',
          borderRadius: '50% 50% 50% 0',
          background: color,
          border: '2px solid white',
          boxShadow: '0 2px 6px rgba(0,0,0,.3)',
          transform: 'translate(-50%, -100%) rotate(-45deg)',
          cursor: 'grab',
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'box-shadow .15s',
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          showPinMenu(thread, e.clientX, e.clientY);
        },
      },
      badge,
    );

    attachPinDrag(pin, thread);

    overlay.appendChild(pin);
    pins.set(thread.id, { thread, el: pin });
    renderListIfOpen();
  }

  function attachPinDrag(pinEl, thread) {
    pinEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const origLeft = parseFloat(pinEl.style.left);
      const origTop = parseFloat(pinEl.style.top);
      let dragging = false;

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) > 4) {
          dragging = true;
          pinEl.style.cursor = 'grabbing';
          pinEl.style.boxShadow = '0 4px 12px rgba(0,0,0,.35)';
        }
        if (dragging) {
          pinEl.style.left = `${origLeft + dx}px`;
          pinEl.style.top = `${origTop + dy}px`;
        }
      };

      const onUp = async (ev) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        pinEl.style.cursor = 'grab';
        pinEl.style.boxShadow = '0 2px 6px rgba(0,0,0,.3)';

        if (dragging) {
          const newX = parseFloat(pinEl.style.left);
          const newY = parseFloat(pinEl.style.top);
          const scene = viewportToScene(newX, newY);
          thread.x = newX;
          thread.y = newY;
          if (scene) { thread.sceneX = scene.sceneX; thread.sceneY = scene.sceneY; }
          await fetch(`${API}/threads/${thread.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              x: newX,
              y: newY,
              sceneX: scene?.sceneX ?? null,
              sceneY: scene?.sceneY ?? null,
              elementId: null,
            }),
          });
        } else {
          openPanel(thread.id);
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  function removePin(threadId) {
    const p = pins.get(threadId);
    if (p) {
      p.el.remove();
      pins.delete(threadId);
    }
  }

  // ---------- Pin floating menu ----------
  let pinMenu = null;
  function showPinMenu(thread, clientX, clientY) {
    closePinMenu();
    const menu = h('div', {
      id: 'excalidraw-chat-pin-menu',
      style: {
        position: 'fixed',
        left: `${clientX}px`,
        top: `${clientY}px`,
        background: 'white',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        boxShadow: '0 6px 20px rgba(0,0,0,.14)',
        zIndex: 10002,
        pointerEvents: 'auto',
        minWidth: '160px',
        padding: '4px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '13px',
      },
    });

    const item = (label, color, onclick) => h('button', {
      type: 'button',
      style: {
        display: 'block',
        width: '100%',
        padding: '8px 10px',
        background: 'transparent',
        border: 'none',
        textAlign: 'left',
        cursor: 'pointer',
        color: color || '#111827',
        borderRadius: '6px',
      },
      onmouseenter: (e) => e.currentTarget.style.background = '#f3f4f6',
      onmouseleave: (e) => e.currentTarget.style.background = 'transparent',
      onclick,
    }, label);

    menu.append(
      item('💬 チャットを開く', null, () => { closePinMenu(); openPanel(thread.id); }),
      item('🗑 削除', '#dc2626', async () => {
        closePinMenu();
        await fetch(`${API}/threads/${thread.id}`, { method: 'DELETE' });
      }),
    );

    document.body.appendChild(menu);
    pinMenu = menu;

    // Dismiss on next click outside
    setTimeout(() => {
      const off = (ev) => {
        if (!menu.contains(ev.target)) closePinMenu();
      };
      document.addEventListener('mousedown', off, { once: true });
      document.addEventListener('contextmenu', off, { once: true });
      menu.__off = off;
    }, 0);
  }
  function closePinMenu() {
    if (pinMenu) { pinMenu.remove(); pinMenu = null; }
  }

  // ---------- Side panel ----------
  const panel = h('div', {
    id: 'excalidraw-chat-panel',
    style: {
      position: 'fixed',
      right: '0',
      top: '0',
      bottom: '0',
      width: '340px',
      background: 'white',
      borderLeft: '1px solid #e5e7eb',
      boxShadow: '-2px 0 12px rgba(0,0,0,.08)',
      zIndex: 10000,
      display: 'none',
      flexDirection: 'column',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '14px',
    },
  });

  const panelHeader = h('div', {
    style: {
      padding: '12px 16px',
      borderBottom: '1px solid #eef0f2',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
  },
    h('strong', {}, 'Chat'),
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('button', {
        id: 'chat-delete',
        title: 'Delete thread',
        style: { border: 'none', background: 'none', cursor: 'pointer', fontSize: '14px', color: '#888' },
        onclick: deleteThread,
      }, 'Delete'),
      h('button', {
        id: 'chat-close',
        title: 'Close',
        style: { border: 'none', background: 'none', cursor: 'pointer', fontSize: '18px' },
        onclick: closePanel,
      }, '×'),
    ),
  );

  const panelMeta = h('div', {
    id: 'chat-meta',
    style: { padding: '8px 16px', fontSize: '11px', color: '#888', borderBottom: '1px solid #f4f5f6' },
  });

  const panelMessages = h('div', {
    id: 'chat-messages',
    style: { flex: '1', overflowY: 'auto', padding: '12px 16px' },
  });

  const panelForm = h('form', {
    id: 'chat-form',
    style: { padding: '12px', borderTop: '1px solid #eef0f2', display: 'flex', gap: '8px' },
    onsubmit: submitMessage,
  },
    h('input', {
      id: 'chat-input',
      type: 'text',
      placeholder: 'メッセージを入力 (例: ここの色を赤くして)',
      autocomplete: 'off',
      style: { flex: '1', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px' },
    }),
    h('button', {
      type: 'submit',
      style: { padding: '8px 14px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' },
    }, '送信'),
  );

  panel.append(panelHeader, panelMeta, panelMessages, panelForm);
  document.body.appendChild(panel);

  function openPanel(threadId) {
    activeThreadId = threadId;
    panel.style.display = 'flex';
    renderMessages();
    setTimeout(() => panel.querySelector('#chat-input')?.focus(), 50);
  }

  function closePanel() {
    activeThreadId = null;
    panel.style.display = 'none';
  }

  // ---------- List panel ----------
  let listOpen = false;

  const listToggle = h('button', {
    id: 'chat-list-toggle',
    title: 'ピン一覧',
    style: {
      position: 'fixed',
      top: '14px',
      right: '14px',
      zIndex: 10001,
      width: '40px',
      height: '40px',
      borderRadius: '8px',
      background: 'white',
      border: '1px solid #e5e7eb',
      boxShadow: '0 1px 3px rgba(0,0,0,.08)',
      cursor: 'pointer',
      fontSize: '18px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    onclick: () => toggleList(),
  }, '📋');
  document.body.appendChild(listToggle);

  const listPanel = h('div', {
    id: 'excalidraw-chat-list',
    style: {
      position: 'fixed',
      top: '60px',
      right: '14px',
      width: '280px',
      maxHeight: '60vh',
      background: 'white',
      border: '1px solid #e5e7eb',
      boxShadow: '0 4px 16px rgba(0,0,0,.12)',
      borderRadius: '10px',
      zIndex: 10001,
      display: 'none',
      flexDirection: 'column',
      overflow: 'hidden',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '13px',
    },
  });
  document.body.appendChild(listPanel);

  function toggleList(force) {
    listOpen = typeof force === 'boolean' ? force : !listOpen;
    listPanel.style.display = listOpen ? 'flex' : 'none';
    listToggle.style.background = listOpen ? '#eff6ff' : 'white';
    if (listOpen) renderList();
  }

  function renderListIfOpen() { if (listOpen) renderList(); }

  function renderList() {
    listPanel.innerHTML = '';
    const head = h('div', {
      style: { padding: '10px 12px', borderBottom: '1px solid #eef0f2', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f9fafb' },
    },
      h('strong', {}, `📌 ピン一覧 (${pins.size})`),
      h('button', {
        style: { border: 'none', background: 'none', cursor: 'pointer', fontSize: '16px', color: '#6b7280' },
        onclick: () => toggleList(false),
      }, '×'),
    );
    listPanel.appendChild(head);

    const body = h('div', { style: { overflowY: 'auto', flex: '1' } });
    listPanel.appendChild(body);

    if (pins.size === 0) {
      body.appendChild(h('div', {
        style: { padding: '20px', color: '#9ca3af', textAlign: 'center' },
      }, 'まだピンがありません。canvasを右クリックして追加できます。'));
      return;
    }

    const sorted = [...pins.values()].sort((a, b) => (b.thread.createdAt || 0) - (a.thread.createdAt || 0));
    for (const { thread } of sorted) {
      const preview = thread.messages[thread.messages.length - 1]?.text || '(メッセージなし)';
      const meta = thread.elementId
        ? `📌 ${thread.elementId.slice(0, 12)}…`
        : `📍 (${Math.round(thread.x)}, ${Math.round(thread.y)})`;
      const item = h('div', {
        style: { padding: '10px 12px', borderBottom: '1px solid #f3f4f6', cursor: 'pointer', display: 'flex', gap: '10px', alignItems: 'center' },
        onmouseenter: (e) => e.currentTarget.style.background = '#f9fafb',
        onmouseleave: (e) => e.currentTarget.style.background = 'white',
        onclick: () => {
          openPanel(thread.id);
          // Flash the pin
          const pin = pins.get(thread.id)?.el;
          if (pin) {
            const o = pin.style.background;
            pin.style.background = '#ef4444';
            setTimeout(() => (pin.style.background = o), 600);
          }
        },
      },
        h('div', { style: { fontSize: '18px', flex: '0 0 auto' } }, '💬'),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', {
            style: { fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '2px' },
          }, preview),
          h('div', { style: { color: '#9ca3af', fontSize: '11px' } }, `${meta} · ${thread.messages.length} msg`),
        ),
        h('button', {
          title: '削除',
          style: { border: 'none', background: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '14px', padding: '4px' },
          onclick: async (e) => {
            e.stopPropagation();
            await fetch(`${API}/threads/${thread.id}`, { method: 'DELETE' });
          },
        }, '🗑'),
      );
      body.appendChild(item);
    }
  }

  async function deleteThread() {
    if (!activeThreadId) return;
    await fetch(`${API}/threads/${activeThreadId}`, { method: 'DELETE' });
    closePanel();
  }

  function renderMessages() {
    if (!activeThreadId) return;
    const p = pins.get(activeThreadId);
    if (!p) return;
    const { thread } = p;
    panelMeta.textContent = thread.elementId
      ? `📌 anchored to: ${thread.elementId}`
      : `📍 position: (${Math.round(thread.x)}, ${Math.round(thread.y)})`;

    panelMessages.innerHTML = '';
    if (thread.messages.length === 0) {
      panelMessages.appendChild(
        h('div', { style: { color: '#9ca3af', fontSize: '13px', textAlign: 'center', padding: '20px' } },
          'メッセージはまだありません'),
      );
    }
    for (const m of thread.messages) {
      const time = new Date(m.ts).toLocaleTimeString();
      const isMe = m.author === 'me' || m.author === 'user';
      const isClaude = m.author === 'claude' || m.author === 'claude-code';
      const label = isClaude ? 'claude code' : isMe ? 'me' : m.author;
      const bubble = h('div', {
        style: { marginBottom: '12px', display: 'flex', flexDirection: 'column', alignItems: isMe ? 'flex-end' : 'flex-start' },
      },
        h('div', { style: { fontSize: '11px', color: '#6b7280', marginBottom: '2px' } }, `${label} · ${time}`),
        h('div', {
          style: {
            background: isMe ? '#dbeafe' : isClaude ? '#ede9fe' : '#f3f4f6',
            color: '#111827',
            padding: '8px 10px',
            borderRadius: '10px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxWidth: '85%',
          },
        }, m.text),
      );
      panelMessages.appendChild(bubble);
    }
    panelMessages.scrollTop = panelMessages.scrollHeight;
    // Update badge count
    const badge = p.el.firstChild;
    if (badge) badge.textContent = String(thread.messages.length);
  }

  async function submitMessage(e) {
    e.preventDefault();
    if (!activeThreadId) return;
    const input = panel.querySelector('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await fetch(`${API}/threads/${activeThreadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'me', text }),
    });
  }

  // ---------- Right-click handler ----------
  function isOnCanvas(target) {
    if (!target || target === document) return false;
    // Skip our own UI
    if (target.closest('#excalidraw-chat-panel, #excalidraw-chat-overlay')) return false;
    // Skip Excalidraw toolbars/menus (heuristics — covers common class names)
    if (target.closest('.App-menu, .Island, .ToolIcon, button, [role="button"], input, textarea, .layer-ui__wrapper__top-right, .App-toolbar')) return false;
    return true;
  }

  document.addEventListener('contextmenu', async (e) => {
    if (!isOnCanvas(e.target)) return;
    e.preventDefault();
    e.stopPropagation();

    const scene = viewportToScene(e.clientX, e.clientY);
    const elementId = scene ? elementAt(scene.sceneX, scene.sceneY) : null;

    // If anchored to an element, record where inside it (0..1) so the pin
    // sticks to that exact spot when the element moves/resizes.
    let anchorX = null, anchorY = null;
    if (elementId && scene) {
      const el = getElementById(elementId);
      if (el && el.width > 0 && el.height > 0) {
        anchorX = (scene.sceneX - el.x) / el.width;
        anchorY = (scene.sceneY - el.y) / el.height;
      }
    }

    try {
      const res = await fetch(`${API}/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x: e.clientX,
          y: e.clientY,
          sceneX: scene?.sceneX ?? null,
          sceneY: scene?.sceneY ?? null,
          elementId,
          anchorX,
          anchorY,
        }),
      });
      const thread = await res.json();
      renderPin(thread);
      openPanel(thread.id);
    } catch (err) {
      console.error('[chat] failed to create thread', err);
    }
  }, true);

  // ---------- WebSocket sync ----------
  function connectWS() {
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      setTimeout(connectWS, 2000);
      return;
    }
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'thread_created') {
        renderPin(msg.thread);
      } else if (msg.type === 'message_added') {
        const p = pins.get(msg.threadId);
        if (p) {
          p.thread.messages.push(msg.message);
          // Re-render the pin so its color reflects the new last author.
          renderPin(p.thread);
          if (activeThreadId === msg.threadId) renderMessages();
          renderListIfOpen();
        }
      } else if (msg.type === 'thread_updated') {
        const p = pins.get(msg.thread.id);
        if (p) {
          p.thread = msg.thread;
          p.el.style.left = `${msg.thread.x}px`;
          p.el.style.top = `${msg.thread.y}px`;
          if (activeThreadId === msg.thread.id) renderMessages();
          renderListIfOpen();
        }
      } else if (msg.type === 'thread_deleted') {
        removePin(msg.threadId);
        if (activeThreadId === msg.threadId) closePanel();
        renderListIfOpen();
      }
    });
    ws.addEventListener('close', () => setTimeout(connectWS, 1500));
    ws.addEventListener('error', () => ws.close());
  }

  // ---------- Boot ----------
  async function load() {
    try {
      const res = await fetch(`${API}/threads`);
      const threads = await res.json();
      threads.forEach(renderPin);
    } catch (err) {
      console.error('[chat] failed to load threads', err);
    }
  }

  // Re-project pins whenever pan/zoom (or viewport size) changes.
  // We watch appState on every animation frame; cheap because we only mutate
  // the DOM when values actually change.
  function startViewportWatcher() {
    let lastKey = '';
    function tick() {
      const s = getAppState();
      if (s) {
        const key = [s.scrollX, s.scrollY, s.zoom?.value, s.offsetLeft, s.offsetTop, s.width, s.height].join('|');
        if (key !== lastKey) {
          lastKey = key;
          for (const { thread, el } of pins.values()) {
            const v = pinViewport(thread);
            el.style.left = `${v.x}px`;
            el.style.top = `${v.y}px`;
          }
          // Backfill scene coords for legacy pins once we have appState.
          maybeBackfillSceneCoords();
        }
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // For pre-existing pins that have viewport coords but no scene coords,
  // compute scene coords once from the current viewport so they stick to
  // canvas content from now on.
  let backfillDone = false;
  async function maybeBackfillSceneCoords() {
    if (backfillDone) return;
    if (!getAppState()) return;
    backfillDone = true;
    for (const { thread } of pins.values()) {
      if (thread.sceneX == null || thread.sceneY == null) {
        const scene = viewportToScene(thread.x, thread.y);
        if (!scene) continue;
        thread.sceneX = scene.sceneX;
        thread.sceneY = scene.sceneY;
        try {
          await fetch(`${API}/threads/${thread.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sceneX: scene.sceneX, sceneY: scene.sceneY }),
          });
        } catch {}
      }
    }
  }

  // Wait briefly so Excalidraw is mounted (for API access)
  setTimeout(() => {
    load();
    connectWS();
    startViewportWatcher();
    syncFilesToBackend();
    setInterval(syncFilesToBackend, 5000);
    console.log('[chat] sidecar ready');
  }, 600);
  } // end runChat
})();
