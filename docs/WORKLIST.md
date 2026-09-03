# Development Worklist

_Last audited: 2026-09-03 (this session = **v3.12 archive-output retirement, source split + test retarget**: the shipped `extension/` and `firefox-extension/` save separate original-resolution files only — per-post ZIP/CBZ/PDF is preserved, NOT shipped, under `source/archive-enabled/`; archive-specific tests were retargeted to that source variant (new `tests/archive-background.test.js` + retargeted archive-lib/pdf-builder/zip-writer suites) and the full offline suite is **168 / 0 fail** — the 8 broken archive tests are runnable again; no `extension/` file changed this pass, manifest stays 3.12.0). Previous audit (2026-09-03): **v3.11 per-user folders + random-naming PENDING REVIEW**: raw downloads default to `Downloads/XMedia/<user>/<post name>/001.jpg` — master folder → one folder **per user** → per-post folder — so a user's media from the home timeline, a profile and its `/media` page all live together, and the folder doubles as visual dedupe on top of v3.10's byte + source-URL verification; `userFolders` toggle (default ON) restores the old `XMedia/<post name>/…` layout; archives (ZIP/CBZ/PDF) cannot create folders, so the username is **forced into the file name** whenever the template would omit it (`{id}` → `nasa - 111.cbz`); legacy queue rows without naming metadata still get their user folder from `item.author`. **The garbled-random-name problem is on this work list as PENDING REVIEW — NOT fixed until the user tests and confirms; root cause still unconfirmed.** Manifest 3.10.0 → 3.11.0, **167 offline tests** (+3), `firefox-extension/` re-synced, no release zip cut yet (pending user review). Previous-but-one audit (2026-09-03): **v3.10 byte-identical + source-URL duplicate verification**: new `lib/dedupe.js` (streaming SHA-256 + canonical source URL); `downloadedMediaRecordsV1` record store (`{id, mediaKey, url, urlKey, hash, size, filename, at}`); `downloadFile` checks URL first (no network), then hashes the bytes and skips same-URL / byte-identical media — the row shows `completed · duplicate` instead of saving a `(1)` copy; completion writes hash + URL + real filename (queue rows via `onChanged`/restart reconcile, direct saves via a pending-record map); canonical URL joins `id`/`mediaKey` as a third queue identity + "Skip already downloaded" record check; archive pass skips already-verified groups and records per-entry + archive digests; `verifyDuplicates` toggle added to Output settings (default ON, best-effort); legacy flat-path sanitizers strip bidi controls so names cannot garble. Manifest 3.9.0 → 3.10.0, 164 offline tests (+14), Firefox port re-synced, release zip re-cut. Prev = **v3.9 virtualization-proof capture**: X removes articles that scroll off-screen and capture was scan-only, so posts inserted and removed between two scans were never listed at all — measured **81 of 207 photos and 39 of 103 posts** on a fast scroll. `harvestMutationArticles()` now reads the observer's `addedNodes` **and** `removedNodes`, lifting that to 204/101 (fast) and 207/103 (normal) with **0 duplicates**; videos went **1 → 17** because a harvested video post is now queued for its per-post resolve instead of vanishing. Dedupe itself was already airtight and is now test-pinned. Prev = **v3.8 Rescan restores deleted rows**: `Rescan tab` and `Fetch media` now forget the tab's "already listed" memory and re-list the posts on screen, so rows the user deleted come back; new **Remove selected** button; `skippedDownloaded` reporting so "nothing came back" always names a reason. Prev = **v3.7 Fetch button**: shallow auto-fetch on tab open/route change, in-page Fetch dock, hybrid deep fetch (scroll → silent GraphQL fill), Side Panel Fetch/Rescan/Reload-tab controls, plus an 8-item missing-logic audit — see the newest IMPROVEMENT_LOG entry. Prev = Firefox port: separate firefox-extension/ folder MV2 sidebar_action + compat shims, README, manifest variant. Prev = v3.6.3 naming-degarble + perf queue:
`sanitizeArtifactFilename` strips invisible bidi/format controls, the
`buildFallbackFilenames` last resort is no longer random
`media_<timestamp>` text, `queueChanged` broadcasts are throttled, one
`resolveTweetMedia` media resolver for both extractors, and the `injected.js`
replay buffer is bounded + marker-walked. Earlier v3.6.2 naming +
archive-warning pass: `makePostBaseName`
collapses separators after sanitizing so a stripped token no longer leaves a
double empty " - " gap in the post folder, and `buildRunNotices` counts
"mixed media" only among kinds actually packed into the archive. Previous v3.6.1
review pass: shared `lib/archive.js` engine replaces duplicated worker/offscreen
archive code, Stop scan cancels the 429/503 countdown, storage save chains
survive a failed write, queueStart gives failed items a fresh attempt budget,
dead state removed, CI YAML cleaned in both copies. **Same-day CI follow-up:**
`actions/checkout` / `actions/setup-node` bumped `@v4`→`@v5` in both copies
(clears the node20 deprecation warning), `scripts/package-release.sh` no longer
exits 141 on a SIGPIPE, CI's packaging assertion made glob-safe, and the v3.6.1
release zip offline-verified (browser load-unpacked click still pending).
Previous audit 2026-09-01: v3.6 media-kind upgrade; v3.5 master folder +
per-post archives + naming; 2026-08-26 round-3 live pass + v3.4 quoted-post
capture.)_

## Product target

**Fetch/rescan audit (2026-09-03):** dedupe remains covered at tab level (id/media key), worker level (id/media key/canonical URL), and saved-download level (URL/hash). Fixed status accounting so an absent worker response is not counted as an accepted queue row.

Signed-in Chrome user opens the Side Panel, uses **Scroll capture** as the default workflow while manually scrolling X, reviews listed media, selects items, and downloads with **1–2** active Chrome downloads. The secondary **Remote fetch** tab can still discover a pasted X profile / `@username` up to a local cap (default **99,999**), but it is treated as an advanced fallback because live testing showed extension-initiated profile crawling can hit rate limits sooner than normal user scrolling. Cap is an upper bound only.

No manual API key / password / cookie paste. Self-hosted against the signed-in X session only — **no** third-party account, subscription, or paid/free tier.

## Implementation audit

