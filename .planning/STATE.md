---
gsd_state_version: 1.0
milestone: v0.6
milestone_name: Speaker Diarization
status: executing
last_updated: "2026-06-07T02:54:36.312Z"
last_activity: 2026-06-07 — Phase 13 complete (4/4 criteria; suite 995/1, +28 tests); 15 next, 14 last (gated)
progress:
  total_phases: 7
  completed_phases: 5
  total_plans: 5
  completed_plans: 5
  percent: 71
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-06)

**Core value:** A meeting becomes a clean, searchable note entirely on the user's machine, through the agent they already trust — capture and transcription never depend on the cloud, and Yulu never makes the user reconfigure what their agent already provides.
**Current focus:** v0.6 Speaker Diarization — roadmap created (Phases 9–15); **backend-first, Phase 14 UI gated** on in-flight web-UI redesign (see Blockers). Ready to plan Phase 9.

## Current Position

Phase: 15 — Portability, Footprint & Migration (next)
Plan: —
Status: AUTONOMOUS run in progress. ✅ Phase 9 + ✅ Phase 10 + ✅ Phase 11 + ✅ Phase 12 + ✅ Phase 13 complete. Execution order: run `--only 15`; **14 LAST (gated on UI redesign)**.
Last activity: 2026-06-07 — Phase 13 complete (4/4 criteria; suite 995 passed/1 skip, +28 tests; live pipeline wired, graceful-degrade proven, real integration ran via spike venv)

## Autonomous Run Log (v0.6, 9→13)

- ✅ **Phase 9** Speaker-Merge Core + Sidecar — built (gsd-executor) + independently verified (gsd-verifier) PASSED 5/5; full test suite 873 passed/1 pre-existing skip; UI gate respected (zero `yulu_ui/**`).
- ✅ **Phase 10** Diarize Backend + Provisioning + Capability Probe — built (gsd-executor) 5/5 criteria; **904 passed / 1 pre-existing skip** (+31 new tests, zero regressions); 6 commits 5d3f867/a2bbdea/5399ed7/6128172/c47dc27/a763476; UI gate respected (zero `yulu_ui/**`); real offline integration smoke green (60s clip → 15 turns/3 speakers, dead proxies). **Open: sherpa cp314 wheel resolution into Yulu's 3.14 runtime venv (Phase 15/PORT-01) — built+tested on the 3.10 spike venv only.**
- ✅ **Phase 11** DER/WDER Eval Harness — built (general-purpose; resumed after transient rate-limit) + verified (gsd-verifier) PASSED 5/5; **940 passed/1 skip** (+36 tests, zero regressions); commits for eval harness + ADR-005 (default=sherpa-onnx). **Gate output:** EN DER **0.007** (excellent) / CN DER **0.682** (auto, poor) — pyannote-cross-checked; the CN gap is the **count-knob (Phase 12 target), not embeddings**. Eval deps (pyannote.metrics) dev-venv only. UI-copy string backend-side (`eval/ui_copy.py`). Deferred: human-labelled real CN+EN gold corpus.
- ✅ **Phase 12** Speaker-Count Strategy (the Over-Split Fix) — built 4/4 criteria. New pure `stt_daemon/speaker_count.py` (`resolve_speaker_count` + two-pass `reconcile_count`): calendar-attendee count (via `gog`/`check_meetings.py` `attendees`, linked by `meeting_id`) is the free prior; clamped to `[2, MAX_AUTO_SPEAKERS=8]` (fail-toward-under-merge); auto threshold calibrated to 0.5 (EN-optimal). **CN DER 0.682→0.505 (count -2→+0) / EN held 0.007** via auto-first-then-reconcile (force prior ONLY when auto disagrees → no EN regression); pyannote-cross-checked (CN 0.505 exact). **Carry-forward FIXED:** count-keyed pipeline cache in `diarize.py` — per-call `num_speakers`/`threshold` override served from cache, resident default never reassigned, can't bleed into auto. **Honest finding:** the no-count CN-calibrated *threshold* is INERT on the constructed CN clip (cam++ can't separate similar TTS Mandarin voices across the whole 0.2–0.8 sweep) — the **supplied count is the reliable CN lever**, Phase-13 feeds it. +27 tests; suite **961 passed/1 skip (non-integration) + 3 integration**, zero regressions. UI gate respected (zero `yulu_ui/**`); no runtime-venv mutation (spike venv only). Calendar-prior interface for Phase 13 documented in `speaker_count.py` + 12-SUMMARY.
- ✅ **Phase 13** Pipeline + Summary Integration — built 4/4 criteria. Wired the live flow: new daemon **DIARIZE RPC** (`JobKind.DIARIZE` + `DiarizeRequest`/`DiarizeResponse` in `protocol.py`, `app._on_diarize` dispatching `app.diarize_backend` directly OFF the ASR runtime dict, `transcribe_client.request_diarize`) — the Phase-10 backend existed but was unreachable. Heavy orchestration in **new `stt_daemon/diarize_pipeline.py`** (kept `transcribe.py` a thin PURE ORCHESTRATOR, 492→236 lines): calendar-attendee prior (`resolve_attendee_count` from `schedule.json` by `meeting_id`/title, no `gog` at transcribe time) → Phase-12 `resolve_speaker_count`+two-pass `reconcile_count` → diarize → `speaker_merge.assign_speakers` (re-diarize re-anchors via `prior_map_from_sidecar`+`reanchor_by_overlap` so **renames survive**) → persist labelled `.transcript.txt` + `.speakers.json` + search re-upsert. **Graceful degrade proven** (criterion 1): disabled / no segments / backend|sherpa unavailable / zero turns → plain transcript, NO sidecar, never raises. Summary via **one additive prompt-var pair** `{{speaker_transcript}}`/`{{speaker_list}}` (`""` defaults, every existing prompt byte-identical — criterion 2); worker reads sidecar → `render_from_sidecar` + new `speaker_roster`. **Source-of-truth / no laundering** (criterion 4): low-confidence/UNKNOWN passed through, sidecar endures, cleanup still owns `.transcript.txt` rewrite. +28 tests (27 unit + 1 opt-in integration that **actually ran** via the spike venv `~/funasr-spike/venv-sherpa` + 60s clip → real backend → real merge → sidecar round-trip). Suite **995 passed/1 skip**, zero regressions. 6 commits af2fa52/46c3ea5/764678b/f43d996/5e20a63/50155f6. UI gate respected (zero `yulu_ui/**`); no runtime-venv / `~/.config/yulu` mutation. **Open carry-forward:** sherpa NOT installed on the 3.14 runtime (pipeline degrades; PORT-01); `config.example.json` lacks the documented `transcription.diarization.*` block; `yulu migrate` `models` re-provision is Phase-15.
- ⏳ **Phase 15** Portability, Footprint & Migration — next (`--only 15`). Cross-platform sherpa/ONNX behind the abstraction (PORT-01: confirm cp314 wheel resolution into the 3.14 runtime venv, else isolate); per-meeting wall-clock + peak-RAM regression budget (PORT-02: the diarize stage is now on the live path when enabled, post-recording/off the realtime critical path); seamless `yulu migrate` upgrade (PORT-03).
- ⏸️ **Phase 14** Speaker UI — LAST, gated on the in-flight web-UI redesign (see Blockers). Consumes Phase-13's stored `.speakers.json` + labelled transcript; `speaker_roster`/`render_from_sidecar` helpers ready.
- Mechanism note: each phase = delegated builder agent (writes code+tests+commits+GSD artifacts) → independent verifier agent → STATE/ROADMAP update. Resume point if compacted: read this log + run next ⏳ phase.

