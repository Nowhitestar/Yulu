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
