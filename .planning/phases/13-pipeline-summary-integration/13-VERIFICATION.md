---
phase: 13-pipeline-summary-integration
verified: 2026-06-07T11:20:00Z
status: passed
score: 4/4 success criteria verified (SPKUI-05, SPKUI-06 satisfied)
overrides_applied: 0
independent: true
re_verification: false
gates:
  pytest: "995 passed, 1 skipped (exit 0) — Python 3.14.3; matches baseline 967/1 → claimed 995/1 (+28)"
  yulu_ui_untouched: "0 files changed under yulu/scripts/yulu_ui/** (git diff e6cc0a3..HEAD)"
  no_config_mutation: "no ~/.config/yulu or ~/.yulu file mutated during the test run"
  thin_orchestrator: "test_transcribe_is_thin (<240) + test_transcribe_py_no_inline_mlx_invocation (<400) pass; transcribe.py = 236 lines"
  sherpa_absent_on_runtime: "confirmed: `import sherpa_onnx` raises ModuleNotFoundError on python3 3.14.3 — graceful-degrade is the real live path, not hypothetical"
deferred:
  - truth: "config.example.json documents the transcription.diarization.* block"
    addressed_in: "Phase 15"
    evidence: "SUMMARY carry-forward note; ROADMAP Phase 15 SC3 (yulu migrate re-provisions sherpa+ONNX); config parsing already supports the block via Phase-10 DaemonConfig"
  - truth: "yulu migrate re-provisions sherpa + ONNX models on upgrade"
    addressed_in: "Phase 15"
    evidence: "ROADMAP Phase 15 SC3: 'existing v0.5.x install gains diarization through the existing yulu migrate path (the models step re-provisions sherpa + ONNX)'"
---

# Phase 13: Pipeline + Summary Integration — Independent Verification Report

