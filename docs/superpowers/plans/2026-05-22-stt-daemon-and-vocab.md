# STT Daemon + Vocab SQLite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ad-hoc mlx-whisper subprocess invocations and hardcoded glossary/replacements with a resident `stt_daemon` (Python, asyncio) backed by user-editable `~/.config/yulu/vocab.sqlite`, following the design at [docs/superpowers/specs/2026-05-22-stt-daemon-and-vocab-design.md](../specs/2026-05-22-stt-daemon-and-vocab-design.md).

**Architecture:** Single resident Python daemon owns mlx-whisper model + whisper-cli dispatch + vocab cache + live session tail loops; serves all transcribe requests over a Unix socket (`~/.config/yulu/stt_daemon.sock`) with a two-slot scheduler (interactive reserved for future dictation, background for finalize > live_chunk > file_transcribe). `transcribe.py` becomes a thin client; `realtime_transcribe.py` is deleted, absorbed into the daemon.

**Tech Stack:** Python 3 (asyncio, sqlite3, signal, struct), mlx-whisper (lazy in-process), whisper-cli (subprocess fallback), pytest, launchd. No new third-party deps beyond what Yulu already requires.

---

## Scope Check Note

The spec covers two tightly-coupled subsystems — the daemon and the vocab DB. They cannot ship independently (the daemon's vocab cache requires the DB; the DB is useless without a consumer). One plan, 8 phases. Each phase ends with passing tests and an atomic commit.

## File Structure

**New files (created in this plan):**

```
yulu/scripts/vocab/
  __init__.py                  # package marker, exports VocabRepo
  db.py                        # sqlite connection, schema, migration, repository CRUD
  seed.py                      # frozen SEED_GLOSSARY + SEED_REPLACEMENTS snapshots + seeder
  cli.py                       # `yulu vocab` subcommand handlers (argparse)

yulu/scripts/stt_daemon/
  __init__.py                  # package marker
  __main__.py                  # entry point: `python -m stt_daemon`
  config.py                    # daemon config schema, loaded from ~/.config/yulu/config.json
  protocol.py                  # JobKind, ErrorCode, message dataclasses + JSON codec
  logging.py                   # structured JSON logger
  vocab_cache.py               # VocabCache (reads vocab.sqlite, SIGHUP/mtime reload)
  runtime.py                   # STTRuntime (mlx-whisper + whisper-cli adapters)
  scheduler.py                 # STTScheduler (two slots, priority queue, cancel)
  live_session.py              # LiveSessionManager (tail loop, persistence, crash recovery)
  control_server.py            # asyncio Unix socket server, dispatches to scheduler
  app.py                       # composition root, wires everything together

yulu/scripts/stt_cli.py        # `yulu stt` subcommand (status, warm-up, logs, restart)
yulu/scripts/transcribe_client.py  # synchronous RPC client used by transcribe.py
yulu/scripts/com.yulu.sttdaemon.plist   # launchd plist

tests/conftest.py              # registers pytest markers (e2e, integration)
tests/test_vocab_db.py
tests/test_vocab_seed.py
tests/test_vocab_cli.py
tests/test_stt_protocol.py
tests/test_stt_vocab_cache.py
tests/test_stt_scheduler.py
tests/test_stt_runtime_mock.py
tests/test_stt_live_session.py
tests/test_stt_control_server.py
tests/test_transcribe_client.py
tests/test_e2e_stt_daemon.py   # opt-in via `pytest -m e2e`
tests/fixtures/audio/.gitkeep  # placeholder; e2e audio added locally
```

**Modified files:**

```
yulu/scripts/transcribe.py     # reduce to thin client + business orchestration (refine/summary/agent_queue)
yulu/scripts/meeting_daemon.py # switch realtime path to `subscribe_session`
yulu/scripts/doctor.py         # add stt_daemon health checks
yulu/scripts/yulu              # shell wrapper: add `vocab` and `stt` subcommands
yulu/scripts/setup.sh          # install plist, run seed, warm-up
yulu/scripts/dev_install.py    # register stt_daemon launchd target
yulu/scripts/config.example.json  # remove transcription.replacements field; add stt_daemon defaults
.github/workflows/ci.yml       # ensure new tests run
```

**Deleted files:**

```
yulu/scripts/realtime_transcribe.py
```

---

# Phase 1 — Vocab SQLite Foundation

**Outcome:** User can run `yulu vocab add/list/edit/remove/seed/export/import` against `~/.config/yulu/vocab.sqlite`. No daemon yet. Full unit + DB tests green.

## Task 1.1: VocabRepo schema + CRUD

**Files:**
- Create: `yulu/scripts/vocab/__init__.py`
- Create: `yulu/scripts/vocab/db.py`
- Create: `tests/test_vocab_db.py`

- [ ] **Step 1: Create package marker**

Write `yulu/scripts/vocab/__init__.py`:

```python
"""Vocab package — custom_words SQLite repository and CLI."""

from .db import VocabRepo, CustomWord, Scope, Source, open_db

__all__ = ["VocabRepo", "CustomWord", "Scope", "Source", "open_db"]
```

- [ ] **Step 2: Write failing tests for VocabRepo basics**

Write `tests/test_vocab_db.py`:

```python
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from vocab import VocabRepo, CustomWord, Scope, Source, open_db


def test_open_db_creates_schema(tmp_path):
    db_path = tmp_path / "vocab.sqlite"
    conn = open_db(db_path)
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    tables = [row[0] for row in cur.fetchall()]
    assert "custom_words" in tables
    assert "meta" in tables
    schema_version = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    assert schema_version[0] == "1"


def test_add_and_fetch_row(tmp_path):
    repo = VocabRepo(open_db(tmp_path / "vocab.sqlite"))
    word_id = repo.add(term="Kubernetes", canonical="Kubernetes", scope=Scope.PROMPT)
    fetched = repo.get(word_id)
    assert fetched.term == "Kubernetes"
    assert fetched.canonical == "Kubernetes"
    assert fetched.scope == Scope.PROMPT
    assert fetched.source == Source.MANUAL
    assert fetched.enabled is True


def test_list_filters(tmp_path):
    repo = VocabRepo(open_db(tmp_path / "vocab.sqlite"))
    repo.add(term="AgentKey", canonical="AgentKey", scope=Scope.PROMPT)
    repo.add(term="agent king", canonical="AgentKey", scope=Scope.REPLACE)
    repo.add(term="github", canonical="GitHub", scope=Scope.BOTH)
    repo.add(term="disabled", canonical="Disabled", scope=Scope.REPLACE, enabled=False)

    assert len(repo.list_words()) == 4
    assert len(repo.list_words(scope=Scope.PROMPT)) == 1
    assert len(repo.list_words(scope=Scope.BOTH)) == 1
    assert len(repo.list_words(scope=Scope.REPLACE)) == 2  # incl. disabled row
    enabled = repo.list_words(enabled_only=True)
    assert len(enabled) == 3
    prompt_or_both = repo.list_words(scopes=[Scope.PROMPT, Scope.BOTH], enabled_only=True)
    assert len(prompt_or_both) == 2


def test_edit_and_disable(tmp_path):
    repo = VocabRepo(open_db(tmp_path / "vocab.sqlite"))
    wid = repo.add(term="github", canonical="GitHub", scope=Scope.REPLACE)
    repo.edit(wid, canonical="GitHub.com", scope=Scope.BOTH)
    w = repo.get(wid)
    assert w.canonical == "GitHub.com"
    assert w.scope == Scope.BOTH
    repo.set_enabled(wid, False)
    assert repo.get(wid).enabled is False


def test_remove(tmp_path):
    repo = VocabRepo(open_db(tmp_path / "vocab.sqlite"))
    wid = repo.add(term="x", canonical="X", scope=Scope.PROMPT)
    assert repo.remove(wid) is True
    assert repo.get(wid) is None
    assert repo.remove(wid) is False  # idempotent


def test_meta_seeded_at(tmp_path):
    repo = VocabRepo(open_db(tmp_path / "vocab.sqlite"))
    assert repo.get_meta("seeded_at") is None
    repo.set_meta("seeded_at", "2026-05-22T10:00:00Z")
    assert repo.get_meta("seeded_at") == "2026-05-22T10:00:00Z"
```

- [ ] **Step 3: Run tests — verify they FAIL with ImportError**

Run: `python3 -m pytest tests/test_vocab_db.py -v`
Expected: `ImportError: cannot import name 'VocabRepo' from 'vocab'` (the import succeeds for the package marker but symbols missing).

- [ ] **Step 4: Implement VocabRepo**

Write `yulu/scripts/vocab/db.py`:

```python
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
    conn.commit()
    return conn


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
```

- [ ] **Step 5: Run tests — verify PASS**

Run: `python3 -m pytest tests/test_vocab_db.py -v`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/vocab/__init__.py yulu/scripts/vocab/db.py tests/test_vocab_db.py
git commit -m "feat(vocab): add VocabRepo with sqlite schema + CRUD"
```

## Task 1.2: Seed snapshots + seeder

**Files:**
- Create: `yulu/scripts/vocab/seed.py`
- Create: `tests/test_vocab_seed.py`

- [ ] **Step 1: Write failing tests**

Write `tests/test_vocab_seed.py`:

```python
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from vocab import VocabRepo, Scope, Source, open_db
from vocab.seed import (
    SEED_GLOSSARY,
    SEED_REPLACEMENTS,
    seed_from_current,
    restore_defaults,
)


def test_snapshots_are_frozen_non_empty():
    assert len(SEED_GLOSSARY) >= 20
    assert "AgentKey" in SEED_GLOSSARY
    assert SEED_REPLACEMENTS.get("agent king") == "AgentKey"
    assert SEED_REPLACEMENTS.get("github") == "GitHub"


def test_seed_from_current_with_no_config(tmp_path):
    repo = VocabRepo(open_db(tmp_path / "vocab.sqlite"))
    summary = seed_from_current(repo, config_replacements=None)
    assert summary["glossary_inserted"] == len(SEED_GLOSSARY)
    assert summary["replacements_inserted"] == len(SEED_REPLACEMENTS)
    assert repo.get_meta("seeded_at") is not None
    # glossary terms should be prompt scope
    prompt_rows = repo.list_words(scope=Scope.PROMPT)
    assert any(w.term == "AgentKey" and w.source == Source.SEED for w in prompt_rows)
    both_rows = repo.list_words(scope=Scope.BOTH)
    assert any(w.term == "agent king" and w.canonical == "AgentKey" for w in both_rows)


def test_seed_merges_config_replacements(tmp_path):
    repo = VocabRepo(open_db(tmp_path / "vocab.sqlite"))
    extra = {"my custom term": "MyCustomTerm"}
    summary = seed_from_current(repo, config_replacements=extra)
    assert summary["replacements_inserted"] == len(SEED_REPLACEMENTS) + 1
    rows = repo.list_words(scope=Scope.BOTH)
    assert any(w.term == "my custom term" and w.source == Source.SEED for w in rows)


def test_seed_is_idempotent(tmp_path):
    repo = VocabRepo(open_db(tmp_path / "vocab.sqlite"))
    seed_from_current(repo, config_replacements=None)
    count1 = repo.count()
    seed_from_current(repo, config_replacements=None)
    count2 = repo.count()
    assert count1 == count2, "re-seeding should not duplicate seed rows"


def test_restore_defaults_preserves_manual(tmp_path):
    repo = VocabRepo(open_db(tmp_path / "vocab.sqlite"))
    seed_from_current(repo, config_replacements=None)
    manual_id = repo.add(term="custom", canonical="Custom", scope=Scope.PROMPT)
    # mutate a seed row
    seed_row = next(w for w in repo.list_words(scope=Scope.PROMPT) if w.term == "AgentKey")
    repo.edit(seed_row.id, canonical="AgentKeyMutated")
    # restore
    restore_defaults(repo)
    # seed row reverted, manual row preserved
    refreshed = repo.get(seed_row.id)
    assert refreshed.canonical == "AgentKey"
    assert repo.get(manual_id) is not None
```

- [ ] **Step 2: Run tests — verify FAIL with ImportError**

Run: `python3 -m pytest tests/test_vocab_seed.py -v`
Expected: ImportError for `vocab.seed`.

- [ ] **Step 3: Implement seed module**

Write `yulu/scripts/vocab/seed.py`:

```python
"""Frozen seed snapshots + seeder for vocab.sqlite.

These snapshots are intentionally frozen copies of the constants that used
to live in `scripts/transcribe.py`. The same PR that adds this module
deletes those constants from `transcribe.py`. After that point, this file
is the canonical history.
"""

from __future__ import annotations

from typing import Optional

from .db import Scope, Source, VocabRepo


# Frozen snapshot of DEFAULT_GLOSSARY from scripts/transcribe.py
SEED_GLOSSARY: tuple[str, ...] = (
    "AgentKey", "OpenClaw", "OpenAI", "Claude", "Cursor", "Deal Hub",
    "Portfolio", "public market", "candidate", "qualification", "recruiter",
    "research rollup", "workflow", "GitHub", "screenshot", "VP",
    "VC", "AI conference", "meetup", "Yulu",
)

# Frozen snapshot of the inline `replacements` dict
SEED_REPLACEMENTS: dict[str, str] = {
    "agent king": "AgentKey",
    "Agent King": "AgentKey",
    "agency": "AgentKey",
    "Agency": "AgentKey",
    "open cloud": "OpenClaw",
    "OpenCloud": "OpenClaw",
    "OpenCore": "OpenClaw",
    "deal hub": "Deal Hub",
    "github": "GitHub",
}


def _existing_seed_index(repo: VocabRepo) -> dict[tuple[str, str], str]:
    """Map (term, scope) -> id for existing seed rows."""
    index = {}
    for w in repo.list_words():
        if w.source == Source.SEED:
            index[(w.term, w.scope.value)] = w.id
    return index


def seed_from_current(
    repo: VocabRepo,
    *,
    config_replacements: Optional[dict[str, str]] = None,
) -> dict[str, int]:
    """Apply bundled snapshots + optional config overrides.

    Returns a summary dict with counts. Idempotent: skips (term, scope)
    pairs already present as seed rows.
    """
    existing = _existing_seed_index(repo)
    glossary_inserted = 0
    for term in SEED_GLOSSARY:
        if (term, Scope.PROMPT.value) in existing:
            continue
        repo.add(term=term, canonical=term, scope=Scope.PROMPT, source=Source.SEED)
        glossary_inserted += 1

    merged_replacements = dict(SEED_REPLACEMENTS)
    if config_replacements:
        for k, v in config_replacements.items():
            if k not in merged_replacements:
                merged_replacements[k] = v

    replacements_inserted = 0
    for term, canonical in merged_replacements.items():
        if (term, Scope.BOTH.value) in existing:
            continue
        repo.add(term=term, canonical=canonical, scope=Scope.BOTH, source=Source.SEED)
        replacements_inserted += 1

    from datetime import datetime, timezone
    repo.set_meta(
        "seeded_at",
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    )
    return {
        "glossary_inserted": glossary_inserted,
        "replacements_inserted": replacements_inserted,
    }


def restore_defaults(repo: VocabRepo) -> dict[str, int]:
    """Overwrite seed rows back to bundled snapshots; preserve manual rows.

    Seed rows are updated in-place (IDs preserved) so that callers holding
    IDs still get the reverted values. Seed rows that have no match in the
    bundled snapshots are removed. Manual rows are never touched.
    """
    # Build lookup tables for the bundled snapshots
    glossary_by_term: dict[str, str] = {t: t for t in SEED_GLOSSARY}
    replacements_by_term: dict[str, str] = dict(SEED_REPLACEMENTS)

    rows = repo.list_words()
    reverted = 0
    removed = 0
    for w in rows:
        if w.source != Source.SEED:
            continue
        if w.scope == Scope.PROMPT and w.term in glossary_by_term:
            canonical = glossary_by_term[w.term]
            if w.canonical != canonical:
                repo.edit(w.id, canonical=canonical)
            reverted += 1
        elif w.scope == Scope.BOTH and w.term in replacements_by_term:
            canonical = replacements_by_term[w.term]
            if w.canonical != canonical:
                repo.edit(w.id, canonical=canonical)
            reverted += 1
        else:
            # seed row no longer in snapshots — remove it
            repo.remove(w.id)
            removed += 1

    # Insert any snapshot entries that don't exist yet
    inserted = seed_from_current(repo, config_replacements=None)
    return {
        "reverted": reverted,
        "removed_stale": removed,
        "glossary_inserted": inserted["glossary_inserted"],
        "replacements_inserted": inserted["replacements_inserted"],
    }
```

- [ ] **Step 4: Run tests — verify PASS**

Run: `python3 -m pytest tests/test_vocab_seed.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/vocab/seed.py tests/test_vocab_seed.py
git commit -m "feat(vocab): add frozen seed snapshots + seeder"
```

## Task 1.3: `yulu vocab` CLI

**Files:**
- Create: `yulu/scripts/vocab/cli.py`
- Create: `tests/test_vocab_cli.py`

- [ ] **Step 1: Write failing tests for CLI argparse + side effects**

Write `tests/test_vocab_cli.py`:

```python
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from vocab.cli import main as vocab_main


def _run(args, *, db_path, capsys):
    code = vocab_main([*args, "--db", str(db_path)])
    out, err = capsys.readouterr()
    return code, out, err


def test_add_and_list_json(tmp_path, capsys):
    db = tmp_path / "vocab.sqlite"
    code, out, _ = _run(["add", "Kubernetes", "Kubernetes", "--scope", "prompt"], db_path=db, capsys=capsys)
    assert code == 0
    code, out, _ = _run(["list", "--json"], db_path=db, capsys=capsys)
    assert code == 0
    data = json.loads(out)
    assert len(data) == 1
    assert data[0]["term"] == "Kubernetes"


def test_seed_from_current_outputs_summary(tmp_path, capsys):
    db = tmp_path / "vocab.sqlite"
    code, out, _ = _run(["seed", "--from-current"], db_path=db, capsys=capsys)
    assert code == 0
    assert "glossary_inserted" in out
    code, out, _ = _run(["list", "--json"], db_path=db, capsys=capsys)
    data = json.loads(out)
    terms = {w["term"] for w in data}
    assert "AgentKey" in terms


def test_edit_and_disable(tmp_path, capsys):
    db = tmp_path / "vocab.sqlite"
    _run(["add", "github", "GitHub", "--scope", "replace"], db_path=db, capsys=capsys)
    code, out, _ = _run(["list", "--json"], db_path=db, capsys=capsys)
    word_id = json.loads(out)[0]["id"]
    code, _, _ = _run(["edit", word_id, "--scope", "both"], db_path=db, capsys=capsys)
    assert code == 0
    code, _, _ = _run(["edit", word_id, "--disable"], db_path=db, capsys=capsys)
    assert code == 0
    code, out, _ = _run(["list", "--json"], db_path=db, capsys=capsys)
    rec = json.loads(out)[0]
    assert rec["scope"] == "both"
    assert rec["enabled"] is False


def test_remove_returns_error_for_unknown(tmp_path, capsys):
    db = tmp_path / "vocab.sqlite"
    code, _, err = _run(["remove", "nonexistent"], db_path=db, capsys=capsys)
    assert code != 0
    assert "not found" in err.lower()


def test_export_then_import_json_roundtrip(tmp_path, capsys):
    db = tmp_path / "vocab.sqlite"
    _run(["add", "github", "GitHub", "--scope", "both"], db_path=db, capsys=capsys)
    _run(["add", "Kubernetes", "Kubernetes", "--scope", "prompt"], db_path=db, capsys=capsys)
    export_path = tmp_path / "out.json"
    code, _, _ = _run(["export", "--format", "json", "-o", str(export_path)], db_path=db, capsys=capsys)
    assert code == 0
    assert export_path.exists()

    db2 = tmp_path / "vocab2.sqlite"
    code, _, _ = _run(["import", str(export_path)], db_path=db2, capsys=capsys)
    assert code == 0
    code, out, _ = _run(["list", "--json"], db_path=db2, capsys=capsys)
    assert len(json.loads(out)) == 2
```

- [ ] **Step 2: Run tests — verify ImportError FAIL**

Run: `python3 -m pytest tests/test_vocab_cli.py -v`
Expected: ImportError for `vocab.cli`.

- [ ] **Step 3: Implement CLI**

Write `yulu/scripts/vocab/cli.py`:

```python
"""`yulu vocab` CLI subcommand implementation."""

from __future__ import annotations

import argparse
import csv
import json
import os
import signal
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from .db import VocabRepo, Scope, Source, open_db
from .seed import seed_from_current, restore_defaults


DEFAULT_DB = Path.home() / ".config" / "yulu" / "vocab.sqlite"
DAEMON_PID = Path.home() / ".config" / "yulu" / "stt_daemon.pid"


def _sighup_daemon() -> None:
    """Best-effort SIGHUP to the running stt_daemon to reload vocab cache."""
    try:
        if not DAEMON_PID.exists():
            return
        pid = int(DAEMON_PID.read_text().strip())
        os.kill(pid, signal.SIGHUP)
    except (OSError, ValueError):
        # daemon not running or stale pid -- next daemon start will read fresh
        pass


def _word_to_dict(w) -> dict:
    d = asdict(w)
    d["scope"] = w.scope.value
    d["source"] = w.source.value
    return d


def _print_table(rows: list[dict]) -> None:
    if not rows:
        print("(empty)")
        return
    cols = ["id", "term", "canonical", "scope", "source", "enabled", "note"]
    widths = {c: max(len(c), max(len(str(r.get(c, "") or "")) for r in rows)) for c in cols}
    header = "  ".join(c.ljust(widths[c]) for c in cols)
    print(header)
    print("  ".join("-" * widths[c] for c in cols))
    for r in rows:
        print("  ".join(str(r.get(c, "") or "").ljust(widths[c]) for c in cols))


def _cmd_list(args: argparse.Namespace, repo: VocabRepo) -> int:
    scope = Scope(args.scope) if args.scope else None
    words = repo.list_words(scope=scope, enabled_only=False)
    if args.disabled:
        words = [w for w in words if not w.enabled]
    rows = [_word_to_dict(w) for w in words]
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        _print_table(rows)
    return 0


def _cmd_add(args: argparse.Namespace, repo: VocabRepo) -> int:
    canonical = args.canonical if args.canonical is not None else args.term
    wid = repo.add(
        term=args.term,
        canonical=canonical,
        scope=Scope(args.scope),
        note=args.note,
    )
    print(wid)
    return 0


def _cmd_edit(args: argparse.Namespace, repo: VocabRepo) -> int:
    existing = repo.get(args.id)
    if not existing:
        print(f"id {args.id} not found", file=sys.stderr)
        return 1
    repo.edit(
        args.id,
        term=args.term,
        canonical=args.canonical,
        scope=Scope(args.scope) if args.scope else None,
        note=args.note,
    )
    if args.enable:
        repo.set_enabled(args.id, True)
    elif args.disable:
        repo.set_enabled(args.id, False)
    return 0


def _cmd_remove(args: argparse.Namespace, repo: VocabRepo) -> int:
    if not repo.remove(args.id):
        print(f"id {args.id} not found", file=sys.stderr)
        return 1
    return 0


def _cmd_seed(args: argparse.Namespace, repo: VocabRepo) -> int:
    config_replacements = _load_config_replacements() if args.from_current else None
    if args.restore_defaults:
        summary = restore_defaults(repo)
    else:
        summary = seed_from_current(repo, config_replacements=config_replacements)
    print(json.dumps(summary, indent=2))
    return 0


def _cmd_export(args: argparse.Namespace, repo: VocabRepo) -> int:
    words = repo.list_words()
    rows = [_word_to_dict(w) for w in words]
    if args.format == "json":
        out = json.dumps(rows, ensure_ascii=False, indent=2)
    else:
        import io
        buf = io.StringIO()
        fields = ["term", "canonical", "scope", "source", "enabled", "note"]
        writer = csv.DictWriter(buf, fieldnames=fields)
        writer.writeheader()
        for r in rows:
            writer.writerow({f: r.get(f, "") for f in fields})
        out = buf.getvalue()
    if args.output:
        Path(args.output).write_text(out, encoding="utf-8")
    else:
        print(out)
    return 0


def _cmd_import(args: argparse.Namespace, repo: VocabRepo) -> int:
    p = Path(args.file)
    if not p.exists():
        print(f"file not found: {p}", file=sys.stderr)
        return 1
    inserted = 0
    if p.suffix == ".json":
        rows = json.loads(p.read_text(encoding="utf-8"))
    elif p.suffix == ".csv":
        with p.open(newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    else:
        print(f"unsupported file extension: {p.suffix}", file=sys.stderr)
        return 1
    for r in rows:
        try:
            repo.add(
                term=r["term"],
                canonical=r["canonical"],
                scope=Scope(r["scope"]),
                source=Source(r.get("source") or "manual"),
                enabled=str(r.get("enabled", "1")).lower() not in ("0", "false"),
                note=r.get("note") or None,
            )
            inserted += 1
        except (KeyError, ValueError) as exc:
            print(f"skip row: {exc}", file=sys.stderr)
    print(json.dumps({"inserted": inserted}, indent=2))
    return 0


def _cmd_reload(args: argparse.Namespace, repo: VocabRepo) -> int:
    _sighup_daemon()
    print("SIGHUP sent (best-effort)")
    return 0


def _load_config_replacements() -> Optional[dict[str, str]]:
    config = Path.home() / ".config" / "yulu" / "config.json"
    if not config.exists():
        return None
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
        trans = data.get("transcription", {})
        return trans.get("replacements")
    except (json.JSONDecodeError, OSError):
        return None


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="yulu vocab")
    p.add_argument("--db", default=str(DEFAULT_DB), help="vocab.sqlite path")
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list")
    pl.add_argument("--scope", choices=["prompt", "replace", "both"])
    pl.add_argument("--disabled", action="store_true", help="show only disabled rows")
    pl.add_argument("--json", action="store_true")

    pa = sub.add_parser("add")
    pa.add_argument("term")
    pa.add_argument("canonical", nargs="?")
    pa.add_argument("--scope", choices=["prompt", "replace", "both"], default="both")
    pa.add_argument("--note")

    pe = sub.add_parser("edit")
    pe.add_argument("id")
    pe.add_argument("--term")
    pe.add_argument("--canonical")
    pe.add_argument("--scope", choices=["prompt", "replace", "both"])
    pe.add_argument("--note")
    group = pe.add_mutually_exclusive_group()
    group.add_argument("--enable", action="store_true")
    group.add_argument("--disable", action="store_true")

    pr = sub.add_parser("remove")
    pr.add_argument("id")

    ps = sub.add_parser("seed")
    seed_group = ps.add_mutually_exclusive_group(required=True)
    seed_group.add_argument("--from-current", action="store_true")
    seed_group.add_argument("--restore-defaults", action="store_true")

    px = sub.add_parser("export")
    px.add_argument("--format", choices=["json", "csv"], default="json")
    px.add_argument("-o", "--output")

    pi = sub.add_parser("import")
    pi.add_argument("file")

    sub.add_parser("reload")

    return p


def _extract_db_from_argv(argv: list[str]) -> tuple[str, list[str]]:
    """Extract --db value from argv (may appear anywhere). Required because
    argparse subparsers consume positional+optional args after the subcommand
    name, so a top-level --db placed after the subcommand would be rejected.
    Returns (db_path, remaining_argv)."""
    remaining = []
    db_path = str(DEFAULT_DB)
    i = 0
    while i < len(argv):
        if argv[i] == "--db" and i + 1 < len(argv):
            db_path = argv[i + 1]
            i += 2
        elif argv[i].startswith("--db="):
            db_path = argv[i][len("--db="):]
            i += 1
        else:
            remaining.append(argv[i])
            i += 1
    return db_path, remaining


def main(argv: Optional[list[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    db_path, remaining_argv = _extract_db_from_argv(list(argv))

    parser = _build_parser()
    args = parser.parse_args(remaining_argv)
    args.db = db_path

    repo = VocabRepo(open_db(Path(args.db)))
    handlers = {
        "list": _cmd_list,
        "add": _cmd_add,
        "edit": _cmd_edit,
        "remove": _cmd_remove,
        "seed": _cmd_seed,
        "export": _cmd_export,
        "import": _cmd_import,
        "reload": _cmd_reload,
    }
    try:
        code = handlers[args.cmd](args, repo)
    finally:
        repo.conn.close()

    # mutations SIGHUP daemon to refresh cache
    if args.cmd in {"add", "edit", "remove", "seed", "import"}:
        _sighup_daemon()
    return code


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run CLI tests**

Run: `python3 -m pytest tests/test_vocab_cli.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/vocab/cli.py tests/test_vocab_cli.py
git commit -m "feat(vocab): add yulu vocab CLI (list/add/edit/remove/seed/export/import/reload)"
```

## Task 1.4: Wire `vocab` into the `yulu` shell wrapper

**Files:**
- Modify: `yulu/scripts/yulu`

- [ ] **Step 1: Inspect the shell wrapper to find the dispatch table**

Run: `cat yulu/scripts/yulu | head -80`
Read the dispatch logic for existing subcommands (e.g., `transcription`, `doctor`).

- [ ] **Step 2: Add `vocab` subcommand routing**

Open `yulu/scripts/yulu`. Locate the case/dispatch section. Add a new branch that forwards remaining args to `python3 -m vocab.cli`:

```bash
# (near other subcommands, e.g., after `transcription)` branch)
vocab)
    shift
    exec "${PYTHON:-python3}" -m vocab.cli "$@"
    ;;
```

Set `PYTHONPATH` early in the script if not already:

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="${SCRIPT_DIR}:${PYTHONPATH:-}"
```

(Skip the PYTHONPATH line if the existing wrapper already exports it.)

- [ ] **Step 3: Smoke-test the wrapper**

Run:
```bash
YULU_DB=$(mktemp -d)/vocab.sqlite
./yulu/scripts/yulu vocab add Kubernetes Kubernetes --scope prompt --db "$YULU_DB"
./yulu/scripts/yulu vocab list --db "$YULU_DB" --json | python3 -m json.tool
```
Expected: JSON list with one row.

- [ ] **Step 4: Run all current tests to confirm nothing broke**

Run: `python3 -m pytest -q`
Expected: all tests pass (including the new vocab ones).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu
git commit -m "feat(yulu): dispatch 'vocab' subcommand to python -m vocab.cli"
```

---

# Phase 2 — stt_daemon Scaffold (No Real Engines)

**Outcome:** Daemon process runs, exposes the control socket, accepts `health`/`vocab_reload`/mock `transcribe` jobs. Two-slot scheduler enforces priority + cancellation + backpressure. Vocab cache reloads on SIGHUP. Real STT not yet wired (Phase 3).

## Task 2.1: Protocol module + pytest markers

**Files:**
- Create: `yulu/scripts/stt_daemon/__init__.py`
- Create: `yulu/scripts/stt_daemon/protocol.py`
- Create: `yulu/scripts/stt_daemon/logging.py`
- Create: `tests/conftest.py`
- Create: `tests/test_stt_protocol.py`

- [ ] **Step 1: Create package marker**

Write `yulu/scripts/stt_daemon/__init__.py`:

```python
"""stt_daemon — resident STT service for Yulu."""
```

- [ ] **Step 2: Register pytest markers**

Write `tests/conftest.py`:

```python
def pytest_configure(config):
    config.addinivalue_line("markers", "e2e: opt-in tests that require real mlx-whisper model")
    config.addinivalue_line("markers", "integration: tests that spawn the daemon process")
```

- [ ] **Step 3: Write failing tests for protocol codec**

Write `tests/test_stt_protocol.py`:

```python
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.protocol import (
    JobKind, ErrorCode, MessageType,
    TranscribeRequest, TranscribeResponse,
    SubscribeSessionRequest, PartialEvent, FinalReadyEvent,
    ErrorEvent, encode, decode,
)


def test_job_kind_priority_order():
    # final < live < file < dictation (lower number = higher priority within slot)
    assert JobKind.DICTATION.priority == 0
    assert JobKind.FINAL_TRANSCRIBE.priority == 1
    assert JobKind.LIVE_CHUNK.priority == 2
    assert JobKind.FILE_TRANSCRIBE.priority == 3


def test_job_kind_slot_routing():
    assert JobKind.DICTATION.slot == "interactive"
    for k in (JobKind.FINAL_TRANSCRIBE, JobKind.LIVE_CHUNK, JobKind.FILE_TRANSCRIBE):
        assert k.slot == "background"


def test_transcribe_request_roundtrip():
    req = TranscribeRequest(
        job_id="abc",
        kind=JobKind.FINAL_TRANSCRIBE,
        engine="mlx",
        language="zh",
        audio_path="/tmp/x.wav",
        audio_offset_bytes=0,
        audio_length_bytes=None,
        audio_format="wav-pcm-s16le-16k-mono",
        meeting_title="Test",
        session_id=None,
        word_timestamps=False,
        condition_on_previous=True,
        hallucination_silence_threshold=2.0,
        timeout_sec=7200,
    )
    encoded = encode(req)
    parsed = json.loads(encoded)
    assert parsed["type"] == "transcribe"
    assert parsed["kind"] == "final_transcribe"
    back = decode(encoded)
    assert isinstance(back, TranscribeRequest)
    assert back.job_id == "abc"
    assert back.kind == JobKind.FINAL_TRANSCRIBE


def test_error_event_includes_code():
    err = ErrorEvent(job_id="x", code=ErrorCode.AUDIO_NOT_FOUND, message="missing")
    s = encode(err)
    assert "AUDIO_NOT_FOUND" in s


def test_decode_unknown_type_raises():
    import pytest
    with pytest.raises(ValueError):
        decode('{"type":"unknown"}')
```

- [ ] **Step 4: Run tests — FAIL with ImportError**

Run: `python3 -m pytest tests/test_stt_protocol.py -v`
Expected: ImportError.

- [ ] **Step 5: Implement protocol module**

Write `yulu/scripts/stt_daemon/protocol.py`:

```python
"""JSON message types + codec for the stt_daemon Unix socket protocol."""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, Optional, Union


class JobKind(str, Enum):
    DICTATION = "dictation"
    FINAL_TRANSCRIBE = "final_transcribe"
    LIVE_CHUNK = "live_chunk"
    FILE_TRANSCRIBE = "file_transcribe"

    @property
    def priority(self) -> int:
        return {
            JobKind.DICTATION: 0,
            JobKind.FINAL_TRANSCRIBE: 1,
            JobKind.LIVE_CHUNK: 2,
            JobKind.FILE_TRANSCRIBE: 3,
        }[self]

    @property
    def slot(self) -> str:
        return "interactive" if self is JobKind.DICTATION else "background"


class ErrorCode(str, Enum):
    MODEL_NOT_LOADED = "MODEL_NOT_LOADED"
    ENGINE_UNAVAILABLE = "ENGINE_UNAVAILABLE"
    AUDIO_NOT_FOUND = "AUDIO_NOT_FOUND"
    AUDIO_TOO_SHORT = "AUDIO_TOO_SHORT"
    JOB_CANCELLED = "JOB_CANCELLED"
    ENGINE_BUSY = "ENGINE_BUSY"
    VOCAB_LOCKED = "VOCAB_LOCKED"
    WATCHDOG_TIMEOUT = "WATCHDOG_TIMEOUT"
    INTERNAL = "INTERNAL"


class MessageType(str, Enum):
    HEALTH = "health"
    HEALTH_RESPONSE = "health_response"
    WARM_UP = "warm_up"
    VOCAB_RELOAD = "vocab_reload"
    VOCAB_RELOADED = "vocab_reloaded"
    TRANSCRIBE = "transcribe"
    TRANSCRIBE_RESULT = "transcribe_result"
    CANCEL = "cancel"
    SUBSCRIBE_SESSION = "subscribe_session"
    UNSUBSCRIBE_SESSION = "unsubscribe_session"
    PARTIAL = "partial"
    FINAL_READY = "final_ready"
    ERROR = "error"
    OK = "ok"


@dataclass
class HealthRequest:
    pass


@dataclass
class HealthResponse:
    ready: bool
    model_loaded: bool
    vocab_size: int
    in_flight_jobs: int
    active_sessions: int


@dataclass
class WarmUpRequest:
    engine: Optional[str] = None


@dataclass
class VocabReloadRequest:
    pass


@dataclass
class VocabReloadedResponse:
    prompt_terms: int
    replace_rules: int


@dataclass
class TranscribeRequest:
    job_id: str
    kind: JobKind
    engine: str
    language: str
    audio_path: str
    audio_offset_bytes: int = 0
    audio_length_bytes: Optional[int] = None
    audio_format: str = "wav-pcm-s16le-16k-mono"
    meeting_title: Optional[str] = None
    session_id: Optional[str] = None
    word_timestamps: bool = False
    condition_on_previous: bool = True
    hallucination_silence_threshold: float = 2.0
    timeout_sec: int = 7200


@dataclass
class TranscribeResponse:
    job_id: str
    status: str  # "ok" | "error" | "cancelled"
    engine_used: str
    language_used: str
    text: str
    raw_text: str
    segments: list[dict]
    vocab_prompt_terms_count: int
    vocab_replacements_count: int
    duration_ms: int
    error: Optional[str] = None


@dataclass
class CancelRequest:
    job_id: str


@dataclass
class SubscribeSessionRequest:
    sid: str
    mic_path: str
    sys_path: Optional[str] = None
    engine: str = "mlx"
    language: str = "zh"
    chunk_sec: int = 10


@dataclass
class UnsubscribeSessionRequest:
    sid: str
    reason: str  # "stopped" | "orphaned" | "crashed"


@dataclass
class PartialEvent:
    sid: str
    seq: int
    source: str          # "mic" | "system"
    started_ms: int
    ended_ms: int
    text: str


@dataclass
class FinalReadyEvent:
    sid: str
    transcript_path: str
    raw_path: str
    engine: str
    duration_ms: int


@dataclass
class ErrorEvent:
    code: ErrorCode
    message: str
    job_id: Optional[str] = None
    details: Optional[dict] = None


@dataclass
class OkResponse:
    detail: Optional[str] = None


Message = Union[
    HealthRequest, HealthResponse,
    WarmUpRequest,
    VocabReloadRequest, VocabReloadedResponse,
    TranscribeRequest, TranscribeResponse,
    CancelRequest,
    SubscribeSessionRequest, UnsubscribeSessionRequest,
    PartialEvent, FinalReadyEvent,
    ErrorEvent, OkResponse,
]


_TYPE_TO_CLS: dict[str, type] = {
    "health": HealthRequest,
    "health_response": HealthResponse,
    "warm_up": WarmUpRequest,
    "vocab_reload": VocabReloadRequest,
    "vocab_reloaded": VocabReloadedResponse,
    "transcribe": TranscribeRequest,
    "transcribe_result": TranscribeResponse,
    "cancel": CancelRequest,
    "subscribe_session": SubscribeSessionRequest,
    "unsubscribe_session": UnsubscribeSessionRequest,
    "partial": PartialEvent,
    "final_ready": FinalReadyEvent,
    "error": ErrorEvent,
    "ok": OkResponse,
}

_CLS_TO_TYPE: dict[type, str] = {v: k for k, v in _TYPE_TO_CLS.items()}


def _to_jsonable(obj: Any) -> Any:
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, dict):
        return {k: _to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_to_jsonable(v) for v in obj]
    return obj


def encode(msg: Message) -> str:
    """Encode a dataclass message to a JSON string ending with \\n."""
    type_name = _CLS_TO_TYPE.get(type(msg))
    if type_name is None:
        raise ValueError(f"unknown message class: {type(msg).__name__}")
    payload = {"type": type_name, **_to_jsonable(asdict(msg))}
    # Replace dataclass-field name 'audio_path' etc. unchanged — we keep
    # flat-keyed payloads to keep wire format readable.
    return json.dumps(payload, ensure_ascii=False) + "\n"


def decode(line: str) -> Message:
    """Decode one JSON line into a dataclass message."""
    data = json.loads(line)
    type_name = data.get("type")
    if type_name not in _TYPE_TO_CLS:
        raise ValueError(f"unknown message type: {type_name}")
    cls = _TYPE_TO_CLS[type_name]
    payload = {k: v for k, v in data.items() if k != "type"}
    # Coerce known Enum-valued fields
    if cls is TranscribeRequest:
        payload["kind"] = JobKind(payload["kind"])
    if cls is ErrorEvent:
        payload["code"] = ErrorCode(payload["code"])
    try:
        return cls(**payload)
    except TypeError as exc:
        raise ValueError(f"invalid payload for {type_name}: {exc}") from exc
```

- [ ] **Step 6: Implement structured logger**

Write `yulu/scripts/stt_daemon/logging.py`:

```python
"""JSON line logger for stt_daemon."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, TextIO


class JsonLogger:
    def __init__(self, sink: TextIO = sys.stderr):
        self.sink = sink

    def _emit(self, level: str, event: str, **fields: Any) -> None:
        line = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "level": level,
            "event": event,
            **fields,
        }
        self.sink.write(json.dumps(line, ensure_ascii=False) + "\n")
        self.sink.flush()

    def info(self, event: str, **fields: Any) -> None:
        self._emit("info", event, **fields)

    def warn(self, event: str, **fields: Any) -> None:
        self._emit("warn", event, **fields)

    def error(self, event: str, **fields: Any) -> None:
        self._emit("error", event, **fields)


def open_log_sink(path: Optional[Path]) -> TextIO:
    if path is None:
        return sys.stderr
    path.parent.mkdir(parents=True, exist_ok=True)
    return path.open("a", encoding="utf-8")
```

- [ ] **Step 7: Run protocol tests — PASS**

Run: `python3 -m pytest tests/test_stt_protocol.py -v`
Expected: 5 passed.

- [ ] **Step 8: Commit**

```bash
git add yulu/scripts/stt_daemon/ tests/conftest.py tests/test_stt_protocol.py
git commit -m "feat(stt_daemon): add package scaffold, protocol codec, json logger, pytest markers"
```

## Task 2.2: VocabCache

**Files:**
- Create: `yulu/scripts/stt_daemon/vocab_cache.py`
- Create: `tests/test_stt_vocab_cache.py`

- [ ] **Step 1: Write failing tests**

Write `tests/test_stt_vocab_cache.py`:

```python
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from vocab import VocabRepo, Scope, open_db
from stt_daemon.vocab_cache import VocabCache


def _seed(db_path: Path) -> VocabRepo:
    repo = VocabRepo(open_db(db_path))
    repo.add(term="Kubernetes", canonical="Kubernetes", scope=Scope.PROMPT)
    repo.add(term="agent king", canonical="AgentKey", scope=Scope.REPLACE)
    repo.add(term="github", canonical="GitHub", scope=Scope.BOTH)
    repo.add(term="disabled", canonical="Disabled", scope=Scope.PROMPT, enabled=False)
    return repo


def test_load_indexes_by_scope(tmp_path):
    db = tmp_path / "vocab.sqlite"
    _seed(db)
    cache = VocabCache(db)
    cache.load()
    assert sorted(cache.prompt_terms) == sorted(["Kubernetes", "github"])
    rule_terms = [term for term, _ in cache.replace_rules]
    assert sorted(rule_terms) == sorted(["agent king", "github"])


def test_inject_prompt_appends_terms(tmp_path):
    db = tmp_path / "vocab.sqlite"
    _seed(db)
    cache = VocabCache(db)
    cache.load()
    prompt = cache.inject_prompt(base_prompt="Meeting context.", meeting_title="Standup")
    assert "Meeting context." in prompt
    assert "Standup" in prompt
    assert "Kubernetes" in prompt
    assert "github" in prompt


def test_apply_replacements_substitutes_longest_first(tmp_path):
    db = tmp_path / "vocab.sqlite"
    repo = VocabRepo(open_db(db))
    repo.add(term="open cloud", canonical="OpenClaw", scope=Scope.BOTH)
    repo.add(term="open", canonical="ZZ", scope=Scope.BOTH)
    cache = VocabCache(db)
    cache.load()
    raw = "they call this open cloud sometimes."
    new, count = cache.apply_replacements(raw)
    assert "OpenClaw" in new
    assert "open cloud" not in new.lower()
    assert count >= 1


def test_replacement_is_case_insensitive_and_word_bounded(tmp_path):
    db = tmp_path / "vocab.sqlite"
    repo = VocabRepo(open_db(db))
    repo.add(term="github", canonical="GitHub", scope=Scope.REPLACE)
    cache = VocabCache(db)
    cache.load()
    out, _ = cache.apply_replacements("GITHUB is great, also Githubgist is not.")
    assert "GitHub is great" in out
    assert "Githubgist" in out  # word boundary prevents partial match


def test_reload_picks_up_changes(tmp_path):
    db = tmp_path / "vocab.sqlite"
    repo = _seed(db)
    cache = VocabCache(db)
    cache.load()
    initial = len(cache.prompt_terms)
    repo.add(term="NewWord", canonical="NewWord", scope=Scope.PROMPT)
    cache.reload()
    assert len(cache.prompt_terms) == initial + 1


def test_mtime_autoreload(tmp_path):
    db = tmp_path / "vocab.sqlite"
    repo = _seed(db)
    cache = VocabCache(db, autoreload=True)
    cache.load()
    initial = len(cache.prompt_terms)
    time.sleep(1.0)  # ensure mtime resolution
    repo.add(term="LateWord", canonical="LateWord", scope=Scope.PROMPT)
    cache.maybe_reload()
    assert len(cache.prompt_terms) == initial + 1
```

- [ ] **Step 2: Run — FAIL**

Run: `python3 -m pytest tests/test_stt_vocab_cache.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement VocabCache**

Write `yulu/scripts/stt_daemon/vocab_cache.py`:

```python
"""In-memory cache over the vocab.sqlite custom_words table."""

from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Optional

from vocab import VocabRepo, Scope, open_db


_ASCII_RE = re.compile(r"[A-Za-z0-9]")


def _compile_rule(term: str) -> re.Pattern[str]:
    """Build a regex that matches `term` case-insensitively.

    If the term contains any ASCII alphanumeric character we use word
    boundaries; otherwise (pure CJK) we fall back to a plain substring
    match because Python's \\b is not meaningful between CJK characters.
    """
    if _ASCII_RE.search(term):
        pattern = r"\b" + re.escape(term) + r"\b"
    else:
        pattern = re.escape(term)
    return re.compile(pattern, re.IGNORECASE)


class VocabCache:
    """Loads custom_words from sqlite, exposes prompt + replace data."""

    def __init__(self, db_path: Path, *, autoreload: bool = False):
        self.db_path = Path(db_path)
        self.autoreload = autoreload
        self._lock = threading.RLock()
        self._prompt_terms: list[str] = []
        self._replace_rules: list[tuple[str, str, re.Pattern[str]]] = []
        self._mtime: float = 0.0

    @property
    def prompt_terms(self) -> list[str]:
        with self._lock:
            return list(self._prompt_terms)

    @property
    def replace_rules(self) -> list[tuple[str, str]]:
        """Public view: list of (term, canonical) tuples (excludes compiled regex)."""
        with self._lock:
            return [(t, c) for t, c, _ in self._replace_rules]

    def load(self) -> None:
        self.reload()

    def reload(self) -> None:
        with self._lock:
            if not self.db_path.exists():
                self._prompt_terms = []
                self._replace_rules = []
                self._mtime = 0.0
                return
            conn = open_db(self.db_path)
            try:
                repo = VocabRepo(conn)
                prompt_words = repo.list_words(
                    scopes=[Scope.PROMPT, Scope.BOTH], enabled_only=True
                )
                replace_words = repo.list_words(
                    scopes=[Scope.REPLACE, Scope.BOTH], enabled_only=True
                )
            finally:
                conn.close()

            # Sort longest-first to prevent prefix shadowing in regex pass
            replace_words.sort(key=lambda w: len(w.term), reverse=True)
            self._prompt_terms = [w.term for w in prompt_words]
            self._replace_rules = [
                (w.term, w.canonical, _compile_rule(w.term)) for w in replace_words
            ]
            try:
                self._mtime = self.db_path.stat().st_mtime
            except OSError:
                self._mtime = 0.0

    def maybe_reload(self) -> bool:
        """If autoreload enabled and DB mtime changed since last load, reload."""
        if not self.autoreload or not self.db_path.exists():
            return False
        try:
            current_mtime = self.db_path.stat().st_mtime
        except OSError:
            return False
        if current_mtime > self._mtime:
            self.reload()
            return True
        return False

    def inject_prompt(self, base_prompt: str = "", meeting_title: str = "") -> str:
        """Build the initial_prompt fed to the speech engine."""
        with self._lock:
            terms = list(self._prompt_terms)
        parts = []
        if base_prompt:
            parts.append(base_prompt.strip())
        if meeting_title:
            parts.append(f"会议标题：{meeting_title}。")
        if terms:
            parts.append("常见术语：" + ", ".join(terms) + "。")
        return " ".join(parts).strip()

    def apply_replacements(self, text: str) -> tuple[str, int]:
        """Run the regex replacement pass. Returns (new_text, replacement_count)."""
        with self._lock:
            rules = list(self._replace_rules)
        out = text
        total = 0
        for term, canonical, pattern in rules:
            out, n = pattern.subn(canonical, out)
            total += n
        return out, total
```

- [ ] **Step 4: Run — PASS**

Run: `python3 -m pytest tests/test_stt_vocab_cache.py -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/stt_daemon/vocab_cache.py tests/test_stt_vocab_cache.py
git commit -m "feat(stt_daemon): add VocabCache with prompt injection + replacement pass"
```

## Task 2.3: STTBackend protocol + MockSTTBackend

**Files:**
- Create: `yulu/scripts/stt_daemon/runtime.py` (initial: protocol + mock; real engines in Phase 3)
- Create: `tests/test_stt_runtime_mock.py`

- [ ] **Step 1: Write failing tests**

Write `tests/test_stt_runtime_mock.py`:

```python
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.runtime import (
    STTResult, CancelToken, MockSTTBackend, STTRuntime,
)


def test_cancel_token_is_set_and_check():
    tok = CancelToken()
    assert tok.cancelled is False
    tok.cancel()
    assert tok.cancelled is True


def test_mock_backend_returns_canned_result():
    async def go():
        backend = MockSTTBackend(canned_text="hello world")
        result = await backend.transcribe(
            audio_path="/tmp/x.wav", language="en",
            initial_prompt="ctx", cancel_token=CancelToken(),
        )
        return result, backend.last_initial_prompt
    result, prompt = asyncio.run(go())
    assert isinstance(result, STTResult)
    assert result.text == "hello world"
    assert prompt == "ctx"


def test_mock_backend_respects_cancel():
    async def go():
        backend = MockSTTBackend(canned_text="x", delay_sec=0.5)
        tok = CancelToken()
        tok.cancel()  # pre-cancelled
        import pytest as _p
        with _p.raises(asyncio.CancelledError):
            await backend.transcribe(
                audio_path="/x", language="en",
                initial_prompt="", cancel_token=tok,
            )
    asyncio.run(go())


def test_runtime_routes_by_engine():
    async def go():
        mlx = MockSTTBackend(canned_text="from-mlx")
        whisper = MockSTTBackend(canned_text="from-whisper")
        runtime = STTRuntime(backends={"mlx": mlx, "whisper": whisper})
        await runtime.warm_up("mlx")
        r1 = await runtime.transcribe(
            audio_path="/x", language="zh", initial_prompt="",
            cancel_token=CancelToken(), engine="mlx",
        )
        r2 = await runtime.transcribe(
            audio_path="/x", language="zh", initial_prompt="",
            cancel_token=CancelToken(), engine="whisper",
        )
        return r1.text, r2.text, runtime.is_ready("mlx"), runtime.is_ready("whisper")
    t1, t2, mlx_ready, whisper_ready = asyncio.run(go())
    assert t1 == "from-mlx"
    assert t2 == "from-whisper"
    assert mlx_ready is True
    assert whisper_ready is False  # only warmed mlx


def test_runtime_self_reset_after_three_failures():
    async def go():
        flaky = MockSTTBackend(canned_text="ok", raise_first_n=3)
        runtime = STTRuntime(backends={"mlx": flaky}, reset_threshold=3)
        # 3 failures in a row should reset
        for _ in range(3):
            try:
                await runtime.transcribe(
                    audio_path="/x", language="zh", initial_prompt="",
                    cancel_token=CancelToken(), engine="mlx",
                )
            except RuntimeError:
                pass
        return runtime.failure_count("mlx"), flaky.reset_count
    failures, resets = asyncio.run(go())
    assert resets >= 1
    assert failures == 0  # reset zeroes the counter
```

- [ ] **Step 2: Run — FAIL with ImportError**

Run: `python3 -m pytest tests/test_stt_runtime_mock.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement runtime scaffolding (no real engines yet)**

Write `yulu/scripts/stt_daemon/runtime.py`:

```python
"""STTRuntime — model lifecycle + engine dispatch.

This module ships the STTBackend Protocol and the MockSTTBackend used
by tests. Real mlx-whisper and whisper-cli backends are added in Phase 3
of the implementation plan.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Protocol, Optional


@dataclass
class STTResult:
    text: str
    raw_text: str
    segments: list[dict] = field(default_factory=list)
    language: Optional[str] = None
    duration_ms: int = 0


class CancelToken:
    def __init__(self) -> None:
        self._cancelled = False

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    def cancel(self) -> None:
        self._cancelled = True

    def check(self) -> None:
        if self._cancelled:
            raise asyncio.CancelledError("job cancelled")


class STTBackend(Protocol):
    async def warm_up(self) -> None: ...
    async def transcribe(
        self,
        *,
        audio_path: str,
        language: str,
        initial_prompt: str,
        cancel_token: CancelToken,
    ) -> STTResult: ...
    def is_ready(self) -> bool: ...
    def release(self) -> None: ...


class MockSTTBackend:
    """Deterministic backend used in unit + integration tests."""

    def __init__(
        self,
        canned_text: str = "mock transcript",
        delay_sec: float = 0.0,
        raise_first_n: int = 0,
    ):
        self.canned_text = canned_text
        self.delay_sec = delay_sec
        self.raise_first_n = raise_first_n
        self.calls = 0
        self.reset_count = 0
        self.last_initial_prompt: Optional[str] = None
        self._ready = False

    async def warm_up(self) -> None:
        self._ready = True

    async def transcribe(
        self,
        *,
        audio_path: str,
        language: str,
        initial_prompt: str,
        cancel_token: CancelToken,
    ) -> STTResult:
        self.calls += 1
        self.last_initial_prompt = initial_prompt
        cancel_token.check()
        if self.calls <= self.raise_first_n:
            raise RuntimeError(f"mock failure {self.calls}")
        if self.delay_sec:
            await asyncio.sleep(self.delay_sec)
        cancel_token.check()
        return STTResult(
            text=self.canned_text,
            raw_text=self.canned_text,
            segments=[{"start_ms": 0, "end_ms": 1000, "text": self.canned_text}],
            language=language,
            duration_ms=int(self.delay_sec * 1000),
        )

    def is_ready(self) -> bool:
        return self._ready

    def release(self) -> None:
        self._ready = False
        self.reset_count += 1


class STTRuntime:
    """Owns one or more STTBackend instances; tracks readiness + failure counts."""

    def __init__(self, backends: dict[str, STTBackend], reset_threshold: int = 3):
        if not backends:
            raise ValueError("at least one backend required")
        self.backends = backends
        self.reset_threshold = reset_threshold
        self._failure_counts: dict[str, int] = {k: 0 for k in backends}

    def is_ready(self, engine: str) -> bool:
        return engine in self.backends and self.backends[engine].is_ready()

    def failure_count(self, engine: str) -> int:
        return self._failure_counts.get(engine, 0)

    async def warm_up(self, engine: str) -> None:
        if engine not in self.backends:
            raise ValueError(f"unknown engine: {engine}")
        await self.backends[engine].warm_up()

    async def transcribe(
        self,
        *,
        audio_path: str,
        language: str,
        initial_prompt: str,
        cancel_token: CancelToken,
        engine: str,
    ) -> STTResult:
        if engine not in self.backends:
            raise ValueError(f"unknown engine: {engine}")
        backend = self.backends[engine]
        if not backend.is_ready():
            await backend.warm_up()
        try:
            result = await backend.transcribe(
                audio_path=audio_path,
                language=language,
                initial_prompt=initial_prompt,
                cancel_token=cancel_token,
            )
            self._failure_counts[engine] = 0
            return result
        except (asyncio.CancelledError, ValueError):
            raise
        except Exception:
            self._failure_counts[engine] += 1
            if self._failure_counts[engine] >= self.reset_threshold:
                backend.release()
                self._failure_counts[engine] = 0
            raise

    async def shutdown(self) -> None:
        for backend in self.backends.values():
            backend.release()
```

- [ ] **Step 4: Run — PASS**

Run: `python3 -m pytest tests/test_stt_runtime_mock.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/stt_daemon/runtime.py tests/test_stt_runtime_mock.py
git commit -m "feat(stt_daemon): add STTBackend Protocol, MockSTTBackend, STTRuntime with self-reset"
```

## Task 2.4: STTScheduler — slots + priority queue + cancellation

**Files:**
- Create: `yulu/scripts/stt_daemon/scheduler.py`
- Create: `tests/test_stt_scheduler.py`

- [ ] **Step 1: Write failing tests**

Write `tests/test_stt_scheduler.py`:

```python
import asyncio
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.protocol import JobKind
from stt_daemon.runtime import MockSTTBackend, STTRuntime, CancelToken
from stt_daemon.scheduler import STTScheduler, Job


def _make_runtime():
    backend = MockSTTBackend(canned_text="x", delay_sec=0.05)
    return STTRuntime(backends={"mlx": backend}), backend


async def _submit(scheduler, kind, sid=None):
    job = Job(
        job_id=str(uuid.uuid4()),
        kind=kind,
        engine="mlx",
        language="zh",
        audio_path="/tmp/x.wav",
        initial_prompt="",
        session_id=sid,
    )
    fut = await scheduler.submit(job)
    return job.job_id, fut


def test_background_priority_final_beats_live(tmp_path):
    async def go():
        runtime, _ = _make_runtime()
        scheduler = STTScheduler(runtime=runtime)
        await scheduler.start()
        order = []

        async def watch(label, fut):
            await fut
            order.append(label)

        # Submit live first, then file, then final
        _, f_live = await _submit(scheduler, JobKind.LIVE_CHUNK, sid="s1")
        _, f_file = await _submit(scheduler, JobKind.FILE_TRANSCRIBE)
        _, f_final = await _submit(scheduler, JobKind.FINAL_TRANSCRIBE)

        await asyncio.gather(
            watch("live", f_live),
            watch("file", f_file),
            watch("final", f_final),
        )
        await scheduler.stop()
        return order
    order = asyncio.run(go())
    # Live was already running when final arrived, so live finishes first;
    # but among queued, final > file (file shouldn't run before final).
    assert order.index("final") < order.index("file")


def test_dictation_routed_to_interactive_slot(tmp_path):
    async def go():
        runtime, _ = _make_runtime()
        scheduler = STTScheduler(runtime=runtime)
        await scheduler.start()
        # Submit a long-running final + a dictation; dictation must run
        # concurrently (own slot), not be queued behind final.
        runtime.backends["mlx"].delay_sec = 0.2
        _, f_final = await _submit(scheduler, JobKind.FINAL_TRANSCRIBE)
        _, f_dict = await _submit(scheduler, JobKind.DICTATION)
        # Dictation should complete close to its delay, not after final.
        import time
        t0 = time.monotonic()
        await f_dict
        elapsed = time.monotonic() - t0
        await f_final
        await scheduler.stop()
        return elapsed
    elapsed = asyncio.run(go())
    assert elapsed < 0.35, f"dictation queued behind final (elapsed={elapsed})"


def test_cancel_drops_queued_job(tmp_path):
    async def go():
        runtime, backend = _make_runtime()
        scheduler = STTScheduler(runtime=runtime)
        await scheduler.start()
        # Make backend slow so we can race
        backend.delay_sec = 0.3
        # Block the background slot
        id_block, _ = await _submit(scheduler, JobKind.FINAL_TRANSCRIBE)
        # Queue another job
        id_q, fut_q = await _submit(scheduler, JobKind.FILE_TRANSCRIBE)
        cancelled = await scheduler.cancel(id_q)
        assert cancelled is True
        try:
            await fut_q
        except asyncio.CancelledError:
            pass
        await scheduler.stop()
    asyncio.run(go())


def test_session_stop_cancels_remaining_live_chunks(tmp_path):
    async def go():
        runtime, backend = _make_runtime()
        scheduler = STTScheduler(runtime=runtime)
        await scheduler.start()
        backend.delay_sec = 0.5
        # Block scheduler with a long final, queue live_chunks for sid=A
        await _submit(scheduler, JobKind.FINAL_TRANSCRIBE)
        _, f1 = await _submit(scheduler, JobKind.LIVE_CHUNK, sid="A")
        _, f2 = await _submit(scheduler, JobKind.LIVE_CHUNK, sid="A")
        n_cancelled = await scheduler.cancel_session("A")
        assert n_cancelled == 2
        for f in (f1, f2):
            try:
                await f
            except asyncio.CancelledError:
                pass
        await scheduler.stop()
    asyncio.run(go())


def test_live_chunk_queue_drops_oldest(tmp_path):
    async def go():
        runtime, backend = _make_runtime()
        scheduler = STTScheduler(runtime=runtime, live_chunk_max_per_session=2)
        await scheduler.start()
        backend.delay_sec = 0.3
        # Block scheduler
        await _submit(scheduler, JobKind.FINAL_TRANSCRIBE)
        # 4 live chunks; first two should be dropped to make room
        ids = []
        for _ in range(4):
            jid, _ = await _submit(scheduler, JobKind.LIVE_CHUNK, sid="B")
            ids.append(jid)
        # Two oldest should be cancelled
        cancelled = [i for i in ids if not scheduler.is_pending(i)]
        # Hard guarantee: at least 2 of the 4 are not pending after admission
        await scheduler.stop()
        return len(cancelled)
    n = asyncio.run(go())
    assert n >= 2
```

- [ ] **Step 2: Run — FAIL with ImportError**

Run: `python3 -m pytest tests/test_stt_scheduler.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement scheduler**

Write `yulu/scripts/stt_daemon/scheduler.py`:

```python
"""STTScheduler — two-slot worker model with priority queue + cancellation."""

from __future__ import annotations

import asyncio
import heapq
import itertools
from dataclasses import dataclass, field
from typing import Optional

from .protocol import JobKind
from .runtime import CancelToken, STTResult, STTRuntime


@dataclass
class Job:
    job_id: str
    kind: JobKind
    engine: str
    language: str
    audio_path: str
    initial_prompt: str = ""
    session_id: Optional[str] = None
    meeting_title: Optional[str] = None
    options: dict = field(default_factory=dict)


@dataclass(order=True)
class _Queued:
    priority: int
    seq: int
    job: Job = field(compare=False)
    future: asyncio.Future = field(compare=False)
    cancel_token: CancelToken = field(compare=False)
    cancelled: bool = field(default=False, compare=False)


class STTScheduler:
    def __init__(
        self,
        *,
        runtime: STTRuntime,
        live_chunk_max_per_session: int = 4,
    ):
        self.runtime = runtime
        self.live_chunk_max_per_session = live_chunk_max_per_session
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._counter = itertools.count()
        self._interactive_queue: list[_Queued] = []
        self._background_queue: list[_Queued] = []
        self._interactive_event = asyncio.Event()
        self._background_event = asyncio.Event()
        self._all_jobs: dict[str, _Queued] = {}
        self._workers: list[asyncio.Task] = []
        self._stopped = False

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._workers.append(
            asyncio.create_task(self._slot_worker("interactive", self._interactive_queue, self._interactive_event))
        )
        self._workers.append(
            asyncio.create_task(self._slot_worker("background", self._background_queue, self._background_event))
        )

    async def stop(self) -> None:
        self._stopped = True
        self._interactive_event.set()
        self._background_event.set()
        for w in self._workers:
            w.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()

    async def submit(self, job: Job) -> asyncio.Future:
        if self._loop is None:
            raise RuntimeError("scheduler not started")
        fut: asyncio.Future = self._loop.create_future()
        tok = CancelToken()
        queued = _Queued(
            priority=job.kind.priority,
            seq=next(self._counter),
            job=job,
            future=fut,
            cancel_token=tok,
        )
        self._all_jobs[job.job_id] = queued

        if job.kind.slot == "interactive":
            heapq.heappush(self._interactive_queue, queued)
            self._interactive_event.set()
        else:
            self._enforce_live_chunk_cap(job)
            heapq.heappush(self._background_queue, queued)
            self._background_event.set()
        return fut

    def _enforce_live_chunk_cap(self, incoming: Job) -> None:
        if incoming.kind is not JobKind.LIVE_CHUNK or incoming.session_id is None:
            return
        same = [
            q for q in self._background_queue
            if q.job.kind is JobKind.LIVE_CHUNK
            and q.job.session_id == incoming.session_id
            and not q.cancelled
        ]
        # +1 to account for the incoming job we're about to push
        over = len(same) + 1 - self.live_chunk_max_per_session
        if over <= 0:
            return
        # Drop oldest (smallest seq) first
        same.sort(key=lambda q: q.seq)
        for q in same[:over]:
            self._cancel_queued(q, reason="queue_full")

    async def cancel(self, job_id: str) -> bool:
        q = self._all_jobs.get(job_id)
        if not q or q.future.done():
            return False
        return self._cancel_queued(q, reason="user_cancel")

    async def cancel_session(self, sid: str) -> int:
        n = 0
        for q in list(self._all_jobs.values()):
            if q.job.session_id == sid and q.job.kind is JobKind.LIVE_CHUNK and not q.future.done():
                if self._cancel_queued(q, reason="session_stop"):
                    n += 1
        return n

    def _cancel_queued(self, queued: _Queued, *, reason: str) -> bool:
        if queued.cancelled or queued.future.done():
            return False
        queued.cancelled = True
        queued.cancel_token.cancel()
        if not queued.future.done():
            queued.future.cancel()
        return True

    def is_pending(self, job_id: str) -> bool:
        q = self._all_jobs.get(job_id)
        if q is None:
            return False
        return not (q.cancelled or q.future.done())

    def in_flight_count(self) -> int:
        return sum(1 for q in self._all_jobs.values() if not q.future.done())

    async def _slot_worker(
        self,
        name: str,
        queue: list[_Queued],
        event: asyncio.Event,
    ) -> None:
        while not self._stopped:
            await event.wait()
            if self._stopped:
                return
            # Pop next non-cancelled job
            queued: Optional[_Queued] = None
            while queue:
                candidate = heapq.heappop(queue)
                if not candidate.cancelled and not candidate.future.done():
                    queued = candidate
                    break
            if queued is None:
                event.clear()
                continue
            try:
                result = await self.runtime.transcribe(
                    audio_path=queued.job.audio_path,
                    language=queued.job.language,
                    initial_prompt=queued.job.initial_prompt,
                    cancel_token=queued.cancel_token,
                    engine=queued.job.engine,
                )
                if not queued.future.done():
                    queued.future.set_result(result)
            except asyncio.CancelledError:
                if not queued.future.done():
                    queued.future.cancel()
            except Exception as exc:
                if not queued.future.done():
                    queued.future.set_exception(exc)
            finally:
                if not queue:
                    event.clear()
```

- [ ] **Step 4: Run — PASS**

Run: `python3 -m pytest tests/test_stt_scheduler.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/stt_daemon/scheduler.py tests/test_stt_scheduler.py
git commit -m "feat(stt_daemon): add STTScheduler with two-slot priority queue + cancellation + live_chunk cap"
```

## Task 2.5: ControlServer + app composition root + entry point

**Files:**
- Create: `yulu/scripts/stt_daemon/config.py`
- Create: `yulu/scripts/stt_daemon/control_server.py`
- Create: `yulu/scripts/stt_daemon/app.py`
- Create: `yulu/scripts/stt_daemon/__main__.py`
- Create: `tests/test_stt_control_server.py`

- [ ] **Step 1: Write failing integration test**

Write `tests/test_stt_control_server.py`:

```python
import asyncio
import json
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from vocab import VocabRepo, Scope, open_db
from stt_daemon.app import STTDaemonApp
from stt_daemon.config import DaemonConfig
from stt_daemon.runtime import MockSTTBackend


def _build_app(tmp_path):
    db = tmp_path / "vocab.sqlite"
    repo = VocabRepo(open_db(db))
    repo.add(term="Kubernetes", canonical="Kubernetes", scope=Scope.PROMPT)
    repo.add(term="github", canonical="GitHub", scope=Scope.BOTH)
    cfg = DaemonConfig(
        socket_path=tmp_path / "stt.sock",
        vocab_db_path=db,
        pid_file=tmp_path / "stt.pid",
        log_path=None,
        sessions_dir=tmp_path / "sessions",
    )
    backends = {"mlx": MockSTTBackend(canned_text="HELLO github world")}
    return STTDaemonApp(cfg, backends=backends)


async def _send(socket_path: Path, lines: list[str]) -> list[str]:
    reader, writer = await asyncio.open_unix_connection(str(socket_path))
    for line in lines:
        writer.write((line if line.endswith("\n") else line + "\n").encode())
    await writer.drain()
    results: list[str] = []
    for _ in lines:
        line = await reader.readline()
        if not line:
            break
        results.append(line.decode())
    writer.close()
    try:
        await writer.wait_closed()
    except (ConnectionResetError, BrokenPipeError):
        pass
    return results


def test_health_returns_loaded(tmp_path):
    async def go():
        app = _build_app(tmp_path)
        await app.start()
        try:
            results = await _send(app.config.socket_path, ['{"type":"health"}'])
            return results
        finally:
            await app.stop()
    results = asyncio.run(go())
    payload = json.loads(results[0])
    assert payload["type"] == "health_response"
    assert payload["vocab_size"] >= 2


def test_transcribe_applies_vocab(tmp_path):
    async def go():
        app = _build_app(tmp_path)
        await app.start()
        try:
            req = {
                "type": "transcribe",
                "job_id": str(uuid.uuid4()),
                "kind": "final_transcribe",
                "engine": "mlx",
                "language": "zh",
                "audio_path": "/tmp/dummy.wav",
                "audio_offset_bytes": 0,
                "audio_length_bytes": None,
                "audio_format": "wav-pcm-s16le-16k-mono",
                "meeting_title": "T",
                "session_id": None,
                "word_timestamps": False,
                "condition_on_previous": True,
                "hallucination_silence_threshold": 2.0,
                "timeout_sec": 7200,
            }
            results = await _send(app.config.socket_path, [json.dumps(req)])
            return results
        finally:
            await app.stop()
    payload = json.loads(asyncio.run(go())[0])
    assert payload["type"] == "transcribe_result"
    assert payload["status"] == "ok"
    # MockSTTBackend returns "HELLO github world"; cache should rewrite to GitHub
    assert "GitHub" in payload["text"]
    # initial_prompt should contain Kubernetes (the only prompt term we added)
    assert payload["vocab_prompt_terms_count"] >= 1


def test_vocab_reload_applies_new_rows(tmp_path):
    async def go():
        app = _build_app(tmp_path)
        await app.start()
        try:
            # add a new row + send reload
            repo = VocabRepo(open_db(app.config.vocab_db_path))
            repo.add(term="hello", canonical="HELLO!!", scope=Scope.BOTH)
            results = await _send(app.config.socket_path, ['{"type":"vocab_reload"}'])
            payload = json.loads(results[0])
            return payload
        finally:
            await app.stop()
    payload = asyncio.run(go())
    assert payload["type"] == "vocab_reloaded"
    assert payload["replace_rules"] >= 2
```

- [ ] **Step 2: Run — FAIL**

Run: `python3 -m pytest tests/test_stt_control_server.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement config**

Write `yulu/scripts/stt_daemon/config.py`:

```python
"""Daemon config — loaded from ~/.config/yulu/config.json `stt_daemon` section."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


HOME_DIR = Path.home() / ".config" / "yulu"


@dataclass
class DaemonConfig:
    socket_path: Path = field(default_factory=lambda: HOME_DIR / "stt_daemon.sock")
    pid_file: Path = field(default_factory=lambda: HOME_DIR / "stt_daemon.pid")
    log_path: Optional[Path] = field(default_factory=lambda: HOME_DIR / "logs" / "stt_daemon.log")
    vocab_db_path: Path = field(default_factory=lambda: HOME_DIR / "vocab.sqlite")
    sessions_dir: Path = field(default_factory=lambda: HOME_DIR / "sessions")
    default_engine: str = "mlx"
    default_language: str = "zh"
    mlx_python: str = ""           # absolute path to venv python, set in real backend
    mlx_model: str = "mlx-community/whisper-large-v3-mlx"
    whisper_cli: str = "whisper-cli"
    whisper_model: str = ""
    live_chunk_max_per_session: int = 4
    max_concurrent_connections: int = 100

    @classmethod
    def from_user_config(cls, path: Optional[Path] = None) -> "DaemonConfig":
        if path is None:
            path = HOME_DIR / "config.json"
        cfg = cls()
        if not path.exists():
            return cfg
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return cfg
        sd = data.get("stt_daemon", {})
        trans = data.get("transcription", {})
        mlx = trans.get("mlx", {})
        if mlx.get("python"):
            cfg.mlx_python = str(Path(mlx["python"]).expanduser())
        if mlx.get("model"):
            cfg.mlx_model = mlx["model"]
        if trans.get("whisper_cli"):
            cfg.whisper_cli = trans["whisper_cli"]
        if trans.get("local_model_path"):
            cfg.whisper_model = str(Path(trans["local_model_path"]).expanduser())
        if trans.get("language"):
            cfg.default_language = trans["language"]
        if sd.get("default_engine"):
            cfg.default_engine = sd["default_engine"]
        if sd.get("live_chunk_max_per_session"):
            cfg.live_chunk_max_per_session = int(sd["live_chunk_max_per_session"])
        return cfg
```

- [ ] **Step 4: Implement ControlServer**

Write `yulu/scripts/stt_daemon/control_server.py`:

```python
"""Asyncio Unix-socket server: routes incoming lines to handlers."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Awaitable, Callable, Optional

from .logging import JsonLogger
from .protocol import (
    HealthRequest, WarmUpRequest, VocabReloadRequest,
    TranscribeRequest, CancelRequest,
    SubscribeSessionRequest, UnsubscribeSessionRequest,
    decode, encode,
)


HandlerResult = Awaitable[Optional[object]]
Handler = Callable[[object, asyncio.StreamWriter], HandlerResult]


class ControlServer:
    def __init__(
        self,
        *,
        socket_path: Path,
        logger: JsonLogger,
        max_connections: int = 100,
    ):
        self.socket_path = Path(socket_path)
        self.logger = logger
        self.max_connections = max_connections
        self._handlers: dict[type, Handler] = {}
        self._server: Optional[asyncio.AbstractServer] = None
        self._active = 0

    def register(self, msg_cls: type, handler: Handler) -> None:
        self._handlers[msg_cls] = handler

    async def start(self) -> None:
        if self.socket_path.exists():
            self.socket_path.unlink()
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        self._server = await asyncio.start_unix_server(
            self._handle_client, path=str(self.socket_path)
        )
        self.logger.info("control_server_started", path=str(self.socket_path))

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        if self.socket_path.exists():
            try:
                self.socket_path.unlink()
            except OSError:
                pass

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        if self._active >= self.max_connections:
            self.logger.warn("connection_rejected", active=self._active)
            writer.close()
            return
        self._active += 1
        try:
            while True:
                line = await reader.readline()
                if not line:
                    return
                try:
                    msg = decode(line.decode().strip())
                except ValueError as exc:
                    from .protocol import ErrorEvent, ErrorCode
                    writer.write(encode(ErrorEvent(
                        code=ErrorCode.INTERNAL,
                        message=f"decode error: {exc}",
                    )).encode())
                    await writer.drain()
                    continue

                handler = self._handlers.get(type(msg))
                if handler is None:
                    from .protocol import ErrorEvent, ErrorCode
                    writer.write(encode(ErrorEvent(
                        code=ErrorCode.INTERNAL,
                        message=f"no handler for {type(msg).__name__}",
                    )).encode())
                    await writer.drain()
                    continue

                try:
                    response = await handler(msg, writer)
                except Exception as exc:
                    self.logger.error("handler_failed", error=str(exc), type=type(msg).__name__)
                    from .protocol import ErrorEvent, ErrorCode
                    response = ErrorEvent(code=ErrorCode.INTERNAL, message=str(exc))

                if response is not None:
                    writer.write(encode(response).encode())
                    await writer.drain()
        finally:
            self._active -= 1
            try:
                writer.close()
                await writer.wait_closed()
            except (ConnectionResetError, BrokenPipeError):
                pass
```

- [ ] **Step 5: Implement composition root**

Write `yulu/scripts/stt_daemon/app.py`:

```python
"""STTDaemonApp — wires scheduler, runtime, vocab cache, control server, sessions."""

from __future__ import annotations

import asyncio
import os
import signal
import uuid
from pathlib import Path
from typing import Optional

from .config import DaemonConfig
from .control_server import ControlServer
from .logging import JsonLogger, open_log_sink
from .protocol import (
    JobKind, ErrorCode, ErrorEvent, OkResponse,
    HealthRequest, HealthResponse,
    WarmUpRequest,
    VocabReloadRequest, VocabReloadedResponse,
    TranscribeRequest, TranscribeResponse,
    CancelRequest,
    SubscribeSessionRequest, UnsubscribeSessionRequest,
)
from .runtime import STTRuntime, STTBackend
from .scheduler import STTScheduler, Job
from .vocab_cache import VocabCache


class STTDaemonApp:
    def __init__(
        self,
        config: DaemonConfig,
        *,
        backends: dict[str, STTBackend],
    ):
        self.config = config
        self.logger = JsonLogger(open_log_sink(config.log_path))
        self.vocab_cache = VocabCache(config.vocab_db_path, autoreload=True)
        self.runtime = STTRuntime(backends=backends)
        self.scheduler = STTScheduler(
            runtime=self.runtime,
            live_chunk_max_per_session=config.live_chunk_max_per_session,
        )
        self.control_server = ControlServer(
            socket_path=config.socket_path,
            logger=self.logger,
            max_connections=config.max_concurrent_connections,
        )
        self._active_sessions: dict[str, "_SessionEntry"] = {}

    async def start(self) -> None:
        self.vocab_cache.load()
        await self.scheduler.start()
        self._register_handlers()
        await self.control_server.start()
        self._write_pid()
        self._install_signal_handlers()
        self.logger.info("daemon_ready", vocab=len(self.vocab_cache.prompt_terms))

    async def stop(self) -> None:
        await self.control_server.stop()
        await self.scheduler.stop()
        await self.runtime.shutdown()
        self._remove_pid()
        self.logger.info("daemon_stopped")

    def _register_handlers(self) -> None:
        cs = self.control_server
        cs.register(HealthRequest, self._on_health)
        cs.register(WarmUpRequest, self._on_warm_up)
        cs.register(VocabReloadRequest, self._on_vocab_reload)
        cs.register(TranscribeRequest, self._on_transcribe)
        cs.register(CancelRequest, self._on_cancel)
        cs.register(SubscribeSessionRequest, self._on_subscribe_session)
        cs.register(UnsubscribeSessionRequest, self._on_unsubscribe_session)

    async def _on_health(self, msg, writer):
        return HealthResponse(
            ready=True,
            model_loaded=any(self.runtime.is_ready(e) for e in self.runtime.backends),
            vocab_size=len(self.vocab_cache.prompt_terms) + len(self.vocab_cache.replace_rules),
            in_flight_jobs=self.scheduler.in_flight_count(),
            active_sessions=len(self._active_sessions),
        )

    async def _on_warm_up(self, msg: WarmUpRequest, writer):
        engine = msg.engine or self.config.default_engine
        try:
            await self.runtime.warm_up(engine)
            return OkResponse(detail=f"warmed {engine}")
        except Exception as exc:
            return ErrorEvent(code=ErrorCode.ENGINE_UNAVAILABLE, message=str(exc))

    async def _on_vocab_reload(self, msg, writer):
        self.vocab_cache.reload()
        return VocabReloadedResponse(
            prompt_terms=len(self.vocab_cache.prompt_terms),
            replace_rules=len(self.vocab_cache.replace_rules),
        )

    async def _on_transcribe(self, msg: TranscribeRequest, writer):
        if not Path(msg.audio_path).exists():
            return ErrorEvent(
                job_id=msg.job_id,
                code=ErrorCode.AUDIO_NOT_FOUND,
                message=f"audio not found: {msg.audio_path}",
            )
        self.vocab_cache.maybe_reload()
        initial_prompt = self.vocab_cache.inject_prompt(
            meeting_title=msg.meeting_title or "",
        )
        job = Job(
            job_id=msg.job_id,
            kind=msg.kind,
            engine=msg.engine,
            language=msg.language,
            audio_path=msg.audio_path,
            initial_prompt=initial_prompt,
            session_id=msg.session_id,
            meeting_title=msg.meeting_title,
        )
        fut = await self.scheduler.submit(job)
        try:
            result = await fut
        except asyncio.CancelledError:
            return TranscribeResponse(
                job_id=msg.job_id, status="cancelled",
                engine_used=msg.engine, language_used=msg.language,
                text="", raw_text="", segments=[],
                vocab_prompt_terms_count=0, vocab_replacements_count=0,
                duration_ms=0, error="cancelled",
            )
        except Exception as exc:
            return ErrorEvent(job_id=msg.job_id, code=ErrorCode.INTERNAL, message=str(exc))

        cleaned, n_replace = self.vocab_cache.apply_replacements(result.text)
        return TranscribeResponse(
            job_id=msg.job_id,
            status="ok",
            engine_used=msg.engine,
            language_used=result.language or msg.language,
            text=cleaned,
            raw_text=result.raw_text,
            segments=result.segments,
            vocab_prompt_terms_count=initial_prompt.count(",") + (1 if initial_prompt else 0),
            vocab_replacements_count=n_replace,
            duration_ms=result.duration_ms,
        )

    async def _on_cancel(self, msg: CancelRequest, writer):
        ok = await self.scheduler.cancel(msg.job_id)
        return OkResponse(detail="cancelled" if ok else "not_found")

    async def _on_subscribe_session(self, msg: SubscribeSessionRequest, writer):
        # Live sessions implemented in Phase 4. For now reject explicitly so
        # the protocol surface is correct and tests for Phase 4 will replace
        # this stub.
        return ErrorEvent(
            code=ErrorCode.INTERNAL,
            message="subscribe_session not implemented until Phase 4",
        )

    async def _on_unsubscribe_session(self, msg: UnsubscribeSessionRequest, writer):
        return ErrorEvent(
            code=ErrorCode.INTERNAL,
            message="unsubscribe_session not implemented until Phase 4",
        )

    def _write_pid(self) -> None:
        self.config.pid_file.parent.mkdir(parents=True, exist_ok=True)
        self.config.pid_file.write_text(str(os.getpid()), encoding="utf-8")

    def _remove_pid(self) -> None:
        try:
            self.config.pid_file.unlink()
        except FileNotFoundError:
            pass

    def _install_signal_handlers(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, lambda s=sig: asyncio.create_task(self._handle_signal(s)))
            except NotImplementedError:
                # Windows; not relevant on macOS
                pass
        try:
            loop.add_signal_handler(signal.SIGHUP, self._on_sighup)
        except NotImplementedError:
            pass

    def _on_sighup(self) -> None:
        self.vocab_cache.reload()
        self.logger.info("vocab_reloaded_via_sighup",
                          terms=len(self.vocab_cache.prompt_terms),
                          rules=len(self.vocab_cache.replace_rules))

    async def _handle_signal(self, sig) -> None:
        self.logger.info("signal_received", sig=int(sig))
        await self.stop()


class _SessionEntry:
    """Placeholder; replaced by Phase 4."""
    pass
```

- [ ] **Step 6: Implement entry point**

Write `yulu/scripts/stt_daemon/__main__.py`:

```python
"""Entry point: `python -m stt_daemon` or `python -m stt_daemon.__main__`."""

from __future__ import annotations

import asyncio
import sys

from .app import STTDaemonApp
from .config import DaemonConfig


def _build_real_backends(config: DaemonConfig):
    """Return real backends. Implemented in Phase 3.

    Phase 2 entry point only supports mock for development; a real run
    swaps these in via Phase 3's wiring.
    """
    from .runtime import MockSTTBackend
    return {
        "mlx": MockSTTBackend(canned_text="(mock — install Phase 3 backends)"),
        "whisper": MockSTTBackend(canned_text="(mock whisper-cli)"),
    }


async def _run() -> int:
    cfg = DaemonConfig.from_user_config()
    backends = _build_real_backends(cfg)
    app = STTDaemonApp(cfg, backends=backends)
    await app.start()
    try:
        # Park forever; signals shut down via app
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        await app.stop()
    return 0


def main() -> int:
    try:
        return asyncio.run(_run())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 7: Run integration tests — PASS**

Run: `python3 -m pytest tests/test_stt_control_server.py -v`
Expected: 3 passed.

- [ ] **Step 8: Sanity check — daemon starts standalone**

Run:
```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
PYTHONPATH=yulu/scripts timeout 2 python3 -m stt_daemon 2>&1 | head -3 || true
```
Expected: `{"ts":"...","event":"daemon_ready",...}` line on stderr, then SIGTERM via timeout.

- [ ] **Step 9: Commit**

```bash
git add yulu/scripts/stt_daemon/config.py yulu/scripts/stt_daemon/control_server.py yulu/scripts/stt_daemon/app.py yulu/scripts/stt_daemon/__main__.py tests/test_stt_control_server.py
git commit -m "feat(stt_daemon): wire control server + app composition root + entry point"
```

---

# Phase 3 — Real STT Backends (MLX + whisper-cli)

**Outcome:** Daemon transcribes real audio via mlx-whisper (in-process) or whisper-cli (subprocess). Mocks still used for unit/integration tests; an opt-in `e2e` suite exercises the real path.

## Task 3.1: MLX backend

**Files:**
- Create: `yulu/scripts/stt_daemon/backends/__init__.py`
- Create: `yulu/scripts/stt_daemon/backends/mlx.py`
- Create: `tests/test_stt_backend_mlx.py`

- [ ] **Step 1: Create backends package marker**

Write `yulu/scripts/stt_daemon/backends/__init__.py`:

```python
"""Real STT backends: mlx-whisper, whisper-cli."""
```

- [ ] **Step 2: Write tests for MLX backend (no real model — use monkeypatch)**

Write `tests/test_stt_backend_mlx.py`:

```python
import asyncio
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.backends.mlx import MlxWhisperBackend
from stt_daemon.runtime import CancelToken


def _stub_module(text="hello", segments=None):
    """Return a fake mlx_whisper module with controlled transcribe()."""
    fake = MagicMock()
    fake.transcribe.return_value = {
        "text": text,
        "segments": segments or [],
        "language": "zh",
    }
    return fake


def test_mlx_backend_lazy_loads_module(monkeypatch):
    """Backend must NOT import mlx_whisper at construction time."""
    monkeypatch.setitem(sys.modules, "mlx_whisper", None)  # importing should fail
    backend = MlxWhisperBackend(model="dummy-model", language="zh")
    assert backend.is_ready() is False  # not loaded yet


def test_mlx_backend_uses_initial_prompt(monkeypatch):
    fake = _stub_module(text="GitHub rules")
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    backend = MlxWhisperBackend(model="dummy", language="zh")

    async def go():
        await backend.warm_up()
        result = await backend.transcribe(
            audio_path="/tmp/x.wav",
            language="zh",
            initial_prompt="ctx: ABC",
            cancel_token=CancelToken(),
        )
        return result
    result = asyncio.run(go())
    assert result.text == "GitHub rules"
    call_kwargs = fake.transcribe.call_args.kwargs
    assert call_kwargs.get("initial_prompt") == "ctx: ABC"
    assert call_kwargs.get("path_or_hf_repo") == "dummy"


def test_mlx_backend_segment_format(monkeypatch):
    fake = _stub_module(
        text="raw text",
        segments=[
            {"start": 0.0, "end": 2.5, "text": "hello"},
            {"start": 2.5, "end": 5.0, "text": "world"},
        ],
    )
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    backend = MlxWhisperBackend(model="dummy", language="zh")

    async def go():
        await backend.warm_up()
        return await backend.transcribe(
            audio_path="/tmp/x.wav",
            language="zh",
            initial_prompt="",
            cancel_token=CancelToken(),
        )
    result = asyncio.run(go())
    assert len(result.segments) == 2
    assert result.segments[0]["start_ms"] == 0
    assert result.segments[1]["end_ms"] == 5000


def test_mlx_backend_propagates_cancel_pre_call(monkeypatch):
    fake = _stub_module()
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    backend = MlxWhisperBackend(model="dummy", language="zh")

    async def go():
        await backend.warm_up()
        tok = CancelToken()
        tok.cancel()
        with pytest.raises(asyncio.CancelledError):
            await backend.transcribe(
                audio_path="/tmp/x.wav",
                language="zh",
                initial_prompt="",
                cancel_token=tok,
            )
    asyncio.run(go())
```

- [ ] **Step 3: Run — FAIL with ImportError**

Run: `python3 -m pytest tests/test_stt_backend_mlx.py -v`
Expected: ImportError.

- [ ] **Step 4: Implement MLX backend**

Write `yulu/scripts/stt_daemon/backends/mlx.py`:

```python
"""mlx-whisper backend — in-process, lazy-loaded, single resident model."""

from __future__ import annotations

import asyncio
import importlib
from typing import Optional

from ..runtime import CancelToken, STTResult


class MlxWhisperBackend:
    """Wraps mlx_whisper.transcribe(). Model stays loaded after first call."""

    def __init__(
        self,
        *,
        model: str,
        language: str = "zh",
        condition_on_previous_text: bool = True,
        word_timestamps: bool = False,
        hallucination_silence_threshold: float = 2.0,
    ):
        self.model = model
        self.language = language
        self.condition_on_previous_text = condition_on_previous_text
        self.word_timestamps = word_timestamps
        self.hallucination_silence_threshold = hallucination_silence_threshold
        self._module = None
        self._ready = False
        self._lock = asyncio.Lock()

    def is_ready(self) -> bool:
        return self._ready

    async def warm_up(self) -> None:
        async with self._lock:
            if self._ready:
                return
            module = await asyncio.to_thread(importlib.import_module, "mlx_whisper")
            if module is None:
                raise RuntimeError("mlx_whisper module is unavailable")
            self._module = module
            # mlx_whisper has no explicit preload; first transcribe pays the
            # load cost. We mark ready optimistically — STTRuntime self-resets
            # if subsequent calls fail.
            self._ready = True

    def release(self) -> None:
        self._module = None
        self._ready = False

    async def transcribe(
        self,
        *,
        audio_path: str,
        language: str,
        initial_prompt: str,
        cancel_token: CancelToken,
    ) -> STTResult:
        cancel_token.check()
        if not self._ready:
            await self.warm_up()
        if self._module is None:
            raise RuntimeError("mlx_whisper module not loaded")

        def _run() -> dict:
            return self._module.transcribe(
                audio_path,
                path_or_hf_repo=self.model,
                language=language,
                task="transcribe",
                verbose=False,
                initial_prompt=initial_prompt or None,
                condition_on_previous_text=self.condition_on_previous_text,
                word_timestamps=self.word_timestamps,
                hallucination_silence_threshold=self.hallucination_silence_threshold,
            )

        result = await asyncio.to_thread(_run)
        cancel_token.check()

        text = (result.get("text") or "").strip()
        segments_raw = result.get("segments") or []
        segments = [
            {
                "start_ms": int(float(s.get("start", 0)) * 1000),
                "end_ms": int(float(s.get("end", s.get("start", 0))) * 1000),
                "text": (s.get("text") or "").strip(),
            }
            for s in segments_raw
        ]
        duration_ms = segments[-1]["end_ms"] if segments else 0
        return STTResult(
            text=text,
            raw_text=text,
            segments=segments,
            language=result.get("language") or language,
            duration_ms=duration_ms,
        )
```

- [ ] **Step 5: Run — PASS**

Run: `python3 -m pytest tests/test_stt_backend_mlx.py -v`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/stt_daemon/backends/__init__.py yulu/scripts/stt_daemon/backends/mlx.py tests/test_stt_backend_mlx.py
git commit -m "feat(stt_daemon): add mlx-whisper backend with lazy load + resident model"
```

## Task 3.2: whisper-cli backend

**Files:**
- Create: `yulu/scripts/stt_daemon/backends/whisper_cli.py`
- Create: `tests/test_stt_backend_whisper_cli.py`

- [ ] **Step 1: Write tests with a stubbed subprocess**

Write `tests/test_stt_backend_whisper_cli.py`:

```python
import asyncio
import os
import shutil
import stat
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.backends.whisper_cli import WhisperCliBackend
from stt_daemon.runtime import CancelToken


def _make_stub_whisper_cli(tmp_path: Path, transcript_text: str) -> Path:
    """Create a fake whisper-cli that writes <stem>.txt with the desired text."""
    cli = tmp_path / "whisper-cli"
    cli.write_text(
        "#!/usr/bin/env bash\n"
        "while [[ $# -gt 0 ]]; do\n"
        "  case \"$1\" in\n"
        "    -of) OUT_STEM=\"$2\"; shift 2 ;;\n"
        "    *) shift ;;\n"
        "  esac\n"
        "done\n"
        f"echo {transcript_text!r} > \"$OUT_STEM.txt\"\n"
        "exit 0\n"
    )
    cli.chmod(cli.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return cli


def test_whisper_cli_runs_and_reads_output(tmp_path):
    audio = tmp_path / "in.wav"
    audio.write_bytes(b"RIFFdummy")
    cli = _make_stub_whisper_cli(tmp_path, "hello world")
    backend = WhisperCliBackend(
        binary=str(cli),
        model_path=str(tmp_path / "model.bin"),
    )

    async def go():
        await backend.warm_up()
        result = await backend.transcribe(
            audio_path=str(audio),
            language="zh",
            initial_prompt="",
            cancel_token=CancelToken(),
        )
        return result
    result = asyncio.run(go())
    assert "hello world" in result.text


def test_whisper_cli_missing_binary_raises(tmp_path):
    backend = WhisperCliBackend(
        binary=str(tmp_path / "does-not-exist"),
        model_path=str(tmp_path / "model.bin"),
    )

    async def go():
        await backend.warm_up()
        with pytest.raises(RuntimeError):
            await backend.transcribe(
                audio_path=str(tmp_path / "x.wav"),
                language="zh",
                initial_prompt="",
                cancel_token=CancelToken(),
            )
    asyncio.run(go())


def test_whisper_cli_respects_pre_cancel(tmp_path):
    audio = tmp_path / "in.wav"
    audio.write_bytes(b"RIFFdummy")
    cli = _make_stub_whisper_cli(tmp_path, "x")
    backend = WhisperCliBackend(
        binary=str(cli),
        model_path=str(tmp_path / "model.bin"),
    )

    async def go():
        await backend.warm_up()
        tok = CancelToken()
        tok.cancel()
        with pytest.raises(asyncio.CancelledError):
            await backend.transcribe(
                audio_path=str(audio),
                language="zh",
                initial_prompt="",
                cancel_token=tok,
            )
    asyncio.run(go())
```

- [ ] **Step 2: Run — FAIL**

Run: `python3 -m pytest tests/test_stt_backend_whisper_cli.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement whisper-cli backend**

Write `yulu/scripts/stt_daemon/backends/whisper_cli.py`:

```python
"""whisper-cli subprocess backend (whisper.cpp variant)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Optional

from ..runtime import CancelToken, STTResult


class WhisperCliBackend:
    """Spawns whisper-cli per request. Output is parsed from the -of text file."""

    def __init__(
        self,
        *,
        binary: str,
        model_path: str,
    ):
        self.binary = binary
        self.model_path = model_path
        self._ready = False

    def is_ready(self) -> bool:
        return self._ready

    async def warm_up(self) -> None:
        # Nothing to load — readiness == binary exists.
        self._ready = Path(self.binary).exists()

    def release(self) -> None:
        self._ready = False

    async def transcribe(
        self,
        *,
        audio_path: str,
        language: str,
        initial_prompt: str,
        cancel_token: CancelToken,
    ) -> STTResult:
        cancel_token.check()
        await self.warm_up()
        if not Path(self.binary).exists():
            raise RuntimeError(f"whisper-cli binary not found: {self.binary}")

        output_stem = str(Path(audio_path).with_suffix("")) + ".whisper"
        output_txt = Path(f"{output_stem}.txt")
        cmd = [
            self.binary,
            "-m", str(self.model_path),
            "-l", language,
            "-otxt",
            "-of", output_stem,
            audio_path,
        ]
        if initial_prompt:
            cmd.extend(["--prompt", initial_prompt])

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await proc.communicate()
        except asyncio.CancelledError:
            proc.kill()
            raise

        if proc.returncode != 0:
            raise RuntimeError(
                f"whisper-cli failed (rc={proc.returncode}): {stderr.decode()[:500]}"
            )
        if not output_txt.exists():
            raise RuntimeError(f"whisper-cli did not write {output_txt}")

        text = output_txt.read_text(encoding="utf-8").strip()
        try:
            output_txt.unlink()
        except OSError:
            pass
        return STTResult(
            text=text,
            raw_text=text,
            segments=[],  # whisper.cpp -otxt has no per-segment timing
            language=language,
            duration_ms=0,
        )
```

- [ ] **Step 4: Run — PASS**

Run: `python3 -m pytest tests/test_stt_backend_whisper_cli.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/stt_daemon/backends/whisper_cli.py tests/test_stt_backend_whisper_cli.py
git commit -m "feat(stt_daemon): add whisper-cli subprocess backend"
```

## Task 3.3: Wire real backends into entry point + opt-in E2E test

**Files:**
- Modify: `yulu/scripts/stt_daemon/__main__.py`
- Create: `tests/test_e2e_stt_daemon.py`
- Create: `tests/fixtures/audio/.gitkeep`

- [ ] **Step 1: Update entry point to construct real backends**

Edit `yulu/scripts/stt_daemon/__main__.py`, replacing `_build_real_backends`:

```python
def _build_real_backends(config: DaemonConfig):
    from .backends.mlx import MlxWhisperBackend
    from .backends.whisper_cli import WhisperCliBackend

    return {
        "mlx": MlxWhisperBackend(
            model=config.mlx_model,
            language=config.default_language,
        ),
        "whisper": WhisperCliBackend(
            binary=config.whisper_cli,
            model_path=config.whisper_model,
        ),
    }
```

- [ ] **Step 2: Write opt-in E2E test (marker = e2e)**

Write `tests/test_e2e_stt_daemon.py`:

```python
"""E2E tests against a real mlx-whisper model. Opt-in via `pytest -m e2e`.

Skipped by default. To run locally:
  pytest -m e2e tests/test_e2e_stt_daemon.py -v
Requires:
  - mlx-whisper installed in the python on PATH
  - tests/fixtures/audio/tiny_10s.wav present (you provide it)
"""

import asyncio
import importlib
import json
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

FIXTURE = ROOT / "tests" / "fixtures" / "audio" / "tiny_10s.wav"


pytestmark = pytest.mark.e2e


def _mlx_available() -> bool:
    try:
        importlib.import_module("mlx_whisper")
        return True
    except ImportError:
        return False


@pytest.mark.skipif(not _mlx_available(), reason="mlx_whisper not installed")
@pytest.mark.skipif(not FIXTURE.exists(), reason="fixture audio missing — add tests/fixtures/audio/tiny_10s.wav")
def test_real_mlx_round_trip(tmp_path):
    from vocab import VocabRepo, Scope, open_db
    from stt_daemon.app import STTDaemonApp
    from stt_daemon.config import DaemonConfig
    from stt_daemon.backends.mlx import MlxWhisperBackend

    db = tmp_path / "vocab.sqlite"
    VocabRepo(open_db(db))  # ensure schema
    cfg = DaemonConfig(
        socket_path=tmp_path / "stt.sock",
        vocab_db_path=db,
        pid_file=tmp_path / "stt.pid",
        log_path=None,
        sessions_dir=tmp_path / "sessions",
    )
    backends = {"mlx": MlxWhisperBackend(model="mlx-community/whisper-large-v3-mlx", language="zh")}
    app = STTDaemonApp(cfg, backends=backends)

    async def go():
        await app.start()
        try:
            reader, writer = await asyncio.open_unix_connection(str(cfg.socket_path))
            req = {
                "type": "transcribe",
                "job_id": str(uuid.uuid4()),
                "kind": "final_transcribe",
                "engine": "mlx",
                "language": "zh",
                "audio_path": str(FIXTURE),
                "audio_offset_bytes": 0,
                "audio_length_bytes": None,
                "audio_format": "wav-pcm-s16le-16k-mono",
                "meeting_title": "E2E",
                "session_id": None,
                "word_timestamps": False,
                "condition_on_previous": True,
                "hallucination_silence_threshold": 2.0,
                "timeout_sec": 7200,
            }
            writer.write((json.dumps(req) + "\n").encode())
            await writer.drain()
            line = await reader.readline()
            writer.close()
            await writer.wait_closed()
            return json.loads(line)
        finally:
            await app.stop()

    payload = asyncio.run(go())
    assert payload["status"] == "ok"
    assert len(payload["text"]) > 0
```

- [ ] **Step 3: Create fixture placeholder**

Run:
```bash
mkdir -p tests/fixtures/audio
touch tests/fixtures/audio/.gitkeep
```

- [ ] **Step 4: Verify the suite still passes (E2E skipped without -m e2e)**

Run: `python3 -m pytest -q`
Expected: all tests pass; E2E test is silently deselected because it has the `e2e` marker and the default test run does not include it. (If pytest still runs it because of the `pytestmark`, the inner skipif guards will mark it skipped.)

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/stt_daemon/__main__.py tests/test_e2e_stt_daemon.py tests/fixtures/audio/.gitkeep
git commit -m "feat(stt_daemon): wire real backends in entry point + opt-in e2e suite"
```

---

# Phase 4 — Live Sessions (Tail Loop, Persistence, Subscribe Protocol)

**Outcome:** `meeting_daemon` (Phase 7) can `subscribe_session` while audio_daemon writes the recording WAV; daemon tails the file, emits `partial` events per chunk, persists tail offsets so crash + restart resumes without losing partials. `unsubscribe_session` triggers `final_transcribe` automatically.

## Task 4.1: LiveSessionManager + tail loop

**Files:**
- Create: `yulu/scripts/stt_daemon/live_session.py`
- Create: `tests/test_stt_live_session.py`

- [ ] **Step 1: Write failing tests**

Write `tests/test_stt_live_session.py`:

```python
import asyncio
import json
import struct
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.live_session import LiveSession, LiveSessionManager, TailState
from stt_daemon.protocol import JobKind, PartialEvent
from stt_daemon.runtime import MockSTTBackend, STTRuntime
from stt_daemon.scheduler import STTScheduler
from stt_daemon.vocab_cache import VocabCache


def _write_wav(path: Path, samples_per_second: int = 16000, seconds: float = 1.0) -> None:
    """Write a valid 16kHz mono PCM WAV with constant tone."""
    n = int(samples_per_second * seconds)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(samples_per_second)
        wf.writeframes(b"\x00\x10" * n)


def _append_pcm(path: Path, seconds: float, samples_per_second: int = 16000) -> None:
    """Append more PCM bytes to an existing WAV without fixing header."""
    n = int(samples_per_second * seconds)
    with open(path, "ab") as f:
        f.write(b"\x00\x10" * n)


def _build_minimal_app(tmp_path):
    backend = MockSTTBackend(canned_text="partial-chunk", delay_sec=0.0)
    runtime = STTRuntime(backends={"mlx": backend})
    scheduler = STTScheduler(runtime=runtime)
    cache = VocabCache(tmp_path / "vocab.sqlite")
    cache.load()
    return backend, runtime, scheduler, cache


def test_tail_state_roundtrip(tmp_path):
    state = TailState(
        sid="s1",
        mic_path=str(tmp_path / "mic.wav"),
        sys_path=None,
        engine="mlx",
        language="zh",
        chunk_sec=10,
        mic_offset_bytes=4096,
        sys_offset_bytes=0,
        next_seq=3,
        started_at="2026-05-22T10:00:00Z",
        last_partial_at="2026-05-22T10:00:30Z",
    )
    state_path = tmp_path / "session.tail.json"
    state.persist(state_path)
    loaded = TailState.load(state_path)
    assert loaded == state


def test_manager_emits_partial_when_audio_grows(tmp_path):
    wav_path = tmp_path / "rec.wav"
    _write_wav(wav_path, seconds=1.0)  # initial 1s = 32000 bytes (header skipped)

    backend, runtime, scheduler, cache = _build_minimal_app(tmp_path)
    received: list[PartialEvent] = []

    async def go():
        await scheduler.start()
        mgr = LiveSessionManager(
            scheduler=scheduler,
            vocab_cache=cache,
            sessions_dir=tmp_path / "sessions",
            on_partial=lambda evt: received.append(evt),
        )
        sid = "abc"
        await mgr.start_session(LiveSession(
            sid=sid,
            mic_path=str(wav_path),
            sys_path=None,
            engine="mlx",
            language="zh",
            chunk_sec=0.5,  # short for test
        ))
        # Append more audio so a chunk is ready
        _append_pcm(wav_path, seconds=0.6)
        await mgr.poll_once(sid)
        await asyncio.sleep(0.1)
        await mgr.stop_session(sid, reason="stopped")
        await scheduler.stop()

    asyncio.run(go())
    assert any(evt.source == "mic" for evt in received), f"no mic partial emitted: {received}"


def test_manager_persists_offset_across_restart(tmp_path):
    wav_path = tmp_path / "rec.wav"
    _write_wav(wav_path, seconds=1.0)

    backend, runtime, scheduler, cache = _build_minimal_app(tmp_path)

    async def first():
        await scheduler.start()
        mgr = LiveSessionManager(
            scheduler=scheduler,
            vocab_cache=cache,
            sessions_dir=tmp_path / "sessions",
            on_partial=lambda evt: None,
        )
        sid = "persist-test"
        await mgr.start_session(LiveSession(
            sid=sid,
            mic_path=str(wav_path),
            sys_path=None,
            engine="mlx",
            language="zh",
            chunk_sec=0.5,
        ))
        _append_pcm(wav_path, seconds=0.6)
        await mgr.poll_once(sid)
        await mgr.flush_state(sid)
        await scheduler.stop()
        return mgr.tail_state_path(sid)

    state_path = asyncio.run(first())
    state = TailState.load(state_path)
    assert state.mic_offset_bytes > 0


def test_manager_recovers_active_sessions_from_disk(tmp_path):
    wav_path = tmp_path / "rec.wav"
    _write_wav(wav_path, seconds=1.0)
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    TailState(
        sid="recover-me",
        mic_path=str(wav_path),
        sys_path=None,
        engine="mlx",
        language="zh",
        chunk_sec=0.5,
        mic_offset_bytes=44,  # WAV header only
        sys_offset_bytes=0,
        next_seq=0,
        started_at="2026-05-22T10:00:00Z",
        last_partial_at="2026-05-22T10:00:00Z",
    ).persist(sessions_dir / "recover-me.tail.json")

    backend, runtime, scheduler, cache = _build_minimal_app(tmp_path)

    async def go():
        await scheduler.start()
        mgr = LiveSessionManager(
            scheduler=scheduler,
            vocab_cache=cache,
            sessions_dir=sessions_dir,
            on_partial=lambda evt: None,
        )
        recovered = mgr.recover_from_disk()
        await scheduler.stop()
        return recovered

    recovered = asyncio.run(go())
    assert "recover-me" in recovered
```

- [ ] **Step 2: Run — FAIL with ImportError**

Run: `python3 -m pytest tests/test_stt_live_session.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement LiveSessionManager**

Write `yulu/scripts/stt_daemon/live_session.py`:

```python
"""Live session ingestion: tail audio files and dispatch live_chunk jobs."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable, Optional

from .protocol import JobKind, PartialEvent
from .runtime import STTResult
from .scheduler import Job, STTScheduler
from .vocab_cache import VocabCache


WAV_HEADER_BYTES = 44
SAMPLE_RATE_HZ = 16000
SAMPLE_BYTES = 2  # int16 mono

PartialCallback = Callable[[PartialEvent], Optional[Awaitable[None]]]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass
class LiveSession:
    sid: str
    mic_path: str
    sys_path: Optional[str]
    engine: str
    language: str
    chunk_sec: float = 10.0
    meeting_title: Optional[str] = None


@dataclass
class TailState:
    sid: str
    mic_path: str
    sys_path: Optional[str]
    engine: str
    language: str
    chunk_sec: float
    mic_offset_bytes: int
    sys_offset_bytes: int
    next_seq: int
    started_at: str
    last_partial_at: str

    def persist(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)

    @classmethod
    def load(cls, path: Path) -> "TailState":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(**data)


@dataclass
class _ActiveSession:
    spec: LiveSession
    state: TailState


class LiveSessionManager:
    def __init__(
        self,
        *,
        scheduler: STTScheduler,
        vocab_cache: VocabCache,
        sessions_dir: Path,
        on_partial: PartialCallback,
    ):
        self.scheduler = scheduler
        self.vocab_cache = vocab_cache
        self.sessions_dir = Path(sessions_dir)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.on_partial = on_partial
        self._active: dict[str, _ActiveSession] = {}
        self._tail_tasks: dict[str, asyncio.Task] = {}

    def tail_state_path(self, sid: str) -> Path:
        return self.sessions_dir / f"{sid}.tail.json"

    def active_sessions(self) -> list[str]:
        return list(self._active.keys())

    async def start_session(self, spec: LiveSession) -> None:
        if spec.sid in self._active:
            # idempotent reuse — useful for client reconnect after daemon restart
            return
        existing_state_path = self.tail_state_path(spec.sid)
        if existing_state_path.exists():
            state = TailState.load(existing_state_path)
        else:
            mic_size = self._size_or_header(Path(spec.mic_path))
            sys_size = self._size_or_header(Path(spec.sys_path)) if spec.sys_path else 0
            state = TailState(
                sid=spec.sid,
                mic_path=spec.mic_path,
                sys_path=spec.sys_path,
                engine=spec.engine,
                language=spec.language,
                chunk_sec=spec.chunk_sec,
                mic_offset_bytes=mic_size,
                sys_offset_bytes=sys_size,
                next_seq=0,
                started_at=_now_iso(),
                last_partial_at=_now_iso(),
            )
            state.persist(existing_state_path)
        self._active[spec.sid] = _ActiveSession(spec=spec, state=state)
        self._tail_tasks[spec.sid] = asyncio.create_task(self._tail_loop(spec.sid))

    async def stop_session(self, sid: str, *, reason: str) -> Optional[asyncio.Future]:
        active = self._active.pop(sid, None)
        task = self._tail_tasks.pop(sid, None)
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        if active is None:
            return None
        # Persist final state before we touch the file
        await self.flush_state(sid, active=active)
        # Cancel any queued live_chunks
        await self.scheduler.cancel_session(sid)
        # If reason indicates the recording is over, dispatch a final_transcribe
        if reason in ("stopped", "orphaned", "crashed"):
            job = Job(
                job_id=str(uuid.uuid4()),
                kind=JobKind.FINAL_TRANSCRIBE,
                engine=active.spec.engine,
                language=active.spec.language,
                audio_path=active.spec.mic_path,
                initial_prompt=self.vocab_cache.inject_prompt(
                    meeting_title=active.spec.meeting_title or "",
                ),
                session_id=sid,
                meeting_title=active.spec.meeting_title,
            )
            fut = await self.scheduler.submit(job)
            # Clean up tail state on successful completion
            try:
                self.tail_state_path(sid).unlink()
            except FileNotFoundError:
                pass
            return fut
        try:
            self.tail_state_path(sid).unlink()
        except FileNotFoundError:
            pass
        return None

    def recover_from_disk(self) -> list[str]:
        """Scan sessions_dir for .tail.json files; return sids found.

        Caller is expected to re-register subscriber callbacks on reconnect
        before any new chunks emit. We DO NOT auto-start the tail loop here:
        we wait for a subscribe_session message from a client so we know who
        receives the partial events. (Old state survives across restart so
        offsets aren't lost.)
        """
        sids = []
        for p in sorted(self.sessions_dir.glob("*.tail.json")):
            try:
                state = TailState.load(p)
            except (OSError, ValueError):
                continue
            if not Path(state.mic_path).exists():
                # source gone; remove stale state
                try:
                    p.unlink()
                except FileNotFoundError:
                    pass
                continue
            sids.append(state.sid)
        return sids

    async def poll_once(self, sid: str) -> None:
        """For tests: run one tail iteration synchronously."""
        await self._tail_iteration(sid)

    async def flush_state(self, sid: str, *, active: Optional[_ActiveSession] = None) -> None:
        active = active or self._active.get(sid)
        if active is None:
            return
        active.state.persist(self.tail_state_path(sid))

    async def _tail_loop(self, sid: str) -> None:
        try:
            while sid in self._active:
                await self._tail_iteration(sid)
                active = self._active.get(sid)
                if active is None:
                    return
                await asyncio.sleep(active.spec.chunk_sec)
        except asyncio.CancelledError:
            pass

    async def _tail_iteration(self, sid: str) -> None:
        active = self._active.get(sid)
        if active is None:
            return
        # Mic stream first
        mic_chunk = self._read_pending(
            Path(active.spec.mic_path),
            active.state.mic_offset_bytes,
            min_seconds=active.spec.chunk_sec,
        )
        if mic_chunk is not None:
            chunk_path, new_offset, duration_ms = mic_chunk
            await self._dispatch_chunk(active, source="mic", chunk_path=chunk_path, duration_ms=duration_ms)
            active.state.mic_offset_bytes = new_offset
        if active.spec.sys_path:
            sys_chunk = self._read_pending(
                Path(active.spec.sys_path),
                active.state.sys_offset_bytes,
                min_seconds=active.spec.chunk_sec,
            )
            if sys_chunk is not None:
                chunk_path, new_offset, duration_ms = sys_chunk
                await self._dispatch_chunk(active, source="system", chunk_path=chunk_path, duration_ms=duration_ms)
                active.state.sys_offset_bytes = new_offset
        active.state.last_partial_at = _now_iso()
        await self.flush_state(sid, active=active)

    async def _dispatch_chunk(
        self,
        active: _ActiveSession,
        *,
        source: str,
        chunk_path: Path,
        duration_ms: int,
    ) -> None:
        seq = active.state.next_seq
        active.state.next_seq += 1
        started_ms = self._offset_to_ms(active.state, source, before_chunk=True, duration_ms=duration_ms)
        job = Job(
            job_id=str(uuid.uuid4()),
            kind=JobKind.LIVE_CHUNK,
            engine=active.spec.engine,
            language=active.spec.language,
            audio_path=str(chunk_path),
            initial_prompt=self.vocab_cache.inject_prompt(
                meeting_title=active.spec.meeting_title or "",
            ),
            session_id=active.spec.sid,
        )
        fut = await self.scheduler.submit(job)
        try:
            result: STTResult = await fut
        except asyncio.CancelledError:
            return
        except Exception:
            return  # Errors logged elsewhere; live chunks are best-effort.
        text, _ = self.vocab_cache.apply_replacements(result.text)
        event = PartialEvent(
            sid=active.spec.sid,
            seq=seq,
            source=source,
            started_ms=started_ms,
            ended_ms=started_ms + duration_ms,
            text=text,
        )
        out = self.on_partial(event)
        if asyncio.iscoroutine(out):
            await out

    def _offset_to_ms(self, state: TailState, source: str, *, before_chunk: bool, duration_ms: int) -> int:
        offset = state.mic_offset_bytes if source == "mic" else state.sys_offset_bytes
        offset = max(offset - WAV_HEADER_BYTES, 0)
        ms = int(offset / (SAMPLE_RATE_HZ * SAMPLE_BYTES) * 1000)
        if before_chunk:
            ms = max(ms - duration_ms, 0)
        return ms

    @staticmethod
    def _size_or_header(path: Path) -> int:
        try:
            return max(path.stat().st_size, WAV_HEADER_BYTES)
        except FileNotFoundError:
            return WAV_HEADER_BYTES

    def _read_pending(
        self,
        path: Path,
        offset: int,
        *,
        min_seconds: float,
    ) -> Optional[tuple[Path, int, int]]:
        """Read >= min_seconds of audio after `offset`, write a temp WAV.

        Returns (chunk_wav_path, new_offset, duration_ms) or None if too little.
        """
        try:
            current_size = path.stat().st_size
        except FileNotFoundError:
            return None
        available = current_size - offset
        if available < int(min_seconds * SAMPLE_RATE_HZ * SAMPLE_BYTES):
            return None
        with open(path, "rb") as f:
            f.seek(offset)
            pcm = f.read(available)
        if len(pcm) < SAMPLE_BYTES:
            return None
        chunk_path = path.with_name(
            f"{path.stem}.chunk-{offset}-{offset + len(pcm)}.wav"
        )
        _write_wav_chunk(chunk_path, pcm)
        duration_ms = int(len(pcm) / (SAMPLE_RATE_HZ * SAMPLE_BYTES) * 1000)
        return chunk_path, offset + len(pcm), duration_ms


def _write_wav_chunk(path: Path, pcm_bytes: bytes) -> None:
    import wave
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(SAMPLE_BYTES)
        wf.setframerate(SAMPLE_RATE_HZ)
        wf.writeframes(pcm_bytes)
```

- [ ] **Step 4: Run — PASS**

Run: `python3 -m pytest tests/test_stt_live_session.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/stt_daemon/live_session.py tests/test_stt_live_session.py
git commit -m "feat(stt_daemon): add LiveSessionManager with tail loop + persistence + crash-recovery hook"
```

## Task 4.2: Wire subscribe/unsubscribe handlers and recovery into app.py

**Files:**
- Modify: `yulu/scripts/stt_daemon/app.py`
- Modify: `tests/test_stt_control_server.py` (extend with subscribe coverage)

- [ ] **Step 1: Replace the Phase 2 stubs in app.py**

Edit `yulu/scripts/stt_daemon/app.py`:

Add at the top of the imports:

```python
from .live_session import LiveSession, LiveSessionManager
```

Replace `_active_sessions: dict[str, "_SessionEntry"]` with:

```python
        self.live_sessions = LiveSessionManager(
            scheduler=self.scheduler,
            vocab_cache=self.vocab_cache,
            sessions_dir=config.sessions_dir,
            on_partial=self._broadcast_partial,
        )
        self._subscribers: dict[str, list[asyncio.StreamWriter]] = {}
```

Replace the body of `_on_subscribe_session`:

```python
    async def _on_subscribe_session(self, msg: SubscribeSessionRequest, writer):
        spec = LiveSession(
            sid=msg.sid,
            mic_path=msg.mic_path,
            sys_path=msg.sys_path,
            engine=msg.engine,
            language=msg.language,
            chunk_sec=msg.chunk_sec,
        )
        await self.live_sessions.start_session(spec)
        self._subscribers.setdefault(msg.sid, []).append(writer)
        self.logger.info("session_subscribed", sid=msg.sid, mic=msg.mic_path)
        return OkResponse(detail=f"subscribed:{msg.sid}")
```

Replace the body of `_on_unsubscribe_session`:

```python
    async def _on_unsubscribe_session(self, msg: UnsubscribeSessionRequest, writer):
        fut = await self.live_sessions.stop_session(msg.sid, reason=msg.reason)
        subscribers = self._subscribers.pop(msg.sid, [])
        if fut is not None:
            asyncio.create_task(self._announce_final_when_ready(msg.sid, fut, subscribers))
        return OkResponse(detail=f"unsubscribed:{msg.sid}")
```

Add the broadcast + announce helpers below `_on_unsubscribe_session`:

```python
    async def _broadcast_partial(self, event) -> None:
        subscribers = self._subscribers.get(event.sid, [])
        if not subscribers:
            return
        from .protocol import encode
        payload = encode(event).encode()
        for writer in list(subscribers):
            if writer.is_closing():
                subscribers.remove(writer)
                continue
            try:
                writer.write(payload)
                await writer.drain()
            except (ConnectionResetError, BrokenPipeError):
                subscribers.remove(writer)

    async def _announce_final_when_ready(self, sid, fut, subscribers) -> None:
        from .protocol import FinalReadyEvent, encode
        try:
            result = await fut
        except (asyncio.CancelledError, Exception) as exc:
            self.logger.warn("final_transcribe_failed_after_session_stop", sid=sid, err=str(exc))
            return
        # Save transcript file alongside the source mic recording
        active_paths = self._session_artifact_paths(sid, result)
        if active_paths is None:
            return
        transcript_path, raw_path = active_paths
        evt = FinalReadyEvent(
            sid=sid,
            transcript_path=str(transcript_path),
            raw_path=str(raw_path),
            engine=result.language or "",
            duration_ms=result.duration_ms,
        )
        payload = encode(evt).encode()
        for writer in subscribers:
            if writer.is_closing():
                continue
            try:
                writer.write(payload)
                await writer.drain()
            except (ConnectionResetError, BrokenPipeError):
                continue

    def _session_artifact_paths(self, sid, result):
        # Path layout: <meeting>.transcript.txt + <meeting>.raw.transcript.txt
        # owned by transcribe.py business logic; daemon writes a side car for
        # subscribers to pick up if they want.
        artifact_dir = self.config.sessions_dir / sid
        artifact_dir.mkdir(parents=True, exist_ok=True)
        transcript_path = artifact_dir / "final.transcript.txt"
        raw_path = artifact_dir / "final.raw.transcript.txt"
        transcript_path.write_text(result.text or "", encoding="utf-8")
        raw_path.write_text(result.raw_text or "", encoding="utf-8")
        return transcript_path, raw_path
```

Update `start()` to recover sessions on boot:

```python
    async def start(self) -> None:
        self.vocab_cache.load()
        await self.scheduler.start()
        self._register_handlers()
        await self.control_server.start()
        self._write_pid()
        self._install_signal_handlers()
        recovered = self.live_sessions.recover_from_disk()
        self.logger.info("daemon_ready",
                          vocab=len(self.vocab_cache.prompt_terms),
                          recovered_sessions=recovered)
```

- [ ] **Step 2: Add a subscribe integration test**

Append to `tests/test_stt_control_server.py`:

```python
import wave


def _write_wav(path, seconds=1.0, rate=16000):
    n = int(seconds * rate)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(b"\x00\x10" * n)


def test_subscribe_session_returns_ok(tmp_path):
    async def go():
        app = _build_app(tmp_path)
        await app.start()
        try:
            wav = tmp_path / "rec.wav"
            _write_wav(wav, seconds=1.0)
            req = {
                "type": "subscribe_session",
                "sid": "test-sid",
                "mic_path": str(wav),
                "sys_path": None,
                "engine": "mlx",
                "language": "zh",
                "chunk_sec": 10,
            }
            results = await _send(app.config.socket_path, [json.dumps(req)])
            return json.loads(results[0])
        finally:
            await app.stop()
    payload = asyncio.run(go())
    assert payload["type"] == "ok"
    assert "subscribed" in payload["detail"]


def test_unsubscribe_session_triggers_final(tmp_path):
    async def go():
        app = _build_app(tmp_path)
        await app.start()
        try:
            wav = tmp_path / "rec.wav"
            _write_wav(wav, seconds=1.0)
            req_sub = {
                "type": "subscribe_session",
                "sid": "fin-sid",
                "mic_path": str(wav),
                "sys_path": None,
                "engine": "mlx",
                "language": "zh",
                "chunk_sec": 10,
            }
            req_unsub = {
                "type": "unsubscribe_session",
                "sid": "fin-sid",
                "reason": "stopped",
            }
            results = await _send(app.config.socket_path, [json.dumps(req_sub), json.dumps(req_unsub)])
            return [json.loads(r) for r in results]
        finally:
            await app.stop()
    payloads = asyncio.run(go())
    assert payloads[0]["type"] == "ok"
    assert payloads[1]["type"] == "ok"
```

- [ ] **Step 3: Run — PASS**

Run: `python3 -m pytest tests/test_stt_control_server.py -v`
Expected: 5 passed (3 from Phase 2 + 2 new).

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/stt_daemon/app.py tests/test_stt_control_server.py
git commit -m "feat(stt_daemon): wire subscribe/unsubscribe handlers + partial broadcast + final emit"
```

---

# Phase 5 — launchd Integration + `yulu stt` CLI + Doctor

**Outcome:** Daemon auto-starts via launchd on login; `yulu stt status/warm-up/logs/restart` works end-to-end; `yulu doctor` reports the daemon section.

## Task 5.1: launchd plist + setup.sh installer changes

**Files:**
- Create: `yulu/scripts/com.yulu.sttdaemon.plist`
- Modify: `yulu/scripts/setup.sh`
- Modify: `yulu/scripts/dev_install.py`
- Create: `tests/test_dev_install_stt.py`

- [ ] **Step 1: Write the launchd plist (template — setup.sh fills paths at install time)**

Write `yulu/scripts/com.yulu.sttdaemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yulu.sttdaemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>__PYTHON__</string>
        <string>-m</string>
        <string>stt_daemon</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PYTHONPATH</key>
        <string>__SCRIPTS_DIR__</string>
        <key>YULU_HOME</key>
        <string>__HOME_DIR__</string>
        <key>PATH</key>
        <string>__PATH__</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>__HOME_DIR__</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>__HOME_DIR__/logs/stt_daemon.out.log</string>
    <key>StandardErrorPath</key>
    <string>__HOME_DIR__/logs/stt_daemon.log</string>
    <key>ProcessType</key>
    <string>Standard</string>
</dict>
</plist>
```

- [ ] **Step 2: Add installer helper to dev_install.py**

Open `yulu/scripts/dev_install.py`. After the existing plist install logic for `audio_daemon`/`scheduler`/etc., add a new entry that templates and installs `com.yulu.sttdaemon.plist`. The exact patch depends on `dev_install.py`'s current structure; add at the bottom of its plist-rendering table:

```python
STT_DAEMON_PLIST = "com.yulu.sttdaemon.plist"


def render_stt_daemon_plist(
    *,
    template_path: Path,
    python: str,
    scripts_dir: Path,
    home_dir: Path,
    path_env: str,
) -> str:
    text = template_path.read_text(encoding="utf-8")
    return (
        text.replace("__PYTHON__", python)
            .replace("__SCRIPTS_DIR__", str(scripts_dir))
            .replace("__HOME_DIR__", str(home_dir))
            .replace("__PATH__", path_env)
    )
```

Wire it into whatever main flow `dev_install.py` uses (call site mirrors existing daemons). Set `path_env` to `os.environ.get("PATH", "/usr/bin:/bin:/usr/local/bin")` so `which python3` etc. work.

- [ ] **Step 3: Add tests for the renderer**

Write `tests/test_dev_install_stt.py`:

```python
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from dev_install import render_stt_daemon_plist


def test_render_substitutes_placeholders(tmp_path):
    template = tmp_path / "tpl.plist"
    template.write_text(
        "<?xml version=\"1.0\"?><dict>"
        "<key>Program</key><string>__PYTHON__</string>"
        "<key>Scripts</key><string>__SCRIPTS_DIR__</string>"
        "<key>Home</key><string>__HOME_DIR__</string>"
        "<key>Path</key><string>__PATH__</string>"
        "</dict>",
        encoding="utf-8",
    )
    out = render_stt_daemon_plist(
        template_path=template,
        python="/opt/py/bin/python3",
        scripts_dir=Path("/usr/share/yulu/scripts"),
        home_dir=Path("/Users/x/.config/yulu"),
        path_env="/usr/local/bin:/usr/bin",
    )
    for needle in ("/opt/py/bin/python3", "/usr/share/yulu/scripts", "/Users/x/.config/yulu", "/usr/local/bin"):
        assert needle in out
    assert "__PYTHON__" not in out
```

- [ ] **Step 4: Run — verify the renderer passes**

Run: `python3 -m pytest tests/test_dev_install_stt.py -v`
Expected: 1 passed.

- [ ] **Step 5: Add setup.sh additions**

Open `yulu/scripts/setup.sh`. After the existing daemon-install steps (search for `com.yulu.scheduler.plist` and similar), add:

```bash
echo "→ Installing stt_daemon launchd target..."
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
mkdir -p "${LAUNCH_AGENTS_DIR}"
PYTHON_BIN="$(command -v python3)"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME}/.config/yulu"
python3 - <<PY
from pathlib import Path
import os, sys
sys.path.insert(0, "${SCRIPTS_DIR}")
from dev_install import render_stt_daemon_plist
out = render_stt_daemon_plist(
    template_path=Path("${SCRIPTS_DIR}/com.yulu.sttdaemon.plist"),
    python="${PYTHON_BIN}",
    scripts_dir=Path("${SCRIPTS_DIR}"),
    home_dir=Path("${HOME_DIR}"),
    path_env=os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
)
Path("${LAUNCH_AGENTS_DIR}/com.yulu.sttdaemon.plist").write_text(out, encoding="utf-8")
PY
launchctl bootstrap "gui/$(id -u)" "${LAUNCH_AGENTS_DIR}/com.yulu.sttdaemon.plist" 2>/dev/null || true

echo "→ Seeding vocab.sqlite from current glossary..."
"${SCRIPTS_DIR}/yulu" vocab seed --from-current >/dev/null

echo "→ Warming up stt_daemon..."
"${SCRIPTS_DIR}/yulu" stt warm-up || echo "  (warm-up failed; you can retry with: yulu stt warm-up)"
```

- [ ] **Step 6: Run all tests**

Run: `python3 -m pytest -q`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add yulu/scripts/com.yulu.sttdaemon.plist yulu/scripts/dev_install.py yulu/scripts/setup.sh tests/test_dev_install_stt.py
git commit -m "feat(stt_daemon): add launchd plist, dev_install renderer, setup.sh integration"
```

## Task 5.2: `yulu stt` CLI

**Files:**
- Create: `yulu/scripts/stt_cli.py`
- Modify: `yulu/scripts/yulu`
- Create: `tests/test_stt_cli.py`

- [ ] **Step 1: Write failing tests**

Write `tests/test_stt_cli.py`:

```python
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from vocab import VocabRepo, Scope, open_db
from stt_daemon.app import STTDaemonApp
from stt_daemon.config import DaemonConfig
from stt_daemon.runtime import MockSTTBackend
from stt_cli import main as stt_main


def _spawn(tmp_path):
    db = tmp_path / "vocab.sqlite"
    VocabRepo(open_db(db))
    cfg = DaemonConfig(
        socket_path=tmp_path / "stt.sock",
        vocab_db_path=db,
        pid_file=tmp_path / "stt.pid",
        log_path=None,
        sessions_dir=tmp_path / "sessions",
    )
    backends = {"mlx": MockSTTBackend(canned_text="ok")}
    return STTDaemonApp(cfg, backends=backends)


def test_status_reports_running_daemon(tmp_path, capsys):
    async def go():
        app = _spawn(tmp_path)
        await app.start()
        try:
            code = stt_main([
                "status",
                "--socket", str(app.config.socket_path),
                "--json",
            ])
            out = capsys.readouterr().out
            return code, out
        finally:
            await app.stop()
    code, out = asyncio.run(go())
    assert code == 0
    payload = json.loads(out)
    assert payload["ready"] is True


def test_status_when_daemon_down(tmp_path, capsys):
    code = stt_main([
        "status",
        "--socket", str(tmp_path / "nope.sock"),
        "--json",
    ])
    out = capsys.readouterr().out
    assert code != 0
    payload = json.loads(out)
    assert payload["ready"] is False


def test_warm_up_returns_ok(tmp_path, capsys):
    async def go():
        app = _spawn(tmp_path)
        await app.start()
        try:
            code = stt_main([
                "warm-up",
                "--engine", "mlx",
                "--socket", str(app.config.socket_path),
            ])
            return code, capsys.readouterr().out
        finally:
            await app.stop()
    code, out = asyncio.run(go())
    assert code == 0
    assert "warmed" in out.lower() or "ok" in out.lower()
```

- [ ] **Step 2: Run — FAIL with ImportError**

Run: `python3 -m pytest tests/test_stt_cli.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement `yulu stt` CLI**

Write `yulu/scripts/stt_cli.py`:

```python
"""`yulu stt` CLI — status/warm-up/logs/restart against the running daemon."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Optional

DEFAULT_SOCKET = Path.home() / ".config" / "yulu" / "stt_daemon.sock"
DEFAULT_LOG = Path.home() / ".config" / "yulu" / "logs" / "stt_daemon.log"
DEFAULT_PID = Path.home() / ".config" / "yulu" / "stt_daemon.pid"
LAUNCHD_LABEL = "com.yulu.sttdaemon"


async def _request_response(socket_path: Path, payload: dict, timeout: float = 5.0) -> Optional[dict]:
    if not socket_path.exists():
        return None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(str(socket_path)), timeout=timeout
        )
    except (FileNotFoundError, ConnectionRefusedError, asyncio.TimeoutError):
        return None
    try:
        writer.write((json.dumps(payload) + "\n").encode())
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=timeout)
        if not line:
            return None
        return json.loads(line.decode())
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionResetError, BrokenPipeError):
            pass


def _cmd_status(args: argparse.Namespace) -> int:
    payload = asyncio.run(_request_response(Path(args.socket), {"type": "health"}))
    if payload is None or payload.get("type") != "health_response":
        report = {"ready": False, "error": "daemon not reachable"}
        if args.json:
            print(json.dumps(report))
        else:
            print("daemon: not reachable")
        return 1
    if args.json:
        print(json.dumps(payload))
    else:
        print(f"daemon:  ready (vocab={payload['vocab_size']}, in_flight={payload['in_flight_jobs']}, sessions={payload['active_sessions']})")
    return 0


def _cmd_warm_up(args: argparse.Namespace) -> int:
    payload = asyncio.run(_request_response(
        Path(args.socket), {"type": "warm_up", "engine": args.engine}
    ))
    if payload is None:
        print("daemon not reachable", file=sys.stderr)
        return 1
    if payload.get("type") == "error":
        print(payload.get("message", "error"), file=sys.stderr)
        return 1
    print(payload.get("detail", "ok"))
    return 0


def _cmd_logs(args: argparse.Namespace) -> int:
    path = Path(args.log_path)
    if not path.exists():
        print(f"log not found: {path}", file=sys.stderr)
        return 1
    if args.tail <= 0:
        sys.stdout.write(path.read_text(encoding="utf-8"))
        return 0
    # Cheap tail: read whole file, print last N lines
    lines = path.read_text(encoding="utf-8").splitlines()
    for line in lines[-args.tail:]:
        print(line)
    return 0


def _cmd_restart(args: argparse.Namespace) -> int:
    # Try launchd kickstart first, fall back to signal
    rc = subprocess.run(
        ["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"],
        capture_output=True,
    ).returncode
    if rc == 0:
        print(f"restarted via launchd: {LAUNCHD_LABEL}")
        return 0
    # Fallback: SIGTERM the pid file process; launchd KeepAlive will respawn
    try:
        pid = int(Path(args.pid_file).read_text().strip())
        os.kill(pid, signal.SIGTERM)
        print(f"sent SIGTERM to pid {pid}")
        return 0
    except (OSError, ValueError):
        print("could not signal daemon and launchctl kickstart failed", file=sys.stderr)
        return 1


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="yulu stt")
    p.add_argument("--socket", default=str(DEFAULT_SOCKET))
    p.add_argument("--pid-file", default=str(DEFAULT_PID))
    sub = p.add_subparsers(dest="cmd", required=True)

    ps = sub.add_parser("status")
    ps.add_argument("--json", action="store_true")

    pw = sub.add_parser("warm-up")
    pw.add_argument("--engine", default="mlx")

    pl = sub.add_parser("logs")
    pl.add_argument("--tail", type=int, default=50)
    pl.add_argument("--log-path", default=str(DEFAULT_LOG))

    sub.add_parser("restart")

    return p


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    handlers = {
        "status": _cmd_status,
        "warm-up": _cmd_warm_up,
        "logs": _cmd_logs,
        "restart": _cmd_restart,
    }
    return handlers[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Wire `yulu stt` into the shell wrapper**

Edit `yulu/scripts/yulu`. After the `vocab)` branch added in Task 1.4, add:

```bash
stt)
    shift
    exec "${PYTHON:-python3}" -m stt_cli "$@"
    ;;
```

(Since `stt_cli.py` is a module at the scripts root, `python -m stt_cli` works with `PYTHONPATH` already pointing at scripts.)

- [ ] **Step 5: Run — PASS**

Run: `python3 -m pytest tests/test_stt_cli.py -v`
Expected: 3 passed.

- [ ] **Step 6: Smoke test the wrapper end to end**

Run:
```bash
# Start a daemon in background using mock backend
PYTHONPATH=yulu/scripts python3 -m stt_daemon &
DAEMON_PID=$!
sleep 1
./yulu/scripts/yulu stt status --json | python3 -m json.tool
./yulu/scripts/yulu stt warm-up
kill $DAEMON_PID
wait $DAEMON_PID 2>/dev/null
```
Expected: status JSON shows `"ready": true`, warm-up prints ok.

- [ ] **Step 7: Commit**

```bash
git add yulu/scripts/stt_cli.py yulu/scripts/yulu tests/test_stt_cli.py
git commit -m "feat(stt_daemon): add yulu stt CLI (status/warm-up/logs/restart) + wrapper dispatch"
```

## Task 5.3: Extend `yulu doctor`

**Files:**
- Modify: `yulu/scripts/doctor.py`
- Modify: `tests/test_doctor.py`

- [ ] **Step 1: Read `doctor.py` to find the check-collection pattern**

Run: `python3 -c "import ast, sys; sys.path.insert(0, 'yulu/scripts'); import doctor; print([n for n in dir(doctor) if not n.startswith('_')])"`

Identify the function that aggregates checks (likely `collect_report()` or `main()`) and its dict/list shape.

- [ ] **Step 2: Add stt_daemon checks**

Add this helper to `yulu/scripts/doctor.py`:

```python
def check_stt_daemon(*, config_dir: Path = Path.home() / ".config" / "yulu") -> dict:
    socket_path = config_dir / "stt_daemon.sock"
    pid_file = config_dir / "stt_daemon.pid"
    vocab_db = config_dir / "vocab.sqlite"
    log_file = config_dir / "logs" / "stt_daemon.log"
    report = {
        "socket_path": str(socket_path),
        "socket_present": socket_path.exists(),
        "pid_file_present": pid_file.exists(),
        "vocab_db_present": vocab_db.exists(),
        "log_path": str(log_file),
        "log_present": log_file.exists(),
        "vocab_term_count": None,
        "daemon_reachable": False,
        "model_loaded": None,
        "in_flight_jobs": None,
        "active_sessions": None,
        "error": None,
    }

    # vocab count
    if vocab_db.exists():
        try:
            import sqlite3
            conn = sqlite3.connect(str(vocab_db))
            try:
                row = conn.execute("SELECT COUNT(*) FROM custom_words").fetchone()
                report["vocab_term_count"] = row[0]
            finally:
                conn.close()
        except sqlite3.DatabaseError as exc:
            report["error"] = f"vocab.sqlite read error: {exc}"

    # daemon health
    if socket_path.exists():
        try:
            import asyncio, json
            async def _ask():
                reader, writer = await asyncio.wait_for(
                    asyncio.open_unix_connection(str(socket_path)), timeout=2.0
                )
                writer.write(b'{"type":"health"}\n')
                await writer.drain()
                line = await asyncio.wait_for(reader.readline(), timeout=2.0)
                writer.close()
                try:
                    await writer.wait_closed()
                except (ConnectionResetError, BrokenPipeError):
                    pass
                return json.loads(line.decode())
            payload = asyncio.run(_ask())
            report["daemon_reachable"] = True
            report["model_loaded"] = payload.get("model_loaded")
            report["in_flight_jobs"] = payload.get("in_flight_jobs")
            report["active_sessions"] = payload.get("active_sessions")
        except Exception as exc:
            report["error"] = f"health rpc failed: {exc}"

    return report
```

Then in the existing aggregator, splice the result under the key `stt_daemon`. The exact wiring depends on doctor's current shape; add after the existing per-component checks.

- [ ] **Step 3: Extend the JSON smoke test**

Edit `tests/test_doctor.py`. Find the test that calls `doctor.main(["--json"])` (or similar) and add an assertion:

```python
def test_doctor_json_includes_stt_daemon(tmp_path, capsys):
    import doctor
    # Run with a non-existent config dir so checks are deterministic
    report = doctor.collect_report(config_dir=tmp_path)  # or whatever the aggregator is named
    assert "stt_daemon" in report
    sd = report["stt_daemon"]
    assert sd["daemon_reachable"] is False
    assert sd["socket_present"] is False
```

If the existing tests use a different entry point (e.g., subprocess), mirror that pattern instead. The assertion stays the same: `stt_daemon` key present, `daemon_reachable` is False when config dir is empty.

- [ ] **Step 4: Run — PASS**

Run: `python3 -m pytest tests/test_doctor.py -v`
Expected: all green (existing + new).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/doctor.py tests/test_doctor.py
git commit -m "feat(doctor): add stt_daemon health checks"
```

---

# Phase 6 — `transcribe.py` Reduced to Thin Client + Business Orchestration

**Outcome:** `transcribe.py` no longer launches mlx-whisper or whisper-cli subprocesses. All STT goes through the daemon. Business logic (`refine_transcript`, `summarize`, `fallback_summary`, `request_agent_summary`, agent-queue dispatch) stays inside `transcribe.py`. File length drops from 581 lines to < 200.

## Task 6.1: `transcribe_client.py` — synchronous RPC with retry

**Files:**
- Create: `yulu/scripts/transcribe_client.py`
- Create: `tests/test_transcribe_client.py`

- [ ] **Step 1: Write failing tests**

Write `tests/test_transcribe_client.py`:

```python
import asyncio
import json
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from vocab import VocabRepo, Scope, open_db
from stt_daemon.app import STTDaemonApp
from stt_daemon.config import DaemonConfig
from stt_daemon.runtime import MockSTTBackend
from transcribe_client import transcribe_file, DaemonUnavailable


def _spawn(tmp_path, text="ok output"):
    db = tmp_path / "vocab.sqlite"
    VocabRepo(open_db(db))
    cfg = DaemonConfig(
        socket_path=tmp_path / "stt.sock",
        vocab_db_path=db,
        pid_file=tmp_path / "stt.pid",
        log_path=None,
        sessions_dir=tmp_path / "sessions",
    )
    backends = {"mlx": MockSTTBackend(canned_text=text), "whisper": MockSTTBackend(canned_text=text)}
    return STTDaemonApp(cfg, backends=backends)


def test_transcribe_file_round_trip(tmp_path):
    async def go():
        app = _spawn(tmp_path, text="my transcript")
        await app.start()
        try:
            audio = tmp_path / "x.wav"
            audio.write_bytes(b"RIFFstub")
            return transcribe_file(
                audio_path=str(audio),
                engine="mlx",
                language="zh",
                meeting_title="T",
                socket_path=app.config.socket_path,
            )
        finally:
            await app.stop()
    result = asyncio.run(go())
    assert result["status"] == "ok"
    assert "my transcript" in result["text"]


def test_transcribe_file_daemon_unavailable(tmp_path):
    audio = tmp_path / "x.wav"
    audio.write_bytes(b"R")
    with pytest.raises(DaemonUnavailable):
        transcribe_file(
            audio_path=str(audio),
            engine="mlx",
            language="zh",
            socket_path=tmp_path / "missing.sock",
            connect_timeout_sec=0.5,
        )


def test_transcribe_file_retries_once_on_eof(tmp_path, monkeypatch):
    # Simulate one EOF then success via patching _send_once
    call_count = {"n": 0}
    import transcribe_client as tc

    real = tc._send_once

    async def flaky(socket_path, request, *, timeout, response_timeout):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise tc.DaemonEOF("simulated")
        return await real(socket_path, request, timeout=timeout, response_timeout=response_timeout)

    monkeypatch.setattr(tc, "_send_once", flaky)

    async def go():
        app = _spawn(tmp_path, text="second try")
        await app.start()
        try:
            audio = tmp_path / "x.wav"
            audio.write_bytes(b"RIFF")
            return transcribe_file(
                audio_path=str(audio),
                engine="mlx",
                language="zh",
                socket_path=app.config.socket_path,
            )
        finally:
            await app.stop()
    result = asyncio.run(go())
    assert result["status"] == "ok"
    assert call_count["n"] == 2  # one failure + one retry
```

- [ ] **Step 2: Run — FAIL with ImportError**

Run: `python3 -m pytest tests/test_transcribe_client.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement transcribe_client**

Write `yulu/scripts/transcribe_client.py`:

```python
"""Synchronous RPC client for the stt_daemon.

Used by transcribe.py and any other Python caller that needs file-level
transcription. Hides the asyncio surface behind a blocking function.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any, Optional

DEFAULT_SOCKET = Path.home() / ".config" / "yulu" / "stt_daemon.sock"


class DaemonUnavailable(Exception):
    """The daemon socket cannot be reached / connect timed out."""


class DaemonEOF(Exception):
    """Daemon closed the connection without a response."""


class DaemonError(Exception):
    """Daemon returned an error event."""


async def _send_once(
    socket_path: Path,
    request: dict,
    *,
    timeout: float,
    response_timeout: float,
) -> dict:
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(str(socket_path)),
            timeout=timeout,
        )
    except (FileNotFoundError, ConnectionRefusedError) as exc:
        raise DaemonUnavailable(str(exc)) from exc
    except asyncio.TimeoutError as exc:
        raise DaemonUnavailable("connect timeout") from exc

    try:
        writer.write((json.dumps(request) + "\n").encode())
        await writer.drain()
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=response_timeout)
        except asyncio.TimeoutError as exc:
            raise DaemonUnavailable("response timeout") from exc
        if not line:
            raise DaemonEOF("socket closed before response")
        return json.loads(line.decode())
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionResetError, BrokenPipeError):
            pass


def _run_with_retry(
    socket_path: Path,
    request: dict,
    *,
    connect_timeout_sec: float,
    response_timeout_sec: float,
) -> dict:
    last_exc: Optional[Exception] = None
    for attempt in (1, 2):
        try:
            return asyncio.run(_send_once(
                socket_path, request,
                timeout=connect_timeout_sec,
                response_timeout=response_timeout_sec,
            ))
        except DaemonEOF as exc:
            last_exc = exc
            continue  # retry once
        except DaemonUnavailable:
            raise
    raise DaemonUnavailable(f"retries exhausted: {last_exc}")


def transcribe_file(
    *,
    audio_path: str,
    engine: str = "mlx",
    language: str = "zh",
    meeting_title: Optional[str] = None,
    session_id: Optional[str] = None,
    kind: str = "final_transcribe",
    word_timestamps: bool = False,
    condition_on_previous: bool = True,
    hallucination_silence_threshold: float = 2.0,
    timeout_sec: int = 7200,
    socket_path: Optional[Path] = None,
    connect_timeout_sec: float = 5.0,
    response_timeout_sec: float = 7200.0,
) -> dict[str, Any]:
    """Synchronously transcribe one audio file via the running stt_daemon.

    Returns the daemon's `transcribe_result` payload (dict). Raises
    `DaemonUnavailable` if the daemon is not running. Retries once if the
    daemon closes the connection mid-request (covers daemon-restart races).
    """
    socket_path = Path(socket_path or DEFAULT_SOCKET)
    request = {
        "type": "transcribe",
        "job_id": str(uuid.uuid4()),
        "kind": kind,
        "engine": engine,
        "language": language,
        "audio_path": str(Path(audio_path).resolve()),
        "audio_offset_bytes": 0,
        "audio_length_bytes": None,
        "audio_format": "wav-pcm-s16le-16k-mono",
        "meeting_title": meeting_title,
        "session_id": session_id,
        "word_timestamps": word_timestamps,
        "condition_on_previous": condition_on_previous,
        "hallucination_silence_threshold": hallucination_silence_threshold,
        "timeout_sec": timeout_sec,
    }
    response = _run_with_retry(
        socket_path, request,
        connect_timeout_sec=connect_timeout_sec,
        response_timeout_sec=response_timeout_sec,
    )
    if response.get("type") == "error":
        raise DaemonError(response.get("message", "daemon error"))
    if response.get("type") != "transcribe_result":
        raise DaemonError(f"unexpected response: {response.get('type')}")
    return response
```

- [ ] **Step 4: Run — PASS**

Run: `python3 -m pytest tests/test_transcribe_client.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/transcribe_client.py tests/test_transcribe_client.py
git commit -m "feat(transcribe): add synchronous RPC client with retry-on-EOF"
```

## Task 6.2: Refactor `transcribe.py` to thin client

**Files:**
- Modify: `yulu/scripts/transcribe.py` (drastic reduction)
- Modify: `tests/test_transcription_config.py` (update any tests that touched deleted helpers)

- [ ] **Step 1: Take a snapshot of what business logic to preserve**

Read [yulu/scripts/transcribe.py](yulu/scripts/transcribe.py) and identify the functions to KEEP (with minor adaptation):
- `load_config` — unchanged.
- `refine_transcript` — keep (LLM cleanup pass; still subprocess to claude/codex).
- `summarize` — keep (LLM call).
- `fallback_summary` — keep.
- `request_agent_summary` — keep.
- `_send_agent_notification` — keep.
- `_notify_agent` — keep.
- `normalize_post_recording_mode` — keep.
- `read_realtime_transcript` — keep (still reads `<meeting>.realtime.transcript.txt` written by daemon).

DELETE entirely:
- `DEFAULT_TRANSCRIBE_CMD`, `DEFAULT_MLX_PYTHON`, `DEFAULT_MLX_MODEL`, `DEFAULT_GLOSSARY` constants (now in seed module or daemon config).
- `transcribe()` (whisper-cli inline path).
- `transcribe_mlx()` (mlx-whisper inline path).
- `_glossary_prompt()` (now in VocabCache.inject_prompt).
- `normalize_transcript_text()` (now in VocabCache.apply_replacements — daemon already applies before returning).
- `final_transcribe_audio()` (now `transcribe_client.transcribe_file`).
- `_looks_like_agent_event_json` — keep only if `refine_transcript` / `summarize` still needs it (they do; keep).

- [ ] **Step 2: Write the new `transcribe.py` from scratch**

Overwrite `yulu/scripts/transcribe.py`:

```python
#!/usr/bin/env python3
"""Process a recorded meeting: orchestrate transcription via stt_daemon,
optionally polish via LLM, persist summary, and dispatch to agent queue.

This file replaces the previous in-process mlx-whisper / whisper-cli
subprocess invocations with stt_daemon RPC calls. All STT lives in the
daemon now; transcribe.py is the *business* orchestrator.
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

from transcribe_client import transcribe_file, DaemonUnavailable, DaemonError

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"

FAST_POST_RECORDING_MODE = "fast_summary"
FULL_POST_RECORDING_MODE = "full_transcribe"

NOTIFY_SCRIPT = Path(__file__).parent / "notify.py"

SUMMARY_PROMPT = """请将以下会议转录整理成结构化会议纪要。

会议主题：{title}

{template_section}

要求：
1. 列出会议基本信息（主题、时间）
2. 按议题分类讨论要点，每个议题下列出关键发言和结论
3. 提取所有 Action Items（待办事项），标注负责人和截止日期（如能从内容推断）
4. 提取关键决策结论
5. 使用中文，Markdown 格式输出，不要任何额外说明文字

会议转录：
---
{transcript}
---
"""


def load_config():
    if not CONFIG_PATH.exists():
        print(f"Config not found at {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def _looks_like_agent_event_json(text: str) -> bool:
    s = (text or "").strip()
    if not s.startswith("["):
        return False
    try:
        data = json.loads(s)
    except Exception:
        return False
    if not isinstance(data, list) or not data:
        return False
    event_types = {
        "transcript", "summary_ready", "transcribing", "summary_request",
        "realtime_transcribing", "realtime_transcript_error",
    }
    return all(isinstance(x, dict) and x.get("type") in event_types for x in data)


def refine_transcript(transcript: str, meeting_title: str, trans_cfg: dict, llm_cfg: dict) -> str:
    """Optional LLM polish pass over the daemon-returned transcript."""
    cleanup_cfg = trans_cfg.get("cleanup", {}) if isinstance(trans_cfg.get("cleanup"), dict) else {}
    enabled = cleanup_cfg.get("enabled", True)
    if not enabled or not llm_cfg.get("enabled", True):
        return transcript
    cmd_template = cleanup_cfg.get("command") or llm_cfg.get("command") or []
    if not cmd_template or cmd_template == [""]:
        return transcript
    prompt = f"""请清理以下会议转录，输出 cleaned transcript，不要摘要，不要增删事实。

会议主题：{meeting_title}

要求：
- 保留时间戳。
- 去除明显重复幻觉句。
- 恢复合理标点和段落；口语可轻微整理，但不要改写观点。
- 不要输出解释，只输出清理后的 transcript。

原始转录：
---
{transcript}
---
"""
    print(f"🧹 Transcript cleanup LLM: {shlex.join(cmd_template)}")
    try:
        result = subprocess.run(
            cmd_template, input=prompt,
            capture_output=True, text=True,
            timeout=int(cleanup_cfg.get("timeout_sec", llm_cfg.get("timeout_sec", 900))),
        )
        if result.returncode == 0 and result.stdout.strip():
            cleaned = result.stdout.strip()
            if not _looks_like_agent_event_json(cleaned):
                return cleaned
            print("Transcript cleanup returned agent-event JSON; keeping daemon transcript", file=sys.stderr)
        else:
            print(f"Transcript cleanup failed: {result.stderr}", file=sys.stderr)
    except Exception as exc:
        print(f"Transcript cleanup error: {exc}", file=sys.stderr)
    return transcript


def summarize(transcript: str, meeting_title: str, llm_cfg: dict) -> Optional[str]:
    cmd_template = llm_cfg.get("command") or []
    if not cmd_template or cmd_template == [""]:
        print("🤖 未配置 llm.command，写入 agent queue 后使用本地规则草稿...")
        return None
    if cmd_template[0] == "claude":
        try:
            subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=10, check=True)
        except Exception as exc:
            print(f"Claude CLI unavailable: {exc}", file=sys.stderr)
            return None

    template_section = ""
    template_path = Path(__file__).parent / "summary_template.md"
    if template_path.exists():
        template = template_path.read_text(encoding="utf-8").strip()
        template_section = f"请优先遵循这个纪要模板：\n---\n{template}\n---"
    prompt = SUMMARY_PROMPT.format(title=meeting_title, transcript=transcript, template_section=template_section)
    print(f"🤖 LLM: {shlex.join(cmd_template)}")
    try:
        result = subprocess.run(
            cmd_template, input=prompt,
            capture_output=True, text=True,
            timeout=int(llm_cfg.get("timeout_sec", 600)),
        )
        if result.returncode == 0:
            summary = result.stdout.strip()
            if summary and not _looks_like_agent_event_json(summary):
                return summary
            print("LLM returned empty or agent-event JSON; falling back", file=sys.stderr)
        else:
            print(f"LLM failed: {result.stderr}", file=sys.stderr)
    except Exception as exc:
        print(f"LLM error: {exc}", file=sys.stderr)
    return None


def fallback_summary(transcript: str, meeting_title: str) -> str:
    lines = [line.strip() for line in transcript.splitlines() if line.strip()]
    text = " ".join(lines)
    tldr = text[:220] + ("…" if len(text) > 220 else "")
    points = []
    for line in lines:
        if len(line) >= 4 and line not in points:
            points.append(line)
        if len(points) >= 8:
            break
    action_lines = [
        line for line in lines
        if re.search(r"(需要|要做|负责|跟进|安排|确认|明天|下周|todo|action)", line, re.I)
    ]
    question_lines = [
        line for line in lines
        if "?" in line or "？" in line or re.search(r"(问题|疑问|阻塞|不确定|block)", line, re.I)
    ]
    decision_lines = [
        line for line in lines
        if re.search(r"(决定|确认|结论|同意|采用|最终)", line)
    ]
    def bullets(items, empty="无明确内容"):
        return "\n".join(f"- {x}" for x in items[:8]) if items else f"- {empty}"
    def todos(items):
        return "\n".join(f"- [ ] {x}" for x in items[:8]) if items else "- [ ] 无明确待办"
    return (
        f"# {meeting_title}\n\n"
        f"## TL;DR\n{tldr or '转录为空，无法生成摘要。'}\n\n"
        f"## Discussion Points\n{bullets(points)}\n\n"
        f"## Action Items\n{todos(action_lines)}\n\n"
        f"## Open Questions / Blockers\n{bullets(question_lines)}\n\n"
        f"## Decisions Made\n{bullets(decision_lines, '无明确决策')}\n\n"
        f"---\n"
        f"## 原始转录\n\n{transcript}\n"
    )


def request_agent_summary(meeting_title: str, transcript_path: Path, summary_path: Path) -> None:
    template_path = Path(__file__).parent / "summary_template.md"
    try:
        from agent_notify import notify
        notify(
            "summary_request",
            title=meeting_title,
            transcript_path=str(transcript_path),
            summary_path=str(summary_path),
            template_path=str(template_path),
        )
    except Exception as exc:
        print(f"agent_notify failed: {exc}", file=sys.stderr)


def _notify_agent(event_type: str, **kw):
    try:
        from agent_notify import notify
        notify(event_type, **kw)
    except Exception:
        pass


def normalize_post_recording_mode(value) -> str:
    raw = str(value or FAST_POST_RECORDING_MODE).strip().lower().replace("-", "_")
    aliases = {
        "fast": FAST_POST_RECORDING_MODE, "quick": FAST_POST_RECORDING_MODE,
        "realtime": FAST_POST_RECORDING_MODE, "realtime_polish": FAST_POST_RECORDING_MODE,
        "realtime_summary": FAST_POST_RECORDING_MODE, "fast_summary": FAST_POST_RECORDING_MODE,
        "full": FULL_POST_RECORDING_MODE, "quality": FULL_POST_RECORDING_MODE,
        "final": FULL_POST_RECORDING_MODE, "full_transcribe": FULL_POST_RECORDING_MODE,
        "final_transcribe": FULL_POST_RECORDING_MODE,
    }
    return aliases.get(raw, raw if raw in {FAST_POST_RECORDING_MODE, FULL_POST_RECORDING_MODE} else FAST_POST_RECORDING_MODE)


def read_realtime_transcript(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8").strip()
    return text or None


def _request_final_transcribe(audio_path: Path, trans_cfg: dict, meeting_title: str) -> Optional[str]:
    """Ask the daemon to transcribe the file. Returns text or None on failure."""
    engine = trans_cfg.get("final_engine", "mlx")
    language = trans_cfg.get("language", "zh")
    try:
        response = transcribe_file(
            audio_path=str(audio_path),
            engine=engine,
            language=language,
            meeting_title=meeting_title,
            kind="file_transcribe",
        )
    except DaemonUnavailable as exc:
        print(f"⚠️ stt_daemon unavailable: {exc}", file=sys.stderr)
        return None
    except DaemonError as exc:
        print(f"⚠️ stt_daemon error: {exc}", file=sys.stderr)
        return None
    if response.get("status") != "ok":
        print(f"⚠️ daemon transcribe failed: {response.get('error')}", file=sys.stderr)
        return None
    return response["text"]


def process_audio(audio_path_str: str) -> tuple[str, str]:
    config = load_config()
    trans_cfg = config.get("transcription", {})
    llm_cfg = config.get("llm", {})

    audio_path = Path(audio_path_str)
    if not audio_path.exists():
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    meeting_title = audio_path.stem.rsplit("_", 1)[0].replace("_", " ")
    print(f"📁 处理: {audio_path.name}（标题: {meeting_title}）")

    raw_transcript_path = audio_path.with_suffix(".raw.transcript.txt")
    realtime_transcript_path = audio_path.with_suffix(".realtime.transcript.txt")
    transcript: Optional[str] = None
    post_mode = normalize_post_recording_mode(trans_cfg.get("post_recording_mode"))

    if post_mode == FAST_POST_RECORDING_MODE:
        transcript = read_realtime_transcript(realtime_transcript_path)
        if transcript:
            print(f"⚡ 使用实时转写结果进行清理和摘要: {realtime_transcript_path}")
        else:
            print("⚠️ 未找到可用实时转写，回退到完整 daemon 转录", file=sys.stderr)

    if transcript is None:
        transcript = _request_final_transcribe(audio_path, trans_cfg, meeting_title)
        if transcript is None:
            transcript = read_realtime_transcript(realtime_transcript_path)
            if transcript is None:
                print("❌ 无法获取任何转录，daemon 不可用且无 realtime 结果", file=sys.stderr)
                sys.exit(2)

    raw_transcript_path.write_text(transcript, encoding="utf-8")
    transcript = refine_transcript(transcript, meeting_title, trans_cfg, llm_cfg)

    transcript_path = audio_path.with_suffix(".transcript.txt")
    transcript_path.write_text(transcript, encoding="utf-8")
    print(f"✅ 原始转录已保存: {raw_transcript_path}")
    print(f"✅ 清理转录已保存: {transcript_path}")

    summary = None
    llm_enabled = llm_cfg.get("enabled", True)
    if llm_enabled:
        summary = summarize(transcript, meeting_title, llm_cfg)
    agent_should_finalize = False
    if summary is None:
        summary = fallback_summary(transcript, meeting_title)
        agent_should_finalize = bool(llm_enabled)

    summary_path = audio_path.with_suffix(".summary.md")
    summary_path.write_text(summary, encoding="utf-8")
    print(f"✅ 纪要已保存: {summary_path}")

    summary_html_path = ""
    try:
        from html_artifact import write_meeting_summary_html
        summary_html_path = str(write_meeting_summary_html(
            summary_path,
            transcript_path,
            audio_path.with_suffix(".summary.html"),
            title=meeting_title,
        ))
        print(f"✅ HTML 工作台已保存: {summary_html_path}")
    except Exception as exc:
        print(f"⚠️ HTML summary generation failed: {exc}", file=sys.stderr)

    if agent_should_finalize:
        print("Summary status: draft_agent_pending")
        request_agent_summary(meeting_title, transcript_path, summary_path)
    else:
        print("Summary status: final")
        _notify_agent("summary_ready", title=meeting_title, path=str(summary_path), html_path=summary_html_path)

    return str(transcript_path), str(summary_path)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file_path>", file=sys.stderr)
        sys.exit(1)
    process_audio(sys.argv[1])
```

- [ ] **Step 3: Update tests that referenced deleted helpers**

Read `tests/test_transcription_config.py`. If any test imports `transcribe.transcribe`, `transcribe.transcribe_mlx`, `_glossary_prompt`, `normalize_transcript_text`, etc., either:
- Update the test to call the equivalent through the daemon path (preferred), or
- Move the assertion to test new code (e.g., `VocabCache.apply_replacements`).

For each such test, write the replacement inline. Example: if there's a test that mocks `subprocess.run` to check `whisper-cli` flags, delete it (no longer relevant — the daemon owns whisper-cli).

If no tests touch the deleted helpers, skip this step.

- [ ] **Step 4: Verify line count target**

Run: `wc -l yulu/scripts/transcribe.py`
Expected: < 200 lines.

- [ ] **Step 5: Run full suite**

Run: `python3 -m pytest -q`
Expected: all green.

- [ ] **Step 6: Smoke-test transcribe.py end to end against a running daemon**

Run:
```bash
# Spin up daemon
PYTHONPATH=yulu/scripts python3 -m stt_daemon &
DAEMON_PID=$!
sleep 1
# Make a fake audio
python3 -c "
import wave
with wave.open('/tmp/yulu-smoke.wav', 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b'\\x00\\x10' * 16000)
"
# Make a minimal config
mkdir -p ~/.config/yulu
cat > ~/.config/yulu/config.json <<'CFG'
{"transcription": {"final_engine": "mlx", "language": "zh", "post_recording_mode": "full"}, "llm": {"enabled": false}}
CFG
PYTHONPATH=yulu/scripts python3 yulu/scripts/transcribe.py /tmp/yulu-smoke.wav
kill $DAEMON_PID
```
Expected: `.transcript.txt`, `.summary.md`, `.summary.html` produced next to the smoke wav. Note: the daemon in this smoke test is running with mock backends (Phase 3 swaps to real); the text will be the mock canned response.

- [ ] **Step 7: Commit**

```bash
git add yulu/scripts/transcribe.py tests/test_transcription_config.py
git commit -m "refactor(transcribe): reduce to thin daemon client + business orchestration"
```

---

# Phase 7 — meeting_daemon Migration + Delete `realtime_transcribe.py`

**Outcome:** `meeting_daemon` opens a `subscribe_session` connection to the daemon when recording starts; partial events stream live transcript to `<meeting>.realtime.transcript.txt`. The old `realtime_transcribe.py` is deleted from the repo.

## Task 7.1: `meeting_daemon` subscribe / unsubscribe integration

**Files:**
- Modify: `yulu/scripts/meeting_daemon.py`
- Create: `tests/test_meeting_daemon_subscribe.py`

- [ ] **Step 1: Read meeting_daemon.py to find where recording-start and recording-stop happen**

Run: `grep -n "record_audio\|realtime_transcribe\|subprocess.Popen\|state_store" yulu/scripts/meeting_daemon.py | head -40`

Identify the points where `meeting_daemon`:
- Starts recording (currently kicks off `realtime_transcribe.py` as a subprocess)
- Stops recording (kills realtime_transcribe and runs `transcribe.py`)

- [ ] **Step 2: Write the subscribe-helper module + tests**

Write `tests/test_meeting_daemon_subscribe.py`:

```python
import asyncio
import json
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from vocab import VocabRepo, open_db
from stt_daemon.app import STTDaemonApp
from stt_daemon.config import DaemonConfig
from stt_daemon.runtime import MockSTTBackend

# meeting_daemon's new subscribe helper lives in meeting_daemon itself,
# exported as `subscribe_session_lifecycle`. We import it directly.
from meeting_daemon import subscribe_session_lifecycle


def _write_wav(path, seconds=1.0):
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000)
        wf.writeframes(b"\x00\x10" * int(16000 * seconds))


def _spawn(tmp_path):
    db = tmp_path / "vocab.sqlite"
    VocabRepo(open_db(db))
    cfg = DaemonConfig(
        socket_path=tmp_path / "stt.sock",
        vocab_db_path=db,
        pid_file=tmp_path / "stt.pid",
        log_path=None,
        sessions_dir=tmp_path / "sessions",
    )
    backends = {"mlx": MockSTTBackend(canned_text="live-chunk-text")}
    return STTDaemonApp(cfg, backends=backends)


def test_subscribe_collects_partials_and_finalizes(tmp_path):
    async def go():
        app = _spawn(tmp_path)
        await app.start()
        try:
            wav = tmp_path / "rec.wav"
            _write_wav(wav, seconds=1.0)
            realtime_path = tmp_path / "rec.realtime.transcript.txt"

            # Run subscribe lifecycle in background; stop after a short delay
            stop_event = asyncio.Event()
            task = asyncio.create_task(subscribe_session_lifecycle(
                socket_path=app.config.socket_path,
                sid="meet-1",
                mic_path=str(wav),
                sys_path=None,
                engine="mlx",
                language="zh",
                chunk_sec=0.5,
                realtime_transcript_path=realtime_path,
                stop_event=stop_event,
            ))
            # Append more audio so a chunk fires
            with open(wav, "ab") as f:
                f.write(b"\x00\x10" * 16000)  # +1s
            await asyncio.sleep(1.0)
            stop_event.set()
            await task
            return realtime_path.read_text(encoding="utf-8") if realtime_path.exists() else ""
        finally:
            await app.stop()
    content = asyncio.run(go())
    assert "live-chunk-text" in content
```

- [ ] **Step 3: Implement the subscribe helper in `meeting_daemon.py`**

Append to `yulu/scripts/meeting_daemon.py` (or place near the recording start/stop block):

```python
import asyncio
import json
from pathlib import Path
from typing import Optional


async def subscribe_session_lifecycle(
    *,
    socket_path: Path,
    sid: str,
    mic_path: str,
    sys_path: Optional[str],
    engine: str,
    language: str,
    chunk_sec: float,
    realtime_transcript_path: Path,
    stop_event: asyncio.Event,
) -> None:
    """Open a subscribe_session connection; stream partials to disk.

    Returns when `stop_event` is set or the connection drops.
    The caller is responsible for sending `unsubscribe_session` afterwards.
    """
    reader, writer = await asyncio.open_unix_connection(str(socket_path))
    sub = {
        "type": "subscribe_session",
        "sid": sid,
        "mic_path": str(mic_path),
        "sys_path": str(sys_path) if sys_path else None,
        "engine": engine,
        "language": language,
        "chunk_sec": chunk_sec,
    }
    writer.write((json.dumps(sub) + "\n").encode())
    await writer.drain()

    # First response is OkResponse from subscribe.
    ack = await reader.readline()
    if not ack:
        return
    realtime_transcript_path.parent.mkdir(parents=True, exist_ok=True)
    buffer: list[str] = []

    async def reader_loop():
        while True:
            line = await reader.readline()
            if not line:
                return
            try:
                msg = json.loads(line.decode())
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "partial":
                source = msg.get("source", "")
                tag = "Me" if source == "mic" else "Them"
                buffer.append(f"[{tag}] {msg.get('text', '').strip()}")
                realtime_transcript_path.write_text("\n".join(buffer), encoding="utf-8")
            elif msg.get("type") == "final_ready":
                break

    reader_task = asyncio.create_task(reader_loop())
    stop_task = asyncio.create_task(stop_event.wait())
    done, pending = await asyncio.wait(
        [reader_task, stop_task], return_when=asyncio.FIRST_COMPLETED
    )
    for p in pending:
        p.cancel()

    if stop_event.is_set():
        unsub = {"type": "unsubscribe_session", "sid": sid, "reason": "stopped"}
        try:
            writer.write((json.dumps(unsub) + "\n").encode())
            await writer.drain()
        except (ConnectionResetError, BrokenPipeError):
            pass

    writer.close()
    try:
        await writer.wait_closed()
    except (ConnectionResetError, BrokenPipeError):
        pass
```

Then replace the section that currently spawns `realtime_transcribe.py` as a subprocess. The exact patch depends on `meeting_daemon.py`'s current layout; conceptually:

```python
# OLD (delete):
# realtime_proc = subprocess.Popen([sys.executable, str(SCRIPTS / "realtime_transcribe.py"), ...])

# NEW:
import asyncio, threading
_stop_event = asyncio.Event()
_subscribe_thread = threading.Thread(
    target=lambda: asyncio.run(subscribe_session_lifecycle(
        socket_path=Path.home() / ".config" / "yulu" / "stt_daemon.sock",
        sid=session_id,
        mic_path=audio_path,
        sys_path=None,
        engine=trans_cfg.get("realtime", {}).get("engine", trans_cfg.get("final_engine", "mlx")),
        language=trans_cfg.get("language", "zh"),
        chunk_sec=float(trans_cfg.get("realtime", {}).get("chunk_sec", 10)),
        realtime_transcript_path=audio_path.with_suffix(".realtime.transcript.txt"),
        stop_event=_stop_event,
    )),
    daemon=True,
)
_subscribe_thread.start()

# On stop:
_stop_event.set()
_subscribe_thread.join(timeout=10)
```

(Substitute the variable names — `session_id`, `audio_path`, `trans_cfg` — to whatever meeting_daemon already uses for those values. If meeting_daemon already uses asyncio internally, drop the threading shim.)

- [ ] **Step 4: Run test — PASS**

Run: `python3 -m pytest tests/test_meeting_daemon_subscribe.py -v`
Expected: 1 passed.

- [ ] **Step 5: Run full test suite**

Run: `python3 -m pytest -q`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/meeting_daemon.py tests/test_meeting_daemon_subscribe.py
git commit -m "feat(meeting_daemon): subscribe to stt_daemon live sessions instead of spawning realtime_transcribe"
```

## Task 7.2: Delete `realtime_transcribe.py`

**Files:**
- Delete: `yulu/scripts/realtime_transcribe.py`

- [ ] **Step 1: Verify nothing else references the script**

Run: `grep -rn "realtime_transcribe" yulu/ tests/ scripts/ .github/ 2>/dev/null | grep -v "^Binary"`
Expected: zero hits outside of the file itself.

If hits are found (e.g., setup.sh references it), patch each call site to either remove the reference or replace with the daemon-equivalent path. The grep result is your TODO list for this step.

- [ ] **Step 2: Delete the file**

Run: `git rm yulu/scripts/realtime_transcribe.py`

- [ ] **Step 3: Run full suite + py_compile**

Run: `make test`
Expected: all green; no compile error from the deleted file.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: delete realtime_transcribe.py (absorbed into stt_daemon)"
```

---

# Phase 8 — Source Cleanup

**Outcome:** No vocab data lives in source code or `config.example.json`. Repo grep for `mlx_whisper` shows hits only inside `yulu/scripts/stt_daemon/`. Acceptance criteria #2 and #4 from the spec are met.

## Task 8.1: Remove `transcription.replacements` from `config.example.json`

**Files:**
- Modify: `yulu/scripts/config.example.json`
- Modify: `tests/test_transcription_config.py` (if it asserts on the field)

- [ ] **Step 1: Inspect the example config**

Run: `cat yulu/scripts/config.example.json`

Locate `"transcription"` block. Note any `replacements` key.

- [ ] **Step 2: Edit the file**

Edit `yulu/scripts/config.example.json`:
- Remove the entire `"replacements": { ... }` key under `"transcription"`.
- Add a new top-level `"stt_daemon"` block with sensible defaults:

```json
"stt_daemon": {
  "default_engine": "mlx",
  "live_chunk_max_per_session": 4
}
```

- [ ] **Step 3: Verify no test asserts on the removed key**

Run: `grep -n "replacements" tests/test_transcription_config.py`

If any test references the removed key, update it to either:
- Confirm the key is absent (`assert "replacements" not in cfg["transcription"]`), or
- Delete the test if it was specifically about the legacy field.

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest tests/test_transcription_config.py -v`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/config.example.json tests/test_transcription_config.py
git commit -m "chore(config): drop transcription.replacements; add stt_daemon block defaults"
```

## Task 8.2: Verify acceptance criteria (codified as tests)

**Files:**
- Create: `tests/test_spec_acceptance.py`

- [ ] **Step 1: Write the acceptance test suite**

Write `tests/test_spec_acceptance.py`:

```python
"""Codifies acceptance criteria from the design spec
(docs/superpowers/specs/2026-05-22-stt-daemon-and-vocab-design.md §13)."""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"


def test_no_realtime_transcribe_in_repo():
    """Acceptance #2: realtime_transcribe.py deleted; mlx_whisper only inside stt_daemon."""
    if not (SCRIPTS / "realtime_transcribe.py").exists():
        pass  # deleted
    else:
        raise AssertionError("realtime_transcribe.py should have been deleted")

    # grep -r for mlx_whisper outside stt_daemon
    result = subprocess.run(
        ["grep", "-r", "-l", "mlx_whisper", str(SCRIPTS), str(ROOT / "tests")],
        capture_output=True, text=True,
    )
    hits = [Path(p) for p in result.stdout.strip().splitlines() if p]
    bad = [
        p for p in hits
        if "stt_daemon" not in p.parts and not p.name.startswith("test_stt_")
    ]
    assert not bad, f"mlx_whisper referenced outside stt_daemon: {bad}"


def test_transcribe_py_is_thin():
    """Acceptance #3: transcribe.py < 200 lines."""
    path = SCRIPTS / "transcribe.py"
    line_count = sum(1 for _ in path.open(encoding="utf-8"))
    assert line_count < 200, f"transcribe.py too long: {line_count} lines"


def test_default_glossary_constant_removed():
    """Acceptance #4: DEFAULT_GLOSSARY removed from transcribe.py source."""
    text = (SCRIPTS / "transcribe.py").read_text(encoding="utf-8")
    assert "DEFAULT_GLOSSARY" not in text, "DEFAULT_GLOSSARY should not appear in transcribe.py"


def test_replacements_dict_removed():
    """Acceptance #4 part 2: inline replacements dict removed from transcribe.py."""
    text = (SCRIPTS / "transcribe.py").read_text(encoding="utf-8")
    # Look for the specific legacy dict literal pattern
    assert "\"agent king\": \"AgentKey\"" not in text


def test_seed_count_threshold(tmp_path):
    """Acceptance #4 part 3: yulu vocab seed --from-current produces >= 23 rows."""
    sys.path.insert(0, str(SCRIPTS))
    from vocab import VocabRepo, open_db
    from vocab.seed import seed_from_current
    repo = VocabRepo(open_db(tmp_path / "vocab.sqlite"))
    seed_from_current(repo, config_replacements=None)
    assert repo.count() >= 23, f"seed produced too few rows: {repo.count()}"
```

- [ ] **Step 2: Run — verify all assertions pass**

Run: `python3 -m pytest tests/test_spec_acceptance.py -v`
Expected: 5 passed.

- [ ] **Step 3: Run final full-suite check**

Run: `make test`
Expected: py_compile + pytest + swift build all green.

- [ ] **Step 4: Commit**

```bash
git add tests/test_spec_acceptance.py
git commit -m "test: codify spec acceptance criteria (no mlx_whisper outside daemon, thin transcribe.py)"
```

---

# Self-Review Checklist (For The Plan Author)

Before handing this plan to an implementer, the plan author should:

1. **Spec coverage** — Walk through every section of `docs/superpowers/specs/2026-05-22-stt-daemon-and-vocab-design.md` and confirm each requirement is covered by at least one task. Cross-reference table:

| Spec Section | Tasks |
|---|---|
| §4 Process topology | Phase 2.5, Phase 7.1 |
| §5 stt_daemon internal layers | Phase 2.1, 2.2, 2.3, 2.4, 2.5, Phase 4.1 |
| §6 Unix socket protocol (all messages) | Phase 2.1 (codec), Phase 2.5 (RPC handlers), Phase 4.2 (subscribe handlers) |
| §6.4 Error codes | Phase 2.1 (enum), Phase 2.5 (returned in handlers) |
| §7 Vocab schema + seed | Phase 1 |
| §8 CLI surface | Phase 1.3 (yulu vocab), Phase 5.2 (yulu stt), Phase 1.4 + 5.2 (wrapper) |
| §9 launchd + signals + failure matrix | Phase 5.1 (plist), Phase 2.5 (signal handlers), Phase 4 (crash recovery) |
| §10 Observability + doctor | Phase 2.1 (JsonLogger), Phase 5.3 (doctor) |
| §11 Migration path (config, deleted files) | Phase 6, Phase 7, Phase 8 |
| §12 Testing strategy | All phases include tests; Phase 3.3 sets up e2e marker |
| §13 Acceptance criteria | Phase 8.2 codifies as runnable tests |

2. **Placeholder scan** — Search the plan for "TBD", "TODO", "fill in", "similar to". None of these should appear (the integration steps in Phase 5.3 and Phase 7.1 reference "the existing layout" but include actionable patches in the same step).

3. **Type consistency** —
   - `Scope` / `Source` / `JobKind` / `ErrorCode` / `MessageType` enums are defined once (Phase 1.1, Phase 2.1) and referenced by string value `.value` everywhere.
   - `STTBackend` Protocol method signatures (Phase 2.3) match `MlxWhisperBackend` and `WhisperCliBackend` implementations (Phase 3.1, Phase 3.2).
   - `Job` dataclass shape (Phase 2.4) matches what `LiveSessionManager` constructs (Phase 4.1).
   - `TranscribeResponse` field set matches what `transcribe_client._send_once` parses (Phase 6.1) and what `process_audio` reads (Phase 6.2).

If any gap is found during review, add the task inline.

---

**End of plan.**
