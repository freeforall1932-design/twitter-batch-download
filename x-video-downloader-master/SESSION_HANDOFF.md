# Session Handoff — X Media Downloader

**Prepared:** 2026-08-24

## Project and branch

- Repository: `freeforall1932-design/twitter-batch-download`
- Extension directory: `x-video-downloader-master/`
- Working branch for this Arena session: `arena/01a02c57-twitter-batch-download`
- Current relevant commits:
  - `5ee8ad3` — Add queue retry and download progress states
  - `3947598` — Add profile media discovery to side panel
  - `58c2f32` — Document queue discovery implementation worklist
  - `b211e8b` — Add side panel batch queue foundation
  - `5813597` — mainline v3.0 merge baseline

The extension has no build step, package manager, TypeScript, or server. Reload it in `chrome://extensions` after changes and load `x-video-downloader-master/` as the unpacked extension.

## Product direction agreed in this session

The main product is a **Chrome Side Panel batch media queue**, not only one-button-per-tweet downloading.

A user should be able to:

1. Enter `@username`, a profile URL, or a `/media` URL.
2. Discover the account's media with an upper cap, default **9,999**.
   - The cap is not a target. If an account has 690 media items, discovery should complete at 690.
3. See discovered items newest-first in the Side Panel.
4. Tick individual media items or Select all.
5. Download selected items or all discovered items.
6. Limit active Chrome downloads to **one or two**. A later item must not begin until an active download reaches a terminal Chrome status.
7. Optionally include reposted media. Replies and quoted media will become explicit options later.

The existing per-tweet action-bar button remains supported but is not the main current focus.

## Security and authentication policy

Do **not** ask the user to paste passwords, API keys, `auth_token`, `ct0`, or a Cookie header.

The extension is intended to use the existing signed-in X session in the same Chrome profile:

- `background.js` reads the `ct0` cookie for the CSRF header.
- It reads X cookies to create its authenticated cookie string.
- It extracts the public app Bearer token from X page JavaScript, with a known public fallback.
- The user must be signed into X in Chrome.

Do not display, export, log, or persist separate cookie/token values. Any user-supplied network capture must redact all session credentials.

## Current architecture

### `manifest.json`

- Manifest V3.
- Existing X/CDN host permissions only.
- `sidePanel` permission and `side_panel.default_path` were added for the Side Panel.

### `background.js`

Owns authentication, GraphQL calls, rate limiting, Chrome downloads, queue persistence, and profile discovery.

Important existing areas:

- `refreshAuth(tabId)`: reads cookies and tries to locate the current public Bearer token in X JavaScript bundles.
- `getTweetMedia(tweetId)`: current single-tweet `TweetResultByRestId` flow.
- `fetchWithRetry()`: request throttling and exponential retry for 429/503.
- `downloadFile()`: Chrome download start wrapper.
- Queue storage key: `batchDownloadQueueV1`.
- Profile discovery storage key: `profileDiscoveryV1`.
- `processQueue()`: enforces concurrency of 1 or 2. It schedules only available slots.
- `chrome.downloads.onChanged`: updates bytes/progress, marks terminal state, retries failed/interrupted download attempts up to three times, then starts the next queue item only after a terminal event.
- `runProfileDiscovery(options)`: normalizes a profile target, checks signed-in X tab/session, discovers current `UserByScreenName` and `UserMedia` operation metadata from loaded X scripts, resolves a user, fetches pages, parses media, and adds items to the queue.

### `sidepanel.html`, `sidepanel.css`, `sidepanel.js`

The persistent batch interface.

Current controls:

- profile target input and “use current X tab” button;
- scan limit, default 9,999;
- Include reposts checkbox;
- Discover media / Stop scan;
- discovered, selected, completed counters;
- queue filter: all, videos, photos;
- individual selection and Select all;
- Download selected / Download all;
- active-download selector: 1 or 2;
- Stop after active downloads;
- Retry failed / Clear finished.

The panel listens for `queueChanged` messages to reload queue and discovery state.

### `content.js`

Existing page-side behavior.

- Detects media tweets through DOM selectors.
- Adds action-bar download buttons.
- Has a separate older DOM auto-scroll bulk mode driven by popup controls.
- This mode is **not** the Side Panel full-profile scanner; it only finds tweets loaded in the page DOM.

### `popup.html`, `popup.js`

- Existing current-page bulk download controls remain.
- Default max input changed to 9,999.
- Added **Open batch queue** action to open the Side Panel.

### `lib/zip-writer.js`

A custom STORE-mode ZIP writer exists. It is not yet connected to the Side Panel queue.

## Runtime messages

### Queue messages

- `queueGet`
- `queueAdd` with normalized media records
- `queueSelect`
- `queueSelectVisible`
- `queueSetConcurrency`
- `queueStart` (`mode: "selected"` or `"all"`)
- `queueStop`
- `queueRetryFailed`
- `queueClearFinished`

### Discovery messages

- `discoveryGet`
- `discoveryStart` with `{ target, limit, includeRetweets }`
- `discoveryStop`

