import json
import os
import subprocess
import sys
from pathlib import Path

from socket_helpers import cleanup_socket_path, short_socket_path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from configure import FULL_MODE, FAST_MODE, set_engine, set_mode
from transcribe import normalize_post_recording_mode, read_realtime_transcript


def write_config(path):
    path.write_text(json.dumps({"transcription": {"language": "zh"}}, ensure_ascii=False), encoding="utf-8")


def test_post_recording_mode_aliases():
    assert normalize_post_recording_mode("fast") == FAST_MODE
    assert normalize_post_recording_mode("realtime") == FAST_MODE
    assert normalize_post_recording_mode("full") == FULL_MODE
    assert normalize_post_recording_mode("quality") == FULL_MODE


def test_realtime_transcript_rejects_agent_event_json(tmp_path):
    transcript = tmp_path / "meeting.realtime.transcript.txt"
    transcript.write_text(
        json.dumps([
            {"type": "realtime_transcript_error", "title": "Weekly"},
            {"type": "realtime_transcript_ready", "title": "Weekly"},
        ], ensure_ascii=False),
        encoding="utf-8",
    )

    assert read_realtime_transcript(transcript) is None


def test_configure_sets_fast_and_full_modes(tmp_path):
    cfg = tmp_path / "config.json"
    write_config(cfg)

    set_mode("full", path=cfg)
    data = json.loads(cfg.read_text(encoding="utf-8"))
    assert data["transcription"]["post_recording_mode"] == FULL_MODE

    set_mode("fast", path=cfg)
    data = json.loads(cfg.read_text(encoding="utf-8"))
    assert data["transcription"]["post_recording_mode"] == FAST_MODE


def test_configure_sets_mlx_engine_for_final_and_realtime(tmp_path):
    cfg = tmp_path / "config.json"
    write_config(cfg)

    set_engine("mlx", "mlx-community/whisper-large-v3-mlx", path=cfg)

    trans = json.loads(cfg.read_text(encoding="utf-8"))["transcription"]
    assert trans["final_engine"] == "mlx"
    assert trans["mlx"]["model"] == "mlx-community/whisper-large-v3-mlx"
    assert trans["mlx"]["final_model"] == "mlx-community/whisper-large-v3-mlx"
    assert trans["mlx"]["preprocess_audio"] is True
    assert trans["realtime"]["engine"] == "mlx"
    # Realtime/live captions run a FAST model independent of the (here: slow
    # large-v3) FINAL model, so the live tail keeps up with wall-clock audio.
    # Picking large-v3 for the final pass must NOT drag realtime down with it.
    assert trans["realtime"]["mlx_model"] == "mlx-community/whisper-large-v3-turbo"
    assert trans["realtime"]["chunk_sec"] == 15
    assert trans["realtime"]["chunk_max_sec"] == 30


def test_configure_respects_explicit_realtime_model_override(tmp_path):
    """If a user has already set a realtime model, set_engine must not stomp it."""
    cfg = tmp_path / "config.json"
    write_config(cfg)
    # Pre-seed an explicit realtime model.
    import json as _json
    data = _json.loads(cfg.read_text(encoding="utf-8"))
    data.setdefault("transcription", {}).setdefault("realtime", {})["mlx_model"] = \
        "mlx-community/whisper-small-mlx"
    cfg.write_text(_json.dumps(data), encoding="utf-8")

    set_engine("mlx", "mlx-community/whisper-large-v3-mlx", path=cfg)

    trans = json.loads(cfg.read_text(encoding="utf-8"))["transcription"]
    assert trans["realtime"]["mlx_model"] == "mlx-community/whisper-small-mlx"


def test_configure_mlx_engine_does_not_resurrect_dead_python_marker(tmp_path):
    # v0.6.0 removed the dedicated venv; migrate/detect.py treats a lingering
    # transcription.mlx.python as a v0.5.x-stale signal. configure.py must NOT
    # write it back, or every install would look un-migrated on each upgrade.
    cfg = tmp_path / "config.json"
    write_config(cfg)

    set_engine("mlx", path=cfg)

    mlx = json.loads(cfg.read_text(encoding="utf-8"))["transcription"]["mlx"]
    assert "python" not in mlx


def test_configure_sets_whisper_engine_command(tmp_path):
    cfg = tmp_path / "config.json"
    write_config(cfg)
    model = tmp_path / "ggml-large-v3.bin"

    set_engine("whisper", str(model), path=cfg)

    trans = json.loads(cfg.read_text(encoding="utf-8"))["transcription"]
    assert trans["final_engine"] == "whisper"
    assert trans["local_model_path"] == str(model)
    assert trans["realtime"]["engine"] == "whisper"
    assert "{{input}}" in trans["command"]


def _run_shell_migration(tmp_path):
    script = SCRIPTS / "setup_capabilities.sh"
    return subprocess.run(
        ["bash", "-c", f'source "{script}"; migrate_realtime_config'],
        env={**os.environ, "CONFIG_DIR": str(tmp_path), "PYTHON_BIN": sys.executable},
        capture_output=True,
        text=True,
    )


