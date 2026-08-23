#!/usr/bin/env bash
#
# Yulu — one-line installer
#
# What it does:
#   1. Sanity-check macOS, Python, and Xcode CLI tools.
#   2. Enter the selected GitHub Release installer (or explicit dev helper).
#   3. Install the selected Yulu runtime.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --version v0.5.0
#   curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --dev

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.yulu}"
HELPER_URL="https://raw.githubusercontent.com/Nowhitestar/Yulu/main/yulu/scripts/release_installer.py"
# package.sh replaces both sentinels in the versioned release asset. The raw-main
# bootstrap leaves them untouched and forwards stable installs to a Release asset.
EMBEDDED_HELPER_BASE64="__YULU_EMBEDDED_RELEASE_INSTALLER_BASE64__"
PACKAGED_RELEASE_TAG="__YULU_PACKAGED_RELEASE_TAG__"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

ok()    { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
err()   { printf "${RED}✗${NC} %s\n" "$1"; }
info()  { printf "${BLUE}ℹ${NC} %s\n" "$1"; }
header(){ printf "\n${BLUE}━━━ %s ━━━${NC}\n" "$1"; }

normalize_release_tag() {
    local tag="$1"
    [[ "$tag" == v* ]] || tag="v$tag"
    if [[ ! "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
        printf '%s is not a valid SemVer release tag\n' "$1" >&2
        return 2
    fi
    local prerelease="${tag%%+*}"
    if [[ "$prerelease" == *-* ]]; then
        prerelease="${prerelease#*-}"
        local identifier
        while IFS= read -r identifier; do
            if [[ "$identifier" =~ ^[0-9]+$ && "$identifier" != "0" && "$identifier" == 0* ]]; then
                printf '%s is not a valid SemVer release tag\n' "$1" >&2
                return 2
            fi
        done < <(tr '.' '\n' <<< "$prerelease")
    fi
    printf '%s\n' "$tag"
}

usage() {
    cat <<'EOF'
Yulu one-line installer

Usage:
  install.sh [--latest | --version vX.Y.Z | --dev] [--help]

Options:
  --latest          Install the latest stable release. This is the default.
  --version vX.Y.Z  Install a specific stable release tag.
  --dev             Install/update from the development channel.
  --help            Show this help.

Environment:
  INSTALL_DIR       Install location. Defaults to ~/.yulu.
EOF
}

TARGET_ARGS=()
TARGET_COUNT=0

while (($# > 0)); do
    case "$1" in
        --latest)
            TARGET_ARGS=(--latest)
            TARGET_COUNT=$((TARGET_COUNT + 1))
            shift
            ;;
        --version)
            if (($# < 2)); then
                err "--version requires a value like v0.5.0"
                exit 2
            fi
            if [[ -z "$2" || "$2" == --* ]]; then
                err "--version requires a value like v0.5.0"
                exit 2
            fi
            TARGET_ARGS=(--version "$(normalize_release_tag "$2")")
            TARGET_COUNT=$((TARGET_COUNT + 1))
            shift 2
            ;;
        --dev)
            TARGET_ARGS=(--dev)
            TARGET_COUNT=$((TARGET_COUNT + 1))
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            err "Unknown argument: $1"
            echo
            usage
            exit 2
            ;;
    esac

    if ((TARGET_COUNT > 1)); then
        err "Choose only one of --latest, --version, or --dev."
        exit 2
    fi
done

if [[ "$PACKAGED_RELEASE_TAG" != __YULU_PACKAGED_* ]]; then
    PACKAGED_RELEASE_TAG="$(normalize_release_tag "$PACKAGED_RELEASE_TAG")"
    if ((${#TARGET_ARGS[@]} == 0)) || [[ "${TARGET_ARGS[0]}" == "--latest" ]]; then
        TARGET_ARGS=(--version "$PACKAGED_RELEASE_TAG")
    elif [[ "${TARGET_ARGS[0]}" == "--version" && "${TARGET_ARGS[1]}" != "$PACKAGED_RELEASE_TAG" ]]; then
        printf 'Requested release %s does not match packaged release %s\n' "${TARGET_ARGS[1]}" "$PACKAGED_RELEASE_TAG" >&2
        exit 2
    fi
fi

# ─── Pre-flight ───────────────────────────────────────────────────

header "Yulu one-line installer"
echo "Install: $INSTALL_DIR"
if ((${#TARGET_ARGS[@]} == 0)); then
    echo "Target:  latest stable"
else
    echo "Target:  ${TARGET_ARGS[*]}"
fi
echo

if [[ "$(uname -s)" != "Darwin" ]]; then
    err "Yulu is macOS-only. Got: $(uname -s)"
    exit 1
fi
MACOS_VERSION="$(sw_vers -productVersion)"
MACOS_MAJOR="${MACOS_VERSION%%.*}"
if [[ ! "$MACOS_MAJOR" =~ ^[0-9]+$ || "$MACOS_MAJOR" -lt 13 ]]; then
    err "Yulu requires macOS 13 or newer. Got: $MACOS_VERSION"
    exit 1
fi
ok "macOS $MACOS_VERSION"

# Official release assets contain arm64 native bundles. A shell running under
# Rosetta reports x86_64 even on Apple Silicon, so prefer the hardware capability
# bit and fall back to uname only when sysctl is unavailable. Dev installs build
# locally and therefore keep their existing architecture behavior.
if ! (( ${#TARGET_ARGS[@]} > 0 )) || [[ "${TARGET_ARGS[0]}" != "--dev" ]]; then
    ARM64_CAPABLE="$(sysctl -n hw.optional.arm64 2>/dev/null || true)"
    if [[ "$ARM64_CAPABLE" != "1" && "$(uname -m)" != "arm64" ]]; then
        err "Official Yulu release assets require an Apple Silicon (arm64) Mac."
        err "This Mac reports architecture: $(uname -m)"
        exit 1
    fi
    ok "Apple Silicon release architecture"
fi

if ! command -v python3 &>/dev/null; then
    err "python3 is required. Install Python 3 and retry."
    exit 1
fi
if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    err "Python 3.10 or newer is required. Install a current Python 3 and retry."
    exit 1
fi
ok "python3 $(python3 --version | awk '{print $2}')"

# Xcode Command Line Tools (swiftc) are needed only by the --dev fork, which
# compiles Yulu.app / StatusAgent.app from source (build_audio_daemon.sh +
# build_status_agent.sh). A RELEASE install ships pre-built, signed, notarized +
# stapled binaries and needs no compiler — so the Xcode pre-flight is gated on
# --dev (BUILD-03 / Pitfall 6), mirroring the --dev-gated git check below.
# `xcode-select -p` exits 2 if no developer dir is set.
if ((${#TARGET_ARGS[@]} > 0)) && [[ "${TARGET_ARGS[0]}" == "--dev" ]]; then
    if ! xcode-select -p &>/dev/null; then
        warn "Xcode Command Line Tools not installed (required for --dev source builds)."
        echo "Triggering installation now — a macOS dialog will appear."
        echo "Click 'Install', wait ~5 minutes, then re-run this command."
        xcode-select --install || true
        exit 1
    fi
    ok "Xcode Command Line Tools at $(xcode-select -p)"

    if ! command -v git &>/dev/null; then
        err "git is required for --dev installs. Install Xcode CLI Tools or git and retry."
        exit 1
    fi
fi

# ─── Download helper ──────────────────────────────────────────────

header "Fetching installer"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yulu-installer.XXXXXX")"
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

HELPER="$TMP_DIR/release_installer.py"

download_file() {
    local url="$1"
    local output="$2"
    if command -v curl &>/dev/null; then
        curl -fsSL "$url" -o "$output"
        return
    fi
    warn "curl not found; downloading with python3 urllib."
    python3 - "$url" "$output" <<'PY'
import sys
import urllib.request

url, output = sys.argv[1], sys.argv[2]
request = urllib.request.Request(url, headers={"User-Agent": "YuluInstaller"})
with urllib.request.urlopen(request, timeout=30) as response:
    data = response.read()
with open(output, "wb") as handle:
    handle.write(data)
PY
}

if [[ "$EMBEDDED_HELPER_BASE64" == __YULU_EMBEDDED_* ]] && \
   { ((${#TARGET_ARGS[@]} == 0)) || [[ "${TARGET_ARGS[0]}" != "--dev" ]]; }; then
    RELEASE_INSTALLER="$TMP_DIR/install.sh"
    if ((${#TARGET_ARGS[@]} > 0)) && [[ "${TARGET_ARGS[0]}" == "--version" ]]; then
        RELEASE_INSTALLER_URL="https://github.com/Nowhitestar/Yulu/releases/download/${TARGET_ARGS[1]}/install.sh"
    else
        RELEASE_INSTALLER_URL="https://github.com/Nowhitestar/Yulu/releases/latest/download/install.sh"
    fi
    if ! download_file "$RELEASE_INSTALLER_URL" "$RELEASE_INSTALLER"; then
        err "Failed to download release installer from $RELEASE_INSTALLER_URL"
        exit 1
    fi
    if [[ ! -s "$RELEASE_INSTALLER" ]]; then
        err "Downloaded release installer is empty: $RELEASE_INSTALLER_URL"
        exit 1
    fi
    ok "Release installer downloaded"
    INSTALL_DIR="$INSTALL_DIR" bash "$RELEASE_INSTALLER" "${TARGET_ARGS[@]}"
    exit $?
fi

if [[ "$EMBEDDED_HELPER_BASE64" != __YULU_EMBEDDED_* ]]; then
    if ! printf '%s' "$EMBEDDED_HELPER_BASE64" | base64 --decode > "$HELPER"; then
        err "Failed to unpack the embedded release installer helper."
        exit 1
    fi
    ok "Using installer helper embedded in this release asset"
else
    if ! download_file "$HELPER_URL" "$HELPER"; then
        err "Failed to download installer helper from $HELPER_URL"
        exit 1
    fi
fi
if [[ ! -s "$HELPER" ]]; then
    err "Downloaded installer helper is empty: $HELPER_URL"
    exit 1
fi
ok "Installer helper downloaded"

python3 -m py_compile "$HELPER"
ok "Installer helper validated"

# ─── Hand off ────────────────────────────────────────────────────

header "Installing Yulu"

INSTALL_CMD=(python3 "$HELPER" install --install-dir "$INSTALL_DIR" "${TARGET_ARGS[@]}")
if [[ -t 0 ]]; then
    "${INSTALL_CMD[@]}"
elif (exec 3</dev/tty) 2>/dev/null; then
    "${INSTALL_CMD[@]}" < /dev/tty
else
    warn "No interactive terminal available — setup will run non-interactively."
    "${INSTALL_CMD[@]}" < /dev/null
fi

if [[ ! -d "$INSTALL_DIR" ]]; then
    err "Install did not create $INSTALL_DIR"
    exit 1
fi
if [[ ! -f "$INSTALL_DIR/VERSION" ]]; then
    err "Install completed but VERSION is missing in $INSTALL_DIR"
    exit 1
fi
if [[ ! -f "$INSTALL_DIR/yulu/scripts/setup.sh" && ! -f "$INSTALL_DIR/yulu/scripts/yulu" ]]; then
    err "Install completed but runtime scripts are missing in $INSTALL_DIR/yulu/scripts"
    exit 1
fi

header "Done"
echo "Yulu is ready at:   $INSTALL_DIR"
echo "Uninstall with:     yulu uninstall"
