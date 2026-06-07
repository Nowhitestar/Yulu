"""Opt-in REAL pipeline diarization smoke (Phase 13, SPKUI-05) — runs the actual production stack.

End-to-end proof that the wired pipeline produces speaker-labelled output from a REAL diarize:
runs the production ``SherpaDiarizeBackend`` on a 60s clip, then feeds its real turns through the
REAL ``speaker_merge.assign_speakers`` + sidecar builders — i.e. exactly what ``transcribe.py``'s
``_run_diarize_stage`` does, minus the daemon socket (which the CI-safe test_transcribe_diarize.py
already covers with a mocked RPC).

Because Yulu's default ``python3`` (3.14) lacks ``sherpa_onnx`` (the Phase-15/PORT-01 wheel
question), the diarize half runs in a SUBPROCESS using whichever interpreter can import sherpa:
  1. the current interpreter, if it can import sherpa_onnx; else
  2. the spike venv at ``~/funasr-spike/venv-sherpa/bin/python``.
The subprocess emits the real turns as JSON; the merge then runs in THIS interpreter against the
production ``speaker_merge`` (which is pure / dependency-free, so it needs no sherpa).

SKIPS cleanly when sherpa / the models / the clip are absent (the engine simply isn't installed
here — not a Phase-13 failure).
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

# Real spike resources (mirror test_diarize_integration.py). Not in the repo → skip without them.
SPIKE = Path.home() / "funasr-spike"
SEG_MODEL = SPIKE / "sherpa-models" / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
EMB_MODEL = SPIKE / "sherpa-models" / "campplus.onnx"
CLIP = SPIKE / "clip_smoke_60s.wav"
SPIKE_PY = SPIKE / "venv-sherpa" / "bin" / "python"

pytestmark = pytest.mark.integration


def _interp_can_import_sherpa(py: str) -> bool:
    try:
        r = subprocess.run([py, "-c", "import sherpa_onnx"], capture_output=True, timeout=30)
        return r.returncode == 0
    except Exception:
        return False


def _pick_interpreter():
    if _interp_can_import_sherpa(sys.executable):
        return sys.executable
    if SPIKE_PY.exists() and _interp_can_import_sherpa(str(SPIKE_PY)):
        return str(SPIKE_PY)
    return None


# Driver: run the PRODUCTION backend, print the real turns as one JSON line.
_DRIVER = r"""
import sys, json, asyncio
sys.path.insert(0, sys.argv[1])  # yulu/scripts
from stt_daemon.backends.diarize import SherpaDiarizeBackend
from stt_daemon.runtime import CancelToken

seg, emb, wav = sys.argv[2], sys.argv[3], sys.argv[4]

async def main():
    b = SherpaDiarizeBackend(seg_model=seg, emb_model=emb)  # auto count
    await b.warm_up()
    turns = await b.diarize(audio_path=wav, num_speakers=None, cancel_token=CancelToken())
    print("RESULT " + json.dumps([t.to_dict() for t in turns]))

asyncio.run(main())
"""


def _real_turns():
    py = _pick_interpreter()
    if py is None:
        pytest.skip("sherpa_onnx not importable by any interpreter (current or spike venv)")
    proc = subprocess.run(
        [py, "-c", _DRIVER, str(SCRIPTS), str(SEG_MODEL), str(EMB_MODEL), str(CLIP)],
        capture_output=True, text=True, timeout=600,
    )
    assert proc.returncode == 0, f"driver failed rc={proc.returncode}\n{proc.stderr[-1500:]}"
    line = next((ln for ln in proc.stdout.splitlines() if ln.startswith("RESULT ")), None)
    assert line is not None, f"no RESULT line:\n{proc.stdout}\n{proc.stderr[-800:]}"
    return json.loads(line[len("RESULT "):])


@pytest.mark.skipif(not (SEG_MODEL.exists() and EMB_MODEL.exists() and CLIP.exists()),
                    reason="diarization models / test clip not present (spike resources absent)")
def test_real_diarize_feeds_merge_into_labelled_transcript_and_sidecar(tmp_path):
    """Real turns → real speaker_merge → labelled transcript + sane sidecar (the production
    _run_diarize_stage path, minus the daemon socket)."""
    from stt_daemon import speaker_merge as sm

    turns = _real_turns()
    assert len(turns) >= 1, "expected at least one real speaker turn"
    n_speakers = len({t.get("speaker_idx", t.get("speaker")) for t in turns})
    assert 1 <= n_speakers <= 8, f"insane speaker count: {n_speakers}"

    # Synthesize ASR segments aligned to the real turns (one per turn) so the overlap merge has
    # something concrete to attribute — this exercises the REAL assign_speakers on REAL timings.
    asr_segments = [
        {"start": float(t["start"]), "end": float(t["end"]), "text": f"utterance {i}"}
        for i, t in enumerate(turns)
    ]

    result = sm.assign_speakers(asr_segments=asr_segments, turns=turns)
    assert result.segments, "merge produced no labelled segments"
    assert result.transcript, "merge produced no rendered transcript"
    # Every rendered line is in the [MM:SS <name>] format.
    for line in result.transcript.splitlines():
        assert line.startswith("[") and "]" in line

    # Build + write the sidecar exactly as the pipeline does, then round-trip it.
    audio = tmp_path / "RealClip_20260601_100000.wav"
    audio.write_bytes(b"RIFF")  # placeholder; the sidecar path is what matters
    doc = sm.build_sidecar(result=result, turns=turns, provider="sherpa-onnx")
    path = sm.write_sidecar(sm.speakers_sidecar_path(audio), doc)
    assert path.exists()

    reloaded = sm.read_sidecar(path)
    assert reloaded["schema_version"] == sm.SCHEMA_VERSION
    assert len(reloaded["turns"]) == len(turns)
    assert reloaded["segments"], "sidecar carries no segment assignments"
    # The round-tripped transcript reproduces the same labels (Phase-9 invariant, end-to-end).
    assert sm.render_from_sidecar(reloaded) == result.transcript
