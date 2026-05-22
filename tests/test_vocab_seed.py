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
