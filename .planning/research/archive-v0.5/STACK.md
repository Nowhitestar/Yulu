# Stack Research

**Domain:** Speaker diarization — *supporting* stack for measurement, storage, and UI (v0.6, on the existing Yulu macOS meeting-recorder stack)
**Researched:** 2026-06-06
**Confidence:** HIGH (engine already de-risked by spikes 001/002; this report covers only the supporting stack and is version-verified via Context7 + PyPI)

> **Scope guard.** The diarization *engine* is settled by the spikes: **sherpa-onnx** (ONNX Runtime, no torch; seg 5.7 MB + cam++ 27 MB) as the default provider, FunASR/MPS optional. This report does **NOT** re-research the engine. It covers the three supporting areas the spikes flagged but did not build: (a) **measure** DER/JER, (b) **store** speaker labels, (c) **frontend** speaker-label UI. Everything below either reuses Yulu's existing stack or adds the smallest possible, torch-free dependency.
>
> *(This file supersedes the v0.5 "Agent-Native Provisioning" STACK.md at this path — that milestone is complete; its content remains in git history.)*

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **pyannote.metrics** | `4.1` (2026-05-06, current) | Compute **DER** (and JER, purity/coverage, identification error) against hand-labelled reference — the spikes' required eval gate | The **de-facto standard** for diarization eval; implements the *optimal* (Hungarian) reference↔hypothesis mapping DER expects, so numbers are comparable to published work. **Pure-Python, torch-free** — torch lives only in the *sibling* `pyannote.audio`, which we do NOT install. Reads/writes **RTTM** natively (`pyannote.database.util.load_rttm`). Satisfies the no-torch + local-first mandate. |
| **sherpa-onnx** | (engine — already chosen; not re-researched here) | Diarization engine | See spike 002. Listed only so the eval/store/UI layers have a named producer of `(speaker, start, end)` turns. |
| **better-sqlite3** | `^11.5.0` (already in `package-lock.json`) | Persist speaker labels + per-segment speaker map (UI/Node side) | **Already the UI's SQLite driver** (`src/db.ts`; powers `prompts.sqlite`/`vocab.sqlite`/`search.sqlite`). Speaker storage reuses it — **zero new dependency.** |
| **Python `sqlite3` stdlib** | (stdlib) | Persist speaker labels from the Python pipeline side (`stt_daemon`/`transcribe.py`/`agent_queue_worker.py`) | Yulu's Python is **stdlib-only for SQLite** (CONVENTIONS — `sqlite3`, atomic `os.replace`). The diarization writer is Python; same stdlib path. **Zero new dependency.** |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **spy-der** (`import spyder`) | `0.4.1` (2023-06-29) | Lightweight, **zero-dependency** DER (C++ core, own Hungarian impl); RTTM CLI `spyder ref.rttm hyp.rttm` | **Alternative / cross-check only**, not primary. Use for a sub-second DER with literally no Python deps. **Caveat:** last release 2023; **no macOS arm64 wheel** (only `macosx_10_14_x86_64` + sdist) → `pip install spy-der` will **compile C++ from source** on Apple Silicon (needs Xcode CLT, which Yulu already requires for `swiftc`). Keep as a confirmation tool, not the load-bearing one. |
| **`pyannote.core`** | pulled in by `pyannote.metrics` | `Annotation`/`Segment` objects the metric consumes | Transitive — build `Annotation` objects (or load RTTM) to feed `DiarizationErrorRate()`. No separate install decision. |
| **wavesurfer.js Regions plugin** | ships *inside* `wavesurfer.js@^7.8.0` (already installed) — import `wavesurfer.js/dist/plugins/regions.esm.js` | Draw **color-coded speaker spans** on the existing waveform; click-to-seek per turn | The "color-coding" requirement. **No new npm dependency** — Regions is part of the wavesurfer.js package Yulu already ships; `AudioPlayer.tsx` just isn't registering it yet. |
| **lucide-react** | already installed (used in `AudioPlayer.tsx`, reader route) | Icons for rename/merge/correct controls (`Pencil`, `Combine`/`Merge`, `Check`) | Reuse the existing icon set for the speaker-edit affordances. No new dependency. |

