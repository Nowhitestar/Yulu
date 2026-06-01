---
phase: 05-capability-reuse-data-folder-cloud-sync-safety
verified: 2026-05-30T11:25:00Z
status: human_needed
score: 17/17 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Live cloud warning against a REAL iCloud/Drive folder"
    expected: "Settings → Storage → Output directory → Choose… → pick ~/Library/Mobile Documents/com~apple~CloudDocs/… OR ~/Library/CloudStorage/GoogleDrive-<acct>/… → a warning naming the engine + eviction/corruption risk appears BEFORE commit; Use anyway (opt-in) and Cancel both work."
    why_human: "CI has no live iCloud/Google Drive sync engine. Detection is unit-tested with mocked SF_DATALESS + path-prefix; the real-engine path-prefix + live stat can only be exercised on a machine with a real sync root."
  - test: "Data-folder change → audio-daemon restart → new recording lands in the new folder"
    expected: "Pick a local folder (~/Movies/Yulu2) → no warning, immediate commit, row shows ⟳ restart indicator for audiodaemon. Apply, restart audio daemon, record a short clip → the clip lands in the new folder; status_agent menu reflects it."
    why_human: "Requires a running daemon stack (audio_daemon caches RECORDING_DIR at process start). CI cannot start launchd daemons or capture real audio."
  - test: "Live SF_DATALESS eviction reporting (the warned harm is real)"
    expected: "Induce eviction (Optimise Mac Storage + disk pressure, or brctl evict) on a file in the cloud data-folder → it reports SF_DATALESS; confirm runtime SQLite/sockets remain in ~/.config/yulu and never appear in the chosen data-folder (DATA-02 holds)."
    why_human: "OS-induced eviction only happens on a real sync engine under disk pressure; cannot be induced in CI."
---

# Phase 5: Capability Reuse + Data-Folder Cloud-Sync Safety — Verification Report

**Phase Goal:** Yulu stops duplicating what the host provides, and the data folder can point at a cloud-sync root safely — machine-local runtime/state physically isolated from syncable content so a sync engine can never corrupt a DB or evict an in-use recording.
**Verified:** 2026-05-30T11:25:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

