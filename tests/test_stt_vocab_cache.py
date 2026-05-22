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
