"""Connector send_summary switches expose manual delivery, not auto delivery."""

import importlib.util
import json
import ssl
import sys
import types
from pathlib import Path
from urllib.error import URLError

ROOT = Path(__file__).resolve().parents[1]
SEND_SUMMARY = ROOT / "yulu" / "scripts" / "send_summary.py"


def load_send_summary():
    spec = importlib.util.spec_from_file_location("send_summary", SEND_SUMMARY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_connector_summary_switches_do_not_auto_send(tmp_path, monkeypatch):
    mod = load_send_summary()
    config_path = tmp_path / "config.json"
    summary_path = tmp_path / "meeting.summary.md"
    summary_path.write_text("hello", encoding="utf-8")
    config_path.write_text(json.dumps({
        "output": {"channel": "file", "notion": {"database_id": "db"}, "zulip": {"stream": "s", "topic": "t"}},
        "connectors": {
            "notion": {"send_summary": True},
            "zulip": {"send_summary": True},
        },
    }), encoding="utf-8")
    monkeypatch.setattr(mod, "CONFIG_PATH", config_path)

    calls = []
    monkeypatch.setattr(mod, "send_to_file", lambda path: calls.append(("file", path)) or True)
    monkeypatch.setattr(mod, "send_to_notion", lambda path, cfg: calls.append(("notion", cfg)) or True)
    monkeypatch.setattr(mod, "send_to_zulip", lambda path, cfg: calls.append(("zulip", cfg)) or True)

    assert mod.send_summary(str(summary_path)) is True
    assert [name for name, _ in calls] == ["file"]


def test_send_summary_to_explicit_connector_channel(tmp_path, monkeypatch):
    mod = load_send_summary()
    summary_path = tmp_path / "meeting.summary.md"
    summary_path.write_text("hello", encoding="utf-8")

    calls = []
    monkeypatch.setattr(mod, "send_to_notion", lambda path, cfg: calls.append(("notion", path, cfg)) or True)

    assert mod.send_summary_to_channel(str(summary_path), "notion", {"output": {"notion": {"database_id": "db"}}}) is True
    assert calls == [("notion", str(summary_path), {"database_id": "db"})]


def test_notion_database_destination_uses_selected_destination_id(tmp_path, monkeypatch):
    mod = load_send_summary()
    summary_path = tmp_path / "meeting.summary.md"
    summary_path.write_text("hello", encoding="utf-8")

    seen = {}

    class FakePages:
        def create(self, **kwargs):
            seen["create"] = kwargs
            return {"url": "https://notion.so/new-page"}

    class FakeClient:
        def __init__(self, auth):
            assert auth == "secret"
            self.pages = FakePages()

    monkeypatch.setitem(sys.modules, "notion_client", types.SimpleNamespace(Client=FakeClient))
    monkeypatch.setenv("NOTION_API_KEY", "secret")

    assert mod.send_to_notion(str(summary_path), {
        "destination_id": "db-1",
        "destination_type": "database",
        "destination_label": "Team Notes",
    }) is True
    assert seen["create"]["parent"] == {"database_id": "db-1"}


def test_notion_page_destination_appends_to_selected_page(tmp_path, monkeypatch):
    mod = load_send_summary()
    summary_path = tmp_path / "meeting.summary.md"
    summary_path.write_text("hello", encoding="utf-8")

    seen = {}

    class FakeBlocksChildren:
        def append(self, **kwargs):
            seen["append"] = kwargs
            return {"ok": True}

    class FakeBlocks:
        children = FakeBlocksChildren()

    class FakeClient:
        def __init__(self, auth):
            assert auth == "secret"
            self.blocks = FakeBlocks()

    monkeypatch.setitem(sys.modules, "notion_client", types.SimpleNamespace(Client=FakeClient))
    monkeypatch.setenv("NOTION_API_KEY", "secret")

    assert mod.send_to_notion(str(summary_path), {
        "destination_id": "page-1",
        "destination_type": "page",
        "destination_label": "Weekly Memo",
    }) is True
    assert seen["append"]["block_id"] == "page-1"


def test_notion_page_destination_uses_rest_without_python_package(tmp_path, monkeypatch):
    mod = load_send_summary()
    summary_path = tmp_path / "meeting.summary.md"
    summary_path.write_text("hello", encoding="utf-8")
    monkeypatch.setitem(sys.modules, "notion_client", None)
    monkeypatch.setenv("NOTION_TOKEN", "secret")
    seen = {}

    def fake_post(url, api_key, payload, method="POST"):
        seen["url"] = url
        seen["api_key"] = api_key
        seen["payload"] = payload
        seen["method"] = method
        return {"ok": True}

    monkeypatch.setattr(mod, "_notion_post_json", fake_post)

    assert mod.send_to_notion(str(summary_path), {
        "api_key_env": "NOTION_TOKEN",
        "destination_id": "page-1",
        "destination_type": "page",
        "destination_label": "Weekly Memo",
    }) is True
    assert seen["url"] == "https://api.notion.com/v1/blocks/page-1/children"
    assert seen["api_key"] == "secret"
    assert seen["method"] == "PATCH"
    assert seen["payload"]["children"][0]["type"] == "heading_2"


def test_zulip_send_uses_zuliprc_and_rest_without_python_package(tmp_path, monkeypatch):
    mod = load_send_summary()
    summary_path = tmp_path / "meeting.summary.md"
    summary_path.write_text("hello", encoding="utf-8")
    config_path = tmp_path / ".zuliprc"
    config_path.write_text(
        "[api]\nemail=bot@example.com\nkey=secret\nsite=https://chat.example.com\n",
        encoding="utf-8",
    )
    monkeypatch.setitem(sys.modules, "zulip", None)
    seen = {}

    def fake_post(url, email, api_key, payload):
        seen["url"] = url
        seen["email"] = email
        seen["api_key"] = api_key
        seen["payload"] = payload
        return {"result": "success"}

    monkeypatch.setattr(mod, "_zulip_post_form", fake_post)

    assert mod.send_to_zulip(str(summary_path), {
        "zuliprc": str(config_path),
        "stream_id": "3",
        "stream": "notes",
        "topic": "纪要",
    }) is True
    assert seen == {
        "url": "https://chat.example.com/api/v1/messages",
        "email": "bot@example.com",
        "api_key": "secret",
        "payload": {
            "type": "channel",
            "to": "3",
            "topic": "纪要",
            "content": "hello",
        },
    }


def test_zulip_post_retries_transient_ssl_eof(monkeypatch):
    mod = load_send_summary()
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

    monkeypatch.setattr(mod, "urlopen", fake_urlopen)

    result = mod._zulip_post_form(
        "https://chat.example.com/api/v1/messages",
        "bot@example.com",
        "secret",
        {"type": "channel", "to": "3", "topic": "纪要", "content": "hello"},
    )

    assert result == {"result": "success"}
    assert attempts == [
        ("https://chat.example.com/api/v1/messages", 10),
        ("https://chat.example.com/api/v1/messages", 10),
    ]
