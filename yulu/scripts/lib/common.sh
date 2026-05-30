#!/usr/bin/env bash
#
# lib/common.sh — shared helpers for the decomposed setup_*.sh concern scripts.
#
# Sourced by setup_deps.sh / setup_models.sh / setup_ui.sh (and, in later plans,
# setup_audio.sh / setup_capabilities.sh / setup_daemons.sh / the setup.sh
# orchestrator). Provides:
#   1. printf-based color + log helpers (ok/warn/err/info/header/prompt)
#   2. launch_path        — the §6b stable launch PATH (NO nvm-versioned literal)
#   3. install_plist      — the §8c de-duplication target (one canonical copy)
#   4. resolve_install_mode / detect_source — the D-13 dev/release fork reader
#
# Sourcing this file is side-effect-free: it only defines functions + color vars.
#
# shellcheck source=lib/common.sh
set -uo pipefail

# ─── 1. Colors + log helpers ─────────────────────────────────────────
# printf-based (adopted from the `yulu` CLI, safer than `echo -e`).
# Guard against double-definition when multiple concern scripts source us.
if [[ -z "${YULU_COMMON_SH_LOADED:-}" ]]; then
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    RED='\033[0;31m'
    BLUE='\033[0;34m'
    NC='\033[0m' # No Color
fi

# Colors live outside the printf format string (shellcheck SC2059) — pass them
# as %s arguments so an accidental `%` in a color var can never be interpreted.
ok()   { printf '%b✓%b %s\n' "$GREEN" "$NC" "$1"; }
warn() { printf '%b⚠%b %s\n' "$YELLOW" "$NC" "$1"; }
err()  { printf '%b✗%b %s\n' "$RED" "$NC" "$1"; }
info() { printf '%bℹ%b %s\n' "$BLUE" "$NC" "$1"; }

header() {
    local bar='━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    printf '\n'
    printf '%b%s%b\n' "$BLUE" "$bar" "$NC"
    printf '%b  %s%b\n' "$BLUE" "$1" "$NC"
    printf '%b%s%b\n' "$BLUE" "$bar" "$NC"
}

prompt() { printf '%b➡️%b %s ' "$YELLOW" "$NC" "$1"; }

