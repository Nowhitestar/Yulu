import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import run_calendar_services as calendar  # noqa: E402


def test_calendar_service_never_reads_or_exchanges_gog_oauth_tokens():
    source = (SCRIPTS / "run_calendar_services.py").read_text(encoding="utf-8")

    assert "find-generic-password" not in source
    assert "refresh_token" not in source
    assert "client_secret" not in source
    assert "credentials.json" not in source
    assert "oauth2.googleapis.com" not in source
    assert "cloudflared" not in source
    assert "GOG_ACCOUNT" not in source


def test_calendar_service_delegates_all_provider_access_to_check_meetings(monkeypatch, tmp_path):
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))

        class Result:
            returncode = 0
            stderr = ""
            stdout = "[]" if "check_meetings.py" in " ".join(command) else ""

        return Result()

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setattr(calendar, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(calendar, "LAST_SYNC", 0)
    monkeypatch.setattr(calendar.time, "time", lambda: 1_000_000)
    monkeypatch.setattr(calendar.subprocess, "run", fake_run)

    calendar.sync_calendar_to_schedule()

    assert calls[0][0] == [
        sys.executable,
        str(SCRIPTS / "check_meetings.py"),
        "week",
        "--json",
    ]
    assert "env" not in calls[0][1]
    assert json.loads((config_dir / "schedule.json").read_text(encoding="utf-8")) == {
        "events": [],
        "meetings": [],
    }


def test_calendar_service_does_not_rewrite_schedule_when_provider_exits_nonzero(monkeypatch, tmp_path):
    class Result:
        returncode = 2
        stdout = ""
        stderr = "calendar_source_error:macos:enumeration_failed\n"

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    schedule = config_dir / "schedule.json"
    original = '{"events":[{"at":"2099-01-01T00:00:00Z"}],"meetings":[]}'
    schedule.write_text(original, encoding="utf-8")
    monkeypatch.setattr(calendar, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(calendar, "LAST_SYNC", 0)
    monkeypatch.setattr(calendar.time, "time", lambda: 1_000_000)
    monkeypatch.setattr(calendar.subprocess, "run", lambda *_args, **_kwargs: Result())

    calendar.sync_calendar_to_schedule()

    assert schedule.read_text(encoding="utf-8") == original


def test_calendar_service_normalizes_all_day_events_without_aborting_sync(monkeypatch, tmp_path):
    class Result:
        returncode = 0
        stderr = ""
        stdout = json.dumps([{
            "id": "all-day-1",
            "title": "Company holiday",
            "start": "2099-01-01",
            "end": "2099-01-02",
            "source": "google",
        }])

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setattr(calendar, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(calendar, "LAST_SYNC", 0)
    monkeypatch.setattr(calendar.time, "time", lambda: 1_000_000)
    monkeypatch.setattr(calendar.subprocess, "run", lambda *_args, **_kwargs: Result())

    calendar.sync_calendar_to_schedule()

    schedule = json.loads((config_dir / "schedule.json").read_text(encoding="utf-8"))
    assert schedule["meetings"][0]["id"] == "all-day-1"
    assert schedule["events"] == []
