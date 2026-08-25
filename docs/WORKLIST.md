# Development Worklist

_Last audited: 2026-08-25 (Side Panel scroll-capture-first UX after live testing feedback)_

## Product target

Signed-in Chrome user opens the Side Panel, uses **Scroll capture** as the default workflow while manually scrolling X, reviews listed media, selects items, and downloads with **1–2** active Chrome downloads. The secondary **Remote fetch** tab can still discover a pasted X profile / `@username` up to a local cap (default **99,999**), but it is treated as an advanced fallback because live testing showed extension-initiated profile crawling can hit rate limits sooner than normal user scrolling. Cap is an upper bound only.

No manual API key / password / cookie paste. Self-hosted against the signed-in X session only — **no** third-party account, subscription, or paid/free tier.

## Implementation audit

| Area | Status | Notes |
|---|---|---|
| Manifest V3 / no build | Done | Plain JS under this folder. |
| Side Panel two-tab queue | Implemented, needs live-X | Default **Scroll capture** tab watches active X pages while the user scrolls; **Remote fetch** keeps paste-link discovery as secondary. Selection/download actions are tab-scoped. |
| Persistent queue + restart reconcile | Done | `batchDownloadQueueV1`; starting/downloading recovery via `chrome.downloads.search`. |
| Profile discovery | Implemented, needs live-X | Capture-first op IDs + bundle scrape fallback; timeline_v2/legacy; empty-page stop. |
| Live GraphQL/header/response capture | Implemented, needs live-X | MAIN `injected.js` → content → background. Headers warm operation metadata; GraphQL responses can list media from normal page scrolling. No cookie values in bag. |
| Discovery error codes + RL countdown | Implemented, needs live-X | Side Panel countdown via `retryUntil`. |
| Direct filenames + invalid-name ladder | Done | ZIP intentionally removed. |
| Per-tweet action bar | Done, needs selector verify | `content.js` into `article[data-testid=tweet] [role=group]`. |
| Popup DOM auto-scroll bulk | Legacy fallback | Popup still exists, but Side Panel Scroll capture is now the primary scroll/review/download surface. |
| ZIP export | **Removed** | Deprecated path deleted (`lib/zip-writer.js`, handlers). Do not ship multi-GB archives. |
| Third-party tier/license | Absent | Do not add. |
| Bookmarks / likes full scan | Not implemented | |
| Include replies / quoted | Not implemented | Must be explicit switches when added. |
| Live signed-in verification | **Partially run by user; new UX needs another pass** | Previous remote flow worked but was subpar vs Rank S UX/rate-limit behavior. New Scroll capture flow needs validation. |


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

## P0 — remaining (live-X)

1. Reload the unpacked extension, hard-refresh X, open Side Panel, and verify **Scroll capture** is the default tab.
2. On an X profile `/media` page, manually scroll and confirm media appears without pressing Remote discover.
3. Verify visible DOM photos list reliably and GraphQL-response-captured videos/photos appear as X loads timeline pages.
4. Confirm duplicates are avoided across DOM and response capture.
5. Test tab-scoped behavior: Scroll capture list, Remote fetch list, Select all, Download all in tab, and Clear history.
6. Test optional Side Panel auto-scroll: start, stop, limit, speed, media filter.
7. Run Remote fetch as secondary with a small limit and verify clearer rate-limit messaging/stopping.
8. Replace or augment synthetic fixtures with sanitized live first/cursor captures when available.
9. Optional but recommended next: Side Panel diagnostics/status pill and sanitized copy-debug-report.

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

- Retire or simplify popup DOM bulk into an “Open Side Panel” launcher after Scroll capture passes live testing.
- Action-bar “Add to queue”.
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
- **27+** local Node tests still green after cleanup.
