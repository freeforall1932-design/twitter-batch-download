# Session Handoff — X Media Downloader

**Prepared:** 2026-09-03 · **Extension version:** 3.15.0 · **Status:** **v3.15 = animated WebP mode + animated-format fallback chain** (newest IMPROVEMENT_LOG entry): the "Animated posts save as" setting gained a fifth choice — **animated WebP** (`webp`: true color via the browser's native per-frame encoder, `canvas.toBlob("image/webp", 0.9)`, wrapped into the WebP animation container by the new dependency-free `lib/webpEncoder.js` — VP8X/ANIM/ANMF per the container spec, ALPH propagation, 24-bit fields; 25 fps / ≤1920 px / ≤256 MB). Conversion failures now **fall back automatically**: `ANIMATED_OUTPUT_FIDELITY = [apng, webp, gif-max, gif]`, `convertFallbackChain(preferred)` tries the user's choice first then every other animated format, and `prepareRawDownload` keeps the original MP4 only after ALL animated formats failed ("use GIF before MP4 as last resort"); `normalizeGifOutput` accepts `webp`; both workers + both sidepanel copies updated (Firefox behavior unchanged: no offscreen → MP4). Reference-decoder review (Pillow) confirms GIF (balanced + max), APNG and WebP all open as real 3-frame animations with correct size/loop/durations; APNG pixel-exact, WebP true color (~686 B vs APNG ~11.8 KB on the 3×48×48 check), GIF-max per-frame palette accurate, balanced GIF shows its documented first-frame-palette banding. **Tests 194 pass / 0 fail**: new `tests/webp-encoder.test.js` (7) + media-kinds webp conversion / APNG→WebP fallback / all-failed→MP4 chain report / `convertFallbackChain` + normalize coverage. Manifests **3.14.0 → 3.15.0**; no release zip cut yet (pending user review). Previous status: **v3.14 = output quality modes — maximum-quality GIF + true-color APNG** (older IMPROVEMENT_LOG entry): the "GIF posts save as" Output-settings select now offers balanced GIF (unchanged default: 12 fps / ≤720 px / global palette / ≤40 MB), **maximum-quality GIF** (`gif-max`: 25 fps / ≤1920 px / per-frame local 256-color palettes + Floyd–Steinberg dithering / ≤256 MB), **true-color APNG** (`apng`: same caps, full RGBA frames — no palette, `extension/lib/apngEncoder.js`, filter-0 + per-frame deflate via `CompressionStream`, chunk CRCs + fcTL/fdAT sequence numbers) and MP4. Offscreen conversion is now a **chunked two-message relay** (3 MB binaries, per-job buffer with 15-min TTL; legacy one-shot path kept for no-jobId callers); background `convertGifViaOffscreen(url, output)` joins chunks, keeps the data:-URL save (master folder + per-user subfolders survive for `.gif` **and** `.apng`), and every failure still degrades to the original MP4. `normalizeGifOutput` accepts all four modes, upgrading/storing and degrading unknown values to `gif`. Worker relays + sidepanel options mirrored to the Firefox port (UI hint unchanged: no offscreen → MP4 kept). **Tests 183 pass / 0 fail**: new `tests/apng-encoder.test.js` (6), GIF local-palette reader + 4 max-quality tests, media-kinds chunked-relay/gif-max/apng/chunk-failure/normalize tests. Two encoder bugs found by the new tests and fixed: GIF local mode re-wrote the header per frame; APNG acTL patch used wrong part offsets (missing signature) and included the length field in the recomputed CRC. Manifests **3.13.0 → 3.14.0**; workflows now also trigger on `firefox-extension/**` + `source/archive-enabled/**`; no release zip cut yet (pending user review). Previous status: **v3.13 = leanness pass — dead archive code stripped, GIF conversion restored** (older IMPROVEMENT_LOG entry): the shipped `extension/` + `firefox-extension/` save separate original-resolution files only — per-post ZIP/CBZ/PDF is retired from the shipped UI/worker (`queueStart` forces raw) and preserved under `source/archive-enabled/` (**not** a Load-unpacked target). This pass removed the ~230-line dead archive section from both workers (`runArchivePass`, `buildArchiveInWorker`, `sendArchiveJobToOffscreen`, `archiveGroups`, `effectiveGroupFormat`, `archiveEntryExtension`, `archivedKinds`) plus the vestigial format/notices UI (defaultFormat/jobFormat selects, queueNotices box + CSS, archive preview branch, archive settings keys), and restored the one thing worth keeping: **GIF conversion works again on Chrome** via a small GIF-only offscreen document (`offscreen.html` + `offscreen.js`, only `chrome.runtime`, only `offscreenConvertGif`; `offscreen` permission re-added, manifest **3.13.0**). The Side Panel "GIF posts save as" select is now actually wired (it was never persisted before). Firefox keeps the MP4 clip (no `chrome.offscreen` in MV2). Archive coverage lives in `tests/archive-background.test.js`; the shipped suites keep raw-mode + GIF-conversion regression coverage; full offline suite **169 pass / 0 fail** (168 before +1 stale-format regression). No release zip cut yet. Previous status: **v3.12 = archive-output retirement, source split + test retarget**: **v3.11 = per-user folders in the master folder**: raw downloads default to `XMedia/<user>/<post name>/001.jpg` (master → one folder PER USER → per-post folder), so media from the home timeline, a profile and its `/media` page of the same user lands in ONE folder — the folder doubles as visual dedupe on top of v3.10's byte + source-URL verification; `userFolders` toggle (default ON) restores the old layout; legacy queue rows still get their user folder from `item.author`; no known author → no user segment (never an "unknown" bucket). **The garbled-random-name problem is on the work list as PENDING REVIEW — root cause still unconfirmed, NOT fixed until the user tests and confirms.** Manifest **3.10.0 → 3.11.0**, **167 offline tests** (+3), `firefox-extension/` re-synced, NO release zip cut yet (pending user review; the v3.10.0 zip is stale). Previous status: **v3.10 = byte-identical + source-URL duplicate verification** (newest before that IMPROVEMENT_LOG entry): new `lib/dedupe.js` (streaming SHA-256 + canonical source URL, `XDLDedupe`); `downloadedMediaRecordsV1` record store with URL-key/hash/mediaKey indexes alongside the legacy id list; `downloadFile` verifies source URL first (no network), then streams the bytes and hashes them before `chrome.downloads.download` — same-URL or byte-identical media is skipped with `duplicate_url` / `duplicate_bytes` and marked `completed · duplicate` instead of re-saved under a uniquified `(1)` name; completion stores hash + URL + real saved filename (queue rows via `onChanged`, direct one-click saves via a pending-record map); `mergeQueueItems` treats the canonical URL as a third identity and checks it against the record store for "Skip already downloaded"; the archive pass skips a group whose media are all already verified and records per-entry + archive digests; `verifyDuplicates` toggle added to Output settings (default ON, best-effort — a failed byte fetch falls back to the historical direct download); legacy flat path sanitizers also strip bidi controls so names cannot garble. Manifest **3.9.0 → 3.10.0**, **164 offline tests** (+14), `firefox-extension/` re-synced, release zip re-cut. Previous status: **v3.9 = virtualization-proof capture** (newest IMPROVEMENT_LOG entry): X removes articles that scroll off-screen and capture was scan-only, so a post inserted and removed between two scans was never listed at all — measured **81 of 207 photos, 39 of 103 posts, 1 of 17 videos** on a fast scroll. `harvestMutationArticles()` now reads the MutationObserver's `addedNodes` *and* `removedNodes` (a detached subtree is still fully queryable, so even a same-task insert+trim is caught), lifting that to **204 photos / 101 posts / 17 videos** fast and **207 / 103 / 17** at normal speed, with **0 duplicate ids** in every configuration. Dedupe was already airtight across three layers and is now test-pinned. Manifest 3.8.0 → **3.9.0**, **150 offline tests** (+10), `firefox-extension/` re-synced, release zip re-cut. Previous status: **v3.8 = Rescan restores deleted rows** (newest IMPROVEMENT_LOG entry): the per-tab "already listed" memory that made `Rescan tab` look broken is now cleared by explicit user actions — `forgetListedMedia()` wipes `listedMediaIds`/`listedMediaKeys`/video-resolve state *and* `lastReplaySeq`, so a rescan (or the start of a deep fetch) re-lists the posts on screen, including ones X virtualized out of the DOM that survive only in the MAIN-world replay buffer. The Side Panel gained **Remove selected** (`queueRemove` with an `ids` array — the worker already accepted it) to complete "pick which ones to delete", and `mergeQueueItems` now reports `skippedDownloaded` so an empty result always names its reason. Manifest 3.7.0 → **3.8.0**, **140 offline tests** (+5, 1 rewritten), `firefox-extension/` re-synced, release zip re-cut. Previous status: **v3.7 = the Fetch button** (newest IMPROVEMENT_LOG entry): a shallow fetch (replay buffered GraphQL + DOM rescan + video resolve, *no page movement*) now runs by itself when a tab opens on a profile and on every SPA route change, so a new tab lists its first batch without scrolling; a floating in-page **Fetch media** dock (`.xdl-fetch-dock`, which absorbed the old auto-scroll badge) and a Side Panel **Fetch media** button run the *deep* fetch — shallow → the existing auto-scroll engine → an optional silent `discoveryStart` fill of the same profile (hybrid, the user's explicit choice; its rows land in the Remote fetch list, the two lists stay separate). The same audit fixed 8 real defects, the headline one being `safeSend()` never releasing awaiting callers on an invalidated extension context, which wedged the video resolver until the user reloaded the page. Manifest 3.6.3 → **3.7.0**, **135 offline tests** (+10), `firefox-extension/` re-synced, release zip re-cut. Previous status: Firefox port added (see below). v3.6.1 = the 2026-09-02 review/cleanup pass: shared `lib/archive.js` archive engine (worker + offscreen no longer carry duplicated fetch/PDF/ZIP code), Stop scan now cancels the 429/503 countdown, storage save chains survive a rejected write, `queueStart` gives failed items a fresh attempt budget, dead state removed, CI YAML cleaned in both byte-identical copies. All 116 offline tests green. **v3.6.2 (this branch) = naming-engine + archive-warning review pass:** `makePostBaseName` collapses separators *after* sanitizing so a stripped token can no longer leave a double empty " - " gap in the post folder (`XMedia/nasa -  - 111` → `XMedia/nasa - 111`); `buildRunNotices` now counts "mixed media" only among kinds actually packed into the archive, so a photo+raw-video run (videos not opted into archives) no longer raises a false mix warning. Manifest 3.6.1 → 3.6.2; 117 offline tests. **Same-day CI follow-up (this branch):** `actions/checkout`/`setup-node` bumped `@v4`→`@v5` in both copies (v4 declared the `node20` runtime that runner images now force onto node24 with a deprecation warning; v5+ declare `node24` — upstream is already at v7, see IMPROVEMENT_LOG), `scripts/package-release.sh` no longer exits 141 on a SIGPIPE, CI's packaging assertion made glob-safe, and `releases/x-media-downloader-v3.6.1.zip` offline-verified (manifest at root, byte-identical to `extension/`, all references resolve). No `extension/` file changed, so the manifest stays 3.6.1. Still pending live-X: the v3.4 quote-card spot-check AND the v3.5–v3.6 (now also v3.6.1) output spot-check — WORKLIST P0 items 12 + 14 — plus the one browser click to Load unpacked the unzipped release zip. **v3.6.3 queue (this session, Tasks 1–5 of `WORKLIST.md`'s active queue — naming degarble + perf):** `sanitizeArtifactFilename` strips invisible bidi/format controls; `buildFallbackFilenames` last resort is now deterministic `x-media/download_<stem>.<ext>` (no random `media_<timestamp>`); `queueChanged` broadcasts are throttled (leading + one trailing per 250 ms) so a download's byte-delta ticks don't spam the Side Panel; a single `resolveTweetMedia(item)` is the ONE media resolver for both `getTweetMedia` and `mediaItemsFromTweetObject`; `injected.js` runs an early-exit `containsMediaMarker` object walk before `JSON.stringify` and bounds its replay buffer by BOTH count (40) and total bytes (~8 MB). **125 offline tests green** (+6). Manifest **3.6.2 → 3.6.3** and `releases/x-media-downloader-v3.6.3.zip` was cut + offline-verified (manifest at root, byte-identical to `extension/`). Tasks 6–7 stay holds pending live-jank evidence. **Post-cut review pass:** a diff re-review found `resolveTweetMedia`'s photo-extension fallback returned a garbage extension (`commediaabc`) for a bare CDN URL (no `format`, no file extension) while `content.js getPhotoExtension` returned `jpg` — the two extractors could name the same photo differently. Fixed via `photoExtensionFromUrl()` mirroring `getPhotoExtension` + 1 regression. **This re-edited `background.js` after the zip was cut — re-run `scripts/package-release.sh` before shipping.**

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

_Latest input (2026-09-03, fourth brief):_ the extension's own master folder
(`XMedia`) should contain **one folder per user** the media is sourced from —
`XMedia/<user>/<post name>/001.ext` — so all of a user's batch-archived media
lives together; different sources (home timeline, profile, `/media` page) of
the same user must land in the same folder (it doubles as dedupe); when a
folder is impossible (ZIP/CBZ/PDF archives) the username must at least appear
in the file name; and the **random file name problem goes on the work list as
pending review — do not mark it fixed until the user tests and confirms**.
Shipped in v3.11 (committed, NOT pushed/PR'd — pending the user's review of
the output); the random-name item stays OPEN/UNVERIFIED — see the WORKLIST P0
"v3.11 per-user folders + random-naming PENDING REVIEW" section.

_Previous input (2026-09-03, third brief):_ the file name still ended up as
"garbled random word and number text", and when that happened the same media
arrived twice under different names with **byte-identical content from the
same post URL** — implement **two verifications, byte identity and source URL,
to avoid duplications**. Shipped in v3.10 — see the 2026-09-03 v3.10
IMPROVEMENT_LOG entry.

_Earlier input (2026-09-01, second brief):_ review the v3.5 workflow commit
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
  They were kept separate on explicit past request — do not merge without a new
  decision. **v3.7 makes this question sharper:** a deep fetch now fills both
  lists in one gesture (scrolled media → Scroll capture, silently paged media →
  Remote fetch). The user chose the hybrid knowing that; if the split starts to
  feel arbitrary in live use, this is the moment to revisit it.
- ~~Are per-batch subfolders (e.g. `x-media/{username}/`) wanted?~~ —
  **answered by v3.11: yes, INSIDE the master folder** —
  `XMedia/<user>/<post name>/…` (the per-user folder is the owning post's
  author), with the old flat `<master>/<post name>/…` behind the
  `userFolders` toggle. Archives still cannot create folders (anchor path),
  but the username is now forced into the archive file name so user archives
  are still distinguishable; revisit the anchor-path limitation only if
  Chromium fixes the blob-filename bug that forced it.

---

## 1. Project and branch

- Repository: `freeforall1932-design/twitter-batch-download`
- Extension directory: `extension/` (the **Load unpacked** target)
- Working branch for this session: `arena/01a065c5-twitter-batch-download` (branched from `main` at `e4c8cf6`, the Firefox-port merge); the prior Arena sessions used `arena/01a064df-` (Firefox port) and `arena/01a06058-twitter-batch-download`
- Recent history:
  - **(v3.9, this branch)** — virtualization-proof capture:
    `harvestMutationArticles()` in the observer callback (addedNodes +
    removedNodes), `submitDomItems()` shared by harvest and scan, harvested
    video posts queued for the per-post resolve, and an honest response when
    a second concurrent rescan is refused. Plus 10 tests pinning the harvest
    and every dedupe layer. Manifest **3.9.0**, 150 tests.
  - **(v3.8, this branch)** — Rescan/restore: `forgetListedMedia()` (explicit
    actions only — automatic load/route passes stay incremental),
    `shallowFetchPass(reason, {fresh})`, async `startRescan()` answering with
    `rescanning: true` + a status-poll note, `rescanNote()` wording,
    cumulative `passCounters` with per-pass deltas, `lastRescan` in the status
    payload, `skippedDownloaded` through `mergeQueueItems` → `addQueueItems` →
    `queueAdd`/`localTimelineCapture`, and the panel's **Remove selected**
    button + rescan busy state. Manifest **3.8.0**, 140 tests.
  - **(v3.7, this branch)** — Fetch button + capture-robustness audit: automatic
    shallow fetch on tab open/route change, in-page `.xdl-fetch-dock`
    (Fetch/Stop/×) replacing the auto-scroll badge, deep fetch = shallow →
    auto-scroll → optional silent GraphQL fill via the existing discovery
    engine, Side Panel `Fetch media` / `Auto-scroll only` / `Rescan tab` /
    `Reload tab` + two switches, incremental MAIN-world replay (`seq`/`since`),
    run-token guards on every loop, `safeSend` always releases callers,
    staged-scan fix, video-resolve retry budget. Manifest **3.7.0**, 135 tests.
    `background.js` untouched — the feature rides the existing `discovery*`
    contract, so the Firefox port needed only the shared files re-synced.
  - **(Firefox port, `arena/01a064df-…`, merged as `e4c8cf6`)** — separate
    `firefox-extension/` MV2 folder: `sidebar_action`, `background.scripts`
    lib/* + background.js, MAIN-world injection via a `<script>` tag from
    content.js, `_executeScriptCompat`, no offscreen (worker data-URL fallback).
  - **(CI follow-up, no version bump)** — `actions/checkout` +
    `actions/setup-node` `@v4` → `@v5` in both CI copies (clears the node20
    deprecation warning), `scripts/package-release.sh` SIGPIPE fix (`sed`
    instead of `head`, so it stops exiting 141), glob-safe CI artifact
    assertion, and offline verification of the v3.6.1 release zip.
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
extension/                 # ← Load unpacked Chrome MV3 target (manifest.json at root)
                           #   v3.12: raw-only; v3.14 adds quality modes
extension/lib/             # naming.js / dedupe.js / gifEncoder.js / webpEncoder.js /
                           # apngEncoder.js — UMD, shared by worker, sidepanel, tests
extension/offscreen.html   # + offscreen.js: MP4→.gif / .webp / APNG conversion
                           # (chrome.runtime ONLY — re-added in v3.13, quality
                           # + chunked relay in v3.14, WebP in v3.15; no archive code)
source/archive-enabled/    # preserved pre-v3.12 archive-enabled implementation
                           # (NOT a Load-unpacked target): chrome-extension/ +
                           # firefox-extension/ with lib/archive|zipWriter|
                           # pdfBuilder.js and offscreen.* — the archive tests
                           # pin this variant (see its README)
firefox-extension/         # ← Firefox MV2 port: manifest v2, sidebar_action,
                           # background.scripts lib/* + background.js, MAIN-world
                           # injection via <script> tag, no offscreen (fallback)
                           # README.md explains deltas + install
tests/                     # background/content/naming/zip-writer/pdf-builder/
                           # gif-encoder/archive-lib/archive-background/
                           # downloader/media-kinds/injected/dedupe suites +
                           # helpers/load-background.js (extensionRoot option)
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
   and scroll normally, at any speed. Capture is always on; no button is
   pressed first. Since v3.9 posts that scroll *past* are captured on the way
   (the DOM's own mutation records are harvested, so a post X removes from the
   page before the next scan is still listed) instead of only the ones that
   linger.
3. Navigate **within the same tab** (profile → `/media` → post) and keep
   capturing, with no reload.
4. See media listed from X's own GraphQL responses and from visible DOM photos.
5. Optionally press **Fetch media** (on the page or in the panel) and let the
   extension do the scrolling: it reads the tab, scrolls the timeline to the end
   at the chosen speed, then — unless switched off — silently pages the same
   profile to pick up whatever X never rendered. **Auto-scroll only** is the
   scroll phase on its own; **Rescan tab** re-reads the view without moving the
   page. None of it ever blocks on downloads and there is no item cap.
   Since v3.7 step 2 alone already lists the first screenful of a freshly opened
   profile — the shallow fetch is automatic, the deep fetch is always a click.
6. Deletes rows they do not want (**×** per row, or tick + **Remove selected**),
   and presses **Rescan tab** whenever they want them back: since v3.8 an
   explicit rescan or fetch forgets what the tab already sent and re-lists the
   posts on screen. Rescan *is* the undo — there is no trash or remove-history.
7. Review the list, tick items or **Select all**, and press **Download selected**
   with **1 or 2** concurrent Chrome downloads. This is the *only* download
   action — a separate "Download all" was removed as redundant and confusing.
8. Use **Remote fetch** as the secondary/advanced tab: paste `@username` or a
   profile/`/media` URL and discover up to a local cap, default **99,999**.
   - The cap is an upper bound, not a target (690 media → completes at 690).
   - Local community cap only — not a third-party paid/free tier.
   - It can hit X rate limits sooner than human scrolling, so it is never the
     first impression.
9. Optionally include reposted media for Remote fetch. Quoted-post ("mentioned
   post" card) media is included **by default** in both tabs via the
   **Include quoted** switch (v3.4), listed with the quoted post's own
   attribution and a `quote` badge. Replies remain a future explicit option.
10. Use per-post action-bar buttons — **Download** (immediate) and
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
- `downloadedMediaIdsV1` (legacy) stores **queue item ids only** — no URLs, no
  post text. v3.10 keeps ids here in sync with `downloadedMediaRecordsV1`,
  which stores `{ id, mediaKey, url, urlKey, hash, size, filename, at }` — the
  canonical source URL and a SHA-256 of the saved bytes. Still no tokens, no
  post content.

---

## 4. Current architecture (v3.15.0)

**Fetch/rescan review note:** queue counts must be based on the worker's numeric `addedCount` acknowledgement. A missing response from an invalidated context is not an accepted row and must never be counted optimistically; content and worker dedupe remain separate layers.


**Output policy:** per-post ZIP/CBZ/PDF packaging is retired. Queue downloads are always separate files: photos force `name=orig`, and videos select the highest-bitrate MP4. The old archive-enabled implementation is preserved under `source/archive-enabled/`; it is not loaded or invoked by the shipped queue path, and its historical tests were retargeted to that source variant so they remain runnable (`tests/archive-background.test.js` + archive-lib/pdf-builder/zip-writer suites).


| File | Role |
|---|---|
| `manifest.json` | MV3, sidePanel, cookies/downloads/storage/scripting, **offscreen** (MP4→GIF/APNG conversion, re-added v3.13, quality modes v3.14). Content scripts: `injected.js` (MAIN, document_start) + `content.js` (isolated, document_start). Hosts: x.com / twitter.com / twimg CDN only. Version **3.15.0**. |
| `background.js` | Auth, GraphQL, source-tagged queue, remote discovery, downloads, capture bag, timeline response ingestion, downloaded-id history. Quoted-post media resolved from `quoted_status_result` (one level, soft-unwrap) with owning-post attribution. v3.5: output settings bag (`getOutputSettings`), download-time path building (`rawPathForItem`), per-post archive pass (`runArchivePass`) relayed to the offscreen document with a worker data-URL fallback. v3.6: `normalizePhotoUrl` forces `name=orig`; `isGif` identity; `prepareRawDownload` (GIF→.gif via offscreen, MP4 fallback); kind rules (`archivedKinds`/`effectiveGroupFormat`) and `buildRunNotices` warnings. v3.6.1: `shouldAbort` through `fetchWithRetry`/`sleepWithRateLimitCountdown` (Stop scan cancels backoff), catch-recovering storage save chains, `queueStart` resets the attempt budget, archive bytes delegated to `lib/archive.js`. v3.6.2: `buildRunNotices` counts "mixed media" only among kinds actually in the archive (photo+raw-video no longer warns). v3.6.3: `resolveTweetMedia(item)` is the ONE media resolver (orig photo + highest-bitrate MP4 + GIF flag + extension) used by BOTH `getTweetMedia` and `mediaItemsFromTweetObject` — they can no longer drift; `broadcastQueueChanged()` throttles `queueChanged` in both `saveQueueState` and `saveDiscoveryState`; `buildFallbackFilenames` last rung is deterministic `x-media/download_<stem>.<ext>` (no random timestamp). Post-cut review: `photoExtensionFromUrl()` mirrors `content.js getPhotoExtension` so `resolveTweetMedia` never emits a garbage extension for a bare CDN URL. **v3.10:** `downloadFile` verifies before saving — canonical source URL first (no network), then a streamed SHA-256 of the bytes (`computeMediaDigest`, 512 MB bound); a hit returns `{ success:true, skipped:true, reason:"duplicate_url"|"duplicate_bytes" }` and queues/saves skip the file (marks `completed · duplicate`); completion persists `downloadedMediaRecordsV1` with `{ id, mediaKey, url, urlKey, hash, size, filename, at }` (queue rows via `onChanged` + restart reconciliation, direct one-click saves via a pending-record map); `mergeQueueItems` adds the canonical URL as a third identity; archive pass skips already-verified groups and stores per-entry + archive digests; `verifyDuplicates` setting (default ON) gates byte verification (URL check stays; a failed digest falls back to direct download). **v3.11:** `rawPathForItem` adds the per-user segment for legacy rows (from `item.author`, never an "unknown" bucket) and passes `userFolders` through. **v3.12:** archive output retired — `queueStart` forces `state.outputFormat = "raw"` and no archive pass exists. **v3.13:** the dead archive section (`runArchivePass`, `buildArchiveInWorker`, `sendArchiveJobToOffscreen`, `archiveGroups`, `effectiveGroupFormat`, `archiveEntryExtension`, `archivedKinds`, `buildRunNotices`) was stripped from the shipped workers; the only archive-adjacent code left is the GIF/APNG offscreen relay (`ensureOffscreenDocument`/`sendOffscreenRequest`/`convertGifViaOffscreen`). The historical archive worker remains functionally in `source/archive-enabled/chrome-extension/background.js`. **v3.14:** `normalizeGifOutput` returns animated formats + mp4 (unknown → balanced `gif`); `prepareRawDownload` passes the mode through, chooses the right MIME + extension; `convertGifViaOffscreen(url, output)` runs the chunked relay (start → `totalChunks` → per-index `offscreenConvertGifChunk`, 60 s per chunk, 10-min conversion cap) and joins base64. **v3.15:** `webp` added; `ANIMATED_OUTPUT_FIDELITY = ["apng","webp","gif-max","gif"]` drives `convertFallbackChain(preferred)` and `prepareRawDownload` retries every animated format (MP4 only as the last resort). **No whole-batch ZIP.** |
| `lib/naming.js` | Shared naming engine (UMD → `XDLNaming`): `sanitizeArtifactFilename` (per-segment, from nh-dw), master-folder normalize (empty = off), format whitelist, template tokens/render/preview helpers, raw + archive path builders. v3.6.2: `makePostBaseName` re-collapses separators after sanitizing so a token whose content is stripped (e.g. text `"???"`) can't leave a double empty " - " gap. v3.6.3: `sanitizeArtifactFilename` also strips invisible bidi/format controls (U+200B/200E/200F/202A-202E/2066-2069/FEFF) while preserving visible non-ASCII (CJK/emoji/Arabic) so mixed-script/RTL post text no longer scrambles folder names. **v3.11:** `DEFAULT_USER_FOLDERS = true`; `userFolderName(fields)` (strips `@`, ONE sanitized segment — an odd handle can never create nested folders; empty handle → no user segment, never an "unknown" bucket); `baseNamesUser(base, user)` (case-insensitive exact or `"user "` prefix — avoids `nasa - nasa - …`); `buildRawMediaPath` → `<master>/<user>/<base>/NNN.ext` unless `userFolders === false`; `buildArchiveFilename` forces the username into the name when the template omits it (`{id}` → `nasa - 111.cbz`). |
| `lib/dedupe.js` | v3.10: shared duplicate-verification engine (UMD → `XDLDedupe`) — pure-JS **incremental** SHA-256 (`Sha256`, chunked, no `crypto.subtle`, runs in worker/offscreen/Node/VM), `canonicalSourceUrl` (scheme+host+path, delivery query params stripped), `mergeRecords`, `duplicateNote`. Loaded by background.js and tests (the v3.15 offscreen document is conversion-only and does not need it). |
| `lib/zipWriter.js` | STORE-only ZIP writer (`XDLZip`) for per-post archives — local re-implementation instead of JSZip (no-npm guardrail). **Preserved source variant only** (`source/archive-enabled/chrome-extension/lib/`). |
| `lib/pdfBuilder.js` | Dependency-free PDF 1.4 writer (`XDLPdf`), ported verbatim from nh-dw `pdfBuilder.ts` (JPEG DCTDecode verbatim, byte-exact xref). **Preserved source variant only.** |
| `lib/gifEncoder.js` | v3.6: dependency-free streaming GIF89a encoder (`XDLGif`) — median-cut global palette, spec-timed LZW, NETSCAPE loop. Round-trip-verified by a decoder in its test suite. (_Shipped_ — still used for the raw GIF conversion path when an offscreen document is available.) |
| `lib/archive.js` | v3.6.1: shared archive plumbing (`XDLArchive`) — `fetchImageBytes`, `preparePdfImage`, `bytesToBase64`, `buildArchiveBytes` (ZIP/CBZ/PDF bytes + MIME). ONE copy used by the worker fallback AND the offscreen document (they previously duplicated ~120 lines and could drift); no chrome API, runs in both contexts and Node. **Preserved source variant only.** |
| `offscreen.html/js` | **Shipped (v3.15):** converts X's MP4 "GIF" clips through `<video>`+canvas into real .gif bytes (balanced: 12 fps/≤720 px/global palette/≤40 MB; `gif-max`: 25 fps/≤1920 px/per-frame local palettes + Floyd–Steinberg/≤256 MB), an animated WebP (`lib/webpEncoder.js` wraps `canvas.toBlob("image/webp")` frames into VP8X/ANIM/ANMF; true color, 25 fps/≤1920 px/≤256 MB) or a true-color APNG (`lib/apngEncoder.js`, full RGBA, same caps). Bytes return chunked (`offscreenConvertGif { job:{url,output,jobId} } → {ok,jobId,totalChunks}`, then `offscreenConvertGifChunk {jobId,index} → {ok,base64,index,last}`, 3 MB binary chunks, 15-min job TTL; legacy one-shot `{ok,base64}` kept when no jobId). Handles ONLY those two messages; exposes ONLY `chrome.runtime`; data: URLs keep the master-folder subpath. **Preserved variant (archive-enabled):** also assembled ZIP/CBZ/PDF blobs and saved them via an in-document `<a download>` anchor — kept under `source/archive-enabled/`, not shipped. |
| `injected.js` | MAIN-world XHR/fetch observer. Forwards **any** media-bearing GraphQL response (no operation allowlist), keeps a replay buffer bounded by BOTH count (40) and total serialized bytes (~8 MB), runs an early-exit `containsMediaMarker` object walk before any `JSON.stringify` (non-media payloads are never serialized across worlds), and watches SPA route changes via `pushState`/`replaceState`/`popstate`. The allowlist survives only for Remote-fetch *request metadata*. v3.7: every buffered entry carries a monotonic `seq`, and `xdlRequestReplay {since}` makes `replayAll(since)` send only what the isolated world has not handled yet (`xdlReplayDone` reports `{count, lastSeq}`) — a caller that sends no cursor still gets everything, so the two worlds can never be version-locked. |
| `content.js` | **Always-on** scroll capture (no watch command), SPA route re-arm, DOM photo listing, rate-bounded per-post video resolve (quote-card media resolved through the outer post id), content-driven auto-scroll with in-page badge, action-bar `Download` + `Add to queue`, toasts. v3.5: items carry `text`/`displayName`/`mediaIndex`; `downloadFile` sends the owning item. v3.6: one shared `mediaEntryToItem()` builder (scroll resolver + action bar), `isGif` flag. v3.6.2: `getDisplayName` reads the author's display name from `[data-testid="User-Name"]` so DOM-scanned photos carry `{name}` like GraphQL items. **v3.7: the fetch engine** — `shallowFetchPass()` (replay + rescan + awaited video resolve) runs on load (`armLoadFetch()` at 900/2200/4000 ms) and on every route change; `startDeepFetch()` chains shallow → `autoScrollLoop()` → `runRemoteFill()` (sends `discoveryStart`/`discoveryGet`/`discoveryStop` for the profile in the URL); `.xdl-fetch-dock` is the single in-page widget (Fetch media ↔ Stop, phase label, ×); `stopCapture()` + per-run tokens (`autoScrollRunId`/`deepFetchRunId`) make Stop authoritative; `safeSend` always calls back and `sendMessage` is time-bounded; `scheduleScanAt()` gives staged passes that the coalescing `scheduleScan()` used to drop. **v3.8:** `forgetListedMedia()` clears the dedupe sets *and* `lastReplaySeq` — called only by `startRescan()` and by `shallowFetchPass("deep", {fresh:true})`; `shallowFetchPass` reports per-pass deltas of the cumulative `passCounters`; `statusPayload` gained `rescanning`, `lastPass`, `lastRescan`. **v3.9:** the
MutationObserver callback runs `harvestMutationArticles(mutations)` *before*
`scheduleScan(150)` — it collects `article[data-testid="tweet"]` from both
`addedNodes` and `removedNodes` (walking containers, skipping non-elements) and
submits through `submitDomItems()`, the path it now shares with
`scanVisibleMedia()`. Capture therefore no longer depends on a post still being
in the document when a scan happens to run. |
| `sidepanel.html/js/css` | Two-tab Side Panel: Scroll capture + Remote fetch. One download action, live active-tab status pill, per-row remove, skip-already-downloaded toggle, **Include quoted** switches, `Clear finished` / `Reset downloaded history` buttons. v3.5: **Output settings** card (master folder, name-template checkboxes + live preview + custom-template input — the ONLY writer of the sync output settings) and the `gif` badge. **v3.8:** `Remove selected` next to `Download selected` (confirm-guarded, sends `queueRemove {ids}`), a `Re-listing this tab` pill state, and a busy state that disables Fetch/Auto-scroll/Rescan during a rescan while leaving **Stop** disabled (nothing to cancel). **v3.7 Scroll card:** `Fetch media` (deep fetch), `Stop`, `Auto-scroll only`, `Rescan tab`, the **Then fetch the rest silently** (`deepFetchRemote`) and **Show the Fetch button on X pages** (`showFetchButton`) switches, a `Reload tab` button that appears in the status pill when the active X tab has no live content script, and a status pill that names the fetch phase. **v3.11:** `One folder per user (XMedia/<user>/…)` checkbox in the Output settings card (default checked, syncs `userFolders`) and re-renders the live name preview (`Downloads/XMedia/nasa/<post>/001.jpg`) on change. **v3.13:** the archive machinery was removed (default-format/job-format picks, archive preview branch, `queueNotices` box + CSS); the GIF select is now actually wired to `storage.sync.gifOutput` (Chrome), and the format picker/notices are gone since output is always separate files. **v3.14/v3.15:** the select offers balanced GIF / `gif-max` / `webp` / `apng` / MP4 (default balanced), persisted via `storage.sync`; the hint explains the quality-vs-size trade-off AND the fallback order (APNG → WebP → max GIF → GIF → MP4); Firefox copy stays byte-identical. |
| `popup.html/js` | Side Panel launcher + capture status line. No scroll/download loop. |
| `tests/` | `background.test.js`, `content.test.js`, plus v3.5: `naming.test.js`, `downloader.test.js` (real v3.13 worker in a VM — **raw-mode** master folder/name-template paths + stale-format regression), v3.6: `gif-encoder.test.js` (round-trip decoder) + `media-kinds.test.js` (quality, GIF identity, raw-GIF conversion via offscreen), v3.6.1: `archive-lib.test.js` (shared-engine byte parity) + 4 background regressions (abort on Stop, `stopped` classification, attempt-budget reset, storage-write recovery), v3.6.3: `injected.test.js` (media-marker walk + replay-buffer bound) + 4 background/naming regressions (deterministic fallback, `queueChanged` throttle, shared `resolveTweetMedia` rules, path agreement), `helpers/load-background.js` (gains `extensionRoot` for the archive worker). **v3.12 follow-up:** `zip-writer.test.js`/`pdf-builder.test.js`/`archive-lib.test.js` import `source/archive-enabled/chrome-extension/lib/*` and `archive-background.test.js` pins the preserved archive worker (archive pipelines, kind rules, warnings, archive-group dedupe). **v3.13:** the two archive-specific tests that were in shipped-worker suites moved to `archive-background.test.js`; shipped suites keep raw-mode + GIF conversion coverage only (169 total). **v3.14:** new `apng-encoder.test.js` (6 tests — per-chunk CRC, fcTL/fdAT sequence checks, zlib inflate, byte-exact true-color gradient, acTL count+CRC patch, CRC vector), 4 max-quality GIF tests (local palettes, dither pattern, LZW growth, solid-frame exactness) and media-kinds chunked-relay/`gif-max`/`apng`/chunk-failure/normalize tests. **v3.15:** `webp-encoder.test.js` (7 tests — RIFF/VP8X/ANIM/ANMF structure + exact durations/frames, alpha propagation, VP8L path, real reference-encoded fixture, rejection guards) and media-kinds webp conversion / fallback-chain tests; full suite **194 / 0 fail**. |

### Post-v3.11 review note

The per-user path must treat a missing owning author as no user segment, never as a literal `unknown` folder. `namingFieldsForItem()` and the legacy-row path both preserve that distinction; `unknown` remains valid only for unrelated discovery/error or legacy filename fallback labels.

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
17. **`queueChanged` broadcasts are throttled.** (v3.6.3.) `saveQueueState()`
   fires on every queue mutation AND on every `chrome.downloads.onChanged`
   byte-delta tick, so a long multi-file run could post dozens of
   `queueChanged` messages a second and force a full `sidepanel.refresh()`
   each time. `broadcastQueueChanged()` emits on the leading edge and folds
   a burst into ONE trailing emit per 250 ms (the Side Panel just re-reads
   the freshest state — the message carries no payload). Do not revert to a
   raw `sendMessage({action:"queueChanged"})` per save.
18. **One media resolver for both extraction paths.** (v3.6.3.)
   `resolveTweetMedia(item)` is the single source for CDN URL selection
   (photo forced to `orig`, video to the highest-bitrate MP4), the media
   kind/extension, and the GIF flag. `getTweetMedia`'s per-post path and
   `mediaItemsFromTweetObject`'s timeline path both call it — they previously
   re-implemented the same rules and could drift silently. Do not inline the
   variant/photo-normalization logic back into either caller.
19. **Shallow fetch is automatic; deep fetch is always a click.** (v3.7, the
   user's explicit choice.) A shallow pass — replay buffered GraphQL, rescan the
   rendered DOM, resolve pending video posts — moves nothing on the page, so it
   is safe to run on every tab open and route change. The deep fetch scrolls the
   user's viewport and can trigger an extra remote crawl, so it must never start
   by itself. Do not "improve" this by auto-starting the scroll.
20. **One in-page widget.** (v3.7.) `.xdl-fetch-dock` absorbed the
   auto-scroll-only badge: one dock starts a fetch, shows the phase, and stops
   it. Two floating widgets in the same corner is what the merge ended. A
   *running* fetch always renders the dock even when `showFetchButton` is off —
   hiding Stop while the extension scrolls someone's page is not an option.
21. **The deep fetch's silent fill reuses the discovery engine, and its rows go
   to the Remote fetch list.** (v3.7.) X has no paginated HTML to crawl (the
   sister repo `rule34video`'s `fetchPage` crawler scrapes listing pages /
   POSTs a JSON search API — neither exists here), so the fill sends the panel's
   own `discoveryStart` with the handle from the URL. Items are tagged
   `source: "remote"` and stay in that tab's list: the two lists remain
   separate by standing decision, and the note says where to look. `background.js`
   needed no change at all.
22. **Every loop is run-token guarded, and `safeSend` always releases its
   caller.** (v3.7.) Shared booleans (`autoScrollRunning`) cannot express
   "this specific run was stopped": a Stop followed by a restart let the old
   loop re-read the new run's `true` and keep scrolling. `autoScrollRunId` /
   `deepFetchRunId` (mirroring the worker's `discoveryRunSerial`) invalidate a
   superseded run, which then returns without touching shared state. Likewise an
   invalidated extension context must still invoke the callback, or awaiting
   callers hang forever — that single `return` is what made a tab look dead
   until the user reloaded the page.
23. **Replays are incremental.** (v3.7.) Shallow passes made replays frequent,
   and each one used to structured-clone up to ~8 MB of buffered GraphQL across
   worlds. Entries carry `seq`, the content script remembers `lastReplaySeq`,
   and `xdlRequestReplay {since}` limits the answer. Keep the no-cursor path
   working (full replay) so the two worlds are never version-locked.
24. **Automatic passes are incremental; explicit clicks start clean.** (v3.8.)
    The per-tab "already listed" memory exists so a scan on every DOM mutation
    does not re-post the whole timeline — it is a performance guard, and it must
    stay one. `forgetListedMedia()` is therefore reachable *only* from
    `startRescan()` and the first phase of a deep fetch. Clearing it from a load
    or route-change pass would re-clone the entire replay buffer on every
    mutation tick. This is also why the v3.7 incremental-replay test now drives a
    *route change*: asserting the property through `scrollRescan` would pin the
    wrong behaviour.
25. **A no-op must still say why.** (v3.8.) `mergeQueueItems` returns
    `{added, skippedDownloaded}` because "nothing came back" has two very
    different causes — *already in your list* (fine) and *held back by Skip
    already downloaded* (a setting the user can change) — and silence after a
    click reads as a broken button. Per-pass numbers come from **cumulative
    counters with start/end deltas**, never from a shared object a pass zeroes:
    an `armLoadFetch()` timer landing inside a rescan's `await` wiped the first
    implementation's tally and made a successful rescan report "nothing new".
    For the same reason a rescan records its outcome in `lastRescan`, not
    `lastPass` (which honestly means "whatever pass ran most recently").
26. **Capture must not depend on a node still being in the document.** (v3.9.)
    X virtualizes its timeline, so an article can be inserted and removed
    between two scans — and a scan-only strategy then loses it silently
    (measured: ~60% of media on a fast scroll). The mutation record still holds
    the node, so `harvestMutationArticles()` reads `addedNodes` (earlier than any
    scan) *and* `removedNodes` (the last chance, and the only way to catch a
    same-task insert+trim). Keep the scan as well: it covers everything already
    in the DOM when the observer attaches, which at `document_start` is nothing
    but after an extension reload is the whole view.
    Corollary worth repeating because it nearly produced a wrong fix: **when a
    measurement looks wrong, suspect the fixture before the product.** Two harness
    artifacts (a tweet id past `Number.MAX_SAFE_INTEGER`, and a fake video URL
    with an identical leaf for every post) made video dedupe look lossy; the
    tempting "fix" — dropping the media key for videos — would have listed
    every reposted and quoted video twice.

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
- The auto-scroll-only in-page badge (`.xdl-autoscroll-badge` +
  `showAutoScrollBadge`/`updateAutoScrollBadge`/`hideAutoScrollBadge`) — folded
  into `.xdl-fetch-dock` in v3.7 (decision 20).
- A separate `scrollFetchStop` command: `scrollStop` stops both engines, and the
  contract test now fails on any content.js handler with no sender.
- A shared per-pass tally object that each pass zeroes at its start (v3.8) —
  overlapping passes are normal, and an automatic pass landing inside a rescan's
  `await` made a successful rescan report "nothing new". Use the cumulative
  `passCounters` + start/end delta, and `lastRescan` for a rescan's own outcome.
- Scan-only capture (pre-v3.9) — reading the live DOM assumes a post stays
  rendered long enough to be seen. Keep the mutation harvest in front of the scan.
- A permanent "already sent" memory with no way to clear it (pre-v3.8). It is a
  performance guard, not a correctness rule — the worker dedupes on its side, so
  re-sending is always safe. Do not reintroduce a set that outlives the user's
  intent to re-list.
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
contract test in `tests/background.test.js`, which since v3.7 checks
**`content.js` handlers too** — add a command → add a sender, or the suite
fails. The old `scrollRescan` exception is gone: v3.7 gave it a real
**Rescan tab** button._

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

**Worker → offscreen (v3.14, shipped conversion document):**
`offscreenConvertGif` `{ job: { url, output, jobId } }` → `{ ok, jobId,
totalChunks }` / `{ ok: false, error }`; the worker then pulls each chunk
with `offscreenConvertGifChunk { jobId, index }` → `{ ok, base64, index,
last }` (3 MB binaries, ~4 MB base64 per message, 15-min job TTL). A
no-jobId call keeps the v3.13 one-shot `{ ok, base64 }` reply.
`offscreenBuildArchive` exists only in the preserved
`source/archive-enabled/` variant and is pinned by
`tests/archive-background.test.js`. Chrome: GIF/APNG conversion runs (no
offscreen API → MP4 kept). Firefox port: no `chrome.offscreen`, so MP4 kept.

**Side Panel → content script:** `scrollSettings` (carries `includeQuoted`,
and v3.7's `deepFetchRemote` / `showFetchButton`), `scrollStart` (auto-scroll
only), `scrollFetch` (**v3.7** deep fetch: shallow → scroll → silent fill;
accepts the same settings bag), `scrollStop` (**one** stop for both engines),
`scrollStatus` (v3.7 adds `fetching`, `fetchPhase`, `fetchNote`, `fetchTarget`,
`deepFetchRemote`, `showFetchButton`, `dockHidden`, `scans`; v3.8 adds
`rescanning`, `lastPass`, `lastRescan`), `scrollRescan` (shallow pass only — now
sent by the panel's **Rescan tab**, and since v3.8 from a **clean slate**: it
answers immediately with `rescanning: true` and the panel's 1.5 s poll picks up
the completion note).

**Side Panel → worker (v3.8):** `queueRemove` takes either `{id}` or `{ids:[…]}`
— the array form existed in the worker all along and finally has a sender
(**Remove selected**). Responses to `queueAdd` / `localTimelineCapture` now carry
`skippedDownloaded` alongside `addedCount`; `mergeQueueItems` returns
`{added, skippedDownloaded}` instead of a bare count.

**Content script → worker (v3.7):** the deep fetch's silent fill sends the
*existing* `discoveryStart` / `discoveryGet` / `discoveryStop` from a content
script, not just from the panel. The worker does not care who asks; the run is
shared, so the Remote fetch tab shows the same progress and its Stop cancels the
same run.

**MAIN ↔ isolated world (`window.postMessage`):**
`XDL_INJECTED` → `xdlInjectedReady`, `xdlNetworkCapture`, `xdlGraphqlResponse`
(v3.7: each entry carries a monotonic `seq`), `xdlUrlChanged`, `xdlReplayDone`
(`{count, lastSeq}`); `XDL_CONTENT` → `xdlRequestReplay` (v3.7: `{since}` —
replay only entries with `seq > since`; absent/0 means all)

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
`downloadedMediaIdsV1` (completed item ids only, capped at 20k, local) and
(v3.10) `downloadedMediaRecordsV1` (same cap, local — `{ id, mediaKey, url,
urlKey, hash, size, filename, at }` for byte + source-URL verification), plus UI prefs
(local) `sidePanelActiveTab`, `scrollMediaFilter`, `scrollSpeed`, `skipDownloaded`,
`scrollIncludeQuoted`, `batchTarget`, `batchLimit`, `includeRetweets`,
`includeQuoted`, and (v3.7) `deepFetchRemote` (default `true` — run the silent
GraphQL fill after the scroll) and `showFetchButton` (default `true` — render the
in-page dock). Both are written by the Side Panel's Scroll card and read by
`content.js` at `document_start`, so a tab opened with the panel closed still
honors them.

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
- **Capture completeness (v3.9, WORKLIST P0 item 18)** — the highest-value live
  check in the repo right now: run a **fast** auto-scroll or **Fetch media** on a
  long profile and compare the panel's row count with the post count X shows on
  that profile's `/media` tab (before v3.9 a fast pass dropped ~60% of the media).
  Also confirm posts scrolled *past* quickly are listed, video posts from those
  sections resolve, no skeleton/placeholder article is listed as media, CPU stays
  sane on a 1000-post scroll, and nothing is duplicated when the same post arrives
  from the DOM *and* a GraphQL capture.
- **Rescan / restore (v3.8, WORKLIST P0 item 17)** — never run in a browser:
  delete rows then press **Rescan tab** and confirm they return with a count in
  the hint; confirm a post X has virtualized out of the DOM still comes back
  while it is inside the replay buffer (40 entries / ~8 MB) and note where that
  boundary actually lands; confirm a rescan with nothing deleted says
  `nothing new … unchanged` and creates no duplicates; confirm the
  already-downloaded wording and that unticking **Skip already downloaded** (or
  **Reset downloaded history**) lets those rows list; confirm **Rescan** during a
  running fetch is refused rather than racing the scroll loop; confirm **Remove
  selected** removes exactly the ticked rows of the *active* list only.
- **Fetch button (v3.7, WORKLIST P0 item 16)** — never run in a browser: a new
  tab opened straight onto a profile must list its first screenful with no
  scrolling and no reload; the in-page dock must walk
  `Reading this view → Scrolling the timeline → Silently fetching @handle` with
  its button reading **Stop**; Stop mid-scroll and mid-fill must halt at once and
  report a clean stop in the Remote fetch tab; the silent fill's rows must land
  **only** in the Remote fetch list, deduped against the scrolled ones; both new
  switches and the dock's × must behave; `/home` and a single post must skip the
  fill with a note rather than an error; and after an extension reload on an
  already-open tab the panel must offer **Reload tab** and video resolve must
  work again afterwards.
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
  per-post ZIP/CBZ/PDF (≤4 images of ONE post) was the explicitly decided
  exception and had to stay per-post; it was **retired in v3.12** and now
  lives only in `source/archive-enabled/` — if it is ever revived it must
  stay per-post and remain pinned by the archive test suites.
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
node --test tests/*.test.js            # 169 tests (archive suites pin source/archive-enabled/)
scripts/package-release.sh             # → releases/x-media-downloader-v<version>.zip
```

`tests/content.test.js` runs the real `content.js` inside a DOM + `chrome` shim
and encodes each reported live failure as a regression test (homepage capture,
in-tab route change, duplicate suppression, capture filter, auto-scroll
lifecycle, and since v3.7: the fresh-tab shallow fetch, the staged-scan count,
incremental replay, the in-page dock's click/switch/× behaviour, the panel's
`scrollFetch`/`scrollStop`/`scrollRescan`, and recovery from an invalidated
extension context — that last one was verified to fail against the old
`safeSend` before it was kept — and since v3.8: rescan re-listing deleted rows,
rescan re-asking for the whole replay buffer, Fetch starting from a clean slate,
and the two rescan outcome notes — and since v3.9: a post that leaves the DOM
before any scan, a post inserted and removed in the same task, harvesting the same
post twice, a container of articles plus a text node, a harvested video post
reaching its resolve, the same photo at different `name=` sizes, repeated rescans,
multi-row `queueRemove`, the `skippedDownloaded` reason, and one row across the
scroll and remote lists). The shim grew three backwards-compatible
capabilities for it: element listeners are recorded and dispatchable
(`el.emit("click")`), `dataset` is a real proxy over `data-*` attributes, and
`runTimeouts(rounds)` drives delayed passes; `loadContentScript({href})` can
start on a profile URL, and `setQueueResponder(fn)` lets a test stand in for the
worker's dedupe/skip decision (`addedCount: 0` + `skippedDownloaded`) instead of
the optimistic "takes everything" default; since v3.9 its elements carry
`nodeType: 1`, `matches()` and `remove()`, and `emitMutations(records)` delivers
`{addedNodes, removedNodes}` to every observing MutationObserver — the harvest path
reads all four. `tests/downloader.test.js` runs the real v3.13 `background.js`
(plus the real `lib/` files via a working `importScripts`) in a window-less VM
and covers the **raw-mode** output pipeline — master folder on/custom/off/weird,
per-user folders, template-driven names, and the stale-format guard. Since
v3.12 the archive pipelines live in `tests/archive-background.test.js`, which
points `loadBackground` at `source/archive-enabled/chrome-extension` and pins
the preserved archive worker: ZIP/CBZ/PDF end-to-end through the data-URL
fallback with byte-level archive assertions, the offscreen job relay,
media-kind rules, warnings, toggles and the archive-group dedupe skip.
`media-kinds.test.js` (v3.6) covers quality forcing, GIF identity and the
raw-GIF conversion paths (now against the v3.13 GIF-only offscreen relay);
`gif-encoder.test.js` round-trips encoded GIFs (balanced + max-quality)
and `apng-encoder.test.js` round-trips true-color APNGs
through a real decoder. **Extend these rather than testing by hand** — every
future capture or output bug should land as a failing test first.

CI is LIVE: `.github/workflows/extension-tests.yml` is installed and runs
green on GitHub (installed via the web UI on 2026-09-01 — the Arena GitHub
App has historically lacked the `workflows` scope to push it, so if a push
touching `.github/workflows/` is rejected, keep `docs/ci/extension-tests.yml`
updated and hand the user the paste-ready diff). `docs/ci/extension-tests.yml`
remains the byte-identical reference copy — verify with `diff` after every
workflow edit (both were cleaned together on 2026-09-02 for v3.6.1, and both
were bumped together in this branch's CI follow-up; edit one and `cp` it over
the other rather than hand-editing twice). It runs
the offline set plus a packaging smoke and deliberately has NO real-browser
job (§7).

Two CI/packaging gotchas the 2026-09-02 follow-up fixed — do not reintroduce
either:

- `scripts/package-release.sh` runs under `set -euo pipefail`. Its closing
  `unzip -l "$OUT" | sed -n '1,15p'` must stay a full-draining reader: with
  `head -n 15` the pipe closes early, `unzip` dies of SIGPIPE, and the script
  exits **141** despite having written a correct zip (reproduced 5/5).
- The artifact assertion must stay glob-safe (`shopt -s nullglob` +
  `test "${#zips[@]}" -gt 0`). A plain `test -f releases/*.zip` fails with
  `binary operator expected` as soon as a second zip exists in `releases/`.

Actions are pinned to `@v5` because v4 declared the `node20` runtime that
runner images now force onto node24 with a deprecation warning. Upstream is
already at `checkout@v7.0.1` / `setup-node@v7.0.0` (both `node24`); the bump
was deliberately left at v5 as requested — read the IMPROVEMENT_LOG note
before jumping majors.

---

## 9. Next session priorities

1. **Live spot-check v3.9's capture completeness first** — WORKLIST P0 item 18.
   Fast-scroll a long profile and compare the panel's count against the profile's
   `/media` post count. This is the change with the largest measured effect (~60%
   of media was being dropped on a fast pass) and it is judgeable in one scroll.
2. **Then v3.8's Rescan/restore** — WORKLIST P0 item 17. It is
   the newest code and the fastest to judge: list a profile, delete a few rows,
   press **Rescan tab**, watch them come back with a count. Then tick rows and
   press **Remove selected**. If a rescan reports "nothing new" when the user
   expected rows, the note should already say whether **Skip already downloaded**
   is the cause.
3. **Then live spot-check v3.7's Fetch button** — WORKLIST P0 item 16 (the
   list above). It is the newest code, it is the only part that moves the user's
   page, and it is the one thing that can be judged in under a minute: open a
   profile in a new tab, watch it list itself, press **Fetch media**, press
   **Stop**. If the silent fill trips a rate limit on a big profile, the answer
   is the **Then fetch the rest silently** switch, not removing the phase.
4. **Then live spot-check v3.4 + v3.5 + v3.6 + v3.6.1** — WORKLIST P0 items 12 and 14.
   Reload `extension/` unpacked (manifest 3.6.3, "ask where to save" OFF),
   then: the quote-card case (item 12), a 4-photo post in raw mode
   (`Downloads/XMedia/<post name>/001…004.jpg`), the empty-master-folder
   rollback, one ZIP + one CBZ + one PDF from the same post (contents,
   order, names, PDF orientation), the `{text}` checkbox → preview + real
   names, the dock picker not persisting — plus the v3.6 list in item 14:
   real `.gif` output (and the `.mp4` switch), mixed-post PDF→ZIP with the
   amber warning, opt-in video zipping with its warning, `orig`-quality
   re-download. If an archive still saves under a UUID, capture the Chrome
   version — that is the blob-filename bug the anchor mechanism dodges.
5. **Cut the first release zip** — `scripts/package-release.sh` →
   `releases/x-media-downloader-v3.9.0.zip` is **cut and offline-verified**
   (v3.6.1/v3.6.3/v3.7.0/v3.8.0 before it were too)
   (2026-09-02): `manifest.json` at the zip root, `diff -r` byte-identical to
   `extension/`, and all 23 manifest-declared + runtime-resolved resources
   present (`lib/*`, `offscreen.*`, every `importScripts`/`<script src>`
   target). What is left of this item is **one browser click**: unzip the file
   and Load unpacked the folder. Optionally start `CHANGELOG.md`. With that
   plus item 1, P0 is complete. (The v3.6.1 `ci` packaging smoke also passed —
   `lib/archive.js` is in the zip; that CI artifact was deleted.)
6. P1 afterwards: Side Panel diagnostics + sanitized copy-debug-report,
   explicit Include replies switch (quoted shipped in v3.4). Name templates
   shipped in v3.5; highest-bitrate video is guaranteed since v3.6.
7. Settled decisions that stay settled: separate scroll/remote lists (do not
   merge without a new user decision), one download action, no whole-batch
   ZIP (per-post archives only), no reply capture until it has its own
   switch, offscreen documents = chrome.runtime only, blob saves via the
   in-document anchor, PDF photos-only (GIF/video archive entries force
   ZIP), GIF failures fall back to MP4 — never a failed item, and (v3.7)
   decisions 19–26: shallow automatic / deep on click, one in-page dock, the
   silent fill reuses discovery and lands in the Remote list, run tokens on
   every loop, incremental replays, automatic-incremental vs
   explicit-clean-slate, every no-op reporting its reason, and capture that never
   depends on a node still being in the document.
8. Before finishing: update all three docs (log entry, worklist statuses,
   this file).
