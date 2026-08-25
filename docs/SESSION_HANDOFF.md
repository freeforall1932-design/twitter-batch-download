# Session Handoff — X Media Downloader

**Prepared:** 2026-08-26 · **Extension version:** 3.4 · **Status:** v3.4 = v3.3 + quoted-post ("mentioned post" card) media capture with per-tab **Include quoted** switches. Round-3 live test of v3.3 passed the core flows (capture, dedupe, queue, UI); quote card was the one gap — awaiting a live spot-check of the quote case.

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

_Latest input (2026-08-26, live round-3 result):_ all functions work, no
double entries, UI/UX already decent for deployment — but media inside a
**quoted ("mentioned") post card** (the small box with thumbnail + text shown
on a GIF/video reaction post) was never fetched. The user asked whether it is
impossible and pointed at the scrapyard + community GitHub. **Resolved in
v3.4** — it was never impossible: the quoted post's full payload sits under
`legacy.quoted_status_result` in the same GraphQL response (Rank S and Rank B
both parse it); this repo deliberately skipped it pending an explicit option.
Quoted media now lists by default with correct attribution, an `isQuote` flag,
and per-tab **Include quoted** switches. Still to live-check: item 12 of the
P0 round-3 checklist in `docs/WORKLIST.md`.

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
- Are per-batch subfolders (e.g. `x-media/{username}/`) wanted? Rank A does this.

---

## 1. Project and branch

- Repository: `freeforall1932-design/twitter-batch-download`
- Extension directory: `extension/` (the **Load unpacked** target)
- Working branch for the last Arena session: `arena/01a03ae9-twitter-batch-download`
- Recent history:
  - **(v3.4, this branch)** — Quoted-post ("mentioned post" card) media
    capture: quote parsing in `mediaFromTweet`/`getTweetMedia` with
    quoted-post attribution, `isQuote` flag + `quote` badge, per-tab
    **Include quoted** switches (default on), 7 new tests; plus the
    post-interrupt review pass (repost `rest_id` fallback restored,
    README updated, seams documented) — commits `08e68d0` + `b943a84`
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
tests/                     # background.test.js (unit) + content.test.js (DOM sim)
scripts/package-release.sh # zip extension/ → releases/x-media-downloader-v<version>.zip
releases/                  # generated zips (gitignored)
docs/                      # WORKLIST.md, SESSION_HANDOFF.md, IMPROVEMENT_LOG.md,
                           # PROJECT_IMPROVEMENT_OPINION.md
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

## 4. Current architecture (v3.4)

| File | Role |
|---|---|
| `manifest.json` | MV3, sidePanel, cookies/downloads/storage/scripting. Content scripts: `injected.js` (MAIN, document_start) + `content.js` (isolated, document_start). Hosts: x.com / twitter.com / twimg CDN only. |
| `background.js` | Auth, GraphQL, source-tagged queue, remote discovery, downloads, capture bag, timeline response ingestion, downloaded-id history. Quoted-post media resolved from `quoted_status_result` (one level, soft-unwrap) with owning-post attribution. **No ZIP.** |
| `injected.js` | MAIN-world XHR/fetch observer. Forwards **any** media-bearing GraphQL response (no operation allowlist), keeps a 40-entry replay buffer, and watches SPA route changes via `pushState`/`replaceState`/`popstate`. The allowlist survives only for Remote-fetch *request metadata*. |
| `content.js` | **Always-on** scroll capture (no watch command), SPA route re-arm, DOM photo listing, rate-bounded per-post video resolve (quote-card media resolved through the outer post id), content-driven auto-scroll with in-page badge, action-bar `Download` + `Add to queue`, toasts. |
| `sidepanel.html/js/css` | Two-tab Side Panel: Scroll capture + Remote fetch. One download action, live active-tab status pill, per-row remove, skip-already-downloaded toggle, **Include quoted** switches in both tabs (default on) with a `quote` row badge, plus `Clear finished` / `Reset downloaded history` maintenance buttons (wired in the round-3 review; the handlers existed but nothing sent them). |
| `popup.html/js` | Side Panel launcher + capture status line. No scroll/download loop. |
| `tests/` | `background.test.js` (Node VM unit tests + sanitized fixtures) and `content.test.js` (real `content.js` in a DOM + `chrome` shim). |

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

