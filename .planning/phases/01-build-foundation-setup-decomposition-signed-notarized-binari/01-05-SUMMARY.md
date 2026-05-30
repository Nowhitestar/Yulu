---
phase: 01-build-foundation-setup-decomposition-signed-notarized-binari
plan: 05
subsystem: infra
tags: [setup-decomposition, thin-orchestrator, dev-release-fork, install-sh, xcode-gate, swiftc, tests]

# Dependency graph
requires:
  - phase: 01-plan-02
    provides: "lib/common.sh — resolve_install_mode/detect_source (D-13), hoisted install_plist, launch_path, log helpers; setup_deps.sh/setup_models.sh/setup_ui.sh concern scripts"
  - phase: 01-plan-04
    provides: "setup_audio.sh (dev/release fork, swiftc dev-only), setup_capabilities.sh (verify mlx, no venv), setup_daemons.sh (hoisted install_plist + seed steps) — completing the six-concern set"
provides:
  - "yulu/scripts/setup.sh — THIN ORCHESTRATOR: resolves install mode once (resolve_install_mode), owns all interactive prompts, sequences the six setup_*.sh concerns passing $MODE + decisions via exported env (D-12)"
  - "install.sh — Xcode CLT pre-flight gated on --dev (mirrors the --dev git check); a release install runs with no Xcode/swiftc (BUILD-03, SC-1, Pitfall 6)"
  - "tests/test_setup_decomposition.py — per-concern set -uo pipefail + isolation (no unbound) + idempotency proof (BUILD-01, SC-3)"
  - "tests/test_release_no_swiftc.py — release fork is swiftc-free + install.sh Xcode check is --dev-gated (BUILD-03, SC-1)"
affects: [phase-06-provision-step-registry, phase-02-platform-impls, phase-07-venv-migration]

# Tech tracking
tech-stack:
  added: []  # no new deps — bash + stdlib python3 inline idiom; tests use stdlib subprocess/pathlib/stat (no bats)
  patterns:
    - "Thin orchestrator (D-12): resolve mode once via lib/common.sh, own ALL interactive prompts, export resolved decisions (UPGRADE_MODE/CONFIG_DIR/...) then sequence concern scripts as subprocess invocations passing $MODE (Pitfall 5 — no shared globals)"
    - "install.sh prerequisite gating: a single `if (( ${#TARGET_ARGS[@]} > 0 )) && [[ ${TARGET_ARGS[0]} == --dev ]]` block wraps BOTH the xcode-select pre-flight and the git check — release installs require neither (BUILD-03)"
    - "Orchestrator records only the engine+model CHOICE in config; the concern scripts act on it later (setup_capabilities.sh verifies mlx, setup_models.sh downloads GGML) — no venv (D-02), no download in the orchestrator, no dead mlx.python (D-03)"
    - "Hermetic shell-script test harness: run each concern in RELEASE mode behind a no-op PATH shim (fake brew/launchctl/npm/node/curl/swiftc/nc/tccutil/open/...) in tmp HOME/CONFIG_DIR — keeps the real python3/coreutils on PATH so inline-python3 config writers work (T-01-14 mitigation)"
    - "Recording-shim swiftc + build_*.sh stubs write to a sentinel; a release run asserting the sentinel stays empty PROVES the release path is compiler-free (SC-1)"

key-files:
  created:
    - tests/test_setup_decomposition.py
    - tests/test_release_no_swiftc.py
  modified:
    - yulu/scripts/setup.sh
    - install.sh
    - tests/test_search_setup_init.py
    - tests/test_spec_acceptance.py