All 17 plan must-haves are VERIFIED in the actual codebase (read, not trusted from SUMMARY). All 4 ROADMAP success criteria are code-complete and proven by the passing suites; the 3 live-sync confirmations (real cloud folder + running daemons + OS eviction) are genuine human-verify items, not gaps.

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| **Plan 01 — runtime/content split (DATA-02/DATA-01)** | | | |
| 1 | runtime_dir() resolves machine-local, NEVER reads audio.output_dir | ✓ VERIFIED | path_resolver.py:84-96 `runtime_dir()` returns `config_dir()` (==~/.config/yulu); docstring states LOCKED/non-configurable; comment block L63-82 documents the split |
| 2 | A config routing runtime under a cloud root is rejected at startup | ✓ VERIFIED | path_resolver.py:98-130 `assert_runtime_not_synced()` raises RuntimeError when `is_cloud_root(runtime_dir()).is_cloud`; test_yulu_platform_macos.py covers raise + no-op (now unskipped — cloud_detect landed) |
| 3 | New recordings/transcripts/summaries/voicemails land under data_dir(), not a ~/Movies/Yulu literal | ✓ VERIFIED | indexer.py:60 `CORPUS_ROOT=_resolve_data_dir()`; repo.py:39 `VOICEMAIL_DIR_DEFAULT=_resolve_data_dir()/"voicemails"`; record_audio.py:81 fallback `str(_resolve_data_dir())` |
| 4 | The 3 hardcoded content-root literals resolve via PathResolver.data_dir() | ✓ VERIFIED | grep confirms `_resolve_data_dir`→`MacOSPathResolver().data_dir()` in all 3 modules; SEARCH_DB_PATH (runtime) routes via runtime_dir() — split holds |
| **Plan 02 — reuse gating (REUSE-01/REUSE-02)** | | | |
| 5 | A host whisper-cli/mlx-whisper/gog status==usable skips its install | ✓ VERIFIED | setup_deps.sh:54,63 + setup_capabilities.sh:101 gate `[[ "$(capability_status X)" == "usable" ]]`; doctor `gog` probe returns status=usable on this machine |
| 6 | present-but-unverified OR absent both install Yulu's own (tri-state never collapsed) | ✓ VERIFIED | KEY CHECK (a): grep for `-n "$status"` / `!= "absent"` returns NOTHING in all 3 scripts; test_reuse_gating.py L45-46 parametrizes present-but-unverified→install, absent→install |
| 7 | doctor.py --json includes a gog capability | ✓ VERIFIED | doctor.py:265 `report.capabilities["gog"]=probe_command("gog",("--version",))`; behavioral spot-check: `_host_capabilities()` emits gog key (status=usable) |
| 8 | The reuse gate never executes a resolved_path in a shell (fixed argv + JSON-parse-in-Python) | ✓ VERIFIED | lib/common.sh:61-73 `capability_status()` runs `doctor.py --json` fixed argv, pipes to `python3 -c` parsing host_capabilities.capabilities.<cap>.status, cap name passed as argv not interpolated; only `status` echoed |
| **Plan 03 — cloud detection (DATA-03)** | | | |
| 9 | is_cloud_root() flags an iCloud Drive path | ✓ VERIFIED | cloud_detect.py:126-132 matches `_ICLOUD_ROOT="Library/Mobile Documents/com~apple~CloudDocs"`; test_cloud_detect.py asserts |
| 10 | is_cloud_root() flags ~/Library/CloudStorage/<Provider>-<acct> and names the engine | ✓ VERIFIED | cloud_detect.py:135-148 + `_engine_from_cloudstorage_segment` maps google-drive/dropbox/onedrive/cloudstorage |
| 11 | is_cloud_root() returns not-cloud for ~/.config/yulu and ~/Movies/Yulu | ✓ VERIFIED | cloud_detect.py:159 default not-cloud; test_cloud_detect.py asserts both |
| 12 | Eviction uses os.stat().st_flags & stat.SF_DATALESS, never os.getxattr | ✓ VERIFIED | KEY CHECK (b): cloud_detect.py:171,185,191 use SF_DATALESS (10 occurrences); grep `getxattr` returns NOTHING |
| 13 | A tRPC cloud.detect(path) route returns the structured result without executing user input | ✓ VERIFIED | system.ts:181-202 `cloud.detect` spawns python3 with `input.path` as separate argv element (L189), parses JSON, degrades to typed default; T-05-07 safe |
| **Plan 04 — cloud-capable picker (DATA-01/DATA-03)** | | | |
| 14 | Changing audio.output_dir reports the audio daemon as needing restart (no longer 'none') | ✓ VERIFIED | config.ts:66 `"audio.output_dir": "restart:audiodaemon"` (was "none"); WHY comment L62-65 |
| 15 | Choosing a cloud-sync folder shows an eviction/corruption warning BEFORE commit | ✓ VERIFIED | InlineEditRow.tsx:163 `cloud.detect.fetch()` on folder pick; L189 defers commit, CloudWarn (L199-216) renders eviction copy; cloudwarn.test.tsx asserts warn+no-commit |
| 16 | User can opt in to a cloud folder anyway (detect-and-warn, NOT block) | ✓ VERIFIED | InlineEditRow.tsx:213 "Use anyway" button → onAccept→onCommit; L209 "You can use this folder anyway"; cloudwarn.test.tsx: Use anyway→commit, Cancel→no commit |
| 17 | A detection failure never blocks folder selection (degrades to no-warn) | ✓ VERIFIED | InlineEditRow.tsx try/catch around detect → immediate commit; system.ts CLOUD_DETECT_DEGRADED; cloudwarn.test.tsx: detection error→immediate commit |

**Score:** 17/17 truths verified

### ROADMAP Success Criteria (code half — all VERIFIED)

