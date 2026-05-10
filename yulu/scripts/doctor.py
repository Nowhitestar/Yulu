#!/usr/bin/env python3
"""Yulu local health check."""

from __future__ import annotations

import json
import shutil
import socket
import subprocess
import sys
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "yulu"
CONFIG_PATH = CONFIG_DIR / "config.json"
QUEUE_PATH = CONFIG_DIR / "agent-queue.json"
SOCKET_PATH = CONFIG_DIR / "audio_daemon.sock"


def version_status() -> None:
    try:
        from version import format_version, version_info
        line(True, "version", format_version(version_info()))
    except Exception as exc:
        line(None, "version", f"unavailable: {exc}")


def line(ok: bool | None, name: str, detail: str = "") -> None:
    mark = "OK" if ok is True else ("WARN" if ok is None else "FAIL")
    suffix = f" — {detail}" if detail else ""
    print(f"[{mark}] {name}{suffix}")


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        line(False, "config", f"missing: {CONFIG_PATH}")
        return {}
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        line(True, "config", str(CONFIG_PATH))
        return cfg
    except Exception as exc:
        line(False, "config", f"invalid JSON: {exc}")
        return {}


def daemon_status() -> None:
    if not SOCKET_PATH.exists():
        line(False, "audio daemon", f"socket missing: {SOCKET_PATH}")
        return
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(2)
        sock.connect(str(SOCKET_PATH))
        sock.sendall(b'{"action":"status"}')
        sock.shutdown(socket.SHUT_WR)
        data = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        resp = json.loads(data.decode())
    except Exception as exc:
        line(False, "audio daemon", f"no response: {exc}")
        return
    finally:
        try:
            sock.close()
        except Exception:
            pass

    ready = bool(resp.get("sysReady")) and bool(resp.get("micReady"))
    detail = f"recording={resp.get('recording')} sysReady={resp.get('sysReady')} micReady={resp.get('micReady')}"
    line(True if ready else None, "audio daemon", detail)


def transcription_status(cfg: dict) -> None:
    trans = cfg.get("transcription", {}) if isinstance(cfg, dict) else {}
    mode = trans.get("post_recording_mode", "fast_summary")
    engine = trans.get("final_engine", "whisper")
    realtime = trans.get("realtime", {}) if isinstance(trans.get("realtime", {}), dict) else {}
    line(True, "transcription mode", f"post_recording_mode={mode} final_engine={engine} realtime={realtime.get('engine', engine)}")
    if engine == "mlx":
        mlx = trans.get("mlx", {}) if isinstance(trans.get("mlx", {}), dict) else {}
        py = Path(str(trans.get("mlx_python") or mlx.get("python") or CONFIG_DIR / "venv-mlx-whisper/bin/python")).expanduser()
        model = trans.get("mlx_model") or mlx.get("model") or "mlx-community/whisper-large-v3-mlx"
        line(True if py.exists() else False, "mlx python", str(py))
        line(True, "mlx model", str(model))
        return

    command = trans.get("command") or []
    whisper = command[0] if command else trans.get("whisper_cli", "whisper-cli")
    model = trans.get("local_model_path", "")
    if command:
        for i, tok in enumerate(command):
            if tok == "-m" and i + 1 < len(command):
                model = command[i + 1]
                break
    model_path = Path(str(model)).expanduser() if model else None
    whisper_ok = bool(shutil.which(str(whisper)))
    model_ok = bool(model_path and model_path.exists())
    line(True if whisper_ok else False, "whisper binary", str(whisper))
    line(True if model_ok else False, "whisper model", str(model_path or "<unset>"))


def llm_status(cfg: dict) -> None:
    llm = cfg.get("llm", {}) if isinstance(cfg, dict) else {}
    if not llm.get("enabled", True):
        line(None, "llm", "disabled; fallback summary will be final")
        return
    cmd = llm.get("command")
    if not cmd:
        line(None, "llm", "no command; summary_request stays for an external agent")
        return
    binary = cmd[0] if isinstance(cmd, list) else str(cmd).split()[0]
    line(True if shutil.which(binary) else False, "llm command", binary)


def queue_status() -> None:
    if not QUEUE_PATH.exists():
        line(True, "agent queue", "empty")
        return
    try:
        q = json.loads(QUEUE_PATH.read_text(encoding="utf-8"))
        if not isinstance(q, list):
            raise ValueError("queue is not a list")
    except Exception as exc:
        line(False, "agent queue", f"invalid: {exc}")
        return
    pending = sum(1 for e in q if isinstance(e, dict) and e.get("type") == "summary_request" and e.get("status") not in {"done", "error"})
    errors = sum(1 for e in q if isinstance(e, dict) and e.get("status") == "error")
    line(True if errors == 0 else None, "agent queue", f"{pending} pending, {errors} error")


def calendar_status(cfg: dict) -> None:
    calendars = cfg.get("calendars", []) if isinstance(cfg, dict) else []
    enabled = [c for c in calendars if c.get("enabled")]
    if not enabled:
        line(None, "calendar", "disabled")
        return
    gog = shutil.which("gog")
    cloudflared = shutil.which("cloudflared")
    detail = f"{len(enabled)} enabled; gog={'yes' if gog else 'no'} cloudflared={'yes' if cloudflared else 'no'}"
    line(True if gog else False, "calendar", detail)


def launchd_status() -> None:
    try:
        r = subprocess.run(["launchctl", "list"], capture_output=True, text=True, timeout=5)
    except Exception as exc:
        line(None, "launchd", str(exc))
        return
    labels = [x for x in ("com.yulu.audiodaemon", "com.yulu.scheduler", "com.yulu.detector", "com.yulu.agentqueue") if x in r.stdout]
    line(True if labels else None, "launchd", ", ".join(labels) if labels else "no com.yulu services listed")


def main() -> int:
    version_status()
    cfg = load_config()
    daemon_status()
    transcription_status(cfg)
    llm_status(cfg)
    queue_status()
    calendar_status(cfg)
    launchd_status()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
