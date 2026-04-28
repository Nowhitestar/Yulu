#!/usr/bin/env python3
"""
会议助手主调度脚本（重构版）。

每天一次设定当天提醒，每分钟检查触发。

命令：
  schedule    — 每天早上运行，扫描当天日历并设定提醒计划
  check       — 每分钟运行（cron），检查是否有到时间的提醒/录制
  remind      — 发送会议前5分钟提醒
  ask_record  — 会议开始时询问是否录制
  auto_stop   — 检测到静默时询问是否停止
  stop        — 手动停止录制并生成纪要
"""

import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "meeting-assistant" / "config.json"
SCHEDULE_PATH = Path.home() / ".config" / "meeting-assistant" / "schedule.json"
STATE_PATH = Path.home() / ".config" / "meeting-assistant" / ".state.json"
SCRIPT_DIR = Path(__file__).parent


def load_config():
    if not CONFIG_PATH.exists():
        print(f"Config not found at {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def load_schedule():
    if not SCHEDULE_PATH.exists():
        return []
    with open(SCHEDULE_PATH) as f:
        return json.load(f)


def save_schedule(schedule):
    SCHEDULE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(SCHEDULE_PATH, "w") as f:
        json.dump(schedule, f, indent=2, ensure_ascii=False, default=str)


def load_state():
    if not STATE_PATH.exists():
        return {"processed": {}, "recording": {}}
    with open(STATE_PATH) as f:
        return json.load(f)


def save_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False, default=str)


# ───────────────────────────────────────────────
# 日历获取
# ───────────────────────────────────────────────

def fetch_today_meetings():
    """获取今天所有会议。"""
    config = load_config()
    now = datetime.now()
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_of_day = start_of_day + timedelta(days=1)

    all_meetings = []
    
    for cal in config.get("calendars", []):
        if not cal.get("enabled", False):
            continue
        if cal["type"] == "feishu":
            all_meetings.extend(_fetch_feishu(cal, start_of_day, end_of_day))
        elif cal["type"] == "google":
            all_meetings.extend(_fetch_google(cal, start_of_day, end_of_day))

    # 按开始时间排序
    all_meetings.sort(key=lambda m: m["start"])
    return all_meetings


def _fetch_feishu(config, start, end):
    """TODO: 实现飞书日历 API 调用。"""
    return []


def _fetch_google(config, start, end):
    """TODO: 实现 Google Calendar API 调用。"""
    return []


# ───────────────────────────────────────────────
# 调度：每天设定提醒
# ───────────────────────────────────────────────

def cmd_schedule():
    """每天早上运行，设定当天提醒计划。"""
    print("📅 正在扫描今天日历...")
    meetings = fetch_today_meetings()
    
    if not meetings:
        print("今天没有会议。")
        save_schedule([])
        return

    schedule = []
    for m in meetings:
        start = _parse_time(m["start"])
        remind_at = start - timedelta(minutes=5)
        
        schedule.append({
            "id": m.get("id", m["title"]),
            "title": m["title"],
            "start": start.isoformat(),
            "remind_at": remind_at.isoformat(),
            "link": m.get("link", ""),
            "reminded_5min": False,
            "started": False,
            "recorded": False,
            "stopped": False,
        })
        print(f"  • {m['title']} @ {start.strftime('%H:%M')} (提醒: {remind_at.strftime('%H:%M')})")

    save_schedule(schedule)
    print(f"\n✅ 已设定 {len(schedule)} 个会议的提醒计划")


def _parse_time(t):
    """解析时间字符串。"""
    if isinstance(t, str):
        return datetime.fromisoformat(t.replace("Z", "+00:00"))
    return t


# ───────────────────────────────────────────────
# 检查：每分钟触发
# ───────────────────────────────────────────────

def cmd_check():
    """每分钟运行，检查是否需要提醒或开始录制。"""
    schedule = load_schedule()
    if not schedule:
        return

    now = datetime.now()
    state = load_state()
    updated = False

    for item in schedule:
        if item.get("stopped"):
            continue

        start = _parse_time(item["start"])
        remind_at = _parse_time(item["remind_at"])
        meeting_id = item["id"]

        # T-5min 提醒
        if not item.get("reminded_5min") and now >= remind_at:
            print(f"⏰ 触发5分钟提醒: {item['title']}")
            _trigger_remind(item)
            item["reminded_5min"] = True
            updated = True

        # T-0min 会议开始
        if not item.get("started") and now >= start:
            print(f"🔴 会议开始: {item['title']}")
            _trigger_start(item)
            item["started"] = True
            updated = True

    if updated:
        save_schedule(schedule)


