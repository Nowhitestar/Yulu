# Plan: Global Search (Phase 6)

> **Status**: Ready for execution
> **Date**: 2026-05-25
> **Owner**: 不白 (yxliao.lewis@gmail.com)
> **Spec**: `docs/superpowers/specs/2026-05-25-global-search-design.md`
> **Branch**: stacked on `claude/phase5-status-agent` (depends on Phase 5 IPC)

## Pre-flight reading (every executor task starts here)

1. **Spec** — `docs/superpowers/specs/2026-05-25-global-search-design.md` (especially §4 schema, §6.2 query path, §9 acceptance criteria)
2. **Existing modules to mirror in style**:
   - `yulu/scripts/prompts/db.py` — schema bootstrap pattern, WAL mode, dataclass shapes
   - `yulu/scripts/voicemail/repo.py` — directory-scan + dataclass return + tests style
   - `yulu/scripts/status_agent_config.py` — CLI argparse + IPC client pattern (Phase 5)
3. **Existing writers we will hook into**:
   - `yulu/scripts/agent_queue_worker.py` `_handle_summary_request` — where `output_path.write_text(...)` lives
   - `yulu/scripts/voicemail/recorder.py` `_transcribe_and_enqueue` — where `transcript_path.write_text(...)` lives
   - `yulu/scripts/transcribe.py` — where meeting `transcript.txt` is written

## Conventions

- Python 3.11+ syntax (the repo uses `dict[str, Any]`, `list[str]`, `X | None` already)
- All new modules under `yulu/scripts/search/` package
- Tests under `tests/test_search_*.py`, one file per module
- WAL mode on every new SQLite connection
- AF_UNIX paths kept short (`/tmp/yulu_test_<uuid>.sock`) to dodge the 104-byte limit (Phase 5 lesson)
- No new launchd job — sweep + writer-push covers freshness
- Every commit: `feat(search)` or `test(search)` or `feat(<existing>): wire search index hook`

## Task breakdown

### Phase A — Scaffolding (no behavior change yet)

#### A.1 — Create `search/` package + schema bootstrap
- **Files**: `yulu/scripts/search/__init__.py`, `yulu/scripts/search/indexer.py`
- **Code**:
  - Module-level constants: `SEARCH_DB_PATH = Path.home() / ".config" / "yulu" / "search.sqlite"`, `CORPUS_ROOT = Path.home() / "Movies" / "Yulu"`
  - `_SCHEMA_SQL` containing `docs` (FTS5, trigram), `docs_meta`, `meta` (per spec §4.1)
  - `def init_db(path: Path = SEARCH_DB_PATH) -> sqlite3.Connection` — open, WAL, executescript schema if absent, seed meta.schema_version='1' if absent. Idempotent.
  - `def open_conn(path: Path = SEARCH_DB_PATH) -> sqlite3.Connection` — open + WAL, no schema work
- **Tests**: `tests/test_search_indexer.py`
  - `test_init_db_creates_tables`
  - `test_init_db_is_idempotent`
  - `test_init_db_seeds_schema_version`
  - `test_trigram_tokenizer_available` (creates virtual table, inserts, queries — fails if SQLite < 3.34 or trigram missing)

#### A.2 — `parse_stem` helper
- **Files**: `yulu/scripts/search/indexer.py` (add function), `tests/test_search_parse_stem.py`
- **Code**:
  ```python
  @dataclass(frozen=True)
  class StemInfo:
      meeting_title: str
      recorded_at: str          # ISO-8601 YYYY-MM-DDTHH:MM:SS

  _STEM_RE = re.compile(r"^(?P<title>.+?)_(?P<date>\d{8})_(?P<time>\d{6})$")

  def parse_stem(stem: str) -> StemInfo | None:
      """Parse '<title>_YYYYMMDD_HHMMSS'. Returns None if pattern doesn't match."""
  ```
- **Tests**: meeting title, voicemail literal, slug-tagged-stem (extracted from `.slug.summary.md` separately — slug is part of source_path, not the stem), invalid stems return None

### Phase B — Writer side

#### B.1 — `upsert_doc` + sha256 dedup
- **Files**: `yulu/scripts/search/indexer.py`
- **Code**:
  ```python
  def upsert_doc(*, source_path: Path, kind: str, body: str | None = None,
                 conn: sqlite3.Connection | None = None) -> bool:
      """
      Returns True if the doc was inserted/updated, False if it was already
      indexed with identical content (sha256 match). Optional conn parameter
      lets writers reuse a connection; default opens its own.
      """
  ```
  - Compute sha256 of body (read from disk if body is None)
  - Look up docs_meta.sha256 by source_path; if match → no-op return False
  - Parse stem to extract meeting_title + recorded_at (skip + warn if unparseable)
  - `BEGIN IMMEDIATE` → DELETE existing docs row (if any), INSERT new docs row, UPSERT docs_meta with new sha256/mtime/indexed_at, COMMIT