### Removed / deprecated — do not reintroduce without a product decision

- `lib/zip-writer.js` and all ZIP assembly (`downloadZip`, `fetchAsArrayBuffer`,
  `zipBuffers`, `importScripts` of zip-writer).
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
`queueSelectVisible`, `queueSetConcurrency`, `queueStart`, `queueStop`,
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
its owning post's `username` / `tweetId` / `text` / `isQuote`), `downloadFile`

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
  filename,           // x-media/{user}_{text}_{tweetId}_{index}.{ext}
  selected, status,   // discovered|queued|starting|downloading|completed|failed
  attempts, bytesReceived, totalBytes, downloadId?, error?
}
```

### Storage keys

`batchDownloadQueueV1` (queue), `profileDiscoveryV1` (discovery),
`downloadedMediaIdsV1` (completed item ids only, capped at 20k), plus UI prefs
`sidePanelActiveTab`, `scrollMediaFilter`, `scrollSpeed`, `skipDownloaded`,
`scrollIncludeQuoted`, `batchTarget`, `batchLimit`, `includeRetweets`,
`includeQuoted`.

---

## 5. What still needs live-X validation

**Round 3 passed (2026-08-26, against v3.3).** The user reported: all
functions work, no double entries, UI/UX already decent for deployment. That
covers checklist items 1–11 of `docs/WORKLIST.md` → "P0 — remaining (live-X,
round 3)". Offline tests still cover only logic, not X's live shapes, so two
browser items remain open:

- **Quote-card media (v3.4, checklist item 12)** — shipped *after* the
  round-3 test, so it has never run in a browser: a GIF/video reaction to a
  quoted post must list the card's media too, with the quoted author and a
  `quote` badge; **Include quoted** off must suppress it; the same quoted
  photo quoted by two different posts must stay a single row.
- **First release zip** — `scripts/package-release.sh` output must be
  confirmed to load from the unzipped folder.

Do **not** declare P0 complete without the signed-in quote-case check.

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

- No npm / TypeScript / webpack / build step.
- No `<all_urls>` or non-X host permissions.
- Privileged APIs stay in `background.js`.
- No manual auth-token input.
- No dead `statuses/show.json` v1.1 endpoint.
- No ZIP reintroduction for large batch queues (direct files only).
- No claim of current X support without a live check.

---

## 8. Commands

```bash
# from repo root
node --check extension/background.js extension/content.js extension/popup.js \
             extension/sidepanel.js extension/injected.js
node --test tests/*.test.js            # 55 tests
scripts/package-release.sh             # → releases/x-media-downloader-v<version>.zip
```

`tests/content.test.js` runs the real `content.js` inside a DOM + `chrome` shim
and encodes each reported live failure as a regression test (homepage capture,
in-tab route change, duplicate suppression, capture filter, auto-scroll
lifecycle). **Extend it rather than testing capture by hand** — every future
capture bug should land there first as a failing test.

---

## 9. Next session priorities

1. **Live spot-check the v3.4 quote case** — WORKLIST round-3 item 12. Reload
   `extension/` unpacked (manifest 3.4), scroll past a GIF/video reaction to a
   quoted post, and confirm the card's media lists with the `quote` badge
   under the quoted post's author; test the **Include quoted** switch in both
   tabs. If a specific card still does not list, get a sanitized GraphQL
   response from that exact view (§5 below) and add it to `tests/fixtures/`.
2. **Cut the first release zip** (`scripts/package-release.sh` →
   `releases/x-media-downloader-v3.4.zip`) and confirm it loads from the
   unzipped folder. Optionally start `CHANGELOG.md`. With that plus item 1,
   P0 is complete.
3. P1 afterwards: Side Panel diagnostics + sanitized copy-debug-report,
   explicit Include replies switch (quoted shipped in v3.4), filename
   templates + video quality preference, per-batch subfolders if requested.
4. Settled decisions that stay settled: separate scroll/remote lists (do not
   merge without a new user decision), one download action, no ZIP,
   no reply capture until it has its own switch.
5. Before finishing: update all three docs (log entry, worklist statuses,
   this file).
