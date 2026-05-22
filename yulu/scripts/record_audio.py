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

from state_store import (
    is_recording_active,
    load_state as load_recording_state,
    recording_info,
    save_state as save_recording_state,
    set_recording_started,
    set_recording_stopped,
)
from recording_lock import (
    acquire as acquire_recording_lock,
    record as record_lock,
    RecordingBusy,
)

try:
    from agent_notify import notify
except Exception:
    def notify(*args, **kwargs):
        pass

CONFIG_DIR = Path.home() / ".config" / "yulu"
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
    return load_recording_state(STATE_PATH)


def write_state(state):
    save_recording_state(state, STATE_PATH)


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

        def alive():
            try:
                os.kill(pid, 0)
                return True
            except ProcessLookupError:
                return False

        def wait_until_dead(seconds):
            deadline = time.time() + seconds
            while time.time() < deadline:
                if not alive():
                    REALTIME_PID_PATH.unlink(missing_ok=True)
                    return True
                time.sleep(0.5)
            return not alive()

        if wait and wait_until_dead(180 if graceful else 20):
            return

        # realtime_transcribe.py is launched with start_new_session=True and can be
        # blocked inside an mlx-whisper child process. Its SIGTERM handler only
        # sets a flag, so a plain os.kill(pid, SIGTERM) can leave the process
        # group alive and keep appending to the realtime transcript after the
        # recording has stopped. Kill the whole process group, then escalate.
        try:
            os.killpg(pid, signal.SIGTERM)
        except Exception:
            os.kill(pid, signal.SIGTERM)

        if wait and not wait_until_dead(20):
            try:
                os.killpg(pid, signal.SIGKILL)
            except Exception:
                try:
                    os.kill(pid, signal.SIGKILL)
                except Exception:
                    pass
            wait_until_dead(5)
    except Exception:
        pass
    REALTIME_PID_PATH.unlink(missing_ok=True)


def detect_daemon_crash(resp=None):
    """Detect a stale 'recording=true' state when the daemon/socket is gone.

    The daemon writes WAV data incrementally now, so even after a crash the path
    should point to a recoverable partial recording. We still must tell the user.
    """
    state = read_state()
    if not is_recording_active(state):
        return False
    rec = recording_info(state)
    if rec.get("backend") == "sox":
        return False
    socket_missing = resp is None or not SOCKET_PATH.exists()
    if not socket_missing:
        return False
    title = rec.get("title", "")
    path = rec.get("audio_path") or rec.get("file_path", "")
    log(f"⚠️ 检测到 Yulu 异常退出，录音状态残留: {title} → {path}")
    stop_realtime_transcriber(wait=True)
    notify("recording_crashed", title=title, path=path, message="Yulu 异常退出，已保留可恢复的部分录音文件。")
    set_recording_stopped(status="crashed", path=STATE_PATH, extra={"crashed_at": datetime.now().isoformat()})
    return True


# ─── 后端: audio_daemon ──────────────────────────────

def daemon_start(title, lock_handle=None):
    cfg = load_config()
    resp = socket_send({"action": "start", "title": title})
    if resp and resp.get("status") == "recording":
        path = resp.get("file")
        if lock_handle is not None:
            record_lock(
                lock_handle,
                title=title,
                path=path or "",
                started_at=datetime.now().isoformat(),
            )
        log(f"🎙 Recording started: {path}")
        start_realtime_transcriber(path, title)
        return True
    log(f"❌ Start failed: {resp}")
    return False


def emergency_stop_daemon(rec=None):
    """Best-effort stop when the Swift daemon socket is dead/unresponsive.

    The daemon patches the WAV header every few seconds, so terminating it is
    preferable to leaving recording stuck forever. Keep the recorded file path
    from state so downstream transcription can still proceed.
    """
    rec = rec or recording_info(read_state())
    path = rec.get("audio_path") or rec.get("file_path", "")
    title = rec.get("title", "")
    patterns = ["Yulu.app/Contents/MacOS/audio_daemon", "/scripts/audio_daemon"]
    for pat in patterns:
        try:
            out = subprocess.run(["pgrep", "-f", pat], capture_output=True, text=True, timeout=2).stdout.split()
        except Exception:
            out = []
        for s in out:
            try:
                pid = int(s)
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    continue
            except Exception:
                pass
    time.sleep(1)
    for pat in patterns:
        try:
            out = subprocess.run(["pgrep", "-f", pat], capture_output=True, text=True, timeout=2).stdout.split()
        except Exception:
            out = []
        for s in out:
            try:
                pid = int(s)
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass
    set_recording_stopped(status="stopped_emergency_daemon_unresponsive", path=STATE_PATH, extra={
        "title": title,
        "audio_path": path,
        "file_path": path,
        "stopped_at": datetime.now().isoformat(timespec="seconds"),
    })
    log(f"⚠️ Daemon unresponsive; emergency-stopped and preserved recording: {path}")
    return {"path": path, "duration": 0, "emergency": True} if path else None


