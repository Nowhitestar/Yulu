#!/usr/bin/env python3
"""
会议助手主控脚本（事件驱动版本，无轮询）。

调度由常驻的 scheduler_daemon.py 负责（LaunchAgent 启动），
本脚本只负责：扫日历写 schedule.json、手动添加会议、录制控制、纪要生成。

命令：
  schedule                                 扫描今日日历，重写 schedule.json，通知调度器
  add <title> <start_iso> [duration_min]   手动添加一场会议（默认 60 分钟）
  test [title]                             添加一条 30 秒后的测试会议（默认"测试会议"）
  list                                     显示当前调度
  remove <meeting_id>                      移除某场会议
  start <title>                            手动开始录制并注册状态浮窗/超时询问
  start_meeting <meeting_id> [--join]      精准开始当前/指定会议录制，可同时加入会议
  current_meeting                          输出当前正在进行的会议和弹窗主动作偏好
  prompt_action <get|set> [record|record_join]  读取/保存弹窗主动作偏好
  ask_record <title> <meeting_id>          会议开始时弹窗询问是否录制（由调度器 fire）
  auto_stop                                录制超时弹窗询问是否停止（由调度器 fire）
  stop                                     立即停止录制并生成纪要
  detect [once|daemon]                     检测当前是否处于会议/通话场景
"""

import json
import os
import signal
import subprocess
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import meeting_actions
from state_store import (
    load_state as load_recording_state,
    recording_info,
    save_state as save_recording_state,
    set_recording_started,
    set_recording_stopped,
)
from recording_lock import (
    acquire as acquire_recording_lock,
    record as record_lock,
    RecordingBusy,
)

CONFIG_DIR = Path.home() / ".config" / "yulu"
CONFIG_PATH = CONFIG_DIR / "config.json"
SCHEDULE_PATH = CONFIG_DIR / "schedule.json"
STATE_PATH = CONFIG_DIR / ".state.json"
SCHEDULER_PID = CONFIG_DIR / ".scheduler.pid"
SCRIPT_DIR = Path(__file__).resolve().parent

DEFAULT_DURATION_MIN = 60


# ───────────────────────────────────────────────
# IO helpers
# ───────────────────────────────────────────────

