#!/usr/bin/env python3
"""
查询日历会议。

支持：飞书日历、Google Calendar（需要配置）。

用法：
  check_meetings.py today       # 获取今天所有会议
  check_meetings.py upcoming    # 获取未来24小时会议
  check_meetings.py json        # 输出 JSON 格式（供其他脚本使用）
"""

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "meeting-assistant" / "config.json"


def load_config():
    if not CONFIG_PATH.exists():
        print(f"Config not found at {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def fetch_meetings(start, end, config=None):
    """获取指定时间范围内的会议。"""
    if config is None:
        config = load_config()
    
    all_meetings = []
    for cal in config.get("calendars", []):
        if not cal.get("enabled", False):
            continue
        if cal["type"] == "feishu":
            all_meetings.extend(_fetch_feishu(cal, start, end))
        elif cal["type"] == "google":
            all_meetings.extend(_fetch_google(cal, start, end))
    
    all_meetings.sort(key=lambda m: m["start"])
    return all_meetings


def _fetch_feishu(config, start, end):
    """
    通过飞书 API 获取会议列表。
    
    需要配置：
    - feishu_app_id / feishu_app_secret（环境变量或 config）
    
    TODO: 实现具体 API 调用
    """
    # 示例返回格式：
    # return [
    #     {
    #         "id": "event_001",
    #         "title": "项目周会",
    #         "start": "2026-04-29T10:00:00",
    #         "end": "2026-04-29T11:00:00",
    #         "link": "https://meetings.feishu.cn/...",
    #         "attendees": ["张三", "李四"],
    #     }
    # ]
    return []


def _fetch_google(config, start, end):
    """
    通过 Google Calendar API 获取会议列表。
    
    需要配置：
    - credentials_path: GCP OAuth 凭证文件路径
    
    TODO: 实现具体 API 调用
    """
    return []


def print_meetings(meetings):
    """打印会议列表。"""
    if not meetings:
        print("没有找到会议。")
        return
    
    print(f"\n📅 找到 {len(meetings)} 个会议:\n")
    for m in meetings:
        start = datetime.fromisoformat(m["start"].replace("Z", "+00:00"))
        print(f"  • {m['title']}")
        print(f"    时间: {start.strftime('%Y-%m-%d %H:%M')}")
        if m.get("link"):
            print(f"    链接: {m['link']}")
        print()


def main():
    if len(sys.argv) < 2:
        cmd = "today"
    else:
        cmd = sys.argv[1]
    
    now = datetime.now()
    
    if cmd == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
    elif cmd == "upcoming":
        start = now
        end = now + timedelta(hours=24)
    elif cmd == "json":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
        meetings = fetch_meetings(start, end)
        print(json.dumps(meetings, ensure_ascii=False, indent=2))
        return
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)
    
    meetings = fetch_meetings(start, end)
    print_meetings(meetings)


if __name__ == "__main__":
    main()
