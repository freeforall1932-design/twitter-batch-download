# Development Worklist

_Last audited: 2026-08-25 (post Rank S/A pass + deprecation cleanup)_

## Product target

Signed-in Chrome user enters an X profile / `@username`, discovers media up to a local cap (default **99,999**), reviews newest-first in the Side Panel, selects items, and downloads with **1–2** active Chrome downloads. Cap is an upper bound only.

No manual API key / password / cookie paste. Self-hosted against the signed-in X session only — **no** third-party account, subscription, or paid/free tier.

## Implementation audit

| Area | Status | Notes |
|---|---|---|
| Manifest V3 / no build | Done | Plain JS under this folder. |
| Side Panel batch queue | Done | Selection, filter, concurrency 1–2, stop, retry, clear finished. |
| Persistent queue + restart reconcile | Done | `batchDownloadQueueV1`; starting/downloading recovery via `chrome.downloads.search`. |
| Profile discovery | Implemented, needs live-X | Capture-first op IDs + bundle scrape fallback; timeline_v2/legacy; empty-page stop. |
| Live GraphQL/header capture | Implemented, needs live-X | MAIN `injected.js` → content → `networkCapture`. No cookie values in bag. |
| Discovery error codes + RL countdown | Implemented, needs live-X | Side Panel countdown via `retryUntil`. |
| Direct filenames + invalid-name ladder | Done | ZIP intentionally removed. |
| Per-tweet action bar | Done, needs selector verify | `content.js` into `article[data-testid=tweet] [role=group]`. |
| Popup DOM auto-scroll bulk | Done (legacy) | Separate from Side Panel discovery; only sees loaded DOM tweets. |
| ZIP export | **Removed** | Deprecated path deleted (`lib/zip-writer.js`, handlers). Do not ship multi-GB archives. |
| Third-party tier/license | Absent | Do not add. |
| Bookmarks / likes full scan | Not implemented | |
| Include replies / quoted | Not implemented | Must be explicit switches when added. |
| Live signed-in verification | **Not run in CI/sandbox** | Blocks P0 complete. |

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

## P0 — remaining (live-X)

1. Run re-review checklist on a signed-in profile (limit ~20).
2. Replace synthetic fixtures with sanitized live first/cursor captures when available.
3. Confirm capture bridge warms after opening `/media` once.
4. Optional: Side Panel signed-in status pill.

## P1 — inclusion and review UX

1. Explicit Include replies / Include quoted media.
2. Stronger repost badge (original vs reposter when exposed).
3. Photo/video/GIF counts; thumbnail polish.
4. Filename templates + video quality preference.

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

- Retire or migrate popup DOM bulk into Side Panel.
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
