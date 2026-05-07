#!/usr/bin/env python3
"""
日历服务启动器：webhook 服务器 + cloudflared tunnel + Google Calendar watch 注册。

工作流：
1. 启动 HTTP webhook 服务器（后台线程）
2. 启动 cloudflared quick tunnel 到 webhook 端口
3. 解析 cloudflared 输出的公网 URL
4. 注册/重新注册 Google Calendar push notification channels
5. 持续监控，tunnel 重启后自动重新注册

作为 LaunchAgent 常驻运行。
"""

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "meeting-assistant"
LOG_PATH = CONFIG_DIR / "calendar_services.log"
STATE_PATH = CONFIG_DIR / ".watch_state.json"
SCRIPT_DIR = Path(__file__).resolve().parent

WEBHOOK_PORT = 8899

# Google OAuth
# 从 gog 的 keychain 读取 OAuth 配置
# 或从环境变量读取

# 要 watch 的日历列表（从 config.json 加载）
CALENDARS_TO_WATCH = []
GOG_ACCOUNT = ""

LOCK = threading.Lock()
LAST_SYNC = 0
SYNC_COOLDOWN = 10  # 防止通知风暴每分钟只同步一次
POLL_INTERVAL_SEC = 300  # 兜底轮询：5 分钟，避免新会议最多延迟 1 小时才发现
WATCH_RENEW_BEFORE_SEC = 3600  # Google watch 过期前 1 小时续期


def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    # print 由 LaunchAgent 的 StandardOutPath 捕获到日志文件，不再重复写


def _get_gog_credentials():
    """从 gog 的 keychain 读取 OAuth 凭证。
    用户需先运行：
      gog auth credentials ~/path/to/client_secret.json
      gog auth add <email> --services calendar
    也可通过环境变量手动指定。
    """
    env_id = os.environ.get("GOOGLE_CLIENT_ID")
    env_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    env_token = os.environ.get("GOG_REFRESH_TOKEN")
    if env_id and env_secret and env_token:
        return env_id, env_secret, env_token

    client_id = ""
    client_secret = ""
    refresh_token = ""

    # gog stores the OAuth refresh token and OAuth client credentials separately.
    # Older code returned immediately after reading the token, leaving client_id /
    # client_secret empty; Google token refresh then failed and watch renewal died.
    try:
        r = subprocess.run(
            ["security", "find-generic-password", "-s", "gogcli",
             "-a", f"token:default:{GOG_ACCOUNT}", "-w"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0:
            data = json.loads(r.stdout)
            refresh_token = data.get("refresh_token", "")
            client_id = data.get("client_id", "")
            client_secret = data.get("client_secret", "")
    except Exception:
        pass

    # 读取 gog 的 OAuth client credentials
    cred_path = Path.home() / "Library" / "Application Support" / "gogcli" / "credentials.json"
    if cred_path.exists():
        creds = json.loads(cred_path.read_text())
        client_id = client_id or creds.get("client_id", "")
        client_secret = client_secret or creds.get("client_secret", "")

    if client_id and client_secret and refresh_token:
        return client_id, client_secret, refresh_token

    return "", "", ""


def _get_access_token():
    """用 refresh token 换取 access token。"""
    cid, secret, token = _get_gog_credentials()
    if not token and secret:
        # 只有 client credentials，没有 refresh token——换一种方式
        log("⚠️ 未配置 Google OAuth refresh token")
        log("   请运行: gog auth add <email> --services calendar")
        log("   或设置环境变量: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOG_REFRESH_TOKEN")
        raise RuntimeError("No OAuth refresh token available")

    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "client_id": cid,
        "client_secret": secret,
        "refresh_token": token,
    }).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=data,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = json.loads(resp.read())
    return body["access_token"]


def register_watch_channels(public_url):
    """为所有日历注册 Google Calendar push notification。"""
    token = _get_access_token()
    channel_id = str(uuid.uuid4())
    results = []

    for cal in CALENDARS_TO_WATCH:
        cal_id = urllib.parse.quote(cal["id"], safe="")
        url = f"https://www.googleapis.com/calendar/v3/calendars/{cal_id}/events/watch"
        body = json.dumps({
            "id": channel_id,
            "type": "web_hook",
            "address": f"{public_url.rstrip('/')}/calendar-webhook",
        }).encode()
        req = urllib.request.Request(
            url, data=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
            expires = datetime.fromtimestamp(int(data["expiration"]) / 1000, tz=timezone.utc)
            results.append({
                "calendar_id": cal["id"],
                "label": cal["label"],
                "channel_id": channel_id,
                "resource_id": data.get("resourceId", ""),
                "expires": expires.isoformat(),
            })
            log(f"✅ 已注册 watch: {cal['label']} → 过期 {expires.isoformat()}")
        except urllib.error.HTTPError as e:
            err = e.read().decode()
            log(f"❌ 注册 watch 失败 ({cal['label']}): {e.code} {err}")
        except Exception as e:
            log(f"❌ 注册 watch 异常 ({cal['label']}): {e}")

    state = {
        "public_url": public_url,
        "channels": results,
        "registered_at": datetime.now(timezone.utc).isoformat(),
    }
    STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False))
    return results


