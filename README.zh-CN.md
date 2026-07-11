<div align="center">
  <img src="assets/logo.svg" width="120" alt="Yulu logo" />
  <h1>Yulu</h1>
  <p><b>本地会议，Agent 原生纪要。</b></p>
  <a href="https://github.com/Nowhitestar/Yulu/stargazers"><img src="https://img.shields.io/github/stars/Nowhitestar/Yulu?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/Nowhitestar/Yulu/releases"><img src="https://img.shields.io/github/v/tag/Nowhitestar/Yulu?label=version&style=flat-square" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License"></a>
  <a href="#"><img src="https://img.shields.io/badge/macOS-13%2B-black?style=flat-square&logo=apple" alt="macOS 13+"></a>
  <p><a href="README.md">English</a> · <b>简体中文</b></p>
</div>

## 为什么叫 Yulu

Yulu（语录，*yǔ lù*）出自《论语》《传习录》《朱子语类》——中文里"把发言原原本本记下来"的最古老体裁。两千五百年前孔子的弟子做的事，今天我们还在重复：开了一个重要的会，事后才发现没有人写下来。

Yulu 是一个围绕本地 Agent 设计的 macOS 会议记录工具。它原生录制会议，把每次录音持久化为可恢复、可审计的本地任务，再把转写、总结和经明确授权的 Notion 投递交给 Hermes。Agent Console 可以另选 Codex CLI、Claude Code、Hermes、OpenClaw 或自定义 Agent 来处理对话及其自己的连接器。

**不需要虚拟声卡，也不需要 Yulu 账号**。录音文件和任务状态留在本机；自动处理会把音频交给 Hermes，是否使用外部服务取决于 Hermes 自己的配置。Yulu 不代替 Hermes 保存连接器凭据，也不会把「Agent 说完成了」当作任务完成的证据。

跟 Otter / Granola / Fireflies 比：

- **系统音频原生录制**：用 macOS 13+ 的 `ScreenCaptureKit`，**不需要 BlackHole 或多输出设备**。
- **智能能力归 Agent**：Hermes 负责录音转写、总结和明确授权的 Notion 投递；Yulu 不再维护另一套模型、STT 或 connector runtime。
- **Agent Console 是默认工作台**：开始录制、最近三天任务状态、问会议、底层 Agent 切换、当前能力都在一个界面里完成。
- **任务状态真正持久化**：Host 用 SQLite 保存任务、租约、事件、产物哈希和投递结果；进程重启后可以恢复，也能区分录音、Agent、产物提交和外部投递分别在哪里失败。
- **连接能力跟着 Agent 走**：录音产物发送到 Notion 时使用 Hermes 自己的 connector；其它交互式连接器动作由 Agent Console 当前选中的 Agent 负责。凭据始终留在 Agent 侧。
- **半双工混音**：对方说话时优先录系统音频，系统静音时切到麦克风，远端发言始终清晰。
- **本地 Web UI 在 `http://127.0.0.1:7777/agent-console`**：Agent Console、录音、模板、术语表、设置、健康状态都在这里。参见 [docs/yulu_ui.md](docs/yulu_ui.md)。

## 看一眼

<p align="center">
  <img src="assets/demos/agent-console-desktop.png" alt="Yulu Agent Console 桌面版" />
</p>

<table>
<tr>
  <td align="center" width="50%">
    <img src="assets/demos/agent-console-mobile.png" alt="Yulu Agent Console 窄屏布局" />
    <br><b>Agent Console 适配窄屏</b>
    <br><sub>录制、问会议、session 历史、能力面板会在窄屏下自然折叠。</sub>
  </td>
  <td align="center" width="50%">
    <b>Console 里有什么</b>
    <br><sub>最近三天任务保留完整状态；问会议会创建可恢复的 Agent session；当前能力展示通用 Agent、Hermes 录音处理、模板、连接器提示和本地 Host 健康状态。</sub>
  </td>
</tr>
</table>

## 快速安装

正式 Release 目前要求 Apple Silicon（arm64）和 macOS 13 或更高版本；installer
会在下载 arm64 资产前拒绝 Intel-only Mac。
同时需要 Python 3.10 或更高版本；安装器会在下载资产前明确检查。

默认安装最新稳定版：

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash
```

安装指定版本：

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --version <tag>
```

