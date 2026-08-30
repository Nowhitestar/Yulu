#!/usr/bin/env python3
"""Shared helpers for calendar-meeting recording actions.

The scheduler, web UI, and status-agent menu all need the same answers:
which calendar meeting is happening now, what the user's preferred primary
action is, and which meeting link should be opened after recording starts.
Keeping that logic here prevents three subtly different "current meeting"
implementations from drifting.
"""

import argparse
import json
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from application_paths import DURABLE_DATA_DIR, LEGACY_READ_ONLY_DATA_DIR

CONFIG_DIR = DURABLE_DATA_DIR
SCHEDULE_PATH = CONFIG_DIR / "schedule.json"
PREFERENCE_PATH = CONFIG_DIR / "meeting_prompt.json"

DEFAULT_DURATION_MIN = 60
DEFAULT_PRIMARY_ACTION = "record"
PRIMARY_ACTIONS = {"record", "record_join"}


def parse_iso(value):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _timestamp(value):
    return parse_iso(value).timestamp()


def load_schedule(path=None):
    path = Path(path) if path is not None else SCHEDULE_PATH
    if path == SCHEDULE_PATH and not path.exists():
        legacy = LEGACY_READ_ONLY_DATA_DIR / "schedule.json"
        if legacy.exists():
            path = legacy
    if not Path(path).exists():
        return {"events": [], "meetings": []}
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        return {"events": [], "meetings": []}
    if not isinstance(data, dict):
        return {"events": [], "meetings": []}
    data.setdefault("events", [])
    data.setdefault("meetings", [])
    return data


def load_primary_action(path=None):
    path = Path(path) if path is not None else PREFERENCE_PATH
    if path == PREFERENCE_PATH and not path.exists():
        legacy = LEGACY_READ_ONLY_DATA_DIR / "meeting_prompt.json"
        if legacy.exists():
            path = legacy
    try:
        with open(path) as f:
            raw = json.load(f)
    except Exception:
        return DEFAULT_PRIMARY_ACTION
    action = raw.get("primary_action") if isinstance(raw, dict) else None
    return action if action in PRIMARY_ACTIONS else DEFAULT_PRIMARY_ACTION


def save_primary_action(action, path=None):
    if action not in PRIMARY_ACTIONS:
        action = DEFAULT_PRIMARY_ACTION
    path = Path(path) if path is not None else PREFERENCE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "primary_action": action,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
    }
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    tmp.replace(path)
    return action


def meeting_end_ts(meeting):
    if meeting.get("end"):
        try:
            return _timestamp(meeting["end"])
        except Exception:
            pass
    start = parse_iso(meeting["start"])
    duration = int(meeting.get("duration_min", DEFAULT_DURATION_MIN))
    return (start + timedelta(minutes=duration)).timestamp()


def normalize_meeting(meeting):
    return {
        "id": str(meeting.get("id", "")),
        "title": str(meeting.get("title", "")),
        "start": str(meeting.get("start", "")),
        "end": str(meeting.get("end", "")),
        "duration_min": int(meeting.get("duration_min", DEFAULT_DURATION_MIN)),
        "source": str(meeting.get("source") or meeting.get("provider") or ""),
        "link": str(meeting.get("link") or meeting.get("url") or ""),
        "attendees": [str(x) for x in meeting.get("attendees", []) if x],
    }


def meeting_by_id(meeting_id, schedule=None):
    if not meeting_id:
        return None
    schedule = schedule or load_schedule()
    for meeting in schedule.get("meetings", []):
        if str(meeting.get("id", "")) == str(meeting_id):
            return meeting
    return None


def current_meetings(now=None, schedule=None):
    now_ts = (now or datetime.now()).timestamp()
    schedule = schedule or load_schedule()
    matches = []
    for meeting in schedule.get("meetings", []):
        try:
            start_ts = _timestamp(meeting["start"])
            end_ts = meeting_end_ts(meeting)
        except Exception:
            continue
        if start_ts <= now_ts <= end_ts:
            matches.append(meeting)
    matches.sort(key=lambda m: str(m.get("start", "")), reverse=True)
    return matches


def current_meeting(now=None, schedule=None):
    meetings = current_meetings(now=now, schedule=schedule)
    return meetings[0] if meetings else None


def open_meeting_link(meeting):
    link = str((meeting or {}).get("link") or "")
    if not link:
        return False
    subprocess.Popen(["open", link], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


def current_payload(schedule_path=None, preference_path=None):
    schedule = load_schedule(schedule_path)
    meeting = current_meeting(schedule=schedule)
    return {
        "primary_action": load_primary_action(preference_path),
        "meeting": normalize_meeting(meeting) if meeting else None,
    }


def _self_test():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        sched = root / "schedule.json"
        pref = root / "meeting_prompt.json"
        now = datetime.now()
        sched.write_text(json.dumps({
            "meetings": [{
                "id": "m1",
                "title": "Design",
                "start": (now - timedelta(minutes=5)).isoformat(),
                "duration_min": 30,
                "link": "https://meet.example/m1",
            }],
            "events": [],
        }), encoding="utf8")
        payload = current_payload(sched, pref)
        assert payload["meeting"]["id"] == "m1"
        assert payload["primary_action"] == "record"
        assert save_primary_action("record_join", pref) == "record_join"
        assert load_primary_action(pref) == "record_join"
    print("meeting_actions self-test ok")


def main(argv=None):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("current")
    pref = sub.add_parser("preference")
    pref.add_argument("op", choices=["get", "set"])
    pref.add_argument("action", nargs="?")
    sub.add_parser("self-test")
    args = parser.parse_args(argv)

    if args.cmd == "current":
        print(json.dumps(current_payload(), ensure_ascii=False))
        return 0
    if args.cmd == "preference":
        if args.op == "get":
            print(load_primary_action())
            return 0
        action = args.action or ""
        if action not in PRIMARY_ACTIONS:
            print(f"invalid primary action: {action}", file=sys.stderr)
            return 2
        print(save_primary_action(action))
        return 0
    if args.cmd == "self-test":
        _self_test()
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
