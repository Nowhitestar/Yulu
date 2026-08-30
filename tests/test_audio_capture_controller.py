import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def test_macos_audio_capture_controller_translates_neutral_verbs(monkeypatch, tmp_path):
    from yulu_platform.macos import audio_capture

    monkeypatch.setattr(audio_capture.platform, "system", lambda: "Darwin")
    calls = []

    def fake_send(command):
        calls.append(command)
        return {"ok": True, "action": command["action"]}

    ctrl = audio_capture.MacOSAudioCaptureController(
        tmp_path / "audio_daemon.sock",
        socket_send=fake_send,
    )

    assert ctrl.status() == {"ok": True, "action": "status"}
    assert ctrl.start({"title": "Planning", "silence_seconds": 60}) == {
        "ok": True,
        "action": "start",
    }
    assert ctrl.stop() == {"ok": True, "action": "stop"}
    assert ctrl.windows() == {"ok": True, "action": "windows"}

    assert calls == [
        {"action": "status"},
        {"title": "Planning", "silence_seconds": 60, "action": "start"},
        {"action": "stop"},
        {"action": "windows"},
    ]


def test_macos_audio_capture_controller_missing_socket_degrades(monkeypatch, tmp_path):
    from yulu_platform.macos import audio_capture

    monkeypatch.setattr(audio_capture.platform, "system", lambda: "Darwin")
    ctrl = audio_capture.MacOSAudioCaptureController(tmp_path / "missing.sock")

    assert ctrl.status() is None


def test_macos_audio_capture_controller_uses_standard_ipc_path(monkeypatch, tmp_path):
    from yulu_platform.macos import audio_capture

    monkeypatch.setattr(audio_capture.platform, "system", lambda: "Darwin")
    ipc_dir = tmp_path / "Library" / "Caches" / "Yulu"
    monkeypatch.setenv("YULU_CACHE_DIR", str(ipc_dir))
    monkeypatch.setenv("YULU_IPC_DIR", str(ipc_dir))

    ctrl = audio_capture.MacOSAudioCaptureController()

    assert ctrl.socket_path == ipc_dir / "audio_daemon.sock"
