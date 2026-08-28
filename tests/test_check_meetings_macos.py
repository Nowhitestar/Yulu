import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import check_meetings  # noqa: E402


class CommandResult:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_empty_calendar_config_does_not_select_macos_by_discovery(monkeypatch):
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

    assert meetings == []
    assert calls == []


def test_macos_calendar_provider_invokes_bundled_eventkit_helper_and_normalizes_events(monkeypatch):
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs

        class Result:
            returncode = 0
            stderr = ""
            stdout = json.dumps({"ok": True, "events": [{
                "id": "uid-1",
                "title": "Agent Review",
                "start": "2026-06-25T10:00:00.000Z",
                "end": "2026-06-25T11:00:00.000Z",
                "link": "https://meet.google.com/abc",
                "description": "Discuss Ask Yulu",
                "calendar": "Work",
                "attendees": [],
            }], "start": "2026-06-25T00:00:00Z", "end": "2026-06-26T00:00:00Z"})

        return Result()

    monkeypatch.setattr(check_meetings.sys, "platform", "darwin")
    monkeypatch.setattr(check_meetings.subprocess, "run", fake_run)

    meetings = check_meetings._fetch_macos_calendar(
        {"type": "macos", "enabled": True, "watch_calendars": ["Work"]},
        datetime(2026, 6, 25, tzinfo=timezone.utc),
        datetime(2026, 6, 26, tzinfo=timezone.utc),
    )

    assert captured["cmd"][0].endswith("calendar_probe")
    assert captured["cmd"][0] != "osascript"
    assert captured["cmd"][1:6] == ["--events", "--start", "2026-06-25T00:00:00Z", "--end", "2026-06-26T00:00:00Z"]
    assert json.loads(captured["cmd"][7]) == ["Work"]
    assert "env" not in captured["kwargs"]
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


def test_production_week_window_is_split_into_bounded_eventkit_enumerations(monkeypatch):
    commands = []

    def fake_run(cmd, **_kwargs):
        commands.append(cmd)

        class Result:
            returncode = 0
            stderr = ""
            stdout = json.dumps({"ok": True, "events": [], "start": cmd[3], "end": cmd[5]})

        return Result()

    monkeypatch.setattr(check_meetings.sys, "platform", "darwin")
    monkeypatch.setattr(check_meetings.subprocess, "run", fake_run)

    meetings = check_meetings._fetch_macos_calendar(
        {"type": "macos", "enabled": True},
        datetime(2026, 6, 25, tzinfo=timezone.utc),
        datetime(2026, 7, 2, tzinfo=timezone.utc),
    )

    assert meetings == []
    assert len(commands) == 4
    for command in commands:
        start = datetime.fromisoformat(command[3].replace("Z", "+00:00"))
        end = datetime.fromisoformat(command[5].replace("Z", "+00:00"))
        assert end > start
        assert end - start <= check_meetings.timedelta(hours=48)


def test_gog_production_polling_uses_fixed_native_oauth_argv_without_token_env(monkeypatch):
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs

        class Result:
            returncode = 0
            stderr = ""
            stdout = json.dumps({"events": []})

        return Result()

    monkeypatch.setattr(check_meetings.subprocess, "run", fake_run)

    meetings = check_meetings._fetch_google(
        {"type": "google", "enabled": True, "gog_account": "me@example.com"},
        datetime(2026, 6, 25, tzinfo=timezone.utc),
        datetime(2026, 6, 26, tzinfo=timezone.utc),
    )

    assert meetings == []
    assert captured["cmd"] == [
        "gog",
        "--json",
        "--results-only",
        "--no-input",
        "--account",
        "me@example.com",
        "calendar",
        "events",
        "primary",
        "--all-pages",
        "--from",
        "2026-06-25T00:00:00+0000",
        "--to",
        "2026-06-26T00:00:00+0000",
    ]
    assert "env" not in captured["kwargs"]


def test_gog_production_polling_rejects_malformed_event_items(monkeypatch):
    def fake_run(_cmd, **_kwargs):
        class Result:
            returncode = 0
            stderr = ""
            stdout = json.dumps({"events": [{"error": "unauthorized"}]})

        return Result()

    monkeypatch.setattr(check_meetings.subprocess, "run", fake_run)

    with pytest.raises(check_meetings.CalendarSourceError) as raised:
        check_meetings._fetch_google(
            {"gog_account": "me@example.com"},
            datetime(2026, 6, 25, tzinfo=timezone.utc),
            datetime(2026, 6, 26, tzinfo=timezone.utc),
        )
    assert raised.value.reason == "enumeration_failed"


