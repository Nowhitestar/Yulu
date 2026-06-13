"""ConnectorProvider seam for reusable AI-native integrations."""

from __future__ import annotations

from abc import ABC, abstractmethod

from capabilities import report
from capabilities.probes import probe_command
from capabilities.report import Capability, Provenance, Status

from .probes import probe_agent_plugin, probe_notion_mcp_token, probe_notion_token, probe_python_module, probe_zuliprc
from .report import Connector


class ConnectorProvider(ABC):
    connector_id: str = ""
    display_name: str = ""
    actions: tuple[str, ...] = ()
    config_prefix: str = ""

    @abstractmethod
    def connectors(self) -> dict[str, Connector]:
        """Return this provider's connector entries. Must never raise."""
        ...


def _first_present(caps: list[Capability], missing_detail: str) -> Capability:
    for cap in caps:
        if cap.status is not Status.ABSENT and cap.provenance is not Provenance.ABSENT:
            return cap
    detail = "; ".join(cap.detail for cap in caps if cap.detail) or missing_detail
    return report.absent(detail)


def _connector(
    connector_id: str,
    display_name: str,
    actions: tuple[str, ...],
    config_prefix: str,
    cap: Capability,
) -> Connector:
    return Connector(
        connector_id=connector_id,
        display_name=display_name,
        provenance=cap.provenance,
        status=cap.status,
        resolved_path=cap.resolved_path,
        detail=cap.detail,
        actions=actions,
        config_prefix=config_prefix,
    )


def _app_backed_connector(
    connector_id: str,
    display_name: str,
    actions: tuple[str, ...],
    config_prefix: str,
    cap: Capability,
) -> Connector:
    return Connector(
        connector_id=connector_id,
        display_name=display_name,
        provenance=cap.provenance,
        status=Status.PRESENT_BUT_UNVERIFIED,
        resolved_path=cap.resolved_path,
        detail=f"{cap.detail}; host app bridge not available",
        actions=actions,
        config_prefix=config_prefix,
    )


class GOGConnectorProvider(ConnectorProvider):
    connector_id = "gog"
    display_name = "Google Calendar (gog)"
    actions = ("calendar.read",)
    config_prefix = "calendars"

    def connectors(self) -> dict[str, Connector]:
        cap = probe_command("gog", ("--version",))
        return {self.connector_id: _connector(self.connector_id, self.display_name, self.actions, self.config_prefix, cap)}


class FeishuConnectorProvider(ConnectorProvider):
    connector_id = "feishu"
    display_name = "Feishu"
    actions = ("calendar.read",)
    config_prefix = "connectors.feishu"

    def connectors(self) -> dict[str, Connector]:
        cap = _first_present(
            [
                probe_agent_plugin("feishu", ("lark",)),
                probe_command("feishu", ("--version",)),
            ],
            "feishu connector not found",
        )
        return {self.connector_id: _connector(self.connector_id, self.display_name, self.actions, self.config_prefix, cap)}


class NotionConnectorProvider(ConnectorProvider):
    connector_id = "notion"
    display_name = "Notion"
    actions = ("summary.send",)
    config_prefix = "connectors.notion"

    def connectors(self) -> dict[str, Connector]:
        local_cap = _first_present(
            [
                probe_notion_token(),
                probe_command("notion", ("--version",)),
                probe_python_module("notion_client"),
            ],
            "notion local connector not found",
        )
        if local_cap.status is Status.USABLE:
            return {self.connector_id: _connector(self.connector_id, self.display_name, self.actions, self.config_prefix, local_cap)}

        mcp_cap = probe_notion_mcp_token()
        if mcp_cap.status is not Status.ABSENT:
            return {self.connector_id: _connector(self.connector_id, self.display_name, self.actions, self.config_prefix, mcp_cap)}

        plugin_cap = probe_agent_plugin("notion")
        if plugin_cap.status is not Status.ABSENT:
            return {self.connector_id: _app_backed_connector(self.connector_id, self.display_name, self.actions, self.config_prefix, plugin_cap)}

        return {
            self.connector_id: _connector(
                self.connector_id,
                self.display_name,
                self.actions,
                self.config_prefix,
                report.absent(f"{plugin_cap.detail}; {local_cap.detail}"),
            ),
        }


class ZulipConnectorProvider(ConnectorProvider):
    connector_id = "zulip"
    display_name = "Zulip"
    actions = ("summary.send",)
    config_prefix = "connectors.zulip"

    def connectors(self) -> dict[str, Connector]:
        cap = _first_present(
            [
                probe_zuliprc(),
                probe_agent_plugin("zulip", ("zulipchat",)),
                probe_command("zulip", ("--version",)),
                probe_python_module("zulip"),
            ],
            "zulip connector not found",
        )
        return {self.connector_id: _connector(self.connector_id, self.display_name, self.actions, self.config_prefix, cap)}


def default_providers() -> list[ConnectorProvider]:
    return [
        GOGConnectorProvider(),
        FeishuConnectorProvider(),
        NotionConnectorProvider(),
        ZulipConnectorProvider(),
    ]


__all__ = [
    "ConnectorProvider",
    "GOGConnectorProvider",
    "FeishuConnectorProvider",
    "NotionConnectorProvider",
    "ZulipConnectorProvider",
    "default_providers",
]
