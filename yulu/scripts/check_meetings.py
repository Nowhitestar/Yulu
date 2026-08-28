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
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"

STABLE_FAILURE_REASONS = {
    "runtime_missing",
    "authorization_denied",
    "authorization_restricted",
    "authorization_not_determined",
    "enumeration_failed",
}


class CalendarSourceError(RuntimeError):
    """A stable provider failure that never includes command output or secrets."""

    def __init__(self, source, reason):
        stable_reason = reason if reason in STABLE_FAILURE_REASONS else "enumeration_failed"
        self.source = source
        self.reason = stable_reason
        super().__init__(f"calendar_source_error:{source}:{stable_reason}")


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

    calendars = config.get("calendars", [])

    all_meetings = []
    for cal in calendars:
        if not cal.get("enabled", False):
            continue
        if cal["type"] == "feishu":
            all_meetings.extend(_fetch_feishu(cal, start, end))
        elif cal["type"] == "google":
            all_meetings.extend(_fetch_google(cal, start, end))
        elif cal["type"] in ("macos", "system"):
            all_meetings.extend(_fetch_macos_calendar(cal, start, end))
    
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
    通过 gog CLI 获取 Google Calendar 会议列表。
    不需要 Google API Python 库，gog 处理了 OAuth。
    """
    account = config.get("gog_account")
    if not account:
        raise CalendarSourceError("gog", "authorization_not_determined")

    fmt_start = start.strftime("%Y-%m-%dT%H:%M:%S%z") if hasattr(start, 'strftime') else str(start)
    fmt_end = end.strftime("%Y-%m-%dT%H:%M:%S%z") if hasattr(end, 'strftime') else str(end)

    cmd = [
        "gog",
        "--json",
        "--results-only",
        "--no-input",
        "--account", account,
        "calendar", "events", "primary",
        "--all-pages",
        "--from", fmt_start,
        "--to", fmt_end,
    ]

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except FileNotFoundError as error:
        raise CalendarSourceError("gog", "runtime_missing") from error
    except (subprocess.TimeoutExpired, OSError) as error:
        raise CalendarSourceError("gog", "enumeration_failed") from error

    if r.returncode != 0:
        diagnostic = f"{r.stdout}\n{r.stderr}".lower()
        reason = "authorization_denied" if any(marker in diagnostic for marker in (
            "not authenticated",
            "unauthorized",
            "unauthorised",
            "oauth",
            "auth required",
            "login required",
            "credential",
            "token expired",
        )) else "enumeration_failed"
        raise CalendarSourceError("gog", reason)
    try:
        data = json.loads(r.stdout)
    except (json.JSONDecodeError, TypeError) as error:
        raise CalendarSourceError("gog", "enumeration_failed") from error

    if isinstance(data, list):
        events = data
    elif isinstance(data, dict):
        if "events" in data:
            events = data["events"]
        elif "items" in data:
            events = data["items"]
        elif "result" in data:
            nested = data["result"]
            if isinstance(nested, list):
                events = nested
            elif isinstance(nested, dict) and "events" in nested:
                events = nested["events"]
            elif isinstance(nested, dict) and "items" in nested:
                events = nested["items"]
            else:
                events = None
        else:
            events = None
    else:
        events = None
    if not isinstance(events, list):
        raise CalendarSourceError("gog", "enumeration_failed")

    for event in events:
        if not isinstance(event, dict):
            raise CalendarSourceError("gog", "enumeration_failed")
        for boundary in ("start", "end"):
            value = event.get(boundary)
            if not isinstance(value, dict):
                raise CalendarSourceError("gog", "enumeration_failed")
            raw = value.get("dateTime") or value.get("date")
            if not isinstance(raw, str):
                raise CalendarSourceError("gog", "enumeration_failed")
            try:
                datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError as error:
                raise CalendarSourceError("gog", "enumeration_failed") from error

    meetings = []
    for ev in events:
        start_raw = ev.get("start", {}).get("dateTime") or ev.get("start", {}).get("date")
        end_raw = ev.get("end", {}).get("dateTime") or ev.get("end", {}).get("date")
        if not start_raw:
            continue

        # Google Meet 链接
        link = ev.get("hangoutLink") or ""
        if not link and ev.get("conferenceData"):
            for ep in ev["conferenceData"].get("entryPoints", []):
                if ep.get("entryPointType") == "video":
                    link = ep.get("uri", "")
                    break

        # 参会人
        attendees = []
        for a in ev.get("attendees", []):
            name = a.get("displayName") or a.get("email", "")
            if name:
                attendees.append(name)

        meetings.append({
            "id": ev.get("id", ""),
            "title": ev.get("summary", "(无标题)"),
            "start": start_raw,
            "end": end_raw,
            "link": link,
            "attendees": attendees,
            "description": ev.get("description", ""),
            "source": "google",
        })

    return meetings


def _calendar_probe_path():
    return Path(__file__).resolve().parent / "Yulu.app" / "Contents" / "MacOS" / "calendar_probe"


def _calendar_iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _fetch_macos_calendar(config, start, end):
    """Read the selected system calendars through Yulu's signed EventKit helper."""
    if sys.platform != "darwin":
        raise CalendarSourceError("macos", "runtime_missing")

    watch = config.get("watch_calendars") or config.get("calendar_names") or []
    if not isinstance(watch, list):
        watch = []
    data = []
    cursor = start
    while cursor < end:
        chunk_end = min(cursor + timedelta(hours=48), end)
        command = [
            str(_calendar_probe_path()),
            "--events",
            "--start", _calendar_iso(cursor),
            "--end", _calendar_iso(chunk_end),
            "--calendars-json", json.dumps([str(item) for item in watch if item], ensure_ascii=False),
        ]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=35)
        except FileNotFoundError as error:
            raise CalendarSourceError("macos", "runtime_missing") from error
        except (subprocess.TimeoutExpired, OSError) as error:
            raise CalendarSourceError("macos", "enumeration_failed") from error
        try:
            payload = json.loads(result.stdout)
        except (json.JSONDecodeError, TypeError) as error:
            raise CalendarSourceError("macos", "enumeration_failed") from error
        if result.returncode != 0 or not isinstance(payload, dict) or payload.get("ok") is not True:
            reason = payload.get("reason", "enumeration_failed") if isinstance(payload, dict) else "enumeration_failed"
            raise CalendarSourceError("macos", reason)
        if payload.get("start") != command[3] or payload.get("end") != command[5]:
            raise CalendarSourceError("macos", "enumeration_failed")
        chunk_events = payload.get("events")
        if not isinstance(chunk_events, list):
            raise CalendarSourceError("macos", "enumeration_failed")
        data.extend(chunk_events)
        cursor = chunk_end

    meetings = []
    seen = set()
    for event in data:
        if not isinstance(event, dict):
            raise CalendarSourceError("macos", "enumeration_failed")
        start_raw = event.get("start")
        end_raw = event.get("end")
        if not isinstance(start_raw, str) or not isinstance(end_raw, str):
            raise CalendarSourceError("macos", "enumeration_failed")
        attendees = event.get("attendees")
        if not isinstance(attendees, list) or not all(isinstance(item, str) for item in attendees):
            raise CalendarSourceError("macos", "enumeration_failed")
        try:
            datetime.fromisoformat(start_raw.replace("Z", "+00:00"))
            datetime.fromisoformat(end_raw.replace("Z", "+00:00"))
        except ValueError as error:
            raise CalendarSourceError("macos", "enumeration_failed") from error
        identity = (str(event.get("id", "")), str(start_raw), str(end_raw))
        if identity in seen:
            continue
        seen.add(identity)
        meetings.append({
            "id": str(event.get("id", "")),
            "title": str(event.get("title") or "(无标题)"),
            "start": str(start_raw),
            "end": str(end_raw),
            "link": str(event.get("link", "")),
            "attendees": [attendee for attendee in attendees if attendee],
            "description": str(event.get("description", "")),
            "calendar": str(event.get("calendar", "")),
            "source": "macos",
        })
    return meetings

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
    args = sys.argv[1:]
    use_json = "--json" in args or "-j" in args
    args = [a for a in args if a not in ("--json", "-j")]

    cmd = args[0] if args else "today"

    now = datetime.now().astimezone()

    try:
        if cmd == "today":
            start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(days=1)
        elif cmd == "tomorrow":
            start = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(days=1)
        elif cmd == "yesterday":
            start = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(days=1)
        elif cmd == "upcoming":
            start = now
            end = now + timedelta(hours=24)
        elif cmd == "week":
            start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(days=7)
        elif cmd == "json":
            start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(days=1)
        else:
            print(f"Unknown command: {cmd}", file=sys.stderr)
            sys.exit(1)

        meetings = fetch_meetings(start, end)
    except CalendarSourceError as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)

    if use_json or cmd == "json":
        print(json.dumps(meetings, ensure_ascii=False, indent=2))
    else:
        print_meetings(meetings)


if __name__ == "__main__":
    main()
