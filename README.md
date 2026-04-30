# Meeting Assistant — 会议全流程自动化

> 运行在 macOS 上，从日历到录制到会议纪要，全链路自动化的会议助手。

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
```

## 前置要求

- macOS（测试于 macOS 14+ / 15+ arm64）
- [Homebrew](https://brew.sh)
- [gog CLI](https://gogcli.sh) — Google Calendar OAuth（`brew install steipete/tap/gogcli`）
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — tunnel（`brew install cloudflared`）
- Python 3.11+
- [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole) — 虚拟音频设备
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — 本地转录（可选）

## 快速开始

### 1. 克隆

```bash
git clone https://github.com/Nowhitestar/meeting-assistant.git
cd meeting-assistant
```

### 2. 安装系统依赖

```bash
# 音频录制
brew install blackhole-2ch sox switchaudio-osx ffmpeg

# 通知
brew install terminal-notifier

# Google Calendar 集成
brew install steipete/tap/gogcli cloudflared
```

### 3. 配置音频（BlackHole）

**创建多输出设备（让系统声音同时到扬声器和 BlackHole）：**

1. 打开 **音频 MIDI 设置**（`应用程序 → 实用工具`）
2. 左下角 **+** → **创建多输出设备**
3. 勾选：✅ **BlackHole 2ch** ✅ 你的扬声器/耳机
4. 右键 → **将此设备用于声音输出**

**找到设备编号：**

```bash
ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep -E "Microphone|BlackHole"
```

示例输出：
```
[0] Built-in Microphone           ← mic_device: ":0"
[1] BlackHole 2ch                 ← system_audio_device: ":1"
```

### 4. 配置 ~/.config/meeting-assistant/config.json

```bash
mkdir -p ~/.config/meeting-assistant
cp meeting-assistant/scripts/config.example.json ~/.config/meeting-assistant/config.json
# 编辑，根据上方设备编号修改 audio.mic_device 和 audio.system_audio_device
```

### 5. 设置 Google Calendar

#### 5a. Google Cloud Console

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)
2. 创建项目或选择已有项目
3. 启用 **Google Calendar API**
4. **凭据 → 创建凭据 → OAuth 客户端 ID** → 选**桌面应用**
5. 下载 JSON，保存到 `~/.config/gcp/client_secret.json`

#### 5b. gog 认证

```bash
gog auth credentials ~/.config/gcp/client_secret.json
gog auth add your.email@example.com --services calendar
```

浏览器会打开，授权完成后就 OK 了。验证：

```bash
gog auth list
# 应该看到 your.email@example.com 和 calendar 服务

# 测试日历读取
gog calendar events your.email@example.com --from "2026-05-01T00:00:00+08:00" --to "2026-05-02T00:00:00+08:00"
```

#### 5c. 更新 config.json

```json
{
  "calendars": [
    {
      "type": "google",
      "enabled": true,
      "gog_account": "your.email@example.com",
      "watch_calendars": ["primary", "shared.calendar@gmail.com"]
    }
  ]
}
```

### 6. 设置云日历（可选）

**使用 cloudflared tunnel（推荐）：**

```bash
# 无需域名——cloudflared 快速隧道会自动分配 trycloudflare.com 子域名
# 但子域名每次重启会变，需要重启后重新注册 Google Calendar watch 频道
# run_calendar_services.py 自动处理这个流程
```

或者你不想要实时推送，也可以只用轮询模式（每小时同步一次），无需 tunnel：

```bash
# 编辑 run_calendar_services.py 注释掉 cloudflared 相关部分
# 或单独运行 scheduler（已配置 LaunchAgent）
```

### 7. 安装 LaunchAgent

```bash
# 复制 plist 文件到 LaunchAgents
cp meeting-assistant/scripts/com.meetingassistant.scheduler.plist ~/Library/LaunchAgents/
cp meeting-assistant/scripts/com.meetingassistant.detector.plist ~/Library/LaunchAgents/
cp meeting-assistant/scripts/com.meetingassistant.calendar.plist ~/Library/LaunchAgents/  # 可选

# 需要编辑 plist 中的路径为你的实际 Python 和脚本路径
# 然后加载：
launchctl load ~/Library/LaunchAgents/com.meetingassistant.scheduler.plist
launchctl load ~/Library/LaunchAgents/com.meetingassistant.detector.plist
launchctl load ~/Library/LaunchAgents/com.meetingassistant.calendar.plist  # 可选
```

### 8. 验证

```bash
# 查看服务是否运行
launchctl list | grep com.meetingassistant

# 手动测试日历同步
python3 meeting-assistant/scripts/check_meetings.py week

# 查看计划事件
cat ~/.config/meeting-assistant/schedule.json

