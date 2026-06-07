# Roadmap: Yulu — v0.6 Speaker Diarization

## Overview

This milestone adds local-first, cross-platform **speaker attribution** ("who-said-what") to Yulu meeting transcripts. It is **not** a greenfield subsystem — it is the **N-speaker generalization of the 2-speaker dual-track path Yulu already ships** (`stt_daemon/transcript_merge.py` already emits `[MM:SS 我] … / [MM:SS 对方] …` from *channels*). The job is to split the single far-end/system stream — where multiple remote people are mixed — into distinct voices, label them, and let the user name them, riding the existing **sidecar → prompt-var → UI** rails end-to-end. ASR stays MLX/whisper.cpp untouched. The engine is settled by spikes 001/002: **sherpa-onnx** (ONNX Runtime, no torch, ~33 MB models, CPU-fast, genuinely cross-platform), chosen over FunASR specifically because it satisfies the milestone's "must not hard-couple to macOS" mandate. Net new shipped-runtime dependency: one (`sherpa-onnx`); the eval harness lives in a dev/eval venv only.

The build order front-loads the **highest-risk pure logic** and lands the **eval as a gate, not a tail**. The dominant risk is *quality, not throughput*: sherpa over-splits on Chinese (59→32→20, never near the true ~5), ~8–12% of ASR segments fall in a coverage gap, whisper hallucinates on silence, and overlap mis-attributes — every one of these cascades into a wrong-owner action item in the summary, so accuracy gets the weight. The journey: harden the pure `speaker_merge` core + `<stem>.speakers.json` sidecar on fixtures first (Phase 9, zero deps); stand up the resident `SherpaDiarizeBackend` + offline model provisioning + capability probe in parallel (Phase 10); build the DER/WDER eval harness that picks the default provider on evidence and sets honest UI copy (Phase 11, the gate); calibrate the speaker-count strategy against that eval (Phase 12); wire ASR→diarize→merge into the live pipeline and the agent-queue summary (Phase 13); render labels with rename/merge/correct + honest copy (Phase 14); and close the cross-platform/footprint/migration mandate (Phase 15). This respects the v0.5 one-way layering (`provision → capabilities → platform → runtime`) with zero back-edges.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

**Continuation note:** v0.5 shipped Phases 1–8 (see git history + PROJECT.md). v0.6 continues the numbering at **Phase 9**. The historical `phases/01–08` directories remain in place untouched.

- [x] **Phase 9: Speaker-Merge Core + `.speakers.json` Sidecar** - The pure, I/O-free overlap-assignment engine + sidecar data model, hardened on fixtures with no sherpa/daemon/SQLite ✓ (verified 2026-06-06: 5/5 criteria, 32 tests)
- [x] **Phase 10: Diarize Backend + Provisioning + Capability Probe** - Resident `SherpaDiarizeBackend` (warm_up/diarize/is_ready/release), offline ONNX model provisioning, tri-state `probe_diarization()` (completed 2026-06-06)
- [x] **Phase 11: DER/WDER Evaluation Harness (the Gate)** - Labelled CN+EN corpus + torch-free DER/WDER/SER/count-error harness that picks the default provider on evidence and sets UI accuracy copy ✓ (completed 2026-06-07: 5/5 criteria, 36 tests; default=sherpa-onnx ADR-005; measured EN DER 0.007 / CN DER 0.682 auto, pyannote-cross-checked)
- [ ] **Phase 12: Speaker-Count Strategy (the Over-Split Fix)** - Calendar-attendee prior → CN-calibrated threshold → fail-toward-under-merge, verified against the eval
- [ ] **Phase 13: Pipeline + Summary Integration** - Wire ASR→diarize→merge into `transcribe.py`; flow speaker-attributed transcript into the agent-queue summary via one additive prompt-var pair
- [ ] **Phase 14: Speaker UI — Labels, Rename/Merge/Correct, Honest Copy** — ⚠ **GATED on in-flight web-UI redesign; execute LAST** (see STATE.md Blockers) - Per-speaker blocks + color + click-to-seek; "You" auto-known; rename-all/merge/correct; export; labels-are-a-hint copy
- [ ] **Phase 15: Portability, Footprint & Migration** - Cross-platform sherpa/ONNX verification behind the abstraction; per-meeting wall-clock + peak-RAM regression budget; seamless `yulu migrate` upgrade

