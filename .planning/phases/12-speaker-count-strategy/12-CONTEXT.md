---
phase: 12
plan: 12
subsystem: diarization-count-strategy
tags: [speaker-count, over-split, calendar-prior, gog, threshold-calibration, under-merge, reconcile]
requires: [10, 11]
provides: [speaker-count-strategy, calendar-prior-interface, override-bleed-fix, per-call-threshold]
affects: [yulu/scripts/stt_daemon, yulu/scripts/eval]
---

# Phase 12 Context: Speaker-Count Strategy (the Over-Split Fix)

## Goal (from ROADMAP)

Mitigate sherpa's measured count weakness with a deliberate **count-strategy ladder** whose failure
mode is recoverable **under-merge**, not catastrophic over-split — using the calendar-attendee count
(via the existing `gog` integration) as a free prior, then a CN-calibrated threshold, verified
against the Phase-11 eval to NOT regress English.

## Inputs / starting state

- **Phase-11 gate output (the target):** CN auto-DER **0.682** (poor) / EN auto-DER **0.007** (good),
  pyannote-cross-checked. The verifier flagged the CN gap as the **count-knob, not embeddings**.
- **Phase-10 backend:** `SherpaDiarizeBackend.diarize(num_speakers=...)` hook exists, but a per-call
  `num_speakers` override **rebuilt and reassigned `self._sd`** — so a forced-count call bled into
  the next auto call (the carry-forward bug to fix here).
- **Eval harness (Phase 11):** `yulu/scripts/eval/{harness,corpus,metrics,rttm}.py`; a re-runnable
  constructed CN+EN corpus + torch-free DER/WDER/SER/count metrics; pyannote cross-check available
  in `~/funasr-spike/venv-eval`.
- **Calendar source:** `check_meetings.py::_fetch_google` already returns each event's `attendees`
  list via `gog calendar events ... --json`. A recording is linked to its event by `meeting_id`
  (threaded through `meeting_daemon.py` → `schedule.json`). `len(attendees)` is the free prior.
- **Spike resources:** `~/funasr-spike/venv-sherpa/bin/python` (sherpa-onnx 1.13.2) + models under
  `~/funasr-spike/sherpa-models/`.

## What this phase must produce (success criteria 1-4)

1. Calendar-attendee count used as a prior `num_speakers` BEFORE threshold auto-clustering.
2. A CN-calibrated clustering threshold (not the library default) for the no-count path.
3. Fail toward UNDER-merge when uncertain (fewer speakers, user-recoverable), never over-split.
4. Validated on BOTH CN and EN against the eval — fixing CN must NOT regress EN.

## Key empirical finding that shaped the design

On the constructed corpus, sherpa's auto mode **collapses the 3 Mandarin TTS voices to 1 speaker
across the ENTIRE threshold range (0.2–0.8)** — the segmentation finds the turns, but cam++ can't
separate these acoustically-similar synthetic voices. So **no auto threshold recovers CN here**; the
only lever that moves the count is a **supplied count**. Forcing a count fixes CN (DER 0.682→0.505,
count -2→+0) but, applied blindly, *regresses* EN (auto already nailed 3 → forcing 3 perturbs
clustering → 0.007→0.318). The resolution is a **two-pass reconcile**: run auto, then force the
calendar prior ONLY when auto disagrees with it — which fixes CN and leaves EN at 0.007.

## Constraints honored

- ⚠ UI gate: no `yulu/scripts/yulu_ui/**` touched.
- No Yulu runtime-venv / `~/.yulu` / `~/.config/yulu` mutation — all sherpa work via the spike venv.
- Atomic Conventional Commits (`feat(diarize):`, `test(diarize):`, `docs(diarize):`); no push.
