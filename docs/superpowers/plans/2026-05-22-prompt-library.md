# Prompt Library + Multi-Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded `SUMMARY_PROMPT` strings + dual LLM dispatch paths with a SQLite-backed Prompt Library; one meeting can produce multiple `<slug>.summary.md` files; `agent_queue_worker` becomes the single LLM dispatcher. Follows [spec/2026-05-22-prompt-library-design.md](../specs/2026-05-22-prompt-library-design.md).

**Architecture:** Mirror Phase-1 vocab architecture (SQLite + WAL + SIGHUP cache + frozen seed + `yulu prompts` CLI). `transcribe.py` becomes a pure enqueuer; `agent_queue_worker.py` becomes the single LLM dispatcher with snapshot resolution + provenance tracking via `summaries` table.

**Tech Stack:** Python 3.12+, sqlite3 (WAL mode), pytest, existing `queue_store.py` JSON file queue. No new third-party deps.

---

## Scope check

Spec is one coherent subsystem (prompts catalog + dispatch flow). One plan, 6 phases. Each phase ends with passing tests and atomic commits.

## Style note for the implementer

Plan code blocks show **tests verbatim** (they are the contract) and **function signatures + docstrings + key invariants** for implementation; **method bodies are sketches, not verbatim**. The implementer is expected to fill in bodies guided by:
1. The test cases (they pin down behavior).
2. The Phase-1 sibling modules in `yulu/scripts/vocab/` and `yulu/scripts/stt_daemon/vocab_cache.py` — same architecture, lift the patterns.
3. The spec for higher-level questions.

If a plan code sketch looks wrong or ambiguous, **stop and report `DONE_WITH_CONCERNS`** rather than guess.

## File structure

**New files**

```
yulu/scripts/prompts/
  __init__.py                       # package marker, re-exports
  db.py                             # PromptsRepo + SummariesRepo + open_db + Prompt/Summary dataclasses
  seed.py                           # SEED_PROMPTS frozen + seed_from_current + restore_defaults
  cli.py                            # `yulu prompts` argparse subcommand
  cache.py                          # PromptsCache + resolve_meeting_date helper

yulu/scripts/summaries_cli.py       # `yulu summaries` reader CLI (separate file; less intertwined with prompts)

yulu/spec/adr/004-prompt-library.md

tests/test_prompts_db.py
tests/test_prompts_seed.py
tests/test_prompts_cache.py
tests/test_prompts_cli.py
tests/test_transcribe_enqueue.py
tests/test_agent_queue_worker_prompts.py
tests/test_summaries_cli.py
```

**Modified files**

```
yulu/scripts/transcribe.py                # delete summarize/fallback_summary/refine_transcript; pure enqueuer
yulu/scripts/agent_queue_worker.py         # single LLM dispatcher; SummariesRepo + html + send + pid file
yulu/scripts/queue_store.py                # additive: helper for new summary_request fields (back-compat)
yulu/scripts/send_summary.py               # add --prompt <slug> flag (else default = legacy <meeting>.summary.md)
yulu/scripts/html_artifact.py              # accept arbitrary output path (already does); no protocol change
yulu/scripts/yulu                          # dispatch `prompts` + `summaries` subcommands
yulu/scripts/setup.sh                      # add `yulu prompts seed --from-current` step
tests/test_spec_acceptance.py              # extend with prompt-library acceptance checks
```

---

# Phase 1 — Prompts SQLite Foundation

**Outcome:** `yulu prompts add/list/edit/remove/seed/show/export/import` works against `~/.config/yulu/prompts.sqlite`. `yulu summaries list/show` reads the provenance table. No consumers yet.

## Task 1.1: `PromptsRepo` + `SummariesRepo` + schema

**Files:**
- Create: `yulu/scripts/prompts/__init__.py`
- Create: `yulu/scripts/prompts/db.py`
- Create: `tests/test_prompts_db.py`

**Reference:** `yulu/scripts/vocab/db.py` is the architectural sibling. Lift the WAL-mode `open_db` pattern, the dataclass-row mapping, and the `_now_iso()` helper.

- [ ] **Step 1: Package marker**

Write `yulu/scripts/prompts/__init__.py`:

```python
"""Prompts package — prompts SQLite repository + cache + CLI."""

from .db import (
    PromptsRepo, SummariesRepo, Prompt, Summary,
    Category, Source, SummaryStatus, open_db,
)

__all__ = [
    "PromptsRepo", "SummariesRepo", "Prompt", "Summary",
    "Category", "Source", "SummaryStatus", "open_db",
]
```

- [ ] **Step 2: Write tests**

Write `tests/test_prompts_db.py` — full test suite, drives the API:

```python
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import pytest
from prompts import (
    PromptsRepo, SummariesRepo, Prompt, Summary,
    Category, Source, SummaryStatus, open_db,
)


def test_open_db_creates_schema(tmp_path):
    conn = open_db(tmp_path / "prompts.sqlite")
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    assert {"prompts", "summaries", "meta"} <= tables
    version = conn.execute(
        "SELECT value FROM meta WHERE key='schema_version'"
    ).fetchone()
    assert version[0] == "1"


# ── PromptsRepo ────────────────────────────────────────────────────

def test_prompts_add_and_fetch(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    pid = repo.add(
        slug="summary",
        name="Standard Summary",
        category=Category.SUMMARY,
        content="请总结 {{transcript}}",
        is_auto_run=True,
    )
    p = repo.get(pid)
    assert p.slug == "summary"
    assert p.name == "Standard Summary"
    assert p.category == Category.SUMMARY
    assert p.is_auto_run is True
    assert p.source == Source.MANUAL


def test_prompts_slug_unique(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    repo.add(slug="summary", name="A", category=Category.SUMMARY, content="x")
    with pytest.raises(ValueError):
        repo.add(slug="summary", name="B", category=Category.SUMMARY, content="y")


def test_prompts_by_slug(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    pid = repo.add(slug="action-items", name="A", category=Category.SUMMARY, content="x")
    p = repo.by_slug("action-items")
    assert p.id == pid
    assert repo.by_slug("missing") is None


def test_prompts_list_filters(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    repo.add(slug="summary", name="S", category=Category.SUMMARY, content="x", is_auto_run=True)
    repo.add(slug="action-items", name="AI", category=Category.SUMMARY, content="x", is_auto_run=False)
    repo.add(slug="cleanup", name="C", category=Category.CLEANUP, content="x", is_auto_run=True)
    assert len(repo.list_prompts()) == 3
    assert len(repo.list_prompts(category=Category.SUMMARY)) == 2
    assert len(repo.list_prompts(category=Category.CLEANUP)) == 1
    assert len(repo.list_prompts(auto_run_only=True)) == 2
    assert len(repo.list_prompts(category=Category.SUMMARY, auto_run_only=True)) == 1


def test_prompts_edit_by_slug(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    repo.add(slug="summary", name="Old", category=Category.SUMMARY, content="x")
    assert repo.edit("summary", name="New", content="y", is_auto_run=True) is True
    p = repo.by_slug("summary")
    assert p.name == "New"
    assert p.content == "y"
    assert p.is_auto_run is True
    assert repo.edit("missing", name="z") is False


def test_prompts_remove(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    pid = repo.add(slug="x", name="X", category=Category.SUMMARY, content="x")
    assert repo.remove("x") is True
    assert repo.get(pid) is None
    assert repo.remove("x") is False


def test_prompts_slug_validation(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    # slug must be lowercase alphanumeric + hyphens
    for bad in ["Summary", "with space", "with_underscore", "ünicode", ""]:
        with pytest.raises(ValueError):
            repo.add(slug=bad, name="X", category=Category.SUMMARY, content="x")


# ── SummariesRepo ──────────────────────────────────────────────────

def test_summaries_start_and_done(tmp_path):
    repo = SummariesRepo(open_db(tmp_path / "p.sqlite"))
    sid = repo.start(
        audio_path="/abs/meeting.wav",
        prompt_id="pid-1",
        prompt_slug="summary",
        prompt_name="Standard Summary",
        prompt_content="please summarize {{transcript}}",
        output_path="/abs/meeting.summary.md",
        model="claude",
    )
    s = repo.get(sid)
    assert s.status == SummaryStatus.QUEUED
    assert s.audio_path == "/abs/meeting.wav"
    assert s.prompt_slug == "summary"
    assert s.model == "claude"

    repo.mark_running(sid)
    assert repo.get(sid).status == SummaryStatus.RUNNING

    repo.mark_done(sid, duration_ms=1234, word_count=42, html_path="/abs/meeting.summary.html")
    s = repo.get(sid)
    assert s.status == SummaryStatus.DONE
    assert s.duration_ms == 1234
    assert s.word_count == 42
    assert s.html_path == "/abs/meeting.summary.html"
    assert s.completed_at is not None


def test_summaries_mark_error(tmp_path):
    repo = SummariesRepo(open_db(tmp_path / "p.sqlite"))
    sid = repo.start(
        audio_path="/x", prompt_id="p", prompt_slug="summary",
        prompt_name="N", prompt_content="c", output_path="/y",
    )
    repo.mark_error(sid, error="llm timed out")
    s = repo.get(sid)
    assert s.status == SummaryStatus.ERROR
    assert s.error == "llm timed out"
    assert s.completed_at is not None


def test_summaries_list_by_audio_and_status(tmp_path):
    repo = SummariesRepo(open_db(tmp_path / "p.sqlite"))
    repo.start(audio_path="/a.wav", prompt_id="p1", prompt_slug="summary",
               prompt_name="N", prompt_content="c", output_path="/a.summary.md")
    s2 = repo.start(audio_path="/a.wav", prompt_id="p2", prompt_slug="action-items",
                    prompt_name="N", prompt_content="c", output_path="/a.ai.md")
    repo.mark_done(s2, duration_ms=0, word_count=0)
    repo.start(audio_path="/b.wav", prompt_id="p1", prompt_slug="summary",
               prompt_name="N", prompt_content="c", output_path="/b.summary.md")
    assert len(repo.list_summaries(audio_path="/a.wav")) == 2
    assert len(repo.list_summaries(status=SummaryStatus.DONE)) == 1
    assert len(repo.list_summaries(status=SummaryStatus.QUEUED)) == 2


def test_meta_roundtrip(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    assert repo.get_meta("seeded_at") is None
    repo.set_meta("seeded_at", "2026-05-22T10:00:00Z")
    assert repo.get_meta("seeded_at") == "2026-05-22T10:00:00Z"
```

