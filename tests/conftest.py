import os
from pathlib import Path
import sys


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


def _default_tmp_root() -> Path:
    private_tmp = Path("/private/tmp")
    if private_tmp.exists() and os.access(private_tmp, os.W_OK):
        return private_tmp
    return Path(os.environ.get("TMPDIR") or "/tmp")


def _ensure_test_paths() -> None:
    tmp_root = _default_tmp_root()
    os.environ.setdefault("YULU_REAL_HOME", os.environ.get("HOME", ""))
    if os.environ.get("YULU_TEST_USE_REAL_HOME") != "1":
        os.environ["HOME"] = os.environ.get("YULU_TEST_HOME", str(tmp_root / "yulu-test-home"))
    os.environ["TMPDIR"] = os.environ.get("YULU_TEST_TMPDIR", str(tmp_root / "yulu-pytest-tmp"))
    os.environ["YULU_TEST_SOCKET_DIR"] = os.environ.get(
        "YULU_TEST_SOCKET_DIR", str(tmp_root / "yulu-test-sockets")
    )
    home = Path(os.environ["HOME"])
    tmpdir = Path(os.environ["TMPDIR"])
    sockdir = Path(os.environ["YULU_TEST_SOCKET_DIR"])
    for path in (home, tmpdir, sockdir):
        path.mkdir(parents=True, exist_ok=True)


def pytest_configure(config):
    _ensure_test_paths()
    config.addinivalue_line("markers", "e2e: opt-in tests that require real external runtimes")
    config.addinivalue_line("markers", "integration: tests that spawn the daemon process")