key-decisions:
  - "setup.sh main sequence (the old flat 18-call list) replaced by: pre-flight (check_repo_layout/check_system) → confirm_deps_install → setup_deps.sh → create_config + 3 config-choice prompts → setup_audio.sh → setup_models.sh → setup_capabilities.sh → setup_calendar + setup_daemons.sh → setup_ui.sh → install_yulu_cli/install_agent_skill/run_tests/show_summary. swiftc reached ONLY via setup_audio.sh's dev branch (D-13)"
  - "install_yulu_cli/install_agent_skill/run_tests/show_summary KEPT in the orchestrator (not in the D-11 six-concern set; install_agent_skill decoupling is Phase 6 PROV-05 — left unchanged, call preserved)"
  - "compile_scanner DROPPED entirely from the orchestrator (window_scanner build folds into setup_audio.sh's dev branch per D-13; it was already release-skipped) — and compile_audio_daemon/install_deps/install_launchagents/install_yulu_ui/install_mlx_whisper/download_whisper_model inline bodies removed (they live in the concern scripts now)"
  - "install.sh: the git check is now NESTED inside the single --dev gate alongside xcode-select (cleaner than the monolith's two separate --dev conditionals) — one gate, both prerequisites; a release run requires neither Xcode nor git"
  - "configure_transcription_engine writes only final_engine + the chosen model (mlx.model for MLX, local_model_path for whisper) via a new record_engine_choice helper; it does NOT create a venv (D-02) and does NOT download (setup_models.sh owns the curl) — the heavy lifting stays in the sequenced concerns"
  - "Two pre-existing static-text tests (test_search_setup_init::test_setup_sh_invokes_search_init, test_spec_acceptance::test_setup_sh_installs_statusagent_plist) asserted against the pre-decomposition monolith; updated to assert the behavior in the owning concern (setup_daemons.sh) AND that the orchestrator sequences it — the behavior moved, it did not disappear"
  - "Dropped the stale transcription.mlx.python field from create_config's heredoc template too (D-03 consistency: a fresh config no longer seeds a venv path)"

patterns-established:
  - "setup.sh is now the 1:1 concern→step orchestrator Phase 6's `yulu provision <step>` registry binds to (D-12 shape realized)"
  - "The hermetic no-op-PATH-shim harness is the template for any future test that must run a side-effectful install concern in CI without host mutation or network"

requirements-completed: [BUILD-01, BUILD-03]

# Metrics
duration: 19min
completed: 2026-05-30
---

# Phase 1 Plan 5: Setup Orchestrator + install.sh Xcode Gate + Decomposition Tests Summary

**`setup.sh` becomes the thin orchestrator that resolves the install mode once (`resolve_install_mode`), owns every interactive prompt, and sequences the six `setup_*.sh` concern scripts passing `$MODE` + decisions down via exported env — replacing the monolith's 18-call flat sequence; `install.sh`'s Xcode CLT pre-flight is gated on `--dev` (a single `--dev` block now wraps both the `xcode-select` and `git` checks) so a release install runs with no compiler present; and two new hermetic shell-out tests prove per-concern `set -uo pipefail` + isolation + idempotency (BUILD-01/SC-3) and that the release fork invokes no `swiftc` while `install.sh`'s Xcode check is `--dev`-gated (BUILD-03/SC-1).**

## Performance

- **Duration:** ~19 min
- **Completed:** 2026-05-30
- **Tasks:** 2 of 2
- **Files:** 2 created, 4 modified

## What Was Built

### Task 1 — `setup.sh` thin orchestrator + `install.sh` `--dev` Xcode gate (commit `b76964f`)

