---
phase: 06-agent-orchestrated-provisioning-decoupled-skill-install
verified: 2026-05-30T13:30:00Z
status: human_needed
score: 5/5 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Real `gh attestation verify` of a published signed Yulu release zip"
    expected: "`gh attestation verify <published-zip> --repo Nowhitestar/Yulu` returns exit 0; a byte-tampered copy returns nonzero"
    why_human: "gh attestation verify fetches the attestation from the GitHub API and validates the Sigstore cert chain + Rekor transparency-log inclusion against a REAL signed asset minted by release-publish.yml. No fixture can stand in for a genuine published attestation, and verify REQUIRES gh auth (exit-4 unauthenticated even for public repos). The gate CODE is fully unit-proven against mocked gh + corrupted fixtures (6 attest tests green); only the live confirmation needs a real asset + auth."
  - test: "Confirm `--signer-workflow`/`--signer-repo` strictness for the reusable release-publish.yml (RESEARCH A1/Q2)"
    expected: "`gh attestation verify <zip> --repo Nowhitestar/Yulu --signer-workflow Nowhitestar/Yulu/.github/workflows/release-publish.yml` STILL passes for the genuine asset; record whether `--repo` alone is acceptable strictness or signer pinning is required"
    why_human: "The exact signer-identity flag for a reusable workflow can only be confirmed against a real attestation. attest.py ships with `--repo` alone today (RESEARCH-verified shape-correct, less strict); the verify result decides whether to append `--signer-workflow` to the verify_asset argv (a documented one-line follow-up). Not a correctness break — a hardening nuance."
---

# Phase 6: Agent-Orchestrated Provisioning + Decoupled Skill Install — Verification Report