- [ ] **Step 3: Run tests — verify FAIL with ImportError**

Run: `pytest tests/test_prompts_db.py -v`
Expected: ImportError.

- [ ] **Step 4: Implement `yulu/scripts/prompts/db.py`**

Skeleton (fill in bodies guided by tests + vocab/db.py pattern):

```python
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


# Schema SQL — keep the CHECK constraints; they enforce the enum value sets at
# the DB level so a future caller bypassing the repo still can't insert junk.
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


def open_db(path: Path) -> sqlite3.Connection:
    """Open WAL-mode sqlite, ensure schema; mirrors vocab.db.open_db."""
    # IMPLEMENTER: follow yulu/scripts/vocab/db.py::open_db — WAL,
    # busy_timeout=2000, sqlite3.Row factory, executescript(_SCHEMA_SQL),
    # INSERT OR IGNORE meta(schema_version).
    ...


class PromptsRepo:
    """CRUD over the `prompts` table.

    Public methods (tests pin down behavior):
      add(slug, name, category, content, *, is_auto_run=False,
          source=Source.MANUAL, sort_order=0, note=None) -> id
        - raises ValueError if slug fails _SLUG_RE or already exists
      get(id) -> Optional[Prompt]
      by_slug(slug) -> Optional[Prompt]
      list_prompts(*, category=None, auto_run_only=False) -> list[Prompt]
        - sorted by sort_order asc, then slug asc
      edit(slug, *, name=None, content=None, category=None,
           is_auto_run=None, sort_order=None, note=None) -> bool
        - touch updated_at iff any field actually changes; return False if
          slug not found
      remove(slug) -> bool
      get_meta(key) / set_meta(key, value)
    """
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    # IMPLEMENTER: methods below — follow vocab/db.py::VocabRepo shape


class SummariesRepo:
    """CRUD over the `summaries` table.

    Public methods:
      start(audio_path, prompt_id, prompt_slug, prompt_name,
            prompt_content, output_path, *, model=None) -> id
        - inserts row with status=QUEUED, created_at=now, completed_at=None
      mark_running(id) -> None
      mark_done(id, *, duration_ms, word_count, html_path=None) -> None
        - sets status=DONE, completed_at=now
      mark_error(id, *, error: str) -> None
        - sets status=ERROR, completed_at=now
      get(id) -> Optional[Summary]
      list_summaries(*, audio_path=None, status=None) -> list[Summary]
        - sorted by created_at desc
    """
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
```

- [ ] **Step 5: Run tests — PASS**

Run: `pytest tests/test_prompts_db.py -v`
Expected: 11 passed.

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/prompts/__init__.py yulu/scripts/prompts/db.py tests/test_prompts_db.py
git commit -m "feat(prompts): add PromptsRepo + SummariesRepo with sqlite schema"
```

## Task 1.2: Frozen seed snapshots

**Files:**
- Create: `yulu/scripts/prompts/seed.py`
- Create: `tests/test_prompts_seed.py`

- [ ] **Step 1: Write tests**

Write `tests/test_prompts_seed.py`:

```python
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from prompts import PromptsRepo, Category, Source, open_db
from prompts.seed import (
    SEED_PROMPTS, seed_from_current, restore_defaults,
)


def test_seed_constants_complete():
    slugs = {p["slug"] for p in SEED_PROMPTS}
    assert {"summary", "transcript-cleanup", "action-items"} <= slugs
    for p in SEED_PROMPTS:
        assert p["category"] in ("summary", "cleanup")
        assert "{{transcript}}" in p["content"]
    # auto-run: summary + transcript-cleanup yes, action-items no
    auto = {p["slug"]: p["is_auto_run"] for p in SEED_PROMPTS}
    assert auto["summary"] is True
    assert auto["transcript-cleanup"] is True
    assert auto["action-items"] is False


