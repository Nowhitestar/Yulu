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
import wave
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
    read_meta as read_lock_meta,
    RecordingBusy,
)

CONFIG_DIR = Path.home() / ".config" / "yulu"
CONFIG_PATH = CONFIG_DIR / "config.json"
SOCKET_PATH = CONFIG_DIR / "audio_daemon.sock"
STATE_PATH = CONFIG_DIR / ".state.json"
SCRIPT_DIR = Path(__file__).resolve().parent


# Phase 5 DATA-01 — the output_dir FALLBACK (when config has none) follows
# data_dir() so an unconfigured install lands new recordings under the resolver
# default (~/Movies/Yulu), not a repo-relative dir. Existing-file migration is
# Phase 7 (D-08). Lazy + guarded resolver import (mirrors probes.probe_recording_dir).
def _resolve_data_dir() -> Path:
    try:
        from yulu_platform.macos.path_resolver import MacOSPathResolver

        return MacOSPathResolver().data_dir()
    except Exception:
        return Path.home() / "Movies" / "Yulu"


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
    audio_cfg.setdefault("backend", "daemon")  # "daemon" or "sox"
    if audio_cfg.get("backend") == "sox":
        if not isinstance(audio_cfg.get("mic_device"), str) or not audio_cfg.get("mic_device"):
            audio_cfg["mic_device"] = ":0"
        if not isinstance(audio_cfg.get("system_audio_device"), str) or not audio_cfg.get("system_audio_device"):
            audio_cfg["system_audio_device"] = ":1"
    else:
        if not isinstance(audio_cfg.get("mic_device"), str):
            audio_cfg["mic_device"] = ""
        if "system_audio_device" not in audio_cfg:
            audio_cfg["system_audio_device"] = None
    audio_cfg.setdefault("output_dir", str(_resolve_data_dir()))
    audio_cfg.setdefault("silence_threshold", 0.01)
    audio_cfg.setdefault("silence_duration_sec", 300)
    # The old realtime-transcription config default was vestigial, so capture no
    # longer injects it.
    return audio_cfg


def socket_send(cmd):
    """发送命令到 audio_daemon Unix socket。"""
    if not SOCKET_PATH.exists():
        return None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(15)
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


class _FallbackCaptureController:
    """Small local fallback used when the platform adapter cannot load."""

    def status(self):
        return socket_send({"action": "status"})

    def start(self, payload):
        return socket_send({**payload, "action": "start"})

    def stop(self):
        return socket_send({"action": "stop"})

    def windows(self):
        return socket_send({"action": "windows"})


def _capture_controller():
    """Return the platform capture controller for the daemon backend."""
    try:
        from yulu_platform.macos import MacOSAudioCaptureController

        return MacOSAudioCaptureController(SOCKET_PATH, socket_send=socket_send)
    except Exception:
        return _FallbackCaptureController()


def read_state():
    return load_recording_state(STATE_PATH)


def write_state(state):
    save_recording_state(state, STATE_PATH)


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
    set_recording_stopped(status="crashed", path=STATE_PATH, extra={"crashed_at": datetime.now().isoformat()})
    return True


# ─── 后端: audio_daemon ──────────────────────────────

def _unique_existing(paths):
    out = []
    seen = set()
    for raw in paths:
        if not raw:
            continue
        p = str(raw)
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out


def _recording_segments(state):
    raw = state.get("segments")
    segments = list(raw) if isinstance(raw, list) else []
    cur = state.get("audio_path") or state.get("file_path")
    return _unique_existing([*segments, cur])


def _daemon_start_payload(title, cfg):
    payload = {"action": "start", "title": title}
    output_dir = cfg.get("output_dir")
    if isinstance(output_dir, str) and output_dir.strip():
        payload["output_dir"] = os.path.expanduser(output_dir.strip())
    mic_device = cfg.get("mic_device")
    if isinstance(mic_device, str) and mic_device.strip() and not mic_device.strip().startswith(":"):
        payload["mic_device"] = mic_device.strip()
    silence_seconds = cfg.get("silence_duration_sec")
    if isinstance(silence_seconds, (int, float)) and silence_seconds > 0:
        payload["silence_seconds"] = silence_seconds
    silence_threshold = cfg.get("silence_threshold")
    if isinstance(silence_threshold, (int, float)) and 0 <= silence_threshold <= 1:
        payload["silence_threshold"] = silence_threshold
    return payload


def _record_resumed_segment(state, new_path):
    title = state.get("title", "")
    segments = _unique_existing([*_recording_segments(state), new_path])
    next_state = {
        **state,
        "recording": True,
        "status": "recording",
        "file_path": new_path,
        "audio_path": new_path,
        "segments": segments,
        "resume_count": int(state.get("resume_count") or 0) + 1,
        "last_resumed_at": datetime.now().isoformat(timespec="seconds"),
    }
    write_state(next_state)


