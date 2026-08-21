"""Regression test for audio_daemon Unix-socket starvation under sustained polling.

Background
----------
The original SocketServer ran ``handle()`` synchronously on the accept
thread. Any slow handler — a misbehaving client that never closed its
write side, a scanWindows call that took a while, the ScreenCaptureKit
init path — froze the accept loop for the duration of that handler.
While the loop was frozen, the kernel queued incoming connects against
the listen backlog (5 slots). Sustained polling from status_agent
(1Hz) plus the recording controller (during recordings) plus the
occasional shell ping was enough to overrun the backlog within seconds, after which new
clients got ECONNREFUSED and the system surfaced ``daemonDown``.

The fix reads requests off the accept thread, routes control actions
through a serial IPC queue, and isolates ``windows`` scans on a separate
queue. Combined with the larger backlog (64) and per-fd SO_RCVTIMEO
(5s), a stuck client now degrades its own request instead of taking the
whole daemon offline.

These tests codify two regressions:

1. ``test_burst_polls_do_not_starve_socket`` — 50 SHUT_WR requests in
   a tight loop must finish well inside a 5s budget. This is the
   smoke-test version of the bug: it catches a daemon that pegs at the
   pre-fix per-request timeout.

2. ``test_slow_client_does_not_refuse_others`` — the meatier claim. One
   client connects and deliberately holds the socket open without
   sending anything (the server's ``read()`` will block until
   SO_RCVTIMEO=5s). In parallel, 30 normal SHUT_WR clients must still
   *connect and eventually receive responses* — none may be refused or
   dropped by the kernel. The pre-fix daemon would refuse parallel
   clients once the 5-slot listen backlog overflowed; the fixed daemon
   queues them in the IPC serial queue (so they wait behind the stuck
   handler) but never refuses. Latency degrades gracefully; capacity
   does not collapse.

Marked ``integration`` because they require a running audio_daemon
(they talk to the live socket at ``~/.config/yulu/audio_daemon.sock``).
Skipped automatically when no daemon is up — CI does not start one.
"""

from __future__ import annotations

import json
import socket
import threading
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration

SOCKET_PATH = Path.home() / ".config" / "yulu" / "audio_daemon.sock"
DAEMON_SOURCE = (
    Path(__file__).resolve().parents[1] / "yulu" / "scripts" / "audio_daemon.swift"
)


def _swift_function(source: str, signature: str) -> str:
    start = source.index(signature)
    next_func = source.find("\n    private func ", start + len(signature))
    if next_func == -1:
        return source[start:]
    return source[start:next_func]


def test_windows_scan_isolated_from_control_ipc_queue():
    """Accessibility window scans must not block status/stop IPC."""
    source = DAEMON_SOURCE.read_text()

    assert 'DispatchQueue(label: "yulu.audio-daemon.ipc.read", attributes: .concurrent)' in source
    assert 'DispatchQueue(label: "yulu.audio-daemon.ipc.control")' in source
    assert 'DispatchQueue(label: "yulu.audio-daemon.window-scan")' in source
    assert 'if request.action == "windows"' in source
    assert "handleWindows(c)" in source

    handle_parsed = _swift_function(source, "private func handleParsed")
    assert 'case "windows"' not in handle_parsed
    assert "scanWindows()" not in handle_parsed


def test_window_scan_requests_fail_fast_when_previous_scan_is_stuck():
    """Repeated detector polls must not queue unbounded sockets."""
    source = DAEMON_SOURCE.read_text()
    handle_windows = _swift_function(source, "private func handleWindows")

    assert "windowScanInFlight" in handle_windows
    assert '"window_scan_busy"' in handle_windows
    assert "windowScanQueue.async" in handle_windows


