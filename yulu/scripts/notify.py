#!/usr/bin/env python3
"""Send semantic notification events to Yulu.app; native helpers own dialogs.

No AppleScript / terminal-notifier fallback: a missing App must not silently
change the sender, icon, privacy permissions or click destination.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

from application_paths import IPC_DIR

SCRIPT_DIR = Path(__file__).resolve().parent


def send_event(kind, event_id, title="", stem=None):
    payload = {"action": "notify", "kind": kind, "id": event_id, "title": title}
    if stem is not None:
        payload["stem"] = stem
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(4)
            client.connect(str(IPC_DIR / "status_agent.sock"))
            client.sendall(json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
            with client.makefile("rb") as reply:
                response = json.loads(reply.readline(65536))
        if not isinstance(response, dict) or response.get("ok") is not True:
            raise ValueError("Yulu did not accept the notification")
        return True
    except (OSError, ValueError) as exc:
        print(f"Yulu notification unavailable: {type(exc).__name__}", file=sys.stderr)
        return False


def _ask(meeting_title, mode, timeout=None):
    declared = os.environ.get("YULU_NATIVE_HELPER_DIR")
    prompt = (Path(declared) if declared else SCRIPT_DIR) / "meeting_prompt"
    args = [str(prompt), meeting_title, "", "record", mode]
    if timeout is not None:
        args.append(str(max(1, int(timeout))))
    try:
        result = subprocess.run(args, capture_output=True, text=True,
                                timeout=None if timeout is None else max(1, int(timeout)) + 5)
        payload = json.loads(result.stdout) if result.returncode == 0 else {}
        return payload.get("choice", "") if isinstance(payload, dict) else ""
    except (OSError, ValueError, subprocess.TimeoutExpired):
        # Unavailable UI never authorizes starting or stopping capture.
        return ""


def ask_record(meeting_title, timeout=None):
    return "开始录制" if _ask(meeting_title, "record", timeout) == "record" else "忽略"


def ask_stop(meeting_title, timeout=None):
    return "停止录制" if _ask(meeting_title, "stop", timeout) == "stop" else "继续录制"


def notify_stop(meeting_title, reason="manual", stem=None):
    # A saved WAV proves capture ended, not that transcription/summary started.
    return send_event("recording_saved", stem or meeting_title, meeting_title, stem)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["meeting_soon", "calendar_empty", "ask_record", "ask_stop", "notify_stop"])
    parser.add_argument("args", nargs="*")
    options = parser.parse_args()
    args = options.args
    title = args[0] if args else ""
    if options.action == "ask_record":
        print(ask_record(title))
    elif options.action == "ask_stop":
        print(ask_stop(title))
    else:
        if options.action == "notify_stop":
            ok = notify_stop(title, args[1] if len(args) > 1 else "manual", args[2] if len(args) > 2 else None)
        elif options.action == "meeting_soon":
            ok = send_event("meeting_soon", args[1] if len(args) > 1 else title, title)
        else:
            ok = send_event("calendar_empty", "calendar")
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
