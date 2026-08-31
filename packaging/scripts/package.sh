#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: TAG=vX.Y.Z package.sh [--dist dist] [--skip-build]" >&2
    echo "   or: package.sh vX.Y.Z [--dist dist] [--skip-build]" >&2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST="dist"
SKIP_BUILD=false
YULU_APP="$ROOT/yulu/scripts/Yulu.app"
BUILD_WORK=""
WORK=""
OUTPUT_WORK=""
ALLOWED_BUILD_OUTPUTS=(
    "yulu/scripts/Yulu.app/Contents/Info.plist"
    "yulu/scripts/Yulu.app/Contents/MacOS/yulu_app"
    "yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon"
    "yulu/scripts/Yulu.app/Contents/MacOS/xai_keychain"
    "yulu/scripts/Yulu.app/Contents/MacOS/calendar_probe"
    "yulu/scripts/Yulu.app/Contents/Helpers/YuluCapture.app/Contents/Info.plist"
    "yulu/scripts/Yulu.app/Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon"
    "yulu/scripts/Yulu.app/Contents/Helpers/YuluCapture.app/Contents/_CodeSignature/CodeResources"
    "yulu/scripts/Yulu.app/Contents/_CodeSignature/CodeResources"
)
PROTECTED_BUILD_OUTPUT_DIRS=(
    "yulu/scripts/Yulu.app/Contents/Helpers/YuluCapture.app/Contents/MacOS"
    "yulu/scripts/Yulu.app/Contents/Helpers/YuluCapture.app/Contents/_CodeSignature"
)

cleanup() {
    if [[ -n "$BUILD_WORK" ]]; then rm -rf "$BUILD_WORK"; fi
    if [[ -n "$WORK" ]]; then rm -rf "$WORK"; fi
    if [[ -n "$OUTPUT_WORK" ]]; then rm -rf "$OUTPUT_WORK"; fi
}
trap cleanup EXIT

is_allowed_build_output() {
    local candidate="$1" allowed
    for allowed in "${ALLOWED_BUILD_OUTPUTS[@]}"; do
        [[ "$candidate" == "$allowed" ]] && return 0
    done
    return 1
}

