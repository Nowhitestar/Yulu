#!/usr/bin/env python3
"""
录制会议音频（麦克风 + 扬声器），支持静默检测自动停止。

依赖：
- ffmpeg
- macOS: BlackHole 虚拟音频设备

安装 BlackHole:
  brew install blackhole-2ch

用法：
  record_audio.py start <title>     # 开始录制
  record_audio.py stop              # 停止录制
  record_audio.py monitor <title> <audio_path>  # 后台静默检测
"""

import json
import os
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave
from datetime import datetime
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "meeting-assistant" / "config.json"
PID_FILE = Path.home() / ".config" / "meeting-assistant" / ".recording_pid"
MONITOR_PID_FILE = Path.home() / ".config" / "meeting-assistant" / ".monitor_pid"
SCRIPT_DIR = Path(__file__).parent

# 静默检测阈值（振幅归一化 0.0-1.0）
SILENCE_THRESHOLD = 0.01
# 连续静默多少秒后触发自动停止询问
SILENCE_DURATION_SEC = 300  # 5分钟
# 检测间隔（秒）
CHECK_INTERVAL = 10


def load_config():
    if not CONFIG_PATH.exists():
        print(f"Config not found at {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def start_recording(meeting_title="meeting"):
    """开始录制音频。"""
    config = load_config()
    audio_config = config.get("audio", {})
    output_dir = Path(audio_config.get("output_dir", "~/Downloads/meeting-recordings")).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_title = "".join(c if c.isalnum() or c in "-_ " else "_" for c in meeting_title)
    output_file = output_dir / f"{safe_title}_{timestamp}.wav"

    mic = audio_config.get("mic_device", ":0")
    sys_audio = audio_config.get("system_audio_device", ":1")

    # ffmpeg 同时录制麦克风和系统音频
    cmd = [
        "ffmpeg",
        "-y",
        "-f", "avfoundation",
        "-i", mic,
        "-f", "avfoundation",
        "-i", sys_audio,
        "-filter_complex", "amix=inputs=2:duration=longest",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        str(output_file),
    ]

    print(f"Starting recording: {output_file}")
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    with open(PID_FILE, "w") as f:
        json.dump({"pid": process.pid, "file": str(output_file), "title": meeting_title}, f)

    print(f"Recording started (PID: {process.pid})")
    print(f"Output: {output_file}")
    return process, str(output_file)


def stop_recording():
    """停止录制。"""
    if not PID_FILE.exists():
        print("No active recording found.", file=sys.stderr)
        return None

    with open(PID_FILE) as f:
        info = json.load(f)

    pid = info["pid"]
    output_file = info["file"]

    try:
        os.kill(pid, signal.SIGTERM)
        time.sleep(1)
        # 确认进程已结束
        try:
            os.kill(pid, 0)
            time.sleep(1)
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    except ProcessLookupError:
        pass

    PID_FILE.unlink(missing_ok=True)
    
    # 也停止 monitor
    if MONITOR_PID_FILE.exists():
        with open(MONITOR_PID_FILE) as f:
            mon_info = json.load(f)
        try:
            os.kill(mon_info["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass
        MONITOR_PID_FILE.unlink(missing_ok=True)

    print(f"Recording saved: {output_file}")
    return output_file


# ───────────────────────────────────────────────
# 静默检测
# ───────────────────────────────────────────────

def get_audio_level(audio_path, duration_sec=1):
    """获取最近 N 秒音频的平均音量电平（0.0-1.0）。"""
    try:
        # 使用 ffmpeg 获取音频统计信息
        cmd = [
            "ffmpeg",
            "-i", str(audio_path),
            "-af", f"atrim=end={duration_sec},volumedetect",
            "-f", "null",
            "-",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        
        # 解析 volumedetect 输出中的 mean_volume
        for line in result.stderr.split("\n"):
            if "mean_volume:" in line:
                # 格式: mean_volume: -20.5 dB
                db_str = line.split(":")[1].strip().split()[0]
                db = float(db_str)
                # 转换 dB 到 0-1 范围（-60dB = 0, 0dB = 1）
                level = min(1.0, max(0.0, (db + 60) / 60))
                return level
        return 0.0
    except Exception:
        return 0.0


def monitor_silence(title, audio_path):
    """后台静默检测进程。"""
    audio_path = Path(audio_path)
    
    # 保存 monitor PID
    with open(MONITOR_PID_FILE, "w") as f:
        json.dump({"pid": os.getpid()}, f)

    silence_start = None
    print(f"🔍 开始静默检测: {title}")

    while True:
        time.sleep(CHECK_INTERVAL)

        # 检查录制是否还在进行
        if not PID_FILE.exists():
            print("录制已停止，退出检测")
            break

        # 检查音频文件是否存在且有内容
        if not audio_path.exists() or audio_path.stat().st_size < 1024:
            continue

        # 获取音量电平
        level = get_audio_level(audio_path)
        print(f"  音量电平: {level:.4f}")

        if level < SILENCE_THRESHOLD:
            if silence_start is None:
                silence_start = time.time()
                print(f"  开始检测静默...")
            else:
                elapsed = time.time() - silence_start
                print(f"  已静默 {elapsed:.0f}s")
                if elapsed >= SILENCE_DURATION_SEC:
                    print("  ⚠️ 静默超过阈值，触发自动停止询问")
                    _trigger_auto_stop(title)
                    break
        else:
            if silence_start is not None:
                print(f"  检测到声音，重置静默计时")
            silence_start = None


def _trigger_auto_stop(title):
    """触发自动停止询问。"""
    daemon = SCRIPT_DIR / "meeting_daemon.py"
    subprocess.Popen([
        sys.executable, str(daemon), "auto_stop",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ───────────────────────────────────────────────
# 主入口
# ───────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("""Usage: record_audio.py <command> [args]

Commands:
  start <title>              开始录制
  stop                       停止录制
  monitor <title> <path>     后台静默检测
""")
        sys.exit(1)

    action = sys.argv[1]
    if action == "start":
        title = sys.argv[2] if len(sys.argv) > 2 else "meeting"
        start_recording(title)
    elif action == "stop":
        stop_recording()
    elif action == "monitor":
        if len(sys.argv) < 4:
            print("Usage: record_audio.py monitor <title> <audio_path>", file=sys.stderr)
            sys.exit(1)
        monitor_silence(sys.argv[2], sys.argv[3])
    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
