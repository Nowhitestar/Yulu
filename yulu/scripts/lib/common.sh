#!/usr/bin/env bash
#
# lib/common.sh — shared helpers for the decomposed setup_*.sh concern scripts.
#
# Sourced by setup_deps.sh / setup_ui.sh (and
# setup_audio.sh / setup_daemons.sh / the setup.sh
# orchestrator). Provides:
#   1. printf-based color + log helpers (ok/warn/err/info/header/prompt)
#   2. Node runtime selection shared by dependency + UI setup
#   3. launch_path        — selected Node first, then stable system fallbacks
#   4. install_plist      — the §8c de-duplication target (one canonical copy)
#   5. resolve_install_mode / detect_source — the D-13 dev/release fork reader
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

# ─── 1b. capability_status — read one capability's tri-state from the report ──
# Host capability lookup used by setup_deps.sh.
#
# Runs `doctor.py --json` with FIXED argv and parses
# `host_capabilities.capabilities.<cap>.status` in Python (T-05-04). It echoes ONLY
# the tri-state status string — it NEVER interpolates a capability's resolved_path
# into a shell command (the probes.py T-03-02 discipline: resolve-not-execute is
# preserved; llm.command is never run). On ANY failure (no doctor, malformed JSON,
# missing key) it echoes `absent` — the SAFE default, which means "install Yulu's own"
# (a slow/broken doctor degrades to install, never to over-skip; T-05-06).
#
# Callers MUST gate STRICTLY on `== "usable"` (Pitfall 4 / report.py:35): the tri-state
# is never collapsed to a boolean. `present-but-unverified` and `absent` both install.
#
# Usage: status="$(capability_status gog)"
capability_status() {
    local cap="$1"
    local py="${PYTHON_BIN:-$(command -v python3 || echo /usr/bin/python3)}"
    local script_dir="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
    "$py" "$script_dir/doctor.py" --json 2>/dev/null \
        | "$py" -c 'import sys, json
try:
    r = json.load(sys.stdin)
    print(r.get("host_capabilities", {}).get("capabilities", {}).get(sys.argv[1], {}).get("status", "absent"))
except Exception:
    print("absent")' "$cap" 2>/dev/null \
        || echo "absent"
}

# ─── 2. Node runtime policy + selection ──────────────────────────────
# Vite 8 requires Node 20.19+ or 22.12+. Yulu additionally keeps the Host on
# even-numbered LTS lines through Node 24 because better-sqlite3 is native.
node_version_supported() {
    local version="${1#v}"
    local major rest minor
    major="${version%%.*}"
    rest="${version#*.}"
    minor="${rest%%.*}"

    [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
    case "$major" in
        20) (( minor >= 19 )) ;;
        22) (( minor >= 12 )) ;;
        24) return 0 ;;
        *) return 1 ;;
    esac
}

compatible_node_bin() {
    local candidate version
    local candidates=()
    if [[ -n "${NODE_BIN:-}" ]]; then
        candidates+=("$NODE_BIN")
    fi
    if command -v node >/dev/null 2>&1; then
        candidates+=("$(command -v node)")
    fi
    candidates+=(
        "$HOME"/.nvm/versions/node/v20*/bin/node
        "$HOME"/.nvm/versions/node/v22*/bin/node
        "$HOME"/.nvm/versions/node/v24*/bin/node
        /opt/homebrew/opt/node@20/bin/node
        /opt/homebrew/opt/node@22/bin/node
        /opt/homebrew/opt/node@24/bin/node
        /usr/local/opt/node@20/bin/node
        /usr/local/opt/node@22/bin/node
        /usr/local/opt/node@24/bin/node
    )

    for candidate in "${candidates[@]}"; do
        [[ -x "$candidate" ]] || continue
        version="$("$candidate" -v 2>/dev/null)"
        if node_version_supported "$version"; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

# ─── 3. launch_path — Host-aligned PATH for launchd plists ───────────
# Mirrors dev_install.py::_launch_path: the selected Host Node directory comes
# first so /usr/bin/env node and npx children use the same runtime/ABI as the
# absolute ProgramArguments entry. Stable system prefixes follow; callers that
# have not selected a runtime get the highest available nvm bin as a fallback.
#
# Echoes the assembled PATH on stdout; de-dupes entries (first wins).
launch_path() {
    local selected_node="${1:-}"
    local -a parts=(
        "$HOME/.local/bin"
        "/opt/homebrew/bin"
        "/usr/local/bin"
        "/usr/bin"
        "/bin"
        "/usr/sbin"
        "/sbin"
    )

    # Keep child processes on the same Node runtime as the Host. The absolute
    # ProgramArguments path is stable for Homebrew's versioned node@24 keg; its
    # directory must also precede an unversioned/newer node on PATH.
    if [[ -n "$selected_node" ]]; then
        parts=("$(dirname "$selected_node")" "${parts[@]}")
    fi

    # Without an explicit selection, insert the highest-sorted nvm bin (glob,
    # NOT a baked `$(node -v)` literal) right after ~/.local/bin, mirroring
    # dev_install.py's fallback.
    local nvm_root="$HOME/.nvm/versions/node"
    if [[ -z "$selected_node" && -d "$nvm_root" ]]; then
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
            parts=("${sorted_bins[0]}" "${parts[@]}")
        fi
    fi

    # De-dupe while preserving order (first occurrence wins).
    local -a seen=()
    local out="" p existing dup
    for p in ${parts[@]+"${parts[@]}"}; do
        dup=false
        # `"${seen[@]}"` on an EMPTY array trips `set -u` ("unbound variable") on the
        # bash that CI/macOS uses (and the first iteration always sees it empty). The
        # `${arr[@]+"${arr[@]}"}` idiom expands to the elements only when set, nothing
        # when empty — set-u-safe across bash versions. (tests/test_setup_decomposition.py)
        for existing in ${seen[@]+"${seen[@]}"}; do
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
# Substitutes the five fixed plist tokens. __PATH__ uses launch_path (§6b) with
# the exact selected Node directory first. Tokens absent from a given template (e.g.
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
        warn "$name: 模板不存在于 ${src}，跳过"
        return 1
    fi

    mkdir -p "$HOME/Library/Logs/Yulu"
    chmod 700 "$HOME/Library/Logs/Yulu"

    if [[ -f "$dest" ]]; then
        launchctl unload "$dest" 2>/dev/null || true
    fi

    if ! cp "$src" "$dest"; then
        err "$name: 复制到 $dest 失败"
        return 1
    fi

    # Keep the selected Host Node first, followed by stable system fallbacks.
    local lp
    lp="$(launch_path "$node_bin")"

    if ! sed -i '' \
        -e "s|__PYTHON__|$python_bin|g" \
        -e "s|__NODE_BIN__|$node_bin|g" \
        -e "s|__HOME__|$HOME|g" \
        -e "s|__SCRIPT_DIR__|$script_dir|g" \
        -e "s|__PATH__|$lp|g" \
        "$dest" 2>/dev/null; then
        err "$name: plist token 替换失败"
        return 1
    fi

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
