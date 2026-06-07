---
phase: 13
plan: 1
type: standard
autonomous: true
wave: 1
depends_on: [9, 10, 12]
requirements: [SPKUI-05, SPKUI-06]
subsystem: diarize-pipeline
---

# Phase 13 Plan: Pipeline + Summary Integration

## Objective

Wire ASR → diarize → speaker_merge into `transcribe.py`, persist `.transcript.txt` +
`.speakers.json` + search upsert (graceful-degrade when diarize absent/disabled), and flow the
speaker-attributed transcript into the agent-queue summary via one additive prompt-var pair.

## Context

@.planning/research/ARCHITECTURE.md
@.planning/phases/13-pipeline-summary-integration/13-CONTEXT.md

## Tasks

<task type="auto" id="1" name="Daemon diarize RPC plumbing">
  <behavior>
  Add the missing RPC so `transcribe.py` can ask the daemon to diarize:
  - `protocol.py`: add `JobKind.DIARIZE` (background slot), `DiarizeRequest` (audio_path,
    num_speakers, threshold, language, job_id, timeout_sec) + `DiarizeResponse` (job_id, status,
    turns: list[dict], num_speakers_detected, duration_ms, error). Register both in `_TYPE_TO_CLS`
    and the `Message` union; decode coerces nothing special (turns stay dicts).
  - `app.py`: register `DiarizeRequest` handler `_on_diarize`. When `self.diarize_backend is None`
    → `ErrorEvent(ENGINE_UNAVAILABLE, "diarization not configured")`. Else `warm_up()` (lazy) then
    `diarize(audio_path, num_speakers, threshold, cancel_token)`; return `DiarizeResponse` with
    `[t.to_dict() for t in turns]`. Any exception → `ErrorEvent(INTERNAL,...)` (sherpa-missing
    surfaces here cleanly). Attribute `self.diarize_backend` must default to None on the app so a
    daemon built without it (tests) doesn't AttributeError.
  - `transcribe_client.py`: add `request_diarize(*, wav, num_speakers, threshold, language,
    socket_path, ...) -> dict` mirroring `request_final_transcribe`; returns the daemon payload or
    raises `DaemonError`/`DaemonUnavailable`. Reuse `_run_with_retry`.
  </behavior>
  <files>
  yulu/scripts/stt_daemon/protocol.py
  yulu/scripts/stt_daemon/app.py
  yulu/scripts/transcribe_client.py
  </files>
  <verify>pytest tests/test_diarize_rpc.py tests/test_transcribe_client.py -q</verify>
  <done>DIARIZE round-trips through encode/decode; handler returns turns when backend present,
  ENGINE_UNAVAILABLE when None; request_diarize raises cleanly when daemon down.</done>
</task>

<task type="auto" id="2" name="Calendar-prior resolution helper">
  <behavior>
  New pure-ish helper `transcribe._resolve_attendee_count(audio_path, *, schedule_path,
  state_path) -> Optional[int]`: read recording state (`state_store`) for the active/last
  `meeting_id`; look that id up in `schedule.json` `meetings`; if found return
  `len(meeting["attendees"])` (or None when empty/absent). Fallback: match the recording's
  meeting_title (derived from stem) against `schedule.json` meetings by title. ANY failure (no
  files, malformed JSON, no match) → None (→ auto mode). Never raises. Stdlib + existing modules
  only; no network, no gog call at transcribe time (the count was already captured into
  schedule.json at scan time).
  </behavior>
  <files>yulu/scripts/transcribe.py</files>
  <verify>pytest tests/test_transcribe_calendar_prior.py -q</verify>
  <done>Returns attendee count when schedule.json links the recording by meeting_id or title;
  returns None on any miss/error without raising.</done>
</task>

