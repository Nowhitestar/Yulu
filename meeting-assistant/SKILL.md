---
name: meeting-assistant
description: "Native macOS meeting automation for OpenClaw: calendar/window detection, prompt-before-recording, ScreenCaptureKit system audio + microphone recording, local whisper-cli transcription, and agent-generated meeting notes. No BlackHole or virtual audio device required. Use when you need automatic meeting detection, recording, transcription, and final summaries delivered by an OpenClaw agent."
---

# Meeting Assistant — 会议全流程自动化

macOS 原生会议助手：日历/窗口检测 → 弹窗询问 → 录制系统音频 + 麦克风 → 本地转录 → OpenClaw agent 生成会议纪要。

## 架构概览

```
Google Calendar / Window Detector
          ↓
 schedule.json → scheduler_daemon.py
          ↓
 meeting_daemon.py ask_record
          ↓
 notify.py 弹窗：开始录制？
          ↓
 record_audio.py → AudioDaemon.app (Unix socket)
          ↓
 ScreenCaptureKit 系统音频 + AVFoundation 麦克风
          ↓
 WAV → transcribe.py → whisper-cli
          ↓
 transcript.txt + summary_request queue
          ↓
 OpenClaw agent heartbeat → 覆盖写入最终 summary.md → 发给用户
```

## 核心功能

| 功能 | 说明 |
|------|------|
| 📅 日历同步 | Google Calendar push notification + 兜底轮询 |
| 🔔 准时提醒 | 会议前通知，到点弹窗询问是否录制 |
| 👀 窗口检测 | 微信、腾讯会议、Google Meet、Zoom、飞书等会议窗口 |
| 🎙️ 原生录制 | ScreenCaptureKit 系统音频 + AVFoundation 麦克风，无需虚拟声卡 |
| 🌓 半双工混音 | 对方说话时录系统音频；系统静音时切到麦克风 |
| 🪟 状态浮窗 | 右侧录制状态浮窗 + 手动停止按钮 |
| 📝 本地转录 | whisper-cli（C++ 版，无需 Python whisper 包的依赖问题） |
| 🤖 会议纪要 | OpenClaw agent 根据 transcript + template 生成最终 summary |
| 🛎️ 全流程自动化 | LaunchAgent 常驻服务，无需手动干预 |

## 关键特性

- **不需要 BlackHole / 多输出设备 / 虚拟声卡** — 直接通过 ScreenCaptureKit 捕获系统音频
- **AudioDaemon.app 固定签名** — 编译后用 Apple Development 或 Developer ID 证书签名的 app bundle，便于 macOS TCC 权限稳定识别，不会频繁弹出授权请求
- **半双工混音** — 系统音频有声时优先系统音频；系统静音时渐变到麦克风
- **OpenClaw agent 集成** — 转写完成后通过 `agent-queue.json` 将 `summary_request` 写入队列，agent heartbeat 自动读取模板+转写文件，生成并覆盖最终版纪要，然后直接推送到用户对话

## 快速开始

### 克隆后安装

```bash
git clone https://github.com/Nowhitestar/meeting-assistant.git
cd meeting-assistant
bash meeting-assistant/scripts/setup.sh
```

如果已经在 skill 目录（包含 `SKILL.md` 和 `scripts/`）中，也可以运行：

```bash
bash scripts/setup.sh
```

`setup.sh` 需要完整仓库文件，不能直接 `curl | bash`。

安装脚本交互式完成：

1. 检查 macOS / Homebrew / Python
2. 安装依赖：`sox`、`ffmpeg`、`whisper-cpp`、`terminal-notifier`
3. 创建配置文件
4. 编译窗口扫描工具并授权辅助功能
5. 编译并固定签名 `AudioDaemon.app`
6. 引导授权麦克风、屏幕与系统音频录制权限
7. 配置 Google Calendar（可选）
8. 安装 LaunchAgent 常驻服务
9. 运行验证测试

### 手动安装

