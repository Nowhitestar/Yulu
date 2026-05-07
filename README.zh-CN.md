<div align="center">
  <img src="assets/logo.svg" width="120" alt="Yulu logo" />
  <h1>Yulu</h1>
  <p><b>会议在说，它在听。</b></p>
  <a href="https://github.com/Nowhitestar/Yulu/stargazers"><img src="https://img.shields.io/github/stars/Nowhitestar/Yulu?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/Nowhitestar/Yulu/releases"><img src="https://img.shields.io/github/v/tag/Nowhitestar/Yulu?label=version&style=flat-square" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License"></a>
  <a href="#"><img src="https://img.shields.io/badge/macOS-13%2B-black?style=flat-square&logo=apple" alt="macOS 13+"></a>
  <p><a href="README.md">English</a> · <b>简体中文</b></p>
</div>

## 为什么叫 Yulu

Yulu（语录，*yǔ lù*）出自《论语》《传习录》《朱子语类》——中文里"把发言原原本本记下来"的最古老体裁。两千五百年前孔子的弟子做的事，今天我们还在重复：开了一个重要的会，事后才发现没有人写下来。

Yulu 是一个 macOS 原生的会议录制和会议纪要工具。它本地录音、本地转录、再把转录交给你信任的 coding agent（Claude Code、Codex、OpenClaw…）整理成一份干净的会议纪要。**不需要虚拟声卡，不需要云端转录，不需要注册账号**——音频从录到摘都不离开你这台电脑，除非你自己愿意。

跟 Otter / Granola / Fireflies 比：

- **系统音频原生录制**：用 macOS 13+ 的 `ScreenCaptureKit`，**不需要 BlackHole 或多输出设备**。
- **转录完全本地**：`whisper-cli`（whisper.cpp），自己的模型文件，中文质量不输英文。
- **纪要环节是 BYOA**（Bring Your Own Agent）：Yulu 把 `summary_request` 写到 JSON 队列，你信任的 agent 读完转录和模板后写回 `summary.md`。**没有任何一家厂商被硬编码进流程**。
- **半双工混音**：对方说话时优先录系统音频，系统静音时切到麦克风，远端发言始终清晰。

## 看一眼

<table>
<tr>
  <td align="center" width="50%">
    <img src="assets/demos/demo-status-window.png" alt="录制状态浮窗" />
    <br><b>录制状态</b>
    <br><sub>右侧浮窗，带手动停止按钮</sub>
  </td>
  <td align="center" width="50%">
    <img src="assets/demos/demo-summary.png" alt="生成的会议纪要" />
    <br><b>最终纪要</b>
    <br><sub>TL;DR · 议题讨论 · Action Items · 决策</sub>
  </td>
</tr>
<tr>
  <td align="center" width="50%">
    <img src="assets/demos/demo-prompt.png" alt="录制前确认" />
    <br><b>录制前必问</b>
    <br><sub>Yulu 永远先问你"开始录吗"</sub>
  </td>
  <td align="center" width="50%">
    <img src="assets/demos/demo-transcript.png" alt="本地转录" />
    <br><b>本地转录</b>
    <br><sub>whisper-cli 离线运行；中英混排都能出</sub>
  </td>
</tr>
</table>

> Demo 图放在 [`assets/demos/`](assets/demos/)，发布前请把占位图替换成你自己的截图。

## 快速安装

```bash
git clone https://github.com/Nowhitestar/Yulu.git
cd Yulu
bash yulu/scripts/setup.sh
```

安装脚本会引导你完成：

1. 检查 macOS 13+、Homebrew、Python 3。
2. 安装 `sox`、`ffmpeg`、`whisper-cpp`、`terminal-notifier`、`gogcli`、`cloudflared`。
3. 在 `~/.config/yulu/config.json` 写一份用户级配置。
4. 编译窗口扫描器，引导你授权"辅助功能"权限。
5. 编译并签名 `AudioDaemon.app`（默认 ad-hoc 签名，有 Apple Developer 证书会优先用）。
6. 引导你授权"麦克风"和"屏幕与系统音频录制"。
7. （可选）通过 `gog` 配置 Google Calendar。
8. 安装 LaunchAgent 后台服务。
9. 跑一遍冒烟测试。

> `setup.sh` 需要完整仓库文件，**不能 `curl | bash`**。

## 工作原理

```text
Google 日历 / 窗口检测器
          ↓
 schedule.json  ──►  scheduler_daemon.py
          ↓
 meeting_daemon.py  ──►  notify.py 弹窗："开始录吗？"
          ↓
 record_audio.py  ──►  AudioDaemon.app  (Unix socket)
          ↓
 ScreenCaptureKit (系统音频) + AVFoundation (麦克风)
          ↓
 WAV  ──►  transcribe.py  ──►  whisper-cli
          ↓
 transcript.txt  +  summary_request  ──►  agent-queue.json
          ↓
 任意 agent (Claude Code / Codex / OpenClaw…)  ──►  summary.md
```

几个值得记住的数字：
- WAV：16-bit 立体声 48 kHz。
- ScreenCaptureKit Float32 planar → 交错立体声 Int16。
- 半双工 crossfade 触发阈值：默认 `silence_threshold=0.01`。
- 默认 whisper 模型：`ggml-medium.bin`。
- Bundle id：`com.yulu.audiodaemon`（Apple Developer 证书签名，无证书则回退到 ad-hoc）。
- Agent 队列：`~/.config/yulu/agent-queue.json`。

## macOS 权限

