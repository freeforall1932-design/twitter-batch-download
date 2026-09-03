# Archive-enabled source variant

This folder preserves the previous, archive-enabled implementation for reference
and optional development. It is **not shipped** and is not the Load unpacked
target.

- `chrome-extension/` — previous Chrome build with ZIP/CBZ/PDF UI and runtime.
- `firefox-extension/` — corresponding Firefox build.

The shipped builds are the top-level `extension/` and `firefox-extension/` folders
and intentionally support separate original-resolution files only.

## Tests

The archive-specific historical suites pin **this** source variant, not the
shipped `extension/`, so the retired behavior stays runnable:

- `tests/archive-lib.test.js` → `chrome-extension/lib/archive.js` (+ zipWriter/pdfBuilder)
- `tests/pdf-builder.test.js` → `chrome-extension/lib/pdfBuilder.js`
- `tests/zip-writer.test.js` → `chrome-extension/lib/zipWriter.js`
- `tests/archive-background.test.js` → `chrome-extension/background.js` +
  its `lib/` files (ZIP/CBZ/PDF worker fallback, offscreen job relay, media-kind
  rules, archive toggles and queueStart warnings).

They are part of the normal `node --test tests/*.test.js` run. The shipped
worker suites (`tests/downloader.test.js`, `tests/media-kinds.test.js`) cover
the stripped v3.12 build and keep the raw-mode assertions only.
