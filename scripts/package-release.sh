#!/usr/bin/env bash
# Package the unpacked Chrome extension into a distributable zip under releases/.
#
# The extension has NO build step: this script only zips the finished files in
# extension/ so the result can be unzipped + "Load unpacked", or uploaded to the
# Chrome Web Store dashboard. manifest.json is placed at the zip root.
#
# Usage:
#   scripts/package-release.sh            # releases/x-media-downloader-v<version>.zip
#   scripts/package-release.sh 2026-08-25 # releases/x-media-downloader-v<version>-2026-08-25.zip
#
# Requires: zip, node (node is only used to read the manifest version).
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./extension/manifest.json').version")"
TAG="${1:-}"
OUT="releases/x-media-downloader-v${VERSION}${TAG:+-$TAG}.zip"

if ! command -v zip >/dev/null 2>&1; then
  echo "error: 'zip' is not installed." >&2
  echo "  macOS:  brew install zip   |   Debian/Ubuntu: sudo apt-get install zip" >&2
  echo "  Windows (PowerShell, no zip needed):" >&2
  echo "    cd extension && Compress-Archive -Path * -Force -DestinationPath ..\\releases\\x-media-downloader-v${VERSION}${TAG:+-$TAG}.zip" >&2
  exit 1
fi

# Sanity: the folder being packaged must actually be a loadable unpacked extension.
test -f extension/manifest.json

mkdir -p releases
rm -f "$OUT"
(cd extension && zip -rq "../$OUT" .)

echo "Wrote $OUT (version $VERSION${TAG:+, tag $TAG})"
# sed (not head) on purpose: `head` closes the pipe after 15 lines and unzip dies
# of SIGPIPE, which `set -o pipefail` turns into a 141 exit for a script that
# actually succeeded. sed drains the whole listing, so the exit stays honest.
unzip -l "$OUT" | sed -n '1,15p'
