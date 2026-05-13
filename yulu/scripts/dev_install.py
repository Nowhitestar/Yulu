#!/usr/bin/env python3
"""Dry-run installer for Yulu development checkouts.

For now this is intentionally non-mutating by default. It shows what a future
`make dev-install` would copy and refuses to proceed while Yulu appears to be
recording.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUNTIME_ROOT = Path.home() / ".yulu"
DEFAULT_CONFIG_DIR = Path.home() / ".config/yulu"

RUNTIME_ITEMS = [
    "install.sh",
    "skills/yulu/SKILL.md",
    "yulu/SKILL.md",
    "yulu/scripts",
]


def _socket_status(config_dir: Path) -> dict:
    sock = config_dir / "audio_daemon.sock"
    if not sock.exists():
        return {"exists": False, "recording": False}
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(1.0)
            s.connect(str(sock))
            s.sendall(b'{"action":"status"}\n')
            data = s.recv(4096).decode("utf-8", errors="replace")
        parsed = json.loads(data)
        return {"exists": True, "ok": True, "recording": bool(parsed.get("recording")), "response": parsed}
    except Exception as exc:
        return {"exists": True, "ok": False, "recording": False, "error": str(exc)}


def plan(source_root: Path, runtime_root: Path, config_dir: Path) -> dict:
    status = _socket_status(config_dir)
    copies = []
    for rel in RUNTIME_ITEMS:
        src = source_root / rel
        dst = runtime_root / rel
        copies.append({"source": str(src), "dest": str(dst), "exists": src.exists()})
    return {
        "source_root": str(source_root),
        "runtime_root": str(runtime_root),
        "config_dir": str(config_dir),
        "recording": bool(status.get("recording")),
        "socket": status,
        "copies": copies,
    }


def print_plan(data: dict) -> None:
    print("Yulu dev-install dry run")
    print(f"source:  {data['source_root']}")
    print(f"runtime: {data['runtime_root']}")
    print(f"recording: {data['recording']}")
    print("planned copies:")
    for item in data["copies"]:
        mark = "✓" if item["exists"] else "!"
        print(f"  {mark} {item['source']} -> {item['dest']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Yulu dev install dry-run")
    parser.add_argument("--source-root", type=Path, default=SOURCE_ROOT)
    parser.add_argument("--runtime-root", type=Path, default=DEFAULT_RUNTIME_ROOT)
    parser.add_argument("--config-dir", type=Path, default=DEFAULT_CONFIG_DIR)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--apply", action="store_true", help="reserved for future use; currently refuses to mutate")
    args = parser.parse_args(argv)

    data = plan(args.source_root.resolve(), args.runtime_root.expanduser(), args.config_dir.expanduser())
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print_plan(data)
    if data["recording"]:
        print("Refusing to install while Yulu is recording.", file=sys.stderr)
        return 2
    if args.apply:
        print("Apply mode is not implemented yet; use this as a dry-run scaffold.", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
