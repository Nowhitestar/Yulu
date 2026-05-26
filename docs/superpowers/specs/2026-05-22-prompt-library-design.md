# Spec: Prompt Library + Multi-Summary

> **Status**: Draft — pending user review
> **Date**: 2026-05-22
> **Owner**: 不白 (yxliao.lewis@gmail.com)
> **Inspired by**: macparakeet `spec/12-processing-layer.md` (Prompt Library + multi-summary + per-result snapshot)
> **Builds on**: ADR-002 (Vocab SQLite + SIGHUP cache pattern), ADR-001 (single-LLM-runtime principle)
> **Replaces**: hardcoded `SUMMARY_PROMPT` strings in `scripts/transcribe.py` (`summarize`, `fallback_summary`) and `scripts/agent_queue_worker.py` (`_handle_summary_request`); hardcoded `refine_transcript` cleanup prompt
> **Out of scope** (future specs): voicemail/agent inbox, dictation Transforms, dual-track recording

---

## 1. Background and Motivation

The Phase-1 STT-daemon + vocab work cleaned up the speech path. The LLM path remains a tangle:

- `scripts/transcribe.py` carries one hardcoded `SUMMARY_PROMPT` template plus an inline `summarize()` that runs the LLM subprocess directly, with a `fallback_summary()` regex tier when the LLM fails.
- `scripts/agent_queue_worker.py` carries a **second**, slightly different hardcoded `SUMMARY_PROMPT` plus its own LLM dispatch path.
- `scripts/transcribe.py::refine_transcript` carries a **third** hardcoded prompt for transcript cleanup, again with its own subprocess.

Three call sites, three prompt strings, two duplicated dispatch paths, no way for a user to change a prompt without editing source. A meeting always produces exactly one summary file even when "Action Items" and "Decision Log" would be more useful separately.

This spec ports macparakeet's Prompt Library + multi-summary model into Yulu, adapted for Yulu's file-centric workflow (Obsidian / send_summary / launchd agent queue).

## 2. Goals

1. **Single source of truth for LLM prompts** at `~/.config/yulu/prompts.sqlite`, editable via `yulu prompts` CLI.
2. **Single LLM dispatch path** — `agent_queue_worker` is the only place that spawns the LLM subprocess. `transcribe.py` only enqueues work.
3. **Multi-summary per meeting** — multiple `is_auto_run` prompts each produce their own `<meeting>.<slug>.summary.md` file (back-compat: `slug='summary'` writes to legacy `<meeting>.summary.md`).
4. **Provenance** — every summary file is paired with a row in a `summaries` table containing the prompt snapshot, model used, duration, status. Reproducibility + observability.
5. **Zero LLM subprocess invocations** in `transcribe.py` after this spec lands.

## 3. Non-Goals

- A live in-app prompt editor or UI surface.
- Streaming LLM output (worker remains batch-per-event).
- Cross-meeting prompt analytics or A/B testing.
- Voicemail / chat / Transforms — separate prompts categories deferred to future specs.
- Migrating historical summaries (`.summary.md` files on disk pre-spec stay where they are).

## 4. Topology

```
meeting ends → transcribe.py
                ├─ writes .raw.transcript.txt + .transcript.txt (unchanged)
                ├─ reads is_auto_run prompts from prompts.sqlite
                └─ enqueues one summary_request event per prompt
                            ↓
                   ~/.config/yulu/agent-queue.json
                            ↓
              agent_queue_worker (launchd, ~5s tick)
                            ├─ ONLY LLM dispatcher
                            ├─ runs llm.command (claude / codex / any)
                            ├─ writes <meeting>.<slug>.summary.md
                            ├─ inserts row in summaries table (status, model, duration)
                            ├─ writes <meeting>.<slug>.summary.html via html_artifact
                            └─ for slug='summary': triggers send_summary
                            
                   yulu prompts CLI ── writes prompts.sqlite, SIGHUPs worker for cache reload
                   PromptsCache (used inside worker; transcribe.py reads via short-lived connection)
```

No new daemon. Worker grows two responsibilities (was: handle one summary type; now: handle N summaries plus an optional cleanup pass) but the surface is the same `summary_request` event with one new field.