check_clean_worktree() {
    local phase="$1"
    if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        return 0
    fi

    local unexpected=() line path ignored_outputs
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        path="${line:3}"
        if [[ "$phase" == "after build" ]] && is_allowed_build_output "$path"; then
            continue
        fi
        unexpected+=("$line")
    done < <(git -C "$ROOT" status --porcelain --untracked-files=all)

    if ! ignored_outputs="$(
        git -C "$ROOT" ls-files --others --ignored --exclude-standard -- \
            "${PROTECTED_BUILD_OUTPUT_DIRS[@]}"
    )"; then
        echo "Failed to inspect ignored Capture build outputs; refusing to package release assets." >&2
        exit 1
    fi
    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        if [[ "$phase" == "after build" ]] && is_allowed_build_output "$path"; then
            continue
        fi
        unexpected+=("!! $path")
    done <<< "$ignored_outputs"

    if ((${#unexpected[@]} > 0)); then
        echo "Worktree is dirty $phase; refusing to package release assets." >&2
        printf '%s\n' "${unexpected[@]}" >&2
        echo "Commit or clean these files, or use --skip-build for packaging-only tests." >&2
        exit 1
    fi
}

if [[ $# -gt 0 && "$1" != --* ]]; then
    TAG="$1"
    shift
else
    TAG="${TAG:-}"
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dist)
            [[ $# -ge 2 ]] || { usage; exit 1; }
            DIST="$2"
            shift 2
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage
            exit 1
            ;;
    esac
done

if [[ -z "$TAG" ]]; then
    echo "TAG is required." >&2
    usage
    exit 1
fi
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
    echo "Invalid release tag: $TAG" >&2
    exit 1
fi
TAG_WITHOUT_BUILD="${TAG%%+*}"
if [[ "$TAG_WITHOUT_BUILD" == *-* ]]; then
    PRERELEASE="${TAG_WITHOUT_BUILD#*-}"
    if [[ "$PRERELEASE" == .* || "$PRERELEASE" == *. || "$PRERELEASE" == *..* ]]; then
        echo "Invalid release tag: $TAG" >&2
        exit 1
    fi
    IFS='.' read -r -a PRERELEASE_IDENTIFIERS <<< "$PRERELEASE"
    for IDENTIFIER in "${PRERELEASE_IDENTIFIERS[@]}"; do
        if [[ -z "$IDENTIFIER" || "$IDENTIFIER" =~ ^0[0-9]+$ ]]; then
            echo "Invalid release tag: $TAG" >&2
            exit 1
        fi
    done
fi
if [[ "$TAG" == *+* ]]; then
    BUILD_METADATA="${TAG#*+}"
    if [[ "$BUILD_METADATA" == .* || "$BUILD_METADATA" == *. || "$BUILD_METADATA" == *..* ]]; then
        echo "Invalid release tag: $TAG" >&2
        exit 1
    fi
fi
if [[ -f "$ROOT/VERSION" ]]; then
    VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
    EXPECTED_TAG="v$VERSION"
    if [[ "$TAG" != "$EXPECTED_TAG" ]]; then
        command -v python3 >/dev/null 2>&1 || {
            echo "TAG ($TAG) must match VERSION ($EXPECTED_TAG)." >&2
            exit 1
        }
        python3 "$ROOT/packaging/scripts/release_identity.py" \
            --tag "$TAG" \
            --version-file "$ROOT/VERSION" \
            --repository "$ROOT" \
            --validate-only
    fi
fi

if [[ "$SKIP_BUILD" != true ]]; then
    check_clean_worktree "before build"
    BUILD_WORK="$(mktemp -d "${TMPDIR:-/tmp}/yulu-application-runtime.XXXXXX")"
    YULU_APP="$BUILD_WORK/Yulu.app"
    YULU_APP_OUTPUT_PATH="$YULU_APP" \
        YULU_BUNDLE_APPLICATION_RUNTIME=1 \
        bash "$ROOT/yulu/scripts/build_audio_daemon.sh"
    check_clean_worktree "after build"
fi

[[ -d "$YULU_APP/Contents" ]] || {
    echo "Immutable Application Runtime missing: $YULU_APP" >&2
    exit 1
}
command -v hdiutil >/dev/null 2>&1 || {
    echo "hdiutil is required to build the macOS DMG." >&2
    exit 1
}
command -v ditto >/dev/null 2>&1 || {
    echo "ditto is required to preserve the signed App bundle." >&2
    exit 1
}

DIST_ABS="$(mkdir -p "$DIST" && cd "$DIST" && pwd)"
DMG_PATH="$DIST_ABS/yulu-macos-arm64-$TAG.dmg"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/yulu-dmg.XXXXXX")"
OUTPUT_WORK="$(mktemp -d "$DIST_ABS/.yulu-dmg.XXXXXX")"
STAGE="$WORK/stage"
RW_DMG="$WORK/Yulu-read-write.dmg"
DMG_TMP="$OUTPUT_WORK/yulu-macos-arm64-$TAG.dmg"

mkdir -p "$STAGE"
ditto "$YULU_APP" "$STAGE/Yulu.app"
ln -s /Applications "$STAGE/Applications"

[[ -d "$STAGE/Yulu.app/Contents" && ! -L "$STAGE/Yulu.app" ]] || {
    echo "DMG staging failed to preserve Yulu.app." >&2
    exit 1
}
[[ -L "$STAGE/Applications" && "$(readlink "$STAGE/Applications")" == "/Applications" ]] || {
    echo "DMG Applications alias must resolve exactly to /Applications." >&2
    exit 1
}
if [[ "$(find "$STAGE" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d '[:space:]')" != "2" ]]; then
    echo "DMG staging must contain only Yulu.app and the Applications alias." >&2
    exit 1
fi

hdiutil create -quiet -ov -format UDRW -fs HFS+ -volname Yulu \
    -srcfolder "$STAGE" "$RW_DMG"
hdiutil convert "$RW_DMG" -quiet -ov -format UDZO -imagekey zlib-level=9 \
    -o "$DMG_TMP"
[[ -s "$DMG_TMP" ]] || {
    echo "DMG conversion did not produce an artifact: $DMG_TMP" >&2
    exit 1
}

rm -f "$DMG_PATH"
mv "$DMG_TMP" "$DMG_PATH"
echo "$DMG_PATH"