def test_seed_from_current_inserts(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    n = seed_from_current(repo)
    assert n["inserted"] == len(SEED_PROMPTS)
    assert n["updated"] == 0
    assert repo.by_slug("summary") is not None
    assert repo.by_slug("transcript-cleanup").category == Category.CLEANUP
    assert all(p.source == Source.SEED for p in repo.list_prompts())
    assert repo.get_meta("seeded_at") is not None


def test_seed_from_current_idempotent(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    seed_from_current(repo)
    second = seed_from_current(repo)
    assert second["inserted"] == 0
    # If the user hasn't touched seed rows, second pass updates nothing.
    assert second["updated"] == 0


def test_restore_defaults_preserves_manual(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    seed_from_current(repo)
    # User edits a seed row
    repo.edit("summary", content="MUTATED")
    # User adds a manual prompt
    repo.add(slug="custom", name="Custom", category=Category.SUMMARY,
             content="custom {{transcript}}")
    # Restore
    restore_defaults(repo)
    # Seed row reverted in place (ID preserved — same restore pattern as vocab)
    assert repo.by_slug("summary").content != "MUTATED"
    # Manual row preserved
    assert repo.by_slug("custom") is not None
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `seed.py`**

Skeleton (the SEED_PROMPTS literal is the canonical migration data):

```python
"""Frozen seed snapshots for the Prompt Library.

These are intentionally frozen copies of the prompts that used to live as
SUMMARY_PROMPT constants in transcribe.py + agent_queue_worker.py and the
inline cleanup prompt in transcribe.py::refine_transcript. The same PR that
adds this module deletes those constants. After that, this file is the
canonical migration history.
"""

from __future__ import annotations

from .db import Category, PromptsRepo, Source, _now_iso

# ───────────────────────────────────────────────────────────────────
# IMPLEMENTER: SEED_PROMPTS is the migration's primary content.
# Each entry must include all fields PromptsRepo.add accepts via kwargs.
# The `content` is the prompt template; supports {{transcript}}, {{meeting_title}}, {{date}}.
#
# For SEED_PROMPTS[0] (slug='summary'): MERGE the two existing SUMMARY_PROMPT
# strings — the one in transcribe.py is fallback-flavor, the one in
# agent_queue_worker.py is "final pass" flavor; the merged version should
# take the directive tone of the worker version and keep the {{transcript}}
# variable. Inline transcribe.py's `summary_template.md` template ref as a
# `{template_section}` static block IF you find it useful, but the spec's
# intent is to STOP relying on that side-file; better to fold any structural
# requirements directly into the content here.
#
# For SEED_PROMPTS[1] (slug='transcript-cleanup'): take refine_transcript's
# inline prompt verbatim, with {{transcript}}/{{meeting_title}} substituted
# for whatever the old code used.
#
# For SEED_PROMPTS[2] (slug='action-items'): a NEW prompt focused only on
# action items + decisions + owners. macparakeet-style. Use Chinese to match
# Yulu's existing summary style.
# ───────────────────────────────────────────────────────────────────

SEED_PROMPTS: list[dict] = [
    {
        "slug": "summary",
        "name": "Standard Summary",
        "category": "summary",
        "is_auto_run": True,
        "sort_order": 10,
        "content": (
            # IMPLEMENTER: paste merged summary prompt here; must include {{transcript}}
            # and {{meeting_title}}; may include {{date}}.
            "<MERGED SUMMARY PROMPT WITH {{transcript}}, {{meeting_title}}, optional {{date}}>"
        ),
    },
    {
        "slug": "transcript-cleanup",
        "name": "Transcript Cleanup",
        "category": "cleanup",
        "is_auto_run": True,
        "sort_order": 0,
        "content": (
            # IMPLEMENTER: paste transcribe.py::refine_transcript's inline prompt,
            # with {{transcript}} placeholder
            "<CLEANUP PROMPT WITH {{transcript}}>"
        ),
    },
    {
        "slug": "action-items",
        "name": "Action Items & Decisions",
        "category": "summary",
        "is_auto_run": False,
        "sort_order": 20,
        "content": (
            # IMPLEMENTER: write a focused action-items prompt in Chinese.
            "<ACTION ITEMS PROMPT WITH {{transcript}}, {{meeting_title}}>"
        ),
    },
]


def seed_from_current(repo: PromptsRepo) -> dict[str, int]:
    """Apply SEED_PROMPTS into the repo.

    Returns {inserted: N, updated: N}. Idempotent — a row with the same slug
    already at source='seed' and identical content is left alone; a slug at
    source='seed' with drifted content is updated in place (preserving id).
    A slug at source='manual' is left alone entirely.

    After insert/update, writes meta.seeded_at.
    """
    # IMPLEMENTER: follow vocab/seed.py::seed_from_current shape.
    ...


def restore_defaults(repo: PromptsRepo) -> dict[str, int]:
    """Force seed rows back to bundled snapshot values.

    Same in-place semantics as vocab/seed.py::restore_defaults: existing
    seed-source rows are reverted (id preserved), missing ones inserted,
    manual rows untouched.
    """
    # IMPLEMENTER: follow vocab/seed.py::restore_defaults.
    ...
```

**IMPORTANT for the implementer when filling in `SEED_PROMPTS[0].content`** (summary):

Look at these two pre-spec strings:

- `yulu/scripts/transcribe.py::SUMMARY_PROMPT` (the version that says "请将以下会议转录整理成结构化会议纪要" + 5 numbered requirements)
- `yulu/scripts/agent_queue_worker.py::SUMMARY_PROMPT` (the version that says "请基于以下会议转录生成最终版结构化会议纪要" + 3 numbered requirements)

Merge them into ONE prompt that:
1. Uses the worker's "请基于...生成最终版" framing (more directive)
2. Keeps the union of structural requirements (TL;DR, Discussion Points, Action Items, Open Questions, Decisions Made)
3. Uses `{{transcript}}`, `{{meeting_title}}`, optionally `{{date}}` instead of Python `{title}`/`{transcript}` placeholders
4. Drops the `{template_section}` indirection (the side-file template.md), folding any structural requirements directly into the content

If you finish step 3 above and the merged prompt is materially different from BOTH originals, that's expected; please stop and report `DONE_WITH_CONCERNS` with a side-by-side diff so the spec author can confirm the merge.

- [ ] **Step 4: Run — PASS**

Run: `pytest tests/test_prompts_seed.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/prompts/seed.py tests/test_prompts_seed.py
git commit -m "feat(prompts): add frozen seed snapshots + idempotent seeder"
```

## Task 1.3: `yulu prompts` CLI

**Files:**
- Create: `yulu/scripts/prompts/cli.py`
- Create: `tests/test_prompts_cli.py`

- [ ] **Step 1: Write tests**

Write `tests/test_prompts_cli.py`:

```python
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from prompts.cli import main as prompts_main


def _run(args, *, db_path, capsys):
    code = prompts_main([*args, "--db", str(db_path)])
    out, err = capsys.readouterr()
    return code, out, err


def test_add_and_list_json(tmp_path, capsys):
    db = tmp_path / "p.sqlite"
    code, _, _ = _run([
        "add", "summary",
        "--name", "Standard Summary",
        "--category", "summary",
        "--content", "请总结 {{transcript}}",
        "--auto-run",
    ], db_path=db, capsys=capsys)
    assert code == 0
    code, out, _ = _run(["list", "--json"], db_path=db, capsys=capsys)
    data = json.loads(out)
    assert len(data) == 1
    assert data[0]["slug"] == "summary"
    assert data[0]["is_auto_run"] is True


def test_seed_from_current(tmp_path, capsys):
    db = tmp_path / "p.sqlite"
    code, out, _ = _run(["seed", "--from-current"], db_path=db, capsys=capsys)
    assert code == 0
    assert "inserted" in out
    code, out, _ = _run(["list", "--json"], db_path=db, capsys=capsys)
    slugs = {p["slug"] for p in json.loads(out)}
    assert {"summary", "transcript-cleanup", "action-items"} <= slugs


def test_show(tmp_path, capsys):
    db = tmp_path / "p.sqlite"
    _run([
        "add", "x", "--name", "X", "--category", "summary",
        "--content", "hello {{transcript}}",
    ], db_path=db, capsys=capsys)
    code, out, _ = _run(["show", "x"], db_path=db, capsys=capsys)
    assert code == 0
    assert "hello {{transcript}}" in out


def test_edit_toggles_auto_run(tmp_path, capsys):
    db = tmp_path / "p.sqlite"
    _run(["add", "x", "--name", "X", "--category", "summary",
          "--content", "y"], db_path=db, capsys=capsys)
    _run(["edit", "x", "--auto-run"], db_path=db, capsys=capsys)
    code, out, _ = _run(["list", "--json"], db_path=db, capsys=capsys)
    assert json.loads(out)[0]["is_auto_run"] is True
    _run(["edit", "x", "--no-auto-run"], db_path=db, capsys=capsys)
    code, out, _ = _run(["list", "--json"], db_path=db, capsys=capsys)
    assert json.loads(out)[0]["is_auto_run"] is False


def test_remove_unknown_returns_error(tmp_path, capsys):
    db = tmp_path / "p.sqlite"
    code, _, err = _run(["remove", "ghost"], db_path=db, capsys=capsys)
    assert code != 0
    assert "not found" in err.lower()


def test_export_import_json_roundtrip(tmp_path, capsys):
    db = tmp_path / "p.sqlite"
    _run(["seed", "--from-current"], db_path=db, capsys=capsys)
    out_file = tmp_path / "p.json"
    _run(["export", "-o", str(out_file)], db_path=db, capsys=capsys)
    assert out_file.exists()
    db2 = tmp_path / "p2.sqlite"
    _run(["import", str(out_file)], db_path=db2, capsys=capsys)
    code, out, _ = _run(["list", "--json"], db_path=db2, capsys=capsys)
    slugs = {p["slug"] for p in json.loads(out)}
    assert {"summary", "transcript-cleanup", "action-items"} <= slugs


def test_content_from_file(tmp_path, capsys):
    db = tmp_path / "p.sqlite"
    content_file = tmp_path / "prompt.txt"
    content_file.write_text("from file {{transcript}}", encoding="utf-8")
    code, _, _ = _run([
        "add", "y", "--name", "Y", "--category", "summary",
        "--from-file", str(content_file),
    ], db_path=db, capsys=capsys)
    assert code == 0
    code, out, _ = _run(["show", "y"], db_path=db, capsys=capsys)
    assert "from file {{transcript}}" in out
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `cli.py`**

Skeleton — full sub-parsers (mirror `yulu/scripts/vocab/cli.py`, including the `_extract_db_from_argv` workaround for argparse-subparser argv positioning):

```python
"""`yulu prompts` CLI subcommand implementation."""

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

from .db import (
    PromptsRepo, Prompt, Category, Source, open_db,
)
from .seed import seed_from_current, restore_defaults


DEFAULT_DB = Path.home() / ".config" / "yulu" / "prompts.sqlite"
WORKER_PID = Path.home() / ".config" / "yulu" / "agent_queue_worker.pid"


def _sighup_worker() -> None:
    """Best-effort SIGHUP to the running agent_queue_worker for cache reload."""
    try:
        if not WORKER_PID.exists():
            return
        pid = int(WORKER_PID.read_text().strip())
        os.kill(pid, signal.SIGHUP)
    except (OSError, ValueError):
        pass


def _prompt_to_dict(p: Prompt) -> dict:
    d = asdict(p)
    d["category"] = p.category.value
    d["source"] = p.source.value
    return d


# ── argparse builders ──────────────────────────────────────────────
def _build_parser() -> argparse.ArgumentParser:
    """Build the argparse tree.

    Subcommands and key flags (test names pin the surface):
      list [--category summary|cleanup] [--auto-run] [--json]
      add <slug> --name <name> --category {summary,cleanup}
            (--content <text> | --from-file <path>)
            [--auto-run] [--sort-order N] [--note <text>]
      edit <slug> [--name ...] [--content ... | --from-file ...]
            [--category ...] [--sort-order N] [--note ...]
            [--auto-run | --no-auto-run]
      remove <slug>
      show <slug>
      seed (--from-current | --restore-defaults)
      export [--format json|csv] [-o path]
      import <file>
      reload
    """
    # IMPLEMENTER: mirror vocab/cli.py shape EXACTLY for consistency,
    # except positional `slug` instead of UUID `id` for prompts subcommands.
    ...


def _extract_db_from_argv(argv: list[str]) -> tuple[str, list[str]]:
    """Same workaround as vocab/cli.py: pull --db out before argparse so it
    can appear anywhere (the test passes it AFTER the subcommand)."""
    # IMPLEMENTER: copy vocab/cli.py::_extract_db_from_argv verbatim,
    # changing only the DEFAULT.
    ...


def main(argv: Optional[list[str]] = None) -> int:
    """Entry point. Returns process exit code."""
    if argv is None:
        argv = sys.argv[1:]
    db_path, remaining = _extract_db_from_argv(list(argv))
    parser = _build_parser()
    args = parser.parse_args(remaining)
    args.db = db_path

    repo = PromptsRepo(open_db(Path(args.db)))
    try:
        handlers = {
            "list":   _cmd_list,
            "add":    _cmd_add,
            "edit":   _cmd_edit,
            "remove": _cmd_remove,
            "show":   _cmd_show,
            "seed":   _cmd_seed,
            "export": _cmd_export,
            "import": _cmd_import,
            "reload": _cmd_reload,
        }
        code = handlers[args.cmd](args, repo)
    finally:
        repo.conn.close()

    # mutations SIGHUP the worker so its PromptsCache reloads
    if args.cmd in {"add", "edit", "remove", "seed", "import"}:
        _sighup_worker()
    return code


# IMPLEMENTER: write the _cmd_* handlers. They are mostly thin wrappers
# over PromptsRepo / seed.py functions. Key invariants the tests demand:
#  - _cmd_list with no flags shows ALL prompts (enabled+disabled+all categories)
#    in JSON if --json, else a human table. Default sort: sort_order asc, slug asc.
#  - _cmd_add accepts EITHER --content or --from-file (mutually exclusive,
#    required). Validates category. Prints the new prompt's id.
#  - _cmd_edit's --auto-run / --no-auto-run are mutually exclusive.
#  - _cmd_remove prints "id <slug> not found" to stderr and returns 1 on miss.
#  - _cmd_show prints the raw content to stdout (no escaping).
#  - _cmd_seed: requires either --from-current or --restore-defaults (mutex).
#  - _cmd_export: default --format json, optional --output (else stdout).
#  - _cmd_import: supports .json (list of prompt dicts).
```

- [ ] **Step 4: Run — PASS**

Run: `pytest tests/test_prompts_cli.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/prompts/cli.py tests/test_prompts_cli.py
git commit -m "feat(prompts): add yulu prompts CLI"
```

## Task 1.4: `yulu summaries` reader CLI

**Files:**
- Create: `yulu/scripts/summaries_cli.py`
- Create: `tests/test_summaries_cli.py`

- [ ] **Step 1: Write tests**

Write `tests/test_summaries_cli.py`:

```python
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from prompts import SummariesRepo, SummaryStatus, open_db
from summaries_cli import main as summaries_main


def _seed(db_path):
    repo = SummariesRepo(open_db(db_path))
    s1 = repo.start(audio_path="/a.wav", prompt_id="p1", prompt_slug="summary",
                    prompt_name="N", prompt_content="c", output_path="/a.summary.md",
                    model="claude")
    repo.mark_done(s1, duration_ms=100, word_count=42)
    s2 = repo.start(audio_path="/a.wav", prompt_id="p2", prompt_slug="action-items",
                    prompt_name="N", prompt_content="c",
                    output_path="/a.action-items.summary.md")
    repo.mark_error(s2, error="timeout")
    s3 = repo.start(audio_path="/b.wav", prompt_id="p1", prompt_slug="summary",
                    prompt_name="N", prompt_content="c", output_path="/b.summary.md")
    return s1, s2, s3


def test_list_all_json(tmp_path, capsys):
    db = tmp_path / "p.sqlite"
    _seed(db)
    code = summaries_main(["list", "--json", "--db", str(db)])
    out, _ = capsys.readouterr()
    assert code == 0
    rows = json.loads(out)
    assert len(rows) == 3


def test_list_by_audio(tmp_path, capsys):
    db = tmp_path / "p.sqlite"
    _seed(db)
    code = summaries_main(["list", "--audio", "/a.wav", "--json", "--db", str(db)])
    out, _ = capsys.readouterr()
    rows = json.loads(out)
    assert len(rows) == 2


def test_list_by_status(tmp_path, capsys):
    db = tmp_path / "p.sqlite"
    _seed(db)
    code = summaries_main(["list", "--status", "error", "--json", "--db", str(db)])
    out, _ = capsys.readouterr()
    rows = json.loads(out)
    assert len(rows) == 1
    assert rows[0]["status"] == "error"


def test_show_unknown_returns_error(tmp_path, capsys):
    db = tmp_path / "p.sqlite"
    code = summaries_main(["show", "missing-id", "--db", str(db)])
    _, err = capsys.readouterr()
    assert code != 0
    assert "not found" in err.lower()
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `summaries_cli.py`**

```python
"""`yulu summaries` CLI — read-only browser over the summaries provenance table."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from prompts import SummariesRepo, SummaryStatus, open_db


DEFAULT_DB = Path.home() / ".config" / "yulu" / "prompts.sqlite"


def _summary_to_dict(s) -> dict:
    d = asdict(s)
    d["status"] = s.status.value
    return d


def _extract_db_from_argv(argv: list[str]) -> tuple[str, list[str]]:
    """Same pattern as vocab/cli.py + prompts/cli.py."""
    # IMPLEMENTER: mirror.
    ...


def _build_parser() -> argparse.ArgumentParser:
    """Subcommands:
      list [--audio <path>] [--status queued|running|done|error] [--json]
      show <id>
    """
    # IMPLEMENTER: build it.
    ...


def main(argv: Optional[list[str]] = None) -> int:
    """Entry point. Note: this CLI is read-only, no SIGHUP needed."""
    if argv is None:
        argv = sys.argv[1:]
    db_path, remaining = _extract_db_from_argv(list(argv))
    parser = _build_parser()
    args = parser.parse_args(remaining)
    args.db = db_path

    repo = SummariesRepo(open_db(Path(args.db)))
    try:
        if args.cmd == "list":
            status = SummaryStatus(args.status) if args.status else None
            rows = repo.list_summaries(audio_path=args.audio, status=status)
            data = [_summary_to_dict(s) for s in rows]
            if args.json:
                print(json.dumps(data, ensure_ascii=False, indent=2))
            else:
                _print_table(data)
            return 0
        elif args.cmd == "show":
            s = repo.get(args.id)
            if not s:
                print(f"summary {args.id} not found", file=sys.stderr)
                return 1
            print(json.dumps(_summary_to_dict(s), ensure_ascii=False, indent=2))
            return 0
    finally:
        repo.conn.close()


def _print_table(rows: list[dict]) -> None:
    """Compact table: id-prefix, status, slug, audio basename, duration_ms."""
    # IMPLEMENTER: simple formatting; mirror vocab/cli.py _print_table style.
    ...


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run — PASS**

Run: `pytest tests/test_summaries_cli.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/summaries_cli.py tests/test_summaries_cli.py
git commit -m "feat(prompts): add yulu summaries reader CLI"
```

## Task 1.5: Wire `prompts` + `summaries` into yulu wrapper

**Files:**
- Modify: `yulu/scripts/yulu`

- [ ] **Step 1: Edit dispatch table**

Find the `case "${1:-help}" in ... esac` block at the bottom of `yulu/scripts/yulu`. Locate the `vocab)` and `stt)` lines (added by earlier work). Insert two new lines right after them:

```bash
    prompts)   shift; PYTHONPATH="$SCRIPT_DIR:${PYTHONPATH:-}" exec "${PYTHON:-python3}" -m prompts.cli "$@" ;;
    summaries) shift; PYTHONPATH="$SCRIPT_DIR:${PYTHONPATH:-}" exec "${PYTHON:-python3}" -m summaries_cli "$@" ;;