def load_config():
    if not CONFIG_PATH.exists():
        print(f"Config not found at {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def load_schedule():
    if not SCHEDULE_PATH.exists():
        return {"events": [], "meetings": []}
    with open(SCHEDULE_PATH) as f:
        data = json.load(f)
    data.setdefault("events", [])
    data.setdefault("meetings", [])
    return data


def _prune_past_events(data, grace_sec=15):
    """清理已过期事件/会议，避免 schedule reload 后旧测试/ask_stop 重复触发。"""
    now_ts = datetime.now().timestamp()

    kept_events = []
    for ev in data.get("events", []):
        try:
            at_ts = parse_iso(ev["at"]).timestamp()
        except Exception:
            continue
        if at_ts + grace_sec >= now_ts:
            kept_events.append(ev)
    data["events"] = kept_events

    kept_meetings = []
    for meeting in data.get("meetings", []):
        try:
            start = parse_iso(meeting["start"])
            duration = int(meeting.get("duration_min", DEFAULT_DURATION_MIN))
            end_ts = (start + timedelta(minutes=duration)).timestamp()
        except Exception:
            continue
        if end_ts + grace_sec >= now_ts:
            kept_meetings.append(meeting)
    data["meetings"] = kept_meetings
    return data


def save_schedule(data):
    SCHEDULE_PATH.parent.mkdir(parents=True, exist_ok=True)
    data = _prune_past_events(data)
    with open(SCHEDULE_PATH, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False, default=str)
    notify_scheduler()


def load_state():
    return load_recording_state(STATE_PATH)


def save_state(state):
    save_recording_state(state, STATE_PATH)


def notify_scheduler():
    """给 scheduler_daemon 发 SIGHUP 让它重读 schedule。"""
    if not SCHEDULER_PID.exists():
        print("⚠️ scheduler_daemon 未运行，已写入 schedule.json 但未通知调度器")
        return
    try:
        pid = int(SCHEDULER_PID.read_text().strip())
        os.kill(pid, signal.SIGHUP)
        print(f"✅ 已通知调度器 (pid={pid})")
    except (ValueError, ProcessLookupError) as e:
        print(f"⚠️ 调度器 PID 无效或已退出: {e}")


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ───────────────────────────────────────────────
# 日历获取（占位符，等真正接入再补）
# ───────────────────────────────────────────────

def fetch_today_meetings():
    config = load_config()
    now = datetime.now()
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_of_day = start_of_day + timedelta(days=1)

    try:
        from check_meetings import fetch_meetings
        return fetch_meetings(start_of_day, end_of_day, config)
    except Exception as e:
        print(f"日历读取失败: {e}", file=sys.stderr)
        return []


def _fetch_feishu(cfg, start, end):
    try:
        from check_meetings import _fetch_feishu as fetch
        return fetch(cfg, start, end)
    except Exception:
        return []


def _fetch_google(cfg, start, end):
    try:
        from check_meetings import _fetch_google as fetch
        return fetch(cfg, start, end)
    except Exception:
        return []


# ───────────────────────────────────────────────
# 调度命令：scan / add / list / remove
# ───────────────────────────────────────────────

def _build_events_for_meeting(meeting):
    """把一场 meeting 展开成 scheduler 用的事件列表。"""
    start = parse_iso(meeting["start"])
    remind_at = start - timedelta(minutes=5)
    return [
        {
            "id": f"{meeting['id']}::remind",
            "kind": "remind",
            "at": remind_at.isoformat(),
            "meeting_id": meeting["id"],
            "title": meeting["title"],
        },
        {
            "id": f"{meeting['id']}::ask_record",
            "kind": "ask_record",
            "at": start.isoformat(),
            "meeting_id": meeting["id"],
            "title": meeting["title"],
        },
    ]


def cmd_schedule():
    print("📅 扫描今天日历...")
    meetings = fetch_today_meetings()
    if not meetings:
        print("今天没有会议（或日历未接入）。")

    sched = {"events": [], "meetings": []}
    for m in meetings:
        m.setdefault("id", str(uuid.uuid4())[:8])
        m.setdefault("duration_min", DEFAULT_DURATION_MIN)
        sched["meetings"].append(m)
        sched["events"].extend(_build_events_for_meeting(m))
        print(f"  • {m['title']} @ {parse_iso(m['start']).strftime('%H:%M')}")

    save_schedule(sched)
    print(f"✅ 已写入 {len(sched['meetings'])} 场会议、{len(sched['events'])} 个事件")


def cmd_add(args):
    if len(args) < 2:
        print("Usage: meeting_daemon.py add <title> <start_iso> [duration_min]", file=sys.stderr)
        sys.exit(1)
    title = args[0]
    start_iso = args[1]
    duration = int(args[2]) if len(args) > 2 else DEFAULT_DURATION_MIN

    try:
        start = parse_iso(start_iso)
    except Exception as e:
        print(f"start_iso 解析失败: {e}", file=sys.stderr)
        sys.exit(1)

    meeting = {
        "id": str(uuid.uuid4())[:8],
        "title": title,
        "start": start.isoformat(),
        "duration_min": duration,
    }
    data = load_schedule()
    data["meetings"].append(meeting)
    data["events"].extend(_build_events_for_meeting(meeting))
    save_schedule(data)
    print(f"✅ 已添加: [{meeting['id']}] {title} @ {start.strftime('%Y-%m-%d %H:%M')} ({duration}min)")


def cmd_list():
    data = load_schedule()
    meetings = data.get("meetings", [])
    if not meetings:
        print("（无）")
        return
    now = datetime.now()
    for m in meetings:
        start = parse_iso(m["start"])
        marker = "📌" if start > now else "✓ "
        print(f"  {marker} [{m['id']}] {m['title']} @ {start.strftime('%Y-%m-%d %H:%M')} ({m.get('duration_min', '?')}min)")
    print()
    print("事件队列:")
    for ev in data.get("events", []):
        print(f"  - {ev['kind']:<11} @ {ev['at']}  ({ev.get('title','')})")


def cmd_remove(args):
    if not args:
        print("Usage: meeting_daemon.py remove <meeting_id>", file=sys.stderr)
        sys.exit(1)
    mid = args[0]
    data = load_schedule()
    before_m = len(data.get("meetings", []))
    data["meetings"] = [m for m in data.get("meetings", []) if m.get("id") != mid]
    data["events"] = [e for e in data.get("events", []) if e.get("meeting_id") != mid]
    save_schedule(data)
    print(f"✅ 已移除 {before_m - len(data['meetings'])} 场会议")


def cmd_test(args):
    """添加一条60秒后的测试会议。"""
    title = args[0] if args else "测试会议"
    start = datetime.now() + timedelta(seconds=60)
    meeting = {
        "id": "__test__",
        "title": title,
        "start": start.isoformat(),
        "duration_min": 5,
    }
    data = load_schedule()
    # 清理旧测试事件
    data["events"] = [e for e in data.get("events", []) if "__test__" not in e.get("id", "")]
    data["meetings"] = [m for m in data.get("meetings", []) if m.get("id") != "__test__"]
    data["meetings"].append(meeting)
    data["events"].extend(_build_events_for_meeting(meeting))
    save_schedule(data)
    print(f"🧪 测试会议「{title}」 @ {start.strftime('%H:%M:%S')} (60秒后)")


# ───────────────────────────────────────────────
# 录制控制（由调度器 fire 或用户手动）
# ───────────────────────────────────────────────

def cmd_ask_record(args):
    """会议开始时弹窗，用户决定是否录制。"""
    if len(args) < 1:
        print("Usage: meeting_daemon.py ask_record <title> [meeting_id]", file=sys.stderr)
        sys.exit(1)
    title = args[0]
    meeting_id = args[1] if len(args) > 1 else ""

    meeting = meeting_actions.meeting_by_id(meeting_id) or {
        "id": meeting_id,
        "title": title,
        "link": "",
    }
    choice, primary_action = _ask_record_choice(title, meeting)
    meeting_actions.save_primary_action(primary_action)
    print(f"User choice: {choice}, primary_action={primary_action}")

    # 移除本条 ask_record 事件，防止调度器重载后重复触发
    _remove_ask_record_event(meeting_id)

    if choice in ("record", "record_join"):
        started = _start_recording(title, meeting_id)
        if started and choice == "record_join":
            meeting_actions.open_meeting_link(meeting)
    else:
        print("用户跳过录制")


def _ask_record_choice(title, meeting):
    primary_action = meeting_actions.load_primary_action()
    prompt = SCRIPT_DIR / "meeting_prompt"
    link = str((meeting or {}).get("link") or "")
    if prompt.exists():
        try:
            result = subprocess.run(
                [str(prompt), title, link, primary_action],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                raw = result.stdout.strip()
                payload = json.loads(raw) if raw else {}
                choice = payload.get("choice", "")
                saved = payload.get("primary_action", primary_action)
                if saved not in meeting_actions.PRIMARY_ACTIONS:
                    saved = primary_action
                if choice in {"record", "record_join", "ignore"}:
                    return choice, saved
            if result.stderr.strip():
                print(f"⚠️ meeting_prompt failed: {result.stderr.strip()}", file=sys.stderr)
        except Exception as exc:
            print(f"⚠️ meeting_prompt unavailable: {exc}", file=sys.stderr)

    notify = SCRIPT_DIR / "notify.py"
    result = subprocess.run(
        [sys.executable, str(notify), "ask_record", title],
        capture_output=True,
        text=True,
    )
    choice = result.stdout.strip()
    return ("record" if choice == "开始录制" else "ignore"), primary_action


def cmd_start_meeting(args):
    if not args:
        print("Usage: meeting_daemon.py start_meeting <meeting_id> [--join]", file=sys.stderr)
        sys.exit(1)
    meeting_id = args[0]
    should_join = "--join" in args[1:]
    meeting = meeting_actions.meeting_by_id(meeting_id)
    if not meeting:
        print(f"meeting not found: {meeting_id}", file=sys.stderr)
        sys.exit(1)
    title = str(meeting.get("title") or "未命名会议")
    started = _start_recording(title, meeting_id)
    if started and should_join:
        meeting_actions.open_meeting_link(meeting)


def cmd_current_meeting():
    print(json.dumps(meeting_actions.current_payload(), ensure_ascii=False))


def cmd_prompt_action(args):
    if not args or args[0] == "get":
        print(meeting_actions.load_primary_action())
        return
    if args[0] != "set" or len(args) < 2:
        print("Usage: meeting_daemon.py prompt_action <get|set> [record|record_join]", file=sys.stderr)
        sys.exit(1)
    if args[1] not in meeting_actions.PRIMARY_ACTIONS:
        print(f"invalid primary action: {args[1]}", file=sys.stderr)
        sys.exit(2)
    print(meeting_actions.save_primary_action(args[1]))


def _remove_ask_record_event(meeting_id):
    """从 schedule 中移除已触发的 ask_record 事件。"""
    if not meeting_id:
        return
    data = load_schedule()
    before = len(data.get("events", []))
    data["events"] = [
        e for e in data.get("events", [])
        if not (e.get("kind") == "ask_record" and e.get("meeting_id") == meeting_id)
    ]
    if len(data.get("events", [])) < before:
        save_schedule(data)


def _start_recording(title, meeting_id=""):
    print(f"🎙️ 开始录制: {title}")
    try:
        with acquire_recording_lock(timeout=0.5) as lock_handle:
            audio_path = _daemon_start_recording(title, lock_handle=lock_handle)
            if not audio_path:
                print(
                    f"❌ 录制启动失败: daemon 未返回有效路径 (title={title!r})",
                    file=sys.stderr,
                )
                return False

            record_lock(
                lock_handle,
                title=title,
                path=audio_path,
                started_at=datetime.now().isoformat(),
            )

            set_recording_started(
                title, audio_path,
                meeting_id=meeting_id, backend="daemon", path=STATE_PATH,
                extra={"segments": [audio_path]},
            )
            try:
                from record_audio import start_realtime_transcriber
                start_realtime_transcriber(audio_path, title)
            except Exception as exc:
                print(f"⚠️ 实时转写启动失败: {exc}", file=sys.stderr)
            print(f"✅ 录制中: {audio_path}")

            # 启动状态浮窗
            _launch_status_window(title)

            # 注册"录制超时询问停止"事件：会议结束时间触发
            duration_min = _meeting_duration(meeting_id)
            end_at = datetime.now() + timedelta(minutes=duration_min)
            _add_runtime_event({
                "id": f"recording-{meeting_id or 'manual'}::ask_stop",
                "kind": "ask_stop",
                "at": end_at.isoformat(),
                "meeting_id": meeting_id,
                "title": title,
            })
            print(f"📅 已注册超时停止询问 @ {end_at.strftime('%H:%M')}")
            return True
    except RecordingBusy as exc:
        print(
            f"⚠️ recording lock busy: meeting_id={meeting_id} "
            f"title={title!r} holder={exc.info}",
            file=sys.stderr,
        )
        return False


def _daemon_start_recording(title, lock_handle=None):
    """Start capture through the platform controller and return the recorded
    file path on success, or ``None`` on failure.

    Imported lazily from ``record_audio`` so that the audio_daemon socket
    adapter stays co-located with the rest of the daemon-talking code while
    keeping ``meeting_daemon`` free to call them inside the recording-lock
    critical section without the child-process flock contention that a
    ``subprocess.run(record_audio.py start)`` would introduce.

    Defers to the daemon as the canonical "is recording" arbiter: probes
    status first, and raises ``RecordingBusy`` if a recording is already in
    flight (the flock alone cannot prevent this — see ``recording_lock``
    docstring for why). Lets the caller's existing ``except RecordingBusy``
    surface the live recording's metadata.
    """
    from record_audio import _capture_controller, _raise_if_daemon_recording

    _raise_if_daemon_recording(lock_handle)
    resp = _capture_controller().start({"title": title})
    if not resp or resp.get("status") != "recording":
        print(f"⚠️ daemon failed to start: {resp}", file=sys.stderr)
        return None
    return resp.get("file") or None


def _meeting_duration(meeting_id):
    if not meeting_id:
        return DEFAULT_DURATION_MIN
    data = load_schedule()
    for m in data.get("meetings", []):
        if m.get("id") == meeting_id:
            return int(m.get("duration_min", DEFAULT_DURATION_MIN))
    return DEFAULT_DURATION_MIN


def _add_runtime_event(ev):
    """运行时给 schedule 加一个事件并通知调度器。"""
    data = load_schedule()
    data["events"].append(ev)
    save_schedule(data)


def cmd_auto_stop():
    rec = recording_info(load_state())
    if not rec:
        print("没有正在进行的录制")
        return
    title = rec.get("title", "")
    notify = SCRIPT_DIR / "notify.py"
    result = subprocess.run(
        [sys.executable, str(notify), "ask_stop", title],
        capture_output=True, text=True,
    )
    choice = result.stdout.strip()
    print(f"Stop choice: {choice}")

    if choice in ("停止录制", "停止", "timeout"):
        _stop_and_process()
    else:
        # 用户选继续：再延 30 分钟问一次。save_schedule 会顺手清理已过期 ask_stop。
        end_at = datetime.now() + timedelta(minutes=30)
        _add_runtime_event({
            "id": f"recording-{rec.get('meeting_id','manual')}::ask_stop_extended",
            "kind": "ask_stop",
            "at": end_at.isoformat(),
            "meeting_id": rec.get("meeting_id", ""),
            "title": title,
        })
        print(f"⏭ 继续录制，{end_at.strftime('%H:%M')} 再次询问")


def cmd_stop():
    print("🛑 手动停止录制")
    _stop_and_process()


def _active_recording_info():
    rec = recording_info(load_state())
    if rec:
        return rec
    try:
        from record_audio import _capture_controller
        resp = _capture_controller().status()
    except Exception:
        resp = None
    if not (resp and resp.get("recording") is True):
        return {}
    audio_path = resp.get("file") or ""
    title = Path(audio_path).stem if audio_path else "meeting"
    return {
        "title": title,
        "audio_path": audio_path,
        "file_path": audio_path,
        "backend": "daemon",
    }


def _launch_status_window(title):
    """启动状态浮窗（先杀掉旧的）。"""
    _kill_status_window()
    status_bin = SCRIPT_DIR / "recorder_status"
    if not status_bin.exists():
        print("⚠️ recorder_status 未编译，跳过浮窗")
        return
    log_path = CONFIG_DIR / "recorder_status.log"
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = log_path.open("ab")
    proc = subprocess.Popen([str(status_bin), title, str(STATE_PATH)],
                            stdout=log_file, stderr=log_file)
    log_file.close()
    try:
        exited = proc.wait(timeout=0.4)
    except subprocess.TimeoutExpired:
        exited = None
    if exited is not None:
        print(f"⚠️ 状态浮窗启动后立即退出(code={exited})，详见 {log_path}", file=sys.stderr)
        return
    state = load_state()
    state["_status_pid"] = proc.pid
    save_state(state)
    print(f"🪟 状态浮窗已启动 (pid={proc.pid})")


def _kill_status_window():
    state = load_state()
    pid = state.pop("_status_pid", None)
    save_state(state)
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
            # 也杀所有同名进程（防残留）
            subprocess.run(
                ["pkill", "-f", "recorder_status"],
                capture_output=True,
            )
        except ProcessLookupError:
            pass


def _stop_and_process():
    # 先关状态浮窗
    _kill_status_window()

    rec = _active_recording_info()
    if not rec:
        print("没有正在进行的录制", file=sys.stderr)
        return

    title = rec.get("title", "meeting")
    audio_path = rec.get("audio_path") or rec.get("file_path")

    # 1. 停录制
    record = SCRIPT_DIR / "record_audio.py"
    stop_result = subprocess.run(
        [sys.executable, str(record), "stop"],
        capture_output=True, text=True,
    )
    for line in stop_result.stdout.splitlines():
        if line.startswith("FINAL_RECORDING_PATH="):
            audio_path = line.split("=", 1)[1].strip() or audio_path
            break

    notify = SCRIPT_DIR / "notify.py"
    subprocess.Popen([sys.executable, str(notify), "notify_stop", title],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # 2. 通知 agent 开始转录
    try:
        from agent_notify import notify
        notify("transcribing", title=title)
    except Exception:
        pass

    # 3. 转录 + 摘要
    print("📝 转录 + 摘要...")
    transcribe = SCRIPT_DIR / "transcribe.py"
    result = subprocess.run(
        [sys.executable, str(transcribe), audio_path],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"❌ 转录失败:\n{result.stderr}", file=sys.stderr)
        return
    print(result.stdout)

    # 4. 通知 agent 转录完成
    transcript_path = None
    summary_path = None
    summary_pending_agent = False
    summary_queued = False
    for line in result.stdout.split("\n"):
        if line.startswith("Transcript saved:"):
            transcript_path = line.split("Transcript saved:", 1)[1].strip()
        if line.startswith("Summary saved:"):
            summary_path = line.split("Summary saved:", 1)[1].strip()
        if line.startswith("Summary status:") and "draft_agent_pending" in line:
            summary_pending_agent = True
        if "enqueued" in line and "LLM jobs" in line:
            summary_queued = True

    try:
        notify("transcript", title=title, path=transcript_path or "")
    except Exception:
        pass

    if not summary_path:
        if transcript_path or summary_queued:
            set_recording_stopped(path=STATE_PATH)
            try:
                data = load_schedule()
                save_schedule(data)
            except Exception:
                pass
            print("⏳ 摘要任务已进入队列，agent_queue_worker 会继续生成最终摘要")
            print(f"✅ 完成: {transcript_path or audio_path}")
            return
        print("❌ 找不到 summary 路径", file=sys.stderr)
        return

    # 3. 发送。若 summary 等待 agent 最终生成，则不发送草稿，由 heartbeat 的 summary_request 负责覆盖并推送。
    if not summary_pending_agent:
        send = SCRIPT_DIR / "send_summary.py"
        subprocess.run([sys.executable, str(send), summary_path], capture_output=True)

        config = load_config()
        channel = config.get("output", {}).get("channel", "file")
        subprocess.Popen(
            [sys.executable, str(notify), "notify_sent", title, channel],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    else:
        print("⏳ Summary 草稿已保存，等待 agent 按模板生成最终版")

    set_recording_stopped(path=STATE_PATH)

    # 清理当前录制相关的过期 ask_stop 事件，避免测试/重载后残留。
    try:
        data = load_schedule()
        save_schedule(data)
    except Exception:
        pass

    print(f"✅ 完成: {summary_path}")


# ───────────────────────────────────────────────
# 主入口
# ───────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    args = sys.argv[2:]
    handlers = {
        "schedule": lambda: cmd_schedule(),
        "start": lambda: _start_recording(args[0] if args else "未命名会议"),
        "start_meeting": lambda: cmd_start_meeting(args),
        "current_meeting": lambda: cmd_current_meeting(),
        "prompt_action": lambda: cmd_prompt_action(args),
        "add": lambda: cmd_add(args),
        "test": lambda: cmd_test(args),
        "list": lambda: cmd_list(),
        "remove": lambda: cmd_remove(args),
        "ask_record": lambda: cmd_ask_record(args),
        "auto_stop": lambda: cmd_auto_stop(),
        "stop": lambda: cmd_stop(),
        "detect": lambda: subprocess.run([
            sys.executable,
            str(SCRIPT_DIR / "meeting_detector.py"),
            args[0] if args else "once",
        ]),
    }
    handler = handlers.get(cmd)
    if not handler:
        print(f"Unknown command: {cmd}\n", file=sys.stderr)
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    handler()


if __name__ == "__main__":
    main()
