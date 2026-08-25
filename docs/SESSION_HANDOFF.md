# Session Handoff — X Media Downloader

**Prepared:** 2026-08-25

## Project and branch

- Repository: `freeforall1932-design/twitter-batch-download`
- Extension directory: `extension/` (load-unpacked root)
- Previous Arena session branch `arena/01a0367e-twitter-batch-download` — **merged into `main`** (commit `66fab6e`).
- Working branch for this Arena session: `arena/01a036a9-twitter-batch-download`
- Recent commits:
  - cleanup / PR batch (prior handoff): remove deprecated ZIP path, legacy message handlers, dead bulk flags
  - `4cc3782` — Rank S live capture bridge + Rank A download fallbacks
  - `93940d8` — Discovery error classification, rate-limit countdown, fixtures
  - `14d2c4d` — Baseline upload

The extension has **no build step**, package manager, TypeScript, or server. Reload it in `chrome://extensions` after changes and load **`extension/`** as the unpacked extension.

### Repository layout (2026-08-25 restructure)

```
extension/                 # ← Load unpacked target (manifest.json at root)
tests/                     # node --test tests/background.test.js
scripts/package-release.sh # zip extension/ → releases/x-media-downloader-v<version>.zip
releases/                  # generated zips (gitignored)
docs/                      # WORKLIST.md, SESSION_HANDOFF.md, IMPROVEMENT_LOG.md
reference/scrapyard/       # abandoned extensions, reference only: rank-s-plucker-xbd / rank-a-video-downloader / rank-b-x-exporter
```

Old names → new names: `x-video-downloader-master/` → `extension/`; docs moved out of the extension root; `abandoned chrome extension scrapyard for use/` → `reference/scrapyard/` (ranks flattened).

## Product direction

The main product is a **Chrome Side Panel media queue** with a Rank-S-style scroll-capture workflow first, not only one-button-per-tweet downloading and not primarily a background crawler.

A user should be able to:

1. Open the Side Panel and land on **Scroll capture** by default.
2. Open / refresh an X profile or `/media` page and manually scroll normally.
3. See media listed from X's own timeline GraphQL responses and visible DOM photos, without first running a separate profile crawl.
4. Optionally use Side Panel **Start auto-scroll** when they want the extension to scroll for them.
5. Review tab-scoped lists, tick individual items or Select all in tab, and download selected/all with **1 or 2** concurrent Chrome downloads.
6. Use **Remote fetch** as the secondary/advanced tab: paste `@username`, a profile URL, or `/media` URL and discover with an upper cap, default **99,999**.
   - Cap is an upper bound, not a target (e.g. 690 media → complete at 690).
   - Local community cap only — not a third-party paid/free tier.
   - Remote fetch can hit X rate limits sooner than user-driven scrolling, so it should not be the first impression.
7. Optionally include reposted media for Remote fetch. Replies / quoted media are future explicit options.

Per-tweet action-bar buttons and the old popup auto-scroll remain supported but are secondary / fallback surfaces.

## Security and authentication policy

Do **not** ask the user to paste passwords, API keys, `auth_token`, `ct0`, or Cookie headers.

- Self-hosted against the **signed-in X session only**.
- No third-party account, subscription, activation, license, or tier service.
- `background.js` reads `ct0` / `auth_token` cookies and Bearer token (page capture or public fallback).
- Live network capture may remember non-cookie request headers (`authorization`, `x-csrf-token`, `x-client-transaction-id`, …). **Cookie header values are never stored in the capture bag.**
- Do not display, export, log, or persist separate token values in the UI.

## Current architecture (post scroll-capture UX pass)

| File | Role |
|---|---|
| `manifest.json` | MV3, sidePanel, cookies/downloads/storage/scripting. Content scripts: `injected.js` (MAIN, document_start) + `content.js` (isolated, document_start). Hosts: x.com / twitter.com / twimg CDN only. |
| `background.js` | Auth, GraphQL, source-tagged queue, remote discovery, downloads, capture bag, local timeline response ingestion. **No ZIP.** |
| `injected.js` | MAIN-world XHR/fetch observer → posts GraphQL op metadata + safe headers and parses cloned GraphQL responses for scroll-capture listing. |
| `content.js` | Forwards captures/responses; action-bar buttons; Side Panel scroll-capture commands; visible DOM photo listing; legacy popup DOM bulk. |
| `sidepanel.html/js/css` | Two-tab Side Panel: default Scroll capture + secondary Remote fetch; tab-scoped review/download/clear actions. |
| `popup.html/js` | Open Side Panel + legacy page bulk controls. |
| `tests/` | Node VM unit tests + sanitized fixtures. |

