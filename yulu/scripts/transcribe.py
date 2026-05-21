#!/usr/bin/env python3
"""Process a recorded meeting: orchestrate transcription via stt_daemon,
optionally polish via LLM, persist summary, and dispatch to agent queue.

This file replaces the previous in-process mlx-whisper / whisper-cli
subprocess invocations with stt_daemon RPC calls. All STT lives in the
daemon now; transcribe.py is the *business* orchestrator.
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Optional

from transcribe_client import transcribe_file, DaemonUnavailable, DaemonError

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"

FAST_POST_RECORDING_MODE = "fast_summary"
FULL_POST_RECORDING_MODE = "full_transcribe"

NOTIFY_SCRIPT = Path(__file__).parent / "notify.py"

SUMMARY_PROMPT = """请将以下会议转录整理成结构化会议纪要。

会议主题：{title}

{template_section}

要求：
1. 列出会议基本信息（主题、时间）
2. 按议题分类讨论要点，每个议题下列出关键发言和结论
3. 提取所有 Action Items（待办事项），标注负责人和截止日期（如能从内容推断）
4. 提取关键决策结论
5. 使用中文，Markdown 格式输出，不要任何额外说明文字

会议转录：
---
{transcript}
---
"""


def load_config():
    if not CONFIG_PATH.exists():
        print(f"Config not found at {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def _looks_like_agent_event_json(text: str) -> bool:
    s = (text or "").strip()
    if not s.startswith("["):
        return False
    try:
        data = json.loads(s)
    except Exception:
        return False
    if not isinstance(data, list) or not data:
        return False
    event_types = {
        "transcript", "summary_ready", "transcribing", "summary_request",
        "realtime_transcribing", "realtime_transcript_error",
    }
    return all(isinstance(x, dict) and x.get("type") in event_types for x in data)


def refine_transcript(transcript: str, meeting_title: str, trans_cfg: dict, llm_cfg: dict) -> str:
    """Optional LLM polish pass over the daemon-returned transcript."""
    cleanup_cfg = trans_cfg.get("cleanup", {}) if isinstance(trans_cfg.get("cleanup"), dict) else {}
    enabled = cleanup_cfg.get("enabled", True)
    if not enabled or not llm_cfg.get("enabled", True):
        return transcript
    cmd_template = cleanup_cfg.get("command") or llm_cfg.get("command") or []
    if not cmd_template or cmd_template == [""]:
        return transcript
    prompt = f"""请清理以下会议转录，输出 cleaned transcript，不要摘要，不要增删事实。

会议主题：{meeting_title}

要求：
- 保留时间戳。
- 去除明显重复幻觉句。
- 恢复合理标点和段落；口语可轻微整理，但不要改写观点。
- 不要输出解释，只输出清理后的 transcript。

