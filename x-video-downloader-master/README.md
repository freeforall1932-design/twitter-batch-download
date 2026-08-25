# X Media Downloader — Chrome Extension

**Download videos and photos from X (Twitter) via a Side Panel batch queue, or one click on a tweet.**

Self-hosted against your signed-in X session. No third-party accounts, API keys, or paid tiers.

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-brightgreen)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Features

- **Side Panel batch queue** — Enter `@username` or a profile/media URL, discover media (cap default 99,999), select items, download with 1–2 concurrent Chrome downloads.
- **Download button on media tweets** — Action-bar control for a single post.
- **Videos + photos** — Highest-bitrate MP4 (including animated GIFs as MP4); original-resolution photos (`name=orig`).
- **Include reposts** — Optional during profile discovery.
- **Rate-limit handling** — Throttle + exponential backoff; Side Panel shows a retry countdown on 429/503.
- **Direct file naming** — `Downloads/x-media/{username}_{post text}_{tweetId}_{index}.{ext}` (no multi-GB ZIP archives).
- **Live session capture** — MAIN-world observer learns current GraphQL operation IDs and safe request headers from the open X tab.
- **No third-party services** — Calls go to X only, using your browser session.

Legacy popup **DOM auto-scroll bulk** still works on the currently loaded page; full-profile discovery is the Side Panel flow.

## Installation

1. Clone this repo or download the source archive.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. **Load unpacked** → select the `x-video-downloader-master` folder.
4. Sign in to [x.com](https://x.com) in that Chrome profile.
5. Open the extension popup → **Open batch queue** (Side Panel), or use on-tweet Download buttons.

You must be logged in to X. The extension uses your existing session — no API keys or passwords.

## Usage

### Side Panel batch queue (primary)

1. Open any X tab so page scripts load (a profile `/media` page is ideal).
2. Popup → **Open batch queue**.
3. Enter `@username` or a profile URL; set limit; optionally include reposts.
4. **Discover media** → review queue newest-first → select → **Download selected** or **Download all**.
5. Keep concurrent downloads at 1 or 2. Use **Stop after active downloads** / **Stop scan** as needed.

### Single tweet

Click **Download** on a media tweet’s action bar. Files go to `Downloads/x-media/`.

### Legacy page bulk (popup)

On a timeline already loaded in the tab, set max items / filter / scroll speed and **Start**. This only sees DOM-loaded tweets — it is not full-profile GraphQL discovery.

## How it works

1. **Auth** — Reads `ct0` / `auth_token` cookies and a public Bearer token (from page JS, live capture, or known public fallback).
2. **Live capture** — `injected.js` (MAIN world) observes GraphQL requests for operation IDs, features, and headers such as `x-client-transaction-id` (never stores Cookie header values in the capture bag).
3. **Discovery** — Resolves user via `UserByScreenName`, pages `UserMedia` (or captured media-timeline aliases), parses timeline instructions, enqueues media.
4. **Single tweet** — `TweetResultByRestId` for action-bar / DOM bulk.
5. **Downloads** — `chrome.downloads` with concurrency 1–2, retries, and a safer filename ladder if Chrome rejects a path.

## Permissions

| Permission | Why |
|------------|-----|
| `cookies` | Session CSRF / signed-in check |
| `downloads` | Save media |
| `storage` | Queue, discovery state, settings |
| `activeTab` + `scripting` | Buttons, bundle metadata, messaging |
| `sidePanel` | Batch queue UI |

**Host permissions:** `x.com`, `twitter.com`, `video.twimg.com`, `pbs.twimg.com`, `api.x.com`.

No data is sent to third-party extension backends.

## Architecture

```
x-video-downloader-master/
├── manifest.json
├── background.js          # Auth, GraphQL, queue, discovery, downloads
├── injected.js            # MAIN-world GraphQL/header capture
├── content.js             # Capture forwarder, action bar, DOM bulk
├── sidepanel.html/js/css  # Batch queue UI
├── popup.html/js          # Open panel + legacy bulk controls
├── tests/                 # Node unit tests + fixtures
├── SESSION_HANDOFF.md
├── WORKLIST.md
├── IMPROVEMENT_LOG.md
└── README.md
```

Vanilla JavaScript — no frameworks, no build step, no npm, no TypeScript.

## Development

```bash
cd x-video-downloader-master
node --check background.js content.js popup.js sidepanel.js injected.js
node --test tests/background.test.js
```

See `WORKLIST.md` for priorities and the post-rewrite code-review checklist. See `SESSION_HANDOFF.md` for architecture and live-X validation needs.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Auth / session errors | Sign in on x.com, hard-refresh, retry |
| Operation metadata missing | Open the target profile `/media` once so live capture can warm up |
| Protected / N/A | Private, deleted, or unavailable to your account |
| Rate limited | Wait for the Side Panel countdown; use slower bulk scroll |
| After code update | Reload extension on `chrome://extensions`, then hard-refresh X |

## Disclaimer

For personal use. Respect creators’ rights and X’s Terms of Service. Downloaded media remains the IP of its creators.

## License

[MIT](LICENSE)
