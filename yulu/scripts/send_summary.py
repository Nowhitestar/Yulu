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
import ssl
import sys
from configparser import ConfigParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"
NOTION_API_BASE = "https://api.notion.com/v1"
NOTION_VERSION = "2026-03-11"
ZULIP_TRANSIENT_ATTEMPTS = 3


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


def _read_zuliprc(path):
    rc_path = Path(path).expanduser()
    parser = ConfigParser()
    if not rc_path.exists():
        raise FileNotFoundError(f"zuliprc not found at {rc_path}")
    parser.read(rc_path, encoding="utf-8")
    if not parser.has_section("api"):
        raise ValueError("zuliprc missing [api] section")
    api = parser["api"]
    email = (api.get("email") or "").strip()
    key = (api.get("key") or "").strip()
    site = (api.get("site") or "").strip().rstrip("/")
    if not email or not key or not site:
        raise ValueError("zuliprc missing email, key, or site")
    return {"email": email, "key": key, "site": site}


def _is_transient_zulip_error(exc):
    reason = exc.reason
    text = str(reason)
    return (
        isinstance(reason, ssl.SSLError)
        or "UNEXPECTED_EOF_WHILE_READING" in text
        or "EOF occurred in violation" in text
    )


def _zulip_post_form(url, email, api_key, payload):
    import base64

    body = urlencode(payload).encode("utf-8")
    auth = base64.b64encode(f"{email}:{api_key}".encode("utf-8")).decode("ascii")
    request = Request(
        url,
        data=body,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )
    for attempt in range(ZULIP_TRANSIENT_ATTEMPTS):
        try:
            with urlopen(request, timeout=10) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            body_text = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Zulip API returned {exc.code}: {body_text}") from exc
        except URLError as exc:
            if attempt + 1 < ZULIP_TRANSIENT_ATTEMPTS and _is_transient_zulip_error(exc):
                continue
            raise RuntimeError(f"Zulip API request failed: {exc.reason}") from exc
    raise RuntimeError("Zulip API request failed")


def _send_to_zulip_rest(summary_path, config, content):
    creds = _read_zuliprc(config.get("zuliprc", "~/.zuliprc"))
    stream = config.get("stream_id") or config.get("stream") or "general"
    topic = config.get("topic", "会议纪要")
    return _zulip_post_form(
        f"{creds['site']}/api/v1/messages",
        creds["email"],
        creds["key"],
        {
            "type": "channel",
            "to": str(stream),
            "topic": topic,
            "content": content,
        },
    )


def _notion_api_key(config):
    api_key_env = config.get("api_key_env", "NOTION_API_KEY")
    api_key = os.environ.get(api_key_env, "")
    if not api_key and api_key_env == "NOTION_API_KEY":
        api_key = os.environ.get("NOTION_TOKEN", "")
    return api_key


def _notion_headers(api_key):
    return {
        "Authorization": f"Bearer {api_key}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _notion_post_json(url, api_key, payload, method="POST"):
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=_notion_headers(api_key),
        method=method,
    )
    try:
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Notion API returned {exc.code}: {body_text}") from exc
    except URLError as exc:
        raise RuntimeError(f"Notion API request failed: {exc.reason}") from exc


def _notion_paragraph_blocks(text, chunk_size=1800):
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


def _notion_summary_title(summary_path):
    summary_name = Path(summary_path).stem
    parts = summary_name.rsplit("_", 1)
    title = parts[0].replace("_", " ")
    return title, parts[1] if len(parts) > 1 else ""


