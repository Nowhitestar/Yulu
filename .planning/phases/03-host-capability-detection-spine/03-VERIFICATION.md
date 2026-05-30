---
phase: 03-host-capability-detection-spine
verified: 2026-05-30T16:05:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: none
---

# Phase 3: Host-Capability Detection Spine Verification Report

**Phase Goal:** `doctor.py` produces a single versioned `HostCapabilityReport` that honestly reflects what the daemon can actually use, with per-capability provenance and tri-state status — the foundational dependency four downstream consumers bind to.
**Verified:** 2026-05-30T16:05:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria — all 5 automatable)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `yulu doctor` emits versioned `HostCapabilityReport` JSON with provenance (host-path/yulu-managed/agent-config/absent) + tri-state status (usable/present-but-unverified/absent), never boolean | ✓ VERIFIED | Real CLI `doctor.py --json` emits `host_capabilities` with `schema_version=1` + 8 caps; all status ∈ 3-set, all provenance ∈ 4-set, no boolean status. `grep -c 'status.*bool' report.py` = 0. `Status(str,Enum)` has 3 string members (report.py:35-45). |
| 2 | Login-shell PATH resolution (not launchd minimal PATH) + Python importability via daemon's interpreter | ✓ VERIFIED | probes.py `resolve_on_login_path` runs `[$SHELL,-lc,"command -v "+binary]` (list-form, probes.py:64-88); `probe_importable` runs `[daemon_python(),-c,import X]` (probes.py:94-117). grep: 3×`-lc`, 6×`command -v`. No bare `shutil.which` for binary resolution. |
| 3 | Report covers claude CLI, whisper-cli, mlx-whisper importability, llm.command validity, model paths/sizes, recording-dir writability | ✓ VERIFIED | All 6 probe keys present in live `--json` output: `claude, whisper_cli, mlx_whisper, llm_command, models, recording_dir`. `_host_capabilities` (doctor.py:250-258) populates all 6 + merges providers. |
| 4 | mlx_python ambiguity resolved — green usable = daemon can actually import | ✓ VERIFIED | `daemon_python()` (probes.py:55-58) mirrors `lib/common.sh:124` exactly (`PYTHON_BIN` → `which python3` → `/usr/bin/python3`). `probe_mlx_whisper()` probes via `daemon_python()` (probes.py:149). Dead `mlx_python` config field ignored. |
| 5 | CapabilityProvider interface + ClaudeCodeProvider end-to-end | ✓ VERIFIED | provider.py: `class CapabilityProvider(ABC)` + `@abstractmethod capabilities()` (no agent vocab in contract, grep=0); `ClaudeCodeProvider` relabels to AGENT_CONFIG; `default_providers()` wired into doctor (doctor.py:262). Live CLI: `claude_cli` provenance=`agent-config`, status=`usable`. |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `yulu/scripts/capabilities/report.py` | versioned tri-state schema + enums | ✓ VERIFIED | 107 lines; `Provenance`/`Status` str-enums, `Capability`, `HostCapabilityReport` (schema_version=1), `to_dict()` with `.value` coercion, `absent()` helper. |
| `yulu/scripts/capabilities/probes.py` | login-PATH + daemon-interp + 5 probes | ✓ VERIFIED | 302 lines; `daemon_python`, `resolve_on_login_path`, `probe_importable`, `probe_command`, `probe_mlx_whisper`, `probe_llm_command`, `scan_models`, `probe_recording_dir`. Each never raises (try/except → `absent`). |
| `yulu/scripts/capabilities/provider.py` | ABC + ClaudeCodeProvider + default_providers | ✓ VERIFIED | 116 lines; ABC + reference impl + `_as_agent_config` relabel + extension point. |
| `yulu/scripts/capabilities/__init__.py` | 7 exports | ✓ VERIFIED | All 7 (`HostCapabilityReport, Capability, Provenance, Status, CapabilityProvider, ClaudeCodeProvider, default_providers`) import cleanly. |
| `yulu/scripts/doctor.py` | `_host_capabilities` + §5d fix | ✓ VERIFIED | `_host_capabilities` (doctor.py:214-273) + `host_capabilities` key (doctor.py:387). §5d: line 386 `runtime_root / "yulu"`; `source_root / "yulu"` grep = 0. |
| 4 Wave-0 test files | schema/probes/provider/doctor | ✓ VERIFIED | All present; 44 phase-specific tests pass. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| probes.py | `$SHELL -lc 'command -v X'` | login-shell PATH (D-02) | ✓ WIRED | List-form subprocess, probes.py:77-82. |
| probes.py | daemon python3 (`__PYTHON__`) | `[daemon_python,-c,import X]` (D-03/04) | ✓ WIRED | probes.py:102-110; daemon_python mirrors common.sh:124. |
| probes.py | `MacOSPathResolver` | recording-dir writability (D-05) | ✓ WIRED | Guarded lazy import, probes.py:236-240. |
| provider.py | probes.py `probe_command` | `ClaudeCodeProvider.capabilities()` | ✓ WIRED | provider.py:88; relabels HOST_PATH→AGENT_CONFIG. |
| doctor.py `collect_report` | probes + `default_providers` | host_capabilities assembly | ✓ WIRED | doctor.py:250-265; 6 probes + provider merge. |
| doctor.py `collect_report` | `check_yulu_ui(runtime_root/...)` | §5d fix | ✓ WIRED | doctor.py:386; runtime_root, not source_root. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| doctor `host_capabilities` | `report.capabilities` | 6 live probes (subprocess/fs) + `default_providers()` | Yes — live CLI returned 8 real caps with resolved paths + version detail | ✓ FLOWING |

