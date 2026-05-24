# Voicemail Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `yulu memo` CLI that captures mic-only voice notes into a dedicated inbox, transcribes them via the existing stt_daemon (Phase 3 SYS_DISABLED + DUAL_TRACK marker), enqueues voicemail-category prompts for LLM summarization, and provides inbox-management commands.

**Architecture:** Pure addition. Zero new daemons or sockets. Recording reuses Phase 3 `audio_daemon` with `sys_disabled=true` plus a new `silence_seconds` field to shorten the auto-stop threshold from 15 s to 3 s. Storage is a new `~/Movies/Yulu/voicemails/` directory. A new `voicemail` prompt category gets a one-time lazy SQL CHECK-constraint migration in `open_db()` so existing `prompts.sqlite` files migrate on first open. Inbox is filesystem-as-database; no new SQLite. The `agent_queue_worker` dispatcher already handles new prompts; a small post-dispatch hook fires `terminal-notifier` for completed `voicemail-todos` outputs.

**Tech Stack:** Python 3.x (`yulu/scripts/voicemail/*.py`, `prompts/`, `agent_queue_worker.py`), Swift 5.x (one-line change to `audio_daemon.swift` start handler), `pytest`, existing helpers (`recording_lock`, `transcribe_client`, `queue_store`, `PromptsCache`, `terminal-notifier`).

**Spec:** [`docs/superpowers/specs/2026-05-23-voicemail-inbox-design.md`](../specs/2026-05-23-voicemail-inbox-design.md)

---

## Phase A — Prompts: schema migration + seeds

### Task A.1: Category.VOICEMAIL + lazy CHECK migration

**Files:**
- Modify: `yulu/scripts/prompts/db.py` (`Category` enum at line 18, `_SCHEMA_SQL` CHECK clause at line 75, `open_db` at line 122)
- Create: `tests/test_prompts_voicemail_migration.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_prompts_voicemail_migration.py`:

```python
"""Verify Category.VOICEMAIL + lazy CHECK migration for pre-Phase-4
prompts.sqlite files."""

import sqlite3
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from prompts.db import Category, PromptsRepo, open_db


def test_category_voicemail_enum_value_exists():
    assert hasattr(Category, "VOICEMAIL")
    assert Category.VOICEMAIL.value == "voicemail"


def test_fresh_db_allows_voicemail_category(tmp_path):
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    p = repo.add(
        slug="vm-test", name="VM Test",
        category=Category.VOICEMAIL,
        content="hello {{transcript}}",
    )
    assert p.category is Category.VOICEMAIL
    fetched = repo.get_by_slug("vm-test")
    assert fetched.category is Category.VOICEMAIL


def test_legacy_db_migrates_to_include_voicemail(tmp_path):
    """Simulate a pre-Phase-4 prompts.sqlite that has the OLD CHECK
    constraint (only summary/cleanup). open_db must rewrite the table
    so voicemail is also accepted, while preserving all existing rows."""
    db = tmp_path / "legacy.sqlite"
    # Build the pre-Phase-4 schema by hand
    conn = sqlite3.connect(str(db))
    conn.executescript("""
        CREATE TABLE prompts (
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
    """)
    conn.execute(
        "INSERT INTO prompts (id, slug, name, category, content, "
        "is_auto_run, source, sort_order, created_at, updated_at) "
        "VALUES ('id-1', 'old-summary', 'Old Summary', 'summary', "
        "'content', 1, 'seed', 10, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
    )
    conn.commit()
    conn.close()

    # Now re-open with the new open_db — migration must run
    repo = PromptsRepo(open_db(db))
    # Existing row survived
    old = repo.get_by_slug("old-summary")
    assert old.category is Category.SUMMARY
    # And voicemail now accepted
    repo.add(slug="vm-after-migrate", name="VM After Migrate",
             category=Category.VOICEMAIL, content="{{transcript}}")
    assert repo.get_by_slug("vm-after-migrate") is not None


def test_migration_is_idempotent(tmp_path):
    """Opening a freshly-migrated DB a second time is a no-op."""
    db = tmp_path / "idem.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(slug="a", name="A", category=Category.VOICEMAIL,
             content="{{transcript}}")
    # Second open — must not raise, must not duplicate rows
    repo2 = PromptsRepo(open_db(db))
    all_rows = repo2.list_prompts()
    assert len([p for p in all_rows if p.slug == "a"]) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6 && PYTHONPATH=yulu/scripts python3 -m pytest tests/test_prompts_voicemail_migration.py -v`
Expected: AttributeError / OperationalError — `Category.VOICEMAIL` missing or CHECK constraint rejects.

- [ ] **Step 3: Add Category.VOICEMAIL enum value**

In `yulu/scripts/prompts/db.py`, find the `Category` enum (around line 18). Add `VOICEMAIL = "voicemail"` as a third member:

```python
class Category(str, Enum):
    SUMMARY = "summary"
    CLEANUP = "cleanup"
    VOICEMAIL = "voicemail"
```

- [ ] **Step 4: Update `_SCHEMA_SQL` CHECK clause for fresh DBs**

In `yulu/scripts/prompts/db.py` `_SCHEMA_SQL` (around line 75), change:

```sql
category TEXT NOT NULL CHECK(category IN ('summary', 'cleanup')),
```

to:

```sql
category TEXT NOT NULL CHECK(category IN ('summary', 'cleanup', 'voicemail')),
```

This handles fresh DBs. For existing DBs we still need the migration in Step 5.

- [ ] **Step 5: Add lazy migration in `open_db`**

In `yulu/scripts/prompts/db.py`, add this function above `open_db`:

```python
def _migrate_category_check_constraint(conn: sqlite3.Connection) -> None:
    """One-shot migration: if the `prompts.category` CHECK constraint
    doesn't include 'voicemail', rebuild the table with the new constraint.
    Idempotent — re-running is a no-op.

    SQLite has no `ALTER TABLE ... DROP CONSTRAINT`, so we use the standard
    rebuild dance (PRAGMA table_info won't show CHECK constraints — we
    inspect sqlite_master.sql instead).
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='prompts'"
    ).fetchone()
    if row is None:
        return  # no prompts table yet — fresh DB will get the new schema
    table_sql = row[0] if isinstance(row, tuple) else row["sql"]
    if "'voicemail'" in table_sql:
        return  # already migrated
    conn.executescript("""
        BEGIN;
        CREATE TABLE prompts_new (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN ('summary', 'cleanup', 'voicemail')),
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
```

Then in `open_db` (around line 122), after `conn.executescript(_SCHEMA_SQL)` add a call:

```python
def open_db(path: Path) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=2.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=2000")
    conn.executescript(_SCHEMA_SQL)
    _migrate_category_check_constraint(conn)   # NEW — runs on every open, idempotent
    conn.execute(
        # ... existing meta seeding ...
    )
    return conn
```

(Preserve all existing post-schema setup verbatim — only insert the one new line.)

- [ ] **Step 6: Run tests to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_prompts_voicemail_migration.py -v`
Expected: 4 passed.

- [ ] **Step 7: Confirm no Phase 1-3 regression**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/ -q 2>&1 | tail -5`
Expected: still 200 (or 200+4=204 with the 4 new tests) all green.

- [ ] **Step 8: Commit**

```bash
git add yulu/scripts/prompts/db.py tests/test_prompts_voicemail_migration.py
git commit -m "feat(prompts): add Category.VOICEMAIL + lazy CHECK migration"
```

---

### Task A.2: Seed voicemail-todos + voicemail-clean

**Files:**
- Modify: `yulu/scripts/prompts/seed.py` (append to `SEED_PROMPTS`)
- Modify: `tests/test_prompts_seed.py` (append assertions)

- [ ] **Step 1: Append failing tests**

Append to `tests/test_prompts_seed.py`:

```python
def test_seed_includes_voicemail_todos(tmp_path):
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current

    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    seed_from_current(repo)
    p = repo.get_by_slug("voicemail-todos")
    assert p is not None
    assert p.category.value == "voicemail"
    assert p.is_auto_run is True
    assert "{{transcript}}" in p.content
    assert "{{meeting_title}}" in p.content
    assert "{{date}}" in p.content


def test_seed_includes_voicemail_clean(tmp_path):
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current

    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    seed_from_current(repo)
    p = repo.get_by_slug("voicemail-clean")
    assert p is not None
    assert p.category.value == "voicemail"
    assert p.is_auto_run is False     # opt-in
    assert "{{transcript}}" in p.content


def test_seed_total_count_after_phase4(tmp_path):
    """4 phase-2/3 seeds + 2 phase-4 voicemail seeds = 6 minimum."""
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current

    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    seed_from_current(repo)
    assert len(repo.list_prompts()) >= 6
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_prompts_seed.py::test_seed_includes_voicemail_todos tests/test_prompts_seed.py::test_seed_includes_voicemail_clean tests/test_prompts_seed.py::test_seed_total_count_after_phase4 -v`
Expected: AssertionError — slugs not present.

- [ ] **Step 3: Add the two seed entries**

In `yulu/scripts/prompts/seed.py`, find the `SEED_PROMPTS` list. Append (matching the existing list-of-dict style):

```python
{
    "slug": "voicemail-todos",
    "name": "Voicemail Action Items",
    "category": "voicemail",
    "is_auto_run": True,
    "sort_order": 100,
    "content": """请基于以下语音备忘录，提取我提到的待办事项、想法、决定。

备忘录主题：{{meeting_title}}
时间：{{date}}

转录：
---
{{transcript}}
---

要求：
1. 输出 Markdown，分两段：## 待办事项 / ## 想法记录。
2. 待办事项每条一行，列出具体动作；如果提到了截止日期或对象，标在行末。
3. 想法记录每条 1-2 句，保留原话风格。
4. 不要输出原始转录，不要解释。
""",
},
{
    "slug": "voicemail-clean",
    "name": "Voicemail Cleanup",
    "category": "voicemail",
    "is_auto_run": False,
    "sort_order": 110,
    "content": """请清理以下语音备忘录的转录稿，输出可读版本。

转录：
---
{{transcript}}
---

要求：
- 修正标点和段落；
- 去除"嗯/啊/那个"等口水词；
- 不要改写观点或事实；
- 不要总结，只输出清理后的文本。
""",
},
```

