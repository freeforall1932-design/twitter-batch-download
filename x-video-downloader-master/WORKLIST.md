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
| Side Panel profile-media discovery | Implemented, requires live-X validation | The Discover control normalizes a profile target, reads current X bundle metadata, resolves the user, and pushes discovered media into the queue. |
| Full-profile pagination / end-of-timeline completion | Implemented, requires live-X validation | Follows the bottom cursor until the cap, no/repeated cursor, or Stop discovery. |
| Original post / repost / reply / quote inclusion rules | Partial | Original posts are scanned; the existing Include reposts option is now consumed. Replies and quoted media remain explicit future options. |
| Discovery progress and rate-limit status | Partial | Resolving/page/found/completed/stopped/error states are shown. A visible retry countdown remains to be added. |
| Queue filename metadata | Implemented | Queue records include author, post date, tweet ID, media ID, thumbnail, repost flag, and filename. |
| Queue retries / download byte progress | Implemented, requires browser validation | Up to three attempts for start/interruption failures, manual Retry failed action, and per-item percentage when Chrome exposes byte deltas. |
| ZIP from Side Panel queue | Not connected | ZIP writer exists; old `useZip` flag is unused by current UI. |
| Bookmarks / likes full scan | Not implemented | Existing DOM bulk works on loaded content only. |
| Automated browser/live-X verification | Not run | Requires a logged-in X browser session. |

## Re-review checkpoint for the next session

Before marking the profile scanner complete, re-review the code and execute the live-X checklist below against a signed-in Chrome session. Do not treat a third-party repository, a hardcoded query ID, or an old handoff as current API evidence.

1. Confirm current X page JavaScript still exposes discoverable metadata for `UserByScreenName` and `UserMedia`.
2. Compare a sanitized live first-page and cursor-page response with `runProfileDiscovery()`, `collectTweets()`, `findBottomCursor()`, and `mediaFromTweet()` in `background.js`.
3. Verify complete result counts for a small account (for example, an account with 690 media should stop at 690 rather than 9,999).
4. Verify media ordering, multi-photo uniqueness, direct MP4 selection, and original photo URLs.
5. Verify Include reposts off/on; keep quote/reply media excluded until their dedicated options are implemented.
6. Verify a 1-download and 2-download queue, retry behavior, Stop scan, Stop after active downloads, and a Side Panel reload.
7. Record sanitized failures and update the parser/error handling before adding more source types.

## Next implementation sequence

### P0 — Live-X validation and hardening

1. Run the re-review checklist with a signed-in X account and a small public profile.
2. Use sanitized current first/cursor-page media responses to make operation extraction, variables, features, instruction parsing, cursor parsing, and repost logic exact.
3. Add specific error handling for expired login, protected account, deleted content, NSFW state, operation metadata failure, and rate limiting.
4. Add a visible rate-limit retry countdown and regression fixtures from sanitized data.

### P1 — Inclusion and review UX

1. Add explicit Include replies and Include quoted media switches; do not include these implicitly.
2. Mark reposted media in the queue and retain both original author and reposting account where the live response exposes them.
3. Add item counts by photo/video/GIF and better thumbnail/badge presentation.
4. Add configurable filename templates and a video-quality preference.

### P2 — Other timeline sources

1. Authenticated bookmarks pagination.
2. Likes pagination.
3. Full user posts/replies timeline source.
4. Search / date-range results.
5. Import currently loaded DOM media into the same Side Panel queue.

### P3 — Robustness and optional features

1. Download history UI and stronger resume policy after browser/extension restart.
2. ZIP output as an explicit Side Panel queue export.
3. HLS/live-media policy and support after direct MP4 coverage is verified.
4. Firefox MV3 compatibility.
5. Direct avatar/banner download.
6. Improve original photo extension detection using content type where available.

## Bucket list — later / do not start before P0

- Rebuild the old popup DOM auto-scroll bulk flow around the Side Panel queue, or retire it after a migration plan.
- Per-tweet action-bar controls for “Add to queue” / “Download this media.”
- Gallery/list/grid queue view modes, preview modal, open-tweet links, and queue sorting choices.
- Parallel download tuning above two only after rate-limit and reliability testing.
- ZIP grouping by account/date/media type.
- Custom folders and filename templates such as `{date}_{author}_{tweetId}_{index}`.
- Skip known/downloaded media and user-visible download history export.
- Animated GIF conversion, HLS merging, or native companion integration only if there is a clear supported use case.
- Firefox compatibility, accessibility pass, localization, and automated UI tests.

## Reference research completed

### yt-dlp (`yt_dlp/extractor/twitter.py`)

- The reviewed current file used `2ICDjqPd81tulZcYrtpTuQ/TweetResultByRestId` for a single tweet.
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
