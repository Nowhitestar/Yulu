"""SQLite-backed repository for custom vocabulary words."""

from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional


SCHEMA_VERSION = "1"


class Scope(str, Enum):
    PROMPT = "prompt"
    REPLACE = "replace"
    BOTH = "both"


class Source(str, Enum):
    SEED = "seed"
    MANUAL = "manual"
    LEARNED = "learned"


@dataclass(frozen=True)
class CustomWord:
    id: str
    term: str
    canonical: str
    scope: Scope
    source: Source
    enabled: bool
    note: Optional[str]
    created_at: str
    updated_at: str


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS custom_words (
    id          TEXT PRIMARY KEY,
    term        TEXT NOT NULL,
    canonical   TEXT NOT NULL,
    scope       TEXT NOT NULL CHECK(scope IN ('prompt', 'replace', 'both')),
    source      TEXT NOT NULL DEFAULT 'manual'
                CHECK(source IN ('seed', 'manual', 'learned')),
    enabled     INTEGER NOT NULL DEFAULT 1,
    note        TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_words_enabled_scope ON custom_words(enabled, scope);
CREATE INDEX IF NOT EXISTS idx_custom_words_canonical ON custom_words(canonical);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def open_db(path: Path) -> sqlite3.Connection:
    """Open a sqlite connection in WAL mode and ensure schema is current."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=2.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=2000")
    conn.executescript(_SCHEMA_SQL)
    conn.execute(
        "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)",
        (SCHEMA_VERSION,),
    )
    _migrate_legacy_vocab(conn)
    conn.commit()
    return conn


def _migrate_legacy_vocab(conn: sqlite3.Connection) -> None:
    table = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='vocab'"
    ).fetchone()
    if table is None:
        return
    try:
        rows = conn.execute(
            "SELECT term, pinyin, notes, created_at, updated_at FROM vocab"
        ).fetchall()
    except sqlite3.Error:
        return
    for row in rows:
        term = str(row["term"] or "").strip()
        if not term:
            continue
        exists = conn.execute(
            "SELECT 1 FROM custom_words WHERE term=? AND canonical=? LIMIT 1",
            (term, term),
        ).fetchone()
        if exists:
            continue
        note_parts = []
        if row["notes"]:
            note_parts.append(str(row["notes"]))
        if row["pinyin"]:
            note_parts.append(f"pinyin: {row['pinyin']}")
        conn.execute(
            """
            INSERT INTO custom_words(id, term, canonical, scope, source, enabled, note, created_at, updated_at)
            VALUES (?, ?, ?, 'both', 'manual', 1, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                term,
                term,
                "\n".join(note_parts) or None,
                row["created_at"] or _now_iso(),
                row["updated_at"] or _now_iso(),
            ),
        )


def _row_to_word(row: sqlite3.Row) -> CustomWord:
    return CustomWord(
        id=row["id"],
        term=row["term"],
        canonical=row["canonical"],
        scope=Scope(row["scope"]),
        source=Source(row["source"]),
        enabled=bool(row["enabled"]),
        note=row["note"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class VocabRepo:
    """Synchronous repository over the custom_words table."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def add(
        self,
        term: str,
        canonical: str,
        scope: Scope,
        source: Source = Source.MANUAL,
        enabled: bool = True,
        note: Optional[str] = None,
    ) -> str:
        if not term or not canonical:
            raise ValueError("term and canonical are required")
        word_id = str(uuid.uuid4())
        now = _now_iso()
        self.conn.execute(
            """
            INSERT INTO custom_words(id, term, canonical, scope, source, enabled, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (word_id, term, canonical, scope.value, source.value, 1 if enabled else 0, note, now, now),
        )
        self.conn.commit()
        return word_id

    def get(self, word_id: str) -> Optional[CustomWord]:
        row = self.conn.execute(
            "SELECT * FROM custom_words WHERE id = ?", (word_id,)
        ).fetchone()
        return _row_to_word(row) if row else None

    def list_words(
        self,
        *,
        scope: Optional[Scope] = None,
        scopes: Optional[list[Scope]] = None,
        enabled_only: bool = False,
    ) -> list[CustomWord]:
        sql = "SELECT * FROM custom_words"
        clauses, params = [], []
        if scope is not None:
            clauses.append("scope = ?")
            params.append(scope.value)
        elif scopes:
            placeholders = ",".join("?" for _ in scopes)
            clauses.append(f"scope IN ({placeholders})")
            params.extend(s.value for s in scopes)
        if enabled_only:
            clauses.append("enabled = 1")
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY length(term) DESC, term ASC"
        return [_row_to_word(r) for r in self.conn.execute(sql, params).fetchall()]

    def edit(
        self,
        word_id: str,
        *,
        term: Optional[str] = None,
        canonical: Optional[str] = None,
        scope: Optional[Scope] = None,
        note: Optional[str] = None,
    ) -> bool:
        existing = self.get(word_id)
        if not existing:
            return False
        new_term = term if term is not None else existing.term
        new_canonical = canonical if canonical is not None else existing.canonical
        new_scope = scope.value if scope is not None else existing.scope.value
        new_note = note if note is not None else existing.note
        self.conn.execute(
            """
            UPDATE custom_words
            SET term=?, canonical=?, scope=?, note=?, updated_at=?
            WHERE id=?
            """,
            (new_term, new_canonical, new_scope, new_note, _now_iso(), word_id),
        )
        self.conn.commit()
        return True

    def set_enabled(self, word_id: str, enabled: bool) -> bool:
        cur = self.conn.execute(
            "UPDATE custom_words SET enabled=?, updated_at=? WHERE id=?",
            (1 if enabled else 0, _now_iso(), word_id),
        )
        self.conn.commit()
        return cur.rowcount > 0

    def remove(self, word_id: str) -> bool:
        cur = self.conn.execute("DELETE FROM custom_words WHERE id=?", (word_id,))
        self.conn.commit()
        return cur.rowcount > 0

    def get_meta(self, key: str) -> Optional[str]:
        row = self.conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        self.conn.commit()

    def count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM custom_words").fetchone()[0]
