# Chrome Web Store listing: RePost for X

Copy each field into the [Developer Dashboard](https://chrome.google.com/webstore/devconsole).

## Package

Upload `dist/repost-for-x-<version>.zip` (build it with `npm run package`).

## Store listing tab

**Name:** RePost for X *(taken from the manifest)*

**Summary** *(taken from the manifest; must be 132 characters or fewer):*
Repost photos and videos from X posts in one click, with credit to the original author. Runs entirely in your browser.

**Description:**

```
RePost for X adds a small RePost icon to posts that have photos, videos or GIFs, right next to bookmark and share.

HOW IT WORKS
1. Find a post with a photo or video.
2. Click the RePost icon in the post's action bar.
3. Check the preview and edit the caption if you like.
4. The extension opens a new post with the media attached and the caption filled in. You review it and click Post yourself.

FEATURES
• Photos (up to 4), videos and GIFs, downloaded at the best available quality
• Live progress while large videos download
• Edit the caption before anything happens, with an X-style character counter
• Credits the original author with "via @handle" by default (you can turn this off)
• Never posts anything automatically: you always click Post
• Turn the buttons on or off from the toolbar popup

PRIVATE BY DESIGN
Everything runs in your own browser tab. No account, no API keys, no servers, no analytics or tracking. Nothing about you or your browsing is collected or sent anywhere.

Please respect creators: only repost content you have the right to share, and keep the credit line on.

RePost for X is an independent project and is not affiliated with, endorsed by or sponsored by X Corp.
```

**Category:** Social Networking
**Language:** English

**Graphic assets** (in `store/`):
| Field | File |
|---|---|
| Store icon (128×128) | `icons/icon-128.png` |
| Screenshot 1 (1280×800) | `store/screenshot-1.png` |
| Screenshot 2 (1280×800) | `store/screenshot-2.png` |
| Small promo tile (440×280) | `store/promo-small.png` |

*Optional but recommended:* add a third screenshot of the RePost icon in a real post's action bar on x.com. Use a post of your own, or one whose media you have the right to show.

**Additional fields:**
- Homepage URL: `https://github.com/happy2deepak/x-repost`
- Support URL: `https://github.com/happy2deepak/x-repost/issues`

## Privacy tab

**Single purpose:**
> Repost a photo or video from an X (x.com) post into a new post composer on X, so the user can review it and publish it themselves.

**Permission justifications:**
- **storage:** Saves the user's on/off preference and the result of the last repost, locally on the device.
- **Host permission x.com / twitter.com:** Adds the RePost icon to posts and fills the new-post composer in the user's tab with the selected media and caption.
- **Host permission pbs.twimg.com / video.twimg.com:** Downloads the selected post's image or video from X's media servers so it can be attached to the new post. Requests are limited to these two hosts.

**Remote code:** No, I am not using remote code. *(All JavaScript ships in the package.)*

**Data usage:** tick **Website content** only (post text, author handle and media URLs, read only when the user clicks RePost). Leave every other category unticked.

Tick all three certifications:
- I do not sell or transfer user data to third parties, apart from the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** `https://github.com/happy2deepak/x-repost/blob/main/PRIVACY.md`

## Distribution tab

- Visibility: Public *(or Unlisted for a soft launch)*
- Regions: All regions

## Before you submit

- [ ] Your developer account is registered (one-time US$5 fee) and your contact email is verified
- [ ] Trader / non-trader declaration completed in Account settings (required for the EU)
- [ ] You loaded `dist/` unpacked and did a final check on x.com: one image, several images, a video, a GIF and a quoted post
- [ ] For later updates, bump `version` in **both** `manifest.json` and `package.json` (the package script refuses to build if they differ)

Review usually takes a few days. Host permissions on x.com trigger a more detailed review, so the clear justifications above matter.
