# Session Handoff — X Media Downloader

**Prepared:** 2026-08-25

## Project and branch

- Repository: `freeforall1932-design/twitter-batch-download`
- Extension directory: `x-video-downloader-master/`
- Working branch for this Arena session: `arena/01a0367e-twitter-batch-download`
- Recent commits on this branch:
  - cleanup / PR batch (this handoff): remove deprecated ZIP path, legacy message handlers, dead bulk flags
  - `4cc3782` — Rank S live capture bridge + Rank A download fallbacks
  - `93940d8` — Discovery error classification, rate-limit countdown, fixtures
  - `14d2c4d` — Baseline upload

The extension has **no build step**, package manager, TypeScript, or server. Reload it in `chrome://extensions` after changes and load `x-video-downloader-master/` as the unpacked extension.

## Product direction

The main product is a **Chrome Side Panel batch media queue**, not only one-button-per-tweet downloading.

A user should be able to:

1. Enter `@username`, a profile URL, or a `/media` URL.
2. Discover the account's media with an upper cap, default **99,999**.
   - Cap is an upper bound, not a target (e.g. 690 media → complete at 690).
   - Local community cap only — not a third-party paid/free tier.
3. See discovered items newest-first in the Side Panel.
4. Tick individual items or Select all.
5. Download selected or all, with **1 or 2** concurrent Chrome downloads.
6. Optionally include reposted media. Replies / quoted media are future explicit options.

Per-tweet action-bar buttons remain supported but are secondary to the Side Panel.

## Security and authentication policy

Do **not** ask the user to paste passwords, API keys, `auth_token`, `ct0`, or Cookie headers.

- Self-hosted against the **signed-in X session only**.
- No third-party account, subscription, activation, license, or tier service.
- `background.js` reads `ct0` / `auth_token` cookies and Bearer token (page capture or public fallback).
- Live network capture may remember non-cookie request headers (`authorization`, `x-csrf-token`, `x-client-transaction-id`, …). **Cookie header values are never stored in the capture bag.**
- Do not display, export, log, or persist separate token values in the UI.

## Current architecture (post-cleanup)

| File | Role |
|---|---|
| `manifest.json` | MV3, sidePanel, cookies/downloads/storage/scripting. Content scripts: `injected.js` (MAIN, document_start) + `content.js` (isolated, document_start). Hosts: x.com / twitter.com / twimg CDN only. |
| `background.js` | Auth, GraphQL, queue, discovery, downloads, capture bag. **No ZIP.** |
| `injected.js` | MAIN-world XHR/fetch observer → posts GraphQL op metadata + safe headers. |
| `content.js` | Forwards captures; action-bar buttons; legacy DOM auto-scroll bulk (popup). |
| `sidepanel.html/js/css` | Batch queue UI. |
| `popup.html/js` | Open Side Panel + legacy page bulk controls. |
| `tests/` | Node VM unit tests + sanitized fixtures. |

### Removed / deprecated (do not reintroduce without product decision)

- `lib/zip-writer.js` and all ZIP assembly (`downloadZip`, `fetchAsArrayBuffer`, `zipBuffers`, `importScripts` of zip-writer).
- Legacy runtime messages: `getVideoUrl`, `downloadVideo`, `downloadZip`, `fetchAsArrayBuffer`.
- Unused `webRequest` permission.
- Dead `useZip` / `bulkId` state in `content.js`.
- Accidental `TweetDetail` fallback for single-tweet media (wrong variables/shape).

### Runtime messages (current)

**Queue:** `queueGet`, `queueAdd`, `queueSelect`, `queueSelectVisible`, `queueSetConcurrency`, `queueStart`, `queueStop`, `queueRetryFailed`, `queueClearFinished`

**Discovery:** `discoveryGet`, `discoveryStart` `{ target, limit, includeRetweets }`, `discoveryStop`  
State also exposes `errorCode`, `retryAfterMs`, `retryUntil`.

**Other:** `networkCapture`, `initEnv`, `getTweetMedia`, `downloadFile`, content bulk `start` / `stop` / `getStatus`

### Queue item shape

```js
{
  id: "tweetId-mediaId",
  url, type: "photo" | "video",
  thumbnail, author, date, tweetId, mediaId,
  isRepost, filename, // x-media/{user}_{text}_{tweetId}_{index}.{ext}
  selected, status, // discovered|queued|starting|downloading|completed|failed
  attempts, bytesReceived, totalBytes, downloadId?, error?
}
```

## What needs live-X validation (not complete offline)

- Live capture bridge on real X tabs (op IDs, features, transaction id).
- `UserByScreenName` + `UserMedia` (or photo/video timeline aliases) response shapes.
- Repost on/off, multi-photo, highest-bitrate MP4, original photos.
- Rate-limit countdown against real 429s.
- Protected / NSFW / expired session messaging.
- Action-bar selectors and single-tweet GraphQL.

Do **not** declare P0 complete without a signed-in Chrome check.

## Required live data if something fails

Ask for a **sanitized** Network capture only (no credentials):

1. First `…/media` GraphQL request URL + variables/features + JSON body sample.
2. Cursor page request/response.
3. Optional: 429, protected, deleted, NSFW errors.
4. Redact: cookies, auth headers, private content.

## Scrapyard policy (Rank S > A > B)

- Use abandoned extensions as **conceptual / pattern** references only.
- Reimplement locally against this queue/parser/scheduler.
- Never import third-party login, license, activation, tier, or external API hosts (`apixbd.plucker.io`, ExtPay, etc.).
- Rank S (Plucker): live GraphQL/header intercept patterns — **already partially adopted**.
- Rank A: filename fallbacks / action-bar UX — **partially adopted**.
- Rank B: low priority; licensing code ignored.

## Guardrails

- No npm / TypeScript / webpack / build step.
- No `<all_urls>` or non-X host permissions.
- Privileged APIs stay in `background.js`.
- No manual auth-token input.
- No dead `statuses/show.json` v1.1 endpoint.
- No ZIP reintroduction for large batch queues (direct files only).
- No claim of current X support without live check.

## Useful commands

```bash
cd x-video-downloader-master
node --check background.js content.js popup.js sidepanel.js injected.js
node --test tests/background.test.js
```

## Next session priorities

1. Live-X checklist (WORKLIST P0 remaining).
2. Optional: signed-in status pill in Side Panel.
3. P1: Include replies / quoted media switches; filename template settings; better badges/counts.
4. Later: bookmarks/likes sources; retire or migrate popup DOM bulk into Side Panel queue.
