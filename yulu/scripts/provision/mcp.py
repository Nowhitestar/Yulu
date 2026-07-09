#!/usr/bin/env python3
"""Yulu HTTP MCP registration.

Core install owns the local server; this module owns the per-agent pointer to it.
All subprocess calls are argv lists.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

ENDPOINT = "http://127.0.0.1:7777/mcp"
ENV_NAME = "YULU_MCP_TOKEN"
CONFIG_DIR = Path.home() / ".config" / "yulu"
TOKEN_PATH = CONFIG_DIR / "mcp-token.json"
AGENTS = ("codex", "claude", "openclaw", "hermes")


def ensure_token(path: Path = TOKEN_PATH, rotate: bool = False) -> str:
    if not rotate:
        token = read_token(path)
        if token:
            chmod_600(path)
            return token
    token = secrets.token_urlsafe(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps({
        "token": token,
        "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "endpoint": ENDPOINT,
    }, indent=2) + "\n", encoding="utf-8")
    chmod_600(tmp)
    os.replace(tmp, path)
    chmod_600(path)
    return token


def read_token(path: Path = TOKEN_PATH) -> str:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return ""
    token = raw.get("token")
    return token if isinstance(token, str) and token else ""


def chmod_600(path: Path) -> None:
    try:
        path.chmod(0o600)
    except OSError:
        pass


def normalize_agent(agent: str) -> str:
    key = agent.strip().lower().replace("_", "-")
    aliases = {
        "claude-code": "claude",
        "open-cloud": "openclaw",
        "openclaw": "openclaw",
        "codex": "codex",
        "claude": "claude",
        "hermes": "hermes",
    }
    if key not in aliases:
        raise ValueError(f"unknown agent: {agent} (valid: {', '.join(AGENTS)})")
    return aliases[key]


def wanted_agents(args: argparse.Namespace) -> list[str]:
    raw = args.agents or list(AGENTS)
    agents = []
    for item in raw:
        agent = normalize_agent(item)
        if agent not in agents:
            agents.append(agent)
    if getattr(args, "detected_only", False):
        agents = [agent for agent in agents if detected(agent)]
    return agents


def detected(agent: str) -> bool:
    if agent in {"codex", "claude"}:
        return shutil.which(agent) is not None
    if agent == "hermes":
        return shutil.which("hermes") is not None or (Path.home() / ".hermes" / "config.yaml").exists()
    if agent == "openclaw":
        return shutil.which("openclaw") is not None or (Path.home() / ".openclaw" / "openclaw.json").exists()
    return False


def run(argv: list[str], *, non_fatal: bool) -> bool:
    if shutil.which(argv[0]) is None:
        print(f"skip: {argv[0]} not found")
        return non_fatal
    proc = subprocess.run(argv, text=True)
    if proc.returncode == 0:
        return True
    print(f"warn: {' '.join(argv[:4])} failed with {proc.returncode}", file=sys.stderr)
    return non_fatal


def set_launchctl_env(token: str) -> None:
    if shutil.which("launchctl") is None:
        return
    subprocess.run(["launchctl", "setenv", ENV_NAME, token], text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def install_agent(agent: str, token: str, endpoint: str, *, non_fatal: bool) -> bool:
    if agent == "codex":
        set_launchctl_env(token)
        run(["codex", "mcp", "remove", "yulu"], non_fatal=True)
        return run(["codex", "mcp", "add", "yulu", "--url", endpoint, "--bearer-token-env-var", ENV_NAME], non_fatal=non_fatal)
    if agent == "claude":
        run(["claude", "mcp", "remove", "yulu", "--scope", "user"], non_fatal=True)
        return run(["claude", "mcp", "add", "--scope", "user", "--transport", "http", "yulu", endpoint, "--header", f"Authorization: Bearer {token}"], non_fatal=non_fatal)
    if agent == "openclaw":
        payload = json.dumps({"url": endpoint, "transport": "streamable-http", "headers": {"Authorization": f"Bearer {token}"}}, separators=(",", ":"))
        if shutil.which("openclaw"):
            return run(["openclaw", "mcp", "set", "yulu", payload], non_fatal=non_fatal)
        write_openclaw_config(payload)
        return True
    if agent == "hermes":
        if shutil.which("hermes"):
            run(["hermes", "mcp", "remove", "yulu"], non_fatal=True)
            run(["hermes", "mcp", "add", "yulu", "--url", endpoint, "--auth", "header"], non_fatal=True)
        write_hermes_config(endpoint, token)
        return True
    raise ValueError(agent)


def remove_agent(agent: str, *, non_fatal: bool) -> bool:
    if agent == "codex":
        return run(["codex", "mcp", "remove", "yulu"], non_fatal=non_fatal)
    if agent == "claude":
        return run(["claude", "mcp", "remove", "yulu", "--scope", "user"], non_fatal=non_fatal)
    if agent == "openclaw":
        if shutil.which("openclaw"):
            return run(["openclaw", "mcp", "unset", "yulu"], non_fatal=non_fatal)
        unset_openclaw_config()
        return True
    if agent == "hermes":
        if shutil.which("hermes"):
            run(["hermes", "mcp", "remove", "yulu"], non_fatal=True)
        unset_hermes_config()
        return True
    raise ValueError(agent)


def write_openclaw_config(payload_json: str) -> None:
    path = Path.home() / ".openclaw" / "openclaw.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    data.setdefault("mcp", {}).setdefault("servers", {})["yulu"] = json.loads(payload_json)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    chmod_600(path)


def unset_openclaw_config() -> None:
    path = Path.home() / ".openclaw" / "openclaw.json"
    if not path.exists():
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    servers = data.get("mcp", {}).get("servers", {})
    if isinstance(servers, dict):
        servers.pop("yulu", None)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    chmod_600(path)


def write_hermes_config(endpoint: str, token: str) -> None:
    path = Path.home() / ".hermes" / "config.yaml"
    block = (
        "  yulu:\n"
        f"    url: {endpoint}\n"
        "    headers:\n"
        f"      Authorization: Bearer {token}\n"
        "    enabled: true\n"
        "    timeout: 120\n"
        "    connect_timeout: 20\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    path.write_text(replace_yaml_child(text, "mcp_servers", "yulu", block), encoding="utf-8")
    chmod_600(path)


def unset_hermes_config() -> None:
    path = Path.home() / ".hermes" / "config.yaml"
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    path.write_text(replace_yaml_child(text, "mcp_servers", "yulu", ""), encoding="utf-8")
    chmod_600(path)


def replace_yaml_child(text: str, section: str, child: str, block: str) -> str:
    lines = text.splitlines(keepends=True)
    header = f"{section}:"
    start = next((i for i, line in enumerate(lines) if line.strip() == header), -1)
    if start < 0:
        prefix = text if text.endswith("\n") or not text else text + "\n"
        return prefix + header + "\n" + block
    end = start + 1
    while end < len(lines) and (lines[end].startswith(" ") or not lines[end].strip()):
        end += 1
    child_start = next((i for i in range(start + 1, end) if lines[i].startswith(f"  {child}:")), -1)
    if child_start >= 0:
        child_end = child_start + 1
        while child_end < end and not (lines[child_end].startswith("  ") and not lines[child_end].startswith("    ") and lines[child_end].strip().endswith(":")):
            child_end += 1
        lines[child_start:child_end] = [block] if block else []
    elif block:
        lines.insert(end, block)
    return "".join(lines)


def cmd_install(args: argparse.Namespace) -> int:
    token = ensure_token(rotate=False)
    agents = wanted_agents(args)
    if not agents:
        print("No requested agents detected; MCP registration skipped.")
        return 0
    ok = True
    for agent in agents:
        print(f"Installing Yulu MCP for {agent}...")
        ok = install_agent(agent, token, args.endpoint, non_fatal=args.non_fatal) and ok
    return 0 if ok or args.non_fatal else 1


def cmd_remove(args: argparse.Namespace) -> int:
    agents = wanted_agents(args)
    if not agents:
        print("No requested agents detected; MCP cleanup skipped.")
        return 0
    ok = True
    for agent in agents:
        print(f"Removing Yulu MCP from {agent}...")
        ok = remove_agent(agent, non_fatal=args.non_fatal) and ok
    return 0 if ok or args.non_fatal else 1


def cmd_rotate(args: argparse.Namespace) -> int:
    ensure_token(rotate=True)
    print(f"Rotated {TOKEN_PATH}")
    return cmd_install(args)


def cmd_status(args: argparse.Namespace) -> int:
    print(json.dumps({
        "endpoint": args.endpoint,
        "tokenFile": str(TOKEN_PATH),
        "tokenPresent": bool(read_token()),
        "agents": {agent: {"detected": detected(agent), "configured": configured(agent)} for agent in AGENTS},
    }, indent=2))
    return 0


def configured(agent: str) -> Optional[bool]:
    if agent == "codex":
        path = Path.home() / ".codex" / "config.toml"
        return path.exists() and "[mcp_servers.yulu]" in path.read_text(encoding="utf-8", errors="ignore")
    if agent == "openclaw":
        path = Path.home() / ".openclaw" / "openclaw.json"
        try:
            return "yulu" in json.loads(path.read_text(encoding="utf-8")).get("mcp", {}).get("servers", {})
        except Exception:
            return False
    if agent == "hermes":
        path = Path.home() / ".hermes" / "config.yaml"
        return path.exists() and "\n  yulu:" in ("\n" + path.read_text(encoding="utf-8", errors="ignore"))
    return None


def cmd_test(args: argparse.Namespace) -> int:
    token = read_token()
    if not token:
        print(f"token missing at {TOKEN_PATH}", file=sys.stderr)
        return 1
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "yulu-mcp-test", "version": "1.0"}},
    }).encode("utf-8")
    req = urllib.request.Request(
        args.endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            print(f"ok: HTTP {resp.status}")
            return 0
    except urllib.error.HTTPError as exc:
        print(f"failed: HTTP {exc.code} {exc.read().decode('utf-8', 'ignore')}", file=sys.stderr)
    except Exception as exc:
        print(f"failed: {exc}", file=sys.stderr)
    return 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="yulu mcp")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("install", "remove"):
        sp = sub.add_parser(name)
        common_args(sp)
    rotate = sub.add_parser("rotate-token")
    common_args(rotate)
    status = sub.add_parser("status")
    status.add_argument("--endpoint", default=ENDPOINT)
    test = sub.add_parser("test")
    test.add_argument("--endpoint", default=ENDPOINT)
    return p


def common_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--agent", action="append", dest="agents", help="target agent; repeatable")
    p.add_argument("--detected-only", action="store_true", help="skip agents not detected on this machine")
    p.add_argument("--non-fatal", action="store_true", help="return success after registration warnings")
    p.add_argument("--endpoint", default=ENDPOINT)


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        if args.cmd == "install":
            return cmd_install(args)
        if args.cmd == "remove":
            return cmd_remove(args)
        if args.cmd == "rotate-token":
            return cmd_rotate(args)
        if args.cmd == "status":
            return cmd_status(args)
        if args.cmd == "test":
            return cmd_test(args)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
