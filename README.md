# RePost for X

A Chrome extension that adds a **RePost** button to X (x.com) posts with photos or videos. Click it, review the preview, and the extension fills a new-post composer with the media and caption. By default it credits the original author with `via @handle`. You click **Post** yourself; nothing is ever posted automatically.

Not affiliated with or endorsed by X Corp.

## Install (development)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder

## Scripts

```bash
npm install
npm test            # Jest unit tests
npm run package     # builds dist/repost-for-x-<version>.zip for the Chrome Web Store
node generate-icons-pure.js   # regenerates icons/ (no dependencies)
```

## Chrome Web Store notes

**Single purpose:** repost media from an X post into a new post composer on X.

**Permission justifications**

| Permission | Why |
|---|---|
| `storage` | Remembers the on/off toggle and the last repost status. |
| Host `x.com`, `twitter.com` | Adds the RePost button to posts and fills the composer. |
| Host `pbs.twimg.com`, `video.twimg.com` | Downloads the post's image or video so it can be attached to the new post. |

**Data use:** reads website content (post text, author handle, media URLs) only when you click RePost. Nothing is collected or sent off-device. See [PRIVACY.md](PRIVACY.md).

**Privacy policy URL:** https://github.com/happy2deepak/x-repost/blob/main/PRIVACY.md
