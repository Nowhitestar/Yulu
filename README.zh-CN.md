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

## 快速安装

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash
```

就这一行。安装脚本会做：

1. 检查 macOS 13+、Xcode CLI Tools、Homebrew、Python 3。
2. 把 Yulu clone 到 `~/.yulu/`（路径固定，别移走）。
3. 安装 Homebrew 包：`sox`、`ffmpeg`、`whisper-cpp`、`terminal-notifier`、`gogcli`、`cloudflared`。
4. 写用户级配置到 `~/.config/yulu/config.json`，建录音目录 `~/Movies/Yulu/`。
5. 编译窗口扫描器，引导授权"辅助功能"。
6. 编译并签名 `Yulu.app`，引导授权"麦克风"和"屏幕与系统音频录制"。
7. **下载 `whisper.cpp` 模型文件**（让你选大小，默认 `large-v3-q5_0`，~1.1 GB）。
8. （可选）通过 `gog` 配置 Google Calendar。
9. 安装 4 个 LaunchAgent 后台服务。
10. 把 `yulu` CLI 装到 `~/.local/bin/yulu`。
11. （可选）把 Yulu 注册为 **agent skill**，让 Claude Code / OpenClaw / Codex 等用自然语言驱动 Yulu。
12. 跑一遍冒烟测试。

装完之后**确保 `~/.local/bin` 在 PATH 里**（一般 zsh 默认没加）：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && exec zsh
```

### 升级

```bash
yulu update
```

拉 `~/.yulu/` 最新代码，然后跑 `setup.sh --upgrade` —— 不重弹 TCC、不重做 OAuth、不重下 whisper 模型，已配置过的步骤全部跳过。

### 卸载

```bash
yulu uninstall
```

停服务、删 LaunchAgent、删 CLI。**默认保留**录音、配置、agent skill —— 脚本会一项一项问你要不要删。macOS TCC 条目和 Homebrew 包不会动（其他 app 可能在用），脚本最后会列出手动清理的步骤。

### `yulu` CLI

| 命令 | 作用 |
|---|---|
| `yulu setup` | 重新跑安装脚本（fresh install） |
| `yulu update` | `git pull && setup --upgrade` |
| `yulu start` / `stop` / `restart` | 控制四个 LaunchAgent |
| `yulu status` | 服务健康、daemon socket、最近录音 |
| `yulu logs [name]` | tail 日志（默认 `audio_daemon`） |
| `yulu record start "<title>"` / `yulu record stop` | 手动录音 |
| `yulu where` | 列出所有相关磁盘路径 |
| `yulu uninstall` | 见上 |

### 在 Coding Agent 里用 Yulu