def resume_interrupted_recording(resp):
    state = read_state()
    if not is_recording_active(state) or state.get("backend") == "sox":
        return None
    if resp and resp.get("recording") is True:
        return None
    title = state.get("title") or "未命名会议"
    old_path = state.get("audio_path") or state.get("file_path") or ""
    log(f"⚠️ 检测到 daemon 重启导致录制中断，正在续录: {title} → {old_path}")
    start_resp = _capture_controller().start(_daemon_start_payload(title, load_config()))
    if not (start_resp and start_resp.get("status") == "recording" and start_resp.get("file")):
        set_recording_stopped(
            status="interrupted",
            path=STATE_PATH,
            extra={
                "title": title,
                "audio_path": old_path,
                "file_path": old_path,
                "segments": _recording_segments(state),
                "interrupted_at": datetime.now().isoformat(timespec="seconds"),
            },
        )
        return None
    new_path = start_resp.get("file")
    _record_resumed_segment(state, new_path)
    log(f"✅ 已续录: {new_path}")
    return {"recording": True, "file": new_path, "resumed": True}


def _combine_segments_to_first_wav(paths):
    segments = [Path(p) for p in _unique_existing(paths) if Path(p).exists()]
    if not segments:
        return "", []
    if len(segments) == 1:
        only = str(segments[0])
        return only, [only]
    first = segments[0]
    stored_segments = [str(first)]
    tmp = first.with_suffix(f".merge-{os.getpid()}.wav")
    params = None
    with wave.open(str(tmp), "wb") as out:
        for seg in segments:
            with wave.open(str(seg), "rb") as src:
                if params is None:
                    params = src.getparams()
                    out.setparams(params)
                elif src.getparams()[:3] != params[:3]:
                    raise ValueError(f"segment format mismatch: {seg}")
                out.writeframes(src.readframes(src.getnframes()))
    os.replace(tmp, first)
    for idx, seg in enumerate(segments[1:], start=2):
        archived = seg.with_suffix(f".part{idx}.wav")
        try:
            if archived.exists():
                archived.unlink()
            seg.rename(archived)
            stored_segments.append(str(archived))
        except OSError:
            stored_segments.append(str(seg))
            pass
    return str(first), stored_segments

def _raise_if_daemon_recording(lock_handle):
    """Defer to the audio_daemon as the canonical "is recording" arbiter.

    The flock is held only for the start-handshake (~50ms) while the recording
    it gated runs for minutes/hours. So a second `start` invocation can
    acquire the flock cleanly while the daemon is still recording. Probe the
    daemon: if it reports recording, raise RecordingBusy carrying the live
    holder's metadata (read from the lock file, which now persists past the
    holder's release per the new lock semantics).
    """
    status = _capture_controller().status()
    if not (status and status.get("recording") is True):
        return
    info = {}
    if lock_handle is not None:
        info = read_lock_meta(lock_handle.path)
    if not info:
        info = {
            "title": "<unknown>",
            "path": status.get("file") or "<unknown>",
            "started_at": "<unknown>",
        }
    raise RecordingBusy(info)


def daemon_start(title, lock_handle=None):
    cfg = load_config()
    _raise_if_daemon_recording(lock_handle)
    resp = _capture_controller().start(_daemon_start_payload(title, cfg))
    if resp and resp.get("status") == "recording":
        path = resp.get("file")
        if path:
            set_recording_started(title, path, backend="daemon", path=STATE_PATH, extra={"segments": [path]})
        if lock_handle is not None:
            record_lock(
                lock_handle,
                title=title,
                path=path or "",
                started_at=datetime.now().isoformat(),
            )
        log(f"🎙 Recording started: {path}")
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
    state = read_state()
    rec = recording_info(state)
    resp = _capture_controller().stop()
    if resp and resp.get("status") == "stopped":
        dur = resp.get("duration", 0)
        path = resp.get("file", "")
        segments = _unique_existing([*_recording_segments(state), path])
        if len(segments) > 1:
            final_path, stored_segments = _combine_segments_to_first_wav(segments)
        else:
            final_path = path
            stored_segments = segments
        set_recording_stopped(
            path=STATE_PATH,
            extra={
                "audio_path": final_path,
                "file_path": final_path,
                "segments": stored_segments,
                "stopped_at": datetime.now().isoformat(timespec="seconds"),
            },
        )
        log(f"⏹ Recording stopped: {dur}s → {final_path or path}")
        return {"path": final_path or path, "duration": dur, "segments": stored_segments}

    # Socket failure while state says daemon recording: stop quickly and keep file.
    detect_daemon_crash(resp)
    result = emergency_stop_daemon(rec)
    if result:
        return result
    log(f"❌ Stop failed: {resp}")
    return None


def daemon_status():
    resp = _capture_controller().status()
    resumed = resume_interrupted_recording(resp)
    if resumed:
        return resumed
    detect_daemon_crash(resp)
    return resp or {"recording": False}


def daemon_ensure_running():
    """如果 daemon 没在运行，尝试启动它。"""
    resp = _capture_controller().status()
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
            resp = _capture_controller().status()
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
                result = sox_stop()
            else:
                result = daemon_stop()
                if not result:
                    result = sox_stop()
            if result and result.get("path"):
                print(f"FINAL_RECORDING_PATH={result.get('path')}")
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
            result = sox_stop()
            if result and result.get("path"):
                print(f"FINAL_RECORDING_PATH={result.get('path')}")
        elif cmd == "status":
            result = sox_status()
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(f"未知命令: {cmd}")


if __name__ == "__main__":
    main()
