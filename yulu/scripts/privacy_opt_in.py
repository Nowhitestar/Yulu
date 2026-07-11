"""Local-first privacy and external-service opt-in report."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping


def load_config(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def privacy_opt_in_report(config: Mapping[str, Any] | None) -> dict[str, Any]:
    cfg = dict(config or {})
    agent_pipeline = _dict(cfg.get("agent_pipeline"))
    llm = _dict(cfg.get("llm"))
    agent = _dict(llm.get("agent"))
    conversation_provider = str(agent.get("provider") or "hermes").strip().lower()
    pipeline_enabled = agent_pipeline.get("enabled") is not False

    auto_notion = bool(agent_pipeline.get("auto_send_notion"))
    external_channels = ["notion"] if auto_notion else []

    return {
        "schema_version": 1,
        "ok": pipeline_enabled,
        "transcription": {
            "owner": "agent",
            "provider": "hermes",
            "yulu_executor": False,
            "ok": pipeline_enabled,
        },
        "conversation": {
            "owner": "agent",
            "provider": conversation_provider,
            "yulu_executor": False,
            "ok": llm.get("enabled") is not False,
        },
        "summary_delivery": {
            "owner": "hermes",
            "auto_channel": "notion" if auto_notion else "file",
            "auto_external_opt_in": auto_notion,
            "external_opt_in_channels": external_channels,
            "ok": True,
        },
    }
