import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import run_calendar_services as calendar  # noqa: E402


def test_gog_credentials_cache_successful_keychain_read(monkeypatch, tmp_path):
    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))

        class Result:
            returncode = 0
            stdout = json.dumps({
                "client_id": "client",
                "client_secret": "secret",
                "refresh_token": "refresh",
            })

        return Result()

    monkeypatch.setattr(calendar, "GOG_ACCOUNT", "me@example.com")
    monkeypatch.setattr(calendar, "GOG_CREDENTIALS_CACHE", None)
    monkeypatch.setattr(calendar.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(calendar.subprocess, "run", fake_run)
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("GOOGLE_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("GOG_REFRESH_TOKEN", raising=False)

    assert calendar._get_gog_credentials() == ("client", "secret", "refresh")
    assert calendar._get_gog_credentials() == ("client", "secret", "refresh")

    assert len(calls) == 1
    assert calls[0][1]["timeout"] == 60
