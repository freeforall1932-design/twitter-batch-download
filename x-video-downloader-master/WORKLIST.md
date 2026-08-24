# Development Worklist

_Last audited: 2026-08-24_

## Product target

A signed-in Chrome user can enter an X profile URL or `@username`, discover that account's media (up to a configurable cap, default **9,999**), review media newest-first in the Side Panel, select individual files or all files, and download with **one or two** active downloads only. A cap is an upper bound: if a timeline ends after 690 items, discovery completes normally at 690.

No manual API key, password, `auth_token`, or cookie-pasting field will be added. The extension must use the existing signed-in X browser session and clearly say so in the UI.

## Current implementation audit

| Area | Status | Evidence / gap |
|---|---|---|
| Manifest V3 extension / no build step | Done | Plain JS extension under this folder. |
| Signed-in session setup | Partial | `background.js` reads `ct0`, cookie string, and Bearer token. Add a user-facing signed-in/error state and improve auth-error classification. |
| Single-tweet GraphQL media lookup | Done, needs live verification | `TweetResultByRestId` query is implemented. Current yt-dlp still uses query ID `2ICDjqPd81tulZcYrtpTuQ`. |
| Video and photo parsing | Done, needs live verification | Highest bitrate MP4 and `?name=orig` photos are parsed. |
| Per-tweet action button | Done, needs selector verification | `content.js` injects into `article[data-testid="tweet"] [role="group"]`. |
| Existing visible-page auto-scroll downloader | Done | Popup starts a DOM-scroll loop. It is separate from Side Panel discovery and only sees loaded tweets. |
| Side Panel UI | Done | Target input, discovery cap defaulting to 9,999, queue view, media filter, individual selection, Select all, Download selected/all. |
| Persistent queue | Done | `chrome.storage.local` queue state in `background.js`. |
| 1–2 download scheduler | Done | A new item starts only after `chrome.downloads.onChanged` reports a prior item terminal; default 2. |
| Side Panel profile-media discovery | Not implemented | The Discover control currently validates/saves its target but cannot yet populate the queue. This is the next feature. |
| Full-profile pagination / end-of-timeline completion | Not implemented | Need cursor extraction, cursor requests, `no more results` completion, and Stop discovery. |
| Original post / repost / reply / quote inclusion rules | Not implemented | Existing UI has an `Include reposts` setting only; no connector consumes it yet. |
| Discovery progress and rate-limit status | Not implemented | Add resolving, page count, items found, retry countdown, completed / stopped state. |
| Queue filename metadata | Not implemented | Queue records need stable filename, author, post date, tweet ID, media index, thumbnail, source type. |
| Queue retries / download byte progress | Not implemented | Add failed-item retry and progress from `chrome.downloads` deltas. |
| ZIP from Side Panel queue | Not connected | ZIP writer exists; old `useZip` flag is unused by current UI. |
| Bookmarks / likes full scan | Not implemented | Existing DOM bulk works on loaded content only. |
| Automated browser/live-X verification | Not run | Requires a logged-in X browser session. |

## Next implementation sequence

### P0 — Full profile media discovery

1. Normalize a submitted `@username`, profile URL, or `/media` URL.
2. Confirm an X signed-in session exists and present actionable errors without exposing cookies/tokens.
3. Resolve the profile and retrieve media timeline pages through the current internal GraphQL request shape.
4. Parse every timeline instruction entry, including media in nested/reposted results, into normalized queue records.
5. Follow the bottom cursor until the cap is hit, a cursor is absent/repeated, or the user presses Stop.
6. Dedupe by stable `tweet ID + media ID`; prepend each discovery batch so the queue remains newest-first.
7. Send live discovery progress and rate-limit/backoff status to the Side Panel.

### P1 — Inclusion and review UX

1. Make the scan source explicit: original posts, reposts, replies, and quoted media.
2. Mark reposted media in the queue and keep its original author and the reposting account separate.
3. Add item counts by type, a retry-failed action, and clear labels for completed/skipped/failed.
4. Create collision-safe filenames from post date, author, tweet ID, and media index.

### P2 — Other timeline sources

1. Authenticated bookmarks pagination.
2. Likes pagination.
3. Search / date-range results.
4. Optional current-page DOM scan import into the same Side Panel queue.

### P3 — Robustness and optional features

1. Actual byte progress (where Chrome exposes it) and download-history records.
2. Retry policy for failed Chrome downloads.
3. ZIP as an explicit queue export option.
4. HLS/live media policy and any native companion work only after direct MP4 coverage is verified.

## Reference research completed

### yt-dlp (`yt_dlp/extractor/twitter.py`)

- The current file still uses `2ICDjqPd81tulZcYrtpTuQ/TweetResultByRestId` for a single tweet.
- It uses the public app Bearer token plus `ct0` for signed-in requests; its `is_logged_in` check is based on an existing `auth_token` cookie.
- It does **not** provide a ready-made `UserMedia` query ID in that extractor, so it is a reference for authenticated single-tweet parsing, not a turnkey full-profile scanner.

### EltonChou/TwitterMediaHarvest

- Its response-cache layer explicitly supports `UserMedia`, `UserTweets`, `UserTweetsAndReplies`, Likes, Bookmarks, Home, Search, and TweetDetail GraphQL responses.
- It parses timeline `instructions` rather than relying only on visible DOM cards. This validates the intended cursor/instruction-based queue adapter.
- Its article parser includes useful selector fallbacks (`[data-testid="videoPlayer"]`, `[data-testid="playButton"]`, `[data-testid="videoComponent"]`) and handles quoted-content false positives.
- It is TypeScript and uses a substantially different architecture; copy neither its build system nor its license-bound source into this plain-JS extension.

### afkarxyz/Twitter-X-Media-Batch-Downloader

- Its UI validates the desired product pattern: newest-first sort, filter counts, per-item selection, Select all, download selected/all, item status, and repost badges.
- Its data model preserves direct media URL, tweet ID, type, thumbnail, timestamp, original author, and repost flag—fields this queue adapter should retain.
- It uses an external native extractor and accepts a manually supplied auth token. That is **not** appropriate for this Chrome extension: the extension should use Chrome's existing signed-in cookie session and should not add a token input.

## Validation checklist before declaring P0 complete

- Logged-in public profile with fewer than cap items ends cleanly (for example, 690 found).
- Profile with more than cap items stops exactly at the configured cap.
- Multi-photo posts produce distinct queue items.
- Videos and animated GIFs produce direct MP4 queue items when available.
- Reposts are absent when disabled and marked/present when enabled.
- Protected, suspended, deleted, NSFW, logged-out, and rate-limited cases show specific recoverable status.
- Stop discovery prevents another cursor request; active downloads continue only when the download scheduler is intentionally running.
- Reloading the Side Panel retains queue, selection, and terminal states.
