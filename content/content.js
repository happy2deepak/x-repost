// =====================================================================
// RePost for X — Content Script
// Injects a floating "RePost" button on X.com posts that contain
// images or videos. On click, downloads the media and fills the
// X.com new-post composer with it and the original caption.
// No external API calls — everything runs in the same browser tab.
// =====================================================================

'use strict';

// ─── Selectors ────────────────────────────────────────────────────────────────
const SEL = {
  article:    'article[data-testid="tweet"]',
  tweetText:  '[data-testid="tweetText"]',
  tweetPhoto: '[data-testid="tweetPhoto"]',
  videoComp:  '[data-testid="videoComponent"]',

  composerTextarea: '[data-testid="tweetTextarea_0"]',

  // Compose button (sidebar / floating action button)
  newTweetBtns: [
    '[data-testid="SideNav_NewTweet_Button"]',
    'header[role="banner"] a[href*="/compose/post"]',
    'a[href*="/compose/post"]',
    'a[href*="/compose/tweet"]',
    '[data-testid="FloatingActionButton"]',
  ],

  // Contenteditable editor — always searched INSIDE the composer root
  composerEditor: [
    '[data-testid="tweetTextarea_0"][contenteditable="true"]',
    '[data-testid="tweetTextarea_0"] [contenteditable="true"]',
    '[data-testid="tweetTextarea_0"] [role="textbox"]',
    '.public-DraftEditor-content[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
  ],

  // Anything that means the open composer is a reply / quote, not a new post
  replyMarkers: '[data-testid="replyingToText"], article[data-testid="tweet"], [data-testid="quoteTweet"]',

  attachments: '[data-testid="attachments"]',
  fileInput:   'input[data-testid="fileInput"], input[type="file"]',
};

const MAX_WEIGHT = 280;   // X's weighted character limit for non-Premium accounts
const MAX_IMAGES = 4;     // X allows up to 4 images per post
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// ─── Small helpers ────────────────────────────────────────────────────────────
function isElementVisible(el) {
  if (!el) return false;
  return Boolean(el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0));
}

function queryAny(selectors, root = document) {
  for (const sel of selectors) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch (_) { /* invalid selector, skip */ }
  }
  return null;
}

function queryAnyVisible(selectors, root = document) {
  for (const sel of selectors) {
    try {
      for (const el of root.querySelectorAll(sel)) {
        if (isElementVisible(el)) return el;
      }
    } catch (_) { /* invalid selector, skip */ }
  }
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Poll `fn` until it returns a truthy value or the timeout passes.
async function waitFor(fn, timeout = 5000, interval = 150) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value = null;
    try { value = fn(); } catch (_) {}
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(interval);
  }
}

function isLoggedOut() {
  const hasLoginBtn = document.querySelector(
    '[data-testid="loginButton"], [data-testid="signupButton"], a[href="/login"], a[href="/i/flow/login"]'
  );
  const hasUserAccount = document.querySelector(
    '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"], [aria-label="Account menu"]'
  );
  return Boolean(hasLoginBtn && !hasUserAccount);
}

// ─── State ────────────────────────────────────────────────────────────────────
let isEnabled = true;
let toastEl   = null;
let toastTimeout = null;
let observer  = null;
let activePreviewDismiss = null;
const pendingArticles = new Set();
let flushTimer = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    isEnabled = response?.enabled ?? true;
  } catch (_) {
    isEnabled = true;
  }
  if (isEnabled) startObserver();
}

// ─── Runtime message listener (from popup toggle) ─────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'TOGGLE_ENABLED') return;
  isEnabled = message.enabled;
  if (isEnabled) {
    startObserver();
  } else {
    stopObserver();
    removeAllButtons();
  }
});

function removeAllButtons() {
  document.querySelectorAll('.xrp-action, .xrp-repost-btn').forEach(el => el.remove());
  document.querySelectorAll('.xrp-host').forEach(el => el.classList.remove('xrp-host'));
}

// ─── MutationObserver ─────────────────────────────────────────────────────────
function startObserver() {
  if (observer) return;
  document.querySelectorAll(SEL.article).forEach(queueArticle);

  observer = new MutationObserver((mutations) => {
    if (!isEnabled) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== ELEMENT_NODE) continue;
        if (node.classList?.contains('xrp-repost-btn') || node.classList?.contains('xrp-action')) continue;
        // Media often renders AFTER the article itself — re-check the owning article
        const owner = node.closest?.(SEL.article);
        if (owner) queueArticle(owner);
        node.querySelectorAll?.(SEL.article).forEach(queueArticle);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
  pendingArticles.clear();
  clearTimeout(flushTimer);
  flushTimer = null;
}

function queueArticle(article) {
  pendingArticles.add(article);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const batch = [...pendingArticles];
    pendingArticles.clear();
    if (isEnabled) batch.forEach(processArticle);
  }, 50);
}