def test_second_daemon_cannot_replace_live_socket_owner():
    """A second app instance must leave the active daemon's socket intact."""
    source = DAEMON_SOURCE.read_text()
    socket_server = source[source.index("class SocketServer") : source.index("// ─── App Delegate")]
    start = _swift_function(socket_server, "func start() -> Bool")
    stop = _swift_function(socket_server, "func stop()")

    lock_helper = source[source.index("func acquireExclusiveFileLock") : source.index("class SocketServer")]
    assert "flock(fd, LOCK_EX | LOCK_NB)" in lock_helper
    assert start.index("acquireExclusiveFileLock(at: SOCKET_LOCK_PATH)") < start.index(
        "unixSocketIsReachable(at: SOCKET_PATH)"
    )
    assert "singletonLockFD = lockFD" in start
    assert "unixSocketIsReachable(at: SOCKET_PATH)" in start
    assert "return false" in start
    assert "ownsSocketPath = true" in start
    assert "if ownsSocketPath" in stop
    assert "removeItem(at: SOCKET_PATH)" in stop
    assert "close(singletonLockFD)" in stop
    assert stop.index("removeItem(at: SOCKET_PATH)") < stop.index("close(singletonLockFD)")

    termination = source[source.index("func applicationWillTerminate") :]
    termination = termination[: termination.index("\n    }")]
    assert "removeItem(at: SOCKET_PATH)" not in termination

    launch = source[source.index("func applicationDidFinishLaunching") : source.index("func applicationWillTerminate")]
    assert launch.index("guard ss.start()") < launch.index("write(to: PID_PATH")


def _daemon_alive() -> bool:
    """Probe — connect and send a status request the standard way."""
    if not SOCKET_PATH.exists():
        return False
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(2.0)
            s.connect(str(SOCKET_PATH))
            s.sendall(b'{"action":"status"}')
            s.shutdown(socket.SHUT_WR)
            data = s.recv(4096)
            return bool(data and json.loads(data.decode()))
    except Exception:
        return False


def _shutwr_status(timeout: float = 1.0) -> tuple[bool, float]:
    """One SHUT_WR-framed status request. Returns (ok, elapsed_seconds).

    ok is True iff the daemon replied with a parseable JSON object
    containing ``recording``. This is the canonical framing used by
    every in-tree client (record_audio.py, meeting_daemon.py,
    status_agent.swift since #20).
    """
    start = time.monotonic()
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(str(SOCKET_PATH))
            s.sendall(b'{"action":"status"}')
            s.shutdown(socket.SHUT_WR)
            data = s.recv(8192)
        elapsed = time.monotonic() - start
        if not data:
            return False, elapsed
        payload = json.loads(data.decode())
        return ("recording" in payload), elapsed
    except Exception:
        return False, time.monotonic() - start


def test_burst_polls_do_not_starve_socket():
    """50 SHUT_WR status requests in a tight loop must finish inside 5s.

    With the original synchronous accept loop, each request could be
    serialized behind the previous one's full handle() runtime. Under
    sustained polling this manifests as a per-request stall of seconds.
    With the fix, the whole batch completes in milliseconds.
    """
    if not _daemon_alive():
        pytest.skip("audio_daemon not running on ~/.config/yulu/audio_daemon.sock")

    num_requests = 50
    total_budget = 5.0

    failures: list[tuple[int, float]] = []
    slowest = 0.0
    batch_start = time.monotonic()

    for i in range(num_requests):
        ok, elapsed = _shutwr_status()
        slowest = max(slowest, elapsed)
        if not ok:
            failures.append((i, elapsed))

    total = time.monotonic() - batch_start

    assert not failures, (
        f"{len(failures)}/{num_requests} status polls failed. "
        f"First few: {failures[:5]}. "
        f"slowest_ok={slowest:.3f}s total={total:.2f}s"
    )
    assert total < total_budget, (
        f"{num_requests} status polls took {total:.2f}s "
        f"(budget {total_budget}s); slowest single call was "
        f"{slowest:.3f}s. Indicates the accept loop is stalling per request."
    )


