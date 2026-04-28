#!/usr/bin/env python3
"""
会议助手守护进程。

功能：
1. 定期检查即将开始的会议
2. 会议前5分钟发送提醒
3. 会议开始时提醒并开始录制
4. 会议结束后停止录制并生成纪要
5. 发送纪要到指定频道

用法：
  meeting_daemon.py check    # 检查即将开始的会议
  meeting_daemon.py start    # 开始录制当前会议
  meeting_daemon.py stop     # 停止录制并处理

配置：~/.config/meeting-assistant/config.json
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "meeting-assistant" / "config.json"
STATE_PATH = Path.home() / ".config" / "meeting-assistant" / ".state.json"


def load_config():
    if not CONFIG_PATH.exists():
        return {}
    with open(CONFIG_PATH) as f:
        return json.load(f)


def load_state():
    if not STATE_PATH.exists():
        return {}
    with open(STATE_PATH) as f:
        return json.load(f)


def save_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def get_script_dir():
    return Path(__file__).parent


def check_upcoming_meetings():
    """检查即将开始的会议，返回需要提醒的会议列表。"""
    script = get_script_dir() / "check_meetings.py"
    result = subprocess.run(
        [sys.executable, str(script)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"check_meetings failed: {result.stderr}", file=sys.stderr)
        return []

    try:
        meetings = json.loads(result.stdout)
    except json.JSONDecodeError:
        print(f"Invalid JSON from check_meetings: {result.stdout}", file=sys.stderr)
        return []

    return meetings


def send_reminder(meeting, reminder_type="5min"):
    """发送会议提醒。"""
    title = meeting.get("title", "未知会议")
    start = meeting.get("start", "")
    link = meeting.get("link", "")

    if reminder_type == "5min":
        message = f"⏰ 会议提醒：「{title}」将在 5 分钟后开始"
    elif reminder_type == "start":
        message = f"🔴 会议开始：「{title}」\n\n开始录制会议音频..."
    else:
        message = f"📅 会议：「{title}」"

    if link:
        message += f"\n会议链接: {link}"

    # 通过 OpenClaw 的 message 工具发送
    # 这里输出内容，由 OpenClaw 处理发送
    print(f"=== REMINDER [{reminder_type}] ===")
    print(message)
    print("=== END ===")
    return message


def start_recording(meeting):
    """开始录制会议。"""
    title = meeting.get("title", "meeting")
    script = get_script_dir() / "record_audio.py"
    result = subprocess.run(
        [sys.executable, str(script), "start", title],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"Failed to start recording: {result.stderr}", file=sys.stderr)
        return None

    # 解析输出获取文件路径
    for line in result.stdout.split("\n"):
        if "Output:" in line:
            return line.split("Output:")[1].strip()
    return None


def stop_recording():
    """停止录制。"""
    script = get_script_dir() / "record_audio.py"
    result = subprocess.run(
        [sys.executable, str(script), "stop"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"Failed to stop recording: {result.stderr}", file=sys.stderr)
        return None

    # 解析输出获取文件路径
    for line in result.stdout.split("\n"):
        if "Recording saved:" in line:
            return line.split("Recording saved:")[1].strip()
    return None


def transcribe_and_summarize(audio_path):
    """转录音频并生成纪要。"""
    script = get_script_dir() / "transcribe.py"
    result = subprocess.run(
        [sys.executable, str(script), audio_path],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"Transcription failed: {result.stderr}", file=sys.stderr)
        return None, None

    # 解析输出获取文件路径
    transcript_path = None
    summary_path = None
    for line in result.stdout.split("\n"):
        if "Transcript saved:" in line:
            transcript_path = line.split("Transcript saved:")[1].strip()
        if "Summary saved:" in line:
            summary_path = line.split("Summary saved:")[1].strip()

    return transcript_path, summary_path


def send_summary(summary_path):
    """发送纪要。"""
    script = get_script_dir() / "send_summary.py"
    result = subprocess.run(
        [sys.executable, str(script), summary_path],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"Failed to send summary: {result.stderr}", file=sys.stderr)
        return False
    return True


def check():
    """主检查逻辑，由 cron 定期调用。"""
    config = load_config()
    state = load_state()
    now = datetime.utcnow()

    meetings = check_upcoming_meetings()
    if not meetings:
        return

    for meeting in meetings:
        meeting_id = meeting.get("id", meeting.get("title", "unknown"))
        start_time = datetime.fromisoformat(meeting["start"].replace("Z", "+00:00"))
        time_until_start = (start_time - now).total_seconds()

        # 检查是否已经处理过
        if meeting_id in state.get("processed", {}):
            continue

        # 会议前 5 分钟提醒
        if 0 < time_until_start <= 300:  # 5分钟内
            if not state.get("reminded_5min", {}).get(meeting_id):
                send_reminder(meeting, "5min")
                state.setdefault("reminded_5min", {})[meeting_id] = True
                save_state(state)

        # 会议开始
        if time_until_start <= 0 and time_until_start > -3600:  # 开始后1小时内
            if not state.get("recording", {}).get(meeting_id):
                send_reminder(meeting, "start")
                audio_path = start_recording(meeting)
                if audio_path:
                    state.setdefault("recording", {})[meeting_id] = {
                        "audio_path": audio_path,
                        "start_time": now.isoformat(),
                    }
                    save_state(state)


def stop():
    """停止当前录制并处理。"""
    state = load_state()

    # 停止录制
    audio_path = stop_recording()
    if not audio_path:
        print("No recording to stop.", file=sys.stderr)
        sys.exit(1)

    # 转录并生成纪要
    transcript_path, summary_path = transcribe_and_summarize(audio_path)
    if summary_path:
        send_summary(summary_path)

    # 清理状态
    for meeting_id, info in list(state.get("recording", {}).items()):
        if info.get("audio_path") == audio_path:
            state.setdefault("processed", {})[meeting_id] = {
                "audio_path": audio_path,
                "transcript": transcript_path,
                "summary": summary_path,
                "processed_at": datetime.utcnow().isoformat(),
            }
            del state["recording"][meeting_id]
            break

    save_state(state)
    print("Meeting processed successfully.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: meeting_daemon.py <check|stop>", file=sys.stderr)
        sys.exit(1)

    action = sys.argv[1]
    if action == "check":
        check()
    elif action == "stop":
        stop()
    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        sys.exit(1)
