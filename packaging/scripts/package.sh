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
fi

if [[ "$SKIP_BUILD" != true ]]; then
    if [[ -x "$ROOT/yulu/scripts/build_audio_daemon.sh" ]]; then
        bash "$ROOT/yulu/scripts/build_audio_daemon.sh"
    fi
    if [[ -x "$ROOT/yulu/scripts/build_status_agent.sh" ]]; then
        bash "$ROOT/yulu/scripts/build_status_agent.sh"
    fi
fi

DIST_ABS="$(mkdir -p "$DIST" && cd "$DIST" && pwd)"
ZIP_PATH="$DIST_ABS/yulu-macos-arm64-$TAG.zip"
INSTALL_ASSET="$DIST_ABS/install.sh"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/yulu-package.XXXXXX")"

cleanup() {
    rm -rf "$STAGE"
}
trap cleanup EXIT

mkdir -p "$STAGE/yulu"

if command -v rsync >/dev/null 2>&1; then
    rsync -a \
        --exclude '.git/' \
        --exclude '.github/' \
        --exclude '.omc/' \
        --exclude '.claude/' \
        --exclude 'dist/' \
        --exclude '.ci-build/' \
        --exclude '.venv*/' \
        --exclude 'venv/' \
        --exclude '__pycache__/' \
        --exclude '.pytest_cache/' \
        --exclude '.mypy_cache/' \
        --exclude '.ruff_cache/' \
        --exclude '.DS_Store' \
        --exclude 'tests/' \
        --exclude 'docs/superpowers/' \
        --exclude 'packaging/' \
        --exclude 'worktrees/' \
        --exclude '*.log' \
        --exclude '*.pid' \
        --exclude '*.sock' \
        --exclude 'client_secret*.json' \
        --exclude '*token*.json' \
        "$ROOT/" "$STAGE/yulu/"
else
    (cd "$ROOT" && tar \
        --exclude './.git' \
        --exclude './.github' \
        --exclude './.omc' \
        --exclude './.claude' \
        --exclude './dist' \
        --exclude './.ci-build' \
        --exclude './.venv*' \
        --exclude './venv' \
        --exclude './__pycache__' \
        --exclude './.pytest_cache' \
        --exclude './.mypy_cache' \
        --exclude './.ruff_cache' \
        --exclude './tests' \
        --exclude './docs/superpowers' \
        --exclude './packaging' \
        --exclude './worktrees' \
        -cf - .) | (cd "$STAGE/yulu" && tar -xf -)
fi

if [[ -f "$ROOT/install.sh" ]]; then
    cp "$ROOT/install.sh" "$INSTALL_ASSET"
fi

rm -f "$ZIP_PATH"
(cd "$STAGE" && find yulu -type f -exec touch -t 202001010000 {} +)
(cd "$STAGE" && find yulu -type d -exec touch -t 202001010000 {} +)
(cd "$STAGE" && find yulu -print | LC_ALL=C sort | zip -X -q "$ZIP_PATH" -@)

echo "$ZIP_PATH"