开发通道：

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --dev
```

默认安装会把最新稳定版 GitHub Release assets 下载到 `~/.yulu`，不是 clone `main`。`--version` 只影响这一次安装，`--dev` 才使用开发通道。

安装脚本会做：

1. 检查 macOS 13+、Xcode CLI Tools、Homebrew、Python 3。
2. 把选定的 Yulu runtime 安装到 `~/.yulu/`（路径固定，别移走）。
3. 安装本地 Host 与音频/通知所需的 Homebrew 包，包括兼容的 `node@24`（已有 Node 20/22/24 时复用）、`sox`、`ffmpeg` 和 `terminal-notifier`。
4. 写用户级配置到 `~/.config/yulu/config.json`，建录音目录 `~/Movies/Yulu/`。
5. 编译窗口扫描器，引导授权"辅助功能"。
6. 编译并签名 `Yulu.app`，引导授权"麦克风"和"屏幕与系统音频录制"。
7. 不安装 Yulu 自己的语音模型；自动录音处理和语音输入要求 LaunchAgent 的 PATH 中已有可用 Hermes CLI。
8. 引导选择 Agent Console 的通用 Agent provider；这不会改变录音任务固定使用 Hermes 的边界。
9. （可选）通过 `gog` 配置 Yulu 自己的日历调度。
10. 安装本地 Host、原生录音、菜单栏、调度和检测等 LaunchAgent。
11. 把 `yulu` CLI 装到 `~/.local/bin/yulu`，并注册带 bearer token 的本地 MCP。
12. （可选）安装 **Yulu agent skill**，让支持的 Agent 用自然语言驱动 Yulu。
13. 跑一遍安装与原生录音冒烟测试；再用 `yulu doctor --json` 验证 Hermes 管线依赖。

装完之后**确保 `~/.local/bin` 在 PATH 里**（一般 zsh 默认没加）：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && exec zsh
```

### 升级

升级到最新稳定版：

```bash
yulu update
```

升级到指定版本：

```bash
yulu update --version <tag>
```

升级到开发通道：

```bash
yulu update --dev
```

稳定版和指定版本升级会校验 GitHub Release 的 `checksums.txt`，再以用户权限原子替换 `~/.yulu/` 中的 runtime zip；zip 内的 app bundle 已签名、公证并 stapled。`package-pkg` 目前只用于本地诊断：仓库尚未配置 Developer ID Installer 证书，因此正式 Release 不发布未签名 pkg。`--dev` 则从 `main` 安装或更新。之后都会跑幂等升级流程；已有 TCC 授权和录音会保留。

升级旧 runtime 时，Yulu 会归档旧推理/connector 配置与遗留队列，但不会自动重放历史 Agent 任务；仍需处理的录音可在当前 UI 中手动 reprocess。已退役服务会被卸载，避免两条处理链同时运行。

如果当前安装是 v0.17.x，其内置 updater 只认识旧 pkg 资产。请先执行一次下面的 bridge 命令切换到 zip updater：

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash
```

从 v0.18 开始，内置 helper 已支持 zip release。为了保持版本 pin 和供应链边界，`yulu update` 不会自动下载并执行 `main` 上可变的 installer；未来若再次变更资产格式，会提供新的显式 bridge。

`--version` 只影响这一次操作；下一次直接跑 `yulu update` 会回到最新稳定版。

### 卸载

```bash
yulu uninstall
```

停服务、删 LaunchAgent、删 CLI。**默认保留**录音、配置、agent skill —— 脚本会一项一项问你要不要删。macOS TCC 条目和 Homebrew 包不会动（其他 app 可能在用），脚本最后会列出手动清理的步骤。

### `yulu` CLI

| 命令 | 作用 |
|---|---|
| `yulu setup` | 重新跑安装脚本（fresh install） |
| `yulu update [--version vX.Y.Z \| --dev]` | 用最新稳定版 release assets、指定版本或开发通道升级 |
| `yulu start` / `stop` / `restart` | 控制已安装的 Yulu LaunchAgent |
| `yulu version` | 输出 Yulu 版本、git commit、tag 和 dirty 状态 |
| `yulu status` | 查看服务、原生录音 socket、最近录音和 Host 健康 |
| `yulu doctor [--json]` | 只读检查原生录音、Host 任务、Hermes 和日历健康 |
| `yulu logs [name]` | tail 日志（默认 `audio_daemon`） |
| `yulu record start "<title>"` / `yulu record stop` | 手动录音；停止后把完成事件交给持久化 Host 管线 |
| `yulu dictate start\|stop\|once\|toggle\|ask` | 原生麦克风录音，由 Hermes 转写；`ask` 会继续进入 Agent Console |
| `yulu search "<query>"` | 搜索本地转录与纪要 |
| `yulu mcp status\|install\|remove\|rotate-token\|test` | 管理带认证的本地 MCP 注册 |
| `yulu skill install [--agent <name>]` | 安装或刷新面向 Agent 的 Yulu skill |
| `yulu where` | 列出所有相关磁盘路径 |
| `yulu uninstall` | 见上 |

### 在 Coding Agent 里用 Yulu

仓库里 [`skills/yulu/`](skills/yulu/SKILL.md) 下有一份 `SKILL.md`，告诉 Claude Code、OpenClaw、Codex、Cursor 等[共 50+ 个 vercel-labs/skills 支持的 agent](https://github.com/vercel-labs/skills#supported-agents) 怎么调用 Yulu。注册之后，可以直接说：

- "开始录制，标题就叫 Yulu 周会"
- "停止录制并出个纪要"
- "上周二的 standup 我们聊了什么？"

核心 `setup.sh` 不会注册 Agent skill。安装完成后请按目标 Agent 独立安装或刷新：

```bash
# 推荐：使用 Yulu CLI
yulu skill install --agent claude-code
yulu skill install --agent codex

