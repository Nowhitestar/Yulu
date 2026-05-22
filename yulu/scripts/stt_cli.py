"""`yulu stt` CLI — status/warm-up/logs/restart against the running daemon."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Optional

DEFAULT_SOCKET = Path.home() / ".config" / "yulu" / "stt_daemon.sock"
DEFAULT_LOG = Path.home() / ".config" / "yulu" / "logs" / "stt_daemon.log"
DEFAULT_PID = Path.home() / ".config" / "yulu" / "stt_daemon.pid"
LAUNCHD_LABEL = "com.yulu.sttdaemon"


async def _request_response(socket_path: Path, payload: dict, timeout: float = 5.0) -> Optional[dict]:
    if not socket_path.exists():
        return None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(str(socket_path)), timeout=timeout
        )
    except (FileNotFoundError, ConnectionRefusedError, asyncio.TimeoutError, TimeoutError, OSError):
        return None
    try:
        writer.write((json.dumps(payload) + "\n").encode())
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=timeout)
        if not line:
            return None
        return json.loads(line.decode())
    except (TimeoutError, asyncio.TimeoutError, json.JSONDecodeError):
        return None
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionResetError, BrokenPipeError):
            pass


def _cmd_status(args: argparse.Namespace) -> int:
    payload = asyncio.run(_request_response(Path(args.socket), {"type": "health"}))
    if payload is None or payload.get("type") != "health_response":
        report = {"ready": False, "error": "daemon not reachable"}
        if args.json:
            print(json.dumps(report))
        else:
            print("daemon: not reachable")
        return 1
    if args.json:
        print(json.dumps(payload))
    else:
        print(
            f"daemon:  ready (vocab={payload['vocab_size']}, "
            f"in_flight={payload['in_flight_jobs']}, "
            f"sessions={payload['active_sessions']})"
        )
    return 0


def _cmd_warm_up(args: argparse.Namespace) -> int:
    payload = asyncio.run(_request_response(
        Path(args.socket), {"type": "warm_up", "engine": args.engine}
    ))
    if payload is None:
        print("daemon not reachable", file=sys.stderr)
        return 1
    if payload.get("type") == "error":
        print(payload.get("message", "error"), file=sys.stderr)
        return 1
    print(payload.get("detail", "ok"))
    return 0


def _cmd_logs(args: argparse.Namespace) -> int:
    path = Path(args.log_path)
    if not path.exists():
        print(f"log not found: {path}", file=sys.stderr)
        return 1
    if args.tail <= 0:
        sys.stdout.write(path.read_text(encoding="utf-8"))
        return 0
    lines = path.read_text(encoding="utf-8").splitlines()
    for line in lines[-args.tail:]:
        print(line)
    return 0


def _cmd_restart(args: argparse.Namespace) -> int:
    rc = subprocess.run(
        ["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"],
        capture_output=True,
    ).returncode
    if rc == 0:
        print(f"restarted via launchd: {LAUNCHD_LABEL}")
        return 0
    try:
        pid = int(Path(args.pid_file).read_text().strip())
        os.kill(pid, signal.SIGTERM)
        print(f"sent SIGTERM to pid {pid}")
        return 0
    except (OSError, ValueError):
        print("could not signal daemon and launchctl kickstart failed", file=sys.stderr)
        return 1


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="yulu stt")
    sub = p.add_subparsers(dest="cmd", required=True)

    ps = sub.add_parser("status")
    ps.add_argument("--json", action="store_true")

    pw = sub.add_parser("warm-up")
    pw.add_argument("--engine", default="mlx")

    pl = sub.add_parser("logs")
    pl.add_argument("--tail", type=int, default=50)
    pl.add_argument("--log-path", default=str(DEFAULT_LOG))

    sub.add_parser("restart")

    return p


_GLOBAL_FLAGS = {
    "--socket": str(DEFAULT_SOCKET),
    "--pid-file": str(DEFAULT_PID),
}


def _extract_global_flags(argv: list[str]) -> tuple[dict[str, str], list[str]]:
    """Extract --socket and --pid-file from argv regardless of position.

    Returns (extracted_values, remaining_argv).  Mirrors the _extract_db_from_argv
    pattern used in the vocab CLI so that flags work before or after the subcommand.
    """
    values = dict(_GLOBAL_FLAGS)
    remaining: list[str] = []
    i = 0
    while i < len(argv):
        matched = False
        for flag in _GLOBAL_FLAGS:
            if argv[i] == flag and i + 1 < len(argv):
                values[flag] = argv[i + 1]
                i += 2
                matched = True
                break
            if argv[i].startswith(flag + "="):
                values[flag] = argv[i][len(flag) + 1:]
                i += 1
                matched = True
                break
        if not matched:
            remaining.append(argv[i])
            i += 1
    return values, remaining


def main(argv: Optional[list[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    # Pre-extract global flags so they work before or after the subcommand.
    global_vals, remaining_argv = _extract_global_flags(list(argv))

    parser = _build_parser()
    args = parser.parse_args(remaining_argv)

    # Inject extracted global values into namespace.
    args.socket = global_vals["--socket"]
    args.pid_file = global_vals["--pid-file"]

    handlers = {
        "status": _cmd_status,
        "warm-up": _cmd_warm_up,
        "logs": _cmd_logs,
        "restart": _cmd_restart,
    }
    return handlers[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
