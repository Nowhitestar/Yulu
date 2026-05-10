import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from agent_queue_worker import process_queue_once


def test_processes_summary_request_writes_summary_and_marks_done(tmp_path):
    transcript = tmp_path / "meeting.transcript.txt"
    transcript.write_text("我们讨论了 AgentKey。需要 Lewis 跟进安装。", encoding="utf-8")
    summary = tmp_path / "meeting.summary.md"
    template = tmp_path / "summary_template.md"
    template.write_text("## TL;DR\n## Action Items", encoding="utf-8")
    llm = tmp_path / "fake_llm.py"
    llm.write_text(
        "import sys\n"
        "prompt = sys.stdin.read()\n"
        "assert 'AgentKey' in prompt\n"
        "print('# 最终纪要\\n\\n- 已处理')\n",
        encoding="utf-8",
    )
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

    processed = process_queue_once(queue_path=queue_path, llm_command=[sys.executable, str(llm)], timeout_sec=5)

    assert processed == 1
    assert summary.read_text(encoding="utf-8") == "# 最终纪要\n\n- 已处理\n"
    queue = json.loads(queue_path.read_text(encoding="utf-8"))
    assert queue[0]["status"] == "done"
    assert queue[0]["processed_by"] == "yulu-agent-queue-worker"
    assert "processed_at" in queue[0]


def test_missing_transcript_marks_error_without_crashing(tmp_path):
    queue_path = tmp_path / "agent-queue.json"
    queue_path.write_text(json.dumps([
        {
            "type": "summary_request",
            "title": "missing",
            "transcript_path": str(tmp_path / "missing.txt"),
            "summary_path": str(tmp_path / "out.md"),
        }
    ]), encoding="utf-8")

    processed = process_queue_once(queue_path=queue_path, llm_command=[sys.executable, "-c", "print('unused')"], timeout_sec=5)

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
