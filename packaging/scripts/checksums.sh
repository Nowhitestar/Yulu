#!/usr/bin/env bash
set -euo pipefail

DIST="${1:-dist}"
TAG="${2:-${TAG:-}}"

if [[ ! -d "$DIST" ]]; then
    echo "No dist directory: $DIST" >&2
    exit 1
fi
if [[ -z "$TAG" || ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
    echo "A valid release tag is required to select exact checksum subjects." >&2
    exit 1
fi

CHECKSUMS="$DIST/checksums.txt"
TMP="$CHECKSUMS.tmp"
ARTIFACTS="$CHECKSUMS.artifacts.tmp"

cleanup() {
    rm -f "$TMP" "$ARTIFACTS"
}
trap cleanup EXIT

: > "$ARTIFACTS"
for artifact in \
    "$DIST/appcast.xml" \
    "$DIST/yulu-local-caption-runtime-macos-arm64-$TAG.zip" \
    "$DIST/yulu-macos-arm64-$TAG.dmg"; do
    if [[ -f "$artifact" ]]; then
        printf '%s\n' "$artifact" >> "$ARTIFACTS"
    fi
done

if [[ ! -s "$ARTIFACTS" ]]; then
    echo "No current DMG, Optional Runtime Pack, or appcast found in $DIST for $TAG." >&2
    exit 1
fi

while IFS= read -r artifact; do
    shasum -a 256 "$artifact" | awk -v name="$(basename "$artifact")" '{print $1 "  " name}'
done < "$ARTIFACTS" > "$TMP"

mv "$TMP" "$CHECKSUMS"
echo "$CHECKSUMS"