**`yulu/scripts/setup.sh` (refactor in place, ~576 net lines removed):**
- Switched from bare `set -e` to `set -uo pipefail`; sources `lib/common.sh` for the log helpers + `resolve_install_mode`.
- Resolves the install mode ONCE: `MODE="$(resolve_install_mode "$@")"` (`.yulu-install.json` `source` field + a `--dev` override). Verified end-to-end: release json → `release`; `--dev` overrides → `dev`; missing json (dev checkout) → `dev`; `--upgrade --dev` → `MODE=dev UPGRADE=true`.
- Exports the resolved decision state (`SCRIPT_DIR PYTHON_BIN NODE_BIN CONFIG_DIR MODEL_DIR LAUNCH_AGENTS_DIR UPGRADE_MODE`) so the sequenced concern scripts and the hoisted `install_plist` read identical values via env (Pitfall 5).
- **Owns all interactive prompts** (the install banner, deps confirmation via `confirm_deps_install`, post-recording mode, transcription engine, summary mode, the config-overwrite prompt, the calendar `[y/N]` via `setup_calendar`/`confirm_calendar_plist`) and resolves them into config/env before invoking the non-interactive concern scripts.
- **Replaced the flat 18-call sequence** with: `check_repo_layout` → `check_system` → `confirm_deps_install` ⇒ `setup_deps.sh "$MODE"` → `create_config` + the three config-choice prompts → `setup_audio.sh "$MODE"` → `setup_models.sh "$MODE"` → `setup_capabilities.sh "$MODE"` → `setup_calendar` + `confirm_calendar_plist` + `setup_daemons.sh "$MODE"` → `setup_ui.sh "$MODE"` → `install_yulu_cli` + `install_agent_skill` + `run_tests` + `show_summary`.
- **Dropped the inline concern bodies**: `compile_scanner`, `compile_audio_daemon`, `install_deps`, `download_whisper_model`, `install_mlx_whisper`, `install_launchagents`, `install_yulu_ui`, plus `write_mlx_to_config`/`write_model_to_config` (those live in the concern scripts now). `compile_scanner` is gone entirely (folds into `setup_audio.sh`'s dev branch, D-13). swiftc is reachable ONLY through `setup_audio.sh`'s dev branch.
- New `record_engine_choice` helper writes only `final_engine` + the chosen model into config (mlx.model for MLX with `mlx.pop("python")` per D-03; `local_model_path` for whisper) — no venv (D-02), no download (setup_models.sh owns the curl).
- Kept `install_yulu_cli`/`install_agent_skill`/`run_tests`/`show_summary` orchestrator-resident (out of the D-11 six-concern scope; `install_agent_skill` left unchanged for Phase 6 PROV-05).

**`install.sh` (Pitfall 6 / BUILD-03):**
- Gated the previously-unconditional `xcode-select -p` pre-flight on `--dev`. A single `if (( ${#TARGET_ARGS[@]} > 0 )) && [[ "${TARGET_ARGS[0]}" == "--dev" ]]` block now wraps BOTH the `xcode-select` pre-flight AND the git check (the git check was folded inside, removing the monolith's separate `--dev` conditional). A release install (pre-built signed/notarized/stapled binaries) skips the Xcode and git requirements entirely; the `--dev` path still requires both, exactly as before.

Both files are `bash -n` clean and `shellcheck -x` clean (the carried-over `configure_summary_mode` inline-env block was tidied to drop a benign SC2097/SC2098 — `PYTHON_BIN`/`SCRIPT_DIR`/`CONFIG_DIR` are read from the exported env now).

### Task 2 — Wave 0 decomposition + release-no-swiftc tests (commit `2726406`)

**`tests/test_setup_decomposition.py` (BUILD-01, SC-3) — 33 tests:** for each of the six `setup_*.sh` plus `lib/common.sh`:
- (a) declares `set -uo pipefail` (text read);
- (b) `bash -n` clean; `lib/common.sh` sources cleanly under `set -u` and defines `ok`/`install_plist`/`resolve_install_mode`/`launch_path`;
- (b) each concern runs standalone in RELEASE mode behind a no-op PATH shim (fake `brew`/`launchctl`/`npm`/`node`/`curl`/`swiftc`/`nc`/`tccutil`/`open`/`pkill`/`pgrep`/`xattr`/`gog`/`terminal-notifier`/`sw_vers`) in a tmp `HOME`/`CONFIG_DIR`/`LAUNCH_AGENTS_DIR`, asserting returncode 0 with no `unbound variable` in stderr — hermetic, no network, no host mutation (T-01-14);
- (c) idempotency: the same hermetic invocation runs twice (shared tmp HOME) and the second run still succeeds;
- each concern carries the `[[ "${BASH_SOURCE[0]}" == "${0}" ]]` standalone-or-sourced guard.

**`tests/test_release_no_swiftc.py` (BUILD-03, SC-1) — 6 tests:**
- structural: `build_audio_daemon.sh`/`build_status_agent.sh` invocations live only in `setup_audio.sh`'s dev branch (executable lines only — comments stripped); `setup_audio.sh` runs no literal `swiftc` (it delegates to the build scripts); the `xattr -dr com.apple.quarantine` strip is dev-only (D-07);
- behavioral: a `setup_audio.sh release` run behind a *recording* shim (swiftc + build scripts append to a sentinel) asserts the sentinel stays empty — the release path reaches no compiler;
- install.sh: the `xcode-select -p` pre-flight is nested inside a `--dev`-gated block; the `TARGET_ARGS[0] == "--dev"` idiom governs both the Xcode and git prerequisites; no unconditional top-level `xcode-select` call.

Both reuse `test_package_release.py`'s `subprocess.run(..., capture_output=True, text=True, check=False)` helper (no bats) and the `ROOT = Path(__file__).resolve().parents[1]` anchor; `conftest.py` registers only markers (plain functions).

**Full suite:** `make pytest` → **567 passed, 1 skipped** (the skip is pre-existing).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated two pre-existing static-text tests coupled to the pre-decomposition `setup.sh` monolith**
- **Found during:** Task 2 (`make pytest` after writing the new tests)
- **Issue:** `test_search_setup_init.py::test_setup_sh_invokes_search_init` and `test_spec_acceptance.py::test_setup_sh_installs_statusagent_plist` asserted that `setup.sh` *itself* contains `search.indexer init` / `com.yulu.statusagent.plist`. The decomposition moved those lines into `setup_daemons.sh` (the orchestrator now reaches them by sequencing that concern), so both static assertions failed against the refactored thin orchestrator. The behavior is preserved — it moved, it did not disappear.
- **Fix:** Updated both to assert the line/string in the owning concern (`setup_daemons.sh`) AND that `setup.sh` sequences `setup_daemons.sh`. This keeps the intent (the install pipeline wires search-init + statusagent-plist) while following the moved code.
- **Files modified:** tests/test_search_setup_init.py, tests/test_spec_acceptance.py
- **Verification:** both tests pass in isolation; `make pytest` green (567 passed).
- **Committed in:** `2726406` (Task 2 commit)

**2. [Rule 1 - Bug] Tidied the carried-over `configure_summary_mode` inline-env block (SC2097/SC2098)**
- **Found during:** Task 1 (`shellcheck -x setup.sh`)
- **Issue:** The original `setup.sh` line `SUMMARY_MODE=... PYTHON_BIN="$PYTHON_BIN" ... "$PYTHON_BIN" - <<'PY'` assigns `PYTHON_BIN` on the command prefix AND expands `"$PYTHON_BIN"` on the same line — shellcheck SC2097/SC2098 (the prefix assignment is only visible to the forked process). Benign here (values identical) but the established clean-shellcheck criterion (01-02/01-04) requires zero findings, and plan 01-06 adds a shellcheck CI step.
- **Fix:** `PYTHON_BIN`/`SCRIPT_DIR`/`CONFIG_DIR` are already exported at the orchestrator top, so the prefix now passes only the two per-call decisions (`SUMMARY_MODE`/`CUSTOM_LLM_CMD`); the heredoc reads the rest from `os.environ`. No behavior change.
- **Files modified:** yulu/scripts/setup.sh
- **Verification:** `shellcheck -x setup.sh` clean; `make pytest` green.
- **Committed in:** `b76964f` (Task 1 commit)

**3. [Rule 2 - Consistency] Dropped the stale `transcription.mlx.python` venv path from `create_config`'s template**
- **Found during:** Task 1 (writing the orchestrator config)
- **Issue:** The monolith's `create_config` heredoc seeded `"mlx": { "python": "$CONFIG_DIR/venv-mlx-whisper/bin/python", ... }`. D-02/D-03 (plan 01-04) removed the venv and dropped the `mlx.python` field; a fresh config still seeding the venv path would re-introduce the dead field the decomposition deleted.
- **Fix:** The `create_config` template `mlx` block now carries only `"model"` (no `python`), matching `setup_capabilities.sh::write_mlx_to_config` (D-03). `stt_daemon/config.py` reads `mlx.python` only `if mlx.get("python")`, so absence is harmless.
- **Files modified:** yulu/scripts/setup.sh
- **Verification:** `make pytest` green (the config-shape tests still pass); shellcheck clean.
- **Committed in:** `b76964f` (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (2 test/lint cleanups required by my own refactor + established criteria, 1 D-02/D-03 consistency fix). No package installs (this plan introduces none; tests use stdlib `subprocess`/`pathlib`/`stat`). No architectural changes. No authentication gates.

## Threat Surface

No new security surface beyond the plan's `<threat_model>`. Mitigations honored:
- **T-01-12 (mitigate):** install.sh's Xcode pre-flight uses the same proven `TARGET_ARGS[0] == "--dev"` conditional as the git check; a release install relies on notarized+stapled binaries (plans 03/06), not a local compiler. No `curl|bash` SIGNATURE gate added (that is explicitly Phase 6) and none regressed.
- **T-01-13 (mitigate):** `resolve_install_mode` reads only the local `.yulu-install.json` `source` field + a local `--dev` override; no remote input selects the mode, and a missing file in a non-dev context defaults to the release prebuilt path.
- **T-01-14 (mitigate):** the decomposition tests run concern scripts behind a no-op PATH shim in tmp HOME/CONFIG_DIR — no host mutation, no network, non-interactive — so CI cannot brick the runner or hang on a prompt.
- **T-01-SC (mitigate):** no package installs in this plan; tests use stdlib only. No `[ASSUMED]`/`[SUS]` package introduced.

## Verification

- `bash -n yulu/scripts/setup.sh` + `bash -n install.sh` → exit 0.
- `shellcheck -x setup.sh` (from `yulu/scripts/`) + `shellcheck install.sh` → clean.
- `python3 -m pytest tests/test_setup_decomposition.py tests/test_release_no_swiftc.py -q` → 39 passed.
- `make pytest` → 567 passed, 1 pre-existing skip.
- `setup.sh` lists all six concern scripts (`grep -o 'setup_[a-z]*\.sh' | sort -u` → audio, capabilities, daemons, deps, models, ui).
- install.sh `xcode-select -p` is inside the `--dev` conditional; no unconditional top-level `xcode-select`.
- **Manual-only (carried to end-of-phase human verification):** proving a release install actually runs end-to-end on a machine with NO Xcode is a clean-machine check (RESEARCH Validation manual-only) — the static + behavioral tests prove the release path is compiler-free, but the real no-Xcode round-trip is a clean-machine manual gate.

## Scope Boundaries Respected

- Stayed within this plan's `files_modified` for the primary deliverables (setup.sh, install.sh, the two new test files); the two coupled-test edits are Rule-1 fixes for behavior my refactor moved (not new scope).
- Did NOT touch CI workflows (the `bash -n` list extension + the new shellcheck step are plan 01-06).
- Did NOT modify `lib/common.sh` or the six concern scripts (plans 01-02/01-04) — the orchestrator consumes them as-is.
- Preserved the `release_installer.py → setup.sh` contract (setup.sh entry behavior, idempotency, `--upgrade`) and release-please / Conventional Commits.

## Next Plan Readiness

- **For plan 01-06 (CI):** extend the `bash -n` loop list in `ci.yml` + `release-publish.yml` to include the new `setup_*.sh` (already listed in 01-PATTERNS), add the shellcheck job covering `setup*.sh`/`lib/*.sh`/`build_*.sh`, and wire the signing/notarization/attestation steps. The new `tests/test_*.py` are picked up automatically by the existing `pytest -q` step.
- **For Phase 6 (provision registry):** `setup.sh` is now the 1:1 concern→step orchestrator — each `setup_*.sh "$MODE"` invocation is the seam `yulu provision <step>` binds to.
- **Carried-forward (Phase 7):** orphaned-venv cleanup — the install path no longer creates `~/.config/yulu/venv-mlx-whisper` (and `create_config` no longer seeds `mlx.python`), but an upgrade migration should remove a stale venv from old installs.

## Self-Check: PASSED

- Created files verified present: `tests/test_setup_decomposition.py`, `tests/test_release_no_swiftc.py`.
- Modified files verified present: `yulu/scripts/setup.sh`, `install.sh`, `tests/test_search_setup_init.py`, `tests/test_spec_acceptance.py`.
- Both task commits verified in git log: `b76964f`, `2726406`.

---
*Phase: 01-build-foundation-setup-decomposition-signed-notarized-binari*
*Completed: 2026-05-30*
