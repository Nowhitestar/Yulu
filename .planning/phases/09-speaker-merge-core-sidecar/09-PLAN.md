---
phase: 9
plan: 09
type: standard
subsystem: stt_daemon / speaker-diarization
autonomous: true
requirements: [MERGE-01, MERGE-02, MERGE-03, MERGE-04, MERGE-05]
depends_on: []
---

# Phase 9 Plan: Speaker-Merge Core + `.speakers.json` Sidecar

## Objective

Land the milestone's highest-risk *logic* as a pure, I/O-free Python module plus its
on-disk sidecar data model — assign each ASR segment a speaker by timestamp overlap,
survive coverage gaps / whisper hallucination / re-runs — hardened on fixtures with
**no sherpa, no daemon, no SQLite, no network**.

In scope: `stt_daemon/speaker_merge.py` (pure functions) + the `<stem>.speakers.json`
read/write/round-trip + an exhaustive pytest suite covering all 5 ROADMAP success criteria.
Out of scope: sherpa backend (Phase 10), pipeline wiring (Phase 13), any UI (Phase 14, GATED).

## Context

- `yulu/scripts/stt_daemon/transcript_merge.py` — the literal in-codebase template (2-speaker
  channel-merge). `speaker_merge.py` is its N-speaker sibling; same `[MM:SS speaker] text` line
  format, same whitespace/blank-skipping rules, same "empty → ''" contract.
- `.planning/research/ARCHITECTURE.md` §2/§3 — merge module design, sidecar schema, idempotent re-anchor.
- `.planning/spikes/002-option-b-diarization-merge/REPORT.md` — overlap-argmax, ~8–12% coverage gap, agreement numbers.
- ASR segment shape `{start, end, text}` (seconds); diarization turn shape `{start, end, speaker}` (seconds, sherpa).

## Tasks

1. **(auto, tdd) `speaker_merge.py` overlap-assignment core + render** — `assign_speakers()` picks
   max-overlap speaker per ASR segment, emits labelled segments + `[MM:SS <name>]` string in the
   `transcript_merge` format. Default names `Speaker 1..N` from stable `speaker_id` map.
   → MERGE-01. Success criterion 1.

2. **(auto, tdd) Coverage-gap fallback** — an ASR segment with no overlapping turn is NEVER dropped:
   same-speaker-bracket → nearest-within-window → explicit `UNKNOWN`; never snap across a speaker
   boundary. Carry a per-segment `source`/confidence flag. → MERGE-02. Success criterion 2.

3. **(auto, tdd) Hallucination / repeat guard** — collapse consecutive identical-text same-speaker
   segments; flag zero-overlap duplicate-of-neighbour text as low-confidence (VAD-gate); never
   launder into a confident wrong-owner attribution. → MERGE-03. Success criterion 3.

4. **(auto, tdd) `<stem>.speakers.json` sidecar read/write/round-trip** — schema (raw turns +
   per-segment assignments + editable `speaker_id`→`display_name` map + provenance/version);
   atomic write (`os.replace`, mirroring `queue_store`/`live_session`); round-trip reproduces labels.
   No biometric embeddings stored. → MERGE-04. Success criterion 4.

5. **(auto, tdd) Idempotent re-anchor** — re-diarize with a `prior_map` re-anchors fresh cluster
   indices to existing stable `speaker_id`s by overlap; NEVER overwrites a user rename
   (`renamed: true`); ambiguous → keep prior + flag low-confidence. → MERGE-05. Success criterion 5.

6. **(auto) GSD artifacts + green test run** — write `09-SUMMARY.md`; run `make pytest` (or
   `python3 -m pytest tests -q`) until GREEN; map each of the 5 criteria → its proving test(s).

## Verification / Success Criteria

The 5 ROADMAP Phase-9 success criteria, each as a passing pytest:
1. `assign_speakers()` returns labelled segments + `[MM:SS Speaker N]` string, max-overlap, zero deps.
2. No-overlap segment filled by same-speaker-bracket → nearest-within-window → `UNKNOWN`, never crosses a boundary.
3. Hallucination/repeat segment VAD-gated/flagged, never a confident wrong owner; uncertain → confidence flag.
4. Round-trips through `<stem>.speakers.json`; re-read reproduces the same labels.
5. Re-diarize with `prior_map` re-anchors by overlap and never overwrites a user rename.

Plus edge cases: empty input, full coverage gap, overlapping turns, hallucination repeat, re-anchor preserving a rename.

## Hard Constraints

- ⚠ UI GATE: do NOT create/edit any file under `yulu/scripts/yulu_ui/`. Backend/Python only.
- Pure core: no sherpa, no daemon, no SQLite, no network in `speaker_merge.py`.
- Dev worktree only; never touch `~/.yulu` or `~/.config/yulu`.
- Atomic commits, Conventional Commits prefixes; do not push.

## Output

- `yulu/scripts/stt_daemon/speaker_merge.py` (new, pure).
- `tests/test_speaker_merge.py` (new, full criteria coverage).
- `.planning/phases/09-speaker-merge-core-sidecar/09-PLAN.md`, `09-SUMMARY.md`.