(Match the shape of pre-existing seed entries — the seeder normalizes string `"voicemail"` → `Category.VOICEMAIL` on insert.)

- [ ] **Step 4: Update `test_seed_constants_complete`-style test if it asserts content on every prompt**

If `tests/test_prompts_seed.py` has a `test_seed_constants_complete` that iterates all prompts and asserts e.g. `{{transcript}}` substring, the voicemail prompts already include `{{transcript}}` so it passes. If it asserts `{{meeting_title}}` on every prompt, `voicemail-clean` fails — make that assertion slug-aware (e.g., skip `voicemail-clean` since its design intentionally omits the title). Adapt minimally.

- [ ] **Step 5: Run tests**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_prompts_seed.py -v`
Expected: all green (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/prompts/seed.py tests/test_prompts_seed.py
git commit -m "feat(prompts): seed voicemail-todos + voicemail-clean prompts"
```

---

## Phase B — Voicemail Repo (filesystem-as-database)

### Task B.1: `VoicemailRecord` + `list_voicemails`

**Files:**
- Create: `yulu/scripts/voicemail/__init__.py` (empty package marker)
- Create: `yulu/scripts/voicemail/repo.py`
- Create: `tests/test_voicemail_repo.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_voicemail_repo.py`:

```python
"""VoicemailRecord + list_voicemails — filesystem-as-database."""

import sys
import wave
from datetime import datetime
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from voicemail.repo import (
    VOICEMAIL_DIR_DEFAULT,
    VoicemailRecord,
    list_voicemails,
)


def _write_minimal_wav(path: Path, *, duration_sec: float = 1.0,
                       channels: int = 2, framerate: int = 48000) -> None:
    """Write a minimal valid stereo WAV of `duration_sec` for header parsing."""
    n_frames = int(framerate * duration_sec)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(framerate)
        w.writeframes(b"\x00" * n_frames * channels * 2)


def test_list_empty_dir_returns_empty_list(tmp_path):
    assert list_voicemails(directory=tmp_path) == []


def test_list_returns_newest_first(tmp_path):
    a = tmp_path / "voicemail_20260520_120000.wav"
    b = tmp_path / "voicemail_20260523_120000.wav"
    c = tmp_path / "voicemail_20260521_120000.wav"
    for p in (a, b, c):
        _write_minimal_wav(p, duration_sec=1)
    out = list_voicemails(directory=tmp_path)
    stems = [r.stem for r in out]
    assert stems == [
        "voicemail_20260523_120000",
        "voicemail_20260521_120000",
        "voicemail_20260520_120000",
    ]


def test_list_respects_limit(tmp_path):
    for i in range(25):
        p = tmp_path / f"voicemail_20260520_{120000 + i:06d}.wav"
        _write_minimal_wav(p, duration_sec=1)
    out = list_voicemails(directory=tmp_path, limit=10)
    assert len(out) == 10


def test_record_title_from_sidecar(tmp_path):
    wav = tmp_path / "voicemail_20260523_120000.wav"
    _write_minimal_wav(wav, duration_sec=2)
    (tmp_path / "voicemail_20260523_120000.title").write_text(
        "Anthropic pricing follow-up\n", encoding="utf-8"
    )
    out = list_voicemails(directory=tmp_path)
    assert out[0].title == "Anthropic pricing follow-up"


def test_record_title_falls_back_to_transcript_first_words(tmp_path):
    wav = tmp_path / "voicemail_20260523_120000.wav"
    _write_minimal_wav(wav, duration_sec=2)
    (tmp_path / "voicemail_20260523_120000.transcript.txt").write_text(
        "嗯 记得明天找 Anthropic 团队聊 pricing 的事 然后还要写一下 Phase 4 的 plan",
        encoding="utf-8",
    )
    out = list_voicemails(directory=tmp_path)
    # First 8 whitespace-separated tokens, joined with single spaces
    assert out[0].title == "嗯 记得明天找 Anthropic 团队聊 pricing 的事 然后"


def test_record_title_unknown_when_no_sidecar_no_transcript(tmp_path):
    wav = tmp_path / "voicemail_20260523_120000.wav"
    _write_minimal_wav(wav, duration_sec=2)
    out = list_voicemails(directory=tmp_path)
    assert out[0].title == "(no title)"


def test_record_duration_from_wav_header(tmp_path):
    wav = tmp_path / "voicemail_20260523_120000.wav"
    _write_minimal_wav(wav, duration_sec=12.5)
    out = list_voicemails(directory=tmp_path)
    assert 12 <= out[0].duration_sec <= 13   # int seconds


def test_record_created_at_parsed_from_filename(tmp_path):
    wav = tmp_path / "voicemail_20260523_201500.wav"
    _write_minimal_wav(wav, duration_sec=1)
    out = list_voicemails(directory=tmp_path)
    assert out[0].created_at == datetime(2026, 5, 23, 20, 15, 0)


def test_record_has_summary_flag(tmp_path):
    wav = tmp_path / "voicemail_20260523_120000.wav"
    _write_minimal_wav(wav, duration_sec=1)
    out = list_voicemails(directory=tmp_path)
    assert out[0].has_summary is False
    assert out[0].summary_slugs == []
    (tmp_path / "voicemail_20260523_120000.summary.md").write_text("hi", encoding="utf-8")
    (tmp_path / "voicemail_20260523_120000.voicemail-clean.summary.md").write_text("hi", encoding="utf-8")
    out2 = list_voicemails(directory=tmp_path)
    assert out2[0].has_summary is True
    assert set(out2[0].summary_slugs) == {"voicemail-todos", "voicemail-clean"}


def test_list_ignores_non_voicemail_wavs(tmp_path):
    # Meeting recording wav (different prefix) MUST be ignored
    (tmp_path / "ProductWeekly_20260523_120000.wav").write_bytes(b"")
    _write_minimal_wav(tmp_path / "voicemail_20260523_120000.wav")
    out = list_voicemails(directory=tmp_path)
    assert len(out) == 1
    assert out[0].stem == "voicemail_20260523_120000"


def test_default_dir_constant():
    assert VOICEMAIL_DIR_DEFAULT.name == "voicemails"
    assert "Movies/Yulu" in str(VOICEMAIL_DIR_DEFAULT)
```

