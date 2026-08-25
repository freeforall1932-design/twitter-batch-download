# Improvement Log

Chronological implementation record for X Media Downloader.

## 2026-08-25 — Full pre-release code review (WORKLIST checklist) — contract gaps found and closed

### Motivation
Before declaring v3.2 ready for live round-3 testing, the `WORKLIST.md`
code-review checklist was run end to end. It had not been run in full previously;
only the reported `appendChild` crash had been investigated.

### Verified clean (each re-checked against the shipped tree, not the docs)

- **No third-party hosts / license / tier gates.** The only `plucker` / `tier`
  matches in `extension/` are code comments; no external API host.
- **No ZIP path.** The only `zip` match is a comment explaining why ZIP was dropped.
- **No manual token/password input.** No `type="password"`, no token/cookie prompt.
- **No build tooling, no non-X permissions.** No `package.json`/`tsconfig`/lockfile
  outside `reference/`; manifest hosts are x.com, twitter.com, and three twimg/X CDNs.
- **Every deprecated symbol is gone.** `downloadZip`, `fetchAsArrayBuffer`,
  `getVideoUrl`, `downloadVideo`, `zipBuffers`, `ZipWriter`, `useZip`, `bulkId`,
  `webRequest` — 0 hits in `extension/`.
- **`TweetDetail` is request-metadata only.** It sits in `injected.js`
  `TRACKED_OPS`, which is explicitly documented as *not* gating response parsing
  (`injected.js:100` returns the parsed payload regardless). `getTweetMedia`
  still reads only `getCapturedOperation("TweetResultByRestId")`.
- **Capture bag never stores cookies** (`background.js:242-243` skips the
  `cookie` header) and **fresh CSRF from cookies overrides a stale capture**
  (`background.js:317-318`).
- **Discovery stop conditions all present** in one guard
  (`background.js:1621`): no cursor, repeated cursor, and `emptyPages >= 2`;
  plus cap (`state.found < limit`), user stop (`!state.stopRequested`), and
  `isCurrentDiscoveryRun()` staleness checks at 14 points in the loop.
- **No missing DOM ids.** Every `$("#id")` in `sidepanel.js` exists in
  `sidepanel.html`, and both `popup.js` ids exist in `popup.html` — so no
  `null.addEventListener` crash class. (`remoteTabBtn`, `scrollTabBtn`,
  `tabStatusDot`, `downloadNotice` look unused by id but are wired via the
  `.tab` class + `data-tab` or are static CSS/text — not dead markup.)
- **No unused functions** in `content.js`, `injected.js`, `sidepanel.js`.

### Found and fixed

1. **Two message-contract commands were unreachable.** `background.js` handled
   `queueClearFinished` (line 1030) and `queueClearDownloadedHistory` (line 1023),
   and `SESSION_HANDOFF.md` §4 lists both in the contract — but **nothing in the
   Side Panel ever sent either**. `queueClearFinished` was a real user-facing
   control in the 2026-08-24 "Persistent Side Panel batch queue" entry and was
   lost in the v3.2 rework; the `Clear list` button sends `queueClearAll`
   instead. `queueClearDownloadedHistory`'s *handler* was covered by a test, but
   no button could reach it, so the documented "resettable" skip-history was not
   actually resettable by a user.
   - **Fixed:** added `Clear finished` and `Reset downloaded history` buttons to
     the queue-maintenance toolbar (`sidepanel.html`), wired in `sidepanel.js`.
     Both handlers already returned `publicQueueState()`, so no background change
     was needed. Chosen over deletion because the docs advertise both.
2. **`getCapturedHeaders()` has no shipped caller.** Declared at
   `background.js:275`, used only by `tests/background.test.js:690` as a test
   seam. Left in place deliberately; recorded so it is not mistaken for dead code.
3. **`scrollRescan` is handled in `content.js:929` but never sent.** Read-only
   rescan hook documented in the contract; harmless, left wired for a future
   panel control and allowlisted explicitly in the new contract test.

### Added

- **A structural contract test** (`tests/background.test.js`): cross-checks the
  shipped sources so every `action:` the UI sends has a handler in
  `background.js` or `content.js`, and every `background.js` handler has a sender
  (allowlist: `scrollRescan`). This is the test that should have existed when
  v3.2 dropped those two controls.
- **`queueClearFinished` behaviour test** — completed/failed rows are dropped,
  unfinished rows survive.
- Both new tests were verified to fail against the pre-fix tree: unwiring the new
  `clearFinishedBtn` listener makes the contract test report
  `"queueClearFinished" is handled in background.js but no UI sends it`.

### Validation