### Removed / deprecated (do not reintroduce without product decision)

- `lib/zip-writer.js` and all ZIP assembly (`downloadZip`, `fetchAsArrayBuffer`, `zipBuffers`, `importScripts` of zip-writer).
- Legacy runtime messages: `getVideoUrl`, `downloadVideo`, `downloadZip`, `fetchAsArrayBuffer`.
- Unused `webRequest` permission.
- Dead `useZip` / `bulkId` state in `content.js`.
- Accidental `TweetDetail` fallback for single-tweet media (wrong variables/shape).

### Runtime messages (current)

**Queue:** `queueGet`, `queueAdd`, `queueSelect`, `queueSelectVisible`, `queueSetConcurrency`, `queueStart`, `queueStop`, `queueRetryFailed`, `queueClearFinished`, `queueClearAll`

**Discovery:** `discoveryGet`, `discoveryStart` `{ target, limit, includeRetweets }`, `discoveryStop`  
State also exposes `errorCode`, `retryAfterMs`, `retryUntil`.

**Other:** `networkCapture`, `localTimelineCapture`, `initEnv`, `getTweetMedia`, `downloadFile`, Side Panel content commands `localCaptureWatch` / `localCaptureStart` / `localCaptureStop` / `localCaptureStatus`, content bulk `start` / `stop` / `getStatus`

### Queue item shape

```js
{
  id: "tweetId-mediaId",
  url, type: "photo" | "video",
  thumbnail, author, date, tweetId, mediaId,
  source: "scroll" | "remote",
  isRepost, filename, // x-media/{user}_{text}_{tweetId}_{index}.{ext}
  selected, status, // discovered|queued|starting|downloading|completed|failed
  attempts, bytesReceived, totalBytes, downloadId?, error?
}
```

## What needs live-X validation (not complete offline)

- New Scroll capture default tab on real X pages: active-tab watch, manual-scroll listing, optional auto-scroll, tab-scoped clear/download.
- Live capture bridge on real X tabs (op IDs, features, transaction id, response parsing).
- Manual-scroll listing of both already-rendered DOM photos and GraphQL-response videos/photos.
- `UserByScreenName` + `UserMedia` (or photo/video timeline aliases) response shapes for Remote fetch.
- Repost on/off, multi-photo, highest-bitrate MP4, original photos.
- Rate-limit countdown against real 429s and Remote fetch stop behavior.
- Protected / NSFW / expired session messaging.
- Action-bar selectors and single-tweet GraphQL.

Do **not** declare P0 complete without a signed-in Chrome check.

## Required live data if something fails

Ask for a **sanitized** Network capture only (no credentials):

1. For Scroll capture: sanitized X GraphQL response shape from a normal manually scrolled `/media` page, especially entries containing videos/photos.
2. For Remote fetch: first `…/media` GraphQL request URL + variables/features + JSON body sample.
3. Cursor page request/response.
4. Optional: 429, protected, deleted, NSFW errors.
5. Redact: cookies, auth headers, private content.

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
# from repo root
node --check extension/background.js extension/content.js extension/popup.js extension/sidepanel.js extension/injected.js
node --test tests/background.test.js
scripts/package-release.sh            # → releases/x-media-downloader-v<version>.zip
```

## Next session priorities

1. **Try the new default Scroll capture:** reload unpacked `extension/`, hard-refresh X, open Side Panel, keep Scroll capture selected, and manually scroll an X `/media` page.
2. Verify media listing, duplicate avoidance, tab-scoped Select all / Download all / Clear history, and optional auto-scroll start/stop.
3. Verify Remote fetch remains usable as a secondary advanced fallback and does not feel like the primary path.
4. Add diagnostics/status next if live testing is unclear: active X tab, watching status, last captured ops, warm/cold capture, sanitized copy-debug-report.
5. Cut the first release zip only after the Scroll capture live pass; bump manifest version on next user-visible release.
6. P1: stronger live response parsing, source/count badges, Include replies / quoted media switches, filename template settings.
7. Later: simplify popup into an Open Side Panel launcher after Side Panel scroll capture replaces it.
