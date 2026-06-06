# Phase 9: Speaker-Merge Core + `.speakers.json` Sidecar - Context

**Gathered:** 2026-06-06
**Status:** Ready for planning
**Mode:** Auto-seeded (autonomous run; standard-pattern phase, crisp ROADMAP spec + spike/research grounding)

<domain>
## Phase Boundary

The milestone's highest-risk *logic* as a pure, dependency-free Python module: assign each ASR
segment a speaker by timestamp overlap; survive coverage gaps, whisper hallucination/repeat, and
re-runs; plus the `<stem>.speakers.json` sidecar data model whose "renames survive re-diarize"
property is locked at the file level. Buildable and hardenable on fixtures with **no sherpa, no
daemon, no SQLite, no I/O in the core function** (the merge function takes data in, returns data out).

IN SCOPE: `stt_daemon/speaker_merge.py` (pure functions) + the sidecar read/write/round-trip + an
exhaustive fixture test suite. OUT OF SCOPE: the sherpa backend (Phase 10), the live pipeline wiring
(Phase 13), any UI (Phase 14, GATED).
</domain>

<decisions>
## Implementation Decisions

### Locked (from spikes 001/002 + research ARCHITECTURE.md / SUMMARY.md — see .planning/research/ and .planning/spikes/)
- **Mirror `stt_daemon/transcript_merge.py`** — it is the direct in-codebase template (it already
  emits `[MM:SS speaker] text` for the 2-speaker mic/system path). `speaker_merge.py` is its
  N-speaker sibling and lives beside it.
- **Pure + I/O-free core:** `assign_speakers(asr_segments, diarization_turns, ...) -> labelled segments`
  picks max-overlap speaker; unit-testable with zero sherpa/daemon/SQLite.
- **Coverage-gap fallback:** an ASR segment with no overlapping turn is NEVER dropped — fill via
  same-speaker-bracket → nearest-within-window → explicit `UNKNOWN`; never snap across a speaker boundary.
- **Hallucination/repeat:** VAD-gate/flag duplicate text in silent stretches; never launder into a
  confident wrong-owner attribution; uncertain segments carry a confidence flag downstream.
- **Sidecar `<stem>.speakers.json`:** raw turns + per-segment assignments + editable
  `speaker_id` → `display_name` map. Travels with `data_dir` (NEVER runtime SQLite). Round-trips.
- **Idempotent re-anchor:** re-diarizing with a `prior_map` re-anchors fresh (volatile) cluster
  indices to existing stable `speaker_id`s by overlap and NEVER overwrites a user rename.
- Speaker embeddings are biometric — they are NOT part of the sidecar; only abstract `speaker_id`s.

### Claude's Discretion
Exact function signatures, dataclasses, the windowing constant for "nearest", confidence-flag
representation, and test fixture design — all at Claude's discretion, guided by ROADMAP success
criteria + `transcript_merge.py` conventions.
</decisions>

<code_context>
## Existing Code Insights
- `yulu/scripts/stt_daemon/transcript_merge.py` — the literal template (2-speaker `merge_segments`).
- ASR segment shape: whisper.cpp/MLX produce segments with start/end (see `transcribe.py`,
  `realtime_transcribe.py`). Diarization turns are `{start, end, speaker}` (seconds) per spike 002's
  sherpa output; FunASR `sentence_info` is `{start,end,spk,text}` (ms).
- Sidecar convention: `{stem}.*` beside the recording (like `.transcript.txt`); see `recordings.ts`.
</code_context>

<specifics>
## Specific Ideas
Implements MERGE-01..05. Success criteria are the 5 in ROADMAP.md Phase 9 — each must be a passing
unit test (pytest, in the repo's existing test layout). No network, no models.

⚠ **UI GATE (milestone-wide):** do NOT touch any `yulu_ui/web/**` file. Backend/Python only.
</specifics>

<deferred>
## Deferred Ideas
Sherpa backend (Phase 10), pipeline wiring + summary (Phase 13), UI rendering/rename/merge (Phase 14, GATED).
</deferred>
