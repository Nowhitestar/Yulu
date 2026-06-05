"""SQLite-backed repositories for the Prompt Library + Summaries provenance."""

from __future__ import annotations

import re
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional


SCHEMA_VERSION = "1"


class Category(str, Enum):
    SUMMARY = "summary"
    CLEANUP = "cleanup"


class Source(str, Enum):
    SEED = "seed"
    MANUAL = "manual"
    LEARNED = "learned"


class SummaryStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"


@dataclass(frozen=True)
class Prompt:
    id: str
    slug: str
    name: str
    category: Category
    content: str
    is_auto_run: bool
    source: Source
    sort_order: int
    note: Optional[str]
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class Summary:
    id: str
    audio_path: str
    prompt_id: str
    prompt_slug: str
    prompt_name: str
    prompt_content: str
    output_path: str
    html_path: Optional[str]
    model: Optional[str]
    status: SummaryStatus
    error: Optional[str]
    duration_ms: Optional[int]
    word_count: Optional[int]
    created_at: str
    completed_at: Optional[str]


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('summary', 'cleanup')),
    content TEXT NOT NULL,
    is_auto_run INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual'
        CHECK(source IN ('seed', 'manual', 'learned')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompts_category_autorun
    ON prompts(category, is_auto_run);

CREATE TABLE IF NOT EXISTS summaries (
    id TEXT PRIMARY KEY,
    audio_path TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    prompt_slug TEXT NOT NULL,
    prompt_name TEXT NOT NULL,
    prompt_content TEXT NOT NULL,
    output_path TEXT NOT NULL,
    html_path TEXT,
    model TEXT,
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'done', 'error')),
    error TEXT,
    duration_ms INTEGER,
    word_count INTEGER,
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_summaries_audio ON summaries(audio_path);
CREATE INDEX IF NOT EXISTS idx_summaries_status ON summaries(status);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

_SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")


def _now_iso() -> str:
    return (datetime.now(timezone.utc)
            .isoformat(timespec="seconds").replace("+00:00", "Z"))


def _migrate_category_check_constraint(conn: sqlite3.Connection) -> None:
    """One-shot DOWN-migration: collapse the legacy 3-value category CHECK
    (summary / cleanup / voicemail) back to 2 values (summary / cleanup).

    The 'voicemail' category was removed when voicemails were unified into
    meetings. Any surviving 'voicemail' rows (the bundled voicemail-todos /
    voicemail-clean seeds, or user/learned rows) are re-pointed FIRST so the
    rebuilt CHECK doesn't reject them:
      - slug contains 'clean'  → 'cleanup'
      - everything else        → 'summary'
    then the table is rebuilt with the narrowed constraint.

    Idempotent — re-running is a no-op once the table already carries the
    2-value constraint. SQLite has no `ALTER TABLE ... DROP CONSTRAINT`, so we
    use the standard rebuild dance (PRAGMA table_info won't show CHECK
    constraints — we inspect sqlite_master.sql instead).
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='prompts'"
    ).fetchone()
    if row is None:
        return  # no prompts table yet — fresh DB will get the new schema
    table_sql = row[0] if isinstance(row, tuple) else row["sql"]
    if "'voicemail'" not in table_sql:
        return  # already on the 2-value constraint — no-op
    conn.executescript("""
        BEGIN;
        -- Re-point legacy voicemail rows BEFORE the narrowed CHECK applies.
        UPDATE prompts
            SET category = CASE
                WHEN instr(slug, 'clean') > 0 THEN 'cleanup'
                ELSE 'summary'
            END
            WHERE category = 'voicemail';
        CREATE TABLE prompts_new (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN ('summary', 'cleanup')),
            content TEXT NOT NULL,
            is_auto_run INTEGER NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT 'manual'
                CHECK(source IN ('seed', 'manual', 'learned')),
            sort_order INTEGER NOT NULL DEFAULT 0,
            note TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO prompts_new SELECT * FROM prompts;
        DROP TABLE prompts;
        ALTER TABLE prompts_new RENAME TO prompts;
        CREATE INDEX IF NOT EXISTS idx_prompts_category_autorun
            ON prompts(category, is_auto_run);
        COMMIT;
    """)


def open_db(path: Path) -> sqlite3.Connection:
    """Open WAL-mode sqlite, ensure schema; mirrors vocab.db.open_db.

    Sets PRAGMA journal_mode=WAL, busy_timeout=2000, row_factory=sqlite3.Row.
    Runs _SCHEMA_SQL and seeds meta.schema_version with INSERT OR IGNORE."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=2.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=2000")
    conn.executescript(_SCHEMA_SQL)
    _migrate_category_check_constraint(conn)   # NEW — runs on every open, idempotent
    conn.execute(
        "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)",
        (SCHEMA_VERSION,),
    )
    conn.commit()
    return conn


