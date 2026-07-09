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
import shutil
import signal
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
PROMPTS_DB = Path.home() / ".config" / "yulu" / "prompts.sqlite"
SCRIPT_DIR = Path(__file__).resolve().parent
CODEX_AGENT_COMMAND = ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check"]

# Set by SIGHUP; checked between events in process_queue_once.
_RELOAD_PROMPTS = False


def _handle_sighup(_signum, _frame):
    global _RELOAD_PROMPTS
    _RELOAD_PROMPTS = True


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
    cmd = llm_cfg.get("command")
    if isinstance(cmd, str):
        return _normalize_legacy_agent_command(_resolve_bundled_script_args(shlex.split(cmd)))
    if isinstance(cmd, list) and cmd:
        return _normalize_legacy_agent_command(_resolve_bundled_script_args([str(x) for x in cmd if str(x)]))
    agent_cfg = llm_cfg.get("agent", {}) if isinstance(llm_cfg, dict) else {}
    provider = str(agent_cfg.get("provider", "auto") if isinstance(agent_cfg, dict) else "auto").strip().lower()
    movies_dir = _recording_dir_from_config(cfg)
    if provider in ("auto", "codex") and shutil.which("codex"):
        return list(CODEX_AGENT_COMMAND)
    if provider in ("auto", "claude", "claude-code") and shutil.which("claude"):
        return ["claude", "--print", "--add-dir", str(movies_dir)]
    return []


def _recording_dir_from_config(cfg: Any) -> Path:
    if isinstance(cfg, dict):
        audio = cfg.get("audio", {})
        if isinstance(audio, dict):
            out = audio.get("output_dir")
            if isinstance(out, str) and out.strip():
                return Path(out).expanduser()
    return Path.home() / "Movies" / "Yulu"


def _normalize_legacy_agent_command(cmd: list[str]) -> list[str]:
    """Upgrade the old Python Codex shim to the native Codex CLI boundary."""
    if any(Path(part).name == "codex_llm.py" for part in cmd):
        return list(CODEX_AGENT_COMMAND)
    return cmd


def _resolve_bundled_script_args(cmd: list[str]) -> list[str]:
    """Resolve Yulu-bundled helper scripts so launchd's cwd cannot break them."""
    resolved: list[str] = []
    for part in cmd:
        if "/" in part:
            resolved.append(part)
            continue
        candidate = SCRIPT_DIR / part
        if candidate.exists() and candidate.is_file():
            resolved.append(str(candidate))
        else:
            resolved.append(part)
    return resolved


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
    if len(s) < 40:
        return False
    if _looks_like_agent_event_json(s):
        return False
    return True


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


def _maybe_summary_notify(*, summary_path: Path, prompt_slug: str) -> None:
    """Generic "summary ready" completion notification.

    Fires only for the default auto-run summary prompt (slug 'summary') so a
    single notification lands per recording when its meeting note is ready;
    other prompts (cleanup, opt-in summaries) stay quiet.
    """
    if prompt_slug != "summary":
        return
    first_line = ""
    try:
        for line in summary_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                first_line = line[:80]
                break
    except OSError:
        return
    if not first_line:
        first_line = "summary ready"
    try:
        subprocess.Popen([
            "terminal-notifier",
            "-title", "Yulu",
            "-message", first_line,
            "-open", f"file://{summary_path}",
            "-sender", "com.yulu.audiodaemon",
        ])
    except (FileNotFoundError, OSError):
        pass


