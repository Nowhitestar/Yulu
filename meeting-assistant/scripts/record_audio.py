#!/usr/bin/env python3
"""
音频录制控制器 — 支持两种后端：
  - daemon: ScreenCaptureKit 原生捕获（macOS 12.3+，推荐）
  - sox: BlackHole + SoX 传统方案

用法和原来一样：
  record_audio.py start "会议标题"
  record_audio.py stop
  record_audio.py status
"""

import json
import os
import signal
import socket
import struct
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    from agent_notify import notify
except Exception:
    def notify(*args, **kwargs):
        pass

CONFIG_DIR = Path.home() / ".config" / "meeting-assistant"
CONFIG_PATH = CONFIG_DIR / "config.json"
SOCKET_PATH = CONFIG_DIR / "audio_daemon.sock"
STATE_PATH = CONFIG_DIR / ".state.json"
SCRIPT_DIR = Path(__file__).resolve().parent
REALTIME_PID_PATH = CONFIG_DIR / ".realtime_transcribe.pid"


def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def load_config():
    cfg = {}
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text())
        except Exception:
            pass
    audio_cfg = cfg.get("audio", {})
    audio_cfg.setdefault("mic_device", ":0")
    audio_cfg.setdefault("system_audio_device", ":1")
    audio_cfg.setdefault("output_dir", str(SCRIPT_DIR.parent.parent / "meeting-recordings"))
    audio_cfg.setdefault("silence_threshold", 0.01)
    audio_cfg.setdefault("silence_duration_sec", 300)
    audio_cfg.setdefault("backend", "daemon")  # "daemon" or "sox"
    audio_cfg.setdefault("realtime_transcribe", True)
    return audio_cfg


def socket_send(cmd):
    """发送命令到 audio_daemon Unix socket。"""
    if not SOCKET_PATH.exists():
        return None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect(str(SOCKET_PATH))
        sock.sendall(json.dumps(cmd).encode())
        sock.shutdown(socket.SHUT_WR)
        data = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        sock.close()
        return json.loads(data.decode()) if data else None
    except Exception as e:
        log(f"Socket error: {e}")
        return None


def read_state():
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return {}


def write_state(state):
    STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def realtime_enabled():
    try:
        cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
    except Exception:
        cfg = {}
    trans_cfg = cfg.get("transcription", {})
    if "realtime_enabled" in trans_cfg:
        return bool(trans_cfg.get("realtime_enabled"))
    return bool(cfg.get("audio", {}).get("realtime_transcribe", True))


def start_realtime_transcriber(audio_path, title):
    if not realtime_enabled() or not audio_path:
        return
    script = SCRIPT_DIR / "realtime_transcribe.py"
    if not script.exists():
        return
    stop_realtime_transcriber(wait=False)
    log_path = CONFIG_DIR / "realtime_transcribe.log"
    with log_path.open("ab") as log_file:
        proc = subprocess.Popen(
            [sys.executable, str(script), str(audio_path), title],
            stdout=log_file,
            stderr=log_file,
            start_new_session=True,
        )
    REALTIME_PID_PATH.write_text(str(proc.pid))
    log(f"📝 实时转写已启动: pid={proc.pid}")


def stop_realtime_transcriber(wait=True, graceful=False):
    if not REALTIME_PID_PATH.exists():
        return
    try:
        pid = int(REALTIME_PID_PATH.read_text().strip())
        if wait:
            deadline = time.time() + (180 if graceful else 20)
            while time.time() < deadline:
                try:
                    os.kill(pid, 0)
                    time.sleep(0.5)
                except ProcessLookupError:
                    REALTIME_PID_PATH.unlink(missing_ok=True)
                    return
        os.kill(pid, signal.SIGTERM)
        if wait:
            deadline = time.time() + 20
            while time.time() < deadline:
                try:
                    os.kill(pid, 0)
                    time.sleep(0.5)
                except ProcessLookupError:
                    break
    except Exception:
        pass
    REALTIME_PID_PATH.unlink(missing_ok=True)


def detect_daemon_crash(resp=None):
    """Detect a stale 'recording=true' state when the daemon/socket is gone.

    The daemon writes WAV data incrementally now, so even after a crash the path
    should point to a recoverable partial recording. We still must tell the user.
    """
    state = read_state()
    if not state.get("recording"):
        return False
    if state.get("backend") == "sox":
        return False
    socket_missing = resp is None or not SOCKET_PATH.exists()
    if not socket_missing:
        return False
    title = state.get("title", "")
    path = state.get("file_path", "")
    log(f"⚠️ 检测到 AudioDaemon 异常退出，录音状态残留: {title} → {path}")
    stop_realtime_transcriber(wait=True)
    notify("recording_crashed", title=title, path=path, message="AudioDaemon 异常退出，已保留可恢复的部分录音文件。")
    state["recording"] = False
    state["crashed_at"] = datetime.now().isoformat()
    write_state(state)
    return True


# ─── 后端: audio_daemon ──────────────────────────────

