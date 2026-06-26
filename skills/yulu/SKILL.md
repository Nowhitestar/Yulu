---
name: yulu
description: Control Yulu（语录）, Lewis 的本地优先 macOS 会议录音工具。用于开始/停止会议录音、查看录音状态、查找历史转录、处理 ~/.config/yulu/agent-queue.json 里的 summary_request 并生成/重生成会议纪要。
version: 1.0.0
source: ~/.yulu/skills/yulu/SKILL.md
metadata:
  hermes:
    tags: [yulu, meeting, recorder, transcription, summary, macos, local-first]
---

# Yulu — 雷子的控制面

Yulu 是本地优先的 macOS 会议记录器：ScreenCaptureKit + AVFoundation 录音，whisper.cpp 本地转录，摘要请求写入 `~/.config/yulu/agent-queue.json`。没有云端账号，也不需要虚拟声卡。

这个 skill 是给 Hermes/雷子用的适配版。原始 skill 位于 `~/.yulu/skills/yulu/SKILL.md`。

## 什么时候用

用户说这些事时加载本 skill：

- 开始录音 / 记录这个会议 / start recording / record this meeting
- 停止录音 / 结束会议 / stop recording / wrap it up
- Yulu 现在是否在录 / 录音状态 / recording status
- 总结刚才会议 / 重生成某个会议摘要 / process Yulu queue
- 找某次会议 transcript / 昨天会议讲了什么
- 把某次会议纪要发到配置好的渠道

不要把它用于泛用音频录制。Yulu 面向会议，文件写在项目下的 `meeting-recordings/`。

## 路径约定

默认安装路径：

- Hermes skill/source copy: `~/.yulu/yulu/`
- 录音控制脚本：`~/.yulu/yulu/scripts/record_audio.py`
- 摘要模板：通常在 `~/.yulu/yulu/scripts/summary_template.md`
- 当前 launchd/实际运行进程可能仍来自 OpenClaw 旧路径：`~/.openclaw/workspace/meeting-assistant/yulu/scripts/`。排障时先用 `ps aux | grep yulu` 确认真实脚本路径；修复 `record_audio.py` / `transcribe.py` 这类运行脚本时要同步两边，或确认 launchd 已切到新路径。
- daemon socket: `~/.config/yulu/audio_daemon.sock`
- agent queue: `~/.config/yulu/agent-queue.json`

如果默认路径不存在，定位方式：

```bash
command -v yulu || find ~ -maxdepth 6 -name 'meeting_daemon.py' -path '*/yulu/scripts/*' -print -quit 2>/dev/null
```

## 开发 / 发布流（Yulu 不只是 skill）

当用户问 Yulu 的开发、发布、dogfood、GitHub 同步、第三方 code CLI 协作，先把 Yulu 当成完整应用仓库处理，而不是只改 skill。

当前约定：

- Git 源仓库：`~/.yulu`，remote `https://github.com/Nowhitestar/Yulu.git`。
- 源码脚本：`~/.yulu/yulu/scripts/`。
- 旧运行态/launchd 可能仍来自：`~/.openclaw/workspace/meeting-assistant/yulu/scripts/`；迁移前必须用 doctor 检查真实进程来源。
- 运行配置/状态：`~/.config/yulu/`，不进 Git。
- 会议产物：`~/Movies/Yulu/`，不进 Git。
- Skill 源头在 Yulu repo：`~/.yulu/skills/yulu/SKILL.md`，同步到 Hermes 和 l-skills。

Repo hygiene workflow：

```bash
cd ~/.yulu
make doctor              # 只读检查 source/runtime/legacy process/socket/tools
make test                # py_compile + pytest + Swift build
make dev-install-dry-run # 不改运行态；录音中会拒绝
make dev-install         # 真实迁移/reload launchd 到当前 repo runtime
make sync-skill-dry-run  # 预览 skill 同步
make sync-skill          # 同步到 ~/.hermes 和 ~/Documents/Codebase/l-skills
```

当前 hygiene branch：`chore/yulu-repo-hygiene`，PR `https://github.com/Nowhitestar/Yulu/pull/15`。已加入 Makefile、doctor、dev_install、repair_permissions、sync_skill、queue_store/state_store、HTML artifact、测试、CI 和开发文档。`make dev-install` 可执行真实迁移：录音中拒绝安装，编译 helper，渲染并 reload LaunchAgents，停止旧 OpenClaw 进程，把运行态切到 `~/.yulu/yulu/scripts/`。迁移后用 `make doctor` 验证 legacy_processes=0；若 `sysReady=false`，先跑 `yulu repair-permissions`，必要时再跑 `yulu repair-permissions --reset` 并在系统设置里手动启用 Yulu。

