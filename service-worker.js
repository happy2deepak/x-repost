// RePost for X — Service Worker
// Manages extension state AND acts as a fetch proxy so the content script
// can download twimg media even when CORS blocks a direct fetch.
// Media is streamed back in chunks over a Port so large videos don't hit the
// single-message size limit.

const ALLOWED_MEDIA_HOSTS = new Set(['pbs.twimg.com', 'video.twimg.com']);
const CHUNK_BYTES = 4 * 1024 * 1024;

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
    try {
      const url = new URL(msg.url);
      if (url.protocol !== 'https:' || !ALLOWED_MEDIA_HOSTS.has(url.hostname)) {
        throw new Error(`Blocked media host: ${url.hostname}`);
      }

      const resp = await fetch(url.href, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`.trim());

      const mimeType = resp.headers.get('content-type') ||
                       (msg.mediaType === 'video' ? 'video/mp4' : 'image/jpeg');

      const reader = resp.body.getReader();
      let pending = [];
      let pendingSize = 0;
      let total = 0;

      const flush = () => {
        if (!pendingSize) return;
        port.postMessage({ type: 'chunk', data: bytesToBase64(concatChunks(pending, pendingSize)) });
        pending = [];
        pendingSize = 0;
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (closed) { reader.cancel().catch(() => {}); return; }
        pending.push(value);
        pendingSize += value.length;
        total += value.length;
        if (pendingSize >= CHUNK_BYTES) flush();
      }
      flush();

      port.postMessage({ type: 'done', mimeType, size: total });
    } catch (err) {
      console.error('[RePost for X SW] Fetch error:', err);
      if (!closed) port.postMessage({ type: 'error', error: err.message });
    }
  });
});