## 5. Module Boundaries

| Module | Role | New / Modified |
|---|---|---|
| `yulu/scripts/prompts/__init__.py` | Package marker, re-exports | **NEW** |
| `yulu/scripts/prompts/db.py` | `PromptsRepo` (CRUD) + `SummariesRepo` (CRUD) over sqlite | **NEW** |
| `yulu/scripts/prompts/seed.py` | Frozen `SEED_PROMPTS` snapshot of legacy prompts | **NEW** |
| `yulu/scripts/prompts/cli.py` | `yulu prompts list/add/edit/remove/seed/export/import/reload` | **NEW** |
| `yulu/scripts/prompts/cache.py` | `PromptsCache` (WAL-aware mtime + SIGHUP, mirrors `VocabCache`) | **NEW** |
| `yulu/scripts/transcribe.py` | Delete `summarize`/`fallback_summary`/`SUMMARY_PROMPT`; enqueue per-prompt events | **MODIFIED** |
| `yulu/scripts/agent_queue_worker.py` | Single LLM dispatcher; reads prompt content from snapshot in event, writes summaries-table row, dispatches html + send | **MODIFIED** |
| `yulu/scripts/queue_store.py` | Add `prompt_id` / `prompt_slug` / `prompt_content_snapshot` to summary_request schema; back-compat: missing fields fall through to default prompt | **MODIFIED (small)** |
| `yulu/scripts/send_summary.py` | Default sends slug=`summary`; add `--prompt <slug>` for ad-hoc | **MODIFIED (small)** |
| `yulu/scripts/html_artifact.py` | Accept slug-tagged output paths; no behavior change for default | **MODIFIED (small)** |
| `yulu/scripts/yulu` (shell) | Dispatch `prompts` subcommand to `python -m prompts.cli` | **MODIFIED (one line)** |
| `yulu/scripts/setup.sh` | Add `yulu prompts seed --from-current` step | **MODIFIED** |
| `yulu/spec/adr/004-prompt-library.md` | Architectural decision record | **NEW** |

## 6. SQLite Schema

**Path**: `~/.config/yulu/prompts.sqlite`. WAL mode for concurrent CLI writer + worker reader.

```sql
CREATE TABLE prompts (
    id          TEXT PRIMARY KEY,           -- UUID v4
    slug        TEXT NOT NULL UNIQUE,       -- short ID for file naming
                                            -- e.g. "summary", "action-items", "transcript-cleanup"
    name        TEXT NOT NULL,              -- human-readable display name
    category    TEXT NOT NULL CHECK(category IN ('summary', 'cleanup')),
    content     TEXT NOT NULL,              -- template; supports {{transcript}}, {{meeting_title}}, {{date}}
    is_auto_run INTEGER NOT NULL DEFAULT 0, -- 1 = fires automatically per meeting
    source      TEXT NOT NULL DEFAULT 'manual'
                CHECK(source IN ('seed', 'manual', 'learned')),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    note        TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX idx_prompts_category_autorun ON prompts(category, is_auto_run);

CREATE TABLE summaries (
    id              TEXT PRIMARY KEY,       -- UUID
    audio_path      TEXT NOT NULL,          -- absolute canonical path; implicit meeting FK
    prompt_id       TEXT NOT NULL,          -- FK to prompts(id) at dispatch time
    prompt_slug     TEXT NOT NULL,          -- snapshot
    prompt_name     TEXT NOT NULL,          -- snapshot
    prompt_content  TEXT NOT NULL,          -- snapshot (template before substitution)
    output_path     TEXT NOT NULL,          -- absolute path to <meeting>.<slug>.summary.md
    html_path       TEXT,                   -- optional html artifact
    model           TEXT,                   -- first word of llm.command (claude / codex / ...)
    status          TEXT NOT NULL CHECK(status IN ('queued', 'running', 'done', 'error')),
    error           TEXT,
    duration_ms     INTEGER,
    word_count      INTEGER,
    created_at      TEXT NOT NULL,          -- when enqueued
    completed_at    TEXT                    -- when worker finished (status in done/error)
);
CREATE INDEX idx_summaries_audio ON summaries(audio_path);
CREATE INDEX idx_summaries_status ON summaries(status);

CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- meta rows: schema_version=1, seeded_at=<ISO 8601>
```

