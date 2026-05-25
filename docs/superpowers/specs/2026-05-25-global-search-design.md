# Spec: Global Search Across Voicemails, Meetings, and Summaries

> **Status**: Draft — pending user review
> **Date**: 2026-05-25
> **Owner**: 不白 (yxliao.lewis@gmail.com)
> **Builds on**: Phase 2 (`prompts.sqlite` + `summaries` metadata table), Phase 3 (dual-track recording + per-channel transcripts), Phase 4 (`voicemail` package — `_transcribe_and_enqueue` writes `transcript.txt` + later `summary.md`), Phase 5 (`status_agent.swift` IPC server)
> **Replaces**: nothing — pure addition of a new search surface. The existing browse paths (`yulu memo list`, `yulu memo show`, Finder on `~/Movies/Yulu/`) remain.
> **Out of scope** (future specs): semantic / embedding search (sqlite-vec); cross-device sync; AppKit Spotlight-style popover (this spec ships IPC only); search-result highlighting in the inline summary viewer; speaker-aware search (filter by who spoke a line); query-history / saved searches; OCR over images in summaries.

---

## 1. Background and Motivation

Phases 1–5 deliver capture and processing. The corpus on disk today is:

```
~/Movies/Yulu/                                       7.4 GB
  ├── <meeting_title>_<YYYYMMDD>_<HHMMSS>.wav        38 files
  ├── <meeting_title>_<YYYYMMDD>_<HHMMSS>.transcript.txt
  ├── <meeting_title>_<YYYYMMDD>_<HHMMSS>.summary.md  11 files
  ├── <meeting_title>_<YYYYMMDD>_<HHMMSS>.realtime.transcript.txt  (rough, redundant)
  └── voicemails/
       ├── voicemail_<YYYYMMDD>_<HHMMSS>.wav         (currently empty after Phase 4 ship)
       ├── voicemail_<YYYYMMDD>_<HHMMSS>.transcript.txt
       └── voicemail_<YYYYMMDD>_<HHMMSS>.summary.md
```

That data is opaque after the week it was captured. Asking "did anyone mention OKR in last week's product weekly?" requires `grep -ri "OKR" ~/Movies/Yulu`, which works for ASCII but misses cleanup-corrected forms, ignores the temporal axis, and has no concept of "summary vs raw transcript." Asking the same question over voicemails requires opening every `.transcript.txt` by hand.

`prompts.sqlite` has a `summaries` table (Phase 2) but it stores **metadata only** (audio_path, prompt_slug, status, model, duration_ms, word_count); the summary body lives in the `.md` file. There is no full-text index anywhere.

Phase 6 closes the recall loop: capture → process → **find**.

## 2. Goals

1. **One command, all corpora**: `yulu search "OKR"` searches across meeting summaries, meeting transcripts, voicemail summaries, and voicemail transcripts in one ranked list.
2. **Filterable**: by time (`--since 7d`), kind (`--type voicemail|meeting`), and content layer (`--in summary|transcript`).
3. **Composable**: same query path exposed as IPC (`{"action":"search", ...}`) on the existing `status_agent.sock`, so future menu-bar UI / Spotlight-style popover plugs in without re-implementing.
4. **Self-maintaining index**: writers update the index synchronously when they produce content; a cheap mtime sweep at query time catches anything missed (file moved/deleted/edited out-of-band).
5. **Chinese-friendly**: ≥ 3-char Chinese queries work via the SQLite trigram tokenizer; 1–2-char queries fall back to `LIKE` automatically (no silent zero-results).
6. **Zero new daemons**: no `search_indexer.plist`. Writers already have process identity; readers run as CLI / inside `status_agent`.
7. **Doctor-checkable**: `yulu doctor` reports search index health (row counts, last sweep, schema version).

## 3. Non-Goals