| 组件 | 权限 | 用途 |
|---|---|---|
| `AudioDaemon.app` | 麦克风 | 录制本机麦克风 |
| `AudioDaemon.app` | 屏幕与系统音频录制 | 通过 ScreenCaptureKit 捕获系统音频 |
| `window_scanner` | 辅助功能 | 读取窗口标题，检测会议/通话 |

如果系统音频录不到：系统设置 → 隐私与安全性 → **屏幕与系统音频录制** → 启用 `AudioDaemon.app`，然后重启 daemon。

## 配置

路径：`~/.config/yulu/config.json`

```json
{
  "audio": {
    "backend": "daemon",
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

- `audio.backend = "daemon"` 是默认值。`mic_device` / `system_audio_device` 只用于旧版 SoX fallback 路径。
- `llm` 留空就把摘要环节交给 agent 队列。要直接调外部 LLM，把 `llm.command` 设成任意接受 stdin prompt、输出 Markdown 的 CLI（例如 `["claude", "--print", "--model", "claude-opus-4-7"]`）。

完整配置参考：[`docs/configuration.md`](docs/configuration.md)。
手动命令和排障：[`docs/operations.md`](docs/operations.md)。

## 设计理念

几个**不能让步**的设计决定，贡献代码前请先理解：

- **不依赖虚拟声卡**。`ScreenCaptureKit` 是 macOS 13 专门为"系统音频不需要驱动 hack"加的 API；Yulu 拒绝回退到 BlackHole——装一次的麻烦才是这个项目存在的理由。
- **录音永远先问**。检测可以错，知情同意不能错。每一次录制都走 `notify.py` 真的弹一次窗。
- **LLM 是插件不是依赖**。`transcribe.py` 即使没有任何 agent 也能跑出一份可读的 Markdown 摘要——`fallback_summary()` 用正则把转录分桶成"决策 / 待办 / 阻塞 / 议题"，不会留 "TODO: agent will fill this in" 这种占位。
- **状态写在文件里，不在内存里**。`agent-queue.json`、`schedule.json`、本地录音都是磁盘对象。会议中突然断电，最多丢上次 flush 之后的几秒音频，其它都还在。
- **TCC 权限只挂在一个 binary 上**。整个系统里只有 `AudioDaemon.app` 持有麦克风和屏幕录制权限；Python 代码只能通过 Unix socket 跟它说话，绕不开 macOS 的隐私墙。

## 故事

我每周开很多会——内部 review、客户电话、需要回头听一遍的演讲录音。Granola 不录系统音频；Otter 必须联网而且中文很差；每一篇"装个 BlackHole 就好"的教程，最后都让我有两个输出设备、连不上蓝牙耳机、电话另一头的朋友一脸困惑。

于是自己写。第一版是 200 行 sox 加上一句祈祷。你现在看到的这版用 `ScreenCaptureKit`、内联做半双工混音、让本地的 Claude Code agent 把会议纪要写完——这些事情发生在我开下一个会的时候。**Yulu**（语录）这个名字就是承诺：每一段对话，都该落到一个你以后愿意再读一遍的地方。

## 项目结构

```text
Yulu/
├── README.md
├── README.zh-CN.md
├── LICENSE
├── CONTRIBUTING.md
├── CHANGELOG.md
├── docs/
│   ├── configuration.md
│   └── operations.md
├── assets/
│   ├── logo.svg
│   └── demos/
└── yulu/
    ├── SKILL.md                          # Claude / OpenClaw skill manifest
    └── scripts/
        ├── setup.sh                      # 交互式安装脚本
        ├── migrate_to_yulu.sh            # 从旧 meeting-assistant 升级的迁移脚本
        ├── AudioDaemon.app/              # 签名（或 ad-hoc）后的音频 daemon
        ├── audio_daemon.swift            # ScreenCaptureKit + AVFoundation
        ├── build_audio_daemon.sh         # 编译并签名 AudioDaemon
        ├── record_audio.py               # 录音控制
        ├── meeting_daemon.py             # 工作流调度
        ├── scheduler_daemon.py           # 基于日历的调度器
        ├── meeting_detector.py           # 基于窗口的会议检测器
        ├── window_scanner.swift          # 辅助功能窗口扫描
        ├── recorder_status.swift         # 录制状态浮窗
        ├── transcribe.py                 # whisper 转录 + 写 agent 队列
        ├── agent_notify.py               # agent 队列辅助
        ├── notify.py                     # macOS 通知和弹窗
        ├── send_summary.py               # 可选 Telegram / Notion / Zulip 输出
        ├── summary_template.md           # 默认会议纪要模板
        └── com.yulu.*.plist              # LaunchAgent 定义
```

## 从 `meeting-assistant` 升级

如果你装过老版（当时这个项目叫 `meeting-assistant`），重新跑 `setup.sh` 之前先跑迁移脚本：

```bash
bash yulu/scripts/migrate_to_yulu.sh
bash yulu/scripts/setup.sh
```

迁移脚本会把 `~/.config/meeting-assistant/` 移到 `~/.config/yulu/`，并卸载旧的 `com.meetingassistant.*` LaunchAgents。**因为 AudioDaemon 的 bundle id 变了，macOS 会把它当作一个新 app 重新弹麦克风和屏幕录制权限**——这一步无法绕过，是重命名的代价。

## 支持

- 觉得 Yulu 有用，请给个 star 或者分享出去。
- 想法、bug、奇怪的会议场景：开 issue 或 PR。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全披露：请发邮件，不要开公开 issue。

## License

MIT。详见 [LICENSE](LICENSE)。

`whisper.cpp`、`ScreenCaptureKit`、`AVFoundation`、`terminal-notifier`、`cloudflared`、`gog` 各自保留原 license。
