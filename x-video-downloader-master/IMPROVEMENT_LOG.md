# Improvement Log

Chronological implementation record for X Media Downloader.

## 2026-08-24 — Persistent Side Panel batch queue

**Commit:** `b211e8b Add side panel batch queue foundation`

### Added
- Chrome Side Panel declaration and an **Open batch queue** popup action.
- Side Panel target input for `@username` or an X profile/media URL.
- Default scan cap of **9,999**. This is an upper limit, not an expected result count.
- Persistent queue stored in `chrome.storage.local`.
- Individual item checkboxes, Select all, queue filter, Download selected, Download all, and Clear finished controls.
- Queue rows designed for thumbnail, author, timestamp, media type, and status.
- A one-or-two concurrent download scheduler. A replacement item is scheduled only after Chrome reports an active download terminal (`complete` or `interrupted`).
- Stop behavior that prevents future scheduling while leaving already active Chrome downloads alone.

### Important implementation notes
- The queue state key is `batchDownloadQueueV1`.
- Queue additions use the `queueAdd` runtime message and deduplicate by queue item ID.
- Side Panel UI uses `queueGet`, `queueSelect`, `queueSelectVisible`, `queueStart`, `queueStop`, `queueSetConcurrency`, and `queueClearFinished`.

## 2026-08-24 — Worklist and reference review

**Commit:** `58c2f32 Document queue discovery implementation worklist`

### Added
- `WORKLIST.md` with implementation audit, priority sequencing, reference findings, and validation checklist.

### Reference review completed
- **yt-dlp:** Current `TweetResultByRestId` operation still used query ID `2ICDjqPd81tulZcYrtpTuQ` at review time. It is a reference for single-tweet authenticated GraphQL requests, not a complete profile-media crawler.
- **EltonChou/TwitterMediaHarvest:** Its response cache supports `UserMedia`, `UserTweets`, replies, Likes, Bookmarks, Search, and timeline instruction parsing. This validates an instruction/cursor-based scanner design.
- **afkarxyz/Twitter-X-Media-Batch-Downloader:** Its newest-first media review, selection, status, repost, and progress UX informed this Side Panel direction. Its native-extractor/manual-token architecture is intentionally not copied.

## 2026-08-24 — Profile media discovery connector

**Commit:** `3947598 Add profile media discovery to side panel`

### Added
- Target normalization for `@username`, X profile URLs, and `/media` URLs.
- Discovery state persisted as `profileDiscoveryV1`.
- Signed-in X session check using the existing extension cookie/session mechanism; no manual token, password, or API-key field.
- Runtime operation metadata discovery from JavaScript bundles in an open X tab for:
  - `UserByScreenName`
  - `UserMedia`
- User profile resolution, paginated `UserMedia` requests, bottom-cursor extraction, deduped queue insertion, and terminal conditions:
  - configured cap reached;
  - no cursor;
  - repeated cursor;
  - user stops the scan.
- Discovery UI states: resolving, reading page metadata, fetching page, found count, completed, stopped, and error.
- `Include reposts` now affects profile-media discovery.
- Stop scan control.

### Deliberate boundaries
- Quoted media is intentionally excluded until there is a visible **Include quoted media** option.
- Replies are not yet a separate source mode.
- The implementation requires live X validation: query IDs can be discovered dynamically, but the exact operation variable and response shapes remain subject to X frontend changes.

## 2026-08-24 — Queue retries and download progress

**Commit:** `5ee8ad3 Add queue retry and download progress states`

### Added
- Up to three attempts when a download fails to start or Chrome reports it interrupted.
- **Retry failed** queue action.
- Attempts, byte counts, and total byte counts stored on queue items.
- Per-item percentage display when Chrome publishes `bytesReceived` and `totalBytes` changes.
- Failure reason is retained as a queue-item tooltip.

### Remaining limitation
- Chrome does not always expose total bytes for a CDN transfer; percentage may be unavailable even while a file downloads.
- Retry/backoff timing needs live browser validation against actual CDN failures and rate limiting.

## 2026-08-24 — Exact discovery caps and deterministic counting

### Fixed
- Discovery now counts unique media encountered during the current scan instead of inferring the count from the mutable global queue length.
- The final page is trimmed to the remaining capacity, so a scan cannot overshoot its configured media limit.
- Media repeated across cursor pages no longer consumes the cap more than once.
- Queue additions now reject duplicate IDs within a single incoming batch as well as IDs already in the queue.

### Validation
- Added local Node tests for exact cap selection, cross-page deduplication, and same-batch queue deduplication.
- No live X data or signed-in session is required for these deterministic tests.

## 2026-08-24 — Stable newest-first discovery ordering

