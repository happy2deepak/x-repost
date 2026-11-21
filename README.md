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

## Publishing

- `npm run package` builds the upload zip in `dist/`
- Store images (screenshots and promo tile) are in [`store/`](store/). Each is rendered from its `.html` file, so edit the HTML and re-render if you need to change one.
- Every dashboard field, ready to paste, is in [`store/STORE_LISTING.md`](store/STORE_LISTING.md)
- Privacy policy: [PRIVACY.md](PRIVACY.md) (https://github.com/happy2deepak/x-repost/blob/main/PRIVACY.md)