def test_shell_migration_rewrites_stale_realtime_config(tmp_path):
    """B1 regression: setup_capabilities.sh::migrate_realtime_config must actually
    RUN on upgrade and rewrite an EXISTING config's stale large-v3 realtime model →
    turbo, plus clamp chunk_sec <= chunk_max_sec. The migration used to be dead code
    that nothing called, so upgraders silently kept the slow model and a chunk_sec
    that disabled the backlog cap. This test FAILS against the pre-fix code (the
    function did not exist → bash exits non-zero)."""
    cfg = tmp_path / "config.json"
    cfg.write_text(
        json.dumps(
            {
                "transcription": {
                    "final_engine": "mlx",
                    "mlx": {"model": "mlx-community/whisper-large-v3-mlx"},
                    "realtime": {
                        "engine": "mlx",
                        "mlx_model": "mlx-community/whisper-large-v3-mlx",
                        "chunk_sec": 60,
                    },
                }
            }
        ),
        encoding="utf-8",
    )
    result = _run_shell_migration(tmp_path)
    assert result.returncode == 0, result.stderr
    rt = json.loads(cfg.read_text(encoding="utf-8"))["transcription"]["realtime"]
    assert rt["mlx_model"] == "mlx-community/whisper-large-v3-turbo"
    assert rt["chunk_sec"] == 15
    assert rt["chunk_max_sec"] == 30


def test_shell_migration_is_idempotent_and_nondestructive(tmp_path):
    """A config already on turbo with sane chunk bounds must be left untouched —
    the migration must never clobber a user's good realtime config."""
    cfg = tmp_path / "config.json"
    cfg.write_text(
        json.dumps(
            {
                "transcription": {
                    "final_engine": "mlx",
                    "mlx": {"model": "mlx-community/whisper-large-v3-mlx"},
                    "realtime": {
                        "engine": "mlx",
                        "mlx_model": "mlx-community/whisper-large-v3-turbo",
                        "chunk_sec": 15,
                        "chunk_max_sec": 30,
                    },
                }
            }
        ),
        encoding="utf-8",
    )
    assert _run_shell_migration(tmp_path).returncode == 0
    rt = json.loads(cfg.read_text(encoding="utf-8"))["transcription"]["realtime"]
    assert rt["mlx_model"] == "mlx-community/whisper-large-v3-turbo"
    assert rt["chunk_sec"] == 15
    assert rt["chunk_max_sec"] == 30


def test_transcribe_coverage_guard_blocks_truncated_realtime(tmp_path, monkeypatch):
    """transcribe._realtime_coverage_ok must reject a realtime transcript that covered
    materially less than the recording, so fast_summary mode does NOT reuse a
    truncated transcript as the final (the 1-hour-meeting-truncated-to-1-minute bug),
    while staying permissive when coverage is unmeasurable (back-compat). FAILS
    against the pre-fix code (the guard did not exist)."""
    import transcribe
    import realtime_coverage

    wav = tmp_path / "rec.wav"
    wav.write_bytes(b"\x00")  # contents irrelevant; duration is monkeypatched
    # transcribe._realtime_coverage_ok IS realtime_coverage.realtime_coverage_ok (shared
    # module, one source of truth), so patch the duration helper on the shared module.
    monkeypatch.setattr(realtime_coverage, "wav_duration_sec", lambda p: 3600.0)
    cov = wav.with_suffix(".realtime.coverage.json")

    # No coverage sidecar → unmeasurable → don't block (preserve prior behavior).
    assert transcribe._realtime_coverage_ok(wav) is True
    # Live tail only covered 60s of a 3600s recording → block (would lose ~59 min).
    cov.write_text(json.dumps({"covered_ms": 60_000}), encoding="utf-8")
    assert transcribe._realtime_coverage_ok(wav) is False
    # Live tail covered nearly the whole recording → safe to reuse.
    cov.write_text(json.dumps({"covered_ms": 3_590_000}), encoding="utf-8")
    assert transcribe._realtime_coverage_ok(wav) is True


def test_transcribe_client_reads_large_response():
    """A full transcript of a long recording is ONE JSON line far larger than
    asyncio's default 64 KiB StreamReader limit. _send_once must read it instead of
    raising 'Separator is not found, and chunk exceed the limit' — which silently
    broke full (re)transcription of hour-long recordings. FAILS against pre-fix code."""
    import asyncio
    from transcribe_client import _send_once

    big_text = "x" * (256 * 1024)  # 256 KiB, well over the 64 KiB default limit
    # AF_UNIX paths are capped (~104 chars on macOS); pytest's tmp_path is too long,
    # so bind the test socket under the shared short socket directory.
    sock = short_socket_path("s")

    async def handle(reader, writer):
        await reader.readline()  # consume the request line
        writer.write((json.dumps({"text": big_text}) + "\n").encode())
        await writer.drain()
        writer.close()

    async def run():
        server = await asyncio.start_unix_server(handle, path=str(sock))
        try:
            return await _send_once(
                sock, {"action": "ping"}, timeout=5.0, response_timeout=5.0
            )
        finally:
            server.close()
            await server.wait_closed()

    try:
        resp = asyncio.run(run())
        assert resp["text"] == big_text
    finally:
        cleanup_socket_path(sock)
