# Meeting Assistant - 会议助手

自动化的会议全流程助手：从日历识别、系统通知提醒、可选录制、静默检测到纪要输出。

## 功能

- **每日调度** — 每天早上自动扫描当天日历，设定提醒计划
- **系统通知** — 会议前5分钟弹提醒，会议开始时弹窗询问是否录制
- **可选录制** — 用户确认后才录制，避免录不需要的会议
- **静默检测** — 连续5分钟无声音自动提示停止录制
- **语音转录** — 使用 Whisper（API 或本地）转录音频
- **纪要生成** — LLM 自动生成结构化会议纪要
- **多渠道输出** — 支持本地文件 / Zulip / Notion / Telegram

---

## 安装指南（手把手）

### 第一步：安装系统依赖（macOS）

```bash
# 1. 安装 Homebrew（如未安装）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. 安装音频录制工具
brew install blackhole-2ch        # 虚拟音频设备，用于录制系统声音
brew install ffmpeg               # 音频录制
brew install terminal-notifier    # macOS 系统通知

# 3. 验证安装
which ffmpeg
which terminal-notifier
```

### 第二步：配置音频（关键步骤）

BlackHole 用于捕获系统声音（对方说话声），麦克风捕获你的声音。

**设置多输出设备：**

1. 打开 **音频 MIDI 设置**（Applications → Utilities → Audio MIDI Setup）
2. 点击左下角 **+** → 选择 **创建多输出设备**
3. 勾选以下两项：
   - ✅ **BlackHole 2ch**
   - ✅ 你的实际输出设备（如 MacBook Air 扬声器 / 耳机）
4. 右键点击这个多输出设备 → **将此设备用于声音输出**
5. 记录设备编号（后面 config 要用）：
   ```bash
   ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep -E "(BlackHole|Microphone)"
   ```
   输出示例：
   ```
   [0] Built-in Microphone           ← 麦克风通常是 :0
   [1] BlackHole 2ch                 ← BlackHole 通常是 :1
   ```

### 第三步：安装 Python 依赖

```bash
# 建议用虚拟环境
python3 -m venv ~/.venv/meeting-assistant
source ~/.venv/meeting-assistant/bin/activate

# 安装依赖
pip install openai openai-whisper notion-client

# 验证
python3 -c "import openai; print('openai ok')"
python3 -c "import whisper; print('whisper ok')"
```

### 第四步：配置环境变量

```bash
# 添加到 ~/.zshrc 或 ~/.bash_profile

# OpenAI API Key（必须）
export OPENAI_API_KEY="sk-你的-key"

# 飞书应用凭证（如需飞书日历）
export FEISHU_APP_ID="cli_xxxxxxxx"
export FEISHU_APP_SECRET="xxxxxxxx"

# Notion API Key（如需发送到 Notion）
export NOTION_API_KEY="secret_xxxxxxxx"

# 生效
source ~/.zshrc
```

### 第五步：创建配置文件

```bash
# 创建配置目录
mkdir -p ~/.config/meeting-assistant

# 复制示例配置
cp meeting-assistant/scripts/config.example.json ~/.config/meeting-assistant/config.json

# 编辑配置
nano ~/.config/meeting-assistant/config.json
```

**配置详解：**

```json
{
  "calendars": [
    {
      "type": "feishu",
      "enabled": true,
      "app_id_env": "FEISHU_APP_ID",
      "app_secret_env": "FEISHU_APP_SECRET"
    },
    {
      "type": "google",
      "enabled": false,
      "credentials_path": "~/.config/gcp/calendar-credentials.json"
    }
  ],
  "audio": {
    "mic_device": ":0",
    "system_audio_device": ":1",
    "output_dir": "~/Downloads/meeting-recordings",
    "silence_threshold": 0.01,
    "silence_duration_sec": 300
  },
  "transcription": {
    "mode": "api",
    "api_key_env": "OPENAI_API_KEY",
    "language": "zh",
    "model": "whisper-1"
  },
  "llm": {
    "enabled": true,
    "provider": "openai",
    "model": "gpt-4",
    "api_key_env": "OPENAI_API_KEY"
  },
  "output": {
    "channel": "file",
    "zulip": {
      "stream": "meetings",
      "topic": "会议纪要"
    },
    "notion": {
      "api_key_env": "NOTION_API_KEY",
      "database_id": "your-database-id"
    },
    "telegram": {
      "chat_id": ""
    }
  }
}
```

**关键字段说明：**

| 字段 | 说明 | 示例 |
|------|------|------|
| `audio.mic_device` | 麦克风设备索引 | `:0` |
| `audio.system_audio_device` | 系统音频（BlackHole） | `:1` |
| `transcription.mode` | `api` 或 `local` | `api` |
| `llm.enabled` | 是否用 LLM 生成纪要 | `true` |
| `output.channel` | 输出目标 | `file` / `zulip` / `notion` / `telegram` |