## Phase Details

### Phase 9: Speaker-Merge Core + `.speakers.json` Sidecar

**Goal**: The milestone's highest-risk *logic* exists as a pure, dependency-free module — assigning each ASR segment a speaker by timestamp overlap, surviving coverage gaps, hallucination, and re-runs — plus the sidecar data model whose "renames survive re-diarize" property is locked at the file level. Buildable and hardenable on fixtures with no sherpa, no daemon, no SQLite.
**Depends on**: Nothing (first phase of the milestone; parallelizable with Phase 10)
**Requirements**: MERGE-01, MERGE-02, MERGE-03, MERGE-04, MERGE-05
**Success Criteria** (what must be TRUE):

  1. Given canned ASR segments + diarization turns, `assign_speakers()` returns labelled segments + a `[MM:SS Speaker N]` rendered string, picking the max-overlap speaker — verifiable in a unit test with zero sherpa/daemon/SQLite
  2. An ASR segment with no overlapping turn is never dropped: it is filled by same-speaker-bracket → nearest-within-window → explicit `UNKNOWN`, and never snapped across a speaker boundary
  3. A whisper hallucination/repeat segment (duplicate text in a silent stretch) is VAD-gated/flagged and never laundered into a confident wrong-owner attribution; uncertain segments carry a confidence flag
  4. Speaker data round-trips through `<stem>.speakers.json` (raw turns + assignments + editable `speaker_id`→`display_name` map); re-reading reproduces the same labels
  5. Re-diarizing with a `prior_map` re-anchors fresh cluster indices to existing stable `speaker_id`s by overlap and never overwrites a user rename

**Plans**: TBD

### Phase 10: Diarize Backend + Provisioning + Capability Probe

**Goal**: The engine plumbing exists and stays warm — a resident `SherpaDiarizeBackend` in `stt_daemon` that mirrors the STT backend lifecycle, dispatched on its own job kind (deliberately held OUT of the ASR fallback chain), fed by offline-by-default ONNX models provisioned through the existing idempotent `models` step, with a tri-state capability probe so the UI can show readiness. Parallelizable with Phase 9 (its output is only needed at integration).
**Depends on**: Nothing for the merge logic (parallel with Phase 9); rides the v0.5 provision/capabilities/platform seams
**Requirements**: DIAR-01, DIAR-02, DIAR-03, DIAR-04, DIAR-05
**Success Criteria** (what must be TRUE):

  1. A `DiarizeBackend` Protocol (audio → speaker turns with timestamps) is config-selected, mirrors the STT lifecycle (`warm_up`/`is_ready`/`release`), and is NOT registered into the ASR runtime dict nor a `CapabilityProvider` subclass (the ASR fallback chain can never route to it)
  2. The default backend is sherpa-onnx (pyannote-3.0 segmentation + 3D-Speaker cam++ embedding) running torch-free on CPU, returning speaker turns for a short real clip
  3. Diarization models (seg ~5.7 MB + cam++ ~27 MB ONNX) provision via the existing `models` step and load from local file paths with zero network calls under a forced-offline test
  4. `doctor.py` reports a tri-state `probe_diarization()` entry with provenance `yulu-managed` (usable / present-but-unverified / absent)
  5. A `warm_up()` dummy pass amortizes the first-run cold-start so the first real meeting isn't JIT-penalized

**Plans**: TBD

### Phase 11: DER/WDER Evaluation Harness (the Gate)