def _send_to_notion_rest(summary_path, config, api_key, content, title):
    destination_id = config.get("destination_id") or config.get("database_id")
    destination_type = config.get("destination_type") or "database"
    blocks = _notion_paragraph_blocks(content)

    if destination_type == "page":
        _notion_post_json(
            f"{NOTION_API_BASE}/blocks/{destination_id}/children",
            api_key,
            {
                "children": [
                    {
                        "object": "block",
                        "type": "heading_2",
                        "heading_2": {
                            "rich_text": [{"type": "text", "text": {"content": title}}],
                        },
                    },
                    *blocks,
                ],
            },
            method="PATCH",
        )
        print(f"📤 Notion 已追加到页面: {destination_id}")
        return True

    page = _notion_post_json(
        f"{NOTION_API_BASE}/pages",
        api_key,
        {
            "parent": {"database_id": destination_id},
            "properties": {
                "Name": {"title": [{"text": {"content": title}}]},
                "Status": {"select": {"name": "已完成"}},
            },
            "children": blocks,
        },
    )
    print(f"📤 Notion 页面已创建: {page.get('url', destination_id)}")
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
        try:
            resp = _send_to_zulip_rest(summary_path, config, content)
            if resp.get("result") != "success":
                print(f"Zulip send failed: {resp}", file=sys.stderr)
                return False
            print(f"📤 Zulip 已发送: {config.get('stream') or config.get('stream_id') or 'general'} / {topic}")
            return True
        except Exception as e:
            print(f"Failed to send Zulip message: {e}", file=sys.stderr)
            return False

    try:
        client = zulip.Client(config_file=config.get("zuliprc", "~/.zuliprc"))
        resp = client.send_message({
            "type": "channel",
            "to": config.get("stream_id") or stream,
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
    api_key = _notion_api_key(config)
    if not api_key:
        print("NOTION_API_KEY not set", file=sys.stderr)
        return False

    destination_id = config.get("destination_id") or config.get("database_id")
    destination_type = config.get("destination_type") or "database"
    if not destination_id:
        print("Notion destination not configured", file=sys.stderr)
        return False

    try:
        with open(summary_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        print(f"Failed to read summary: {e}", file=sys.stderr)
        return False

    title, _date_str = _notion_summary_title(summary_path)

    try:
        from notion_client import Client
    except ImportError:
        try:
            return _send_to_notion_rest(summary_path, config, api_key, content, title)
        except Exception as e:
            print(f"Failed to create Notion page: {e}", file=sys.stderr)
            return False

    notion = Client(auth=api_key)

    try:
        if destination_type == "page":
            notion.blocks.children.append(
                block_id=destination_id,
                children=[
                    {
                        "object": "block",
                        "type": "heading_2",
                        "heading_2": {
                            "rich_text": [{"type": "text", "text": {"content": title}}],
                        },
                    },
                    *_notion_paragraph_blocks(content),
                ],
            )
            print(f"📤 Notion 已追加到页面: {destination_id}")
        else:
            page = notion.pages.create(
                parent={"database_id": destination_id},
                properties={
                    "Name": {"title": [{"text": {"content": title}}]},
                    "Status": {"select": {"name": "已完成"}},
                },
                children=_notion_paragraph_blocks(content),
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


def _summary_channels(config):
    """Return the legacy output.channel only.

    Connector send_summary switches now expose manual delivery from the meeting
    detail page. They intentionally do not auto-send when a summary is produced.
    """
    output_config = config.get("output", {})
    channels = [output_config.get("channel", "file")]

    out = []
    seen = set()
    for channel in channels:
        if not channel or channel in seen:
            continue
        seen.add(channel)
        out.append(channel)
    return out or ["file"]


def _send_to_channel(channel, summary_path, output_config):
    channel_config = output_config.get(channel, {})
    if channel == "file":
        return send_to_file(summary_path)
    if channel == "zulip":
        return send_to_zulip(summary_path, channel_config)
    if channel == "notion":
        return send_to_notion(summary_path, channel_config)
    if channel == "telegram":
        return send_to_telegram(summary_path, channel_config)
    print(f"Unknown output channel: {channel}", file=sys.stderr)
    return False


def send_summary(summary_path):
    config = load_config()
    output_config = config.get("output", {})
    ok = True
    for channel in _summary_channels(config):
        ok = _send_to_channel(channel, summary_path, output_config) and ok
    return ok


def send_summary_to_channel(summary_path, channel, config=None):
    config = config if config is not None else load_config()
    return _send_to_channel(channel, summary_path, config.get("output", {}))


def _resolve_summary_path(arg: str, prompt_slug: str | None) -> str:
    """If `arg` looks like a .summary.md path, use it directly.
    Else treat it as an audio path and derive the summary path from prompt_slug.
    Default slug 'summary' → <audio>.summary.md; else <audio>.<slug>.summary.md."""
    p = Path(arg)
    if p.name.endswith(".summary.md") or p.name.endswith(".md"):
        return str(p)
    slug = prompt_slug or "summary"
    suffix = ".summary.md" if slug == "summary" else f".{slug}.summary.md"
    return str(p.with_suffix(suffix))


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(
        prog="send_summary.py",
        description="Send a meeting summary to the configured channel.")
    parser.add_argument("path",
                        help="Summary .md path OR audio .wav path (combined with --prompt)")
    parser.add_argument("--prompt", default=None,
                        help="When path is an audio file, prompt slug to pick the "
                             "summary version (default: 'summary' → <audio>.summary.md)")
    parser.add_argument("--channel", choices=["file", "zulip", "notion", "telegram"], default=None,
                        help="Explicit channel for manual delivery. When omitted, uses output.channel.")
    args = parser.parse_args()

    summary_file = _resolve_summary_path(args.path, args.prompt)
    if not Path(summary_file).exists():
        print(f"summary file not found: {summary_file}", file=sys.stderr)
        print(f"  hint: yulu summaries list --audio {args.path}", file=sys.stderr)
        sys.exit(1)
    success = send_summary_to_channel(summary_file, args.channel) if args.channel else send_summary(summary_file)
    sys.exit(0 if success else 1)
