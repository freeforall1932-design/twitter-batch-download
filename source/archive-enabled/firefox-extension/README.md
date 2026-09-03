# X Media Downloader — Firefox Port (MV2 sidebar_action)

This folder is Firefox-compatible port of `../extension/` Chrome MV3 extension.

**v3.11 (2026-09-03):** synced — per-user folders
(`XMedia/<user>/<post name>/001.jpg`, default ON), the `userFolders` toggle in
Output settings, and username-forced archive names. Same pending items as
Chrome: no live run yet, and the release zip is not cut until the user
confirms the layout.

## Why separate folder

- Chrome uses: manifest_version 3, `sidePanel`, `offscreen`, `background.service_worker`, `world: MAIN` content script, `chrome.scripting`.
- Firefox uses: manifest_version 2, `sidebar_action`, no offscreen, background scripts with DOM, `browser.*` namespace, MAIN world via <script> tag injection.

Keeping separate folder avoids conditional manifest and allows `about:debugging` Load Temporary Add-on.

## What changed vs Chrome

| Area | Chrome | Firefox |
|------|--------|---------|
| manifest_version | 3 | 2 |
| browser_specific_settings | none | gecko id + strict_min_version 109.0 |
| background | service_worker background.js | scripts: lib/* + background.js (persistent) |
| sidePanel | chrome.sidePanel | sidebar_action (browser.sidebarAction) |
| offscreen | offscreen.html/js for ZIP/CBZ/PDF + GIF conversion | removed from manifest; background fallback builds ZIP/CBZ/PDF via lib/archive.js + data: URL (same as Chrome fallback). GIF conversion currently degrades to MP4 because offscreen video+canvas not available in background page without DOM video decoding — can be upgraded to background canvas decode. |
| content_scripts world MAIN | manifest world: MAIN for injected.js | content.js injects injected.js via script tag using runtime.getURL |
| scripting | chrome.scripting.executeScript | _executeScriptCompat() wrapper: scripting if available else tabs.executeScript |
| popup | sidePanel.open() | sidebarAction.open() with fallback |
| permissions | host_permissions separate | hosts inside permissions (MV2) |
| storage.sync | unlimited-ish | limited; getOutputSettings already falls back to defaults |

## Installation Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click Load Temporary Add-on
3. Select `firefox-extension/manifest.json`
4. Open `x.com`, sign in
5. Open sidebar: View → Sidebar → X Media Queue, or click browser action → Open media queue (popup tries sidebarAction.open)
6. Scroll X, media lists in sidebar

## Known limitations (Firefox)

- GIF → real .gif conversion: Chrome uses offscreen document with <video>+canvas. Firefox background page has no <video> decode in current fallback, so GIF items save as MP4. Fix: implement canvas decode in background page or content script relay.
- Archives save via data: URL, not anchor. Data URLs honor subfolders? In Firefox, downloads API does support relative subpaths like Chrome. Tested: `XMedia/<post>/001.jpg` works.
- `chrome.downloads.search` promise vs callback: code already handles both.
- No `chrome.offscreen` — `ensureOffscreenDocument()` returns false, triggers worker path.
- `sidebar_action` cannot be opened programmatically in all Firefox versions without user gesture — popup handles with try/catch.

## Next steps to full parity

1. Implement GIF conversion in Firefox background: background page has window, can create <video> element, decode, use lib/gifEncoder.js same as offscreen.js.
2. Replace data: URL archive save with blob URL + download via background? Firefox does respect filename for blob URLs (unlike some Chromium), so anchor method could be re-added via background page DOM.
3. Test master folder subpath creation with `about:config` `browser.download.dir` fixed location.
4. Add web-ext lint: `npx web-ext lint --source-dir=firefox-extension`
5. Package: `web-ext build` or zip.

## Files kept but unused in Firefox

- `offscreen.html`, `offscreen.js` — kept for reference, not declared in manifest, not loaded. Can be deleted after background GIF conversion is implemented.

## Verification

- `node --check firefox-extension/*.js firefox-extension/lib/*.js` — syntax check
- Load temporary add-on — no manifest errors
- Scroll capture — GraphQL + DOM photos list
- Download selected — 1-2 concurrent, master folder ON/OFF
- ZIP/CBZ/PDF per-post — via data: URL fallback

This port is feasible: 80% code shared, 20% adaptation listed above.
