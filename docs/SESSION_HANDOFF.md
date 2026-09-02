# Session Handoff — X Media Downloader

**Prepared:** 2026-09-02 · **Extension version:** 3.6.1 · **Status:** v3.6.1 = the 2026-09-02 review/cleanup pass: shared `lib/archive.js` archive engine (worker + offscreen no longer carry duplicated fetch/PDF/ZIP code), Stop scan now cancels the 429/503 countdown, storage save chains survive a rejected write, `queueStart` gives failed items a fresh attempt budget, dead state removed, CI YAML cleaned in both byte-identical copies. All 116 offline tests green. Still pending live-X: the v3.4 quote-card spot-check AND the v3.5–v3.6 (now also v3.6.1) output spot-check — WORKLIST P0 items 12 + 14.

---

## 0. Start here — how to pick up this project

Read these three documents in order before touching code. They are maintained as
a set and each answers a different question:

| Document | Question it answers | How to use it |
|---|---|---|
| `docs/IMPROVEMENT_LOG.md` | **What changed and why?** Chronological, newest first. | Read the top 1–2 entries. Each records motivation, root cause, what changed, and validation. This is the fastest way to understand *why the code looks the way it does* — several designs are deliberate reactions to live-test failures and must not be "simplified" back. |
| `docs/WORKLIST.md` | **What is done, what is next?** Implementation audit table, priorities P0→P3, code-review checklist. | Check the audit table for area status, then the P0 section for the immediate task. Update the table when you change an area's status. |
| `docs/SESSION_HANDOFF.md` (this file) | **How does it fit together, and what are the rules?** Architecture, message contract, guardrails. | Reference while working. Update the architecture/message tables when you change them. |

**The review loop for each session:**

1. Read the newest `IMPROVEMENT_LOG.md` entries → understand recent intent.
2. Read `WORKLIST.md` P0 + audit table → find the next task.
3. Read this file's architecture + guardrails → avoid re-breaking settled decisions.
4. Take the user's input for this session (below) as the highest priority — it
   overrides the written plan when they conflict.
5. Do the work. Run `node --test tests/*.test.js`.
6. **Write back to all three docs before finishing**: a new `IMPROVEMENT_LOG.md`
   entry, updated `WORKLIST.md` statuses, and any architecture/message changes here.

### User input carried into the next session

_Latest input (2026-09-01, second brief):_ review the v3.5 workflow commit
(user installed CI via the GitHub web UI — it runs green) and the diff for
missing/misaligned logic; guarantee highest quality (photos `orig`, videos
top bitrate, **GIF saved as GIF, not MP4**); multi-GIF posts archive like
photo posts but **ZIP/CBZ only, never PDF**, optional; GIF+photo mixes
default to ZIP/CBZ; multi-video posts ZIP/CBZ only, **optional**; warn when
zipping a video post or when a post mixes photos/GIFs/videos; update the
three docs; clean up leftover code, keep the directory purpose-separated;
merge the PR. **Shipped in v3.6** — see the second 2026-09-01
IMPROVEMENT_LOG entry.

