---
name: yulu
description: "Yulu (语录) — native macOS meeting recorder and note-taker. Calendar/window detection, prompt-before-recording, ScreenCaptureKit system audio + microphone recording, local MLX / whisper transcription, and agent-generated meeting notes via an agent queue. No BlackHole or virtual audio device required."
metadata:
  internal: true
  notice: "This is the project's internal architecture / developer documentation. The user-facing agent contract that gets installed by `npx skills add` lives at skills/yulu/SKILL.md."
---

# Yulu

Yulu (语录, *yǔ lù*) is a native macOS meeting recorder and note-taker. The name comes from the Chinese genre of "recorded sayings" — *The Analects* is the classic example.

Pipeline: calendar/window detection → prompt before recording → system audio + microphone capture → local MLX / whisper transcription → agent-generated meeting notes.

## Architecture

```text
Google Calendar / Window Detector
          ↓
 schedule.json → scheduler_daemon.py
          ↓
 meeting_daemon.py ask_record
          ↓
 notify.py prompt: Start recording?
          ↓
 record_audio.py → Yulu.app (Unix socket)
          ↓
 ScreenCaptureKit system audio + AVFoundation microphone
          ↓
WAV → realtime_transcribe.py / transcribe.py → MLX Whisper or whisper-cli
          ↓
 transcript.txt + summary_request queue
          ↓
 OpenClaw heartbeat agent → final summary.md → user notification
```

## Key Features

- **No BlackHole required** — captures system audio directly with ScreenCaptureKit.
- **Native Yulu.app bundle** — a signed macOS audio daemon for stable TCC privacy permissions.
- **System audio + microphone** — records remote speaker audio and local microphone input.
- **Half-duplex mixing** — prioritize system audio while others speak; fade to microphone during system silence.
- **Meeting detection** — detects Zoom, Tencent Meeting, Google Meet, Feishu/Lark, WeChat calls, and browser-based meetings.
- **Resident STT daemon** — `stt_daemon` keeps MLX Whisper (or whisper-cli) loaded under launchd; eliminates the 3–10s per-transcribe cold-start tax. Two-slot scheduler (interactive + background) with priority + cancellation. See [ADR-001](spec/adr/001-resident-stt-daemon.md).
- **User-editable vocabulary** — `~/.config/yulu/vocab.sqlite` drives both `mlx-whisper` `initial_prompt` injection and post-transcription regex replacement. Edit via `yulu vocab add/list/edit/remove`. See [ADR-002](spec/adr/002-vocab-sqlite-single-source.md).
- **OpenClaw agent summaries** — transcription writes a `summary_request` into the agent queue; the OpenClaw agent generates the final meeting notes and notifies the user.

## Install

Clone the full repository first. `setup.sh` needs repository files and should not be run via `curl | bash`.

```bash
git clone https://github.com/Nowhitestar/Yulu.git
cd Yulu
bash yulu/scripts/setup.sh
```

If you are already inside the skill folder that contains `SKILL.md` and `scripts/`, you can run:

```bash
bash scripts/setup.sh
```

The installer will:

1. Check macOS, Homebrew, and Python
2. Install `sox`, `ffmpeg`, `whisper-cpp`, `terminal-notifier`, `gogcli`, and `cloudflared`
3. Create `~/.config/yulu/config.json`
4. Compile the window scanner and guide Accessibility permission setup
5. Build and sign `Yulu.app`
6. Guide Microphone and Screen & System Audio Recording permissions
7. Optionally configure Google Calendar
8. Install LaunchAgent background services
9. Run basic verification tests

## macOS Permissions

| Component | Permission | Purpose |
|---|---|---|
| `Yulu.app` | Microphone | Record local microphone audio |
| `Yulu.app` | Screen & System Audio Recording | Capture system audio via ScreenCaptureKit |
| `window_scanner` | Accessibility | Read window titles to detect meetings/calls |

If system audio is missing, open:

System Settings → Privacy & Security → **Screen & System Audio Recording** → enable `Yulu.app`.

## Google Calendar and Privacy

