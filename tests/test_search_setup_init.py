"""Phase F.1 tests: `python3 -m search.indexer init` creates the schema.

This is the same command setup.sh issues. We verify the CLI helper
itself end-to-end via subprocess, and that setup.sh references it
(static text check)."""

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"


def test_module_init_creates_search_db(tmp_path):
    """`python3 -m search.indexer init` creates schema_version=1 db at
    the default location ($HOME/.config/yulu/search.sqlite)."""
    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "PYTHONPATH": str(SCRIPTS) + os.pathsep + os.environ.get("PYTHONPATH", ""),
    }
    result = subprocess.run(
        [sys.executable, "-m", "search.indexer", "init"],
        env=env, capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    db = tmp_path / ".config" / "yulu" / "search.sqlite"
    assert db.exists()
    conn = sqlite3.connect(str(db))
    try:
        version = conn.execute(
            "SELECT value FROM meta WHERE key='schema_version'"
        ).fetchone()
        assert version[0] == "1"
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        assert "docs" in tables
        assert "docs_meta" in tables
    finally:
        conn.close()


def test_module_init_is_idempotent(tmp_path):
    """Re-running init must not error or wipe data."""
    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "PYTHONPATH": str(SCRIPTS) + os.pathsep + os.environ.get("PYTHONPATH", ""),
    }
    for _ in range(3):
        result = subprocess.run(
            [sys.executable, "-m", "search.indexer", "init"],
            env=env, capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0


def test_setup_sh_invokes_search_init():
    """Static check: the setup install pipeline runs `python3 -m search.indexer init`.

    After the Phase-1 setup decomposition (D-12), setup.sh is a thin orchestrator
    that sequences setup_daemons.sh, which owns the vocab/prompts/search seed steps.
    So the `search.indexer init` line now lives in setup_daemons.sh and the
    orchestrator reaches it by invoking that concern script."""
    daemons_sh = SCRIPTS / "setup_daemons.sh"
    daemons_text = daemons_sh.read_text(encoding="utf-8")
    assert "search.indexer init" in daemons_text, \
        "setup_daemons.sh missing 'python3 -m search.indexer init' line"

    setup_text = (SCRIPTS / "setup.sh").read_text(encoding="utf-8")
    assert "setup_daemons.sh" in setup_text, \
        "setup.sh orchestrator must sequence setup_daemons.sh (which runs search.indexer init)"
