<div align="center">
  <img src="assets/logo.svg" width="104" alt="Yulu Logo" />
  <h1>Yulu</h1>
  <p><b>原生录制，实时字幕，让每场会议成为 Agent 可用的记忆。</b></p>
  <a href="https://github.com/Nowhitestar/Yulu/stargazers"><img src="https://img.shields.io/github/stars/Nowhitestar/Yulu?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/Nowhitestar/Yulu/releases"><img src="https://img.shields.io/github/v/tag/Nowhitestar/Yulu?label=version&style=flat-square" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/macOS-13%2B-black?style=flat-square&logo=apple" alt="macOS 13+">
  <p><a href="README.md">English</a> · <b>简体中文</b></p>
</div>

Yulu（语录，*yǔ lù*）是一套围绕本地文件和现有 Agent 设计的 macOS
会议工作台。它不需要虚拟声卡就能同时录制系统声音和麦克风，在屏幕上显示可移动的
实时字幕，把会议整理成可搜索的转录与纪要，并让 Agent 继续使用这些历史内容工作。

Yulu 不需要账号。录音文件和任务状态保存在你的 Mac 上。实时字幕、最终转写和听写
使用你明确选择的音频引擎：默认本地，也可通过 Yulu 管理的一次 Grok 兼容 OAuth
或显式提交的 API Key 连接 xAI 云端方案。引擎与凭据来源之间都不会自动切换。

## 现在可以做什么

| 使用场景 | Yulu 提供的能力 |
|---|---|
| 录制会议 | 通过 ScreenCaptureKit 捕获系统声音、通过 AVFoundation 捕获麦克风；支持从 UI、菜单栏、日历/窗口检测、CLI 或 MCP 开始 |
| 查看实时字幕 | 默认在当前活动屏幕中下方显示电影式字幕，可以移动位置，并切换仅原文、双语或仅译文；可选本地 sherpa-onnx Paraformer INT8 模型提供低延时原文 |
| 回看会议 | 在统一资料库里播放录音、查看转录和纪要、管理标签、修正说话人、选择模板和术语表、进行本地搜索 |
| 独立执行每个动作 | 重新转写、重新生成纪要、分享纪要互相独立，可以按需单独重跑 |
| 询问全部会议历史 | Agent Console 把本地会议记录交给你选择的通用 Agent，并使用该 Agent 自己的连接器 |
| 用语音代替输入 | 全局快捷键支持听写、快速翻译，以及把语音问题继续发送到 Agent Console |
| 检查运行状态 | 设置与健康状态页面集中展示权限、主机能力、持久化任务、后台服务、调度器和日志 |

## 当前界面

<p align="center">
  <img src="assets/demos/agent-console-desktop.png" alt="使用蓝色引号 Logo 和新版录音控件的 Yulu Agent Console" />
</p>

Agent Console 是默认工作台。你可以在同一个页面开始或停止录制、查看最近的会议任务、
询问本地会议历史，并检查当前 Agent 已具备的能力。

在 Agent Console 打开「管理 Agents 与 Connectors」，可以切换对话 Agent，并查看该
Agent 中 Notion、Zulip、日历等连接器的状态。Yulu 只展示配置状态、提供该 Agent 的
原生管理命令并保存非密钥目标偏好；连接器凭据和 OAuth 始终留在拥有它的 Agent 中。

<p align="center">
  <img src="assets/demos/recordings-reader.png" alt="包含录音播放、转录阅读和独立处理动作的 Yulu 录音资料库" />
</p>

录音阅读页把原始音频、转录、纪要以及手动操作放在一起。上面两张截图中的会议标题和
转录内容均为演示数据。

## 实时字幕与翻译

开始录制后，Yulu 会在当前活动屏幕的中下方显示纯电影字幕样式的悬浮层。

