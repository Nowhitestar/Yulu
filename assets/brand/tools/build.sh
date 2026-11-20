#!/usr/bin/env bash
# Regenerate the Yulu brand kit in assets/brand and the copies the product uses.
#
# Usage: assets/brand/tools/build.sh [fonts_dir]
#
# Needs python3 with fontTools and Pillow, and Node with Playwright's Chromium
# (rasterize.mjs and preview.mjs render the SVGs). Fonts are downloaded into
# tools/.fonts on first run unless a directory is given.
set -euo pipefail
TOOLS="$(cd "$(dirname "$0")" && pwd)"
BRAND="$(dirname "$TOOLS")"
REPO="$(cd "$BRAND/../.." && pwd)"
FONTS="${1:-$TOOLS/.fonts}"
[[ -f "$FONTS/inter-400.ttf" ]] || "$TOOLS/fetch_fonts.sh" "$FONTS"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
KIT="$WORK/kit"
python3 -I "$TOOLS/build_svgs.py" "$FONTS" "$KIT"
node "$TOOLS/rasterize.mjs" "$KIT" "$WORK/raster-jobs.json"
python3 -I "$TOOLS/pack_icons.py" "$KIT"
node "$TOOLS/preview.mjs" "$KIT"

# The app icon set lives once, at assets/Yulu.iconset and assets/Yulu.icns.
rm -rf "$REPO/assets/Yulu.iconset"
mv "$KIT/app-icon/Yulu.iconset" "$REPO/assets/Yulu.iconset"
mv "$KIT/app-icon/Yulu.icns" "$REPO/assets/Yulu.icns"

for dir in logo lockup app-icon menubar favicon social motion colors; do
  rm -rf "${BRAND:?}/$dir"
  cp -R "$KIT/$dir" "$BRAND/$dir"
done
cp "$KIT/preview.png" "$BRAND/preview.png"

# Product copies.
cp "$KIT/logo/svg/yulu-mark.svg" "$REPO/assets/logo.svg"
cp "$KIT/logo/svg/yulu-mark-on-dark.svg" "$REPO/assets/logo-dark.svg"
cp "$KIT/app-icon/png/yulu-app-icon-512.png" "$REPO/assets/logo.png"
cp "$KIT/social/yulu-social-card.svg" "$REPO/assets/social-card.svg"
cp "$KIT/social/yulu-social-card.png" "$REPO/assets/social-card.png"
cp "$KIT/favicon/favicon.svg" "$REPO/yulu/scripts/yulu_ui/web/public/favicon.svg"
echo "brand kit and product icons updated"
