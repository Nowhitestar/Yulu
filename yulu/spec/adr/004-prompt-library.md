# ADR-004: Prompt Library + multi-summary with single LLM dispatcher

**Status**: Accepted
**Date**: 2026-05-22
**Spec**: [docs/superpowers/specs/2026-05-22-prompt-library-design.md](../../../docs/superpowers/specs/2026-05-22-prompt-library-design.md)
**Builds on**: [ADR-002](002-vocab-sqlite-single-source.md) (vocab SQLite + SIGHUP cache pattern)
**Supersedes**: hardcoded `SUMMARY_PROMPT` constants in `scripts/transcribe.py` and `scripts/agent_queue_worker.py`; the inline cleanup prompt in `transcribe.py::refine_transcript`; the inline `summarize()` + `fallback_summary()` LLM path.

## Context

Three pre-spec LLM call sites carried three independently-edited prompt strings:

1. `transcribe.py::SUMMARY_PROMPT` — used by `summarize()` when `llm.command` was configured.
2. `agent_queue_worker.py::SUMMARY_PROMPT` — used when transcribe enqueued a `summary_request` (fallback path or queued path). Slightly different wording from #1.
3. `transcribe.py::refine_transcript` — inline f-string for the transcript-cleanup pass.

Net effect: editing any prompt meant editing source code; the two summary prompts had already drifted; the dispatch path branched between "inline LLM in transcribe.py" and "queue → worker" with subtly different validation. Each meeting produced exactly one summary file even when the user wanted "Action Items" and "Decisions" as separate documents.

## Decision

SQLite-backed prompt catalog at `~/.config/yulu/prompts.sqlite` (mirroring `vocab.sqlite`) with two categories — `summary` and `cleanup` — and a per-prompt `is_auto_run` flag.

`transcribe.py` becomes a pure enqueuer: for each `is_auto_run` prompt, it appends one `summary_request` event to `agent-queue.json` carrying a **snapshot of the prompt content at enqueue time**.

`agent_queue_worker.py` is now the **single LLM dispatcher** in the codebase. It owns:
- Snapshot-first resolution (legacy events without `prompt_*` fields fall back to the cache's default `summary` slug)
- `SummariesRepo` provenance — every dispatch records `model`, `duration_ms`, `word_count`, `status`, `error` in the `summaries` table
- Branching: `cleanup` slug writes to `<audio>.transcript.txt` (overwriting transcribe.py's raw write); summary slugs write to `<audio>.<slug>.summary.md`
- HTML artifact generation + `send_summary.py` dispatch, both only for the default `summary` slug

File-on-disk artifacts preserved: default summary still writes to `<meeting>.summary.md` (no slug infix) for Obsidian / send_summary / existing-tool compatibility; other summary slugs get `<meeting>.<slug>.summary.md`.

## Rejected alternatives

- **DB-only summary content** (macparakeet's approach) — would break Yulu's file-centric workflow. Obsidian users sync .md files; `send_summary.py` reads .md files; iCloud sync expects .md files.
- **Keep inline LLM in transcribe.py for low latency, queue only as fallback** — preserves the dual-path drift problem that triggered this spec. The drift between the two `SUMMARY_PROMPT` strings was the smoking gun.
- **YAML prompt files instead of SQLite** — concurrent CLI writer + worker reader is messier without WAL; SQLite tooling is already in-house from Phase 1 (vocab). Mirroring the pattern means one architecture to maintain.
- **Per-prompt LLM model selection at this spec** — YAGNI. The `summaries.model` column already records what was used; a future spec can add `prompts.preferred_model` as an additive column.

## Consequences

**Good**
- Single LLM dispatch surface (`agent_queue_worker._handle_summary_request`). All future LLM throttling, retry, fallback chain lands in one place.
- `transcribe.py` shrinks from 340 → 187 lines; all LLM concerns gone.
- Users get multi-version summaries by toggling `is_auto_run` on additional prompts. `action-items` ships off-by-default; users opt in via `yulu prompts edit action-items --auto-run`.
- Provenance: `yulu summaries list --audio <wav>` shows every dispatch with timing + status. `yulu summaries list --status error` for debugging.
- Reproducibility: even if a prompt is edited later, the snapshot in `summaries.prompt_content` lets you re-render the same input.

**Bad**
- LLM is now always queue-dispatched, even when `llm.command` is a fast local subprocess. Adds ~5s tick latency from `agent_queue_worker`'s launchd polling. Acceptable for the meeting-summary use case; immediate dispatch can be added later if it becomes UX-painful.
- The `summaries` table grows monotonically. One row per dispatch per meeting; even at 10 meetings/day with 3 auto-run prompts that's ~11k rows/year — manageable for sqlite. No retention policy this spec.
- Cleanup slug overwriting `.transcript.txt` means we lose the "raw vs cleaned" file-level distinction visible from `ls`. The `.raw.transcript.txt` sibling preserves the pre-cleanup version, so the information is still recoverable, just less prominent.

## Notes for future change

- **New prompt categories** (e.g. `chat`, `digest`) are additive enum extensions; the SQLite `CHECK` constraint needs updating but no schema migration required for existing rows.
- **Per-prompt model selection** — add `preferred_model` column to `prompts`; worker honors it when set, falls back to global `llm.command`. SummariesRepo already records actual model used per row.
- **Cross-meeting aggregator** — e.g. weekly digest. New category `digest` with prompts that ingest multiple transcripts; transcribe.py wouldn't be the enqueuer (a separate scheduler picks N transcripts and enqueues one digest event). The dispatcher code can stay unchanged.
- **Live preview / chat** would need an immediate-dispatch path that bypasses the queue. The PromptsCache + render() helpers are reusable; the dispatcher becomes plural (sync + async LLM clients).
