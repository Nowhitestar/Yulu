import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from agent_queue_worker import _is_valid_summary, _load_llm_command, process_queue_once
from prompts import PromptsRepo, Category, open_db


def valid_summary_text():
    return (
        "# 最终纪要\n\n"
        "## TL;DR\n"
        "AgentKey 会议明确了激活用户作为北极星指标。" + "补充说明" * 80 + "\n\n"
        "## Discussion Points\n"
        "- 讨论增长、SEO、Sponsor、社群和付费转化。\n\n"
        "## Action Items\n"
        "- [ ] @Lewis - 跟进后台数据权限。\n\n"
        "## Open Questions / Blockers\n"
        "- 后台口径还需确认。\n\n"
        "## Decisions Made\n"
        "- 激活用户优先于注册用户。\n"
    )


def _setup_prompts_db(tmp_path: Path) -> Path:
    """Create a minimal prompts.sqlite with the default 'summary' slug."""
    prompts_db = tmp_path / "prompts.sqlite"
    repo = PromptsRepo(open_db(prompts_db))
    repo.add(
        slug="summary",
        name="Standard Summary",
        category=Category.SUMMARY,
        content="summarize: {{transcript}}",
        is_auto_run=True,
    )
    return prompts_db


def write_fake_llm(tmp_path, output):
    llm = tmp_path / "fake_llm.py"
    llm.write_text(
        "import sys\n"
        "prompt = sys.stdin.read()\n"
        "assert 'AgentKey' in prompt\n"
        f"print({output!r})\n",
        encoding="utf-8",
    )
    return llm


def test_processes_summary_request_writes_summary_marks_done_and_refreshes_html(tmp_path):
    prompts_db = _setup_prompts_db(tmp_path)
    transcript = tmp_path / "meeting.transcript.txt"
    transcript.write_text("[00:00] 我们讨论了 AgentKey。需要 Lewis 跟进安装。", encoding="utf-8")
    summary = tmp_path / "meeting.summary.md"
    template = tmp_path / "summary_template.md"
    template.write_text("## TL;DR\n## Discussion Points\n## Action Items", encoding="utf-8")
    llm = write_fake_llm(tmp_path, valid_summary_text())
    queue_path = tmp_path / "agent-queue.json"
    queue_path.write_text(json.dumps([
        {
            "type": "summary_request",
            "ts": "2026-05-09T21:00:00",
            "title": "AgentKey 安装讨论",
            "transcript_path": str(transcript),
            "summary_path": str(summary),
            "template_path": str(template),
        }
    ], ensure_ascii=False), encoding="utf-8")

    processed = process_queue_once(
        queue_path=queue_path,
        llm_command=[sys.executable, str(llm)],
        timeout_sec=5,
        prompts_db=prompts_db,
    )

    assert processed == 1
    assert summary.read_text(encoding="utf-8") == valid_summary_text()
    assert summary.with_suffix(".html").exists()
    queue = json.loads(queue_path.read_text(encoding="utf-8"))
    assert queue[0]["status"] == "done"
    assert queue[0]["processed_by"] == "yulu-agent-queue-worker"
    assert "processed_at" in queue[0]
    assert queue[0]["html_path"] == str(summary.with_suffix(".html"))


def test_invalid_agent_event_json_marks_error_and_does_not_overwrite_existing_summary(tmp_path):
    prompts_db = _setup_prompts_db(tmp_path)
    transcript = tmp_path / "meeting.transcript.txt"
    transcript.write_text("[00:00] AgentKey 增长会议", encoding="utf-8")
    summary = tmp_path / "meeting.summary.md"
    summary.write_text("existing summary", encoding="utf-8")
    llm = write_fake_llm(tmp_path, json.dumps([{"type": "summary_ready"}], ensure_ascii=False))
    queue_path = tmp_path / "agent-queue.json"
    queue_path.write_text(json.dumps([
        {
            "type": "summary_request",
            "title": "AgentKey",
            "transcript_path": str(transcript),
            "summary_path": str(summary),
        }
    ]), encoding="utf-8")

    processed = process_queue_once(
        queue_path=queue_path,
        llm_command=[sys.executable, str(llm)],
        timeout_sec=5,
        prompts_db=prompts_db,
    )

    assert processed == 0
    assert summary.read_text(encoding="utf-8") == "existing summary"
    queue = json.loads(queue_path.read_text(encoding="utf-8"))
    assert queue[0]["status"] == "error"
    assert "invalid summary" in queue[0]["error"]


def test_summary_guardrail_rejects_short_output_and_agent_queue_json():
    assert not _is_valid_summary("## TL;DR\n短")
    assert not _is_valid_summary('[{"type":"realtime_transcript_error"}]')
    assert _is_valid_summary(valid_summary_text())


def test_missing_transcript_marks_error_without_crashing(tmp_path):
    prompts_db = _setup_prompts_db(tmp_path)
    queue_path = tmp_path / "agent-queue.json"
    queue_path.write_text(json.dumps([
        {
            "type": "summary_request",
            "title": "missing",
            "transcript_path": str(tmp_path / "missing.txt"),
            "summary_path": str(tmp_path / "out.md"),
        }
    ]), encoding="utf-8")

    processed = process_queue_once(
        queue_path=queue_path,
        llm_command=[sys.executable, "-c", "print('unused')"],
        timeout_sec=5,
        prompts_db=prompts_db,
    )

    assert processed == 0
    queue = json.loads(queue_path.read_text(encoding="utf-8"))
    assert queue[0]["status"] == "error"
    assert "transcript not found" in queue[0]["error"]


def test_no_llm_command_leaves_request_pending(tmp_path):
    queue_path = tmp_path / "agent-queue.json"
    queue_path.write_text(json.dumps([
        {
            "type": "summary_request",
            "title": "pending",
            "transcript_path": str(tmp_path / "transcript.txt"),
            "summary_path": str(tmp_path / "out.md"),
        }
    ]), encoding="utf-8")

    processed = process_queue_once(queue_path=queue_path, llm_command=[], timeout_sec=5)

    assert processed == 0
    queue = json.loads(queue_path.read_text(encoding="utf-8"))
    assert "status" not in queue[0]


def test_load_llm_command_upgrades_legacy_codex_shim(tmp_path):
    cfg = tmp_path / "config.json"
    cfg.write_text(
        json.dumps({"llm": {"command": ["python3", "codex_llm.py"]}}),
        encoding="utf-8",
    )

    cmd = _load_llm_command(cfg)

    assert cmd == ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check"]