- **Tests**:
  - `test_upsert_inserts_new_doc`
  - `test_upsert_is_noop_when_unchanged` (sha256 dedup; FTS rowid stable)
  - `test_upsert_replaces_on_change`
  - `test_upsert_skips_unparseable_stem` (returns False, no row inserted)
  - `test_upsert_concurrent_same_file` (two threads upsert same path → one final row, no exception)

#### B.2 — Wire into `agent_queue_worker._handle_summary_request`
- **Files**: `yulu/scripts/agent_queue_worker.py` (edit), `tests/test_agent_queue_worker_search_hook.py` (new)
- **Code**: After successful `output_path.write_text(summary_md, ...)`, call:
  ```python
  try:
      kind = ("voicemail_summary"
              if str(audio_path).find("/voicemails/") >= 0
              else "meeting_summary")
      search.indexer.upsert_doc(source_path=output_path, kind=kind, body=summary_md)
  except Exception as exc:
      log.warning("search index upsert failed for %s: %s", output_path, exc)
  ```
- **Tests**: stub `upsert_doc` (monkeypatch), assert it's called with the right kind + path for both a voicemail and a meeting summary. Failure path: monkeypatch raises → worker still returns success.

#### B.3 — Wire into `voicemail.recorder._transcribe_and_enqueue`
- **Files**: `yulu/scripts/voicemail/recorder.py` (edit), extend existing tests
- **Code**: After `transcript_path.write_text(...)`, call `search.indexer.upsert_doc(source_path=transcript_path, kind="voicemail_transcript", body=text)` with the same try/log/no-raise pattern.
- **Tests**: existing voicemail flow tests gain an assertion on the upsert hook.

#### B.4 — Wire into `transcribe.py`
- **Files**: `yulu/scripts/transcribe.py` (edit), `tests/test_transcribe_search_hook.py`
- **Code**: After meeting `transcript.txt` write, call `upsert_doc(kind="meeting_transcript", ...)` with the same pattern.
- **Tests**: monkeypatch + assert called.

### Phase C — Reader side

#### C.1 — Sweep
- **Files**: `yulu/scripts/search/reader.py`
- **Code**:
  ```python
  def sweep(*, conn: sqlite3.Connection | None = None,
            roots: list[Path] | None = None) -> dict[str, int]:
      """
      Walk corpus roots, upsert changed files, delete absent files.
      Returns counts: {'added': n, 'updated': n, 'removed': n, 'scanned': n}.
      Uses BEGIN IMMEDIATE to serialize concurrent sweepers.
      """
  ```
  - Default `roots = [CORPUS_ROOT, CORPUS_ROOT / "voicemails"]`
  - For each `.transcript.txt` and `.summary.md` (and `.<slug>.summary.md`) matching `parse_stem`:
    - kind = derived from (root, suffix)
    - if mtime > docs_meta.mtime or row absent → upsert_doc
  - After scan: `SELECT source_path FROM docs_meta` minus on-disk set → DELETE rows for absent paths
  - Update `meta.last_full_sweep_at`
- **Tests**:
  - `test_sweep_indexes_new_files`
  - `test_sweep_updates_changed_files` (mtime advance triggers re-upsert)
  - `test_sweep_removes_deleted_files`
  - `test_sweep_skips_unparseable_filenames`
  - `test_sweep_completes_under_250ms_for_38_files` (synth corpus, perf assertion with slack)

#### C.2 — `_fts_search` (trigram path)
- **Files**: `yulu/scripts/search/reader.py`
- **Code**:
  ```python
  @dataclass(frozen=True)
  class SearchHit:
      kind: str; stem: str; meeting_title: str; recorded_at: str
      source_path: str; score: float; snippet: str

  def _fts_search(query: str, *, since: datetime | None,
                  kinds: list[str] | None, limit: int,
                  conn: sqlite3.Connection) -> list[SearchHit]:
  ```
  - Bind kinds via `IN (?, ?, ...)` (validated subset of the 4)
  - Bind `since` against `recorded_at >= ?` (ISO compare works because ISO sorts lexicographically when same length)
  - `bm25(docs)` negated to "higher = better" before returning
  - `snippet(docs, 5, '[hit]', '[/hit]', '...', 16)` for the body column (column index 5 in CREATE)
