"""Unit tests for recording_lock — flock-based mutex with metadata."""

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from recording_lock import acquire, record, RecordingBusy


def test_acquire_releases_when_context_exits(tmp_path):
    lock = tmp_path / ".recording.lock"
    with acquire(lock_path=lock, timeout=0.1) as handle:
        record(handle, title="t1", path="/tmp/x.wav", started_at="2026-05-22T12:00:00")

    # Outside the with — file may still exist but no one holds the lock.
    with acquire(lock_path=lock, timeout=0.1):
        pass


def test_acquire_busy_raises_when_held_in_another_process(tmp_path):
    lock = tmp_path / ".recording.lock"
    # Spawn a sidecar Python that holds the lock for ~2s.
    sidecar = Path(__file__).parent / "_lock_sidecar.py"
    sidecar.write_text(f"""
import sys, time
sys.path.insert(0, {str(SCRIPTS)!r})
from recording_lock import acquire, record
with acquire(lock_path={str(lock)!r}, timeout=0.1) as h:
    record(h, title='other', path='/tmp/other.wav', started_at='2026-05-22T12:00:00')
    time.sleep(2.0)
""")
    proc = subprocess.Popen([sys.executable, str(sidecar)])
    try:
        time.sleep(0.3)  # give sidecar time to acquire
        with pytest.raises(RecordingBusy) as exc_info:
            with acquire(lock_path=lock, timeout=0.5):
                pass
        info = exc_info.value.info
        assert info["title"] == "other"
        assert info["path"] == "/tmp/other.wav"
        assert info["started_at"] == "2026-05-22T12:00:00"
    finally:
        proc.terminate()
        proc.wait(timeout=3)
        sidecar.unlink(missing_ok=True)


def test_acquire_recovers_after_holder_dies(tmp_path):
    """If the holding process is killed, the next acquire succeeds quickly."""
    lock = tmp_path / ".recording.lock"
    sidecar = Path(__file__).parent / "_lock_sidecar_die.py"
    sidecar.write_text(f"""
import sys, time, os
sys.path.insert(0, {str(SCRIPTS)!r})
from recording_lock import acquire, record
with acquire(lock_path={str(lock)!r}, timeout=0.1) as h:
    record(h, title='zombie', path='/tmp/z.wav', started_at='2026-05-22T12:00:00')
    time.sleep(0.3)
    os._exit(0)  # hard exit closes fd → flock releases
""")
    proc = subprocess.Popen([sys.executable, str(sidecar)])
    try:
        time.sleep(0.1)  # sidecar holds lock
        # Acquire immediately would block; wait a bit then try
        time.sleep(0.6)  # by now sidecar exited and released
        with acquire(lock_path=lock, timeout=0.5):
            pass
    finally:
        proc.wait(timeout=3)
        sidecar.unlink(missing_ok=True)


def test_record_persists_metadata_to_lock_file(tmp_path):
    """The metadata written by record() must be readable by the next acquirer."""
    import json
    lock = tmp_path / ".recording.lock"

    with acquire(lock_path=lock, timeout=0.1) as h:
        record(h, title="my meeting", path="/tmp/a.wav",
               started_at="2026-05-22T13:00:00")
        # Read while we still hold it
        content = lock.read_text(encoding="utf-8")
        meta = json.loads(content) if content.strip() else {}
        assert meta.get("title") == "my meeting"
        assert meta.get("path") == "/tmp/a.wav"
        assert meta.get("started_at") == "2026-05-22T13:00:00"


def test_metadata_survives_release_for_contender_inspection(tmp_path):
    """Spec §9 + acceptance #6 require that a second `start` while a recording
    is in flight surfaces the live recording's title/path/started_at. The
    daemon's `status` RPC does NOT carry title/started_at — the lock file is
    the only source. Therefore the metadata MUST persist across the holder's
    context exit so the next acquirer can read it.
    """
    import json
    lock = tmp_path / ".recording.lock"
    with acquire(lock_path=lock, timeout=0.1) as h:
        record(h, title="LivePrimary", path="/tmp/primary.wav",
               started_at="2026-05-22T10:00:00")

    # Holder released the lock cleanly. The contents must still be there for
    # the next caller to inspect.
    content = lock.read_text(encoding="utf-8")
    assert content.strip(), "lock file metadata must survive release"
    meta = json.loads(content)
    assert meta["title"] == "LivePrimary"
    assert meta["path"] == "/tmp/primary.wav"
    assert meta["started_at"] == "2026-05-22T10:00:00"


