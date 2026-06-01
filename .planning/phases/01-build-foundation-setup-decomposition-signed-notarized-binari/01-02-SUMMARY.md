---
phase: 01-build-foundation-setup-decomposition-signed-notarized-binari
plan: 02
subsystem: infra
tags: [setup-decomposition, bash, install-plist, launchd-path, dev-release-fork]

# Dependency graph
requires:
  - "setup.sh monolith function bodies (install_deps, download_whisper_model, write_model_to_config, install_yulu_ui, install_plist) — the extraction sources"
  - "dev_install.py::_launch_path — the §6b stable-PATH reference implementation"
  - "release_installer.py .yulu-install.json source field — the D-13 fork input"
provides:
  - "yulu/scripts/lib/common.sh — shared bash helper library (first bash lib in the repo)"
  - "Hoisted canonical install_plist (§8c de-dup, D-14) — one module-scope copy"
  - "launch_path helper — stable launchd PATH, no baked nvm version literal (§6b fix)"
  - "detect_source / resolve_install_mode — D-13 dev/release fork reader"
  - "setup_deps.sh, setup_models.sh, setup_ui.sh — three standalone-or-sourced concern scripts under set -uo pipefail"
affects: [phase-01-plan-04-setup-audio-capabilities-daemons, phase-01-plan-05-setup-orchestrator, phase-06-provision-step-registry]

# Tech tracking
tech-stack:
  added: []  # no new deps — bash + stdlib python3 inline idiom only
  patterns:
    - "Standalone-or-sourced bash concern: set -uo pipefail + SCRIPT_DIR + source lib/common.sh + one concern fn + [[ BASH_SOURCE == 0 ]] guard (RESEARCH Pattern 5)"
    - "Hoisted shared helper (install_plist) takes state via explicit env/args, never monolith globals (Pitfall 5)"
    - "launch_path: hardcoded stable prefix order + glob highest nvm node dir, never a baked $(node -v) literal (§6b)"
    - "printf '%b...%s' color/log helpers (shellcheck SC2059-clean) — colors as %b args, not in the format string"

key-files:
  created:
    - yulu/scripts/lib/common.sh
    - yulu/scripts/setup_deps.sh
    - yulu/scripts/setup_models.sh
    - yulu/scripts/setup_ui.sh
  modified: []

key-decisions:
  - "install_plist hoisted to ONE canonical lib/common.sh copy (§8c, D-14): it was nested in install_launchagents (setup.sh 841-869) AND inline-duplicated in install_yulu_ui (1079-1088); setup_ui.sh now calls the hoisted helper, no local redefinition"
  - "§6b PATH fix: launch_path globs the highest ~/.nvm/versions/node/*/bin if present and never bakes a $(node -v) version into the plist __PATH__ — so a later nvm install/uninstall can't strand the LaunchAgent (and no attacker-influenceable versioned dir is prepended; T-01-03 mitigated)"
  - "Concern scripts are non-interactive standalone (Pitfall 5): setup_deps.sh DROPS the 继续安装？ confirmation gate; the setup.sh orchestrator (plan 01-05) owns all prompts"
  - "Pitfall-5 global audit: PYTHON_BIN/NODE_BIN/CONFIG_DIR/MODEL_DIR/LAUNCH_AGENTS_DIR taken via env-with-${VAR:-default}, so set -u standalone invocation never crashes on an unbound monolith global (T-01-05 mitigated)"
  - "setup_ui.sh runs npm ci against the committed package-lock.json (not npm install) — dependency set stays lockfile-pinned, no new package this phase (T-01-SC mitigated)"
  - "Scope held to deps/models/ui + lib/common.sh; audio/capabilities/daemons stay in plan 01-04, the orchestrator rewire stays in plan 01-05 — setup.sh main sequence is NOT yet rewired to call these"

patterns-established:
  - "lib/common.sh is the shared foundation every later setup_*.sh sources (plans 04, 05 depend on it)"
  - "Each setup_*.sh is the 1:1 seam Phase 6's `yulu provision <step>` registry binds to (D-12 check/apply shape)"