NOTE: `summary_slugs` for the default `voicemail-todos` slug is reported as `"voicemail-todos"`. Detection: `.summary.md` (no infix) → slug = `"voicemail-todos"` (because that's the only auto-run voicemail prompt; the default-slug-without-infix convention from Phase 2 still applies but now refers to the default voicemail prompt). For non-default voicemail prompts the infix carries: `.voicemail-clean.summary.md` → slug `"voicemail-clean"`.

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_voicemail_repo.py -v`
Expected: ModuleNotFoundError.

- [ ] **Step 3: Create the package and repo**

Create `yulu/scripts/voicemail/__init__.py` (empty file).

Create `yulu/scripts/voicemail/repo.py`:

```python
"""Filesystem-as-database voicemail inbox.

Voicemails live as `voicemail_YYYYMMDD_HHMMSS.wav` files (plus siblings)
in ~/Movies/Yulu/voicemails/. This module exposes a small API to enumerate,
fetch (by id-prefix), and delete records — no SQLite involved.

Title resolution order (per spec §5):
  1. `<stem>.title` sidecar
  2. First 8 whitespace tokens of `<stem>.transcript.txt`
  3. Literal "(no title)"

Summary slugs:
  - `<stem>.summary.md` → "voicemail-todos" (default-slug convention from Phase 2)
  - `<stem>.<slug>.summary.md` → that <slug>
"""

from __future__ import annotations

import re
import wave
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import List, Optional

VOICEMAIL_DIR_DEFAULT = Path.home() / "Movies" / "Yulu" / "voicemails"
_STEM_RE = re.compile(r"^voicemail_(\d{8})_(\d{6})$")
_DEFAULT_SUMMARY_SLUG = "voicemail-todos"


@dataclass
class VoicemailRecord:
    stem: str
    wav_path: Path
    title: str
    duration_sec: int
    has_summary: bool
    summary_slugs: List[str]
    created_at: datetime


def _parse_created_at(stem: str) -> Optional[datetime]:
    m = _STEM_RE.match(stem)
    if not m:
        return None
    ymd, hms = m.groups()
    try:
        return datetime.strptime(ymd + hms, "%Y%m%d%H%M%S")
    except ValueError:
        return None


def _read_title(stem: str, directory: Path) -> str:
    title_sidecar = directory / f"{stem}.title"
    if title_sidecar.exists():
        text = title_sidecar.read_text(encoding="utf-8").strip()
        if text:
            return text
    transcript = directory / f"{stem}.transcript.txt"
    if transcript.exists():
        text = transcript.read_text(encoding="utf-8").strip()
        if text:
            tokens = text.split()[:8]
            return " ".join(tokens) if tokens else "(no title)"
    return "(no title)"


def _read_duration(wav_path: Path) -> int:
    try:
        with wave.open(str(wav_path), "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate()
            return int(frames / rate) if rate > 0 else 0
    except (wave.Error, OSError, EOFError):
        return 0


def _summary_slugs_for(stem: str, directory: Path) -> List[str]:
    slugs: list[str] = []
    default = directory / f"{stem}.summary.md"
    if default.exists():
        slugs.append(_DEFAULT_SUMMARY_SLUG)
    # `<stem>.<slug>.summary.md` siblings (skip default which has no infix)
    prefix = f"{stem}."
    suffix = ".summary.md"
    for child in directory.iterdir():
        name = child.name
        if not (name.startswith(prefix) and name.endswith(suffix)):
            continue
        infix = name[len(prefix):-len(suffix)]
        if infix and "." not in infix:    # safe slug
            slugs.append(infix)
    return slugs


def _make_record(stem: str, directory: Path) -> Optional[VoicemailRecord]:
    wav_path = directory / f"{stem}.wav"
    if not wav_path.exists():
        return None
    created = _parse_created_at(stem)
    if created is None:
        return None
    slugs = _summary_slugs_for(stem, directory)
    return VoicemailRecord(
        stem=stem,
        wav_path=wav_path,
        title=_read_title(stem, directory),
        duration_sec=_read_duration(wav_path),
        has_summary=bool(slugs),
        summary_slugs=slugs,
        created_at=created,
    )


def list_voicemails(*, directory: Path = VOICEMAIL_DIR_DEFAULT,
                    limit: int = 20) -> List[VoicemailRecord]:
    """Enumerate voicemails in `directory`, newest first, capped at `limit`."""
    directory = Path(directory)
    if not directory.exists():
        return []
    stems = []
    for child in directory.iterdir():
        if child.suffix != ".wav":
            continue
        stem = child.stem
        if _STEM_RE.match(stem):
            stems.append(stem)
    stems.sort(reverse=True)  # filename includes ts → sort = chronological
    out: List[VoicemailRecord] = []
    for stem in stems[:limit]:
        rec = _make_record(stem, directory)
        if rec is not None:
            out.append(rec)
    return out
```

- [ ] **Step 4: Run tests to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_voicemail_repo.py -v`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/voicemail/__init__.py yulu/scripts/voicemail/repo.py tests/test_voicemail_repo.py
git commit -m "feat(voicemail): add VoicemailRecord + list_voicemails (FS-as-DB)"
```

---

### Task B.2: `get_voicemail` (prefix match) + `delete_voicemail`

**Files:**
- Modify: `yulu/scripts/voicemail/repo.py` (add 2 functions + 1 exception)
- Modify: `tests/test_voicemail_repo.py` (append tests)

- [ ] **Step 1: Append failing tests**

Append to `tests/test_voicemail_repo.py`:

```python
import pytest

from voicemail.repo import (
    AmbiguousVoicemailId,
    VoicemailNotFound,
    delete_voicemail,
    get_voicemail,
)


def test_get_by_exact_stem(tmp_path):
    wav = tmp_path / "voicemail_20260523_120000.wav"
    _write_minimal_wav(wav, duration_sec=1)
    rec = get_voicemail("voicemail_20260523_120000", directory=tmp_path)
    assert rec.stem == "voicemail_20260523_120000"


def test_get_by_unique_prefix(tmp_path):
    _write_minimal_wav(tmp_path / "voicemail_20260523_120000.wav")
    _write_minimal_wav(tmp_path / "voicemail_20260521_120000.wav")
    rec = get_voicemail("voicemail_20260523", directory=tmp_path)
    assert rec.stem == "voicemail_20260523_120000"


def test_get_by_ambiguous_prefix_raises(tmp_path):
    _write_minimal_wav(tmp_path / "voicemail_20260523_120000.wav")
    _write_minimal_wav(tmp_path / "voicemail_20260523_180000.wav")
    with pytest.raises(AmbiguousVoicemailId) as exc:
        get_voicemail("voicemail_20260523", directory=tmp_path)
    assert "voicemail_20260523_120000" in exc.value.candidates
    assert "voicemail_20260523_180000" in exc.value.candidates


def test_get_missing_raises(tmp_path):
    with pytest.raises(VoicemailNotFound):
        get_voicemail("voicemail_00000000_000000", directory=tmp_path)


def test_delete_removes_all_siblings(tmp_path):
    stem = "voicemail_20260523_120000"
    _write_minimal_wav(tmp_path / f"{stem}.wav")
    (tmp_path / f"{stem}.transcript.txt").write_text("hi")
    (tmp_path / f"{stem}.raw.transcript.txt").write_text("hi")
    (tmp_path / f"{stem}.title").write_text("hi")
    (tmp_path / f"{stem}.summary.md").write_text("hi")
    (tmp_path / f"{stem}.voicemail-clean.summary.md").write_text("hi")
    (tmp_path / f"{stem}.summary.html").write_text("hi")

    rec = get_voicemail(stem, directory=tmp_path)
    removed = delete_voicemail(rec)
    assert removed == 7
    assert list(tmp_path.iterdir()) == []


def test_delete_idempotent_on_missing_siblings(tmp_path):
    stem = "voicemail_20260523_120000"
    _write_minimal_wav(tmp_path / f"{stem}.wav")
    # No siblings — just the wav
    rec = get_voicemail(stem, directory=tmp_path)
    removed = delete_voicemail(rec)
    assert removed == 1
    assert not (tmp_path / f"{stem}.wav").exists()


def test_delete_does_not_touch_other_voicemails(tmp_path):
    _write_minimal_wav(tmp_path / "voicemail_20260523_120000.wav")
    _write_minimal_wav(tmp_path / "voicemail_20260521_120000.wav")
    rec = get_voicemail("voicemail_20260523_120000", directory=tmp_path)
    delete_voicemail(rec)
    assert (tmp_path / "voicemail_20260521_120000.wav").exists()
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_voicemail_repo.py -v 2>&1 | tail -20`
Expected: ImportError on `AmbiguousVoicemailId` / `VoicemailNotFound` / `get_voicemail` / `delete_voicemail`.

- [ ] **Step 3: Add the functions + exceptions**

Append to `yulu/scripts/voicemail/repo.py`:

```python
class VoicemailNotFound(LookupError):
    """Raised when no voicemail matches the given id prefix."""

    def __init__(self, id_prefix: str):
        super().__init__(f"no voicemail matches '{id_prefix}'")
        self.id_prefix = id_prefix


class AmbiguousVoicemailId(LookupError):
    """Raised when an id prefix matches more than one voicemail."""

    def __init__(self, id_prefix: str, candidates: List[str]):
        super().__init__(
            f"id prefix '{id_prefix}' matches {len(candidates)} voicemails: {candidates}"
        )
        self.id_prefix = id_prefix
        self.candidates = candidates


def get_voicemail(id_prefix: str, *,
                  directory: Path = VOICEMAIL_DIR_DEFAULT) -> VoicemailRecord:
    """Resolve `id_prefix` to a unique VoicemailRecord, or raise.

    Exact stem match wins over prefix match.
    """
    directory = Path(directory)
    if not directory.exists():
        raise VoicemailNotFound(id_prefix)

    exact = _make_record(id_prefix, directory)
    if exact is not None:
        return exact

    matches: List[str] = []
    for child in directory.iterdir():
        if child.suffix != ".wav":
            continue
        stem = child.stem
        if _STEM_RE.match(stem) and stem.startswith(id_prefix):
            matches.append(stem)
    if not matches:
        raise VoicemailNotFound(id_prefix)
    if len(matches) > 1:
        matches.sort()
        raise AmbiguousVoicemailId(id_prefix, matches)
    rec = _make_record(matches[0], directory)
    if rec is None:
        raise VoicemailNotFound(id_prefix)
    return rec


def delete_voicemail(record: VoicemailRecord) -> int:
    """Remove the WAV and all `<stem>.*` sibling files. Returns the count."""
    directory = record.wav_path.parent
    prefix = f"{record.stem}."
    removed = 0
    # Remove the .wav itself
    if record.wav_path.exists():
        record.wav_path.unlink()
        removed += 1
    # Remove every sibling whose name starts with `<stem>.`
    for child in directory.iterdir():
        if child.name == record.wav_path.name:
            continue   # already removed above
        if child.name.startswith(prefix):
            try:
                child.unlink()
                removed += 1
            except OSError:
                pass
    return removed
```

- [ ] **Step 4: Run tests to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_voicemail_repo.py -v`
Expected: 18 passed (11 + 7).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/voicemail/repo.py tests/test_voicemail_repo.py
git commit -m "feat(voicemail): add get_voicemail (prefix match) + delete_voicemail"
```

---

## Phase C — Swift audio_daemon: silence_seconds field

### Task C.1: Accept silence_seconds in start action

**Files:**
- Modify: `yulu/scripts/audio_daemon.swift` (start action handler — already touched in B.3 for SYS_DISABLED)

- [ ] **Step 1: Add the field handling**

Run `grep -nE 'SYS_DISABLED.*sys_disabled' yulu/scripts/audio_daemon.swift` to locate the start handler (lines around 640). Find the line:

```swift
SYS_DISABLED = (json["sys_disabled"] as? Bool) ?? false
```

Add a sibling line immediately after, setting the recorder's silenceSeconds from the request (omitted → keep the default `DEFAULT_SILENCE_SEC`):

```swift
SYS_DISABLED = (json["sys_disabled"] as? Bool) ?? false
if let s = json["silence_seconds"] as? Int, s > 0 {
    recorder.silenceSeconds = Double(s)
} else if let s = json["silence_seconds"] as? Double, s > 0 {
    recorder.silenceSeconds = s
} else {
    recorder.silenceSeconds = DEFAULT_SILENCE_SEC
}
```

(`recorder` is the existing `AudioRecorder` instance referenced elsewhere in the dispatcher. If the local variable name differs, adapt; the field write is `<recorder>.silenceSeconds = …`. Per the existing `AudioRecorder.start(title:)`, `startSilenceMonitor()` reads `self.silenceSeconds` so the new value takes effect on this recording.)

The reset-when-omitted clause ensures that a meeting start (which doesn't send `silence_seconds`) doesn't inherit a voicemail's 3-second threshold from a previous recording.

- [ ] **Step 2: Build the daemon**

Run: `bash yulu/scripts/build_audio_daemon.sh`
Must succeed.

After successful build:
```bash
git checkout -- yulu/scripts/Yulu.app/  # revert build artifacts; this commit is source-only
```

- [ ] **Step 3: Commit**

```bash
git add yulu/scripts/audio_daemon.swift
git commit -m "feat(audio_daemon): accept silence_seconds in start action for voicemail (3s default)"
```

NOTE: the Yulu.app binary will be rebuilt as part of a final commit in Task G.3 (real-machine smoke). For testing purposes, the source change is what matters for Phase 4 unit tests; the binary will be re-baked when the user runs `build_audio_daemon.sh` after merge.

---

## Phase D — Recorder orchestration

### Task D.1: `_transcribe_and_enqueue` post-stop pipeline

**Files:**
- Create: `yulu/scripts/voicemail/recorder.py`
- Create: `tests/test_voicemail_recorder.py`

- [ ] **Step 1: Write failing test**

Create `tests/test_voicemail_recorder.py`:

```python
"""Voicemail recorder: post-stop transcribe + enqueue pipeline.

These tests stub the daemon socket and the prompts cache so the recorder
logic can be tested without launching audio_daemon / stt_daemon."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import voicemail.recorder as recorder
import queue_store


@pytest.fixture
def isolated_paths(tmp_path, monkeypatch):
    queue = tmp_path / "queue.json"
    lock = tmp_path / "queue.lock"
    prompts_db = tmp_path / "prompts.sqlite"
    monkeypatch.setattr(recorder, "AGENT_QUEUE_PATH", queue)
    monkeypatch.setattr(recorder, "PROMPTS_DB", prompts_db)
    monkeypatch.setattr(queue_store, "QUEUE_PATH", queue)
    monkeypatch.setattr(queue_store, "LOCK_PATH", lock)

    # Seed prompts so the cache returns voicemail prompts
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    repo = PromptsRepo(open_db(prompts_db))
    seed_from_current(repo)
    return queue, prompts_db


def test_transcribe_writes_mic_text_only(isolated_paths, tmp_path, monkeypatch):
    queue, prompts_db = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()

    fake_response = {
        "status": "ok",
        "layout": "dual_track",
        "channels": {
            "mic": {"text": "嗯 记得明天找 Anthropic 团队",
                    "segments": [{"start": 0.0, "end": 2.0,
                                  "text": "嗯 记得明天找 Anthropic 团队"}]},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        recorder._transcribe_and_enqueue(wav, title=None)

    # No speaker tag — single-speaker voicemail
    transcript_text = (wav.with_suffix(".transcript.txt")).read_text(encoding="utf-8")
    assert transcript_text == "嗯 记得明天找 Anthropic 团队"
    # raw mirrors transcript (pre-cleanup snapshot)
    raw = (wav.with_suffix(".raw.transcript.txt")).read_text(encoding="utf-8")
    assert raw == transcript_text
    # NO mic/sys siblings for voicemails (mono-equivalent)
    assert not wav.with_suffix(".mic.transcript.txt").exists()
    assert not wav.with_suffix(".sys.transcript.txt").exists()


def test_transcribe_writes_title_sidecar_when_provided(isolated_paths, tmp_path, monkeypatch):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {
        "status": "ok",
        "channels": {
            "mic": {"text": "hi", "segments": []},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        recorder._transcribe_and_enqueue(wav, title="Anthropic follow-up")
    sidecar = wav.with_suffix(".title")
    assert sidecar.read_text(encoding="utf-8") == "Anthropic follow-up\n"


def test_enqueues_only_voicemail_category_prompts(isolated_paths, tmp_path, monkeypatch):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {
        "status": "ok",
        "channels": {
            "mic": {"text": "hi", "segments": [{"start": 0.0, "end": 1.0, "text": "hi"}]},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        recorder._transcribe_and_enqueue(wav, title=None)
    events = json.loads(queue.read_text(encoding="utf-8"))
    # Only voicemail-todos (auto-run); voicemail-clean is opt-in
    slugs = [e["prompt_slug"] for e in events]
    assert slugs == ["voicemail-todos"]
    assert events[0]["audio_path"] == str(wav)
    # summary_path is <wav>.summary.md (default-slug convention from Phase 2)
    assert events[0]["summary_path"] == str(wav.with_suffix(".summary.md"))


def test_transcribe_handles_legacy_response_shape(isolated_paths, tmp_path, monkeypatch):
    """If stt_daemon returns the legacy single-text shape (channel_split=False),
    use response['text'] directly."""
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {"status": "ok", "layout": "mono",
                     "text": "legacy text", "segments": []}
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        recorder._transcribe_and_enqueue(wav, title=None)
    assert wav.with_suffix(".transcript.txt").read_text(encoding="utf-8") == "legacy text"


def test_transcribe_handles_daemon_error_gracefully(isolated_paths, tmp_path, monkeypatch):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {"status": "error", "error": "daemon dead"}
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        rc = recorder._transcribe_and_enqueue(wav, title=None)
    assert rc != 0
    assert not wav.with_suffix(".transcript.txt").exists()
    events = json.loads(queue.read_text(encoding="utf-8"))
    assert events == []
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_voicemail_recorder.py -v 2>&1 | tail -20`
Expected: AttributeError — `voicemail.recorder` doesn't exist.

- [ ] **Step 3: Create `voicemail/recorder.py` with the post-stop pipeline**

Create `yulu/scripts/voicemail/recorder.py`:

```python
"""Voicemail recorder — start/stop orchestration and post-stop transcribe.

This module owns the contract between `yulu memo` and the existing
audio_daemon / stt_daemon / agent_queue_worker pipeline. It does NOT
duplicate any Phase 1-3 primitives:

- Recording start  → record_audio.socket_send({action:'start', sys_disabled:true, ...})
- Recording stop   → record_audio.socket_send({action:'stop'})
- Transcript       → transcribe_client.request_final_transcribe(channel_split=True)
- Enqueue          → transcribe._enqueue_summary_request (reused verbatim)
- LLM dispatch     → agent_queue_worker (unchanged)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

from voicemail.repo import VOICEMAIL_DIR_DEFAULT

# Mirror Phase 2/3 constants for the live deployment
AGENT_QUEUE_PATH = Path.home() / ".config" / "yulu" / "agent-queue.json"
PROMPTS_DB = Path.home() / ".config" / "yulu" / "prompts.sqlite"
VOICEMAIL_DIR = VOICEMAIL_DIR_DEFAULT
DEFAULT_SILENCE_SECONDS = 3


def _request_transcribe(wav_path: Path) -> dict:
    """Thin wrapper around transcribe_client; isolates the import for tests."""
    from transcribe_client import request_final_transcribe
    try:
        return request_final_transcribe(
            wav=str(wav_path),
            title=wav_path.stem,
            language="zh",
            channel_split=True,
        )
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def _extract_mic_text(response: dict) -> str:
    """Voicemails are single-speaker. Pick the mic-side text only; never
    invoke merge_segments (which would prefix `[00:00 我]`)."""
    if "channels" in response:
        return (response["channels"].get("mic", {}).get("text") or "").strip()
    # Legacy single-text shape (channel_split=False or MONO/LEGACY input)
    return (response.get("text") or "").strip()


def _enqueue_voicemail_prompts(audio_path: Path, transcript_path: Path,
                                title: str, prompts_db: Path,
                                queue_path: Path) -> int:
    """Iterate voicemail-category auto-run prompts and enqueue one
    summary_request per. Returns the count enqueued."""
    from prompts.cache import PromptsCache
    from transcribe import _enqueue_summary_request   # Phase 2/3 helper

    cache = PromptsCache(prompts_db)
    cache.load()
    queued = 0
    for prompt in cache.auto_run("voicemail"):
        # Default slug ('voicemail-todos') drops to <wav>.summary.md per the
        # Phase 2 convention (the slug whose category is the de-facto default
        # for this audio kind writes to the no-infix path so send_summary +
        # Obsidian + html artifacts work unchanged).
        if prompt.slug == "voicemail-todos":
            output_path = audio_path.with_suffix(".summary.md")
        else:
            output_path = audio_path.with_suffix(f".{prompt.slug}.summary.md")
        _enqueue_summary_request(
            prompt=prompt,
            audio_path=audio_path,
            transcript_path=transcript_path,
            meeting_title=title,
            output_path=output_path,
            queue_path=queue_path,
        )
        queued += 1
    return queued


def _persist_title_sidecar(wav_path: Path, title: Optional[str]) -> None:
    if not title:
        return
    wav_path.with_suffix(".title").write_text(title + "\n", encoding="utf-8")


def _transcribe_and_enqueue(wav_path: Path, *, title: Optional[str]) -> int:
    """Post-stop pipeline. Returns 0 on success, non-zero on failure."""
    response = _request_transcribe(wav_path)
    if response.get("status") != "ok":
        print(
            f"⚠️ stt_daemon transcribe failed: {response.get('error')}",
            file=sys.stderr,
        )
        return 2

    text = _extract_mic_text(response)

    raw_path = wav_path.with_suffix(".raw.transcript.txt")
    transcript_path = wav_path.with_suffix(".transcript.txt")
    raw_path.write_text(text, encoding="utf-8")
    transcript_path.write_text(text, encoding="utf-8")
    _persist_title_sidecar(wav_path, title)

    meeting_title = title or wav_path.stem
    queued = _enqueue_voicemail_prompts(
        audio_path=wav_path,
        transcript_path=transcript_path,
        title=meeting_title,
        prompts_db=PROMPTS_DB,
        queue_path=AGENT_QUEUE_PATH,
    )
    print(f"📤 enqueued {queued} voicemail prompt(s)", file=sys.stderr)
    return 0
```

- [ ] **Step 4: Run tests to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_voicemail_recorder.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/voicemail/recorder.py tests/test_voicemail_recorder.py
git commit -m "feat(voicemail): add post-stop _transcribe_and_enqueue pipeline"
```

---

### Task D.2: `cmd_new` (blocking) + `cmd_stop`

**Files:**
- Modify: `yulu/scripts/voicemail/recorder.py` (add cmd_new, cmd_stop, helper)
- Modify: `tests/test_voicemail_recorder.py` (append tests)

- [ ] **Step 1: Append failing tests**

Append to `tests/test_voicemail_recorder.py`:

```python
def test_cmd_new_sends_start_with_sys_disabled_and_silence_seconds(
    isolated_paths, tmp_path, monkeypatch,
):
    """cmd_new must invoke the daemon with sys_disabled=True and a
    3-second silence_seconds; must acquire the recording lock; must
    block until the recording state flips to not-recording."""
    queue, _ = isolated_paths
    # Redirect VOICEMAIL_DIR to tmp_path so the wav lands somewhere we control
    monkeypatch.setattr(recorder, "VOICEMAIL_DIR", tmp_path)

    sent: list[dict] = []
    status_responses = iter([
        {"recording": True, "file": str(tmp_path / "voicemail_20260523_201500.wav")},
        {"recording": True, "file": str(tmp_path / "voicemail_20260523_201500.wav")},
        {"recording": False, "file": str(tmp_path / "voicemail_20260523_201500.wav")},
    ])

    def fake_socket_send(cmd):
        sent.append(cmd)
        if cmd.get("action") == "status":
            return next(status_responses)
        if cmd.get("action") == "start":
            return {"status": "recording",
                    "file": str(tmp_path / "voicemail_20260523_201500.wav")}
        if cmd.get("action") == "stop":
            return {"status": "stopped",
                    "file": str(tmp_path / "voicemail_20260523_201500.wav")}
        return None

    fake_response = {
        "status": "ok",
        "channels": {
            "mic": {"text": "test memo", "segments": [{"start": 0.0, "end": 1.0, "text": "test memo"}]},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }

    monkeypatch.setattr(recorder, "_socket_send", fake_socket_send)
    monkeypatch.setattr(recorder, "_poll_interval", 0.01)   # speed up the test loop
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        rc = recorder.cmd_new(title="MyMemo")

    assert rc == 0
    # First non-status RPC is the start
    starts = [c for c in sent if c.get("action") == "start"]
    assert len(starts) == 1
    assert starts[0]["sys_disabled"] is True
    assert starts[0]["silence_seconds"] == 3
    assert starts[0]["title"].startswith("voicemail_")

    # Transcript landed
    assert (tmp_path / "voicemail_20260523_201500.transcript.txt").exists()
    assert (tmp_path / "voicemail_20260523_201500.title").read_text(encoding="utf-8") == "MyMemo\n"


def test_cmd_new_returns_2_on_busy(tmp_path, monkeypatch):
    """If the recording_lock acquire raises RecordingBusy, cmd_new exits 2
    with a friendly Chinese error mentioning the in-flight recording."""
    from recording_lock import RecordingBusy
    monkeypatch.setattr(recorder, "VOICEMAIL_DIR", tmp_path)

    def fake_acquire(*args, **kwargs):
        raise RecordingBusy({
            "title": "ProductWeekly", "path": "/tmp/foo.wav",
            "started_at": "2026-05-23T12:00:00",
        })
    monkeypatch.setattr(recorder, "_acquire_recording_lock", fake_acquire)

    rc = recorder.cmd_new()
    assert rc == 2


def test_cmd_stop_idempotent_when_not_recording(monkeypatch):
    """If status reports not-recording, cmd_stop exits 0 without sending
    a stop RPC."""
    sent: list[dict] = []
    def fake_socket_send(cmd):
        sent.append(cmd)
        if cmd.get("action") == "status":
            return {"recording": False, "file": ""}
        return None
    monkeypatch.setattr(recorder, "_socket_send", fake_socket_send)
    rc = recorder.cmd_stop()
    assert rc == 0
    assert all(c.get("action") != "stop" for c in sent)


def test_cmd_stop_sends_stop_when_recording(monkeypatch):
    sent: list[dict] = []
    def fake_socket_send(cmd):
        sent.append(cmd)
        if cmd.get("action") == "status":
            return {"recording": True, "file": "/tmp/voicemail_20260523_201500.wav"}
        if cmd.get("action") == "stop":
            return {"status": "stopped",
                    "file": "/tmp/voicemail_20260523_201500.wav"}
        return None
    monkeypatch.setattr(recorder, "_socket_send", fake_socket_send)
    rc = recorder.cmd_stop()
    assert rc == 0
    assert any(c.get("action") == "stop" for c in sent)
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_voicemail_recorder.py -v 2>&1 | tail -20`
Expected: AttributeError — `cmd_new` / `cmd_stop` / `_socket_send` / `_acquire_recording_lock` / `_poll_interval` not defined.

- [ ] **Step 3: Add the new symbols to `recorder.py`**

Append to `yulu/scripts/voicemail/recorder.py`:

```python
import signal
import time
from datetime import datetime

# Module-level seams for tests (patchable)
_poll_interval = 1.0


def _socket_send(cmd: dict):
    """Indirection so tests can stub the daemon socket without importing
    record_audio.socket_send everywhere."""
    from record_audio import socket_send
    return socket_send(cmd)


def _acquire_recording_lock(*, timeout: float = 0.5):
    """Re-exposed so tests can stub away the OS-level flock."""
    from recording_lock import acquire as _acquire
    return _acquire(timeout=timeout)


def _record_lock_meta(handle, *, title: str, path: str, started_at: str) -> None:
    from recording_lock import record as _record
    _record(handle, title=title, path=path, started_at=started_at)


def _gen_stem(now: Optional[datetime] = None) -> str:
    now = now or datetime.now()
    return now.strftime("voicemail_%Y%m%d_%H%M%S")


def cmd_new(title: Optional[str] = None, *,
            silence_seconds: int = DEFAULT_SILENCE_SECONDS) -> int:
    """Start a voicemail recording and block until the daemon stops
    recording (Ctrl-C or silence-stop). Then transcribe + enqueue."""
    from recording_lock import RecordingBusy

    VOICEMAIL_DIR.mkdir(parents=True, exist_ok=True)
    stem = _gen_stem()

    try:
        lock_ctx = _acquire_recording_lock(timeout=0.5)
    except RecordingBusy as exc:
        info = exc.info or {}
        print(
            f"⚠️ 录音正在进行中: {info.get('title', '<unknown>')}\n"
            f"   file: {info.get('path', '<unknown>')}\n"
            f"   started: {info.get('started_at', '<unknown>')}",
            file=sys.stderr,
        )
        return 2

    wav_path: Optional[Path] = None
    try:
        with lock_ctx as lock_handle:
            resp = _socket_send({
                "action": "start",
                "title": stem,
                "sys_disabled": True,
                "silence_seconds": silence_seconds,
                "output_dir": str(VOICEMAIL_DIR),
            })
            if not resp or resp.get("status") != "recording":
                print(f"⚠️ daemon failed to start: {resp}", file=sys.stderr)
                return 1
            wav_path = Path(resp.get("file") or (VOICEMAIL_DIR / f"{stem}.wav"))
            _record_lock_meta(
                lock_handle,
                title=stem,
                path=str(wav_path),
                started_at=datetime.now().isoformat(),
            )
            print(f"🎤 录音中 — Ctrl+C 停止 ({silence_seconds}s 静音自动停)",
                  file=sys.stderr)

            stop_requested = {"v": False}

            def _on_sigint(_sig, _frame):
                stop_requested["v"] = True

            prev = signal.signal(signal.SIGINT, _on_sigint)
            try:
                # Poll daemon status until it flips to not-recording.
                while True:
                    if stop_requested["v"]:
                        _socket_send({"action": "stop"})
                        stop_requested["v"] = False  # one-shot
                    status = _socket_send({"action": "status"}) or {}
                    if not status.get("recording"):
                        break
                    time.sleep(_poll_interval)
            finally:
                signal.signal(signal.SIGINT, prev)
            print("⏹ Stopped", file=sys.stderr)
    finally:
        pass

    if wav_path is None or not wav_path.exists():
        print("⚠️ recording stopped but no .wav file present", file=sys.stderr)
        return 1
    return _transcribe_and_enqueue(wav_path, title=title)


def cmd_stop() -> int:
    """Stop any in-flight recording. Idempotent: prints 'no active recording'
    if nothing was recording. Does NOT trigger transcribe — that's the
    owner cmd_new's responsibility."""
    status = _socket_send({"action": "status"}) or {}
    if not status.get("recording"):
        print("no active recording", file=sys.stderr)
        return 0
    resp = _socket_send({"action": "stop"}) or {}
    print(f"⏹ Stopped: {resp.get('file', '<unknown>')}", file=sys.stderr)
    return 0
```

NOTE about the `output_dir` field on the start RPC: this requires the audio_daemon to honor an `output_dir` override per-recording so voicemails land in `voicemails/`. If the existing Swift handler doesn't already accept this, see if it does:

```bash
grep -nE 'output_dir|RECORDING_DIR' yulu/scripts/audio_daemon.swift | head
```

If not, the simplest implementation is to default `output_dir` from `RECORDING_DIR` (existing global) and override it per-request:

```swift
case "start":
    SYS_DISABLED = (json["sys_disabled"] as? Bool) ?? false
    if let s = json["silence_seconds"] as? Int, s > 0 { recorder.silenceSeconds = Double(s) }
    else if let s = json["silence_seconds"] as? Double, s > 0 { recorder.silenceSeconds = s }
    else { recorder.silenceSeconds = DEFAULT_SILENCE_SEC }
    if let dir = json["output_dir"] as? String, !dir.isEmpty {
        recorder.outputDir = URL(fileURLWithPath: dir)
    } else {
        recorder.outputDir = RECORDING_DIR
    }
    // … existing start logic …
```

And `AudioRecorder.start(title:)` uses `outputDir` instead of `RECORDING_DIR`:

```swift
var outputDir: URL = RECORDING_DIR

func start(title: String) -> String? {
    // … existing setup …
    let url = outputDir.appendingPathComponent(fn)
    try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
    // … rest unchanged …
}
```

This is a small Swift change (~5 lines) but it's required for storage isolation (Acceptance #2). Fold it into the same commit as the silence_seconds change from Task C.1 — they're both small additive start-action fields.

- [ ] **Step 4: Run all recorder tests**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_voicemail_recorder.py -v`
Expected: 9 passed (5 + 4).

- [ ] **Step 5: Apply the Swift output_dir change**

Open `yulu/scripts/audio_daemon.swift`. Per the note in Step 3, add:
1. A new `var outputDir: URL = RECORDING_DIR` property on `AudioRecorder` (placed near the other top-level properties around line 213).
2. Update `start(title:)` to use `outputDir` in place of `RECORDING_DIR`.
3. In the `"start"` action handler (around line 640), set `recorder.outputDir = …` from the request JSON, defaulting to `RECORDING_DIR` if the field is omitted (mirrors silence_seconds behavior).

Build:

```bash
bash yulu/scripts/build_audio_daemon.sh
git checkout -- yulu/scripts/Yulu.app/    # source-only commit; binary lands in G.3
```

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/audio_daemon.swift yulu/scripts/voicemail/recorder.py tests/test_voicemail_recorder.py
git commit -m "feat(voicemail): cmd_new (blocking) + cmd_stop + audio_daemon output_dir field"
```

---

## Phase E — CLI + wrapper

### Task E.1: `yulu memo` argparse CLI

**Files:**
- Create: `yulu/scripts/voicemail/cli.py`
- Create: `tests/test_voicemail_cli.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_voicemail_cli.py`:

```python
"""Voicemail CLI dispatch — argparse + subcommand handlers."""

import sys
import wave
from pathlib import Path
from unittest.mock import patch

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from voicemail import cli as memo_cli
from voicemail.repo import VOICEMAIL_DIR_DEFAULT


def _write_wav(path: Path, duration: float = 1.0) -> None:
    n = int(48000 * duration)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(b"\x00" * n * 4)


def test_no_args_dispatches_to_cmd_new(monkeypatch, capsys):
    """`yulu memo` (no subcommand) is an alias for `yulu memo new`."""
    called = {}
    def fake_cmd_new(title=None, **kwargs):
        called["title"] = title
        return 0
    monkeypatch.setattr(memo_cli, "_cmd_new", fake_cmd_new)
    rc = memo_cli.main([])
    assert rc == 0
    assert called == {"title": None}


def test_new_dispatches_to_cmd_new_with_title(monkeypatch):
    called = {}
    def fake_cmd_new(title=None, **kwargs):
        called["title"] = title
        return 0
    monkeypatch.setattr(memo_cli, "_cmd_new", fake_cmd_new)
    rc = memo_cli.main(["new", "--title", "MyMemo"])
    assert rc == 0
    assert called["title"] == "MyMemo"


def test_stop_dispatches_to_cmd_stop(monkeypatch):
    called = {"v": False}
    def fake_stop():
        called["v"] = True
        return 0
    monkeypatch.setattr(memo_cli, "_cmd_stop", fake_stop)
    rc = memo_cli.main(["stop"])
    assert rc == 0
    assert called["v"] is True


def test_list_empty_inbox_prints_message(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    rc = memo_cli.main(["list"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "no voicemails" in out


def test_list_prints_table(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    _write_wav(tmp_path / "voicemail_20260523_201500.wav", duration=12)
    (tmp_path / "voicemail_20260523_201500.title").write_text("Anthropic follow-up\n")
    (tmp_path / "voicemail_20260523_201500.summary.md").write_text("hi")
    rc = memo_cli.main(["list"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "voicemail_20260523_201500" in out
    assert "Anthropic follow-up" in out
    assert "12s" in out or "12 s" in out
    assert "✓" in out   # has_summary indicator


def test_show_prints_transcript_and_summary(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    stem = "voicemail_20260523_201500"
    _write_wav(tmp_path / f"{stem}.wav", duration=1)
    (tmp_path / f"{stem}.transcript.txt").write_text("我说的话\n", encoding="utf-8")
    (tmp_path / f"{stem}.summary.md").write_text("## 待办\n- todo 1\n", encoding="utf-8")
    rc = memo_cli.main(["show", stem])
    assert rc == 0
    out = capsys.readouterr().out
    assert "我说的话" in out
    assert "todo 1" in out


def test_show_ambiguous_prefix_lists_candidates(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    _write_wav(tmp_path / "voicemail_20260523_120000.wav", duration=1)
    _write_wav(tmp_path / "voicemail_20260523_180000.wav", duration=1)
    rc = memo_cli.main(["show", "voicemail_20260523"])
    assert rc == 1
    out = capsys.readouterr().out + capsys.readouterr().err
    assert "voicemail_20260523_120000" in out
    assert "voicemail_20260523_180000" in out


def test_show_missing_id_returns_1(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    rc = memo_cli.main(["show", "nonexistent"])
    assert rc == 1


def test_delete_removes_files(tmp_path, monkeypatch):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    stem = "voicemail_20260523_201500"
    _write_wav(tmp_path / f"{stem}.wav", duration=1)
    (tmp_path / f"{stem}.transcript.txt").write_text("hi")
    # --yes to skip the confirm prompt in tests
    rc = memo_cli.main(["delete", stem, "--yes"])
    assert rc == 0
    assert not (tmp_path / f"{stem}.wav").exists()
    assert not (tmp_path / f"{stem}.transcript.txt").exists()


def test_send_invokes_send_summary(tmp_path, monkeypatch):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    stem = "voicemail_20260523_201500"
    _write_wav(tmp_path / f"{stem}.wav", duration=1)
    (tmp_path / f"{stem}.summary.md").write_text("hi")

    captured = {}
    def fake_send_summary(summary_path):
        captured["path"] = summary_path
        return True
    monkeypatch.setattr(memo_cli, "_send_summary", fake_send_summary)
    rc = memo_cli.main(["send", stem])
    assert rc == 0
    assert captured["path"] == str(tmp_path / f"{stem}.summary.md")
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_voicemail_cli.py -v 2>&1 | tail -10`
Expected: ImportError on `voicemail.cli`.

- [ ] **Step 3: Create `voicemail/cli.py`**

Create `yulu/scripts/voicemail/cli.py`:

```python
"""yulu memo — voicemail inbox CLI."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional, Sequence

from voicemail.repo import (
    VOICEMAIL_DIR_DEFAULT,
    AmbiguousVoicemailId,
    VoicemailNotFound,
    delete_voicemail,
    get_voicemail,
    list_voicemails,
)

# Module-level so tests can monkeypatch
VOICEMAIL_DIR = VOICEMAIL_DIR_DEFAULT


def _cmd_new(title: Optional[str] = None) -> int:
    """Real implementation imported lazily so tests can stub the module."""
    from voicemail.recorder import cmd_new as _real
    return _real(title=title)


def _cmd_stop() -> int:
    from voicemail.recorder import cmd_stop as _real
    return _real()


def _send_summary(summary_path: str) -> bool:
    """Indirection around send_summary.send_summary for testability."""
    from send_summary import send_summary
    return send_summary(summary_path)


def _cmd_list(args) -> int:
    records = list_voicemails(directory=VOICEMAIL_DIR, limit=args.limit)
    if not records:
        print("no voicemails")
        return 0
    header = f"{'ID':<32} {'TITLE':<40} {'DURATION':<10} SUMMARIZED"
    print(header)
    print("-" * len(header))
    for r in records:
        summarized = "✓" if r.has_summary else ""
        if len(r.summary_slugs) > 1:
            summarized = f"✓ ({' + '.join(s.replace('voicemail-', '') for s in r.summary_slugs)})"
        title_disp = (r.title[:38] + "..") if len(r.title) > 38 else r.title
        dur = f"{r.duration_sec}s" if r.duration_sec < 60 else f"{r.duration_sec // 60}m{r.duration_sec % 60:02d}s"
        print(f"{r.stem:<32} {title_disp:<40} {dur:<10} {summarized}")
    return 0


def _resolve(id_prefix: str) -> Optional[object]:
    try:
        return get_voicemail(id_prefix, directory=VOICEMAIL_DIR)
    except AmbiguousVoicemailId as exc:
        print(f"ambiguous id '{id_prefix}'; candidates:", file=sys.stderr)
        for s in exc.candidates:
            print(f"  {s}", file=sys.stderr)
        return None
    except VoicemailNotFound:
        print(f"no voicemail matches '{id_prefix}'", file=sys.stderr)
        return None


def _cmd_show(args) -> int:
    rec = _resolve(args.id)
    if rec is None:
        return 1
    transcript_path = rec.wav_path.with_suffix(".transcript.txt")
    summary_path = rec.wav_path.with_suffix(".summary.md")
    print(f"# {rec.stem}  —  {rec.title}")
    print()
    if transcript_path.exists():
        print("## Transcript\n")
        print(transcript_path.read_text(encoding="utf-8"))
    if summary_path.exists():
        print("\n## Summary\n")
        print(summary_path.read_text(encoding="utf-8"))
    return 0


def _cmd_delete(args) -> int:
    rec = _resolve(args.id)
    if rec is None:
        return 1
    if not args.yes:
        ans = input(f"delete {rec.stem}? [y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            print("aborted")
            return 0
    n = delete_voicemail(rec)
    print(f"removed {n} files")
    return 0


def _cmd_send(args) -> int:
    rec = _resolve(args.id)
    if rec is None:
        return 1
    slug = args.prompt or "voicemail-todos"
    if slug == "voicemail-todos":
        summary_path = rec.wav_path.with_suffix(".summary.md")
    else:
        summary_path = rec.wav_path.with_suffix(f".{slug}.summary.md")
    if not summary_path.exists():
        print(f"summary file not found: {summary_path}", file=sys.stderr)
        return 1
    ok = _send_summary(str(summary_path))
    return 0 if ok else 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="yulu memo",
                                     description="Voicemail inbox")
    sub = parser.add_subparsers(dest="cmd")

    new_p = sub.add_parser("new", help="Start a new voicemail recording")
    new_p.add_argument("--title", default=None)

    sub.add_parser("stop", help="Stop the current voicemail recording")

    list_p = sub.add_parser("list", help="List inbox (newest first)")
    list_p.add_argument("--limit", type=int, default=20)

    show_p = sub.add_parser("show", help="Show transcript + summary")
    show_p.add_argument("id")

    del_p = sub.add_parser("delete", help="Delete a voicemail")
    del_p.add_argument("id")
    del_p.add_argument("--yes", action="store_true",
                       help="Skip confirmation prompt")

    send_p = sub.add_parser("send", help="Forward summary via send_summary")
    send_p.add_argument("id")
    send_p.add_argument("--prompt", default=None,
                        help="Which summary slug to send (default: voicemail-todos)")

    args = parser.parse_args(argv)
    if args.cmd in (None, "new"):
        title = getattr(args, "title", None)
        return _cmd_new(title=title)
    if args.cmd == "stop":
        return _cmd_stop()
    if args.cmd == "list":
        return _cmd_list(args)
    if args.cmd == "show":
        return _cmd_show(args)
    if args.cmd == "delete":
        return _cmd_delete(args)
    if args.cmd == "send":
        return _cmd_send(args)
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run tests to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_voicemail_cli.py -v`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/voicemail/cli.py tests/test_voicemail_cli.py
git commit -m "feat(voicemail): add yulu memo CLI (new/stop/list/show/delete/send)"
```

---

### Task E.2: Shell wrapper dispatch

**Files:**
- Modify: `yulu/scripts/yulu` (existing dispatcher; add `memo` case)

- [ ] **Step 1: Inspect existing wrapper**

Run: `cat yulu/scripts/yulu`

Note the existing case statement that dispatches `vocab`, `stt`, `prompts`, `summaries`. Pattern is `exec python3 -m <module>.cli "$@"`.

- [ ] **Step 2: Add `memo` case**

Insert into the existing case statement (alongside `vocab`, `stt`, `prompts`, `summaries`):

```bash
    memo)
        shift
        cd "$SCRIPT_DIR" && exec python3 -m voicemail.cli "$@"
        ;;
```

Place it in alphabetical-ish position with the other subcommand cases. Preserve the existing fallback / usage block.

- [ ] **Step 3: Smoke-verify dispatch**

```bash
PYTHONPATH=yulu/scripts yulu/scripts/yulu memo list 2>&1 | head -3
```

Expected: either `no voicemails` (if dir empty) or a table header. NOT `command not found` / `no such subcommand`.

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/yulu
git commit -m "feat(yulu): dispatch 'memo' subcommand to voicemail.cli"
```

---

## Phase F — Completion notification

### Task F.1: `_maybe_voicemail_notify` in agent_queue_worker

**Files:**
- Modify: `yulu/scripts/agent_queue_worker.py` (`_handle_summary_request` post-dispatch hook)
- Create: `tests/test_voicemail_notify.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_voicemail_notify.py`:

```python
"""_maybe_voicemail_notify: fires terminal-notifier only for voicemail
audio paths AND only for the voicemail-todos slug."""

import sys
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from agent_queue_worker import _maybe_voicemail_notify


def test_notify_fires_for_voicemail_todos(tmp_path):
    # Simulate a real voicemails-dir audio path
    vm_dir = tmp_path / "voicemails"
    vm_dir.mkdir()
    audio = vm_dir / "voicemail_20260523_201500.wav"
    audio.touch()
    summary = audio.with_suffix(".summary.md")
    summary.write_text("# Voicemail summary\n\n- 嗯 记得明天找 Anthropic 团队\n",
                       encoding="utf-8")

    with patch("subprocess.Popen") as popen_mock:
        _maybe_voicemail_notify(audio_path=audio, summary_path=summary,
                                prompt_slug="voicemail-todos")
        assert popen_mock.called
        args = popen_mock.call_args[0][0]
        assert args[0] == "terminal-notifier"
        # message contains first non-header line
        assert any("Anthropic" in str(a) for a in args)


def test_notify_skips_non_voicemail_audio(tmp_path):
    audio = tmp_path / "ProductWeekly_20260523.wav"
    audio.touch()
    summary = audio.with_suffix(".summary.md")
    summary.write_text("foo", encoding="utf-8")
    with patch("subprocess.Popen") as popen_mock:
        _maybe_voicemail_notify(audio_path=audio, summary_path=summary,
                                prompt_slug="summary")
        assert not popen_mock.called


def test_notify_skips_non_default_voicemail_slug(tmp_path):
    """Only the auto-run voicemail-todos slug fires a notification;
    voicemail-clean does not (avoids double-notify when both are auto-run)."""
    vm_dir = tmp_path / "voicemails"
    vm_dir.mkdir()
    audio = vm_dir / "voicemail_20260523_201500.wav"
    audio.touch()
    summary = audio.with_suffix(".voicemail-clean.summary.md")
    summary.write_text("cleaned", encoding="utf-8")
    with patch("subprocess.Popen") as popen_mock:
        _maybe_voicemail_notify(audio_path=audio, summary_path=summary,
                                prompt_slug="voicemail-clean")
        assert not popen_mock.called


def test_notify_swallows_missing_terminal_notifier(tmp_path):
    """If terminal-notifier isn't on PATH (FileNotFoundError), the helper
    must not raise — voicemail completion should never fail because of
    a missing notification binary."""
    vm_dir = tmp_path / "voicemails"
    vm_dir.mkdir()
    audio = vm_dir / "voicemail_20260523_201500.wav"
    audio.touch()
    summary = audio.with_suffix(".summary.md")
    summary.write_text("hi", encoding="utf-8")
    with patch("subprocess.Popen", side_effect=FileNotFoundError):
        # Must not raise
        _maybe_voicemail_notify(audio_path=audio, summary_path=summary,
                                prompt_slug="voicemail-todos")
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_voicemail_notify.py -v 2>&1 | tail -10`
Expected: AttributeError — `_maybe_voicemail_notify` not defined.

- [ ] **Step 3: Add the helper + wire it into `_handle_summary_request`**

Open `yulu/scripts/agent_queue_worker.py`. Add this function (place near the other module-level helpers — search for `_handle_summary_request` to find a good spot):

```python
def _maybe_voicemail_notify(*, audio_path: Path, summary_path: Path,
                             prompt_slug: str) -> None:
    """Voicemail-only completion notification. Quiet for meetings.

    Fires only when:
      - audio_path is under a 'voicemails' directory
      - prompt_slug == 'voicemail-todos' (the default auto-run voicemail prompt)
    """
    import subprocess as _sp
    if "voicemails" not in audio_path.parts:
        return
    if prompt_slug != "voicemail-todos":
        return
    first_line = ""
    try:
        for line in summary_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                first_line = line[:80]
                break
    except OSError:
        return
    if not first_line:
        first_line = "summary ready"
    try:
        _sp.Popen([
            "terminal-notifier",
            "-title", "Yulu Voicemail",
            "-message", first_line,
            "-open", f"file://{summary_path}",
            "-sender", "com.yulu.audiodaemon",
        ])
    except (FileNotFoundError, OSError):
        pass
```

Then at the end of `_handle_summary_request`'s success branch (after the row inserts and html dispatch), call:

```python
_maybe_voicemail_notify(
    audio_path=Path(entry["audio_path"]),
    summary_path=Path(entry["summary_path"]),
    prompt_slug=entry.get("prompt_slug", ""),
)
```

(Look at the existing `_handle_summary_request` to find the exact place. The call should be the LAST thing before returning — after all persistence is done, so a notification failure can't roll back any actual work.)

- [ ] **Step 4: Run tests to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_voicemail_notify.py -v`
Expected: 4 passed.

- [ ] **Step 5: Sanity check Phase 2/3 worker tests still green**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_agent_queue_worker_prompts.py tests/test_transcribe_enqueue.py tests/test_transcribe_dual_track.py -v`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/agent_queue_worker.py tests/test_voicemail_notify.py
git commit -m "feat(agent_queue_worker): fire voicemail completion notification (voicemail-todos only)"
```

---

## Phase G — Acceptance + smoke

### Task G.1: Phase 4 acceptance tests in `test_spec_acceptance.py`

**Files:**
- Modify: `tests/test_spec_acceptance.py`

- [ ] **Step 1: Append the Phase 4 block**

Append at the end of `tests/test_spec_acceptance.py`:

```python
# ── Voicemail Inbox acceptance (spec 2026-05-23-voicemail-inbox-design.md) ──

def test_voicemail_package_exists():
    pkg = SCRIPTS / "voicemail"
    assert (pkg / "__init__.py").exists()
    assert (pkg / "repo.py").exists()
    assert (pkg / "recorder.py").exists()
    assert (pkg / "cli.py").exists()


def test_category_voicemail_seeds():
    sys.path.insert(0, str(SCRIPTS))
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    import tempfile, pathlib
    with tempfile.TemporaryDirectory() as td:
        repo = PromptsRepo(open_db(pathlib.Path(td) / "p.sqlite"))
        seed_from_current(repo)
        slugs = {p.slug for p in repo.list_prompts()}
    assert "voicemail-todos" in slugs
    assert "voicemail-clean" in slugs


def test_prompts_db_check_constraint_includes_voicemail():
    text = (SCRIPTS / "prompts" / "db.py").read_text(encoding="utf-8")
    assert "CHECK(category IN ('summary', 'cleanup', 'voicemail'))" in text
    assert "_migrate_category_check_constraint" in text


def test_audio_daemon_accepts_silence_seconds_and_output_dir():
    text = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    assert "silence_seconds" in text
    assert "output_dir" in text


def test_agent_queue_worker_has_voicemail_notify():
    text = (SCRIPTS / "agent_queue_worker.py").read_text(encoding="utf-8")
    assert "_maybe_voicemail_notify" in text
    assert "voicemails" in text


def test_yulu_wrapper_dispatches_memo():
    text = (SCRIPTS / "yulu").read_text(encoding="utf-8")
    assert "memo)" in text
    assert "voicemail.cli" in text


def test_voicemail_recorder_does_not_call_merge_segments():
    """Acceptance #4: voicemail transcripts have NO speaker tags, so
    voicemail.recorder MUST NOT invoke merge_segments."""
    text = (SCRIPTS / "voicemail" / "recorder.py").read_text(encoding="utf-8")
    assert "merge_segments" not in text


def test_voicemail_recorder_sends_sys_disabled():
    text = (SCRIPTS / "voicemail" / "recorder.py").read_text(encoding="utf-8")
    assert "sys_disabled" in text
    assert "silence_seconds" in text


def test_voicemail_cli_default_dir_is_voicemails_subdir():
    sys.path.insert(0, str(SCRIPTS))
    from voicemail.repo import VOICEMAIL_DIR_DEFAULT
    assert VOICEMAIL_DIR_DEFAULT.name == "voicemails"
```

- [ ] **Step 2: Run all acceptance tests**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_spec_acceptance.py -v`
Expected: all green (Phase 1+2+3+4).

- [ ] **Step 3: Commit**

```bash
git add tests/test_spec_acceptance.py
git commit -m "test(acceptance): extend with voicemail-inbox criteria"
```

---

### Task G.2: Full regression sanity

- [ ] **Step 1: Run the entire test suite**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/ -q --tb=short 2>&1 | tail -10`
Expected: every test passes. Count should be 200 (Phase 3 baseline) + Phase-4 new tests (~40) = ~240 passed, 1 skipped.

- [ ] **Step 2: Fix any regression**

If anything fails, root-cause and fix. Don't mutate the test to make it pass unless the test itself was buggy.

- [ ] **Step 3: Commit any fix-ups**

```bash
git add -A
git commit -m "fix(phase4): address regression surfaced by full suite"
```

(Skip if nothing failed.)

---

### Task G.3: Real-machine smoke (deferred; manual)

After G.2 is green and the user installs the Phase 4 build:

- [ ] **Step 1: Rebuild Yulu.app with the new audio_daemon and install**

```bash
bash yulu/scripts/build_audio_daemon.sh
launchctl unload ~/Library/LaunchAgents/com.yulu.audiodaemon.plist
cp -R yulu/scripts/Yulu.app /Users/liaoyuxing/.yulu/yulu/scripts/Yulu.app
launchctl load ~/Library/LaunchAgents/com.yulu.audiodaemon.plist
```

- [ ] **Step 2: Reseed prompts to pick up voicemail-todos + voicemail-clean**

```bash
PYTHONPATH=yulu/scripts python3 -m prompts.cli seed --from-current --db ~/.config/yulu/prompts.sqlite
```

Expected: `{"inserted": 2, "updated": 0}`.

- [ ] **Step 3: Record a test voicemail**

```bash
PYTHONPATH=yulu/scripts yulu/scripts/yulu memo new --title "Phase 4 smoke test"
# Speak something into the mic for ~10s, then Ctrl+C (or wait 3s for silence-stop)
```

- [ ] **Step 4: Verify WAV layout + storage location**

```bash
ls -la ~/Movies/Yulu/voicemails/
PYTHONPATH=yulu/scripts python3 -c "
from pathlib import Path
from stt_daemon.wav_inspect import classify
wav = sorted(Path.home().joinpath('Movies/Yulu/voicemails').glob('*.wav'))[-1]
print(wav.name, '→', classify(wav))
"
```

Expected: WAV in `voicemails/` subdir (NOT `~/Movies/Yulu/`); classifier returns `DUAL_TRACK`; R channel near-silent.

- [ ] **Step 5: Verify transcript + inbox**

```bash
PYTHONPATH=yulu/scripts yulu/scripts/yulu memo list
PYTHONPATH=yulu/scripts yulu/scripts/yulu memo show voicemail_<latest-ts>
```

Expected: list shows the new entry with title "Phase 4 smoke test", duration ~10s, summary status (✓ if worker ran, blank if not yet). `show` prints transcript and (if summarized) summary content.

- [ ] **Step 6: Verify notification (manual)**

When the agent_queue_worker dispatches `voicemail-todos`, a desktop notification should appear with the first non-header line of the summary. Click it → opens the `.summary.md`.

- [ ] **Step 7: Test concurrent voicemail vs meeting (recording_lock interop)**

```bash
PYTHONPATH=yulu/scripts yulu/scripts/yulu memo new &
sleep 1
PYTHONPATH=yulu/scripts yulu/scripts/yulu memo new
echo "exit code = $?"   # expect 2 with "录音正在进行中"
PYTHONPATH=yulu/scripts yulu/scripts/yulu memo stop
```

- [ ] **Step 8: Cleanup**

```bash
PYTHONPATH=yulu/scripts yulu/scripts/yulu memo delete voicemail_<smoke-ts> --yes
```

---

## Plan Self-Review

Cross-checked the plan against the spec section-by-section:

| Spec § | Covered by |
|---|---|
| §2.1 Quick ad-hoc capture | Tasks D.1 + D.2 |
| §2.2 Storage separation | Task D.2 Step 5 (Swift `output_dir`) + Task B.1 (`VOICEMAIL_DIR_DEFAULT`) |
| §2.3 Reuse full pipeline | Tasks D.1/D.2 (use socket_send + recording_lock + transcribe_client) |
| §2.4 First-class prompt category | Tasks A.1 + A.2 |
| §2.5 Inbox management | Tasks B.1/B.2/E.1 |
| §2.6 Completion notification | Task F.1 |
| §4 Topology | Implemented by D.1 (post-stop pipeline) + D.2 (start/stop) + F.1 (notify hook) |
| §5 Storage Layout | Tasks B.1 (record helpers parse this) + D.1 (writes per this convention) + D.2 Step 5 (Swift writes to voicemails/) |
| §6 Recording Flow | Task D.2 (cmd_new blocking, cmd_stop, plus SIGINT handler + polling loop); §6.3 detach is deferred to a follow-up (not in scope) — NOTE this departure from spec |
| §7 Prompt category extension | Task A.1 (enum + migration) + A.2 (seeds) |
| §8 Inbox CLI | Task E.1 (all 6 subcommands) |
| §9 Module structure | Tasks B.1/B.2/D.1/D.2/E.1 |
| §10 Wrapper integration | Task E.2 |
| §11 Completion notification | Task F.1 |
| §12 Recording-lock interaction | Task D.2 (cmd_new acquires + RecordingBusy handler) |
| §13 Backward compatibility | Inherent to the design — no breaking changes; verified by G.2 regression |
| §14 Failure modes | Covered case-by-case in the relevant task tests (D.1 daemon error, D.2 RecordingBusy, B.2 delete idempotency, F.1 missing terminal-notifier) |
| §15 Acceptance criteria 1-12 | Task G.1 (acceptance tests) cross-references each |

**Departures from spec:**
- `--detach` (spec §6.3): deferred. The blocking `cmd_new` covers the common case; users who need detached capture can run `nohup yulu memo new &` until a future spec adds first-class detach.
- Notification spec §11 mentions `-open file://...` click handler; my implementation includes it.

**Placeholder scan:**

Searched plan for "TBD"/"TODO"/"fill in" patterns — clean. The word "TODO" appears in test text fixtures and prompt content where it's the literal value being tested (a user's spoken "todo: file a bug").

**Type / signature consistency:**

- `VoicemailRecord` definition (Task B.1) reused verbatim in B.2 + E.1 — no drift
- `cmd_new(title=None)` signature consistent between recorder.py and cli.py
- `_socket_send` / `_acquire_recording_lock` are module-level seams in recorder.py used by both D.2 and tests
- Prompt slugs `voicemail-todos` / `voicemail-clean` consistent across A.2 / D.1 / E.1 / F.1 / G.1
- `VOICEMAIL_DIR_DEFAULT` (repo.py) / `VOICEMAIL_DIR` (recorder.py + cli.py module-level for monkeypatching) — same value, both intentional

Plan ready for execution.
