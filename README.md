# Meeting Assistant - 会议助手

自动化的会议全流程助手：从日历识别、提醒、录制、转录到纪要输出。

## 功能

- **日历检查** — 自动检查飞书/Google 日历中的即将开始的会议
- **智能提醒** — 会议前 5 分钟提醒，会议开始时提醒
- **音频录制** — 录制麦克风 + 电脑扬声器（支持线上会议）
- **语音转录** — 使用 Whisper（API 或本地）转录音频
- **纪要生成** — 自动生成结构化会议纪要
- **多渠道输出** — 支持发送到 Zulip 或 Notion

## 快速开始

```bash
# 1. 安装依赖
brew install blackhole-2ch ffmpeg
pip install openai-whisper openai notion-client

# 2. 配置
mkdir -p ~/.config/meeting-assistant
cp meeting-assistant/scripts/config.example.json ~/.config/meeting-assistant/config.json
# 编辑 config.json，填入你的配置

# 3. 设置 API Key
export OPENAI_API_KEY="sk-..."

# 4. 配置 cron 自动检查
openclaw cron add --name "meeting-check" --schedule "*/2 * * * *" \
  --command "python3 meeting-assistant/scripts/meeting_daemon.py check"
```

## 手动使用

```bash
# 开始录制
python3 meeting-assistant/scripts/record_audio.py start "项目周会"

# 结束录制并生成纪要
python3 meeting-assistant/scripts/record_audio.py stop
python3 meeting-assistant/scripts/transcribe.py <音频文件路径>

# 发送纪要
python3 meeting-assistant/scripts/send_summary.py <纪要文件路径>
```

## 配置说明

编辑 `~/.config/meeting-assistant/config.json`：

- `calendars` — 日历源（飞书/Google）
- `audio` — 音频设备配置
- `transcription` — 转录模式（api/local）
- `output` — 输出渠道（zulip/notion）

详见 `meeting-assistant/scripts/config.example.json`

## 依赖

- Python 3.8+
- ffmpeg
- BlackHole (macOS) 或类似虚拟音频设备
- OpenAI API Key（用于 Whisper 转录）

## 仓库结构

```
.
├── README.md
├── meeting-assistant/
│   ├── SKILL.md              # 技能说明文档
│   └── scripts/
│       ├── check_meetings.py     # 检查日历事件
│       ├── record_audio.py       # 录制音频
│       ├── meeting_daemon.py     # 主调度脚本
│       ├── transcribe.py         # 转录 + 生成纪要
│       ├── send_summary.py       # 发送纪要
│       └── config.example.json   # 配置示例
└── meeting-assistant.skill     # 打包好的技能文件
```

## License

Private