- `node --test tests/*.test.js` — **48** pass (was 46).
- `node --check` clean on all five extension scripts and both test files.
- Id audit and message-contract audit both report zero unhandled/missing entries.
- `extension/manifest.json` bumped **3.2 → 3.3**: two new toolbar buttons plus the
   crash fix are user-visible, per the WORKLIST rule on version bumps. No release
   zip cut yet — `scripts/package-release.sh` should run only after round 3 passes.

### Still not verified (unchanged)

Nothing here was run in a signed-in Chrome. The live-X round-3 checklist in
`WORKLIST.md` remains the gating item before P0 can be called complete.

## 2026-08-25 — Reported `appendChild` on null crash: traced, partly already fixed, residual gap closed

### Report
A live error was reported against `https://x.com/real_loonarae/media`:

```
Uncaught TypeError: Cannot read properties of null (reading 'appendChild')
  content.js:105
```

Line 105 of the reported file is `document.head.appendChild(style);` — the
unguarded stylesheet injection.

### Findings

1. **The reported file is a pre-v3.2 build, not this repo's `content.js`.** The
   copy that produced the trace is 754 lines and still contains the
   `localCaptureWatch/Start/Stop/Status` handlers, the popup `start` / `stop` /
   `getStatus` bulk loop, `mainLoop()`, and `getVisibleMediaTweets()`. All of
   those are listed as *removed in v3.2* in `SESSION_HANDOFF.md` §4. The current
   `extension/content.js` is 924 lines and contains none of them
   (`grep -n "localCapture\|mainLoop\|getVisibleMediaTweets" extension/content.js`
   returns nothing). **Anyone still seeing this trace is running a stale unpacked
   folder — reload the extension, or confirm the folder is this repo's
   `extension/`.**
2. **The exact crash the user hit (null `<head>`) was already addressed.** The
   injection had become `(document.head || document.documentElement).appendChild(style);`.
   Verified by loading the real script with `document.head === null`: no throw,
   stylesheet lands on `<html>`. This is the documented `document_start` case —
   `<head>` may not exist yet while `<html>` does.
3. **But the guard was incomplete and untested.** At `document_start` both
   `document.head` *and* `document.documentElement` can be null. Loading the real
   script in that state still threw the identical
   `TypeError: Cannot read properties of null (reading 'appendChild')`, now at
   `content.js:234`, killing the whole IIFE so capture never started on that tab.
   `tests/content.test.js` never caught this because its DOM shim hardcodes a
   non-null `head` *and* `documentElement`, so the null branch was never executed.
   No doc recorded the fallback either.

### Changed

- `extension/content.js`: stylesheet injection is now `injectStyles()` — it tries
  `document.head`, then `document.documentElement`, and if neither exists yet it
  arms a non-subtree `MutationObserver` on the `Document` node plus a
  `DOMContentLoaded` listener and retries. It never throws, so a null root can no
  longer abort the script and silently kill capture.
- `tests/content.test.js`: `loadContentScript()` takes a `documentOptions`
  override (`head` / `documentElement` / `body`) and the `MutationObserver` shim
  now records instances, so a `document_start` with a missing root is testable.
  Three regression tests added: null `<head>`; null `<head>` *and* null `<html>`
  (retry via observer); deferred attach via `DOMContentLoaded` alone. Each also
  asserts capture still lists media afterwards, since the old throw killed
  capture, not just styling.

### Validation