- **Tests**:
  - `test_fts_search_returns_ranked_hits` (English)
  - `test_fts_search_handles_3char_chinese`
  - `test_fts_search_filters_by_kind`
  - `test_fts_search_filters_by_since`

#### C.3 — `_like_search` (short-query fallback)
- **Files**: `yulu/scripts/search/reader.py`
- **Code**:
  ```python
  def _like_search(query: str, *, since, kinds, limit, conn) -> list[SearchHit]:
  ```
  - Use `body LIKE '%' || ? || '%'`
  - Snippet via `substr(body, max(1, instr(body, ?) - 60), 200)`
  - Order by `recorded_at DESC` (no rank signal)
  - Same kind/since filters as FTS path
- **Tests**:
  - `test_like_search_handles_2char_chinese`
  - `test_like_search_returns_empty_for_nonexistent_term`

#### C.4 — `search()` entry point + telemetry
- **Files**: `yulu/scripts/search/reader.py`, `tests/test_search_reader.py`
- **Code**:
  ```python
  def search(query: str, *, since: timedelta | None = None,
             kinds: list[str] | None = None,
             limit: int = 20) -> tuple[list[SearchHit], dict]:
  ```
  - Open conn, run sweep, measure elapsed_ms
  - Choose path: `len(query.strip()) < 3` → LIKE; else FTS
  - Return (hits, {'sweep_ms', 'query_ms', 'fallback_used', 'hit_count'})
- **Tests**:
  - `test_search_picks_fts_for_3char_query`
  - `test_search_picks_like_for_2char_query`
  - `test_search_validates_kinds` (rejects unknown kind)
  - `test_search_clamps_limit_to_100`
  - `test_search_returns_telemetry`

### Phase D — CLI

#### D.1 — `yulu search` argparse + IPC client + in-process fallback
- **Files**: `yulu/scripts/search/cli.py`, `tests/test_search_cli.py`
- **Code**:
  - argparse: positional `query`, flags `--since`, `--type`, `--in`, `--limit`, `--json`, `--open`, `--doctor`, `--reindex`, `--verbose`
  - `--since 7d / 24h / 2w / 30m` parsed by tiny human-duration helper
  - `--type {voicemail,meeting,all}` and `--in {summary,transcript,both}` combine to a `kinds` list
  - Connection: try IPC `{"action":"search", ...}` to `status_agent.sock`; on FileNotFoundError / ConnectionRefused → in-process `from search.reader import search; search(...)`
  - Render: TTY-aware ANSI for `[hit]...[/hit]`, plain text otherwise. `--json` → `json.dumps({"hits":..., "telemetry":...})`
- **Tests**:
  - `test_cli_query_round_trips_via_ipc_when_agent_running` (fake IPC server fixture from Phase 5 tests, reused)
  - `test_cli_falls_back_to_in_process_when_agent_down`
  - `test_cli_parses_since_7d_24h_2w`
  - `test_cli_open_runs_macos_open_on_top_hit` (monkeypatch subprocess.run)
  - `test_cli_json_output_is_valid_json`
  - `test_cli_doctor_prints_row_counts`
  - `test_cli_reindex_calls_reindex_path`

#### D.2 — `--reindex` and `--doctor` plumbing
- **Files**: `yulu/scripts/search/reader.py` (add `reindex()`), `yulu/scripts/search/cli.py`
- **Code**:
  - `reindex()` = `DROP TABLE docs; DROP TABLE docs_meta; init_db(); sweep()`
  - `doctor()` = open conn, return `{schema_version, total_docs, per_kind: {...}, last_full_sweep_at, db_size_bytes, integrity_ok}`
- **Tests**: `test_reindex_rebuilds_from_scratch`, `test_doctor_returns_health_dict`

#### D.3 — Shell wrapper dispatch
- **Files**: `yulu/scripts/yulu` (shell wrapper, add `search) shift; PYTHONPATH=... exec python3 -m search.cli "$@" ;;`)
- **Tests**: `test_yulu_wrapper_dispatches_search` (subprocess invocation)

### Phase E — IPC

#### E.1 — Add `"search"` action to `status_agent.swift` IPCServer
- **Files**: `yulu/scripts/status_agent.swift`
- **Code**: New case in `handle()`:
  ```swift
  case "search":
      // Pass the request JSON to a Python helper, return its JSON output.
      // Same pattern as loadRecentVoicemails — keeps all search logic in Python.
      sendJSON(c, runSearchHelper(payload: obj))
  ```
  - `runSearchHelper` spawns `python3 -m search.ipc_helper`, pipes request JSON to stdin, reads response JSON from stdout, returns it
  - Bounded timeout (3 s); on timeout return `{"ok": false, "error": "search timeout"}`