**Goal**: The product gate exists — a labelled CN+EN reference corpus and a torch-free metrics harness that converts "it runs" into a defensible number, picks the default provider (sherpa-onnx vs optional FunASR) on evidence, and sets the UI's accuracy copy from measurement rather than feel. It lands early/parallel (as soon as Phase 10 produces any labels) because hand-labelling is slow and every later tuning change must be measured against it.
**Depends on**: Phase 10 (needs the backend to produce labels to score); runs alongside Phases 12–14
**Requirements**: EVAL-01, EVAL-02, EVAL-03, EVAL-04
**Success Criteria** (what must be TRUE):

  1. A reference corpus of 2–3 real CN+EN meetings is labelled to RTTM without anchoring bias (labels created from audio, not derived from a tool's own output)
  2. The harness reports DER both with and without the 0.25s collar and both with and without overlap scored, plus a short-utterance-sensitive metric (WDER/SER) and speaker-count error, bucketed by language
  3. The default-provider decision (sherpa-onnx vs FunASR) is recorded as an ADR whose justification is the measured numbers, not footprint/feel alone
  4. The UI accuracy copy is set from the measured DER and frames labels as a correctable hint, not ground truth
  5. The harness is re-runnable on the fixed corpus so accuracy is a tracked number every later phase can regress against

**Plans**: TBD

### Phase 12: Speaker-Count Strategy (the Over-Split Fix)

**Goal**: sherpa's known, measured weakness on Chinese (over-splitting 59→32→20, never near the true ~5) is mitigated by a deliberate count-strategy ladder whose failure mode is recoverable *under*-merge, not catastrophic over-split — using the calendar-attendee count Yulu already has as a free prior, then a CN-calibrated threshold, verified to not regress English. Must land before the eval can fairly judge the default.
**Depends on**: Phase 10 (the `num_speakers` hook on the backend), Phase 11 (calibrated and verified against the eval); the calendar prior reuses the existing `gog` integration
**Requirements**: COUNT-01, COUNT-02, COUNT-03
**Success Criteria** (what must be TRUE):

  1. When a calendar event with an attendee count is available (via `gog`), that count is used as a prior before threshold-based auto-clustering
  2. On a real CN meeting, the predicted speaker count lands near the true attendee count (no twenty-phantom-speaker rendering) under a CN-calibrated threshold that is not the library default
  3. When clustering is uncertain, it fails toward UNDER-merge (two people sharing one label, user-recoverable by merge/split) rather than over-splitting into many phantom speakers
  4. The chosen threshold is validated on both CN and EN buckets against the eval so fixing Chinese does not regress English

**Plans**: TBD

### Phase 13: Pipeline + Summary Integration

**Goal**: The proven core is wired into the live flow — `transcribe.py` orchestrates ASR → diarize → `speaker_merge.assign` → persist `.transcript.txt` + `.speakers.json` → search upsert (degrading gracefully to today's plain transcript when diarization is absent/disabled) — and the speaker-attributed transcript reaches the agent-queue summary via one additive prompt-var pair so the agent attributes action items to owners, all without disturbing the `.transcript.txt` cleanup output.
**Depends on**: Phase 9 (the merge core + sidecar), Phase 10 (the diarize backend), Phase 12 (a sane speaker count before labels reach users/the summary)
**Requirements**: SPKUI-05, SPKUI-06
**Success Criteria** (what must be TRUE):

  1. On a recording with diarization enabled, `transcribe.py` writes a speaker-labelled `.transcript.txt` + a `.speakers.json` sidecar and upserts the labelled transcript into search; with diarization absent/disabled it degrades to today's plain transcript with no error
  2. The agent-queue summary receives the speaker-attributed transcript through one additive prompt-var pair (`{{speaker_transcript}}`/`{{speaker_list}}`) with `""` defaults, so every existing prompt keeps working unchanged
  3. A summary generated on a multi-speaker meeting attributes action items / decisions to the named owners; speaker-aware export carries the labels
  4. Speaker labels never auto-rewrite the `.transcript.txt` cleanup output — the `.speakers.json` sidecar remains the source of truth and low-confidence attributions are passed downstream rather than laundered into confident ownership

**Plans**: TBD

### Phase 14: Speaker UI — Labels, Rename/Merge/Correct, Honest Copy

**Goal**: The user-facing payoff — the transcript renders per-speaker blocks with color and click-to-seek on one canonical line format reconciled with the existing parser; "You" is auto-known from the mic channel; and because the engine *will* over-split, correction (rename-all + merge + single-segment reassign) is core, not polish — all persisted to the sidecar, surviving re-diarize, with copy that frames labels as correctable hints sourced from the eval's measured number.
**Depends on**: Phase 9 (the sidecar data model), Phase 13 (the pipeline that produces stored labels), Phase 11 (the accuracy number that sources the honest copy)
**⚠ GATED — execute LAST (after Phase 15)**: The web UI is being redesigned across multiple in-flight branches (`feat/recordings-ui` rewrites the very `TranscriptView.tsx`/`recordings.$stem.tsx` this phase touches; `feat/settings-ui-p1`, `feat/settings-registry`, `feat/remove-voicemail`). Per user directive (2026-06-06): do NOT plan or execute this phase until those land and the reader/transcript components stabilize. When unblocked, plan against the POST-redesign components and re-validate the success criteria below (the `[MM:SS 我]` vs `Speaker A:` parser mismatch, wavesurfer Regions, inline-rename pattern) against the new UI — the criteria as written reference pre-redesign code. Do not touch any `yulu_ui/web/**` file for this milestone before the gate clears.
**Requirements**: SPKUI-01, SPKUI-02, SPKUI-03, SPKUI-04
**Success Criteria** (what must be TRUE):

  1. The transcript renders per-speaker blocks with color-coding and click-to-seek, on one canonical line format reconciled with the existing `TranscriptView` parser (the `[MM:SS 我]` vs `Speaker A:` mismatch is fixed)
  2. The local user ("You"/我) is auto-labelled from the mic channel without the user being asked
  3. A user can rename a speaker once, have it apply everywhere, persist to the sidecar `display_name`, and survive a re-diarize
  4. A user can merge two speaker labels into one (the required recovery path for over-split) and correct a single segment's speaker
  5. Low-confidence segments are visually marked and the UI copy frames labels as correctable hints (sourced from the eval), so trust survives the first visible error

**Plans**: TBD
**UI hint**: yes

### Phase 15: Portability, Footprint & Migration

**Goal**: The milestone's cross-platform mandate is closed and existing users are protected — sherpa-onnx wheels + ONNX models are verified behind the platform abstraction with no macOS coupling (macOS implemented, non-macOS verified/stubbed per the v0.5 pattern); the option-B per-meeting footprint is measured against a regression budget so diarization doesn't degrade the existing pipeline; and existing v0.5.x installs gain diarization on upgrade via the existing `yulu migrate` path with no data loss.
**Depends on**: Phase 10 (the backend + provisioning to verify/measure/migrate), Phase 13 (the integrated pipeline whose footprint is measured)
**Requirements**: PORT-01, PORT-02, PORT-03
**Success Criteria** (what must be TRUE):

  1. sherpa-onnx wheels + ONNX models resolve behind the platform abstraction with no macOS-specific code (macOS impl now; non-macOS verified/stubbed per the v0.5 pattern; Python 3.14 wheel resolution confirmed or an isolated venv used)
  2. Per-meeting added wall-clock and peak RAM are measured on 20-min / 1h / long clips against an explicit regression budget, and diarization stays off the live/critical path (the realtime stream never stalls)
  3. An existing v0.5.x install gains diarization through the existing `yulu migrate` path (the `models` step re-provisions sherpa + ONNX) with no data loss; recordings without a `.speakers.json` simply show no labels until re-diarized

**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 9 → 10 → 11 → 12 → 13 → 14 → 15

Parallelism (for `/gsd-plan-phase` ordering, not separate execution lanes): Phases 9 and 10 are independent (pure logic vs backend) and can be planned/built concurrently; Phase 11 (eval) runs alongside 12–14 because it is slow to build and gates the default; Phases 13 and 14 are independent once the sidecar (9) and pipeline (13) land — but 14 consumes 13's stored labels, so 13 precedes 14 in execution order.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 9. Speaker-Merge Core + Sidecar | 1/1 | ✅ Complete | 5/5 criteria, 32 tests |
| 10. Diarize Backend + Provisioning | 1/1 | ✅ Complete | 5/5 criteria, +31 tests (904 pass) |
| 11. DER/WDER Eval Harness | 1/1 | ✅ Complete | 5/5 criteria, 36 tests; ADR-005 sherpa-onnx; EN DER 0.007 / CN DER 0.682 (auto), pyannote-cross-checked |
| 12. Speaker-Count Strategy | 0/? | Not started | - |
| 13. Pipeline + Summary Integration | 0/? | Not started | - |
| 14. Speaker UI | 0/? | Not started | - |
| 15. Portability, Footprint & Migration | 0/? | Not started | - |
