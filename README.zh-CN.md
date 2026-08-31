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
使用你明确选择的音频引擎：默认本地，也可通过 Yulu 管理的一次兼容 Grok CLI 的 OAuth
或显式提交的 API Key 连接 xAI 云端方案。引擎与凭据来源之间都不会自动切换。

转写、摘要服务与对话服务可以独立选择。摘要任务与本地保存的对话都会固定创建时的
服务与模型；设置变更只影响新工作。xAI 摘要只发送所选摘要指令与已提交转写，关闭响应存储，
并通过同一套本地产物校验与原子提交路径保存 Markdown。失败后任务或对话保持暂停，
不会切换服务或模型。

核心激活会明确显示所选摘要服务与模型。只有当前模型和凭据来源通过真实能力探测，且用户
接受当前版本的数据路径披露后，xAI 摘要才会就绪；OAuth 或 API Key 的存在不等于同意发送
转写文本。激活页只列出当前满足共享摘要契约的连接：direct xAI、Codex 或 Claude Code。
Hermes 与 OpenClaw 仅支持对话，绝不会作为摘要选项出现。

当激活准备状态全部就绪时，`/activate` 会启动 Yulu 其他入口共用的生产录音器，并建议自然录制
10–20 秒。持久化 Host 任务会在离开页面或重启后继续处理。只有音频、转写、当前摘要、完整性与
提供方来源全部通过验证后，才会建立激活里程碑；引导流程完成时会打开已保存笔记，其他符合条件的
录音则只显示非阻塞入口，不会改变当前页面。

全新安装会自动打开一次「新手引导主页」，统一组织核心激活和可选能力；老用户只会通过正常、
非阻塞的导航入口进入。可选能力的已采用或已暂缓结果，以及既有的新手引导完成记录，都会跨重启和
引导版本持久保留；当前就绪状态会单独显示，即使需要处理也不会撤销历史完成。新手引导只链接到
既有的权威设置入口，不会复制服务、连接器、OAuth 或 Token 配置。只有用户明确采用「设置 →
分享」中当前已核验且不含会议内容的测试分享后，分享才会记为已采用；暂缓不会改变当前就绪状态。

## 现在可以做什么

| 使用场景 | Yulu 提供的能力 |
|---|---|
| 录制会议 | 通过 ScreenCaptureKit 捕获系统声音、通过 AVFoundation 捕获麦克风；支持从 UI、菜单栏、日历/窗口检测、CLI 或 MCP 开始 |
| 查看实时字幕 | 默认在当前活动屏幕中下方显示电影式字幕，可以移动位置，并切换仅原文、双语或仅译文；可选本地 sherpa-onnx Paraformer INT8 模型提供低延时原文 |
| 回看会议 | 在统一资料库里播放录音、查看转录和纪要、管理标签、修正说话人、选择模板和术语表、进行本地搜索 |
| 独立执行每个动作 | 重新转写、重新生成纪要、分享纪要互相独立，可以按需单独重跑 |
| 询问全部会议历史 | Agent Console 固定对话服务：xAI 只接收有上限的本地片段与历史；Agent 对话仍使用该 Agent 自己的检索与连接器 |
| 用语音代替输入 | 全局快捷键支持听写、快速翻译，以及把语音问题继续发送到 Agent Console |
| 检查运行状态 | 设置与健康状态页面集中展示权限、主机能力、持久化任务、后台服务、调度器和日志 |

## 当前界面

<p align="center">
  <img src="assets/demos/agent-console-desktop.png" alt="使用蓝色引号 Logo 和新版录音控件的 Yulu Agent Console" />
</p>

Agent Console 是默认工作台。你可以在同一个页面开始或停止录制、查看最近的会议任务、
询问本地会议历史，并检查当前对话服务。xAI 对话会先搜索本地会议，没有命中时不发送任何请求；
来源卡片和对话历史仍保存在本地。会话还会固定 xAI 凭据来源并核验响应模型；失败时保留历史、
来源快照与固定的服务/模型/凭据来源，直到你明确对同一快照重试一次或创建新对话。

「设置 → 智能服务」中的 Agent 连接中心是唯一权威入口，负责连接、数据路径说明、能力测试、
选择、修复与删除。仅打开页面不会发送模型请求；激活页与 Agent Console 会直达准确的连接和
能力。新对话必须来自显式选择且已就绪的连接；既有固定会话仍保留创建时的服务、模型、连接和
原生 session。
发现操作只会列出候选项，不会自动选择。请先安装运行时或将其放入 Yulu Host 的 PATH，
在终端中打开运行时原生登录，返回后刷新状态，再显式连接并选择能力。Yulu 不会读取或复制
运行时的 OAuth 令牌。

「设置 → 分享」用于配置外部投递，且不会修改纪要或对话服务。先选择受支持的 Agent Connection，
分别执行只读目标发现与有界连接器探测，再明确保存目标。只有用户确认发送一条不含会议内容的
测试分享，并由所选 Agent 读回外部回执后，分享才会就绪。写入中断会保留为「结果未知」，直到
用户核验回执并完成对账或放弃该次操作；Yulu 不会自动重试。目标发现、访问探测、写入与回执
读回都必须带有成功的所选连接器工具调用证据，同一个客户端操作 ID 也不能产生两次写入。
Codex 会在临时项目中加载仅属于 Yulu 的调用前守卫，同时继续使用其原有的运行时认证；守卫会在
执行前阻止外部工具和不匹配的写入参数，且不会复制连接器凭据。

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
- 自动生成纪要时，需要先在「设置」中准备好 xAI、Codex 或 Claude Code
  纪要连接。分享需要具备已证明调用前授权边界的 Codex 或 Claude Code 连接；Hermes 与
  OpenClaw 仅支持对话，不能选作纪要或分享提供方。
