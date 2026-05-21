#!/usr/bin/env python3
"""Yulu development/runtime doctor.

Read-only checks for the repository, local runtime, launchd/process leftovers,
configuration, and required tools. This script must never mutate runtime state.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any

DEFAULT_SOURCE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUNTIME_ROOT = Path.home() / ".yulu"
DEFAULT_LEGACY_ROOT = Path.home() / ".openclaw/workspace/meeting-assistant/yulu"
DEFAULT_CONFIG_DIR = Path.home() / ".config/yulu"


def _run(cmd: list[str], timeout: int = 5, cwd: Path | None = None) -> tuple[int, str, str]:
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=str(cwd) if cwd else None)
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except Exception as exc:
        return 999, "", str(exc)


def _git_info(root: Path) -> dict[str, Any]:
    if not (root / ".git").exists():
        return {"is_repo": False}
    branch = _run(["git", "branch", "--show-current"], cwd=root)[1]
    remote = _run(["git", "remote", "get-url", "origin"], cwd=root)[1]
    status = _run(["git", "status", "--short"], cwd=root)[1].splitlines()
    head = _run(["git", "rev-parse", "--short", "HEAD"], cwd=root)[1]
    return {
        "is_repo": True,
        "branch": branch,
        "remote": remote,
        "head": head,
        "dirty": bool(status),
        "status": status,
    }


def _check_command(name: str, args: list[str] | None = None) -> dict[str, Any]:
    path = shutil.which(name)
    check = {"name": name, "ok": bool(path), "path": path or ""}
    if path and args:
        code, out, err = _run([name, *args])
        check.update({"returncode": code, "version": (out or err).splitlines()[0] if (out or err) else ""})
    return check


def _socket_status(sock_path: Path, timeout: float = 3.0) -> dict[str, Any]:
    info: dict[str, Any] = {"path": str(sock_path), "exists": sock_path.exists(), "ok": False}
    if not sock_path.exists():
        return info
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(str(sock_path))
            s.sendall(b'{"action":"status"}\n')
            s.shutdown(socket.SHUT_WR)
            data = s.recv(4096)
        response = data.decode("utf-8", errors="replace").strip()
        info["ok"] = True
        info["response"] = response
        try:
            parsed = json.loads(response)
            info["recording"] = bool(parsed.get("recording"))
            info["sysReady"] = parsed.get("sysReady")
            info["micReady"] = parsed.get("micReady")
            info["sysError"] = parsed.get("sysError", "")
            info["micError"] = parsed.get("micError", "")
        except Exception:
            pass
    except Exception as exc:
        info["error"] = str(exc)
    return info


def _yulu_processes() -> list[str]:
    code, out, _ = _run(["ps", "aux"], timeout=5)
    if code != 0:
        return []
    needles = ("yulu", "Yulu.app", "audio_daemon", "transcribe.py", "realtime_transcribe", "mlx-whisper")
    return [line for line in out.splitlines() if any(n in line for n in needles) and "doctor.py" not in line]


def check_stt_daemon(config_dir: Path) -> dict[str, Any]:
    """Health check the resident stt_daemon: socket, pid, vocab DB, model load."""
    socket_path = config_dir / "stt_daemon.sock"
    pid_file = config_dir / "stt_daemon.pid"
    vocab_db = config_dir / "vocab.sqlite"
    log_file = config_dir / "logs" / "stt_daemon.log"
    report: dict[str, Any] = {
        "socket_path": str(socket_path),
        "socket_present": socket_path.exists(),
        "pid_file_present": pid_file.exists(),
        "vocab_db_present": vocab_db.exists(),
        "log_path": str(log_file),
        "log_present": log_file.exists(),
        "vocab_term_count": None,
        "daemon_reachable": False,
        "model_loaded": None,
        "in_flight_jobs": None,
        "active_sessions": None,
        "error": None,
    }

    if vocab_db.exists():
        try:
            import sqlite3
            conn = sqlite3.connect(str(vocab_db))
            try:
                row = conn.execute("SELECT COUNT(*) FROM custom_words").fetchone()
                report["vocab_term_count"] = row[0]
            finally:
                conn.close()
        except sqlite3.DatabaseError as exc:
            report["error"] = f"vocab.sqlite read error: {exc}"

    if socket_path.exists():
        try:
            import asyncio
            async def _ask() -> dict[str, Any]:
                reader, writer = await asyncio.wait_for(
                    asyncio.open_unix_connection(str(socket_path)), timeout=2.0
                )
                writer.write(b'{"type":"health"}\n')
                await writer.drain()
                line = await asyncio.wait_for(reader.readline(), timeout=2.0)
                writer.close()
                try:
                    await writer.wait_closed()
                except (ConnectionResetError, BrokenPipeError):
                    pass
                return json.loads(line.decode())
            payload = asyncio.run(_ask())
            report["daemon_reachable"] = True
            report["model_loaded"] = payload.get("model_loaded")
            report["in_flight_jobs"] = payload.get("in_flight_jobs")
            report["active_sessions"] = payload.get("active_sessions")
        except Exception as exc:
            report["error"] = f"health rpc failed: {exc}"

    return report


def collect_report(
    source_root: Path = DEFAULT_SOURCE_ROOT,
    runtime_root: Path = DEFAULT_RUNTIME_ROOT,
    legacy_root: Path = DEFAULT_LEGACY_ROOT,
    config_dir: Path = DEFAULT_CONFIG_DIR,
) -> dict[str, Any]:
    source_root = Path(source_root).expanduser().resolve()
    runtime_root = Path(runtime_root).expanduser()
    legacy_root = Path(legacy_root).expanduser()
    config_dir = Path(config_dir).expanduser()

    processes = _yulu_processes()
    legacy_processes = [p for p in processes if str(legacy_root) in p]
    runtime_processes = [p for p in processes if str(runtime_root) in p]

    checks = [
        _check_command("python3", ["--version"]),
        _check_command("ffmpeg", ["-version"]),
        _check_command("ffprobe", ["-version"]),
        _check_command("swiftc", ["--version"]),
        _check_command("codex", ["--version"]),
        _check_command("gh", ["--version"]),
    ]

    queue_path = config_dir / "agent-queue.json"
    config_path = config_dir / "config.json"
    queue_entries = None
    if queue_path.exists():
        try:
            data = json.loads(queue_path.read_text(encoding="utf-8"))
            queue_entries = len(data) if isinstance(data, list) else None
        except Exception:
            queue_entries = None

    return {
        "source_root": str(source_root),
        "source_git": _git_info(source_root),
        "runtime_root": str(runtime_root),
        "runtime_exists": runtime_root.exists(),
        "legacy_root": str(legacy_root),
        "legacy_root_exists": legacy_root.exists(),
        "config_dir": str(config_dir),
        "config_exists": config_dir.exists(),
        "config_path_exists": config_path.exists(),
        "queue_path_exists": queue_path.exists(),
        "queue_entries": queue_entries,
        "socket": _socket_status(config_dir / "audio_daemon.sock"),
        "stt_daemon": check_stt_daemon(config_dir),
        "processes": processes,
        "legacy_processes": legacy_processes,
        "runtime_processes": runtime_processes,
        "checks": checks,
    }


def _overall_ok(report: dict[str, Any]) -> bool:
    required = ["python3"]
    checks = {c["name"]: c for c in report.get("checks", [])}
    if any(not checks.get(name, {}).get("ok") for name in required):
        return False
    if report.get("legacy_processes"):
        return False
    if not report.get("source_git", {}).get("is_repo"):
        return False
    return True


def print_human(report: dict[str, Any]) -> None:
    def mark(ok: bool) -> str:
        return "✓" if ok else "!"

    git = report["source_git"]
    print("Yulu doctor")
    print(f"{mark(git.get('is_repo', False))} source: {report['source_root']}")
    if git.get("is_repo"):
        dirty = "dirty" if git.get("dirty") else "clean"
        print(f"  branch={git.get('branch')} head={git.get('head')} {dirty}")
        print(f"  remote={git.get('remote')}")
    print(f"{mark(report['runtime_exists'])} runtime: {report['runtime_root']}")
    print(f"{mark(not report['legacy_processes'])} legacy root: {report['legacy_root']} exists={report['legacy_root_exists']} legacy_processes={len(report['legacy_processes'])}")
    print(f"{mark(report['config_exists'])} config: {report['config_dir']} queue_entries={report['queue_entries']}")
    sock = report["socket"]
    print(f"{mark(sock.get('ok', False))} audio daemon socket: {sock.get('path')} exists={sock.get('exists')}")
    if sock.get("ok") and (sock.get("sysReady") is not None or sock.get("micReady") is not None):
        sys_part = f"sysReady={sock.get('sysReady')}"
        mic_part = f"micReady={sock.get('micReady')}"
        err_part = ""
        if sock.get("sysError"):
            err_part += f" sysError={sock.get('sysError')}"
        if sock.get("micError"):
            err_part += f" micError={sock.get('micError')}"
        print(f"  {sys_part} {mic_part}{err_part}")
        if sock.get("sysReady") is False:
            print("  repair: yulu repair-permissions --reset")
    sd = report.get("stt_daemon", {})
    if sd:
        print(f"{mark(sd.get('daemon_reachable', False))} stt_daemon socket: {sd.get('socket_path')} present={sd.get('socket_present')} reachable={sd.get('daemon_reachable')}")
        if sd.get("vocab_term_count") is not None:
            print(f"  vocab terms: {sd['vocab_term_count']}")
        if sd.get("daemon_reachable"):
            print(f"  model_loaded={sd.get('model_loaded')} in_flight={sd.get('in_flight_jobs')} sessions={sd.get('active_sessions')}")
        elif sd.get("error"):
            print(f"  error: {sd['error']}")
    for check in report["checks"]:
        print(f"{mark(check['ok'])} {check['name']}: {check.get('path') or 'missing'}")
    if report["legacy_processes"]:
        print("\nLegacy Yulu processes detected:")
        for line in report["legacy_processes"]:
            print(f"  {line}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only Yulu development/runtime doctor")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    parser.add_argument("--source-root", type=Path, default=DEFAULT_SOURCE_ROOT)
    parser.add_argument("--runtime-root", type=Path, default=DEFAULT_RUNTIME_ROOT)
    parser.add_argument("--legacy-root", type=Path, default=DEFAULT_LEGACY_ROOT)
    parser.add_argument("--config-dir", type=Path, default=DEFAULT_CONFIG_DIR)
    args = parser.parse_args(argv)

    report = collect_report(args.source_root, args.runtime_root, args.legacy_root, args.config_dir)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_human(report)
    return 0 if _overall_ok(report) else 1


if __name__ == "__main__":
    raise SystemExit(main())
