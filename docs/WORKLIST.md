# Development Worklist

_Last audited: 2026-08-25 (post live-testing fix pass: always-on capture, SPA route handling, single download action)_

## Product target

Signed-in Chrome user opens the Side Panel, uses **Scroll capture** as the default workflow while manually scrolling X, reviews listed media, selects items, and downloads with **1–2** active Chrome downloads. The secondary **Remote fetch** tab can still discover a pasted X profile / `@username` up to a local cap (default **99,999**), but it is treated as an advanced fallback because live testing showed extension-initiated profile crawling can hit rate limits sooner than normal user scrolling. Cap is an upper bound only.

No manual API key / password / cookie paste. Self-hosted against the signed-in X session only — **no** third-party account, subscription, or paid/free tier.

## Implementation audit

| Area | Status | Notes |
|---|---|---|
| Manifest V3 / no build | Done | Plain JS under this folder. |
| Side Panel two-tab queue | Reworked after live testing | Capture is **always on** in every X tab — no watch command. One download action (`Select all` + `Download selected`); `Download all in tab` removed as redundant. Per-row remove, post deep-link, live active-tab status pill. |
| Persistent queue + restart reconcile | Done | `batchDownloadQueueV1`; starting/downloading recovery via `chrome.downloads.search`. |
| Profile discovery | Implemented, needs live-X | Capture-first op IDs + bundle scrape fallback; timeline_v2/legacy; empty-page stop. |
| Live GraphQL/header/response capture | Reworked after live testing | **No operation allowlist for responses** (that is what broke homepage capture). Allowlist retained only for Remote-fetch request metadata. Adds a 40-entry replay buffer and an SPA `pushState`/`popstate` route watcher. No cookie values in bag. |
| Discovery error codes + RL countdown | Implemented, needs live-X | Side Panel countdown via `retryUntil`. |
| Direct filenames + invalid-name ladder | Done | ZIP intentionally removed. |
| Per-tweet action bar | Expanded (Rank A) | `Download` **and** `Add to queue` on every media post, plus toasts. Reimplemented locally, not copied. |
| Popup DOM auto-scroll bulk | **Removed** | The popup's competing scroll+download loop is deleted; the popup is now an Open-Side-Panel launcher with a live capture status line. |
| ZIP export | **Removed** | Deprecated path deleted (`lib/zip-writer.js`, handlers). Do not ship multi-GB archives. |
| Third-party tier/license | Absent | Do not add. |
| Skip already-downloaded (Rank S "Ignore saved") | Done | `downloadedMediaIdsV1` stores completed item ids only. Toggle in the toolbar; resettable. |
| Cross-source dedupe | Done | Every item carries a CDN-derived `mediaKey`, so DOM-found and GraphQL-found copies of one photo collapse into a single row. |
| Bookmarks / likes full scan | Not implemented | |
| Include replies / quoted | Not implemented | Must be explicit switches when added. |
| Live signed-in verification | **Round 2 feedback applied; needs round 3** | v3.1 live test found: homepage never captured, capture only woke after reload/new tab, auto-scroll broken, redundant download buttons, dead `Watch current tab`. All addressed in v3.2 — re-test needed. |


## Current product opinion / direction

- Keep **Scroll capture** as the default Side Panel tab. It should feel like the Rank S sidebar pattern: user scrolls X normally, media appears in the side list, user reviews/selects/downloads.
- Keep **Remote fetch** as a secondary/advanced tab. It is useful, but should not be the first impression because background crawling can trip X rate limits more easily than human scrolling.
- The popup is no longer the ideal primary UX. Keep it as a fallback until Side Panel scroll capture proves stable, then simplify it to mostly “Open Side Panel.”
- Do not unify the two tab histories yet. The user explicitly preferred separate scroll-captured and remote-fetched lists/queues.
- Highest-value next improvements are live-test diagnostics, clearer active-tab status, and more robust capture/listing from real X timeline responses.

## Code-review checklist (next agent / human)

Use this before claiming “ready” or merging large changes:

### Fit / accidental shipment

- [ ] No third-party hosts, ExtPay, plucker/apixbd, license, or tier gates.
- [ ] No ZIP reintroduction without an explicit product decision.
- [ ] No manual token/password fields.
- [ ] No `<all_urls>` or non-X permissions.
- [ ] No npm/TS/build step.
- [ ] Scrapyard code is reimplemented, not copied as a black-box dependency.

### Missing logic / regressions

