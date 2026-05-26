import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from queue_store import append_event, claim_summary_request, load_queue, update_event


def test_append_claim_and_update_summary_request(tmp_path):
    queue_path = tmp_path / "agent-queue.json"

    entry = append_event(
        "summary_request",
        path=queue_path,
        title="Queue Meeting",
        transcript_path="/tmp/t.txt",
        summary_path="/tmp/s.md",
    )

    claimed = claim_summary_request(path=queue_path, worker_name="test-worker")
    assert claimed["id"] == entry["id"]
    assert claimed["status"] == "processing"
    assert claimed["processing_by"] == "test-worker"

    updated = update_event(claimed["id"], {"status": "done"}, path=queue_path)
    assert updated is True
    queue = load_queue(queue_path)
    assert queue[0]["status"] == "done"


def test_invalid_queue_is_replaced_with_valid_json(tmp_path):
    queue_path = tmp_path / "agent-queue.json"
    queue_path.write_text("{not-json", encoding="utf-8")

    append_event("transcribing", path=queue_path, title="Recovered")

    queue = json.loads(queue_path.read_text(encoding="utf-8"))
    assert len(queue) == 1
    assert queue[0]["type"] == "transcribing"


def test_legacy_and_new_summary_request_shapes_coexist(tmp_path):
    """Schema evolution: summary_request grew prompt_id/prompt_slug/prompt_name/
    prompt_content_snapshot/audio_path/html_path_hint. The queue store is a
    pass-through dict-merge so both shapes are valid; consumer-side fallback
    is tested in test_agent_queue_worker_prompts.py."""
    queue_path = tmp_path / "agent-queue.json"

    # Legacy shape (pre-spec; missing prompt_* fields)
    append_event(
        "summary_request", path=queue_path,
        title="Old Meeting",
        transcript_path="/tmp/t.txt",
        summary_path="/tmp/s.md",
    )
    # New shape (post-spec; full snapshot)
    append_event(
        "summary_request", path=queue_path,
        title="New Meeting",
        audio_path="/tmp/a.wav",
        transcript_path="/tmp/t.txt",
        summary_path="/tmp/s.md",
        html_path_hint="/tmp/s.html",
        prompt_id="pid-1",
        prompt_slug="summary",
        prompt_name="Standard Summary",
        prompt_content_snapshot="please summarize {{transcript}}",
    )

    queue = load_queue(queue_path)
    assert len(queue) == 2
    legacy = next(e for e in queue if e["title"] == "Old Meeting")
    new = next(e for e in queue if e["title"] == "New Meeting")
    assert "prompt_id" not in legacy
    assert new["prompt_id"] == "pid-1"
    assert new["prompt_content_snapshot"] == "please summarize {{transcript}}"
    assert new["html_path_hint"] == "/tmp/s.html"