第三方 code CLI 协作规则：每次只给一个窄任务，写 `.agent/tasks/<slug>.md`，一个 agent 一个 branch/worktree，要求跑 `make test` 和必要 smoke test；雷子负责审 diff，检查是否误提交 config、录音、transcript、日志、密钥。

## 动作

### 开始录音

```bash
python3 ~/.yulu/yulu/scripts/record_audio.py start "<meeting title>"
```

如果用户没给标题：
- 能明显推断就用合理标题
- 否则问一次，或用 `Quick recording <YYYY-MM-DD HH:MM>`

### 停止录音

```bash
python3 ~/.yulu/yulu/scripts/record_audio.py stop
```

停止后，Yulu 会本地转录，并向 `~/.config/yulu/agent-queue.json` 写入 `summary_request`。随后应该尽快处理队列，不要依赖外部 agent 长久在线。

### 查看状态

```bash
echo '{"action":"status"}' | nc -w 2 -U ~/.config/yulu/audio_daemon.sock
```

返回 JSON，通常包含：

- `recording`
- `sysReady`
- `micReady`
- 当前文件路径
- elapsed time

如果 socket 不存在，说明 Yulu daemon 没跑。让用户打开 `Yulu.app`，或运行 Yulu 的 setup。

## 处理 summary_request

`~/.config/yulu/agent-queue.json` 是 JSON 数组。Yulu 会为需要最终摘要的会议写一条：

```json
{
  "id": "8f2d...",
  "type": "summary_request",
  "ts": "2026-05-08T14:32:11",
  "title": "Yulu product weekly",
  "audio_path": "/.../meeting-recordings/Yulu_20260508_143000.wav",
  "transcript_path": "/.../meeting-recordings/Yulu_20260508_143000.transcript.txt",
  "summary_path": "/.../meeting-recordings/Yulu_20260508_143000.summary.md",
  "prompt_id": "summary",
  "prompt_slug": "summary",
  "prompt_name": "Meeting Summary",
  "prompt_content_snapshot": "Write a concise meeting note...",
  "html_path_hint": "/.../meeting-recordings/Yulu_20260508_143000.summary.html"
}
```

处理步骤：

1. 读 `transcript_path`。这是 UTF-8 纯文本，通常带时间戳。
2. 使用 `prompt_content_snapshot` 作为本次摘要的提示词快照；不要重新读旧模板路径，也不要假设 prompt catalog 当前内容和入队时一致。
3. 按提示词生成会议纪要，覆盖写入 `summary_path`。Yulu 可能已经写了 fallback draft，可以覆盖。
4. 如已有 `.summary.md`，同时生成/刷新同 stem 的 `.summary.html`：
   ```bash
   python3 ~/.yulu/yulu/scripts/html_artifact.py /path/to/meeting.summary.md /path/to/meeting.transcript.txt
   ```
   HTML 是后续加工优先的 workbench，模板来自 `~/Documents/LBrain/Templates/html-artifacts/meeting-summary.html`：正文区域可编辑，内嵌 `#artifact-data` JSON，工具条可复制 Markdown/JSON/简版、保存当前 HTML、打印/PDF。
5. 更新 queue：保留 entry，把 `status` 改为 `"done"`，并写入 `processed_by` / `processed_at`；失败时写 `status: "error"` 和 `error`。不要删除 entry，也不要改成旧的完成事件类型，UI/worker 需要靠状态做可观测和重试。
6. 用 Python 或 `jq` 处理 JSON，别用 shell 字符串拼接。

Lewis 偏好：Yulu 摘要尽量交给本地 worker 及时处理；如果需要委托 LLM，优先考虑 Codex CLI，而不是 Claude CLI。

## HTML artifact / workbench

Yulu 纪要现在默认保留两种产物：

- `.summary.md`：适合纯文本发送、兼容旧流程。
- `.summary.html`：适合 Lewis 后续加工。它是单文件 HTML 工作台，包含：
  - 可编辑内容区（`contenteditable="true"`）
  - `script#artifact-data[type="application/json"]` 结构化数据（title / tldr / action_items / decisions / open_questions / topics / paths）
  - 工具条：复制 Markdown、复制 JSON、复制 Telegram 版、保存当前 HTML、打印/PDF