def daemon_stop():
    rec = recording_info(read_state())
    resp = socket_send({"action": "stop"})
    if resp and resp.get("status") == "stopped":
        # Do not let realtime transcription keep the UI stuck for minutes.
        stop_realtime_transcriber(wait=True, graceful=False)
        dur = resp.get("duration", 0)
        path = resp.get("file", "")
        log(f"⏹ Recording stopped: {dur}s → {path}")
        return {"path": path, "duration": dur}

    # Socket failure while state says daemon recording: stop quickly and keep file.
    stop_realtime_transcriber(wait=True, graceful=False)
    detect_daemon_crash(resp)
    result = emergency_stop_daemon(rec)
    if result:
        return result
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

    # 查找已安装的 Yulu.app
    app_paths = [
        SCRIPT_DIR / "Yulu.app",
        Path.home() / "Applications" / "Yulu.app",
        Path("/Applications/Yulu.app"),
    ]
    for app in app_paths:
        binary = app / "Contents/MacOS/audio_daemon"
        if binary.exists():
            log("🚀 启动 Yulu...")
            subprocess.Popen(["open", str(app)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(3)
            resp = socket_send({"action": "status"})
            if resp is not None:
                log("✅ Yulu 已启动")
                return True
            break

    log("⚠️ Yulu 未运行")
    return False


# ─── 后端: SoX + BlackHole ──────────────────────────

def sox_start(title, lock_handle=None):
    """SoX 双路录制（向后兼容）。"""
    cfg = load_config()
    output_dir = Path(cfg["output_dir"]).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)

    safe = title.replace("/", "_").replace(" ", "_")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output = output_dir / f"{safe}_{timestamp}.wav"

    set_recording_started(title, str(output), backend="sox", path=STATE_PATH)

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
    if lock_handle is not None:
        record_lock(
            lock_handle,
            title=title,
            path=str(output),
            started_at=datetime.now().isoformat(),
        )
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

    set_recording_stopped(path=STATE_PATH)
    stop_realtime_transcriber(wait=True, graceful=True)

    log("⏹ 录制已停止")
    return {"path": "", "duration": 0}


def sox_status():
    state = read_state()
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
            try:
                with acquire_recording_lock(timeout=0.5) as lock_handle:
                    if daemon_ensure_running():
                        daemon_start(title, lock_handle=lock_handle)
                    else:
                        log("⚠️ Yulu 未运行，切换到 SoX 后端")
                        sox_start(title, lock_handle=lock_handle)
            except RecordingBusy as exc:
                info = exc.info or {}
                print(
                    f"⚠️ 录音正在进行中: {info.get('title', '<unknown>')}\n"
                    f"   file: {info.get('path', '<unknown>')}\n"
                    f"   started: {info.get('started_at', '<unknown>')}",
                    file=sys.stderr,
                )
                sys.exit(2)
        elif cmd == "stop":
            rec = recording_info(read_state())
            if rec.get("backend") == "sox":
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
            try:
                with acquire_recording_lock(timeout=0.5) as lock_handle:
                    sox_start(title, lock_handle=lock_handle)
            except RecordingBusy as exc:
                info = exc.info or {}
                print(
                    f"⚠️ 录音正在进行中: {info.get('title', '<unknown>')}\n"
                    f"   file: {info.get('path', '<unknown>')}\n"
                    f"   started: {info.get('started_at', '<unknown>')}",
                    file=sys.stderr,
                )
                sys.exit(2)
        elif cmd == "stop":
            sox_stop()
        elif cmd == "status":
            result = sox_status()
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(f"未知命令: {cmd}")


if __name__ == "__main__":
    main()
