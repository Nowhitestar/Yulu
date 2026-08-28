---
name: yulu
description: Control Yulu（语录）, an Agent-native macOS meeting recorder. Use it to start or stop native recording, inspect durable recording tasks, search or read meeting artifacts, and diagnose the local Host, audio-engine, and Agent pipeline.
version: 2.0.0
source: ~/.yulu/skills/yulu/SKILL.md
metadata:
  hermes:
    tags: [yulu, meeting, recorder, transcription, summary, macos, agent-native]
---

# Yulu

Yulu 是 macOS 原生会议记录器和可信本地控制面：

- `Yulu.app` 负责 ScreenCaptureKit 系统音频、AVFoundation 麦克风和 macOS 权限；
- Yulu Host 负责持久化任务、幂等、租约、恢复、产物原子提交和审计；
- Yulu 明确选择的本地/xAI 音频引擎负责实时字幕、最终转写和听写，绝不自动回退；
- Yulu 直接管理 xAI OAuth 并把凭据保存在 macOS 钥匙串；Hermes 负责会议纪要；
- Agent Console 选中的通用 Agent 负责交互式对话和它自己的连接器。

Yulu 只管理受限的本地音频模型，不运行总结 worker、对话引擎或 connector runtime。不要寻找或恢复旧的 STT daemon、JSON Agent 队列或 Yulu-owned Notion 路径。

## 什么时候用

用户提出以下请求时加载本 skill：

- 开始、停止或查看会议录音状态；
- 查找某次历史会议、转录或纪要；
- 查看录音处理进度，判断失败发生在录音、所选音频引擎、Hermes 纪要或产物提交；
- 重跑某次录音的 Agent 处理流程；
- 查看或管理 Yulu 的提示词、术语表和本地搜索；
- 验证 Yulu Host、MCP、Hermes 或 macOS 录音权限。

Yulu 面向会议和语音输入，不是通用音频编辑器。

## 优先使用 MCP

Yulu Host 提供 loopback-only、bearer-authenticated MCP。优先调用已注册的 MCP 工具，不要读取或打印 `~/.config/yulu/mcp-token.json`，也不要直接编辑 `host.sqlite`。

主要工具：

| 工具 | 用途 |
|---|---|
| `recording_status` | 查看原生录音状态和输入权限 |
| `recording_start` | 以可选标题开始原生录音 |
| `recording_stop` | 停止录音并进入同一条持久化处理链 |
| `recordings_list` | 列出历史录音 |
| `recording_get` | 读取一条录音的 metadata、转录、纪要及关联任务状态 |
| `recording_task_get` | 查看持久化任务、阶段和审计事件 |
| `recording_search` | 搜索本地转录和纪要 |
| `recording_rename` | 重命名一条录音 |
| `recording_set_tags` | 更新录音标签 |
| `prompts_list` / `prompt_*` | 读取或管理本地总结、清理和语音提示词 |
| `glossary_list` / `glossary_*` | 读取或管理本地术语上下文 |
| `health_check` | 查看原生录音、Host、Hermes 和相关运行态健康 |

以下工具属于 Host 启动的 Hermes 租约任务，不是普通交互动作：

| 工具 | 租约内用途 |
|---|---|
| `recording_task_progress` | 报告当前 Hermes 任务的语义阶段 |
| `recording_task_transcript_read` | 仅通过 Host 读取当前租约任务的转录，不暴露文件路径 |
| `recording_task_summary_stage` | 通过 Host 提交当前任务的最终 Markdown 纪要 |
| `recording_artifact_commit` | 原子提交当前任务由 Host 管理的转录和纪要 |
| `recording_begin_notion_delivery` | 已退役的兼容端点；拒绝开始任何新投递 |
| `recording_committed_summary_read` | 历史投递审计兼容：读取 Host 校验过的已提交纪要 |
| `recording_commit_notion_delivery` | 仅保留历史投递审计兼容，不用于新录音处理 |

只有当前租约持有者可以调用这些写工具。普通 Agent 不应伪造 task ID、lease 或完成状态。

## 常用工作流

### 开始录音

1. 用户给了标题时，调用 `recording_start`。
2. 没有标题但上下文足够时，使用简短可识别的标题。
3. 上下文不足时问一次，或使用带时间的临时标题。

CLI 回退：

```bash
yulu record start "<meeting title>"
```

### 停止录音

调用 `recording_stop`，或：

```bash
yulu record stop
```

停止只代表原生捕获结束。完成录音会提交给 Host，所选音频引擎先生成并提交最终转录，再由 Hermes 生成纪要。不要告诉用户“纪要已完成”，除非关联任务达到 `completed` 且转录、纪要产物都已由 Host 提交。

### 查看处理进度

先用 `recording_get` 找关联任务，再用 `recording_task_get` 看状态和阶段；完整审计事件可在 Yulu UI 的任务详情中查看。常见状态：

| 状态 | 含义 |
|---|---|
| `queued` | 已持久化，等待领取 |
| `awaiting_agent` | 所选音频引擎或 Hermes 纪要 Agent 不可用，录音仍安全保存 |
| `running` | 当前租约正在转写或总结 |
| `transcript_committed` | 最终转录已持久化，纪要仍可等待或重试 |
| `artifacts_committed` | 转录和纪要均已提交 |
| `sending` | 历史投递已开始；升级后会进入结果不明围栏 |
| `delivery_reported` | 历史 Hermes 投递已报告 Notion 页面 URL 或 ID |
| `completed` | 所需转录和纪要产物已提交；历史投递收据仍可审计 |
| `failed` | 确定性处理或校验失败 |
| `delivery_unverified` | 外部投递结果不确定，必须先人工核对 |