def _handle_summary_request(
    entry: dict[str, Any],
    llm_command: list[str],
    timeout_sec: int,
    *,
    cache,  # PromptsCache
    prompts_db: Path = PROMPTS_DB,
) -> bool:
    """Single LLM dispatch for one summary_request event.

    Flow:
      1. Resolve prompt content:
         - prefer entry['prompt_content_snapshot'] + entry['prompt_*'] (new events)
         - else load default 'summary' slug from cache (legacy events)
      2. Compute meeting_title (entry['title']) and date via resolve_meeting_date
         on entry.get('audio_path') or derived from transcript_path.
      3. Substitute {{transcript}}, {{meeting_title}}, {{date}} in the snapshot.
      4. Open SummariesRepo (short-lived conn); insert row via .start(...)
         → mark_running.
      5. Run llm_command via subprocess; capture stdout; validate via
         _is_valid_summary (non-empty + not agent-event-json).
      6. For cleanup slug (entry['prompt_slug'] == 'transcript-cleanup'):
         - Write output to transcript_path (overwriting transcribe.py's raw write)
         - Skip html artifact + send_summary
         - SummariesRepo.mark_done with output_path = transcript_path
      7. For summary slugs (everything else):
         - Write output to summary_path
         - Try html_artifact (failures logged + non-fatal)
         - For prompt_slug == 'summary' (default), call _dispatch_summary
         - SummariesRepo.mark_done(duration_ms, word_count, html_path=...)
      8. On any failure 4–7: SummariesRepo.mark_error(error=str(exc)); re-raise.
      9. Mutate entry in place: entry['status']='done', entry['processed_by'],
         entry['processed_at'] = _now(), entry['html_path'] if produced.

    Returns True on success. Raises on failure.
    """
    import time
    from prompts import SummariesRepo, open_db
    from prompts.cache import resolve_meeting_date

    transcript_path = Path(str(entry.get("transcript_path", ""))).expanduser()
    summary_path = Path(str(entry.get("summary_path", ""))).expanduser()
    audio_path_str = entry.get("audio_path") or ""
    # Derive audio path from transcript path if not provided (legacy events)
    if not audio_path_str and transcript_path:
        audio_path_str = str(transcript_path).replace(".transcript.txt", ".wav")

    # Resolve prompt
    snapshot = entry.get("prompt_content_snapshot")
    prompt_id = entry.get("prompt_id") or ""
    prompt_slug = entry.get("prompt_slug") or "summary"
    prompt_name = entry.get("prompt_name") or "Standard Summary"
    if not snapshot:
        # Legacy event → fall back to default summary prompt from cache
        default = cache.by_slug("summary")
        if default is None:
            raise RuntimeError(
                "legacy event has no snapshot and no default 'summary' prompt in cache"
            )
        snapshot = default.content
        prompt_id = prompt_id or default.id
        prompt_slug = prompt_slug or default.slug
        prompt_name = prompt_name or default.name

    # Transcript must exist; fail early for a clear error message.
    if not transcript_path.exists():
        raise FileNotFoundError(f"transcript not found: {transcript_path}")

    # Compute substitution variables
    transcript_text = transcript_path.read_text(encoding="utf-8")

    title = entry.get("title", "") or ""
    audio_path = Path(audio_path_str) if audio_path_str else None
    date = resolve_meeting_date(audio_path) if audio_path else ""

    # Phase 3: read per-channel transcripts if they exist (dual-track).
    # Mono / legacy recordings won't have these sidecars → empty strings,
    # which render() treats as no-op substitution for legacy prompts.
    my_transcript = ""
    their_transcript = ""
    if audio_path is not None:
        mic_path = audio_path.with_suffix(".mic.transcript.txt")
        sys_path = audio_path.with_suffix(".sys.transcript.txt")
        if mic_path.exists():
            my_transcript = mic_path.read_text(encoding="utf-8")
        if sys_path.exists():
            their_transcript = sys_path.read_text(encoding="utf-8")

    # Phase 13 (diarization): read the <stem>.speakers.json sidecar if it exists and expose the
    # speaker-attributed transcript + a compact roster via ONE additive prompt-var pair. The
    # sidecar is the source-of-truth (criterion 4): the labelled transcript is rendered FROM it
    # (resolving renames/merges) rather than re-deriving labels. Absent sidecar → both "" so every
    # existing prompt renders EXACTLY unchanged (the same backward-compat property the dual-track
    # vars rely on). DATA only — no UI (criterion 3: export carries labels via these vars).
    speaker_transcript = ""
    speaker_list = ""
    if audio_path is not None:
        speakers_path = audio_path.with_suffix(".speakers.json")
        if speakers_path.exists():
            try:
                from stt_daemon import speaker_merge as _sm
                _doc = _sm.read_sidecar(speakers_path)
                speaker_transcript = _sm.render_from_sidecar(_doc)
                speaker_list = _sm.speaker_roster(_doc)
            except Exception as exc:
                _log(f"speakers sidecar read failed for {speakers_path}: {exc}")
                speaker_transcript = ""
                speaker_list = ""

    speaker_vars = ("{{speaker_list}}", "{{speaker_transcript}}", "{{best_transcript}}")
    if (speaker_transcript or speaker_list) and not any(v in snapshot for v in speaker_vars):
        snapshot = (
            "说话人候选：{{speaker_list}}\n"
            "涉及人名、负责人、说话人时，优先使用说话人候选和转录标签；"
            "不要把候选名单外的人名强行写成负责人。\n"
            "带说话人标签的转录：\n"
            "---\n"
            "{{speaker_transcript}}\n"
            "---\n\n"
            f"{snapshot}"
        )

    # Single-pass substitution via a throwaway Prompt-shaped object so we
    # share the PromptsCache.render() codepath (and test coverage).
    from prompts.db import Prompt, Category, Source
    snapshot_prompt = Prompt(
        id=prompt_id or "snapshot",
        slug=prompt_slug,
        name=prompt_name,
        category=Category.SUMMARY,
        content=snapshot,
        is_auto_run=False,
        source=Source.MANUAL,
        sort_order=0,
        note=None,
        created_at="",
        updated_at="",
    )
    rendered = cache.render(
        snapshot_prompt,
        transcript=transcript_text,
        meeting_title=title,
        date=date,
        my_transcript=my_transcript,
        their_transcript=their_transcript,
        speaker_transcript=speaker_transcript,
        speaker_list=speaker_list,
    )

    # cleanup slug writes back to transcript_path
    is_cleanup = (prompt_slug == "transcript-cleanup")
    output_path_str = str(transcript_path) if is_cleanup else str(summary_path)

    # Record start in SummariesRepo (short-lived connection)
    conn = open_db(prompts_db)
    try:
        srepo = SummariesRepo(conn)
        sid = srepo.start(
            audio_path=audio_path_str,
            prompt_id=prompt_id,
            prompt_slug=prompt_slug,
            prompt_name=prompt_name,
            prompt_content=snapshot,
            output_path=output_path_str,
            model=(llm_command[0] if llm_command else None),
        )
        srepo.mark_running(sid)
    finally:
        conn.close()

    # Run LLM
    t0 = time.monotonic()
    try:
        output = _run_llm(rendered, llm_command, timeout_sec)
    except Exception as exc:
        conn = open_db(prompts_db)
        try:
            SummariesRepo(conn).mark_error(sid, error=str(exc)[:1000])
        finally:
            conn.close()
        raise
    duration_ms = int((time.monotonic() - t0) * 1000)

    # Write output to disk
    output_path = Path(output_path_str)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(output, encoding="utf-8")

    # Best-effort search-index push. Writer-hook failures must NEVER break
    # the recording / summary pipeline — the sweep on the reader side will
    # pick up anything we miss here.
    try:
        from search import indexer as _search_indexer
        # Every recording is a meeting now (voicemails were unified in).
        search_kind = (
            _search_indexer.KIND_MEETING_TRANSCRIPT
            if is_cleanup else _search_indexer.KIND_MEETING_SUMMARY
        )
        _search_indexer.upsert_doc(
            source_path=output_path, kind=search_kind, body=output,
        )
    except Exception as exc:
        _log(f"search index upsert failed for {output_path}: {exc}")

    # HTML artifact: only for summary-category prompts that produce a .md
    html_path = ""
    if not is_cleanup and transcript_path.exists():
        try:
            from html_artifact import write_meeting_summary_html
            html_path = str(write_meeting_summary_html(
                summary_path,
                transcript_path,
                summary_path.with_suffix(".html"),
                title=title or summary_path.stem,
            ))
        except Exception as exc:
            _log(f"html generation failed slug={prompt_slug!r}: {exc}")

    # Record done
    conn = open_db(prompts_db)
    try:
        SummariesRepo(conn).mark_done(
            sid,
            duration_ms=duration_ms,
            word_count=len((output or "").split()),
            html_path=html_path or None,
        )
    finally:
        conn.close()

    # Mutate entry for queue state update by caller
    entry["status"] = "done"
    entry["processed_by"] = WORKER_NAME
    entry["processed_at"] = _now()
    if html_path:
        entry["html_path"] = html_path
    entry.pop("error", None)

    # Summary-ready notification (best-effort, post-persistence).
    # Fires only for the default auto-run summary slug.
    _maybe_summary_notify(
        summary_path=Path(str(entry.get("summary_path", ""))),
        prompt_slug=prompt_slug,
    )

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
    prompts_db: Path = PROMPTS_DB,
) -> int:
    queue_path = Path(queue_path)
    if llm_command is None:
        llm_command = _load_llm_command()
    if not llm_command:
        _log("llm.command not configured; leaving summary_request events for an external agent")
        return 0

    # Lazy import to keep tests fast that don't exercise the LLM path.
    from prompts.cache import PromptsCache
    cache = PromptsCache(prompts_db)
    cache.load()

    processed = 0
    while True:
        global _RELOAD_PROMPTS
        if _RELOAD_PROMPTS:
            cache.reload()
            _RELOAD_PROMPTS = False
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
            _handle_summary_request(
                entry, llm_command, timeout_sec,
                cache=cache, prompts_db=prompts_db,
            )
            if dispatch_output and entry.get("prompt_slug", "summary") == "summary":
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

    try:
        signal.signal(signal.SIGHUP, _handle_sighup)
    except (ValueError, OSError):
        # Non-main thread or unsupported platform; ignore.
        pass

    count = process_queue_once(queue_path=args.queue, timeout_sec=args.timeout, dispatch_output=True)
    if count:
        print(f"processed {count} summary_request event(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
