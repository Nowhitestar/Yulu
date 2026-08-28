#!/usr/bin/env python3
"""Production Calendar polling service.

Provider access is delegated to check_meetings.py. The macOS path uses Yulu's
signed EventKit helper and the optional Google path invokes gog with its native
OAuth custody. This process never reads, copies, or exchanges provider secrets.
"""

import json
import os
import signal
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "yulu"
SCRIPT_DIR = Path(__file__).resolve().parent
LEGACY_PUSH_AUDIT_PATH = CONFIG_DIR / ".watch_state.json"

LAST_SYNC = 0
SYNC_COOLDOWN = 10
POLL_INTERVAL_SEC = 300


def log(message):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {message}", flush=True)


def _existing_schedule_has_future_events():
    path = CONFIG_DIR / "schedule.json"
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text())
        now_timestamp = datetime.now(timezone.utc).astimezone().timestamp()
        for event in data.get("events", []):
            try:
                at = datetime.fromisoformat(event["at"].replace("Z", "+00:00"))
                if at.timestamp() > now_timestamp:
                    return True
            except Exception:
                continue
    except Exception:
        return False
    return False


def _notify_system(title, message):
    try:
        subprocess.Popen(
            [
                sys.executable,
                str(SCRIPT_DIR / "notify.py"),
                "remind",
                title,
                message,
                "日历健康检查",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


def _calendar_datetime(value, local_timezone):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=local_timezone)
    return parsed


def sync_calendar_to_schedule():
    """Enumerate the selected source, update schedule.json, and wake scheduler."""
    global LAST_SYNC
    now_timestamp = time.time()
    if now_timestamp - LAST_SYNC < SYNC_COOLDOWN:
        return
    LAST_SYNC = now_timestamp

    try:
        result = subprocess.run(
            [sys.executable, str(SCRIPT_DIR / "check_meetings.py"), "week", "--json"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            stable_error = next(
                (
                    line.strip()
                    for line in result.stderr.splitlines()
                    if line.strip().startswith("calendar_source_error:")
                ),
                "calendar_source_error:unknown:enumeration_failed",
            )
            log(f"⚠️ check_meetings 失败: {stable_error}")
            return
        meetings = json.loads(result.stdout)
        if not isinstance(meetings, list):
            log("⚠️ check_meetings 返回了无效事件列表")
            return
        log(f"📅 获取到 {len(meetings)} 个会议")

        if not meetings and _existing_schedule_has_future_events():
            log("⚠️ 本次日历返回 0，但当前 schedule 仍有未来事件；保留旧 schedule")
            _notify_system("Meeting Assistant 日历同步异常", "本次拉取返回 0 个会议，已保留现有提醒。")
            return

        events = []
        now_local = datetime.now(timezone.utc).astimezone()
        for meeting in meetings:
            if not isinstance(meeting, dict):
                continue
            try:
                start_raw = meeting["start"]
                end_raw = meeting["end"]
                start = _calendar_datetime(start_raw, now_local.tzinfo)
                end = _calendar_datetime(end_raw, now_local.tzinfo)
            except (AttributeError, KeyError, TypeError, ValueError):
                continue
            if end < now_local:
                continue
            if (len(start_raw) == 10 and "T" not in start_raw) or (len(end_raw) == 10 and "T" not in end_raw):
                continue

            title = str(meeting.get("title") or "(无标题)")
            meeting_id = str(meeting.get("id") or uuid.uuid4())
            remind_at = start - timedelta(minutes=5)
            if remind_at > now_local:
                events.append({
                    "kind": "remind",
                    "at": remind_at.isoformat(),
                    "title": title,
                    "meeting_id": meeting_id,
                })
            if start > now_local:
                events.append({
                    "kind": "ask_record",
                    "at": start.isoformat(),
                    "title": title,
                    "meeting_id": meeting_id,
                })

        schedule = {"events": events, "meetings": meetings}
        (CONFIG_DIR / "schedule.json").write_text(
            json.dumps(schedule, indent=2, ensure_ascii=False),
        )
        log(f"✅ schedule.json 已更新，{len(events)} 个事件")

        try:
            scheduler = subprocess.run(
                ["pgrep", "-f", "scheduler_daemon.py"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            for pid in scheduler.stdout.strip().splitlines():
                if pid.strip():
                    os.kill(int(pid), signal.SIGHUP)
                    log(f"📡 SIGHUP → scheduler (pid={pid.strip()})")
        except Exception as error:
            log(f"⚠️ SIGHUP 失败: {error}")
    except Exception as error:
        log(f"❌ 同步异常: {error}")


def main():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    pid_path = CONFIG_DIR / ".calendar_services.pid"
    if pid_path.exists():
        try:
            old_pid = int(pid_path.read_text().strip())
            os.kill(old_pid, 0)
            log(f"⏭ 已有实例运行 (pid={old_pid})，跳过")
            return
        except (ValueError, OSError, ProcessLookupError):
            pass
    pid_path.write_text(str(os.getpid()))

    log("⚡ Yulu Calendar polling service 启动")
    if LEGACY_PUSH_AUDIT_PATH.exists():
        log("ℹ️ 旧 Google push 状态仅保留用于审计；不会加载、续期或执行")
    try:
        while True:
            sync_calendar_to_schedule()
            time.sleep(POLL_INTERVAL_SEC)
    finally:
        try:
            pid_path.unlink(missing_ok=True)
        except Exception:
            pass


if __name__ == "__main__":
    main()