```

- [ ] **Step 2: Smoke test**

```bash
YULU_DB=$(mktemp -d)/p.sqlite
./yulu/scripts/yulu prompts seed --from-current --db "$YULU_DB"
./yulu/scripts/yulu prompts list --json --db "$YULU_DB" | python3 -m json.tool | head
./yulu/scripts/yulu summaries list --json --db "$YULU_DB"
```
Expected: seed prints `{"inserted": 3, "updated": 0}`; list shows 3 prompts; summaries list is `[]`.

- [ ] **Step 3: Full pytest**

Run: `pytest -q`
Expected: all green (prior tests + 4 new test files = ~26 added tests; previously 94 + e2e skip).

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/yulu
git commit -m "feat(yulu): dispatch 'prompts' and 'summaries' subcommands"
```

---

# Phase 2 — PromptsCache

**Outcome:** `PromptsCache` provides in-process query (`auto_run`, `by_slug`, `by_id`, `render`) with WAL-aware mtime + SIGHUP reload. `resolve_meeting_date(audio_path)` is exposed for both `transcribe.py` and the worker to share.

## Task 2.1: PromptsCache + `resolve_meeting_date`

**Files:**
- Create: `yulu/scripts/prompts/cache.py`
- Create: `tests/test_prompts_cache.py`

**Reference:** `yulu/scripts/stt_daemon/vocab_cache.py` is the architectural sibling. Lift the `_max_mtime()` WAL-sidecar check, the lock, the load/reload split.

- [ ] **Step 1: Write tests**

Write `tests/test_prompts_cache.py`:

```python
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import pytest
from prompts import PromptsRepo, Category, open_db
from prompts.cache import PromptsCache, resolve_meeting_date


# ── render ─────────────────────────────────────────────────────────

def test_render_substitutes_all_three_vars(tmp_path):
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(slug="summary", name="N", category=Category.SUMMARY,
             content="Date: {{date}} Title: {{meeting_title}} -- {{transcript}}",
             is_auto_run=True)
    cache = PromptsCache(db); cache.load()
    p = cache.by_slug("summary")
    out = cache.render(p, transcript="HELLO", meeting_title="Standup", date="2026-05-22")
    assert "Date: 2026-05-22" in out
    assert "Title: Standup" in out
    assert "HELLO" in out
    assert "{{" not in out


# ── auto_run + by_slug + by_id ─────────────────────────────────────

def test_auto_run_filters_by_category(tmp_path):
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(slug="s1", name="S1", category=Category.SUMMARY, content="x", is_auto_run=True)
    repo.add(slug="s2", name="S2", category=Category.SUMMARY, content="x", is_auto_run=False)
    repo.add(slug="c1", name="C1", category=Category.CLEANUP, content="x", is_auto_run=True)
    cache = PromptsCache(db); cache.load()
    s = [p.slug for p in cache.auto_run("summary")]
    c = [p.slug for p in cache.auto_run("cleanup")]
    assert s == ["s1"]
    assert c == ["c1"]


def test_by_slug_and_by_id(tmp_path):
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    pid = repo.add(slug="x", name="X", category=Category.SUMMARY, content="x")
    cache = PromptsCache(db); cache.load()
    assert cache.by_slug("x").id == pid
    assert cache.by_id(pid).slug == "x"
    assert cache.by_slug("ghost") is None


# ── reload ─────────────────────────────────────────────────────────

def test_reload_picks_up_changes(tmp_path):
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(slug="a", name="A", category=Category.SUMMARY, content="x", is_auto_run=True)
    cache = PromptsCache(db); cache.load()
    assert len(cache.auto_run("summary")) == 1
    repo.add(slug="b", name="B", category=Category.SUMMARY, content="x", is_auto_run=True)
    cache.reload()
    assert len(cache.auto_run("summary")) == 2


def test_maybe_reload_uses_max_wal_mtime(tmp_path):
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(slug="a", name="A", category=Category.SUMMARY, content="x", is_auto_run=True)
    cache = PromptsCache(db, autoreload=True); cache.load()
    initial = len(cache.auto_run("summary"))
    time.sleep(1.0)  # WAL writes go to -wal sidecar; mtime ≥ 1 second
    repo.add(slug="b", name="B", category=Category.SUMMARY, content="x", is_auto_run=True)
    assert cache.maybe_reload() is True
    assert len(cache.auto_run("summary")) == initial + 1


# ── resolve_meeting_date ───────────────────────────────────────────

def test_resolve_meeting_date_from_filename_suffix(tmp_path):
    p = tmp_path / "AgentkeyWeekly_20260519_160002.wav"
    p.write_bytes(b"")
    assert resolve_meeting_date(p) == "2026-05-19"


def test_resolve_meeting_date_falls_back_to_mtime(tmp_path):
    p = tmp_path / "no-suffix.wav"
    p.write_bytes(b"")
    # mtime should be today; just assert it's a valid ISO YYYY-MM-DD shape
    d = resolve_meeting_date(p)
    assert len(d) == 10 and d[4] == "-" and d[7] == "-"


def test_resolve_meeting_date_missing_file_falls_back_to_today(tmp_path):
    p = tmp_path / "nonexistent.wav"
    from datetime import datetime
    expected = datetime.now().strftime("%Y-%m-%d")
    assert resolve_meeting_date(p) == expected


def test_resolve_meeting_date_unparseable_suffix(tmp_path):
    # Looks like the pattern but invalid date numbers
    p = tmp_path / "Weird_20269999_999999.wav"
    p.write_bytes(b"")
    # Should fall back to mtime, not raise
    d = resolve_meeting_date(p)
    assert len(d) == 10
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `cache.py`**

Skeleton:

```python
"""In-memory cache over the prompts.sqlite table + shared meeting-date helper."""

from __future__ import annotations

import re
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional

from .db import (
    Category, Prompt, PromptsRepo, open_db,
)


_DATE_SUFFIX_RE = re.compile(r"_(\d{8})_\d{6}\.")


