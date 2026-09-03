# X Media Downloader — Chrome Extension

**Scroll X normally and your media collects itself in a Side Panel queue — or grab a single post with one click.**

Self-hosted against your signed-in X session. No third-party accounts, API keys, or paid tiers.

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-brightgreen)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Features

- **Always-on scroll capture** — Open any X view (home timeline, profile, `/media`, or a single post) and scroll. Media lists itself in the Side Panel. No button to press first, and it follows in-tab navigation without a reload.
- **Nothing is lost while you scroll (v3.9)** — X removes posts from the page once they scroll off-screen, so a capture that only reads the visible page silently missed anything that came and went between two scans (measured: ~60% of media on a fast scroll). Capture now also reads the DOM's own change records, so a post is caught the moment it appears **and** on its way out — including posts that never lingered, and video posts that would otherwise vanish before they could be resolved. Duplicates are impossible: the same post is recognised by its media id and CDN key however it arrives (DOM, GraphQL, scroll list, remote list, rescan).
- **Rescan restores deleted rows (v3.8)** — **Rescan tab** (and **Fetch media**) forget what the tab already sent and re-list the posts on screen, so rows you deleted from the queue come back and you can pick again. Nothing moves on the page and nothing is crawled. Paired with the new **Remove selected** button: tick the rows you do not want, remove them, and rescan whenever you want them back. If items stay away the note says why — usually **Skip already downloaded**.
- **Fetch button (v3.7)** — A floating **Fetch media** button on every X page (and in the Side Panel) fetches the whole view for you, as if you had scrolled it yourself: it first reads everything the tab already has, then drives the auto-scroll so X loads the rest, then optionally pages the same profile silently to pick up media X never rendered. A **shallow** fetch — read the tab without moving the page — now also runs by itself when you open a profile in a new tab and on every in-tab route change, so a fresh profile lists its first batch with no scrolling and no reload.
- **Optional auto-scroll** — Let the extension scroll for you. It paces itself to how fast X renders, has no item cap, and never pauses for downloads. Available on its own (**Auto-scroll only**) or as the middle phase of **Fetch media**.
- **Action-bar buttons on media posts** — **Download** saves immediately; **Add to queue** sends the post's media to the Side Panel list.
- **Remote fetch (advanced)** — Enter `@username` or a profile/media URL, discover media (cap default 99,999), then select and download.
- **Skip already downloaded (v3.10)** — Finished files are remembered and not re-listed, even after you clear the list. **Two verifications** before anything is saved again: the media's **source URL** (canonical scheme + host + path, so `name=small`/`name=orig` and cache-busting params are one file) and its **byte content** (a SHA-256 of the actual bytes; different URLs carrying byte-identical content are one file). A duplicate is skipped and shown as `completed · duplicate` instead of saving a second copy under a renamed `(1)` file. Toggle off in Output settings ("Skip duplicates (byte compare + source URL)").
- **Videos + photos + GIFs at full quality** — Highest-bitrate MP4 for videos; original-resolution photos (`name=orig` forced on every source); GIFs saved as **real animated `.gif` files** (v3.6, converted frame-by-frame from the silent MP4 clips X actually serves — switchable back to MP4 in Output settings).
- **Include reposts** — Optional during profile discovery.
- **Include quoted** — Media inside a quoted post's card (the "mentioned post" box with thumbnail and text) lists too, attributed to the quoted post's author, with a `quote` badge. On by default; switchable per tab.
- **Rate-limit handling** — Throttle + exponential backoff; Side Panel shows a retry countdown on 429/503.
- **Master folder + per-user + per-post folders (v3.5 layout, v3.11 per-user)** — Downloads save as `Downloads/XMedia/<user>/<post name>/001.jpg…` — one folder **per user** the media is sourced from (the owning post's author), so media seen on the home timeline, a profile and its `/media` page of the same user all land in the same folder (it doubles as visual dedupe on top of the byte + source-URL checks). The master folder is configurable in the Side Panel's **Output settings**; **One folder per user** (`userFolders`) can be switched off to restore `Downloads/XMedia/<post name>/001.jpg…`, and emptying the master folder restores the old flat `Downloads/x-media/{username}_{post text}_{tweetId}_{index}.{ext}` layout exactly. Slashes nest deeper (`XMedia/raw`). Since v3.12 every item is saved as its **own file** — per-post ZIP/CBZ/PDF bundles are no longer exposed by the shipped UI or worker.
- **Separate original-resolution files only (v3.12, GIF conversion restored v3.13, quality modes v3.14, WebP + fallback v3.15)** — The queue downloads each selected media item independently: original-resolution photos (`name=orig`), highest-bitrate MP4 videos, and GIFs as a real `.gif`, animated `.webp` or true-color APNG per the output setting (converted from X's silent MP4 clips in a small offscreen document; if the chosen format fails, the other animated formats are retried — Chrome; the Firefox port keeps the MP4 clip). The former per-post **ZIP / CBZ / PDF** output (≤4 items of one post, media-kind rules, archive toggles and warnings) was retired from the shipped build and is preserved for reference — **not** a Load-unpacked target — under [`source/archive-enabled/`](source/archive-enabled/README.md). The old multi-GB whole-batch ZIP stays removed.
- **Naming scheme checkboxes (v3.5)** — The post name is built from tokens (`{user}`, `{name}`, `{text}`, `{id}`, `{date}`; default `{user} - {text} - {id}`) picked with checkboxes and a live example preview; hand-typed custom templates keep working through a manual input. Degenerate names fall back to the post id; Windows-reserved names are prefixed.
- **Live session capture** — MAIN-world observer learns current GraphQL operation IDs and safe request headers from the open X tab.
- **No third-party services** — Calls go to X only, using your browser session.

The popup is just a launcher for the Side Panel — all capture, review, and downloading happens there.

## Installation

1. Clone this repo or download the source archive (or unzip a release zip from `releases/`).
2. Open `chrome://extensions/` and enable **Developer mode**.
3. **Load unpacked** → select the **`extension/`** folder (it contains `manifest.json` at its root).
4. Sign in to [x.com](https://x.com) in that Chrome profile.
5. Open the extension popup → **Open media queue** (Side Panel), or use the on-post buttons.

You must be logged in to X. The extension uses your existing session — no API keys or passwords.

## Usage

### Scroll capture (primary)

1. Open the Side Panel (popup → **Open media queue**). It stays on **Scroll capture**.
2. Open any X view — home timeline, a profile, a profile's `/media` tab, or a single post. Its first batch lists itself within a couple of seconds (v3.7 shallow fetch); no scrolling and no reload needed.
3. Scroll normally, at whatever speed you like. Media appears in the panel as you go — including posts you scroll straight past, which are captured on the way out rather than only while they are on screen. Switching views inside the same tab works without reloading.
4. Want the whole view without scrolling? Press **Fetch media** — on the page (floating button, bottom-right) or in the Side Panel. It reads the tab, scrolls the timeline to the end at the speed you picked, then (if **Then fetch the rest silently** is on) pages the same profile through the Remote fetch engine; those extra rows land in the **Remote fetch** list. The page button turns into **Stop** while it runs, and the panel's **Stop** cancels both phases.
5. **Rescan tab** re-lists the current view without moving the page — including rows you deleted earlier, which come back so you can choose again. **Auto-scroll only** scrolls without the silent fill afterwards.
6. Tick the items you want (or **Select all**) and press **Download selected**. Tick rows you do *not* want and press **Remove selected** to delete just those from the list (files already on disk are untouched).

Keep concurrent downloads at 1 or 2. **Skip already downloaded** keeps finished files out of the list.
Turn off **Show the Fetch button on X pages** to hide the in-page button (the page's own **×** hides it for that tab only).

### Single post

Under any media post: **Download** saves it now, **Add to queue** sends it to the Side Panel list for batching.

### Remote fetch (advanced fallback)

Switch to the **Remote fetch** tab, enter `@username` or a profile URL, set a limit, optionally include reposts and quoted-post media, then **Remote discover**. This crawls X directly, so it can hit rate limits sooner than normal scrolling — prefer Scroll capture when you can.

### Output settings

Open **Output settings** (between the toolbar and the list):

- **Master folder for saved files** — default `XMedia`; raw files save as `Downloads/XMedia/<user>/<post name>/001.jpg…`. Leave it **empty** to switch the folder off (old flat `x-media/` layout). Requires Chrome's *"Ask where to save each file"* to be off for folders to auto-create.
- **Format (v3.12)** — always **separate original-resolution files**; per-post ZIP/CBZ/PDF bundles were retired with the archive path (see `source/archive-enabled/`).
- **Animated posts save as** (v3.6, restored v3.13, quality modes v3.14, WebP + fallback v3.15) — four choices: real `.gif` — **maximum quality** (default: 25 fps, ≤1920 px, per-frame 256-color palettes + Floyd–Steinberg dithering), **animated WebP** (25 fps, ≤1920 px, true color via the browser's native encoder, small files — the middle ground), **APNG — true color** (no palette, every frame keeps full RGBA; the closest an image format gets to the MP4), or the **original MP4 clips**. The old balanced 12 fps/global-palette GIF was removed in the v3.15 review (WebP covers that niche better and a single-table GIF bands on color shifts). If the chosen format fails, the other animated formats are retried in quality order (APNG → WebP → GIF) and the MP4 is the last resort. Firefox port: conversion is unavailable (no `chrome.offscreen`), so the MP4 clip is kept.
- **Post name is built from** — tick the tokens; the example preview updates live. Untick everything and names fall back to the post id. A hand-typed custom template shows a manual input instead.

## How it works

1. **Auth** — Reads `ct0` / `auth_token` cookies and a public Bearer token (from page JS, live capture, or known public fallback).
2. **Live capture** — `injected.js` (MAIN world) observes GraphQL requests for operation IDs, features, and headers such as `x-client-transaction-id` (never stores Cookie header values in the capture bag).
3. **Discovery** — Resolves user via `UserByScreenName`, pages `UserMedia` (or captured media-timeline aliases), parses timeline instructions, enqueues media.
4. **Single tweet** — `TweetResultByRestId` for action-bar / DOM bulk.
5. **Downloads** — `chrome.downloads` with concurrency 1–2, retries, and a safer filename ladder if Chrome rejects a path. Paths honor the **Output settings** (master folder + name template); relative subpaths only, never absolute, never `..`.
6. **Downloads (v3.12)** — every selected item is saved as its own file; no archive pass runs and the worker ignores stale `outputFormat` values (it always forces raw). The former per-post ZIP/CBZ/PDF assembly (offscreen document + `<a download>` anchor, worker data-URL fallback, media-kind rules) is preserved only in `source/archive-enabled/` — see its README.
7. **GIF/WebP/APNG conversion (v3.6, re-added v3.13, quality modes v3.14, WebP v3.15)** — X serves `animated_gif` media as a small silent MP4 clip. The worker asks a small offscreen document (chrome.runtime only) to convert it per the `gifOutput` setting: maximum-quality GIF89a (`lib/gifEncoder.js`, median-cut per-frame palettes + LZW, ≤30 s / ≤1920 px / ≤256 MB) (per-frame local palettes + Floyd–Steinberg dithering, ≤30 s / ≤1920 px / ≤256 MB), animated WebP (`lib/webpEncoder.js` wraps browser-encoded static WebP frames into the WebP animation container; true color, ≤256 MB) or true-color APNG (`lib/apngEncoder.js`, full RGBA frames, same caps). Large results travel back **chunked** (3 MB binary per runtime message); all sizes save via a `data:` URL so they still land inside the master folder with the right `.gif`/`.webp`/`.apng` extension. **Fallback:** the other animated formats are retried in quality order (APNG → WebP → GIF) before the original MP4 is kept — never a failed item. Firefox port: no offscreen → MP4 kept.

## Permissions

| Permission | Why |
|------------|-----|
| `cookies` | Session CSRF / signed-in check |
| `downloads` | Save media |
| `storage` | Queue, discovery state, settings |
| `activeTab` + `scripting` | Buttons, bundle metadata, messaging |
| `sidePanel` | Batch queue UI |
| `offscreen` | Convert X's silent MP4 "GIF" clips into real animated `.gif`/`.webp`/`.apng` files (MV3 workers have no `<video>`/canvas). Conversion only — no archive assembly |

**Host permissions:** `x.com`, `twitter.com`, `video.twimg.com`, `pbs.twimg.com`, `api.x.com`.

No data is sent to third-party extension backends.

## Repository layout

```
.
├── extension/                 # ← Load unpacked: select THIS folder in chrome://extensions
│   ├── manifest.json          #   MV3, name/version live here
│   ├── background.js          #   Auth, GraphQL, queue, discovery, downloads (raw only)
│   ├── injected.js            #   MAIN-world GraphQL/header capture
│   ├── content.js             #   Capture forwarder, action bar, DOM bulk
│   ├── sidepanel.html/js/css  #   Batch queue UI + Output settings card
│   ├── offscreen.html/js      #   MP4 clip → .gif / .webp / APNG conversion document (chrome.runtime ONLY)
│   ├── lib/                   #   naming.js, dedupe.js, gifEncoder.js, webpEncoder.js, apngEncoder.js (shared with tests)
│   ├── popup.html/js          #   Side Panel launcher + capture status
│   └── icon48.png / icon128.png
├── source/archive-enabled/    # Preserved pre-v3.12 archive build (NOT a Load-unpacked target)
├── firefox-extension/         # Firefox port of the same raw-only build (no offscreen)
├── tests/                     # Node unit tests + sanitized fixtures
├── scripts/
│   └── package-release.sh     # Zip extension/ → releases/ (packaging only, no build)
├── releases/                  # Generated distribution zips (gitignored)
├── docs/
│   ├── WORKLIST.md            # Priorities, code-review checklist
│   ├── SESSION_HANDOFF.md     # Architecture, guardrails, live-X validation needs
│   └── IMPROVEMENT_LOG.md     # Chronological implementation record
├── reference/
│   └── scrapyard/             # Abandoned X extensions — conceptual reference ONLY (S/A/B ranks)
├── LICENSE
└── README.md
```

Vanilla JavaScript — no frameworks, no build step, no npm, no TypeScript. The `extension/`
folder is the shippable artifact as-is; `tests/`, `docs/`, `reference/`, and `scripts/` are
never loaded by the browser.

## Development

```bash
for f in extension/*.js extension/lib/*.js; do node --check "$f"; done
node --test tests/*.test.js   # 169 tests (offline: fixtures + window-less VM pipelines;
                              # the archive suites pin source/archive-enabled/)
node --test tests/downloader.test.js
```

CI runs the same offline suites once `docs/ci/extension-tests.yml` is installed
as `.github/workflows/extension-tests.yml` (manual web-UI step — see
`docs/ci/README.md`; the Arena GitHub App cannot push workflow files).
GitHub-hosted runners cannot drive real-browser MV3 tests, so signed-in
verification against live X remains a local manual step
(see `docs/SESSION_HANDOFF.md` §5).

After changing anything in `extension/`: reload the extension on `chrome://extensions`, then
hard-refresh your X tab.

See `docs/WORKLIST.md` for priorities and the post-rewrite code-review checklist. See
`docs/SESSION_HANDOFF.md` for architecture and live-X validation needs.

## Releases (packaging, not a build)

```bash
scripts/package-release.sh            # → releases/x-media-downloader-v<version>.zip
scripts/package-release.sh 2026-08-25 # → releases/x-media-downloader-v<version>-2026-08-25.zip
```

The script reads the version from `extension/manifest.json`, zips the finished `extension/`
folder with `manifest.json` at the zip root, and writes to `releases/` (gitignored). No code is
compiled or rewritten — it is plain distribution packaging. On Windows without `zip`, use
PowerShell: `cd extension && Compress-Archive -Path * -DestinationPath ..\releases\x-media-downloader-v3.1.zip`.

Bump `extension/manifest.json` → `version` when cutting a new release.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Auth / session errors | Sign in on x.com, hard-refresh, retry |
| Operation metadata missing | Open the target profile `/media` once so live capture can warm up |
| Protected / N/A | Private, deleted, or unavailable to your account |
| Rate limited | Wait for the Side Panel countdown; use a slower auto-scroll speed, or switch off **Then fetch the rest silently** so a Fetch does not add a remote crawl on top of the scrolling |
| The list has fewer items than the profile | v3.9 fixed the main cause (posts that left the page before a scan). Check the media filter is **All**, that **Skip already downloaded** is not hiding finished items, and — for a profile with many reposts — that reposts are included. Compare against the post count on the profile's `/media` tab |
| The same post appears twice | Should not happen: items are deduped by media id and CDN key across the DOM, GraphQL, both lists and rescans. If you do see one, note which two rows they are (Scroll capture vs Remote fetch) and file it — that is a new key shape worth a test |
| Deleted rows will not come back | Press **Rescan tab** (or **Fetch media**): both re-list the posts on screen. If the note says items are "already downloaded", untick **Skip already downloaded** — or press **Reset downloaded history** to forget them entirely |
| New tab lists nothing | It should list its first batch on its own within ~2 s. If not, press **Fetch media** (page or panel) — and check the panel's status pill: if it says **Reload needed**, use its **Reload tab** button |
| Silent fill says "operation metadata" | The Remote fetch engine needs one live X request to learn the current query IDs. Open the profile's `/media` tab once (or scroll a little), then Fetch again |
| After code update | Reload extension on `chrome://extensions`, then hard-refresh X. Tabs opened before the reload have no content script — the panel shows **Reload needed** + a **Reload tab** button |

## Disclaimer

For personal use. Respect creators’ rights and X’s Terms of Service. Downloaded media remains the IP of its creators.

## License

[MIT](LICENSE)