def _trigger_remind(item):
    """发送T-5min系统通知。"""
    script = SCRIPT_DIR / "notify.py"
    title = item["title"]
    start = _parse_time(item["start"]).strftime("%H:%M")
    message = f"会议将在 5 分钟后开始 ({start})"
    
    subprocess.Popen([
        sys.executable, str(script),
        "remind", "Meeting Assistant", message, title,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _trigger_start(item):
    """会议开始时：弹出"是否录制"对话框。"""
    script = SCRIPT_DIR / "notify.py"
    title = item["title"]
    
    # 非阻塞地弹出对话框，用户选择后通过 state 记录
    subprocess.Popen([
        sys.executable, str(script),
        "ask_record", title,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    # 同时记录到 state，让后续处理知道有这个会议需要响应
    state = load_state()
    state["pending_record"] = {
        "meeting_id": item["id"],
        "title": title,
        "start_time": item["start"],
        "asked_at": datetime.now().isoformat(),
    }
    save_state(state)


# ───────────────────────────────────────────────
# 录制相关
# ───────────────────────────────────────────────

def cmd_ask_record():
    """会议开始时询问是否录制（由 notify.py 内部调用或测试）。"""
    if len(sys.argv) < 3:
        print("Usage: meeting_daemon.py ask_record <meeting_title>", file=sys.stderr)
        sys.exit(1)
    
    title = sys.argv[2]
    script = SCRIPT_DIR / "notify.py"
    
    result = subprocess.run(
        [sys.executable, str(script), "ask_record", title],
        capture_output=True,
        text=True,
    )
    choice = result.stdout.strip()
    print(f"User choice: {choice}")
    
    if choice == "开始录制":
        _start_recording(title)
    elif choice in ("忽略", "timeout"):
        print("用户选择不录制")
        # 标记为已处理但不录制
        state = load_state()
        state.setdefault("processed", {})[title] = {
            "action": "skipped",
            "time": datetime.now().isoformat(),
        }
        save_state(state)


def _start_recording(title):
    """开始录制。"""
    print(f"🎙️ 开始录制: {title}")
    script = SCRIPT_DIR / "record_audio.py"
    
    result = subprocess.run(
        [sys.executable, str(script), "start", title],
        capture_output=True,
        text=True,
    )
    
    # 解析输出获取文件路径
    audio_path = None
    for line in result.stdout.split("\n"):
        if "Output:" in line:
            audio_path = line.split("Output:")[1].strip()
    
    if audio_path:
        state = load_state()
        state["recording"] = {
            "title": title,
            "audio_path": audio_path,
            "start_time": datetime.now().isoformat(),
        }
        save_state(state)
        print(f"✅ 录制中: {audio_path}")
        
        # 启动静默检测
        _start_silence_monitor(title, audio_path)
    else:
        print("❌ 开始录制失败", file=sys.stderr)


def _start_silence_monitor(title, audio_path):
    """启动静默检测进程。"""
    script = SCRIPT_DIR / "record_audio.py"
    subprocess.Popen([
        sys.executable, str(script), "monitor", title, audio_path,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cmd_auto_stop():
    """检测到静默时询问是否停止（由 record_audio.py monitor 调用）。"""
    state = load_state()
    recording = state.get("recording")
    if not recording:
        return
    
    title = recording["title"]
    script = SCRIPT_DIR / "notify.py"
    
    result = subprocess.run(
        [sys.executable, str(script), "ask_stop", title],
        capture_output=True,
        text=True,
    )
    choice = result.stdout.strip()
    print(f"Auto-stop choice: {choice}")
    
    if choice in ("停止", "timeout"):
        _stop_and_process()
    else:
        print("继续录制")


def cmd_stop():
    """手动停止录制并生成纪要。"""
    print("🛑 停止录制...")
    _stop_and_process()


def _stop_and_process():
    """停止录制并处理后续流程。"""
    state = load_state()
    recording = state.get("recording")
    if not recording:
        print("没有正在进行的录制", file=sys.stderr)
        return
    
    title = recording["title"]
    audio_path = recording["audio_path"]
    
    # 1. 停止录制
    script = SCRIPT_DIR / "record_audio.py"
    subprocess.run(
        [sys.executable, str(script), "stop"],
        capture_output=True,
    )
    
    # 2. 通知正在处理
    notify_script = SCRIPT_DIR / "notify.py"
    subprocess.Popen([
        sys.executable, str(notify_script), "notify_stop", title,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    # 3. 转录
    print("📝 正在转录...")
    transcript_script = SCRIPT_DIR / "transcribe.py"
    result = subprocess.run(
        [sys.executable, str(transcript_script), audio_path],
        capture_output=True,
        text=True,
    )
    
    # 解析输出
    summary_path = None
    for line in result.stdout.split("\n"):
        if "Summary saved:" in line:
            summary_path = line.split("Summary saved:")[1].strip()
    
    if not summary_path:
        print("❌ 转录失败", file=sys.stderr)
        return
    
    print(f"✅ 纪要已生成: {summary_path}")
    
    # 4. 发送
    print("📤 正在发送纪要...")
    send_script = SCRIPT_DIR / "send_summary.py"
    subprocess.run(
        [sys.executable, str(send_script), summary_path],
        capture_output=True,
    )
    
    # 5. 通知完成
    config = load_config()
    channel = config.get("output", {}).get("channel", "zulip")
    subprocess.Popen([
        sys.executable, str(notify_script), "notify_sent", title, channel,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    # 6. 更新状态
    state.setdefault("processed", {})[title] = {
        "audio_path": audio_path,
        "summary": summary_path,
        "processed_at": datetime.now().isoformat(),
    }
    state["recording"] = {}
    save_state(state)
    
    print("✅ 会议处理完成！")


# ───────────────────────────────────────────────
# 主入口
# ───────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("""Usage: meeting_daemon.py <command>

Commands:
  schedule              每天早上运行，扫描当天日历设定提醒
  check                 每分钟运行，检查触发的提醒/录制
  ask_record <title>    询问是否录制（测试用）
  auto_stop             静默检测后询问是否停止
  stop                  手动停止录制并生成纪要
""")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "schedule":
        cmd_schedule()
    elif cmd == "check":
        cmd_check()
    elif cmd == "ask_record":
        cmd_ask_record()
    elif cmd == "auto_stop":
        cmd_auto_stop()
    elif cmd == "stop":
        cmd_stop()
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
