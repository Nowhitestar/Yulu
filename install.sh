#!/usr/bin/env bash
#
# Yulu — one-line installer
#
# What it does:
#   1. Sanity-check macOS, Python, and Xcode CLI tools.
#   2. Download the release installer helper.
#   3. Hand off to the helper to install the selected Yulu release asset.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --version v0.5.0
#   curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --dev

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.yulu}"
HELPER_URL="https://raw.githubusercontent.com/Nowhitestar/Yulu/main/yulu/scripts/release_installer.py"

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
            TARGET_ARGS=(--version "$2")
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
ok "macOS $(sw_vers -productVersion)"

if ! command -v python3 &>/dev/null; then
    err "python3 is required. Install Python 3 and retry."
    exit 1
fi
ok "python3 $(python3 --version | awk '{print $2}')"

# Xcode Command Line Tools are needed by setup for Swift and system tooling.
# `xcode-select -p` exits 2 if no developer dir is set.
if ! xcode-select -p &>/dev/null; then
    warn "Xcode Command Line Tools not installed."
    echo "Triggering installation now — a macOS dialog will appear."
    echo "Click 'Install', wait ~5 minutes, then re-run this command."
    xcode-select --install || true
    exit 1
fi
ok "Xcode Command Line Tools at $(xcode-select -p)"

if ((${#TARGET_ARGS[@]} > 0)) && [[ "${TARGET_ARGS[0]}" == "--dev" ]] && ! command -v git &>/dev/null; then
    err "git is required for --dev installs. Install Xcode CLI Tools or git and retry."
    exit 1
fi

# ─── Download helper ──────────────────────────────────────────────

header "Fetching installer"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yulu-installer.XXXXXX")"
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

HELPER="$TMP_DIR/release_installer.py"
if command -v curl &>/dev/null; then
    if ! curl -fsSL "$HELPER_URL" -o "$HELPER"; then
        err "Failed to download installer helper from $HELPER_URL"
        exit 1
    fi
else
    warn "curl not found; downloading with python3 urllib."
    if ! python3 - "$HELPER_URL" "$HELPER" <<'PY'
import sys
import urllib.request

url, output = sys.argv[1], sys.argv[2]
request = urllib.request.Request(url, headers={"User-Agent": "YuluInstaller"})
with urllib.request.urlopen(request, timeout=30) as response:
    data = response.read()
with open(output, "wb") as handle:
    handle.write(data)
PY
    then
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
