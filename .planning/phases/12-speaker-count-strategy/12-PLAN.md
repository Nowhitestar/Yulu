---
phase: 12
plan: 12
subsystem: diarization-count-strategy
requires: [10, 11]
---

# Phase 12 Plan: Speaker-Count Strategy (the Over-Split Fix)

## Approach

A pure, dependency-free **strategy module** + the **backend carry-forward fix** + an **eval-verified
calibration**, in four moves:

### 1. Empirical sweep (decide the levers before coding)

Run the Phase-11 harness against the spike sherpa venv across:
- auto-threshold sweep 0.2–0.8 (CN + EN) → find the calibrated default;
- supplied-count = true count (the calendar-prior path) → measure the count lever;
- under-merge probes (count = truth ± 1).

Record the before/after DER table; let the data pick the design (it did — see 12-SUMMARY).

### 2. `stt_daemon/speaker_count.py` — the strategy ladder (COUNT-01..03)

Pure logic (no sherpa, no I/O), two decision functions:
- `resolve_speaker_count(attendee_count, language, config_num_speakers, config_threshold)` →
  `SpeakerCountStrategy(num_clusters, threshold, source, attendee_count)`. Precedence: config pin >
  calendar prior (clamped to `[2, MAX_AUTO_SPEAKERS]`) > auto-at-calibrated-threshold. This is the
  one-pass decision (COUNT-01 + COUNT-02 + COUNT-03 clamp).
- `reconcile_count(auto_count, attendee_count, language, config_threshold)` → the criterion-4
  two-pass decision: force the prior ONLY when sherpa's observed `auto_count` disagrees with it;
  else keep auto. This is what protects EN.

Calibrated constants derived from the sweep: `CALIBRATED_THRESHOLD=0.5`, `CN_THRESHOLD=0.5`
(language seam kept), `MAX_AUTO_SPEAKERS=8` (under-merge ceiling), `MIN_SPEAKERS=2`,
`RECONCILE_TOLERANCE=0`.

### 3. Backend carry-forward fix + per-call threshold (`backends/diarize.py`)

Replace the "rebuild + reassign `self._sd`" override path with a **count-keyed pipeline cache**
(`self._pipelines[(num_clusters, threshold)]`). The resident default pipeline is seeded into the
cache at `warm_up` and **never overwritten** — so a per-call override is served from its own cached
pipeline and can never bleed into auto mode. Add a per-call `threshold` arg (the strategy needs it).

### 4. Wire the strategy into the eval + write tests

- Harness `--use-strategy` (+ `--attendee-count`): runs the production backend through the
  `resolve` + `reconcile` two-pass flow, so the eval measures the SHIPPED path.
- Unit tests (CI-safe, no sherpa): supplied-count wins; CN/EN threshold selection; under-merge
  clamp; reconcile keeps-auto-on-agree / forces-on-disagree; cache no-bleed override→auto.
- Opt-in integration: re-run the eval with the strategy; assert CN DER drops + EN doesn't regress.
- `make pytest` green, zero regressions vs the 940/1 baseline.

## Phase-13 hand-off (the calendar-prior interface)

Phase 13 computes `attendee_count = len(event["attendees"]) or None` from the recording's linked
calendar event (`meeting_id` → `schedule.json` → `check_meetings.py`), then runs the documented
two-pass `resolve` + `reconcile` flow (see `speaker_count.py` module docstring) against the live
`diarize_backend`. Nothing in this phase reaches the network or the calendar — it defines and proves
the interface; Phase 13 feeds it.

## Out of scope (this phase)

- The actual per-meeting calendar lookup + pipeline call (Phase 13).
- Any UI surface for "how many speakers?" (Phase 14, gated).
- A human-labelled real CN gold corpus (carried from Phase 11 as `human_needed`).
