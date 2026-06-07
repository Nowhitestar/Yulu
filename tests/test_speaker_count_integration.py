"""Opt-in REAL eval of the Phase-12 speaker-count strategy (criterion 4) — skips without deps.

This is the executable version of the Phase-12 gate: it builds the constructed CN+EN corpus, runs
the eval harness with ``--use-strategy`` (the shipped calendar-prior + reconcile path) AND a plain
auto baseline, then asserts:

  * CN DER DROPS vs the auto baseline (the over-split/under-merge fix lands), and
  * EN DER does NOT regress vs auto (criterion 4 — fixing CN must not break EN).

It runs the whole thing in the spike venv (``~/funasr-spike/venv-sherpa/bin/python``) because
sherpa-onnx + macOS ``say``/``ffmpeg`` are needed to build audio and diarize. If sherpa or the
models aren't importable/present, it SKIPS cleanly — exactly like test_diarize_integration.py.

This is dev/eval-only: it exercises ``yulu/scripts/eval`` + the production ``SherpaDiarizeBackend``
+ ``stt_daemon.speaker_count`` together, end to end on real (synthetic-acoustic) audio.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"

SPIKE = Path.home() / "funasr-spike"
SEG_MODEL = SPIKE / "sherpa-models" / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
EMB_MODEL = SPIKE / "sherpa-models" / "campplus.onnx"
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


def _run_harness(py: str, out_dir: Path, *, build: bool, strategy: bool,
                 report: Path) -> dict:
    """Run the eval harness once; return the parsed report JSON."""
    args = [py, "-m", "eval.harness", "--provider", "sherpa",
            "--seg-model", str(SEG_MODEL), "--emb-model", str(EMB_MODEL),
            "--json", str(report)]
    if build:
        args += ["--build-corpus", "--out", str(out_dir)]
    else:
        args += ["--corpus", str(out_dir)]
    if strategy:
        args += ["--use-strategy"]
    proc = subprocess.run(args, cwd=str(SCRIPTS), capture_output=True, text=True, timeout=600,
                          env=dict(os.environ))
    assert proc.returncode == 0, (
        f"harness failed rc={proc.returncode}\nSTDOUT:{proc.stdout[-1500:]}\nSTDERR:{proc.stderr[-1500:]}"
    )
    return json.loads(report.read_text())


def _cn_en_der(report: dict) -> tuple[float, float]:
    by_lang = report["aggregate"]["by_language"]
    cn = by_lang["cn"]["der"]["collar0.25_overlap"]
    en = by_lang["en"]["der"]["collar0.25_overlap"]
    return cn, en


@pytest.mark.skipif(not (SEG_MODEL.exists() and EMB_MODEL.exists()),
                    reason="diarization models not present (spike resources absent)")
def test_strategy_improves_cn_without_regressing_en():
    """Criterion 4 end-to-end: strategy lowers CN DER and holds EN DER vs the auto baseline."""
    py = _pick_interpreter()
    if py is None:
        pytest.skip("sherpa_onnx not importable by any interpreter (current or spike venv)")

    with tempfile.TemporaryDirectory(prefix="yulu-eval12-it-") as td:
        out_dir = Path(td)
        # 1. Build corpus + auto baseline.
        try:
            auto = _run_harness(py, out_dir, build=True, strategy=False,
                                report=out_dir / "auto.json")
        except AssertionError as e:
            # Building the TTS corpus needs macOS `say` + ffmpeg; skip if unavailable.
            if "say" in str(e) or "ffmpeg" in str(e) or "sox" in str(e):
                pytest.skip(f"cannot build TTS corpus here: {e}")
            raise
        # 2. Strategy run on the SAME corpus.
        strat = _run_harness(py, out_dir, build=False, strategy=True,
                             report=out_dir / "strategy.json")

        cn_auto, en_auto = _cn_en_der(auto)
        cn_strat, en_strat = _cn_en_der(strat)

        # CN improves (the over-split / under-merge fix lands).
        assert cn_strat < cn_auto - 0.05, (
            f"CN DER did not improve: auto={cn_auto:.3f} strategy={cn_strat:.3f}"
        )
        # EN does NOT regress (criterion 4) — allow a tiny tolerance for clustering nondeterminism.
        assert en_strat <= en_auto + 0.02, (
            f"EN DER regressed: auto={en_auto:.3f} strategy={en_strat:.3f}"
        )