| Area | Status | Notes |
|---|---|---|
| Manifest V3 / no build | Done | Plain JS under this folder. |
| Side Panel two-tab queue | Reworked after live testing | Capture is **always on** in every X tab — no watch command. One download action (`Select all` + `Download selected`); `Download all in tab` removed as redundant. Per-row remove, post deep-link, live active-tab status pill. v3.7 Scroll card: `Fetch media` / `Stop` / `Auto-scroll only` / `Rescan tab`, the **Then fetch the rest silently** + **Show the Fetch button on X pages** switches, and a `Reload tab` button in the status pill for tabs that predate the extension. |
| Persistent queue + restart reconcile | Done | `batchDownloadQueueV1`; starting/downloading recovery via `chrome.downloads.search`. |
| Profile discovery | Implemented, needs live-X | Capture-first op IDs + bundle scrape fallback; timeline_v2/legacy; empty-page stop. |
| Live GraphQL/header/response capture | Reworked after live testing | **No operation allowlist for responses** (that is what broke homepage capture). Allowlist retained only for Remote-fetch request metadata. Adds a 40-entry replay buffer and an SPA `pushState`/`popstate` route watcher. No cookie values in bag. |
| Discovery error codes + RL countdown | Implemented, needs live-X | Side Panel countdown via `retryUntil`. |
| Direct filenames + invalid-name ladder | Done | Whole-batch ZIP intentionally removed; v3.5 adds template-driven paths at download time. |
| Master folder for raw downloads | **Done (v3.5), extended (v3.11), needs live spot-check** | `rawMasterFolder` (sync, default `XMedia`): `Downloads/XMedia/<post name>/001.jpg…`. Empty string = off → legacy flat `x-media/` names byte-for-byte. Per-segment sanitizing via `sanitizeArtifactFilename` (nh-dw port). |
| Per-user folders in the master folder | **New (v3.11), needs live spot-check** |
<!-- Post-v3.11 review: missing authors now omit the user segment; no `unknown` folder is created. --> Default ON: `XMedia/<user>/<post name>/001.jpg` — the user segment is the owning post's author (repost/quote attribution is already resolved upstream), so media from the home timeline, a profile and its `/media` page of one user land in the SAME folder (visual dedupe) on top of byte + source-URL verification. `userFolders` toggle (default ON) restores the old layout. Unknown author → no user segment (never an "unknown" bucket). Single sanitized segment — an odd handle can never create nested folders. Legacy rows without naming metadata still get their user folder from `item.author`. Archives cannot create folders (anchor/blob downloads), so `buildArchiveFilename` forces `nasa - …` into the name when the template omits `{user}`. |
| Per-post ZIP/CBZ/PDF output | **Retired (v3.12) — tests pinned** | Queue output is separate original-resolution files only; archive code is no longer loaded or reachable from the shipped UI. The pre-v3.12 implementation is preserved under `source/archive-enabled/` and its historical suites stay runnable (retargeted to that source variant: `tests/archive-background.test.js` + archive-lib/pdf-builder/zip-writer). | One archive per post (≤4 items), assembled in the offscreen document, saved via `<a download>` anchor (blob-filename quirk); worker data-URL fallback. v3.6: PDF is photos-only (GIF/video posts degrade PDF→ZIP); GIFs archive by default, videos opt-in; warnings at queueStart. NOT the removed whole-batch ZIP. |
| GIF → real .gif + quality guarantees | **Done (v3.6), needs live spot-check** | `normalizePhotoUrl` forces `name=orig` on every source; videos keep highest-bitrate MP4; GIFs convert MP4→GIF89a in the offscreen document (`lib/gifEncoder.js`, bounded 30 s/360 frames/720 px) with MP4 fallback on any failure; `gifOutput` toggle. |
| Naming-scheme checkboxes | **Done (v3.5), hardening (v3.6.2)** | `nameTemplate` (sync, default `{user} - {text} - {id}`), checkbox UI + live preview + manual input for custom templates; id fallback, reserved-name prefix. v3.6.2: `makePostBaseName` collapses separators after sanitizing so a token whose content is stripped (e.g. text "???") can't leave `nasa -  - 111`. |
| Offline CI | **Done (v3.5), hardened (v3.6.1), actions bumped (2026-09-02 follow-up)** | `.github/workflows/extension-tests.yml` + byte-identical `docs/ci/extension-tests.yml` (see `docs/ci/README.md`): read-only permissions, concurrency cancel, timeout, glob safe syntax check, packaging artifact assertion; syntax + `node --test` (150 as of v3.9 = the v3.6.3 queue's 6 + 10 Fetch-button/audit + 5 rescan/restore + 7 virtualization-harvest + 3 dedupe/queue regressions) + packaging smoke. Actions on `@v5` — v4 declared the `node20` runtime that runner images now force onto node24 with a warning; v5+ declare `node24` (upstream is at v7, see IMPROVEMENT_LOG). Both the packaging script and its CI assertion were made exit-code-honest this pass (see next row). No real-browser CI — GitHub runners cannot drive MV3 (verified in nh-dw-2.0). |
| Virtualization-proof capture | **New (v3.9), needs live-X** | `harvestMutationArticles(mutations)` runs inside the MutationObserver callback *before* the coalesced scan and reads articles from `addedNodes` (earlier than any scan; `img.src` is already the CDN URL before decode) **and** `removedNodes` (the guaranteed last chance — X can insert and trim in the same task, so the node is never in the document when a scan runs; a detached subtree stays fully queryable). Containers walked, non-element nodes skipped. Shares `submitDomItems()` with the scan so counting/status/dock cannot drift. Cannot duplicate: `makeDomQueueItems` marks `listedMediaIds`/`listedMediaKeys` as it builds. Measured: photos 81 → 204 (fast) / 207 (normal), posts 39 → 101 / 103, **videos 1 → 17**, duplicate ids **0** in every configuration. |
| Dedupe (all layers) | **Verified (v3.9), extended (v3.10) — download-time byte + URL verification** | content.js `listedMediaIds`/`listedMediaKeys` (tab memory) + per-article `seenUrls`; `mediaEntryToItem`'s dedupe context; background `mergeQueueItems` on `knownIds` **and** `knownKeys` across the whole live queue — which collapses the same photo arriving from the DOM and from GraphQL under different id shapes, and (since v3.7) from the scroll list and the remote fill. Identity is the CDN leaf, so `name=small`/`900x900`/`orig` are one row. **v3.10 adds the two verifications at save time:** (1) canonical source URL (`lib/dedupe.js canonicalSourceUrl`, scheme+host+path) against `downloadedMediaRecordsV1`, then (2) streamed SHA-256 of the actual bytes — same-URL or byte-identical media is skipped (`duplicate_url`/`duplicate_bytes`, row shows `completed · duplicate`) instead of re-saved under a `(1)` name; canonical URL is also a third queue identity. |
| Rescan / restore deleted rows | **New (v3.8), needs live-X** | `forgetListedMedia()` clears `listedMediaIds`/`listedMediaKeys`/video-resolve state **and** `lastReplaySeq`, so an explicit rescan (or the start of a deep fetch) re-lists rows the user deleted — including posts X virtualized out of the DOM, which survive only in the MAIN-world replay buffer. Automatic load/route passes stay incremental (rule: *automatic = incremental, explicit click = clean slate*). `Rescan tab` answers immediately with `rescanning: true` and the panel's status poll reports the outcome; **Remove selected** (`queueRemove` with an `ids` array — the worker already accepted it) completes the pick-and-delete loop. |
| Fetch button / deep fetch | **New (v3.7), needs live-X** | In-page `.xdl-fetch-dock` (Fetch media / Stop / ×) + Side Panel `Fetch media`. Shallow pass (replay + DOM rescan + video resolve, no page movement) runs automatically on tab open and every route change; deep fetch = shallow → existing auto-scroll engine → optional silent `discoveryStart` fill of the same profile (rows land in the Remote fetch list; profiles only, never a single post). Run tokens make Stop authoritative; `scrollStop` stops both engines. |
| Capture robustness audit (v3.7) | **Done, regression-tested** | Fixed: `safeSend` hung awaiting callers on a dead context (wedged the video resolver until a page reload), a route change dropped its 1800 ms staged scan, one failed video resolve blacklisted that post for the tab's life (now a 2-attempt budget), Stop + restart could leave two scroll loops, every replay re-cloned the whole MAIN-world buffer (now `seq`/`since` incremental), `scrollRescan` had no sender, `window.__xdl_active` dead state, `profileHandleFromUrl` threw on a non-http origin. |
| Per-tweet action bar | Expanded (Rank A) | `Download` **and** `Add to queue` on every media post, plus toasts. Reimplemented locally, not copied. |
| Popup DOM auto-scroll bulk | **Removed** | The popup's competing scroll+download loop is deleted; the popup is now an Open-Side-Panel launcher with a live capture status line. |
| ZIP export (whole-batch) | **Removed — stays removed** | The multi-GB whole-batch archive path stays deleted. v3.5's per-post archive (≤4 images, offscreen-assembled) is a different, explicitly requested feature and must not grow into batch archiving. |
| Third-party tier/license | Absent | Do not add. |
| Skip already-downloaded (Rank S "Ignore saved") | Done, extended (v3.10) | `downloadedMediaIdsV1` (legacy ids) is kept in sync with `downloadedMediaRecordsV1` (`{id, mediaKey, url, urlKey, hash, size, filename, at}`), so a re-listed item is held back by id, mediaKey, canonical source URL **or** byte hash. Toggle in the toolbar; resettable — Reset clears both stores. |
| Cross-source dedupe | Done, extended (v3.10) | Every item carries a CDN-derived `mediaKey`, so DOM-found and GraphQL-found copies of one photo collapse into a single row; the canonical source URL is now a second key (`mergeQueueItems` `knownUrls`), and the saved-byte SHA-256 catches content that arrives under different URLs entirely. |
| Bookmarks / likes full scan | Not implemented | |
| Include replies / quoted | **Quoted done (v3.4); replies not implemented** | Quote-card ("mentioned post") media now lists by default in both tabs with an **Include quoted** switch, correct quoted-post attribution, and a `quote` badge. Replies still need their own explicit switch. |
| Live signed-in verification | **Round 3 mostly passed; one gap fixed, needs spot-check** | Round 3 (v3.3): all functions work, no double entries, UI/UX decent for deployment — except quote-card media never listed (now fixed in v3.4 with quoted-post parsing + Include quoted switches). Re-verify the quote case plus the v3.3 items below. |
| `document_start` null-root crash | **Fixed + regression-tested** | Reported `Cannot read properties of null (reading 'appendChild')` at `content.js:105`. That file is a pre-v3.2 build (still has `localCapture*` + the popup bulk loop). The null-`<head>` case was already covered by a `documentElement` fallback; the null-`<head>`-and-null-`<html>` case still threw and killed capture. Now deferred-and-retried, never throws. 3 regression tests. |
| Code-review checklist (fit + missing logic + dead code) | **Run in full (v3.6.1)** | v3.6.1 pass found/fixed: duplicated worker↔offscreen archive plumbing (→ shared `lib/archive.js`), Stop scan not cancelling the rate-limit countdown, poisonable storage save chains, failed items re-queued without a fresh attempt budget, dead `replayedKeys`/`scanStats.photos|videos`/unused `collectTweetMedia` fields. Previous pass: two contract commands handled with no UI sender (`queueClearFinished`, `queueClearDownloadedHistory`) — now wired, guard test keeps them reachable; `scrollRescan` stays a documented hook with no button (read-only, allowlisted). **Same-day follow-up:** the CI/packaging path was re-read too and two exit-code bugs surfaced there — `scripts/package-release.sh` returning **141** (its `unzip -l \| head -n 15` SIGPIPEs `unzip`, which `set -o pipefail` turns into a failure for a script that succeeded) and CI's `test -f releases/*.zip` failing with `binary operator expected` whenever a second zip exists. Both fixed; the packaging step was re-run verbatim with two zips present (exit 0). |


## Current product opinion / direction

- Keep **Scroll capture** as the default Side Panel tab. It should feel like the Rank S sidebar pattern: user scrolls X normally, media appears in the side list, user reviews/selects/downloads.
- Keep **Remote fetch** as a secondary/advanced tab. It is useful, but should not be the first impression because background crawling can trip X rate limits more easily than human scrolling.
- The popup is no longer the ideal primary UX. Keep it as a fallback until Side Panel scroll capture proves stable, then simplify it to mostly “Open Side Panel.”
- Do not unify the two tab histories yet. The user explicitly preferred separate scroll-captured and remote-fetched lists/queues.
- Highest-value next improvements are live-test diagnostics, clearer active-tab status, and more robust capture/listing from real X timeline responses.

## Session workflow (how these docs are maintained)

The three docs in `docs/` are a maintained set. Each session:

1. Read `IMPROVEMENT_LOG.md` (newest entries) → why the code looks the way it does.
2. Read this worklist (audit table + current P0) → what to do next.
3. Read `SESSION_HANDOFF.md` (architecture + guardrails) → what not to re-break.
4. Apply the user's input for the session; it **overrides** the written plan on conflict.
5. Do the work; run `node --test tests/*.test.js`.
6. Write back to all three: new log entry, updated audit statuses here, and any
   architecture/message-contract changes in the handoff.

`SESSION_HANDOFF.md` §4 lists **design decisions that must not be simplified
away** — each fixes a reproduced live failure. Check it before refactoring
capture, routing, or the download actions.

## Code-review checklist (next agent / human)

Use this before claiming “ready” or merging large changes:

### Before trusting a live bug report

- [ ] Match the reported file and line against the current tree first. A trace
      from a stale unpacked folder is not a bug in this repo — check the line
      number, the total line count, and whether the surrounding symbols still
      exist (`grep -n`). v3.2 deleted whole command families, so pre-v3.2 traces
      point at code that is no longer here.
- [ ] Reproduce against the real script before fixing. Load
      `extension/content.js` through `tests/content.test.js`'s `loadContentScript()`
      rather than reasoning about it — the DOM shim's defaults can hide a branch.
- [ ] If the DOM shim supplies a node the live page may not have at
      `document_start` (`head`, `documentElement`, `body`), pass an override so
      the null path is actually executed.

### Fit / accidental shipment

- [x] No third-party hosts, ExtPay, plucker/apixbd, license, or tier gates.
- [x] No whole-batch ZIP reintroduction. (v3.5's per-post ZIP/CBZ/PDF — ≤4 images, one post — was an explicit product decision this session and is the allowed exception.)
- [x] No manual token/password fields.
- [x] No `<all_urls>` or non-X permissions.
- [x] No npm/TS/build step.
- [x] Scrapyard code is reimplemented, not copied as a black-box dependency.

### Missing logic / regressions

- [x] Discovery: stop on cap, no cursor, repeated cursor, empty pages, user stop, run-id staleness.
- [x] Queue: only 1–2 concurrent; `starting` holds a slot; terminal event before next start.
- [x] Queue: user-triggered `queueStart` resets the attempt budget for re-queued failed items (v3.6.1); save chains survive a rejected `storage.local.set`.
- [x] Discovery: Stop scan cancels a pending rate-limit countdown/backoff (v3.6.1 `shouldAbort`), reports a clean stop, never a fake error.
- [x] Restart: in_progress kept; complete/interrupted/missing reconciled; no duplicate downloads.
- [x] Capture bag: cookies never stored; CSRF from cookies preferred over stale capture when refreshing.
- [x] Single-tweet path uses `TweetResultByRestId` shape only (not TweetDetail variables).
- [x] Quotes are an explicit switch (**Include quoted**, default on, both tabs)
      and quote rows carry `isQuote` + quoted-post attribution; reposts honor
      Include reposts. Replies remain excluded.
- [x] Filename sanitization + invalid-filename fallback ladder still works.
- [x] v3.7: every `chrome.runtime.sendMessage` caller is released even when the
      extension context is invalidated (`safeSend` always calls back;
      `withTimeout` bounds the round trip) — no awaiting path can wedge.
- [x] v3.7: long-running loops (auto-scroll, deep fetch, silent fill) are
      run-token guarded, so Stop + immediate restart cannot double-run and a
      superseded run never writes shared state.
- [x] v3.7: the deep fetch's silent fill is cancelled by Stop (`discoveryStop`
      sent from `stopCapture`, not only from the abandoned poll loop).
- [x] v3.7: staged scan passes are uncoalesced (`scheduleScanAt`) — the
      coalescing `scheduleScan` stays for the MutationObserver only.
- [x] v3.7: MAIN→isolated replay is incremental (`seq` / `since`) and stays
      backwards compatible with a caller that sends no cursor.
- [x] v3.8: per-pass counters are **cumulative with start/end deltas**, never a
      shared object a pass zeroes — overlapping passes are normal (an
      `armLoadFetch` timer can land inside a rescan's `await`) and zeroing made
      a successful rescan report "nothing new".
- [x] v3.8: an explicit action that finds nothing still reports a reason
      (`skippedDownloaded` distinguishes "already in your list" from "held back
      by a setting"). No silent no-ops.
- [x] v3.9: capture does not depend on a node still being in the document when a
      scan runs — mutation records (`addedNodes` + `removedNodes`) are harvested
      synchronously in the observer callback.
- [x] v3.9: the harvest and the scan share one submission path
      (`submitDomItems`), so counters, status text and dock refresh cannot drift.
- [x] v3.9: harvesting cannot duplicate — `makeDomQueueItems` marks the tab's
      dedupe sets as it builds each item, and the worker dedupes on id + media key
      as a second layer.
- [x] v3.9: a harvested *video* post is queued for the bounded per-post resolve
      (`pendingVideoTweets`) — that is what took videos from 1 to 17.
- [x] v3.8: `forgetListedMedia()` is reachable ONLY from explicit user actions.
      Calling it from a load/route pass would re-clone the whole replay buffer
      on every mutation tick.

### Deprecated / dead code to keep out

- Legacy runtime commands and batch-ZIP session state: `downloadZip`, `fetchAsArrayBuffer`, `getVideoUrl`, `downloadVideo`, `zipBuffers`, `useZip`, `bulkId`, and the old `lib/zip-writer.js` batch archiver. (The v3.5 `lib/zipWriter.js`/`XDLZip` STORE writer is per-post only and is NOT this.)
- `webRequest` permission without a real listener.
- The auto-scroll-only in-page badge (`.xdl-autoscroll-badge`,
  `showAutoScrollBadge`/`updateAutoScrollBadge`/`hideAutoScrollBadge`) — v3.7
  folded it into the single `.xdl-fetch-dock` widget. Do not re-add a second
  floating badge; two widgets fighting over the same corner is why it merged.
- A separate `scrollFetchStop` command — `scrollStop` stops both engines, and an
  extra handler with no sender now fails the contract test.
- A shared per-pass tally object that each pass resets at its start (v3.8): use
  the cumulative `passCounters` + per-pass delta, and give an explicit rescan its
  own `lastRescan` record instead of reading `lastPass` (which means "whatever
  pass ran most recently", usually an automatic one).
- Scan-only capture (pre-v3.9): reading `article[data-testid="tweet"]` from the
  live DOM assumes a post stays rendered long enough to be seen. X virtualizes, so
  it does not — the scan alone loses ~60% of media on a fast scroll (measured).
  Keep the mutation harvest in front of it.
- Weakening video dedupe by dropping the media key (considered and rejected in
  v3.9). Two harness artifacts — a tweet id past `Number.MAX_SAFE_INTEGER`, and a
  fake video URL whose leaf was identical for every post — made it look like
  videos were being lost to dedupe. They were not: real X leaves are unique per
  video, and dropping the key would have listed every reposted/quoted video
  twice. **Fix the fixture, not the dedupe.**
- Hardcoded third-party query IDs as the only discovery path (capture + scrape is OK; single stale ID as sole source is not).

## P0 — repo layout & release packaging (try-it-out path)

New this session (2026-08-25): restructure so the extension can be **Load unpacked** directly, with source and releases separated.

- [x] Renamed project folder to `extension/` — the single **Load unpacked** target (manifest.json at its root).
- [x] Moved docs to `docs/`, tests to `tests/`, LICENSE + README to repo root; `extension/` now contains only browser-loaded files + icons.
- [x] Flattened scrapyard to `reference/scrapyard/{rank-s-plucker-xbd, rank-a-video-downloader, rank-b-x-exporter}` (rank A/B were nested inside rank S; rank A extension was double-nested). Context notes + install instructions preserved per rank.
- [x] Added `scripts/package-release.sh` → `releases/x-media-downloader-v<version>.zip` (manifest at zip root, optional date tag, Windows fallback documented); `releases/*.zip` gitignored.
- [x] **Try it out:** loaded unpacked and live-tested across rounds 1–3. Round 3 (2026-08-26, v3.3) passed the core checklist — user report: all functions work, no double entries, UI/UX already decent for deployment. Only the v3.4 quote-case spot-check (item 12 below) remains.
- [~] Cut the first release zip (`scripts/package-release.sh`) and confirm it loads from the unzipped folder — **half done 2026-09-02**: `releases/x-media-downloader-v3.6.2.zip` is cut and offline-verified — `manifest.json` at the zip root (no wrapper folder), `diff -r` byte-identical to `extension/`, and all manifest-declared *and* runtime-resolved resources present (`lib/*`, `offscreen.*`, every `importScripts`/`<script src>` target). **Remaining:** the one click only a browser can make — Load unpacked on the unzipped folder — plus (optionally) starting `CHANGELOG.md`.
- [x] Bump `extension/manifest.json` version when shipping the next user-visible change — now at **3.6.3** (v3.4 quoted-media capture, v3.5 output upgrade, v3.6 media kinds, v3.6.1 Stop/retry fixes, v3.6.2 naming/`{name}`/archive-warning fixes, and v3.6.3 bidi-strip + deterministic-fallback + `queueChanged` throttle + one media resolver + replay bound are all user-visible; the 2026-09-02 CI pass changed no `extension/` file, so it did not bump the version). Still open: starting a `CHANGELOG.md` per release.

## P0 — remaining (live-X, round 3)

Re-test **v3.3** against the exact v3.1 failures:

**Status (2026-08-26): items 1–11 PASSED** — user round-3 report: "all
function work no double entry and the ui ux already decent for deployment."
Still open: **item 12** (the v3.4 quote case, shipped after that test ran, so
never executed in a browser) and **item 13** (live fixtures).

1. ✅ **Homepage capture:** open `x.com/home`, scroll, confirm media lists without any reload.
2. ✅ **In-tab route change:** from home click into a post, then to a profile, then to `/media`, all without reloading. Media must list on every view within a couple of seconds.
3. ✅ **Profile posts vs /media:** on `https://x.com/real_loonarae` (the reported case) confirm the *posts* tab lists media, not only `/media`.
4. ✅ **Video posts:** confirm videos appear (per-post resolve is rate-bounded to ~1/700ms, so a video-heavy view fills in progressively).
5. ✅ **Auto-scroll:** start from the panel, confirm the in-page badge appears, that it scrolls continuously without waiting on downloads, and that Stop works from both the badge and the panel.
6. ✅ **Speed:** compare Fast vs Medium; Fast should advance as soon as X renders the next batch.
7. ✅ **One download action:** confirm `Select all` + `Download selected` is sufficient and nothing references a removed `Download all in tab`.
8. ✅ **Skip already downloaded:** download a few items, clear the list, re-scroll the same view, and confirm they do not come back. Then untick the toggle and confirm they do.
   - **v3.3 toolbar buttons** (`Clear finished`, `Reset downloaded history`): shipped in v3.3 and covered by the round-3 "all functions work" pass.
9. ✅ **Action bar:** confirm both `Download` and `Add to queue` appear under media posts and that `Add to queue` lands in the Side Panel list.
10. ✅ **Status pill:** confirm it reflects the current route, posts on screen, and pending video resolves; and that it warns when the tab is not X or needs a refresh.
11. ✅ Remote fetch still works as the secondary path with clear rate-limit messaging.
12. **PENDING — Quoted post card (v3.4):** scroll past a post that is a GIF/video
    reaction to a quoted ("mentioned") post. The card's media must list with
    a violet `quote` badge, attributed to the quoted post's author (not the
    reactor), and download named after the quoted post. Untick **Include
    quoted** in both tabs and confirm card media stops listing (existing rows
    stay). Also confirm the same quoted photo quoted by two different posts
    still produces exactly one row.
13. **Open —** replace synthetic fixtures with sanitized live captures when available.
14. **Open (v3.5–v3.6, never run in a browser)** — media output upgrade spot-check:
    - Master folder ON, fixed download location, no save prompts: one 4-photo
      post → `Downloads/XMedia/<post name>/001…004.jpg`, folders auto-created.
    - Empty the master folder box → old flat `x-media/` layout is back exactly.
    - ZIP and CBZ contain only the original full-size images in post order;
      PDF has every page in order and orientation; all named
      `<post name>.<ext>` (archives land at the Downloads root — anchor
      downloads cannot carry folders).
    - Unchecking `{text}` updates the example preview AND the produced names;
      a post with no usable text falls back to the post id.
    - The dock "Save posts as" picker changes one run without touching
      the stored default; videos (not opted into archives) still save as
      separate MP4s.
    - **v3.6:** a GIF post downloads as a real looping `.gif` inside the
      master folder (and as `.mp4` when "GIF posts save as" is switched);
      a mixed photos+GIF post with PDF selected saves as ZIP with `001.jpg` +
      `002.gif` and the amber warning shows in the dock; ticking "Include
      videos in post archives" + zipping a video post shows the size warning
      and produces `NNN.mp4` entries; a photo already saved at `name=small`
      re-downloads at `orig` resolution.
15. **Open (v3.6.2)** — the display name (`{name}`) token and the naming fixes
    need one signed-in browser pass:
    - Set the name template to `{user} - {name} - {id}`, then on a scroll
      capture (DOM path) list a photo post: the example preview and the
      produced `<post name>` folder must contain the display name, AND it must
      match the name produced for the *same* post discovered through Remote
      fetch (GraphQL path). This is what the v3.6.2 `content.js` fix targets.
    - Confirm `[data-testid="User-Name"]` still holds the display name as
      `span:first-child` / the first non-`@` `<span>` (cross-checked against
      2026 X/DOM scrapers; verify live in the current DOM). If X has changed
      the header, capture the new shape and update `getDisplayName`.
    - Confirm a post with a text that sanitizes to nothing (e.g. `"???"`) now
      names its folder `nasa - <id>` (no `-  -` gap), and that a photo-only
      ZIP run never shows the "mix" warning while a photo+GIF run still does.

16. **Open (v3.7, never run in a browser)** — Fetch button pass on a real
    signed-in profile:
    - Open `https://x.com/<handle>` in a **new tab with the Side Panel closed**:
      the first screenful must list on its own within ~2–4 s (shallow fetch),
      and the floating **Fetch media** dock must sit bottom-right without
      covering X's own nav.
    - Press **Fetch media**: the dock label must walk
      `Reading this view` → `Scrolling the timeline` → `Silently fetching @handle`,
      the button must read **Stop**, and the listed count must climb.
    - **Stop** mid-scroll and again mid-fill: the page must stop moving at once,
      the Remote fetch tab must report a clean stop (no fake error), and a second
      **Fetch media** right after must start exactly one loop.
    - Silent-fill rows must appear in the **Remote fetch** list only (the two
      lists stay separate), deduped against what the scroll already listed.
    - Untick **Then fetch the rest silently** → the fetch ends after the scroll.
      Untick **Show the Fetch button on X pages** → the dock disappears, but a
      *running* fetch must still show its Stop. The dock's **×** hides it for
      that tab and the panel switch brings it back.
    - On a single post (`/handle/status/id`) and on `/home` the fill must skip
      with its note, not error.
    - Reload the extension at `chrome://extensions` with an X tab already open:
      the panel must offer **Reload tab**, and after reloading, video posts must
      resolve again (the old wedge is fixed).

17. **Open (v3.8, never run in a browser)** — Rescan / restore pass on a real
    signed-in profile:
    - List a few posts, delete some rows (per-row **×** or tick + **Remove
      selected**), then press **Rescan tab**: the deleted rows must come back and
      the hint must say how many (`Rescan — N media items re-listed…`).
    - Scroll well past a post so X virtualizes it out of the DOM, delete its row,
      rescan: it should still return **while it is inside the replay buffer**
      (40 entries / ~8 MB). Beyond that it needs **Fetch media** — confirm where
      the boundary actually lands on a real timeline.
    - Rescan with nothing deleted: the hint must say `nothing new … unchanged`,
      and the list must not grow or duplicate.
    - Rescan when every visible post is already downloaded: the hint must name
      **Skip already downloaded**; unticking it (or **Reset downloaded history**)
      must let them list.
    - Press **Rescan tab** while a fetch is running: it must be refused/disabled,
      not race the scroll loop.
    - **Remove selected** on a multi-selection removes exactly the ticked rows in
      the active tab's list only (Scroll capture vs Remote fetch), leaves files on
      disk alone, and disables itself again afterwards.

18. **Open (v3.9, never run in a browser)** — capture completeness on a real
    signed-in profile. Biggest measured effect of any item here, so it is the one
    most worth two minutes:
    - Run a **fast** auto-scroll (or **Fetch media**) on a long profile and
      compare the panel's row count with the post count X shows on that profile's
      `/media` tab. Before v3.9 a fast pass silently dropped ~60% of the media;
      the counts should now be close, with any difference explained by reposts,
      the media filter, and **Skip already downloaded**.
    - Scroll a few screens manually and confirm posts you scrolled *past* quickly
      are in the list, not only the ones you lingered on.
    - Confirm **video** posts from fast-scrolled-past sections resolve (the panel
      shows `resolving N video posts`) and that none are listed twice.
    - Watch for **skeleton/placeholder** articles being listed as media on a real
      timeline (they yield nothing in the harness; real X skeletons deserve one
      look).
    - Watch CPU on a very long scroll: the harvest runs per mutation batch and has
      never been profiled against a real 1000-post timeline. It is bounded by the
      dedupe sets, but "bounded" is not the same as "measured".
    - Confirm no duplicates when the same post arrives from the DOM *and* a
      GraphQL capture, and that a deep fetch's silent fill does not duplicate what
      the scroll already listed (two lists, one row).

**Live GraphQL reference needed for item 15 / 14 (a sanitized capture, no
credentials):** the display-name field on the GraphQL path is
`core.user_results.result.legacy.name` (already used by `background.js` for
`displayName`). A DOM snapshot of one `article[data-testid="tweet"]` from the
same post is what confirms the `[data-testid="User-Name"]` `span` maps to the
same value — item 15 needs both a real DOM capture and the matching
`UserMedia` / `TweetResultByRestId` response for a handle like `@nasa`.

## Active task queue (v3.6.3 — naming degarble + perf; worked one by one)

Session input (2026-09-02): the pipeline was already live-tested OK before the
naming feature; the naming feature itself is what produced **"garbled random
text"** in saved names. Work the tasks below one at a time, then update this
list (tick `[x]`) AND the three docs before ending the session so the next one
picks up here.

1. [x] **Naming: strip invisible bidi/format control characters.** `???`
      `sanitizeArtifactFilename` now removes invisible bidi/format controls
      (`\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff`) so mixed-script /
      RTL post text no longer scrambles folder names. Keeps visible non-ASCII
      (CJK, emoji, Arabic) so legitimate scripts are preserved.
2. [x] **Naming: kill the random-text fallback.** `buildFallbackFilenames`
      no longer ends in `x-media/media_<random base36>.<ext>`. The last rung is
      now deterministic `x-media/download_<stem>.<ext>`; uniqueness comes from
      `conflictAction: uniquify` (unchanged) rather than a timestamp. The ladder
      is run-to-run deterministic and can never produce "garbled random text".
      Regression assertion added (no `media_[a-z0-9]{5,}` stem + determinism).
3. [x] **Perf: throttle `queueChanged` broadcasts.** Added `broadcastQueueChanged()`
      (leading-edge emit + one trailing emit per 250 ms) and routed both
      `saveQueueState()` and `saveDiscoveryState()` through it, so a download's
      `chrome.downloads.onChanged` byte-delta ticks no longer flood
      `sidepanel.refresh()` with a `queueChanged` message per tick. Regression
      test: a 20-save burst coalesces to ≤4 broadcasts.
4. [x] **Drift risk: consolidate the two media extractors in `background.js`.**
      Added a single `resolveTweetMedia(item)` for URL selection (orig photo,
      highest-bitrate MP4), GIF detection, and target extension; both
      `getTweetMedia`'s `collectTweetMediaEntries` and `mediaItemsFromTweetObject`
      now call it. The two paths can no longer drift on media rules. Regression
      tests pin photo/video/GIF resolution and that both paths agree on the
      same CDN URL.
5. [x] **Perf: bound the `injected.js` replay buffer + cheap media marker.**
      `emitGraphqlResponse` now runs an early-exit `containsMediaMarker` object
      walk BEFORE any `JSON.stringify`, so non-media GraphQL payloads (metrics
      polls, profile metadata) skip serialization entirely. The replay buffer is
      bounded by BOTH count (40) and total serialized bytes (~8 MB) via
      `replayBytes` in `bufferResponse`. New `tests/injected.test.js` pins the
      marker walk and the 40-entry count cap.
6. [ ] **Hold (do not implement yet, decide after live jank):** `content.js`
      re-queries all articles + recomputes `getTweetInfo` every 2.5s on top of
      the MutationObserver. Only tune if a big-queue session shows real jank.
7. [ ] **Hold:** don't split `background.js` (2.3k lines) — MV3 single-worker +
      no-build guardrail makes the split not worth the importScripts/test-loader
      risk.

**Queue status (this session, 2026-09-02):** Tasks **1–5 are DONE** and ticked
above — the "garbled random text" root causes are fixed (invisible bidi/format
control strip in `sanitizeArtifactFilename`, and the deterministic fallback in
`buildFallbackFilenames`) plus three perf/consistency wins (throttled
`queueChanged`, one `resolveTweetMedia` media resolver, bounded `injected.js`
replay + marker walk). Tasks **6–7 stay holds** — do not implement them until a
big-queue session provides live jank evidence, or a decision to split
`background.js` regardless. Full suite: **125** (v3.6.3) → **135** (v3.7) → **140** (v3.8) → **150 pass / 0 fail** (v3.9). Manifest bumped
**3.6.2 → 3.6.3** and `releases/x-media-downloader-v3.6.3.zip` was cut +
offline-verified (manifest at root, byte-identical to `extension/`).

**Diff review pass (added after the 1–5 queue):** re-reviewed the session's
diff for remaining missing logic / misalignment / bugs and fixed one real one —
`resolveTweetMedia`'s photo-extension fallback returned a garbage extension
(`commediaabc`) for a bare CDN URL with no `format` and no file extension,
while the DOM path (`content.js getPhotoExtension`) safely returned `jpg`, so
the two extractors could name the same photo differently. Added
`photoExtensionFromUrl()` mirroring `getPhotoExtension` (format → jpg/png/webp
→ jpg default) and +1 regression. **Note:** this touched `extension/background.js`
after the zip was cut, so re-run `scripts/package-release.sh` before shipping.

**Live data still genuinely useful (not required for the above):** one
signed-in run of the v3.5–v3.6.2 output + naming path (WORKLIST P0 items 12 /
14 / 15), and one sanitized `UserMedia` request+response to lock the
`features`/`fieldToggles`/`variables` and confirm
`core.user_results.result.legacy.name` is the live display-name field.

## P0 — v3.11 per-user folders + random-naming PENDING REVIEW (new, 2026-09-03)

User request (this session, fifth brief): (1) the random/garbled file-name
problem goes on the work list as **pending review** — do NOT claim it fixed
until the user tests the output and confirms; (2) the extension's own master
folder should contain one folder **per user** the media is sourced from —
`XMedia/<user>/<post name>/001.ext` — so all of a user's batch-archived media
lives together; (3) when a folder is impossible (archives), the username must
at least appear in the file name; (4) it doubles as dedupe — different sources
(home timeline, profile, `/media`) of the same user land in the same folder —
on top of the v3.10 byte + URL verification; (5) record all of it here and in
SESSION_HANDOFF / IMPROVEMENT_LOG for the next session to review.

### Random file name / garbled name — ⚠ PENDING REVIEW (do not close until the user confirms)

Status: **UNVERIFIED.** v3.6.3 removed the random `media_<base36>` fallback
(deterministic ladder now) and both sanitizers strip invisible bidi/format
controls; v3.10 prevents re-save duplicates via byte + URL verification. None
of that has ever been observed fixing the original live report — offline tests
cannot reproduce it, so the root cause stays **unconfirmed**.

- [~] Root cause: still unconfirmed. Remaining suspects: Chrome `uniquify`
      `(1)`-suffix behavior, a template/user-typed value, or a live X post
      shape that feeds a weird `text` into `makePostBaseName`.
- [ ] **User test:** download a real batch in Chrome (Load unpacked) and
      confirm file/folder names carry the post text with no garbled random
      word+number text.
- [ ] If it still garbles: capture the queue row + real saved filename, and
      trace `makePostBaseName` → `buildFallbackFilenames` →
      `conflictAction:"uniquify"` (the remaining suspect for the
      "random word and number" symptom).
- [x] Random-name *fallback* gone (v3.6.3) — NOT the same as the user's issue
      being fixed; keep [~]/[ ] above open until the live test confirms.

### Per-user folders (v3.11 — implemented, committed, needs live spot-check)

- [x] Layout: raw downloads default to `XMedia/<user>/<post name>/NNN.ext`
      (master → per-user → per-post). Example: `XMedia/nasa/nasa - Hello world - 111/001.jpg`.
- [x] `userFolders` toggle in Output settings (default ON). OFF restores
      `XMedia/<post name>/NNN.ext`.
- [x] Archive filenames: username forced when the template omits `{user}`
      (`{id}` → `nasa - 111.cbz`); `{user} - …` stays as-is (no double user).
- [x] Cross-source dedupe: home timeline / profile / `/media` media of one
      user share one folder, on top of v3.10 byte+URL verification.
- [x] Legacy queue rows without naming metadata use `item.author` for the
      user folder; no author → no user segment (no "unknown" bucket).
- [ ] Live spot-check (P0 item 12/14 style): same user's media from two pages
      lands in ONE folder; different users get different folders; archive
      names carry the username; toggle OFF gives the old layout.
- [ ] `firefox-extension/` re-synced (naming/background/sidepanel/html) —
      live about:debugging spot-check still pending from the Firefox port task.
- [ ] Release zip: NOT cut yet (v3.10.0 zip is stale). Cut + offline-verify
      after the user confirms the layout — `scripts/package-release.sh`.

## P1 — inclusion and review UX

1. Diagnostics panel: active X tab URL, watching status, last captured operation names, capture warm/cold, queue counts, and sanitized copy-debug-report.
2. Improve manual-scroll media support across more live X response shapes, especially video timeline variants.
3. Clearer badges/counts: scroll vs remote, photo/video/GIF counts (v3.6 added the per-row `gif` badge), repost/original when exposed.
4. Explicit Include replies switch (quoted media shipped in v3.4).
5. ~~Filename templates~~ (shipped v3.5) + ~~video quality preference~~ (v3.6 always takes the highest-bitrate MP4 variant; a lower-quality *preference* is still unbuilt and likely unwanted).
6. ~~Stop scan interrupting the rate-limit countdown~~ — **done (v3.6.1)**: `shouldAbort` is threaded through `fetchWithRetry`/`sleepWithRateLimitCountdown`, so Stop breaks a pending backoff on the next tick and reports a clean stop.

## P2 — other sources

1. Bookmarks / likes pagination.
2. User posts/replies timeline source.
3. Search / date-range.
4. Import currently loaded DOM media into the same queue.

## P0 — Firefox port (new, 2026-09-03, user request)

User request: create separate folder for Firefox extension, port chrome `extension/` into Firefox compatible.

Feasibility check (2026-09-03 analysis):
- Current: Manifest V3, `sidePanel`, `offscreen`, `background.service_worker`, `world: MAIN` content script, `chrome.scripting.executeScript`, `chrome.cookies`, `chrome.downloads`, `chrome.storage.sync`.
- Firefox status: Firefox supports MV3 since 109+, but `sidePanel` is Chrome-only (Firefox has `sidebar_action` legacy), `offscreen` is Chrome-only, `chrome.scripting` with MAIN world limited, `browser.*` namespace preferred, `background.service_worker` → `background.scripts` or event page, `chrome.cookies` needs host permission.

Required adaptations:
1. Separate folder `firefox-extension/` (Load Temporary Add-on target).
2. Manifest: `manifest_version: 2` or 3 with `browser_specific_settings` (gecko id), replace `sidePanel` with `sidebar_action`, replace `offscreen` with background script handling (Firefox background has DOM), replace `service_worker` with `scripts: ["lib/*", "background.js"]`, add `permissions: ["downloads", "storage", "cookies", "tabs", "<all_urls>"? keep X hosts]`.
3. Background: Firefox background is not service worker — persistent. Remove `chrome.offscreen` calls, use direct `lib/archive.js` + `OffscreenCanvas`/`canvas` in background or content. `chrome.downloads.search` callback vs promise dual support already exists.
4. Side Panel → Sidebar: `sidebar_action` default panel = sidepanel.html, messaging same. `chrome.sidePanel.open` not available — replace with `browser.sidebarAction.open()` or instruct user to open sidebar.
5. Content scripts: `world: MAIN` not supported in Firefox MV2; need to inject `injected.js` via `script` tag injection from content.js instead of manifest MAIN world. Already have injection pattern.
6. Cookies: Firefox `cookies` API requires `cookies` permission + host, same.
7. GIF conversion: Firefox background has DOM access, can reuse canvas/video decoding without offscreen doc.
8. Storage: `chrome.storage.sync` limits lower in Firefox — keep `storage.local` for output settings fallback.
9. Packaging: `web-ext` or zip with manifest at root.

Tasks:
- [x] Create `firefox-extension/` folder (copy of `extension/` as baseline) — 2026-09-03, `cp -r extension firefox-extension`, ls shows 10 files + lib/
- [x] Write `manifest.json` Firefox variant (MV2 with `browser_specific_settings` id x-media-downloader@example.com, `sidebar_action` default_path sidepanel.html, background scripts lib/naming,lib/zipWriter,lib/pdfBuilder,lib/gifEncoder,lib/archive,background.js, no `offscreen`/`sidePanel`, permissions includes hosts for MV2, browser_action popup) — validated JSON, manifest_version 2, gecko strict_min_version 109.0
- [x] Adapt `background.js`: offscreen fallback becomes primary — `ensureOffscreenDocument` already returns false when chrome.offscreen undefined, triggers `buildArchiveInWorker` path (lib/archive.js + data: URL). Added compat shim: _extApi=browser||chrome, chrome alias when undefined, importScripts guarded typeof check, _executeScriptCompat wrapper handling scripting vs tabs.executeScript. Replaced 2 executeScript sites with wrapper (refreshAuth + scrapeOperationIdsFromBundles). GIF conversion still degrades to MP4 in Firefox (background canvas decode not yet wired) — documented in README as known limitation.
- [x] Adapt `injected.js` injection: Firefox MAIN world via script tag — content.js Firefox branch injectMainWorldForFirefox() creates <script src=runtime.getURL('injected.js')> with dataset.xdlInjected guard, avoids double injection
- [x] Adapt `sidepanel.js`/`popup.js`: `sidePanel.open` → `sidebarAction.open` with fallback — popup.js _api=browser||chrome, tries api.sidebarAction.open() then api.sidePanel.open({windowId}) then window.close(); refreshStatus still chrome.* but works because chrome alias present
- [ ] Test `chrome.downloads` with master folder subpaths (Firefox supports subfolders) — pending live about:debugging
- [ ] Add `docs/ci` test for Firefox manifest parse — pending
- [x] Document install: `about:debugging` → Load Temporary Add-on → select `firefox-extension/` — done in firefox-extension/README.md with why separate folder table, install steps, known limitations, next steps
- [x] Re-sync v3.11 per-user folders into the Firefox port (`lib/naming.js`, `background.js`, `sidepanel.js`, `sidepanel.html`; manifest → 3.11.0) — `content.js` keeps its intentional MAIN-world injection shim (do not blind-sync it).


## P3 — robustness

1. Download history UI; stronger resume policy.
2. ~~Per-batch subfolders (Rank A-style)~~ — superseded by v3.5's master folder + per-post folders.
3. HLS policy after MP4 verified.
4. Firefox MV3; avatar/banner; content-type extension detection. → **Moved to P0 Firefox port above**

## Bucket list — do not start before P0 live pass

- ~~Retire or simplify popup DOM bulk into an “Open Side Panel” launcher~~ — **done in v3.2**.
- ~~Action-bar “Add to queue”~~ — **done in v3.2**.
- Gallery modes, preview modal, sort choices.
- Concurrency > 2 only after rate-limit testing.
- Skip already-downloaded history export.

## Scrapyard ranking (supporting context only)

| Rank | Source | Use |
|---|---|---|
| **S** | Plucker XBD | Live intercept patterns adopted locally; reject remote license API. |
| **A** | Action-bar video downloader | Filename fallbacks / folder ideas; good later for Add-to-queue. |
| **B** | X Exporter | Weak UX; ExtPay — ignore licensing. |

## Validation before declaring P0 complete

- Public profile under cap ends cleanly.
- Cap stop exact; multi-photo unique; MP4 + orig photos.
- Reposts off/on correct.
- Protected / NSFW / logged-out / rate-limit messages specific.
- Stop discovery; stop downloads; Side Panel reload retains state.
- **168** local Node tests still green after cleanup (`node --test tests/*.test.js`: background + content + naming + zip-writer + pdf-builder + gif-encoder + archive-lib + archive-background + downloader + media-kinds + injected + dedupe + dedupe-pipeline suites; the archive suites pin `source/archive-enabled/chrome-extension/` — see its README).
- Both CI copies parse as YAML and stay byte-identical (`diff .github/workflows/extension-tests.yml docs/ci/extension-tests.yml`); a workflow edit must be re-applied to BOTH.
- `scripts/package-release.sh` exits **0** (was a deterministic 141 SIGPIPE) and the CI packaging step passes verbatim even with more than one zip in `releases/`.
- The release zip unzips to a structurally loadable folder: manifest at root, contents identical to `extension/`, every manifest + runtime reference resolvable.
