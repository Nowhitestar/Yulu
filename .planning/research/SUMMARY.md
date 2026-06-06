# Project Research Summary

**Project:** Yulu (语录) — milestone v0.6 Speaker Diarization
**Domain:** Speaker diarization as a post-process bolt-on to a local-first, single-user, agent-native macOS meeting recorder
**Researched:** 2026-06-06
**Confidence:** HIGH (engine already de-risked by spikes 001/002 on real Yulu meetings; supporting stack version-verified; all integration points read in the live codebase)

## Executive Summary

v0.6 is **not a greenfield diarization subsystem — it is the N-speaker generalization of a 2-speaker path Yulu already ships.** All four reports converge hard on this: `stt_daemon/transcript_merge.py::merge_segments(mic, sys)` already emits `[MM:SS 我] … / [MM:SS 对方] …` — the exact "Me/Them" model Granola desktop ships, derived from *channels*, not voices. The milestone's job is to split the single far-end/system stream (where multiple remote people are mixed) into distinct voices, label them, and let the user name them — riding the **existing sidecar → prompt-var → UI rails** end-to-end. ASR stays MLX/whisper.cpp untouched. The engine question is *settled* by the spikes: **sherpa-onnx** (ONNX Runtime, no torch; seg 5.7 MB + cam++ 27 MB), chosen over FunASR specifically because it is genuinely cross-platform (cp37–cp314 wheels for macOS/Linux/Windows) and satisfies the milestone's "must not hard-couple to macOS" mandate that FunASR+MPS violates.

The recommended approach is a clean post-process stage: a **resident `DiarizeBackend` in `stt_daemon`** (reusing the `warm_up`/`is_ready`/`release` lifecycle, dispatched via a new `JobKind.DIARIZE` on the background slot — but deliberately held OUT of the ASR fallback chain), feeding a **pure `speaker_merge.py` module** (overlap-argmax assignment + ~10% coverage-gap fallback + VAD-gate/hallucination filter + idempotent re-anchor), persisting to a **`<stem>.speakers.json` sidecar** (stable `speaker_id` → editable `display_name`) that travels with `data_dir` and never enters runtime SQLite. Speaker info reaches the summary through one additive prompt-var pair (`{{speaker_transcript}}`/`{{speaker_list}}`), mirroring the dual-track `{{my_transcript}}`/`{{their_transcript}}` addition — zero new plumbing. **Net new shipped-runtime dependency: zero.** sherpa-onnx is the only added runtime package; `pyannote.metrics` (for eval) lives in a dev/eval venv only; store + UI reuse the existing `better-sqlite3`/React/wavesurfer Regions.

The dominant risks are **quality, not throughput.** Three reports independently flag the same gates: (1) the **DER/WDER eval harness** on labelled CN+EN meetings is the product gate that picks the default provider and sets honest UI copy — it must land **early/parallel, not last**, and must respect DER methodology traps (collar/overlap/WDER/anchoring-bias/tiny-N); (2) sherpa **over-splits on Chinese** (59→32→20 clusters as threshold rises, never near the true ~5), requiring a deliberate speaker-count strategy whose failure mode is recoverable *under*-merge, not catastrophic *over*-split; (3) the `speaker_merge` module is the **highest-risk logic** and must be hardened on fixtures in isolation. A fourth cross-cutting risk is **privacy**: speaker embeddings are biometric voiceprints — ephemeral by default, never leaking via cloud-sync or the agent→cloud-LLM boundary; v0.6 stays anonymous per-meeting + manual labels (no cross-meeting voiceprint enrollment, which is explicitly deferred).

## Key Findings

### Recommended Stack

The engine is settled (sherpa-onnx, from spikes); the four reports add only the **supporting stack** for measure/store/UI, and the unifying signal is **reuse, not addition**. The one genuinely new shipped dependency is `sherpa-onnx` (onnxruntime-only, no torch, cross-platform wheels). Everything else either already ships in Yulu or lives in a dev/eval venv. See [STACK.md](STACK.md), [ARCHITECTURE.md](ARCHITECTURE.md).

