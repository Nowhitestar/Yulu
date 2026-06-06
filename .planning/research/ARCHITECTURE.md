# Architecture Research

**Domain:** Speaker diarization as a post-process bolt-on to Yulu's existing local-first ASR pipeline (v0.6)
**Researched:** 2026-06-06
**Confidence:** HIGH — every integration point was read in the live codebase; the dual-track (mic/sys) feature is a near-exact structural precedent for N-speaker diarization. The one unverified surface is sherpa-onnx accuracy/speaker-count tuning (spike 002 flagged it; the DER harness owns it).

---

## TL;DR for the Roadmapper

Diarization is **not** a greenfield subsystem — it is the **N-speaker generalization of Yulu's existing 2-speaker dual-track path**. Yulu already has the entire shape end-to-end:

- per-source segments → `stt_daemon/transcript_merge.merge_segments()` → `[MM:SS speaker] text` lines
- speaker-scoped sidecar files (`.mic.transcript.txt` / `.sys.transcript.txt`)
- speaker-aware prompt vars (`{{my_transcript}}` / `{{their_transcript}}`) substituted in `prompts/cache.render()`
- UI serving those transcripts via `recordings.ts`

The job is to **add a diarization stage that produces speaker turns, generalize the merge module to assign one of N speakers by timestamp overlap, persist an editable speaker map, and let the labels ride the existing sidecar/prompt-var/UI rails.** ASR stays MLX/whisper.cpp untouched.

The two load-bearing decisions:

1. **WHERE diarization runs → a new `stt_daemon` backend keyed `"diarize"`, dispatched as its own job kind, NOT inline in `transcribe.py`.** It reuses the `warm_up`/`transcribe`/`is_ready`/`release` Protocol shape (warm-up matters: spike 001 showed first-run shader JIT). But it is a *sibling stage*, not an ASR engine in the fallback chain — `transcribe.py` orchestrates "ASR → diarize → merge" exactly as it already orchestrates "ASR → channel-merge".
2. **The merge module is its own pure, testable unit** (`stt_daemon/speaker_merge.py`), sibling to the existing `transcript_merge.py`, owning overlap-assignment + ~10% coverage-gap fallback + whisper hallucination/repeat handling. Zero I/O, zero daemon coupling → unit-testable on fixtures.

---

## Standard Architecture

### System Overview — where diarization slots in

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CAPTURE (unchanged)                                                        │
│  audio_daemon (Swift, SCK/CoreAudio) ──► record_audio.py ──► <stem>.wav     │
└───────────────────────────────────┬────────────────────────────────────────┘
                                     │  (on stop)
┌───────────────────────────────────▼────────────────────────────────────────┐
│  transcribe.py  — PURE ORCHESTRATOR (modified: adds a diarize+merge step)    │
│                                                                              │
│   1. request_final_transcribe ──► stt_daemon (TRANSCRIBE job)               │
│        └─ MLX/whisper.cpp  → ASR segments [{start,end,text}]   (UNCHANGED)  │
│                                                                              │
│   2. [NEW] request_diarize ──► stt_daemon (DIARIZE job)                     │
│        └─ sherpa-onnx backend "diarize" → speaker turns                     │
│                            [{start,end,speaker_idx}]                         │
│                                                                              │
│   3. [NEW] speaker_merge.assign(asr_segments, turns, prior_map)            │
│        └─ overlap assignment + gap fallback + hallucination guard           │
│           → labelled segments [{start,end,text,speaker_id}]                 │
│           → rendered transcript string  "[MM:SS Speaker 1] ..."             │
│                                                                              │
│   4. persist:  <stem>.transcript.txt          (labelled, inline — existing) │
│                <stem>.speakers.json    [NEW structured sidecar: turns+map]  │
│                search index upsert            (existing hook)               │
│                                                                              │
│   5. enqueue summary_request ──► agent-queue.json   (existing, +1 prompt var)│
└───────────────────────────────────┬────────────────────────────────────────┘
                                     │
┌───────────────────────────────────▼────────────────────────────────────────┐
│  agent_queue_worker.py  (modified: reads <stem>.speakers.json,              │
│   exposes {{speaker_transcript}} / {{speaker_list}} to prompts/cache.render)│
└───────────────────────────────────┬────────────────────────────────────────┘
                                     │
┌───────────────────────────────────▼────────────────────────────────────────┐
│  yulu_ui  (modified: recordings.ts serves speakers.json; new tRPC mutation  │
│   renameSpeaker/mergeSpeaker writes the map back; React shows labels)       │
└──────────────────────────────────────────────────────────────────────────┘

           ┌─────────────────────────────────────────────────────────────┐
PROVISION  │  provision/registry.py  +  setup_models.sh  (modified):       │
SEAM       │  download seg(5.7MB)+cam++(27MB) ONNX, pip sherpa-onnx into   │
           │  the diarization env.  capabilities/probes + a `diarization`  │
           │  report entry surface "is diarization usable?"                 │
           └─────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | New / Modified | File |