_Earlier input (2026-09-01, first brief):_ port three proven features from
the sister repo [nh-dw-2.0](https://github.com/freeforall1932-design/nh-dw-2.0)
(PR #30 / commit `9f86426` and the files it touches): (1) a master folder for
loose raw downloads (`Downloads/XMedia/<post name>/001.jpg…`, empty setting =
off, per-segment sanitizing), (2) ZIP/CBZ/PDF "one file per post" output for
multi-picture posts (offscreen blob + `<a download>` anchor because some
Chromium builds save blob downloads under a UUID), and (3) naming-scheme
checkboxes over a stored template string with a live preview. **Shipped in
v3.5** — see the 2026-09-01 IMPROVEMENT_LOG entry. The brief's guardrails are
folded into §7. Not yet live-verified (P0 item 14).

_(2026-08-26, kept for reference):_ live round-3 result — all functions work,
no double entries, UI/UX decent for deployment; quote-card media was the one
gap, fixed in v3.4 (`legacy.quoted_status_result`, per-tab **Include quoted**
switches). Its live spot-check (P0 item 12) is still pending.

_(2026-08-25, kept for reference):_ the pre-v3.2 `appendChild` crash trace and
its two carry-forward notes — confirm which folder Chrome has loaded before
trusting an old trace, and test new `document_start` DOM code with shim
overrides, not the shim's defaults.

Open questions to ask the user if they are available:

- ~~Did homepage / in-tab route-change capture actually work in v3.2?~~ —
  **answered by live round 3 (2026-08-26): all functions work, no double entries.**
- ~~Is auto-scroll "Fast" fast enough now?~~ — no complaint raised in round 3;
  revisit only if the user asks for more aggressive pacing.
- Should the two tab lists (Scroll capture / Remote fetch) finally be unified?
  They were kept separate on explicit past request — do not merge without a new decision.
- ~~Are per-batch subfolders (e.g. `x-media/{username}/`) wanted?~~ —
  **superseded by v3.5's master folder + per-post folders.**
- Should archives also honor the master folder? Currently impossible for the
  anchor path (the `download` attribute cannot carry folders); revisit only if
  Chromium fixes the blob-filename bug that forced the anchor mechanism.

---

## 1. Project and branch

- Repository: `freeforall1932-design/twitter-batch-download`
- Extension directory: `extension/` (the **Load unpacked** target)
- Working branch for the last Arena session: `arena/01a05aab-twitter-batch-download`; this session's branch is `arena/01a05f98-twitter-batch-download`
- Recent history:
  - **(v3.6.1, this branch)** — Review/cleanup pass: shared archive engine
    (`lib/archive.js`), Stop-cancels-backoff (`shouldAbort` through
    `fetchWithRetry`), save-chain hardening (`.catch` on queue/downloaded/
    discovery chains), `queueStart` attempt-budget reset, dead code removed
    (`replayedKeys`, `scanStats` counters, unused `collectTweetMedia` fields),
    CI YAML cleaned in both copies. Manifest 3.6 → 3.6.1, 116 offline tests.
  - **(v3.6, main)** — Media-kind upgrade: GIF→real-.gif conversion
    (`lib/gifEncoder.js` + offscreen `<video>`/canvas decode), forced
    `name=orig` photo quality, archive kind rules (PDF photos-only,
    GIF default-in / video opt-in, ZIP/CBZ only), queueStart warnings,
    shared `mediaEntryToItem` builder in content.js, 18 new tests (106)
  - **(v3.5, this branch)** — Media output upgrade ported from nh-dw-2.0:
    `rawMasterFolder` master folder for raw downloads (empty = off),
    per-post ZIP/CBZ/PDF assembly in a new offscreen document with an
    `<a download>` anchor save, `nameTemplate` checkbox UI + preview,
    `extension/lib/` (naming/zipWriter/pdfBuilder), 33 new tests (88 total),
    offline CI workflow
  - `4b10c23` — Merge PR #9 (**v3.4**: quoted-post ("mentioned post" card) media
    capture: quote parsing in `mediaFromTweet`/`getTweetMedia` with
    quoted-post attribution, `isQuote` flag + `quote` badge, per-tab
    **Include quoted** switches (default on), 7 new tests; plus the
    post-interrupt review pass — commits `08e68d0` + `b943a84`)
  - `abb3062` — Merge PR #8 (**v3.3**: `document_start` null-root crash fix;
    `queueClearFinished` + `queueClearDownloadedHistory` wired to toolbar
    buttons; message-contract and style-injection regression tests)
  - `6370ba8` — Live-testing fixes: always-on capture, SPA routes, single download action (**v3.2**)
  - `4cded49` — Merge PR #6 (repo restructure + release packaging)
  - `4cc3782` — Rank S live capture bridge + Rank A download fallbacks
  - `93940d8` — Discovery error classification, rate-limit countdown, fixtures

No build step, package manager, TypeScript, or server. After changes, reload the
extension at `chrome://extensions` and load **`extension/`** unpacked.

### Repository layout

```
extension/                 # ← Load unpacked target (manifest.json at root)
extension/lib/             # naming.js / zipWriter.js / pdfBuilder.js /
                           # gifEncoder.js / archive.js — UMD, shared by
                           # worker, offscreen, sidepanel and tests
extension/offscreen.html   # + offscreen.js: archive assembly (chrome.runtime ONLY)
tests/                     # background/content/naming/zip-writer/pdf-builder/
                           # gif-encoder/archive-lib/downloader/media-kinds
                           # suites + helpers/load-background.js
scripts/package-release.sh # zip extension/ → releases/x-media-downloader-v<version>.zip
releases/                  # generated zips (gitignored)
docs/                      # WORKLIST.md, SESSION_HANDOFF.md, IMPROVEMENT_LOG.md,
                           # PROJECT_IMPROVEMENT_OPINION.md
docs/ci/                   # extension-tests.yml (offline CI) — must be installed
                           # manually as .github/workflows/… (see docs/ci/README.md)
reference/scrapyard/       # abandoned extensions, reference only:
                           # rank-s-plucker-xbd / rank-a-video-downloader / rank-b-x-exporter
```