// ─── Article Processing ───────────────────────────────────────────────────────
// A quoted post renders inside a div[role="link"] within the outer article.
function getQuoteRoot(el, article) {
  const q = el.closest('div[role="link"]');
  return q && q !== article && article.contains(q) ? q : null;
}

function scopeOf(el, article) {
  return getQuoteRoot(el, article) || article;
}

// Group media by owner: the post itself, or a quoted post inside it.
function getMediaGroups(article) {
  const groups = new Map();
  const els = article.querySelectorAll(`${SEL.tweetPhoto}, ${SEL.videoComp}, video`);
  for (const el of els) {
    const scope = scopeOf(el, article);
    if (groups.has(scope)) continue;
    const host = el.closest(SEL.tweetPhoto) || el.closest(SEL.videoComp) || el.parentElement;
    if (host) groups.set(scope, host);
  }
  return [...groups.entries()].map(([scope, host]) => ({ scope, host }));
}

// The post's native action bar (reply · repost · like · views · bookmark · share).
// Quoted posts have no action bar of their own, so this is always the outer post's.
function findActionBar(article) {
  return [...article.querySelectorAll('[role="group"]')].find(g =>
    g.closest(SEL.article) === article &&
    g.querySelector('[data-testid="reply"], [data-testid="like"], [data-testid="unlike"]')
  ) || null;
}

// Which media the action-bar button reposts: the post's own, else the quoted post's.
function pickMediaScope(article) {
  const groups = getMediaGroups(article);
  return (groups.find(g => g.scope === article) || groups[0])?.scope || null;
}