@pytest.mark.parametrize(
    ("config", "runner", "reason"),
    [
        ({}, None, "authorization_not_determined"),
        (
            {"gog_account": "me@example.com"},
            lambda *_args, **_kwargs: CommandResult(
                returncode=1,
                stderr="unauthorized token-do-not-print",
            ),
            "authorization_denied",
        ),
        (
            {"gog_account": "me@example.com"},
            lambda *_args, **_kwargs: CommandResult(stdout="not-json"),
            "enumeration_failed",
        ),
    ],
)
def test_gog_provider_failures_are_typed_and_sanitized(monkeypatch, config, runner, reason):
    if runner is not None:
        monkeypatch.setattr(check_meetings.subprocess, "run", runner)

    with pytest.raises(check_meetings.CalendarSourceError) as raised:
        check_meetings._fetch_google(
            config,
            datetime(2026, 6, 25, tzinfo=timezone.utc),
            datetime(2026, 6, 26, tzinfo=timezone.utc),
        )

    assert raised.value.source == "gog"
    assert raised.value.reason == reason
    assert "token-do-not-print" not in str(raised.value)


@pytest.mark.parametrize(
    ("runner", "reason"),
    [
        (
            lambda *_args, **_kwargs: CommandResult(
                returncode=1,
                stdout=json.dumps({"ok": False, "reason": "authorization_denied"}),
                stderr="calendar-secret-do-not-print",
            ),
            "authorization_denied",
        ),
        (
            lambda *_args, **_kwargs: CommandResult(stdout="not-json"),
            "enumeration_failed",
        ),
        (
            lambda *_args, **_kwargs: (_ for _ in ()).throw(FileNotFoundError()),
            "runtime_missing",
        ),
    ],
)
def test_eventkit_provider_failures_are_typed_and_sanitized(monkeypatch, runner, reason):
    monkeypatch.setattr(check_meetings.sys, "platform", "darwin")
    monkeypatch.setattr(check_meetings.subprocess, "run", runner)

    with pytest.raises(check_meetings.CalendarSourceError) as raised:
        check_meetings._fetch_macos_calendar(
            {"type": "macos", "enabled": True},
            datetime(2026, 6, 25, tzinfo=timezone.utc),
            datetime(2026, 6, 26, tzinfo=timezone.utc),
        )

    assert raised.value.source == "macos"
    assert raised.value.reason == reason
    assert "calendar-secret-do-not-print" not in str(raised.value)


@pytest.mark.parametrize(
    "payload",
    [
        {
            "ok": True,
            "events": [None],
            "start": "2026-06-25T00:00:00Z",
            "end": "2026-06-26T00:00:00Z",
        },
        {
            "ok": True,
            "events": [{
                "start": "2026-06-25T10:00:00Z",
                "end": "2026-06-25T11:00:00Z",
                "attendees": "not-a-list",
            }],
            "start": "2026-06-25T00:00:00Z",
            "end": "2026-06-26T00:00:00Z",
        },
        {
            "ok": True,
            "events": [],
            "start": "2026-06-24T00:00:00Z",
            "end": "2026-06-26T00:00:00Z",
        },
    ],
)
def test_eventkit_provider_rejects_malformed_items_and_window_mismatch(monkeypatch, payload):
    monkeypatch.setattr(check_meetings.sys, "platform", "darwin")
    monkeypatch.setattr(
        check_meetings.subprocess,
        "run",
        lambda *_args, **_kwargs: CommandResult(stdout=json.dumps(payload)),
    )

    with pytest.raises(check_meetings.CalendarSourceError) as raised:
        check_meetings._fetch_macos_calendar(
            {"type": "macos", "enabled": True},
            datetime(2026, 6, 25, tzinfo=timezone.utc),
            datetime(2026, 6, 26, tzinfo=timezone.utc),
        )

    assert raised.value.reason == "enumeration_failed"


def test_main_exits_nonzero_with_only_stable_provider_failure(monkeypatch, capsys):
    monkeypatch.setattr(check_meetings.sys, "argv", ["check_meetings.py", "week", "--json"])
    monkeypatch.setattr(
        check_meetings,
        "fetch_meetings",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            check_meetings.CalendarSourceError("gog", "enumeration_failed")
        ),
    )

    with pytest.raises(SystemExit) as raised:
        check_meetings.main()

    assert raised.value.code == 2
    assert capsys.readouterr().err.strip() == "calendar_source_error:gog:enumeration_failed"