### Fixed
- Older cursor pages are now placed after media from earlier, newer pages instead of being prepended ahead of them.
- A scan maintains the order supplied by the profile timeline rather than sorting potentially unreliable timestamps.
- Media already present in the queue is moved into the current scan's authoritative order, while unrelated queue records retain their relative order behind the scanned group.

### Validation
- Added local tests covering multiple discovery pages, an existing unrelated queue record, and repair of matching records left in an older incorrect order.

## 2026-08-24 — Serialized download scheduling

### Fixed
- Queue scheduling passes are now serialized so runtime commands, retry timers, and simultaneous Chrome terminal events cannot reserve slots concurrently.
- Items in both `starting` and `downloading` states consume concurrency slots, preventing a slow `chrome.downloads.download()` callback from allowing extra starts.
- The existing one-or-two active download policy and terminal-event refill behavior remain unchanged.

### Validation
- Added delayed-download tests that issue overlapping scheduling requests and verify only two downloads start, then exactly one replacement starts after a terminal event.
- Added a focused test confirming a `starting` item blocks the sole slot when concurrency is one.

## 2026-08-24 — Atomic discovery startup

### Fixed
- Discovery now claims and persists its running state before tab lookup, authentication, metadata extraction, or network requests begin.
- Concurrent first-use state loads share one initialization promise, preventing two rapid starts from receiving separate state objects.
- Each scan receives a run ID; stale async continuations cannot overwrite the status, errors, or completion state owned by a newer run.
- Discovery-state writes are serialized snapshots so older writes cannot land after newer state.

### Validation
- Added a gated-tab test proving simultaneous Discover requests launch only one scan.
- Added a stale-run test proving an older failed lookup cannot replace newer discovery state.

## 2026-08-25 — Service-worker restart queue reconciliation

### Fixed
- When a service worker restarts, persisted `downloading` items are no longer blindly reset to `queued`. `chrome.downloads.search()` is used to inspect the stored download ID and reconcile the real state:
  - `in_progress` keeps the item as `downloading` and preserves its `downloadId`, so the scheduler does not start a second copy of the same URL.
  - `complete` marks the item `completed`, clears the `downloadId`, and applies the final byte counts.
  - `interrupted` returns the item to `queued` when retry attempts remain, otherwise marks it `failed` and preserves Chrome's error.
  - No matching Chrome download resets the item to `queued` and clears the ghost `downloadId`.
- Persisted `starting` items (a worker killed while `chrome.downloads.download()` was in flight) are now recovered to `queued` instead of being stranded forever.
- Added `chrome.runtime.onStartup` and `chrome.runtime.onInstalled` hooks that reconcile and resume a still-running queue after the browser or extension restarts.

### Validation
- Added a dual callback/promise helper for `chrome.downloads.search()` so the extension works on both modern and legacy Chrome downloads APIs.
- Added local tests covering stranded `starting`, active `in_progress` slot preservation, `complete`, retryable and exhausted `interrupted`, missing download recovery, and restart resume without duplicating an active download.
- All 14 local Node tests pass; no live X data or signed-in session required.

## 2026-08-25 — Direct filenames by post username and text (ZIP export dropped)

### Decision
- ZIP output from the Side Panel queue is intentionally out of scope. A large queue could bundle into a multi-GB archive, so media stays as direct individual files.

### Fixed
- Added `sanitizeFilePart()` and `makeMediaFilename()` helpers.
- Queue downloads are now named `x-media/{username}_{post-text}_{tweetId}_{index}.{ext}` instead of being grouped for a ZIP.
- Multi-photo/video posts remain separate files, numbered by their media index, with `conflictAction: "uniquify"` preventing overwrites.

### Validation
- Added tests that verify a photo and animated GIF from one post use the post username/text in their filenames and that username/text sanitization is deterministic.
- No live X data or signed-in session required.

## 2026-08-25 — Community cap and abandoned-extension scope

### Decision
- Drop the idea of unlocking a "paid tier" or bypassing a third-party license gate. This project is self-hosted and uses only the signed-in X session.
- The abandoned Chrome Web Store X-media extension is a **conceptual reference only** (batch fetch then download, sidebar-style review surface). It has no public source or verifiable license, so it is **not** unpacked, decompiled, or copied. Any aligned behavior is reimplemented locally.
- No third-party account, subscription, activation, or tier-checking service is added. Host permissions remain X/Twitter-only.

### Changed
- Community discovery cap raised from 9,999 to **99,999** in Side Panel, popup, and background discovery.
- Added `normalizeDiscoveryLimit()` for a single deterministic cap rule (invalid/blank → 99,999; zero/negative → 1; higher values clamped to 99,999).