- Realtime indexing of `.realtime.transcript.txt`. These are rough, redundant with the post-stop `.transcript.txt`, and noisy. Phase 7 candidate at most.
- Semantic / vector search. Trigram + LIKE gets us to "useful daily tool." Embeddings need a model + storage + retrieval re-rank loop; deferred.
- Search-result preview rendering. We return a snippet; viewers (CLI, future popover) decide how to display.
- Re-cleaning historical content. We index whatever is on disk; the existing `transcribe.py` / `agent_queue_worker` already produces the cleaned versions.

## 4. Data Layout

New SQLite at `~/.config/yulu/search.sqlite` (alongside `vocab.sqlite`, `prompts.sqlite`).

### 4.1 Schema

```sql
-- FTS5 virtual table holding the searchable text + minimum metadata
CREATE VIRTUAL TABLE docs USING fts5(
    kind UNINDEXED,           -- 'meeting_summary' | 'meeting_transcript'
                              -- | 'voicemail_summary' | 'voicemail_transcript'
    stem UNINDEXED,           -- e.g. '30minwithYuxingMasonLee_20260513_140012'
    meeting_title UNINDEXED,  -- e.g. '30minwithYuxingMasonLee' (parsed from stem)
    recorded_at UNINDEXED,    -- ISO-8601 with seconds, derived from stem timestamp
    source_path UNINDEXED,    -- absolute path to backing file
    body,                     -- THE searchable content (transcript or summary text)
    tokenize = 'trigram'
);

-- Sidecar table for incremental sync. Rows track (source_path, mtime, sha256).
-- Sweep compares disk mtime to this; sha256 lets a writer skip the upsert
-- when the content is byte-identical to what's already indexed.
CREATE TABLE docs_meta (
    source_path TEXT PRIMARY KEY,
    rowid_in_docs INTEGER NOT NULL,    -- FTS5 docs.rowid
    mtime REAL NOT NULL,                -- POSIX mtime seconds
    sha256 TEXT NOT NULL,
    indexed_at TEXT NOT NULL            -- ISO-8601 when we last upserted
);
CREATE INDEX idx_docs_meta_mtime ON docs_meta(mtime);

-- Global meta (versioning, last sweep)
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Seeded rows: schema_version='1', last_full_sweep_at=<ISO>, corpus_root=<path>
```

`PRAGMA journal_mode = WAL;` is set on every connection open (existing convention from `prompts.db`).

### 4.2 Stem parsing

Every indexable file's stem follows `<title>_<YYYYMMDD>_<HHMMSS>(.<modifier>)?.<ext>`:

| Pattern | Example | meeting_title | recorded_at |
|---|---|---|---|
| `<title>_YYYYMMDD_HHMMSS.transcript.txt` | `30minwithYuxingMasonLee_20260513_140012.transcript.txt` | `30minwithYuxingMasonLee` | `2026-05-13T14:00:12` |
| `<title>_YYYYMMDD_HHMMSS.summary.md` | same as above | same | same |
| `<title>_YYYYMMDD_HHMMSS.<slug>.summary.md` | `voicemail_20260513_140012.action-items.summary.md` | `voicemail` | `2026-05-13T14:00:12` |
| Voicemails use literal title `voicemail` | `voicemail_20260513_140012.transcript.txt` | `voicemail` | `2026-05-13T14:00:12` |

Regex (single source of truth, owned by `search.indexer.parse_stem`):

```
^(?P<title>.+?)_(?P<date>\d{8})_(?P<time>\d{6})$
```

Slug-tagged summary variants (`<stem>.<slug>.summary.md`) are indexed as separate rows with the same `meeting_title` / `recorded_at` but different `source_path`. Useful so "OKR" can match an `action-items.summary.md` distinctly from the default `summary.md`.

If a file doesn't match the regex (e.g. user dropped a manual note), we skip it — log a debug line, no error.

### 4.3 Why a separate SQLite file?

