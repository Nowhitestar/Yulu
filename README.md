# Meeting Assistant — 会议全流程自动化

> 运行在 macOS 上，从日历到录制到会议纪要，全链路自动化的会议助手。

## 快速安装

```bash
# 方式一：一行命令安装
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/meeting-assistant/main/setup.sh | bash

# 方式二：克隆后安装
git clone https://github.com/Nowhitestar/meeting-assistant.git
cd meeting-assistant
bash setup.sh
```

安装脚本会交互式引导你完成以下步骤：

1. 检查系统环境（macOS / Homebrew / Python）
2. 安装所有依赖（BlackHole、SoX、ffmpeg、gog CLI、cloudflared）
3. 检测音频设备并创建配置文件
4. 编译窗口扫描工具并授权辅助功能
5. 配置 Google 日历 OAuth（可选）
6. 安装常驻 LaunchAgent 服务
7. 运行验证测试

全程约 **10-15 分钟**。

## 功能一览

| 功能 | 说明 |
|------|------|
| 📅 **日历同步** | Google Calendar → push notification → 自动排入提醒计划 |
| 🔔 **准时提醒** | 会议前 5 分钟 macOS 系统通知，到点弹窗询问是否录制 |
| 🎙️ **自动录制** | 点"开始"后用 SoX 双路录（系统音频 + 麦克风），半双工防回声 |
| 🤫 **静默检测** | 连续 5 分钟无声音自动提示停止录制 |
| 📝 **自动转录** | 本地 whisper.cpp 转文字 |
| 🤖 **纪要生成** | LLM 生成结构化纪要（TL;DR / 讨论 / 行动项 / 决定） |
| 🪟 **窗口检测** | 检测微信、腾讯会议、Google Meet、Zoom、飞书等会议窗口 |
| ☁️ **多渠道输出** | 本地文件 / Telegram / Notion / Zulip |
| ⚡ **实时推送** | cloudflared tunnel + Google Calendar push notification，变更即同步 |

## 架构

```
Google Calendar
     ↕ Google Push Notification
cloudflared tunnel → localhost:8899
     ↕
webhook_server.py ←→ check_meetings.py
     ↕
schedule.json → scheduler_daemon.py → notify.py / meeting_daemon.py

         window_scanner (Swift, 有 Accessibility 权限)
              ↕ 读取所有窗口标题
         meeting_detector.py → 匹配会议关键词
              ↕ 稳定检测 15s 后触发
         meeting_daemon.py ask_record (弹窗录制)
```

## 手动配置

如果不想用安装脚本，也可以手动配置：

### 依赖

```bash
brew install blackhole-2ch sox switchaudio-osx ffmpeg terminal-notifier
brew install steipete/tap/gogcli cloudflared
```

### 音频

1. 打开 **音频 MIDI 设置**（应用程序 → 实用工具）
2. 左下角 **+** → **创建多输出设备**
3. 勾选：✅ **BlackHole 2ch** ✅ 你的扬声器/耳机
4. 右键 → **将此设备用于声音输出**

找到设备编号：

```bash
ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep -E "Microphone|BlackHole"
```

### 配置文件

```bash
mkdir -p ~/.config/meeting-assistant
# 然后根据 config.example.json 创建 ~/.config/meeting-assistant/config.json
```

### 编译窗口扫描工具

```bash
swiftc -o meeting-assistant/scripts/window_scanner \
  meeting-assistant/scripts/window_scanner.swift \
  -framework Cocoa
open meeting-assistant/scripts/window_scanner  # 触发辅助功能权限
# 在弹出的对话框中点击「允许」
```

### Google 日历

```bash
# 1. 获取 client_secret.json（Google Cloud Console → API → OAuth）
gog auth credentials ~/.config/gcp/client_secret.json
gog auth add your.email@example.com --services calendar

# 2. 验证
gog calendar events your.email@example.com --from "$(date -u +%Y-%m-%dT00:00:00Z)" --to "$(date -u -v+1d +%Y-%m-%dT00:00:00Z)"
```

### 安装服务

```bash
# 复制并加载 LaunchAgent
cp meeting-assistant/scripts/com.meetingassistant.scheduler.plist ~/Library/LaunchAgents/
cp meeting-assistant/scripts/com.meetingassistant.detector.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.meetingassistant.scheduler.plist
launchctl load ~/Library/LaunchAgents/com.meetingassistant.detector.plist

# 日历推送（可选）
cp meeting-assistant/scripts/com.meetingassistant.calendar.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.meetingassistant.calendar.plist

# 验证
launchctl list | grep com.meetingassistant
```

## 文件结构

