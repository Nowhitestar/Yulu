"""MIG-02 / D-02 — the migration recording-guard.

``migrate/guard.py`` is THE data-loss prevention for Phase 7: before stopping
ANY daemon, it asks the audio_daemon status socket whether a recording is
active (the canonical arbiter, exactly as ``record_audio._raise_if_daemon_recording``)
and REFUSES to stop while active — raising ``RecordingActive`` rather than
truncating an in-flight WAV (CONCERNS §2d). When no recording is active it
clean-stops daemons through the Phase 2 ``MacOSDaemonManager.unload``
(``launchctl unload``), with NO ``pkill -9`` anywhere (D-06 removed the orphan
that historically forced ``pkill``).

These tests prove (Task 1 — recording_active probe):
  (1) injected status ``{"recording": True}``  → recording_active is True;
  (2) injected status ``{"recording": False}`` → recording_active is False;
  (3) injected status ``None`` (socket absent / daemon down) → False
      (a down daemon is, correctly, not recording);
  (4) the predicate mirrors the arbiter exactly — a status dict MISSING the
      ``recording`` key → False (no KeyError);
  (5) a guarded-import failure of ``record_audio.socket_send`` degrades to
      "not recording" (the probe never crashes migration);
  (6) guard.py imports NO ``fcntl``/``flock`` — the daemon socket, not the
      lock, is the arbiter.

These tests prove (Task 2 — stop_daemons_guarded):
  (7) recording active → ``RecordingActive`` raised AND manager.unload is NEVER
      called (call count 0) — the in-flight capture is not truncated (T-07-04);
  (8) the raised ``RecordingActive.info`` carries the live recording metadata
      (title/path) read from a fixture ``.recording.lock`` so the refusal names
      what is recording;
  (9) recording NOT active → manager.unload(label) is called once per label, in
      the given order; nothing is raised;
  (10) default labels (when labels=None) are the eight ``com.yulu.*`` jobs,
       audiodaemon first (the recording-critical one);
  (11) static MIG-02 control — a source grep over guard.py finds ZERO
       non-comment occurrences of ``pkill`` (T-07-05).

Import style mirrors the repo (test_migrate_detect.py): yulu/scripts is placed
on sys.path so ``import migrate.guard`` works whether pytest runs from the repo
root (``pytest tests``) or from yulu/scripts.
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from migrate import guard as guard_mod  # noqa: E402

GUARD_SRC = SCRIPTS / "migrate" / "guard.py"


# ── injectable fakes ─────────────────────────────────────────────────────────


def _send_returning(payload):
    """Build a fake socket_send that asserts the canonical status action and
    returns the given payload (or None)."""

    def _send(cmd):
        assert cmd == {"action": "status"}
        return payload

    return _send


class _RecordingManager:
    """A fake DaemonManager recording the order/count of unload() calls."""

    def __init__(self):
        self.unloaded: list[str] = []

    def unload(self, name: str) -> None:
        self.unloaded.append(name)


# ── Task 1 — recording_active probe ──────────────────────────────────────────


def test_recording_active_true_when_daemon_reports_recording():
    """(1) injected status recording=True → True (the arbiter is recording)."""
    assert guard_mod.recording_active(_send_returning({"recording": True})) is True


def test_recording_active_false_when_daemon_reports_not_recording():
    """(2) injected status recording=False → False."""
    assert guard_mod.recording_active(_send_returning({"recording": False})) is False


def test_recording_active_false_when_socket_absent():
    """(3) injected status None (socket down) → False — a down daemon is not
    recording; the guard must not block on an absent socket (T-07-06)."""
    assert guard_mod.recording_active(_send_returning(None)) is False


def test_recording_active_false_on_missing_recording_key():
    """(4) status dict without a ``recording`` key → False, no KeyError —
    byte-for-byte the _raise_if_daemon_recording predicate
    (status and status.get("recording") is True)."""
    assert guard_mod.recording_active(_send_returning({"file": "x.wav"})) is False


def test_recording_active_degrades_when_socket_send_unavailable():
    """(5) a socket_send that raises (stand-in for a guarded-import failure)
    degrades to "not recording" — the probe never crashes migration."""

    def _boom(cmd):
        raise OSError("socket gone")

    assert guard_mod.recording_active(_boom) is False


def test_guard_does_not_import_fcntl_or_flock():
    """(6) the daemon socket — not the start-handshake flock — is the arbiter,
    so guard.py must not import fcntl / flock (acceptance: no flock misuse)."""
    src = GUARD_SRC.read_text(encoding="utf-8")
    assert "import fcntl" not in src
    assert "flock" not in src


# ── Task 2 — stop_daemons_guarded ────────────────────────────────────────────


def test_stop_refuses_and_never_unloads_while_recording():
    """(7) HEADLINE MIG-02 control (T-07-04): recording active → RecordingActive
    raised AND manager.unload NEVER called (count 0) — no daemon stopped, the
    in-flight WAV is not truncated."""
    manager = _RecordingManager()
    with pytest.raises(guard_mod.RecordingActive):
        guard_mod.stop_daemons_guarded(
            labels=["com.yulu.audiodaemon", "com.yulu.sttdaemon"],
            manager=manager,
            socket_send=_send_returning({"recording": True}),
        )
    assert manager.unloaded == []  # zero daemon stops while recording


def test_recording_active_error_carries_live_metadata(tmp_path):
    """(8) the refusal names what is recording: RecordingActive.info carries the
    title/path read from a fixture .recording.lock."""
    lock = tmp_path / ".recording.lock"
    lock.write_text(
        '{"title": "Q3 Planning", "path": "/Movies/Yulu/q3.wav", '
        '"started_at": "2026-05-30T10:00:00", "holder_pid": 4242}',
        encoding="utf-8",
    )
    manager = _RecordingManager()
    with pytest.raises(guard_mod.RecordingActive) as excinfo:
        guard_mod.stop_daemons_guarded(
            labels=["com.yulu.audiodaemon"],
            manager=manager,
            socket_send=_send_returning({"recording": True}),
            lock_path=lock,
        )
    info = excinfo.value.info
    assert info.get("title") == "Q3 Planning"
    assert info.get("path") == "/Movies/Yulu/q3.wav"
    assert manager.unloaded == []


def test_stop_unloads_each_label_in_order_when_idle():
    """(9) recording NOT active → manager.unload(label) once per label, in the
    given order; nothing raised."""
    manager = _RecordingManager()
    labels = ["com.yulu.audiodaemon", "com.yulu.sttdaemon", "com.yulu.ui"]
    guard_mod.stop_daemons_guarded(
        labels=labels,
        manager=manager,
        socket_send=_send_returning({"recording": False}),
    )
    assert manager.unloaded == labels


def test_default_labels_cover_eight_jobs_audiodaemon_first():
    """(10) labels=None → the eight com.yulu.* jobs, audiodaemon first (the
    recording-critical daemon the guard protects)."""
    manager = _RecordingManager()
    guard_mod.stop_daemons_guarded(
        labels=None,
        manager=manager,
        socket_send=_send_returning({"recording": False}),
    )
    expected = {
        "com.yulu.audiodaemon",
        "com.yulu.sttdaemon",
        "com.yulu.agentqueue",
        "com.yulu.detector",
        "com.yulu.scheduler",
        "com.yulu.calendar",
        "com.yulu.statusagent",
        "com.yulu.ui",
    }
    assert set(manager.unloaded) == expected
    assert len(manager.unloaded) == 8
    assert manager.unloaded[0] == "com.yulu.audiodaemon"


def test_no_pkill_anywhere_in_guard_source():
    """(11) static MIG-02 control (T-07-05): ZERO non-comment ``pkill`` in
    guard.py — clean launchctl unload only, no forced-kill truncation vector."""
    non_comment = [
        line
        for line in GUARD_SRC.read_text(encoding="utf-8").splitlines()
        if not line.lstrip().startswith("#")
    ]
    assert sum(line.count("pkill") for line in non_comment) == 0
