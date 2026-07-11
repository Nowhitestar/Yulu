#!/usr/bin/env bash
# Local diagnostics only. Do not upload this pkg as an official release unless
# it is signed with a Developer ID Installer certificate and independently
# verified. The production release workflow intentionally publishes the signed,
# notarized, stapled runtime zip instead.
set -euo pipefail

usage() {
    echo "Usage: TAG=vX.Y.Z package_pkg.sh [--dist dist] [--runtime-zip path] [--skip-build]" >&2
    echo "   or: package_pkg.sh vX.Y.Z [--dist dist] [--runtime-zip path] [--skip-build]" >&2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST="dist"
RUNTIME_ZIP=""
SKIP_BUILD=false
export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

PKG_IDENTIFIER="${YULU_PKG_IDENTIFIER:-com.yulu.installer}"
PKG_SIGN_IDENTITY="${YULU_PKG_SIGN_IDENTITY:-}"
RUNTIME_PREFIX="${YULU_PKG_RUNTIME_PREFIX:-Library/Application Support/Yulu/runtime}"
VISIBLE_APP_PREFIX="${YULU_PKG_VISIBLE_APP_PREFIX:-Applications/Yulu.app}"
VISIBLE_APP_SOURCE="${YULU_PKG_VISIBLE_APP_SOURCE:-yulu/scripts/Yulu.app}"
PKG_SCRIPTS_SRC="${YULU_PKG_SCRIPTS_SRC:-$SCRIPT_DIR/pkg_postinstall.sh}"

if [[ $# -gt 0 && "$1" != --* ]]; then
    TAG="$1"
    shift
else
    TAG="${TAG:-}"
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dist)
            if [[ $# -lt 2 ]]; then
                usage
                exit 1
            fi
            DIST="$2"
            shift 2
            ;;
        --runtime-zip)
            if [[ $# -lt 2 ]]; then
                usage
                exit 1
            fi
            RUNTIME_ZIP="$2"
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

if [[ -f "$ROOT/VERSION" ]]; then
    VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
    EXPECTED_TAG="v$VERSION"
    if [[ "$TAG" != "$EXPECTED_TAG" ]]; then
        echo "TAG ($TAG) must match VERSION ($EXPECTED_TAG)." >&2
        exit 1
    fi
else
    VERSION="${TAG#v}"
fi

require_command() {
    local name="$1"
    if ! command -v "$name" >/dev/null 2>&1; then
        echo "$name is required to create a macOS installer package." >&2
        exit 1
    fi
}

require_command pkgbuild
require_command pkgutil
require_command mkbom
require_command unzip
require_command cpio
require_command gzip
require_command perl
if [[ -n "$PKG_SIGN_IDENTITY" ]]; then
    require_command productsign
fi
if [[ ! -f "$PKG_SCRIPTS_SRC" ]]; then
    echo "Package postinstall script not found: $PKG_SCRIPTS_SRC" >&2
    exit 1
fi

DIST_ABS="$(mkdir -p "$DIST" && cd "$DIST" && pwd)"
PKG_PATH="$DIST_ABS/yulu-macos-arm64-$TAG.pkg"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/yulu-pkg.XXXXXX")"

cleanup() {
    rm -rf "$STAGE"
}
trap cleanup EXIT

if [[ -z "$RUNTIME_ZIP" ]]; then
    RUNTIME_DIST="$STAGE/runtime-dist"
    PACKAGE_ARGS=("$TAG" "--dist" "$RUNTIME_DIST")
    if [[ "$SKIP_BUILD" == true ]]; then
        PACKAGE_ARGS+=("--skip-build")
    fi
    bash "$SCRIPT_DIR/package.sh" "${PACKAGE_ARGS[@]}" >/dev/null
    RUNTIME_ZIP="$RUNTIME_DIST/yulu-macos-arm64-$TAG.zip"
fi

if [[ ! -f "$RUNTIME_ZIP" ]]; then
    echo "Runtime zip not found: $RUNTIME_ZIP" >&2
    exit 1
fi

EXTRACTED="$STAGE/extracted"
PAYLOAD="$STAGE/payload"
SCRIPTS="$STAGE/scripts"
mkdir -p "$EXTRACTED" "$PAYLOAD" "$SCRIPTS"
unzip -q "$RUNTIME_ZIP" -d "$EXTRACTED"

RUNTIME_SRC="$EXTRACTED/yulu"
RUNTIME_DEST="$PAYLOAD/$RUNTIME_PREFIX"
if [[ ! -f "$RUNTIME_SRC/VERSION" || ! -f "$RUNTIME_SRC/yulu/scripts/setup.sh" ]]; then
    echo "Runtime zip has an invalid layout: $RUNTIME_ZIP" >&2
    exit 1
fi

mkdir -p "$(dirname "$RUNTIME_DEST")"
cp -R "$RUNTIME_SRC" "$RUNTIME_DEST"

APP_SRC="$RUNTIME_DEST/$VISIBLE_APP_SOURCE"
APP_DEST="$PAYLOAD/$VISIBLE_APP_PREFIX"
if [[ ! -d "$APP_SRC" ]]; then
    echo "Visible app source missing in runtime: $VISIBLE_APP_SOURCE" >&2
    exit 1
fi
mkdir -p "$(dirname "$APP_DEST")"
cp -R "$APP_SRC" "$APP_DEST"
rm -rf "$APP_SRC"

# pkgbuild can preserve macOS AppleDouble sidecar records when copied trees
# carry extended metadata. They are not part of Yulu's runtime contract.
xattr -cr "$PAYLOAD" 2>/dev/null || true
find "$PAYLOAD" -name '._*' -type f -exec rm -f {} +
cp "$PKG_SCRIPTS_SRC" "$SCRIPTS/postinstall"
chmod 0755 "$SCRIPTS/postinstall"

PKGBUILD_ARGS=(
    --root "$PAYLOAD"
    --scripts "$SCRIPTS"
    --identifier "$PKG_IDENTIFIER"
    --version "$VERSION"
    --install-location "/"
)

BASE_PKG="$STAGE/base.pkg"
EXPANDED_PKG="$STAGE/expanded-pkg"
CLEAN_PKG="$STAGE/clean.pkg"

write_clean_payload() {
    local root="$1"
    local output="$2"
    (
        cd "$root"
        find . -print | LC_ALL=C sort | cpio -o --format odc 2>/dev/null
    ) | gzip -n -c > "$output"
}

rewrite_package_payload_metadata() {
    local package_info="$1"
    local payload_count payload_kbytes
    payload_count="$(find "$PAYLOAD" -print | wc -l | tr -d '[:space:]')"
    payload_kbytes="$(du -sk "$PAYLOAD" | awk '{print $1}')"
    PAYLOAD_COUNT="$payload_count" PAYLOAD_KBYTES="$payload_kbytes" perl -0pi -e \
        's/<payload numberOfFiles="\d+" installKBytes="\d+"\/>/<payload numberOfFiles="$ENV{PAYLOAD_COUNT}" installKBytes="$ENV{PAYLOAD_KBYTES}"\/>/g' \
        "$package_info"
}

rm -f "$PKG_PATH" "$BASE_PKG" "$CLEAN_PKG"
pkgbuild "${PKGBUILD_ARGS[@]}" "$BASE_PKG"

pkgutil --expand "$BASE_PKG" "$EXPANDED_PKG"
mkbom "$PAYLOAD" "$EXPANDED_PKG/Bom"
write_clean_payload "$PAYLOAD" "$EXPANDED_PKG/Payload"
rewrite_package_payload_metadata "$EXPANDED_PKG/PackageInfo"
pkgutil --flatten "$EXPANDED_PKG" "$CLEAN_PKG"

if [[ -n "$PKG_SIGN_IDENTITY" ]]; then
    productsign --sign "$PKG_SIGN_IDENTITY" "$CLEAN_PKG" "$PKG_PATH"
else
    mv -f "$CLEAN_PKG" "$PKG_PATH"
fi

echo "$PKG_PATH"