Live `doctor.py --json` on this host produced `claude_cli` = `agent-config`/`usable` with real resolved path — not hardcoded/empty. Probes genuinely shell out / stat the filesystem.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Real CLI emits valid host_capabilities | `doctor.py --json ... \| json` assertions | 8 caps, schema_version=1, tri-state, no-bool, provider e2e | ✓ PASS |
| Assembly never raises with missing roots | `collect_report(runtime_root=/tmp/nope...)` | shape-intact, host_capabilities present, no exception | ✓ PASS |
| llm.command resolved-not-executed | `inspect.getsource(probe_llm_command)` | no `input=`, uses `resolve_on_login_path` | ✓ PASS |
| Existing doctor keys preserved | top-level key diff | all of source_root/checks/stt_daemon/search_index/yulu_ui present | ✓ PASS |
| Full test suite | `make pytest` | **657 passed, 1 skipped** (matches expected) | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| DETECT-01 | 03-01, 03-03 | versioned report, provenance + tri-state | ✓ SATISFIED | SC1 verified; report.py + doctor host_capabilities. |
| DETECT-02 | 03-01 | login-shell PATH + daemon interpreter | ✓ SATISFIED | SC2 verified; resolve_on_login_path + probe_importable. |
| DETECT-03 | 03-01, 03-03 | 6-probe coverage | ✓ SATISFIED | SC3 verified; all 6 keys in live output. |
| DETECT-04 | 03-01 | mlx_python ambiguity resolved | ✓ SATISFIED | SC4 verified; daemon_python mirrors common.sh:124. |
| DETECT-05 | 03-02, 03-03 | CapabilityProvider + ClaudeCode e2e | ✓ SATISFIED | SC5 verified; provider entries reach doctor report. |

All 5 DETECT requirements declared in plans match REQUIREMENTS.md Phase 3 mapping. No orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | none | — | No TBD/FIXME/XXX debt markers in capabilities/ or doctor.py. No stub returns (empty returns are documented `absent()` degradation paths, not stubs). |

### Human Verification Required

None required for phase pass. The 2 manual items in 03-VALIDATION.md are explicitly OPTIONAL accuracy confirmations (NOT blocking), advisory only:

- *(advisory)* Detection accuracy on a host where a binary is on login-PATH-but-not-launchd-PATH (DETECT-02) — hard to reproduce launchd minimal PATH in CI; the login-shell `-lc` mechanism is verified, only the real-host accuracy is unconfirmed.
- *(advisory)* A green `usable` mlx-whisper actually transcribes first try (DETECT-04) — the daemon-interpreter probe mechanism is verified; only the end-to-end first-recording on a real mlx-equipped host is unconfirmed.

Per the task directive and VALIDATION.md, these do not force `human_needed` — all 5 automatable criteria are met and tests pass.

### Gaps Summary

No gaps. All 5 ROADMAP success criteria are observably true in the codebase, verified end-to-end through the real `yulu doctor --json` CLI (not just unit mocks): versioned tri-state provenance-labeled report, login-shell PATH + daemon-interpreter probing, full 6-probe coverage, resolved mlx_python ambiguity, and the CapabilityProvider seam with ClaudeCodeProvider flowing agent-config entries into the report. The §5d source-vs-runtime root bug is fixed. `host_capabilities` is purely additive (existing doctor shape intact, never raises). Full suite: 657 passed, 1 skipped.

---

_Verified: 2026-05-30T16:05:00Z_
_Verifier: Claude (gsd-verifier)_
