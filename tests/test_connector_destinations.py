"""Output connector destinations expose accounts and selectable targets."""

import json
import ssl
import sys
import types
from pathlib import Path
from urllib.error import URLError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "yulu" / "scripts"))

from connectors import destinations as dest_mod  # noqa: E402


def test_notion_destinations_list_identity_databases_and_pages(monkeypatch):
    class FakeUsers:
        def me(self):
            return {
                "name": "Ada Lovelace",
                "person": {"email": "ada@example.com"},
            }

    class FakeClient:
        def __init__(self, auth):
            assert auth == "secret-token"
            self.users = FakeUsers()

        def search(self, **kwargs):
            object_filter = kwargs["filter"]["value"]
            if object_filter == "database":
                return {
                    "results": [
                        {
                            "id": "db-1",
                            "title": [{"plain_text": "Team Notes"}],
                            "url": "https://notion.so/db-1",
                        },
                    ],
                }
            return {
                "results": [
                    {
                        "id": "page-1",
                        "properties": {"title": {"title": [{"plain_text": "Weekly Memo"}]}},
                        "url": "https://notion.so/page-1",
                    },
                ],
            }

    fake_module = types.SimpleNamespace(Client=FakeClient)
    monkeypatch.setitem(sys.modules, "notion_client", fake_module)
    monkeypatch.setenv("NOTION_API_KEY", "secret-token")

    result = dest_mod.notion_destinations({"api_key_env": "NOTION_API_KEY"})

    assert result["ok"] is True
    assert result["identity"] == {"label": "Ada Lovelace", "detail": "ada@example.com"}
    assert result["destinations"] == [
        {"id": "db-1", "type": "database", "label": "Team Notes", "detail": "https://notion.so/db-1"},
        {"id": "page-1", "type": "page", "label": "Weekly Memo", "detail": "https://notion.so/page-1"},
    ]


def test_notion_destinations_use_rest_without_python_package(monkeypatch):
    monkeypatch.setitem(sys.modules, "notion_client", None)
    monkeypatch.setenv("NOTION_TOKEN", "secret-token")
    seen = []

    def fake_get_json(url, token):
        seen.append(("GET", url, token, None))
        return {"name": "Ada Lovelace", "person": {"email": "ada@example.com"}}

    def fake_post_json(url, token, payload):
        seen.append(("POST", url, token, payload))
        object_filter = payload["filter"]["value"]
        if object_filter == "database":
            return {
                "results": [
                    {"id": "db-1", "title": [{"plain_text": "Team Notes"}], "url": "https://notion.so/db-1"},
                ],
            }
        return {
            "results": [
                {
                    "id": "page-1",
                    "properties": {"title": {"title": [{"plain_text": "Weekly Memo"}]}},
                    "url": "https://notion.so/page-1",
                },
            ],
        }

    monkeypatch.setattr(dest_mod, "_notion_get_json", fake_get_json)
    monkeypatch.setattr(dest_mod, "_notion_post_json", fake_post_json)

    result = dest_mod.notion_destinations({"api_key_env": "NOTION_TOKEN"})

    assert result["ok"] is True
    assert result["identity"] == {"label": "Ada Lovelace", "detail": "ada@example.com"}
    assert result["destinations"] == [
        {"id": "db-1", "type": "database", "label": "Team Notes", "detail": "https://notion.so/db-1"},
        {"id": "page-1", "type": "page", "label": "Weekly Memo", "detail": "https://notion.so/page-1"},
    ]
    assert seen[0] == ("GET", "https://api.notion.com/v1/users/me", "secret-token", None)


def test_zulip_destinations_list_identity_and_subscribed_channels(monkeypatch):
    class FakeClient:
        email = "bot@example.com"

        def __init__(self, config_file):
            assert config_file == "~/.zuliprc"

        def get_profile(self):
            return {
                "result": "success",
                "full_name": "Yulu Bot",
                "email": "bot@example.com",
            }

        def get_subscriptions(self):
            return {
                "result": "success",
                "subscriptions": [
                    {"stream_id": 1, "name": "meetings", "description": "Meeting notes"},
                    {"stream_id": 2, "name": "team", "description": ""},
                ],
            }

    fake_module = types.SimpleNamespace(Client=FakeClient)
    monkeypatch.setitem(sys.modules, "zulip", fake_module)

    result = dest_mod.zulip_destinations({"zuliprc": "~/.zuliprc"})

    assert result["ok"] is True
    assert result["identity"] == {"label": "Yulu Bot", "detail": "bot@example.com"}
    assert result["destinations"] == [
        {"id": "1", "type": "channel", "label": "meetings", "detail": "Meeting notes"},
        {"id": "2", "type": "channel", "label": "team", "detail": ""},
    ]


def test_zulip_destinations_use_zuliprc_and_rest_without_python_package(monkeypatch, tmp_path):
    config_path = tmp_path / ".zuliprc"
    config_path.write_text(
        "[api]\nemail=bot@example.com\nkey=secret\nsite=https://chat.example.com\n",
        encoding="utf-8",
    )
    monkeypatch.setitem(sys.modules, "zulip", None)

    seen_urls = []

    def fake_get_json(url, email, api_key):
        seen_urls.append((url, email, api_key))
        if url.endswith("/api/v1/users/me"):
            return {"result": "success", "full_name": "Yulu Bot", "email": "bot@example.com"}
        if url.endswith("/api/v1/users/me/subscriptions"):
            return {
                "result": "success",
                "subscriptions": [
                    {"stream_id": 3, "name": "notes", "description": "Meeting notes"},
                ],
            }
        raise AssertionError(url)

    monkeypatch.setattr(dest_mod, "_zulip_get_json", fake_get_json)

    result = dest_mod.zulip_destinations({"zuliprc": str(config_path)})

    assert result["ok"] is True
    assert result["identity"] == {"label": "Yulu Bot", "detail": "bot@example.com"}
    assert result["destinations"] == [
        {"id": "3", "type": "channel", "label": "notes", "detail": "Meeting notes"},
    ]
    assert seen_urls == [
        ("https://chat.example.com/api/v1/users/me", "bot@example.com", "secret"),
        ("https://chat.example.com/api/v1/users/me/subscriptions", "bot@example.com", "secret"),
    ]


def test_zulip_rest_get_retries_transient_ssl_eof(monkeypatch):
    attempts = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, _exc_type, _exc, _tb):
            return False

        def read(self):
            return json.dumps({"result": "success"}).encode("utf-8")

    def fake_urlopen(request, timeout):
        attempts.append((request.full_url, timeout))
        if len(attempts) == 1:
            raise URLError(ssl.SSLError("[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol"))
        return FakeResponse()

    monkeypatch.setattr(dest_mod, "urlopen", fake_urlopen)

    result = dest_mod._zulip_get_json("https://chat.example.com/api/v1/users/me", "bot@example.com", "secret")

    assert result == {"result": "success"}
    assert attempts == [
        ("https://chat.example.com/api/v1/users/me", 10),
        ("https://chat.example.com/api/v1/users/me", 10),
    ]
