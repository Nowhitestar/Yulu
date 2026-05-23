"""flock-based recording-start mutex.

Both manual (`record_audio.py start`) and automated (`meeting_daemon
_start_recording`) callers acquire this lock before sending the
audio_daemon `start` action. The lock is advisory at the caller level —
the audio_daemon itself remains the authoritative "is recording"
arbiter — but it prevents the race where two callers each think they're
the one starting and both send `start` (the daemon answers "already
recording" to the second, which the caller misreads as success).

The lock file (default ``~/.config/yulu/.recording.lock``) is opened by
the calling process and held via ``fcntl.flock(LOCK_EX | LOCK_NB)`` for
the lifetime of the context manager. On process exit / crash, the OS
releases the lock automatically (no stale-cleanup needed).
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

DEFAULT_LOCK_PATH = Path.home() / ".config" / "yulu" / ".recording.lock"


@dataclass
class RecordingLockHandle:
    """Returned to the caller inside the with-block. Carries the open fd
    so subsequent metadata writes hit the same inode."""

    fd: int
    path: Path


class RecordingBusy(RuntimeError):
    """Raised when the lock is held by another process. ``info`` carries
    whatever metadata that process wrote via :func:`record` (may be empty
    if the holder hasn't called record() yet)."""

    def __init__(self, info: dict):
        super().__init__(f"recording already in progress: {info}")
        self.info = info


def read_meta(path: Path) -> dict:
    """Read the JSON metadata blob from a lock file path. Returns ``{}`` when
    the file is missing, empty, or malformed. Used by contenders to surface
    the live recording's title / path / started_at when the daemon reports
    a recording in progress (the daemon's status RPC does not carry these).
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    text = text.strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


@contextmanager
def acquire(
    *, lock_path: Optional[Path] = None, timeout: float = 0.5,
) -> Iterator[RecordingLockHandle]:
    """Acquire the recording lock with `LOCK_EX | LOCK_NB` retry.

    If contended, retry every 50ms within `timeout`, then raise
    `RecordingBusy(info)` carrying the holder's metadata.
    """
    lock_path = Path(lock_path) if lock_path else DEFAULT_LOCK_PATH
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o644)
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError as exc:
            if exc.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                os.close(fd)
                raise
            if time.monotonic() >= deadline:
                info = read_meta(lock_path)
                os.close(fd)
                raise RecordingBusy(info)
            time.sleep(0.05)

    try:
        yield RecordingLockHandle(fd=fd, path=lock_path)
    finally:
        # NOTE: do NOT truncate metadata on release. The flock is held only
        # for the duration of the daemon-start handshake (~50ms), but the
        # recording it gated continues for minutes/hours. A second `start`
        # caller acquires the flock cleanly the moment the first releases,
        # and uses the persisted metadata (title/started_at — fields the
        # daemon's status RPC does not carry) to surface a RecordingBusy
        # error. The daemon itself remains the canonical arbiter of "is
        # recording", consulted via socket_send({"action":"status"}).
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def record(
    handle: RecordingLockHandle, *, title: str, path: str, started_at: str,
) -> None:
    """Write metadata into the locked file so subsequent contenders can
    inspect who holds the lock. Idempotent — last call wins."""
    payload = json.dumps(
        {"title": title, "path": path, "started_at": started_at,
         "holder_pid": os.getpid()},
        ensure_ascii=False,
    )
    os.lseek(handle.fd, 0, os.SEEK_SET)
    os.ftruncate(handle.fd, 0)
    os.write(handle.fd, payload.encode("utf-8"))
    try:
        os.fsync(handle.fd)
    except OSError:
        pass
