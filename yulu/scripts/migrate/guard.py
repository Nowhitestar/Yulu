"""Migration recording-guard (MIG-02, D-02) — THE data-loss prevention.

Before stopping ANY daemon, migration must ask the audio_daemon whether a
recording is in flight. Stopping the audio daemon mid-recording truncates /
corrupts the WAV being written (CONCERNS §2d). This module makes that
impossible by deferring to the daemon's own "is recording" flag — exactly as
``record_audio._raise_if_daemon_recording`` does (record_audio.py:230) — and
REFUSING (raising :class:`RecordingActive`) rather than forcing a stop.

The recording-active arbiter is the audio_daemon status socket, never a guessed
PID and never the start-handshake advisory lock. ``recording_lock`` holds its
advisory lock for only the ~50ms daemon-start handshake while the recording it
gated runs for minutes/hours (recording_lock.py:100-108), so that lock is NOT a
recording sentinel — its metadata only ENRICHES the refusal message (who/what
is recording). The live socket is the sole authority (T-07-07).

When no recording is active, daemons are clean-stopped through the Phase 2
:class:`~yulu_platform.macos.daemon_manager.MacOSDaemonManager` — a list-form
``launchctl unload`` (no shell, no PID math). There is NO forced-kill path
anywhere in this module: the Phase 2 ``open -W`` → direct-launch fix (D-06)
removed the orphan that historically forced an escalation, so ``launchctl
unload`` stops the job cleanly on its own (T-07-05). A static source grep in the
test suite asserts zero forced-kill occurrences.

stdlib only. Every cross-module import (``record_audio``, ``recording_lock``,
``MacOSDaemonManager``) is lazy + guarded so this module imports cleanly
off-Darwin and degrades rather than crashing migration.
"""

from __future__ import annotations

from typing import Callable, List, Optional

# The eight launchd jobs migration stops (ls yulu/scripts/com.yulu.*.plist).
# ``com.yulu.audiodaemon`` is FIRST and is the recording-critical one the guard
# protects — truncating its WAV is the data-loss this whole module prevents.
DEFAULT_LABELS: List[str] = [
    "com.yulu.audiodaemon",
    "com.yulu.sttdaemon",
    "com.yulu.agentqueue",
    "com.yulu.detector",
    "com.yulu.scheduler",
    "com.yulu.calendar",
    "com.yulu.statusagent",
    "com.yulu.ui",
]


class RecordingActive(RuntimeError):
    """Raised by :func:`stop_daemons_guarded` when the audio_daemon reports a
    live recording. ``info`` carries the recording metadata
    (``title``/``path``/``started_at``) read from the lock file so the refusal
    names what is recording — the refusal is data-loss prevention, not a
    failure: migration must retry after the user stops the recording."""

    def __init__(self, info: dict):
        title = info.get("title") if isinstance(info, dict) else None
        path = info.get("path") if isinstance(info, dict) else None
        detail = ""
        if title or path:
            detail = f" ({title or '<unknown>'} → {path or '<unknown>'})"
        super().__init__(
            "refusing to stop daemons: a recording is in progress"
            f"{detail}; stopping the audio daemon now would truncate the "
            "in-flight capture. Stop the recording, then retry migration."
        )
        self.info = info if isinstance(info, dict) else {}


def recording_active(socket_send: Optional[Callable[[dict], Optional[dict]]] = None) -> bool:
    """Return ``True`` iff the audio_daemon reports a recording in progress.

    The audio_daemon status socket is the canonical "is recording" arbiter.
    This mirrors ``record_audio._raise_if_daemon_recording`` byte-for-byte:
    ``status and status.get("recording") is True``. A ``None`` status (socket
    absent / daemon down) or a status dict missing the ``recording`` key
    degrades to ``False`` — a down daemon is, correctly, not recording, and the
    guard never blocks on an absent socket (T-07-06).

    ``socket_send`` is injectable for testing; when ``None`` it lazily and
    guardedly imports ``record_audio.socket_send`` (which carries a 5s socket
    timeout and returns ``None`` on any error). Any failure — an import error or
    a raising send — degrades to ``False`` so the probe never crashes
    migration.
    """
    if socket_send is None:
        try:
            from record_audio import socket_send as _send  # lazy + guarded
        except Exception:
            return False
        socket_send = _send

    try:
        status = socket_send({"action": "status"})
    except Exception:
        return False
    return bool(status and status.get("recording") is True)


def stop_daemons_guarded(
    labels: Optional[List[str]] = None,
    manager: Optional[object] = None,
    socket_send: Optional[Callable[[dict], Optional[dict]]] = None,
    lock_path: Optional[object] = None,
) -> None:
    """Stop the migration daemons — but ONLY when no recording is active.

    Checks :func:`recording_active` FIRST. If a recording is in progress, reads
    the live recording metadata from ``.recording.lock`` (to name what is
    recording) and raises :class:`RecordingActive` — ``manager.unload`` is never
    reached, so zero daemons are stopped and the in-flight WAV is not truncated
    (T-07-04, the headline MIG-02 control).

    Only when not recording does it clean-stop each label via
    ``manager.unload(label)`` (``MacOSDaemonManager.unload`` = ``launchctl
    unload``). ``manager`` defaults to a freshly-instantiated
    :class:`MacOSDaemonManager` (lazy + guarded import; Darwin-gated). NEVER
    escalates to a forced kill — the Phase 2 direct-launch fix (D-06) made
    ``launchctl unload`` clean, so no signal escalation is needed.

    ``labels`` defaults to :data:`DEFAULT_LABELS` (the eight ``com.yulu.*``
    jobs, audiodaemon first). ``socket_send`` / ``lock_path`` are injectable for
    testing.
    """
    if labels is None:
        labels = DEFAULT_LABELS

    if recording_active(socket_send):
        info = {}
        try:
            from recording_lock import read_meta, DEFAULT_LOCK_PATH  # lazy + guarded

            info = read_meta(lock_path if lock_path is not None else DEFAULT_LOCK_PATH)
        except Exception:
            info = {}
        raise RecordingActive(info)

    if manager is None:
        # Lazy + guarded so the module imports off-Darwin; only the clean-stop
        # path needs the macOS manager. Instantiate directly (the proven idiom)
        # — there is no get_platform() accessor (state.py references one only
        # inside a degrading try/except; it is not defined in yulu_platform).
        from yulu_platform.macos.daemon_manager import MacOSDaemonManager

        manager = MacOSDaemonManager()

    for label in labels:
        manager.unload(label)