`vocab.sqlite` is hot-cached in `stt_daemon` and SIGHUP-reloaded; `prompts.sqlite` is shared between `agent_queue_worker` and CLI. Mixing FTS5 virtual tables into `prompts.sqlite` would:
- Conflate "what summaries exist" (curated metadata) with "what's indexable" (raw cleaned text), violating SRP.
- Make `prompts.sqlite` backup / migration much heavier (FTS5 shadow tables are ~3× body size).
- Force every reader of `prompts.sqlite` to deal with FTS5 schema versioning.

Separate file. Clean lifecycle. `yulu doctor` checks both.

## 5. Writers (Push Path)

Three writers, all using the same helper:

```python
# yulu/scripts/search/indexer.py
def upsert_doc(*, source_path: Path, kind: str, body: str | None = None) -> None:
    """
    If body is None, read source_path. Compute sha256; compare with docs_meta;
    skip if unchanged. Otherwise upsert into docs (DELETE existing rowid +
    INSERT) and update docs_meta. Safe to call concurrently — uses a WAL-mode
    connection with a brief BEGIN IMMEDIATE.
    """
```

| Writer | Hook point | kind |
|---|---|---|
| `agent_queue_worker._handle_summary_request` | After `output_path.write_text(summary_md, ...)` succeeds | `'meeting_summary'` or `'voicemail_summary'` (decided by whether source dir == voicemails) |
| `voicemail.recorder._transcribe_and_enqueue` | After `transcript_path.write_text(text, ...)` succeeds | `'voicemail_transcript'` |
| `transcribe.py` (meeting transcripts) | After `output_path.write_text(text, ...)` succeeds | `'meeting_transcript'` |

Write failures must **not** break recording. The hook is wrapped:

```python
try:
    search.indexer.upsert_doc(source_path=p, kind=k)
except Exception as exc:
    log.warning("search index upsert failed for %s: %s", p, exc)
    # do NOT re-raise — recording / summary pipeline owns the user contract
```

The mtime sweep (next section) will recover any miss.

## 6. Reader (Sweep + Query)

Single entry point, used by CLI and IPC alike:

```python
# yulu/scripts/search/reader.py
@dataclass
class SearchHit:
    kind: str
    stem: str
    meeting_title: str
    recorded_at: str          # ISO-8601
    source_path: str
    score: float              # FTS5 bm25 (lower is better; we negate to "higher=better")
    snippet: str              # ~200 chars with [hit]...[/hit] markers

def search(
    query: str,
    *,
    since: timedelta | None = None,
    kinds: list[str] | None = None,
    limit: int = 20,
) -> tuple[list[SearchHit], dict]:    # (hits, telemetry: {sweep_ms, query_ms, fallback_used})
    ...
```

### 6.1 Sweep (called at the top of `search()` on every invocation)

1. `os.walk` two roots: `~/Movies/Yulu/` (depth 1, only files matching the stem regex) and `~/Movies/Yulu/voicemails/`.
2. For each candidate file, `stat(mtime)` and compare against `docs_meta.mtime`.
3. If `mtime > docs_meta.mtime` or row absent: call `upsert_doc` (re-reads + sha256 dedup).
4. After scanning, find `docs_meta` rows whose `source_path` no longer exists on disk → `DELETE FROM docs WHERE rowid=?; DELETE FROM docs_meta WHERE source_path=?`.
5. Write `meta.last_full_sweep_at = now`.

Measured at current corpus size (38 files): expected < 50 ms. If sweep exceeds 250 ms (corpus grows), we add `--no-sweep` to the CLI and a `last_sweep_at` freshness gate (skip sweep if last_sweep_at < 60 s ago).

### 6.2 Query

```python
# Tokenizer-aware path selection
query_norm = query.strip()
if len(query_norm) < 3 or _looks_short_cjk(query_norm):
    # Trigram tokenizer needs ≥ 3 chars of indexable content to generate
    # any trigram. Short queries (esp. 1-2 char Chinese like '进度') would
    # silently return zero results from FTS5. Route them through LIKE.
    return _like_search(query_norm, since=since, kinds=kinds, limit=limit)
return _fts_search(query_norm, since=since, kinds=kinds, limit=limit)
```

