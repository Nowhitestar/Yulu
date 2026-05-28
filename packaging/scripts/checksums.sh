#!/usr/bin/env bash
set -euo pipefail

DIST="${1:-dist}"

if [[ ! -d "$DIST" ]]; then
    echo "No dist directory: $DIST" >&2
    exit 1
fi

CHECKSUMS="$DIST/checksums.txt"
TMP="$CHECKSUMS.tmp"

find "$DIST" -maxdepth 1 \( -name '*.zip' -o -name 'install.sh' \) -type f -print \
    | LC_ALL=C sort \
    | while IFS= read -r artifact; do
        shasum -a 256 "$artifact" | awk -v name="$(basename "$artifact")" '{print $1 "  " name}'
    done > "$TMP"

mv "$TMP" "$CHECKSUMS"
echo "$CHECKSUMS"
