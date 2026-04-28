---
name: meeting-assistant
description: "会议助手：自动识别日历会议、系统通知提醒、可选录制、静默检测自动停止、生成纪要并发送。支持飞书/Google日历，输出到本地/Zulip/Notion/Telegram。Use when: (1) 需要自动提醒即将开始的会议，(2) 需要录制会议音频并转录，(3) 需要自动生成会议纪要，(4) 会议管理自动化。"
---

# Meeting Assistant - 会议助手

自动化的会议全流程助手：从日历识别、系统通知提醒、可选录制、静默检测到纪要输出。

## 核心功能

1. **每日调度** — 每天早上扫描当天日历，设定提醒计划
2. **系统通知** — T-5min 弹提醒，T-0min 弹窗询问是否录制
3. **可选录制** — 用户确认后才录制，避免录不需要的会议
4. **静默检测** — 连续5分钟无声音自动提示停止
5. **自动转录** — Whisper 转录音频
6. **纪要生成** — LLM 生成结构化纪要（待办、决策、讨论要点）
7. **多渠道输出** — 支持本地文件/Zulip/Notion/Telegram

## 工作流程

```
每天早上8点
    │
    ▼
┌─────────────┐
│  schedule   │──扫描当天日历──▶ 保存到 schedule.json
└─────────────┘
    │
    ▼
每分钟 check
    │
    ├── T-5min ──▶ 系统通知: "⏰ 5分钟后有会"
    │
    └── T-0min ──▶ 系统弹窗: "会议开始了 [开始录制] [忽略]"
                        │
            ┌───────────┴───────────┐
            │                       │
        点击"开始录制"          点击"忽略"
            │                       │
            ▼                       ▼
      ┌──────────┐            标记为跳过
      │  ffmpeg  │
      │  录制中  │
      └────┬─────┘
           │
    ┌──────┴──────┐
    │  静默检测    │──每10秒检查音量──▶ 连续5分钟静默?
    └─────────────┘                              │
                                 是 ──▶ 弹窗"是否停止? [停止] [继续]"
                                                    │
                                              点击"停止"
                                                    │
                                                    ▼
                                           ┌─────────────┐
                                           │  停止录制    │
                                           │  Whisper转录 │
                                           │  LLM生成纪要 │
                                           │  发送到频道  │
                                           └─────────────┘
```

## 快速开始

### 1. 安装依赖

```bash
# macOS 音频录制
brew install blackhole-2ch ffmpeg terminal-notifier

# Python 依赖
pip install openai-whisper openai notion-client

# macOS 启用 at 命令（如使用系统 at）
sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.atrun.plist
```

### 2. 配置音频

1. 打开 **音频 MIDI 设置** → 创建**多输出设备**
2. 勾选 **BlackHole 2ch** + 你的实际输出设备
3. 设为系统默认输出
4. 验证设备索引：`ffmpeg -f avfoundation -list_devices true -i ""`

### 3. 创建配置文件

```bash
mkdir -p ~/.config/meeting-assistant
cp scripts/config.example.json ~/.config/meeting-assistant/config.json
# 编辑 config.json
```

### 4. 设置环境变量

```bash
export OPENAI_API_KEY="sk-..."
export FEISHU_APP_ID="cli_..."
export FEISHU_APP_SECRET="..."
```

### 5. 配置 Cron

```bash
# 每天早上8点扫描当天日历设定提醒
openclaw cron add --name "meeting-schedule" --schedule "0 8 * * *" \
  --command "python3 scripts/meeting_daemon.py schedule"

# 每分钟检查是否有到时间的提醒
openclaw cron add --name "meeting-check" --schedule "* * * * *" \
  --command "python3 scripts/meeting_daemon.py check"
```

## 脚本说明

| 脚本 | 用途 |
|------|------|
| `meeting_daemon.py schedule` | 每天早上运行，扫描日历设定提醒 |
| `meeting_daemon.py check` | 每分钟运行，触发提醒/录制询问 |
| `meeting_daemon.py stop` | 手动停止录制并生成纪要 |
| `notify.py` | macOS 系统通知（提醒/询问/确认） |
| `record_audio.py start/stop/monitor` | 录制/停止/静默检测 |
| `transcribe.py` | 转录 + 生成纪要 |
| `send_summary.py` | 发送纪要到频道 |
| `check_meetings.py` | 查询日历会议 |

## 手动使用

### 测试通知

```bash
# 测试5分钟提醒
python3 scripts/notify.py remind "Meeting Assistant" "测试提醒" "项目周会"

# 测试录制询问
python3 scripts/notify.py ask_record "项目周会"
```

### 仅录制当前会议

```bash
# 开始录制
python3 scripts/record_audio.py start "临时会议"

# ... 会议中 ...

# 停止并自动生成纪要
python3 scripts/meeting_daemon.py stop
```

## 配置说明

### 飞书日历

需要创建飞书应用并开启以下权限：
- `calendar:calendar:readonly`
- `calendar:calendar.event:readonly`

### Google Calendar

1. Google Cloud Console → 创建 OAuth 应用
2. 下载 `credentials.json`
3. 首次运行会引导 OAuth 授权

### Notion 输出

1. 创建 Notion Integration
2. 创建数据库（字段：Name, Status）
3. 将 Integration 添加到数据库页面
4. 配置 `database_id`

## 常见问题

**Q: 弹窗通知不显示？**
A: 检查 terminal-notifier 是否安装：`which terminal-notifier`。如未安装：`brew install terminal-notifier`。

**Q: 录制没有声音？**
A: 检查 BlackHole 多输出设备是否正确配置，ffmpeg 设备索引是否匹配 config。

**Q: 静默检测不准确？**
A: 调整 `config.json` 中的 `silence_threshold`（默认 0.01）和 `silence_duration_sec`（默认 300）。

**Q: 转录质量差？**
A: 切换到本地 whisper（`"mode": "local"`），或使用更大的模型。

## 依赖

- Python 3.8+
- ffmpeg
- terminal-notifier (macOS)
- BlackHole 2ch (macOS)
- openai (Whisper API / LLM)
- openai-whisper (optional, 本地转录)
- notion-client (optional, Notion 输出)