实现文件：`scripts/html_artifact.py`。它是 Yulu 薄适配层，优先读取 LBrain 模板 `~/Documents/LBrain/Templates/html-artifacts/meeting-summary.html`，并复用支撑脚本 `~/Documents/LBrain/System/html-artifacts/render_artifact.py`。`transcribe.py` 写完 `.summary.md` 后会自动调用 `write_meeting_summary_html(...)` 生成 `.summary.html`，并在 `summary_ready` 事件里附带 `html_path`。`agent_queue_worker.py` 处理 `summary_request` 覆盖 `.summary.md` 前必须校验：不能是 agent-queue JSON，长度不能过短，至少包含 `## TL;DR` / `## Discussion Points` / `## Action Items`；覆盖后也要刷新 `.summary.html`。修 `transcribe.py` / `html_artifact.py` / `agent_queue_worker.py` 时要同步到源码 repo 和当前真实运行态；改通用模板时优先改 LBrain Templates。

## 查找历史会议

录音文件通常在 `<repo>/meeting-recordings/`。同一次会议会共享 stem：

`<SanitizedTitle>_<YYYYMMDD>_<HHMMSS>`

常见文件：

| Suffix | 内容 |
|---|---|
| `.wav` | 录音音频 |
| `.transcript.txt` | 最终 transcript |
| `.realtime.transcript.txt` | 录制时流式 partial transcript，可能没有 |
| `.summary.md` | Markdown 会议纪要 |
| `.summary.html` | 可编辑 HTML 工作台：内嵌 JSON data island，支持复制 Markdown/JSON/Telegram 版、保存当前 HTML、打印/PDF |

回答“某次会议说了什么”时，必须读取 transcript 或 summary，不要只凭文件名推断。

## 已知排障点

- 如果 `sysReady=false` 且 `sysError` 是 `no display` 或 TCC 拒绝，先跑 `yulu repair-permissions`；它会重启 audio daemon 并打开 Screen & System Audio Recording 设置页。若需要清掉旧授权状态，再跑 `yulu repair-permissions --reset`，然后在系统设置里手动启用 Yulu。
- 如果 `.transcript.txt` 或 `.summary.md` 里只有类似 `[{"type":"transcript"...}]` / `summary_ready` / `realtime_transcript_error` 的 JSON 数组，这是 LLM shim/Codex 或 realtime 转写错误事件被误当正文。应检查 `transcribe.py` 的 `_looks_like_agent_event_json`，把所有 agent-queue event type 加进拒绝名单；遇到这种输出必须拒绝并保留原 transcript / fallback summary，不能覆盖成 JSON。
- 如果录音停止后 `realtime_transcribe.py` 还在跑，通常是它卡在 `mlx-whisper` 子进程里；`record_audio.py` 需要 kill 整个 process group（`start_new_session=True` 对应 `os.killpg`），否则 fast_summary 会读到不完整 realtime transcript。
- 如果浮窗卡死、点不了停止，但 wav 文件仍在增长：常见根因是 Swift `audio_daemon` 进程活着但 Unix socket accept/read 不响应。排障顺序：`record_audio.py status`/`nc` 验证 socket；检查 `.state.json` 和 wav mtime/size；若 socket 失联，先保留 wav，kill `recorder_status`、`realtime_transcribe.py` process group、卡住的 `mlx_whisper`、`Yulu.app/Contents/MacOS/audio_daemon`，再把 state 标成 stopped/crashed。修复点：`recorder_status.swift` 的 socket read/write 必须设置 1s `SO_RCVTIMEO`/`SO_SNDTIMEO`，避免 UI 主线程阻塞；`record_audio.py stop` 应有 `emergency_stop_daemon()` 兜底，daemon 不响应时终止 daemon 并保留录音路径；`audio_daemon.swift` 的 accept loop 不要用会失效的 weak self 静默退出，失败要 log errno。
- `fast_summary` 速度快但依赖实时转写完成度；长会议里 realtime chunk 可能明显落后或坏掉，质量优先时切到完整 final transcript 或等待 realtime ready。
- Realtime transcript 里出现大量 “请保留英文专有名词...” 或重复术语，是 whisper initial_prompt 在静音/弱语音段幻觉泄漏；优先降低 realtime prompt 强度、关 `condition_on_previous_text` 或对 prompt 泄漏行做过滤。 / fallback summary，不能覆盖成 JSON。
- 如果录音停止后 `realtime_transcribe.py` 还在跑，通常是它卡在 `mlx-whisper` 子进程里；`record_audio.py` 需要 kill 整个 process group（`start_new_session=True` 对应 `os.killpg`），否则 fast_summary 会读到不完整 realtime transcript。
- 如果浮窗卡死、点不了停止，但 wav 文件仍在增长：常见根因是 Swift `audio_daemon` 进程活着但 Unix socket accept/read 不响应。排障顺序：`record_audio.py status`/`nc` 验证 socket；检查 `.state.json` 和 wav mtime/size；若 socket 失联，先保留 wav，kill `recorder_status`、`realtime_transcribe.py` process group、卡住的 `mlx_whisper`、`Yulu.app/Contents/MacOS/audio_daemon`，再把 state 标成 stopped/crashed。修复点：`recorder_status.swift` 的 socket read/write 必须设置 1s `SO_RCVTIMEO`/`SO_SNDTIMEO`，避免 UI 主线程阻塞；`record_audio.py stop` 应有 `emergency_stop_daemon()` 兜底，daemon 不响应时终止 daemon 并保留录音路径；`audio_daemon.swift` 的 accept loop 不要用会失效的 weak self 静默退出，失败要 log errno。
- `fast_summary` 速度快但依赖实时转写完成度；长会议里 realtime chunk 可能明显落后或坏掉，质量优先时切到完整 final transcript 或等待 realtime ready。
- Realtime transcript 里出现大量 “请保留英文专有名词...” 或重复术语，是 whisper initial_prompt 在静音/弱语音段幻觉泄漏；优先降低 realtime prompt 强度、关 `condition_on_previous_text` 或对 prompt 泄漏行做过滤。

