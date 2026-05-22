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