# 或直接使用 skills CLI 装到全局
npx skills add Nowhitestar/Yulu -g -a claude-code -y
npx skills add Nowhitestar/Yulu -g -a codex -y

# 或者装本地 clone
npx skills add . -g -a claude-code -y
```

skill 只是一份契约——告诉 Agent Yulu 通过 MCP 暴露了哪些录音、历史、搜索和任务动词。Yulu 的 macOS app、本地 Host、LaunchAgent 和 Hermes 能力仍要靠 `setup.sh` 安装并验证。**单装 skill 不会录音，也不会创建可用的转写管线**。

## 工作原理

```text
Agent Console
          ↓
 通用 Agent provider
          ↓
 Codex CLI / Claude Code / Hermes / OpenClaw sessions
          ↓
 问会议历史 · 交互式对话 · 该 Agent 自己的连接器

日历 / 窗口检测器 / 菜单栏 / CLI / MCP
          ↓
 schedule.json  ──►  scheduler_daemon.py
          ↓
 meeting_daemon.py  ──►  notify.py 弹窗："开始录吗？"
          ↓
 record_audio.py  ──►  Yulu.app  (Unix socket)
          ↓
 ScreenCaptureKit (系统音频) + AVFoundation (麦克风)
          ↓
 本地 WAV  ──►  带认证的本地 Host
          ↓
 host.sqlite 持久化任务 + 租约 + 审计事件
          ↓
 Hermes 转写 + 总结  ──►  Host 原子提交 transcript.txt + summary.md
          ↓（任务明确授权时）
 Hermes Notion connector  ──►  Host 记录页面 URL / ID
```

几个值得记住的数字：
- WAV：16-bit 立体声 48 kHz。
- ScreenCaptureKit Float32 planar → 交错立体声 Int16。
- 半双工 crossfade 触发阈值：默认 `silence_threshold=0.01`。
- Bundle id：`com.yulu.audiodaemon`（Apple Developer 证书签名，无证书则回退到 ad-hoc）。
- Host 状态库：`~/.config/yulu/host.sqlite`。
- Host 临时不可用时，完成事件原子暂存在 `~/.config/yulu/recording-events/`，恢复后重放且不会重复创建同一个自动任务。

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
    "output_dir": "~/Movies/Yulu",
    "silence_threshold": 0.01,
    "silence_duration_sec": 300,
    "half_duplex": true
  },
  "transcription": {
    "language": "zh"
  },
  "agent_pipeline": {
    "enabled": true,
    "auto_process_recordings": true,
    "auto_send_notion": false,
    "notion_destination": "Yulu Meeting",
    "hermes_serve_port": 0,
    "transcription_chunk_sec": 1200
  },
  "llm": {
    "enabled": true,
    "command": null,
    "agent": {
      "provider": "hermes"
    }
  },
  "agent_console": {
    "plugins": {
      "added": ["summary"]
    }
  }
}
```

- `audio.backend = "daemon"` 是受支持的原生录音路径；`output_dir` 同时是 Host 接受完成录音的安全边界。
- `agent_pipeline` 只控制持久化任务、自动处理和 Notion 授权，不选择模型或保存 connector 凭据。
- `auto_send_notion = true` 是真实外部副作用授权。每个录音任务都会限制 Hermes 的工具集；未授权任务没有 Notion 或其它 connector 的可调用能力。Hermes 只有在转录和纪要一起提交后，才能向 Host 申请投递。
- `transcription` 只保留语言和听写交互上下文；Yulu 不再配置或运行语音模型。
- `llm.agent.provider` / `llm.command` 选择 Agent Console 的通用 Agent。无论这里选什么，录音处理和语音输入仍固定使用 Hermes。
- `agent_console.plugins.added` 只是能力展示过滤。连接器凭据、OAuth 和实际配置属于 Agent，不进入 Yulu 配置。