> **Hand-rolled fallback (no library at all):** DER is arithmetic once you have the optimal speaker mapping — `DER = (miss + false_alarm + confusion) / total_reference_speech`. A ~40-line pure-Python impl (`itertools.permutations` mapping for ≤6 speakers, which Yulu meetings are) is a legitimate zero-dependency option. **Recommendation:** use `pyannote.metrics` for the canonical number (optimal Hungarian mapping, JER, purity/coverage diagnostics) **and** keep a tiny hand-rolled DER in the test suite as an independent sanity check. Don't ship a hand-rolled metric as the *only* source of truth — collar/overlap handling is where naive impls silently diverge from published DER.

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| **RTTM** (file format, not a tool) | Interchange between hand labels, engine output, and the metric | NIST 10-field text format. Both `pyannote.metrics` and `spy-der` read it. Make the diarization engine *also* emit RTTM (trivial) so reference and hypothesis share one format → one-line DER. |
| **Audacity label track** | Manual reference labelling of the 2–3 CN+EN meetings | Open `.wav` → add a **Label Track** → mark each speaker turn (label text = speaker id) → **File → Export → Export Labels** → tab-separated `start \t end \t label`. Add a ~15-line `labels_to_rttm.py` (stdlib). Lowest-friction, fully local, no account. **Recommended labelling path.** |
| **pyannote.metrics CLI** | One-shot DER over a folder of RTTMs | `pip install "pyannote.metrics[cli]"` adds `pyannote-metrics.py diarization …`; handy for the harness but the Python API is enough. |
| **eval venv (isolated)** | Keep eval deps out of the runtime | Install `pyannote.metrics` into a **throwaway/dev venv** (or the existing `.venv-ci`), **NOT** `~/.config/yulu/venv-mlx-whisper/`. The metric is a dev/eval-time tool; it must never enter the shipped runtime. |

## Installation