```bash
# 安装依赖
brew install sox ffmpeg whisper-cpp terminal-notifier

# 创建配置
cp scripts/config.example.json ~/.config/meeting-assistant/config.json
# 按需编辑 config.json

# 编译 AudioDaemon（固定签名）
bash scripts/build_audio_daemon.sh

# 编译窗口扫描工具
cd AudioDaemon.app/..  # 或 scripts 目录
swiftc -o window_scanner window_scanner.swift -framework ApplicationServices
# 授权辅助功能：系统设置 → 隐私 → 辅助功能

# 安装 LaunchAgent
cp scripts/com.meetingassistant.*.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.meetingassistant.audiodaemon.plist
```

## 必要 macOS 权限

| 组件 | 权限 | 用途 |
|------|------|------|
| `AudioDaemon.app` | 麦克风 | 录制本机麦克风（自己的声音） |
| `AudioDaemon.app` | 屏幕与系统音频录制 | 通过 ScreenCaptureKit 捕获对方的声音 |
| `window_scanner` | 辅助功能 | 读取窗口标题，检测会议/通话状态 |

如果录不到系统音频：
系统设置 → 隐私与安全性 → **屏幕与系统音频录制** → 允许 `AudioDaemon.app`

## Google Calendar 与隐私

日历授权使用 `gog`，refresh token 存在系统 Keychain；仓库不应包含真实 `client_secret*.json`、refresh token、API key 或个人日历 ID。

推荐配置：

```bash
# 1. Google Cloud Console 启用 Calendar API，创建 Desktop OAuth client，下载 JSON
# 2. 本机导入并授权
gog auth credentials ~/Downloads/client_secret_xxx.json
gog auth add your.email@example.com --services calendar
gog auth list
# 3. 授权成功后可删除 Downloads 中的 client_secret_xxx.json 副本
```

然后在 `~/.config/meeting-assistant/config.json` 中启用：

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

如果凭据曾经发到聊天或公开仓库：删除对应 OAuth client，revoke token，重新创建并授权。

## 配置文件

路径：`~/.config/meeting-assistant/config.json`

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
    "command": [
      "whisper-cli",
      "-m", "~/Models/whisper/ggml-medium.bin",
      "-l", "zh",
      "-otxt",
      "-of", "{{output_stem}}",
      "{{input}}"
    ]
  },
  "llm": {
    "enabled": true
  }
}
```

## 脚本说明

所有脚本位于 `scripts/` 目录：

| 脚本 | 用途 |
|------|------|
| `setup.sh` | 交互式一键安装脚本 |
| `AudioDaemon.app/` | 原生音频录制 daemon（固定签名） |
| `audio_daemon.swift` | ScreenCaptureKit + AVFoundation + Unix socket |
| `build_audio_daemon.sh` | 编译并固定签名 AudioDaemon |
| `record_audio.py` | 录制控制（start/stop/status） |
| `meeting_daemon.py` | 录制流程控制（ask_record / schedule / check） |
| `scheduler_daemon.py` | 定时调度器，管理日历任务 |
| `meeting_detector.py` | 会议窗口检测（微信/腾讯会议/飞书等） |
| `window_scanner.swift` | AX 窗口扫描工具（辅助功能） |
| `recorder_status.swift` | 录制状态浮窗 app |
| `transcribe.py` | whisper 转写 + agent queue summary_request |
| `agent_notify.py` | OpenClaw agent queue 队列写入 |
| `notify.py` | macOS 系统通知/弹窗 |
| `check_meetings.py` | 日历查询 |
| `send_summary.py` | 推送到 Telegram/Zulip 等频道 |
| `webhook_server.py` | Google Calendar push notification webhook |
| `echo_cancel.py` | SoX 降噪回显（fallback 模式下） |
| `summary_template.md` | 会议纪要 Markdown 模板 |
| `config.example.json` | 配置文件示例 |
| `com.meetingassistant.*.plist` | LaunchAgents 服务定义 |

## 手动命令

```bash
# AudioDaemon 状态
echo '{"action":"status"}' | nc -w 2 -U ~/.config/meeting-assistant/audio_daemon.sock

# 手动录制
python3 scripts/record_audio.py start "测试会议"
python3 scripts/record_audio.py stop

# 弹窗录制流程
python3 scripts/meeting_daemon.py ask_record "测试会议" "manual-test"

