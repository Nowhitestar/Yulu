---
gsd_state_version: 1.0
milestone: v0.6
milestone_name: Speaker Diarization
status: planning
last_updated: "2026-06-06T10:32:00.000Z"
last_activity: 2026-06-06
progress:
  total_phases: 7
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-06)

**Core value:** A meeting becomes a clean, searchable note entirely on the user's machine, through the agent they already trust — capture and transcription never depend on the cloud, and Yulu never makes the user reconfigure what their agent already provides.
**Current focus:** v0.6 Speaker Diarization — roadmap created (Phases 9–15); ready to plan Phase 9

## Current Position

Phase: 9 — Speaker-Merge Core + `.speakers.json` Sidecar (not started)
Plan: —
Status: Roadmap created — ready for `/gsd-plan-phase 9`
Last activity: 2026-06-06 — v0.6 roadmap created (7 phases, 9–15; 26/26 reqs mapped)

## Performance Metrics

**Velocity:**

- Total plans completed: 29
- Average duration: — min
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 6 | - | - |
| 2 | 4 | - | - |
| 3 | 3 | - | - |
| 4 | 4 | - | - |
| 5 | 4 | - | - |
| 6 | 4 | - | - |
| 7 | 3 | - | - |
| 8 | 1 | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 1 P01 | 4 | 2 tasks | 7 files |
| Phase 01 P02 | 5 | 2 tasks | 4 files |
| Phase 01 P03 | 8 | 2 tasks | 6 files |
| Phase 01 P04 | 7 | 2 tasks | 3 files |
| Phase 01 P05 | 19 | 2 tasks | 6 files |
| Phase 01 P06 | 7 | 2 tasks | 4 files |
| Phase 02 P01 | 6 | 3 tasks | 5 files |
| Phase 02 P03 | 6 | 2 tasks | 6 files |
| Phase 02 P02 | 7min | 2 tasks | 6 files |
| Phase 02 P04 | 11 | 2 tasks | 6 files |
| Phase 03 P01 | 9 | 2 tasks | 5 files |
| Phase 03 P02 | 5 | 1 tasks | 3 files |
| Phase 03 P03 | 12 | 1 tasks | 2 files |
| Phase 04 P01 | 13 | 2 tasks | 5 files |
| Phase 04 P02 | 5 | 2 tasks | 4 files |
| Phase 04 P03 | 4min | 2 tasks | 4 files |
| Phase 04 P04 | 3 | 2 tasks | 4 files |
| Phase 05 P01 | 17 | 2 tasks | 6 files |
| Phase 05 P02 | 13 | 3 tasks | 5 files |
| Phase 05 P03 | 11 | 2 tasks | 3 files |
| Phase 05 P04 | 13min | 3 tasks | 7 files |
| Phase 06 P01 | 11 | 2 tasks tasks | 3 files files |
| Phase 06 P02 | 16 | 2 tasks | 4 files |
| Phase 06 P03 | 8min | 2 tasks | 3 files |
| Phase 06 P04 | 12min | 2 tasks tasks | 7 files files |
| Phase 07 P01 | 14 | 2 tasks | 4 files |
| Phase 07 P02 | 10min | 2 tasks tasks | 2 files files |
| Phase 07 P03 | 38 | 3 tasks | 7 files |
| Phase 08 P01 | 14 | 2 tasks | 2 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [v0.6 Roadmap]: Phase numbering CONTINUES from v0.5 — v0.6 is Phases 9–15 (not reset to 1); historical phases/01–08 dirs untouched.
- [v0.6 Roadmap]: Diarization is built as a `DiarizeBackend` Protocol (config-selected) + a tri-state `yulu-managed` probe entry — NOT a `CapabilityProvider` subclass (that ABC means agent-reuse; diarization is Yulu-managed). PROJECT.md's "capability provider" wording is honored as "swappable provider behind an abstraction," resolved to the backend Protocol seam. (research SUMMARY/ARCHITECTURE gap.)
- [v0.6 Roadmap]: The pure `speaker_merge` core + `<stem>.speakers.json` sidecar (Phase 9) is the highest-risk LOGIC with ZERO deps — built/tested FIRST on fixtures (no sherpa/daemon/SQLite). Renames-survive-re-diarize is locked at the file level here.
- [v0.6 Roadmap]: The DER/WDER eval harness (Phase 11) is the GATE that picks the default provider (sherpa vs FunASR) and sets UI copy — lands EARLY/parallel (alongside 12–14), NOT last. Provider choice is an ADR output of the eval.
- [v0.6 Roadmap]: Speaker-count strategy (Phase 12) fails toward recoverable UNDER-merge, never over-split; calendar-attendee count (via gog) is the free prior; CN-calibrated threshold verified not to regress EN.
- [v0.6 Roadmap]: Speaker data lives in the synced `<stem>.speakers.json` sidecar (travels with data_dir), NEVER runtime SQLite; speaker embeddings stay ephemeral/local — biometric, never synced, never shipped to a cloud LLM via agent-queue.
- [v0.6 Roadmap]: Reframe — v0.6 generalizes Yulu's EXISTING 2-speaker dual-track path (mic=我 / system=对方) to N voice-clustered speakers (mainly splitting the far-end stream); it is NOT greenfield. ASR stays MLX/whisper.cpp; new shipped-runtime dep = sherpa-onnx only.

