"""Connector report schema for agent-native integrations."""

from __future__ import annotations

from dataclasses import dataclass, field

from capabilities.report import Provenance, Status


@dataclass
class Connector:
    connector_id: str
    display_name: str
    provenance: Provenance
    status: Status
    resolved_path: str = ""
    detail: str = ""
    actions: tuple[str, ...] = ()
    config_prefix: str = ""


@dataclass
class ConnectorReport:
    schema_version: int = 1
    connectors: dict[str, Connector] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "connectors": {
                connector_id: {
                    "connector_id": connector.connector_id,
                    "display_name": connector.display_name,
                    "provenance": connector.provenance.value,
                    "status": connector.status.value,
                    "resolved_path": connector.resolved_path,
                    "detail": connector.detail,
                    "actions": list(connector.actions),
                    "config_prefix": connector.config_prefix,
                }
                for connector_id, connector in self.connectors.items()
            },
        }


__all__ = ["Connector", "ConnectorReport"]

