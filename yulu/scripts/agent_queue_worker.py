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
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"
QUEUE_PATH = Path.home() / ".config" / "yulu" / "agent-queue.json"
LOG_PATH = Path.home() / ".config" / "yulu" / "agent_queue_worker.log"
WORKER_NAME = "yulu-agent-queue-worker"
DEFAULT_LLM_CMD = ["claude", "--print"]

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
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(f"{_now()} {message}\n")


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        _log(f"failed to read {path}: {exc}")
        return default


def _write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def _load_llm_command(config_path: Path = CONFIG_PATH) -> list[str]:
    cfg = _load_json(config_path, {})
    llm_cfg = cfg.get("llm", {}) if isinstance(cfg, dict) else {}
    if not llm_cfg.get("enabled", True):
        return []
    cmd = llm_cfg.get("command") or DEFAULT_LLM_CMD
    if isinstance(cmd, str):
        return shlex.split(cmd)
    if isinstance(cmd, list):
        return [str(x) for x in cmd if str(x)]
    return DEFAULT_LLM_CMD


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
    return output + "\n"


def _handle_summary_request(entry: dict[str, Any], llm_command: list[str], timeout_sec: int) -> bool:
    prompt = _render_summary_prompt(entry)
    summary_path = Path(str(entry.get("summary_path", ""))).expanduser()
    if not summary_path:
        raise ValueError("summary_path is missing")
    summary = _run_llm(prompt, llm_command, timeout_sec)
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(summary, encoding="utf-8")
    entry["status"] = "done"
    entry["processed_by"] = WORKER_NAME
    entry["processed_at"] = _now()
    entry.pop("error", None)
    return True


def process_queue_once(
    queue_path: Path = QUEUE_PATH,
    llm_command: list[str] | None = None,
    timeout_sec: int = 900,
) -> int:
    queue_path = Path(queue_path)
    queue = _load_json(queue_path, [])
    if not isinstance(queue, list):
        _log(f"queue is not a list: {queue_path}")
        return 0
    if llm_command is None:
        llm_command = _load_llm_command()

    processed = 0
    changed = False
    for entry in queue:
        if not isinstance(entry, dict):
            continue
        if entry.get("type") != "summary_request":
            continue
        if entry.get("status") in {"done", "error", "processing"}:
            continue
        entry["status"] = "processing"
        entry["processing_by"] = WORKER_NAME
        entry["processing_at"] = _now()
        changed = True
        try:
            _handle_summary_request(entry, llm_command, timeout_sec)
            processed += 1
            changed = True
            _log(f"processed summary_request title={entry.get('title', '')!r}")
        except Exception as exc:
            entry["status"] = "error"
            entry["processed_by"] = WORKER_NAME
            entry["processed_at"] = _now()
            entry["error"] = str(exc)[:1000]
            changed = True
            _log(f"summary_request error title={entry.get('title', '')!r}: {exc}")
    if changed:
        _write_json_atomic(queue_path, queue)
    return processed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Process Yulu agent-queue summary_request events once.")
    parser.add_argument("--queue", type=Path, default=QUEUE_PATH)
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args(argv)
    count = process_queue_once(queue_path=args.queue, timeout_sec=args.timeout)
    if count:
        print(f"processed {count} summary_request event(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
