/**
 * tests/content.test.js — regression tests for the content-script fixes.
 */

const ctx = require('./helpers/loadContent');

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '';
});

// ── Bridge messaging ──────────────────────────────────────────────────────────
describe('callBridge', () => {
  test('ignores its own request echo and resolves with the bridge response', async () => {
    const spy = jest.spyOn(window, 'postMessage').mockImplementation(() => {});
    const p = ctx.callBridge('XRP_REQ_EXTRACT_VIDEO', 1000, { extractId: 'abc' });
    const sent = spy.mock.calls[0][0];
    spy.mockRestore();

    expect(sent.extractId).toBe('abc');   // payload is forwarded

    // Echo of our own request (same reqId) must NOT resolve the promise
    window.dispatchEvent(new MessageEvent('message', { data: sent, source: window }));
    // The real response does
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'XRP_RES_EXTRACT_VIDEO', reqId: sent.reqId, videoUrl: 'https://video.twimg.com/x/1.mp4' },
      source: window,
    }));

    await expect(p).resolves.toMatchObject({ type: 'XRP_RES_EXTRACT_VIDEO', videoUrl: 'https://video.twimg.com/x/1.mp4' });
  });

  test('times out when no response arrives', async () => {
    const spy = jest.spyOn(window, 'postMessage').mockImplementation(() => {});
    const res = await ctx.callBridge('XRP_REQ_PING', 20);
    spy.mockRestore();
    expect(res.timedOut).toBe(true);
  });
});