- [ ] Discovery: stop on cap, no cursor, repeated cursor, empty pages, user stop, run-id staleness.
- [ ] Queue: only 1–2 concurrent; `starting` holds a slot; terminal event before next start.
- [ ] Restart: in_progress kept; complete/interrupted/missing reconciled; no duplicate downloads.
- [ ] Capture bag: cookies never stored; CSRF from cookies preferred over stale capture when refreshing.
- [ ] Single-tweet path uses `TweetResultByRestId` shape only (not TweetDetail variables).
- [ ] Quotes still excluded until an explicit option exists; reposts honor Include reposts.
- [ ] Filename sanitization + invalid-filename fallback ladder still works.

### Deprecated / dead code to keep out

- `downloadZip`, `fetchAsArrayBuffer`, `getVideoUrl`, `downloadVideo`, `zipBuffers`, `ZipWriter`, `useZip`, `bulkId` ZIP session ids.
- `webRequest` permission without a real listener.
- Hardcoded third-party query IDs as the only discovery path (capture + scrape is OK; single stale ID as sole source is not).

## P0 — repo layout & release packaging (try-it-out path)

New this session (2026-08-25): restructure so the extension can be **Load unpacked** directly, with source and releases separated.

- [x] Renamed project folder to `extension/` — the single **Load unpacked** target (manifest.json at its root).
- [x] Moved docs to `docs/`, tests to `tests/`, LICENSE + README to repo root; `extension/` now contains only browser-loaded files + icons.
- [x] Flattened scrapyard to `reference/scrapyard/{rank-s-plucker-xbd, rank-a-video-downloader, rank-b-x-exporter}` (rank A/B were nested inside rank S; rank A extension was double-nested). Context notes + install instructions preserved per rank.
- [x] Added `scripts/package-release.sh` → `releases/x-media-downloader-v<version>.zip` (manifest at zip root, optional date tag, Windows fallback documented); `releases/*.zip` gitignored.
- [ ] **Try it out:** load `extension/` unpacked in a signed-in Chrome, then run the live-X checklist below end-to-end.
- [ ] Cut the first release zip (`scripts/package-release.sh`) and confirm it loads from the unzipped folder.
- [ ] Bump `extension/manifest.json` version when shipping the next user-visible change; optionally start a `CHANGELOG.md` per release.

## P0 — remaining (live-X, round 3)

Re-test v3.2 against the exact v3.1 failures:

1. **Homepage capture:** open `x.com/home`, scroll, confirm media lists without any reload.
2. **In-tab route change:** from home click into a post, then to a profile, then to `/media`, all without reloading. Media must list on every view within a couple of seconds.
3. **Profile posts vs /media:** on `https://x.com/real_loonarae` (the reported case) confirm the *posts* tab lists media, not only `/media`.
4. **Video posts:** confirm videos appear (per-post resolve is rate-bounded to ~1/700ms, so a video-heavy view fills in progressively).
5. **Auto-scroll:** start from the panel, confirm the in-page badge appears, that it scrolls continuously without waiting on downloads, and that Stop works from both the badge and the panel.
6. **Speed:** compare Fast vs Medium; Fast should advance as soon as X renders the next batch.
7. **One download action:** confirm `Select all` + `Download selected` is sufficient and nothing references a removed `Download all in tab`.
8. **Skip already downloaded:** download a few items, clear the list, re-scroll the same view, and confirm they do not come back. Then untick the toggle and confirm they do.
9. **Action bar:** confirm both `Download` and `Add to queue` appear under media posts and that `Add to queue` lands in the Side Panel list.
10. **Status pill:** confirm it reflects the current route, posts on screen, and pending video resolves; and that it warns when the tab is not X or needs a refresh.
11. Remote fetch still works as the secondary path with clear rate-limit messaging.
12. Replace synthetic fixtures with sanitized live captures when available.

## P1 — inclusion and review UX

1. Diagnostics panel: active X tab URL, watching status, last captured operation names, capture warm/cold, queue counts, and sanitized copy-debug-report.
2. Improve manual-scroll media support across more live X response shapes, especially video timeline variants.
3. Clearer badges/counts: scroll vs remote, photo/video/GIF counts, repost/original when exposed.
4. Explicit Include replies / Include quoted media.
5. Filename templates + video quality preference.

## P2 — other sources

1. Bookmarks / likes pagination.
2. User posts/replies timeline source.
3. Search / date-range.
4. Import currently loaded DOM media into the same queue.

## P3 — robustness

1. Download history UI; stronger resume policy.
2. Per-batch subfolders (Rank A-style) if requested.
3. HLS policy after MP4 verified.
4. Firefox MV3; avatar/banner; content-type extension detection.

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
- **43+** local Node tests still green after cleanup (`tests/background.test.js` + `tests/content.test.js`).