def daemon_start(title):
    cfg = load_config()
    resp = socket_send({"action": "start", "title": title})
    if resp and resp.get("status") == "recording":
        path = resp.get("file")
        log(f"🎙 Recording started: {path}")
        start_realtime_transcriber(path, title)
        return True
    log(f"❌ Start failed: {resp}")
    return False


def daemon_stop():
    resp = socket_send({"action": "stop"})
    stop_realtime_transcriber(wait=True, graceful=True)
    if resp and resp.get("status") == "stopped":
        dur = resp.get("duration", 0)
        path = resp.get("file", "")
        log(f"⏹ Recording stopped: {dur}s → {path}")
        return {"path": path, "duration": dur}
    detect_daemon_crash(resp)
    log(f"❌ Stop failed: {resp}")
    return None


def daemon_status():
    resp = socket_send({"action": "status"})
    detect_daemon_crash(resp)
    return resp or {"recording": False}


def daemon_ensure_running():
    """如果 daemon 没在运行，尝试启动它。"""
    resp = socket_send({"action": "status"})
    if resp is not None:
        return True
    detect_daemon_crash(resp)

    # 查找已安装的 AudioDaemon.app
    app_paths = [
        SCRIPT_DIR / "AudioDaemon.app",
        Path.home() / "Applications" / "Meeting Assistant.app",
        Path("/Applications/Meeting Assistant.app"),
    ]
    for app in app_paths:
        binary = app / "Contents/MacOS/audio_daemon"
        if binary.exists():
            log("🚀 启动 AudioDaemon...")
            subprocess.Popen(["open", str(app)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(3)
            resp = socket_send({"action": "status"})
            if resp is not None:
                log("✅ AudioDaemon 已启动")
                return True
            break

    log("⚠️ AudioDaemon 未运行")
    return False


# ─── 后端: SoX + BlackHole ──────────────────────────

def sox_start(title):
    """SoX 双路录制（向后兼容）。"""
    cfg = load_config()
    output_dir = Path(cfg["output_dir"]).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)

    safe = title.replace("/", "_").replace(" ", "_")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output = output_dir / f"{safe}_{timestamp}.wav"

    state = {
        "recording": True,
        "backend": "sox",
        "title": title,
        "file_path": str(output),
        "started_at": datetime.now().isoformat(),
    }
    STATE_PATH.write_text(json.dumps(state, indent=2))

    listen_cmd = [
        "sox", "-q",
        "-t", "coreaudio", cfg["system_audio_device"],
        "-t", "coreaudio", cfg["mic_device"],
        "-t", "wav", str(output),
        "remix", "1,2",
        "gain", "-3",
    ]

    log(f"🎙 录制中: {output}")
    log(f"   后端: SoX (mic={cfg['mic_device']}, sys={cfg['system_audio_device']})")

    proc = subprocess.Popen(
        listen_cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    (CONFIG_DIR / ".recording_pid").write_text(str(proc.pid))
    start_realtime_transcriber(output, title)
    return True


def sox_stop():
    pid_path = CONFIG_DIR / ".recording_pid"
    if pid_path.exists():
        try:
            pid = int(pid_path.read_text().strip())
            os.kill(pid, 15)
            time.sleep(0.5)
            pid_path.unlink(missing_ok=True)
        except Exception:
            pass

    state = {"recording": False, "title": "", "file_path": ""}
    STATE_PATH.write_text(json.dumps(state, indent=2))
    stop_realtime_transcriber(wait=True, graceful=True)

    log("⏹ 录制已停止")
    return {"path": "", "duration": 0}


def sox_status():
    state = {"recording": False, "title": ""}
    if STATE_PATH.exists():
        try:
            state = json.loads(STATE_PATH.read_text())
        except Exception:
            pass
    if (CONFIG_DIR / ".recording_pid").exists():
        state["recording"] = True
    return state


# ─── 主入口 ──────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(f"用法: {sys.argv[0]} <start|stop|status> [标题]")
        sys.exit(1)

    cmd = sys.argv[1]
    cfg = load_config()
    backend = cfg.get("backend", "daemon")

    if backend == "daemon":
        if cmd == "start":
            title = sys.argv[2] if len(sys.argv) > 2 else "未命名会议"
            if daemon_ensure_running():
                daemon_start(title)
            else:
                log("⚠️ AudioDaemon 未运行，切换到 SoX 后端")
                sox_start(title)
        elif cmd == "stop":
            state = read_state()
            if state.get("backend") == "sox":
                sox_stop()
            else:
                result = daemon_stop()
                if not result:
                    sox_stop()
        elif cmd == "status":
            result = daemon_status()
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(f"未知命令: {cmd}")
    else:
        if cmd == "start":
            title = sys.argv[2] if len(sys.argv) > 2 else "未命名会议"
            sox_start(title)
        elif cmd == "stop":
            sox_stop()
        elif cmd == "status":
            result = sox_status()
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(f"未知命令: {cmd}")


if __name__ == "__main__":
    main()
