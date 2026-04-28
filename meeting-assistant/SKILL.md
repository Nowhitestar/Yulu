---
name: meeting-assistant
description: "会议助手：自动识别日历会议、提醒、录制音频、生成纪要并发送。支持飞书日历和 Google Calendar，输出到 Zulip 或 Notion。Use when: (1) 需要自动提醒即将开始的会议，(2) 需要录制会议音频并转录，(3) 需要自动生成会议纪要并发送到指定频道，(4) 需要批量处理会议记录。"
---

# Meeting Assistant - 会议助手

自动化的会议全流程助手：从日历识别、提醒、录制、转录到纪要输出。

## 核心功能

1. **日历检查** — 自动检查飞书/Google 日历中的即将开始的会议
2. **智能提醒** — 会议前 5 分钟提醒，会议开始时提醒
3. **音频录制** — 录制麦克风 + 电脑扬声器（支持线上会议）
4. **语音转录** — 使用 Whisper（API 或本地）转录音频
5. **纪要生成** — 自动生成结构化会议纪要（待办、决策、讨论要点）
6. **多渠道输出** — 支持发送到 Zulip 或 Notion

## 工作流程

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  检查日历    │────▶│  提前提醒    │────▶│  开始录制    │
│  (cron)     │     │  (T-5min)   │     │  (会议开始)  │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                                │
┌─────────────┐     ┌─────────────┐     ┌──────▼──────┐
│  发送纪要    │◀────│  生成纪要    │◀────│  停止录制    │
│  (Zulip/   │     │  (Whisper)  │     │  (会议结束)  │
│   Notion)   │     └─────────────┘     └─────────────┘
└─────────────┘
```

## 快速开始

### 1. 安装依赖

```bash
# macOS 音频录制（必须）
brew install blackhole-2ch ffmpeg

# Python 依赖
pip install openai-whisper openai notion-client

# 可选：本地 whisper（质量更好但较慢）
pip install openai-whisper
```

### 2. 配置音频

macOS 需要设置多输出设备以同时录制系统声音和麦克风：

1. 打开 **音频 MIDI 设置**（Applications → Utilities）
2. 点击左下角 `+` → **创建多输出设备**
3. 勾选 **BlackHole 2ch** 和你的实际输出设备（如 MacBook Pro 扬声器）
4. 右键创建的多输出设备 → **将此设备用于声音输出**
5. 在 **系统设置 → 声音 → 输出** 中选择该多输出设备

验证设备索引：
```bash
ffmpeg -f avfoundation -list_devices true -i ""
```

### 3. 创建配置文件

```bash
mkdir -p ~/.config/meeting-assistant
cp scripts/config.example.json ~/.config/meeting-assistant/config.json
```

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
    "output_dir": "~/Downloads/meeting-recordings"
  },
  "transcription": {
    "mode": "api",
    "api_key_env": "OPENAI_API_KEY",
    "language": "zh"
  },
  "output": {
    "channel": "zulip",
    "zulip": {
      "stream": "meetings",
      "topic": "会议纪要"
    }
  }
}
```

### 4. 设置环境变量

```bash
export OPENAI_API_KEY="sk-..."
export NOTION_API_KEY="secret_..."  # 如果使用 Notion
```

### 5. 配置 Cron

使用 OpenClaw 的 cron 功能定期检查会议：

```bash
# 每 2 分钟检查一次即将开始的会议
openclaw cron add \
  --name "meeting-check" \
  --schedule "*/2 * * * *" \
  --command "python3 ~/.openclaw/skills/meeting-assistant/scripts/meeting_daemon.py check"
```

## 脚本说明

| 脚本 | 用途 | 调用方式 |
|------|------|----------|
| `check_meetings.py` | 检查日历事件 | 被 daemon 调用 |
| `record_audio.py` | 录制/停止音频 | `record_audio.py start/stop [title]` |
| `meeting_daemon.py` | 主调度脚本 | `meeting_daemon.py check/stop` |
| `transcribe.py` | 转录 + 生成纪要 | `transcribe.py <audio_file>` |
| `send_summary.py` | 发送纪要 | `send_summary.py <summary_file>` |

## 手动使用

### 场景：会议即将开始，自动提醒和录制

```bash
# 1. 检查会议（通常由 cron 自动执行）
python3 scripts/meeting_daemon.py check

# 2. 会议结束后停止录制并生成纪要
python3 scripts/meeting_daemon.py stop
```

### 场景：仅录制当前会议，稍后处理

```bash
# 开始录制
python3 scripts/record_audio.py start "项目周会"

# ... 会议中 ...

# 停止录制
python3 scripts/record_audio.py stop

# 生成纪要（会自动调用转录和总结）
python3 scripts/transcribe.py ~/Downloads/meeting-recordings/项目周会_20260428.wav

# 发送纪要
python3 scripts/send_summary.py ~/Downloads/meeting-recordings/项目周会_20260428.summary.md
```

## 高级配置

### 飞书日历集成

需要配置飞书应用权限（`calendar:calendar:readonly` 等），在 config 中启用即可。

### Google Calendar 集成

1. 在 Google Cloud Console 创建 OAuth 应用
2. 下载 credentials.json 到 `~/.config/gcp/`
3. 首次运行会引导 OAuth 授权

### Notion 输出

1. 创建 Notion Integration，获取 API Key
2. 创建数据库，包含字段：Name, Status, Date
3. 将 Integration 添加到数据库页面
4. 在 config 中配置 database_id

## 常见问题

**Q: 录制没有声音？**
A: 检查 BlackHole 是否正确安装，多输出设备是否包含 BlackHole，且 ffmpeg 设备索引正确。

**Q: 转录质量差？**
A: 尝试切换到本地 whisper（`"mode": "local"`），或使用更大的模型如 `whisper-1`。

**Q: 会议纪要不够详细？**
A: 启用 LLM 总结（配置 `"llm": {"enabled": true}`），需要 OpenAI API Key。

## 依赖

- Python 3.8+
- ffmpeg
- BlackHole (macOS) 或类似虚拟音频设备
- openai (for Whisper API)
- openai-whisper (optional, for local transcription)
- notion-client (optional, for Notion output)