- 默认只显示原文。可在「设置 → 转写」安装本地模型完成私有字幕与转写，或明确选择 xAI 云端语音转文字；所选引擎负责完整音频链路，不会自动切换。
- 录制过程中可以选择目标语言，并切换仅原文、双语或仅译文。
- 通过左侧浅色六点抓手移动字幕位置。
- 用户正在操作时显示完整录制工具栏；失焦三秒后，工具栏缩成居中的“红点 + 录制中”。
- 鼠标悬浮“录制中”时，红点变为停止方块，文字变为“点击停止”。
- 点击最右侧、上下居中的箭头后，字幕收起为带呼吸效果的 Yulu 蓝色引号 Logo；点击
  Logo 可以重新展开。
- 停止录制后，整个悬浮层从屏幕上消失。

## 快速开始

### 系统要求

- macOS 13 或更高版本。
- 正式 Release 目前支持 Apple Silicon（arm64）。
- Python 3.10 或更高版本。
- 自动生成纪要或投递连接器时，Yulu 的 LaunchAgent 需要能找到可用的 Hermes CLI。
- 转写、听写和实时字幕默认使用本地引擎；也可显式选择 xAI，并直接在 Yulu
  设置中完成 OAuth。两种引擎不会自动切换。
- Agent Console 可选使用 Codex CLI、Claude Code、OpenClaw、Hermes 或自定义命令。

缺少兼容的 Node.js 与必要音频工具时，安装器会自动准备。

### 安装

安装最新稳定版：

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash
```

确保 CLI 已加入 shell 的 PATH：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
exec zsh
```

Yulu 默认安装到 `~/.yulu`，并在设置流程中引导授权三项 macOS 权限：

| 组件 | 权限 | 用途 |
|---|---|---|
| `Yulu.app` | 麦克风 | 录制本机麦克风 |
| `Yulu.app` | 屏幕与系统音频录制 | 通过 ScreenCaptureKit 捕获会议声音 |
| `window_scanner` | 辅助功能 | 检测受支持的会议窗口与标题 |

