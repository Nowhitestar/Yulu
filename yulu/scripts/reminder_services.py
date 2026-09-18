#!/usr/bin/env python3
"""App-owned reminder services. No LaunchAgents or private provider credentials.

The visible App starts this supervisor after migration, and stops it before an
update. Each service and its dialogs share a process group, so quiescing cannot
leave a delayed recording prompt behind. A parent watchdog also covers crashes.
"""

import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

from application_paths import CONFIG_PATH, IPC_DIR, LOGS_DIR

SERVICES = {
    "com.yulu.scheduler": ("scheduler_daemon.py", [], "scheduler.log"),
    "com.yulu.calendar": ("run_calendar_services.py", [], "calendar_services.log"),
    "com.yulu.detector": ("meeting_detector.py", ["daemon"], "detector.log"),
}
SCRIPT_DIR = Path(__file__).resolve().parent


class ReminderServices:
    def __init__(self, script_dir=SCRIPT_DIR, config_path=CONFIG_PATH, logs_dir=LOGS_DIR):
        self.script_dir = Path(script_dir)
        self.config_path = Path(config_path)
        self.logs_dir = Path(logs_dir)
        self.children = {}
        self.enabled = {}
        self.stopped = set()
        self.exits = {}
        self.retry_at = {}
        self.closed = False

    def reconcile(self):
        if self.closed:
            return
        try:
            config = json.loads(self.config_path.read_text())
            self.enabled = {
                "com.yulu.scheduler": True,
                "com.yulu.calendar": any(c.get("enabled", False) for c in config.get("calendars", [])),
                "com.yulu.detector": config.get("meeting_detection", {}).get("enabled", True),
            }
        except (OSError, ValueError, TypeError, AttributeError):
            # A malformed/unavailable config must not enable capture prompts.
            self.enabled = {name: False for name in SERVICES}
        for name in SERVICES:
            child = self.children.get(name)
            if child is not None and child.poll() is not None:
                self.exits[name] = child.returncode
                self._stop(name)
                self.retry_at[name] = time.monotonic() + 5
            if not self.enabled[name] or name in self.stopped:
                self._stop(name)
            elif name not in self.children and time.monotonic() >= self.retry_at.get(name, 0):
                self._start(name)

    def _start(self, name):
        script, arguments, filename = SERVICES[name]
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        environment = dict(os.environ, YULU_MANAGED_REMINDERS="1", PYTHONDONTWRITEBYTECODE="1")
        try:
            fd = os.open(self.logs_dir / filename, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, "ab") as log:
                child = subprocess.Popen(
                    [sys.executable, str(self.script_dir / script), *arguments],
                    cwd=self.script_dir, env=environment, stdin=subprocess.DEVNULL,
                    stdout=log, stderr=log, start_new_session=True,
                )
            self.children[name] = child
            self.exits[name] = 0
        except OSError:
            self.exits[name] = 1
            self.retry_at[name] = time.monotonic() + 5

    def _stop(self, name):
        child = self.children.pop(name, None)
        if child is None:
            return
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        # Also reap helpers that outlive the scheduler/detector parent.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=1)

    def command(self, request):
        name, action = request.get("label"), request.get("action")
        if name not in SERVICES or action not in {"status", "start", "stop", "restart", "sighup"}:
            return {"ok": False, "error": "invalid_command"}
        if action == "stop":
            self.stopped.add(name)
            self._stop(name)
        elif action in {"start", "restart"}:
            self.stopped.discard(name)
            if action == "restart":
                self._stop(name)
            self.retry_at.pop(name, None)
        elif action == "sighup":
            child = self.children.get(name)
            if child is None or child.poll() is not None:
                return {"ok": False, "error": "service_not_running"}
            # Only the scheduler consumes HUP. Calendar/detector refresh by restart.
            if name == "com.yulu.scheduler":
                child.send_signal(signal.SIGHUP)
            else:
                self._stop(name)
                self.retry_at.pop(name, None)
        self.reconcile()
        child = self.children.get(name)
        return {
            "ok": True, "label": name, "enabled": self.enabled.get(name, False),
            "pid": child.pid if child and child.poll() is None else 0,
            "exitStatus": self.exits.get(name, 0),
        }

    def close(self):
        self.closed = True
        for name in list(self.children):
            self._stop(name)


def main():
    IPC_DIR.mkdir(parents=True, exist_ok=True)
    lock = open(IPC_DIR / "reminder_services.lock", "a")
    os.chmod(lock.name, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    path = IPC_DIR / "reminder_services.sock"
    path.unlink(missing_ok=True)
    parent = os.getppid()
    services = ReminderServices()
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(path))
            os.chmod(path, 0o600)
            server.listen(8)
            server.settimeout(1)
            while not stopping and os.getppid() == parent:
                services.reconcile()
                try:
                    client, _ = server.accept()
                except socket.timeout:
                    continue
                with client:
                    client.settimeout(1)
                    try:
                        data = bytearray()
                        while len(data) <= 4096:
                            chunk = client.recv(1024)
                            if not chunk:
                                break
                            data.extend(chunk)
                            if b"\n" in chunk:
                                break
                        request = json.loads(data) if len(data) <= 4096 else None
                        response = services.command(request) if isinstance(request, dict) else {"ok": False}
                        client.sendall(json.dumps(response).encode() + b"\n")
                    except (OSError, ValueError):
                        pass
    finally:
        services.close()
        path.unlink(missing_ok=True)
        lock.close()


if __name__ == "__main__":
    main()
