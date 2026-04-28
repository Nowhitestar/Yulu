#!/usr/bin/env python3
"""
录制会议音频（麦克风 + 扬声器）。

依赖：
- ffmpeg
- macOS: BlackHole (或 Soundflower) 虚拟音频设备用于录制系统声音

安装 BlackHole:
  brew install blackhole-2ch

然后在系统偏好设置 -> 声音 -> 输出中选择 BlackHole，
同时在音频 MIDI 设置中创建多输出设备，包含 BlackHole 和你的实际输出设备。

配置：
在 ~/.config/meeting-assistant/config.json 中设置：
{
  "audio": {
    "mic_device": ":0",
    "system_audio_device": ":1",
    "output_dir": "~/Downloads/meeting-recordings",
    "format": "wav"
  }
}
"""

import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "meeting-assistant" / "config.json"
PID_FILE = Path.home() / ".config" / "meeting-assistant" / ".recording_pid"


def load_config():
    if not CONFIG_PATH.exists():
        print(f"Config not found at {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def start_recording(meeting_title="meeting"):
    config = load_config()
    audio_config = config.get("audio", {})
    output_dir = Path(audio_config.get("output_dir", "~/Downloads/meeting-recordings")).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_title = "".join(c if c.isalnum() or c in "-_ " else "_" for c in meeting_title)
    output_file = output_dir / f"{safe_title}_{timestamp}.wav"

    # macOS 使用 ffmpeg + avfoundation
    # 麦克风
    mic = audio_config.get("mic_device", ":0")
    # 系统音频（通过 BlackHole）
    sys_audio = audio_config.get("system_audio_device", ":1")

    # 同时录制麦克风和系统音频，混合输出
    # 使用 ffmpeg 的 amix 滤镜合并两个输入
    cmd = [
        "ffmpeg",
        "-y",  # 覆盖输出
        "-f", "avfoundation",
        "-i", mic,  # 麦克风
        "-f", "avfoundation",
        "-i", sys_audio,  # 系统音频
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

    # 保存 PID 和输出文件路径
    with open(PID_FILE, "w") as f:
        json.dump({"pid": process.pid, "file": str(output_file)}, f)

    print(f"Recording started (PID: {process.pid})")
    print(f"Output: {output_file}")
    return process, str(output_file)


def stop_recording():
    if not PID_FILE.exists():
        print("No active recording found.", file=sys.stderr)
        sys.exit(1)

    with open(PID_FILE) as f:
        info = json.load(f)

    pid = info["pid"]
    output_file = info["file"]

    try:
        os.kill(pid, signal.SIGTERM)
        print(f"Sent stop signal to recording process (PID: {pid})")
        # 等待进程结束
        time.sleep(2)
    except ProcessLookupError:
        print(f"Process {pid} not found, may have already exited.")

    PID_FILE.unlink(missing_ok=True)
    print(f"Recording saved: {output_file}")
    return output_file


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: record_audio.py <start|stop> [meeting_title]", file=sys.stderr)
        sys.exit(1)

    action = sys.argv[1]
    if action == "start":
        title = sys.argv[2] if len(sys.argv) > 2 else "meeting"
        start_recording(title)
    elif action == "stop":
        stop_recording()
    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        sys.exit(1)
