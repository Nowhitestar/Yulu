"""Search reader: sweep + query.

`search(query, ...)` is the single shared entry point used by both the
`yulu search` CLI and the status_agent IPC server. It:

  1. Runs a cheap mtime sweep over ~/Movies/Yulu/ to pick up out-of-band
     file changes (writer-hook misses, manual edits, deletions).
  2. Routes the query to FTS5 trigram (queries ≥ 3 chars) or LIKE (1-2
     chars), per spec §6.2.
  3. Returns hits + telemetry so the CLI can show timing and the doctor
     can spot regressions.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterable, Optional

from search.indexer import (
    CORPUS_ROOT,
    KIND_MEETING_SUMMARY,
    KIND_MEETING_TRANSCRIPT,
    SEARCH_DB_PATH,
    VALID_KINDS,
    _now_iso,
    _stem_from_source_path,
    init_db,
    parse_stem,
    upsert_doc,
)
from search.roots import content_roots, root_registry_report

log = logging.getLogger(__name__)

# Hard cap on `limit` per spec §7.1 (IPC schema).
MAX_LIMIT = 100

_QUERY_TERM_RE = re.compile(r"[^\W_]+", re.UNICODE)
_LOW_SIGNAL_QUERY_TERMS = frozenset({
    "about", "across", "after", "again", "against", "all", "also", "and",
    "any", "are", "before", "between", "both", "but", "can", "could", "did",
    "discuss", "discussed", "does", "each", "for", "from", "had", "has", "have",
    "how", "into", "its", "made", "meeting", "meetings", "near", "not", "our",
    "ours", "please", "regarding", "should", "tell", "than",
    "that", "the", "their", "them", "then", "there", "these", "they", "this",
    "those", "through", "was", "were", "what", "when", "where", "which", "who",
    "why", "will", "with", "would", "you", "your",
})

# File-suffix → indexable? The sweep only walks .transcript.txt and
# .summary.md (and slug-tagged variants). Realtime / raw / per-channel
# transcripts are intentionally excluded (spec §3, non-goal #1).
_INDEXABLE_TRANSCRIPT_SUFFIX = ".transcript.txt"
_INDEXABLE_SUMMARY_SUFFIX = ".summary.md"
_EXCLUDE_INFIXES = (
    ".raw.transcript.txt",
    ".realtime.transcript.txt",
    ".mic.transcript.txt",
    ".sys.transcript.txt",
)


@dataclass(frozen=True)
class SearchHit:
    kind: str
    stem: str
    meeting_title: str
    recorded_at: str  # ISO-8601
    source_path: str
    score: float      # higher = better (bm25 negated for FTS path; 0.0 for LIKE)
    snippet: str

    def to_dict(self) -> dict:
        return asdict(self)


# ── Sweep ─────────────────────────────────────────────────────────────

def _iter_indexable_files(roots: Iterable[Path]) -> Iterable[tuple[Path, str]]:
    """Yield (path, kind) for every file under `roots` that we know how
    to index. Excludes intermediate / per-channel transcripts."""
    for root in roots:
        if not root.exists():
            continue
        # Depth 1 only: every recording is a meeting and lives in the single
        # recordings root (the voicemails/ subdir was merged away).
        for entry in root.iterdir():
            if not entry.is_file():
                continue
            name = entry.name
            if any(name.endswith(infix) for infix in _EXCLUDE_INFIXES):
                continue
            if name.endswith(_INDEXABLE_TRANSCRIPT_SUFFIX):
                kind = KIND_MEETING_TRANSCRIPT
            elif name.endswith(_INDEXABLE_SUMMARY_SUFFIX):
                kind = KIND_MEETING_SUMMARY
            else:
                continue
            if parse_stem(_stem_from_source_path(entry)) is None:
                continue
            yield entry, kind


def sweep(
    *,
    conn: Optional[sqlite3.Connection] = None,
    roots: Optional[list[Path]] = None,
) -> dict[str, int]:
    """Reconcile docs/docs_meta with the filesystem.

    Returns counts {'scanned', 'added', 'updated', 'removed'}.
    """
    own_conn = conn is None
    if own_conn:
        conn = init_db()
    if roots is None:
        roots = content_roots(fallback_root=CORPUS_ROOT)

    counts = {"scanned": 0, "added": 0, "updated": 0, "removed": 0}
    seen_paths: set[str] = set()

    try:
        for path, kind in _iter_indexable_files(roots):
            counts["scanned"] += 1
            seen_paths.add(str(path))
            try:
                st = path.stat()
            except OSError:
                continue
            row = conn.execute(
                "SELECT mtime FROM docs_meta WHERE source_path=?", (str(path),)
            ).fetchone()
            if row is None:
                if upsert_doc(source_path=path, kind=kind, conn=conn):
                    counts["added"] += 1
            elif st.st_mtime > float(row["mtime"]):
                if upsert_doc(source_path=path, kind=kind, conn=conn):
                    counts["updated"] += 1

        # Reconcile deletions: rows in docs_meta whose path is gone.
        existing = conn.execute(
            "SELECT source_path, rowid_in_docs FROM docs_meta"
        ).fetchall()
        for row in existing:
            sp = row["source_path"]
            if sp in seen_paths:
                continue
            if not Path(sp).exists():
                conn.execute("DELETE FROM docs WHERE rowid=?",
                             (row["rowid_in_docs"],))
                conn.execute("DELETE FROM docs_meta WHERE source_path=?",
                             (sp,))
                counts["removed"] += 1

        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('last_full_sweep_at', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (_now_iso(),),
        )
        return counts
    finally:
        if own_conn:
            conn.close()


# ── Query ─────────────────────────────────────────────────────────────

def _kinds_clause(kinds: Optional[list[str]]) -> tuple[str, list]:
    if not kinds:
        return "", []
    bad = [k for k in kinds if k not in VALID_KINDS]
    if bad:
        raise ValueError(f"unknown kinds: {bad}")
    placeholders = ", ".join("?" for _ in kinds)
    return f" AND kind IN ({placeholders})", list(kinds)


def _since_clause(since: Optional[timedelta]) -> tuple[str, list]:
    if since is None:
        return "", []
    cutoff = datetime.now() - since
    return " AND recorded_at >= ?", [cutoff.strftime("%Y-%m-%dT%H:%M:%S")]


def _quote_fts_literal(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def _literal_fts_query(query: str, conn: sqlite3.Connection) -> str:
    """Compile user text into a literal FTS5 expression.

    Search inputs are plain language, not FTS syntax. Quoting each indexable
    term prevents punctuation, quotes, and words such as AND/OR/NOT from being
    executed as operators. A corpus-supported anchor must also match another
    informative term, so unrelated private meetings do not enter the bounded
    conversation payload merely because they mention one generic topic word.
    """
    literal_tokens = _QUERY_TERM_RE.findall(query)
    terms: list[str] = []
    seen: set[str] = set()
    for term in literal_tokens:
        if len(term) < 3:
            continue
        key = term.casefold()
        if key in _LOW_SIGNAL_QUERY_TERMS or key in seen:
            continue
        seen.add(key)
        terms.append(term)
    if not terms:
        literal_phrase = " ".join(literal_tokens) or query
        return _quote_fts_literal(literal_phrase)

    positive_terms: list[tuple[int, str, int]] = []
    for index, term in enumerate(terms):
        literal = _quote_fts_literal(term)
        count = int(conn.execute(
            "SELECT COUNT(*) FROM docs WHERE docs MATCH ?", (literal,),
        ).fetchone()[0])
        if count > 0:
            positive_terms.append((index, term, count))
    if not positive_terms:
        return _quote_fts_literal(" ".join(terms))

    shared_terms = [entry for entry in positive_terms if entry[2] >= 2]
    anchor = min(
        shared_terms or positive_terms,
        key=lambda entry: (entry[2], -len(entry[1]), entry[1].casefold()),
    )
    anchor_literal = _quote_fts_literal(anchor[1])
    companions = [
        _quote_fts_literal(term)
        for index, term, _count in positive_terms
        if index != anchor[0]
    ]
    if not companions:
        return anchor_literal
    return f"{anchor_literal} AND ({' OR '.join(companions)})"


def _fts_search(
    query: str,
    *,
    since: Optional[timedelta],
    kinds: Optional[list[str]],
    limit: int,
    conn: sqlite3.Connection,
) -> list[SearchHit]:
    """Trigram-tokenized FTS5 search. bm25 is "lower = better"; we
    negate it before returning so SearchHit.score follows the
    "higher = better" convention documented in the spec."""
    k_sql, k_params = _kinds_clause(kinds)
    s_sql, s_params = _since_clause(since)
    sql = f"""
        SELECT kind, stem, meeting_title, recorded_at, source_path,
               bm25(docs) AS score,
               snippet(docs, 5, '[hit]', '[/hit]', '...', 16) AS snippet
        FROM docs
        WHERE docs MATCH ?
              {k_sql}{s_sql}
        ORDER BY bm25(docs)
        LIMIT ?
    """
    params = [_literal_fts_query(query, conn), *k_params, *s_params, limit]
    rows = conn.execute(sql, params).fetchall()
    return [
        SearchHit(
            kind=r["kind"], stem=r["stem"],
            meeting_title=r["meeting_title"],
            recorded_at=r["recorded_at"],
            source_path=r["source_path"],
            score=-float(r["score"]),  # negate: higher = better
            snippet=r["snippet"],
        )
        for r in rows
    ]


def _like_search(
    query: str,
    *,
    since: Optional[timedelta],
    kinds: Optional[list[str]],
    limit: int,
    conn: sqlite3.Connection,
) -> list[SearchHit]:
    """Fallback for queries the trigram tokenizer can't handle
    (length < 3). No rank signal, so we sort by recorded_at desc.

    Snippet: 200-char window centred-ish on the first hit position
    (offset back 60 chars to give some lead-in context)."""
    k_sql, k_params = _kinds_clause(kinds)
    s_sql, s_params = _since_clause(since)
    pattern = f"%{query}%"
    sql = f"""
        SELECT kind, stem, meeting_title, recorded_at, source_path,
               0.0 AS score,
               substr(body, max(1, instr(body, ?) - 60), 200) AS snippet
        FROM docs
        WHERE body LIKE ?
              {k_sql}{s_sql}
        ORDER BY recorded_at DESC
        LIMIT ?
    """
    params = [query, pattern, *k_params, *s_params, limit]
    rows = conn.execute(sql, params).fetchall()
    return [
        SearchHit(
            kind=r["kind"], stem=r["stem"],
            meeting_title=r["meeting_title"],
            recorded_at=r["recorded_at"],
            source_path=r["source_path"],
            score=0.0,
            snippet=r["snippet"],
        )
        for r in rows
    ]


def _should_use_like(query: str) -> bool:
    """Trigram tokenizer needs ≥ 3 chars of *indexable* content. We use
    a simple length check; 1-2 char queries (esp. CJK like '进度') go
    through LIKE so they don't silently zero-result."""
    return len(query) < 3


