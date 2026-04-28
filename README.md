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

## 快速开始

```bash
# 1. 安装依赖
brew install blackhole-2ch ffmpeg terminal-notifier
pip install openai-whisper openai notion-client

# 2. 配置音频（macOS）
# 音频 MIDI 设置 → 创建多输出设备 → 勾选 BlackHole + 实际输出 → 设为默认

# 3. 配置
mkdir -p ~/.config/meeting-assistant
cp meeting-assistant/scripts/config.example.json ~/.config/meeting-assistant/config.json
# 编辑 config.json，填入日历和 API 配置

# 4. 设置 API Key
export OPENAI_API_KEY="sk-..."

# 5. 配置 Cron（OpenClaw）
# 每天早上8点设定当天提醒
openclaw cron add --name "meeting-schedule" --schedule "0 8 * * *" \
  --command "python3 meeting-assistant/scripts/meeting_daemon.py schedule"

# 每分钟检查触发
openclaw cron add --name "meeting-check" --schedule "* * * * *" \
  --command "python3 meeting-assistant/scripts/meeting_daemon.py check"
```

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

## 手动使用

```bash
# 查询今天会议
python3 meeting-assistant/scripts/check_meetings.py today

# 手动开始录制
python3 meeting-assistant/scripts/record_audio.py start "项目周会"

# 手动停止并生成纪要
python3 meeting-assistant/scripts/meeting_daemon.py stop

# 转录指定音频
python3 meeting-assistant/scripts/transcribe.py ~/Downloads/meeting-recordings/xxx.wav
```

## 配置说明

编辑 `~/.config/meeting-assistant/config.json`：

```json
{
  "calendars": [
    {"type": "feishu", "enabled": true},
    {"type": "google", "enabled": false}
  ],
  "audio": {
    "mic_device": ":0",
    "system_audio_device": ":1",
    "output_dir": "~/Downloads/meeting-recordings",
    "silence_duration_sec": 300
  },
  "transcription": {
    "mode": "api",
    "api_key_env": "OPENAI_API_KEY",
    "language": "zh"
  },
  "llm": {
    "enabled": false,
    "provider": "openai",
    "model": "gpt-4"
  },
  "output": {
    "channel": "file"
  }
}
```

## 依赖

- Python 3.8+
- ffmpeg
- terminal-notifier (macOS)
- BlackHole 2ch (macOS) — 录制系统音频
- OpenAI API Key — Whisper 转录 / LLM 纪要

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
