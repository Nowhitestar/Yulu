import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import check_meetings  # noqa: E402


def test_empty_calendar_config_defaults_to_macos_provider_on_darwin(monkeypatch):
    calls = []

    def fake_fetch(config, start, end):
        calls.append((config, start, end))
        return [{
            "id": "native-1",
            "title": "Native Weekly",
            "start": "2026-06-25T10:00:00Z",
            "end": "2026-06-25T11:00:00Z",
            "source": "macos",
        }]

    monkeypatch.setattr(check_meetings.sys, "platform", "darwin")
    monkeypatch.setattr(check_meetings, "_fetch_macos_calendar", fake_fetch)

    meetings = check_meetings.fetch_meetings(
        datetime(2026, 6, 25, tzinfo=timezone.utc),
        datetime(2026, 6, 26, tzinfo=timezone.utc),
        config={"calendars": []},
    )

    assert meetings[0]["title"] == "Native Weekly"
    assert calls[0][0] == {"type": "macos", "enabled": True}


def test_macos_calendar_provider_invokes_osascript_and_normalizes_events(monkeypatch):
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["env"] = kwargs["env"]

        class Result:
            returncode = 0
            stderr = ""
            stdout = json.dumps([{
                "id": "uid-1",
                "title": "Agent Review",
                "start": "2026-06-25T10:00:00.000Z",
                "end": "2026-06-25T11:00:00.000Z",
                "link": "https://meet.google.com/abc",
                "description": "Discuss Ask Yulu",
                "calendar": "Work",
                "attendees": [],
            }])

        return Result()

    monkeypatch.setattr(check_meetings.sys, "platform", "darwin")
    monkeypatch.setattr(check_meetings.subprocess, "run", fake_run)

    meetings = check_meetings._fetch_macos_calendar(
        {"type": "macos", "enabled": True, "watch_calendars": ["Work"]},
        datetime(2026, 6, 25, tzinfo=timezone.utc),
        datetime(2026, 6, 26, tzinfo=timezone.utc),
    )

    assert captured["cmd"][:3] == ["osascript", "-l", "JavaScript"]
    assert json.loads(captured["env"]["YULU_CALENDAR_NAMES_JSON"]) == ["Work"]
    assert meetings == [{
        "id": "uid-1",
        "title": "Agent Review",
        "start": "2026-06-25T10:00:00.000Z",
        "end": "2026-06-25T11:00:00.000Z",
        "link": "https://meet.google.com/abc",
        "attendees": [],
        "description": "Discuss Ask Yulu",
        "calendar": "Work",
        "source": "macos",
    }]
