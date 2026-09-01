# Development Worklist

_Last audited: 2026-09-01 (v3.6 media-kind upgrade: GIF→real-.gif conversion, forced-orig photo quality, archive kind rules — GIF/video ZIP/CBZ-only with optional toggles — and queueStart warnings; v3.5 earlier the same day: master folder, per-post ZIP/CBZ/PDF, naming checkboxes, offline CI. See both IMPROVEMENT_LOG entries. Previous audit 2026-08-26: round-3 live pass + v3.4 quoted-post capture.)_

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
| Direct filenames + invalid-name ladder | Done | Whole-batch ZIP intentionally removed; v3.5 adds template-driven paths at download time. |
| Master folder for raw downloads | **Done (v3.5), needs live spot-check** | `rawMasterFolder` (sync, default `XMedia`): `Downloads/XMedia/<post name>/001.jpg…`. Empty string = off → legacy flat `x-media/` names byte-for-byte. Per-segment sanitizing via `sanitizeArtifactFilename` (nh-dw port). |
| Per-post ZIP/CBZ/PDF output | **Done (v3.5, kind rules v3.6), needs live spot-check** | One archive per post (≤4 items), assembled in the offscreen document, saved via `<a download>` anchor (blob-filename quirk); worker data-URL fallback. v3.6: PDF is photos-only (GIF/video posts degrade PDF→ZIP); GIFs archive by default, videos opt-in; warnings at queueStart. NOT the removed whole-batch ZIP. |
| GIF → real .gif + quality guarantees | **Done (v3.6), needs live spot-check** | `normalizePhotoUrl` forces `name=orig` on every source; videos keep highest-bitrate MP4; GIFs convert MP4→GIF89a in the offscreen document (`lib/gifEncoder.js`, bounded 30 s/360 frames/720 px) with MP4 fallback on any failure; `gifOutput` toggle. |
| Naming-scheme checkboxes | **Done (v3.5)** | `nameTemplate` (sync, default `{user} - {text} - {id}`), checkbox UI + live preview + manual input for custom templates; id fallback, reserved-name prefix. |
| Offline CI | **Done (v3.5)** | `docs/ci/extension-tests.yml` (install by hand as `.github/workflows/…` — see `docs/ci/README.md`): syntax + `node --test` + packaging smoke. No real-browser CI — GitHub runners cannot drive MV3 (verified in nh-dw-2.0). |
| Per-tweet action bar | Expanded (Rank A) | `Download` **and** `Add to queue` on every media post, plus toasts. Reimplemented locally, not copied. |
| Popup DOM auto-scroll bulk | **Removed** | The popup's competing scroll+download loop is deleted; the popup is now an Open-Side-Panel launcher with a live capture status line. |
| ZIP export (whole-batch) | **Removed — stays removed** | The multi-GB whole-batch archive path stays deleted. v3.5's per-post archive (≤4 images, offscreen-assembled) is a different, explicitly requested feature and must not grow into batch archiving. |
| Third-party tier/license | Absent | Do not add. |
| Skip already-downloaded (Rank S "Ignore saved") | Done | `downloadedMediaIdsV1` stores completed item ids only. Toggle in the toolbar; resettable. |
| Cross-source dedupe | Done | Every item carries a CDN-derived `mediaKey`, so DOM-found and GraphQL-found copies of one photo collapse into a single row. |
| Bookmarks / likes full scan | Not implemented | |
| Include replies / quoted | **Quoted done (v3.4); replies not implemented** | Quote-card ("mentioned post") media now lists by default in both tabs with an **Include quoted** switch, correct quoted-post attribution, and a `quote` badge. Replies still need their own explicit switch. |
| Live signed-in verification | **Round 3 mostly passed; one gap fixed, needs spot-check** | Round 3 (v3.3): all functions work, no double entries, UI/UX decent for deployment — except quote-card media never listed (now fixed in v3.4 with quoted-post parsing + Include quoted switches). Re-verify the quote case plus the v3.3 items below. |
| `document_start` null-root crash | **Fixed + regression-tested** | Reported `Cannot read properties of null (reading 'appendChild')` at `content.js:105`. That file is a pre-v3.2 build (still has `localCapture*` + the popup bulk loop). The null-`<head>` case was already covered by a `documentElement` fallback; the null-`<head>`-and-null-`<html>` case still threw and killed capture. Now deferred-and-retried, never throws. 3 regression tests. |
| Code-review checklist (fit + missing logic + dead code) | **Run in full** | Clean except two contract commands that were handled in `background.js` and listed in the handoff but had no UI sender (`queueClearFinished`, `queueClearDownloadedHistory`). Both now wired to toolbar buttons; a structural contract test guards the class. `scrollRescan` remains a documented hook with no button (read-only, allowlisted). |


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
- [x] Restart: in_progress kept; complete/interrupted/missing reconciled; no duplicate downloads.
- [x] Capture bag: cookies never stored; CSRF from cookies preferred over stale capture when refreshing.
- [x] Single-tweet path uses `TweetResultByRestId` shape only (not TweetDetail variables).
- [x] Quotes are an explicit switch (**Include quoted**, default on, both tabs)
      and quote rows carry `isQuote` + quoted-post attribution; reposts honor
      Include reposts. Replies remain excluded.