def search(
    query: str,
    *,
    since: Optional[timedelta] = None,
    kinds: Optional[list[str]] = None,
    limit: int = 20,
    db_path: Path = SEARCH_DB_PATH,
) -> tuple[list[SearchHit], dict]:
    """Single search entry point used by CLI and IPC.

    Telemetry dict: {sweep_ms, query_ms, fallback_used, hit_count}.
    """
    if not isinstance(query, str) or not query.strip():
        return [], {
            "sweep_ms": 0, "query_ms": 0,
            "fallback_used": False, "hit_count": 0,
        }
    query = query.strip()
    limit = max(1, min(int(limit), MAX_LIMIT))
    # Validate kinds early so a typo doesn't silently expand to "everything".
    if kinds is not None:
        bad = [k for k in kinds if k not in VALID_KINDS]
        if bad:
            raise ValueError(f"unknown kinds: {bad}")

    conn = init_db(db_path)
    try:
        t0 = time.monotonic()
        sweep(conn=conn)
        sweep_ms = int((time.monotonic() - t0) * 1000)

        use_like = _should_use_like(query)
        t1 = time.monotonic()
        if use_like:
            hits = _like_search(query, since=since, kinds=kinds,
                                limit=limit, conn=conn)
        else:
            hits = _fts_search(query, since=since, kinds=kinds,
                               limit=limit, conn=conn)
        query_ms = int((time.monotonic() - t1) * 1000)
    finally:
        conn.close()

    return hits, {
        "sweep_ms": sweep_ms,
        "query_ms": query_ms,
        "fallback_used": use_like,
        "hit_count": len(hits),
    }


