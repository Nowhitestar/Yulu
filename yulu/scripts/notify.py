#!/usr/bin/env python3
"""
macOS 系统通知封装。

支持：
- 纯提醒通知（T-5min）
- 交互式通知（T-0min，带按钮）
- 确认对话框（自动停止提示）

依赖：
- terminal-notifier: brew install terminal-notifier
"""

import subprocess
import sys
from pathlib import Path


def _has_terminal_notifier():
    return subprocess.run(
        ["which", "terminal-notifier"],
        capture_output=True,
    ).returncode == 0


def _applescript_string(value):
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _fallback_notify(title, message, subtitle=""):
    """fallback 到 osascript display notification。"""
    script = f"display notification {_applescript_string(message)} with title {_applescript_string(title)}"
    if subtitle:
        script += f" subtitle {_applescript_string(subtitle)}"
    subprocess.run(["osascript", "-e", script], capture_output=True)


def _fallback_dialog(message, buttons, default_button, timeout=None):
    """fallback 到 osascript display dialog。

    timeout=None 时不附加 'giving up after'，对话框常驻直到用户点击。
    timeout 是整数秒时，超时后 osascript 返回 gave up:true，函数返回 'timeout'。
    """
    btn_str = ",".join(_applescript_string(b) for b in buttons)
    script = (
        f"display dialog {_applescript_string(message)} "
        f'buttons {{{btn_str}}} '
        f"default button {_applescript_string(default_button)}"
    )
    if timeout is not None:
        script += f' giving up after {int(timeout)}'
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
    )
    # 解析返回: button returned:xxx, gave up:false
    parts = [line.strip() for line in result.stdout.split(",")]
    if any("gave up:true" in line for line in parts):
        return "timeout"
    for line in parts:
        if "button returned:" in line:
            return line.split(":", 1)[1].strip()
    return ""


YULU_BUNDLE_ID = "com.yulu.audiodaemon"


def remind(title, message, subtitle=""):
    """发送纯提醒通知（会议前5分钟）。"""
    if _has_terminal_notifier():
        cmd = [
            "terminal-notifier",
            "-title", title,
            "-message", message,
            "-sound", "Glass",
            # Show the Yulu logo instead of the calling shell's icon (Terminal,
            # iTerm, …). -sender requires the bundle id to belong to a launched
            # app; the Yulu LaunchAgent keeps com.yulu.audiodaemon alive.
            "-sender", YULU_BUNDLE_ID,
        ]
        if subtitle:
            cmd += ["-subtitle", subtitle]
        subprocess.run(cmd, capture_output=True)
    else:
        _fallback_notify(title, message, subtitle)


def ask_record(meeting_title, timeout=None):
    """
    会议开始时询问是否录制。
    使用 osascript display dialog（真正的弹窗，按钮清晰可见）。
    默认 timeout=None：弹窗常驻，用户不点不会消失；默认按钮为「开始录制」，
    回车不再误触「忽略」而静默跳过录制。
    返回: "开始录制" | "忽略" | "timeout"（仅当显式传入 timeout）
    """
    return _fallback_dialog(
        f"会议「{meeting_title}」开始了\n\n是否开始录制音频？",
        buttons=["忽略", "开始录制"],
        default_button="开始录制",
        timeout=timeout,
    )


def ask_stop(meeting_title, timeout=None):
    """
    检测到静默时询问是否停止录制。
    使用 osascript display dialog（真正的弹窗，按钮清晰可见）。
    返回: "停止" | "继续" | "timeout"
    """
    return _fallback_dialog(
        f"会议「{meeting_title}」\n已连续 5 分钟无声音\n\n是否停止录制？",
        buttons=["继续录制", "停止录制"],
        default_button="停止录制",
        timeout=timeout,
    )


def notify_stop(meeting_title, reason="manual"):
    automatic = reason == "automatic"
    action = "已自动停止录制" if automatic else "已停止录制"
    subtitle = "自动停止" if automatic else "录制已停止"
    remind("Yulu", f"会议「{meeting_title}」\n{action}，正在生成纪要...", subtitle=subtitle)


def notify_summary_sent(meeting_title, channel):
    """纪要发送后的通知。"""
    message = f"会议「{meeting_title}」\n纪要已发送到 {channel}"
    remind("Yulu", message, subtitle="纪要完成")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: notify.py <remind|ask_record|ask_stop|notify_stop|notify_sent> ...")
        sys.exit(1)
    
    action = sys.argv[1]
    if action == "remind":
        remind(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "")
    elif action == "ask_record":
        print(ask_record(sys.argv[2]))
    elif action == "ask_stop":
        print(ask_stop(sys.argv[2]))
    elif action == "notify_stop":
        notify_stop(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "manual")
    elif action == "notify_sent":
        notify_summary_sent(sys.argv[2], sys.argv[3])
    else:
        print(f"Unknown action: {action}")
