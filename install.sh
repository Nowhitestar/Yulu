#!/usr/bin/env bash
#
# Yulu — one-line installer
#
# What it does:
#   1. Sanity-check macOS, git, Xcode CLI tools.
#   2. Clone (or fast-forward) the repo at ~/.yulu (a stable, predictable path —
#      no matter where the user was when they ran this command).
#   3. Hand off to yulu/scripts/setup.sh which handles deps, codesigning,
#      whisper model, TCC walkthrough, OAuth, LaunchAgents, agent skill, etc.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash
#
# Re-running this is safe: it pulls the latest code and re-runs setup in
# upgrade mode (idempotent — won't re-download the whisper model, won't
# re-prompt for TCC if already granted, won't redo OAuth).

set -euo pipefail

REPO_URL="https://github.com/Nowhitestar/Yulu.git"
INSTALL_DIR="$HOME/.yulu"
BRANCH="main"

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

# ─── Pre-flight ───────────────────────────────────────────────────

header "Yulu one-line installer"
echo "Repo:    $REPO_URL"
echo "Install: $INSTALL_DIR"
echo

if [[ "$(uname -s)" != "Darwin" ]]; then
    err "Yulu is macOS-only. Got: $(uname -s)"
    exit 1
fi
ok "macOS $(sw_vers -productVersion)"

# Xcode Command Line Tools (needed for swiftc, git, /usr/bin/clang).
# `xcode-select -p` exits 2 if no developer dir is set.
if ! xcode-select -p &>/dev/null; then
    warn "Xcode Command Line Tools not installed."
    echo "Triggering installation now — a macOS dialog will appear."
    echo "Click 'Install', wait ~5 minutes, then re-run this command."
    xcode-select --install || true
    exit 1
fi
ok "Xcode Command Line Tools at $(xcode-select -p)"

if ! command -v git &>/dev/null; then
    err "git is missing (Xcode CLI Tools should provide it). Install Xcode CLI Tools and retry."
    exit 1
fi
ok "git $(git --version | awk '{print $3}')"

# ─── Clone or update the repo ────────────────────────────────────

header "Fetching Yulu"

mkdir -p "$INSTALL_DIR"

if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Existing checkout at $INSTALL_DIR — updating"
    git -C "$INSTALL_DIR" fetch --quiet origin
    if git -C "$INSTALL_DIR" diff --quiet HEAD -- && git -C "$INSTALL_DIR" diff --quiet --cached; then
        git -C "$INSTALL_DIR" checkout --quiet "$BRANCH"
        if ! git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"; then
            err "Couldn't fast-forward — your local clone has diverged."
            echo "Resolve manually in $INSTALL_DIR or remove it and re-run this installer."
            exit 1
        fi
        ok "Updated to $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
    else
        warn "Local changes detected in $INSTALL_DIR — leaving them alone."
        echo "Stash or commit them, then re-run."
        exit 1
    fi
elif [[ -e "$INSTALL_DIR" && "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
    err "$INSTALL_DIR exists and isn't a Yulu git checkout."
    echo "Move it aside or delete it, then re-run."
    exit 1
else
    info "Cloning $REPO_URL → $INSTALL_DIR"
    git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    ok "Cloned $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
fi

# ─── Hand off to setup.sh ────────────────────────────────────────

SETUP="$INSTALL_DIR/yulu/scripts/setup.sh"
if [[ ! -x "$SETUP" ]]; then
    chmod +x "$SETUP" 2>/dev/null || true
fi

# Decide whether this is a fresh install or an upgrade.
# Heuristic: if any yulu launchd plist already exists, treat as upgrade.
SETUP_ARGS=()
if compgen -G "$HOME/Library/LaunchAgents/com.yulu.*.plist" > /dev/null; then
    info "Detected existing Yulu installation — running setup in --upgrade mode"
    SETUP_ARGS+=(--upgrade)
else
    info "Fresh install — running setup interactively"
fi

# install.sh is typically invoked via `curl | bash`, which means stdin is the
# curl pipe, not the user's terminal. setup.sh reads from stdin for prompts,
# so we want to redirect from /dev/tty when one is actually available — but
# `[[ -e /dev/tty ]]` is not enough: the file node can exist while the device
# is "not configured" (CI runners, certain non-interactive shells). Try to
# open it for real before relying on it.
if [[ -t 0 ]]; then
    # stdin is already a tty — user ran the script directly. Pass through.
    bash "$SETUP" "${SETUP_ARGS[@]}"
elif (exec 3</dev/tty) 2>/dev/null; then
    # stdin is a pipe (curl|bash) but /dev/tty is openable. Redirect.
    bash "$SETUP" "${SETUP_ARGS[@]}" < /dev/tty
else
    # Truly non-interactive (CI, sandboxed agent, certain SSH sessions).
    # setup.sh's `read` calls will see EOF and fall through to defaults.
    warn "No interactive terminal available — setup.sh will run non-interactively."
    bash "$SETUP" "${SETUP_ARGS[@]}" < /dev/null
fi

header "Done"
echo "Yulu lives at: $INSTALL_DIR"
echo "Update later with:  yulu update"
echo "Uninstall with:     yulu uninstall"
echo "More:               https://github.com/Nowhitestar/Yulu"