# 转写 WAV
python3 scripts/transcribe.py /path/to/meeting-recordings/xxx.wav

# 日历
python3 scripts/check_meetings.py today
python3 scripts/check_meetings.py upcoming
python3 scripts/check_meetings.py week --json

# 窗口检测
python3 scripts/meeting_detector.py once
python3 scripts/meeting_detector.py daemon

# 手动触发 summary
echo '{"type":"summary_request","title":"测试会议","transcript_path":"...","template_path":"...","summary_path":"..."}' \
  > ~/.config/meeting-assistant/agent-queue.json
```

## 常用排障

### AudioDaemon 没有系统音频

```bash
echo '{"action":"status"}' | nc -w 2 -U ~/.config/meeting-assistant/audio_daemon.sock
```

如果 `sysReady=false`：
1. 系统设置 → 隐私与安全性 → **屏幕与系统音频录制**
2. 允许 `AudioDaemon.app`
3. 重启：`pkill -f audio_daemon` → 重新开

### WAV 生成但全静音

通常是 TCC 权限或 daemon 没 ready。新版 `start` 会在 `sysReady`/`micReady` 不满足时拒绝录制。

### Summary 是草稿？

检查队列：

```bash
cat ~/.config/meeting-assistant/agent-queue.json
```

如果有 `summary_request`，OpenClaw agent heartbeat 会读取 transcript + template，覆盖写最终 summary 并主动推送。

### 重新运行安装脚本

```bash
bash scripts/setup.sh
```

## 音频实现细节

- **Socket**：`~/.config/meeting-assistant/audio_daemon.sock`
- **Action**：`start` / `stop` / `status` / `windows`
- **输出**：`meeting-recordings/*.wav`
- **WAV**：16-bit stereo 48kHz
- **系统音频**：ScreenCaptureKit Float32 planar → interleaved stereo Int16
- **麦克风**：AVAudioEngine Float32 mono → stereo mix
- **半双工**：系统音频 active 时优先系统；系统静音时渐变到麦克风

### 固定签名

`build_audio_daemon.sh` 会：
1. 编译 `audio_daemon.swift`
2. 复制到 `AudioDaemon.app/Contents/MacOS/audio_daemon`
3. 写入 TCC usage descriptions
4. 优先使用本机 Apple Development / Developer ID 证书签名
5. 无证书时才 fallback 到 ad-hoc

```bash
MEETING_ASSISTANT_CODESIGN_IDENTITY="Developer ID Application: ..." \
  bash scripts/build_audio_daemon.sh
```

## 项目文件结构

```text
meeting-assistant/
├── SKILL.md                                    # Agent skill 文档
├── meeting-assistant.skill                     # Skill 归档包
└── scripts/
    ├── setup.sh                                # 交互式一键安装
    ├── AudioDaemon.app/                        # 原生音频 daemon app（固定签名）
    ├── audio_daemon.swift                      # ScreenCaptureKit + AVFoundation + socket
    ├── build_audio_daemon.sh                   # 编译并固定签名 AudioDaemon
    ├── record_audio.py                         # 录制控制
    ├── meeting_daemon.py                       # 流程控制
    ├── scheduler_daemon.py                     # 定时调度
    ├── meeting_detector.py                     # 窗口检测
    ├── window_scanner.swift                    # AX 窗口扫描
    ├── recorder_status.swift                   # 状态浮窗
    ├── transcribe.py                           # 转写 + agent queue
    ├── agent_notify.py                         # Agent queue 写入
    ├── notify.py                               # 系统通知
    ├── check_meetings.py                       # 日历查询
    ├── send_summary.py                         # 推送纪要
    ├── webhook_server.py                       # Google Calendar webhook
    ├── echo_cancel.py                          # 降噪（fallback）
    ├── summary_template.md                     # 纪要模板
    ├── config.example.json                     # 配置示例
    └── com.meetingassistant.*.plist             # LaunchAgents
```

## 依赖

- macOS 14+（ScreenCaptureKit 需要）
- Homebrew (sox, ffmpeg, whisper-cpp, terminal-notifier)
- Python 3.8+
- OpenClaw（agent heartbeat 集成 summary 生成）
