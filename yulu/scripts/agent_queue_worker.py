#!/usr/bin/env python3
"""Process Yulu agent-queue events that need a local agent response.

The queue is still a JSON event log for external agents, but this worker handles
`summary_request` locally and promptly via the configured LLM command. It is
safe to run repeatedly from launchd: done/error entries are skipped.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from queue_store import claim_summary_request, update_event

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"
QUEUE_PATH = Path.home() / ".config" / "yulu" / "agent-queue.json"
LOG_PATH = Path.home() / ".config" / "yulu" / "agent_queue_worker.log"
PID_PATH = Path.home() / ".config" / "yulu" / "agent_queue_worker.pid"
WORKER_NAME = "yulu-agent-queue-worker"
SUMMARY_PROMPT = """请基于以下会议转录生成最终版结构化会议纪要。

会议主题：{title}

{template_section}

要求：
1. 输出中文 Markdown。
2. 包含会议基本信息、TL;DR、Discussion Points、Action Items、Open Questions / Blockers、Decisions Made。
3. 不要输出解释、寒暄或代码块，只输出纪要正文。

会议转录：
---
{transcript}
---
"""


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _log(message: str) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(f"{_now()} {message}\n")
    except OSError:
        pass


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        _log(f"failed to read {path}: {exc}")
        return default


def _load_llm_command(config_path: Path = CONFIG_PATH) -> list[str]:
    cfg = _load_json(config_path, {})
    llm_cfg = cfg.get("llm", {}) if isinstance(cfg, dict) else {}
    if not llm_cfg.get("enabled", True):
        return []
    cmd = llm_cfg.get("command") or []
    if isinstance(cmd, str):
        return shlex.split(cmd)
    if isinstance(cmd, list):
        return [str(x) for x in cmd if str(x)]
    return []


def _render_summary_prompt(entry: dict[str, Any]) -> str:
    transcript_path = Path(str(entry.get("transcript_path", ""))).expanduser()
    if not transcript_path.exists():
        raise FileNotFoundError(f"transcript not found: {transcript_path}")
    transcript = transcript_path.read_text(encoding="utf-8").strip()
    template_section = ""
    template_path = entry.get("template_path")
    if template_path:
        p = Path(str(template_path)).expanduser()
        if p.exists():
            template = p.read_text(encoding="utf-8").strip()
            if template:
                template_section = f"请优先遵循这个纪要模板：\n---\n{template}\n---"
    title = str(entry.get("title") or transcript_path.stem)
    return SUMMARY_PROMPT.format(title=title, transcript=transcript, template_section=template_section)


def _looks_like_agent_event_json(text: str) -> bool:
    """Reject accidental agent-queue JSON returned by an LLM shim."""
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
        "recording_started",
        "recording_stopped",
        "recording_crashed",
        "transcript",
        "summary_ready",
        "summary_request",
        "transcribing",
        "realtime_transcribing",
        "realtime_transcript_ready",
        "realtime_transcript_error",
    }
    return all(isinstance(x, dict) and x.get("type") in event_types for x in data)


def _is_valid_summary(text: str) -> bool:
    """Basic guardrail before overwriting a meeting summary."""
    s = (text or "").strip()
    if len(s) < 500:
        return False
    if _looks_like_agent_event_json(s):
        return False
    required = ["## TL;DR", "## Discussion Points", "## Action Items"]
    return all(section in s for section in required)


def _run_llm(prompt: str, llm_command: list[str], timeout_sec: int) -> str:
    if not llm_command:
        raise RuntimeError("llm command is disabled or empty")
    result = subprocess.run(
        llm_command,
        input=prompt,
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(f"llm command failed ({result.returncode}): {stderr[:500]}")
    output = (result.stdout or "").strip()
    if not output:
        raise RuntimeError("llm command produced empty output")
    if not _is_valid_summary(output):
        preview = output[:240].replace("\n", " ")
        raise RuntimeError(f"llm command produced invalid summary: {preview}")
    return output + "\n"


def _handle_summary_request(entry: dict[str, Any], llm_command: list[str], timeout_sec: int) -> bool:
    prompt = _render_summary_prompt(entry)
    summary_path = Path(str(entry.get("summary_path", ""))).expanduser()
    transcript_path = Path(str(entry.get("transcript_path", ""))).expanduser()
    if not summary_path:
        raise ValueError("summary_path is missing")
    summary = _run_llm(prompt, llm_command, timeout_sec)
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(summary, encoding="utf-8")

    html_path = ""
    if transcript_path.exists():
        try:
            from html_artifact import write_meeting_summary_html
            html_path = str(write_meeting_summary_html(
                summary_path,
                transcript_path,
                summary_path.with_suffix(".html"),
                title=str(entry.get("title") or summary_path.stem),
            ))
        except Exception as exc:
            _log(f"html generation failed title={entry.get('title', '')!r}: {exc}")

    entry["status"] = "done"
    entry["processed_by"] = WORKER_NAME
    entry["processed_at"] = _now()
    if html_path:
        entry["html_path"] = html_path
    entry.pop("error", None)
    return True


def _dispatch_summary(entry: dict[str, Any]) -> dict[str, Any]:
    summary_path = Path(str(entry.get("summary_path", ""))).expanduser()
    if not summary_path.exists():
        return {"dispatch_status": "skipped", "dispatch_error": "summary file not found"}
    if not CONFIG_PATH.exists():
        return {"dispatch_status": "skipped", "dispatch_error": "config not found"}

    script = Path(__file__).resolve().parent / "send_summary.py"
    result = subprocess.run(
        [sys.executable, str(script), str(summary_path)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        return {
            "dispatch_status": "error",
            "dispatch_error": (result.stderr or result.stdout or "").strip()[:1000],
            "dispatched_at": _now(),
        }

    try:
        cfg = _load_json(CONFIG_PATH, {})
        channel = cfg.get("output", {}).get("channel", "file") if isinstance(cfg, dict) else "file"
        notify = Path(__file__).resolve().parent / "notify.py"
        subprocess.Popen(
            [sys.executable, str(notify), "notify_sent", str(entry.get("title", "")), channel],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass
    return {"dispatch_status": "done", "dispatched_at": _now()}


def process_queue_once(
    queue_path: Path = QUEUE_PATH,
    llm_command: list[str] | None = None,
    timeout_sec: int = 900,
    dispatch_output: bool = False,
) -> int:
    queue_path = Path(queue_path)
    if llm_command is None:
        llm_command = _load_llm_command()
    if not llm_command:
        _log("llm.command not configured; leaving summary_request events for an external agent")
        return 0

    processed = 0
    while True:
        entry = claim_summary_request(path=queue_path, worker_name=WORKER_NAME)
        if not entry:
            break
        event_id = str(entry.get("id", ""))
        match = {
            "type": "summary_request",
            "transcript_path": entry.get("transcript_path"),
            "summary_path": entry.get("summary_path"),
        }
        try:
            _handle_summary_request(entry, llm_command, timeout_sec)
            if dispatch_output:
                entry.update(_dispatch_summary(entry))
            processed += 1
            update_event(event_id, entry, path=queue_path, match=match)
            _log(f"processed summary_request title={entry.get('title', '')!r}")
        except Exception as exc:
            updates = {
                "status": "error",
                "processed_by": WORKER_NAME,
                "processed_at": _now(),
                "error": str(exc)[:1000],
            }
            update_event(event_id, updates, path=queue_path, match=match)
            _log(f"summary_request error title={entry.get('title', '')!r}: {exc}")
    return processed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Process Yulu agent-queue summary_request events once.")
    parser.add_argument("--queue", type=Path, default=QUEUE_PATH)
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args(argv)

    # Write pid file so `yulu prompts ...` mutations can SIGHUP us for
    # PromptsCache reload between events. Best-effort; failure is ignored.
    try:
        PID_PATH.parent.mkdir(parents=True, exist_ok=True)
        PID_PATH.write_text(str(os.getpid()), encoding="utf-8")
    except OSError:
        pass

    count = process_queue_once(queue_path=args.queue, timeout_sec=args.timeout, dispatch_output=True)
    if count:
        print(f"processed {count} summary_request event(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
