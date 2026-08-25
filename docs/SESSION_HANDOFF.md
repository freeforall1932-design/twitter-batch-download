# Session Handoff — X Media Downloader

**Prepared:** 2026-08-25 · **Extension version:** 3.3 · **Status:** v3.3 = v3.2 + `document_start` null-root crash fix, two unreachable queue commands wired, contract test. Awaiting live-X round 3.

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

_Latest input (2026-08-25): a live `TypeError: Cannot read properties of null
(reading 'appendChild')` at `content.js:105` on `https://x.com/real_loonarae/media`.
Traced and closed — see the IMPROVEMENT_LOG entry of the same name. Two things to
carry forward: (a) the trace came from a **pre-v3.2** file, so if the user reports
it again, first confirm which folder Chrome has loaded; (b) the DOM shim in
`tests/content.test.js` used to guarantee `head` + `documentElement`, which hid
the null branch — new `document_start` DOM code must be tested with overrides._

Open questions to ask the user if they are available:

- Did homepage / in-tab route-change capture actually work in v3.2?
- Is auto-scroll "Fast" fast enough now, or should the pacing be more aggressive?
- Should the two tab lists (Scroll capture / Remote fetch) finally be unified?
  They were kept separate on explicit past request — do not merge without a new decision.
- Are per-batch subfolders (e.g. `x-media/{username}/`) wanted? Rank A does this.

---

## 1. Project and branch

- Repository: `freeforall1932-design/twitter-batch-download`
- Extension directory: `extension/` (the **Load unpacked** target)
- Working branch for the last Arena session: `arena/01a03748-twitter-batch-download`
- Recent history:
  - **(this branch)** — `document_start` null-root crash fix; `queueClearFinished` +
    `queueClearDownloadedHistory` wired to toolbar buttons; message-contract and
    style-injection regression tests (**v3.3**)
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
8. Optionally include reposted media for Remote fetch. Replies / quoted media
   remain future explicit options.
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

## 4. Current architecture (v3.3)

| File | Role |
|---|---|
| `manifest.json` | MV3, sidePanel, cookies/downloads/storage/scripting. Content scripts: `injected.js` (MAIN, document_start) + `content.js` (isolated, document_start). Hosts: x.com / twitter.com / twimg CDN only. |
| `background.js` | Auth, GraphQL, source-tagged queue, remote discovery, downloads, capture bag, timeline response ingestion, downloaded-id history. **No ZIP.** |
| `injected.js` | MAIN-world XHR/fetch observer. Forwards **any** media-bearing GraphQL response (no operation allowlist), keeps a 40-entry replay buffer, and watches SPA route changes via `pushState`/`replaceState`/`popstate`. The allowlist survives only for Remote-fetch *request metadata*. |
| `content.js` | **Always-on** scroll capture (no watch command), SPA route re-arm, DOM photo listing, rate-bounded per-post video resolve, content-driven auto-scroll with in-page badge, action-bar `Download` + `Add to queue`, toasts. |
| `sidepanel.html/js/css` | Two-tab Side Panel: Scroll capture + Remote fetch. One download action, live active-tab status pill, per-row remove, skip-already-downloaded toggle, plus `Clear finished` / `Reset downloaded history` maintenance buttons (wired in the round-3 review; the handlers existed but nothing sent them). |
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

**Discovery:** `discoveryGet`, `discoveryStart` `{ target, limit, includeRetweets }`,
`discoveryStop`. State also exposes `errorCode`, `retryAfterMs`, `retryUntil`.

**Capture / media:** `networkCapture`, `localTimelineCapture` (returns
`{ addedCount, tweetIds }`), `initEnv`, `getTweetMedia`, `downloadFile`

**Side Panel → content script:** `scrollSettings`, `scrollStart`, `scrollStop`,
`scrollStatus`, `scrollRescan`

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
  isRepost, filename, // x-media/{user}_{text}_{tweetId}_{index}.{ext}
  selected, status,   // discovered|queued|starting|downloading|completed|failed
  attempts, bytesReceived, totalBytes, downloadId?, error?
}
```

### Storage keys

`batchDownloadQueueV1` (queue), `profileDiscoveryV1` (discovery),
`downloadedMediaIdsV1` (completed item ids only, capped at 20k), plus UI prefs
`sidePanelActiveTab`, `scrollMediaFilter`, `scrollSpeed`, `skipDownloaded`,
`batchTarget`, `batchLimit`, `includeRetweets`.

---

## 5. What still needs live-X validation

Offline tests cover logic, not X's live response shapes or rate limits. The full
round-3 checklist lives in `docs/WORKLIST.md` → **"P0 — remaining (live-X, round 3)"**.
Headline items:

- Homepage capture and in-tab route changes with no reload (the v3.1 failures).
- A profile's **posts** listing media, not only `/media`.
- Video posts filling in via the rate-bounded per-post resolve.
- Auto-scroll start/stop, badge, and whether "Fast" is fast enough.
- Skip-already-downloaded surviving a list clear.
- `UserByScreenName` + `UserMedia` shapes for Remote fetch; 429 countdown;
  protected / NSFW / expired-session messaging.

Do **not** declare P0 complete without a signed-in Chrome check.

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
node --test tests/*.test.js            # 48 tests
scripts/package-release.sh             # → releases/x-media-downloader-v<version>.zip
```

`tests/content.test.js` runs the real `content.js` inside a DOM + `chrome` shim
and encodes each reported live failure as a regression test (homepage capture,
in-tab route change, duplicate suppression, capture filter, auto-scroll
lifecycle). **Extend it rather than testing capture by hand** — every future
capture bug should land there first as a failing test.

---

## 9. Next session priorities

1. **Run the live checklist** in `docs/WORKLIST.md` → "P0 — remaining (live-X,
   round 3)". It is written directly against the v3.1 failures v3.2 fixed.
2. If capture still misses a view, get a sanitized GraphQL response from that
   exact view and add it to `tests/fixtures/` as a regression test.
3. If video posts fill in too slowly, tune the 700ms gap in `content.js`
   (`drainPendingVideoTweets`) against real rate limits before raising it.
4. Cut the first release zip once round 3 passes; the manifest is already at **3.3**.
5. P1 afterwards: Side Panel diagnostics + sanitized copy-debug-report, explicit
   Include replies / quoted media switches, filename templates, per-batch
   subfolders.
6. Before finishing: update all three docs (log entry, worklist statuses, this file).