### Constraints / semantics

- `slug` is the user-stable identifier. It must be URL-safe filename-safe (lowercase letters, digits, hyphens). CLI validates on add/edit.
- A row with `slug='summary'` is treated as "default" — its output is written to `<meeting>.summary.md` (no slug infix) for back-compat. Other slugs get `<meeting>.<slug>.summary.md`.
- `category='cleanup'` rows write their output back to `<audio>.transcript.txt` (overwriting transcribe.py's raw write). At most one cleanup prompt can be `is_auto_run` simultaneously; CLI add/edit enforces this.
- Templates support **exactly three variables**: `{{transcript}}`, `{{meeting_title}}`, and `{{date}}`. Substitution is single-pass, literal — no Jinja, no escaping.
  - `{{date}}` resolves to the meeting recording's date in `YYYY-MM-DD` form. The recording date is parsed from the audio filename's trailing `_YYYYMMDD_HHMMSS` suffix (Yulu's audio_daemon naming convention); on parse failure, falls back to `os.stat(audio_path).st_mtime` formatted as `YYYY-MM-DD` in the system timezone. The same resolution is reused everywhere the variable is referenced (transcribe.py at enqueue, worker at dispatch).
- Prompt edits do not retroactively change existing `summaries` rows (snapshot fields make those reproducible).

### Seed snapshots (frozen)

`prompts/seed.py` carries three rows; `yulu prompts seed --from-current` is idempotent (matches `(slug)` not `(content)`):

| slug | name | category | is_auto_run | content source |
|---|---|---|---|---|
| `summary` | Standard Summary | summary | **1** | Merged from transcribe.py's `SUMMARY_PROMPT` and agent_queue_worker's `SUMMARY_PROMPT`; takes the union of formatting requirements |
| `transcript-cleanup` | Transcript Cleanup | cleanup | **1** | transcribe.py's `refine_transcript` inline prompt |
| `action-items` | Action Items & Decisions | summary | **0** (user opts in) | New, macparakeet-style: focus only on actions, decisions, owners, deadlines |

The merge for `summary`: take agent_queue_worker's wording (more directive: "请基于以下..."), keep transcribe.py's `template_section` placeholder for `summary_template.md`. Final canonical text written out at seed time and frozen here.

## 7. Event Schema (agent-queue.json `summary_request`)

### Current (kept for back-compat)

```json
{
  "id": "<uuid>",
  "type": "summary_request",
  "title": "Meeting Title",
  "transcript_path": "/abs/path.transcript.txt",
  "summary_path": "/abs/path.summary.md",
  "template_path": "/abs/path/summary_template.md",
  "ts": "..."
}
```

### Extended (new fields, all optional for back-compat)

```json
{
  "id": "<uuid>",
  "type": "summary_request",
  "title": "Meeting Title",
  "audio_path": "/abs/path.wav",              // NEW: lets worker compute output paths
  "transcript_path": "/abs/path.transcript.txt",
  "summary_path": "/abs/path.summary.md",     // for slug='summary'; or path.<slug>.summary.md
  "html_path_hint": "/abs/path.summary.html", // optional; worker will derive if absent
  "prompt_id": "<uuid>",                      // NEW: FK to prompts(id) at enqueue time
  "prompt_slug": "summary",                   // NEW: snapshot for routing
  "prompt_name": "Standard Summary",          // NEW: snapshot for summaries table + logs
  "prompt_content_snapshot": "请...{{transcript}}...",  // NEW: full template at enqueue
  "ts": "..."
}
```

Worker dispatch logic:
- If `prompt_content_snapshot` present → substitute variables → run LLM with it.
- If absent (legacy event) → load default `slug='summary'` prompt from `PromptsCache` → substitute → run LLM with it.

## 8. CLI Surface (`yulu prompts`)

Mirror of `yulu vocab` for consistency. Writes auto-SIGHUP daemon (worker reads pid file at `~/.config/yulu/agent_queue_worker.pid` — added in this spec).

```
yulu prompts list [--category summary|cleanup] [--auto-run] [--json]
yulu prompts add <slug> --name <name> --category <summary|cleanup> [--auto-run] [--from-file <path>]
yulu prompts edit <slug> [--name ...] [--content <path>] [--auto-run|--no-auto-run]
yulu prompts remove <slug>
yulu prompts show <slug>                          # print content
yulu prompts seed --from-current
yulu prompts seed --restore-defaults
yulu prompts export [--format json] [-o path]
yulu prompts import <file.json>
yulu prompts reload                               # SIGHUP worker (also fires after mutations)

yulu summaries list [--audio <path>] [--status ...] [--json]
yulu summaries show <id>
```

The `yulu summaries` subcommand is a thin reader over the `summaries` table — useful for `yulu summaries list --status error` debugging or `yulu summaries list --audio <wav>` to see what versions exist.

## 9. Cache (`PromptsCache`)

Mechanical clone of `VocabCache`:

```python
class PromptsCache:
    def __init__(self, db_path: Path, *, autoreload: bool = False): ...
    def load(self) -> None: ...
    def reload(self) -> None: ...
    def maybe_reload(self) -> bool: ...  # WAL-aware mtime poll
    def auto_run(self, category: str) -> list[Prompt]: ...  # filtered + sorted by sort_order
    def by_slug(self, slug: str) -> Optional[Prompt]: ...
    def by_id(self, prompt_id: str) -> Optional[Prompt]: ...
    def render(self, prompt: Prompt, *, transcript: str, meeting_title: str, date: str) -> str:
        return (prompt.content
                .replace("{{transcript}}", transcript)
                .replace("{{meeting_title}}", meeting_title)
                .replace("{{date}}", date))


def resolve_meeting_date(audio_path: Path) -> str:
    """Extract YYYY-MM-DD from audio filename's trailing _YYYYMMDD_HHMMSS suffix.
    Falls back to file mtime in system timezone. Same logic used by transcribe.py
    (at enqueue) and agent_queue_worker (at dispatch) so the value is identical."""
    import re
    from datetime import datetime
    m = re.search(r"_(\d{8})_\d{6}\.", audio_path.name)
    if m:
        try:
            return datetime.strptime(m.group(1), "%Y%m%d").strftime("%Y-%m-%d")
        except ValueError:
            pass
    try:
        return datetime.fromtimestamp(audio_path.stat().st_mtime).strftime("%Y-%m-%d")
    except OSError:
        return datetime.now().strftime("%Y-%m-%d")
```

Used by:
- `transcribe.py` — short-lived (load → query → close)
- `agent_queue_worker.py` — long-lived in the worker process; SIGHUP triggers `reload()`

## 10. New transcribe.py shape

After this spec, `process_audio` becomes pure orchestration. Pseudocode (~80 lines down from 340):

```python
def process_audio(audio_path_str: str):
    config = load_config()
    audio_path = Path(audio_path_str)
    meeting_title = audio_path.stem.rsplit("_", 1)[0].replace("_", " ")

    # 1. transcript (unchanged via stt_daemon)
    transcript = _request_final_transcribe(audio_path, ...) or read_realtime_transcript(...)
    if transcript is None:
        sys.exit(2)
    raw_path = audio_path.with_suffix(".raw.transcript.txt")
    raw_path.write_text(transcript)

    # 2. seed default .transcript.txt now; cleanup prompt (if any) will overwrite
    transcript_path = audio_path.with_suffix(".transcript.txt")
    transcript_path.write_text(transcript)

    # 3. enqueue all auto-run prompts for this meeting
    cache = PromptsCache(PROMPTS_DB); cache.load()
    queued = 0
    for prompt in cache.auto_run('cleanup'):
        # cleanup writes back to .transcript.txt
        _enqueue(prompt, audio_path, transcript_path, meeting_title,
                 output_path=transcript_path, kind='cleanup')
        queued += 1
    for prompt in cache.auto_run('summary'):
        suffix = '.summary.md' if prompt.slug == 'summary' else f'.{prompt.slug}.summary.md'
        output = audio_path.with_suffix(suffix)
        _enqueue(prompt, audio_path, transcript_path, meeting_title,
                 output_path=output, kind='summary')
        queued += 1

    print(f"📁 {audio_path.name}: queued {queued} LLM jobs; agent_queue_worker will process them")


def _enqueue(prompt, audio_path, transcript_path, meeting_title, *, output_path, kind):
    rendered = PromptsCache(...).render(prompt, transcript=transcript_path.read_text(), meeting_title=meeting_title)
    event = {
        "type": "summary_request",
        "title": meeting_title,
        "audio_path": str(audio_path),
        "transcript_path": str(transcript_path),
        "summary_path": str(output_path),
        "prompt_id": prompt.id,
        "prompt_slug": prompt.slug,
        "prompt_name": prompt.name,
        "prompt_content_snapshot": prompt.content,  # template, not rendered
    }
    if kind == 'summary':
        event['html_path_hint'] = str(output_path.with_suffix('.html'))
    queue_store.append_event(event)
```

Deleted from `transcribe.py`:
- `SUMMARY_PROMPT` constant
- `summarize()` function
- `fallback_summary()` function
- `_send_agent_notification()` (duplicated against `_notify_agent`; consolidate)
- `_looks_like_agent_event_json()` — moves to `prompts/dispatch.py` since only worker needs it
- `refine_transcript()` — replaced by enqueuing a cleanup prompt

## 11. New agent_queue_worker.py shape

```python
def _handle_summary_request(entry, llm_command, timeout_sec, cache: PromptsCache):
    # 1. resolve prompt + render
    snapshot = entry.get('prompt_content_snapshot')
    prompt_id = entry.get('prompt_id')
    prompt_slug = entry.get('prompt_slug', 'summary')
    prompt_name = entry.get('prompt_name', 'Standard Summary')
    if snapshot is None:
        # legacy event
        p = cache.by_slug('summary')
        snapshot = p.content
        prompt_id, prompt_slug, prompt_name = p.id, p.slug, p.name

    transcript_path = Path(entry['transcript_path'])
    transcript = transcript_path.read_text(encoding='utf-8') if transcript_path.exists() else ''
    from prompts.cache import resolve_meeting_date
    date = resolve_meeting_date(Path(entry.get('audio_path', transcript_path)))
    rendered = (snapshot
                .replace('{{transcript}}', transcript)
                .replace('{{meeting_title}}', entry.get('title', ''))
                .replace('{{date}}', date))

    # 2. record start
    summary_id = summaries_repo.start(
        audio_path=entry.get('audio_path', ''),
        prompt_id=prompt_id, prompt_slug=prompt_slug, prompt_name=prompt_name,
        prompt_content=snapshot, output_path=entry['summary_path'],
        model=llm_command[0] if llm_command else None,
    )

    # 3. run LLM
    t0 = time.monotonic()
    try:
        result = subprocess.run(llm_command, input=rendered,
                                capture_output=True, text=True, timeout=timeout_sec)
        if result.returncode != 0:
            raise RuntimeError(f"llm rc={result.returncode}: {result.stderr[:500]}")
        output = result.stdout.strip()
        if not output or _looks_like_agent_event_json(output):
            raise RuntimeError("llm output empty or returned agent-event JSON")
    except Exception as exc:
        summaries_repo.error(summary_id, str(exc))
        raise
    duration_ms = int((time.monotonic() - t0) * 1000)

    # 4. write output
    output_path = Path(entry['summary_path'])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(output + '\n', encoding='utf-8')

    # 5. html artifact (summary slug only by default; controlled per category)
    html_path = ''
    if prompt_slug != 'transcript-cleanup' and entry.get('html_path_hint'):
        try:
            from html_artifact import write_meeting_summary_html
            html_path = str(write_meeting_summary_html(
                output_path, transcript_path, Path(entry['html_path_hint']),
                title=entry.get('title', '')))
        except Exception as exc:
            log(f"html generation failed: {exc}")

    summaries_repo.done(summary_id, duration_ms=duration_ms,
                        word_count=len(output.split()), html_path=html_path or None)

    # 6. dispatch send (default summary only)
    if prompt_slug == 'summary':
        _dispatch_send_summary(output_path)
```

Deleted from `agent_queue_worker.py`:
- `SUMMARY_PROMPT` constant
- `_render_summary_prompt()` function (replaced by inline snapshot resolution above)
- The hardcoded `_is_valid_summary` section list — kept only as "non-empty + not agent-event-JSON" check (per-prompt section validation belongs to the user; if their prompt requires "## TL;DR", they'll see when it's missing)

## 12. Test Strategy

| File | Coverage | Tier |
|---|---|---|
| `tests/test_prompts_db.py` | CRUD, slug uniqueness, category check, summaries-table CRUD | unit |
| `tests/test_prompts_seed.py` | 3 seed rows idempotent, restore-defaults preserves manual | unit |
| `tests/test_prompts_cache.py` | auto_run filter, by_slug, render substitution (all 3 vars), `resolve_meeting_date` with valid suffix / unparseable suffix / missing file, WAL mtime reload, SIGHUP | unit + integration |
| `tests/test_prompts_cli.py` | argparse subcommands, slug validation, --from-file, --auto-run flag, SIGHUP fire | unit |
| `tests/test_transcribe_enqueue.py` | with mocked queue_store + cache, verify N events enqueued per meeting | unit |
| `tests/test_agent_queue_worker_prompts.py` | snapshot resolution, legacy event fallback, summary file write, summaries-table row insert (status flow), error path | integration |
| `tests/test_spec_acceptance.py` (extended) | grep transcribe.py for SUMMARY_PROMPT (must be absent); grep agent_queue_worker.py same; verify `yulu prompts list \| wc -l ≥ 3` | acceptance |

E2E real-LLM test stays opt-in (`pytest -m e2e`); not added in this spec since it would require a real claude/codex CLI installed in CI.

## 13. Acceptance Criteria

1. `grep -E "SUMMARY_PROMPT" yulu/scripts/transcribe.py yulu/scripts/agent_queue_worker.py` returns zero hits.
2. `grep -E "^\s*def (summarize|fallback_summary)\b" yulu/scripts/transcribe.py` returns zero hits.
3. `yulu prompts seed --from-current` then `yulu prompts list --json | jq length` ≥ 3.
4. Spawn a fresh `~/.config/yulu/prompts.sqlite`, enable two `summary` auto-run prompts plus the default, run `transcribe.py` on a recorded WAV, then poll `agent-queue.json` — exactly **3** `summary_request` events appear (one per prompt).
5. After agent_queue_worker processes them: 3 `<meeting>.<slug>.summary.md` files exist (the default at `<meeting>.summary.md`); 3 rows in `summaries` table with `status='done'`.
6. Worker handles a hand-crafted legacy event (no `prompt_*` fields) — falls back to default summary prompt; row in summaries table records its snapshot.
7. `pytest -q` all green (~110 tests after this spec's additions).
8. `transcribe.py` < 200 lines.

## 14. Migration Path

| Step | Action |
|---|---|
| 1 | `bash yulu/scripts/setup.sh --upgrade` (or fresh `setup.sh`) installs prompt DB + seeds 3 prompts |
| 2 | After upgrade, existing recorded meetings can be re-transcribed; `transcribe.py <existing.wav>` will enqueue new-format events |
| 3 | Old `.summary.md` files preserved; not touched |
| 4 | In-flight queue events from before upgrade still work via legacy-event fallback in worker |

setup.sh additions:
```bash
echo "→ Seeding prompts.sqlite..."
PYTHONPATH="$SCRIPT_DIR" "$PYTHON_BIN" -m prompts.cli seed --from-current >/dev/null \
  && ok "prompts seed 完成" \
  || warn "prompts seed 失败"
```

dev_install.py: no new launchd plist (agent_queue_worker already exists). Just ensure the worker has a pid file written for SIGHUP — current worker doesn't write one; add `~/.config/yulu/agent_queue_worker.pid` write at worker startup.

## 15. Open Questions

None at spec-writing time. Future specs to file:
- Per-prompt output validators (allow users to declare required sections)
- LLM model fallback chain (claude → codex → ollama) when primary returns malformed output
- Cross-meeting "summary aggregator" — combine N meeting summaries into a weekly digest via another prompt category

---

**End of spec.**
