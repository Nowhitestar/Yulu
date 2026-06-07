# Phase 13 Context: Pipeline + Summary Integration

**Milestone:** v0.6 Speaker Diarization
**Requirements:** SPKUI-05, SPKUI-06
**Type:** Backend-only wiring (UI gated — Phase 14 last)
**Depends on:** Phase 9 (merge core + sidecar), Phase 10 (diarize backend), Phase 12 (count strategy)

## Goal (from ROADMAP)

Wire the proven core into the live flow. `transcribe.py` orchestrates
ASR → diarize → `speaker_merge.assign_speakers` → persist `.transcript.txt` + `.speakers.json`
→ search upsert, degrading gracefully to today's plain transcript when diarization is
absent/disabled. The speaker-attributed transcript reaches the agent-queue summary via one
additive prompt-var pair so the agent attributes action items to owners — all without
disturbing the `.transcript.txt` cleanup output.

## What already exists (consumed, not rebuilt)

- **Phase 9** `stt_daemon/speaker_merge.py` — `assign_speakers`, `build_sidecar`, `write_sidecar`,
  `read_sidecar`, `speakers_sidecar_path`, `prior_map_from_sidecar`, `reanchor_by_overlap`,
  `render_from_sidecar`, `apply_rename`. Pure, fully tested (32 tests).
- **Phase 10** `stt_daemon/backends/diarize.py` — `SherpaDiarizeBackend` (`warm_up`/`diarize`/
  `is_ready`/`release`), `SpeakerTurn`, `resolve_model_paths`, `models_present`. Constructed in
  `__main__._build_diarize_backend` and attached to `app.diarize_backend`. sherpa lazy-imported.
- **Phase 12** `stt_daemon/speaker_count.py` — `resolve_speaker_count` + two-pass `reconcile_count`;
  the docstring literally contains the Phase-13 wiring recipe. Pure.

## What is MISSING (this phase builds it)

1. **Daemon RPC for diarize.** There is NO `JobKind.DIARIZE`, NO `DiarizeRequest`/`DiarizeResponse`
   in `protocol.py`, NO handler in `app.py`, NO `request_diarize` in `transcribe_client.py`. The
   backend is attached to the app but unreachable. `__main__.py:83` explicitly says "Phase 13 wires
   the JobKind.DIARIZE dispatch."
2. **transcribe.py orchestration** of ASR → diarize → merge → persist both files → search upsert,
   with graceful degrade.
3. **Calendar-prior resolution** at transcribe time: map `audio_path` → attendee count via
   `schedule.json` (matched by `meeting_id` from recording state, else by title), feeding the
   Phase-12 two-pass flow. Degrades to `None` (auto) with no calendar link.
4. **Summary prompt vars.** `prompts/cache.render()` gains `{{speaker_transcript}}` /
   `{{speaker_list}}` (`""` defaults); `agent_queue_worker._handle_summary_request` reads
   `.speakers.json` and passes them.

## CRITICAL runtime constraint

Yulu's runtime venv is **Python 3.14** and **sherpa-onnx is NOT installed there** (that is
Phase 15/PORT-01). So the diarize RPC MUST graceful-degrade when the backend is unavailable:
- the daemon handler returns an error/empty when `app.diarize_backend is None` or sherpa missing;
- `transcribe.py` treats ANY diarize failure as "no diarization" → writes today's plain transcript,
  NO error, NO speakers.json. Diarization is opt-in via `transcription.diarization.enabled=true`.
- Real diarize is exercised only by the opt-in integration test using the spike venv
  (`~/funasr-spike/venv-sherpa`) + 60s clip.

## Success criteria (acceptance bar)

1. diarization ENABLED → labelled `.transcript.txt` + `.speakers.json` + search upsert; ABSENT/
   DISABLED → today's plain transcript, no error. Re-diarize uses `prior_map_from_sidecar` +
   `reanchor_by_overlap` so renames survive.
2. summary gets the speaker transcript via ONE additive prompt-var pair (`{{speaker_transcript}}` /
   `{{speaker_list}}`) with `""` defaults — every existing prompt unchanged.
3. multi-speaker summary can attribute action items to named owners; export carries labels (DATA
   only, no UI).
4. labels NEVER auto-rewrite the `.transcript.txt` cleanup output; `.speakers.json` is source of
   truth; low-confidence/UNKNOWN/hallucination passed downstream as uncertain, not laundered.

## Hard constraints

- ⚠ UI gate: do NOT touch `yulu/scripts/yulu_ui/**`.
- No `~/.yulu` / `~/.config/yulu` mutation.
- Atomic Conventional Commits; don't push.
- Baseline to hold: **967 passed / 1 skipped**.

## Key design decisions (from ARCHITECTURE.md)

- Merge runs in `transcribe.py` (orchestrator), NOT the backend — backend is audio→turns only.
- `.speakers.json` sidecar is source-of-truth; `.transcript.txt` carries inline labels for display.
- The diarize backend stays OFF the ASR fallback chain (separate JobKind, separate app attribute).
- Prompt vars mirror the `{{my_transcript}}`/`{{their_transcript}}` dual-track addition exactly.