def resolve_meeting_date(audio_path: Path) -> str:
    """Resolve YYYY-MM-DD for a meeting audio file.

    Strategy:
      1. Look for `_YYYYMMDD_HHMMSS.` in the filename (audio_daemon naming).
      2. Try to parse it as a date. On parse failure, drop to (3).
      3. Fall back to os.stat(path).st_mtime, system timezone.
      4. On stat failure (file missing), return today's date.

    Reused by transcribe.py at enqueue AND agent_queue_worker at dispatch so
    the value is stable across the queue boundary.
    """
    # IMPLEMENTER: write the 4-tier strategy. The tests pin behavior.
    audio_path = Path(audio_path)
    m = _DATE_SUFFIX_RE.search(audio_path.name)
    if m:
        try:
            return datetime.strptime(m.group(1), "%Y%m%d").strftime("%Y-%m-%d")
        except ValueError:
            pass
    try:
        return datetime.fromtimestamp(audio_path.stat().st_mtime).strftime("%Y-%m-%d")
    except OSError:
        return datetime.now().strftime("%Y-%m-%d")


class PromptsCache:
    """Loads prompts from sqlite; exposes auto_run / by_slug / by_id / render.

    API parallels yulu/scripts/stt_daemon/vocab_cache.py::VocabCache —
    same WAL-aware reload semantics, same threading.RLock.
    """

    def __init__(self, db_path: Path, *, autoreload: bool = False):
        self.db_path = Path(db_path)
        self.autoreload = autoreload
        self._lock = threading.RLock()
        self._by_id: dict[str, Prompt] = {}
        self._by_slug: dict[str, Prompt] = {}
        self._mtime: float = 0.0

    def _max_mtime(self) -> float:
        """max(main file mtime, -wal sidecar mtime). Mirror vocab_cache.py."""
        # IMPLEMENTER: copy the vocab_cache._max_mtime body.
        ...

    def load(self) -> None:
        self.reload()

    def reload(self) -> None:
        """Re-read prompts from sqlite; rebuild by_id + by_slug indexes."""
        # IMPLEMENTER: open_db + PromptsRepo, list_prompts(), populate
        # _by_id and _by_slug under self._lock. Update self._mtime via
        # _max_mtime(). If db_path doesn't exist, clear caches and set
        # _mtime=0.0.
        ...

    def maybe_reload(self) -> bool:
        """If autoreload + mtime changed since last load, reload + return True."""
        # IMPLEMENTER: copy vocab_cache.maybe_reload pattern.
        ...

    def by_id(self, prompt_id: str) -> Optional[Prompt]:
        with self._lock:
            return self._by_id.get(prompt_id)

    def by_slug(self, slug: str) -> Optional[Prompt]:
        with self._lock:
            return self._by_slug.get(slug)

    def auto_run(self, category: str) -> list[Prompt]:
        """Prompts in `category` with is_auto_run=True, sorted by sort_order asc."""
        cat = Category(category) if not isinstance(category, Category) else category
        with self._lock:
            results = [p for p in self._by_id.values()
                       if p.category == cat and p.is_auto_run]
        results.sort(key=lambda p: (p.sort_order, p.slug))
        return results

    def render(self, prompt: Prompt, *,
               transcript: str, meeting_title: str, date: str) -> str:
        """Single-pass literal substitution of {{transcript}}/{{meeting_title}}/{{date}}."""
        return (prompt.content
                .replace("{{transcript}}", transcript)
                .replace("{{meeting_title}}", meeting_title)
                .replace("{{date}}", date))
```

- [ ] **Step 4: Run — PASS**

Run: `pytest tests/test_prompts_cache.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/prompts/cache.py tests/test_prompts_cache.py
git commit -m "feat(prompts): add PromptsCache + resolve_meeting_date helper"
```

---

# Phase 3 — Event Schema Evolution

**Outcome:** `queue_store.append_event` accepts the new `summary_request` fields; readers handle missing fields as legacy events.

## Task 3.1: Extend `queue_store.py` (additive, back-compat)

**Files:**
- Modify: `yulu/scripts/queue_store.py`
- Modify: `tests/test_queue_store.py` (extend, not replace)

**Note:** `queue_store.append_event` is already generic (`append_event(event_type, path, **fields)`). It writes whatever fields you pass into the JSON object. So the schema extension is **purely about consumer-side handling**: this task is really about adding tests that pin the legacy-event-fallback contract.

- [ ] **Step 1: Add tests for back-compat shape**

Open `tests/test_queue_store.py` and append:

```python
def test_legacy_summary_request_lacks_prompt_fields(tmp_path):
    """A summary_request written by pre-spec code has no prompt_* fields.
    This test pins that the QUEUE STORE accepts both shapes; consumer-side
    fallback is tested separately in test_agent_queue_worker_prompts.py."""
    queue_path = tmp_path / "agent-queue.json"
    # Legacy shape
    append_event("summary_request", path=queue_path,
                 title="Old Meeting",
                 transcript_path="/tmp/t.txt",
                 summary_path="/tmp/s.md")
    # New shape
    append_event("summary_request", path=queue_path,
                 title="New Meeting",
                 audio_path="/tmp/a.wav",
                 transcript_path="/tmp/t.txt",
                 summary_path="/tmp/s.md",
                 html_path_hint="/tmp/s.html",
                 prompt_id="pid-1",
                 prompt_slug="summary",
                 prompt_name="Standard Summary",
                 prompt_content_snapshot="please summarize {{transcript}}")
    queue = load_queue(queue_path)
    assert len(queue) == 2
    legacy = next(e for e in queue if e["title"] == "Old Meeting")
    new = next(e for e in queue if e["title"] == "New Meeting")
    assert "prompt_id" not in legacy
    assert new["prompt_id"] == "pid-1"
    assert new["prompt_content_snapshot"] == "please summarize {{transcript}}"
```

- [ ] **Step 2: Run — PASS** (no implementation change needed; the test should already pass against the current `queue_store.py` since it's a passthrough dict-merge)

Run: `pytest tests/test_queue_store.py -v`
Expected: all green (existing + 1 new).

- [ ] **Step 3: Commit**

```bash
git add tests/test_queue_store.py
git commit -m "test(queue_store): pin summary_request legacy + new shapes coexist"
```

---

# Phase 4 — agent_queue_worker Rewrite

**Outcome:** Worker writes a pid file, owns the only LLM dispatch, resolves prompt content from snapshot or cache, records every run in `summaries` table, and triggers html artifact + send for `summary` slug.

## Task 4.1: Worker pid file at startup (for SIGHUP)

**Files:**
- Modify: `yulu/scripts/agent_queue_worker.py`
- Test: extend `tests/test_agent_queue_worker.py` (existing)

- [ ] **Step 1: Write a test**

Append to `tests/test_agent_queue_worker.py`:

```python
def test_main_writes_pid_file(tmp_path, monkeypatch, capsys):
    """yulu prompts CLI sends SIGHUP via the pid file; worker must write it."""
    import agent_queue_worker as worker
    pid_file = tmp_path / "agent_queue_worker.pid"
    monkeypatch.setattr(worker, "PID_PATH", pid_file)
    monkeypatch.setattr(worker, "QUEUE_PATH", tmp_path / "agent-queue.json")
    # Avoid running any LLM
    monkeypatch.setattr(worker, "_load_llm_command", lambda *_a, **_k: [])
    worker.main([])
    assert pid_file.exists()
    pid = int(pid_file.read_text().strip())
    assert pid == os.getpid()
```

(Add `import os` at top if not present.)

- [ ] **Step 2: Run — FAIL**

Expected: AttributeError `PID_PATH` not on module.

- [ ] **Step 3: Edit `agent_queue_worker.py`**

Near the existing `LOG_PATH` constant, add:

```python
PID_PATH = Path.home() / ".config" / "yulu" / "agent_queue_worker.pid"
```

In `main()`, near the top before queue processing:

```python
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(...)
    # ... existing args ...
    args = parser.parse_args(argv)

    # Write pid for `yulu prompts reload` SIGHUP path
    try:
        PID_PATH.parent.mkdir(parents=True, exist_ok=True)
        PID_PATH.write_text(str(os.getpid()), encoding="utf-8")
    except OSError:
        pass

    # ... rest of main unchanged ...
```

- [ ] **Step 4: Run — PASS**

```bash
pytest tests/test_agent_queue_worker.py -v
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/agent_queue_worker.py tests/test_agent_queue_worker.py
git commit -m "feat(agent_queue_worker): write pid file at startup for SIGHUP"
```

## Task 4.2: SIGHUP handler + PromptsCache wiring

**Files:**
- Modify: `yulu/scripts/agent_queue_worker.py`

**Note:** Existing worker is launchd-tick-based (`agent_queue_worker.py` is invoked periodically by launchd; not a long-lived process). SIGHUP support is therefore only meaningful for the **current tick**. For now the implementation should:

1. Install a SIGHUP handler that sets a module-level `_RELOAD_PROMPTS` flag.
2. Before each event dispatch, check the flag and reload `PromptsCache` if set.

Because launchd re-spawns the worker every tick (default 5s), this is mostly defensive — fresh process gets a fresh cache anyway. But for long-running batches inside one tick, SIGHUP still does the right thing.

- [ ] **Step 1: Add test that SIGHUP triggers cache reload**

Append to `tests/test_agent_queue_worker.py`:

```python
def test_sighup_reloads_prompts_cache(tmp_path, monkeypatch):
    """SIGHUP between events causes PromptsCache to reload."""
    import agent_queue_worker as worker
    import signal as sig
    import threading

    # IMPLEMENTER: stub out PromptsCache to count reload() calls.
    # Send SIGHUP from a thread, then call process_queue_once after a
    # crafted summary_request landed in the queue. Assert cache.reload
    # was called.
    pass  # IMPLEMENTER: write this test
```

The test is non-trivial; the implementer writes it as part of step 3. Move on if blocked.

- [ ] **Step 2: Implement SIGHUP handler in worker**

In `agent_queue_worker.py` `main()`:

```python
_RELOAD_PROMPTS = False

def _handle_sighup(_signum, _frame):
    global _RELOAD_PROMPTS
    _RELOAD_PROMPTS = True


def main(argv):
    # ... pid file ...
    signal.signal(signal.SIGHUP, _handle_sighup)
    # ... rest ...
```

In `process_queue_once`, before dispatching each event, check the flag:

```python
def process_queue_once(...):
    cache = PromptsCache(PROMPTS_DB)
    cache.load()
    # ... main loop ...
    while True:
        global _RELOAD_PROMPTS
        if _RELOAD_PROMPTS:
            cache.reload()
            _RELOAD_PROMPTS = False
        entry = claim_summary_request(...)
        if not entry:
            break
        _handle_summary_request(entry, llm_command, timeout_sec, cache)