## Performance Metrics

**Velocity:**

- Total plans completed: 30
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
| Phase 10 P10 | 30 | 6 tasks | 11 files |

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

- **⚠ Phase 14 (Speaker UI) GATED — web UI redesign in flight (user directive 2026-06-06).** The entire web UI is being reworked across multiple active branches: `feat/recordings-ui` (recordings reader — `TranscriptView.tsx` / `recordings.$stem.tsx`, the exact files Phase 14 touches), `feat/settings-ui-p1` (settings 3-col MasterDetail), `feat/settings-registry`, `feat/remove-voicemail`. **Directive: backend-first; HOLD Phase 14 until these land and the reader/transcript components stabilize.** Execution order = 9 → 10 → 11 → 12 → 13 → 15, then **14 LAST**. When planning Phase 14: (a) target the POST-redesign components, NOT current files; (b) RE-VALIDATE the research's current-UI assumptions (`TranscriptView`'s `Speaker [A-Z]:` parser regex, `AudioPlayer` wavesurfer Regions, the inline-rename/optimistic-patch pattern) — they were captured against pre-redesign code that is being rewritten. Phases 9–13 & 15 are UI-safe and proceed now. Do NOT edit any `yulu_ui/web/**` file from this milestone until the gate clears.
- **Research flags (deeper per-phase research recommended via `/gsd-plan-phase --research-phase`):**
  - **Phase 12 (Speaker-count strategy):** the highest-leverage *unsolved* accuracy lever — CN-calibration thresholds + constrained-clustering knobs are unproven for Yulu; needs sherpa-onnx config research + empirical sweeps.
  - **Phase 11 (Eval harness):** DER methodology is trap-dense (collar/overlap/WDER/SER/anchoring/tiny-N); worth a focused pass on pyannote.metrics protocol + reference-labelling discipline.
  - **Phase 15 (Cross-platform/footprint):** the option-B footprint was NEVER measured (spike only timed the 20-min merge); needs a measurement plan + non-macOS wheel verification.
- **Phase 10 venv co-location:** Yulu's venv is Python 3.14; sherpa-onnx publishes cp314 wheels but resolution is unverified — verify in Phase 10; isolate into a small dedicated venv if it conflicts (the provision step already isolates envs).
- **Standard-pattern phases (skip research-phase — in-codebase precedent exists):** Phase 9 (merge core — `transcript_merge.py` is a literal template), Phase 10 (backend/provision — mirrors STT backend Protocol + v0.5 `models` step), Phase 13 (pipeline/summary — mirrors the dual-track `{{my_transcript}}` addition exactly). **Phase 14 (UI) is NO LONGER a skip-research phase** — the inline-rename/optimistic-patch/wavesurfer-Regions precedent is being rewritten by the UI redesign; re-derive against the post-redesign components when the gate clears.
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