# ── Reindex + doctor ──────────────────────────────────────────────────

def reindex(db_path: Path = SEARCH_DB_PATH) -> dict[str, int]:
    """Drop docs + docs_meta and rebuild from disk.

    Returns the sweep counts. Schema (incl. meta + schema_version) is
    preserved, so we don't lose telemetry / version state across rebuilds.
    """
    conn = init_db(db_path)
    try:
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM docs")
            conn.execute("DELETE FROM docs_meta")
        return sweep(conn=conn)
    finally:
        conn.close()


def doctor(db_path: Path = SEARCH_DB_PATH) -> dict:
    """Health dict for `yulu search --doctor` and `yulu doctor`."""
    conn = init_db(db_path)
    try:
        schema_version = conn.execute(
            "SELECT value FROM meta WHERE key='schema_version'"
        ).fetchone()
        last_sweep = conn.execute(
            "SELECT value FROM meta WHERE key='last_full_sweep_at'"
        ).fetchone()
        total = conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
        per_kind_rows = conn.execute(
            "SELECT kind, COUNT(*) AS n FROM docs GROUP BY kind"
        ).fetchall()
        per_kind = {r["kind"]: int(r["n"]) for r in per_kind_rows}
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        size_bytes = 0
        try:
            size_bytes = Path(db_path).stat().st_size
        except OSError:
            pass
        return {
            "schema_version": schema_version[0] if schema_version else None,
            "last_full_sweep_at": last_sweep[0] if last_sweep else None,
            "total_docs": int(total),
            "per_kind": per_kind,
            "db_size_bytes": size_bytes,
            "integrity_ok": integrity == "ok",
            "db_path": str(db_path),
            "root_registry": root_registry_report(fallback_root=CORPUS_ROOT),
        }
    finally:
        conn.close()
