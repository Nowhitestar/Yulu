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
