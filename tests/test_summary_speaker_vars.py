"""Phase 13 Task 4 — the additive {{speaker_transcript}} / {{speaker_list}} prompt-var pair.

Locks criterion 2 (one additive pair, "" defaults, every existing prompt unchanged) and the data
half of criterion 3 (the summary prompt carries the speaker labels + roster so an agent can
attribute owners; export carries labels):

  * PromptsCache.render substitutes both new vars;
  * a legacy prompt that references NONE of the new vars renders byte-identically whether or not
    they are passed (the backward-compat contract);
  * agent_queue_worker reads <stem>.speakers.json and feeds the labelled transcript + roster into
    the rendered prompt;
  * absent sidecar → both vars are "" (degrade) and existing prompts still work.

speaker_merge.speaker_roster is also unit-tested (rename + merge resolution).
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from agent_queue_worker import process_queue_once  # noqa: E402
from prompts import PromptsRepo, Category, open_db  # noqa: E402
from prompts.cache import PromptsCache  # noqa: E402
from prompts.db import Prompt, Source  # noqa: E402
from prompts.seed import SEED_PROMPTS, seed_from_current  # noqa: E402
from stt_daemon import speaker_merge as sm  # noqa: E402


# ── render() substitutes the new pair ─────────────────────────────────────────


def _prompt(content: str) -> Prompt:
    return Prompt(id="p", slug="s", name="n", category=Category.SUMMARY, content=content,
                  is_auto_run=False, source=Source.MANUAL, sort_order=0, note=None,
                  created_at="", updated_at="")


def test_render_substitutes_speaker_vars(tmp_path):
    cache = PromptsCache(tmp_path / "x.sqlite")  # not loaded; render needs no DB
    p = _prompt("Roster: {{speaker_list}}\n---\n{{speaker_transcript}}")
    out = cache.render(p, transcript="", meeting_title="M", date="2026-06-01",
                       speaker_transcript="[00:00 Lewis] hi", speaker_list="Lewis, Speaker 2")
    assert "Roster: Lewis, Speaker 2" in out
    assert "[00:00 Lewis] hi" in out


def test_render_best_transcript_prefers_speaker_transcript(tmp_path):
    cache = PromptsCache(tmp_path / "x.sqlite")
    p = _prompt("BODY:\n{{best_transcript}}")
    with_speakers = cache.render(
        p,
        transcript="plain body",
        meeting_title="M",
        date="D",
        speaker_transcript="[00:00 Lewis] hi",
        speaker_list="Lewis",
    )
    without_speakers = cache.render(p, transcript="plain body", meeting_title="M", date="D")
    assert "Lewis" in with_speakers
    assert "plain body" not in with_speakers
    assert "BODY:\nplain body" == without_speakers


def test_legacy_prompt_unchanged_with_and_without_new_vars(tmp_path):
    cache = PromptsCache(tmp_path / "x.sqlite")
    legacy = _prompt("summarize: {{transcript}} ({{meeting_title}} {{date}})")
    without = cache.render(legacy, transcript="BODY", meeting_title="M", date="D")
    with_new = cache.render(legacy, transcript="BODY", meeting_title="M", date="D",
                            speaker_transcript="ignored", speaker_list="ignored")
    assert without == with_new == "summarize: BODY (M D)"
    # No stray placeholders leaked.
    assert "{{speaker" not in with_new


def test_seed_summary_prompts_use_speaker_aware_context():
    by_slug = {p["slug"]: p["content"] for p in SEED_PROMPTS}
    assert "{{speaker_list}}" in by_slug["summary"]
    assert "{{best_transcript}}" in by_slug["summary"]
    assert "{{best_transcript}}" in by_slug["transcript-cleanup"]


# ── speaker_roster resolution ─────────────────────────────────────────────────


def test_speaker_roster_resolves_rename_and_skips_merged():
    doc = {
        "segments": [
            {"start": 0.0, "end": 1.0, "speaker_id": "spk-0", "text": "a"},
            {"start": 1.0, "end": 2.0, "speaker_id": "spk-1", "text": "b"},
            {"start": 2.0, "end": 3.0, "speaker_id": "spk-2", "text": "c"},
        ],
        "speakers": {
            "spk-0": {"display_name": "Lewis", "renamed": True, "merged_into": None},
            "spk-1": {"display_name": "Speaker 2", "renamed": False, "merged_into": None},
            # spk-2 merged into spk-0 → resolves to "Lewis", skipped as a separate entry.
            "spk-2": {"display_name": "Speaker 3", "renamed": False, "merged_into": "spk-0"},
        },
    }
    roster = sm.speaker_roster(doc)
    assert roster == "Lewis, Speaker 2"


def test_speaker_roster_empty():
    assert sm.speaker_roster({"segments": [], "speakers": {}}) == ""


# ── worker feeds the vars from a sidecar ──────────────────────────────────────


def _setup_prompt(tmp_path: Path, content: str) -> Path:
    db = tmp_path / "prompts.sqlite"
    PromptsRepo(open_db(db)).add(slug="summary", name="Standard Summary",
                                 category=Category.SUMMARY, content=content, is_auto_run=True)
    return db


def _capturing_llm(tmp_path: Path, capture: Path) -> Path:
    """Fake LLM: writes the received prompt to `capture`, prints a valid (>=40 char) summary."""
    llm = tmp_path / "fake_llm.py"
    llm.write_text(
        "import sys\n"
        "prompt = sys.stdin.read()\n"
        f"open({str(capture)!r}, 'w', encoding='utf-8').write(prompt)\n"
        "print('# Summary\\n' + 'ok ' * 30)\n",
        encoding="utf-8",
    )
    return llm


def _make_sidecar(audio: Path):
    asr = [
        {"start": 0.0, "end": 2.0, "text": "你好"},
        {"start": 2.0, "end": 4.0, "text": "hello"},
    ]
    turns = [
        {"start": 0.0, "end": 2.0, "speaker_idx": 0},
        {"start": 2.0, "end": 4.0, "speaker_idx": 1},
    ]
    result = sm.assign_speakers(asr_segments=asr, turns=turns)
    # Rename spk-0 → Lewis so the roster shows a named owner.
    doc = sm.build_sidecar(result=result, turns=turns)
    first_sid = result.segments[0].speaker_id
    sm.apply_rename(doc, first_sid, "Lewis")
    sm.write_sidecar(sm.speakers_sidecar_path(audio), doc)


def test_worker_passes_speaker_vars_from_sidecar(tmp_path):
    db = _setup_prompt(tmp_path, "Roster={{speaker_list}}\nTRANSCRIPT:\n{{speaker_transcript}}")
    audio = tmp_path / "Team_20260601_100000.wav"
    audio.write_bytes(b"RIFF")
    transcript = audio.with_suffix(".transcript.txt")
    transcript.write_text("plain merged transcript", encoding="utf-8")
    _make_sidecar(audio)

    capture = tmp_path / "captured_prompt.txt"
    llm = _capturing_llm(tmp_path, capture)
    summary = audio.with_suffix(".summary.md")
    queue_path = tmp_path / "agent-queue.json"
    queue_path.write_text(json.dumps([{
        "type": "summary_request", "title": "Team", "prompt_slug": "summary",
        "audio_path": str(audio),
        "transcript_path": str(transcript), "summary_path": str(summary),
    }], ensure_ascii=False), encoding="utf-8")

    processed = process_queue_once(queue_path=queue_path,
                                   llm_command=[sys.executable, str(llm)],
                                   timeout_sec=10, prompts_db=db)
    assert processed == 1
    sent = capture.read_text(encoding="utf-8")
    assert "Roster=Lewis" in sent              # roster with the renamed owner
    assert "Lewis]" in sent                    # labelled transcript carried the rename
    assert "{{speaker" not in sent             # vars fully substituted


def test_worker_adds_speaker_context_for_legacy_prompt_from_sidecar(tmp_path):
    db = _setup_prompt(tmp_path, "BODY:{{transcript}}")
    audio = tmp_path / "Team_20260601_100000.wav"
    audio.write_bytes(b"RIFF")
    transcript = audio.with_suffix(".transcript.txt")
    transcript.write_text("plain merged transcript", encoding="utf-8")
    _make_sidecar(audio)

    capture = tmp_path / "captured_prompt.txt"
    llm = _capturing_llm(tmp_path, capture)
    summary = audio.with_suffix(".summary.md")
    queue_path = tmp_path / "agent-queue.json"
    queue_path.write_text(json.dumps([{
        "type": "summary_request", "title": "Team", "prompt_slug": "summary",
        "audio_path": str(audio),
        "transcript_path": str(transcript), "summary_path": str(summary),
    }], ensure_ascii=False), encoding="utf-8")

    processed = process_queue_once(queue_path=queue_path,
                                   llm_command=[sys.executable, str(llm)],
                                   timeout_sec=10, prompts_db=db)
    assert processed == 1
    sent = capture.read_text(encoding="utf-8")
    assert "说话人候选：Lewis" in sent
    assert "[00:00 Lewis]" in sent
    assert "BODY:plain merged transcript" in sent


def test_default_seed_summary_uses_speaker_sidecar(tmp_path):
    db = tmp_path / "prompts.sqlite"
    seed_from_current(PromptsRepo(open_db(db)))
    audio = tmp_path / "Team_20260601_100000.wav"
    audio.write_bytes(b"RIFF")
    transcript = audio.with_suffix(".transcript.txt")
    transcript.write_text("plain merged transcript", encoding="utf-8")
    _make_sidecar(audio)

    capture = tmp_path / "captured_prompt.txt"
    llm = _capturing_llm(tmp_path, capture)
    summary = audio.with_suffix(".summary.md")
    queue_path = tmp_path / "agent-queue.json"
    queue_path.write_text(json.dumps([{
        "type": "summary_request", "title": "Team", "prompt_slug": "summary",
        "audio_path": str(audio),
        "transcript_path": str(transcript), "summary_path": str(summary),
    }], ensure_ascii=False), encoding="utf-8")

    processed = process_queue_once(queue_path=queue_path,
                                   llm_command=[sys.executable, str(llm)],
                                   timeout_sec=10, prompts_db=db)
    assert processed == 1
    sent = capture.read_text(encoding="utf-8")
    assert "说话人候选：Lewis" in sent
    assert "[00:00 Lewis]" in sent
    assert "plain merged transcript" not in sent
    assert "{{best_transcript}}" not in sent


def test_worker_absent_sidecar_blanks_vars(tmp_path):
    db = _setup_prompt(tmp_path, "Roster=[{{speaker_list}}]\n{{speaker_transcript}}\nBODY:{{transcript}}")
    audio = tmp_path / "Team_20260601_100000.wav"
    audio.write_bytes(b"RIFF")
    transcript = audio.with_suffix(".transcript.txt")
    transcript.write_text("just the body", encoding="utf-8")
    # No .speakers.json written.

    capture = tmp_path / "captured_prompt.txt"
    llm = _capturing_llm(tmp_path, capture)
    summary = audio.with_suffix(".summary.md")
    queue_path = tmp_path / "agent-queue.json"
    queue_path.write_text(json.dumps([{
        "type": "summary_request", "title": "Team", "prompt_slug": "summary",
        "audio_path": str(audio),
        "transcript_path": str(transcript), "summary_path": str(summary),
    }], ensure_ascii=False), encoding="utf-8")

    processed = process_queue_once(queue_path=queue_path,
                                   llm_command=[sys.executable, str(llm)],
                                   timeout_sec=10, prompts_db=db)
    assert processed == 1
    sent = capture.read_text(encoding="utf-8")
    assert "Roster=[]" in sent                 # speaker_list defaulted to ""
    assert "BODY:just the body" in sent        # legacy {{transcript}} still works
    assert "{{speaker" not in sent
