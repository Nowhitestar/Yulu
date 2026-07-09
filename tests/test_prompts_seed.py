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
    # The voicemail category was removed — every seed is summary or cleanup.
    assert not any(p["slug"].startswith("voicemail") for p in SEED_PROMPTS)
    for p in SEED_PROMPTS:
        assert p["category"] in ("summary", "cleanup")
        # Legacy single-track prompts must include a transcript source;
        # dual-track prompts use {{my_transcript}}/{{their_transcript}} instead.
        if p["slug"] == "action-items-by-speaker":
            assert "{{my_transcript}}" in p["content"]
            assert "{{their_transcript}}" in p["content"]
        else:
            assert "{{transcript}}" in p["content"] or "{{best_transcript}}" in p["content"]
    # auto-run: summary + transcript-cleanup yes, action-items no
    auto = {p["slug"]: p["is_auto_run"] for p in SEED_PROMPTS}
    assert auto["summary"] is True
    assert auto["transcript-cleanup"] is True
    assert auto["action-items"] is False


def test_seed_includes_action_items_by_speaker(tmp_path):
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current

    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    seed_from_current(repo)
    slugs = {p.slug for p in repo.list_prompts()}
    assert "action-items-by-speaker" in slugs

    p = repo.by_slug("action-items-by-speaker")
    # OFF by default — opt-in
    assert p.is_auto_run is False
    # Uses both new template vars
    assert "{{my_transcript}}" in p.content
    assert "{{their_transcript}}" in p.content


def test_seed_total_count_at_least_four():
    """summary + transcript-cleanup + action-items + action-items-by-speaker."""
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    import tempfile, pathlib
    with tempfile.TemporaryDirectory() as td:
        repo = PromptsRepo(open_db(pathlib.Path(td) / "p.sqlite"))
        seed_from_current(repo)
        assert len(repo.list_prompts()) >= 4


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


def test_seed_no_longer_includes_voicemail_prompts(tmp_path):
    """The voicemail-todos / voicemail-clean seeds were deleted; seeding a
    fresh DB must not recreate them."""
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    seed_from_current(repo)
    assert repo.by_slug("voicemail-todos") is None
    assert repo.by_slug("voicemail-clean") is None
    assert not any(p.slug.startswith("voicemail") for p in repo.list_prompts())
