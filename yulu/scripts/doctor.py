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


def _install_info(root: Path) -> dict[str, Any]:
    install_path = root / ".yulu-install.json"
    info: dict[str, Any] = {"present": install_path.exists(), "path": str(install_path)}
    if not install_path.exists():
        return info
    try:
        data = json.loads(install_path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            info.update({
                "schema": data.get("schema"),
                "source": data.get("source"),
                "version": data.get("version"),
                "asset": data.get("asset"),
            })
    except Exception as exc:
        info["error"] = str(exc)
    return info


def _dependency_manager() -> Any:
    """Return a MacOSDependencyManager on Darwin, else None (guarded import).

    Routes brew-managed dependency *presence* reads through the PermissionModel/
    DependencyManager seams so the package-manager vocabulary lives behind the
    abstraction (PLAT-05). Import is lazy+guarded so doctor.py keeps working off
    Darwin or if the seam package is unavailable (it then falls back to which()).
    """
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from yulu_platform.macos import MacOSDependencyManager
        return MacOSDependencyManager()
    except Exception:
        return None


def _check_command(name: str, args: list[str] | None = None) -> dict[str, Any]:
    path = shutil.which(name)
    # Presence read routes through the DependencyManager seam when available;
    # falls back to the which() result off Darwin / when the seam is absent.
    ok = bool(path)
    mgr = _dependency_manager()
    if mgr is not None:
        try:
            ok = bool(mgr.is_available(name))
        except Exception:
            ok = bool(path)
    check = {"name": name, "ok": ok, "path": path or ""}
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


def check_search_index(config_dir: Path) -> dict[str, Any]:
    """Phase 6 health check: open search.sqlite via search.reader.doctor()
    and return a uniform dict. Always returns a dict — never raises —
    so doctor.py can render it inline even if FTS5 or the module is
    unavailable."""
    db_path = config_dir / "search.sqlite"
    report: dict[str, Any] = {
        "db_path": str(db_path),
        "present": db_path.exists(),
        "ok": False,
    }
    if not db_path.exists():
        report["error"] = "search.sqlite not initialized (run setup.sh or `yulu search --reindex`)"
        return report
    try:
        # Lazy import so doctor.py keeps working even if search.indexer
        # has a typo / unreadable schema.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from search.reader import doctor as _doctor
        from search.indexer import SEARCH_DB_PATH as _DEFAULT_DB
        # Use the requested db_path explicitly so a non-standard config_dir
        # still produces a meaningful report (tests rely on this).
        if db_path == _DEFAULT_DB:
            health = _doctor()
        else:
            health = _doctor(db_path=db_path)
        report.update(health)
        report["ok"] = bool(health.get("integrity_ok"))
    except Exception as exc:
        report["error"] = f"search doctor failed: {exc}"
    return report


def _host_capabilities(config_dir: Path, runtime_root: Path) -> dict[str, Any]:
    """Assemble the versioned ``host_capabilities`` section (DETECT-01/03/05).

    Mirrors :func:`check_search_index`'s lazy-import + never-raise contract: it inserts the
    scripts dir on ``sys.path``, guardedly imports the stdlib-only ``capabilities`` module,
    and builds a :class:`HostCapabilityReport` from Plan 01's probes plus Plan 02's providers.

    The six DETECT-03 probes are folded in directly:
    ``claude`` / ``whisper_cli`` (login-shell PATH via ``probe_command``), ``mlx_whisper``
    (daemon-interpreter importability), ``llm_command`` (RESOLVED + statted, NEVER executed —
    T-03-01), ``models`` (path-bounded model scan), and ``recording_dir`` (writability via the
    Phase 2 PathResolver). Then every ``default_providers()`` entry's ``capabilities()`` dict is
    merged (``agent-config`` provenance) — so the ClaudeCodeProvider's ``claude_cli`` /
    ``agent_mlx_whisper`` reach the report end-to-end (DETECT-05).

    The WHOLE body is wrapped in try/except so any failure degrades to
    ``{"error": str(exc), "schema_version": 1, "capabilities": {}}`` — this NEVER raises and
    never hangs ``yulu doctor`` (the doctor never-raise contract; T-03-07). It is read-only:
    no subprocess executes the configured ``llm.command`` and nothing mutates runtime state.

    ``runtime_root`` is accepted for symmetry with the other runtime-scoped checks (the probes
    resolve their own well-known roots today); it lets a future revision scope model/recording
    discovery to the running install without changing this signature.
    """
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from capabilities.probes import (
            probe_command,
            probe_diarization,
            probe_llm_command,
            probe_mlx_whisper,
            probe_recording_dir,
            scan_models,
        )
        from capabilities.provider import default_providers
        from capabilities.report import HostCapabilityReport

        report = HostCapabilityReport()
        # The six DETECT-03 capabilities (claude/whisper-cli/mlx-whisper/llm.command/models/dir).
        report.capabilities["claude"] = probe_command("claude", ("--version",))
        report.capabilities["whisper_cli"] = probe_command("whisper-cli", ("--version",))
        report.capabilities["mlx_whisper"] = probe_mlx_whisper()
        # llm.command is RESOLVED + statted only — the configured command is never executed.
        report.capabilities["llm_command"] = probe_llm_command(config_dir / "config.json")
        report.capabilities["models"] = scan_models()
        report.capabilities["recording_dir"] = probe_recording_dir()
        # diarization (v0.6, DIAR-04) — a Yulu-managed tri-state entry (usable /
        # present-but-unverified / absent). NOT an agent-config reframe: diarization is
        # provisioned + owned by Yulu, surfaced here so the UI can show readiness.
        report.capabilities["diarization"] = probe_diarization()
        # gog (Google Calendar CLI from steipete/tap/gogcli) — a host CLI with host-path
        # provenance, NOT an agent-config reframe (D-06 provider neutrality stays intact).
        # Added so REUSE-01's wording (whisper / model / claude / gog) is fully covered and
        # setup_deps.sh can gate `brew install steipete/tap/gogcli` on its tri-state.
        # probe_command resolves on the login PATH and reports USABLE even if `--version`
        # yields nothing (resolution, not version, drives usability).
        report.capabilities["gog"] = probe_command("gog", ("--version",))

        # Merge every registered provider's agent-config entries (DETECT-05). default_providers()
        # is the single Phase-8 extension point — a new provider arm flows in here with no edit.
        for provider in default_providers():
            try:
                for name, cap in provider.capabilities().items():
                    report.capabilities[name] = cap
            except Exception:
                # A misbehaving provider must not break the section (never-raise contract).
                continue

        return report.to_dict()
    except Exception as exc:
        # Degrade cleanly — same shape (schema_version + capabilities) plus an error marker.
        return {"error": str(exc), "schema_version": 1, "capabilities": {}}


def check_yulu_ui(
    script_dir: Path,
    config_dir: Path,
    timeout: float = 2.0,
) -> dict[str, Any]:
    """Phase G health check: verify yulu_ui dist artifacts, LaunchAgent, and
    /healthz. UI is optional — missing artifacts are not a doctor-level failure.
    Always returns a dict with the same keys so JSON consumers can rely on it."""
    script_dir = Path(script_dir).expanduser()
    config_dir = Path(config_dir).expanduser()

    ui_dir = script_dir / "yulu_ui"
    dist_server = ui_dir / "dist" / "server.js"
    dist_index = ui_dir / "dist" / "web" / "index.html"
    plist_path = Path.home() / "Library" / "LaunchAgents" / "com.yulu.ui.plist"
    log_path = config_dir / "ui.log"

    report: dict[str, Any] = {
        "dist_server_present": dist_server.is_file() and dist_server.stat().st_size > 0,
        "dist_web_present": dist_index.is_file() and dist_index.stat().st_size > 0,
        "plist_installed": plist_path.is_file(),
        "launchctl_loaded": False,
        "port": 7777,
        "healthz_ok": False,
        "healthz_response": None,
        "log_path": str(log_path),
        "log_present": log_path.is_file(),
        "log_size_bytes": log_path.stat().st_size if log_path.is_file() else None,
        "error": None,
    }

    # launchctl loaded?
    code, out, _ = _run(["launchctl", "list"], timeout=3)
    if code == 0 and any("com.yulu.ui" in line for line in out.splitlines()):
        report["launchctl_loaded"] = True

    # /healthz
    try:
        import urllib.request
        with urllib.request.urlopen(
            f"http://127.0.0.1:{report['port']}/healthz", timeout=timeout
        ) as resp:
            body = resp.read().decode("utf-8", errors="replace")[:200]
            report["healthz_response"] = body
            if resp.status == 200 and '"status":"ok"' in body:
                report["healthz_ok"] = True
    except Exception as exc:
        report["error"] = f"healthz fetch failed: {exc}"

    # Categorize the most actionable single error message
    if not report["dist_server_present"] or not report["dist_web_present"]:
        report["error"] = "build artifacts missing — run setup.sh --upgrade"
    elif report["plist_installed"] and not report["launchctl_loaded"]:
        report["error"] = "plist installed but service not loaded — run yulu start"

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
        "source_install": _install_info(source_root),
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
        "search_index": check_search_index(config_dir),
        # §5d fix (CONCERNS §5d, D-07): the UI check must look at the RUNTIME install, not the
        # source checkout — a production install (source_root != runtime_root) now reports the
        # installed UI dist honestly. When source_root == runtime_root (dev), behavior is unchanged.
        "yulu_ui": check_yulu_ui(runtime_root / "yulu" / "scripts", config_dir),
        "host_capabilities": _host_capabilities(config_dir, runtime_root),
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
    if not report.get("source_git", {}).get("is_repo") and not report.get("source_install", {}).get("present"):
        return False
    return True


def print_human(report: dict[str, Any]) -> None:
    def mark(ok: bool) -> str:
        return "✓" if ok else "!"

    git = report["source_git"]
    install = report.get("source_install", {})
    print("Yulu doctor")
    print(f"{mark(git.get('is_repo', False) or install.get('present', False))} source: {report['source_root']}")
    if git.get("is_repo"):
        dirty = "dirty" if git.get("dirty") else "clean"
        print(f"  branch={git.get('branch')} head={git.get('head')} {dirty}")
        print(f"  remote={git.get('remote')}")
    elif install.get("present"):
        version = install.get("version") or "unknown"
        source = install.get("source") or "unknown"
        asset = install.get("asset") or "unknown"
        print(f"  install={source} version={version} asset={asset}")
        if install.get("error"):
            print(f"  install metadata error: {install['error']}")
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
    si = report.get("search_index", {})
    if si:
        print(f"{mark(si.get('ok', False))} search index: {si.get('db_path')} present={si.get('present')}")
        if si.get("ok"):
            per_kind = si.get("per_kind", {}) or {}
            kinds_str = " ".join(f"{k}={v}" for k, v in sorted(per_kind.items())) or "(empty)"
            print(f"  total_docs={si.get('total_docs')} schema=v{si.get('schema_version')} "
                  f"last_sweep={si.get('last_full_sweep_at') or 'never'}")
            print(f"  per_kind: {kinds_str}")
        elif si.get("error"):
            print(f"  error: {si['error']}")
    ui = report.get("yulu_ui", {})
    if ui:
        ok_state = ui.get("healthz_ok", False) and ui.get("dist_server_present", False)
        size_kb = (ui.get("log_size_bytes") or 0) / 1024
        print(f"{mark(ok_state)} yulu_ui: port={ui.get('port')} "
              f"dist={ui.get('dist_server_present')} loaded={ui.get('launchctl_loaded')} "
              f"healthz={'ok' if ui.get('healthz_ok') else 'fail'}")
        if ui.get("log_present"):
            print(f"  log: {ui['log_path']} ({size_kb:.1f} KB)")
        if ui.get("error"):
            print(f"  error: {ui['error']}")
    hc = report.get("host_capabilities", {})
    if hc:
        caps = hc.get("capabilities", {}) or {}
        usable = sum(1 for c in caps.values() if c.get("status") == "usable")
        print(f"  host capabilities: schema=v{hc.get('schema_version')} "
              f"usable={usable}/{len(caps)}")
        if hc.get("error"):
            print(f"  host_capabilities error: {hc['error']}")
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