**Core technologies:**
- **sherpa-onnx** (engine, from spike 002): seg 5.7 MB + cam++ 27 MB ONNX — torch-free, CPU-fast (RTF ~0.17), cp37–cp314 cross-platform wheels — the deciding reason it beat FunASR.
- **pyannote.metrics `4.1`** (DEV/EVAL VENV ONLY): canonical DER/JER/WDER with optimal Hungarian mapping + native RTTM I/O — pure-Python, torch-free (torch lives only in the *sibling* `pyannote.audio`, which is NOT installed). Keep a ~40-line hand-rolled DER in tests as an independent cross-check.
- **`<stem>.speakers.json` sidecar** (data model, not a library): stable `speaker_id` → editable `display_name` map; raw turns + assignments + provenance. Travels with `data_dir` (iCloud/Drive sync), survives DB rebuilds — explicitly **NOT** runtime SQLite (which is never synced).
- **better-sqlite3 `^11.5.0`** + Python stdlib `sqlite3` (already present): the search index gets labelled transcripts for free via the existing `upsert_doc` hook — zero new dependency, zero schema change.
- **wavesurfer.js Regions plugin** (ships *inside* the already-installed `wavesurfer.js@^7.8.0`): color-coded speaker spans on the existing waveform — import `dist/plugins/regions.esm.js`, no new npm dependency.

### Expected Features

Yulu already ships a 2-speaker transcript, so the feature framing is "2 channel speakers → N voice-clustered speakers," primarily by splitting the `对方`/system stream. A pre-existing **format-mismatch landmine** must be fixed first: the merge output is `[MM:SS 我]` but the web `TranscriptView.tsx` parser expects `/^Speaker [A-Z]:/` — these disagree *today*. See [FEATURES.md](FEATURES.md).

**Must have (table stakes):**
- **Canonical speaker-line format + matching parser** — reconciles `[MM:SS 我]` vs `Speaker A:`; unblocks all rendering (blocks, color, seek). The true first task.
- **N-speaker auto-labels from the merge module** — `我`(=you, structural/free) + `Speaker N` for far-end voices; usable with zero naming.
- **Speaker blocks + color-coding + click-to-seek** — legible attributed transcript over existing wavesurfer playback.
- **Rename (applies to all) + persist** via the `speaker_id`→`display_name` map — the keystone interaction; four features collapse to "maintain the map and apply it."
- **Merge two labels into one** — the *required recovery path* for sherpa's known CN over-splitting; cheap given the rename map (= rename-to-same-name).
- **Speaker-attributed summary** via the agent-queue prompt — connects diarization to Yulu's core value (the note); mostly prompt work, no new pipeline.
- **Named export/copy** + **honest accuracy framing in UI copy** — the post-rename transcript leaves the app; one line of "labels are a hint" honesty prevents trust collapse.

**Should have (competitive — cheap because Yulu is local + single-user + agent-native):**
- **"You" is auto-known, never asked** — mic channel = local user, structurally; set your name once globally. A genuine local-first edge competitors structurally cannot match.
- **Calendar-attendee name suggestions** — Yulu already pulls Google Calendar via `gog`; offer attendee names as one-tap renames (also the free speaker-count prior — see Pitfall 2).
- **Agent-driven speaker cleanup** — the agent already sees the transcript; give it the attendee list + a "suggest names" prompt. Fits the agent-native thesis, no new ML.
- **Talk-time / "how much did I talk" stats** — trivial from segment durations; single-user self-coaching framing.