```
meeting-assistant/
├── setup.sh                              # 🆕 交互式安装脚本
├── README.md
├── .gitignore
│
└── meeting-assistant/
    ├── SKILL.md
    └── scripts/
        ├── scheduler_daemon.py           # 事件调度器（常驻）
        ├── meeting_daemon.py             # 会议流程控制
        ├── meeting_detector.py           # 窗口标题会议检测
        ├── window_scanner.swift          # 🆕 窗口扫描工具源码
        ├── window_scanner                # 🆕 编译好的扫描工具（需 Accessibility 授权）
        ├── check_meetings.py             # 日历查询
        ├── run_calendar_services.py      # webhook + tunnel + watch（一站式）
        ├── record_audio.py               # SoX 双路录制 + 回声消除
        ├── transcribe.py                 # 转录 + LLM 纪要
        ├── echo_cancel.py                # 半双工回声消除
        ├── notify.py                     # macOS 通知
        ├── send_summary.py               # 多渠道发送纪要
        ├── agent_notify.py               # Agent 通知队列
        ├── recorder_status.swift         # 录制状态浮窗
        ├── config.example.json           # 配置文件示例
        ├── summary_template.md           # 纪要模板
        │
        ├── com.meetingassistant.scheduler.plist  # LaunchAgent: 调度器
        ├── com.meetingassistant.detector.plist   # LaunchAgent: 检测器
        ├── com.meetingassistant.calendar.plist   # LaunchAgent: 日历服务
        │
        └── scan_windows.sh              # 窗口扫描 shell 备用脚本
```

## 配置项

### config.json

| 路径 | 类型 | 说明 |
|------|------|------|
| `calendars[].type` | `"google"` / `"feishu"` | 日历后端 |
| `calendars[].gog_account` | string | Google 账号 |
| `calendars[].watch_calendars` | string[] | 需要推送监听的日历 |
| `audio.mic_device` | string | 麦克风 ffmpeg 设备号 (如 `:0`) |
| `audio.system_audio_device` | string | BlackHole 设备号（如 `:1`） |
| `audio.output_dir` | string | 录制文件目录 |
| `audio.silence_threshold` | float | 静默阈值 |
| `audio.silence_duration_sec` | int | 静默多久后提示停止 |
| `transcription.mode` | `"local"` / `"api"` | 转录方式 |
| `transcription.local_model_path` | string | whisper.cpp 模型路径 |
| `llm.enabled` | bool | 启用 LLM 纪要 |
| `meeting_detection.interval_sec` | int | 窗口检测间隔（秒） |
| `meeting_detection.stable_sec` | int | 检测持续多久才触发 |
| `meeting_detection.prompt_cooldown_sec` | int | 同会议重复询问冷却时间 |

## 工作流程

```
日历变更 (Google Calendar)
    ↓ push notification 或 定时轮询
webhook 收到通知 → check_meetings.py 拉取会议
    ↓
写入 schedule.json → SIGHUP scheduler
    ↓
scheduler 等待到时间
    ├── T-5min → 系统通知提醒
    └── T+0min → 弹窗询问录制
                      ↓ 点击"开始录制"
                 音频录制（SoX 双路）
                      ↓ 静默检测 / 手动停止
                 Whisper 转录
                      ↓
                 LLM 纪要 → 多渠道发送
```

## 手动命令

```bash
# 日历
check_meetings.py today          # 今天会议
check_meetings.py upcoming       # 未来 24h
check_meetings.py week           # 未来 7 天
check_meetings.py week --json    # JSON 格式

# 会议检测
meeting_detector.py once         # 手动检测
meeting_detector.py daemon       # 守护模式

# 录制
meeting_daemon.py ask_record "标题" "ID"
record_audio.py start "标题"

# 转录
transcribe.py ~/path/to/recording.wav
```

## macOS 辅助功能

部分功能需要辅助功能权限：

| 功能 | 需要授权的程序 |
|------|--------------|
| 窗口标题检测（会议检测器） | `meeting-assistant/scripts/window_scanner` |
| 系统级别窗口扫描 | 同上 |

**安装脚本会自动触发权限弹窗**。如果手动配置，运行：
```bash
open path/to/window_scanner
# 在弹出的对话框中点击「允许」
```

## 注意事项

- **录制依赖 BlackHole 多输出设备**，配置不正确会录不到系统声音
- **Google Calendar push notification 7 天过期**，重启时会自动重新注册
- **cloudflared 快速隧道每次启动 URL 会变**，脚本会在检测到新 URL 时自动重新注册
- **非日历 app 检测（微信通话等）** 工作在无日历配置时也能独立运行，通过窗口标题关键词匹配
- 需要 Python 3.11+（推荐 3.14）

## License

MIT
