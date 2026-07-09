"""STTRuntime mode dispatch + mlx→whisper fallback (BUG 3 + BUG 8).

These exercise the two fresh-install safety policies the runtime applies on top
of plain per-engine dispatch:

  * BUG 3 — when the mlx backend fails (e.g. mlx_whisper is not installed) and a
    whisper.cpp model is present, the request auto-retries on the whisper engine.
  * BUG 8 — transcription.mode orders local vs. the user's cloud_command:
    cloud-fallback = local then cloud; cloud-priority = cloud then local.
"""

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.runtime import CancelToken, MockSTTBackend, STTRuntime


def _transcribe(runtime: STTRuntime, engine: str):
    return asyncio.run(
        runtime.transcribe(
            audio_path="/x.wav",
            language="zh",
            initial_prompt="",
            cancel_token=CancelToken(),
            engine=engine,
        )
    )


# ── BUG 3: mlx unavailable + whisper model present → transcript via whisper ──

def test_mlx_unavailable_falls_back_to_whisper_when_model_present():
    mlx = MockSTTBackend(canned_text="from-mlx", raise_first_n=1)  # mlx "unavailable"
    whisper = MockSTTBackend(canned_text="from-whisper")
    runtime = STTRuntime(
        backends={"mlx": mlx, "whisper": whisper},
        whisper_model_present=True,
    )

    result = _transcribe(runtime, "mlx")

    assert result.text == "from-whisper"  # fell back
    assert mlx.calls == 1                  # mlx was tried once and failed
    assert whisper.calls == 1              # whisper handled it


def test_mlx_failure_propagates_when_no_whisper_model():
    # Without a configured whisper model the fallback must NOT kick in — the mlx
    # failure surfaces (the normal mlx error path is unchanged).
    mlx = MockSTTBackend(canned_text="from-mlx", raise_first_n=1)
    whisper = MockSTTBackend(canned_text="from-whisper")
    runtime = STTRuntime(
        backends={"mlx": mlx, "whisper": whisper},
        whisper_model_present=False,
    )

    raised = False
    try:
        _transcribe(runtime, "mlx")
    except RuntimeError:
        raised = True
    assert raised is True
    assert whisper.calls == 0  # never fell back


def test_healthy_mlx_does_not_fall_back():
    mlx = MockSTTBackend(canned_text="from-mlx")
    whisper = MockSTTBackend(canned_text="from-whisper")
    runtime = STTRuntime(
        backends={"mlx": mlx, "whisper": whisper},
        whisper_model_present=True,
    )

    result = _transcribe(runtime, "mlx")

    assert result.text == "from-mlx"
    assert whisper.calls == 0


def test_hermes_failure_falls_back_to_mlx():
    hermes = MockSTTBackend(canned_text="from-hermes", raise_first_n=1)
    mlx = MockSTTBackend(canned_text="from-mlx")
    runtime = STTRuntime(backends={"hermes": hermes, "mlx": mlx})

    result = _transcribe(runtime, "hermes")

    assert result.text == "from-mlx"
    assert hermes.calls == 1
    assert mlx.calls == 1


# ── BUG 8: transcription.mode dispatch (local / cloud-fallback / cloud-priority) ──

def _runtime_with_cloud(*, mode, mlx_fails=0, cloud_fails=0,
                        cloud_present=True, whisper_model_present=False):
    mlx = MockSTTBackend(canned_text="from-mlx", raise_first_n=mlx_fails)
    whisper = MockSTTBackend(canned_text="from-whisper")
    cloud = MockSTTBackend(canned_text="from-cloud", raise_first_n=cloud_fails)
    runtime = STTRuntime(
        backends={"mlx": mlx, "whisper": whisper, "cloud": cloud},
        mode=mode,
        cloud_command_present=cloud_present,
        whisper_model_present=whisper_model_present,
    )
    return runtime, mlx, whisper, cloud


def test_local_mode_never_touches_cloud():
    runtime, mlx, _w, cloud = _runtime_with_cloud(mode="local")
    result = _transcribe(runtime, "mlx")
    assert result.text == "from-mlx"
    assert cloud.calls == 0


def test_cloud_priority_runs_cloud_first():
    runtime, mlx, _w, cloud = _runtime_with_cloud(mode="cloud-priority")
    result = _transcribe(runtime, "mlx")
    assert result.text == "from-cloud"
    assert cloud.calls == 1
    assert mlx.calls == 0  # local never needed


def test_cloud_priority_falls_back_to_local_when_cloud_fails():
    runtime, mlx, _w, cloud = _runtime_with_cloud(mode="cloud-priority", cloud_fails=1)
    result = _transcribe(runtime, "mlx")
    assert result.text == "from-mlx"  # local picked up after cloud failed
    assert cloud.calls == 1
    assert mlx.calls == 1


def test_cloud_fallback_runs_local_first():
    runtime, mlx, _w, cloud = _runtime_with_cloud(mode="cloud-fallback")
    result = _transcribe(runtime, "mlx")
    assert result.text == "from-mlx"
    assert mlx.calls == 1
    assert cloud.calls == 0  # local succeeded, cloud not needed


def test_cloud_fallback_uses_cloud_when_local_fails():
    # mlx fails AND no whisper model → chain is [mlx, cloud]; cloud rescues it.
    runtime, mlx, _w, cloud = _runtime_with_cloud(mode="cloud-fallback", mlx_fails=1)
    result = _transcribe(runtime, "mlx")
    assert result.text == "from-cloud"
    assert mlx.calls == 1
    assert cloud.calls == 1


def test_cloud_mode_ignored_when_no_command_configured():
    # mode says cloud-priority but cloud_command is empty → cloud is unusable,
    # so it behaves like local-only.
    runtime, mlx, _w, cloud = _runtime_with_cloud(mode="cloud-priority", cloud_present=False)
    result = _transcribe(runtime, "mlx")
    assert result.text == "from-mlx"
    assert cloud.calls == 0


def test_cloud_fallback_then_whisper_then_cloud_full_chain():
    # mlx fails, whisper model present, cloud-fallback → chain [mlx, whisper, cloud].
    # whisper succeeds, so cloud is never reached.
    runtime, mlx, whisper, cloud = _runtime_with_cloud(
        mode="cloud-fallback", mlx_fails=1, whisper_model_present=True,
    )
    result = _transcribe(runtime, "mlx")
    assert result.text == "from-whisper"
    assert mlx.calls == 1
    assert whisper.calls == 1
    assert cloud.calls == 0