// ── Caption extraction ────────────────────────────────────────────────────────
describe('extractCaption', () => {
  test('keeps emoji images and full t.co links, ignores quoted text', () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <div data-testid="tweetText">Hello <img alt="😀" src="e.svg"> see
          <a href="https://t.co/abc123"><span style="display:none">https://</span>example.com/lon…</a>
          <a href="/someone">@someone</a></div>
        <div role="link" tabindex="0">
          <div data-testid="tweetText">quoted text</div>
        </div>
      </article>`;
    const article = document.querySelector('article');
    const caption = ctx.extractCaption(article, article);
    expect(caption).toContain('😀');
    expect(caption).toContain('https://t.co/abc123');
    expect(caption).toContain('@someone');
    expect(caption).not.toContain('example.com/lon');
    expect(caption).not.toContain('quoted text');

    const quote = article.querySelector('[role="link"]');
    expect(ctx.extractCaption(article, quote)).toBe('quoted text');
  });

  test('caption text is never interpreted as HTML in the preview', () => {
    const evil = '</textarea><img src=x id="pwned"> & &amp;';
    ctx.showPreviewPanel({ caption: evil, media: { type: 'image', urls: ['https://pbs.twimg.com/media/a?name=orig'] } }, () => {});
    expect(document.getElementById('pwned')).toBeNull();
    expect(document.querySelector('#xrp-caption-input').value).toBe(evil);
    document.querySelector('.xrp-overlay').remove();
  });
});

// ── Weighted length ───────────────────────────────────────────────────────────
describe('weighted length', () => {
  test('URLs weigh 23, CJK and emoji weigh 2', () => {
    expect(ctx.weightedLength('https://t.co/abcdefghijklmnopqrstuvwxyz')).toBe(23);
    expect(ctx.weightedLength('日本')).toBe(4);
    expect(ctx.weightedLength('a😀')).toBe(3);
  });

  test('truncation never splits an emoji or a URL', () => {
    const text = 'a'.repeat(279) + '😀😀';
    const out = ctx.truncateToWeight(text, 280);
    expect(out).toBe('a'.repeat(279));

    const withUrl = 'b'.repeat(270) + ' https://t.co/xyz';
    expect(ctx.truncateToWeight(withUrl, 280)).toBe('b'.repeat(270));
  });
});

// ── Button injection & toggle ─────────────────────────────────────────────────
const ACTION_BAR = `
  <div role="group">
    <div><button data-testid="reply"></button></div>
    <div><button data-testid="retweet"></button></div>
    <div><button data-testid="like"></button></div>
    <div><a href="/x/status/1/analytics"></a></div>
    <div class="share"><button data-testid="bookmark"></button><button aria-label="Share"></button></div>
  </div>`;

function photoPost({ quoted = false, ownMedia = true, bar = true } = {}) {
  return `
    <article data-testid="tweet">
      <div data-testid="tweetText">main</div>
      ${ownMedia ? `
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/AAA?format=jpg&name=small"></div>
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/BBB?format=png&name=small"></div>` : ''}
      ${quoted ? `<div role="link" tabindex="0">
        <div data-testid="tweetText">quoted</div>
        <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/QQQ?format=jpg&name=small"></div>
      </div>` : ''}
      ${bar ? ACTION_BAR : ''}
    </article>`;
}

describe('processArticle', () => {
  test('adds one icon to the action bar, before bookmark/share, idempotently', () => {
    document.body.innerHTML = photoPost({ quoted: true });
    const article = document.querySelector('article');
    ctx.processArticle(article);
    ctx.processArticle(article);
    const bar = article.querySelector('[role="group"]');
    expect(article.querySelectorAll('.xrp-repost-btn')).toHaveLength(1);
    expect(bar.querySelectorAll(':scope > .xrp-action')).toHaveLength(1);
    expect(bar.lastElementChild.previousElementSibling.classList.contains('xrp-action')).toBe(true);
    expect(article.querySelector('.xrp-repost-btn--overlay')).toBeNull();
  });

  test('falls back to overlay buttons when there is no action bar', () => {
    document.body.innerHTML = photoPost({ quoted: true, bar: false });
    const article = document.querySelector('article');
    ctx.processArticle(article);
    expect(article.querySelectorAll('.xrp-repost-btn--overlay')).toHaveLength(2);
  });

  test('swaps the overlay for the inline icon once the action bar renders', () => {
    document.body.innerHTML = photoPost({ bar: false });
    const article = document.querySelector('article');
    ctx.processArticle(article);
    article.insertAdjacentHTML('beforeend', ACTION_BAR);
    ctx.processArticle(article);
    expect(article.querySelector('.xrp-repost-btn--overlay')).toBeNull();
    expect(article.querySelectorAll('.xrp-repost-btn--inline')).toHaveLength(1);
  });

  test('no icon on posts without media', () => {
    document.body.innerHTML = photoPost({ ownMedia: false });
    const article = document.querySelector('article');
    ctx.processArticle(article);
    expect(article.querySelector('.xrp-action')).toBeNull();
  });

  test('re-adds the icon after toggling off and on', () => {
    document.body.innerHTML = photoPost();
    const article = document.querySelector('article');
    ctx.processArticle(article);
    ctx.removeAllButtons();
    expect(article.querySelectorAll('.xrp-repost-btn')).toHaveLength(0);
    ctx.processArticle(article);
    expect(article.querySelectorAll('.xrp-repost-btn')).toHaveLength(1);
  });

  test('handles media that loads after the article', () => {
    document.body.innerHTML = `<article data-testid="tweet"><div data-testid="tweetText">x</div>${ACTION_BAR}</article>`;
    const article = document.querySelector('article');
    ctx.processArticle(article);
    expect(article.querySelector('.xrp-repost-btn')).toBeNull();
    article.insertAdjacentHTML('afterbegin', '<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/A"></div>');
    ctx.processArticle(article);
    expect(article.querySelector('.xrp-repost-btn--inline')).not.toBeNull();
  });

  test('action-bar icon uses the post media, else the quoted post media', () => {
    document.body.innerHTML = photoPost({ quoted: true });
    let article = document.querySelector('article');
    expect(ctx.pickMediaScope(article)).toBe(article);

    document.body.innerHTML = photoPost({ quoted: true, ownMedia: false });
    article = document.querySelector('article');
    expect(ctx.pickMediaScope(article)).toBe(article.querySelector('[role="link"]'));
  });
});

// ── Media collection ──────────────────────────────────────────────────────────
describe('collectMedia', () => {
  test('collects all images of the post, not the quoted one, at orig quality', async () => {
    document.body.innerHTML = photoPost({ quoted: true });
    const article = document.querySelector('article');
    const media = await ctx.collectMedia(article, article);
    expect(media.type).toBe('image');
    expect(media.urls).toHaveLength(2);
    expect(media.urls[0]).toContain('/media/AAA');
    expect(media.urls[0]).toContain('name=orig');
    expect(media.urls[1]).toContain('format=png');
    expect(media.urls.join()).not.toContain('QQQ');
  });

  test('GIF poster resolves directly to the tweet_video mp4', async () => {
    document.body.innerHTML = `
      <article data-testid="tweet"><div data-testid="tweetPhoto">
        <video poster="https://pbs.twimg.com/tweet_video_thumb/GiFkEy1.jpg" src="blob:https://x.com/1"></video>
      </div></article>`;
    const article = document.querySelector('article');
    const media = await ctx.collectMedia(article, article);
    expect(media).toEqual({ type: 'video', urls: ['https://video.twimg.com/tweet_video/GiFkEy1.mp4'] });
  });

  test('performance fallback only returns MP4s for the same media ID', () => {
    performance.getEntriesByType.mockReturnValueOnce([
      { name: 'https://video.twimg.com/ext_tw_video/999/pu/vid/avc1/1280x720/other.mp4' },
      { name: 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/0/3000/1280x720/frag.mp4' },
      { name: 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/480x270/low.mp4' },
      { name: 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/1280x720/high.mp4' },
    ]);
    expect(ctx.findMp4FromPerformance('123')).toBe('https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/1280x720/high.mp4');
    expect(ctx.findMp4FromPerformance(null)).toBeNull();
  });
});

// ── Composer targeting ────────────────────────────────────────────────────────
describe('findComposerRoot', () => {
  const visible = el => { el.getClientRects = () => [{}]; return el; };

  test('ignores the inline Home / reply composer', () => {
    document.body.innerHTML = '<main><div data-testid="tweetTextarea_0" contenteditable="true"></div></main>';
    visible(document.querySelector('[data-testid="tweetTextarea_0"]'));
    expect(ctx.findComposerRoot()).toBeNull();
  });

  test('finds the modal composer and detects reply dialogs', () => {
    document.body.innerHTML = `
      <div role="dialog" id="d"><div data-testid="tweetTextarea_0" contenteditable="true"></div></div>`;
    visible(document.querySelector('[data-testid="tweetTextarea_0"]'));
    const root = ctx.findComposerRoot();
    expect(root.id).toBe('d');
    expect(ctx.isReplyOrQuoteComposer(root)).toBe(false);

    root.insertAdjacentHTML('afterbegin', '<div data-testid="replyingToText">Replying to @x</div>');
    expect(ctx.isReplyOrQuoteComposer(root)).toBe(true);
  });
});

// ── Preview panel lifecycle ───────────────────────────────────────────────────
describe('showPreviewPanel', () => {
  test('opening a second panel cancels the first', async () => {
    const first = jest.fn();
    const second = jest.fn();
    const media = { type: 'image', urls: ['https://pbs.twimg.com/media/a'] };
    ctx.showPreviewPanel({ caption: 'one', media }, first);
    ctx.showPreviewPanel({ caption: 'two', media }, second);
    expect(first).toHaveBeenCalledWith(false, 'one');
    expect(document.querySelectorAll('.xrp-overlay')).toHaveLength(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    await flush();
  });
});

// ── Attribution ───────────────────────────────────────────────────────────────
describe('attribution', () => {
  const media = { type: 'image', urls: ['https://pbs.twimg.com/media/a'] };

  test('reads the handle of the post, or of the quoted post', () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <div data-testid="User-Name"><span>Alice</span><span>@alice_1</span></div>
        <div role="link" tabindex="0">
          <div data-testid="User-Name"><span>Bob</span><span>@bob</span></div>
        </div>
      </article>`;
    const article = document.querySelector('article');
    expect(ctx.extractAuthorHandle(article, article)).toBe('alice_1');
    expect(ctx.extractAuthorHandle(article, article.querySelector('[role="link"]'))).toBe('bob');
  });

  test('credit is on by default and can be turned off', () => {
    const cb = jest.fn();
    ctx.showPreviewPanel({ caption: 'hi', media, handle: 'alice' }, cb);
    const box = document.querySelector('[data-xrp="credit"]');
    expect(box.checked).toBe(true);
    expect(document.querySelector('[data-xrp="count"]').textContent).toBe(`${ctx.weightedLength('hi\n\nvia @alice')}/280`);
    document.querySelector('[data-xrp="confirm"]').click();
    expect(cb).toHaveBeenCalledWith(true, 'hi\n\nvia @alice');

    const cb2 = jest.fn();
    ctx.showPreviewPanel({ caption: 'hi', media, handle: 'alice' }, cb2);
    document.querySelector('[data-xrp="credit"]').click();
    document.querySelector('[data-xrp="confirm"]').click();
    expect(cb2).toHaveBeenCalledWith(true, 'hi');
  });

  test('no handle → no credit row, caption unchanged', () => {
    const cb = jest.fn();
    ctx.showPreviewPanel({ caption: 'hi', media }, cb);
    expect(document.querySelector('[data-xrp="credit-row"]').hidden).toBe(true);
    document.querySelector('[data-xrp="confirm"]').click();
    expect(cb).toHaveBeenCalledWith(true, 'hi');
  });

  test('credit alone when the caption is empty', () => {
    expect(ctx.composeCaption('  ', 'alice', true)).toBe('via @alice');
  });
});