```

- [ ] **Step 3: Commit**

```bash
git add yulu/scripts/agent_queue_worker.py tests/test_agent_queue_worker.py
git commit -m "feat(agent_queue_worker): SIGHUP triggers PromptsCache reload"
```

## Task 4.3: New `_handle_summary_request` (snapshot + SummariesRepo + html + send)

**Files:**
- Modify: `yulu/scripts/agent_queue_worker.py`
- Create: `tests/test_agent_queue_worker_prompts.py`

**Reference:** Spec §11 has the target shape.

- [ ] **Step 1: Write tests (full suite for the new behavior)**

Write `tests/test_agent_queue_worker_prompts.py`:

```python
"""Tests for agent_queue_worker's new prompt-library-aware dispatch.

Uses a fake LLM command (a bash script that just echoes a known string)
and a fake PromptsCache+SummariesRepo. End-to-end: queue → worker →
file on disk + summaries-table row.
"""

import json
import os
import shutil
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import pytest
from prompts import PromptsRepo, SummariesRepo, Category, SummaryStatus, open_db
import agent_queue_worker as worker


def _stub_llm(tmp_path: Path, output: str) -> Path:
    cli = tmp_path / "stub-llm"
    cli.write_text(
        "#!/usr/bin/env bash\n"
        # Just echo the canned output; ignore stdin
        f"cat > /dev/null\necho {output!r}\nexit 0\n"
    )
    cli.chmod(cli.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return cli


def _setup(tmp_path, summary_text="## Summary\n\n* point", llm_cmd=None):
    prompts_db = tmp_path / "prompts.sqlite"
    repo = PromptsRepo(open_db(prompts_db))
    repo.add(slug="summary", name="Standard Summary", category=Category.SUMMARY,
             content="please summarize: {{transcript}}", is_auto_run=True)
    transcript = tmp_path / "meeting.transcript.txt"
    transcript.write_text("the transcript body", encoding="utf-8")
    summary_path = tmp_path / "meeting.summary.md"
    audio_path = tmp_path / "meeting.wav"
    audio_path.write_bytes(b"R")
    return {
        "prompts_db": prompts_db,
        "transcript": transcript,
        "summary_path": summary_path,
        "audio_path": audio_path,
        "llm_cmd": llm_cmd or [str(_stub_llm(tmp_path, summary_text))],
    }


def test_new_event_resolves_snapshot_and_writes_summary(tmp_path):
    ctx = _setup(tmp_path)
    entry = {
        "id": "e1",
        "type": "summary_request",
        "title": "Test Meeting",
        "audio_path": str(ctx["audio_path"]),
        "transcript_path": str(ctx["transcript"]),
        "summary_path": str(ctx["summary_path"]),
        "prompt_id": "p1",
        "prompt_slug": "summary",
        "prompt_name": "Standard Summary",
        "prompt_content_snapshot": "please summarize: {{transcript}}",
    }
    # Test the inner handler in isolation (not process_queue_once)
    from prompts.cache import PromptsCache
    cache = PromptsCache(ctx["prompts_db"]); cache.load()
    worker._handle_summary_request(
        entry, ctx["llm_cmd"], timeout_sec=30, cache=cache,
        prompts_db=ctx["prompts_db"],
    )
    # File written
    assert ctx["summary_path"].exists()
    assert "Summary" in ctx["summary_path"].read_text()
    # Summaries row recorded
    srepo = SummariesRepo(open_db(ctx["prompts_db"]))
    rows = srepo.list_summaries(audio_path=str(ctx["audio_path"]))
    assert len(rows) == 1
    assert rows[0].status == SummaryStatus.DONE
    assert rows[0].prompt_slug == "summary"
    assert rows[0].duration_ms is not None and rows[0].duration_ms >= 0


def test_legacy_event_falls_back_to_default_summary_prompt(tmp_path):
    ctx = _setup(tmp_path)
    legacy = {
        "id": "e2",
        "type": "summary_request",
        "title": "Legacy",
        "transcript_path": str(ctx["transcript"]),
        "summary_path": str(ctx["summary_path"]),
        # No prompt_* fields
    }
    from prompts.cache import PromptsCache
    cache = PromptsCache(ctx["prompts_db"]); cache.load()
    worker._handle_summary_request(
        legacy, ctx["llm_cmd"], timeout_sec=30, cache=cache,
        prompts_db=ctx["prompts_db"],
    )
    assert ctx["summary_path"].exists()
    srepo = SummariesRepo(open_db(ctx["prompts_db"]))
    rows = srepo.list_summaries()
    # Worker fell back to cache.by_slug('summary') for prompt fields
    assert rows[0].prompt_slug == "summary"


def test_llm_failure_marks_error_in_summaries_table(tmp_path):
    failing = tmp_path / "failing-llm"
    failing.write_text(
        "#!/usr/bin/env bash\ncat > /dev/null\necho 'oops' >&2\nexit 7\n"
    )
    failing.chmod(failing.stat().st_mode | stat.S_IXUSR)
    ctx = _setup(tmp_path, llm_cmd=[str(failing)])
    entry = {
        "id": "e3", "type": "summary_request", "title": "T",
        "audio_path": str(ctx["audio_path"]),
        "transcript_path": str(ctx["transcript"]),
        "summary_path": str(ctx["summary_path"]),
        "prompt_id": "p1", "prompt_slug": "summary",
        "prompt_name": "Standard Summary",
        "prompt_content_snapshot": "please summarize: {{transcript}}",
    }
    from prompts.cache import PromptsCache
    cache = PromptsCache(ctx["prompts_db"]); cache.load()
    with pytest.raises(RuntimeError):
        worker._handle_summary_request(
            entry, ctx["llm_cmd"] + ["nonexistent-flag"],  # unused
            timeout_sec=30, cache=cache,
            prompts_db=ctx["prompts_db"],
        )
    # Actually re-run with failing command
    with pytest.raises(RuntimeError):
        worker._handle_summary_request(
            entry, [str(failing)], timeout_sec=30, cache=cache,
            prompts_db=ctx["prompts_db"],
        )
    srepo = SummariesRepo(open_db(ctx["prompts_db"]))
    err_rows = srepo.list_summaries(status=SummaryStatus.ERROR)
    assert len(err_rows) >= 1
    assert "rc=7" in (err_rows[0].error or "") or "oops" in (err_rows[0].error or "")


def test_template_variables_all_substituted(tmp_path, monkeypatch):
    """{{transcript}}, {{meeting_title}}, {{date}} all replaced before LLM input."""
    received = tmp_path / "stdin-capture.txt"
    capturer = tmp_path / "capture-llm"
    capturer.write_text(
        "#!/usr/bin/env bash\n"
        f"cat > {received!s}\n"
        "echo 'output'\n"
    )
    capturer.chmod(capturer.stat().st_mode | stat.S_IXUSR)
    ctx = _setup(tmp_path, llm_cmd=[str(capturer)])
    # Use a content template that uses all three vars
    repo = PromptsRepo(open_db(ctx["prompts_db"]))
    repo.edit("summary",
              content="date={{date}} title={{meeting_title}} ===\n{{transcript}}")
    # Audio path with parseable date suffix
    audio = tmp_path / "Meeting_20260519_140000.wav"
    audio.write_bytes(b"R")
    transcript = tmp_path / "Meeting_20260519_140000.transcript.txt"
    transcript.write_text("body", encoding="utf-8")
    summary_path = tmp_path / "Meeting_20260519_140000.summary.md"
    entry = {
        "id": "e", "type": "summary_request", "title": "May Meeting",
        "audio_path": str(audio),
        "transcript_path": str(transcript),
        "summary_path": str(summary_path),
        "prompt_id": "p", "prompt_slug": "summary",
        "prompt_name": "S",
        "prompt_content_snapshot":
            "date={{date}} title={{meeting_title}} ===\n{{transcript}}",
    }
    from prompts.cache import PromptsCache
    cache = PromptsCache(ctx["prompts_db"]); cache.load()
    worker._handle_summary_request(
        entry, [str(capturer)], timeout_sec=30, cache=cache,
        prompts_db=ctx["prompts_db"],
    )
    payload = received.read_text(encoding="utf-8")
    assert "date=2026-05-19" in payload
    assert "title=May Meeting" in payload
    assert "body" in payload
    assert "{{" not in payload
```

- [ ] **Step 2: Run — FAIL** (handler signature changed; old `_handle_summary_request` doesn't accept `cache` or `prompts_db` kwargs yet).

- [ ] **Step 3: Implement new `_handle_summary_request`**

Replace the old `_handle_summary_request` in `agent_queue_worker.py` with the new shape per spec §11. Key invariants:

```python
PROMPTS_DB = Path.home() / ".config" / "yulu" / "prompts.sqlite"


def _handle_summary_request(
    entry: dict[str, Any],
    llm_command: list[str],
    timeout_sec: int,
    cache: "PromptsCache",
    *,
    prompts_db: Path = PROMPTS_DB,
) -> bool:
    """Single LLM dispatch for one summary_request event.

    Flow:
      1. Resolve prompt content:
         - prefer entry['prompt_content_snapshot'] (new events)
         - else load default 'summary' slug from cache (legacy events)
      2. Read transcript file; substitute {{transcript}}, {{meeting_title}}, {{date}}
      3. Insert SummariesRepo row (status=queued → running)
      4. Run llm_command via subprocess; capture stdout
      5. Validate output non-empty + not agent-event-json
      6. Write output to entry['summary_path']
      7. For summary slug (not cleanup): write html_artifact, dispatch send_summary
      8. SummariesRepo mark_done (with duration_ms, word_count, html_path)
      9. On any failure path 3→8: SummariesRepo mark_error and re-raise

    Returns True on success. Raises on failure (caller logs).
    """
    # IMPLEMENTER: write this following spec §11. Key tricky points:
    #
    # (a) prompts_db is a kwarg so tests can use a tmp path; in production it
    #     defaults to PROMPTS_DB.
    #
    # (b) For cleanup-category prompts (prompt_slug=='transcript-cleanup'):
    #     write output to transcript_path (overwriting it), NOT to
    #     summary_path. Don't write html, don't dispatch send_summary.
    #     Still record a summaries row with output_path=transcript_path.
    #
    # (c) Use prompts.cache.resolve_meeting_date() to compute {{date}}.
    #     Use entry['audio_path'] if present, else derive from transcript_path
    #     (strip .transcript.txt suffix).
    #
    # (d) The existing _looks_like_agent_event_json helper stays; reuse it
    #     as the "output is invalid" check.
    #
    # (e) Use SummariesRepo from a SHORT-LIVED connection (open + close);
    #     do NOT share `cache.conn` — cache is read-only and may be in a
    #     different thread context if SIGHUP racing.
    ...
```

- [ ] **Step 4: Adjust the existing `_dispatch_summary` integration**

The existing worker has a `_dispatch_summary` function that runs `send_summary.py` after the summary is generated. Keep it but call it ONLY when `prompt_slug == 'summary'` (default summary is the one auto-sent; other slugs need an explicit `yulu send --prompt <slug>`).

- [ ] **Step 5: Run — PASS**

```bash
pytest tests/test_agent_queue_worker_prompts.py -v
pytest tests/test_agent_queue_worker.py -v   # existing tests still green
```

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/agent_queue_worker.py tests/test_agent_queue_worker_prompts.py
git commit -m "feat(agent_queue_worker): single LLM dispatcher with PromptsCache + SummariesRepo"
```

---

# Phase 5 — transcribe.py Thin Orchestrator

**Outcome:** `transcribe.py` only enqueues. Deleted: `SUMMARY_PROMPT`, `summarize`, `fallback_summary`, `refine_transcript`, `_send_agent_notification`. File drops to < 200 lines.

## Task 5.1: Delete the LLM-invoking helpers

**Files:**
- Modify: `yulu/scripts/transcribe.py` (deletion only; new flow lands in Task 5.2)

- [ ] **Step 1: Verify current line count + identify deletions**

Run:
```bash
wc -l yulu/scripts/transcribe.py
grep -nE "^def |^SUMMARY_PROMPT" yulu/scripts/transcribe.py
```
Note the function boundaries you'll delete.

- [ ] **Step 2: Delete these top-level definitions** (entire function bodies + the constant)

- `SUMMARY_PROMPT` constant block (the multi-line string near the top)
- `def refine_transcript(...)`
- `def summarize(...)`
- `def fallback_summary(...)`
- `def _send_agent_notification(...)` (kept-helper duplicate; `_notify_agent` survives)
- `def request_agent_summary(...)` — superseded by Task 5.2's `_enqueue` flow

Imports of `shlex`, `subprocess`, `re` may become dead — leave them; Task 5.2 will re-use some.

- [ ] **Step 3: Comment out the body of `process_audio` from the point summary work begins**

`process_audio` will be rewritten in Task 5.2. For now make it a stub that raises NotImplementedError beyond the transcript-saving step so this commit lands cleanly without orphan function references.

```python
def process_audio(audio_path_str: str) -> tuple[str, str]:
    """STUB during refactor — Task 5.2 rewrites the prompt-dispatch portion."""
    raise NotImplementedError("transcribe.py prompt dispatch is being refactored; see Task 5.2")
```

Tests will fail here; that's fine — the commit is "delete legacy LLM code", and Task 5.2 fixes things.

- [ ] **Step 4: Commit (knowingly red)**

```bash
git add yulu/scripts/transcribe.py
git commit -m "refactor(transcribe): remove inline LLM helpers and SUMMARY_PROMPT (mid-refactor; Task 5.2 lands new flow)"
```

## Task 5.2: New `process_audio` (pure enqueuer)

**Files:**
- Modify: `yulu/scripts/transcribe.py`
- Create: `tests/test_transcribe_enqueue.py`

- [ ] **Step 1: Write tests**

Write `tests/test_transcribe_enqueue.py`:

```python
"""End-to-end (with mocks) that transcribe.py enqueues per-prompt events."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from prompts import PromptsRepo, Category, open_db


def _bootstrap_db(tmp_path, *, with_action_items=False):
    db = tmp_path / "prompts.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(slug="summary", name="Standard Summary", category=Category.SUMMARY,
             content="please summarize {{transcript}}", is_auto_run=True)
    repo.add(slug="transcript-cleanup", name="Cleanup", category=Category.CLEANUP,
             content="clean {{transcript}}", is_auto_run=True)
    if with_action_items:
        repo.add(slug="action-items", name="Action Items",
                 category=Category.SUMMARY,
                 content="actions from {{transcript}}", is_auto_run=True)
    return db


def test_enqueues_one_event_per_auto_run_prompt(tmp_path, monkeypatch):
    import transcribe
    # Point transcribe at our tmp_path config dir
    fake_home = tmp_path / "config"
    (fake_home).mkdir()
    monkeypatch.setattr(transcribe, "CONFIG_PATH", fake_home / "config.json")
    (fake_home / "config.json").write_text(json.dumps({
        "transcription": {"final_engine": "mlx", "language": "zh",
                          "post_recording_mode": "full"},
        "llm": {"enabled": True},
    }))
    # Point prompts at our tmp db
    db = _bootstrap_db(tmp_path, with_action_items=True)
    monkeypatch.setattr(transcribe, "PROMPTS_DB", db, raising=False)
    # Avoid actually contacting stt_daemon — make _request_final_transcribe
    # return a canned transcript
    monkeypatch.setattr(transcribe, "_request_final_transcribe",
                        lambda *a, **k: "the transcript")
    # Point the agent queue at our tmp_path
    queue_path = fake_home / "agent-queue.json"
    monkeypatch.setattr(transcribe, "AGENT_QUEUE_PATH", queue_path, raising=False)

    # Run on a fake audio file
    audio = tmp_path / "Smoke_20260519_120000.wav"
    audio.write_bytes(b"R")
    transcribe.process_audio(str(audio))

    # Expect 3 enqueued events: 1 cleanup + 2 summary (default + action-items)
    queue = json.loads(queue_path.read_text())
    sr = [e for e in queue if e["type"] == "summary_request"]
    assert len(sr) == 3
    slugs = sorted(e["prompt_slug"] for e in sr)
    assert slugs == ["action-items", "summary", "transcript-cleanup"]
    # Snapshots populated
    for ev in sr:
        assert ev["prompt_content_snapshot"]
        assert ev["audio_path"] == str(audio)
    # File naming
    default = next(e for e in sr if e["prompt_slug"] == "summary")
    assert default["summary_path"].endswith(".summary.md")
    assert not default["summary_path"].endswith(".action-items.summary.md")
    action = next(e for e in sr if e["prompt_slug"] == "action-items")
    assert action["summary_path"].endswith(".action-items.summary.md")
    cleanup = next(e for e in sr if e["prompt_slug"] == "transcript-cleanup")
    # Cleanup writes back to .transcript.txt
    assert cleanup["summary_path"].endswith(".transcript.txt")


def test_no_auto_run_prompts_means_no_events(tmp_path, monkeypatch):
    import transcribe
    fake_home = tmp_path / "config"
    fake_home.mkdir()
    monkeypatch.setattr(transcribe, "CONFIG_PATH", fake_home / "config.json")
    (fake_home / "config.json").write_text("{}")
    db = tmp_path / "prompts.sqlite"
    open_db(db)  # schema only, no rows
    monkeypatch.setattr(transcribe, "PROMPTS_DB", db, raising=False)
    monkeypatch.setattr(transcribe, "_request_final_transcribe",
                        lambda *a, **k: "x")
    queue_path = fake_home / "agent-queue.json"
    monkeypatch.setattr(transcribe, "AGENT_QUEUE_PATH", queue_path, raising=False)

    audio = tmp_path / "S_20260519_120000.wav"
    audio.write_bytes(b"R")
    transcribe.process_audio(str(audio))
    # No queue events
    assert not queue_path.exists() or json.loads(queue_path.read_text()) == []
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Rewrite `process_audio` per spec §10**

Replace the stub from Task 5.1 with:

```python
PROMPTS_DB = Path.home() / ".config" / "yulu" / "prompts.sqlite"
AGENT_QUEUE_PATH = Path.home() / ".config" / "yulu" / "agent-queue.json"


def process_audio(audio_path_str: str) -> None:
    """Read audio path; orchestrate transcript + enqueue auto-run prompts.

    Steps:
      1. Validate audio file exists.
      2. Derive meeting_title from filename (existing convention).
      3. Get transcript via _request_final_transcribe → stt_daemon RPC,
         or fall back to .realtime.transcript.txt; exit(2) if neither.
      4. Write <audio>.raw.transcript.txt AND <audio>.transcript.txt.
         The .transcript.txt may be overwritten later by a cleanup prompt
         dispatched through the queue.
      5. Open PromptsCache (short-lived); for each auto_run('cleanup') and
         auto_run('summary') prompt, build a summary_request event and append
         it to AGENT_QUEUE_PATH via queue_store.append_event.
      6. Print one-line summary of how many jobs queued.

    Returns nothing; the caller is record_audio.py / meeting_daemon which
    don't use the return.
    """
    # IMPLEMENTER: write per spec §10 pseudocode. Use
    # prompts.cache.PromptsCache, prompts.cache.resolve_meeting_date,
    # and yulu.scripts.queue_store.append_event.

    # File-naming rules (test pins these):
    #   - cleanup slug → output_path = <audio>.transcript.txt
    #   - slug == 'summary' → output_path = <audio>.summary.md (no infix)
    #   - other summary slugs → output_path = <audio>.<slug>.summary.md
    #   - html_path_hint:
    #       - cleanup → omit
    #       - default summary → <audio>.summary.html
    #       - other summary → <audio>.<slug>.summary.html

    ...


def _enqueue_summary_request(*, prompt, audio_path, transcript_path,
                             meeting_title, output_path, queue_path) -> None:
    """Build a summary_request event and append it to queue_path."""
    from queue_store import append_event
    html_path_hint = None
    if prompt.category.value == "summary":
        html_path_hint = str(output_path.with_suffix(".html"))
    append_event(
        "summary_request",
        path=queue_path,
        title=meeting_title,
        audio_path=str(audio_path),
        transcript_path=str(transcript_path),
        summary_path=str(output_path),
        prompt_id=prompt.id,
        prompt_slug=prompt.slug,
        prompt_name=prompt.name,
        prompt_content_snapshot=prompt.content,
        **({"html_path_hint": html_path_hint} if html_path_hint else {}),
    )
```

- [ ] **Step 4: Run — PASS**

```bash
pytest tests/test_transcribe_enqueue.py -v
```

- [ ] **Step 5: Verify line count target**

```bash
wc -l yulu/scripts/transcribe.py
```
Expected: < 200 lines.

- [ ] **Step 6: Run full suite**

```bash
pytest -q
```
All green; old `tests/test_transcription_config.py` may need a couple updates if it referenced deleted functions — patch as needed.

- [ ] **Step 7: Commit**

```bash
git add yulu/scripts/transcribe.py tests/test_transcribe_enqueue.py
git commit -m "refactor(transcribe): pure orchestrator; enqueue one event per auto-run prompt"
```

---

# Phase 6 — Polish, ADR, Acceptance

## Task 6.1: `setup.sh` + `send_summary.py --prompt`

**Files:**
- Modify: `yulu/scripts/setup.sh`
- Modify: `yulu/scripts/send_summary.py`

- [ ] **Step 1: setup.sh prompts seed step**

In the section of `setup.sh` that seeds vocab (added in earlier work), add an analogous prompts seed right after:

```bash
info "种子 prompts.sqlite..."
PYTHONPATH="$SCRIPT_DIR" "$PYTHON_BIN" -m prompts.cli seed --from-current >/dev/null 2>&1 \
  && ok "prompts seed 完成" \
  || warn "prompts seed 失败（可稍后重试: yulu prompts seed --from-current）"
```

Run: `bash -n yulu/scripts/setup.sh` → clean.

- [ ] **Step 2: send_summary.py --prompt**

Open `yulu/scripts/send_summary.py`. Find its argparse block. Add:

```python
parser.add_argument(
    "--prompt", default="summary",
    help="Slug of the prompt whose summary to send (default: summary)"
)
```

Use the slug to derive the input path: if `args.prompt == 'summary'`, use `<audio>.summary.md`; else `<audio>.<slug>.summary.md`. If the file doesn't exist, error with a clear "yulu summaries list --audio <path>" hint.

(If send_summary.py currently takes a summary path argument directly, keep that path; the `--prompt` flag is a convenience for "give me audio path, I'll find the right summary file".)

- [ ] **Step 3: Commit**

```bash
git add yulu/scripts/setup.sh yulu/scripts/send_summary.py
git commit -m "chore(setup): seed prompts on install; send_summary supports --prompt <slug>"
```

## Task 6.2: ADR-004

**Files:**
- Create: `yulu/spec/adr/004-prompt-library.md`
- Modify: `yulu/spec/adr/README.md` (add to index)

- [ ] **Step 1: Write the ADR**

Write `yulu/spec/adr/004-prompt-library.md`:

```markdown
# ADR-004: Prompt Library + multi-summary with single LLM dispatcher

**Status**: Accepted
**Date**: 2026-05-22
**Spec**: [docs/superpowers/specs/2026-05-22-prompt-library-design.md](../../../docs/superpowers/specs/2026-05-22-prompt-library-design.md)
**Builds on**: ADR-002 (vocab SQLite + SIGHUP cache pattern)
**Supersedes**: hardcoded `SUMMARY_PROMPT` constants in `scripts/transcribe.py` and `scripts/agent_queue_worker.py`; inline cleanup prompt in `transcribe.py::refine_transcript`; the inline `summarize()` + `fallback_summary()` LLM path.

## Context

(...summarize the three-place hardcoded prompts + dual-path drift problem from the spec's §1 in 5 lines...)

## Decision

SQLite-backed prompt catalog at `~/.config/yulu/prompts.sqlite` (mirroring `vocab.sqlite`), with two categories — `summary` and `cleanup` — and a per-prompt `is_auto_run` flag. `transcribe.py` becomes a pure enqueuer; `agent_queue_worker.py` is the single LLM dispatcher and owns the new `summaries` provenance table. Each enqueued event carries a snapshot of the prompt content, so summaries are reproducible even if the prompt is edited later.

File-on-disk artifact preserved: default summary still writes to `<meeting>.summary.md` for back-compat with Obsidian / send_summary; other summaries get `<meeting>.<slug>.summary.md`.

## Rejected alternatives

- **DB-only summary content** — would break Yulu's file-centric workflow (Obsidian sync, send_summary's input convention).
- **Keep inline LLM in transcribe.py for low latency, queue only as fallback** — preserves the dual-path drift problem that triggered this spec.
- **YAML prompt files instead of SQLite** — concurrent CLI writer + worker reader is messier without WAL; SQLite's tooling is already in-house from Phase 1.

## Consequences

- Single LLM dispatch surface in the codebase (the worker). All future LLM throttling / retry / model fallback lands in one place.
- `transcribe.py` line count drops from 340 → < 200.
- Users get multi-version summaries by toggling `is_auto_run` on additional prompts (`action-items` is shipped off-by-default; users opt in via `yulu prompts edit action-items --auto-run`).
- LLM is always queue-dispatched, even when configured locally; adds ~5s tick latency from launchd polling. Acceptable; immediate dispatch can be added later if it becomes a UX issue.

## Notes for future change

- If we add a `voicemail` or `chat` prompt category, it's an additive enum extension.
- Per-prompt model selection (e.g. `summary` uses claude, `cleanup` uses a cheap local model) is a future column on the `prompts` table; SummariesRepo already records `model` per row so analytics work today.
```

The "..." line should be filled in by the implementer; the rest is the canonical text.

- [ ] **Step 2: Update README index**

In `yulu/spec/adr/README.md`, add to the table:

```markdown
| [004](004-prompt-library.md) | Prompt Library + multi-summary with single LLM dispatcher | Accepted | 2026-05-22 |
```

- [ ] **Step 3: Commit**

```bash
git add yulu/spec/adr/004-prompt-library.md yulu/spec/adr/README.md
git commit -m "docs(adr): add ADR-004 prompt library + single LLM dispatcher"
```

## Task 6.3: Acceptance criteria as runnable tests

**Files:**
- Modify: `tests/test_spec_acceptance.py`

- [ ] **Step 1: Add prompt-library acceptance assertions**

Append to `tests/test_spec_acceptance.py`:

```python
# ── Prompt Library acceptance (spec 2026-05-22-prompt-library-design.md) ──

def test_transcribe_no_summary_prompt_constant():
    """Acceptance #1: SUMMARY_PROMPT removed from transcribe.py + worker."""
    for name in ("transcribe.py", "agent_queue_worker.py"):
        text = (SCRIPTS / name).read_text(encoding="utf-8")
        assert "SUMMARY_PROMPT" not in text, f"{name} still has SUMMARY_PROMPT"


def test_transcribe_no_summarize_or_fallback_def():
    """Acceptance #2."""
    import re as _re
    text = (SCRIPTS / "transcribe.py").read_text(encoding="utf-8")
    assert _re.search(r"^\s*def\s+summarize\b", text, _re.MULTILINE) is None
    assert _re.search(r"^\s*def\s+fallback_summary\b", text, _re.MULTILINE) is None
    assert _re.search(r"^\s*def\s+refine_transcript\b", text, _re.MULTILINE) is None


def test_transcribe_is_thin():
    """Acceptance #8."""
    line_count = sum(1 for _ in (SCRIPTS / "transcribe.py").open(encoding="utf-8"))
    assert line_count < 200, f"transcribe.py too long: {line_count} lines"


def test_prompts_seed_count(tmp_path):
    """Acceptance #3."""
    sys.path.insert(0, str(SCRIPTS))
    from prompts import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    seed_from_current(repo)
    assert len(repo.list_prompts()) >= 3
```

- [ ] **Step 2: Run — PASS**

```bash
pytest tests/test_spec_acceptance.py -v
pytest -q
```

- [ ] **Step 3: Commit**

```bash
git add tests/test_spec_acceptance.py
git commit -m "test(acceptance): extend with prompt-library acceptance criteria"
```

---

## Self-review

### Spec coverage map

| Spec section | Task(s) |
|---|---|
| §4 Topology | Phase 4 (worker) + Phase 5 (transcribe) |
| §5 Module boundaries | Phase 1 (new package), Phase 4 (worker), Phase 5 (transcribe), Phase 6 (send_summary, setup) |
| §6 SQLite schema + seed | Task 1.1, 1.2 |
| §7 Event schema | Phase 3 + Task 5.2's `_enqueue_summary_request` |
| §8 CLI surface | Task 1.3 (prompts), Task 1.4 (summaries), Task 1.5 (wrapper) |
| §9 PromptsCache | Task 2.1 |
| §10 New transcribe.py | Task 5.1 + 5.2 |
| §11 New worker handler | Task 4.3 |
| §12 Tests | distributed across all tasks |
| §13 Acceptance | Task 6.3 |
| §14 Migration | Task 6.1 (setup.sh) |
| ADR | Task 6.2 |

### Placeholder scan

The plan deliberately leaves implementation bodies for the implementer (`...` in skeletons) — these are intentional, not placeholders. Each comes with: (a) a docstring fixing the contract, (b) a reference to a sibling module (vocab/db.py, vocab/cli.py, vocab_cache.py) that exemplifies the pattern, (c) full test cases. No `TBD` / `TODO` / `fill in details`.

### Type consistency check

- `Prompt` and `Summary` dataclasses defined in Task 1.1 are referenced in Tasks 1.2 (seed), 1.3 (cli), 1.4 (summaries cli), 2.1 (cache), 4.3 (worker), 5.2 (transcribe). Same field set throughout.
- `Category`, `Source`, `SummaryStatus` enums defined in Task 1.1, referenced in Tasks 1.2 / 1.3 / 1.4 / 2.1 / 4.3 / 5.2.
- `PromptsRepo` / `SummariesRepo` method signatures (e.g. `start`, `mark_done`, `mark_error`) defined in Task 1.1's tests, used identically in Task 4.3.
- `PromptsCache` method names (`auto_run`, `by_slug`, `by_id`, `render`, `reload`, `maybe_reload`) consistent across Task 2.1 and consumers in 4.3 / 5.2.
- `resolve_meeting_date(audio_path)` signature consistent in Task 2.1 and Task 4.3 usage.

No drift detected.

---

**End of plan.**
