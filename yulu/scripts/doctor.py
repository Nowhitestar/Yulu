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