打开本地工作台：
[`http://127.0.0.1:7777/agent-console`](http://127.0.0.1:7777/agent-console)。
也可以直接从菜单栏或 CLI 开始第一次录音：

```bash
yulu record start "产品周会"
yulu record status
yulu record stop
```

### 安装其它通道

```bash
# 安装指定版本
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --version v0.21.0

# 安装 main 分支，用于本地 dogfood
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --dev
```

### 更新与卸载

```bash
yulu update                    # 最新稳定版
yulu update --version v0.21.0  # 指定版本
yulu update --dev              # 当前 main 分支
yulu uninstall
```

更新会保留配置、录音和 macOS 权限。稳定版更新会先校验 Release 中发布的 checksum，
再替换本机运行时。

## 工作原理

```text
UI / 菜单栏 / 日历 / 窗口检测 / CLI / MCP
                      |
                      v
       Yulu.app 原生系统声音 + 麦克风录制
                      |
          +-----------+-----------+
          |                       |
          v                       v
     实时字幕与翻译             本地 WAV 录音
                                  |
                                  v
                         带认证的本地 Host
                                  |
                         持久化任务 + 租约 + 审计
                                  |
                                  v
                    Yulu 所选音频引擎生成转录
                                  |
                                  v
                       先持久化提交转录文件
                                  |
                                  v
                         Hermes 生成并提交纪要
                                  |
                            可选的授权分享

Agent Console -> 用户选择的通用 Agent -> 该 Agent 自己的连接器
```

这条边界是有意设计的：

- **Yulu** 负责原生录制、系统权限、本地文件、持久化任务、产物提交、恢复和授权边界。
- **Yulu 所选音频引擎** 负责实时字幕、最终转写和听写；默认本地，也可显式选择
  xAI 云端，绝不自动降级或切换。
- **Yulu** 直接管理 xAI OAuth，并把凭据保存在 macOS 钥匙串；音频协议与执行均由 Yulu 负责。
- **Hermes** 负责自动生成纪要，以及经过明确授权的连接器投递。
- **用户选择的通用 Agent** 负责 Agent Console 对话和它自己的连接器。

如果录音结束时 Host 暂时不可用，Yulu 会原子保存完成事件，恢复后再继续处理，并避免
为同一段录音重复创建自动任务。完整说明见[架构文档](docs/ARCHITECTURE.md)。

## CLI 参考

| 命令 | 作用 |
|---|---|
| `yulu status` | 查看服务、录音 socket、当前录音和 UI 健康状态 |
| `yulu doctor [--json]` | 检查权限、Host 任务、搜索和 Agent 能力 |
| `yulu record start "<标题>"` | 开始原生会议录音 |
| `yulu record stop` / `status` | 停止录音或读取当前录音状态 |
| `yulu dictate start\|stop\|once\|toggle\|ask` | 听写、翻译，或把语音问题发送到 Agent Console |
| `yulu status-agent hotkeys` | 查看听写、翻译和语音聊天的全局快捷键 |
| `yulu search "<关键词>"` | 搜索本地转录与纪要 |
| `yulu prompts ...` / `yulu vocab ...` | 管理可复用模板和术语上下文 |
| `yulu mcp status\|install\|remove\|rotate-token\|test` | 管理带认证的本地 MCP 注册 |
| `yulu skill install --agent <名称>` | 为指定 Agent 安装或刷新 Yulu skill |
| `yulu logs [audio_daemon\|ui\|scheduler\|detector\|calendar]` | 持续查看后台日志 |
| `yulu start` / `stop` / `restart` | 控制已安装的后台服务 |
| `yulu where` / `version` | 查看安装路径或版本信息 |

运行 `yulu help` 可以查看完整命令列表。

## 在 Agent 中使用 Yulu

Yulu 通过仅监听本机回环地址、使用 bearer token 认证的 MCP，提供录音控制、会议元数据、
持久化任务状态、本地搜索、模板、术语表、健康检查和产物工作流。

```bash
yulu skill install --agent codex
yulu skill install --agent claude-code
yulu mcp test
```

安装后，可以直接对 Agent 说：

- “开始录制，标题叫产品周会。”
- “上周的会议做了哪些决定？”
- “重新生成这场会议的纪要，然后分享出去。”

只安装 skill 不会安装 Yulu 原生 App，也不会创建可用的转写管线。请先安装 Yulu，
再为需要使用它的 Agent 添加 skill。

## 数据与隐私

- WAV 录音默认保存在 `~/Movies/Yulu`。
- 转录和纪要 sidecar 与对应录音放在一起。
- 运行数据库、任务状态、token、socket 和日志保存在 `~/.config/yulu`。
- Host 只监听回环地址，并使用每次安装生成的 bearer token 保护完成事件、转写和 MCP 请求。
- Yulu 不保存 Agent 的连接器凭据。
- 选择 xAI 代表允许 Yulu 把音频直接发送给 xAI；「设置 → 智能服务」把 OAuth
  令牌和显式提交的 API Key 保存在 macOS 钥匙串，并分别测试转写、摘要和对话能力。
  Hermes/OpenClaw 不会收到该凭据。选择本地引擎时，语音识别留在本机。
- 外部投递必须经过明确授权；结果不确定时不会盲目重试。

详细控制与排障见[配置](docs/configuration.md)、[运维](docs/operations.md)和
[安全说明](SECURITY.md)。

## 开发

Yulu 以 macOS 为唯一已发布平台。原生录音与系统悬浮层使用 Swift，本地 Host 和 Web UI
使用 TypeScript，Python 负责录音编排、调度和 macOS 工作流衔接。

```bash
python3 -m pytest -q

cd yulu/scripts/yulu_ui
npm test
npm run typecheck
npm run build
```

把当前 checkout 安装到本机进行 dogfood：

```bash
make dev-install
python3 yulu/scripts/doctor.py --json
curl -fsS http://127.0.0.1:7777/healthz
```

贡献者文档：[开发指南](docs/DEVELOPMENT.md)、[Web UI](docs/yulu_ui.md)、
[品牌规范](docs/branding.md)、[发布流程](docs/RELEASE.md)和
[架构决策](yulu/spec/adr/README.md)。

## License

MIT。详见 [LICENSE](LICENSE)。第三方工具与 macOS framework 保留各自的许可证。
