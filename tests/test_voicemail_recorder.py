"""Voicemail recorder: post-stop transcribe + enqueue pipeline.

These tests stub the daemon socket and the prompts cache so the recorder
logic can be tested without launching audio_daemon / stt_daemon."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import voicemail.recorder as recorder
import queue_store


@pytest.fixture
def isolated_paths(tmp_path, monkeypatch):
    queue = tmp_path / "queue.json"
    lock = tmp_path / "queue.lock"
    prompts_db = tmp_path / "prompts.sqlite"
    monkeypatch.setattr(recorder, "AGENT_QUEUE_PATH", queue)
    monkeypatch.setattr(recorder, "PROMPTS_DB", prompts_db)
    monkeypatch.setattr(queue_store, "QUEUE_PATH", queue)
    monkeypatch.setattr(queue_store, "LOCK_PATH", lock)

    # Initialize empty queue file so tests can read it even when nothing
    # was appended (e.g. the daemon-error path).
    queue.write_text("[]", encoding="utf-8")

    # Seed prompts so the cache returns voicemail prompts
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    repo = PromptsRepo(open_db(prompts_db))
    seed_from_current(repo)
    return queue, prompts_db


def test_transcribe_writes_mic_text_only(isolated_paths, tmp_path, monkeypatch):
    queue, prompts_db = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()

    fake_response = {
        "status": "ok",
        "layout": "dual_track",
        "channels": {
            "mic": {"text": "嗯 记得明天找 Anthropic 团队",
                    "segments": [{"start": 0.0, "end": 2.0,
                                  "text": "嗯 记得明天找 Anthropic 团队"}]},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        recorder._transcribe_and_enqueue(wav, title=None)

    # No speaker tag — single-speaker voicemail
    transcript_text = (wav.with_suffix(".transcript.txt")).read_text(encoding="utf-8")
    assert transcript_text == "嗯 记得明天找 Anthropic 团队"
    # raw mirrors transcript (pre-cleanup snapshot)
    raw = (wav.with_suffix(".raw.transcript.txt")).read_text(encoding="utf-8")
    assert raw == transcript_text
    # NO mic/sys siblings for voicemails (mono-equivalent)
    assert not wav.with_suffix(".mic.transcript.txt").exists()
    assert not wav.with_suffix(".sys.transcript.txt").exists()


def test_transcribe_writes_title_sidecar_when_provided(isolated_paths, tmp_path, monkeypatch):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {
        "status": "ok",
        "channels": {
            "mic": {"text": "hi", "segments": []},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        recorder._transcribe_and_enqueue(wav, title="Anthropic follow-up")
    sidecar = wav.with_suffix(".title")
    assert sidecar.read_text(encoding="utf-8") == "Anthropic follow-up\n"


def test_enqueues_only_voicemail_category_prompts(isolated_paths, tmp_path, monkeypatch):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {
        "status": "ok",
        "channels": {
            "mic": {"text": "hi", "segments": [{"start": 0.0, "end": 1.0, "text": "hi"}]},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        recorder._transcribe_and_enqueue(wav, title=None)
    events = json.loads(queue.read_text(encoding="utf-8"))
    # Only voicemail-todos (auto-run); voicemail-clean is opt-in
    slugs = [e["prompt_slug"] for e in events]
    assert slugs == ["voicemail-todos"]
    assert events[0]["audio_path"] == str(wav)
    # summary_path is <wav>.summary.md (default-slug convention from Phase 2)
    assert events[0]["summary_path"] == str(wav.with_suffix(".summary.md"))


def test_transcribe_handles_legacy_response_shape(isolated_paths, tmp_path, monkeypatch):
    """If stt_daemon returns the legacy single-text shape (channel_split=False),
    use response['text'] directly."""
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {"status": "ok", "layout": "mono",
                     "text": "legacy text", "segments": []}
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        recorder._transcribe_and_enqueue(wav, title=None)
    assert wav.with_suffix(".transcript.txt").read_text(encoding="utf-8") == "legacy text"


def test_transcribe_handles_daemon_error_gracefully(isolated_paths, tmp_path, monkeypatch):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {"status": "error", "error": "daemon dead"}
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        rc = recorder._transcribe_and_enqueue(wav, title=None)
    assert rc != 0
    assert not wav.with_suffix(".transcript.txt").exists()
    events = json.loads(queue.read_text(encoding="utf-8"))
    assert events == []


def test_cmd_new_sends_start_with_sys_disabled_and_silence_seconds(
    isolated_paths, tmp_path, monkeypatch,
):
    """cmd_new must invoke the daemon with sys_disabled=True and a
    3-second silence_seconds; must acquire the recording lock; must
    block until the recording state flips to not-recording."""
    queue, _ = isolated_paths
    # Redirect VOICEMAIL_DIR to tmp_path so the wav lands somewhere we control
    monkeypatch.setattr(recorder, "VOICEMAIL_DIR", tmp_path)

    wav_path = tmp_path / "voicemail_20260523_201500.wav"
    # The post-stop pipeline checks wav existence — touch it now so the
    # success branch is reachable.
    wav_path.touch()

    sent: list[dict] = []
    status_responses = iter([
        {"recording": True, "file": str(wav_path)},
        {"recording": True, "file": str(wav_path)},
        {"recording": False, "file": str(wav_path)},
    ])

    def fake_socket_send(cmd):
        sent.append(cmd)
        if cmd.get("action") == "status":
            return next(status_responses)
        if cmd.get("action") == "start":
            return {"status": "recording", "file": str(wav_path)}
        if cmd.get("action") == "stop":
            return {"status": "stopped", "file": str(wav_path)}
        return None

    fake_response = {
        "status": "ok",
        "channels": {
            "mic": {"text": "test memo",
                    "segments": [{"start": 0.0, "end": 1.0, "text": "test memo"}]},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }

    monkeypatch.setattr(recorder, "_socket_send", fake_socket_send)
    monkeypatch.setattr(recorder, "_poll_interval", 0.01)
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        rc = recorder.cmd_new(title="MyMemo")

    assert rc == 0
    # First non-status RPC is the start
    starts = [c for c in sent if c.get("action") == "start"]
    assert len(starts) == 1
    assert starts[0]["sys_disabled"] is True
    assert starts[0]["silence_seconds"] == 3
    # Literal "voicemail" — Swift appends its own _YYYYMMDD_HHMMSS suffix
    # after stripping non-alphanumerics. See recorder.py::cmd_new.
    assert starts[0]["title"] == "voicemail"
    assert starts[0]["output_dir"] == str(tmp_path)

    # Title sidecar landed
    assert (wav_path.with_suffix(".title")).exists()


def test_cmd_new_returns_2_on_busy(tmp_path, monkeypatch, capsys):
    """If the recording_lock acquire raises RecordingBusy at __enter__,
    cmd_new exits 2 with a friendly Chinese error mentioning the in-flight
    recording. The mock must be a real @contextmanager so the raise fires
    at __enter__ (matching production); a plain function that raises at
    call time would pass even when cmd_new wraps the bare acquire() in
    try/except instead of the with-block."""
    from contextlib import contextmanager
    from recording_lock import RecordingBusy
    monkeypatch.setattr(recorder, "VOICEMAIL_DIR", tmp_path)

    @contextmanager
    def fake_acquire(*args, **kwargs):
        raise RecordingBusy({
            "title": "ProductWeekly", "path": "/tmp/foo.wav",
            "started_at": "2026-05-23T12:00:00",
        })
        yield  # unreachable; makes this a generator so @contextmanager applies
    monkeypatch.setattr(recorder, "_acquire_recording_lock", fake_acquire)

    rc = recorder.cmd_new()
    assert rc == 2
    err = capsys.readouterr().err
    assert "录音正在进行中: ProductWeekly" in err
    assert "/tmp/foo.wav" in err
    assert "2026-05-23T12:00:00" in err


def test_cmd_stop_idempotent_when_not_recording(monkeypatch):
    """If status reports not-recording, cmd_stop exits 0 without sending
    a stop RPC."""
    sent: list[dict] = []
    def fake_socket_send(cmd):
        sent.append(cmd)
        if cmd.get("action") == "status":
            return {"recording": False, "file": ""}
        return None
    monkeypatch.setattr(recorder, "_socket_send", fake_socket_send)
    rc = recorder.cmd_stop()
    assert rc == 0
    assert all(c.get("action") != "stop" for c in sent)


def test_transcribe_pushes_to_search_index(isolated_paths, tmp_path, monkeypatch):
    """B.3 hook: after the voicemail transcript lands on disk, the search
    indexer is called with kind=voicemail_transcript and the same body."""
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {
        "status": "ok",
        "channels": {
            "mic": {"text": "memo body",
                    "segments": [{"start": 0.0, "end": 1.0, "text": "memo body"}]},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }

    calls: list[dict] = []
    from search import indexer as search_indexer
    monkeypatch.setattr(
        search_indexer, "upsert_doc",
        lambda **kw: calls.append(kw) or True,
    )

    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        recorder._transcribe_and_enqueue(wav, title=None)

    assert len(calls) == 1
    assert calls[0]["kind"] == search_indexer.KIND_VOICEMAIL_TRANSCRIPT
    assert calls[0]["source_path"] == wav.with_suffix(".transcript.txt")
    assert calls[0]["body"] == "memo body"


def test_transcribe_swallows_search_index_failure(isolated_paths, tmp_path,
                                                  monkeypatch, capsys):
    """B.3 hook contract: search-indexer raising must not break the
    voicemail pipeline. The transcript still lands on disk; the prompt
    queue still gets the request; rc==0."""
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {
        "status": "ok",
        "channels": {
            "mic": {"text": "memo body",
                    "segments": [{"start": 0.0, "end": 1.0, "text": "memo body"}]},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }

    from search import indexer as search_indexer
    monkeypatch.setattr(
        search_indexer, "upsert_doc",
        lambda **_kw: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        rc = recorder._transcribe_and_enqueue(wav, title=None)
    assert rc == 0
    assert wav.with_suffix(".transcript.txt").exists()
    events = json.loads(queue.read_text(encoding="utf-8"))
    assert len(events) >= 1
    err = capsys.readouterr().err
    assert "search index upsert failed" in err


def test_cmd_stop_sends_stop_when_recording(monkeypatch):
    sent: list[dict] = []
    def fake_socket_send(cmd):
        sent.append(cmd)
        if cmd.get("action") == "status":
            return {"recording": True, "file": "/tmp/voicemail_20260523_201500.wav"}
        if cmd.get("action") == "stop":
            return {"status": "stopped",
                    "file": "/tmp/voicemail_20260523_201500.wav"}
        return None
    monkeypatch.setattr(recorder, "_socket_send", fake_socket_send)
    rc = recorder.cmd_stop()
    assert rc == 0
    assert any(c.get("action") == "stop" for c in sent)


def test_promote_strips_speaker_tags_and_finalizes(isolated_paths, tmp_path):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260528_120000.wav"
    wav.touch()
    wav.with_suffix(".realtime.transcript.txt").write_text(
        "[Me] line one\n[Me] line two\n", encoding="utf-8")

    rc = recorder._promote_realtime_transcript(wav, title=None)

    assert rc == 0
    assert wav.with_suffix(".transcript.txt").read_text(encoding="utf-8") == "line one\nline two"
    assert wav.with_suffix(".raw.transcript.txt").read_text(encoding="utf-8") == "line one\nline two"
    events = json.loads(queue.read_text(encoding="utf-8"))
    assert [e["prompt_slug"] for e in events] == ["voicemail-todos"]


def test_promote_returns_2_when_realtime_missing(isolated_paths, tmp_path):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260528_120000.wav"
    wav.touch()

    rc = recorder._promote_realtime_transcript(wav, title=None)

    assert rc == 2
    assert not wav.with_suffix(".transcript.txt").exists()
    assert json.loads(queue.read_text(encoding="utf-8")) == []


def test_promote_returns_2_when_realtime_empty(isolated_paths, tmp_path):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260528_120000.wav"
    wav.touch()
    wav.with_suffix(".realtime.transcript.txt").write_text("[Me]\n   \n", encoding="utf-8")

    rc = recorder._promote_realtime_transcript(wav, title=None)

    assert rc == 2
    assert not wav.with_suffix(".transcript.txt").exists()


def test_promote_pushes_stripped_body_to_search_index(isolated_paths, tmp_path, monkeypatch):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260528_120000.wav"
    wav.touch()
    wav.with_suffix(".realtime.transcript.txt").write_text("[Me] hello world\n", encoding="utf-8")

    calls: list[dict] = []
    from search import indexer as search_indexer
    monkeypatch.setattr(search_indexer, "upsert_doc", lambda **kw: calls.append(kw) or True)

    rc = recorder._promote_realtime_transcript(wav, title=None)

    assert rc == 0
    assert len(calls) == 1
    assert calls[0]["kind"] == search_indexer.KIND_VOICEMAIL_TRANSCRIPT
    assert calls[0]["body"] == "hello world"
