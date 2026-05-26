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