def test_slow_client_does_not_refuse_others():
    """One stuck client must not cause the kernel to refuse new connects.

    A connection that holds the socket open without sending anything
    will park the server's read() until SO_RCVTIMEO (5s) fires. The
    pre-fix daemon ran handle() on the accept thread, so this single
    stuck client would freeze accept for 5s. New connects would queue
    in the listen backlog (5 slots) and overflow to ECONNREFUSED.

    With the fix, accept returns as soon as prepareClient() is done;
    handle() runs on a serial IPC queue. The stuck handler ties up
    that one queue slot for 5s, but the accept loop keeps the kernel
    backlog drained — so parallel clients all connect successfully,
    queue behind the stuck handler, and ultimately get a response.

    The contract this test asserts is "capacity, not latency": every
    parallel client must connect and receive a valid response within a
    generous budget. The latency itself is allowed to degrade up to
    SO_RCVTIMEO. What's forbidden is connection refusal or no response
    at all, which is what the pre-fix daemon produced.
    """
    if not _daemon_alive():
        pytest.skip("audio_daemon not running on ~/.config/yulu/audio_daemon.sock")

    parallel_count = 30
    stuck_lifetime = 5.0  # let SO_RCVTIMEO close it for us
    # Generous budget: stuck handler holds the queue for ~5s, then 30
    # parallel handles drain serially. Each status handler is sub-ms,
    # so the realistic ceiling is ~5.5s. 10s is comfortable headroom.
    budget_seconds = 10.0
    per_client_timeout = budget_seconds  # don't time out before the queue drains

    # Open the stuck connection on its own thread so we don't have to
    # juggle a half-open socket here. It just connects and sleeps — the
    # server's read() will be parked on it for the full SO_RCVTIMEO window.
    stuck_ready = threading.Event()
    stuck_done = threading.Event()

    def hold_stuck_connection():
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                s.settimeout(stuck_lifetime + 2.0)
                s.connect(str(SOCKET_PATH))
                # Intentionally do NOT send anything. The server will
                # sit in read() until its own SO_RCVTIMEO expires.
                stuck_ready.set()
                time.sleep(stuck_lifetime)
        finally:
            stuck_done.set()

    stuck = threading.Thread(target=hold_stuck_connection, daemon=True)
    stuck.start()
    assert stuck_ready.wait(2.0), "stuck client never connected"

    # Now hammer with parallel SHUT_WR clients. With the fix every one
    # should return quickly; without it most would refuse or time out.
    results: list[tuple[int, bool, float]] = []
    results_lock = threading.Lock()

    def parallel_client(idx: int):
        ok, elapsed = _shutwr_status(timeout=per_client_timeout)
        with results_lock:
            results.append((idx, ok, elapsed))

    threads = [
        threading.Thread(target=parallel_client, args=(i,))
        for i in range(parallel_count)
    ]
    batch_start = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=budget_seconds + 1.0)
    batch_elapsed = time.monotonic() - batch_start

    # Cleanup — let stuck connection finish on its own SO_RCVTIMEO.
    stuck.join(timeout=stuck_lifetime + 3.0)

    failures = [r for r in results if not r[1]]
    slowest_ok = max((r[2] for r in results if r[1]), default=0.0)
    assert len(results) == parallel_count, (
        f"only {len(results)}/{parallel_count} parallel clients reported "
        "back — some threads hung"
    )
    assert not failures, (
        f"{len(failures)}/{parallel_count} parallel clients were refused "
        f"or got no response while a stuck client held one handler slot. "
        f"First few: {failures[:5]}. "
        f"batch_elapsed={batch_elapsed:.2f}s slowest_ok={slowest_ok:.3f}s. "
        "This is the symptom the chip claims to fix — pre-fix daemon would "
        "ECONNREFUSED once the 5-slot backlog overflowed."
    )
    # Latency contract: the stuck handler holds the serial queue for ~5s,
    # so we expect roughly that. Anything dramatically higher means the
    # queue isn't draining at all (or the stuck handler isn't releasing).
    assert batch_elapsed < budget_seconds, (
        f"{parallel_count} parallel SHUT_WR clients took {batch_elapsed:.2f}s "
        f"(budget {budget_seconds}s) while one stuck client occupied the IPC "
        "queue. Indicates the queue isn't draining after the stuck handler "
        "releases."
    )