完整配置参考：[`docs/configuration.md`](docs/configuration.md)。
手动命令和排障：[`docs/operations.md`](docs/operations.md)。

## 设计理念

几个**不能让步**的设计决定，贡献代码前请先理解：

- **不依赖虚拟声卡**。`ScreenCaptureKit` 是 macOS 13 专门为"系统音频不需要驱动 hack"加的 API；Yulu 拒绝回退到 BlackHole——装一次的麻烦才是这个项目存在的理由。
- **录音永远先问**。检测可以错，知情同意不能错。每一次录制都走 `notify.py` 真的弹一次窗。
- **Agent 是智能层**。Yulu 负责本地捕获、权限、持久化任务、租约、产物提交和审计；Hermes 负责录音转写、总结和明确授权的 Notion 投递；通用 Agent 负责对话和自己的连接器。Yulu 不重复实现这些能力。
- **完成必须有可验证证据**。任务状态、事件、产物哈希和投递结果写入 `host.sqlite`；Agent 文本声称“已完成”不等于 Host 完成。外部投递结果不确定时进入 `delivery_unverified`，不会盲目重试。
- **产物成对提交**。Hermes 先在任务私有目录生成 `transcript.txt` 和 `summary.md`，Host 校验后一起原子写回录音目录；只出现其中一个不算成功。
- **TCC 权限只挂在一个 binary 上**。整个系统里只有 `Yulu.app` 持有麦克风和屏幕录制权限；Python 代码只能通过 Unix socket 跟它说话，绕不开 macOS 的隐私墙。

## 故事

我每周开很多会——内部 review、客户电话、需要回头听一遍的演讲录音。Granola 不录系统音频；Otter 必须联网而且中文很差；每一篇"装个 BlackHole 就好"的教程，最后都让我有两个输出设备、连不上蓝牙耳机、电话另一头的朋友一脸困惑。

于是自己写。第一版是 200 行 sox 加上一句祈祷。你现在看到的这版用 `ScreenCaptureKit`、内联做半双工混音，再把录音交给已经在使用的 Hermes 完成转写和纪要——这些事情发生在我开下一个会的时候。**Yulu**（语录）这个名字就是承诺：每一段对话，都该落到一个你以后愿意再读一遍的地方。

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
        ├── meeting_daemon.py             # 录音工作流 + Host 完成事件交付/暂存
        ├── scheduler_daemon.py           # 基于日历的调度器
        ├── meeting_detector.py           # 基于窗口的会议检测器
        ├── window_scanner.swift          # 辅助功能窗口扫描
        ├── recorder_status.swift         # 录制状态浮窗
        ├── dictate.py                    # 麦克风录音 + 带认证的 Hermes 转写入口
        ├── notify.py                     # macOS 通知和弹窗
        ├── prompts/                      # 本地提示词目录和上下文
        ├── yulu_ui/                      # TypeScript Host、持久化管线和 Web UI
        │   └── src/
        │       ├── hostStore.ts          # 任务、租约、事件和投递状态
        │       ├── recordingPipeline.ts  # Hermes 录音任务协调器
        │       ├── agentGateway.ts       # Hermes 会话和工具调用审计
        │       └── artifactStore.ts      # 成对校验并原子提交产物
        └── com.yulu.*.plist              # LaunchAgent 定义
```

装完之后磁盘上的状态：

| 路径 | 内容 |
|---|---|
| `~/.yulu/` | 从 release assets 或开发通道安装的运行时 |
| `~/.config/yulu/config.json` | 用户配置 |
| `~/.config/yulu/audio_daemon.sock` | daemon 暴露的 Unix socket |
| `~/.config/yulu/host.sqlite` | 持久化任务、租约、事件、产物和投递审计 |
| `~/.config/yulu/agent-tasks/` | Hermes 的任务私有 staging 目录 |
| `~/.config/yulu/recording-events/` | Host 暂时不可用时的录音完成事件 |
| `~/.config/yulu/mcp-token.json` | 本地 Host / MCP bearer token，必须保密 |
| `~/Movies/Yulu/` | 你的会议录音 + 转录 + 纪要 |
| `~/Library/LaunchAgents/com.yulu.*.plist` | 已安装的后台服务 |
| `~/.local/bin/yulu` | CLI symlink |

## 支持

- 觉得 Yulu 有用，请给个 star 或者分享出去。
- 想法、bug、奇怪的会议场景：开 issue 或 PR。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全披露：请发邮件，不要开公开 issue。

## License

MIT。详见 [LICENSE](LICENSE)。

Hermes、`ScreenCaptureKit`、`AVFoundation`、`terminal-notifier`、`cloudflared`、`gog` 各自保留原 license。