<task type="auto" id="3" name="Wire diarize+merge into transcribe.py">
  <behavior>
  After the transcript is acquired + persisted (today's flow, unchanged), add a diarize stage that
  runs ONLY when `transcription.diarization.enabled` is true in config:
  - Build ASR segments for the merge. Prefer real segments from the daemon response (mono `segments`
    or the union of mic+sys channel segments); when only merged text exists, skip diarize (need
    timestamps).
  - Resolve `attendee_count` via task-2 helper; `language` from trans_cfg.
  - Run the Phase-12 two-pass flow EXACTLY as documented in speaker_count.py: `resolve_speaker_count`
    → if source==config force on pass 1; else auto pass (num_speakers=None) then `reconcile_count`
    on the observed auto count, second diarize only if the final count differs.
  - Re-diarize safety: if a prior `.speakers.json` exists, load it, compute `prior_map` via
    `prior_map_from_sidecar`, and (when prior turns exist) re-anchor the fresh turns with
    `reanchor_by_overlap` before calling `assign_speakers(prior_map=..., prior_speakers=...)` so
    user renames survive.
  - `assign_speakers(asr_segments, turns, ...)` → MergeResult. Persist:
    `.transcript.txt` = `result.transcript` (labelled), `.speakers.json` = `build_sidecar(...)`
    via `write_sidecar`, and `search.upsert_doc` the labelled transcript. The `.raw.transcript.txt`
    still holds the pre-cleanup plain merged text.
  - GRACEFUL DEGRADE: diarize disabled, backend unavailable, daemon error, sherpa missing, zero
    turns, or no usable segments → leave today's plain `.transcript.txt`, write NO `.speakers.json`,
    print a one-line stderr note, continue. NEVER raise out of the diarize stage.
  - Criterion 4: the labelled transcript written here is the diarize output; it is NOT a "cleanup"
    rewrite. The cleanup prompt still overwrites `.transcript.txt` later via agent_queue_worker; the
    `.speakers.json` sidecar remains source-of-truth. Low-confidence/UNKNOWN segments come straight
    from `assign_speakers` (already flagged) — not laundered.
  </behavior>
  <files>yulu/scripts/transcribe.py</files>
  <verify>pytest tests/test_transcribe_diarize.py tests/test_transcribe_dual_track.py tests/test_transcribe_search_hook.py tests/test_transcribe_enqueue.py -q</verify>
  <done>enabled → both files + upsert with labelled body; disabled/unavailable → plain transcript,
  no sidecar, no error; re-diarize preserves a prior rename; existing transcribe tests still pass.</done>
</task>

<task type="auto" id="4" name="Summary prompt-var pair">
  <behavior>
  Additive, mirroring `{{my_transcript}}`/`{{their_transcript}}`:
  - `prompts/cache.render()`: add `speaker_transcript: str = ""`, `speaker_list: str = ""` params +
    two `.replace()` calls for `{{speaker_transcript}}` / `{{speaker_list}}`. Defaults `""` so every
    existing prompt/caller renders unchanged. Update the docstring var list.
  - `agent_queue_worker._handle_summary_request`: read `<stem>.speakers.json` when present; build
    `speaker_transcript` (the labelled transcript — render_from_sidecar, or the transcript_text it
    already reads) and `speaker_list` (a compact roster like "Speaker 1, Lewis, Speaker 3" from the
    speakers map, resolving merges + skipping merged-away ids). Pass both into `cache.render`.
    Absent sidecar → both `""` (degrade). Export carries labels because the roster + labelled
    transcript are now in the prompt (criterion 3, DATA only).
  </behavior>
  <files>
  yulu/scripts/prompts/cache.py
  yulu/scripts/agent_queue_worker.py
  </files>
  <verify>pytest tests/test_prompts_cache.py tests/test_agent_queue_worker.py tests/test_summary_speaker_vars.py -q</verify>
  <done>render substitutes the new vars and leaves legacy prompts unchanged; worker passes the
  roster + speaker transcript when a sidecar exists, "" when not.</done>
</task>

<task type="auto" id="5" name="Tests: orchestration + opt-in real integration">
  <behavior>
  CI-safe unit tests (mock the daemon/diarize RPC — no sherpa):
  - `test_diarize_rpc.py`: DIARIZE encode/decode round-trip; `_on_diarize` returns turns with a fake
    backend, ENGINE_UNAVAILABLE with `diarize_backend=None`, INTERNAL on backend raise.
  - `test_transcribe_calendar_prior.py`: meeting_id link, title link, no-link→None, malformed→None.
  - `test_transcribe_diarize.py`: enabled writes labelled `.transcript.txt` + `.speakers.json` +
    upsert (mock `request_diarize` → canned turns, mock segments); disabled degrades; backend
    unavailable degrades; re-diarize preserves a prior rename (seed a renamed sidecar, re-run with
    renumbered clusters, assert the rename survives); low-confidence segment stays flagged in the
    sidecar (not laundered).
  - `test_summary_speaker_vars.py`: render substitutes the pair; legacy prompt with no vars
    unchanged; worker builds roster + passes vars from a sidecar; absent sidecar → "".
  - Opt-in `test_transcribe_diarize_integration.py` (marked integration): pick an interpreter that
    can import sherpa (current or `~/funasr-spike/venv-sherpa`), run a real diarize on the 60s clip
    in a subprocess driving the production backend, feed canned ASR segments through the REAL
    `assign_speakers`, assert a labelled transcript + sane sidecar; SKIP cleanly when sherpa/clip
    absent. Mirror test_diarize_integration.py's interpreter-pick + skip pattern.
  Run `make pytest`; hold the 967/1 baseline (new unit tests add to the pass count; integration
  stays skipped in CI).
  </behavior>
  <files>
  tests/test_diarize_rpc.py
  tests/test_transcribe_calendar_prior.py
  tests/test_transcribe_diarize.py
  tests/test_summary_speaker_vars.py
  tests/test_transcribe_diarize_integration.py
  </files>
  <verify>make pytest</verify>
  <done>all new tests pass; full suite green with zero regressions vs 967/1; integration skips
  cleanly without sherpa.</done>
</task>

## Success Criteria

1. diarize enabled → labelled transcript + sidecar + upsert; absent/disabled → plain transcript, no
   error; re-diarize preserves renames.
2. summary via one additive prompt-var pair, `""` defaults, existing prompts unchanged.
3. multi-speaker summary attributes to named owners; export carries labels (DATA only).
4. labels never auto-rewrite cleanup output; sidecar is source-of-truth; low-confidence passed
   downstream uncertain.

## Output

- `transcribe.py` orchestrates the full ASR→diarize→merge→persist→upsert flow with graceful degrade.
- Daemon DIARIZE RPC + `request_diarize` client.
- `{{speaker_transcript}}`/`{{speaker_list}}` prompt vars wired through the worker.
- ~5 new test files; 967/1 baseline held.