仓库里 [`skills/yulu/`](skills/yulu/SKILL.md) 下有一份 `SKILL.md`，告诉 Claude Code、OpenClaw、Codex、Cursor 等[共 50+ 个 vercel-labs/skills 支持的 agent](https://github.com/vercel-labs/skills#supported-agents) 怎么调用 Yulu。注册之后，可以直接说：

- "开始录制，标题就叫 Yulu 周会"
- "停止录制并出个纪要"
- "上周二的 standup 我们聊了什么？"

`setup.sh` 第 9 步会问要不要装。日后想装或重装：

```bash
# 装到全局，目标 Claude Code + OpenClaw，非交互
npx skills add Nowhitestar/Yulu -g -a claude-code -a openclaw -y

# 或者装本地 clone
npx skills add . -g -a claude-code -y
```

skill 只是一份契约——告诉 agent Yulu 暴露了哪些动词（开始/停止/状态/纪要生成），以及历史会议在磁盘哪里。Yulu 的 macOS app、launchd 服务、whisper.cpp 还是要靠 `setup.sh` 装。**单装 skill 不会录音**。

## 工作原理

```text
Google 日历 / 窗口检测器
          ↓
 schedule.json  ──►  scheduler_daemon.py
          ↓
 meeting_daemon.py  ──►  notify.py 弹窗："开始录吗？"
          ↓
 record_audio.py  ──►  Yulu.app  (Unix socket)
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
- 默认 whisper 模型：`ggml-large-v3-q5_0.bin`（~1.1 GB），存在 `~/.config/yulu/models/`。
- Bundle id：`com.yulu.audiodaemon`（Apple Developer 证书签名，无证书则回退到 ad-hoc）。
- Agent 队列：`~/.config/yulu/agent-queue.json`。

## macOS 权限

| 组件 | 权限 | 用途 |
|---|---|---|
| `Yulu.app` | 麦克风 | 录制本机麦克风 |
| `Yulu.app` | 屏幕与系统音频录制 | 通过 ScreenCaptureKit 捕获系统音频 |
| `window_scanner` | 辅助功能 | 读取窗口标题，检测会议/通话 |

如果系统音频录不到：系统设置 → 隐私与安全性 → **屏幕与系统音频录制** → 启用 `Yulu.app`，然后重启 daemon。

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
    "local_model_path": "~/.config/yulu/models/ggml-large-v3-q5_0.bin",
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
- **TCC 权限只挂在一个 binary 上**。整个系统里只有 `Yulu.app` 持有麦克风和屏幕录制权限；Python 代码只能通过 Unix socket 跟它说话，绕不开 macOS 的隐私墙。

## 故事

我每周开很多会——内部 review、客户电话、需要回头听一遍的演讲录音。Granola 不录系统音频；Otter 必须联网而且中文很差；每一篇"装个 BlackHole 就好"的教程，最后都让我有两个输出设备、连不上蓝牙耳机、电话另一头的朋友一脸困惑。

于是自己写。第一版是 200 行 sox 加上一句祈祷。你现在看到的这版用 `ScreenCaptureKit`、内联做半双工混音、让本地的 Claude Code agent 把会议纪要写完——这些事情发生在我开下一个会的时候。**Yulu**（语录）这个名字就是承诺：每一段对话，都该落到一个你以后愿意再读一遍的地方。

## 项目结构

```text
Yulu/
├── install.sh                            # 一行命令安装入口
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
├── skills/
│   └── yulu/SKILL.md                     # 给 agent 的接口契约（npx skills add 装这个）
└── yulu/
    ├── SKILL.md                          # 项目内部架构 / 开发者文档
    └── scripts/
        ├── setup.sh                      # 交互式安装脚本（重跑用 --upgrade）
        ├── uninstall.sh                  # 被 `yulu uninstall` 调用
        ├── yulu                          # CLI 分发器（symlink 到 ~/.local/bin/yulu）
        ├── Yulu.app/                     # 签名（或 ad-hoc）后的音频 daemon bundle
        ├── audio_daemon.swift            # ScreenCaptureKit + AVFoundation
        ├── build_audio_daemon.sh         # 编译并签名 Yulu.app
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

装完之后磁盘上的状态：

| 路径 | 内容 |
|---|---|
| `~/.yulu/` | repo clone（别移走，`yulu update` 拉这里） |
| `~/.config/yulu/config.json` | 用户配置 |
| `~/.config/yulu/models/ggml-*.bin` | 下载的 whisper.cpp 模型 |
| `~/.config/yulu/audio_daemon.sock` | daemon 暴露的 Unix socket |
| `~/.config/yulu/agent-queue.json` | 给 agent 的待办事件队列 |
| `~/Movies/Yulu/` | 你的会议录音 + 转录 + 纪要 |
| `~/Library/LaunchAgents/com.yulu.*.plist` | 后台服务（4 个 LaunchAgent） |
| `~/.local/bin/yulu` | CLI symlink |

## 支持

- 觉得 Yulu 有用，请给个 star 或者分享出去。
- 想法、bug、奇怪的会议场景：开 issue 或 PR。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全披露：请发邮件，不要开公开 issue。

## License

MIT。详见 [LICENSE](LICENSE)。

`whisper.cpp`、`ScreenCaptureKit`、`AVFoundation`、`terminal-notifier`、`cloudflared`、`gog` 各自保留原 license。
