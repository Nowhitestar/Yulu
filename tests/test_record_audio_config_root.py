import os
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"


def test_recording_commands_use_standard_durable_and_ipc_roots(tmp_path):
    durable_dir = tmp_path / "Library" / "Application Support" / "Yulu"
    cache_dir = tmp_path / "Library" / "Caches" / "Yulu"
    media_dir = tmp_path / "Movies" / "Yulu"
    env = {
        **os.environ,
        "PYTHONPATH": str(SCRIPTS),
        "YULU_APPLICATION_SUPPORT_DIR": str(durable_dir),
        "YULU_CACHE_DIR": str(cache_dir),
        "YULU_IPC_DIR": str(cache_dir),
        "YULU_MEDIA_LIBRARY_DIR": str(media_dir),
    }
    env.pop("YULU_CONFIG_DIR", None)
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import record_audio, recording_lock; "
            "print(record_audio.CONFIG_PATH); print(record_audio.SOCKET_PATH); "
            "print(record_audio.STATE_PATH); print(recording_lock.DEFAULT_LOCK_PATH)",
        ],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout.splitlines() == [
        str(durable_dir / "config.json"),
        str(cache_dir / "audio_daemon.sock"),
        str(durable_dir / ".state.json"),
        str(cache_dir / ".recording.lock"),
    ]


def test_recording_state_reads_legacy_but_writes_standard(monkeypatch, tmp_path):
    import record_audio

    standard = tmp_path / "Library" / "Application Support" / "Yulu" / ".state.json"
    legacy_root = tmp_path / ".config" / "yulu"
    legacy_root.mkdir(parents=True)
    legacy = legacy_root / ".state.json"
    legacy.write_text(
        '{"recording":true,"title":"Rollback meeting","audio_path":"/tmp/r.wav"}',
        encoding="utf-8",
    )
    original = legacy.read_bytes()
    monkeypatch.setattr(record_audio, "STATE_PATH", standard)
    monkeypatch.setattr(record_audio, "LEGACY_READ_ONLY_DATA_DIR", legacy_root, raising=False)

    assert record_audio.read_state()["title"] == "Rollback meeting"

    record_audio.write_state({"recording": False, "status": "idle"})
    assert standard.exists()
    assert legacy.read_bytes() == original


def test_recording_media_env_overrides_config_without_rewriting_it(tmp_path):
    durable_dir = tmp_path / "Library" / "Application Support" / "Yulu"
    cache_dir = tmp_path / "Library" / "Caches" / "Yulu"
    configured_media = tmp_path / "Configured Media" / "Yulu"
    environment_media = tmp_path / "Environment Media" / "Yulu"
    durable_dir.mkdir(parents=True)
    config_path = durable_dir / "config.json"
    config_path.write_text(
        json.dumps({"audio": {"output_dir": str(configured_media)}}),
        encoding="utf-8",
    )
    original = config_path.read_bytes()
    env = {
        **os.environ,
        "PYTHONPATH": str(SCRIPTS),
        "YULU_APPLICATION_SUPPORT_DIR": str(durable_dir),
        "YULU_CACHE_DIR": str(cache_dir),
        "YULU_IPC_DIR": str(cache_dir),
        "YULU_MEDIA_LIBRARY_DIR": str(environment_media),
    }

    result = subprocess.run(
        [sys.executable, "-c", "import record_audio; print(record_audio.load_config()['output_dir'])"],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout.strip() == str(environment_media)
    assert config_path.read_bytes() == original


def test_recording_rejects_relative_configured_media_path(tmp_path):
    durable_dir = tmp_path / "Library" / "Application Support" / "Yulu"
    cache_dir = tmp_path / "Library" / "Caches" / "Yulu"
    default_media = tmp_path / "Movies" / "Yulu"
    durable_dir.mkdir(parents=True)
    (durable_dir / "config.json").write_text(
        json.dumps({"audio": {"output_dir": "relative/repository-output"}}),
        encoding="utf-8",
    )
    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "PYTHONPATH": str(SCRIPTS),
        "YULU_APPLICATION_SUPPORT_DIR": str(durable_dir),
        "YULU_CACHE_DIR": str(cache_dir),
        "YULU_IPC_DIR": str(cache_dir),
    }
    env.pop("YULU_MEDIA_LIBRARY_DIR", None)

    result = subprocess.run(
        [sys.executable, "-c", "import record_audio; print(record_audio.load_config()['output_dir'])"],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout.strip() == str(default_media)


def test_recording_preserves_absolute_configured_media_path(tmp_path):
    durable_dir = tmp_path / "Library" / "Application Support" / "Yulu"
    cache_dir = tmp_path / "Library" / "Caches" / "Yulu"
    custom_media = tmp_path / "External Archive" / "Yulu"
    durable_dir.mkdir(parents=True)
    (durable_dir / "config.json").write_text(
        json.dumps({"audio": {"output_dir": str(custom_media)}}),
        encoding="utf-8",
    )
    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "PYTHONPATH": str(SCRIPTS),
        "YULU_APPLICATION_SUPPORT_DIR": str(durable_dir),
        "YULU_CACHE_DIR": str(cache_dir),
        "YULU_IPC_DIR": str(cache_dir),
    }
    env.pop("YULU_MEDIA_LIBRARY_DIR", None)

    result = subprocess.run(
        [sys.executable, "-c", "import record_audio; print(record_audio.load_config()['output_dir'])"],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout.strip() == str(custom_media)


def test_sox_fallback_creates_standard_ipc_parent(monkeypatch, tmp_path):
    import record_audio

    ipc_dir = tmp_path / "Library" / "Caches" / "Yulu"
    output_dir = tmp_path / "Movies" / "Yulu"
    monkeypatch.setattr(record_audio, "IPC_DIR", ipc_dir)
    monkeypatch.setattr(record_audio, "load_config", lambda: {
        "output_dir": str(output_dir),
        "system_audio_device": ":1",
        "mic_device": ":0",
    })
    monkeypatch.setattr(record_audio, "set_recording_started", lambda *_args, **_kwargs: None)

    class Process:
        pid = 24680

    monkeypatch.setattr(record_audio.subprocess, "Popen", lambda *_args, **_kwargs: Process())

    assert record_audio.sox_start("Fresh Install") is True
    assert (ipc_dir / ".recording_pid").read_text(encoding="utf-8") == "24680"
