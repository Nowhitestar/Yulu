# Meeting Assistant — 会议全流程自动化

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
# 方式一：一行命令安装
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/meeting-assistant/main/meeting-assistant/scripts/setup.sh | bash

# 方式二：克隆后安装
git clone https://github.com/Nowhitestar/meeting-assistant.git
cd meeting-assistant
bash meeting-assistant/scripts/setup.sh
```

安装脚本会交互式完成：

1. 检查 macOS / Homebrew / Python
2. 安装依赖：`sox`、`ffmpeg`、`whisper-cpp`、`terminal-notifier`、`gogcli`、`cloudflared`
3. 创建配置文件
4. 编译窗口扫描工具并授权辅助功能
5. 编译并固定签名 `AudioDaemon.app`
6. 引导授权麦克风、屏幕与系统音频录制权限
7. 配置 Google Calendar（可选）
8. 安装 LaunchAgent 常驻服务
9. 运行验证测试

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
|------|------|
| 📅 日历同步 | Google Calendar push notification + 兜底轮询 |
| 🔔 准时提醒 | 会议前通知，到点弹窗询问是否录制 |
| 👀 窗口检测 | 微信、腾讯会议、Google Meet、Zoom、飞书等会议窗口 |
| 🎙️ 原生录制 | ScreenCaptureKit 系统音频 + AVFoundation 麦克风 |
| 🌓 半双工混音 | 对方说话时录系统音频；系统静音时切到麦克风 |
| 🪟 状态浮窗 | 右侧录制状态 + 手动停止按钮 |
| 📝 本地转录 | whisper.cpp / `whisper-cli` |
| 🤖 会议纪要 | OpenClaw agent 根据 transcript + template 生成最终 summary |
| ☁️ 输出 | 本地文件，可扩展 Telegram / Notion / Zulip |

## 架构

```text
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
 OpenClaw agent → 覆盖写入最终 summary.md → 发给用户
```

## 音频实现细节

`AudioDaemon.app` 是一个无 Dock 图标的 macOS app（`LSUIElement`）：

- Socket：`~/.config/meeting-assistant/audio_daemon.sock`
- 支持 action：`start` / `stop` / `status` / `windows`
- 输出：`<repo>/meeting-recordings/*.wav`
- WAV：16-bit stereo 48kHz
- 系统音频：ScreenCaptureKit Float32 planar → interleaved stereo Int16
- 麦克风：AVAudioEngine Float32 mono → stereo mix
- 半双工：系统音频 active 时优先系统；系统静音时渐变到麦克风

### 固定签名

构建脚本：

```bash
meeting-assistant/scripts/build_audio_daemon.sh
```

它会：

1. 编译 `audio_daemon.swift`
2. 复制到 `AudioDaemon.app/Contents/MacOS/audio_daemon`
3. 写入 TCC usage descriptions
4. 优先使用本机 Apple Development / Developer ID 证书签名
5. 无证书时才 fallback 到 ad-hoc

可指定签名 identity：

```bash
MEETING_ASSISTANT_CODESIGN_IDENTITY="Developer ID Application: ..." \
  meeting-assistant/scripts/build_audio_daemon.sh
```

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

说明：

- `audio.backend=daemon` 是推荐/默认模式，不需要 BlackHole。
- `mic_device` / `system_audio_device` 只用于旧 SoX fallback。
- 未配置外部 LLM command 时，summary 会通过 OpenClaw agent queue 交给当前 agent 生成最终版。

## 手动命令

```bash
# AudioDaemon 状态
echo '{"action":"status"}' | nc -w 2 -U ~/.config/meeting-assistant/audio_daemon.sock

# 手动录制
record_audio.py start "测试会议"
record_audio.py stop

# 弹窗录制流程
meeting_daemon.py ask_record "测试会议" "manual-test"

# 转录某个 WAV
transcribe.py /path/to/meeting-assistant/meeting-recordings/xxx.wav

# 日历
check_meetings.py today
check_meetings.py upcoming
check_meetings.py week --json

# 窗口检测
meeting_detector.py once
meeting_detector.py daemon
```

## 文件结构

```text
meeting-assistant/
├── scripts/setup.sh
├── README.md
└── meeting-assistant/scripts/
    ├── AudioDaemon.app/                 # 原生音频 daemon app
    ├── audio_daemon.swift               # ScreenCaptureKit + AVFoundation + socket
    ├── build_audio_daemon.sh            # 编译并固定签名 AudioDaemon
    ├── record_audio.py                  # daemon/sox 后端入口
    ├── meeting_daemon.py                # 录制流程控制
    ├── scheduler_daemon.py              # 定时调度器
    ├── meeting_detector.py              # 会议窗口检测
    ├── window_scanner.swift             # AX 窗口扫描
    ├── recorder_status.swift            # 录制状态浮窗
    ├── transcribe.py                    # whisper 转录 + summary request
    ├── agent_notify.py                  # OpenClaw agent queue
    ├── summary_template.md              # 会议纪要模板
    └── com.meetingassistant.*.plist      # LaunchAgents
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