# 查看检测器日志
tail -f ~/.config/meeting-assistant/detector.log
```

## 文件结构

```
meeting-assistant/
├── README.md
├── .gitignore
│
├── scripts/
│   ├── scheduler_daemon.py     # 事件调度器（常驻）
│   ├── meeting_daemon.py       # 会议流程控制
│   ├── meeting_detector.py     # 窗口标题会议检测
│   ├── check_meetings.py       # 日历查询
│   ├── run_calendar_services.py # webhook + tunnel + watch（一站式）
│   ├── webhook_server.py       # (备用) 独立 webhook 服务器
│   ├── record_audio.py         # SoX 双路录制 + 回声消除
│   ├── transcribe.py           # 转录 + LLM 纪要
│   ├── echo_cancel.py          # 半双工回声消除
│   ├── notify.py               # macOS 通知
│   ├── send_summary.py         # 多渠道发送纪要
│   ├── agent_notify.py         # Agent 通知队列
│   ├── recorder_status.swift   # 录制状态浮窗
│   │
│   ├── config.example.json     # 配置文件示例
│   ├── summary_template.md     # 纪要模板
│   │
│   ├── com.meetingassistant.scheduler.plist  # LaunchAgent: 调度器
│   ├── com.meetingassistant.detector.plist   # LaunchAgent: 检测器
│   ├── com.meetingassistant.calendar.plist   # LaunchAgent: 日历服务
│   └── run_calendar_services.py           # (备用) LaunchAgent 模板
│
└── SKILL.md
```

## 配置项说明

### config.json

| 路径 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `calendars[].type` | `"feishu"` / `"google"` | — | 日历后端 |
| `calendars[].enabled` | bool | `false` | 启用 |
| `calendars[].gog_account` | string | — | Google 账号（Google Calendar 必填） |
| `calendars[].watch_calendars` | string[] | `["primary"]` | 需要推送监听的日历 ID |
| `audio.mic_device` | string | `":0"` | 麦克风 ffmpeg 设备号 |
| `audio.system_audio_device` | string | `":1"` | BlackHole 设备号 |
| `audio.output_dir` | string | `"~/Downloads/meeting-recordings"` | 录制文件目录 |
| `audio.silence_threshold` | float | `0.01` | 静默阈值 |
| `audio.silence_duration_sec` | int | `300` | (5min) 静默多久提示停止 |
| `transcription.mode` | `"local"` / `"api"` | `"local"` | 转录方式 |
| `transcription.local_model_path` | string | — | whisper.cpp 模型路径 |
| `transcription.whisper_cli` | string | `"whisper-cli"` | whisper.cpp 可执行路径 |
| `llm.enabled` | bool | `false` | 启用 LLM 纪要 |
| `llm.model` | string | `"gpt-4"` | LLM 模型 |
| `meeting_detection.interval_sec` | int | `10` | 检测间隔（秒） |
| `meeting_detection.stable_sec` | int | `15` | 稳定检测多久才触发询问 |
| `meeting_detection.prompt_cooldown_sec` | int | `1800` | (30min) 同会议重复询问冷却 |

### environment.json（可选，用于取代 gog keychain）

```bash
# 用于 run_calendar_services.py 手动指定 Google OAuth
export GOG_ACCOUNT="your.email@example.com"
export GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="GOCSPX-xxx"
export GOG_REFRESH_TOKEN="1//xxx"
```

## 工作流程

```
日历变更 (Google Calendar)
    ↓ push notification (实时) 或 定时轮询 (每小时)
webhook 收到通知
    ↓
check_meetings.py 拉取未来 7 天会议
    ↓
写入 schedule.json + SIGHUP → scheduler
    ↓
scheduler 等待到时间
    ├── T-5min → notify.py (系统通知提醒)
    └── T+0min → meeting_daemon.py ask_record (弹窗)
                      ↓ 用户点击"开始录制"
                 record_audio.py (SoX 双路录)
                      ↓ 静默检测触发 / 用户停止
                 transcribe.py (whisper 转录)
                      ↓
                 summary 生成 → 多渠道发送
```

## 手动命令速查

```bash
# 日历
python3 scripts/check_meetings.py today      # 今天会议
python3 scripts/check_meetings.py upcoming   # 未来 24h
python3 scripts/check_meetings.py week       # 未来 7 天
python3 scripts/check_meetings.py week --json  # JSON 格式

# 会议检测
python3 scripts/meeting_detector.py once     # 手动检测
python3 scripts/meeting_detector.py daemon   # 守护模式

# 录制
python3 scripts/meeting_daemon.py ask_record "会议标题" "会议ID"
python3 scripts/record_audio.py start "会议标题"
python3 scripts/record_audio.py status
python3 scripts/meeting_daemon.py stop

# 转录
python3 scripts/transcribe.py ~/path/to/recording.wav
```

## macOS 辅助功能权限

某些功能需要 macOS 辅助功能权限：

| 功能 | 需要授权的程序 |
|------|--------------|
| 窗口标题检测（会议检测器） | Python（`/opt/homebrew/bin/python3`） |
| 控制其他 app（System Events） | Python 或终端模拟器 |

**如何授权：** 系统设置 → 隐私与安全性 → 辅助功能 → **+** → 添加 Python.app

路径参考：`/opt/homebrew/Cellar/python@3.14/3.14.3_1/Frameworks/Python.framework/Versions/3.14/Resources/Python.app`

## 注意事项

- **录制依赖 BlackHole 多输出设备**，配置不正确会录不到系统声音
- **Google Calendar push notification 7 天过期**，run_calendar_services.py 重启时会自动重新注册
- **cloudflared 快速隧道每次启动 URL 会变**，脚本会在检测到新 URL 时自动重新注册 watch 频道
- **Gmail 共享日历可能无法注册推送**，但轮询同步每小时会覆盖
- 需要 Python 3.11+（推荐 3.14）

## License

MIT