|-----------|----------------|----------------|------|
| `SherpaDiarizeBackend` | Resident sherpa-onnx seg+cam++ pipeline; `warm_up`/diarize/`is_ready`/`release`; audio in → speaker turns out | **NEW** | `yulu/scripts/stt_daemon/backends/diarize.py` |
| Diarize job dispatch | New `JobKind.DIARIZE`; `DiarizeRequest`/`DiarizeResponse` messages; routes to the diarize backend on the background slot | **MODIFIED** | `stt_daemon/protocol.py`, `stt_daemon/app.py` (or `control_server.py`), `stt_daemon/scheduler.py` |
| `speaker_merge` | **Pure** overlap-assignment + coverage-gap fallback + hallucination/repeat guard + idempotent re-labelling against a prior map → labelled segments + rendered string | **NEW** | `yulu/scripts/stt_daemon/speaker_merge.py` |
| Speaker data model + persistence | `<stem>.speakers.json` (raw turns + segment→speaker assignments + editable id→display-name map + provenance/version) | **NEW** | sidecar written by `transcribe.py`; schema constants in `stt_daemon/speaker_merge.py` or a small `speakers/` module |
| `transcribe.py` | Orchestrate ASR → diarize → merge → persist; degrade gracefully when diarization is unavailable/disabled (falls back to today's plain transcript) | **MODIFIED** | `yulu/scripts/transcribe.py` |
| `agent_queue_worker.py` | Read `<stem>.speakers.json`; pass `{{speaker_transcript}}` + `{{speaker_list}}` into `render()` | **MODIFIED** | `yulu/scripts/agent_queue_worker.py` |
| `prompts/cache.render()` | One more literal-substitution var pair (mirrors the `my_transcript`/`their_transcript` addition) | **MODIFIED** | `yulu/scripts/prompts/cache.py` |
| `diarization` capability probe | Surface "is sherpa-onnx + the two ONNX models present and usable?" as a tri-state report entry (provenance `yulu-managed`) | **NEW** | `yulu/scripts/capabilities/probes.py` (folded by `doctor.py`) |
| Provision step | Download seg+cam++ ONNX + install sherpa-onnx, idempotent `check()`/`apply()` | **MODIFIED** | `setup_models.sh` (1:1 wrapped by `provision/registry.py`'s `models` step) |
| UI: serve + edit speakers | `recordings.ts` returns `speakers`; new `renameSpeaker`/`mergeSpeaker` tRPC mutations write the map; React renders labels and rename/merge controls | **MODIFIED / NEW** | `yulu_ui/src/routers/recordings.ts`, `web/src/...` |
| DER eval harness | Label 2–3 CN+EN meetings; compute DER for sherpa (and optionally FunASR); set UI accuracy copy; pick default | **NEW** (dev tooling, not shipped runtime) | `yulu/scripts/diarization/eval/` or `tests/` |

---

## The five hard questions, answered

### 1. WHERE does diarization run? → new `stt_daemon` backend, dispatched as a sibling job; merged in `transcribe.py`

**Decision: a resident backend in `stt_daemon/backends/diarize.py`, invoked via a new `JobKind.DIARIZE` job, with the merge done in `transcribe.py` (the orchestrator), NOT inline in either place.**

Three candidate locations were evaluated against the codebase:

| Option | Verdict | Why |
|--------|---------|-----|
| **(A) Inline in `transcribe.py`** | ✗ Reject | Violates the daemon's own design. The resident `stt_daemon` exists precisely so models load once and stay warm (ADR-001). sherpa's seg+cam++ models (33 MB) and, per spike 001, a real shader-JIT warm-up cost want a resident home, not a cold per-meeting subprocess. `transcribe.py` is explicitly a "PURE ORCHESTRATOR" (its own docstring) — putting model code there repeats the pre-ADR-001 / pre-ADR-004 anti-patterns the codebase already names. |
| **(B) New backend in `stt_daemon`, own job kind** | ✓ **Adopt** | Reuses the resident-model + two-slot scheduler infrastructure; warm-up is a first-class lifecycle hook (`warm_up()`); cancellation, health, and failure-reset bookkeeping come for free; one socket, one process, one config-reload signal path. Matches spike 002 §2 ("lives near `stt_daemon/backends/`, its own stage, reuse the Protocol shape"). |
| **(C) A second standalone daemon** | ✗ Reject | No service registry exists (daemons talk through fixed well-known paths only); adding `com.yulu.diarize` doubles launchd/provision/migrate surface for a ~33 MB feature. The existing daemon already multiplexes engines (`mlx`/`whisper`/`cloud`/`mlx-realtime`) — diarization is one more. |

**How it fits the existing backend Protocol — and the one place it does NOT.**

The STT `STTBackend` Protocol is `warm_up()` / `transcribe(audio_path, language, initial_prompt, cancel_token) -> STTResult` / `is_ready()` / `release()`. The diarization backend should **mirror the lifecycle trio verbatim** (`warm_up`/`is_ready`/`release`) but **must not be registered into the `STTRuntime.backends` dict**, because:

- `STTRuntime.transcribe()` builds an *engine fallback chain* (`mlx → whisper → cloud`) and returns ASR `STTResult.text`. Diarization is not interchangeable with ASR and must never be reachable by the ASR fallback logic. Putting it in that dict would let `_engine_chain()` accidentally route ASR to it.
- Its method shape differs: it takes audio and returns **speaker turns** (`[{start, end, speaker_idx}]`), not transcript text. Forcing it through `STTResult` would abuse the type.

**Recommended seam:** a parallel `DiarizeBackend` Protocol + a thin `DiarizeRuntime` (or just hold the single backend on the app object), dispatched by a new `JobKind.DIARIZE` that the scheduler sends to the **background slot** (same slot family as `FINAL_TRANSCRIBE` — never contends with interactive dictation). Add `DiarizeRequest`/`DiarizeResponse` to `protocol.py` alongside the existing message dataclasses and `_TYPE_TO_CLS` table. Reuse `WarmUpRequest(engine="diarize")` so the existing warm-up command path can prime it.

```python
# stt_daemon/backends/diarize.py  (shape only)
class DiarizeBackend(Protocol):
    async def warm_up(self) -> None: ...            # dummy run → pay shader JIT once (spike 001)
    async def diarize(self, *, audio_path: str, num_speakers: int | None,
                      cancel_token: CancelToken) -> list[SpeakerTurn]: ...
    def is_ready(self) -> bool: ...
    def release(self) -> None: ...

@dataclass
class SpeakerTurn:
    start: float      # seconds
    end: float
    speaker_idx: int  # raw cluster index from cam++ (0..N-1) — NOT a user label
```

**Why merge in `transcribe.py`, not in the backend:** the backend's single responsibility is audio→turns. The *merge* needs the ASR segments (which `transcribe.py` already holds from step 1) AND the prior speaker map (for idempotent re-runs, which only the orchestrator/persistence layer knows about). Co-locating merge with the orchestrator mirrors exactly what `transcribe.py` already does for dual-track: it calls `stt_daemon.transcript_merge.merge_segments(mic=..., sys=...)` itself after getting per-channel results. Diarization merge is the same pattern with a different merge function.

### 2. The speaker–transcript MERGE module — its own testable unit

**Decision: `yulu/scripts/stt_daemon/speaker_merge.py`, a pure module (no I/O, no daemon, no SQLite), sibling to the existing `transcript_merge.py`. It is the milestone's highest-risk *logic* (spike 002: 8–12% coverage gap, ~15–20% arguable labels) and therefore must be isolated where it can be unit-tested to death on fixtures.**

The existing `transcript_merge.merge_segments(mic, sys)` is the **proof that this pattern works and a literal template**: it tags segments, sorts by `(start, channel_priority)`, and emits `[MM:SS speaker] text`. `speaker_merge` does the same *output*, but the speaker is decided by overlap with diarization turns instead of by which channel the segment came from.

**Public surface (one pure function, plus the helpers it composes):**

```python
def assign_speakers(
    *,
    asr_segments: list[dict],      # [{start, end, text}] from MLX/whisper.cpp
    turns: list[SpeakerTurn],      # [{start, end, speaker_idx}] from sherpa
    prior_map: dict[int, str] | None = None,  # speaker_idx -> stable speaker_id (idempotency)
) -> MergeResult:                  # labelled segments + rendered string + the (possibly extended) map
    ...
```

It must own **three distinct concerns**, each independently testable:

**(a) Overlap assignment.** For each ASR segment, pick the diarization turn with maximum temporal overlap (intersection of `[start,end]` intervals). Ties / multi-turn segments → the turn covering the larger fraction; this is the standard "argmax overlap" rule and matches what spike 002 measured (0.765–0.843 inter-tool agreement). Keep it O(n·m) or sort-merge O(n+m) — realistic meetings are hundreds of segments, so either is fine (spike 001 confirmed segment counts in the low hundreds).

**(b) ~10% coverage-gap fallback.** Spike 002 measured **8–12% of ASR segments fall outside any diarization turn** (whisper emits text where the VAD-driven diarizer found no speech turn, e.g. quiet/overlapped speech). Fallback rule, in order: (1) if the gap is bracketed by the *same* speaker on both sides, assign that speaker; (2) else assign the **nearest turn by midpoint distance**; (3) else (no turns at all) assign a sentinel `UNKNOWN` speaker rather than dropping the line — never lose transcript text. This rule set is pure and table-test-friendly.

**(c) Whisper hallucination / repeat handling.** Whisper is known to emit repeated phrases and hallucinated text in silence (the codebase already carries `hallucination_silence_threshold` on `TranscribeRequest` and a `condition_on_previous` flag — evidence this is a known pipeline hazard). The merge module should: collapse consecutive identical-text segments attributed to the same speaker (repeat artifact); and flag/down-rank zero- or near-zero-overlap segments whose text duplicates a neighbour as likely hallucination (assign by neighbour, or mark low-confidence). Crucially this is a **labelling-time** guard, not an ASR change — ASR output is immutable input here.

**Why a separate module (not folded into `transcript_merge.py` or the backend):**
- `transcript_merge.py` is the *channel* merge (2 fixed speakers, no overlap math). Keeping speaker-overlap merge separate avoids overloading a tested file and keeps each function single-purpose.
- Pure + dependency-free → the DER harness and unit tests feed it canned `asr_segments`/`turns` and assert on assignments without spinning up the daemon, sherpa, or sqlite. This is the single most important testability decision in the milestone.

**Output contract (mirror the existing line format so all downstream is free):** emit `[MM:SS <display_name>] <text>` lines, identical in shape to `transcript_merge`'s `[MM:SS 我] ...`. Default display names: `Speaker 1`, `Speaker 2`, … (or CN `说话人 1` to match the existing Chinese-first UI copy). Because the line format is unchanged, the search indexer, the UI transcript view, and `{{transcript}}` substitution need **zero** changes to *display* labels — they already render whatever string the transcript file holds.

### 3. The speaker-label DATA MODEL — store, serve, idempotency

**Decision: a per-recording structured sidecar `<stem>.speakers.json` as the source of truth for speaker data, while the human-readable labelled transcript stays in the existing `<stem>.transcript.txt`. SQLite is NOT extended for speaker data this milestone.**

This follows Yulu's strongest existing convention: **per-recording sidecar files next to the `.wav`** (`.transcript.txt`, `.raw.transcript.txt`, `.mic.transcript.txt`, `.sys.transcript.txt`, `.realtime.coverage.json`, `.summary.md`). `recordings.ts` already globs these by suffix; deletion already enumerates them (`recordings.ts` suffix list). A new `.speakers.json` rides those exact rails.

**Schema (`<stem>.speakers.json`):**

```json
{
  "schema_version": 1,
  "provider": "sherpa-onnx",
  "model": "cam++ zh-cn 27MB",
  "num_speakers_detected": 4,
  "num_speakers_supplied": null,
  "turns": [ {"start": 0.0, "end": 12.4, "speaker_idx": 0} ],
  "segments": [ {"start": 0.3, "end": 4.1, "speaker_id": "spk-0", "text_ref": 0} ],
  "speakers": {
    "spk-0": {"display_name": "Speaker 1", "renamed": false, "merged_into": null},
    "spk-1": {"display_name": "Lewis",     "renamed": true,  "merged_into": null}
  }
}
```

- `turns` = raw diarizer output (cheap to keep; lets re-merge run without re-diarizing).
- `speakers` = the **editable map**: `speaker_idx`/`spk-N` → user `display_name`. This is the only thing the UI mutates.
- `segments` carries the final assignment; `text_ref` points at the ASR segment (or inline the text — either is fine, inline is simpler).

**Why sidecar over SQLite:** (1) co-located with the recording → the configurable `data_dir` (iCloud/Drive) sync model carries speaker labels with the meeting automatically; SQLite lives in the *runtime* dir which is explicitly never synced (`search/indexer.py` comments). (2) Matches the dual-track precedent exactly. (3) The summaries/prompts SQLite is provenance-of-LLM-runs, not transcript content — speaker data doesn't belong there. The **search index** still gets the labelled transcript via the existing `upsert_doc(KIND_MEETING_TRANSCRIPT)` hook (labels are already inline in `.transcript.txt`), so speakers become searchable for free with no schema change.

**Serving to the UI:** extend the existing `recordings.ts` detail handler (it already reads `.transcript.txt`/`.summary.md` via a local `read(suffix)` helper) to also `read(".speakers.json")` and return parsed `speakers` + `segments`. The transcript view can then render names; a new tRPC mutation pair `renameSpeaker({stem, speakerId, name})` / `mergeSpeaker({stem, from, into})` writes the `speakers` map back atomically (read-modify-write the JSON; mirror the atomic-write convention used elsewhere).

**Idempotency / re-run safety — THE critical constraint.**

The requirement: *re-diarizing must not scramble user speaker renames.* The danger is real because cam++ cluster indices are **not stable across runs** — a re-run can assign "speaker 0" to a different person.

**Mechanism:** the user-facing identity is the **`display_name` keyed by a stable `speaker_id`**, decoupled from the volatile `speaker_idx`. On re-diarize:

1. Read the existing `<stem>.speakers.json` (the `prior_map` + `speakers`).
2. Run diarization → new raw `turns` with fresh `speaker_idx` values.
3. `speaker_merge.assign_speakers(prior_map=...)` re-anchors new indices to existing `speaker_id`s by **best overlap between new turns and the prior segment assignments** (the same overlap math, applied turn-set vs prior-turn-set). A new index that maps to an old speaker inherits that speaker's `spk-N` and its `display_name` (including any rename). A genuinely new cluster gets a fresh `spk-N` with a default name.
4. Renames the user already made (`"renamed": true`) are **never overwritten** — they are carried by `speaker_id`, and the re-anchor only ever *reassigns which idx points at which speaker_id*, never edits `display_name`.

So a re-diarize refreshes the *acoustic* assignment while preserving the *human* labels. If re-anchoring is ambiguous (low overlap), prefer keeping the prior label and flag low-confidence rather than renumbering. This is, again, pure logic living in `speaker_merge` → fully unit-testable ("given prior map X and new turns Y, renames survive").

A second-order idempotency note for the pipeline: `search/indexer.upsert_doc` is already sha256-dedup'd, and `transcribe.py` overwrites `.transcript.txt` deterministically — so re-running the whole stage is safe at the file level; the only stateful thing to protect is the `speakers` map, handled above.

### 4. Provisioning a `diarization` capability WITHOUT macOS coupling, respecting the one-way layering

The v0.5 layering is `provision/ → capabilities/ → platform/ → runtime`, one-way. Diarization respects it by entering at the **same three seams** the v0.5 work established, with no back-edges:

**(a) `platform/` — nothing new required.** sherpa-onnx ships **cp37–cp314 wheels for macOS (arm64+x86), Linux (x86+ARM), and Windows**, with **onnxruntime as the only runtime dep and no torch** (verified on PyPI, v1.13.2, 2026-05-13). The two ONNX model files are plain bytes. So diarization needs **no OS-specific code** — it is the cleanest possible cross-platform addition and directly satisfies the milestone's "must not hard-couple to macOS" mandate (which spike 002 flagged as the deciding reason to pick sherpa over FunASR+MPS). The only platform touch is path resolution, already abstracted by `PathResolver` (`config_dir()`/`data_dir()`/`runtime_dir()`); model files live under `runtime_dir()/models/` exactly like the GGML whisper models do today.

**(b) `capabilities/` — a new tri-state probe.** Add `probe_diarization()` to `capabilities/probes.py` returning a `Capability` with the existing tri-state `Status` (`usable` / `present-but-unverified` / `absent`) and `Provenance.YULU_MANAGED` (sherpa+models are Yulu-provisioned, not host-agent-supplied — unlike whisper which can be reused from the agent). `doctor.py` folds it into `HostCapabilityReport` the same way it folds the other probes. This is the report entry the UI settings page reads to show "Diarization: ready / models missing".

> **Important scoping nuance on the word "provider".** The spikes and PROJECT.md say "`diarization` capability provider behind the existing `CapabilityProvider` abstraction." Read literally that's a category error: today's `CapabilityProvider` ABC answers *"what has the host coding agent already configured that Yulu can reuse?"* and reframes host findings to `agent-config` provenance (see `capabilities/provider.py` docstring). Diarization is **Yulu-managed**, not agent-reused — there is no host `claude`-style binary to detect. So the faithful interpretation is: **diarization is surfaced as a capability *report entry* via a probe (provenance `yulu-managed`)**, and the *swappable-implementation* abstraction the spikes want (sherpa default, FunASR optional) is the **`DiarizeBackend` Protocol in `stt_daemon`**, selected by config — that is the real "provider behind an abstraction" seam. If a future milestone lets an agent supply its own diarizer, a `CapabilityProvider` subclass can then legitimately contribute a `diarization` entry with `agent-config` provenance, with zero edits to `report.py`/`probes.py` (the seam already guarantees pure-addition). Flag this to the roadmapper as a small but real terminology/architecture clarification — building it as a backend Protocol + a probe entry is correct; forcing it into the agent-reuse `CapabilityProvider` ABC is not.

**(c) `provision/` — extend the existing `models` step, don't add a new daemon.** Model + wheel acquisition belongs in `setup_models.sh`, which `provision/registry.py` already wraps 1:1 as the idempotent `models` step. Add: `pip install sherpa-onnx` into the diarization env, and download seg(5.7 MB)+cam++(27 MB) ONNX to `runtime_dir()/models/`. The step's read-only `check()` probe (`_model_present()` today) extends to also verify the two ONNX files exist → re-running provisioning is a no-op once present (the existing idempotency contract). Offline-by-default holds trivially: ONNX files are plain local bytes (none of FunASR's modelscope-snapshot offline bug from spike 001 — another reason sherpa wins). Because diarization is a sibling `stt_daemon` backend (not a new daemon), the `daemons` provision step is **unchanged** — no new launchd/`ServiceSpec` registration.

**Venv decision (flag for the phase plan):** spike 001 noted Yulu's venv is Python 3.14. sherpa-onnx publishes cp314 wheels, so it can likely co-locate in the existing `venv-mlx-whisper`. The phase should verify the wheel resolves on 3.14; if any conflict, give diarization its own small venv (the provision step already isolates envs). No torch means the footprint stays ~131 MB (spike 002), so a shared venv is the strong default.

**One-way layering audit:** `provision` calls `setup_models.sh` (no import of runtime); `capabilities` probe imports only stdlib + the platform path resolver (guarded import, degrades off-Darwin, mirrors the existing `probe_recording_dir` pattern); the `stt_daemon` backend imports `sherpa_onnx` + platform paths. No layer imports "up." Matches the established discipline exactly.

### 5. How speaker info flows into the agent-queue summary prompt

**Decision: add one prompt-var pair, mirroring the dual-track `{{my_transcript}}`/`{{their_transcript}}` addition — zero new plumbing.**

The pattern already exists end-to-end and is the template: `agent_queue_worker.py` reads the `.mic`/`.sys` sidecars, passes `my_transcript`/`their_transcript` into `prompts/cache.render()`, which does single-pass literal `.replace("{{my_transcript}}", ...)`. Legacy prompts that don't reference the var are unaffected (defaults to `""`).

**Implementation:**
1. `agent_queue_worker._handle_summary_request` already derives `audio_path` and reads sidecars. Add: read `<stem>.speakers.json`; build a **speaker-labelled transcript string** (it's already the content of `.transcript.txt`, so this may just be the existing `transcript_text`) and a compact **speaker roster** string (`"Speaker 1 (Lewis), Speaker 2, Speaker 3"` from the `speakers` map).
2. Extend `prompts/cache.render()` with `speaker_transcript: str = ""` and `speaker_list: str = ""`, adding two `.replace()` calls — exactly the shape of the existing five-var render. Default `""` keeps every existing prompt working (the same backward-compat property the dual-track addition relied on).
3. Seed prompts can then use `{{speaker_list}}` to ask the agent for per-speaker action items / attribution. Because `{{transcript}}` *already* carries inline `[MM:SS Speaker N] ...` labels (the merge module wrote them), even prompts that only use `{{transcript}}` get speaker context for free — the new vars are sugar for explicit per-speaker prompting.

No change to the `agent-queue.json` boundary, the `summary_request` event shape, the worker's claim/lock logic, or `llm.command` dispatch. The labels are *in the transcript text the worker already passes*; the structured roster is an additive convenience var.

---

## Recommended Project Structure (delta only)

```
yulu/scripts/
├── stt_daemon/
│   ├── backends/
│   │   └── diarize.py          # NEW  SherpaDiarizeBackend (warm_up/diarize/is_ready/release)
│   ├── speaker_merge.py        # NEW  PURE overlap-assign + gap-fallback + hallucination guard + re-anchor
│   ├── protocol.py             # MOD  +JobKind.DIARIZE, +DiarizeRequest/DiarizeResponse, +_TYPE_TO_CLS
│   ├── app.py / control_server.py / scheduler.py  # MOD  dispatch DIARIZE → background slot → diarize backend
│   ├── transcript_merge.py     # (unchanged — the 2-speaker channel-merge precedent)
│   └── __main__.py             # MOD  _build_real_backends: construct the diarize backend (held off the ASR runtime dict)
├── transcribe.py               # MOD  ASR → diarize → speaker_merge.assign → write .transcript.txt + .speakers.json
├── agent_queue_worker.py       # MOD  read .speakers.json → {{speaker_transcript}}/{{speaker_list}}
├── prompts/cache.py            # MOD  render(): +speaker_transcript/+speaker_list vars
├── capabilities/probes.py      # MOD  +probe_diarization() (tri-state, yulu-managed)
├── setup_models.sh             # MOD  pip sherpa-onnx + download seg+cam++ ONNX; check() verifies files
├── diarization/
│   └── eval/                   # NEW  DER harness: labelled CN+EN clips, sherpa-vs-FunASR DER, sets UI accuracy copy
└── yulu_ui/
    ├── src/routers/recordings.ts   # MOD  serve speakers.json; +renameSpeaker/mergeSpeaker mutations
    └── web/src/...                 # MOD  render labels; rename/merge UI
```

### Structure Rationale

- **`speaker_merge.py` as a top-level `stt_daemon` module, not under `backends/`:** it is pure logic with no model dependency; it belongs beside `transcript_merge.py`, its conceptual sibling, where both are importable by `transcribe.py` and by tests without touching sherpa.
- **Diarize backend under `backends/`** alongside `mlx.py`/`whisper_cli.py`/`cloud.py`: it IS a resident-model engine; it just isn't an *ASR* engine, so it's constructed in `_build_real_backends` but held on the app, not inserted into the `STTRuntime.backends` ASR dict.
- **`diarization/eval/` separate from shipped runtime:** the DER harness is dev tooling (labelled clips, metrics); keeping it out of the release zip respects the packaging exclude rules.

---

## Architectural Patterns

### Pattern 1: Post-process stage reusing the resident-model + Protocol lifecycle

**What:** Add a new capability as a `stt_daemon` backend with the established `warm_up`/`is_ready`/`release` lifecycle and a new `JobKind`, rather than a new daemon or inline subprocess.
**When to use:** Any new local model that runs over recorded audio and benefits from staying warm.
**Trade-offs:** + reuses scheduler, health, cancellation, warm-up, single-process footprint; − must consciously keep it OUT of the ASR fallback chain (it's a sibling, not an interchangeable engine).

### Pattern 2: Pure merge/assignment module (the `transcript_merge` lineage)

**What:** Isolate timestamp-overlap labelling logic as a dependency-free function returning both structured assignments and a rendered string in the existing `[MM:SS speaker] text` format.
**When to use:** Whenever two timestamped streams must be reconciled into one labelled transcript.
**Trade-offs:** + exhaustively unit-testable on fixtures (critical given 8–12% gaps + ~15–20% arguable labels); + downstream display is free because the output line format is unchanged; − the orchestrator must wire inputs (ASR segments + turns + prior map), which is correct ownership.

### Pattern 3: Per-recording structured sidecar as source-of-truth + inline labels for display

**What:** Keep machine-truth (raw turns, assignments, editable name map, provenance, version) in `<stem>.speakers.json`; keep human-readable labelled text inline in `<stem>.transcript.txt`. Stable `speaker_id` decouples user renames from volatile cluster indices.
**When to use:** Editable, re-derivable per-recording metadata that must survive folder-sync and re-runs.
**Trade-offs:** + travels with the meeting through the configurable `data_dir`/iCloud model; + search & prompt vars get labels for free; + idempotent re-diarize preserves renames; − the rename/merge mutation must atomically read-modify-write the JSON (well-trodden in the codebase).

---

## Data Flow

### Primary: record → ASR → diarize → merge → persist → summarize

```
<stem>.wav
   │
   ├─ TRANSCRIBE job ─► stt_daemon (MLX/whisper.cpp) ─► asr_segments [{start,end,text}]   (UNCHANGED)
   │
   ├─ DIARIZE job ────► stt_daemon (sherpa seg+cam++) ─► turns [{start,end,speaker_idx}]  (NEW)
   │
   ▼
speaker_merge.assign_speakers(asr_segments, turns, prior_map)          (NEW, PURE)
   │   overlap argmax → gap fallback (same-speaker bracket / nearest / UNKNOWN)
   │   → hallucination/repeat collapse → re-anchor idx→speaker_id (renames survive)
   ▼
labelled segments + "[MM:SS Speaker N] text" string + speakers map
   │
   ├─► <stem>.transcript.txt        (inline labels — existing file, existing search hook)
   ├─► <stem>.speakers.json         (turns + assignments + editable name map — NEW)
   └─► search.upsert_doc(...)       (existing; labels searchable for free)
   │
   ▼
enqueue summary_request ─► agent-queue.json ─► agent_queue_worker
   │   reads .speakers.json → {{speaker_transcript}}/{{speaker_list}} → prompts/cache.render()
   ▼
<stem>.summary.md  (+ SummariesRepo provenance row — existing)
```

### Re-run / edit flow (idempotency)

```
User clicks "Re-diarize"            User renames "Speaker 2" → "Lewis"
        │                                   │
        ▼                                   ▼
re-run DIARIZE → new turns          recordings.ts renameSpeaker mutation
        │                                   │
assign_speakers(prior_map)          read-modify-write <stem>.speakers.json
  re-anchor new idx → old           speakers["spk-1"].display_name = "Lewis"
  speaker_id; renames preserved        speakers["spk-1"].renamed   = true
        │                                   │
        ▼                                   ▼
rewrite .transcript.txt + .speakers.json   (renames NEVER overwritten by re-diarize)
```

---

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Typical meeting (20–90 min, hundreds of segments) | No adjustment. Spike 001: cam++ marginal cost +19% for 3.9× audio (~linear in speech-segment count); spike 002: sherpa RTF ~0.17 on CPU. Merge is O(n+m) sort-merge over hundreds of items — negligible. |
| Very long / dense recording (thousands of speech segments) | cam++ clustering is O(segments²) in theory (spike 001 caveat). Mitigation if it ever bites: cap/window the clustering or chunk the recording; not needed for realistic Yulu meetings. |
| Accuracy at scale (the real "bottleneck") | The limit is *quality*, not throughput. sherpa over-splits on CN (spike 002: 59→32→20 as threshold rises). Mitigations live in config/merge, not infra: supplied/estimated `num_speakers`, threshold tuning, calibration. The DER harness sets honest UI expectations. |

### Scaling Priorities

1. **First "bottleneck" is accuracy, not speed.** Ship the DER harness first-class; treat labels as "helpful hints" in UI copy (spike 002's explicit recommendation) until DER is measured.
2. **Speaker-count strategy** is the highest-leverage accuracy lever: expose an optional supplied count (calendar attendee count is a future hint), default to tuned-threshold auto with the over-split caveat surfaced.

---

## Anti-Patterns

### Anti-Pattern 1: Registering the diarize backend into the ASR `STTRuntime.backends` dict

**What people do:** Treat diarization as "just another engine" and add it to the `mlx/whisper/cloud` map so it shares dispatch.
**Why it's wrong:** `STTRuntime._engine_chain()` would make it reachable by ASR fallback, and its return type isn't `STTResult`. It is a sibling stage, not an interchangeable ASR engine.
**Do this instead:** Construct it in `_build_real_backends`, hold it on the app, dispatch via a dedicated `JobKind.DIARIZE`; keep the ASR runtime dict ASR-only.

### Anti-Pattern 2: Running diarization inline in `transcribe.py` (or a fresh subprocess per meeting)

**What people do:** `subprocess.run([... sherpa ...])` or load models inside the orchestrator.
**Why it's wrong:** Repeats the pre-ADR-001/004 anti-patterns the codebase explicitly names; pays cold-start + shader-JIT (spike 001) on every meeting; loses warm-up, cancellation, and health for free.
**Do this instead:** Resident backend in `stt_daemon`, warmed via `warm_up()`.

### Anti-Pattern 3: Making the cluster index the user-facing identity

**What people do:** Show "Speaker 0/1/2" straight from cam++ and let renames attach to the index.
**Why it's wrong:** Cluster indices are unstable across runs → a re-diarize renumbers people and scrambles renames.
**Do this instead:** Stable `speaker_id` in `.speakers.json` carries the `display_name`; re-diarize re-anchors new indices to existing `speaker_id`s by overlap; renames are never overwritten.

### Anti-Pattern 4: Forcing diarization into the agent-reuse `CapabilityProvider` ABC

**What people do:** Write a `DiarizationProvider(CapabilityProvider)` because PROJECT.md says "capability provider."
**Why it's wrong:** That ABC means "what the host coding agent already configured, reframed to `agent-config` provenance." Diarization is `yulu-managed` — there's no host binary to detect.
**Do this instead:** Surface it as a tri-state **probe entry** (`yulu-managed`) in `capabilities/probes.py`; put the swappable sherpa-vs-FunASR seam in the `DiarizeBackend` Protocol selected by config.

### Anti-Pattern 5: Putting speaker data in SQLite or dropping uncovered segments

**What people do:** Add a `speakers` table to a runtime SQLite DB; or drop ASR segments that fall in the ~10% diarization gap.
**Why it's wrong:** Runtime SQLite is never synced (labels wouldn't travel with the meeting); dropping segments loses transcript text the user spoke.
**Do this instead:** Sidecar `.speakers.json` in the synced `data_dir`; the gap fallback always assigns *some* speaker (or `UNKNOWN`) and keeps every line.

---

## Integration Points

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `transcribe.py` ↔ `stt_daemon` (diarize) | New `DiarizeRequest`/`DiarizeResponse` over `stt_daemon.sock` (JSON lines, same socket) | Mirror `transcribe_client.request_final_transcribe`; add `request_diarize`. Background slot. |
| `transcribe.py` ↔ `speaker_merge` | Direct in-process call (pure function) | Same as today's `transcript_merge.merge_segments` call for dual-track. |
| `transcribe.py` ↔ persistence | Writes `.transcript.txt` (existing) + `.speakers.json` (new) + `search.upsert_doc` (existing) | Atomic write for the JSON sidecar. |
| `agent_queue_worker` ↔ speakers | Reads `.speakers.json`; passes new render vars | No change to `agent-queue.json` event shape or claim/lock logic. |
| `yulu_ui` ↔ speakers | `recordings.ts` reads/writes `.speakers.json`; `renameSpeaker`/`mergeSpeaker` tRPC mutations | Read-modify-write the JSON map; React renders + edits labels. |
| `provision` ↔ models | `setup_models.sh` (wrapped by `registry.py` `models` step) downloads ONNX + pip sherpa; `check()` verifies files | Idempotent; offline-by-default (plain local bytes). |
| `capabilities`/`doctor` ↔ report | `probe_diarization()` → tri-state `Capability` (`yulu-managed`) folded into `HostCapabilityReport` | UI settings shows "Diarization: ready / models missing". |

### External Dependencies

| Dependency | Integration | Notes |
|------------|-------------|-------|
| `sherpa-onnx` (PyPI 1.13.2) | `pip install` into the (likely shared) venv; import in the diarize backend | cp37–cp314 wheels for macOS/Linux/Windows; **onnxruntime-only, no torch** → satisfies cross-platform mandate; verify cp314 resolution or isolate venv. |
| seg (5.7 MB) + cam++ (27 MB) ONNX | Downloaded to `runtime_dir()/models/` at provision | Plain local files → clean offline (no FunASR/modelscope snapshot bug from spike 001). |

---

## Suggested Build Order (dependency-respecting; each step independently testable)

The order follows the data flow and the v0.5 layering (`provision → capabilities → platform → runtime`), front-loading the pure, riskiest logic.

1. **`speaker_merge.py` (pure module) + its unit tests, on fixtures.** No sherpa, no daemon. Implement overlap-assign + gap fallback + hallucination/repeat guard + the `prior_map` re-anchor. This is the highest-risk *logic* and the foundation everything else displays — build and harden it first against canned `asr_segments`/`turns`. *(Depends on nothing.)*
2. **`<stem>.speakers.json` schema + read/write helpers + idempotency tests.** Lock the data model and the "renames survive re-diarize" property at the file level. *(Depends on 1 for the assignment shape.)*
3. **`SherpaDiarizeBackend` + protocol/dispatch wiring** (`JobKind.DIARIZE`, `DiarizeRequest/Response`, scheduler background-slot route, `warm_up`). Test against a short real clip → turns out. *(Can proceed in parallel with 1; merge needs its output only at integration.)*
4. **Provisioning: extend `setup_models.sh` + `registry.py` `models` `check()`** to install sherpa + fetch the two ONNX files; verify Python 3.14 wheel resolution (else isolate venv). Confirm offline. *(Depends on 3 knowing which model files it needs.)*
5. **`capabilities/probes.probe_diarization()` + `doctor.py` fold.** Tri-state report entry → UI settings can show readiness. *(Depends on 4 so the probe checks real artifacts.)*
6. **Wire `transcribe.py`: ASR → DIARIZE → `speaker_merge.assign` → write `.transcript.txt` + `.speakers.json` → search upsert.** Graceful degrade when diarization is absent/disabled (today's plain transcript). *(Depends on 1,2,3.)*
7. **Summary flow: `agent_queue_worker` reads `.speakers.json`; `prompts/cache.render()` gains `{{speaker_transcript}}`/`{{speaker_list}}`; seed prompt(s) use them.** *(Depends on 2,6.)*
8. **UI: `recordings.ts` serves `speakers`; `renameSpeaker`/`mergeSpeaker` mutations; React renders labels + rename/merge.** *(Depends on 2,6.)*
9. **DER eval harness (`diarization/eval/`): label 2–3 CN+EN meetings, measure DER for sherpa (and FunASR), pick default, set UI accuracy copy, decide speaker-count strategy defaults.** Can start once 3 exists; its *output* (default provider + accuracy copy) should land before the milestone is called done. *(Depends on 3; informs 5/8 copy.)*
10. **Cross-platform verification (stubs/CI):** confirm sherpa wheels + ONNX resolve behind the abstraction on the non-macOS targets (impl macOS now, others verified/stubbed per the v0.5 pattern). *(Depends on 3,4.)*
11. **Migration:** `yulu migrate` adds the `models` re-provision (sherpa + ONNX) for existing v0.5.x installs; recordings without `.speakers.json` simply show no labels until re-diarized (no destructive change). *(Depends on 4.)*

**Parallelizable:** 1↔3 (pure logic vs backend); 7 and 8 (summary vs UI consumption) are independent once 2+6 land; 9 runs alongside 5–8.

---

## Sources

- Live codebase (read 2026-06-06, HIGH confidence):
  - `yulu/scripts/stt_daemon/runtime.py` — `STTBackend` Protocol, `STTRuntime` engine fallback chain, `dispatch_transcribe`
  - `yulu/scripts/stt_daemon/protocol.py` — `JobKind`/slots, message dataclasses + codec table
  - `yulu/scripts/stt_daemon/transcript_merge.py` — the 2-speaker channel-merge precedent (`[MM:SS speaker] text`)
  - `yulu/scripts/stt_daemon/__main__.py` — `_build_real_backends` registration point
  - `yulu/scripts/transcribe.py` — the "PURE ORCHESTRATOR" + existing dual-track merge call
  - `yulu/scripts/agent_queue_worker.py` + `yulu/scripts/prompts/cache.py` — `{{my_transcript}}`/`{{their_transcript}}` render pattern
  - `yulu/scripts/prompts/db.py` — `PromptsRepo`/`SummariesRepo` (why speaker data does NOT go here)
  - `yulu/scripts/search/indexer.py` — sha256-dedup upsert hook, runtime-vs-data dir split
  - `yulu/scripts/capabilities/provider.py` + `report.py` — `CapabilityProvider` semantics (agent-reuse), tri-state `HostCapabilityReport`
  - `yulu/scripts/provision/registry.py` — idempotent `Step`/`ScriptStep`/`REGISTRY`, `check()`/`apply()` contract
  - `yulu/scripts/yulu_platform/base.py` — `DaemonManager`/`PathResolver`/`PermissionModel` ABCs, no-leaked-OS-vocabulary contract
  - `yulu/scripts/yulu_ui/src/routers/recordings.ts` — sidecar-by-suffix serving + deletion enumeration
- `.planning/spikes/002-option-b-diarization-merge/REPORT.md` — sherpa-onnx default; merge agreement 0.765–0.843; 8–12% coverage gap; CN over-split; accuracy unproven (HIGH for the engine decision)
- `.planning/spikes/001-funasr-camplus-diarization/REPORT.md` — option B confirmed; warm-up shader-JIT cost; cam++ ~linear marginal cost; FunASR offline/modelscope hazard (why sherpa's plain-file models win); Protocol-fit note
- `.planning/PROJECT.md` — v0.6 Active scope, cross-platform mandate, v0.5 layering & abstractions
- PyPI `sherpa-onnx` 1.13.2 (2026-05-13, MEDIUM-HIGH via WebFetch): cp37–cp314 wheels for macOS/Linux/Windows; onnxruntime-only; no torch — confirms the cross-platform + 3.14 viability claims

---
*Architecture research for: speaker diarization post-process integration into Yulu (v0.6)*
*Researched: 2026-06-06*
