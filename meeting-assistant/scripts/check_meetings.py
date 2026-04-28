#!/usr/bin/env python3
"""
检查即将到来的会议。
支持飞书日历和 Google Calendar。

配置：
- ~/.config/meeting-assistant/config.json

示例配置：
{
  "calendars": [
    {"type": "feishu", "enabled": true},
    {"type": "google", "enabled": true, "credentials_path": "~/.config/gcp/calendar-credentials.json"}
  ],
  "reminder_minutes_before": 5,
  "check_window_minutes": 10
}
"""

import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "meeting-assistant" / "config.json"


def load_config():
    if not CONFIG_PATH.exists():
        print(f"Config not found at {CONFIG_PATH}", file=sys.stderr)
        print("Run: mkdir -p ~/.config/meeting-assistant && echo '{}' > ~/.config/meeting-assistant/config.json", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def get_feishu_meetings(config, now, window_end):
    """通过飞书 API 获取会议列表。"""
    meetings = []
    # TODO: 使用 feishu_calendar API 获取事件
    # 当前返回空列表，等待用户配置
    return meetings


def get_google_meetings(config, now, window_end):
    """通过 Google Calendar API 获取会议列表。"""
    meetings = []
    # TODO: 使用 google calendar API 获取事件
    # 当前返回空列表，等待用户配置
    return meetings


def check_meetings():
    config = load_config()
    now = datetime.utcnow()
    window_minutes = config.get("check_window_minutes", 10)
    window_end = now + timedelta(minutes=window_minutes)

    all_meetings = []
    for cal in config.get("calendars", []):
        if not cal.get("enabled", False):
            continue
        if cal["type"] == "feishu":
            all_meetings.extend(get_feishu_meetings(cal, now, window_end))
        elif cal["type"] == "google":
            all_meetings.extend(get_google_meetings(cal, now, window_end))

    # 过滤即将开始的会议（未来 10 分钟内）
    upcoming = []
    for m in all_meetings:
        start_time = datetime.fromisoformat(m["start"].replace("Z", "+00:00"))
        if now <= start_time <= window_end:
            upcoming.append(m)

    # 输出 JSON，供 cron/其他脚本使用
    print(json.dumps(upcoming, ensure_ascii=False, indent=2))
    return upcoming


if __name__ == "__main__":
    check_meetings()
