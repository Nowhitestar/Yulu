"""Opt-in REAL diarization smoke (DIAR-02/03) — runs the actual SherpaDiarizeBackend.

Marked ``integration`` and skipped cleanly unless the real model files exist. Because Yulu's
default ``python3`` typically lacks ``sherpa_onnx`` (it lives in the dev/eval venv), this test
runs the backend in a SUBPROCESS using whichever interpreter can import sherpa:

  1. the current interpreter, if it can import sherpa_onnx; else
  2. the spike venv at ``~/funasr-spike/venv-sherpa/bin/python`` (sherpa-onnx 1.13.2), if present.

If neither can import sherpa, the test SKIPS (the engine isn't installed here — that's the
Phase-15/PORT-01 wheel question, not a Phase-10 failure).

What it proves when it runs:
  * the real backend returns speaker turns for the 60s clip with a sane speaker count (criterion 2);
  * a FORCED-OFFLINE run (``HF_HUB_OFFLINE=1`` + dead ``HTTPS_PROXY``/``HTTP_PROXY``) STILL produces
    turns from the local ONNX files — zero network calls (criterion 3).

The subprocess drives the production ``SherpaDiarizeBackend`` (NOT the spike script), so this is a
true end-to-end check of the shipped code path.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"

# Real spike resources (see 10-CONTEXT.md). These are NOT in the repo; the test skips without them.
SPIKE = Path.home() / "funasr-spike"
SEG_MODEL = SPIKE / "sherpa-models" / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
EMB_MODEL = SPIKE / "sherpa-models" / "campplus.onnx"
CLIP = SPIKE / "clip_smoke_60s.wav"
SPIKE_PY = SPIKE / "venv-sherpa" / "bin" / "python"

pytestmark = pytest.mark.integration


def _interp_can_import_sherpa(py: str) -> bool:
    try:
        r = subprocess.run([py, "-c", "import sherpa_onnx"],
                           capture_output=True, timeout=30)
        return r.returncode == 0
    except Exception:
        return False


def _pick_interpreter() -> str | None:
    """The first interpreter that can import sherpa_onnx: current, then the spike venv."""
    if _interp_can_import_sherpa(sys.executable):
        return sys.executable
    if SPIKE_PY.exists() and _interp_can_import_sherpa(str(SPIKE_PY)):
        return str(SPIKE_PY)
    return None


# The driver script run in the chosen interpreter: it imports the PRODUCTION backend from this
# repo, runs warm_up + diarize on the clip, and prints a one-line JSON result.
_DRIVER = r"""
import sys, os, json, asyncio
sys.path.insert(0, sys.argv[1])  # yulu/scripts
from stt_daemon.backends.diarize import SherpaDiarizeBackend
from stt_daemon.runtime import CancelToken

seg, emb, wav = sys.argv[2], sys.argv[3], sys.argv[4]

async def main():
    b = SherpaDiarizeBackend(seg_model=seg, emb_model=emb)  # auto speaker count
    await b.warm_up()
    turns = await b.diarize(audio_path=wav, num_speakers=None, cancel_token=CancelToken())
    speakers = sorted({t.speaker_idx for t in turns})
    print("RESULT " + json.dumps({
        "ready": b.is_ready(),
        "num_turns": len(turns),
        "num_speakers": len(speakers),
        "first": [[round(t.start, 2), round(t.end, 2), t.speaker_idx] for t in turns[:3]],
    }))

asyncio.run(main())
"""


def _run_backend(env_extra: dict | None = None) -> dict:
    py = _pick_interpreter()
    if py is None:
        pytest.skip("sherpa_onnx not importable by any available interpreter (current or spike venv)")
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        [py, "-c", _DRIVER, str(SCRIPTS), str(SEG_MODEL), str(EMB_MODEL), str(CLIP)],
        capture_output=True, text=True, timeout=600, env=env,
    )
    assert proc.returncode == 0, f"driver failed rc={proc.returncode}\nSTDOUT:{proc.stdout}\nSTDERR:{proc.stderr[-1500:]}"
    line = next((ln for ln in proc.stdout.splitlines() if ln.startswith("RESULT ")), None)
    assert line is not None, f"no RESULT line in driver output:\n{proc.stdout}\n{proc.stderr[-800:]}"
    return json.loads(line[len("RESULT "):])


@pytest.mark.skipif(not (SEG_MODEL.exists() and EMB_MODEL.exists() and CLIP.exists()),
                    reason="diarization models / test clip not present (spike resources absent)")
def test_real_diarization_returns_sane_turns():
    """Criterion 2: the real sherpa-onnx backend returns speaker turns on a short real clip."""
    out = _run_backend()
    assert out["ready"] is True
    assert out["num_turns"] >= 1, "expected at least one speaker turn"
    # A 60s multi-speaker clip should land in a sane range — not zero, not absurd over-split.
    assert 1 <= out["num_speakers"] <= 8, f"insane speaker count: {out['num_speakers']}"


@pytest.mark.skipif(not (SEG_MODEL.exists() and EMB_MODEL.exists() and CLIP.exists()),
                    reason="diarization models / test clip not present (spike resources absent)")
def test_real_diarization_works_offline():
    """Criterion 3: with HF offline + DEAD proxies, the backend STILL loads the local ONNX and
    produces turns — proving zero network dependency at load/diarize time."""
    offline_env = {
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        # Point every proxy at a dead port so ANY accidental network call fails loudly.
        "HTTPS_PROXY": "http://127.0.0.1:9",
        "HTTP_PROXY": "http://127.0.0.1:9",
        "https_proxy": "http://127.0.0.1:9",
        "http_proxy": "http://127.0.0.1:9",
    }
    out = _run_backend(offline_env)
    assert out["ready"] is True
    assert out["num_turns"] >= 1, "offline run must still produce turns from local files"
    assert 1 <= out["num_speakers"] <= 8