- 转写、听写和实时字幕默认使用本地引擎；也可显式选择 xAI，并直接在 Yulu
  设置中完成兼容 Grok CLI 的 OAuth。两种引擎不会自动切换。
- Agent Console 可选使用 Codex CLI、Claude Code、OpenClaw、Hermes 或自定义命令。

官方 App 已内含兼容的 Application Runtime 与必要音频工具。

### 安装

打开 [GitHub 最新 Release](https://github.com/Nowhitestar/Yulu/releases/latest)，
下载 `yulu-macos-arm64-vX.Y.Z.dmg`，打开后把 `Yulu.app` 拖到
`/Applications` 别名。启动 `/Applications/Yulu.app`；自包含 App 会打开设置流程，
并引导授权三项 macOS 权限：

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

### 安装其它版本

在 [Releases 页面](https://github.com/Nowhitestar/Yulu/releases)打开对应版本，
下载其 `yulu-macos-arm64-vX.Y.Z.dmg`，并替换 `/Applications` 中的
`Yulu.app`。贡献者仍可用 `make dev-install` 安装当前 checkout 做开发 dogfood。

### 更新与卸载

Yulu 通过签名的 Sparkle feed 获取稳定版更新。手动恢复也使用同一 Release DMG：
退出 Yulu，把其中的 `Yulu.app` 拖入 `/Applications` 覆盖现有版本，再重新打开。
替换 App 不会删除保存在 bundle 外的配置与录音。

如果升级时出现迁移恢复界面，请先用可见的 **Cancel Service Migration** 回滚当前
尝试，检查系统保留的证据并修复阻塞原因，再选择 **Retry Service Migration**。
不要手工修改迁移 journal 或应用数据库。

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
                        固定的摘要服务生成并提交纪要
                                  |
                            可选的授权分享

Agent Console -> 用户选择的通用 Agent -> 该 Agent 自己的连接器
```

这条边界是有意设计的：

- **Yulu** 负责原生录制、系统权限、本地文件、持久化任务、产物提交、恢复和授权边界。
- **Yulu 所选音频引擎** 负责实时字幕、最终转写和听写；默认本地，也可显式选择
  xAI 云端，绝不自动降级或切换。
- **Yulu** 直接管理 xAI OAuth，并把凭据保存在 macOS 钥匙串；音频协议与执行均由 Yulu 负责。
- **固定的摘要服务** 通过任务创建时选定的准确 xAI、Codex 或 Claude Code
  连接生成纪要。明确的连接器投递使用「设置 → 分享」中独立选择的受支持连接。
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

## Agent 连接能力矩阵

| 连接 | 对话 | 摘要 | 授权与就绪边界 |
|---|---|---|---|
| Codex / Claude Code | 仅在生产适配器证明当前运行时合同时可用 | 只有运行时能证明更严格的无工具摘要合同时才显示 | OAuth 始终由原生运行时保管 |
| OpenClaw 2026.5.12+ | 接受说明并通过有界、无工具的 `infer model run --gateway` 测试后可用 | 不支持 | 测试与对话必须证明同一 Gateway、Provider 和模型，且没有 fallback |
| Hermes 0.20.0 | 在 Hermes 提供稳定的无工具能力测试接口前不可用 | 不支持 | PATH、配置和 OAuth 状态都不能单独代表已就绪 |

「设置 → 智能服务」是唯一权威的 Agent 连接中心。打开它只会检查状态，不会探测模型或消耗
模型额度；能力测试前必须先接受当前数据路径说明。删除运行时自有连接只会移除 Yulu 的
连接/就绪历史与未来选择，不会退出登录或修改原生运行时配置。

## 数据与隐私

- WAV 录音默认保存在 `~/Movies/Yulu`。
- 转录和纪要 sidecar 与对应录音放在一起。
- 运行数据库、任务状态和本地 bearer token 保存在
  `~/Library/Application Support/Yulu`；socket 保存在
  `~/Library/Caches/Yulu`，日志保存在 `~/Library/Logs/Yulu`。
  `~/.config/yulu` 只作为旧版本迁移时的只读来源。
- Host 只监听回环地址，并使用每次安装生成的 bearer token 保护完成事件、转写和 MCP 请求。
- Yulu 不保存 Agent 的连接器凭据。
- 选择 xAI 本身不等于授权云处理；在把录音音频直接发送给 xAI 前，Yulu 还会要求
  当前版本的「云端转写同意」。「设置 → 智能服务」把 OAuth 令牌和显式提交的 API Key
  保存在 macOS 钥匙串。保存 API Key 不会选中它；Credential Source 仍需单独明确选择。
  Yulu 会通过不发送用户音频的生产 WebSocket 握手测试实时转写，并分别测试摘要和对话。
  Hermes/OpenClaw 不会收到该凭据。选择本地引擎时，
  语音识别留在本机。
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