const GLYPH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="13" height="13" rx="3"/><path d="M10 14 20 4M13.5 4H20v6.5"/></svg>`;

function makeButton(className) {
  const btn = document.createElement('button');
  btn.className = className;
  btn.type = 'button';
  btn.title = 'RePost this media';
  btn.setAttribute('aria-label', 'RePost this media');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!btn.disabled) handleRepostClick(btn);
  });
  return btn;
}

// Idempotent: safe to call repeatedly; re-adds the button if React removed it.
function processArticle(article) {
  if (!article.isConnected) return;
  const groups = getMediaGroups(article);
  const bar = findActionBar(article);
  const existing = bar?.querySelector(':scope > .xrp-action');

  if (!groups.length) { existing?.remove(); return; }

  if (bar) {
    // Inline in the action bar — drop any overlay added before the bar rendered
    article.querySelectorAll('.xrp-repost-btn--overlay').forEach(b => b.remove());
    if (!existing) ensureActionButton(bar);
  } else {
    // No action bar in this layout — fall back to a floating button on the media
    for (const { host } of groups) ensureOverlayButton(host);
  }
}

// ─── Button Injection ─────────────────────────────────────────────────────────
function ensureActionButton(bar) {
  const wrap = document.createElement('div');
  wrap.className = 'xrp-action';
  const btn = makeButton('xrp-repost-btn xrp-repost-btn--inline');
  btn.innerHTML = `<span class="xrp-action-icon">${GLYPH_SVG}</span>`;
  wrap.appendChild(btn);

  // Sit just before the bookmark/share cluster (the bar's last item)
  const last = bar.lastElementChild;
  if (last && bar.children.length > 1) bar.insertBefore(wrap, last);
  else bar.appendChild(wrap);
}

function ensureOverlayButton(host) {
  if (host.querySelector(':scope > .xrp-repost-btn')) return;

  const cs = window.getComputedStyle(host);
  if (cs.position === 'static') host.style.position = 'relative';
  host.classList.add('xrp-host');

  const btn = makeButton('xrp-repost-btn xrp-repost-btn--overlay');
  btn.innerHTML = `${GLYPH_SVG}<span>RePost</span>`;
  host.appendChild(btn);
}

// ─── RePost Click Handler ─────────────────────────────────────────────────────
async function handleRepostClick(btn) {
  btn.disabled = true;

  try {
    const article = btn.closest(SEL.article);
    if (!article) throw new Error('This post is no longer on the page.');
    const scope = btn.classList.contains('xrp-repost-btn--inline') ? pickMediaScope(article) : scopeOf(btn, article);
    if (!scope) throw new Error('This post has no photo or video to repost.');

    // Media type is decided at click time, so lazily-loaded videos are detected
    const media = await collectMedia(article, scope);
    if (!media) {
      showToast('Could not detect media URL. Try again.', 'error');
      btn.disabled = false;
      return;
    }

    // Leave room for the "via @handle" credit so it never pushes the post over the limit
    const handle = extractAuthorHandle(article, scope);
    const reserve = handle ? weightedLength(creditSuffix(handle)) : 0;
    const caption = truncateToWeight(extractCaption(article, scope), MAX_WEIGHT - reserve);

    showPreviewPanel({ caption, media, handle }, async (confirmed, editedCaption) => {
      if (!confirmed) { btn.disabled = false; return; }

      try {
        await executeRepost({ media, caption: editedCaption });
        chrome.runtime.sendMessage({ type: 'SET_STATUS', status: { type: 'ready' } }).catch(() => {});
      } catch (err) {
        console.warn('[RePost for X] Repost failed:', err?.message || err);
        showToast(`Failed: ${err.message}`, 'error');
        chrome.runtime.sendMessage({ type: 'SET_STATUS', status: { type: 'error', message: err.message } }).catch(() => {});
      } finally {
        btn.disabled = false;
      }
    });
  } catch (err) {
    console.warn('[RePost for X] Repost initialization error:', err?.message || err);
    showToast(`Error: ${err.message}`, 'error');
    btn.disabled = false;
  }
}

// ─── Caption Extraction ───────────────────────────────────────────────────────
// Walk the DOM instead of using innerText: X renders emoji as <img alt="…">
// (innerText drops them) and shows links as truncated "example.com/ab…" text.
function nodeToText(node) {
  if (node.nodeType === TEXT_NODE) return node.nodeValue;
  if (node.nodeType !== ELEMENT_NODE) return '';
  const tag = node.tagName;
  if (tag === 'IMG') return node.getAttribute('alt') || '';
  if (tag === 'BR') return '\n';
  if (tag === 'A') {
    const href = node.getAttribute('href') || '';
    if (/^https?:\/\/t\.co\//i.test(href)) return href;   // full shortened link
  }
  let out = '';
  for (const child of node.childNodes) out += nodeToText(child);
  return out;
}

function extractCaption(article, scope = article) {
  const textEl = [...scope.querySelectorAll(SEL.tweetText)].find(el => scopeOf(el, article) === scope);
  return textEl ? nodeToText(textEl).trim() : '';
}

// ─── Attribution ──────────────────────────────────────────────────────────────
// The author's @handle, read from the post's (or quoted post's) name row.
const HANDLE_RE = /@([A-Za-z0-9_]{1,15})\b/;

function extractAuthorHandle(article, scope = article) {
  const nameEl = [...scope.querySelectorAll('[data-testid="User-Name"]')].find(el => scopeOf(el, article) === scope);
  const m = nameEl?.textContent.match(HANDLE_RE);
  return m ? m[1] : null;
}

function creditSuffix(handle) {
  return `\n\nvia @${handle}`;
}

// Final post text: the edited caption plus the credit line when enabled.
function composeCaption(caption, handle, credit) {
  const text = (caption || '').trim();
  if (!handle || !credit) return text;
  return text ? text + creditSuffix(handle) : `via @${handle}`;
}

// ─── Weighted length (approximation of twitter-text v3) ───────────────────────
const URL_RE = /https?:\/\/[^\s]+/g;
const URL_WEIGHT = 23;

function isLightCodePoint(cp) {
  return (cp >= 0 && cp <= 4351) || (cp >= 8192 && cp <= 8205) ||
         (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
}

function splitGraphemes(str) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str)].map(s => s.segment);
  }
  return Array.from(str);
}

function graphemeWeight(g) {
  if (/\p{Extended_Pictographic}/u.test(g)) return 2;
  return isLightCodePoint(g.codePointAt(0)) ? 1 : 2;
}

// Tokens: { text, weight, atomic } — URLs are atomic and weigh 23.
function tokenizeWeighted(text) {
  const tokens = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    for (const g of splitGraphemes(text.slice(last, m.index))) tokens.push({ text: g, weight: graphemeWeight(g) });
    tokens.push({ text: m[0], weight: URL_WEIGHT });
    last = m.index + m[0].length;
  }
  for (const g of splitGraphemes(text.slice(last))) tokens.push({ text: g, weight: graphemeWeight(g) });
  return tokens;
}

function weightedLength(text) {
  return tokenizeWeighted(text || '').reduce((sum, t) => sum + t.weight, 0);
}

function truncateToWeight(text, max = MAX_WEIGHT) {
  if (!text) return '';
  let total = 0;
  let out = '';
  for (const t of tokenizeWeighted(text)) {
    if (total + t.weight > max) break;
    total += t.weight;
    out += t.text;
  }
  return out.trimEnd();
}

// ─── Media Extraction ─────────────────────────────────────────────────────────
function upgradeImageUrl(src) {
  try {
    const url = new URL(src);
    url.searchParams.set('format', url.searchParams.get('format') || 'jpg');
    url.searchParams.set('name', 'orig');
    return url.href;
  } catch (_) {
    return null;
  }
}

// Video posters encode the media ID:
//   GIF:   pbs.twimg.com/tweet_video_thumb/<key>.jpg      → video.twimg.com/tweet_video/<key>.mp4
//   Video: pbs.twimg.com/ext_tw_video_thumb/<id>/pu/img/…  (or amplify_video_thumb/<id>/…)
function parseVideoPoster(url) {
  if (!url) return null;
  let m = url.match(/tweet_video_thumb\/([A-Za-z0-9_-]+)\./);
  if (m) return { kind: 'gif', key: m[1] };
  m = url.match(/(?:ext_tw_video_thumb|amplify_video_thumb)\/(\d+)\//);
  if (m) return { kind: 'video', mediaId: m[1] };
  return null;
}

function isMp4Url(u) {
  return typeof u === 'string' && /^https:\/\/video\.twimg\.com\/[^?#]+\.mp4(\?|#|$)/i.test(u);
}

// HLS time-range fragments look like …/vid/avc1/0/3000/1280x720/… — never whole files.
const HLS_FRAGMENT_RE = /\/vid\/[^/]+\/\d+\/\d+\//;

// Only accept network entries that belong to THIS video's media ID.
function findMp4FromPerformance(mediaId) {
  if (!mediaId) return null;
  try {
    const candidates = performance.getEntriesByType('resource')
      .map(e => e.name)
      .filter(n => isMp4Url(n) && n.includes(`/${mediaId}/`) && !HLS_FRAGMENT_RE.test(n));
    if (!candidates.length) return null;
    const area = n => { const m = n.match(/\/(\d+)x(\d+)\//); return m ? m[1] * m[2] : 0; };
    return candidates.sort((a, b) => area(b) - area(a))[0];
  } catch (_) {
    return null;
  }
}

async function extractVideoUrl(target, posterUrl) {
  const ids = parseVideoPoster(posterUrl);
  if (ids?.kind === 'gif') return `https://video.twimg.com/tweet_video/${ids.key}.mp4`;

  // 1. React Fiber lookup via page-bridge (MAIN world — the only place Fiber is visible)
  if (target) {
    const extractId = `xrp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    target.setAttribute('data-xrp-extract-id', extractId);
    try {
      const res = await callBridge('XRP_REQ_EXTRACT_VIDEO', 2500, { extractId, mediaId: ids?.mediaId || null });
      if (isMp4Url(res?.videoUrl)) return res.videoUrl;
    } finally {
      target.removeAttribute('data-xrp-extract-id');
    }
  }

  // 2. Direct MP4 on the <video>/<source> element
  if (target?.tagName === 'VIDEO') {
    if (isMp4Url(target.src)) return target.src;
    for (const s of target.querySelectorAll('source')) {
      if (isMp4Url(s.src)) return s.src;
    }
  }

  // 3. Network entries matching this video's media ID
  return findMp4FromPerformance(ids?.mediaId);
}

// Returns { type: 'video'|'image', urls: [...] } for the given post / quoted post.
async function collectMedia(article, scope) {
  const inScope = el => scopeOf(el, article) === scope;

  const video = [...scope.querySelectorAll('video')].find(inScope) || null;
  const imgs  = [...scope.querySelectorAll(`${SEL.tweetPhoto} img`)].filter(inScope);
  const videoThumb = imgs.find(i => /_video_thumb\//.test(i.src));

  if (video || videoThumb) {
    const poster = video?.poster || videoThumb?.src || '';
    const url = await extractVideoUrl(video || videoThumb, poster);
    return url ? { type: 'video', urls: [url] } : null;
  }

  const urls = [...new Set(
    imgs.filter(i => /pbs\.twimg\.com\/media\//.test(i.src))
        .map(i => upgradeImageUrl(i.src))
        .filter(Boolean)
  )].slice(0, MAX_IMAGES);

  return urls.length ? { type: 'image', urls } : null;
}

// ─── Preview Panel ────────────────────────────────────────────────────────────
// Built with DOM APIs only — post text and URLs are never parsed as HTML.
function showPreviewPanel({ caption, media, handle = null }, callback) {
  // Cancel any panel that is already open so its button is re-enabled
  activePreviewDismiss?.(false);

  const overlay = document.createElement('div');
  overlay.className = 'xrp-overlay';
  overlay.innerHTML = `
    <div class="xrp-preview" role="dialog" aria-modal="true" aria-label="Confirm RePost">
      <div class="xrp-preview-header">
        <svg class="xrp-preview-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="13" height="13" rx="3"/><path d="M10 14 20 4M13.5 4H20v6.5"/>
        </svg>
        <h3>Confirm RePost</h3>
        <button class="xrp-close-btn" aria-label="Cancel" data-xrp="close">✕</button>
      </div>
      <div class="xrp-preview-media" data-xrp="media">
        <span class="xrp-preview-media-badge" data-xrp="badge"></span>
      </div>
      <div class="xrp-preview-caption">
        <label class="xrp-caption-label" for="xrp-caption-input">Caption <span class="xrp-char-count" data-xrp="count"></span></label>
        <textarea id="xrp-caption-input" class="xrp-caption-input" placeholder="Write a caption…" spellcheck="true"></textarea>
        <label class="xrp-credit" data-xrp="credit-row" hidden>
          <input type="checkbox" data-xrp="credit" checked>
          <span data-xrp="credit-text"></span>
        </label>
      </div>
      <div class="xrp-preview-actions">
        <button class="xrp-btn-cancel" data-xrp="cancel">Cancel</button>
        <button class="xrp-btn-confirm" data-xrp="confirm">↩ RePost</button>
      </div>
    </div>
  `;

  const $ = name => overlay.querySelector(`[data-xrp="${name}"]`);
  const mediaBox  = $('media');
  const badge     = $('badge');
  const charCount = $('count');
  const textarea  = overlay.querySelector('#xrp-caption-input');

  if (media.type === 'video') {
    const v = document.createElement('video');
    v.src = media.urls[0];
    v.autoplay = true; v.muted = true; v.loop = true; v.playsInline = true;
    mediaBox.insertBefore(v, badge);
    badge.textContent = 'video';
  } else {
    if (media.urls.length > 1) mediaBox.classList.add('xrp-preview-media--grid');
    for (const url of media.urls) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Media to repost';
      mediaBox.insertBefore(img, badge);
    }
    badge.textContent = media.urls.length > 1 ? `${media.urls.length} images` : 'image';
  }

  textarea.value = caption;

  const creditBox = $('credit');
  if (handle) {
    $('credit-row').hidden = false;
    $('credit-text').textContent = `Credit the original author (adds "via @${handle}")`;   // never parsed as HTML
  }
  const finalText = () => composeCaption(textarea.value, handle, creditBox.checked);

  const updateCount = () => {
    const len = weightedLength(finalText());
    charCount.textContent = `${len}/${MAX_WEIGHT}`;
    charCount.classList.toggle('xrp-char-count--warn', len > MAX_WEIGHT - 20 && len <= MAX_WEIGHT);
    charCount.classList.toggle('xrp-char-count--over', len > MAX_WEIGHT);
    charCount.title = len > MAX_WEIGHT ? 'Over 280 — only Premium accounts can post this' : '';
  };
  textarea.addEventListener('input', updateCount);
  creditBox.addEventListener('change', updateCount);
  updateCount();

  let done = false;
  const onKey = (e) => { if (e.key === 'Escape') dismiss(false); };
  const dismiss = (confirmed) => {
    if (done) return;
    done = true;
    if (activePreviewDismiss === dismiss) activePreviewDismiss = null;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    callback(confirmed, finalText());
  };
  activePreviewDismiss = dismiss;

  $('close').addEventListener('click',   () => dismiss(false));
  $('cancel').addEventListener('click',  () => dismiss(false));
  $('confirm').addEventListener('click', () => dismiss(true));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(false); });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
}

// ─── Core Repost Flow ─────────────────────────────────────────────────────────
async function executeRepost({ media, caption }) {
  // Step 1 — Download media before touching the composer
  const n = media.urls.length;
  const label = i => n > 1 ? `Downloading image ${i + 1} of ${n}…` : `Downloading ${media.type}…`;
  updateToast(label(0), 'progress', 5);
  const files = [];
  for (let i = 0; i < n; i++) {
    let lastPaint = 0;
    files.push(await fetchMediaFile(media.urls[i], media.type, i, (got, total) => {
      const now = Date.now();
      if (now - lastPaint < 200) return;   // throttle DOM updates
      lastPaint = now;
      const sizeText = total ? `${formatMB(got)} / ${formatMB(total)} MB` : `${formatMB(got)} MB`;
      const overall = (i + (total ? Math.min(got / total, 1) : 0)) / n;
      updateToast(`${label(i)} ${sizeText}`, 'progress', 5 + overall * 25);
    }));
  }

  // Step 2 — Open a fresh new-post composer (never a reply / quote)
  updateToast('Opening composer…', 'progress', 30);
  let root = await openFreshComposer();

  // Step 3 — Editor inside THAT composer
  updateToast('Waiting for composer…', 'progress', 42);
  const editor = await waitFor(() => findEditor(root), 8000);
  if (!editor) throw new Error('Composer opened but editor not found. X.com may have updated their UI.');
  await sleep(300);

  // Step 4 — Attach media via the composer's file input
  updateToast('Attaching media…', 'progress', 55);
  const attached = await injectFiles(files, root);
  if (!attached) throw new Error('Could not attach media. Try clicking the 🖼 icon in the composer manually.');

  // Step 5 — Wait for X to accept and upload it
  updateToast('Uploading media to X…', 'progress', 70);
  const uploaded = await waitForUploadComplete(root);

  // Step 6 — Type caption (re-query: React may have re-rendered the composer)
  let typed = true;
  if (caption) {
    updateToast('Writing caption…', 'progress', 86);
    root = findComposerRoot() || root;
    typed = await typeCaption(findEditor(root) || editor, caption);
  }

  // Step 7 — Done. The user reviews and clicks Post themselves.
  if (!typed) {
    try { await navigator.clipboard.writeText(caption); } catch (_) {}
    updateToast('Media attached, but the caption could not be typed — paste it (copied to clipboard if allowed).', 'ready', 100);
  } else if (!uploaded) {
    updateToast('Media is still uploading — click Post once X finishes.', 'ready', 100);
  } else {
    updateToast('✅ Ready! Review and click Post ➜', 'ready', 100);
  }
  return { typed, uploaded };
}

// ─── Fetch Media ──────────────────────────────────────────────────────────────
function extFromMime(mime, mediaType) {
  if (mediaType === 'video') return 'mp4';
  if (mime.includes('png'))  return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif'))  return 'gif';
  return 'jpg';
}

const STALL_MS = 20000;   // give up if no bytes arrive for this long

function formatMB(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
}

// Streams `url` directly, reporting progress. Returns null on CORS/network
// failure so the caller can fall back; throws only on a stall.
async function fetchDirect(url, onProgress) {
  const ctrl = new AbortController();
  let stalled = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { stalled = true; ctrl.abort(); }, STALL_MS);
  };

  arm();
  try {
    const resp = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: ctrl.signal });
    if (!resp.ok || !resp.body) return null;
    const total = Number(resp.headers.get('content-length')) || 0;
    const reader = resp.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      arm();
      onProgress?.(got, total);
    }
    return new Blob(parts, { type: resp.headers.get('content-type') || '' });
  } catch (_) {
    if (stalled) throw new Error('Download stalled — no data from X for 20 seconds. Check your connection and try again.');
    return null;   // CORS or network — fall back to the service worker
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMediaFile(url, mediaType, index = 0, onProgress) {
  // twimg CDNs normally send permissive CORS headers — try directly first
  let blob = await fetchDirect(url, onProgress);
  if (!blob || !blob.size) blob = await fetchViaServiceWorker(url, mediaType, onProgress);

  let mime = blob.type || '';
  if (mediaType === 'video' && !mime.includes('video')) mime = 'video/mp4';
  if (mediaType === 'image' && !mime.includes('image')) mime = 'image/jpeg';

  const ext  = extFromMime(mime, mediaType);
  const name = mediaType === 'video' ? `video.${ext}` : `image-${index + 1}.${ext}`;
  return new File([blob], name, { type: mime });
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Streams the file from the service worker in chunks over a Port, so large
// videos don't hit the single-message size limit.
function fetchViaServiceWorker(url, mediaType, onProgress) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connect({ name: 'xrp-fetch' });
    } catch (err) {
      reject(new Error(`Could not reach extension service worker: ${err.message}. Try reloading the page.`));
      return;
    }

    const parts = [];
    let got = 0;
    let finished = false;
    let timer = null;
    const finish = () => { finished = true; clearTimeout(timer); port.disconnect(); };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (finished) return;
        finish();
        reject(new Error('Download stalled — no data from X for 20 seconds. Check your connection and try again.'));
      }, STALL_MS + 5000);   // the worker has its own 20 s stall check; this catches a dead worker
    };

    port.onMessage.addListener((msg) => {
      if (finished) return;
      arm();
      if (msg?.type === 'progress') {
        onProgress?.(Math.max(got, msg.received || 0), msg.total || 0);
      } else if (msg?.type === 'chunk') {
        const bytes = base64ToBytes(msg.data);
        parts.push(bytes);
        got += bytes.length;
        onProgress?.(got, msg.total || 0);
      } else if (msg?.type === 'done') {
        finish();
        resolve(new Blob(parts, { type: msg.mimeType || '' }));
      } else if (msg?.type === 'error') {
        finish();
        reject(new Error(`Media download failed: ${msg.error}. The media URL may have expired — scroll past the post and back to refresh it, then try again.`));
      }
    });

    port.onDisconnect.addListener(() => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error('Media download was interrupted. Try again.'));
    });

    arm();
    port.postMessage({ type: 'fetch', url, mediaType });
  });
}

// ─── Main World Bridge Communication ──────────────────────────────────────────
let reqCounter = 0;
function callBridge(type, timeout = 5000, payload = {}) {
  return new Promise((resolve) => {
    const reqId = `xrp_${Date.now()}_${++reqCounter}_${Math.random().toString(36).slice(2, 8)}`;
    const expectedType = type.replace(/^XRP_REQ_/, 'XRP_RES_');
    let timer = null;

    // Only accept the bridge's RESPONSE — our own request is also delivered
    // to this listener because both worlds share the window.
    const onMessage = (event) => {
      if (event.source !== window || !event.data || typeof event.data !== 'object') return;
      if (event.data.type !== expectedType || event.data.reqId !== reqId) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(event.data);
    };

    window.addEventListener('message', onMessage);
    window.postMessage({ ...payload, type, reqId }, '*');

    timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve({ success: false, timedOut: true });
    }, timeout);
  });
}

// ─── Interaction Helpers ──────────────────────────────────────────────────────
function simulateClick(element) {
  if (!element) return false;

  const target = element.closest('a, button, [role="button"]') || element;
  const inner = target.querySelector('div, span, svg') || target;
  const opts = { bubbles: true, cancelable: true, view: window, buttons: 1, detail: 1 };

  try { target.focus?.(); } catch (_) {}

  const fire = (Ctor, name) => {
    if (typeof Ctor === 'undefined') return;
    try { inner.dispatchEvent(new Ctor(name, opts)); } catch (_) {}
    try { target.dispatchEvent(new Ctor(name, opts)); } catch (_) {}
  };
  fire(window.PointerEvent, 'pointerdown');
  fire(MouseEvent, 'mousedown');
  fire(window.PointerEvent, 'pointerup');
  fire(MouseEvent, 'mouseup');
  try { target.click(); } catch (_) {}
  return true;
}

// ─── Composer ─────────────────────────────────────────────────────────────────
// The composer "root" is the modal dialog holding tweetTextarea_0 — never the
// inline Home box or a post's reply box. On narrow layouts /compose/post is a
// full page without a dialog, so accept that route too.
function findComposerRoot() {
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    if (dialog.closest('.xrp-overlay')) continue;
    const ta = dialog.querySelector(SEL.composerTextarea);
    if (ta && isElementVisible(ta)) return dialog;
  }
  if (window.location.pathname.startsWith('/compose/')) {
    const ta = document.querySelector(SEL.composerTextarea);
    if (ta && isElementVisible(ta)) return composerBox(ta);
  }
  return null;
}

// On the /compose/post route the composer floats over the page it was opened
// from (often a post's thread). Scope it to the smallest ancestor holding the
// composer's toolbar / file input, and never widen it to include page posts —
// otherwise those posts look like a reply/quote composer.
function composerBox(ta) {
  let last = ta;
  for (let el = ta.parentElement; el && el !== document.body; el = el.parentElement) {
    if (el.querySelector(SEL.article)) break;
    last = el;
    if (el.querySelector(`[data-testid="toolBar"], ${SEL.fileInput}`)) return el;
  }
  return last;
}

function isReplyOrQuoteComposer(root) {
  return Boolean(root.querySelector(SEL.replyMarkers));
}

function findEditor(root) {
  if (!root) return null;
  const el = queryAny(SEL.composerEditor, root);
  if (!el) return null;
  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return el;
  return el.querySelector('[contenteditable="true"]') || el;
}

function findComposeButton() {
  const notInPost = el => el && !el.closest(SEL.article);
  for (const sel of SEL.newTweetBtns) {
    const els = [...document.querySelectorAll(sel)].filter(notInPost);
    const el = els.find(isElementVisible) || els[0];
    if (el) return el;
  }
  return null;
}

async function openFreshComposer() {
  if (isLoggedOut()) throw new Error('You are not logged in to X. Please log in first.');

  let root = findComposerRoot();
  if (root) {
    if (isReplyOrQuoteComposer(root)) {
      throw new Error('A reply or quote composer is open. Close it and try again.');
    }
    return root;
  }

  // 1. Page-world bridge: clicks the compose button with events React sees,
  //    then falls back to /compose/post routing (and undoes it on failure).
  const res = await callBridge('XRP_REQ_OPEN_COMPOSER', 7000);
  root = await waitFor(findComposerRoot, res?.timedOut ? 500 : 2000);

  // 2. Bridge unavailable — click the compose button from here
  if (!root) {
    const btn = findComposeButton();
    if (btn) {
      simulateClick(btn);
      root = await waitFor(findComposerRoot, 4000);
    }
  }

  if (!root) throw new Error('Could not open the composer. Make sure you are on x.com and logged in, then try again.');
  if (isReplyOrQuoteComposer(root)) throw new Error('X opened a reply composer instead of a new post. Close it and try again.');

  await sleep(400);
  return root;
}

function findFileInput(root) {
  const inputs = [...root.querySelectorAll(SEL.fileInput)];
  return inputs.find(i => /image|video/.test(i.accept || '')) || inputs[0] || null;
}

async function injectFiles(files, root) {
  const fileInput = await waitFor(() => findFileInput(root), 3000);
  if (!fileInput) {
    console.warn('[RePost for X] No file input found in the composer.');
    return false;
  }

  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));

  try {
    fileInput.files = dt.files;
    // React's onChange for file inputs listens to 'change' only
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    console.warn('[RePost for X] file input assignment error:', e);
    return false;
  }

  await sleep(500);
  return true;
}

// Returns true when the upload finished, false if it was still going at timeout.
// Throws if X never showed the attachment at all.
async function waitForUploadComplete(root, timeout = 60000) {
  const attachments = await waitFor(() => root.querySelector(SEL.attachments), 10000, 250);
  if (!attachments) {
    throw new Error('X did not accept the media file. Try attaching it manually with the 🖼 button.');
  }

  const busySel = `${SEL.attachments} [role="progressbar"], [data-testid="attachmentsLoading"], [data-testid="progressBar"]`;
  const finished = await waitFor(() => !root.querySelector(busySel), timeout, 300);
  await sleep(500);   // let React settle
  return Boolean(finished);
}

// ─── Type Caption ─────────────────────────────────────────────────────────────
function editorHasText(editor, text) {
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const probe = norm(text).slice(0, 20);
  return norm(editor.innerText ?? editor.textContent).includes(probe);
}

// X's composer is a Draft.js editor: it keeps its own model of the text and
// shows the "What's happening?" placeholder while that model is empty. Text
// that reaches the DOM without going through Draft's handlers is visible but
// not editable, and the placeholder stays on top of it.
function placeholderVisible(editor) {
  const ph = editor.closest('.DraftEditor-root')?.querySelector('.public-DraftEditorPlaceholder-root');
  return Boolean(ph && isElementVisible(ph));
}

// Text is in the DOM *and* Draft's model has it (placeholder gone).
function editorAccepted(editor, text) {
  return editorHasText(editor, text) && !placeholderVisible(editor);
}

function editorIsEmpty(editor) {
  return !(editor.textContent || '').trim();
}

// Wipe the editor through Draft's own handlers (selection stays inside it).
async function clearEditor(editor) {
  editor.focus();
  try { document.execCommand('selectAll'); } catch (_) {}
  try { document.execCommand('delete'); } catch (_) {}
  await sleep(150);
}

function dispatchPaste(editor, text) {
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  } catch (_) {}
}

async function typeCaption(editor, text) {
  if (!text) return true;
  if (!editor) return false;

  editor.focus();
  await sleep(150);

  // Start from an empty editor. selectAll inside a focused contenteditable
  // only selects the editor's text, which Draft tracks correctly (unlike a
  // Range over the editor node, which also covers Draft's structural divs).
  if (!editorIsEmpty(editor)) await clearEditor(editor);

  // 1. Synthetic paste: Draft parses it with its own paste handler, so its
  //    model stays in sync and line breaks become proper blocks.
  dispatchPaste(editor, text);
  await sleep(300);
  if (editorAccepted(editor, text)) return true;

  // Paste left the DOM and Draft's model out of sync — clear before retrying
  // so we never stack a second copy on top of uneditable text.
  if (!editorIsEmpty(editor)) await clearEditor(editor);

  // 2. Fallback: insertText at the caret (no custom Range).
  editor.focus();
  try { document.execCommand('insertText', false, text); } catch (_) {}
  await sleep(300);
  if (editorAccepted(editor, text)) return true;

  // Still out of sync: leave the composer clean for a manual paste.
  if (!editorIsEmpty(editor)) await clearEditor(editor);
  return false;
}

// ─── Toast System ─────────────────────────────────────────────────────────────
const TOAST_ICONS = {
  progress: `<div class="xrp-spinner"></div>`,
  success:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="#00c07f"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`,
  ready:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="#00c07f"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`,
  error:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="#f4212e"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`,
};

