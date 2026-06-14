"""ConnectorProvider contract for agent-native integrations.

The connector seam answers a narrower question than host capabilities:
which calendar/output connectors can Yulu reuse from the host agent or local
runtime, and which actions do they support?
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "yulu" / "scripts"))

from capabilities.report import Capability, Provenance, Status  # noqa: E402
from connectors import provider as connector_mod  # noqa: E402
from connectors.provider import (  # noqa: E402
    ConnectorProvider,
    FeishuConnectorProvider,
    GOGConnectorProvider,
    NotionConnectorProvider,
    ZulipConnectorProvider,
    default_providers,
)
from connectors.report import Connector, ConnectorReport  # noqa: E402


def _usable(path: str, detail: str = "ok") -> Capability:
    return Capability(Provenance.HOST_PATH, Status.USABLE, path, detail)


def test_connector_provider_is_abstract():
    with pytest.raises(TypeError):
        ConnectorProvider()  # type: ignore[abstract]


def test_default_connector_providers_cover_requested_integrations():
    providers = default_providers()
    ids = {p.connector_id for p in providers}
    assert {"gog", "feishu", "notion", "zulip"} <= ids
    assert any(isinstance(p, GOGConnectorProvider) for p in providers)
    assert any(isinstance(p, FeishuConnectorProvider) for p in providers)
    assert any(isinstance(p, NotionConnectorProvider) for p in providers)
    assert any(isinstance(p, ZulipConnectorProvider) for p in providers)
    assert all(isinstance(p, ConnectorProvider) for p in providers)


def test_gog_connector_reports_calendar_read_action(monkeypatch):
    monkeypatch.setattr(connector_mod, "probe_command", lambda *a, **k: _usable("/opt/homebrew/bin/gog", "gog v1"))

    connectors = GOGConnectorProvider().connectors()

    gog = connectors["gog"]
    assert isinstance(gog, Connector)
    assert gog.display_name == "Google Calendar (gog)"
    assert gog.provenance is Provenance.HOST_PATH
    assert gog.status is Status.USABLE
    assert gog.resolved_path == "/opt/homebrew/bin/gog"
    assert gog.actions == ("calendar.read",)
    assert gog.config_prefix == "calendars"


def test_agent_plugin_presence_is_reported_as_agent_config(monkeypatch, tmp_path):
    plugin_root = tmp_path / "plugins"
    (plugin_root / "notion" / "0.1.0").mkdir(parents=True)
    monkeypatch.setenv("YULU_AGENT_PLUGIN_ROOTS", str(plugin_root))
    monkeypatch.setattr(connector_mod, "probe_command", lambda *a, **k: connector_mod.report.absent("not on PATH"))
    monkeypatch.setattr(connector_mod, "probe_python_module", lambda *a, **k: connector_mod.report.absent("not installed"))

    notion = NotionConnectorProvider().connectors()["notion"]

    assert notion.provenance is Provenance.AGENT_CONFIG
    assert notion.status is Status.PRESENT_BUT_UNVERIFIED
    assert notion.resolved_path.endswith("plugins/notion")
    assert notion.actions == ("summary.send",)


def test_notion_token_is_a_usable_local_rest_connector(monkeypatch):
    monkeypatch.setenv("NOTION_TOKEN", "secret")
    monkeypatch.delenv("NOTION_API_KEY", raising=False)
    monkeypatch.setattr(connector_mod, "probe_command", lambda *a, **k: connector_mod.report.absent("not on PATH"))
    monkeypatch.setattr(connector_mod, "probe_python_module", lambda *a, **k: connector_mod.report.absent("not installed"))
    monkeypatch.setattr(connector_mod, "probe_agent_plugin", lambda *a, **k: connector_mod.report.absent("plugin missing"))

    notion = NotionConnectorProvider().connectors()["notion"]

    assert notion.provenance is Provenance.HOST_PATH
    assert notion.status is Status.USABLE
    assert notion.resolved_path == "NOTION_TOKEN"
    assert notion.detail == "NOTION_TOKEN configured"


def test_notion_mcp_token_is_reported_as_unverified_bridge(monkeypatch, tmp_path):
    home = tmp_path / "home"
    token_dir = home / ".config" / "yulu"
    token_dir.mkdir(parents=True)
    (token_dir / "notion-mcp-token.json").write_text('{"access_token":"secret"}', encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("NOTION_TOKEN", raising=False)
    monkeypatch.delenv("NOTION_API_KEY", raising=False)
    monkeypatch.setattr(connector_mod, "probe_command", lambda *a, **k: connector_mod.report.absent("not on PATH"))
    monkeypatch.setattr(connector_mod, "probe_python_module", lambda *a, **k: connector_mod.report.absent("not installed"))
    monkeypatch.setattr(connector_mod, "probe_agent_plugin", lambda *a, **k: connector_mod.report.absent("plugin missing"))

    notion = NotionConnectorProvider().connectors()["notion"]

    assert notion.provenance is Provenance.HOST_PATH
    assert notion.status is Status.PRESENT_BUT_UNVERIFIED
    assert notion.resolved_path == str(token_dir / "notion-mcp-token.json")
    assert "MCP OAuth token stored" in notion.detail


def test_zulip_zuliprc_is_a_usable_local_connector(monkeypatch, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    (home / ".zuliprc").write_text(
        "[api]\nemail=bot@example.com\nkey=secret\nsite=https://chat.example.com\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(connector_mod, "probe_agent_plugin", lambda *a, **k: connector_mod.report.absent("plugin missing"))
    monkeypatch.setattr(connector_mod, "probe_command", lambda *a, **k: connector_mod.report.absent("cli missing"))
    monkeypatch.setattr(connector_mod, "probe_python_module", lambda *a, **k: connector_mod.report.absent("module missing"))

    zulip = ZulipConnectorProvider().connectors()["zulip"]

    assert zulip.provenance is Provenance.HOST_PATH
    assert zulip.status is Status.USABLE
    assert zulip.resolved_path == str(home / ".zuliprc")
    assert zulip.detail == "zuliprc configured"


def test_connector_report_serializes_actions_and_status_strings():
    report = ConnectorReport()
    report.connectors["zulip"] = Connector(
        connector_id="zulip",
        display_name="Zulip",
        provenance=Provenance.AGENT_CONFIG,
        status=Status.USABLE,
        resolved_path="/agent/plugins/zulip",
        detail="agent plugin",
        actions=("summary.send",),
        config_prefix="connectors.zulip",
    )

    data = report.to_dict()

    assert data["schema_version"] == 1
    entry = data["connectors"]["zulip"]
    assert entry["provenance"] == "agent-config"
    assert entry["status"] == "usable"
    assert entry["actions"] == ["summary.send"]
    assert entry["config_prefix"] == "connectors.zulip"
