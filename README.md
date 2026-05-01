# Meeting Assistant

> Native macOS meeting automation: calendar/window detection → ask before recording → record system audio + microphone → local transcription → OpenClaw agent meeting notes.

[中文版本](#中文说明)

## Status

- ✅ Native recording with `ScreenCaptureKit` for system audio and `AVFoundation` for microphone input
- ✅ No BlackHole, virtual audio device, or multi-output device required
- ✅ Signed `AudioDaemon.app` for stable macOS TCC privacy permissions
- ✅ Half-duplex mixing: prioritize system audio while others speak, switch to microphone during system silence
- ✅ Floating recording status window with manual stop button
- ✅ Local transcription via `whisper.cpp` / `whisper-cli`
- ✅ Final meeting notes generated through the OpenClaw agent queue

## Quick Install

```bash
# setup.sh needs the full repository; do not use curl | bash
git clone https://github.com/Nowhitestar/meeting-assistant.git
cd meeting-assistant
bash meeting-assistant/scripts/setup.sh
```

The installer writes user-specific configuration to `~/.config/meeting-assistant/` and `~/.config/gcp/`. These paths are git-ignored. Never commit your own `client_secret*.json`, `config.json`, tokens, or recordings to a public repository.

The installer will guide you through:

1. Checking macOS, Homebrew, and Python
2. Installing `sox`, `ffmpeg`, `whisper-cpp`, `terminal-notifier`, `gogcli`, and `cloudflared`
3. Creating `~/.config/meeting-assistant/config.json`
4. Compiling the window scanner and granting Accessibility permission
5. Building and signing `AudioDaemon.app`
6. Granting Microphone and Screen & System Audio Recording permissions
7. Optional Google Calendar setup
8. Installing LaunchAgent background services
9. Running basic verification tests

## macOS Permissions

| Component | Permission | Why |
|---|---|---|
| `AudioDaemon.app` | Microphone | Record your local microphone |
| `AudioDaemon.app` | Screen & System Audio Recording | Capture system audio with ScreenCaptureKit |
| `window_scanner` | Accessibility | Read window titles for meeting/call detection |

If system audio is missing, open:

System Settings → Privacy & Security → **Screen & System Audio Recording** → enable `AudioDaemon.app`.

## Features

| Feature | Description |
|---|---|
| 📅 Calendar sync | Google Calendar push notification + fallback polling |
| 🔔 Meeting prompts | Notify before meetings and ask before recording starts |
| 👀 Window detection | WeChat, Tencent Meeting, Google Meet, Zoom, Feishu/Lark, and more |
| 🎙️ Native recording | ScreenCaptureKit system audio + AVFoundation microphone |
| 🌓 Half-duplex mixing | Prioritize system audio while others speak, switch to mic during silence |
| 🪟 Status window | Floating recording status with manual stop |
| 📝 Local transcription | `whisper-cli` from whisper.cpp |
| 🤖 Agent notes | OpenClaw agent turns transcripts into final summaries |
| ☁️ Output | Local files, with optional Telegram / Notion / Zulip extensions |

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
 record_audio.py → AudioDaemon.app (Unix socket)
          ↓
 ScreenCaptureKit system audio + AVFoundation microphone
          ↓
 WAV → transcribe.py → whisper-cli
          ↓
 transcript.txt + summary_request queue
          ↓
 OpenClaw agent → final summary.md → user notification
```

## Audio Details

`AudioDaemon.app` is a background macOS app (`LSUIElement`) that exposes a Unix socket:

- Socket: `~/.config/meeting-assistant/audio_daemon.sock`
- Actions: `start` / `stop` / `status` / `windows`
- Output: `<repo>/meeting-recordings/*.wav`
- WAV: 16-bit stereo 48kHz
- System audio: ScreenCaptureKit Float32 planar → interleaved stereo Int16
- Microphone: AVAudioEngine Float32 mono → stereo mix
- Mixing: system audio first when active; fade to microphone when system audio is silent

### Codesigning

Build script:

```bash
meeting-assistant/scripts/build_audio_daemon.sh
```

It compiles `audio_daemon.swift`, updates `AudioDaemon.app`, writes TCC usage descriptions, and signs with an Apple Development / Developer ID certificate when available. Without a certificate it falls back to ad-hoc signing.

Optional signing identity:

```bash
MEETING_ASSISTANT_CODESIGN_IDENTITY="Developer ID Application: ..." \
  meeting-assistant/scripts/build_audio_daemon.sh
```

## Google Calendar Setup

Calendar integration uses `gog`; refresh tokens are stored in the system Keychain. This repository must never contain real OAuth secrets.

Recommended flow:

1. Open Google Cloud Console → APIs & Services → Credentials
2. Enable Google Calendar API
3. Create OAuth Client ID, application type: **Desktop app**
4. Download `client_secret_*.json` locally, e.g. `~/Downloads/client_secret_xxx.json`
5. Run:

```bash
gog auth credentials ~/Downloads/client_secret_xxx.json
gog auth add your.email@example.com --services calendar
gog auth list
```

6. After authorization, you may delete the copy in Downloads. `gog` has copied what it needs into its own config/keychain storage.
7. Enable Google Calendar in `~/.config/meeting-assistant/config.json`:

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

Security note: if any `client_secret*.json` or refresh token was ever posted to chat or committed publicly, delete that OAuth client, revoke the token, and authorize again with a fresh client.

## Configuration

Config path: `~/.config/meeting-assistant/config.json`

Key fields:

```json
{
  "audio": {
    "backend": "daemon",
    "output_dir": "/path/to/meeting-assistant/meeting-recordings",
    "silence_threshold": 0.01,
    "silence_duration_sec": 300,
    "half_duplex": true
  },
  "transcription": {
    "whisper_cli": "whisper-cli",
    "local_model_path": "~/Models/whisper/ggml-medium.bin",
    "language": "zh"
  },
  "llm": {
    "enabled": true
  }
}
```

Notes:

- `audio.backend=daemon` is the recommended default and does not need BlackHole.
- `mic_device` / `system_audio_device` are only for the legacy SoX fallback path.
- When no external LLM command is configured, summaries are delegated to the OpenClaw agent queue.

## Manual Commands

```bash
# AudioDaemon status
echo '{"action":"status"}' | nc -w 2 -U ~/.config/meeting-assistant/audio_daemon.sock

# Manual recording
python3 meeting-assistant/scripts/record_audio.py start "Test Meeting"
python3 meeting-assistant/scripts/record_audio.py stop

# Prompt-based recording flow
python3 meeting-assistant/scripts/meeting_daemon.py ask_record "Test Meeting" "manual-test"

# Transcribe a WAV
python3 meeting-assistant/scripts/transcribe.py /path/to/meeting-assistant/meeting-recordings/xxx.wav

# Calendar
python3 meeting-assistant/scripts/check_meetings.py today
python3 meeting-assistant/scripts/check_meetings.py upcoming
python3 meeting-assistant/scripts/check_meetings.py week --json

# Window detection
python3 meeting-assistant/scripts/meeting_detector.py once
python3 meeting-assistant/scripts/meeting_detector.py daemon
```

## Project Structure

```text
meeting-assistant/
├── README.md
├── meeting-assistant.skill
├── meeting-recordings/                  # local recording output, git ignored
└── meeting-assistant/
    ├── SKILL.md
    └── scripts/
        ├── setup.sh                     # interactive installer
        ├── AudioDaemon.app/             # native audio daemon app
        ├── audio_daemon.swift           # ScreenCaptureKit + AVFoundation + socket
        ├── build_audio_daemon.sh        # build and sign AudioDaemon
        ├── record_audio.py              # recording control
        ├── meeting_daemon.py            # workflow control
        ├── scheduler_daemon.py          # scheduler daemon
        ├── meeting_detector.py          # meeting window detector
        ├── window_scanner.swift         # Accessibility window scanner
        ├── recorder_status.swift        # floating status window
        ├── transcribe.py                # whisper transcription + agent queue
        ├── agent_notify.py              # OpenClaw agent queue writer
        ├── summary_template.md          # meeting notes template
        └── com.meetingassistant.*.plist # LaunchAgents
```

## Troubleshooting

### AudioDaemon has no system audio

```bash
echo '{"action":"status"}' | nc -w 2 -U ~/.config/meeting-assistant/audio_daemon.sock
```

If `sysReady=false`:

1. Open System Settings → Privacy & Security → Screen & System Audio Recording
2. Enable `AudioDaemon.app`
3. Restart AudioDaemon:

```bash
pkill -f audio_daemon
open meeting-assistant/scripts/AudioDaemon.app
```

### WAV exists but is silent

This is usually a TCC permission issue or the daemon is not ready. Newer versions refuse to start recording when `sysReady` / `micReady` is false, to avoid producing fake silent WAVs.

### Summary is still a draft

Check the agent queue:

```bash
cat ~/.config/meeting-assistant/agent-queue.json
```

If there is a `summary_request`, the OpenClaw heartbeat agent will read the transcript and template, overwrite the final summary, and notify you.

---

# 中文说明

> macOS 原生会议助手：日历/窗口检测 → 弹窗询问 → 录制系统音频 + 麦克风 → 本地转录 → OpenClaw agent 生成会议纪要。

## 当前状态

- ✅ 原生录音：`ScreenCaptureKit` 捕获系统音频，`AVFoundation` 捕获麦克风
- ✅ 不需要 BlackHole / 多输出设备 / 虚拟声卡
- ✅ AudioDaemon.app 固定 codesign 签名，便于 macOS TCC 权限稳定识别
- ✅ 半双工混音：系统音频有声时优先系统音频；系统静音时切到麦克风
- ✅ 右侧录制状态浮窗，可手动停止
- ✅ whisper.cpp 本地转录
- ✅ Summary 通过 OpenClaw agent queue 交给 agent 生成最终版

## 快速安装

```bash
# setup.sh 需要完整仓库文件，不能直接 curl | bash
git clone https://github.com/Nowhitestar/meeting-assistant.git
cd meeting-assistant
bash meeting-assistant/scripts/setup.sh
```

安装脚本会把用户级配置写到 `~/.config/meeting-assistant/` 和 `~/.config/gcp/`。这些路径已在 `.gitignore` 中排除。不要把自己的 `client_secret*.json`、`config.json`、token 或录音文件提交到公开仓库。

## 必要 macOS 权限

| 组件 | 权限 | 用途 |
|---|---|---|
| `AudioDaemon.app` | 麦克风 | 录制本机麦克风 |
| `AudioDaemon.app` | 屏幕与系统音频录制 | 通过 ScreenCaptureKit 捕获系统音频 |
| `window_scanner` | 辅助功能 | 读取窗口标题，检测会议/通话 |

如果录不到系统音频，先检查：

系统设置 → 隐私与安全性 → **屏幕与系统音频录制** → 打开 `AudioDaemon.app`

## 功能一览

| 功能 | 说明 |
|---|---|
| 📅 日历同步 | Google Calendar push notification + 兜底轮询 |
| 🔔 准时提醒 | 会议前通知，到点弹窗询问是否录制 |
| 👀 窗口检测 | 微信、腾讯会议、Google Meet、Zoom、飞书等会议窗口 |
| 🎙️ 原生录制 | ScreenCaptureKit 系统音频 + AVFoundation 麦克风 |
| 🌓 半双工混音 | 对方说话时录系统音频；系统静音时切到麦克风 |
| 🪟 状态浮窗 | 右侧录制状态 + 手动停止按钮 |
| 📝 本地转录 | whisper.cpp / `whisper-cli` |
| 🤖 会议纪要 | OpenClaw agent 根据 transcript + template 生成最终 summary |
| ☁️ 输出 | 本地文件，可扩展 Telegram / Notion / Zulip |

## Google Calendar 配置

日历功能使用 `gog`，refresh token 存在系统 Keychain；仓库不会、也不应该包含任何真实 OAuth secret。

推荐流程：

1. 打开 Google Cloud Console → APIs & Services → Credentials
2. 启用 Google Calendar API
3. 创建 OAuth Client ID，Application type 选择 **Desktop app**
4. 下载 `client_secret_*.json` 到本机，例如 `~/Downloads/client_secret_xxx.json`
5. 运行：

```bash
gog auth credentials ~/Downloads/client_secret_xxx.json
gog auth add your.email@example.com --services calendar
gog auth list
```

6. 授权成功后可删除 Downloads 里的 `client_secret_*.json` 副本；`gog` 已把凭据复制到自己的配置目录。
7. 在 `~/.config/meeting-assistant/config.json` 中启用：

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

安全建议：如果任何 `client_secret*.json` 或 refresh token 曾经发到聊天/公开仓库，删除对应 OAuth client 并重新授权。

## 配置文件

路径：`~/.config/meeting-assistant/config.json`

关键字段：

```json
{
  "audio": {
    "backend": "daemon",
    "output_dir": "/path/to/meeting-assistant/meeting-recordings",
    "silence_threshold": 0.01,
    "silence_duration_sec": 300,
    "half_duplex": true
  },
  "transcription": {
    "whisper_cli": "whisper-cli",
    "local_model_path": "~/Models/whisper/ggml-medium.bin",
    "language": "zh"
  },
  "llm": {
    "enabled": true
  }
}
```

说明：

- `audio.backend=daemon` 是推荐/默认模式，不需要 BlackHole。
- `mic_device` / `system_audio_device` 只用于旧 SoX fallback。
- 未配置外部 LLM command 时，summary 会通过 OpenClaw agent queue 交给当前 agent 生成最终版。

## 手动命令

```bash
# AudioDaemon 状态
echo '{"action":"status"}' | nc -w 2 -U ~/.config/meeting-assistant/audio_daemon.sock

# 手动录制
python3 meeting-assistant/scripts/record_audio.py start "测试会议"
python3 meeting-assistant/scripts/record_audio.py stop

# 弹窗录制流程
python3 meeting-assistant/scripts/meeting_daemon.py ask_record "测试会议" "manual-test"

# 转录某个 WAV
python3 meeting-assistant/scripts/transcribe.py /path/to/meeting-assistant/meeting-recordings/xxx.wav

# 日历
python3 meeting-assistant/scripts/check_meetings.py today
python3 meeting-assistant/scripts/check_meetings.py upcoming
python3 meeting-assistant/scripts/check_meetings.py week --json

# 窗口检测
python3 meeting-assistant/scripts/meeting_detector.py once
python3 meeting-assistant/scripts/meeting_detector.py daemon
```

## 排障

### AudioDaemon 没有系统音频

```bash
echo '{"action":"status"}' | nc -w 2 -U ~/.config/meeting-assistant/audio_daemon.sock
```

如果 `sysReady=false`：

1. 打开系统设置 → 隐私与安全性 → 屏幕与系统音频录制
2. 允许 `AudioDaemon.app`
3. 重启 AudioDaemon：

```bash
pkill -f audio_daemon
open meeting-assistant/scripts/AudioDaemon.app
```

### WAV 生成但全静音

通常是 TCC 权限或 daemon 没 ready。新版 `start` 会在 `sysReady/micReady` 不满足时拒绝录制，避免生成假 WAV。

### Summary 还是草稿

检查队列：

```bash
cat ~/.config/meeting-assistant/agent-queue.json
```

如果有 `summary_request`，OpenClaw agent heartbeat 会读取 transcript + template，覆盖写最终 summary。

## License

MIT