**Defer (v2+ / NEVER):**
- **On-device persistent voiceprints** ("this voice = Alex across meetings") — the privacy-preserving headline differentiator, but real embedding-storage + matching + enrollment work; defer until labeling proves valuable.
- **Per-segment manual correction** — higher data-model cost; the sidecar supports it, ship once users ask (v0.6.x).
- **Cloud voiceprint** (NEVER — violates local-first), **live diarization** (NEVER — conflicts with the post-process engine), **word-level boundaries** (NEVER — fights ASR's own segment boundaries).

### Architecture Approach

Diarization slots in as a sibling post-process stage that reuses Yulu's existing shape: per-source segments → merge → `[MM:SS speaker] text` lines → sidecar → prompt-var → UI. The **two load-bearing decisions**: (1) diarization runs in a **new `stt_daemon` backend** keyed `"diarize"` (own `JobKind`, background slot, reuses the warm-up/lifecycle Protocol — but is NOT registered into the ASR `STTRuntime.backends` dict, so the ASR fallback chain can never route to it); (2) the merge is its own **pure, fixture-testable `speaker_merge.py`** module, sibling to `transcript_merge.py`. The swappable seam is a **`DiarizeBackend` Protocol selected by config** (sherpa default, FunASR optional) — **NOT** a `CapabilityProvider` subclass (that ABC means "what the host agent already configured"; diarization is `yulu-managed`, surfaced as a tri-state *probe entry*). The platform layer needs **nothing new** — sherpa ships cross-platform wheels with no torch; provisioning just extends the existing `models` step. See [ARCHITECTURE.md](ARCHITECTURE.md).

**Major components:**
1. **`SherpaDiarizeBackend`** (NEW, `stt_daemon/backends/diarize.py`) — resident seg+cam++ pipeline; `warm_up`/diarize/`is_ready`/`release`; audio in → speaker turns `[{start,end,speaker_idx}]` out.
2. **`speaker_merge.py`** (NEW, pure module) — overlap-argmax assignment + ~10% coverage-gap fallback (same-speaker-bracket → nearest → UNKNOWN, never drop text) + whisper hallucination/repeat collapse + idempotent `prior_map` re-anchor (renames survive re-diarize). Highest-risk logic; zero I/O; unit-testable to death.
3. **`<stem>.speakers.json` sidecar** (NEW data model) — raw turns + segment assignments + the editable `speaker_id`→`display_name` map + provenance/version. Source of truth; `.transcript.txt` keeps inline labels for display.
4. **`transcribe.py`** (MODIFIED) — orchestrates ASR → DIARIZE → `speaker_merge.assign` → persist; degrades gracefully to today's plain transcript when diarization is absent/disabled.
5. **`agent_queue_worker` + `prompts/cache.render()`** (MODIFIED) — read `.speakers.json`, add `{{speaker_transcript}}`/`{{speaker_list}}` vars (default `""`, every existing prompt unaffected).
6. **`recordings.ts` + React** (MODIFIED) — serve `speakers`; `renameSpeaker`/`mergeSpeaker` tRPC mutations (read-modify-write the JSON map); render labels + Regions color-coding.
7. **`capabilities/probes.probe_diarization()` + `setup_models.sh`** (MODIFIED) — tri-state `yulu-managed` probe; provision step extends to pip sherpa + fetch the two ONNX files (idempotent, offline-by-default plain bytes).
8. **DER eval harness** (`diarization/eval/`, dev tooling — NOT shipped) — label 2–3 CN+EN meetings, measure DER/WDER for sherpa (and FunASR), pick the default, set UI copy.

### Critical Pitfalls

All from real-meeting evidence (spikes 001/002) + corroborated by pyannote/AssemblyAI/Deepgram engineering write-ups. See [PITFALLS.md](PITFALLS.md).

1. **Eval harness built last ships unmeasured accuracy** — diarization "looks coherent" by eyeball (0.765–0.843 is *inter-tool agreement, not correctness*) and ships with no defensible number. *Avoid:* treat the DER/WDER/count-error harness as a **gating phase that lands early/parallel**, so every later change (count, merge, fallback) is measured against it; the sherpa-vs-FunASR default is an *output* of the harness, recorded as an ADR.
2. **Speaker-count over-split on Chinese** — sherpa auto-clusters 59→32→20, never near the true ~5; a 5-person weekly renders as twenty phantom speakers. *Avoid:* a deliberate count-strategy ladder — **calendar-attendee count prior** (free; Yulu has `gog`) → **CN-calibrated threshold** (not the library default) → **constrained clustering** that fails toward recoverable *under*-merge. Calibrate on CN, verify it doesn't wreck EN.
3. **Coverage gap (~8–12% of ASR segments fall outside diarization) with a silently-wrong fallback** — a naive "previous speaker" fill confidently mislabels ~10% of the transcript, and mislabels are worse than blanks because they propagate into the summary. *Avoid:* overlap-argmax + a principled ladder (same-speaker-bracket → nearest-within-window → explicit UNKNOWN), a per-segment confidence/source flag, and **never snap a gap across a speaker boundary**.
4. **DER methodology traps make the eval lie** — collar (250ms/side), overlap-skipping, DER-only (vs WDER for "wrong words"), reference-anchoring bias, tiny-N variance. *Avoid:* report DER **with and without collar, with and without overlap**; **lead with WDER + SER**; use a standard scorer; **label references blind** to tool output; bucket CN/EN/code-switch, never one pooled number over 2–3 clips.
5. **Whisper hallucination/repeat on silence pollutes the labelled transcript** — phantom "so"/"字幕"/"thank you for watching" segments get a confident speaker. *Avoid:* **VAD-gate ASR segments before merging**, detect repeat/boilerplate loops, treat hallucination-flagged segments as no-speaker (not previous-speaker). (Plus the cross-cutting **privacy guard**: embeddings are biometric voiceprints — ephemeral by default, never synced into `data_dir`, never shipped to a cloud LLM via agent-queue.)

## Implications for Roadmap

Research converges on a build order that **front-loads the pure riskiest logic, lands the eval gate early/parallel, and treats accuracy (not speed) as the bottleneck.** The functional phase decomposition below follows ARCHITECTURE.md's 11-step build order and PITFALLS.md's P-* phase mapping. Note: phases are *functional groupings* — the roadmapper may merge or split.

### Phase 1: Pure speaker-merge core (`speaker_merge.py` + sidecar data model)
**Rationale:** It is the milestone's highest-risk *logic* (8–12% coverage gap, ~15–20% arguable labels) and depends on nothing — buildable and hardenable on fixtures with no sherpa, no daemon, no sqlite. The data model's "renames survive re-diarize" property must be locked at the file level here.
**Delivers:** `assign_speakers()` (overlap-argmax + gap fallback + hallucination/repeat collapse + `prior_map` re-anchor) returning labelled segments + `[MM:SS Speaker N]` string; `<stem>.speakers.json` schema + read/write helpers; an exhaustive fixture test suite + a hand-rolled DER cross-check.
**Addresses:** N-speaker auto-labels, the canonical line format, merge-recovery foundation.
**Avoids:** Pitfalls 3 (coverage gap), 7 (short-utterance/backchannel), 8 (hallucination), 9 (clobbered renames via stable `speaker_id`).

### Phase 2: Diarize backend + provisioning + capability probe
**Rationale:** The engine plumbing; parallelizable with Phase 1 (its output is only needed at integration). Establishes the resident-model lifecycle and the cross-platform-clean provision seam.
**Delivers:** `SherpaDiarizeBackend` (`warm_up`/diarize/`is_ready`/`release`); `JobKind.DIARIZE` + `DiarizeRequest/Response` + scheduler background-slot dispatch (held OUT of the ASR runtime dict); `setup_models.sh` extended to pip sherpa + fetch seg+cam++ ONNX (idempotent `check()`, offline-by-default); `probe_diarization()` tri-state `yulu-managed` entry folded into `doctor.py`.
**Uses:** sherpa-onnx (onnxruntime-only); `runtime_dir()/models/` paths; the existing `DiarizeBackend` Protocol seam.
**Implements:** Backend + provision + capability components.
**Avoids:** Pitfalls 13 (offline/phone-home → forced-offline test asserting zero network calls), 15 (model bundling + local-path load), the `CapabilityProvider` category-error anti-pattern (probe, not subclass).

### Phase 3: Speaker-count strategy (the over-split fix)
**Rationale:** sherpa's known measured weakness on Chinese; must land before the eval can fairly judge the default, and the calendar-attendee prior is a free lever Yulu already has.
**Delivers:** count-strategy ladder — calendar-attendee count prior (via `gog`) → CN-calibrated threshold → constrained clustering biased toward recoverable under-merge; an optional "how many speakers?" UI control as the entry point.
**Uses:** Existing Google Calendar (`gog`) integration; the `num_speakers` hook on the diarize backend.
**Avoids:** Pitfall 2 (over-split), with robustness verified across CN/EN buckets (Pitfall 6).

### Phase 4: DER/WDER eval harness (the product gate — runs alongside 2–6)
**Rationale:** This is the gate, not a closing chore. It picks the default provider on evidence, sets honest UI copy, and is the regression baseline every tuning change is measured against. It is *slow* (hand-labelling) so it must start as soon as Phase 2 produces any labels.
**Delivers:** labelled CN+EN(+code-switch) corpus; `diarization/eval/` harness reporting DER (with/without collar, with/without overlap) + WDER + SER + count-error, bucketed by language; a provider-choice ADR; the measured number that sets UI accuracy copy.
**Uses:** `pyannote.metrics 4.1` in a dev/eval venv; RTTM interchange; Audacity label-track → `labels_to_rttm.py`.
**Avoids:** Pitfalls 1 (eval-as-gate), 4 (methodology traps), 6 (CN/EN/code-switch divergence).

### Phase 5: Pipeline + summary integration
**Rationale:** Wires the proven core into the live flow once Phases 1–3 land; the summary path is the connection to Yulu's core value.
**Delivers:** `transcribe.py` orchestrating ASR → DIARIZE → `speaker_merge.assign` → write `.transcript.txt` + `.speakers.json` → search upsert (graceful degrade when disabled); `agent_queue_worker` reading `.speakers.json`; `prompts/cache.render()` gaining `{{speaker_transcript}}`/`{{speaker_list}}`; a speaker-aware seed prompt.
**Addresses:** Speaker-attributed summary, named transcript into the agent boundary.
**Avoids:** Pitfall 14 (misattribution cascade — pass uncertainty downstream, prefer UNKNOWN over a wrong owner), Pitfall 16 (warm-up so first meeting isn't JIT-penalized; keep diarization off the live critical path).

### Phase 6: UI — labels, color, rename/merge, honest copy
**Rationale:** The user-facing payoff; depends on the data model (1) and pipeline (5). Because the engine *will* over-split, **merge is core, not polish.**
**Delivers:** canonical-format parser fix in `TranscriptView.tsx`; speaker blocks + Regions color-coding + click-to-seek; `renameSpeaker`/`mergeSpeaker` tRPC mutations with optimistic update; "You" global self-name; visual marking of low-confidence segments; UI copy framing labels as correctable hints (sourced from Phase 4's number).
**Addresses:** Rename-all + persist, merge, color, seek, named export, "You" edge.
**Avoids:** Pitfalls 11 (rename+merge+reassign, not rename-only), 12 (over-promising accuracy), 9 (re-attach-don't-clobber on re-diarize).

### Phase 7: Cross-platform verification + footprint/migration
**Rationale:** Closes the milestone's mandate and protects existing users; mostly verification given sherpa's clean cross-platform story.
**Delivers:** confirm sherpa wheels + ONNX resolve behind the abstraction on non-macOS targets (impl macOS now, others stubbed/verified per the v0.5 pattern); measure the **option-B footprint** (peak RAM, install size, added per-meeting latency on 20-min/1h clips) against a regression budget; `yulu migrate` adds the `models` re-provision; recordings without `.speakers.json` simply show no labels until re-diarized.
**Avoids:** Pitfall 16 (unmeasured footprint, O(n²) clustering tail on long recordings), P-XPLAT (verify-not-just-on-dev-macOS).

### Phase Ordering Rationale

- **Pure logic first (Phase 1):** the merge module is the highest-risk *logic* and has zero dependencies — hardening it on fixtures before any integration is the single most important testability decision (all three engineering reports agree).
- **Parallelism:** Phases 1↔2 are independent (pure logic vs backend); Phase 4 (eval) runs alongside 2–6 because it's slow to build and gates the default; Phases 5 and 6 are independent once the data model + pipeline land.
- **Eval is a gate, not a tail (Phase 4):** the milestone's deferred "which provider is default" decision is an *output* of the eval; building it last would ship unmeasured accuracy and guess the UI copy.
- **Accuracy is the bottleneck, not speed:** sherpa RTF ~0.17 and ~33 MB models mean throughput is a non-issue; every report points the same way — the limit is quality (over-split, coverage gap, overlap, hallucination), so count-strategy + merge + eval get the weight.
- **Reuse rails minimize surface:** sidecar (not SQLite), prompt-var pair (not a new pipeline), Regions (not a new chart lib), probe (not a new daemon) — each grouping rides an existing Yulu convention, keeping new shipped surface near-zero.

### Research Flags

Phases likely needing deeper research during planning (`/gsd-plan-phase --research-phase`):
- **Phase 3 (Speaker-count strategy):** the highest-leverage *unsolved* accuracy lever — CN-calibration thresholds and constrained-clustering knobs are unproven for Yulu; needs sherpa-onnx config research + empirical sweeps. The one engine area the spikes flagged but did not resolve.
- **Phase 4 (Eval harness):** DER methodology is trap-dense (collar/overlap/WDER/SER/anchoring/tiny-N); worth a focused pass on pyannote.metrics protocol + reference-labelling discipline even though the library is settled.
- **Phase 7 (Cross-platform/footprint):** the option-B footprint was *never measured* (spike only timed the 20-min merge); needs a measurement plan + non-macOS wheel verification.

Phases with standard patterns (skip research-phase — well-documented in the research + an existing in-codebase precedent):
- **Phase 1 (merge core):** `transcript_merge.py` is a literal template; merge logic fully specified in ARCHITECTURE.md.
- **Phase 2 (backend/provision):** mirrors the existing STT backend Protocol + the v0.5 `models` provision step; sherpa API verified.
- **Phase 5 (pipeline/summary):** mirrors the dual-track `{{my_transcript}}` addition exactly — zero new plumbing.
- **Phase 6 (UI):** reuses the existing inline-rename + optimistic-patch + wavesurfer-Regions patterns already in the codebase.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Engine de-risked by spikes 001/002 on real meetings; supporting deps version-verified via Context7 + PyPI (pyannote.metrics 4.1, wavesurfer Regions, sherpa cp37–cp314 wheels). Only new shipped dep is sherpa-onnx. |
| Features | HIGH on competitor behavior + Yulu surface dependencies (read directly); MEDIUM on which features Yulu users will actually demand (no Yulu user research — inferred from competitor norms + the single-user/local constraint). |
| Architecture | HIGH | Every integration point read in the live codebase; the dual-track (mic/sys) path is a near-exact structural precedent. Only unverified surface is sherpa accuracy/count-tuning (owned by the eval). |
| Pitfalls | HIGH | Engine behavior grounded in spikes on real Yulu meetings; methodology + failure-mode claims corroborated by pyannote/AssemblyAI/Deepgram/Recall.ai write-ups + 2025–2026 arXiv on Whisper hallucination, WDER/SER, segment reassignment. |

**Overall confidence:** HIGH — the engine is settled, the integration is a generalization of an existing path, and the risks are *known and measured* rather than unknown. The honest uncertainty is concentrated in two named places (absolute diarization accuracy; CN speaker-count calibration), both explicitly owned by the eval phase.

### Gaps to Address

- **Absolute diarization accuracy is unproven** (spike 002: 0.765–0.843 is inter-tool agreement, not correctness; ~15–20% arguable labels). *Handle:* the DER/WDER eval phase produces the first ground-truth number; until then, UI copy treats labels as "helpful hints." This gap is *expected* and the eval phase is designed to close it.
- **CN speaker-count calibration is unsolved** (sherpa over-splits 59→32→20). *Handle:* Phase 3 count-strategy with `--research-phase`; fail toward recoverable under-merge; keep FunASR as the gated escape hatch if calibration can't get sherpa close enough.
- **Option-B footprint was never measured** (spike only timed the 20-min merge; full FunASR pipeline peaked ~8 GB — sherpa expected far lower but unconfirmed for the option-B path). *Handle:* Phase 7 measures peak RAM + install size + added latency on 20-min/1h clips against a regression budget; warm-up + O(n²) clustering guard.
- **Python 3.14 venv co-location** for sherpa-onnx (Yulu's venv is 3.14; sherpa publishes cp314 wheels but resolution unverified). *Handle:* Phase 2 verifies wheel resolution; isolate into a small dedicated venv if it conflicts (the provision step already isolates envs).
- **`CapabilityProvider` terminology vs reality** — PROJECT.md says "`diarization` capability provider behind the `CapabilityProvider` abstraction," but that ABC means agent-reuse; diarization is `yulu-managed`. *Handle:* build it as a `DiarizeBackend` Protocol (config-selected) + a tri-state probe entry; flag the terminology clarification to the roadmapper so requirements don't force a category error.
- **Cross-meeting persistence scope** — users will want named voices to persist; this is speaker *identification* (a heavier, privacy-laden capability), not diarization. *Handle:* explicit PROJECT/REQUIREMENTS scope guard — v0.6 ships anonymous per-meeting + manual labels only; defer voiceprint enrollment to a future milestone with its own consent design.

## Sources

### Primary (HIGH confidence)
- `.planning/spikes/002-option-b-diarization-merge/REPORT.md` — sherpa-onnx default decision; option-B merge agreement 0.765–0.843; ~8–12% coverage gap; CN over-split 59→32→20; eval required; editable/mergeable UI; hallucination handling as merge responsibility — measured on real Yulu meetings.
- `.planning/spikes/001-funasr-camplus-diarization/REPORT.md` — option B confirmed; FunASR clean count=5 but ~8 GB peak / 1.13 GB venv / offline broke despite `disable_update` (modelscope patch must-fix); warm-up ~2× first run; cam++ ~linear marginal cost; O(n²) clustering caveat.
- Live Yulu codebase (read 2026-06-06) — `stt_daemon/transcript_merge.py` (the 2-speaker precedent), `stt_daemon/runtime.py`/`protocol.py` (backend Protocol + JobKind), `transcribe.py` (PURE ORCHESTRATOR + dual-track merge call), `agent_queue_worker.py` + `prompts/cache.py` (`{{my_transcript}}`/`{{their_transcript}}` render pattern), `capabilities/provider.py`+`report.py` (CapabilityProvider = agent-reuse semantics), `provision/registry.py` (idempotent step contract), `search/indexer.py` (runtime-vs-data dir split, sha256-dedup), `yulu_ui/.../recordings.ts` + `TranscriptView.tsx` + `AudioPlayer.tsx` (sidecar serving, the `Speaker [A-Z]:` parser mismatch, wavesurfer-no-Regions-yet).
- `.planning/PROJECT.md` — v0.6 Active scope, cross-platform mandate, local-first/opt-in-cloud constraint, v0.5 layering & abstractions, Phase 5 data-folder sync, calendar integration.
- Context7 `/katspaugh/wavesurfer.js` — Regions plugin import path, `registerPlugin`, `::part(region)` styling, v7 plugin model.
- PyPI `pyannote-metrics` 4.1 (2026-05-06) + docs — DER (optimal Hungarian vs greedy), JER, purity/coverage, RTTM I/O, Python ≥3.10, no torch in core.
- PyPI `sherpa-onnx` 1.13.2 (2026-05-13) — cp37–cp314 wheels for macOS/Linux/Windows, onnxruntime-only, no torch — confirms cross-platform + 3.14 viability.
- pyannote.metrics docs + "How to evaluate Speaker Diarization performance" (pyannote.ai) — collar (250ms/side = 500ms), DER vs JER, `skip_overlap`, leaderboards mix protocols.
- Whisper hallucination corpus — "Whisper Hallucination on Silence" (DEV), arXiv 2501.11378 (non-speech hallucination, ~55% of non-speech → "so"), arXiv 2505.12969 (Calm-Whisper) — VAD-gating is the documented mitigation.

### Secondary (MEDIUM confidence)
- Recall.ai / AssemblyAI / Deepgram engineering write-ups — diarization labels are per-recording (not persistent); diarization ≠ speaker identification; short utterances → Unknown/previous-speaker; WDER 2.68%→11.65% (2→3 speakers); crosstalk cascade into action items/decisions.
- Otter.ai / Fireflies / Granola / tl;dv / Descript / Trint/Reduct / Zoom/Teams help-center docs — rename-applies-everywhere as universal table stakes; merge as over-split recovery; cross-meeting voice memory is everywhere cloud; Granola desktop ships only "Me/Them" (validates Yulu's current state).
- spy-der (PyPI 0.4.1, 2023) — zero-dependency C++ DER cross-check; no arm64 wheel (source build).
- Audacity label-track → export-labels workflow; RTTM 10-field NIST format — manual reference labelling path.
- CDER/SER vs DER for short utterances; ~0.5s minimum-segment sweet spot; arXiv 2406.03155 (segment-level reassignment).

### Tertiary (LOW confidence)
- SDBench (arXiv 2507.16136), "State of Speaker Diarization 2026" (Picovoice) — benchmark-protocol consistency, collar/overlap/VAD confounds (directional, not load-bearing).

---
*Research completed: 2026-06-06*
*Ready for roadmap: yes*
