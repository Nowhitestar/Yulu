"""SQLite FTS5 index for global search.

Schema (per spec §4.1):
  - docs (FTS5 virtual table, trigram tokenizer) — the searchable body + metadata
  - docs_meta — (source_path → rowid_in_docs, mtime, sha256, indexed_at)
  - meta — (key/value) for schema_version, last_full_sweep_at, corpus_root

This module is the single source of truth for:
  - parse_stem()    — '<title>_YYYYMMDD_HHMMSS' parsing
  - upsert_doc()    — writer-side push (idempotent via sha256 dedup)
  - init_db()       — schema bootstrap
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


log = logging.getLogger(__name__)

SCHEMA_VERSION = "1"


# Phase 5 DATA-01/DATA-02 — resolve the runtime (locked) and content (configurable)
# roots through PathResolver instead of bare literals. Both helpers lazily +
# guardedly import MacOSPathResolver (mirroring capabilities.probes.probe_recording_dir)
# so this module still imports off-Darwin / before the resolver is available, degrading
# to the historical literals. Existing-file migration at the old root is Phase 7 (D-08).
def _resolve_runtime_dir() -> Path:
    """Locked machine-local runtime root (== ~/.config/yulu); never synced (D-01)."""
    try:
        from yulu_platform.macos.path_resolver import MacOSPathResolver

        return MacOSPathResolver().runtime_dir()
    except Exception:
        return Path.home() / ".config" / "yulu"


def _resolve_data_dir() -> Path:
    """Configurable content root — follows data_dir() (audio.output_dir)."""
    try:
        from yulu_platform.macos.path_resolver import MacOSPathResolver

        return MacOSPathResolver().data_dir()
    except Exception:
        return Path.home() / "Movies" / "Yulu"


# SEARCH_DB_PATH is RUNTIME (WAL-mode SQLite) — stays machine-local via runtime_dir().
SEARCH_DB_PATH = _resolve_runtime_dir() / "search.sqlite"
# CORPUS_ROOT is CONTENT — follows the configurable data_dir().
CORPUS_ROOT = _resolve_data_dir()

KIND_MEETING_SUMMARY = "meeting_summary"
KIND_MEETING_TRANSCRIPT = "meeting_transcript"
KIND_VOICEMAIL_SUMMARY = "voicemail_summary"
KIND_VOICEMAIL_TRANSCRIPT = "voicemail_transcript"
VALID_KINDS = frozenset({
    KIND_MEETING_SUMMARY,
    KIND_MEETING_TRANSCRIPT,
    KIND_VOICEMAIL_SUMMARY,
    KIND_VOICEMAIL_TRANSCRIPT,
})


_SCHEMA_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
    kind UNINDEXED,
    stem UNINDEXED,
    meeting_title UNINDEXED,
    recorded_at UNINDEXED,
    source_path UNINDEXED,
    body,
    tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS docs_meta (
    source_path TEXT PRIMARY KEY,
    rowid_in_docs INTEGER NOT NULL,
    mtime REAL NOT NULL,
    sha256 TEXT NOT NULL,
    indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_meta_mtime ON docs_meta(mtime);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


@dataclass(frozen=True)
class StemInfo:
    """Parsed `<title>_YYYYMMDD_HHMMSS` stem."""
    meeting_title: str
    recorded_at: str  # ISO-8601 YYYY-MM-DDTHH:MM:SS (no timezone)


_STEM_RE = re.compile(r"^(?P<title>.+?)_(?P<date>\d{8})_(?P<time>\d{6})$")


def parse_stem(stem: str) -> Optional[StemInfo]:
    """Parse '<title>_YYYYMMDD_HHMMSS'. Return None on no match.

    The stem is the filename without any `.transcript.txt` / `.summary.md` /
    `.<slug>.summary.md` suffix. Slug-tagged variants drop the slug + suffix
    before calling this. The title is allowed to contain underscores; the
    last two `_<8 digits>_<6 digits>` segments are the date + time anchor.
    """
    m = _STEM_RE.match(stem)
    if not m:
        return None
    date = m.group("date")
    time_ = m.group("time")
    try:
        # Reject impossible dates / times early (e.g. 99999999_999999).
        dt = datetime.strptime(date + time_, "%Y%m%d%H%M%S")
    except ValueError:
        return None
    return StemInfo(
        meeting_title=m.group("title"),
        recorded_at=dt.strftime("%Y-%m-%dT%H:%M:%S"),
    )


def _stem_from_source_path(source_path: Path) -> str:
    """Derive the canonical stem from a source file path.

    Handles both `.transcript.txt` and `.summary.md` (and `.<slug>.summary.md`)
    by stripping the recognised suffix(es). Anything else returns the bare
    stem (Path.stem) — parse_stem will then return None for non-matching
    filenames, which the caller treats as 'skip this file'.
    """
    name = source_path.name
    # Order matters: longer suffixes first.
    for suffix in (".transcript.txt", ".raw.transcript.txt",
                   ".mic.transcript.txt", ".sys.transcript.txt",
                   ".realtime.transcript.txt"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    if name.endswith(".summary.md"):
        # Trim trailing '.summary.md'
        core = name[: -len(".summary.md")]
        # If there's a slug-tag (e.g. 'stem.action-items'), drop it so the
        # underlying stem still parses cleanly.
        if "." in core:
            stem_candidate, _slug = core.rsplit(".", 1)
            # Only treat as slug-tagged if the stem candidate parses.
            if parse_stem(stem_candidate) is not None:
                return stem_candidate
        return core
    # Fallback: bare suffix stripping (Path.stem strips only the last .ext).
    return source_path.stem


def _now_iso() -> str:
    return (datetime.now(timezone.utc)
            .isoformat(timespec="seconds").replace("+00:00", "Z"))


def open_conn(path: Path = SEARCH_DB_PATH) -> sqlite3.Connection:
    """Open a WAL-mode SQLite connection. Does NOT create schema."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=5.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_db(path: Path = SEARCH_DB_PATH) -> sqlite3.Connection:
    """Open + ensure schema. Idempotent.

    Returns a WAL-mode connection with row_factory=sqlite3.Row.
    Seeds meta.schema_version=SCHEMA_VERSION on first init.
    """
    conn = open_conn(path)
    conn.executescript(_SCHEMA_SQL)
    conn.execute(
        "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)",
        (SCHEMA_VERSION,),
    )
    return conn


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def upsert_doc(
    *,
    source_path: Path,
    kind: str,
    body: Optional[str] = None,
    conn: Optional[sqlite3.Connection] = None,
) -> bool:
    """Upsert one document into the search index.

    Returns True if the row was inserted or replaced; False if the existing
    indexed content was byte-identical (sha256 match) so nothing changed.

    - If `body` is None we read it from `source_path` (UTF-8).
    - Stem parsing failure → False, no row written (debug-logged).
    - Concurrency: BEGIN IMMEDIATE wraps the DELETE+INSERT+UPSERT so two
      writers racing on the same file produce exactly one row.
    """
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown kind: {kind!r}")

    source_path = Path(source_path)
    stem = _stem_from_source_path(source_path)
    info = parse_stem(stem)
    if info is None:
        log.debug("skipping unparseable stem: %s", source_path)
        return False

    if body is None:
        try:
            body = source_path.read_text(encoding="utf-8")
        except OSError as exc:
            log.warning("upsert_doc: read failed for %s: %s", source_path, exc)
            return False

    sha = _sha256_text(body)
    try:
        st = source_path.stat()
        mtime = st.st_mtime
    except OSError:
        # File may have been removed between read and stat; use 'now' as a
        # conservative mtime so the sweep can still reconcile later.
        mtime = datetime.now().timestamp()

    own_conn = conn is None
    if own_conn:
        conn = init_db()

    try:
        with conn:  # BEGIN ... COMMIT/ROLLBACK
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT rowid_in_docs, sha256 FROM docs_meta WHERE source_path=?",
                (str(source_path),),
            ).fetchone()
            if row is not None and row["sha256"] == sha:
                # Touch mtime + indexed_at so sweep doesn't re-read this file.
                conn.execute(
                    "UPDATE docs_meta SET mtime=?, indexed_at=? WHERE source_path=?",
                    (mtime, _now_iso(), str(source_path)),
                )
                return False

            if row is not None:
                conn.execute(
                    "DELETE FROM docs WHERE rowid=?", (row["rowid_in_docs"],)
                )

            cur = conn.execute(
                """
                INSERT INTO docs(kind, stem, meeting_title, recorded_at,
                                 source_path, body)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (kind, stem, info.meeting_title, info.recorded_at,
                 str(source_path), body),
            )
            new_rowid = cur.lastrowid
            conn.execute(
                """
                INSERT INTO docs_meta(source_path, rowid_in_docs, mtime,
                                       sha256, indexed_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(source_path) DO UPDATE SET
                    rowid_in_docs=excluded.rowid_in_docs,
                    mtime=excluded.mtime,
                    sha256=excluded.sha256,
                    indexed_at=excluded.indexed_at
                """,
                (str(source_path), new_rowid, mtime, sha, _now_iso()),
            )
            return True
    finally:
        if own_conn:
            conn.close()


def _cli_init(argv: Optional[list[str]] = None) -> int:
    """`python3 -m search.indexer init` — used by setup.sh."""
    import sys
    args = list(argv if argv is not None else sys.argv[1:])
    if not args or args[0] != "init":
        print("usage: python3 -m search.indexer init", file=sys.stderr)
        return 2
    conn = init_db()
    version = conn.execute(
        "SELECT value FROM meta WHERE key='schema_version'"
    ).fetchone()[0]
    print(f"search index ready at {SEARCH_DB_PATH} (schema v{version})")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli_init())
