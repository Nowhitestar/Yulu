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
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUNTIME_ROOT = Path.home() / ".yulu"
DEFAULT_CONFIG_DIR = Path.home() / ".config/yulu"
DEFAULT_LEGACY_ROOT = Path.home() / ".openclaw/workspace/meeting-assistant/yulu"
LAUNCH_AGENTS_DIR = Path.home() / "Library/LaunchAgents"
LOCAL_BIN = Path.home() / ".local/bin"

RUNTIME_ITEMS = [
    "install.sh",
    "skills/yulu/SKILL.md",
    "yulu/SKILL.md",
    "yulu/scripts",
]

LAUNCHAGENTS = [
    "com.yulu.audiodaemon.plist",
    "com.yulu.scheduler.plist",
    "com.yulu.detector.plist",
    "com.yulu.agentqueue.plist",
    "com.yulu.calendar.plist",
    "com.yulu.sttdaemon.plist",
    "com.yulu.ui.plist",
]


def _run(cmd: list[str], *, timeout: int = 30, check: bool = False, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
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
    for candidate in ("/opt/homebrew/bin/node", "/usr/local/bin/node"):
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


def preferred_node(script_dir: Path | None = None) -> str:
    ui_dir = script_dir / "yulu_ui" if script_dir is not None else SOURCE_ROOT / "yulu/scripts/yulu_ui"
    for candidate in _node_candidates():
        if _node_can_load_ui_native_modules(candidate, ui_dir):
            return candidate
    candidates = _node_candidates()
    return candidates[0] if candidates else "/usr/local/bin/node"


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
        parts.insert(1, str(Path(node_bin).parent))
    else:
        nvm = Path.home() / ".nvm/versions/node"
        if nvm.exists():
            for candidate in sorted(nvm.glob("*/bin"), reverse=True):
                parts.insert(1, str(candidate))
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


def _kill_legacy_processes(legacy_root: Path) -> None:
    if legacy_root.exists():
        _run(["pkill", "-f", str(legacy_root)], timeout=10, check=False)
    # launchctl unload of `open -W Yulu.app` does not always kill the app child.
    _run(["pkill", "-f", "Yulu.app/Contents/MacOS/audio_daemon"], timeout=10, check=False)


def _install_launchagents(script_dir: Path, *, python_bin: str) -> None:
    LAUNCH_AGENTS_DIR.mkdir(parents=True, exist_ok=True)
    node_bin = preferred_node(script_dir)
    launch_path = _launch_path(node_bin)
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


def apply(source_root: Path, runtime_root: Path, config_dir: Path, legacy_root: Path, python_bin: str) -> dict:
    data = plan(source_root, runtime_root, config_dir, legacy_root)
    data["apply"] = True
    if data["recording"]:
        raise RuntimeError("Refusing to install while Yulu is recording")
    _copy_runtime_items(source_root, runtime_root)
    script_dir = runtime_root / "yulu/scripts"
    _compile_helpers(script_dir)
    _kill_legacy_processes(legacy_root)
    _install_launchagents(script_dir, python_bin=python_bin)
    _install_cli(script_dir)
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