requirements-completed: []  # BUILD-01 already marked complete in 01-01; this plan satisfies BUILD-01's SC-3 partial (3 of 6 concerns extracted) — full closure lands with plans 04+05

# Metrics
duration: 5min
completed: 2026-05-30
---

# Phase 1 Plan 2: Shared Bash Library + Deps/Models/UI Concern Extraction Summary

**`lib/common.sh` (the repo's first bash helper library) hoists the duplicated `install_plist` to one canonical copy (§8c) and replaces the nvm-versioned launchd PATH with a stable one (§6b), then `setup_deps.sh` / `setup_models.sh` / `setup_ui.sh` carve three lower-risk `setup.sh` concerns into independent `set -uo pipefail` scripts that run in isolation and are idempotent on re-run — extraction, not re-authoring.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-30T03:52:51Z
- **Completed:** 2026-05-30T03:58:24Z
- **Tasks:** 2 of 2

## What Was Built

### Task 1 — `yulu/scripts/lib/common.sh` (commit `7509c43`)

The first bash library in the repo; the shared foundation every decomposed `setup_*.sh` sources. Header `set -uo pipefail` + `# shellcheck source=lib/common.sh`. Provides:

1. **Color + log helpers** (`ok`/`warn`/`err`/`info`/`header`/`prompt`) — `printf`-based, adopted from the `yulu` CLI style. Colors are passed as `%b` args (not embedded in the format string) so the file is `shellcheck -x` clean (SC2059).
2. **`install_plist`** — the single canonical copy (§8c de-duplication, D-14), lifted from `setup.sh` 841-869. Substitutes the five fixed plist tokens (`__PYTHON__`, `__NODE_BIN__`, `__HOME__`, `__SCRIPT_DIR__`, `__PATH__`). Inputs taken explicitly from env (`PYTHON_BIN`/`NODE_BIN`/`SCRIPT_DIR`/`LAUNCH_AGENTS_DIR`) with safe defaults, not monolith globals (Pitfall 5). Tokens absent from a template (e.g. `com.yulu.audiodaemon.plist`'s `open -W` form, the §8b Phase-2 concern) are left untouched — §8b is not regressed.
3. **`launch_path`** — ports `dev_install.py::_launch_path` to bash (§6b fix). Hardcodes the stable order `~/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, globs the highest-sorted `~/.nvm/versions/node/*/bin` and inserts it after `~/.local/bin` if present, de-dupes — but never bakes a `$(node -v)` version literal (verified: it discovered the live `v22.22.1` dir dynamically, not as a frozen string).
4. **`detect_source` / `resolve_install_mode`** — the D-13 dev/release fork reader. Reads `.yulu-install.json`'s `source` field via the inline-python3-from-bash idiom; `resolve_install_mode` honors a `--dev` flag override else returns `release`/`dev`. Verified to resolve correctly in all three directions (release json → release; `--dev` overrides release json → dev; missing json in dev checkout → dev).

Sourcing is side-effect-free (only defines functions + color vars; a `YULU_COMMON_SH_LOADED` guard prevents re-declaration on re-source).

### Task 2 — `setup_deps.sh` / `setup_models.sh` / `setup_ui.sh` (commit `a0b1c84`)

Three `setup.sh` concerns extracted as standalone-or-sourced scripts (RESEARCH Pattern 5): `set -uo pipefail`, `SCRIPT_DIR`, `. "$SCRIPT_DIR/lib/common.sh"`, one concern function, trailing `[[ "${BASH_SOURCE[0]}" == "${0}" ]] && <concern> "$@"` guard. Each accepts `mode` (`release|dev`) as `${1:-release}` for orchestrator parity.

- **`setup_deps.sh`** (was `install_deps` 112-141) — near-verbatim lift of the idempotent brew block (`sox ffmpeg whisper-cpp terminal-notifier`, `steipete/tap/gogcli`, `cloudflared`). DROPS the interactive `继续安装？` / `read -r` gate (124-130) — standalone runs are non-interactive; orchestrator owns the prompt. Adds a no-brew guard that returns 1 with a clear message.
- **`setup_models.sh`** (was `download_whisper_model` 621-708 + `write_model_to_config` 678-708) — keeps config-driven model-target resolution (inline python3 reading `transcription.final_engine`), `curl -L --fail --progress-bar` + atomic `mv`, and the whisper-cli config rewrite. `PYTHON_BIN`/`CONFIG_DIR`/`MODEL_DIR` taken via env-with-default. Pure file-I/O + config-transform.
- **`setup_ui.sh`** (was `install_yulu_ui` 1022-1111) — keeps the node-version guard, lockfile-sha idempotency marker, `npm ci` + `npm run build`, dist-artifact assertion, and `/healthz` poll. **REPLACES** the §8c inline `install_plist` duplicate (1079-1088) with a call to the hoisted `lib/common.sh::install_plist` for `com.yulu.ui.plist` (then `launchctl load`), passing state through exported env so the hoisted helper sees it.

## Verification

- `bash -n` exits 0 on all four files.
- `shellcheck -x` clean on all four (run from `yulu/scripts/` so the `source=lib/common.sh` directive resolves, as CI does). Three SC2059/SC2012 findings on `lib/common.sh` were fixed during Task 1 to meet the clean-shellcheck criterion (colors moved to `%b` args; nvm glob replaced the `ls | sort` pipe with a bash glob + guarded reverse-sort).
- Standalone isolation proven under `set -u`: `setup_models.sh` skips cleanly with no config (MLX path), is idempotent on re-run, and re-points config to whisper-cli when a model pre-exists — no unbound-var crash. `setup_deps.sh` no-brew guard returns 1 cleanly. `setup_ui.sh` loads and resolves `install_plist` to the sourced hoisted copy (no local def).
- `setup_ui.sh` has zero local `install_plist()` definitions (§8c duplicate removed) and calls the hoisted helper.
- `make pytest`: **522 passed, 1 skipped** (the skip is pre-existing) — existing contract intact.

## Deviations from Plan

None — the plan executed exactly as written. This was a clean brownfield extraction (near-verbatim lifts of named `setup.sh` function bodies into the Pattern-5 skeleton). The only in-task refinements were making `lib/common.sh` `shellcheck -x` clean (SC2059 color-in-format and SC2012 `ls`-vs-glob), which is part of satisfying Task 1's acceptance criteria, not a departure from the plan. No bugs, missing functionality, blocking issues, or architectural changes were encountered. No package installs were attempted. No authentication gates.

## Scope Boundaries Respected

- Did NOT rewire `setup.sh`'s main sequence to call these scripts — that is the orchestrator plan (01-05).
- Did NOT touch the audio/capabilities/daemons concerns — those are plan 01-04.
- Stayed within this plan's `files_modified` (the four created files only); the pre-existing uncommitted `.planning/config.json` change and `01-PATTERNS.md` were left untouched.
- release-please / Conventional Commits / `release_installer.py → setup.sh` contract unchanged.

## For the Next Plan (01-04 / 01-05)

- `lib/common.sh::install_plist` is ready for `setup_daemons.sh` (plan 01-04) to call for every `com.yulu.*.plist` — same hoisted helper, same Pitfall-5 explicit-env contract.
- `resolve_install_mode` is the orchestrator's mode resolver: `mode="$(resolve_install_mode "$@")"` (`.yulu-install.json` source + `--dev` override), then pass `$mode` down to each `setup_*.sh`.
- The `com.yulu.audiodaemon.plist` `open -W` form still carries `__SCRIPT_DIR__`/`__HOME__` only (no `__PATH__`/`__PYTHON__`); the §8b `open -W`→direct-launch change remains Phase 2's (PLAT-03) — do not regress it.

## Self-Check: PASSED

- All four created files verified present on disk (see Self-Check below).
- Both commits verified in git log: `7509c43`, `a0b1c84`.
