#!/usr/bin/env python3
"""
发送会议纪要到指定频道。

支持：
- Zulip（通过 message tool）
- Notion（通过 Notion API）

配置：
{
  "output": {
    "channel": "zulip",  # "zulip" 或 "notion"
    "zulip": {
      "stream": "meetings",
      "topic": "会议纪要"
    },
    "notion": {
      "api_key_env": "NOTION_API_KEY",
      "database_id": "your-database-id"
    }
  }
}
"""

import json
import os
import sys
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "meeting-assistant" / "config.json"


def load_config():
    if not CONFIG_PATH.exists():
        print(f"Config not found at {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def send_to_zulip(summary_path, config):
    """发送纪要内容到 Zulip 频道。"""
    with open(summary_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 通过 OpenClaw 的 message tool 发送
    # 这里输出内容，由调用者决定如何发送
    print("=== ZULIP MESSAGE ===")
    print(f"Stream: {config.get('stream', 'general')}")
    print(f"Topic: {config.get('topic', '会议纪要')}")
    print(f"\n{content}")
    print("=== END ===")
    return True


def send_to_notion(summary_path, config):
    """创建 Notion 页面作为会议纪要。"""
    try:
        from notion_client import Client
    except ImportError:
        print("notion-client not installed. Run: pip install notion-client", file=sys.stderr)
        sys.exit(1)

    api_key = os.environ.get(config.get("api_key_env", "NOTION_API_KEY"))
    if not api_key:
        print("NOTION_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    notion = Client(auth=api_key)
    database_id = config.get("database_id")
    if not database_id:
        print("Notion database_id not configured", file=sys.stderr)
        sys.exit(1)

    with open(summary_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 从文件名提取会议标题和日期
    summary_name = Path(summary_path).stem
    parts = summary_name.rsplit("_", 1)
    title = parts[0].replace("_", " ")

    # 创建 Notion 页面
    page = notion.pages.create(
        parent={"database_id": database_id},
        properties={
            "Name": {"title": [{"text": {"content": title}}]},
            "Status": {"select": {"name": "已完成"}},
            "Date": {"date": {"start": parts[1][:8]}},
        },
        children=[
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": content}}]
                },
            }
        ],
    )

    print(f"Notion page created: {page['url']}")
    return True


def send_summary(summary_path):
    config = load_config()
    output_config = config.get("output", {})
    channel = output_config.get("channel", "zulip")

    channel_config = output_config.get(channel, {})

    if channel == "zulip":
        return send_to_zulip(summary_path, channel_config)
    elif channel == "notion":
        return send_to_notion(summary_path, channel_config)
    else:
        print(f"Unknown output channel: {channel}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: send_summary.py <summary_file_path>", file=sys.stderr)
        sys.exit(1)

    summary_file = sys.argv[1]
    send_summary(summary_file)