`delivery_unverified` 不等于“发送失败”。不要反复触发投递；先在目标 Notion 中按稳定标记 `yulu-<task-id>` 核对。

### 查找历史会议

优先使用 `recording_search`、`recordings_list` 和 `recording_get`。回答“某次会议说了什么”时必须读取转录或纪要，不要只根据标题、文件名或任务状态推断。

录音内容默认位于 `~/Movies/Yulu/`，同一 stem 常见产物是：

- `<stem>.wav`
- `<stem>.transcript.txt`
- `<stem>.summary.md`

### 重跑录音处理

从录音详情页分别使用“重新转写”“重新生成纪要”“分享”动作。不要手工覆盖最终 sidecar 或手工插入 SQLite 任务。每个动作都显式、可独立重跑；自动完成事件本身仍保持幂等。

### 分享边界

录音处理只负责转写并持久化转录与纪要，到此结束。`sendToNotion`、旧配置、完成事件和兼容 MCP 端点都不能开始新投递。分享必须从对应录音详情页发起一个全新的手动 Share Action，并经过独立确认。历史上已经开始且结果不明的投递只能显式确认或放弃，禁止普通重试。

不要把普通 Agent Console 对话中的 Notion 请求和录音分享混为一条路径，也不要让 Yulu 保存 Notion 凭据。

## Hermes 租约任务规则

当 Host 启动本 skill 处理已领取的录音任务时：

1. 只处理 Host 提供的 task ID 和 lease；不要用文件工具读取任务目录或最终 sidecar。
2. artifact session 调用 `recording_task_transcript_read` 获取当前任务转录。
3. 使用任务附带的总结指令生成最终 Markdown，并调用 `recording_task_summary_stage` 提交给 Host。
4. 调用 `recording_artifact_commit`，让 Host 校验并原子提交转录与纪要。
5. 产物提交后立即停止；录音处理任务不得调用任何外部写入或投递工具。
6. 最后报告简短状态；文字报告不能替代 Host 工具提交。

如果 Hermes 无法完成纪要，保留明确错误供 Host 记录。不要切换到另一个通用 Agent 作为隐式 fallback；音频引擎也不得在本地与 xAI 之间自动切换。历史投递的 Unknown Outcome 只能人工核对，不能重试。

## 本地路径

| 路径 | 内容 |
|---|---|
| `~/.yulu/` | 已安装 Yulu runtime |
| `~/.config/yulu/config.json` | 非密钥配置 |
| `~/.config/yulu/host.sqlite` | 任务、租约、事件、产物和投递审计 |
| `~/.config/yulu/agent-tasks/` | Host 私有任务工作区；Agent 不要直接读写 |
| `~/.config/yulu/recording-events/` | Host 不可用时的录音完成事件 |
| `~/.config/yulu/audio_daemon.sock` | 原生录音控制 socket |
| `~/.config/yulu/mcp-token.json` | 本地 bearer token；不要输出 |
| `~/Movies/Yulu/` | 录音及 Host 提交的转录、纪要 |

Host 暂时不可用时，录音完成事件会原子暂存并在恢复后重放；同一个自动完成事件不会重复创建任务。

## 排障顺序

把不同边界分开检查：

1. **原生录音**：`recording_status` 或 `yulu status`；检查 `sysReady`、`micReady` 和 socket。
2. **本地 Host**：`curl -fsS http://127.0.0.1:7777/healthz` 和 `yulu logs ui`。
3. **持久化任务**：`recording_task_get` 或 `yulu doctor --json` 的 `host_tasks`。
4. **音频引擎**：本地模型状态，或 xAI OAuth 来源与 xAI STT 错误。
5. **Hermes**：纪要 Agent capability，以及 Yulu LaunchAgent 能看到的稳定 Hermes PATH。
6. **产物**：检查独立提交的 transcript artifact 和后续 summary artifact。
7. **历史 Notion 投递**：只检查 delivery record、页面 URL/ID 和稳定标记；不要触发新投递。

常用命令：

```bash
yulu status
yulu doctor --json
yulu mcp status
yulu mcp test
yulu logs ui
yulu repair-permissions
```

若 `sysReady=false` 或 `micReady=false`，使用 `yulu repair-permissions`，并在系统设置中为 `Yulu.app` 启用“麦克风”和“屏幕与系统音频录制”。

## 隐私和安全

- 不读取、复制或展示 MCP token、Host SQLite 内部 lease、Agent 凭据或 connector 凭据。
- 不把录音或转录贴到聊天里，除非用户明确要求且只使用必要片段。
- 选择本地引擎时音频不离开本机；选择 xAI 时 Yulu 直接把音频发送给 xAI，并从 macOS 钥匙串读取自己的 OAuth 凭据。
- Notion 是单任务明确授权的副作用；其它 connector 动作遵循当前通用 Agent 自己的授权模型。
- 不把 `host.sqlite`、token、task workspace、socket 或 event spool 放到云同步目录。

## 开发和安装

本 skill 只是 Agent 契约，不能单独安装原生录音和 Host。安装或刷新运行态：

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash
yulu skill install --agent codex
yulu mcp status
yulu mcp test
```

开发 checkout 修改后，先同步到真实运行态再验收：

```bash
make dev-install
python3 yulu/scripts/doctor.py --json
curl -fsS http://127.0.0.1:7777/healthz
```

不要仅凭源码测试推断已安装 runtime 已更新。当前架构详情见 `docs/ARCHITECTURE.md`、`docs/operations.md`、`yulu/spec/adr/005-agent-native-durable-recording-pipeline.md` 和 `yulu/spec/adr/007-explicit-audio-transcription-engines.md`。
