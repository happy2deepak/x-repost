// RePost for X — Service Worker
// Manages extension state AND acts as a fetch proxy so the content script
// can download twimg media even when CORS blocks a direct fetch.
// Media is streamed back in chunks over a Port so large videos don't hit the
// single-message size limit.

const ALLOWED_MEDIA_HOSTS = new Set(['pbs.twimg.com', 'video.twimg.com']);
const CHUNK_BYTES = 4 * 1024 * 1024;
const STALL_MS = 20000;      // abort when no bytes arrive for this long
const PROGRESS_MS = 300;     // progress update cadence between chunks

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Only set defaults on first install — updates must keep the user's choice.
  if (reason !== 'install') return;
  await chrome.storage.local.set({ enabled: true, lastStatus: null });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_STATE') {
    (async () => {
      const { enabled = true, lastStatus = null } =
        await chrome.storage.local.get(['enabled', 'lastStatus']);
      sendResponse({ enabled, lastStatus });
    })();
    return true;
  }

  if (message.type === 'SET_STATE') {
    (async () => {
      await chrome.storage.local.set({ enabled: message.enabled });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'SET_STATUS') {
    (async () => {
      await chrome.storage.local.set({ lastStatus: { ...message.status, at: Date.now() } });
      sendResponse({ ok: true });
    })();
    return true;
  }
});

function bytesToBase64(bytes) {
  let binary = '';
  const step = 8192;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function concatChunks(chunks, size) {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// ── Media fetch proxy (Port: "xrp-fetch") ────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'xrp-fetch') return;

  let closed = false;
  port.onDisconnect.addListener(() => { closed = true; });

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'fetch') return;

    // Abort if no bytes arrive for STALL_MS (covers both connect and mid-stream stalls)
    const ctrl = new AbortController();
    let stalled = false;
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; ctrl.abort(); }, STALL_MS);
    };

    try {
      const url = new URL(msg.url);
      if (url.protocol !== 'https:' || !ALLOWED_MEDIA_HOSTS.has(url.hostname)) {
        throw new Error(`Blocked media host: ${url.hostname}`);
      }

      arm();
      const resp = await fetch(url.href, { cache: 'no-store', signal: ctrl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`.trim());

      const mimeType = resp.headers.get('content-type') ||
                       (msg.mediaType === 'video' ? 'video/mp4' : 'image/jpeg');
      const expected = Number(resp.headers.get('content-length')) || 0;

      const reader = resp.body.getReader();
      let pending = [];
      let pendingSize = 0;
      let received = 0;
      let lastProgress = 0;

      const flush = () => {
        if (!pendingSize) return;
        port.postMessage({ type: 'chunk', data: bytesToBase64(concatChunks(pending, pendingSize)), total: expected });
        pending = [];
        pendingSize = 0;
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (closed) { reader.cancel().catch(() => {}); return; }
        arm();
        pending.push(value);
        pendingSize += value.length;
        received += value.length;
        if (pendingSize >= CHUNK_BYTES) {
          flush();
        } else if (Date.now() - lastProgress > PROGRESS_MS) {
          lastProgress = Date.now();
          port.postMessage({ type: 'progress', received, total: expected });
        }
      }
      flush();

      port.postMessage({ type: 'done', mimeType, size: received });
    } catch (err) {
      const message = stalled ? 'download stalled (no data for 20 seconds)' : err.message;
      console.error('[RePost for X SW] Fetch error:', message);
      if (!closed) port.postMessage({ type: 'error', error: message });
    } finally {
      clearTimeout(timer);
    }
  });
});