def test_daemon_start_raises_busy_when_daemon_already_recording(monkeypatch, tmp_path):
    """Regression: smoke showed a second `record_audio.py start` 2s after the
    first one succeeds silently (the daemon happily re-`start`s while still
    recording). The flock alone cannot prevent this because the first holder
    releases the lock as soon as the start RPC returns (~50ms), leaving a
    ~30min window where the lock is unheld but the daemon is recording.

    Per spec §9, the audio_daemon is the canonical "is recording" arbiter.
    `daemon_start` must query daemon status before sending `start`; if the
    daemon reports recording, raise `RecordingBusy` carrying the live
    recording's title/path/started_at from the lock file.
    """
    import importlib
    sys.path.insert(0, str(SCRIPTS))
    import record_audio
    importlib.reload(record_audio)  # ensure fresh module each test

    lock = tmp_path / ".recording.lock"
    # Simulate the prior holder: seed metadata, then release.
    with acquire(lock_path=lock, timeout=0.1) as h:
        record(h, title="PrimaryMeeting", path="/tmp/primary.wav",
               started_at="2026-05-22T10:00:00")

    # Mock socket_send: status → recording=True; start → must never be called.
    calls = []

    def fake_socket_send(cmd):
        calls.append(cmd)
        action = cmd.get("action")
        if action == "status":
            return {"recording": True, "file": "/tmp/primary.wav",
                    "sysReady": True, "micReady": True}
        if action == "start":
            return {"status": "recording", "file": "/tmp/should_not_run.wav"}
        return None

    monkeypatch.setattr(record_audio, "socket_send", fake_socket_send)
    # Pin realtime side effect so the test is hermetic even if we fail to
    # short-circuit (test will then fail on the assertion below, not crash).
    monkeypatch.setattr(record_audio, "start_realtime_transcriber",
                        lambda *a, **k: None)

    with acquire(lock_path=lock, timeout=0.1) as lock_handle:
        with pytest.raises(RecordingBusy) as exc_info:
            record_audio.daemon_start("ConcurrentMeeting", lock_handle=lock_handle)

    info = exc_info.value.info
    assert info.get("title") == "PrimaryMeeting", info
    assert info.get("path") == "/tmp/primary.wav", info
    assert info.get("started_at") == "2026-05-22T10:00:00", info
    assert not any(c.get("action") == "start" for c in calls), (
        f"daemon_start must not send `start` when daemon already recording; "
        f"calls={calls}"
    )


def test_daemon_start_proceeds_when_daemon_idle(monkeypatch, tmp_path):
    """Negative case: when daemon status reports not-recording, daemon_start
    should proceed normally — send `start`, persist new metadata, return True.
    """
    import importlib
    sys.path.insert(0, str(SCRIPTS))
    import record_audio
    importlib.reload(record_audio)

    lock = tmp_path / ".recording.lock"

    def fake_socket_send(cmd):
        action = cmd.get("action")
        if action == "status":
            return {"recording": False, "file": "", "sysReady": True, "micReady": True}
        if action == "start":
            return {"status": "recording", "file": "/tmp/new.wav"}
        return None

    monkeypatch.setattr(record_audio, "socket_send", fake_socket_send)
    monkeypatch.setattr(record_audio, "start_realtime_transcriber",
                        lambda *a, **k: None)

    with acquire(lock_path=lock, timeout=0.1) as lock_handle:
        ok = record_audio.daemon_start("FreshMeeting", lock_handle=lock_handle)

    assert ok is True
    # Metadata for the new recording got written.
    import json
    meta = json.loads(lock.read_text(encoding="utf-8"))
    assert meta["title"] == "FreshMeeting"
    assert meta["path"] == "/tmp/new.wav"
