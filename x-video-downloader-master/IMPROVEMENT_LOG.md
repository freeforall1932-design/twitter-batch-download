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