### v0.5 Decisions (archived — historical context for the platform/provision/capability seams v0.6 rides)

- [Init]: Build the cross-platform abstraction layer now (macOS-only impl) — avoid deepening lock-in.
- [Init]: Multi-agent from v1 (Claude Code + Codex + OpenClaw) via a capability-provider abstraction.
- [Phase 03]: [03-02] CapabilityProvider ABC = agent_name + a SINGLE @abstractmethod capabilities() -> dict[str, Capability]; agent-neutral by contract (D-06) — a new provider is pure addition, zero edits to report.py/probes.py/doctor.py.
- [Phase ?]: [05-01] runtime_dir() LOCKED machine-local (never reads audio.output_dir), stays ~/.config/yulu; data_dir() is the only configurable content root — speaker sidecars ride data_dir, runtime SQLite stays unsynced.
- [Phase ?]: [06-01] provision/ registry WRAPS the six setup_*.sh 1:1 via argv-list subprocess; StepResult frozen dataclass; apply() short-circuits to skipped when read-only check() satisfied (idempotency contract) — the diarization `models` step extends this.
- [Phase 07]: [07-03] Transactional apply (move-to-pristine-backup + working copy + prune-on-verified-success-only) — `yulu migrate` for v0.6 diarization rides this path.

### Pending Todos

[From .planning/todos/pending/ — ideas captured during sessions]

None yet.

### Blockers/Concerns

[Issues that affect future work]

- **Research flags (deeper per-phase research recommended via `/gsd-plan-phase --research-phase`):**
  - **Phase 12 (Speaker-count strategy):** the highest-leverage *unsolved* accuracy lever — CN-calibration thresholds + constrained-clustering knobs are unproven for Yulu; needs sherpa-onnx config research + empirical sweeps.
  - **Phase 11 (Eval harness):** DER methodology is trap-dense (collar/overlap/WDER/SER/anchoring/tiny-N); worth a focused pass on pyannote.metrics protocol + reference-labelling discipline.
  - **Phase 15 (Cross-platform/footprint):** the option-B footprint was NEVER measured (spike only timed the 20-min merge); needs a measurement plan + non-macOS wheel verification.
- **Phase 10 venv co-location:** Yulu's venv is Python 3.14; sherpa-onnx publishes cp314 wheels but resolution is unverified — verify in Phase 10; isolate into a small dedicated venv if it conflicts (the provision step already isolates envs).
- **Standard-pattern phases (skip research-phase — in-codebase precedent exists):** Phase 9 (merge core — `transcript_merge.py` is a literal template), Phase 10 (backend/provision — mirrors STT backend Protocol + v0.5 `models` step), Phase 13 (pipeline/summary — mirrors the dual-track `{{my_transcript}}` addition exactly), Phase 14 (UI — reuses inline-rename + optimistic-patch + wavesurfer Regions patterns).
- **Privacy guard (cross-cutting):** speaker embeddings are biometric voiceprints — ephemeral by default, never written into synced `data_dir`, never shipped to a cloud LLM via the agent-queue boundary. v0.6 stays anonymous per-meeting + manual labels (cross-meeting voiceprint enrollment is explicitly Out of Scope).

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-06-06T10:32:00.000Z
Stopped at: v0.6 roadmap created (Phases 9–15, 26/26 reqs mapped); resume by running `/gsd-plan-phase 9`
Resume file: None