function ensureToast() {
  if (!toastEl || !document.body.contains(toastEl)) {
    toastEl = document.createElement('div');
    toastEl.className = 'xrp-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
  }
  return toastEl;
}

function updateToast(message, type = 'progress', progress = 50) {
  clearTimeout(toastTimeout);
  const toast = ensureToast();

  toast.innerHTML = `
    <div class="xrp-toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.progress}</div>
    <div class="xrp-toast-content">
      <span class="xrp-toast-msg"></span>
      ${type === 'progress' ? '<div class="xrp-toast-bar"><div class="xrp-toast-bar-fill"></div></div>' : ''}
    </div>
  `;
  toast.querySelector('.xrp-toast-msg').textContent = message;   // never parsed as HTML
  const fill = toast.querySelector('.xrp-toast-bar-fill');
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, Number(progress) || 0))}%`;
  toast.className = `xrp-toast xrp-toast--${type} xrp-toast--visible`;

  if (type === 'ready') {
    toastTimeout = setTimeout(() => toast.classList.remove('xrp-toast--visible'), 30000);
  } else if (type === 'success' || type === 'error') {
    toastTimeout = setTimeout(() => toast.classList.remove('xrp-toast--visible'), type === 'error' ? 6000 : 3000);
  }
}

function showToast(message, type) {
  updateToast(message, type, 100);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
init();