def _row_to_prompt(row: sqlite3.Row) -> Prompt:
    return Prompt(
        id=row["id"],
        slug=row["slug"],
        name=row["name"],
        category=Category(row["category"]),
        content=row["content"],
        is_auto_run=bool(row["is_auto_run"]),
        source=Source(row["source"]),
        sort_order=row["sort_order"],
        note=row["note"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _row_to_summary(row: sqlite3.Row) -> Summary:
    return Summary(
        id=row["id"],
        audio_path=row["audio_path"],
        prompt_id=row["prompt_id"],
        prompt_slug=row["prompt_slug"],
        prompt_name=row["prompt_name"],
        prompt_content=row["prompt_content"],
        output_path=row["output_path"],
        html_path=row["html_path"],
        model=row["model"],
        status=SummaryStatus(row["status"]),
        error=row["error"],
        duration_ms=row["duration_ms"],
        word_count=row["word_count"],
        created_at=row["created_at"],
        completed_at=row["completed_at"],
    )


class PromptsRepo:
    """CRUD over the `prompts` table.

    Method contracts (tests pin behavior):
      add(slug, name, category, content, *, is_auto_run=False,
          source=Source.MANUAL, sort_order=0, note=None) -> id (str UUID)
        - raises ValueError if slug fails _SLUG_RE
        - raises ValueError if slug already exists (sqlite UNIQUE constraint)
        - writes created_at + updated_at = _now_iso()
      get(id) -> Optional[Prompt]
      by_slug(slug) -> Optional[Prompt]
      list_prompts(*, category=None, auto_run_only=False) -> list[Prompt]
        - sorted by sort_order asc, then slug asc
      edit(slug, *, name=None, content=None, category=None,
           is_auto_run=None, sort_order=None, note=None) -> bool
        - return False if slug not found; True otherwise
        - touch updated_at = _now_iso()
        - kwargs left as None mean "don't change"
      remove(slug) -> bool
        - True if a row was deleted; False if slug missing
      get_meta(key) -> Optional[str]
      set_meta(key, value) -> None
        - UPSERT semantics
    """

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def add(
        self,
        slug: str,
        name: str,
        category: Category,
        content: str,
        *,
        is_auto_run: bool = False,
        source: Source = Source.MANUAL,
        sort_order: int = 0,
        note: Optional[str] = None,
    ) -> str:
        if not _SLUG_RE.match(slug):
            raise ValueError(f"Invalid slug: {slug!r}. Must be lowercase alphanumeric + hyphens.")
        prompt_id = str(uuid.uuid4())
        now = _now_iso()
        try:
            self.conn.execute(
                """
                INSERT INTO prompts(id, slug, name, category, content,
                    is_auto_run, source, sort_order, note, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (prompt_id, slug, name, category.value, content,
                 1 if is_auto_run else 0, source.value, sort_order, note, now, now),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"Slug already exists: {slug!r}") from exc
        self.conn.commit()
        return prompt_id

    def get(self, prompt_id: str) -> Optional[Prompt]:
        row = self.conn.execute(
            "SELECT * FROM prompts WHERE id = ?", (prompt_id,)
        ).fetchone()
        return _row_to_prompt(row) if row else None

    def by_slug(self, slug: str) -> Optional[Prompt]:
        row = self.conn.execute(
            "SELECT * FROM prompts WHERE slug = ?", (slug,)
        ).fetchone()
        return _row_to_prompt(row) if row else None

    def list_prompts(
        self,
        *,
        category: Optional[Category] = None,
        auto_run_only: bool = False,
    ) -> list[Prompt]:
        sql = "SELECT * FROM prompts"
        clauses, params = [], []
        if category is not None:
            clauses.append("category = ?")
            params.append(category.value)
        if auto_run_only:
            clauses.append("is_auto_run = 1")
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY sort_order ASC, slug ASC"
        return [_row_to_prompt(r) for r in self.conn.execute(sql, params).fetchall()]

    def edit(
        self,
        slug: str,
        *,
        name: Optional[str] = None,
        content: Optional[str] = None,
        category: Optional[Category] = None,
        is_auto_run: Optional[bool] = None,
        sort_order: Optional[int] = None,
        note: Optional[str] = None,
    ) -> bool:
        existing = self.by_slug(slug)
        if not existing:
            return False
        new_name = name if name is not None else existing.name
        new_content = content if content is not None else existing.content
        new_category = category.value if category is not None else existing.category.value
        new_is_auto_run = (1 if is_auto_run else 0) if is_auto_run is not None else (1 if existing.is_auto_run else 0)
        new_sort_order = sort_order if sort_order is not None else existing.sort_order
        new_note = note if note is not None else existing.note
        self.conn.execute(
            """
            UPDATE prompts
            SET name=?, content=?, category=?, is_auto_run=?, sort_order=?, note=?, updated_at=?
            WHERE slug=?
            """,
            (new_name, new_content, new_category, new_is_auto_run,
             new_sort_order, new_note, _now_iso(), slug),
        )
        self.conn.commit()
        return True

    def remove(self, slug: str) -> bool:
        cur = self.conn.execute("DELETE FROM prompts WHERE slug = ?", (slug,))
        self.conn.commit()
        return cur.rowcount > 0

    def get_meta(self, key: str) -> Optional[str]:
        row = self.conn.execute(
            "SELECT value FROM meta WHERE key = ?", (key,)
        ).fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        self.conn.commit()


class SummariesRepo:
    """CRUD over the `summaries` table.

    Method contracts:
      start(audio_path, prompt_id, prompt_slug, prompt_name,
            prompt_content, output_path, *, model=None) -> id (str UUID)
        - status=QUEUED, created_at=now, completed_at=None
      mark_running(id) -> None
      mark_done(id, *, duration_ms, word_count, html_path=None) -> None
        - status=DONE, completed_at=now
      mark_error(id, *, error: str) -> None
        - status=ERROR, completed_at=now
      get(id) -> Optional[Summary]
      list_summaries(*, audio_path=None, status=None) -> list[Summary]
        - sorted by created_at desc
    """

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def start(
        self,
        audio_path: str,
        prompt_id: str,
        prompt_slug: str,
        prompt_name: str,
        prompt_content: str,
        output_path: str,
        *,
        model: Optional[str] = None,
    ) -> str:
        summary_id = str(uuid.uuid4())
        now = _now_iso()
        self.conn.execute(
            """
            INSERT INTO summaries(id, audio_path, prompt_id, prompt_slug, prompt_name,
                prompt_content, output_path, html_path, model, status, error,
                duration_ms, word_count, created_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, NULL)
            """,
            (summary_id, audio_path, prompt_id, prompt_slug, prompt_name,
             prompt_content, output_path, model, SummaryStatus.QUEUED.value, now),
        )
        self.conn.commit()
        return summary_id

    def mark_running(self, summary_id: str) -> None:
        self.conn.execute(
            "UPDATE summaries SET status=? WHERE id=?",
            (SummaryStatus.RUNNING.value, summary_id),
        )
        self.conn.commit()

    def mark_done(
        self,
        summary_id: str,
        *,
        duration_ms: int,
        word_count: int,
        html_path: Optional[str] = None,
    ) -> None:
        self.conn.execute(
            """
            UPDATE summaries
            SET status=?, duration_ms=?, word_count=?, html_path=?, completed_at=?
            WHERE id=?
            """,
            (SummaryStatus.DONE.value, duration_ms, word_count,
             html_path, _now_iso(), summary_id),
        )
        self.conn.commit()

    def mark_error(self, summary_id: str, *, error: str) -> None:
        self.conn.execute(
            "UPDATE summaries SET status=?, error=?, completed_at=? WHERE id=?",
            (SummaryStatus.ERROR.value, error, _now_iso(), summary_id),
        )
        self.conn.commit()

    def get(self, summary_id: str) -> Optional[Summary]:
        row = self.conn.execute(
            "SELECT * FROM summaries WHERE id = ?", (summary_id,)
        ).fetchone()
        return _row_to_summary(row) if row else None

    def list_summaries(
        self,
        *,
        audio_path: Optional[str] = None,
        status: Optional[SummaryStatus] = None,
    ) -> list[Summary]:
        sql = "SELECT * FROM summaries"
        clauses, params = [], []
        if audio_path is not None:
            clauses.append("audio_path = ?")
            params.append(audio_path)
        if status is not None:
            clauses.append("status = ?")
            params.append(status.value)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY created_at DESC"
        return [_row_to_summary(r) for r in self.conn.execute(sql, params).fetchall()]
