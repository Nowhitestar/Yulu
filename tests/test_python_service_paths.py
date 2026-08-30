import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"


def test_python_services_split_durable_ipc_and_log_paths(tmp_path):
    durable = tmp_path / "Library" / "Application Support" / "Yulu"
    cache = tmp_path / "Library" / "Caches" / "Yulu"
    logs = tmp_path / "Library" / "Logs" / "Yulu"
    media = tmp_path / "Movies" / "Yulu"
    env = {
        **os.environ,
        "PYTHONPATH": str(SCRIPTS),
        "YULU_APPLICATION_SUPPORT_DIR": str(durable),
        "YULU_CACHE_DIR": str(cache),
        "YULU_IPC_DIR": str(cache),
        "YULU_LOG_DIR": str(logs),
        "YULU_MEDIA_LIBRARY_DIR": str(media),
    }
    env.pop("YULU_CONFIG_DIR", None)
    program = """
import json
import check_meetings
import meeting_actions
import meeting_daemon
import meeting_detector
import repair_permissions
import run_calendar_services
import scheduler_daemon
import status_agent_config
import prompts.cli
import vocab.cli
print(json.dumps({
  "meeting_daemon": [str(meeting_daemon.CONFIG_PATH), str(meeting_daemon.SCHEDULE_PATH), str(meeting_daemon.STATE_PATH), str(meeting_daemon.SCHEDULER_PID), str(meeting_daemon.RECORDING_EVENTS_DIR)],
  "meeting_detector": [str(meeting_detector.CONFIG_PATH), str(meeting_detector.STATE_PATH), str(meeting_detector.RECORDING_STATE_PATH), str(meeting_detector.PID_PATH), str(meeting_detector.LOG_PATH), str(meeting_detector.AUDIO_DAEMON_SOCKET)],
  "scheduler": [str(scheduler_daemon.SCHEDULE_PATH), str(scheduler_daemon.PID_PATH), str(scheduler_daemon.LOG_PATH)],
  "status_agent": [str(status_agent_config.CONFIG_PATH), str(status_agent_config.PID_PATH), str(status_agent_config.IPC_SOCKET_PATH)],
  "readers": [str(check_meetings.CONFIG_PATH), str(meeting_actions.CONFIG_DIR), str(run_calendar_services.CONFIG_DIR), str(repair_permissions.SOCKET_PATH), str(prompts.cli.DEFAULT_DB), str(vocab.cli.DEFAULT_DB)],
}))
"""

    result = subprocess.run(
        [sys.executable, "-c", program],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    paths = json.loads(result.stdout)

    assert paths == {
        "meeting_daemon": [
            str(durable / "config.json"),
            str(durable / "schedule.json"),
            str(durable / ".state.json"),
            str(cache / ".scheduler.pid"),
            str(durable / "recording-events"),
        ],
        "meeting_detector": [
            str(durable / "config.json"),
            str(durable / ".detector_state.json"),
            str(durable / ".state.json"),
            str(cache / ".detector.pid"),
            str(logs / "detector.log"),
            str(cache / "audio_daemon.sock"),
        ],
        "scheduler": [
            str(durable / "schedule.json"),
            str(cache / ".scheduler.pid"),
            str(logs / "scheduler.log"),
        ],
        "status_agent": [
            str(durable / "config.json"),
            str(cache / "status_agent.pid"),
            str(cache / "status_agent.sock"),
        ],
        "readers": [
            str(durable / "config.json"),
            str(durable),
            str(durable),
            str(cache / "audio_daemon.sock"),
            str(durable / "prompts.sqlite"),
            str(durable / "vocab.sqlite"),
        ],
    }


def test_schedule_reads_legacy_but_updates_standard(monkeypatch, tmp_path):
    import meeting_daemon

    standard = tmp_path / "Library" / "Application Support" / "Yulu" / "schedule.json"
    legacy_root = tmp_path / ".config" / "yulu"
    legacy_root.mkdir(parents=True)
    legacy = legacy_root / "schedule.json"
    legacy.write_text(
        json.dumps({"events": [], "meetings": [{"id": "legacy", "title": "Old"}]}),
        encoding="utf-8",
    )
    original = legacy.read_bytes()
    monkeypatch.setattr(meeting_daemon, "SCHEDULE_PATH", standard)
    monkeypatch.setattr(meeting_daemon, "LEGACY_READ_ONLY_DATA_DIR", legacy_root)
    monkeypatch.setattr(meeting_daemon, "notify_scheduler", lambda: None)

    assert meeting_daemon.load_schedule()["meetings"][0]["id"] == "legacy"

    meeting_daemon.save_schedule({"events": [], "meetings": []})
    assert standard.exists()
    assert legacy.read_bytes() == original


def test_recording_state_reads_legacy_but_writes_standard(monkeypatch, tmp_path):
    import state_store

    standard = tmp_path / "Library" / "Application Support" / "Yulu" / ".state.json"
    legacy_root = tmp_path / ".config" / "yulu"
    legacy_root.mkdir(parents=True)
    legacy = legacy_root / ".state.json"
    legacy.write_text(json.dumps({"recording": True, "file_path": "/tmp/old.wav"}), encoding="utf-8")
    original = legacy.read_bytes()
    monkeypatch.setattr(state_store, "STATE_PATH", standard)
    monkeypatch.setattr(state_store, "LEGACY_READ_ONLY_DATA_DIR", legacy_root)

    assert state_store.load_state()["file_path"] == "/tmp/old.wav"

    state_store.save_state({"recording": False})
    assert standard.exists()
    assert legacy.read_bytes() == original


def test_scheduler_reads_legacy_schedule_when_standard_is_missing(monkeypatch, tmp_path):
    import scheduler_daemon

    standard = tmp_path / "Library" / "Application Support" / "Yulu" / "schedule.json"
    legacy_root = tmp_path / ".config" / "yulu"
    legacy_root.mkdir(parents=True)
    legacy = legacy_root / "schedule.json"
    legacy.write_text(json.dumps({"events": [{
        "id": "legacy-event",
        "kind": "remind",
        "at": (datetime.now() + timedelta(hours=1)).isoformat(),
    }]}), encoding="utf-8")
    monkeypatch.setattr(scheduler_daemon, "SCHEDULE_PATH", standard)
    monkeypatch.setattr(scheduler_daemon, "LEGACY_READ_ONLY_DATA_DIR", legacy_root, raising=False)

    scheduler = scheduler_daemon.Scheduler()
    scheduler.load()

    assert scheduler.heap[0][2]["id"] == "legacy-event"


def test_meeting_actions_reads_legacy_schedule_when_standard_is_missing(monkeypatch, tmp_path):
    import meeting_actions

    standard = tmp_path / "Library" / "Application Support" / "Yulu" / "schedule.json"
    legacy_root = tmp_path / ".config" / "yulu"
    legacy_root.mkdir(parents=True)
    legacy = legacy_root / "schedule.json"
    legacy.write_text(json.dumps({"events": [], "meetings": [{"id": "legacy"}]}), encoding="utf-8")
    monkeypatch.setattr(meeting_actions, "SCHEDULE_PATH", standard)
    monkeypatch.setattr(meeting_actions, "LEGACY_READ_ONLY_DATA_DIR", legacy_root, raising=False)

    assert meeting_actions.load_schedule()["meetings"][0]["id"] == "legacy"


def test_detector_reads_legacy_cooldown_state_when_standard_is_missing(monkeypatch, tmp_path):
    import meeting_detector

    standard = tmp_path / "Library" / "Application Support" / "Yulu" / ".detector_state.json"
    legacy_root = tmp_path / ".config" / "yulu"
    legacy_root.mkdir(parents=True)
    legacy = legacy_root / ".detector_state.json"
    legacy.write_text(json.dumps({"prompted": {"legacy": 42}}), encoding="utf-8")
    monkeypatch.setattr(meeting_detector, "STATE_PATH", standard)
    monkeypatch.setattr(meeting_detector, "LEGACY_READ_ONLY_DATA_DIR", legacy_root, raising=False)

    assert meeting_detector.load_state()["prompted"]["legacy"] == 42


def test_calendar_empty_sync_preserves_legacy_future_schedule(monkeypatch, tmp_path):
    import run_calendar_services

    durable = tmp_path / "Library" / "Application Support" / "Yulu"
    legacy_root = tmp_path / ".config" / "yulu"
    legacy_root.mkdir(parents=True)
    legacy_schedule = legacy_root / "schedule.json"
    legacy_schedule.write_text(json.dumps({"events": [{
        "kind": "remind",
        "at": (datetime.now() + timedelta(hours=1)).isoformat(),
    }], "meetings": []}), encoding="utf-8")
    notifications = []
    monkeypatch.setattr(run_calendar_services, "CONFIG_DIR", durable)
    monkeypatch.setattr(run_calendar_services, "LEGACY_READ_ONLY_DATA_DIR", legacy_root)
    monkeypatch.setattr(run_calendar_services, "LAST_SYNC", 0)
    monkeypatch.setattr(run_calendar_services.time, "time", lambda: 1000)
    monkeypatch.setattr(
        run_calendar_services.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout="[]", stderr=""),
    )
    monkeypatch.setattr(
        run_calendar_services,
        "_notify_system",
        lambda *args: notifications.append(args),
    )

    run_calendar_services.sync_calendar_to_schedule()

    assert not (durable / "schedule.json").exists()
    assert notifications