def sync_calendar_to_schedule():
    """读取日历事件 → 写入 schedule.json → SIGHUP scheduler。"""
    global LAST_SYNC
    now = time.time()
    if now - LAST_SYNC < SYNC_COOLDOWN:
        return
    LAST_SYNC = now

    try:
        r = subprocess.run(
            [sys.executable, str(SCRIPT_DIR / "check_meetings.py"), "week", "--json"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            log(f"⚠️ check_meetings 失败: {r.stderr}")
            return
        meetings = json.loads(r.stdout)
        log(f"📅 获取到 {len(meetings)} 个会议")

        # gog / Google 偶发返回 0 时，绝不能直接清空已有未来事件；否则会像
        # 2026-05-07 15:46 那样把 16:00 会议从 scheduler 里抹掉。
        if not meetings and _existing_schedule_has_future_events():
            log("⚠️ 本次日历返回 0，但当前 schedule 仍有未来事件；判定为瞬时异常，保留旧 schedule")
            _notify_system("Meeting Assistant 日历同步异常", "本次拉取返回 0 个会议，已保留现有提醒。")
            return

        events = []
        now_local = datetime.now(timezone.utc).astimezone()
        for m in meetings:
            try:
                start = datetime.fromisoformat(m["start"].replace("Z", "+00:00"))
                end = datetime.fromisoformat(m["end"].replace("Z", "+00:00"))
            except (ValueError, KeyError):
                continue
            if end < now_local:
                continue

            title = m["title"]
            meeting_id = m.get("id", str(uuid.uuid4()))

            remind_at = start - timedelta(minutes=5)
            if remind_at > now_local:
                events.append({
                    "kind": "remind", "at": remind_at.isoformat(),
                    "title": title, "meeting_id": meeting_id,
                })
            if start > now_local:
                events.append({
                    "kind": "ask_record", "at": start.isoformat(),
                    "title": title, "meeting_id": meeting_id,
                })

        schedule = {"events": events, "meetings": meetings}
        (CONFIG_DIR / "schedule.json").write_text(
            json.dumps(schedule, indent=2, ensure_ascii=False))
        log(f"✅ schedule.json 已更新，{len(events)} 个事件")

        try:
            r = subprocess.run(
                ["pgrep", "-f", "scheduler_daemon.py"],
                capture_output=True, text=True, timeout=5,
            )
            for pid in r.stdout.strip().splitlines():
                pid = pid.strip()
                if pid:
                    os.kill(int(pid), signal.SIGHUP)
                    log(f"📡 SIGHUP → scheduler (pid={pid})")
        except Exception as e:
            log(f"⚠️ SIGHUP 失败: {e}")
    except Exception as e:
        log(f"❌ 同步异常: {e}")


def _existing_schedule_has_future_events():
    path = CONFIG_DIR / "schedule.json"
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text())
        now_ts = datetime.now(timezone.utc).astimezone().timestamp()
        for ev in data.get("events", []):
            try:
                if datetime.fromisoformat(ev["at"].replace("Z", "+00:00")).timestamp() > now_ts:
                    return True
            except Exception:
                continue
    except Exception:
        return False
    return False


def _notify_system(title, message):
    try:
        subprocess.Popen(
            [sys.executable, str(SCRIPT_DIR / "notify.py"), "remind", title, message, "日历健康检查"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


def _watch_expires_soon():
    if not STATE_PATH.exists():
        return True
    try:
        state = json.loads(STATE_PATH.read_text())
        channels = state.get("channels") or []
        if not channels:
            return True
        now = datetime.now(timezone.utc)
        for ch in channels:
            exp_raw = ch.get("expires")
            if not exp_raw:
                return True
            exp = datetime.fromisoformat(exp_raw.replace("Z", "+00:00"))
            if exp - now <= timedelta(seconds=WATCH_RENEW_BEFORE_SEC):
                return True
    except Exception:
        return True
    return False


# ─── HTTP webhook server ───────────────────────────────

class WebhookHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Meeting Assistant Calendar Webhook\n")
            return
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok"}).encode())
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path == "/calendar-webhook":
            resource_state = self.headers.get("X-Goog-Resource-State", "")
            log(f"📩 推送: state={resource_state}")

            if resource_state == "sync":
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"OK")
                return

            if resource_state in ("update", "exists"):
                threading.Thread(target=sync_calendar_to_schedule, daemon=True).start()

            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"OK")
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, fmt, *args):
        pass


def run_webhook_server():
    server = HTTPServer(("0.0.0.0", WEBHOOK_PORT), WebhookHandler)
    log(f"🌐 Webhook 已启动: http://0.0.0.0:{WEBHOOK_PORT}")
    server.serve_forever()


