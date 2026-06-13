#!/usr/bin/env bash
set -euo pipefail

DIST="${1:-dist}"

if [[ ! -d "$DIST" ]]; then
    echo "No dist directory: $DIST" >&2
    exit 1
fi

CHECKSUMS="$DIST/checksums.txt"
TMP="$CHECKSUMS.tmp"
ARTIFACTS="$CHECKSUMS.artifacts.tmp"

cleanup() {
    rm -f "$TMP" "$ARTIFACTS"
}
trap cleanup EXIT

find "$DIST" -maxdepth 1 \( -name '*.zip' -o -name '*.pkg' -o -name 'install.sh' \) -type f -print \
    | LC_ALL=C sort > "$ARTIFACTS"

if [[ ! -s "$ARTIFACTS" ]]; then
    echo "No release artifacts found in $DIST (expected dist/*.zip, dist/*.pkg, and/or dist/install.sh)." >&2
    exit 1
fi

while IFS= read -r artifact; do
    shasum -a 256 "$artifact" | awk -v name="$(basename "$artifact")" '{print $1 "  " name}'
done < "$ARTIFACTS" > "$TMP"

mv "$TMP" "$CHECKSUMS"
echo "$CHECKSUMS"