- `node --test tests/*.test.js` — **46** pass (was 43).
- The three new tests were run against the pre-fix line to confirm they are real
  regressions: the two null-root tests fail without the fix, the null-`<head>`
  test passes without it (proving finding #2 — that case was already handled).
- `node --check` clean on all five extension scripts.

## 2026-08-25 — Session handoff rewritten as a review-driven document

### Motivation
The handoff described state but not *process*. A new session had no explicit
instruction to review the improvement log and worklist first, and no rule about
writing findings back, so context was rediscovered each time.

### Changed
- `docs/SESSION_HANDOFF.md` rewritten with a numbered structure and a new
  **"Start here"** section: a table explaining what each of the three docs
  answers, plus the six-step review loop (read log → read worklist → read
  handoff → apply user input → work + test → write back to all three).
- Added a **"User input carried into the next session"** slot so live-test
  feedback and open product questions survive the session boundary. Current
  open questions recorded: did v3.2 fix homepage/route capture, is "Fast" fast
  enough, should the two tab lists be unified, are per-batch subfolders wanted.
- Added **"Design decisions that are deliberate — do not simplify these away"**:
  six items (no response allowlist, unconditional capture start, SPA route
  watcher + replay, rate-bounded video resolve, single download action, popup
  has no loop), each tied to the live failure it fixes.
- Expanded the removed/deprecated list with the v3.2 removals
  (`localCapture*`, popup bulk commands, `Watch current tab`, auto-scroll limit,
  `Download all in tab`) and documented the MAIN ↔ isolated world message pairs.
- Corrected stale content: branch, v3.1-era architecture notes, the
  "popup auto-scroll remains supported" line, and the duplicated
  commands/testing sections.
- `docs/WORKLIST.md`: added a **Session workflow** section mirroring the loop and
  pointing at the do-not-simplify list; marked the manifest-version P0 item done.

### Unchanged
- No extension code touched. Docs only; 43 tests still pass.

## 2026-08-25 — Live-testing fixes: always-on capture, SPA routes, one download action

Driven entirely by signed-in live-X testing feedback against v3.1.

### Root causes found

1. **Capture required an explicit "watch" command.** `content.js` only listed
   media after the Side Panel sent `localCaptureWatch` to whichever tab was
   active. Any other tab, and any view reached without the panel re-issuing the
   command, captured nothing.
2. **Response parsing was gated by an operation-name allowlist.** Both
   `injected.js` (`TRACKED_OPS`) and `background.js` dropped every GraphQL
   payload whose operation was not on a fixed list. Home timeline operations
   were never on it, which is why the homepage never captured at all.
3. **Nothing reacted to SPA route changes.** X changes `/user` → `/user/media`
   and opens posts via `history.pushState`, with no document load. The old code
   only re-armed on a real page load, so a route change in the same tab left
   capture pointing at the previous view — exactly the reported "only works
   after a reload, a new tab, or several minutes" behaviour.
4. **Two engines fought over the page.** The popup ran its own scroll+download
   loop that downloaded each item before scrolling further, while the Side Panel
   ran a separate listing loop.

### Changed

- **Capture is always on.** `content.js` starts listing at `document_start` in
  every X tab, with no watch command. `Watch current tab` is gone.
- **No operation allowlist for responses.** `injected.js` forwards any GraphQL
  response containing media markers; `handleLocalTimelineCapture` parses any
  payload. The allowlist survives only for *request metadata* used by Remote
  fetch. Home timeline, profile, `/media`, and post detail all capture now.
- **SPA route watcher.** `injected.js` patches `pushState`/`replaceState`/
  `popstate` (Rank S pattern) and emits `xdlUrlChanged`; `content.js` re-scans
  and requests a replay on every route change, with a 2.5s reconciliation sweep
  as a backstop.
- **Replay buffer.** `injected.js` keeps the last 40 media-bearing GraphQL
  payloads and replays them on request, so an extension reload, a late listener,
  or an SPA view served from X's cache without a new request still lists media.
- **Video posts resolve per-post.** DOM-visible video posts that never produced
  a GraphQL payload are resolved through `TweetResultByRestId`, rate-bounded to
  one per 700ms. This is why a profile's posts now list, not just `/media`.
- **One download action.** `Download all in tab` was removed as redundant with
  `Select all` + `Download selected`.
- **Auto-scroll rewritten.** Content-driven pacing (waits for the timeline to
  grow rather than sleeping a fixed interval), no item limit, and it never waits
  on downloads. A floating in-page badge shows progress with a Stop button.
- **Popup is a launcher.** Its competing scroll/download loop is deleted.
- **Rank A action-bar insight adopted:** every media post now gets both
  `Download` and `Add to queue`, plus toasts. Reimplemented locally.
- **Rank S "Ignore saved" adopted:** completed downloads are remembered by id
  (`downloadedMediaIdsV1`, ids only) and skipped on re-listing. Toggleable via
  `Skip already downloaded`.
- **Cross-source dedupe.** Every item carries a `mediaKey` derived from the CDN
  path, so the same photo found in the DOM and in a GraphQL payload collapses
  into one row.
- **Per-row remove**, post deep-link, and a live active-tab status pill showing
  route, posts on screen, and pending video resolves.

### Validation

- **43** Node tests pass (was 27). New `tests/content.test.js` runs the real
  `content.js` in a DOM shim and reproduces each reported failure: homepage
  capture, in-tab route change, duplicate suppression, filter behaviour, and
  auto-scroll start/stop.
- `node --check` clean on all five extension scripts.
- Side Panel ids/messages cross-checked: no unhandled message, no missing id.

## 2026-08-25 — Repo restructure: load-unpacked layout + release packaging

### Motivation
The repo root mixed the shippable extension (in `x-video-downloader-master/`, a leftover source-zip name), project docs, tests, and the abandoned-extension scrapyard (whose rank A/B folders were accidentally nested inside the rank S folder, and whose rank A extension was double-nested).

### Changed
- Project folder renamed to **`extension/`** — the single **Load unpacked** target (`manifest.json` at its root). It now contains only browser-loaded files + icons.
- Docs moved to `docs/` (`WORKLIST.md`, `SESSION_HANDOFF.md`, `IMPROVEMENT_LOG.md`); tests to `tests/`; `LICENSE` and the full `README.md` to the repo root.
- Scrapyard flattened to `reference/scrapyard/{rank-s-plucker-xbd, rank-a-video-downloader, rank-b-x-exporter}`; each rank keeps its original `comment and context.txt` and `HOW_TO_INSTALL.txt`; `reference/scrapyard/README.md` documents the reference-only policy and rank table.
- Added `scripts/package-release.sh`: reads the version from `extension/manifest.json` and zips the finished `extension/` folder (manifest at zip root) to `releases/x-media-downloader-v<version>.zip` (optional date tag). Windows/PowerShell fallback documented. `releases/*.zip` is gitignored; `releases/README.md` explains the artifacts.
- `tests/background.test.js` now loads `../extension/background.js`.
- README, WORKLIST (new "P0 — repo layout & release packaging" section), and SESSION_HANDOFF (layout map, branch, commands, priorities) updated to the new paths.

### Unchanged
- Extension code, manifest, and permissions — no product change. Still **no build step**; the release script is distribution packaging only, not a build.

### Validation
- `node --check` on all five extension scripts; all **27** local Node tests pass (`node --test tests/background.test.js`).
- Sample release zip produced and verified with `manifest.json` at the zip root.

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

## 2026-08-25 — Deprecation cleanup after big rewrite

### Removed (no longer fits product)
- Entire ZIP path: `lib/zip-writer.js`, `importScripts` of zip-writer, `zipBuffers`, runtime handlers `downloadZip` and `fetchAsArrayBuffer`.
- Legacy unused runtime handlers: `getVideoUrl`, `downloadVideo` (nothing in-tree called them).
- Dead bulk flags in `content.js`: `useZip`, `bulkId`.
- Accidental single-tweet fallback to `TweetDetail` operation name (incompatible variables/response vs `TweetResultByRestId`).

### Fixed / clarified
- `getTweetMedia` stays on `TweetResultByRestId` only; may still use a **live-captured query id** for that operation.
- Header comment and architecture docs no longer claim ZIP packaging is active.
- Handoff/worklist now include an explicit “code-review checklist” for missing logic and accidental shipment.

### Still intentional (not deleted)
- Popup DOM auto-scroll bulk mode — legacy but still product-supported until a Side Panel migration.
- Public Bearer fallback + bundle scrape — fallbacks when live capture is cold.
- Rank S capture bridge — local reimplementation, not third-party.

### Validation
- Syntax check + full Node test suite after cleanup.

## 2026-08-25 — Side Panel scroll-capture first UX

### Motivation
Live testing showed the remote paste-link profile crawler works but is subpar as the primary UX because background fetching can trigger X rate limits more readily than user-driven scrolling. The popup bulk flow also made scroll capture and the Side Panel queue feel like separate products.

### Changed
- Side Panel now opens to a two-tab layout:
  - **Scroll capture** (default): watches the active X tab while the user scrolls and lists captured media for review/download.
  - **Remote fetch**: keeps the existing paste-link GraphQL discovery as an advanced fallback.
- Added optional Side Panel auto-scroll controls for the default Scroll capture tab while keeping manual scrolling as the main path.
- Added an **× clear target** button to the Remote fetch input.
- Added **Clear history** for the current Side Panel tab instead of only clearing completed/failed items.
- Queue actions now operate against the active tab source, so scroll-captured and remote-fetched items are reviewed separately in the Side Panel.
- MAIN-world network capture now also observes GraphQL responses from X's own page requests and forwards media timeline content to the extension so user scrolling can populate the queue without initiating a separate profile crawl.
- Content script now sends visible DOM photo items to the queue while Scroll capture is watching, covering already-rendered photos in addition to response-captured timeline media.

### Validation
- `node --check extension/background.js extension/content.js extension/popup.js extension/sidepanel.js extension/injected.js`
- `node --test tests/background.test.js` — all 27 tests pass.

### Notes
- Video listing from manual scrolling is strongest when X timeline GraphQL responses are captured; already-rendered photos are additionally detected from the DOM.
- The old popup remains available for now, but the Side Panel is now the primary scroll-capture/review/download surface.