# ─── Cloudflare tunnel orchestrator ───────────────────

def parse_cloudflared_url(line):
    """从 cloudflared 日志行提取 URL。"""
    m = re.search(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com', line)
    return m.group(0) if m else None


def run_tunnel_and_register():
    """启动 cloudflared，获取 URL，注册 watch。"""
    log("🚇 启动 cloudflared tunnel...")
    proc = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", f"http://localhost:{WEBHOOK_PORT}",
         "--no-autoupdate"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )

    current_url = None
    registered_once = False

    def renew_loop():
        while True:
            time.sleep(300)
            if current_url and _watch_expires_soon():
                log("🔄 Google Calendar watch 即将过期/已过期，重新注册...")
                try:
                    register_watch_channels(current_url)
                    sync_calendar_to_schedule()
                except Exception as e:
                    log(f"❌ watch 续期失败: {e}")
                    _notify_system("Meeting Assistant 日历 watch 续期失败", str(e))

    threading.Thread(target=renew_loop, daemon=True).start()

    def _signal_handler(signum, frame):
        log(f"收到 signal {signum}，关闭 cloudflared...")
        proc.terminate()

    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)

    try:
        for line in iter(proc.stdout.readline, ""):
            line = line.rstrip()
            if not line:
                continue

            url = parse_cloudflared_url(line)
            if url and url != current_url:
                current_url = url
                log(f"🔗 Tunnel URL: {url}")

                if registered_once:
                    log("🔄 Tunnel 重启，重新注册 watch...")
                try:
                    register_watch_channels(current_url)
                except Exception as e:
                    log(f"❌ watch 注册失败，将继续依赖 5 分钟兜底轮询: {e}")
                    _notify_system("Meeting Assistant 日历 watch 注册失败", "将继续依赖 5 分钟兜底轮询。")

                if not registered_once:
                    log("🔄 执行初始日历同步...")
                    sync_calendar_to_schedule()

                registered_once = True

    except Exception as e:
        log(f"❌ Tunnel 异常: {e}")
    finally:
        proc.terminate()
        proc.wait()


def main():
    # PID 文件阻止重复启动
    PID_PATH = CONFIG_DIR / ".calendar_services.pid"
    if PID_PATH.exists():
        try:
            old_pid = int(PID_PATH.read_text().strip())
            # macOS 用 kill -0 检查进程是否存活
            os.kill(old_pid, 0)
            log(f"⏭ 已有实例运行 (pid={old_pid})，跳过")
            return
        except (ValueError, OSError, ProcessLookupError):
            pass
    PID_PATH.write_text(str(os.getpid()))

    # 从 config.json 加载日历配置
    global GOG_ACCOUNT, CALENDARS_TO_WATCH
    try:
        cfg = json.loads((CONFIG_DIR / "config.json").read_text())
        for cal in cfg.get("calendars", []):
            if cal.get("type") == "google" and cal.get("enabled", False):
                GOG_ACCOUNT = cal.get("gog_account", "") or os.environ.get("GOG_ACCOUNT", "")
                extra_calendars = cal.get("watch_calendars", ["primary"])
                CALENDARS_TO_WATCH = [
                    {"id": cid, "label": cid} for cid in extra_calendars
                ]
                break
    except Exception as e:
        log(f"⚠️ 读取 config.json 失败: {e}")
        log("   请先根据 config.example.json 创建 ~/.config/meeting-assistant/config.json")

    if not GOG_ACCOUNT:
        GOG_ACCOUNT = os.environ.get("GOG_ACCOUNT", "")

    log("⚡ Meeting Assistant Calendar Services 启动")
    log(f"    webhook port: {WEBHOOK_PORT}")
    if GOG_ACCOUNT:
        log(f"    gog account: {GOG_ACCOUNT}")
        log(f"    watch calendars: {[c['label'] for c in CALENDARS_TO_WATCH]}")
    else:
        log("⚠️ 未配置 gog_account，日历推送功能不可用")
        log("   请在 config.json 中设置 calendar.google.gog_account")

    # 后台线程运行 webhook 服务器
    webhook_thread = threading.Thread(target=run_webhook_server, daemon=True)
    webhook_thread.start()
    time.sleep(0.5)  # 确保 webhook 就绪

    # 兜底轮询线程：每 5 分钟同步一次，防推送丢失/watch 过期/新建会议延迟
    def poll_loop():
        while True:
            time.sleep(POLL_INTERVAL_SEC)
            log("⏰ 兜底轮询：同步日历...")
            sync_calendar_to_schedule()
    polling_thread = threading.Thread(target=poll_loop, daemon=True)
    polling_thread.start()

    # 主线程运行 tunnel + watch 注册
    try:
        run_tunnel_and_register()
    finally:
        try:
            PID_PATH.unlink(missing_ok=True)
        except Exception:
            pass


if __name__ == "__main__":
    main()
