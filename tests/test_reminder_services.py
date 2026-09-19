"""Exercise reminder ownership using real, isolated child processes."""
import json
import os
from pathlib import Path
import signal
import time
from datetime import datetime, timedelta

import pytest

from reminder_services import ReminderServices, SERVICES, SCRIPT_DIR


@pytest.fixture
def manager(tmp_path):
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"calendars": [{"enabled": True}], "meeting_detection": {"enabled": True}}))
    for script, _, _ in SERVICES.values():
        (tmp_path / script).write_text(
            "import signal, time\nsignal.signal(signal.SIGHUP, signal.SIG_IGN)\ntime.sleep(120)\n"
        )
    manager = ReminderServices(tmp_path, config, tmp_path / "logs")
    try:
        yield manager
    finally:
        manager.close()


def test_enabled_services_start_once_and_close_reaps_them(manager):
    manager.reconcile()
    children = dict(manager.children)
    assert set(children) == set(SERVICES)
    manager.reconcile()
    assert manager.children == children
    manager.close()
    assert all(child.poll() is not None for child in children.values())
    manager.reconcile()
    assert manager.children == {}


def test_config_disables_and_reenables_optional_services(manager):
    manager.reconcile()
    old_calendar = manager.children["com.yulu.calendar"]
    manager.config_path.write_text('{"calendars": [], "meeting_detection": {"enabled": false}}')
    manager.reconcile()
    assert set(manager.children) == {"com.yulu.scheduler"}
    assert old_calendar.poll() is not None
    manager.config_path.write_text('{"calendars": [{"enabled": true}]}')
    manager.reconcile()
    assert set(manager.children) == set(SERVICES)


def test_health_and_controls_target_app_owned_children(manager):
    status = manager.command({"label": "com.yulu.scheduler", "action": "status"})
    assert status["pid"] > 0 and status["enabled"]
    stopped = manager.command({"label": "com.yulu.scheduler", "action": "stop"})
    assert stopped["pid"] == 0
    manager.reconcile()
    assert "com.yulu.scheduler" not in manager.children
    started = manager.command({"label": "com.yulu.scheduler", "action": "start"})
    assert started["pid"] > 0 and started["pid"] != status["pid"]
    restarted = manager.command({"label": "com.yulu.scheduler", "action": "restart"})
    assert restarted["pid"] != started["pid"]
    assert manager.command({"label": "com.yulu.scheduler", "action": "sighup"})["ok"]
    assert manager.command({"label": "arbitrary-process", "action": "stop"})["ok"] is False


def test_crash_is_reported_then_retried_without_a_spawn_loop(manager):
    manager.reconcile()
    child = manager.children["com.yulu.detector"]
    child.kill()
    child.wait(timeout=2)
    manager.reconcile()
    status = manager.command({"label": "com.yulu.detector", "action": "status"})
    assert status["pid"] == 0 and status["exitStatus"] != 0
    manager.retry_at["com.yulu.detector"] = 0
    manager.reconcile()
    assert manager.children["com.yulu.detector"].pid != child.pid


def test_bad_config_stops_prompts_instead_of_enabling_defaults(manager):
    manager.reconcile()
    manager.config_path.write_text("invalid json")
    manager.reconcile()
    assert manager.children == {}


def test_owned_scheduler_fires_reminder_and_reloads_record_prompt(manager):
    """Real timer and HUP, with harmless presenters in an isolated data directory."""
    manager.config_path.write_text('{"calendars": [], "meeting_detection": {"enabled": false}}')
    (manager.script_dir / "scheduler_daemon.py").write_bytes((SCRIPT_DIR / "scheduler_daemon.py").read_bytes())
    (manager.script_dir / "application_paths.py").write_text(
        "from pathlib import Path\n"
        f"DURABLE_DATA_DIR = IPC_DIR = LEGACY_READ_ONLY_DATA_DIR = LOGS_DIR = Path({str(manager.script_dir)!r})\n"
    )
    marker = manager.script_dir / "fired.jsonl"
    presenter = (
        "import json, sys\n"
        f"with open({str(marker)!r}, 'a') as stream: stream.write(json.dumps(sys.argv[1:]) + '\\n')\n"
    )
    for name in ("notify.py", "meeting_daemon.py"):
        (manager.script_dir / name).write_text(presenter)

    def schedule(kind):
        (manager.script_dir / "schedule.json").write_text(json.dumps({"events": [{
            "kind": kind, "at": (datetime.now() + timedelta(seconds=.3)).isoformat(),
            "title": "Test meeting", "meeting_id": "test",
        }]}))

    def wait_for(count):
        deadline = time.monotonic() + 4
        while not marker.exists() or len(marker.read_text().splitlines()) < count:
            assert time.monotonic() < deadline
            time.sleep(.02)
        return [json.loads(line) for line in marker.read_text().splitlines()]

    schedule("remind")
    manager.reconcile()
    assert wait_for(1)[0][0] == "meeting_soon"
    schedule("ask_record")
    assert manager.command({"label": "com.yulu.scheduler", "action": "sighup"})["ok"]
    fired = wait_for(2)
    assert [arguments[0] for arguments in fired] == ["meeting_soon", "ask_record"]
    assert fired[1][1:] == ["Test meeting", "test"]


def test_stop_reaps_a_prompt_in_the_service_process_group(manager):
    marker = manager.script_dir / "prompt.pid"
    (manager.script_dir / "scheduler_daemon.py").write_text(
        "import subprocess, sys, time\n"
        "from pathlib import Path\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
        f"Path({str(marker)!r}).write_text(str(child.pid))\n"
        "time.sleep(120)\n"
    )
    manager.reconcile()
    deadline = time.monotonic() + 3
    while not marker.exists():
        assert time.monotonic() < deadline
        time.sleep(.02)
    pid = int(marker.read_text())
    manager.close()
    # macOS reaps orphaned descendants asynchronously.
    deadline = time.monotonic() + 3
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        assert time.monotonic() < deadline
        time.sleep(.02)