- New file `yulu/scripts/search/ipc_helper.py`:
  ```python
  # Read one JSON object from stdin, validate against schema, call
  # search.reader.search(), write one JSON object to stdout.
  ```
- **Tests**: `tests/test_search_ipc_helper.py` (stdin→stdout round-trip without spawning Swift)

#### E.2 — End-to-end IPC test (manual smoke documented, no pytest)
- Document in `tests/test_search_ipc_smoke.md` how to run:
  1. Build StatusAgent.app (build_status_agent.sh)
  2. `yulu search "OKR"` → goes through IPC
  3. `pkill StatusAgent` → `yulu search "OKR"` → falls back to in-process
  - Both should return identical hits.

### Phase F — Install / Doctor / Setup

#### F.1 — `setup.sh` adds search init
- **Files**: `yulu/scripts/setup.sh` (or equivalent install path — confirm in code first)
- **Code**: `python3 -m search.indexer init` after the prompts/vocab seed steps
- **Tests**: `test_setup_initializes_search_db` (subprocess `bash setup.sh`, assert search.sqlite exists with schema_version='1')

#### F.2 — `yulu doctor` integration
- **Files**: `yulu/scripts/doctor.py` (edit)
- **Code**: Add `_check_search_index()` that returns `{name: 'search_index', status: 'ok'/'warn'/'error', detail: <doctor() dict>}`
- **Tests**: extend existing doctor tests with a search-index check

### Phase G — Verification

#### G.1 — Spec acceptance tests
- **Files**: `tests/test_spec_acceptance.py` (extend existing)
- **Code**: Add 18 tests, one per spec §9 criterion, named `test_phase6_<n>_<short_name>`
- All must pass.

#### G.2 — Full regression run
- `python3 -m pytest tests/ -q` should be **all passing** (300+ tests baseline + ~50 new).

#### G.3 — Real-machine smoke (deferred)
- After install: index 38 existing files, search 3 known terms (English, 3-char Chinese, 2-char Chinese), measure end-to-end latency.

## Dependency graph

```
A.1 ──┬── A.2 ──┬── B.1 ──┬── B.2
      │         │         ├── B.3
      │         │         └── B.4
      │         └── C.1 ──┬── C.2
      │                   ├── C.3
      │                   └── C.4 ──┬── D.1 ── D.2 ── D.3
      │                             └── E.1 ── E.2
      │                                        └── F.1 ── F.2
      │                                                   └── G.1 ── G.2 ── G.3
```

Most tasks parallelize within a phase. Suggested execution order: A → B (parallel: B.2/B.3/B.4) → C (sequential: C.1 → C.2/C.3 parallel → C.4) → D (sequential within) → E (sequential within) → F → G.

## Goal-backward check

The spec's primary user-facing promises (§2 Goals):

| Goal | Tasks that deliver it |
|---|---|
| `yulu search "OKR"` returns ranked hits across all corpora | C.2, C.4, D.1, D.3 |
| Filters by `--since`/`--type`/`--in` | C.2, C.3, D.1 |
| IPC search action on status_agent.sock | E.1, E.2 |
| Self-maintaining index (push + sweep) | B.1–B.4, C.1 |
| Chinese-friendly (≥3-char FTS, ≤2-char LIKE) | C.2, C.3, C.4 |
| Zero new daemons | (architectural — no plist task) |
| Doctor-checkable | D.2 (`doctor()`), F.2 |

All goals are accounted for. No orphan tasks; no missing tasks.

## Risks during execution

1. **`yulu` shell wrapper layout**: confirm before D.3 — different repos use different dispatchers (case statement vs python entry-point). Read `yulu/scripts/yulu` first.
2. **`transcribe.py` write path** may differ from voicemail/agent_queue patterns. B.4 task starts with a 5-minute read of `transcribe.py` to confirm exact hook location.
3. **Performance perf-test in C.1** (`test_sweep_completes_under_250ms_for_38_files`) can be flaky on slow CI. Use a generous slack (500ms) and skip with `@pytest.mark.slow` if it bites.
4. **Status agent rebuild**: E.1 changes Swift. Executor must `bash yulu/scripts/build_status_agent.sh` and copy to main worktree before smoke, repeating the Phase 5 install dance.