### Validation
- Added a regression test for `normalizeDiscoveryLimit()`.
- All local Node tests pass; no live X data or signed-in session required.

## 2026-08-25 — P0 discovery hardening (errors, countdown, fixtures)

### Added
- `classifyDiscoveryError()` maps transport/API failures to stable codes:
  `rate_limited`, `auth_expired`, `auth_required`, `protected`, `nsfw`,
  `not_found`, `operation_metadata`, `invalid_target`, `unknown`.
- `resolveUserResult()` classifies protected/suspended/missing profiles from
  `UserByScreenName` payloads (`UserUnavailable`).
- Visible rate-limit retry countdown during discovery:
  - `fetchWithRetry()` publishes wait windows via `rateLimitStatusListener`
  - discovery state carries `retryAfterMs`, `retryUntil`, and `errorCode`
  - Side Panel shows a live yellow countdown and keeps it ticking between
    `queueChanged` messages
- Sanitized regression fixtures under `tests/fixtures/`:
  - `user-by-screen-name-ok.json`
  - `user-by-screen-name-protected.json`
  - `user-media-page1.json` (multi-photo, video bitrate pick, repost, tombstone, bottom cursor)
  - `user-media-page2.json` (cursor page)

### Changed
- Discovery GraphQL `features` / `fieldToggles` expanded toward current X web
  timeline request shape (aligned with Rank S Plucker captures; still needs
  live signed-in verification).
- `UserMedia` variables now include `withV2Timeline`, `withVoice`, and
  `withQuickPromoteEligibilityTweetFields`; page size set to 20 to reduce 429s.
- Timeline instruction extraction accepts both `timeline_v2` and legacy
  `timeline` paths.
- Bottom-cursor finder prefers the last `TimelineTimelineCursor` / `Bottom`
  entry (Plucker-style).
- Soft-unwrap skips deleted/NSFW individual timeline entries without aborting
  the whole scan; profile-level failures still stop discovery.
- Session check now also requires an `auth_token` cookie (not only `ct0`).
- Side Panel shows a small **repost** badge on reposted queue items.

### Rank S scrapyard review (supporting only)
- **Plucker XBD (RANK S):** Feature-rich batch UI + media timeline intercept, but
  depends on `apixbd.plucker.io` license/plan gating. Reused only conceptual
  patterns (features blob, cursor entry shape, filename ideas). No third-party
  auth/tier code imported.
- **Rank A action-bar downloader:** Clean local filename/folder helpers and
  action-bar UX; useful later for per-tweet “Add to queue”, not required for P0.
- **Rank B exporter:** Supporting filter/batch code; lower priority UI.

### Validation
- All **23** local Node tests pass (`node --test tests/background.test.js`).
- No live X data or signed-in session required for these tests.
- Live-X checklist in WORKLIST remains open before declaring P0 complete.

## 2026-08-25 — Rank S/A stability review (live capture + download fallbacks)

### Review priority applied
1. **Rank S (Plucker XBD)** first — battle-tested intercept of live GraphQL query IDs, features/variables, and request headers (`authorization`, `x-csrf-token`, `x-client-transaction-id`). Rejected its `apixbd.plucker.io` / plan_code / daily-limit gates.
2. **Rank A** second — Invalid-filename download ladder, photo `format=` extension detection, safer path sanitization.
3. **Rank B** last — ExtPay licensing ignored; no useful GraphQL scanner to port.

### Added
- `injected.js` MAIN-world network bridge (document_start) that observes XHR/fetch GraphQL calls and posts operation metadata + safe headers to the isolated content script.
- `content.js` forwards `xdlNetworkCapture` to the service worker (`networkCapture` message).
- `background.js` capture bag (`__xdlNetworkCapture`) with 30-minute freshness:
  - prefers live `UserMedia` / `UserPhotoTimeline` / `UserVideoTimeline` / `UserByScreenName` query IDs over bundle scrape
  - merges live features/fieldToggles/variables templates into discovery requests
  - reuses `x-client-transaction-id` and other captured X headers
  - never stores Cookie header values in the capture bag
- `downloadFile()` retries with safer path ladder on Chrome `Invalid filename` (Rank S/A pattern).
- `normalizePhotoUrl()` forces `name=orig` while preserving `format=`.
- Discovery stops after repeated empty pages (in addition to missing/repeated cursor).
- Manifest v3.1: MAIN-world content script, dropped unused `webRequest` permission.

### Deliberately not ported
- Any third-party account, license, activation, tier, or daily download counter.
- Plucker’s external webapp task pipeline.
- Rank B ExtPay payment hooks.

### Validation
- All **27** local Node tests pass.
- No live X session required for unit tests; live signed-in validation still required for P0 complete.
