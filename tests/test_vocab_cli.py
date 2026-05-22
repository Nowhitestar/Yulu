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