## Normalized queue item shape

Discovery sends items similar to:

```js
{
  id: "tweetId-mediaId",        // stable dedupe key
  url: "https://…",              // direct MP4 or original photo URL
  type: "photo" | "video",
  thumbnail: "https://…",
  author: "@username",
  date: "X timestamp string",
  tweetId: "…",
  mediaId: "…",
  isRepost: false,
  filename: "x-media/tweet_author_text_1.jpg",
  selected: false,
  status: "discovered",
  attempts: 0,
  bytesReceived: 0,
  totalBytes: 0
}
```

Queue states are `discovered`, `queued`, `starting`, `downloading`, `completed`, and `failed`.

## What is code-complete versus what requires live validation

### Implemented without needing fresh X API data

- Side Panel UI and persistent queue.
- Selection/filtering/download-all/download-selected workflow.
- One/two concurrent scheduler.
- Queue retry (maximum three attempts) and manual retry.
- Progress-state plumbing.
- Profile target validation.
- Stop behavior and queue cleanup.

### Implemented but **must be verified against live X**

- Existing signed-in session handling.
- Single-tweet GraphQL fetching and photo/video parser.
- DOM selectors and action-bar injection.
- Dynamic operation-ID extraction from loaded X JavaScript.
- `UserByScreenName` and `UserMedia` request variables/features.
- Timeline-instruction/cursor parsing.
- Repost result parsing.
- Download byte-progress availability.

Do not declare these complete merely because a reference repo used a similar approach. X frontend/query IDs/response layouts change frequently.

## Required live data for the next session

If a current live test fails, ask for a **sanitized current Network capture** from a signed-in X browser. Do not ask for credentials.

Most valuable captures:

1. Profile media page first request:
   - `https://x.com/<user>/media`
   - GraphQL request URL including operation name/query ID;
   - variables/features/field toggle structure;
   - first JSON response.
2. Second media page request after scrolling:
   - same details, showing cursor request and response.
3. A profile whose media has photos, direct MP4 video, multi-photo post, and a repost.
4. Optional error examples: 429, protected account, deleted post, NSFW/auth error.
5. Current rendered `<article>` outer HTML for normal media post, repost, quote, and multi-photo post.

Redact/replace completely:

- `auth_token`, `ct0`, all Cookie header data;
- authorization/session headers;
- private account IDs or private post content.

## Live test sequence

1. Open `chrome://extensions`, reload the extension, and hard-refresh X.
2. Sign in to X in that Chrome profile.
3. Open any regular X profile page so current JavaScript bundles are loaded.
4. Open extension popup → **Open batch queue**.
5. Enter a small public account and set limit to 20.
6. Click Discover media.
7. Verify discovery status, queue insertion, thumbnails, author/date, media types, multi-photo uniqueness, and end-of-timeline behavior.
8. Test Include reposts both off and on.
9. Select one/two items and verify no more than the configured 1/2 Chrome downloads run at once.
10. Test failed download retry if a harmless reproducible failure is available.
11. Test protected/deleted/NSFW errors without exposing sensitive account details.

## Backlog / bucket list

### Highest priority after live validation

- Make UserMedia GraphQL variables/features and response parser exact from a sanitized current capture.
- Improve error messages for expired login, protected account, deleted content, NSFW state, operation-metadata failure, and rate limits.
- Add visible rate-limit retry countdown during discovery.
- Add automated/manual regression fixtures from sanitized response samples.

### Profile/timeline sources

- Explicit Include replies switch.
- Explicit Include quoted media switch.
- Full bookmarks pagination.
- Full likes pagination.
- Full user posts/replies scanner.
- Search/date-range source.
- Import current loaded DOM media into Side Panel queue.

### Queue/download UX

- Queue item counts by photo/video/GIF.
- Better thumbnails and repost badge.
- Filename template settings.
- Video-quality picker.
- Download history.
- Resume policy after browser/extension restart; current in-progress downloads are reconciled back to queued after service worker restart.
- ZIP output wired to Side Panel queue.
- Controlled parallel-download tuning beyond current 1/2 limit only if specifically requested.

### Media support and compatibility

- HLS/live stream policy/support.
- Firefox MV3 compatibility.
- Direct profile avatar/banner download.
- Better original image file-extension/content-type detection.

## Guardrails

- Do not add npm, TypeScript, webpack, or a build step.
- Do not add `<all_urls>` or non-X host permissions.
- Keep privileged Chrome APIs (`chrome.storage`, `chrome.downloads`, `chrome.scripting`, cookies) in `background.js`.
- Do not reintroduce the dead v1.1 `statuses/show.json` endpoint.
- Do not add a manual auth-token input.
- Do not copy third-party TypeScript/native extractor code or architecture directly.
- Do not claim current X support without a live signed-in browser check.

## Useful commands

```bash
cd /home/user/twitter-batch-download/x-video-downloader-master
node --check background.js
node --check content.js
node --check popup.js
node --check sidepanel.js

# Root repository status
cd /home/user/twitter-batch-download
git status --short --branch
git log --oneline -6
```
