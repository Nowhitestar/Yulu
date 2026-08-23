#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
    echo "At least one binary path is required." >&2
    exit 1
fi

for binary in "$@"; do
    if [[ ! -f "$binary" || ! -r "$binary" ]]; then
        echo "Not a readable regular file: $binary" >&2
        exit 1
    fi

    if ! build_info="$(xcrun vtool -arch arm64 -show-build "$binary" 2>&1)"; then
        echo "Unable to inspect arm64 Mach-O metadata: $binary" >&2
        [[ -z "$build_info" ]] || printf '%s\n' "$build_info" >&2
        exit 1
    fi

    platform="$(awk '$1 == "platform" { print $2; exit }' <<<"$build_info")"
    minos="$(awk '$1 == "minos" { print $2; exit }' <<<"$build_info")"
    if [[ "$platform" != "MACOS" || "$minos" != "13.0" ]]; then
        echo "$binary: expected platform MACOS and minos 13.0; got platform ${platform:-<missing>} and minos ${minos:-<missing>}" >&2
        exit 1
    fi
done