- [x] Filename sanitization + invalid-filename fallback ladder still works.

### Deprecated / dead code to keep out

- Legacy runtime commands and batch-ZIP session state: `downloadZip`, `fetchAsArrayBuffer`, `getVideoUrl`, `downloadVideo`, `zipBuffers`, `useZip`, `bulkId`, and the old `lib/zip-writer.js` batch archiver. (The v3.5 `lib/zipWriter.js`/`XDLZip` STORE writer is per-post only and is NOT this.)
- `webRequest` permission without a real listener.
- Hardcoded third-party query IDs as the only discovery path (capture + scrape is OK; single stale ID as sole source is not).

## P0 — repo layout & release packaging (try-it-out path)

New this session (2026-08-25): restructure so the extension can be **Load unpacked** directly, with source and releases separated.

- [x] Renamed project folder to `extension/` — the single **Load unpacked** target (manifest.json at its root).
- [x] Moved docs to `docs/`, tests to `tests/`, LICENSE + README to repo root; `extension/` now contains only browser-loaded files + icons.
- [x] Flattened scrapyard to `reference/scrapyard/{rank-s-plucker-xbd, rank-a-video-downloader, rank-b-x-exporter}` (rank A/B were nested inside rank S; rank A extension was double-nested). Context notes + install instructions preserved per rank.
- [x] Added `scripts/package-release.sh` → `releases/x-media-downloader-v<version>.zip` (manifest at zip root, optional date tag, Windows fallback documented); `releases/*.zip` gitignored.
- [x] **Try it out:** loaded unpacked and live-tested across rounds 1–3. Round 3 (2026-08-26, v3.3) passed the core checklist — user report: all functions work, no double entries, UI/UX already decent for deployment. Only the v3.4 quote-case spot-check (item 12 below) remains.
- [ ] Cut the first release zip (`scripts/package-release.sh`) and confirm it loads from the unzipped folder.
- [x] Bump `extension/manifest.json` version when shipping the next user-visible change — now at **3.4** (quoted-media capture + Include quoted switches are user-visible); optionally start a `CHANGELOG.md` per release.

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

## P1 — inclusion and review UX

1. Diagnostics panel: active X tab URL, watching status, last captured operation names, capture warm/cold, queue counts, and sanitized copy-debug-report.
2. Improve manual-scroll media support across more live X response shapes, especially video timeline variants.
3. Clearer badges/counts: scroll vs remote, photo/video/GIF counts (v3.6 added the per-row `gif` badge), repost/original when exposed.
4. Explicit Include replies switch (quoted media shipped in v3.4).
5. ~~Filename templates~~ (shipped v3.5) + ~~video quality preference~~ (v3.6 always takes the highest-bitrate MP4 variant; a lower-quality *preference* is still unbuilt and likely unwanted).

## P2 — other sources

1. Bookmarks / likes pagination.
2. User posts/replies timeline source.
3. Search / date-range.
4. Import currently loaded DOM media into the same queue.

## P3 — robustness

1. Download history UI; stronger resume policy.
2. ~~Per-batch subfolders (Rank A-style)~~ — superseded by v3.5's master folder + per-post folders.
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
- **106** local Node tests still green after cleanup (`node --test tests/*.test.js`: background + content + naming + zip-writer + pdf-builder + gif-encoder + downloader + media-kinds suites).
