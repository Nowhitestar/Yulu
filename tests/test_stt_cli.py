import asyncio
import json
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from vocab import VocabRepo, Scope, open_db
from stt_daemon.app import STTDaemonApp
from stt_daemon.config import DaemonConfig
from stt_daemon.runtime import MockSTTBackend
from stt_cli import main as stt_main


def _spawn(tmp_path):
    """Build an app with a macOS-safe short socket path.

    Returns (app, stop_fn) where stop_fn() shuts down the daemon thread.
    The daemon runs in a background thread with its own event loop so that
    stt_main() (a sync function) can communicate with it without deadlocking.
    """
    db = tmp_path / "vocab.sqlite"
    VocabRepo(open_db(db))
    sock_dir = Path(tempfile.mkdtemp(dir="/tmp"))
    cfg = DaemonConfig(
        socket_path=sock_dir / "stt.sock",
        vocab_db_path=db,
        pid_file=tmp_path / "stt.pid",
        log_path=None,
        sessions_dir=tmp_path / "sessions",
    )
    backends = {"mlx": MockSTTBackend(canned_text="ok")}
    app = STTDaemonApp(cfg, backends=backends)

    loop = asyncio.new_event_loop()
    started = threading.Event()
    stopped = threading.Event()

    def _run():
        asyncio.set_event_loop(loop)

        async def _main():
            await app.start()
            started.set()
            # Run until stop() is called
            while not stopped.is_set():
                await asyncio.sleep(0.05)
            await app.stop()

        loop.run_until_complete(_main())
        loop.close()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    started.wait(timeout=5.0)

    def stop():
        stopped.set()
        t.join(timeout=5.0)

    return app, stop


def test_status_reports_running_daemon(tmp_path, capsys):
    app, stop = _spawn(tmp_path)
    try:
        code = stt_main([
            "status",
            "--socket", str(app.config.socket_path),
            "--json",
        ])
        out = capsys.readouterr().out
    finally:
        stop()
    assert code == 0
    payload = json.loads(out)
    assert payload["ready"] is True


def test_status_when_daemon_down(tmp_path, capsys):
    code = stt_main([
        "status",
        "--socket", str(tmp_path / "nope.sock"),
        "--json",
    ])
    out = capsys.readouterr().out
    assert code != 0
    payload = json.loads(out)
    assert payload["ready"] is False


def test_warm_up_returns_ok(tmp_path, capsys):
    app, stop = _spawn(tmp_path)
    try:
        code = stt_main([
            "warm-up",
            "--engine", "mlx",
            "--socket", str(app.config.socket_path),
        ])
        out = capsys.readouterr().out
    finally:
        stop()
    assert code == 0
    assert "warmed" in out.lower() or "ok" in out.lower()
