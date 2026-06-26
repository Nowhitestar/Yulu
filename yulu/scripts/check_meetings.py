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
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"


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
    if not calendars and sys.platform == "darwin":
        calendars = [{"type": "macos", "enabled": True}]

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
    import subprocess

    account = config.get("gog_account")
    if not account:
        print("⚠️ Google Calendar: 未配置 gog_account", file=sys.stderr)
        return []

    fmt_start = start.strftime("%Y-%m-%dT%H:%M:%S%z") if hasattr(start, 'strftime') else str(start)
    fmt_end = end.strftime("%Y-%m-%dT%H:%M:%S%z") if hasattr(end, 'strftime') else str(end)

    cmd = [
        "gog", "calendar", "events", account,
        "--from", fmt_start,
        "--to", fmt_end,
        "--json",
    ]
    env = {**os.environ, "GOG_ACCOUNT": account}

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env)
        if r.returncode != 0:
            print(f"⚠️ gog error: {r.stderr.strip()}", file=sys.stderr)
            return []
        data = json.loads(r.stdout)
    except Exception as e:
        print(f"⚠️ Google Calendar 获取失败: {e}", file=sys.stderr)
        return []

    meetings = []
    for ev in data.get("events", []):
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


MACOS_CALENDAR_JXA = r"""
function env(name) {
  const value = $.NSProcessInfo.processInfo.environment.objectForKey(name);
  return value ? String(value) : "";
}

const start = new Date(Number(env("YULU_CALENDAR_START_MS")));
const end = new Date(Number(env("YULU_CALENDAR_END_MS")));
const wantedRaw = env("YULU_CALENDAR_NAMES_JSON") || "[]";
let wanted = [];
try { wanted = JSON.parse(wantedRaw); } catch (_) { wanted = []; }
const wantedSet = new Set(wanted.map(String).filter(Boolean));

const Calendar = Application("Calendar");
const out = [];
for (const cal of Calendar.calendars()) {
  const calName = String(cal.name());
  if (wantedSet.size > 0 && !wantedSet.has(calName)) continue;
  for (const ev of cal.events()) {
    const startDate = ev.startDate();
    const endDate = ev.endDate();
    if (!startDate || !endDate) continue;
    if (endDate < start || startDate > end) continue;
    let link = "";
    let notes = "";
    try { link = String(ev.url() || ""); } catch (_) {}
    try { notes = String(ev.description() || ""); } catch (_) {}
    out.push({
      id: String(ev.uid ? ev.uid() : `${calName}:${ev.summary()}:${startDate.toISOString()}`),
      title: String(ev.summary() || "(无标题)"),
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      link,
      attendees: [],
      description: notes,
      calendar: calName,
      source: "macos",
    });
  }
}
JSON.stringify(out);
"""


def _fetch_macos_calendar(config, start, end):
    """
    通过 macOS 系统 Calendar 读取会议列表。

    这条路径复用用户已经接入系统日历的 Google/Exchange/iCloud 账号，不要求
    Yulu 另做 Google OAuth。系统会由 macOS 统一弹出 Calendar 权限。
    """
    if sys.platform != "darwin":
        return []

    watch = config.get("watch_calendars") or config.get("calendar_names") or []
    if not isinstance(watch, list):
        watch = []

    env = {
        **os.environ,
        "YULU_CALENDAR_START_MS": str(int(start.timestamp() * 1000)),
        "YULU_CALENDAR_END_MS": str(int(end.timestamp() * 1000)),
        "YULU_CALENDAR_NAMES_JSON": json.dumps(watch, ensure_ascii=False),
    }
    try:
        r = subprocess.run(
            ["osascript", "-l", "JavaScript", "-e", MACOS_CALENDAR_JXA],
            capture_output=True, text=True, timeout=30, env=env,
        )
        if r.returncode != 0:
            print(f"⚠️ macOS Calendar error: {r.stderr.strip()}", file=sys.stderr)
            return []
        data = json.loads(r.stdout)
    except Exception as e:
        print(f"⚠️ macOS Calendar 获取失败: {e}", file=sys.stderr)
        return []

    meetings = []
    for ev in data if isinstance(data, list) else []:
        if not isinstance(ev, dict):
            continue
        start_raw = ev.get("start")
        end_raw = ev.get("end")
        if not start_raw or not end_raw:
            continue
        meetings.append({
            "id": str(ev.get("id", "")),
            "title": str(ev.get("title") or "(无标题)"),
            "start": str(start_raw),
            "end": str(end_raw),
            "link": str(ev.get("link", "")),
            "attendees": [str(a) for a in ev.get("attendees", []) if a],
            "description": str(ev.get("description", "")),
            "calendar": str(ev.get("calendar", "")),
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
        meetings = fetch_meetings(start, end)
        print(json.dumps(meetings, ensure_ascii=False, indent=2))
        return
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)

    meetings = fetch_meetings(start, end)
    if use_json:
        print(json.dumps(meetings, ensure_ascii=False, indent=2))
    else:
        print_meetings(meetings)


if __name__ == "__main__":
    main()