```bash
# (a) MEASURE — DER/JER eval harness. DEV/EVAL VENV ONLY — never the runtime venv.
#     pyannote.metrics is torch-free (torch is only in pyannote.audio, which we DON'T install).
pip install "pyannote.metrics==4.1"          # canonical DER/JER + RTTM I/O
pip install "pyannote.metrics[cli]==4.1"     # optional: pyannote-metrics.py CLI

# Optional cross-check only (compiles C++ from source on arm64 — needs Xcode CLT):
pip install spy-der                           # import spyder; spyder.DER(ref, hyp)

# (b) STORE — no install. Reuse better-sqlite3 (^11.5.0, already in package-lock.json)
#     on the Node side and Python stdlib sqlite3 on the pipeline side.

# (c) FRONTEND — no install. Regions plugin ships inside the already-present wavesurfer.js@^7.8.0:
#     import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `pyannote.metrics` (DER) | `spy-der` | Want a literally-zero-dependency, C++-fast DER and you're OK compiling from source on arm64 (or running it in x86 CI). Good as an independent cross-check of the pyannote number. |
| `pyannote.metrics` (DER) | **Hand-rolled ~40-line DER** | Want **zero** external eval dependency. Fine for a smoke check; risky as the sole metric (collar/overlap edge cases). Keep it in tests, not as the headline number. |
| `pyannote.metrics` (DER) | NIST `md-eval-22.pl` (Perl) | You need byte-for-byte parity with a specific challenge's scoring. Overkill for Yulu; adds a Perl dependency. Skip. |
| `pyannote.metrics` (DER) | `dscore` (nryant) | Multi-metric DIHARD-style scoring. Heavier, less maintained than pyannote.metrics. Skip unless you specifically need its extra metrics. |
| Audacity label track | **Label Studio** (audio template) | You want a polished GUI / multiple labellers / exportable project. Heavier (web app + server) and more setup than a single dev needs for 2–3 files. Audacity → RTTM is faster here. |
| Audacity label track | **ELAN / Praat TextGrid** | Linguistics-grade tier annotation. More than needed; conversion to RTTM is extra work. |
| wavesurfer Regions plugin | Custom overlaid `<div>` lane under the wave | Only if you want a speaker lane *separate* from the wave. Regions (in-wave colored spans) is the lighter, idiomatic v7 path and reuses the existing `AudioPlayer` instance. |
| New `speaker_*` tables in `prompts.sqlite` | JSON sidecar `<stem>.speakers.json` next to the `.wav` | A sidecar matches Yulu's existing file-sidecar pattern (`.title`, `.tags.json`) and survives DB rebuilds, BUT loses queryability and the UI already speaks SQLite via tRPC. **Recommend SQLite as source of truth + optional RTTM sidecar export** for portability/eval (see "Stack Patterns"). |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **`pyannote.audio`** | Pulls in **torch + pytorch-lightning + the whole neural stack** (the exact ~1 GB+ footprint spike 002 rejected). It's the *engine* package; we only need the *metric* sibling. | `pyannote.metrics` (metrics-only — torch-free) |
| **torch / torchmetrics for DER** | Same no-torch mandate; the milestone's cross-platform/local-first goal is the whole reason sherpa-onnx beat FunASR. Don't reintroduce torch through the back door of "eval." | `pyannote.metrics` (pure-Python) or hand-rolled |
| **`speechbrain.utils.DER`** | Drags in SpeechBrain (torch). | `pyannote.metrics` |
| **A new ORM / SQLite wrapper** (Drizzle, Prisma, sql.js, Kysely…) | Yulu standardized on **`better-sqlite3` (Node)** + **stdlib `sqlite3` (Python)** with raw SQL, hand-written `_SCHEMA_SQL`, and idempotent `CREATE TABLE IF NOT EXISTS` migrations. A new abstraction fights the established convention. | Extend the existing raw-SQL schema in `prompts/db.py` / `search/indexer.py` style |
| **A new charting/timeline lib** (vis-timeline, d3, recharts) for the speaker lane | The waveform + Regions already gives a time axis; a second timeline lib is dead weight in a local SPA. | wavesurfer Regions plugin (already bundled) |
| **Label Studio as a hard project dependency** | Yulu is local-first, single-user, account-free; standing up a labelling server contradicts the product. Fine as a *personal* dev tool, not a dependency. | Audacity label track → `labels_to_rttm.py` (stdlib) |
| **Storing speaker labels by mutating `.transcript.txt`** | `.transcript.txt` is **overwritten by the cleanup prompt** (confirmed in `transcribe.py`: it "may be overwritten later by a cleanup prompt"). Speaker data baked into it is lost on re-cleanup. | Persist segments+speakers in SQLite (durable, re-run-idempotent); render labels at view time |

## Stack Patterns by Variant

**(a) MEASURE — the DER eval harness (concrete + runnable):**
- **Reference:** label 2–3 real CN+EN meetings in **Audacity label tracks** → export → convert to `ref/<stem>.rttm` with a stdlib `labels_to_rttm.py`.
- **Hypothesis:** have the sherpa-onnx provider emit `hyp/<stem>.rttm` (it already produces `(speaker, start, end)` turns — RTTM is a 10-field print line).
- **Score:**
  ```python
  from pyannote.metrics.diarization import DiarizationErrorRate, JaccardErrorRate
  from pyannote.database.util import load_rttm
  metric = DiarizationErrorRate(collar=0.25, skip_overlap=False)  # 0.25s collar = common convention
  ref = load_rttm("ref/meeting1.rttm")["meeting1"]
  hyp = load_rttm("hyp/meeting1.rttm")["meeting1"]
  der = metric(ref, hyp)                       # float, e.g. 0.18
  detail = metric(ref, hyp, detailed=True)     # miss / false-alarm / confusion breakdown
  jer = JaccardErrorRate()(ref, hyp)
  ```
  Run **sherpa** and **FunASR** through the same harness → pick the default provider on evidence (spike 002 step 6's explicit gate). Set the UI accuracy-expectation copy from the DER you actually measure. Harness lives in `tests/` or `scripts/eval/`, runs in the **dev/CI venv**.

**(b) STORE — speaker persistence (re-run idempotent):**
- **Source of truth = SQLite** (new `speaker_segments` + `speaker_labels` tables), keyed by `audio_path` — mirror the existing `summaries.audio_path` provenance pattern in `prompts/db.py`.
  - `speaker_segments(id, audio_path, start_ms, end_ms, speaker_key, source TEXT CHECK(source IN ('auto','manual')), run_id, created_at)` — one row per diarized turn.
  - `speaker_labels(audio_path, speaker_key, display_name, color, merged_into, updated_at)` — the human-editable rename/merge/color layer, **separate from raw segments** so re-running diarization never clobbers the user's names.
- **Idempotency:** stamp each pass with `run_id` (uuid) and **delete-then-insert** that recording's `auto` segments in a single transaction (the `prompts/db.py` transaction style), so re-running diarization replaces machine output but **preserves** `manual` overrides and `speaker_labels`. Direct analogue of how `agent_queue_worker.py` re-runs summaries idempotently.
- **Schema bootstrap:** follow the existing `_SCHEMA_SQL` + `CREATE TABLE IF NOT EXISTS` + `meta(schema_version)` convention; add a numbered migration like `prompts/db.py` already does. **Add the tables to `prompts.sqlite`** (already per-recording provenance) rather than a new DB file — unless you want isolation, then `diarization.sqlite` in `runtime_dir()` beside `search.sqlite`.
- **Search integration:** when labels change, re-run the existing `search/indexer.upsert_doc()` hook so the speaker-attributed transcript stays searchable (already called as a write hook in `agent_queue_worker.py`).
- **Portability export (optional):** also write `<stem>.diarization.rttm` (matches Yulu's sidecar habit, doubles as the eval `hyp`, survives DB rebuild). SQLite stays authoritative; the sidecar is a projection.

**(c) FRONTEND — speaker-label UI in the existing React + tRPC + wavesurfer stack:**
- **Transcript labels:** `TranscriptView.tsx` **already** detects a `Speaker [A-Z]:` prefix and styles a `.speaker` span — but speaker should come from **structured data**, not a regex over cleanup-able text. Add a tRPC query (`recordings.speakers`, or fold into `recordings.get`) returning `{segments, labels}` from the new tables; render each line with its speaker chip (display name + color).
- **Color-coding on the wave:** register the **Regions plugin** in `AudioPlayer.tsx`:
  ```ts
  import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
  const regions = ws.registerPlugin(RegionsPlugin.create());
  ws.on("decode", () => {
    for (const seg of speakerSegments)
      regions.addRegion({ start: seg.start, end: seg.end, color: colorFor(seg.speakerKey), drag: false, resize: false });
  });
  ```
  Click a region → seek (reuse the existing `initialSeek`/`onSeek` plumbing). Style via the v7 shadow-DOM `::part(region)` selector. **No new npm dependency.**
- **Rename / merge / correct:** reuse the existing inline-edit pattern (`InlineEditRow.tsx`; the title-rename flow in `recordings.$stem.tsx`) + TanStack Query **optimistic update** (`patchGet`) → tRPC mutations:
  - `recordings.renameSpeaker({ stem, speakerKey, displayName })`
  - `recordings.mergeSpeakers({ stem, from, into })` (sets `merged_into`; the view folds merged keys)
  - `recordings.reassignSegment({ stem, segmentId, speakerKey })` (writes a `manual` segment that wins over `auto`)
  All optimistic-patch the cached `get`, then `invalidateQueries` on settle — the exact pattern already used for rename/tags/delete. **No new state library.**
- **Color assignment:** small deterministic palette (hash `speaker_key` → fixed hue), persisted in `speaker_labels.color` so a renamed/merged speaker keeps its color. Pure CSS/JS, no dependency.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `pyannote.metrics@4.1` | Python ≥ 3.10 | Yulu's runtime venv is 3.14 (spike 001); CI uses system `python3`. 4.1 supports 3.10+. Install into the **dev/eval venv**, not the runtime venv — no coupling to the shipped daemon. **No torch** in its dependency tree. |
| `spy-der@0.4.1` | CPython 3.8 wheel (x86 only) | **No arm64 wheel** → source build on Apple Silicon (needs Xcode CLT, already present). Last release 2023. Optional cross-check; run in x86 CI if you want a prebuilt path. |
| `wavesurfer.js@^7.8.0` + Regions plugin | same package version | Regions is versioned **with** wavesurfer.js — import `wavesurfer.js/dist/plugins/regions.esm.js`; no separate version to pin. v7 API (`registerPlugin`, `addRegion`, `::part(region)`) confirmed via Context7. |
| `better-sqlite3@^11.5.0` | Node 20+ (project floor) | New speaker tables are plain SQL through the existing driver — no version change. |
| `@trpc/*@^11`, `@tanstack/react-query@^5.59`, `react@^18.3`, `react-router@^7`, `zod@^3.23` | each other (current lockfile) | All speaker UI/endpoints reuse these as-is. **No version bumps required** for v0.6. |

## Sources

- `/katspaugh/wavesurfer.js` (Context7) — Regions plugin import path (`dist/plugins/regions.esm.js`), `registerPlugin`, `::part(region)` styling, v7 plugin model — **HIGH**
- [pyannote-metrics · PyPI](https://pypi.org/project/pyannote-metrics/) — latest **4.1**, released **2026-05-06**, Python ≥3.10, extras (`cli`/`plot`/`transcription`), no torch in core — **HIGH**
- [pyannote.metrics 4.1 documentation](https://pyannote.github.io/pyannote-metrics/) + [reference](https://pyannote.github.io/pyannote-metrics/reference.html) — `DiarizationErrorRate` (optimal Hungarian vs greedy), JER, purity/coverage, RTTM I/O — **HIGH**
- [pyannote/pyannote-metrics (GitHub)](https://github.com/pyannote/pyannote-metrics) — metrics-only toolkit, separate from torch-based `pyannote.audio` — **HIGH**
- [spy-der · PyPI](https://pypi.org/project/spy-der/) + [desh2608/spyder README](https://github.com/desh2608/spyder/blob/main/README.md) — `import spyder; spyder.DER(ref, hyp)`, tuple `(speaker,start,end)` input, RTTM CLI, C++ core, **0.4.1 / 2023-06-29, no arm64 wheel** — **HIGH**
- [RTTM format specification](https://m.z3r.io/rttm-format-specification-and-its-application) + [pyannote-database](https://github.com/pyannote/pyannote-database) — 10-field NIST RTTM, the diarization interchange format — **MEDIUM** (format is stable/well-documented)
- Audacity label-track → export-labels workflow (search-corroborated) — manual reference labelling → tab-separated `start/end/label` → RTTM — **MEDIUM**
- Yulu codebase (read directly) — `prompts/db.py` (`summaries` keyed by `audio_path`; `_SCHEMA_SQL` + numbered migration + transaction pattern), `search/indexer.py` (FTS5 + `upsert_doc` write hook; `runtime_dir`/`data_dir` split), `transcribe.py` (`.transcript.txt` overwritten by cleanup; `.raw.transcript.txt` snapshot; `segments` flow through but aren't persisted structured), `stt_daemon/runtime.py` (`segments` = `[{start_ms,end_ms,text}]`), `AudioPlayer.tsx` (wavesurfer v7, **no** Regions yet), `TranscriptView.tsx` (existing `Speaker [A-Z]:` regex + `.speaker` class), `recordings.$stem.tsx` (inline-rename + optimistic `patchGet` + tRPC mutation pattern to mirror), `package.json` (pinned UI deps) — **HIGH**

---
*Stack research for: speaker-diarization supporting stack (measure / store / UI) on existing Yulu stack*
*Researched: 2026-06-06*