**Phase Goal:** Wire ASR → diarize → `speaker_merge.assign` → persist `.transcript.txt` + `.speakers.json` → search upsert (degrading gracefully to today's plain transcript when diarization absent/disabled); flow the speaker-attributed transcript into the agent-queue summary via one additive prompt-var pair; never disturb the `.transcript.txt` cleanup output.
**Verified:** 2026-06-07 (independent lane — code/tests checked directly, SUMMARY claims not trusted)
**Status:** passed
**Re-verification:** No — initial independent verification

## Goal Achievement

### Observable Truths (4 ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | diarize enabled → labelled `.transcript.txt` + `.speakers.json` + search upsert; absent/disabled → plain transcript, NO error, NO sidecar; re-diarize preserves renames | ✓ VERIFIED | `diarize_pipeline.run_diarize_stage` writes `result.transcript`+`build_sidecar`+`upsert_doc` (diarize_pipeline.py:270-292); EVERY degrade path returns False & leaves plain transcript: disabled (L231), no segments (L233), backend/sherpa unavailable→None (L245), zero turns (L247), no labelled segments (L264); never raises (try-wrapped daemon call diarize_pipeline.py:144-156). Tests: `test_diarize_enabled_writes_labelled_transcript_and_sidecar`, `test_diarize_disabled_leaves_plain_transcript`, `test_diarize_backend_unavailable_degrades` (explicitly simulates 3.14 sherpa-missing, L161-163), `test_diarize_zero_turns_degrades`, `test_diarize_skipped_when_no_timestamped_segments`, `test_rediarize_preserves_rename` (rename "Lewis" survives renumbered clusters via prior_map+reanchor). |
| 2 | summary via ONE additive prompt-var pair (`{{speaker_transcript}}`/`{{speaker_list}}`), `""` defaults, every existing prompt unchanged | ✓ VERIFIED | `cache.render()` adds exactly 2 params w/ `""` defaults + 2 `.replace()` calls (cache.py:154,174-175); no other vars added. `test_legacy_prompt_unchanged_with_and_without_new_vars` asserts **byte-identical** `without == with_new == "summarize: BODY (M D)"` (test_summary_speaker_vars.py:57) and no `{{speaker` leak. |
| 3 | multi-speaker summary attributes action items to NAMED owners; speaker-aware export carries labels (DATA only) | ✓ VERIFIED | `agent_queue_worker` reads `.speakers.json` → `render_from_sidecar` + `speaker_roster` → passes both into the rendered LLM prompt (agent_queue_worker.py:262-299). `test_worker_passes_speaker_vars_from_sidecar` captures the ACTUAL prompt sent to a fake LLM and asserts `Roster=Lewis` + `Lewis]` present (test_summary_speaker_vars.py:150-151). Export carries labels because roster+labelled transcript are now in the data path; no UI touched (0 yulu_ui changes — gate respected). |
| 4 | labels never auto-rewrite cleanup output; `.speakers.json` is source-of-truth; low-confidence passed downstream uncertain (not laundered) | ✓ VERIFIED | Labelled transcript written by diarize stage is the diarize output, NOT a cleanup rewrite (cleanup prompt still overwrites `.transcript.txt` later via agent queue — transcribe.py:208-215 unchanged); sidecar written verbatim from `assign_speakers` which flags confidence (speaker_merge.py:278-285: overlap→confident True, no-overlap→confident False→UNKNOWN sentinel, never laundered). `test_low_confidence_segment_not_laundered` asserts a far segment lands `speaker_id="unknown"`, `confident=False` (test_transcribe_diarize.py:273-274). |

**Score:** 4/4 truths verified

### Additional Check Items (per verification request)

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| 1 | Live pipeline + graceful degrade (sherpa absent on 3.14) | ✓ VERIFIED | `import sherpa_onnx` → ModuleNotFoundError on python3 3.14.3 (verified directly). transcribe.py:194-201 calls thin `run_diarize_stage`; degrade swallows DaemonUnavailable/DaemonError→None (diarize_pipeline.py:151-156). Full suite of 995 tests passes ON the 3.14 runtime with sherpa absent → transcription is NOT broken. |
| 2 | Additive prompt vars don't break existing prompts | ✓ VERIFIED | cache.py:151-177 — only the pair added, `""` defaults; byte-identical legacy render test passes. |
| 3 | Named-owner attribution + export | ✓ VERIFIED | Worker fills vars from roster (named owners first) into LLM prompt; captured-prompt test asserts roster/labels appear. Export = data only. |
| 4 | Sidecar source-of-truth, no laundering | ✓ VERIFIED | Diarize output (not cleanup rewrite); UNKNOWN/confident=False preserved; test proves it. |
| 5 | Re-diarize preserves renames | ✓ VERIFIED | `_load_prior` → `prior_map_from_sidecar` + `reanchor_by_overlap` → `assign_speakers(prior_map=,prior_speakers=)` (diarize_pipeline.py:199-263). End-to-end `test_rediarize_preserves_rename` swaps cluster indices, asserts "Lewis" survives in speakers map AND rendered transcript. |
| 6 | Calendar prior wiring (no network at transcribe time) | ✓ VERIFIED | `resolve_attendee_count` reads schedule.json by meeting_id (from .state.json) else by title (diarize_pipeline.py:52-114); feeds Phase-12 `resolve_speaker_count`+`reconcile_count` (diarize_pipeline.py:159-196); NO gog/network — count was captured at scan time. Absent link → None → auto mode. 8 tests (test_transcribe_calendar_prior.py) cover id/title/fall-through/miss/malformed/empty. |
| 7 | Gates | ✓ VERIFIED | See gates frontmatter — all pass. |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `stt_daemon/diarize_pipeline.py` | diarize orchestration | ✓ VERIFIED | 292 lines; calendar prior + two-pass count + daemon round-trip + reanchor + persist + reindex; substantive, wired (imported by transcribe.py:194). |
| `stt_daemon/protocol.py` | JobKind.DIARIZE + Diarize msgs | ✓ VERIFIED | JobKind.DIARIZE (background slot, L19,33), DiarizeRequest/Response (L137-163), registered in _TYPE_TO_CLS + Message union (L224,242-243). |
| `stt_daemon/app.py` | _on_diarize handler | ✓ VERIFIED | `diarize_backend=None` default (L81), registered (L111), handler returns turns / ENGINE_UNAVAILABLE(None) / INTERNAL(raise) / AUDIO_NOT_FOUND (L310-364); OFF the ASR runtime dict. |
| `transcribe_client.py` | request_diarize client | ✓ VERIFIED | `request_diarize` present (L180); reuses _run_with_retry; raises DaemonError/DaemonUnavailable cleanly. |
| `transcribe.py` | thin orchestrator wiring | ✓ VERIFIED | 236 lines; captures asr_segments (L166,169), single run_diarize_stage call (L195-201); stays thin (guards pass). |
| `prompts/cache.py` | additive var pair | ✓ VERIFIED | render() pair + `""` defaults (L154,174-175). |
| `agent_queue_worker.py` | feed vars from sidecar | ✓ VERIFIED | reads sidecar → render_from_sidecar + speaker_roster → cache.render (L254-299). |
| `stt_daemon/speaker_merge.py` | speaker_roster helper | ✓ VERIFIED | speaker_roster resolves renames/skips merged-away/surfaces Unknown (L701-739). |
| 5 test files | new Phase 13 tests | ✓ VERIFIED | all present; +28 tests; suite 995/1. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| transcribe.py | diarize_pipeline.run_diarize_stage | import + call | ✓ WIRED | transcribe.py:194-201 |
| diarize_pipeline | daemon DIARIZE | request_diarize | ✓ WIRED | diarize_pipeline.py:145-150 → transcribe_client.request_diarize → DiarizeRequest |
| diarize_pipeline | speaker_merge.assign_speakers | import + call | ✓ WIRED | diarize_pipeline.py:260-263 |
| diarize_pipeline | search.indexer.upsert_doc | import + call | ✓ WIRED | diarize_pipeline.py:286-288 (labelled body) |
| diarize_pipeline | speaker_count (Phase 12) | resolve_speaker_count + reconcile_count | ✓ WIRED | diarize_pipeline.py:164,170,187 |
| agent_queue_worker | speaker_merge sidecar helpers | render_from_sidecar + speaker_roster | ✓ WIRED | agent_queue_worker.py:266-269 |
| agent_queue_worker | cache.render | speaker_transcript/speaker_list kwargs | ✓ WIRED | agent_queue_worker.py:291-300 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| labelled `.transcript.txt` | result.transcript | assign_speakers(real asr_segments, real turns) | Yes (real merge engine, not static) | ✓ FLOWING |
| `.speakers.json` | build_sidecar(result, turns) | assign_speakers output verbatim | Yes (confidence flags preserved) | ✓ FLOWING |
| `{{speaker_transcript}}` | render_from_sidecar(doc) | read_sidecar of real sidecar | Yes (captured-prompt test confirms) | ✓ FLOWING |
| `{{speaker_list}}` | speaker_roster(doc) | sidecar speakers map | Yes (Roster=Lewis confirmed in prompt) | ✓ FLOWING |
| attendee prior | resolve_attendee_count | schedule.json/state.json (no network) | Yes (8 tests) | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| sherpa absent on runtime | `python3 -c "import sherpa_onnx"` | ModuleNotFoundError | ✓ PASS (confirms degrade is live path) |
| full test suite | `python3 -m pytest tests -q` | 995 passed, 1 skipped, exit 0 | ✓ PASS |
| transcribe.py line count | `wc -l transcribe.py` | 236 (< 240 guard) | ✓ PASS |
| diarize RPC round-trip | pytest test_diarize_rpc.py | encode/decode + handler all green | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SPKUI-05 | 13-PLAN | speaker-attributed transcript flows into agent-queue summary (one additive pair); export carries labels | ✓ SATISFIED | Criteria 2+3 verified; worker captured-prompt test |
| SPKUI-06 | 13-PLAN | speaker labels never auto-rewrite `.transcript.txt` cleanup output (sidecar source-of-truth) | ✓ SATISFIED | Criterion 4 verified; no-laundering test |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| test_transcribe_diarize.py | 170 | tautological assert `"the transcript" or transcript` (always true) | ℹ️ Info | Cosmetic — the NEXT line `assert "[00:00 Speaker" not in transcript` + sidecar-absence assert carry the real degrade check; criterion still proven. Not a gap. |
| prompts/cache.py | 157 | word "placeholders:" in docstring | ℹ️ Info | False positive (template-var documentation), not a stub. |

No debt markers (TBD/FIXME/XXX), no real stubs, no hardcoded-empty rendered data. transcribe.py degrade paths are exhaustive and never raise.

### Deferred Items (addressed in later phases — NOT gaps)

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | config.example.json `transcription.diarization.*` block | Phase 15 | SUMMARY carry-forward; config parsing already supports it (Phase-10 DaemonConfig); doc + migrate hook are Phase-15 concerns |
| 2 | `yulu migrate` re-provisions sherpa + ONNX | Phase 15 | ROADMAP Phase 15 SC3 explicitly owns this |

### Human Verification Required

None. All 4 criteria are programmatically verifiable and verified: the pipeline degrade path is exercised by the live 3.14 runtime (sherpa genuinely absent) + mocked-RPC unit tests; criteria 2/3 are proven by byte-identity + captured-prompt assertions; criterion 4 by the no-laundering test. The opt-in real-clip integration test exercises the true sherpa path via the spike venv and skips cleanly in CI. No visual/UX surface was added (UI is Phase 14, gated).

### Gaps Summary

No gaps. All 4 ROADMAP success criteria are met with substantive, wired, data-flowing implementations and high-quality tests. Both requirements (SPKUI-05, SPKUI-06) are satisfied. All gates pass: full suite 995/1 (exit 0) on the sherpa-less Python 3.14 runtime, zero `yulu_ui` changes, zero real-config mutation, thin-orchestrator guards hold (transcribe.py = 236 lines, heavy logic correctly extracted to `stt_daemon/diarize_pipeline.py`). The critical graceful-degrade claim is independently confirmed: a fresh 3.14 runtime without sherpa does NOT break transcription — the full suite runs green and every diarize failure path leaves today's plain transcript untouched without raising. The two carry-forwards (config.example.json diarization block, migrate re-provision) are correctly scoped to Phase 15 and recorded as deferred, not gaps.

---

_Verified: 2026-06-07 (independent lane)_
_Verifier: Claude (gsd-verifier, Opus 4.8)_