Calendar authorization uses `gog`; refresh tokens are stored in the system Keychain. The repository and skill package must never contain real `client_secret*.json`, refresh tokens, API keys, or personal calendar IDs.

Recommended setup:

```bash
# 1. In Google Cloud Console, enable Calendar API and create a Desktop OAuth client.
# 2. Download the JSON locally.
# 3. Import credentials and authorize Calendar access.
gog auth credentials ~/Downloads/client_secret_xxx.json
gog auth add your.email@example.com --services calendar
gog auth list
# 4. After auth succeeds, delete the Downloads copy of client_secret_xxx.json.
```

Then enable Google Calendar in `~/.config/yulu/config.json`:

```json
{
  "calendars": [
    {
      "type": "google",
      "enabled": true,
      "gog_account": "your.email@example.com",
      "watch_calendars": ["primary"]
    }
  ]
}
```

If credentials were ever posted in chat or committed publicly: delete the OAuth client, revoke the token, create a fresh client, and authorize again.

## Configuration

Config path: `~/.config/yulu/config.json`

Key fields:

```json
{
  "audio": {
    "backend": "daemon",
    "output_dir": "/path/to/Yulu/meeting-recordings",
    "silence_threshold": 0.01,
    "silence_duration_sec": 300,
    "half_duplex": true
  },
  "transcription": {
    "post_recording_mode": "fast_summary",
    "final_engine": "mlx",
    "mlx": {
      "python": "~/.config/yulu/venv-mlx-whisper/bin/python",
      "model": "mlx-community/whisper-large-v3-mlx"
    },
    "realtime": {
      "engine": "mlx",
      "mlx_model": "mlx-community/whisper-large-v3-mlx",
      "chunk_sec": 60
    },
    "whisper_cli": "whisper-cli",
    "local_model_path": "~/.config/yulu/models/ggml-large-v3.bin",
    "language": "zh"
  },
  "llm": {
    "enabled": true
  }
}
```

Notes:

- `audio.backend=daemon` is the recommended default and does not require BlackHole.
- `mic_device` / `system_audio_device` are only for the legacy SoX fallback path.
- `post_recording_mode=fast_summary` uses realtime transcript → polish → summary; switch with `yulu transcription mode full` for a slower full final transcription.
- `final_engine=mlx` is best on Apple Silicon. Non-MLX users can switch with `yulu transcription engine whisper <ggml-model-path>`.
- If no external LLM command is configured, summaries are delegated to the OpenClaw agent queue.

## Scripts

All scripts live under `scripts/`:

| Script | Purpose |
|---|---|
| `setup.sh` | Interactive installer |
| `Yulu.app/` | Native signed audio daemon app bundle |
| `audio_daemon.swift` | ScreenCaptureKit + AVFoundation + Unix socket |
| `build_audio_daemon.sh` | Build and sign Yulu.app |
| `record_audio.py` | Recording control (`start` / `stop` / `status`) |
| `meeting_daemon.py` | Recording workflow control |
| `scheduler_daemon.py` | Meeting scheduler daemon |
| `meeting_detector.py` | Meeting window detector |
| `window_scanner.swift` | Accessibility window scanner |
| `recorder_status.swift` | Floating recording status window |
| `transcribe.py` | Thin client: orchestrate via `stt_daemon` + refine/summary/agent-queue dispatch |
| `transcribe_client.py` | Synchronous RPC client for `stt_daemon` (retry-on-EOF) |
| `realtime_transcribe.py` | Daemon **subscriber** (writes `<audio>.realtime.transcript.txt` from partial events) |
| `stt_daemon/` | Resident STT service — protocol, scheduler, runtime, vocab cache, live-session tail loop, control server |
| `vocab/` | `custom_words` SQLite repository, frozen seed snapshots, `yulu vocab` CLI |
| `stt_cli.py` | `yulu stt` subcommand handlers (status / warm-up / logs / restart) |
| `agent_notify.py` | OpenClaw agent queue writer |
| `notify.py` | macOS notifications/prompts |
| `check_meetings.py` | Calendar queries |
| `send_summary.py` | Optional Telegram/Zulip/Notion output |
| `webhook_server.py` | Deprecated fallback Google Calendar webhook server |
| `run_calendar_services.py` | Google Calendar webhook + cloudflared tunnel service |
| `summary_template.md` | Meeting notes template |
| `config.example.json` | Example config |
| `com.yulu.*.plist` | LaunchAgent definitions (includes `com.yulu.sttdaemon.plist`) |