**Phase Goal:** Provisioning becomes a registry of named, idempotent, status-reporting steps the host agent can drive and re-run safely — composing layers 1–5 — with asset integrity verified before execution, resumable per-step state, and skill install decoupled from core install.
**Verified:** 2026-05-30T13:30:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (5 ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Registry of named steps (`check`/`apply` → `StepResult`), invocable via `yulu provision <step>`, re-run of completed step → `skipped`/`ok` not re-doing destructive work | VERIFIED | `registry.py`: 6 `ScriptStep`s in setup.sh order; `StepResult` frozen dataclass status ∈ {ok,skipped,error}; `apply()` short-circuits to `skipped` when `check()` true (lines 145-148). `cli.py` `--list`/`<step>`/`--all` wired; spot-check `provision --list` printed the six steps, unknown step rejected exit 1. Tests green. |
| 2 | Asset integrity (`gh attestation verify`) before execution; verified signed-zip path is working non-negotiable fallback when `gh` absent | VERIFIED (code) | `attest.py` `verify_asset` gh-LADDER: present AND `verify==0`→"attestation"; exit-4 (unauth) OR gh-absent→checksum floor; non-4→corroborate-or-`TamperError` (lines 104-130). Checksum REUSES `release_installer.verify_checksum`/`parse_checksums` (no fresh hashlib). 6 attest tests green incl. exit-0/4/non-4 + fallback. **Live real-gh verify → human_needed.** |
| 3 | Killed mid-way → resume from per-step `.yulu-install.json` without redoing completed steps or duplicating daemons | VERIFIED | `state.py`: `is_done` true ONLY on `status=="ok"` (line 216-225); `mark(running)` before apply / `mark(result)` after (CLI walk lines 134-136); `resume_order` returns non-ok steps in registry order. `test_provision_resume.py`: seeds deps+audio ok, models running → `resume_order == ["models","capabilities","daemons","ui"]`. Atomic `os.replace`. |
| 4 | Tampered asset rejected before any step executes | VERIFIED | `cli.py` `_run_all`: `verify_asset` runs FIRST when `--asset` supplied; `TamperError`→`return 1` BEFORE the walk loop (lines 108-126), fail-closed. `test_all_with_tampered_asset_aborts_before_any_apply` monkeypatches `verify_asset` to raise AND every `ScriptStep.apply` to explode-if-reached → proves no step runs. `test_tamper_rejected_via_checksum` (gh absent) matches "Checksum mismatch". |
| 5 | `yulu skill install [--agent]` installs/updates skill independently of core install (idempotent), no longer coupled into `setup.sh` | VERIFIED | `skill.py` `skill_install` lifted from setup.sh:620-676 minus prompts; argv-list `npx -y skills add <repo> -g -a <agent> -y`; npx-absent AND npx-failure both non-fatal (return 0); idempotent (re-invoke overwrites symlink). `yulu` dispatcher routes `skill)`→`provision.cli skill`. **setup.sh main flow no longer calls `install_agent_skill`** — only the function def (620) + a comment (925) remain; orchestrator tail (927-929) = `install_yulu_cli`/`run_tests`/`show_summary`. Static guard `test_setup_no_longer_calls_install_agent_skill` green. |

**Score:** 5/5 truths verified (criterion 2's automatable portion fully verified; its live real-asset confirmation is the human_needed item).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `yulu/scripts/provision/registry.py` | Step ABC + StepResult + ScriptStep + ordered REGISTRY | VERIFIED | 271 lines; `StepResult` frozen, `Step(ABC)`, `ScriptStep` wraps setup_*.sh via argv-list subprocess (no shell=True); 6-step REGISTRY in setup.sh order; `step_by_name` raises on unknown. WRAPS not ports (D-01). |
| `yulu/scripts/provision/state.py` | Atomic ledger + mark/is_done/resume_order, preserve installer keys | VERIFIED | 238 lines; `_atomic_write` mkstemp+`os.replace`; `mark()` preserves `_INSTALLER_KEYS` incl. `source` (Pitfall 3); `load` degrades corrupt→{}. |
| `yulu/scripts/provision/attest.py` | verify_asset gh-ladder + checksum floor + TamperError | VERIFIED | 152 lines; `import release_installer`; 3-way ladder; `TamperError(RuntimeError)`; argv-list gh call. |
| `yulu/scripts/provision/cli.py` | argparse provision/skill + resume walk + gate-first | VERIFIED | 243 lines; gate FIRST on `--asset` fail-closed; resume walk skips ok, marks running-before-apply; `skill install` subparser. |
| `yulu/scripts/provision/skill.py` | skill_install idempotent non-fatal npx wrapper | VERIFIED | 105 lines; argv-list npx; both failure modes return 0. |
| `yulu/scripts/provision/__init__.py` | Package exports | VERIFIED | Exports Step, StepResult, ScriptStep, REGISTRY, step_by_name, state, attest, skill. |
| `yulu/scripts/yulu` | provision + skill dispatcher cases | VERIFIED | Lines 311-312 route both; usage text lines 86, 90. |
| `yulu/scripts/setup.sh` | install_agent_skill removed from main flow | VERIFIED | Call removed; only def (620) + comment (922-926) remain; tail calls install_yulu_cli/run_tests/show_summary. |
| `tests/test_provision_*.py` (6 files) | Wave-0 coverage | VERIFIED | registry/state/resume/attest/cli/skill — all substantive assertions; all green in full suite. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| registry.py | setup_*.sh | `subprocess.run(["bash", script, mode])` argv list | WIRED | Lines 149-154; cwd=SCRIPTS_DIR; no shell=True. |
| cli.py | attest.verify_asset | gate FIRST when --asset, before any apply() | WIRED | Lines 108-126; TamperError→return 1 before walk. |
| cli.py | state resume walk | `is_done`→skip; mark running before apply; mark result after | WIRED | Lines 130-137. |
| yulu | provision.cli | `exec python3 -m provision.cli` | WIRED | Lines 311-312. |
| setup.sh | install_agent_skill removal | main flow no longer calls it | WIRED (removed) | Only def + comment; tail has no call. |
| attest.py | release_installer.verify_checksum | `import release_installer` (reuse, not re-implement) | WIRED | Lines 52, 142-151. |
| state.py mark() | installer source field | setdefault preserve, never clobber | WIRED | Lines 204-206, `_INSTALLER_KEYS`. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Registry lists six steps | `python3 -m provision.cli provision --list` | deps/audio/models/capabilities/daemons/ui, exit 0 | PASS |
| Unknown step rejected (no arbitrary exec) | `python3 -m provision.cli provision bogus_step` | "unknown step 'bogus_step'; valid steps: ..." exit 1 | PASS |
| Skill subcommand wired | `python3 -m provision.cli skill install --help` | usage printed, exit 0 | PASS |
| bash dispatcher syntax | (covered by full suite + plan `bash -n`) | clean | PASS |

### Probe Execution / Full Test Suite

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| Full pytest suite | `make pytest` | **760 passed, 1 skipped** in 372.78s | PASS |

Matches the expected 760 passed / 1 skipped exactly. Ran in the verifier's own process (exit code 0).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| PROV-01 | 06-01, 06-04 | Registry of named idempotent steps (`check`/`apply`→StepResult), `yulu provision <step>` | SATISFIED | registry.py + cli.py; truth #1 |
| PROV-02 | 06-01..04 | Spike: who drives steps + partial-failure/resume + tamper rejection exit criteria | SATISFIED | Both exit criteria realized & tested (resume + tamper); D-02 caller decision (agent CAN drive, signed-zip PRIMARY) documented |
| PROV-03 | 06-03 | Asset integrity (`gh attestation verify`) before execution; signed-zip fallback | SATISFIED (code) | attest.py; truth #2/#4; live real-gh verify → human_needed |
| PROV-04 | 06-02 | Resumable via per-step `.yulu-install.json` | SATISFIED | state.py; truth #3 |
| PROV-05 | 06-04 | `yulu skill install [--agent]` decoupled + idempotent | SATISFIED | skill.py + setup.sh decouple; truth #5 |

All 5 PROV requirements map to Phase 6 in REQUIREMENTS.md; no orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | No TBD/FIXME/XXX/HACK/PLACEHOLDER in any provision module | — | Clean |

`raise NotImplementedError` (registry.py 112/117) are `Step` ABC abstractmethods (correct). `return {}` (state.py 170/174, registry.py 179) are documented safe-degrade paths for corrupt/missing config — not stubs.

### Human Verification Required

#### 1. Real `gh attestation verify` of a published signed release zip
**Test:** `gh auth login`; `gh release download <tag> --repo Nowhitestar/Yulu --pattern 'yulu-macos-arm64-*.zip'`; `gh attestation verify yulu-macos-arm64-<tag>.zip --repo Nowhitestar/Yulu`.
**Expected:** exit 0 with attestation summary; a byte-tampered copy (`printf 'X' >> bad.zip`) returns nonzero.
**Why human:** verify fetches the attestation from the GitHub API + validates the Sigstore/Rekor chain against a genuine asset; needs gh auth (exit-4 unauth). The gate CODE is fully unit-proven (6 attest tests green).

#### 2. `--signer-workflow`/`--signer-repo` strictness (RESEARCH A1/Q2)
**Test:** re-run with `--signer-workflow Nowhitestar/Yulu/.github/workflows/release-publish.yml`; confirm it still passes for the genuine asset.
**Expected:** records whether `--repo` alone suffices or signer pinning is required (then a documented one-line argv extension in attest.py).
**Why human:** the exact signer-identity flag can only be confirmed against a real attestation. Ships with `--repo` alone today (RESEARCH shape-correct); a hardening nuance, not a correctness break.

### Gaps Summary

**No code gaps.** All 5 ROADMAP success criteria are achieved in the actual codebase, all 6 Wave-0 test files are substantive (real assertions on the resume order, source preservation, the gh ladder exit codes, and tamper-before-apply), and the full suite is green at the expected 760 passed / 1 skipped. The decoupling (criterion 5) and the additive-only constraint (install.sh / release_installer.py untouched — signed-zip stays PRIMARY per D-02) are both confirmed by grep and git log.

The phase is **functionally complete**. The only outstanding items are two LIVE confirmations of the attestation gate (criterion 2) that genuinely cannot be faked in pytest — they require a published, signed Yulu release asset plus an authenticated `gh`. These were deliberately scoped as a `checkpoint:human-verify` in 06-03 and are routed here as `human_needed`, NOT gaps: the gate logic is fully implemented and unit-proven against mocked gh + corrupted fixtures.

---

_Verified: 2026-05-30T13:30:00Z_
_Verifier: Claude (gsd-verifier)_
