# releases/

Distributable zips of the unpacked extension, produced by `scripts/package-release.sh`.

- Zips are **generated artifacts** — `releases/*.zip` is gitignored; only this README is committed.
- Each zip contains the `extension/` folder contents at its **root** (manifest.json at the zip top level), so it can be:
  - unzipped and loaded unpacked (`chrome://extensions` → **Load unpacked** → the unzipped folder), or
  - uploaded directly to the Chrome Web Store developer dashboard.
- Naming: `x-media-downloader-v<manifest version>.zip` (e.g. `x-media-downloader-v3.1.zip`).

The extension has **no build step** — packaging only zips the finished `extension/` files. No code is compiled, transpiled, or rewritten.