## CLI Surfaces

```bash
# Vocabulary (custom_words SQLite)
yulu vocab seed --from-current        # one-time, install the bundled glossary
yulu vocab list --json                 # show all rows
yulu vocab add "agent king" "AgentKey" --scope both
yulu vocab edit <id> --disable
yulu vocab remove <id>
yulu vocab export --format json -o backup.json
yulu vocab import backup.json
yulu vocab reload                      # SIGHUP daemon (also auto-fired after mutations)

# STT daemon operations
yulu stt status                        # health: model_loaded, in_flight, sessions
yulu stt status --json                 # same, machine-readable
yulu stt warm-up                       # explicit warm (otherwise lazy on first transcribe)
yulu stt logs --tail 50                # tail structured JSON log
yulu stt restart                       # launchctl kickstart -k

# Health check (covers stt_daemon section)
yulu doctor --json | jq .stt_daemon
```

## Manual Commands

```bash
# Audio daemon status (existing)
echo '{"action":"status"}' | nc -w 2 -U ~/.config/yulu/audio_daemon.sock

# Direct daemon RPC (debugging)
echo '{"type":"health"}' | nc -U ~/.config/yulu/stt_daemon.sock

# Manual recording
python3 scripts/record_audio.py start "Test Meeting"
python3 scripts/record_audio.py stop

# Prompt-based recording flow
python3 scripts/meeting_daemon.py ask_record "Test Meeting" "manual-test"

# Transcribe WAV
python3 scripts/transcribe.py /path/to/meeting-recordings/xxx.wav

# Calendar
python3 scripts/check_meetings.py today
python3 scripts/check_meetings.py upcoming
python3 scripts/check_meetings.py week --json

# Window detection
python3 scripts/meeting_detector.py once
python3 scripts/meeting_detector.py daemon
```

## Troubleshooting

### Yulu has no system audio

```bash
echo '{"action":"status"}' | nc -w 2 -U ~/.config/yulu/audio_daemon.sock
```

If `sysReady=false`:

1. Open System Settings → Privacy & Security → Screen & System Audio Recording
2. Enable `Yulu.app`
3. Restart Yulu:

```bash
pkill -f audio_daemon
open scripts/Yulu.app
```

### WAV exists but is silent

Usually this is a TCC permission issue or the daemon is not ready. Newer versions refuse to start recording when `sysReady` / `micReady` is false to avoid fake silent WAVs.

### Summary is still a draft

Check the queue:

```bash
cat ~/.config/yulu/agent-queue.json
```

If there is a `summary_request`, the OpenClaw heartbeat agent will read the transcript and template, overwrite the final summary, and notify the user.

---

# 中文说明

Yulu（语录）是一个 macOS 原生会议助手：日历/窗口检测 → 弹窗询问 → 录制系统音频 + 麦克风 → 本地转录 → agent 生成会议纪要。

名字取自《论语》《传习录》的"语录"体——把发言原原本本记下来再读。

核心特点：不需要 BlackHole；通过 ScreenCaptureKit 直接捕获系统音频；用 MLX Whisper 或 whisper-cli 本地转写；通过 agent queue 让任意 agent（Claude Code / Codex / OpenClaw）生成最终纪要。

快速安装：

```bash
git clone https://github.com/Nowhitestar/Yulu.git
cd Yulu
bash yulu/scripts/setup.sh
```

Google Calendar 授权使用 `gog`，refresh token 存在系统 Keychain。不要把 `client_secret*.json`、refresh token、API key 或个人日历 ID 提交到公开仓库。