| # | Criterion | Code Status | Live Half |
|---|-----------|-------------|-----------|
| 1 | usable host whisper/model/claude/gog → reuse, skip install | ✓ VERIFIED — gates on ==usable; gog probe added; test_reuse_gating.py | n/a (fully automatable) |
| 2 | runtime/state machine-local, physically separated, never in synced folder | ✓ VERIFIED — runtime_dir locked; assert_runtime_not_synced rejects synced; data_dir configurable | live eviction → human #3 |
| 3 | configurable data-folder takes effect across daemons | ✓ VERIFIED — RESTART_MAP audio.output_dir→audiodaemon; 3 literals routed | live change→restart→new-folder → human #2 |
| 4 | cloud-sync root detected → warn before accepting | ✓ VERIFIED — cloud_detect SF_DATALESS+path-prefix; cloud.detect tRPC; warn-before-accept picker | live real-cloud warning → human #1 |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `yulu_platform/macos/path_resolver.py` | runtime/data divergence + assert_runtime_not_synced | ✓ VERIFIED | 157 lines; contains `assert_runtime_not_synced`; runtime stays ~/.config/yulu |
| `yulu_platform/macos/cloud_detect.py` | is_cloud_root → CloudRootResult (SF_DATALESS) | ✓ VERIFIED | 199 lines; contains SF_DATALESS; no getxattr; imports on any OS |
| `lib/common.sh` | capability_status() tri-state helper | ✓ VERIFIED | contains `capability_status`; fixed argv + Python JSON parse |
| `yulu_ui/src/config.ts` | audio.output_dir → restart:audiodaemon | ✓ VERIFIED | contains `restart:audiodaemon` for output_dir |
| `yulu_ui/web/.../InlineEditRow.tsx` | cloud-warn interception in folder choose() | ✓ VERIFIED | contains cloud/detect/CloudWarn; eviction copy; no impossibility copy |
| `tests/test_reuse_gating.py` | tri-state skip/install gate test | ✓ VERIFIED | 176 lines; parametrizes usable/unverified/absent + malformed |
| `tests/test_cloud_detect.py` | path-prefix + dataless tests, mocked | ✓ VERIFIED | 189 lines; both families + SF_DATALESS mock |
| `tests/test_search_corpus_root.py` | content-root routing regression | ✓ VERIFIED | 185 lines |
| `tests/test_yulu_platform_macos.py` | runtime locked + guard tests | ✓ VERIFIED | 320 lines; guard tests now unskipped |
| `yulu_ui/tests/web/InlineEditRow.cloudwarn.test.tsx` | detect-and-warn-not-block matrix | ✓ VERIFIED | 113 lines; 6-case matrix |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| search/indexer.py | MacOSPathResolver.data_dir | CORPUS_ROOT via _resolve_data_dir() lazy/guarded | ✓ WIRED | indexer.py:47-60 |
| path_resolver.py | cloud_detect.is_cloud_root | assert_runtime_not_synced lazy import | ✓ WIRED | path_resolver.py:112-120 |
| setup_deps.sh | doctor.py --json tri-state | capability_status gates on usable | ✓ WIRED | setup_deps.sh:54,63 |
| doctor.py | capabilities.probes.probe_command | gog probe added | ✓ WIRED | doctor.py:265 |
| system.ts | cloud_detect.is_cloud_root | cloud.detect spawns read-only python (argv) | ✓ WIRED | system.ts:181-202 |
| InlineEditRow.tsx | system cloud.detect tRPC | PathValue.choose() detects then warns before onCommit | ✓ WIRED | InlineEditRow.tsx:163-189 |
| config.ts | daemonsNeedingRestart for output_dir | RESTART_MAP restart:audiodaemon | ✓ WIRED | config.ts:66 |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full Python suite | `make pytest` | 707 passed, 1 skipped (exit 0) | ✓ PASS (matches expected 707/1) |
| Phase-5 targeted tests | `pytest test_reuse_gating test_cloud_detect test_search_corpus_root test_yulu_platform_macos` | 55 passed | ✓ PASS |
| TypeScript typecheck | `npm run typecheck` | 0 errors | ✓ PASS |
| Vitest suite | `npm test` | 73 files / 345 tests passed | ✓ PASS (matches expected ~345) |
| Shell syntax | `bash -n` on common.sh/setup_deps.sh/setup_capabilities.sh | all OK | ✓ PASS |
| gog probe emits | `doctor._host_capabilities()` | gog present, status=usable | ✓ PASS |
| KEY CHECK (a) no boolean collapse | `grep -nE '-n "$status"\|!= "absent"'` | no matches | ✓ PASS |
| KEY CHECK (b) no getxattr | `grep getxattr cloud_detect.py` | no matches (SF_DATALESS×10) | ✓ PASS |
| KEY CHECK (c) no impossibility copy | `grep -niE 'socket.*cannot\|cannot.*exist' InlineEditRow.tsx` | no matches; eviction/corruption framing present | ✓ PASS |
| KEY CHECK (d) gog probe present | `grep gog doctor.py` | present (L265) | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| REUSE-01 | 05-02 | usable host whisper/model/claude/gog reused not installed | ✓ SATISFIED | gog probe + capability_status gates (truths 5,7,8); REQUIREMENTS.md marks Complete |
| REUSE-02 | 05-02 | no unconditional brew install whisper-cpp / duplicate MLX venv | ✓ SATISFIED | setup_deps.sh:54 gates whisper-cpp; setup_capabilities.sh adds NO pip (truth 5) |
| DATA-01 | 05-01, 05-04 | configurable data-folder location | ✓ SATISFIED | 3 literals→data_dir() + RESTART_MAP→audiodaemon (truths 3,4,14) |
| DATA-02 | 05-01 | runtime/state physically separated, never synced | ✓ SATISFIED | runtime_dir locked + assert_runtime_not_synced (truths 1,2) |
| DATA-03 | 05-03, 05-04 | detect cloud-sync root + warn | ✓ SATISFIED | is_cloud_root + cloud.detect + warn-before-accept (truths 9-13,15,16) |

