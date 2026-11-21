// =====================================================================
// RePost for X — Page Bridge (Main World)
// Runs inside the page's own JavaScript context, so it can read React
// Fiber data and dispatch events React handles natively.
// Protocol: content script posts XRP_REQ_<NAME> {reqId, ...};
//           bridge answers  XRP_RES_<NAME> {reqId, ...}.
// =====================================================================

'use strict';

(() => {
  const ARTICLE_SEL  = 'article[data-testid="tweet"]';
  const TEXTAREA_SEL = '[data-testid="tweetTextarea_0"]';
  const COMPOSE_BTN_SELS = [
    '[data-testid="SideNav_NewTweet_Button"]',
    'header[role="banner"] a[href*="/compose/post"]',
    'a[href*="/compose/post"]',
    'a[href*="/compose/tweet"]',
    '[data-testid="FloatingActionButton"]',
  ];

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isVisible = el => Boolean(el && (el.offsetParent !== null || el.getClientRects().length > 0));

  function triggerNativeClick(el) {
    if (!el) return false;
    const inner = el.querySelector('div, span') || el;
    const opts = { bubbles: true, cancelable: true, view: window, buttons: 1, detail: 1 };
    const fire = (Ctor, name) => {
      if (typeof Ctor === 'undefined') return;
      try { inner.dispatchEvent(new Ctor(name, opts)); } catch (_) {}
      try { el.dispatchEvent(new Ctor(name, opts)); } catch (_) {}
    };
    fire(window.PointerEvent, 'pointerdown');
    fire(MouseEvent, 'mousedown');
    fire(window.PointerEvent, 'pointerup');
    fire(MouseEvent, 'mouseup');
    try { el.click(); } catch (_) {}
    return true;
  }

  // Only the modal composer (or the full-page /compose route) counts —
  // never the inline Home box or a post's reply box.
  function findVisibleComposer() {
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (dialog.closest('.xrp-overlay')) continue;
      const ta = dialog.querySelector(TEXTAREA_SEL);
      if (isVisible(ta)) return ta;
    }
    if (location.pathname.startsWith('/compose/')) {
      // Skip the page's own Home / inline-reply boxes behind the composer
      const tas = [...document.querySelectorAll(TEXTAREA_SEL)].filter(isVisible);
      const pageOf = ta => ta.closest('[data-testid="primaryColumn"], main');
      return tas.find(ta => !pageOf(ta)) ||
             tas.find(ta => !pageOf(ta).querySelector(ARTICLE_SEL)) ||
             null;
    }
    return null;
  }

  async function waitForComposer(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (findVisibleComposer()) return true;
      await sleep(150);
    }
    return Boolean(findVisibleComposer());
  }

  function findComposeButton() {
    for (const sel of COMPOSE_BTN_SELS) {
      const els = [...document.querySelectorAll(sel)].filter(el => !el.closest(ARTICLE_SEL));
      const el = els.find(isVisible) || els[0];
      if (el) return el;
    }
    return null;
  }

  async function openComposerInPageWorld() {
    if (findVisibleComposer()) return true;

    // 1. Click the compose button
    const btn = findComposeButton();
    if (btn) {
      triggerNativeClick(btn);
      if (await waitForComposer(1500)) return true;
    }

    // 2. Client-side route to /compose/post
    const startPath = location.pathname + location.search + location.hash;
    let pushed = false;
    try {
      window.history.pushState(window.history.state, '', '/compose/post');
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
      pushed = true;
    } catch (_) {}
    if (await waitForComposer(2000)) return true;

    // 3. Keyboard shortcut 'n'
    const eventInit = { key: 'n', code: 'KeyN', keyCode: 78, which: 78, charCode: 110, bubbles: true, cancelable: true, view: window };
    document.body.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    document.body.dispatchEvent(new KeyboardEvent('keyup', eventInit));
    if (await waitForComposer(1500)) return true;

    // Failed — don't leave the address bar stuck on /compose/post
    if (pushed && location.pathname.startsWith('/compose/')) {
      if (location.pathname + location.search + location.hash !== startPath) window.history.back();
    }
    return false;
  }

  // ─── Video URL from React Fiber ──────────────────────────────────────────
  // X's player creates the <video> element outside React, so it has no fiber —
  // climb the DOM to the nearest element React rendered.
  function getFiber(el) {
    for (let node = el, hops = 0; node && hops < 15; node = node.parentElement, hops++) {
      const key = Object.keys(node).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (key) return node[key];
    }
    return null;
  }

  const variantsHaveId = (variants, mediaId) =>
    Boolean(mediaId) && Array.isArray(variants) && variants.some(v => typeof v?.url === 'string' && v.url.includes(`/${mediaId}/`));

  function bestMp4(variants) {
    if (!Array.isArray(variants)) return null;
    const mp4s = variants
      .filter(v => v && v.content_type === 'video/mp4' && typeof v.url === 'string' && !v.url.includes('.m3u8'))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return mp4s.length ? mp4s[0].url : null;
  }

  function mediaMatches(m, mediaId) {
    if (!mediaId || !m) return false;
    return m.id_str === mediaId || String(m.id) === mediaId ||
           (typeof m.media_url_https === 'string' && m.media_url_https.includes(`/${mediaId}/`)) ||
           variantsHaveId(m.video_info?.variants, mediaId);
  }

  // Walk UP from the clicked media element; the first media list met belongs to
  // the nearest post (the quoted post when the media is inside a quote).
  function findMp4FromFiber(element, mediaId) {
    if (!element) return null;
    let fallback = null;

    let curr = getFiber(element);
    let depth = 0;
    while (curr && depth < 60) {
      depth++;
      const props = curr.memoizedProps || curr.pendingProps;
      if (props && typeof props === 'object') {
        const tweet = props.tweet || props.result;
        const list = tweet?.extended_entities?.media || tweet?.legacy?.extended_entities?.media ||
                     tweet?.entities?.media || props.media || (Array.isArray(props.items) ? props.items : null);
        if (Array.isArray(list)) {
          for (const m of list) {
            const url = bestMp4(m?.video_info?.variants);
            if (!url) continue;
            if (mediaMatches(m, mediaId)) return url;
            if (!fallback) fallback = url;
          }
        }

        // Current X video player: props.source = { variants: [{bitrate, content_type, url}], videoId, … }
        const playerVariants = props.source?.variants;
        const fromPlayer = bestMp4(playerVariants);
        if (fromPlayer && (!mediaId || variantsHaveId(playerVariants, mediaId))) return fromPlayer;
        if (fromPlayer && !fallback) fallback = fromPlayer;

        const own = bestMp4(props.video_info?.variants);
        if (own && (!mediaId || mediaMatches(props, mediaId))) return own;
        if (own && !fallback) fallback = own;

        const playerUrl = props.videoSource?.url || props.playerState?.currentUrl;
        if (typeof playerUrl === 'string' && /^https:\/\/video\.twimg\.com\/[^?#]+\.mp4/.test(playerUrl)) {
          if (!mediaId || playerUrl.includes(`/${mediaId}/`)) return playerUrl;
          if (!fallback) fallback = playerUrl;
        }
      }
      curr = curr.return;
    }
    // With a known media ID, a non-matching URL would be some other post's video
    return mediaId ? null : fallback;
  }

  const HLS_FRAGMENT_RE = /\/vid\/[^/]+\/\d+\/\d+\//;

  function findMp4FromPerformance(mediaId) {
    if (!mediaId) return null;
    try {
      const candidates = performance.getEntriesByType('resource')
        .map(e => e.name)
        .filter(n => /^https:\/\/video\.twimg\.com\/[^?#]+\.mp4/.test(n) && n.includes(`/${mediaId}/`) && !HLS_FRAGMENT_RE.test(n));
      const area = n => { const m = n.match(/\/(\d+)x(\d+)\//); return m ? m[1] * m[2] : 0; };
      return candidates.sort((a, b) => area(b) - area(a))[0] || null;
    } catch (_) {
      return null;
    }
  }

  // ─── Message handling ────────────────────────────────────────────────────
  const reply = (type, reqId, data) => window.postMessage({ ...data, type, reqId }, '*');

  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || typeof event.data.type !== 'string') return;
    if (!event.data.type.startsWith('XRP_REQ_')) return;

    const { type, reqId } = event.data;

    if (type === 'XRP_REQ_PING') {
      reply('XRP_RES_PING', reqId, {});
    } else if (type === 'XRP_REQ_EXTRACT_VIDEO') {
      const id = String(event.data.extractId || '');
      const el = id ? document.querySelector(`[data-xrp-extract-id="${CSS.escape(id)}"]`) : null;
      const mediaId = event.data.mediaId || null;
      const videoUrl = el ? (findMp4FromFiber(el, mediaId) || findMp4FromPerformance(mediaId)) : null;
      reply('XRP_RES_EXTRACT_VIDEO', reqId, { videoUrl });
    } else if (type === 'XRP_REQ_OPEN_COMPOSER') {
      const success = await openComposerInPageWorld();
      reply('XRP_RES_OPEN_COMPOSER', reqId, { success });
    }
  });

  window.postMessage({ type: 'XRP_BRIDGE_READY' }, '*');
})();
