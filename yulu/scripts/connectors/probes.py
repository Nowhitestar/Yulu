"""Read-only connector probes.

These probes never read credentials and never execute user-configured commands. They only
look for known plugin folders, fixed CLI names, or importable Python packages.
"""

from __future__ import annotations

import json
import os
from configparser import ConfigParser
from collections import deque
from pathlib import Path

from capabilities import report
from capabilities.probes import daemon_python, probe_module_spec
from capabilities.report import Capability, Provenance, Status


def _default_plugin_roots() -> list[Path]:
    roots: list[Path] = []
    env = os.environ.get("YULU_AGENT_PLUGIN_ROOTS", "")
    roots.extend(Path(p).expanduser() for p in env.split(os.pathsep) if p)
    home = Path.home()
    roots.extend([
        home / ".codex" / "plugins" / "cache",
        home / ".agents" / "plugins",
        home / ".claude" / "plugins",
        home / ".config" / "claude" / "plugins",
    ])
    return roots


def _walk_bounded(root: Path, max_depth: int = 4):
    queue: deque[tuple[Path, int]] = deque([(root, 0)])
    while queue:
        path, depth = queue.popleft()
        yield path
        if depth >= max_depth:
            continue
        try:
            children = list(path.iterdir())
        except OSError:
            continue
        for child in children:
            if child.is_dir():
                queue.append((child, depth + 1))


def probe_agent_plugin(connector_id: str, aliases: tuple[str, ...] = ()) -> Capability:
    names = tuple({connector_id.lower(), *(alias.lower() for alias in aliases)})
    try:
        for root in _default_plugin_roots():
            if not root.exists():
                continue
            for path in _walk_bounded(root):
                name = path.name.lower()
                if any(alias in name for alias in names):
                    return Capability(
                        Provenance.AGENT_CONFIG,
                        Status.USABLE,
                        str(path),
                        "agent plugin detected",
                    )
        return report.absent(f"{connector_id} agent plugin not found")
    except Exception as exc:
        return report.absent(str(exc))


def probe_python_module(module: str) -> Capability:
    try:
        present, detail = probe_module_spec(module)
        if not present:
            return report.absent(detail or f"{module} not installed")
        return Capability(
            Provenance.HOST_PATH,
            Status.USABLE,
            daemon_python(),
            detail or f"{module} importable",
        )
    except Exception as exc:
        return report.absent(str(exc))


def probe_zuliprc(path: str = "~/.zuliprc") -> Capability:
    rc_path = Path(path).expanduser()
    try:
        parser = ConfigParser()
        if not rc_path.exists():
            return report.absent("zuliprc not found")
        parser.read(rc_path, encoding="utf-8")
        api = parser["api"] if parser.has_section("api") else {}
        if not api.get("email") or not api.get("key") or not api.get("site"):
            return report.absent("zuliprc missing email, key, or site")
        return Capability(
            Provenance.HOST_PATH,
            Status.USABLE,
            str(rc_path),
            "zuliprc configured",
        )
    except Exception as exc:
        return report.absent(str(exc))


def probe_notion_token(env_names: tuple[str, ...] = ("NOTION_API_KEY", "NOTION_TOKEN")) -> Capability:
    try:
        for name in env_names:
            if os.environ.get(name):
                return Capability(
                    Provenance.HOST_PATH,
                    Status.USABLE,
                    name,
                    f"{name} configured",
                )
        return report.absent("/".join(env_names) + " not set")
    except Exception as exc:
        return report.absent(str(exc))


def probe_notion_mcp_token(path: str = "~/.config/yulu/notion-mcp-token.json") -> Capability:
    token_path = Path(path).expanduser()
    try:
        if not token_path.exists():
            return report.absent("Notion MCP OAuth token not found")
        data = json.loads(token_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not data.get("access_token"):
            return report.absent("Notion MCP token file is incomplete")
        return Capability(
            Provenance.HOST_PATH,
            Status.PRESENT_BUT_UNVERIFIED,
            str(token_path),
            "Notion MCP OAuth token stored; MCP tool bridge pending",
        )
    except Exception as exc:
        return report.absent(str(exc))


__all__ = [
    "probe_agent_plugin",
    "probe_python_module",
    "probe_zuliprc",
    "probe_notion_token",
    "probe_notion_mcp_token",
]