### 第六步：配置飞书日历（可选）

1. 登录 [飞书开放平台](https://open.feishu.cn/)
2. 创建企业自建应用
3. 开启权限：
   - `calendar:calendar:readonly`
   - `calendar:calendar.event:readonly`
   - `calendar:calendar.event:search`
4. 发布应用并获取 **App ID** 和 **App Secret**
5. 在飞书后台把应用添加到需要读取日历的成员

### 第七步：配置 Google 日历（可选）

1. [Google Cloud Console](https://console.cloud.google.com/) → 创建项目
2. 启用 Google Calendar API
3. 创建 OAuth 2.0 客户端 ID（桌面应用类型）
4. 下载 JSON 凭证，保存到 `~/.config/gcp/calendar-credentials.json`
5. 首次运行会自动引导 OAuth 授权

### 第八步：配置 Cron 定时任务

```bash
# 每天早上8点扫描当天日历并设定提醒计划
openclaw cron add \
  --name "meeting-schedule" \
  --schedule "0 8 * * *" \
  --command "python3 meeting-assistant/scripts/meeting_daemon.py schedule"

# 每分钟检查是否有到时间的会议需要提醒/录制
openclaw cron add \
  --name "meeting-check" \
  --schedule "* * * * *" \
  --command "python3 meeting-assistant/scripts/meeting_daemon.py check"
```

---

## 工作流程

```
每天早8点:  schedule ──▶ 扫描日历 ──▶ 保存当天提醒计划
                              │
每分钟:     check ──▶ 检查时间 ──▶ T-5min 弹提醒
                              │
                              └──▶ T-0min 弹窗"录制?" ──▶ 用户点击"开始录制"
                                                            │
                                                            ▼
                                                      ffmpeg 录制 + 静默检测
                                                            │
                              连续5分钟静默 ──▶ 弹窗"停止?" ──▶ 用户点击"停止"
                                                                    │
                                                                    ▼
                                                            自动转录 ──▶ LLM生成纪要 ──▶ 发送
```

---

## 手动使用

```bash
# 查询今天会议
python3 meeting-assistant/scripts/check_meetings.py today

# 手动开始录制
python3 meeting-assistant/scripts/record_audio.py start "项目周会"

# 手动停止并自动生成纪要
python3 meeting-assistant/scripts/meeting_daemon.py stop

# 转录指定音频文件
python3 meeting-assistant/scripts/transcribe.py ~/Downloads/meeting-recordings/xxx.wav

# 发送纪要到配置的目标
python3 meeting-assistant/scripts/send_summary.py ~/Downloads/meeting-recordings/xxx.summary.md
```

---

## 输出配置详解

### 本地文件（默认）
无需额外配置，纪要保存在 `~/Downloads/meeting-recordings/`

### Zulip
```json
"output": {
  "channel": "zulip",
  "zulip": {
    "stream": "meetings",
    "topic": "会议纪要"
  }
}
```
需配置 `~/.zuliprc` 或提供 API key。

### Notion
```json
"output": {
  "channel": "notion",
  "notion": {
    "api_key_env": "NOTION_API_KEY",
    "database_id": "your-database-id"
  }
}
```
数据库需要包含：`Name`（标题）、`Status`（状态）字段。

### Telegram
```json
"output": {
  "channel": "telegram",
  "telegram": {
    "chat_id": "your-chat-id"
  }
}
```

---

## 常见问题

**Q: 录制没有声音？**
A: 检查 BlackHole 多输出设备是否正确配置为系统默认输出。运行 `ffmpeg -f avfoundation -list_devices true -i ""` 确认设备索引与 config 一致。

**Q: 系统通知不显示？**
A: 确保 `terminal-notifier` 已安装：`which terminal-notifier`。如未安装：`brew install terminal-notifier`。

**Q: 静默检测不准确？**
A: 调整 `config.json` 中的 `silence_threshold`（默认 0.01）和 `silence_duration_sec`（默认 300）。

**Q: 转录质量差？**
A: 使用本地 whisper 大模型（`"mode": "local", "model": "large"`），或确保音频文件音质清晰。

**Q: 飞书日历读取不到会议？**
A: 确认应用已发布，且已给目标成员授权。检查 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 环境变量是否正确设置。

---

## 仓库结构

```
.
├── README.md
├── meeting-assistant/
│   ├── SKILL.md              # 技能说明文档
│   └── scripts/
│       ├── meeting_daemon.py     # 主调度（schedule/check/stop）
│       ├── notify.py             # macOS 系统通知
│       ├── record_audio.py       # 录制 + 静默检测
│       ├── transcribe.py         # 转录 + LLM 纪要
│       ├── send_summary.py       # 发送纪要
│       ├── check_meetings.py     # 日历查询
│       └── config.example.json   # 配置示例
└── meeting-assistant.skill     # 打包好的技能文件
```

## License

Private