No orphaned requirements: all 5 IDs mapped to Phase 5 in REQUIREMENTS.md are claimed by plans and verified.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | — | — | No TBD/FIXME/XXX debt markers; no TODO/HACK/PLACEHOLDER; no stub returns; no hardcoded-empty data flowing to render on any of the 13 Phase-5 modified files |

### Human Verification Required

These three behaviors are the phase's data-loss-safety gate (05-04 Task 4, `gate="blocking-human"`). The code is complete and fully unit-covered with mocked detection; the live paths physically cannot run in CI (no sync engine, no daemon stack, no inducible eviction). They are human_needed, NOT gaps.

1. **Live cloud warning (real sync root).** Settings → Storage → Output directory → Choose… → pick a real iCloud (`~/Library/Mobile Documents/com~apple~CloudDocs/…`) or Google Drive (`~/Library/CloudStorage/GoogleDrive-<acct>/…`) folder. EXPECT: warning naming the engine + eviction/corruption risk appears BEFORE commit; Use anyway / Cancel both work.

2. **Change → audio-daemon restart → new recording lands.** Pick a local folder (no warning, ⟳ restart indicator), apply, restart audio daemon, record a clip. EXPECT: clip lands in the new folder; status_agent menu reflects it. Confirm runtime SQLite/sockets stay in ~/.config/yulu (DATA-02).

3. **Live SF_DATALESS eviction.** Induce eviction (Optimise Mac Storage + disk pressure, or `brctl evict`) on a file in the cloud data-folder. EXPECT: it reports SF_DATALESS — the warned harm is real.

### Gaps Summary

No gaps. All 17 must-haves across 4 plans are VERIFIED against the actual codebase (not SUMMARY claims). All 4 ROADMAP success criteria are code-complete and proven by `make pytest` (707 passed, 1 skipped — exact expected count), `npm run typecheck` (0 errors), and `npm test` (345 passed). All 4 KEY CHECKS pass: (a) reuse gates strictly on ==usable with no boolean-collapse patterns; (b) cloud detection uses SF_DATALESS not os.getxattr; (c) runtime/warning copy frames corruption/eviction not socket-impossibility; (d) gog probe present and reporting usable. No debt markers or stubs on any modified file.

Status is `human_needed` (not `passed`) because 3 live-sync confirmations require a real iCloud/Drive folder + running daemons + OS-induced eviction — genuine human checks with no automated substitute. The runtime LOCK (Plan 01) means even if the live warning were somehow bypassed, runtime/state can never follow the chosen content folder, so the catastrophic case (SQLite on a sync root) is structurally prevented.

---

*Verified: 2026-05-30T11:25:00Z*
*Verifier: Claude (gsd-verifier)*
