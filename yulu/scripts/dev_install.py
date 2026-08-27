#!/usr/bin/env python3
"""Development installer for Yulu checkouts.

Default mode is a dry-run. `--apply` installs/reloads LaunchAgents so the local
machine runs the current checkout instead of an old runtime path. It refuses to
run while Yulu is recording.
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUNTIME_ROOT = Path.home() / ".yulu"
DEFAULT_CONFIG_DIR = Path.home() / ".config/yulu"
DEFAULT_LEGACY_ROOT = Path.home() / ".openclaw/workspace/meeting-assistant/yulu"
LAUNCH_AGENTS_DIR = Path.home() / "Library/LaunchAgents"
LOCAL_BIN = Path.home() / ".local/bin"

RUNTIME_ITEMS = [
    "VERSION",
    "assets/Yulu.icns",
    "install.sh",
    "skills/yulu/SKILL.md",
    "yulu/SKILL.md",
    "yulu/scripts",
]

LAUNCHAGENTS = [
    "com.yulu.audiodaemon.plist",
    "com.yulu.scheduler.plist",
    "com.yulu.detector.plist",
    "com.yulu.calendar.plist",
    "com.yulu.statusagent.plist",
    "com.yulu.ui.plist",
]

OBSOLETE_LAUNCHAGENTS = [
    "com.yulu.agentqueue.plist",
    "com.yulu.sttdaemon.plist",
]


def _run(
    cmd: list[str],
    *,
    timeout: int = 30,
    check: bool = False,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd, env=env)
    if check and result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(cmd)}\n{result.stderr or result.stdout}")
    return result


def _socket_status(config_dir: Path) -> dict:
    sock = config_dir / "audio_daemon.sock"
    if not sock.exists():
        return {"exists": False, "recording": False}
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(1.0)
            s.connect(str(sock))
            s.sendall(b'{"action":"status"}\n')
            s.shutdown(socket.SHUT_WR)
            data = s.recv(4096).decode("utf-8", errors="replace")
        parsed = json.loads(data)
        return {"exists": True, "ok": True, "recording": bool(parsed.get("recording")), "response": parsed}
    except Exception as exc:
        return {"exists": True, "ok": False, "recording": False, "error": str(exc)}


def _state_recording(config_dir: Path) -> bool:
    state_path = config_dir / ".state.json"
    if not state_path.exists():
        return False
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
        return bool(data.get("recording"))
    except Exception:
        return False


def preferred_python() -> str:
    for candidate in ("/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"):
        if Path(candidate).exists():
            return candidate
    return shutil.which("python3") or "/usr/bin/python3"


def _existing_ui_node() -> str | None:
    plist_path = LAUNCH_AGENTS_DIR / "com.yulu.ui.plist"
    try:
        data = plistlib.loads(plist_path.read_bytes())
        argv = data.get("ProgramArguments") or []
        node = argv[0] if argv else None
        return str(node) if node and Path(str(node)).exists() else None
    except Exception:
        return None


def _node_candidates() -> list[str]:
    candidates: list[str] = []
    existing = _existing_ui_node()
    if existing:
        candidates.append(existing)
    found = shutil.which("node")
    if found:
        candidates.append(found)
    nvm = Path.home() / ".nvm/versions/node"
    if nvm.exists():
        for candidate in sorted(nvm.glob("*/bin/node"), reverse=True):
            if candidate.exists():
                candidates.append(str(candidate))
    for candidate in (
        "/opt/homebrew/opt/node@20/bin/node",
        "/opt/homebrew/opt/node@22/bin/node",
        "/opt/homebrew/opt/node@24/bin/node",
        "/usr/local/opt/node@20/bin/node",
        "/usr/local/opt/node@22/bin/node",
        "/usr/local/opt/node@24/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
    ):
        if Path(candidate).exists():
            candidates.append(candidate)
    out: list[str] = []
    for candidate in candidates:
        if candidate not in out:
            out.append(candidate)
    return out


def _node_can_load_ui_native_modules(node_bin: str, ui_dir: Path | None) -> bool:
    if ui_dir is None or not (ui_dir / "node_modules/better-sqlite3").exists():
        return True
    result = _run(
        [node_bin, "-e", "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close();"],
        timeout=10,
        check=False,
        cwd=ui_dir,
    )
    return result.returncode == 0


def _compatible_node_version(node_bin: str) -> bool:
    result = _run(
        [node_bin, "-p", "process.versions.node"],
        timeout=10,
        check=False,
    )
    if result.returncode != 0:
        return False
    try:
        major, minor, *_ = (int(part) for part in result.stdout.strip().split("."))
    except (TypeError, ValueError):
        return False
    return (major == 20 and minor >= 19) or (major == 22 and minor >= 12) or major == 24


def preferred_node(script_dir: Path | None = None) -> str:
    ui_dir = script_dir / "yulu_ui" if script_dir is not None else SOURCE_ROOT / "yulu/scripts/yulu_ui"
    for candidate in _node_candidates():
        if _compatible_node_version(candidate) and _node_can_load_ui_native_modules(candidate, ui_dir):
            return candidate
    raise RuntimeError("Yulu Host requires Node.js 20.19+, 22.12+, or 24 with compatible native modules")


def _launch_path(node_bin: str | None = None) -> str:
    parts = [
        str(Path.home() / ".local/bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    if node_bin:
        parts.insert(0, str(Path(node_bin).parent))
    else:
        nvm = Path.home() / ".nvm/versions/node"
        if nvm.exists():
            for candidate in sorted(nvm.glob("*/bin"), reverse=True):
                parts.insert(0, str(candidate))
                break
    return ":".join(dict.fromkeys(parts))


def render_plist(source: Path, *, script_dir: Path, python_bin: str, home: Path, launch_path: str, node_bin: str | None = None) -> str:
    text = Path(source).read_text(encoding="utf-8")
    replacements = {
        "__PYTHON__": python_bin,
        "__NODE_BIN__": node_bin or preferred_node(script_dir),
        "__HOME__": str(home),
        "__SCRIPT_DIR__": str(script_dir),
        "__PATH__": launch_path,
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    return text


def plan(source_root: Path, runtime_root: Path, config_dir: Path, legacy_root: Path = DEFAULT_LEGACY_ROOT) -> dict:
    source_root = Path(source_root)
    runtime_root = Path(runtime_root)
    config_dir = Path(config_dir)
    socket = _socket_status(config_dir)
    recording = bool(socket.get("recording")) or _state_recording(config_dir)
    copies = []
    for rel in RUNTIME_ITEMS:
        src = source_root / rel
        dst = runtime_root / rel
        copies.append({"source": str(src), "dest": str(dst), "exists": src.exists()})
    launchagents = []
    for name in LAUNCHAGENTS:
        src = source_root / "yulu/scripts" / name
        dest = LAUNCH_AGENTS_DIR / name
        launchagents.append({"source": str(src), "dest": str(dest), "exists": src.exists()})
    return {
        "source_root": str(source_root),
        "runtime_root": str(runtime_root),
        "config_dir": str(config_dir),
        "legacy_root": str(legacy_root),
        "recording": recording,
        "socket": socket,
        "copies": copies,
        "launchagents": launchagents,
    }


def print_plan(data: dict) -> None:
    print("Yulu dev-install" + (" dry run" if not data.get("apply") else ""))
    print(f"source:  {data['source_root']}")
    print(f"runtime: {data['runtime_root']}")
    print(f"recording: {data['recording']}")
    print("planned copies:")
    for item in data["copies"]:
        mark = "✓" if item["exists"] else "!"
        print(f"  {mark} {item['source']} -> {item['dest']}")
    print("launchagents:")
    for item in data["launchagents"]:
        mark = "✓" if item["exists"] else "!"
        print(f"  {mark} {item['source']} -> {item['dest']}")


def _copy_runtime_items(source_root: Path, runtime_root: Path) -> None:
    if source_root.resolve() == runtime_root.resolve():
        return
    for rel in RUNTIME_ITEMS:
        src = source_root / rel
        dst = runtime_root / rel
        if not src.exists():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst, symlinks=True)
        else:
            shutil.copy2(src, dst)


def _write_dev_install_metadata(source_root: Path, runtime_root: Path) -> None:
    def git_value(*args: str) -> str:
        result = _run(["git", "-C", str(source_root), *args], timeout=10, check=False)
        return result.stdout.strip() if result.returncode == 0 else ""

    branch = git_value("branch", "--show-current") or "detached"
    commit = git_value("rev-parse", "--short", "HEAD") or "unknown"
    dirty = bool(git_value("status", "--porcelain"))
    payload = {
        "schema": 1,
        "source": "dev",
        "installed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "branch": branch,
        "commit": commit,
        "dirty": dirty,
    }
    path = runtime_root / ".yulu-install.json"
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _build_ui_dist(source_root: Path) -> None:
    ui_dir = source_root / "yulu/scripts/yulu_ui"
    if (ui_dir / "package.json").exists():
        node_bin = preferred_node(source_root / "yulu/scripts")
        path = _launch_path(node_bin)
        npm_bin = shutil.which("npm", path=path)
        if not npm_bin:
            raise RuntimeError(f"npm is required to build yulu_ui with {node_bin}")
        env = os.environ.copy()
        env["PATH"] = path
        _run([npm_bin, "run", "build"], timeout=180, check=True, cwd=ui_dir, env=env)


def _compile_helpers(script_dir: Path) -> None:
    for name in ("build_audio_daemon.sh", "build_status_agent.sh"):
        build_script = script_dir / name
        if build_script.exists():
            os.chmod(build_script, 0o755)
            _run([str(build_script)], timeout=120, check=True)
    swift_targets = [
        (script_dir / "window_scanner.swift", script_dir / "window_scanner"),
        (script_dir / "recorder_status.swift", script_dir / "recorder_status"),
    ]
    if shutil.which("swiftc"):
        for src, out in swift_targets:
            if src.exists():
                _run(["swiftc", "-o", str(out), str(src)], timeout=120, check=True)
                os.chmod(out, 0o755)


def _unload(dest: Path) -> None:
    if dest.exists():
        _run(["launchctl", "unload", str(dest)], timeout=15, check=False)


def _load(dest: Path) -> None:
    _run(["plutil", "-lint", str(dest)], timeout=10, check=True)
    _run(["launchctl", "load", str(dest)], timeout=15, check=False)


def _cleanup_obsolete_stt_state(config_dir: Path = DEFAULT_CONFIG_DIR) -> None:
    """Remove stale IPC/PID markers only after the old LaunchAgent is unloaded."""
    for path in (
        config_dir / "stt_daemon.sock",
        config_dir / "stt_daemon.pid",
        config_dir / "dictation" / "realtime.pid",
    ):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def _retire_obsolete_launchagents(
    config_dir: Path = DEFAULT_CONFIG_DIR,
    launch_agents_dir: Path = LAUNCH_AGENTS_DIR,
) -> None:
    """Boot out retired jobs by label, even when their plist already vanished."""
    domain = f"gui/{os.getuid()}"
    labels: list[str] = []
    for name in OBSOLETE_LAUNCHAGENTS:
        label = name.removesuffix(".plist")
        labels.append(label)
        dest = launch_agents_dir / name
        _run(["launchctl", "bootout", f"{domain}/{label}"], timeout=15, check=False)
        # Compatibility fallback for older launchctl behavior and installs
        # whose on-disk plist still exists.
        _unload(dest)
        _run(["launchctl", "remove", label], timeout=15, check=False)
        dest.unlink(missing_ok=True)

    for pattern in ("agent_queue_worker.py", "stt_daemon"):
        _run(["pkill", "-f", pattern], timeout=10, check=False)

    result = _run(["launchctl", "list"], timeout=10, check=False)
    if result.returncode != 0:
        raise RuntimeError("unable to verify retired LaunchAgents with launchctl list")
    loaded_labels = {
        line.split()[-1]
        for line in result.stdout.splitlines()
        if line.split()
    }
    still_loaded = [label for label in labels if label in loaded_labels]
    if still_loaded:
        raise RuntimeError(f"retired LaunchAgents are still loaded: {', '.join(still_loaded)}")
    _cleanup_obsolete_stt_state(config_dir)


def _kill_legacy_processes(legacy_root: Path) -> None:
    if legacy_root.exists():
        _run(["pkill", "-f", str(legacy_root)], timeout=10, check=False)
    # launchctl unload of `open -W Yulu.app` does not always kill the app child.
    _run(["pkill", "-f", "Yulu.app/Contents/MacOS/audio_daemon"], timeout=10, check=False)
    _run(["pkill", "-f", "StatusAgent.app/Contents/MacOS/status_agent"], timeout=10, check=False)


def _install_launchagents(script_dir: Path, *, python_bin: str) -> None:
    LAUNCH_AGENTS_DIR.mkdir(parents=True, exist_ok=True)
    node_bin = preferred_node(script_dir)
    launch_path = _launch_path(node_bin)
    _retire_obsolete_launchagents()
    for name in LAUNCHAGENTS:
        src = script_dir / name
        if not src.exists():
            continue
        dest = LAUNCH_AGENTS_DIR / name
        _unload(dest)
        rendered = render_plist(src, script_dir=script_dir, python_bin=python_bin, node_bin=node_bin, home=Path.home(), launch_path=launch_path)
        dest.write_text(rendered, encoding="utf-8")
        _load(dest)


def _install_cli(script_dir: Path) -> None:
    cli = script_dir / "yulu"
    if not cli.exists():
        return
    LOCAL_BIN.mkdir(parents=True, exist_ok=True)
    os.chmod(cli, 0o755)
    dest = LOCAL_BIN / "yulu"
    if dest.exists() or dest.is_symlink():
        dest.unlink()
    dest.symlink_to(cli)


def _seed_prompt_defaults(script_dir: Path, *, python_bin: str) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(script_dir)
    result = subprocess.run(
        [python_bin, "-m", "prompts.cli", "seed", "--from-current"],
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )
    if result.returncode != 0:
        print(f"warning: prompts seed failed: {(result.stderr or result.stdout).strip()}", file=sys.stderr)


def _install_mcp_registration(script_dir: Path, *, python_bin: str) -> None:
    """Require Hermes phase MCPs; register other detected Agents best-effort."""
    env = os.environ.copy()
    env["PYTHONPATH"] = str(script_dir)
    required = subprocess.run(
        [python_bin, "-m", "provision.cli", "mcp", "install", "--agent", "hermes"],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )
    if required.returncode != 0:
        detail = (required.stderr or required.stdout).strip()
        raise RuntimeError(f"Hermes and its Yulu phase MCP registrations are required: {detail}")
    optional = subprocess.run(
        [
            python_bin, "-m", "provision.cli", "mcp", "install",
            "--agent", "codex", "--agent", "claude", "--agent", "openclaw",
            "--detected-only", "--non-fatal",
        ],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )
    if optional.returncode != 0:
        print(f"warning: optional Agent MCP registration failed: {(optional.stderr or optional.stdout).strip()}", file=sys.stderr)


def apply(source_root: Path, runtime_root: Path, config_dir: Path, legacy_root: Path, python_bin: str) -> dict:
    data = plan(source_root, runtime_root, config_dir, legacy_root)
    data["apply"] = True
    if data["recording"]:
        raise RuntimeError("Refusing to install while Yulu is recording")
    # Fail before copying/reloading the runtime when the product's required
    # recording Agent boundary cannot be configured.
    _install_mcp_registration(source_root / "yulu/scripts", python_bin=python_bin)
    _build_ui_dist(source_root)
    _copy_runtime_items(source_root, runtime_root)
    script_dir = runtime_root / "yulu/scripts"
    _compile_helpers(script_dir)
    _kill_legacy_processes(legacy_root)
    _install_launchagents(script_dir, python_bin=python_bin)
    _install_cli(script_dir)
    _seed_prompt_defaults(script_dir, python_bin=python_bin)
    _write_dev_install_metadata(source_root, runtime_root)
    return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Yulu dev install")
    parser.add_argument("--source-root", type=Path, default=SOURCE_ROOT)
    parser.add_argument("--runtime-root", type=Path, default=DEFAULT_RUNTIME_ROOT)
    parser.add_argument("--config-dir", type=Path, default=DEFAULT_CONFIG_DIR)
    parser.add_argument("--legacy-root", type=Path, default=DEFAULT_LEGACY_ROOT)
    parser.add_argument("--python", default=preferred_python())
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)

    source_root = args.source_root.expanduser().resolve()
    runtime_root = args.runtime_root.expanduser().resolve()
    config_dir = args.config_dir.expanduser()
    legacy_root = args.legacy_root.expanduser()

    try:
        if args.apply:
            data = apply(source_root, runtime_root, config_dir, legacy_root, args.python)
        else:
            data = plan(source_root, runtime_root, config_dir, legacy_root)
    except Exception as exc:
        print(f"dev-install failed: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print_plan(data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