FTS5 path:

```sql
SELECT
    kind, stem, meeting_title, recorded_at, source_path,
    bm25(docs) AS score,
    snippet(docs, 5, '[hit]', '[/hit]', '...', 16) AS snippet
FROM docs
WHERE docs MATCH ?
  AND (:kinds_filter)        -- IN (?, ?, ...) if kinds is set
  AND (:since_filter)         -- recorded_at >= :since_iso if since is set
ORDER BY bm25(docs)
LIMIT :limit;
```

LIKE fallback (used for short queries):

```sql
SELECT
    kind, stem, meeting_title, recorded_at, source_path,
    0.0 AS score,
    substr(body, max(1, instr(body, :q) - 60), 200) AS snippet
FROM docs
WHERE body LIKE :pattern   -- '%query%'
  AND (:kinds_filter)
  AND (:since_filter)
ORDER BY recorded_at DESC   -- no rank signal; newest first
LIMIT :limit;
```

Telemetry returned alongside hits so the CLI can show `--verbose` timing and the doctor can spot regressions.

### 6.3 Concurrency

- Writers and the sweep both take a `BEGIN IMMEDIATE` for the upsert/delete block (a few ms).
- WAL mode means readers don't block writers; the query SELECT is non-blocking.
- One additional invariant: only one process should run the sweep at once. We use a `BEGIN IMMEDIATE` around the entire sweep transaction — concurrent sweepers will busy-retry briefly. Acceptable for tens of files.

## 7. IPC + CLI

### 7.1 IPC (extends `status_agent.swift` IPCServer)

New action:

```jsonc
// Request
{
  "action": "search",
  "query": "OKR",                          // required, non-empty
  "since_days": 7,                          // optional, >= 0
  "kinds": ["meeting_summary"],             // optional, subset of the four
  "in": ["summary"],                        // optional shorthand: ["summary"] → all *_summary kinds
  "limit": 20                                // optional, default 20, max 100
}

// Response
{
  "ok": true,
  "hits": [
    {
      "kind": "meeting_summary",
      "stem": "AgentkeyProductWeekly_20260521_160008",
      "meeting_title": "AgentkeyProductWeekly",
      "recorded_at": "2026-05-21T16:00:08",
      "source_path": "/Users/liaoyuxing/Movies/Yulu/AgentkeyProductWeekly_20260521_160008.summary.md",
      "score": 3.21,                       // higher = better (we negate bm25)
      "snippet": "...本周 [hit]OKR[/hit] 整体..."
    }
  ],
  "elapsed_ms": 18,
  "fallback_used": false                    // true if LIKE path was taken
}
```

Implementation: Swift `case "search":` dispatches to a Python helper via `Process` (same pattern as `loadRecentVoicemails`), passing JSON in via stdin, parsing JSON back from stdout. Keeps all search logic in Python (no Swift FTS5 binding).

### 7.2 CLI

```bash
yulu search "OKR"                          # default: all kinds, limit 20
yulu search "OKR" --since 7d               # last 7 days
yulu search "OKR" --type voicemail         # only voicemail_* kinds
yulu search "OKR" --type meeting           # only meeting_* kinds
yulu search "OKR" --in summary             # only *_summary kinds (skip transcripts)
yulu search "OKR" --in transcript          # only *_transcript kinds
yulu search "OKR" --limit 5
yulu search "OKR" --json                   # raw JSON to stdout
yulu search "OKR" --open                   # macOS `open` on the top-scored hit
yulu search --doctor                       # row counts, last sweep, schema version
yulu search --reindex                      # force full rebuild (drop + re-walk)
```

`yulu search` is a top-level verb (peer of `memo`, `prompts`, `vocab`), dispatched by the `yulu` shell wrapper. It is a thin client that goes through the IPC socket when `status_agent.sock` exists, and falls back to in-process Python (importing `search.reader`) when the agent isn't running. **Both paths share the same `search.reader.search()` function** — no behavior drift.