---

## 2. Product direction

The product is a **Chrome Side Panel media queue** built around a Rank-S-style
scroll-capture workflow — not one-button-per-tweet downloading, and not
primarily a background crawler.

A user should be able to:

1. Open the Side Panel and land on **Scroll capture** by default.
2. Open **any** X view — home timeline, profile, `/media`, or a single post —
   and scroll normally. Capture is always on; no button is pressed first.
3. Navigate **within the same tab** (profile → `/media` → post) and keep
   capturing, with no reload.
4. See media listed from X's own GraphQL responses and from visible DOM photos.
5. Optionally press **Start auto-scroll** to have the extension scroll for them.
   It never blocks on downloads and has no item cap.
6. Review the list, tick items or **Select all**, and press **Download selected**
   with **1 or 2** concurrent Chrome downloads. This is the *only* download
   action — a separate "Download all" was removed as redundant and confusing.
7. Use **Remote fetch** as the secondary/advanced tab: paste `@username` or a
   profile/`/media` URL and discover up to a local cap, default **99,999**.
   - The cap is an upper bound, not a target (690 media → completes at 690).
   - Local community cap only — not a third-party paid/free tier.
   - It can hit X rate limits sooner than human scrolling, so it is never the
     first impression.
8. Optionally include reposted media for Remote fetch. Quoted-post ("mentioned
   post" card) media is included **by default** in both tabs via the
   **Include quoted** switch (v3.4), listed with the quoted post's own
   attribution and a `quote` badge. Replies remain a future explicit option.
9. Use per-post action-bar buttons — **Download** (immediate) and
   **Add to queue** (batch) — as a convenience surface.

The popup is only a Side Panel launcher plus a capture status line.

---

## 3. Security and authentication policy

Do **not** ask the user to paste passwords, API keys, `auth_token`, `ct0`, or
Cookie headers.

- Self-hosted against the **signed-in X session only**.
- No third-party account, subscription, activation, license, or tier service.
- `background.js` reads `ct0` / `auth_token` cookies and a Bearer token (page
  capture or public fallback).
- Live network capture may remember non-cookie request headers (`authorization`,
  `x-csrf-token`, `x-client-transaction-id`, …). **Cookie header values are
  never stored in the capture bag.**
- Never display, export, log, or persist token values in the UI.
- `downloadedMediaIdsV1` stores **queue item ids only** — no URLs, no post text.

---

## 4. Current architecture (v3.6.1)

| File | Role |
|---|---|
| `manifest.json` | MV3, sidePanel, cookies/downloads/storage/scripting/**offscreen**. Content scripts: `injected.js` (MAIN, document_start) + `content.js` (isolated, document_start). Hosts: x.com / twitter.com / twimg CDN only. Version **3.6.1**. |
| `background.js` | Auth, GraphQL, source-tagged queue, remote discovery, downloads, capture bag, timeline response ingestion, downloaded-id history. Quoted-post media resolved from `quoted_status_result` (one level, soft-unwrap) with owning-post attribution. v3.5: output settings bag (`getOutputSettings`), download-time path building (`rawPathForItem`), per-post archive pass (`runArchivePass`) relayed to the offscreen document with a worker data-URL fallback. v3.6: `normalizePhotoUrl` forces `name=orig`; `isGif` identity; `prepareRawDownload` (GIF→.gif via offscreen, MP4 fallback); kind rules (`archivedKinds`/`effectiveGroupFormat`) and `buildRunNotices` warnings. v3.6.1: `shouldAbort` through `fetchWithRetry`/`sleepWithRateLimitCountdown` (Stop scan cancels backoff), catch-recovering storage save chains, `queueStart` resets the attempt budget, archive bytes delegated to `lib/archive.js`. **No whole-batch ZIP.** |
| `lib/naming.js` | Shared naming engine (UMD → `XDLNaming`): `sanitizeArtifactFilename` (per-segment, from nh-dw), master-folder normalize (empty = off), format whitelist, template tokens/render/preview helpers, raw + archive path builders. |
| `lib/zipWriter.js` | STORE-only ZIP writer (`XDLZip`) for per-post archives — local re-implementation instead of JSZip (no-npm guardrail). |
| `lib/pdfBuilder.js` | Dependency-free PDF 1.4 writer (`XDLPdf`), ported verbatim from nh-dw `pdfBuilder.ts` (JPEG DCTDecode verbatim, byte-exact xref). |
| `lib/gifEncoder.js` | v3.6: dependency-free streaming GIF89a encoder (`XDLGif`) — median-cut global palette, spec-timed LZW, NETSCAPE loop. Round-trip-verified by a decoder in its test suite. |
| `lib/archive.js` | v3.6.1: shared archive plumbing (`XDLArchive`) — `fetchImageBytes`, `preparePdfImage`, `bytesToBase64`, `buildArchiveBytes` (ZIP/CBZ/PDF bytes + MIME). ONE copy used by the worker fallback AND the offscreen document (they previously duplicated ~120 lines and could drift); no chrome API, runs in both contexts and Node. |
| `offscreen.html/js` | Archive assembly + v3.6 GIF conversion: fetch post media, convert GIF clips through `<video>`+canvas (12 fps, ≤30 s/≤360 frames/≤720 px/≤40 MB) into real .gif bytes, build ZIP/CBZ/PDF blob (via `lib/archive.js`), save via in-document `<a download>` anchor. Raw-mode GIF bytes return to the worker as base64 (data: URLs keep the master-folder subpath). Exposes ONLY `chrome.runtime` — settings arrive relayed in the job message. |
| `injected.js` | MAIN-world XHR/fetch observer. Forwards **any** media-bearing GraphQL response (no operation allowlist), keeps a 40-entry replay buffer, and watches SPA route changes via `pushState`/`replaceState`/`popstate`. The allowlist survives only for Remote-fetch *request metadata*. |
| `content.js` | **Always-on** scroll capture (no watch command), SPA route re-arm, DOM photo listing, rate-bounded per-post video resolve (quote-card media resolved through the outer post id), content-driven auto-scroll with in-page badge, action-bar `Download` + `Add to queue`, toasts. v3.5: items carry `text`/`displayName`/`mediaIndex`; `downloadFile` sends the owning item. v3.6: one shared `mediaEntryToItem()` builder (scroll resolver + action bar), `isGif` flag. |
| `sidepanel.html/js/css` | Two-tab Side Panel: Scroll capture + Remote fetch. One download action, live active-tab status pill, per-row remove, skip-already-downloaded toggle, **Include quoted** switches, `Clear finished` / `Reset downloaded history` buttons. v3.5: **Output settings** card (master folder, default format, name-template checkboxes + live preview + custom-template input — the ONLY writer of the sync output settings) the dock's per-job **Save posts as** picker, v3.6 GIF/archive toggles, the `gif` badge, and the amber `queueNotices` warning box. |
| `popup.html/js` | Side Panel launcher + capture status line. No scroll/download loop. |
| `tests/` | `background.test.js`, `content.test.js`, plus v3.5: `naming.test.js`, `zip-writer.test.js`, `pdf-builder.test.js` (verbatim port), `downloader.test.js` (real worker in a VM: master-folder + archive pipelines), v3.6: `gif-encoder.test.js` (round-trip decoder) + `media-kinds.test.js` (quality, kind rules, warnings, mixed-post pipelines), v3.6.1: `archive-lib.test.js` (shared-engine byte parity) + 4 background regressions (abort on Stop, `stopped` classification, attempt-budget reset, storage-write recovery), `helpers/load-background.js`. |

### Design decisions that are deliberate — do not "simplify" these away

These each fix a specific reproduced live failure. Reverting any of them
re-breaks a bug the user already reported:

1. **No operation-name allowlist on GraphQL *responses*.** An allowlist in
   `injected.js` + `background.js` is exactly what made the home timeline never
   capture. Keep the allowlist for request metadata only.
2. **Capture starts unconditionally at `document_start`.** It must not wait for
   a Side Panel command; that made every non-targeted tab capture nothing.
3. **SPA route watcher + replay buffer.** X serves in-tab views from cache with
   no new request. Without the replay these views list nothing until a reload.
4. **Per-post video resolve is rate-bounded (~700ms).** Raising it without live
   rate-limit testing risks 429s.
5. **One download action.** `Select all` + `Download selected` replaced the
   redundant `Download all in tab`.
6. **The popup has no scroll/download loop.** Two engines fought over the page
   and the popup blocked scrolling on each download.
7. **Stylesheet injection must never throw.** `content.js` runs at
   `document_start`, where `document.head` — and sometimes `document.documentElement`
   — do not exist yet. `injectStyles()` falls back through both parents and, if
   neither exists, defers to a `Document`-node `MutationObserver` +
   `DOMContentLoaded` retry. A bare `document.head.appendChild(...)` here aborted
   the whole IIFE, so a styling edge case silently disabled all capture on that
   tab. Do not collapse it back to a one-liner.
8. **Quoted-post media: one level, soft-unwrap, owning-post attribution.** The
   quote card's media is parsed from `quoted_status_result` in the *same*
   payload (Rank S pattern) — never re-requested per quote, never recursed
   into a quote-of-quote, and a deleted/protected card skips quietly instead
   of failing the page. Items carry the *quoted* post's id/author/text so
   filenames and skip-history match the media's real owner. DOM-scan photos
   inside a quote card still attribute to the outer article (no stable
   selector); the mediaKey dedupe collapses the two, so do not "fix" that by
   guessing quote-card selectors.
9. **Offscreen documents get a settings bag, never storage.** (v3.5, verified
   on real Chrome in nh-dw-2.0.) Offscreen documents expose ONLY
   `chrome.runtime`; a `chrome.storage`/`downloads`/`scripting` call there
   crashes the whole download. Output settings are read in the worker and
   relayed inside the job message.
10. **Archive blobs save via an in-document `<a download>` anchor.** (v3.5,
   nh-dw v3.2.1 hard-learned.) Some Chromium builds ignore
   `chrome.downloads.download`'s `filename` for `blob:` URLs and save a
   UUID. Remote URLs (raw mode) keep going through `chrome.downloads`,
   which names http(s) and data: URLs correctly. Consequence: archives
   cannot carry a folder (the anchor attribute strips paths) and land at
   the Downloads root — do not "fix" this by handing blob URLs to
   chrome.downloads.
11. **The master-folder field saves the empty string.** (v3.5.) Empty is
   meaningful — it means OFF (legacy flat layout, byte-for-byte). The Side
   Panel wires the input manually with a `change` listener storing
   `.value.trim()` verbatim; never route it through a generic widget that
   drops empty values.
12. **Raw paths are computed at download time, not at listing time.** Items
   store metadata (`text`/`displayName`/`mediaIndex`) plus the legacy
   `filename`; `rawPathForItem` renders the template + master folder when
   the download starts, so settings changes apply to an already-listed
   queue and the legacy filename survives as the master-off/fallback path.
13. **GIF items keep `type:"video"` plus an `isGif` flag.** (v3.6.) X
   delivers animated_gif media as silent MP4 clips; the capture filter,
   existing queues, and skip-history all treat them as motion media. A new
   `"gif"` type would have silently dropped GIFs from the "video" filter.
   Conversion to a real .gif happens at download time only, and EVERY
   failure mode falls back to the original MP4 — a GIF item must never fail
   because conversion did.
14. **PDF is photos-only; GIF/video archive entries force ZIP.** (v3.6.)
   `effectiveGroupFormat` degrades PDF→ZIP per post the moment a GIF or
   video enters its archive, and `buildRunNotices` announces it at
   queueStart. Do not "fix" this by rendering a GIF's first frame into a
   PDF page — the animation loss is the whole reason for the rule.
15. **One archive engine for both contexts.** (v3.6.1.) `lib/archive.js`
   (`XDLArchive`) is the ONLY copy of fetch-image / PDF-page-prep / base64 /
   ZIP-PDF assembly; `background.js`'s worker fallback and `offscreen.js`
   both call it. The previous duplicated copies could drift silently (the
   kind of bug this session's review was looking for) — do not re-split them.
16. **Stop scan cancels a pending rate-limit countdown.** (v3.6.1.)
   `fetchWithRetry`/`sleepWithRateLimitCountdown` honor a `shouldAbort`
   callback the discovery run wires to `stopRequested` + run-id staleness,
   and an aborted retry is reported as a clean stop, never a fake error.
   Do not "simplify" this back to a wait-the-full-wait loop.

### Removed / deprecated — do not reintroduce without a product decision

- `lib/zip-writer.js` (the OLD batch archiver) and all whole-batch ZIP
  assembly (`downloadZip`, `fetchAsArrayBuffer`, `zipBuffers`). The v3.5
  per-post archive (≤4 images, `lib/zipWriter.js`/`XDLZip` + offscreen) is a
  separate, explicitly decided feature — it must not grow into batch
  archiving.
- Legacy runtime messages: `getVideoUrl`, `downloadVideo`, `downloadZip`,
  `fetchAsArrayBuffer`.
- Popup bulk commands `start` / `stop` / `getStatus`, and the whole
  `localCapture*` command family (`localCaptureWatch/Start/Stop/Status`).
- The Side Panel `Watch current tab` button and the auto-scroll item limit.
- The `Download all in tab` button.
- Unused `webRequest` permission; dead `useZip` / `bulkId` state.
- `TweetDetail` fallback for single-tweet media (wrong variables/shape).

### Runtime message contract

**Queue:** `queueGet`, `queueAdd` (returns `addedCount`), `queueSelect`,
`queueSelectVisible`, `queueSetConcurrency`, `queueStart` (v3.5: carries an
optional per-job `format` — "raw"|"zip"|"cbz"|"pdf"; omitted → the stored
default; never written back to storage), `queueStop`,
`queueRetryFailed`, `queueClearFinished`, `queueClearAll`, `queueRemove`,
`queueSetSkipDownloaded`, `queueClearDownloadedHistory`

_Every action above is asserted to have both a handler and a UI sender by the
contract test in `tests/background.test.js`. Add a command → add a sender, or the
suite fails. The single exception is `scrollRescan`, a read-only hook with no
button yet._

**Discovery:** `discoveryGet`, `discoveryStart` `{ target, limit, includeRetweets, includeQuoted }`,
`discoveryStop`. State also exposes `errorCode`, `retryAfterMs`, `retryUntil`.

**Capture / media:** `networkCapture`, `localTimelineCapture` (returns
`{ addedCount, tweetIds }`; carries `mediaFilter`, `skipDownloaded`,
`includeQuoted`), `initEnv`, `getTweetMedia` (each returned media entry carries
its owning post's `username` / `displayName` / `tweetId` / `text` / `date` /
`mediaIndex` / `isQuote`; v3.6: video entries keep `type` `"animated_gif"`
so callers can set `isGif`), `downloadFile` (v3.5: optional `item` with the
owning post's metadata so the path honors master folder + template — v3.6
runs it through `prepareRawDownload`, so one-off GIF downloads convert too;
without it the legacy `filename` is used verbatim)

**Worker → offscreen:** `offscreenBuildArchive`
`{ job: { format, filename, gifOutput, images: [{ url, kind, name }] } }`
and v3.6 `offscreenConvertGif` `{ job: { url } }` → `{ ok, base64 }`,
answered via `sendResponse` `{ ok }` / `{ ok: false, error }`. Not part of
the UI contract test (no UI surface sends them); the offscreen document
handles both in `offscreen.js`.

**Side Panel → content script:** `scrollSettings` (carries `includeQuoted`),
`scrollStart`, `scrollStop`, `scrollStatus`, `scrollRescan`

**MAIN ↔ isolated world (`window.postMessage`):**
`XDL_INJECTED` → `xdlInjectedReady`, `xdlNetworkCapture`, `xdlGraphqlResponse`,
`xdlUrlChanged`, `xdlReplayDone`; `XDL_CONTENT` → `xdlRequestReplay`

### Queue item shape

```js
{
  id: "tweetId-mediaId",
  url, type: "photo" | "video",
  thumbnail, author, date, tweetId, mediaId,
  source: "scroll" | "remote",
  mediaKey,           // CDN-derived identity; collapses DOM vs GraphQL duplicates
  isRepost, isQuote,  // isQuote = media owned by the post inside a quote card
  isGif,              // v3.6: animated_gif source (type stays "video"; converted
                      // to a real .gif at download time per gifOutput)
  text,               // v3.5: raw post text (owning post) for the {text} token
  displayName,        // v3.5: owning author's display name ({name} token; "" from DOM scan)
  mediaIndex,         // v3.5: 0-based position in the OWNING post → 001…004 numbering
  filename,           // legacy flat path x-media/{user}_{text}_{tweetId}_{index}.{ext};
                      // used verbatim when the master folder is off / metadata missing
  selected, status,   // discovered|queued|starting|downloading|completed|failed
  attempts, bytesReceived, totalBytes, downloadId?, error?
}
```

Queue STATE additionally persists `outputFormat` (the effective format of the
current run, set by `queueStart`) so a worker restart mid-run cannot switch
archive photos back to raw, and `notices` (v3.6: the run's up-front archive
warnings, rendered in the dock while the queue runs).

### Storage keys

`batchDownloadQueueV1` (queue, local), `profileDiscoveryV1` (discovery, local),
`downloadedMediaIdsV1` (completed item ids only, capped at 20k, local), plus UI prefs
(local) `sidePanelActiveTab`, `scrollMediaFilter`, `scrollSpeed`, `skipDownloaded`,
`scrollIncludeQuoted`, `batchTarget`, `batchLimit`, `includeRetweets`,
`includeQuoted`.

**chrome.storage.sync (v3.5–v3.6, written ONLY by the Side Panel Output
settings card):** `rawMasterFolder` (default `"XMedia"`; **empty string =
OFF**), `nameTemplate` (default `"{user} - {text} - {id}"`), `outputFormat`
(default `"raw"`, whitelist raw|zip|cbz|pdf), `gifOutput` (default `"gif"`,
else `"mp4"`), `archiveGifs` (default `true`), `archiveVideos` (default
`false`). All are normalized on read (`normalizeOutputSettings`) so corrupt
values degrade to defaults. v3.6.1 adds no keys.

---

## 5. What still needs live-X validation

**Round 3 passed (2026-08-26, against v3.3).** The user reported: all
functions work, no double entries, UI/UX already decent for deployment. That
covers checklist items 1–11 of `docs/WORKLIST.md` → "P0 — remaining (live-X,
round 3)". Offline tests still cover only logic, not X's live shapes, so
these browser items remain open:

- **Quote-card media (v3.4, checklist item 12)** — shipped *after* the
  round-3 test, so it has never run in a browser: a GIF/video reaction to a
  quoted post must list the card's media too, with the quoted author and a
  `quote` badge; **Include quoted** off must suppress it; the same quoted
  photo quoted by two different posts must stay a single row.
- **Media output upgrade (v3.5–v3.6, checklist item 14)** — never run in a
  browser: master folder auto-creation on a real 4-photo post
  (`Downloads/XMedia/<post name>/001…004.jpg` with "ask where to save" OFF),
  empty box → old flat layout, ZIP/CBZ/PDF contents + names via the
  offscreen anchor on current Chrome, `{text}` checkbox → preview + produced
  names, dock picker not touching the stored default. v3.6: a GIF post
  saves as a real looping `.gif` in the master folder (`.mp4` when
  switched), a mixed photos+GIF post under PDF saves as ZIP with `002.gif`
  and shows the amber dock warning, video archiving warns and produces
  `NNN.mp4` entries, and a `name=small` photo re-downloads at `orig`.
- **First release zip** — `scripts/package-release.sh` output must be
  confirmed to load from the unzipped folder (it now includes `lib/` and the
  offscreen files; verified present in the zip listing offline).

Do **not** declare P0 complete without the signed-in quote-case and
output-upgrade checks.

### Required live data if something fails

Ask for a **sanitized** network capture only (no credentials):

1. Scroll capture: a GraphQL response from the exact failing view.
   *The parser is allowlist-free, so a miss now means the payload shape, not the
   operation name.*
2. Remote fetch: first `…/media` GraphQL request URL + variables/features + JSON body.
3. Cursor page request/response.
4. Optional: 429, protected, deleted, NSFW errors.
5. Redact cookies, auth headers, and private content.

---

## 6. Scrapyard policy (Rank S > A > B)

- Use the abandoned extensions in `reference/scrapyard/` as **conceptual /
  pattern** references only. Reimplement locally against this queue, parser, and
  scheduler.
- Never import third-party login, license, activation, tier, or external API
  hosts (`apixbd.plucker.io`, ExtPay, etc.).
- **Rank S (Plucker XBD):** live GraphQL/header intercept, SPA URL watcher,
  replay-on-reconnect, "Ignore saved" — **adopted**.
- **Rank A (video downloader):** action-bar `Download` + `Add to queue`, toasts,
  filename fallback ladder — **adopted**. Per-batch subfolders still available
  as an idea.
- **Rank B (X Exporter):** low priority; licensing code ignored.

Each rank folder keeps its original `comment and context.txt`. These are
one-line quality notes that inform ranking, not detailed specs.

---

## 7. Guardrails

- No npm / TypeScript / webpack / build step. (This is why v3.5 ships a
  local STORE-only ZIP writer instead of JSZip.)
- No `<all_urls>` or non-X host permissions.
- Privileged APIs stay in `background.js` — and offscreen documents use
  ONLY `chrome.runtime` (see design decision 9).
- No manual auth-token input.
- No dead `statuses/show.json` v1.1 endpoint.
- No whole-batch ZIP for large queues (direct files only). The v3.5
  per-post ZIP/CBZ/PDF (≤4 images of ONE post) is the explicitly decided
  exception and must stay per-post.
- Download paths: RELATIVE subpaths only — never absolute, never `..`;
  every artifact name passes `sanitizeArtifactFilename` per segment.
- CI stays offline-only: GitHub-hosted runners cannot run real-browser MV3
  tests (Chrome `Runtime.enable` timeout / Brave SIGTRAP — 100% failure
  rate where tried in nh-dw-2.0). Real-browser verification is the local
  P0 checklist. If a workflow push is ever rejected for a missing
  `workflows` scope, hand the user the YAML to paste via the GitHub web UI
  instead of retrying.
- No claim of current X support without a live check.

---

## 8. Commands

```bash
# from repo root
for f in extension/*.js extension/lib/*.js; do node --check "$f"; done   # every shipped script (node --check only honors one file per call)
node --test tests/*.test.js            # 116 tests
scripts/package-release.sh             # → releases/x-media-downloader-v<version>.zip
```

`tests/content.test.js` runs the real `content.js` inside a DOM + `chrome` shim
and encodes each reported live failure as a regression test (homepage capture,
in-tab route change, duplicate suppression, capture filter, auto-scroll
lifecycle). `tests/downloader.test.js` runs the real `background.js` (plus the
real `lib/` files via a working `importScripts`) in a window-less VM and covers
the whole v3.5 output pipeline — master folder on/custom/off/weird, ZIP/CBZ/PDF
end-to-end through the data-URL fallback with byte-level archive assertions,
and the offscreen job relay. `media-kinds.test.js` (v3.6) covers quality
forcing, GIF identity, the kind rules and warnings, and the mixed-post
pipelines; `gif-encoder.test.js` round-trips encoded GIFs through a real
decoder. **Extend these rather than testing by hand** — every future capture
or output bug should land as a failing test first.

CI is LIVE: `.github/workflows/extension-tests.yml` is installed and runs
green on GitHub (installed via the web UI on 2026-09-01 — the Arena GitHub
App has historically lacked the `workflows` scope to push it, so if a push
touching `.github/workflows/` is rejected, keep `docs/ci/extension-tests.yml`
updated and hand the user the paste-ready diff). `docs/ci/extension-tests.yml`
remains the byte-identical reference copy — verify with `diff` after every
workflow edit (both were cleaned together on 2026-09-02 for v3.6.1). It runs
the offline set plus a packaging smoke and deliberately has NO real-browser
job (§7).

---

## 9. Next session priorities

1. **Live spot-check v3.4 + v3.5 + v3.6 + v3.6.1** — WORKLIST P0 items 12 and 14.
   Reload `extension/` unpacked (manifest 3.6.1, "ask where to save" OFF),
   then: the quote-card case (item 12), a 4-photo post in raw mode
   (`Downloads/XMedia/<post name>/001…004.jpg`), the empty-master-folder
   rollback, one ZIP + one CBZ + one PDF from the same post (contents,
   order, names, PDF orientation), the `{text}` checkbox → preview + real
   names, the dock picker not persisting — plus the v3.6 list in item 14:
   real `.gif` output (and the `.mp4` switch), mixed-post PDF→ZIP with the
   amber warning, opt-in video zipping with its warning, `orig`-quality
   re-download. If an archive still saves under a UUID, capture the Chrome
   version — that is the blob-filename bug the anchor mechanism dodges.
2. **Cut the first release zip** (`scripts/package-release.sh` →
   `releases/x-media-downloader-v3.6.1.zip`) and confirm it loads from the
   unzipped folder. Optionally start `CHANGELOG.md`. With that plus item 1,
   P0 is complete. (The v3.6.1 `ci` packaging smoke already passed —
   `lib/archive.js` is in the zip; that CI artifact was deleted.)
3. P1 afterwards: Side Panel diagnostics + sanitized copy-debug-report,
   explicit Include replies switch (quoted shipped in v3.4). Name templates
   shipped in v3.5; highest-bitrate video is guaranteed since v3.6.
4. Settled decisions that stay settled: separate scroll/remote lists (do not
   merge without a new user decision), one download action, no whole-batch
   ZIP (per-post archives only), no reply capture until it has its own
   switch, offscreen documents = chrome.runtime only, blob saves via the
   in-document anchor, PDF photos-only (GIF/video archive entries force
   ZIP), GIF failures fall back to MP4 — never a failed item.
5. Before finishing: update all three docs (log entry, worklist statuses,
   this file).
