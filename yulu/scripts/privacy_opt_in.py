"""Local-first privacy and external-service opt-in report."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping


CLOUD_TRANSCRIPTION_MODES = {"cloud-fallback", "cloud-priority"}
TRANSCRIPTION_MODES = {"local", *CLOUD_TRANSCRIPTION_MODES}
EXTERNAL_SUMMARY_CHANNELS = {"notion", "zulip", "telegram"}


def load_config(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _command_configured(value: Any) -> bool:
    return isinstance(value, list) and any(str(part).strip() for part in value)


def _connector_send_summary(connectors: Mapping[str, Any]) -> dict[str, bool]:
    out: dict[str, bool] = {}
    for channel in ("notion", "zulip"):
        section = _dict(connectors.get(channel))
        out[channel] = bool(section.get("send_summary"))
    return out


def privacy_opt_in_report(config: Mapping[str, Any] | None) -> dict[str, Any]:
    cfg = dict(config or {})
    transcription = _dict(cfg.get("transcription"))
    output = _dict(cfg.get("output"))
    connectors = _dict(cfg.get("connectors"))

    mode = str(transcription.get("mode") or "local").strip().lower()
    cloud_opt_in = mode in CLOUD_TRANSCRIPTION_MODES
    command_configured = _command_configured(transcription.get("cloud_command"))
    transcription_ok = mode in TRANSCRIPTION_MODES and (not cloud_opt_in or command_configured)

    output_channel = str(output.get("channel") or "file").strip().lower()
    auto_external = output_channel in EXTERNAL_SUMMARY_CHANNELS
    manual_connector_opt_ins = _connector_send_summary(connectors)
    manual_channels = [name for name, enabled in manual_connector_opt_ins.items() if enabled]
    external_channels = []
    if auto_external:
        external_channels.append(output_channel)
    for channel in manual_channels:
        if channel not in external_channels:
            external_channels.append(channel)

    return {
        "schema_version": 1,
        "ok": transcription_ok,
        "transcription": {
            "mode": mode,
            "local_default": mode == "local",
            "cloud_opt_in": cloud_opt_in,
            "cloud_command_configured": command_configured,
            "ok": transcription_ok,
        },
        "summary_delivery": {
            "auto_channel": output_channel,
            "auto_external_opt_in": auto_external,
            "manual_connector_opt_ins": manual_connector_opt_ins,
            "external_opt_in_channels": external_channels,
            "ok": True,
        },
    }