// ── Caption typing (Draft.js composer) ────────────────────────────────────────
describe('typeCaption', () => {
  // Minimal Draft-like editor: placeholder shows while the "model" is empty.
  function draftEditor({ handlesPaste = true, handlesInsert = true, syncsModel = true } = {}) {
    document.body.innerHTML = `
      <div class="DraftEditor-root">
        <div class="public-DraftEditorPlaceholder-root">What's happening?</div>
        <div class="public-DraftEditor-content" contenteditable="true"></div>
      </div>`;
    const editor = document.querySelector('[contenteditable]');
    const ph = document.querySelector('.public-DraftEditorPlaceholder-root');
    ph.getClientRects = () => [{}];   // jsdom has no layout — treat as visible
    const setText = (t) => {
      editor.textContent = t;
      if (syncsModel && t) ph.remove();
    };
    if (handlesPaste) {
      editor.addEventListener('paste', (e) => { e.preventDefault(); setText(e.clipboardData.getData('text/plain')); });
    }
    const exec = jest.fn((cmd, _ui, value) => {
      if (cmd === 'delete') editor.textContent = '';
      if (cmd === 'insertText' && handlesInsert) setText(editor.textContent + value);
      return true;
    });
    document.execCommand = exec;
    return { editor, exec };
  }

  const origExec = document.execCommand;
  afterEach(() => { document.execCommand = origExec; });

  test('uses paste first and never touches insertText when Draft accepts it', async () => {
    const { editor, exec } = draftEditor();
    await expect(ctx.typeCaption(editor, 'line one\n\nvia @alice')).resolves.toBe(true);
    expect(editor.textContent).toBe('line one\n\nvia @alice');
    expect(exec).not.toHaveBeenCalledWith('insertText', false, expect.anything());
  });

  test('falls back to insertText when paste is ignored', async () => {
    const { editor, exec } = draftEditor({ handlesPaste: false });
    await expect(ctx.typeCaption(editor, 'hello')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('insertText', false, 'hello');
    expect(editor.textContent).toBe('hello');   // no duplicate
  });

  test('out-of-sync text is cleared, not left uneditable', async () => {
    const { editor } = draftEditor({ syncsModel: false });
    await expect(ctx.typeCaption(editor, 'hello')).resolves.toBe(false);
    expect(editor.textContent).toBe('');
  });
});
