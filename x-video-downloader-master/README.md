# X Media Downloader — Chrome Extension

**Download videos and photos from X (Twitter) — single click or bulk auto-scroll.**

Works on your feed, bookmarks, user profiles, search results — any page with tweets.

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-brightgreen)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Features

- **Download button on every media tweet** — Appears in the action bar of tweets with video or photos. One click to save.
- **Video support** — Downloads highest-bitrate MP4 automatically (including animated GIFs as MP4).
- **Photo support** — Downloads original-resolution images (jpg/png). Multi-image tweets get all photos.
- **Bulk auto-download** — Set a max count, hit Start, and the extension scrolls and downloads every video and/or photo it finds.
- **Media type filter** — Choose to download all media, videos only, or photos only during bulk mode.
- **Download all bookmarked media** — Navigate to your Bookmarks page, hit Start, and save everything. Great for archiving before tweets get deleted.
- **Save NSFW / 18+ content** — Works on age-restricted content (requires you to be logged in with NSFW enabled in settings).
- **Smart file naming** — Files named using tweet author and content: `001_username_tweet text here.mp4`
- **ZIP packaging** — Bundle multiple files into a single ZIP download.
- **Adjustable scroll speed** — Slow (safest), medium, or fast.
- **Rate limit handling** — Exponential backoff with jitter to avoid X's rate limiting.
- **Works everywhere on X** — For You, Following, Bookmarks, user profiles, search results, lists.
- **No third-party services** — Everything runs locally using X's internal GraphQL API. No data sent anywhere.

## Screenshots

### Download Button on Tweets
Every video or photo tweet gets a blue **Download** button in the action bar. Click it and the button shows progress, then turns green when saved.

### Popup Controls
Set max item count, choose media type (all / video / photo), scroll speed, then hit **Start Downloading**.

## Installation

1. **Download** — Clone this repo or [download the ZIP](../../archive/refs/heads/main.zip)
   ```bash
   git clone https://github.com/Teylersf/x-video-downloader.git
   ```
2. **Open Chrome Extensions** — Navigate to `chrome://extensions/`
3. **Enable Developer Mode** — Toggle the switch in the top right corner
4. **Load Extension** — Click "Load unpacked" and select the `x-video-downloader-master` folder
5. **Navigate to X** — Go to [x.com](https://x.com) — you'll see download buttons on media tweets

**Note:** You must be logged in to X in your browser for the extension to work. It uses your existing session — no API keys or passwords needed.

## Usage

### Download from a Single Tweet
1. Browse X/Twitter normally
2. Find a tweet with video or photos
3. Click the **Download** button in the tweet's action bar
4. Media saves to your `Downloads/x-media/` folder

### Bulk Download Media
1. Navigate to any X page — **For You**, **Following**, **Bookmarks**, a user's **profile**, etc.
2. Click the extension icon in the toolbar
3. Set the **max number of items** to download
4. Choose **media type** (all, videos only, or photos only)
5. Choose a **scroll speed** (slow is most reliable)
6. Click **Start Downloading**
7. The extension auto-scrolls, finds media tweets, and downloads them
8. Click **Stop** at any time

### File Naming

Files are saved to `Downloads/x-media/` with descriptive filenames:

```
x-media/
  001_username_First part of the tweet text.mp4
  002_anotheruser_Some other tweet content.jpg
  003_handle_Photo description.png
```

## How It Works

1. **Authentication** — Extracts X's public Bearer token (embedded in X's own JavaScript) and reads your `ct0` CSRF cookie. This lets the extension make authenticated GraphQL API calls using your existing browser session. No passwords or API keys needed.

2. **Media Discovery** — When you click download (or during bulk mode), it calls X's internal GraphQL API (`TweetResultByRestId` endpoint) with the tweet ID. The response contains full media metadata including video URLs and photo URLs.

3. **Video Extraction** — For videos, it selects the highest-bitrate MP4 variant from the response and saves it via Chrome's downloads API.

4. **Photo Extraction** — For photos, it appends `?name=orig` to get the original full-resolution image from X's CDN.

5. **Rate Limiting** — Requests are throttled with a minimum interval, and on 429/503 responses the extension uses exponential backoff (up to 60s) with jitter before retrying.

6. **DOM Integration** — A MutationObserver watches for new tweets appearing in X's virtualized timeline and injects download buttons automatically.

## Permissions

| Permission | Why |
|-----------|-----|
| `cookies` | Read the `ct0` CSRF token for API authentication |
| `downloads` | Save media files to disk |
| `storage` | Remember your settings (max items, scroll speed, media filter) |
| `activeTab` + `scripting` | Inject download buttons and read page scripts for Bearer token |
| `webRequest` | Capture CDN URLs as a fallback |

**Host permissions:** `x.com`, `twitter.com`, `video.twimg.com` (video CDN), `pbs.twimg.com` (photo CDN), `api.x.com`

**No data leaves your browser.** All API calls go directly to X's servers using your existing session.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Auth error" on download | Refresh the X page and try again — your session may have expired |
| Button says "Protected/N/A" | Tweet is from a private account, was deleted, or requires login |
| Downloads are slow | Use "Slow" scroll speed — aggressive usage triggers X's rate limits |
| No download button appears | Make sure you're logged in to X and the extension is enabled |
| Extension not working after update | Go to `chrome://extensions`, click reload on the extension, then hard-refresh X (Ctrl+Shift+R) |
| "Could not find tweet" error | Tweet may have been deleted. Extension skips and moves on. |

## Tech Stack

- **Chrome Extension Manifest V3**
- **X Internal GraphQL API** (TweetResultByRestId) — extracted from [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- **Minimal ZIP writer** — custom uncompressed ZIP creator (no external dependencies)
- Vanilla JavaScript — no frameworks, no build step, no npm, no TypeScript

## Architecture

```
x-video-downloader-master/
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Service worker: auth, GraphQL API, downloads, ZIP
├── content.js             # Content script: DOM observer, button injection, bulk scroll
├── popup.html             # Extension popup UI
├── popup.js               # Popup logic: bulk controls
├── lib/
│   └── zip-writer.js      # Minimal ZIP file creator (STORE, no compression)
├── icon48.png
├── icon128.png
├── LICENSE
└── README.md
```

### File Responsibilities

| File | Owns |
|------|------|
| `background.js` | ALL fetch/API logic, GraphQL calls, Bearer token extraction, `chrome.downloads`, rate limit + retry, ZIP packaging |
| `content.js` | ALL DOM: MutationObserver, tweet node detection, button injection, scroll trigger relay, bulk loop |
| `popup.html / popup.js` | Bulk controls (count, speed, media filter, start/stop) |
| `lib/zip-writer.js` | Minimal ZIP file creator for bundling multiple downloads |

## Contributing

Contributions welcome! Areas that could use help:

- Test DOM selectors against current X.com layout (they change frequently)
- HLS stream handling for live/periscope content
- Firefox MV3 compatibility
- Better error messages for specific failure modes

## Disclaimer

This tool is for personal use. Respect content creators' rights and X's Terms of Service. Downloaded media remains the intellectual property of its original creators. Use responsibly.

## License

[MIT](LICENSE)