def test_calendar_fresh_sync_creates_standard_durable_parent(monkeypatch, tmp_path):
    import run_calendar_services

    durable = tmp_path / "Library" / "Application Support" / "Yulu"
    legacy_root = tmp_path / ".config" / "yulu"
    monkeypatch.setattr(run_calendar_services, "CONFIG_DIR", durable)
    monkeypatch.setattr(run_calendar_services, "LEGACY_READ_ONLY_DATA_DIR", legacy_root)
    monkeypatch.setattr(run_calendar_services, "LAST_SYNC", 0)
    monkeypatch.setattr(run_calendar_services.time, "time", lambda: 1000)
    monkeypatch.setattr(
        run_calendar_services.subprocess,
        "run",
        lambda command, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout="[]" if "check_meetings.py" in " ".join(command) else "",
            stderr="",
        ),
    )

    run_calendar_services.sync_calendar_to_schedule()

    assert json.loads((durable / "schedule.json").read_text(encoding="utf-8")) == {
        "events": [],
        "meetings": [],
    }


def test_native_service_callers_route_ipc_and_logs_out_of_legacy_root():
    cli = (SCRIPTS / "yulu").read_text(encoding="utf-8")
    launchctl = (SCRIPTS / "yulu_ui" / "src" / "launchctl.ts").read_text(encoding="utf-8")
    server = (SCRIPTS / "yulu_ui" / "src" / "server.ts").read_text(encoding="utf-8")
    common = (SCRIPTS / "lib" / "common.sh").read_text(encoding="utf-8")
    setup = (SCRIPTS / "setup.sh").read_text(encoding="utf-8")
    setup_audio = (SCRIPTS / "setup_audio.sh").read_text(encoding="utf-8")
    setup_ui = (SCRIPTS / "setup_ui.sh").read_text(encoding="utf-8")

    assert 'IPC_DIR="${YULU_IPC_DIR:-$HOME/Library/Caches/Yulu}"' in cli
    assert 'LOGS_DIR="${YULU_LOG_DIR:-$HOME/Library/Logs/Yulu}"' in cli
    assert '"$IPC_DIR/audio_daemon.sock"' in cli
    assert 'local log_path="$LOGS_DIR/${name}.log"' in cli
    assert 'join(homedir(), "Library", "Caches", "Yulu", "status_agent.pid")' in launchctl
    assert "new LaunchctlClient(" in server
    assert 'join(runtimePaths.ipcDir, "status_agent.pid")' in server
    assert 'mkdir -p "$HOME/Library/Logs/Yulu"' in common
    assert 'IPC_DIR="${YULU_IPC_DIR:-$HOME/Library/Caches/Yulu}"' in setup_audio
    assert '"$IPC_DIR/audio_daemon.sock"' in setup_audio
    assert '"$HOME/Library/Caches/Yulu/audio_daemon.sock"' in setup
    assert "~/Library/Logs/Yulu/ui.log" in setup_ui
    assert '"$CONFIG_DIR/audio_daemon.sock"' not in setup_audio

    for name in (
        "com.yulu.audiodaemon.plist",
        "com.yulu.statusagent.plist",
        "com.yulu.scheduler.plist",
        "com.yulu.detector.plist",
        "com.yulu.calendar.plist",
        "com.yulu.ui.plist",
    ):
        plist = (SCRIPTS / name).read_text(encoding="utf-8")
        assert "__HOME__/Library/Logs/Yulu/" in plist
        assert "__HOME__/.config/yulu/" not in plist
