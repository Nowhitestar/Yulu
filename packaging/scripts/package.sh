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
EXCLUDES=(
    ".git"
    ".github"
    ".omc"
    ".claude"
    "dist"
    ".ci-build"
    ".venv*"
    "venv"
    "__pycache__"
    ".pytest_cache"
    ".mypy_cache"
    ".ruff_cache"
    ".DS_Store"
    "tests"
    "docs/superpowers"
    "packaging"
    "worktrees"
    "*.log"
    "*.pid"
    "*.sock"
    "client_secret*.json"
    "*token*.json"
    "secrets"
    "tokens"
    ".env"
    ".env.*"
)
ALLOWED_BUILD_OUTPUTS=(
    "yulu/scripts/StatusAgent.app/Contents/Info.plist"
    "yulu/scripts/StatusAgent.app/Contents/MacOS/status_agent"
    "yulu/scripts/Yulu.app/Contents/Info.plist"
    "yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon"
)

rsync_exclude_args() {
    local pattern
    for pattern in "${EXCLUDES[@]}"; do
        printf '%s\n' "--exclude=$pattern"
    done
}

tar_exclude_args() {
    local pattern
    for pattern in "${EXCLUDES[@]}"; do
        printf '%s\n' "--exclude=$pattern"
        printf '%s\n' "--exclude=./$pattern"
    done
}

is_allowed_build_output() {
    local candidate="$1"
    local allowed
    for allowed in "${ALLOWED_BUILD_OUTPUTS[@]}"; do
        if [[ "$candidate" == "$allowed" ]]; then
            return 0
        fi
    done
    return 1
}

check_clean_worktree() {
    local phase="$1"
    if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        return 0
    fi

    local dirty
    dirty="$(git -C "$ROOT" status --porcelain)"
    if [[ -z "$dirty" ]]; then
        return 0
    fi

    local unexpected=()
    local line path
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        path="${line:3}"
        if [[ "$phase" == "after build" ]] && is_allowed_build_output "$path"; then
            continue
        fi
        unexpected+=("$line")
    done <<< "$dirty"

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
    check_clean_worktree "before build"
    if [[ -x "$ROOT/yulu/scripts/build_audio_daemon.sh" ]]; then
        bash "$ROOT/yulu/scripts/build_audio_daemon.sh"
    fi
    if [[ -x "$ROOT/yulu/scripts/build_status_agent.sh" ]]; then
        bash "$ROOT/yulu/scripts/build_status_agent.sh"
    fi
    check_clean_worktree "after build"
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
    RSYNC_ARGS=(-a)
    while IFS= read -r arg; do
        RSYNC_ARGS+=("$arg")
    done < <(rsync_exclude_args)
    rsync "${RSYNC_ARGS[@]}" "$ROOT/" "$STAGE/yulu/"
else
    TAR_ARGS=()
    while IFS= read -r arg; do
        TAR_ARGS+=("$arg")
    done < <(tar_exclude_args)
    (cd "$ROOT" && tar "${TAR_ARGS[@]}" -cf - .) | (cd "$STAGE/yulu" && tar -xf -)
fi

if [[ -f "$ROOT/install.sh" ]]; then
    cp "$ROOT/install.sh" "$INSTALL_ASSET"
fi

rm -f "$ZIP_PATH"
(cd "$STAGE" && find yulu -type f -exec touch -t 202001010000 {} +)
(cd "$STAGE" && find yulu -type d -exec touch -t 202001010000 {} +)
# Belt-and-suspenders: re-assert +x on every git-executable file in the staged
# tree so the packaged zip carries correct modes even if the source checkout's
# permission bits have drifted. zip stores these in external_attr; chmod only
# touches the mode, not mtime, so the reproducible timestamps above stay intact.
while IFS= read -r _exe; do
    [[ -n "$_exe" && -f "$STAGE/yulu/$_exe" ]] && chmod +x "$STAGE/yulu/$_exe"
done < <(git -C "$ROOT" ls-files --stage 2>/dev/null | awk '$1=="100755"{print $4}')
(cd "$STAGE" && find yulu -print | LC_ALL=C sort | zip -X -q "$ZIP_PATH" -@)

echo "$ZIP_PATH"