# ─── 2. launch_path — stable PATH for launchd plists (§6b fix) ────────
# Ports dev_install.py::_launch_path (lines 86-99) to bash. The monolith
# (setup.sh:852) baked an nvm-VERSIONED node path — `$(node -v)` — straight
# into the plist __PATH__ at install time, so a later `nvm install` /
# uninstall left the LaunchAgent pointing at a node that no longer exists
# (and is attacker-influenceable). Here we hardcode a stable, well-known
# prefix order and only GLOB the highest-sorted nvm node dir if present —
# never a literal version string.
#
# Echoes the assembled PATH on stdout; de-dupes entries (first wins).
launch_path() {
    local -a parts=(
        "$HOME/.local/bin"
        "/opt/homebrew/bin"
        "/usr/local/bin"
        "/usr/bin"
        "/bin"
    )

    # Optionally insert the highest-sorted ~/.nvm/versions/node/*/bin (glob,
    # NOT a baked `$(node -v)` literal) right after ~/.local/bin, mirroring
    # dev_install.py's parts.insert(1, ...).
    local nvm_root="$HOME/.nvm/versions/node"
    if [[ -d "$nvm_root" ]]; then
        # Collect matching dirs via a glob (shellcheck SC2012: no `ls`), guard
        # against the literal-glob-when-no-match case, then reverse-sort so the
        # newest version directory wins.
        local -a nvm_bins=()
        local g
        for g in "$nvm_root"/*/bin; do
            [[ -d "$g" ]] && nvm_bins+=("$g")
        done
        if (( ${#nvm_bins[@]} > 0 )); then
            local -a sorted_bins=()
            local line
            while IFS= read -r line; do
                sorted_bins+=("$line")
            done < <(printf '%s\n' "${nvm_bins[@]}" | sort -r)
            parts=("${parts[0]}" "${sorted_bins[0]}" "${parts[@]:1}")
        fi
    fi

    # De-dupe while preserving order (first occurrence wins).
    local -a seen=()
    local out="" p existing dup
    for p in "${parts[@]}"; do
        dup=false
        for existing in "${seen[@]}"; do
            [[ "$existing" == "$p" ]] && { dup=true; break; }
        done
        [[ "$dup" == true ]] && continue
        seen+=("$p")
        if [[ -z "$out" ]]; then out="$p"; else out="$out:$p"; fi
    done
    printf '%s' "$out"
}

# ─── 3. install_plist — hoisted canonical copy (§8c de-dup, D-14) ────
# Lifted from setup.sh::install_launchagents (841-869), which ALSO had an
# inline duplicate in install_yulu_ui (1079-1088). This is the single
# canonical copy.
#
# Inputs are taken explicitly (args/env), NOT shared globals (Pitfall 5):
#   $1 src   — path to the com.yulu.*.plist template
#   $2 name  — destination plist filename (e.g. com.yulu.ui.plist)
# Env (each falls back so `set -u` standalone callers don't crash):
#   PYTHON_BIN, NODE_BIN, SCRIPT_DIR, LAUNCH_AGENTS_DIR
#
# Substitutes the five fixed plist tokens. __PATH__ uses launch_path (§6b),
# never a baked nvm version. Tokens absent from a given template (e.g.
# com.yulu.audiodaemon.plist has no __PATH__/__PYTHON__ — it's `open -W
# Yulu.app`, the §8b form Phase 2 owns) are simply left untouched by sed;
# this helper substitutes only the tokens present and MUST NOT regress §8b.
install_plist() {
    local src="$1"
    local name="$2"

    local launch_agents_dir="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
    local python_bin="${PYTHON_BIN:-$(command -v python3 || echo /usr/bin/python3)}"
    local node_bin="${NODE_BIN:-$(command -v node || echo /usr/local/bin/node)}"
    local script_dir="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
    local dest="$launch_agents_dir/$name"

    if [[ ! -f "$src" ]]; then
        warn "$name: 模板不存在于 $src，跳过"
        return 1
    fi

    if [[ -f "$dest" ]]; then
        launchctl unload "$dest" 2>/dev/null || true
    fi

    cp "$src" "$dest"

    # §6b fix: stable PATH from launch_path, NOT an nvm-versioned literal.
    local lp
    lp="$(launch_path)"

    sed -i '' \
        -e "s|__PYTHON__|$python_bin|g" \
        -e "s|__NODE_BIN__|$node_bin|g" \
        -e "s|__HOME__|$HOME|g" \
        -e "s|__SCRIPT_DIR__|$script_dir|g" \
        -e "s|__PATH__|$lp|g" \
        "$dest" 2>/dev/null || true

    ok "$name: 已复制"
}

# ─── 4. Source detection for the dev/release fork (D-13 plumbing) ─────
# Reads the `source` field of .yulu-install.json (written by
# release_installer.py as either "dev" or "release") via the inline-python3
# idiom from the `yulu` CLI (176-184). Pure reader — no side effects.
#
# Usage: src="$(detect_source [repo_dir])"
# Returns "release" when .yulu-install.json source=="release", else "dev"
# (missing file in a dev checkout defaults to "dev").
detect_source() {
    local repo_dir="${1:-${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}}"
    local py="${PYTHON_BIN:-$(command -v python3 || echo /usr/bin/python3)}"
    "$py" -c "import json,pathlib; print(json.loads(pathlib.Path('$repo_dir/.yulu-install.json').read_text()).get('source','dev'))" 2>/dev/null || echo dev
}

# resolve_install_mode — the orchestrator-facing resolver (D-12/D-13).
# Honors an explicit `--dev` flag (anywhere in "$@") as an override, otherwise
# falls back to the .yulu-install.json source field. Echoes "release" or "dev".
#
# Standalone concern scripts call this to normalize ${1:-release} too, but the
# orchestrator (plan 01-05) is the primary caller that resolves mode once and
# passes it down to each setup_*.sh.
resolve_install_mode() {
    local arg
    for arg in "$@"; do
        case "$arg" in
            --dev) printf 'dev'; return 0 ;;
        esac
    done

    local src
    src="$(detect_source)"
    if [[ "$src" == "release" ]]; then
        printf 'release'
    else
        printf 'dev'
    fi
}

# Mark loaded so re-sources don't re-declare readonly-ish color vars.
YULU_COMMON_SH_LOADED=1