Output format (default, no `--json`):

```
$ yulu search "OKR" --since 7d --in summary
2 hits (18 ms, FTS5)

[1] meeting_summary  AgentkeyProductWeekly  2026-05-21 16:00:08
    ...本周 [OKR] 整体...
    /Users/liaoyuxing/Movies/Yulu/AgentkeyProductWeekly_20260521_160008.summary.md

[2] meeting_summary  30minwithYuxingMasonLee  2026-05-13 14:00:12
    ...讨论 Q2 [OKR] 调整...
    /Users/liaoyuxing/Movies/Yulu/30minwithYuxingMasonLee_20260513_140012.summary.md
```

`[hit]...[/hit]` markers are rendered as ANSI bold-underline when stdout is a TTY; passed through verbatim otherwise.

## 8. Install / Migration

Phase 6 is purely additive — no existing files move.

1. `setup.sh` adds: `python3 -m search.indexer init` to create `~/.config/yulu/search.sqlite` with schema v1 if missing.
2. First `yulu search` after install auto-runs a full sweep, populating from whatever is already on disk.
3. `yulu search --reindex` is the user-visible recovery path.
4. `yulu doctor` (Phase 1 module) gains a `_check_search_index()` block returning OK / row-count / last_sweep_at / schema_version.

No daemon restart needed for the writers — they pick up `search.indexer` via normal import. `agent_queue_worker` SIGHUP would refresh prompts cache as it does today; the indexer import is module-level, no reload needed.

## 9. Acceptance Criteria

Each criterion below maps to a test in `tests/test_search_*.py`.

1. **Schema bootstraps cleanly**: opening a fresh `search.sqlite` creates docs/docs_meta/meta tables and seeds `meta.schema_version='1'`.
2. **Upsert is idempotent**: calling `upsert_doc` twice on the same unchanged file does one upsert and one no-op (sha256 dedup); docs.rowid is stable across the no-op.
3. **Sweep picks up out-of-band changes**: if a `.summary.md` is touched on disk (mtime advanced) but `upsert_doc` was never called, the next `search()` call indexes it.
4. **Sweep removes deleted files**: if a file is deleted on disk, the next `search()` call removes its docs + docs_meta rows.
5. **English query returns ranked hits**: indexing a synthetic corpus containing "OKR" in 3 docs and "KPI" in 1 doc, `search("OKR")` returns the 3 OKR docs in bm25 order.
6. **Chinese 3+ char query works via trigram**: indexing 中文 docs, `search("项目进度")` matches a doc containing "本周项目进度整体良好".
7. **Chinese 2-char query routes to LIKE fallback**: `search("进度")` returns the same doc; response has `fallback_used=True`.
8. **Filters compose**: `search("OKR", since=timedelta(days=7), kinds=["meeting_summary"])` returns only meeting_summary rows recorded in the last 7 days.
9. **Slug-tagged summaries are separate rows**: `<stem>.summary.md` and `<stem>.action-items.summary.md` index as two rows with same `meeting_title` / `recorded_at`, distinct `source_path`.
10. **Stem parser tolerates the literal `voicemail` title**: `voicemail_20260513_140012.transcript.txt` parses with `meeting_title='voicemail'`.
11. **Stem parser skips non-matching files**: `notes.md` in `~/Movies/Yulu/` is skipped without raising.
12. **Index upsert failure does not break recording**: monkeypatching `upsert_doc` to raise causes `_transcribe_and_enqueue` to still complete and return; a warning is logged.
13. **IPC search round-trips**: with `status_agent` running, `{"action":"search","query":"OKR"}` returns the same hits as in-process `search.reader.search("OKR")`.
14. **CLI in-process fallback works**: with `status_agent` NOT running, `yulu search "OKR"` still works (uses in-process search.reader).
15. **`yulu search --doctor` prints row counts**: shows total docs, per-kind counts, last_sweep_at, schema_version.
16. **`yulu search --reindex` rebuilds from scratch**: drops + re-populates docs / docs_meta, idempotent.
17. **Concurrency: two parallel upserts on the same file produce a single row**: regression for the BEGIN IMMEDIATE / sha256 dedup path.
18. **Sweep completes in <250ms on 38-file corpus**: telemetry-asserted.