## 重跑坏掉的 transcript / summary

当用户说“重跑这次录制”或 transcript/summary 已经坏掉时，按这个 workflow：

1. 先确认录音文件健康：
   ```bash
   ffprobe -hide_banner -v error -show_format -show_streams /path/to/meeting.wav
   ffmpeg -hide_banner -nostats -i /path/to/meeting.wav -af volumedetect -f null - 2>&1 | tail -20
   ```
2. 不要直接用 48k stereo 大 wav 跑 full MLX；长会议可能卡很久。先转 16k mono：
   ```bash
   mkdir -p ~/Movies/Yulu/rerun-<name>
   ffmpeg -hide_banner -y -i /path/to/meeting.wav -ac 1 -ar 16000 \
     -af 'loudnorm=I=-16:LRA=11:TP=-1.5' ~/Movies/Yulu/rerun-<name>/meeting_16k.wav
   ```
3. 先抽 60 秒 smoke test，确认模型、音频和语种正常：
   ```bash
   ffmpeg -hide_banner -y -i ~/Movies/Yulu/rerun-<name>/meeting_16k.wav -t 60 ~/Movies/Yulu/rerun-<name>/test60.wav
   ~/.config/yulu/venv-mlx-whisper/bin/python - <<'PY'
   import mlx_whisper
   res=mlx_whisper.transcribe('/path/to/test60.wav', path_or_hf_repo='mlx-community/whisper-large-v3-turbo', language='zh', task='transcribe', verbose=False, condition_on_previous_text=False)
   print((res.get('text') or '')[:500])
   PY
   ```
4. 用 `mlx-community/whisper-large-v3-turbo` 重跑完整 16k wav，通常几十分钟音频约 2 分钟内完成。设置：`language='zh'`, `condition_on_previous_text=False`, `hallucination_silence_threshold=1.5`。保留 segments 时间戳，写回原 stem 的 `.raw.transcript.txt` 和 `.transcript.txt`。
5. 写回前过滤明显幻觉行：prompt 泄漏（“请保留英文专有名词...”）、“请不吝点赞...”、单词/双字重复循环（如 “比想比想...”）。不要过度清洗真实口语。
6. 基于新 transcript 重写 `.summary.md`，并在摘要里注明“Yulu 重新转录”。
7. 如果中途杀掉重跑进程，确认 `~/.config/yulu/config.json` 已恢复，避免临时 `post_recording_mode=full_transcribe` / `cleanup.enabled=false` 残留。

## 暂时没有的能力

如果用户问这些，直接说明还没有，并给最近替代方案：

- “总结我这个月所有会议”——目前没有聚合索引，只能遍历 `meeting-recordings/`，大档案会慢。
- “下个会前 5 分钟叫醒我”——Yulu scheduler 由 launchd 内部处理，agent 没有重触发接口。
- “剪掉录音前 30 秒”——Yulu 暂未暴露音频编辑接口。

## 隐私底线

Yulu 是 local-first。处理时遵守：

- 不上传 `.wav`、`.transcript.txt`、会议 metadata 到云端，除非用户本轮明确要求用云模型总结。
- 不把 transcript 原文大段贴进聊天，除非用户明确要求查看原文。
- 不把摘要写到 `summary_path` 和配置好的发送目的地之外。
- 需要引用 transcript 问澄清时，只引用最小必要片段，并标注。

## 验证

安装/适配后应能：

```bash
test -f ~/.yulu/yulu/scripts/record_audio.py
test -f ~/.config/yulu/agent-queue.json || true
echo '{"action":"status"}' | nc -w 2 -U ~/.config/yulu/audio_daemon.sock
```

Hermes 侧验证：`skills_list(category="leizi")` 能看到 `yulu`。
