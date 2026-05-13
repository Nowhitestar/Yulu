#!/usr/bin/env python3
"""
发送会议纪要到指定频道。

支持：
- file    — 仅保存到本地（默认）
- zulip   — 实验性：发送到 Zulip 频道（需手动安装/配置依赖）
- notion  — 实验性：创建 Notion 页面（需手动安装/配置依赖）
- telegram — 实验性：发送 Telegram 消息（需手动配置 bot token）

配置：
{
  "output": {
    "channel": "file",  # "file" | "zulip" | "notion" | "telegram"
    "zulip": {
      "stream": "meetings",
      "topic": "会议纪要"
    },
    "notion": {
      "api_key_env": "NOTION_API_KEY",
      "database_id": "your-database-id"
    },
    "telegram": {
      "chat_id": "your-chat-id"
    }
  }
}
"""

import json
import os
import sys
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"


def load_config():
    if not CONFIG_PATH.exists():
        print(f"Config not found at {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def send_to_file(summary_path):
    """仅保存到本地（默认）。"""
    print(f"📄 纪要已保存到本地: {summary_path}")
    return True


def send_to_zulip(summary_path, config):
    """发送到 Zulip 频道。"""
    try:
        with open(summary_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        print(f"Failed to read summary: {e}", file=sys.stderr)
        return False

    stream = config.get("stream", "general")
    topic = config.get("topic", "会议纪要")

    try:
        import zulip
    except ImportError:
        print("zulip package not installed. Run: pip install zulip", file=sys.stderr)
        return False

    try:
        client = zulip.Client(config_file=config.get("zuliprc", "~/.zuliprc"))
        resp = client.send_message({
            "type": "stream",
            "to": stream,
            "topic": topic,
            "content": content,
        })
        if resp.get("result") != "success":
            print(f"Zulip send failed: {resp}", file=sys.stderr)
            return False
        print(f"📤 Zulip 已发送: {stream} / {topic}")
        return True
    except Exception as e:
        print(f"Failed to send Zulip message: {e}", file=sys.stderr)
        return False


def send_to_notion(summary_path, config):
    """创建 Notion 页面。"""
    try:
        from notion_client import Client
    except ImportError:
        print("notion-client not installed. Run: pip install notion-client", file=sys.stderr)
        return False

    api_key = os.environ.get(config.get("api_key_env", "NOTION_API_KEY"))
    if not api_key:
        print("NOTION_API_KEY not set", file=sys.stderr)
        return False

    database_id = config.get("database_id")
    if not database_id:
        print("Notion database_id not configured", file=sys.stderr)
        return False

    try:
        with open(summary_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        print(f"Failed to read summary: {e}", file=sys.stderr)
        return False

    # 从文件名提取标题
    summary_name = Path(summary_path).stem
    parts = summary_name.rsplit("_", 1)
    title = parts[0].replace("_", " ")
    date_str = parts[1] if len(parts) > 1 else ""

    notion = Client(auth=api_key)

    def paragraph_blocks(text, chunk_size=1800):
        blocks = []
        for i in range(0, len(text), chunk_size):
            blocks.append({
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": text[i:i + chunk_size]}}]
                },
            })
        return blocks or [{
            "object": "block",
            "type": "paragraph",
            "paragraph": {"rich_text": [{"type": "text", "text": {"content": ""}}]},
        }]

    try:
        page = notion.pages.create(
            parent={"database_id": database_id},
            properties={
                "Name": {"title": [{"text": {"content": title}}]},
                "Status": {"select": {"name": "已完成"}},
            },
            children=paragraph_blocks(content),
        )
        print(f"📤 Notion 页面已创建: {page['url']}")
        return True
    except Exception as e:
        print(f"Failed to create Notion page: {e}", file=sys.stderr)
        return False


def send_to_telegram(summary_path, config):
    """通过 Telegram Bot API 发送。"""
    try:
        with open(summary_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        print(f"Failed to read summary: {e}", file=sys.stderr)
        return False

    chat_id = config.get("chat_id", "")
    if not chat_id:
        print("Telegram chat_id not configured", file=sys.stderr)
        return False
    token = os.environ.get(config.get("bot_token_env", "TELEGRAM_BOT_TOKEN"), "")
    if not token:
        print("TELEGRAM_BOT_TOKEN not set", file=sys.stderr)
        return False

    import urllib.parse
    import urllib.request

    def chunks(text, size=3900):
        for i in range(0, len(text), size):
            yield text[i:i + size]

    try:
        for part in chunks(content):
            data = urllib.parse.urlencode({
                "chat_id": chat_id,
                "text": part,
                "disable_web_page_preview": "true",
            }).encode()
            req = urllib.request.Request(
                f"https://api.telegram.org/bot{token}/sendMessage",
                data=data,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = json.loads(resp.read())
            if not body.get("ok"):
                print(f"Telegram send failed: {body}", file=sys.stderr)
                return False
        print(f"📤 Telegram 已发送: {chat_id}")
        return True
    except Exception as e:
        print(f"Failed to send Telegram message: {e}", file=sys.stderr)
        return False


def send_summary(summary_path):
    config = load_config()
    output_config = config.get("output", {})
    channel = output_config.get("channel", "file")

    channel_config = output_config.get(channel, {})

    if channel == "file":
        return send_to_file(summary_path)
    elif channel == "zulip":
        return send_to_zulip(summary_path, channel_config)
    elif channel == "notion":
        return send_to_notion(summary_path, channel_config)
    elif channel == "telegram":
        return send_to_telegram(summary_path, channel_config)
    else:
        print(f"Unknown output channel: {channel}", file=sys.stderr)
        return False


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: send_summary.py <summary_file_path>", file=sys.stderr)
        sys.exit(1)

    summary_file = sys.argv[1]
    success = send_summary(summary_file)
    sys.exit(0 if success else 1)