## 10. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| FTS5 shadow tables bloat `search.sqlite` faster than expected. | Separate file, easy to `VACUUM` or delete; `yulu search --doctor` shows size. Phase 7 candidate: configurable retention by `recorded_at`. |
| Trigram tokenizer ships in macOS sqlite 3.45 but absent in some Linux distros. | We're a macOS-only product (launchd + Swift app). `setup.sh` runs `SELECT sqlite_version();` and refuses install on < 3.34. |
| Short-query LIKE fallback over a large corpus becomes slow. | At current scale negligible. Spec records `query_ms` in telemetry; if user reports > 500 ms for any query, Phase 7 adds a length-2-gram secondary index. |
| Writer hook silently fails repeatedly → permanent index drift. | Sweep recovers everything on next `yulu search`. Doctor reports stale rows (`source_path` missing on disk) as warnings. |
| Two CLI processes both call `search()` simultaneously → both run sweep. | BEGIN IMMEDIATE serializes; second sweeper finds nothing changed and exits in ms. |
| Realtime transcripts (`.realtime.transcript.txt`) get indexed by accident. | Stem regex matches `<title>_DATE_TIME` only; the `realtime` infix breaks the pattern. Explicitly tested (acceptance #11). |
| User renames a `.md` file → orphan row remains. | Sweep's "absent on disk" pass deletes it within the next `yulu search` invocation. |
| `~/.config/yulu/search.sqlite` corruption. | `yulu search --reindex` is the documented recovery. Doctor flags corruption via `PRAGMA integrity_check`. |

## 11. Architecture Decisions (will become ADR-006 after implementation)

1. **Separate `search.sqlite` (not in `prompts.sqlite`)**: lifecycle isolation, FTS5 shadow-table bloat containment, schema-version independence.
2. **Trigram + LIKE hybrid (not jieba)**: zero new Python deps, works for English and 3+ char CJK, LIKE handles the 1–2 char gap. Jieba would require maintaining a dictionary and adds a 5-MB dep — not worth it for a personal-scale corpus.
3. **Hybrid sync (writer push + reader sweep), no FSEvents daemon**: avoids a new launchd job. Writers already exist; sweep is cheap at corpus scale.
4. **Shared `search.reader.search()` between CLI and IPC**: one query path, no behavior drift. Status agent's Swift IPC server shells out to Python (same pattern as `loadRecentVoicemails`); CLI imports directly when agent unavailable.
5. **`yulu search` is a top-level verb**: matches the established `yulu memo`, `yulu prompts`, `yulu vocab` shape. Better discoverability than nesting under `yulu status-agent`.

## 12. Telemetry / Observability

Every `search()` call returns telemetry: `sweep_ms`, `query_ms`, `fallback_used`, `hit_count`. CLI shows this with `--verbose`; IPC response always includes it. `yulu doctor` aggregates the last N invocations into a "p50 / p95 sweep_ms" line (uses a small ring buffer in `~/.config/yulu/search_telemetry.jsonl`, capped at 1 MB).

## 13. Open Questions (to resolve during planning)

1. Should we index `.html` summaries alongside `.md`? They contain the same content, just rendered. → **Decision deferred to planning.** Likely no — `.md` is canonical, `.html` is a rendering artifact.
2. Do we want a per-corpus search root config (`config.json: search.roots: [...]`) or hardcode `~/Movies/Yulu/`? → **Hardcode for v1**, config is a Phase 7 add if user wants to index e.g. `~/Documents/notes/`.
3. Should sweep also re-hash files whose mtime is unchanged but sha256 might have drifted (e.g. filesystem clock skew on iCloud sync)? → **No for v1**, mtime is the contract; if user has clock-skew issues, `--reindex` is the answer.
