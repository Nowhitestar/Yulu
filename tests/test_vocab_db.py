import sys
import sqlite3
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


def test_open_db_migrates_legacy_vocab_rows(tmp_path):
    db_path = tmp_path / "vocab.sqlite"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE vocab (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            term TEXT NOT NULL UNIQUE,
            pinyin TEXT,
            notes TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO vocab (term, pinyin, notes, created_at, updated_at)
        VALUES ('阿尔法学院', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        """
    )
    conn.commit()
    conn.close()

    repo = VocabRepo(open_db(db_path))
    words = repo.list_words()
    assert [(w.term, w.canonical, w.scope) for w in words] == [
        ("阿尔法学院", "阿尔法学院", Scope.BOTH)
    ]


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