原始转录：
---
{transcript}
---
"""
    print(f"🧹 Transcript cleanup LLM: {shlex.join(cmd_template)}")
    try:
        result = subprocess.run(
            cmd_template, input=prompt,
            capture_output=True, text=True,
            timeout=int(cleanup_cfg.get("timeout_sec", llm_cfg.get("timeout_sec", 900))),
        )
        if result.returncode == 0 and result.stdout.strip():
            cleaned = result.stdout.strip()
            if not _looks_like_agent_event_json(cleaned):
                return cleaned
            print("Transcript cleanup returned agent-event JSON; keeping daemon transcript", file=sys.stderr)
        else:
            print(f"Transcript cleanup failed: {result.stderr}", file=sys.stderr)
    except Exception as exc:
        print(f"Transcript cleanup error: {exc}", file=sys.stderr)
    return transcript


def summarize(transcript: str, meeting_title: str, llm_cfg: dict) -> Optional[str]:
    cmd_template = llm_cfg.get("command") or []
    if not cmd_template or cmd_template == [""]:
        print("🤖 未配置 llm.command，写入 agent queue 后使用本地规则草稿...")
        return None
    if cmd_template[0] == "claude":
        try:
            subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=10, check=True)
        except Exception as exc:
            print(f"Claude CLI unavailable: {exc}", file=sys.stderr)
            return None

    template_section = ""
    template_path = Path(__file__).parent / "summary_template.md"
    if template_path.exists():
        template = template_path.read_text(encoding="utf-8").strip()
        template_section = f"请优先遵循这个纪要模板：\n---\n{template}\n---"
    prompt = SUMMARY_PROMPT.format(title=meeting_title, transcript=transcript, template_section=template_section)
    print(f"🤖 LLM: {shlex.join(cmd_template)}")
    try:
        result = subprocess.run(
            cmd_template, input=prompt,
            capture_output=True, text=True,
            timeout=int(llm_cfg.get("timeout_sec", 600)),
        )
        if result.returncode == 0:
            summary = result.stdout.strip()
            if summary and not _looks_like_agent_event_json(summary):
                return summary
            print("LLM returned empty or agent-event JSON; falling back", file=sys.stderr)
        else:
            print(f"LLM failed: {result.stderr}", file=sys.stderr)
    except Exception as exc:
        print(f"LLM error: {exc}", file=sys.stderr)
    return None


def fallback_summary(transcript: str, meeting_title: str) -> str:
    lines = [line.strip() for line in transcript.splitlines() if line.strip()]
    text = " ".join(lines)
    tldr = text[:220] + ("…" if len(text) > 220 else "")
    points = []
    for line in lines:
        if len(line) >= 4 and line not in points:
            points.append(line)
        if len(points) >= 8:
            break
    action_lines = [
        line for line in lines
        if re.search(r"(需要|要做|负责|跟进|安排|确认|明天|下周|todo|action)", line, re.I)
    ]
    question_lines = [
        line for line in lines
        if "?" in line or "？" in line or re.search(r"(问题|疑问|阻塞|不确定|block)", line, re.I)
    ]
    decision_lines = [
        line for line in lines
        if re.search(r"(决定|确认|结论|同意|采用|最终)", line)
    ]
    def bullets(items, empty="无明确内容"):
        return "\n".join(f"- {x}" for x in items[:8]) if items else f"- {empty}"
    def todos(items):
        return "\n".join(f"- [ ] {x}" for x in items[:8]) if items else "- [ ] 无明确待办"
    return (
        f"# {meeting_title}\n\n"
        f"## TL;DR\n{tldr or '转录为空，无法生成摘要。'}\n\n"
        f"## Discussion Points\n{bullets(points)}\n\n"
        f"## Action Items\n{todos(action_lines)}\n\n"
        f"## Open Questions / Blockers\n{bullets(question_lines)}\n\n"
        f"## Decisions Made\n{bullets(decision_lines, '无明确决策')}\n\n"
        f"---\n"
        f"## 原始转录\n\n{transcript}\n"
    )


def request_agent_summary(meeting_title: str, transcript_path: Path, summary_path: Path) -> None:
    template_path = Path(__file__).parent / "summary_template.md"
    try:
        from agent_notify import notify
        notify(
            "summary_request",
            title=meeting_title,
            transcript_path=str(transcript_path),
            summary_path=str(summary_path),
            template_path=str(template_path),
        )
    except Exception as exc:
        print(f"agent_notify failed: {exc}", file=sys.stderr)


def _notify_agent(event_type: str, **kw):
    try:
        from agent_notify import notify
        notify(event_type, **kw)
    except Exception:
        pass


def normalize_post_recording_mode(value) -> str:
    raw = str(value or FAST_POST_RECORDING_MODE).strip().lower().replace("-", "_")
    aliases = {
        "fast": FAST_POST_RECORDING_MODE, "quick": FAST_POST_RECORDING_MODE,
        "realtime": FAST_POST_RECORDING_MODE, "realtime_polish": FAST_POST_RECORDING_MODE,
        "realtime_summary": FAST_POST_RECORDING_MODE, "fast_summary": FAST_POST_RECORDING_MODE,
        "full": FULL_POST_RECORDING_MODE, "quality": FULL_POST_RECORDING_MODE,
        "final": FULL_POST_RECORDING_MODE, "full_transcribe": FULL_POST_RECORDING_MODE,
        "final_transcribe": FULL_POST_RECORDING_MODE,
    }
    return aliases.get(raw, raw if raw in {FAST_POST_RECORDING_MODE, FULL_POST_RECORDING_MODE} else FAST_POST_RECORDING_MODE)


def read_realtime_transcript(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8").strip()
    return text or None


def _request_final_transcribe(audio_path: Path, trans_cfg: dict, meeting_title: str) -> Optional[str]:
    """Ask the daemon to transcribe the file. Returns text or None on failure."""
    engine = trans_cfg.get("final_engine", "mlx")
    language = trans_cfg.get("language", "zh")
    try:
        response = transcribe_file(
            audio_path=str(audio_path),
            engine=engine,
            language=language,
            meeting_title=meeting_title,
            kind="file_transcribe",
        )
    except DaemonUnavailable as exc:
        print(f"⚠️ stt_daemon unavailable: {exc}", file=sys.stderr)
        return None
    except DaemonError as exc:
        print(f"⚠️ stt_daemon error: {exc}", file=sys.stderr)
        return None
    if response.get("status") != "ok":
        print(f"⚠️ daemon transcribe failed: {response.get('error')}", file=sys.stderr)
        return None
    return response["text"]


def process_audio(audio_path_str: str) -> tuple[str, str]:
    config = load_config()
    trans_cfg = config.get("transcription", {})
    llm_cfg = config.get("llm", {})

    audio_path = Path(audio_path_str)
    if not audio_path.exists():
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    meeting_title = audio_path.stem.rsplit("_", 1)[0].replace("_", " ")
    print(f"📁 处理: {audio_path.name}（标题: {meeting_title}）")

    raw_transcript_path = audio_path.with_suffix(".raw.transcript.txt")
    realtime_transcript_path = audio_path.with_suffix(".realtime.transcript.txt")
    transcript: Optional[str] = None
    post_mode = normalize_post_recording_mode(trans_cfg.get("post_recording_mode"))

    if post_mode == FAST_POST_RECORDING_MODE:
        transcript = read_realtime_transcript(realtime_transcript_path)
        if transcript:
            print(f"⚡ 使用实时转写结果进行清理和摘要: {realtime_transcript_path}")
        else:
            print("⚠️ 未找到可用实时转写，回退到完整 daemon 转录", file=sys.stderr)

    if transcript is None:
        transcript = _request_final_transcribe(audio_path, trans_cfg, meeting_title)
        if transcript is None:
            transcript = read_realtime_transcript(realtime_transcript_path)
            if transcript is None:
                print("❌ 无法获取任何转录，daemon 不可用且无 realtime 结果", file=sys.stderr)
                sys.exit(2)

    raw_transcript_path.write_text(transcript, encoding="utf-8")
    transcript = refine_transcript(transcript, meeting_title, trans_cfg, llm_cfg)

    transcript_path = audio_path.with_suffix(".transcript.txt")
    transcript_path.write_text(transcript, encoding="utf-8")
    print(f"✅ 原始转录已保存: {raw_transcript_path}")
    print(f"✅ 清理转录已保存: {transcript_path}")

    summary = None
    llm_enabled = llm_cfg.get("enabled", True)
    if llm_enabled:
        summary = summarize(transcript, meeting_title, llm_cfg)
    agent_should_finalize = False
    if summary is None:
        summary = fallback_summary(transcript, meeting_title)
        agent_should_finalize = bool(llm_enabled)

    summary_path = audio_path.with_suffix(".summary.md")
    summary_path.write_text(summary, encoding="utf-8")
    print(f"✅ 纪要已保存: {summary_path}")

    summary_html_path = ""
    try:
        from html_artifact import write_meeting_summary_html
        summary_html_path = str(write_meeting_summary_html(
            summary_path,
            transcript_path,
            audio_path.with_suffix(".summary.html"),
            title=meeting_title,
        ))
        print(f"✅ HTML 工作台已保存: {summary_html_path}")
    except Exception as exc:
        print(f"⚠️ HTML summary generation failed: {exc}", file=sys.stderr)

    if agent_should_finalize:
        print("Summary status: draft_agent_pending")
        request_agent_summary(meeting_title, transcript_path, summary_path)
    else:
        print("Summary status: final")
        _notify_agent("summary_ready", title=meeting_title, path=str(summary_path), html_path=summary_html_path)

    return str(transcript_path), str(summary_path)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file_path>", file=sys.stderr)
        sys.exit(1)
    process_audio(sys.argv[1])
