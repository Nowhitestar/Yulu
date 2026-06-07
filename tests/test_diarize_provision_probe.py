"""Unit tests for diarization provisioning idempotency + the tri-state probe (DIAR-03/04).

CI-safe — no network, no sherpa install, no real models (all paths mocked / tmp files):

- provisioning idempotency: the `models` step's read-only `_model_present()` requires BOTH the
  whisper half AND the diarization half, where the diarization half short-circuits True when
  diarization is disabled and otherwise needs both ONNX files (criterion 3 idempotency contract);
- the registry still has exactly SIX steps (diarization EXTENDS the `models` step, no 7th step);
- `probe_diarization()` returns the correct tri-state across {models present?} × {sherpa import?}
  and is always `yulu-managed` (criterion 4).
"""

import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from provision import REGISTRY  # noqa: E402
from provision import registry as registry_mod  # noqa: E402
import capabilities.probes as probes  # noqa: E402
from capabilities.report import Provenance, Status  # noqa: E402
from stt_daemon.backends import diarize as diar  # noqa: E402


# ════════════════════════════════════════════════════════════════════════════
# Provisioning idempotency — the `models` step check() gate (criterion 3)
# ════════════════════════════════════════════════════════════════════════════


def test_registry_still_six_steps_no_new_diarize_step():
    """Diarization EXTENDS the models step — it must not add a 7th registry step."""
    assert [s.name for s in REGISTRY] == [
        "deps", "audio", "models", "capabilities", "daemons", "ui"
    ]


def _engine_present(monkeypatch, present: bool) -> None:
    """Pin the PORT-01 engine-importable gate so the model-file logic is tested in isolation.

    The CI interpreter does NOT have sherpa-onnx installed, so without this the engine half of
    ``_diarization_models_present`` would dominate. These model-file tests pin it True; the
    dedicated engine-gate tests below exercise the gate itself.
    """
    monkeypatch.setattr(registry_mod, "_diarization_engine_importable", lambda: present)


def test_diarization_half_true_when_disabled():
    # No diarization key, or enabled:false → the diarization half is satisfied (nothing to fetch).
    # Disabled short-circuits BEFORE the engine gate (no engine needed when off).
    assert registry_mod._diarization_models_present({}) is True
    assert registry_mod._diarization_models_present({"diarization": {"enabled": False}}) is True


def test_diarization_half_false_when_enabled_and_models_absent(monkeypatch):
    _engine_present(monkeypatch, True)  # isolate: engine present, models absent
    trans = {"diarization": {"enabled": True,
                             "seg_model": "/nope/seg.onnx", "emb_model": "/nope/emb.onnx"}}
    assert registry_mod._diarization_models_present(trans) is False


def test_diarization_half_true_when_enabled_and_both_present(monkeypatch, tmp_path):
    _engine_present(monkeypatch, True)  # isolate the model-file half
    seg = tmp_path / "seg.onnx"; seg.write_bytes(b"s")
    emb = tmp_path / "emb.onnx"; emb.write_bytes(b"e")
    trans = {"diarization": {"enabled": True, "seg_model": str(seg), "emb_model": str(emb)}}
    assert registry_mod._diarization_models_present(trans) is True


def test_diarization_half_false_when_engine_missing_even_if_models_present(monkeypatch, tmp_path):
    """PORT-01: with both ONNX present but the sherpa engine NOT importable, the diarization
    half is UNSATISFIED so the models step re-runs and installs the engine (criterion 3 / 1)."""
    _engine_present(monkeypatch, False)
    seg = tmp_path / "seg.onnx"; seg.write_bytes(b"s")
    emb = tmp_path / "emb.onnx"; emb.write_bytes(b"e")
    trans = {"diarization": {"enabled": True, "seg_model": str(seg), "emb_model": str(emb)}}
    assert registry_mod._diarization_models_present(trans) is False


def test_model_present_combines_whisper_and_diarization(monkeypatch, tmp_path):
    """_model_present() = whisper-half AND diarization-half. With mlx (whisper-half True) and
    diarization enabled but absent, the WHOLE step is unsatisfied → the step will (re)run."""
    _engine_present(monkeypatch, True)  # isolate the model-file half (engine present)
    seg = tmp_path / "seg.onnx"  # intentionally absent
    cfg = {"transcription": {"engine": "mlx",
                             "diarization": {"enabled": True,
                                             "seg_model": str(seg),
                                             "emb_model": str(tmp_path / "emb.onnx")}}}
    monkeypatch.setattr(registry_mod, "_load_config", lambda: cfg)
    assert registry_mod._model_present() is False  # diarization half fails → not done

    # Now create both files → the whole step is satisfied (idempotent skip on re-run).
    seg.write_bytes(b"s")
    (tmp_path / "emb.onnx").write_bytes(b"e")
    assert registry_mod._model_present() is True


def test_model_present_mlx_only_no_diarization_is_true(monkeypatch):
    """Back-compat: mlx engine + no diarization config → step satisfied (unchanged behavior)."""
    monkeypatch.setattr(registry_mod, "_load_config",
                        lambda: {"transcription": {"engine": "mlx"}})
    assert registry_mod._model_present() is True


# ════════════════════════════════════════════════════════════════════════════
# PORT-01 — the sherpa-onnx engine-importable gate (co-locate in daemon interpreter)
# ════════════════════════════════════════════════════════════════════════════


def test_engine_importable_reflects_find_spec(monkeypatch):
    """_diarization_engine_importable() is True iff importlib can find sherpa_onnx; it never
    imports the heavy module and never raises."""
    import importlib.util as _ilu

    monkeypatch.setattr(_ilu, "find_spec", lambda name: object() if name == "sherpa_onnx" else None)
    assert registry_mod._diarization_engine_importable() is True

    monkeypatch.setattr(_ilu, "find_spec", lambda name: None)
    assert registry_mod._diarization_engine_importable() is False


def test_engine_importable_never_raises(monkeypatch):
    import importlib.util as _ilu

    def _boom(name):
        raise RuntimeError("import system on fire")

    monkeypatch.setattr(_ilu, "find_spec", _boom)
    assert registry_mod._diarization_engine_importable() is False  # degrades, never raises


def test_enabled_diarization_unsatisfied_when_engine_missing_drives_models_step(monkeypatch):
    """End-to-end at the step gate: diarization enabled + engine missing ⇒ the models step's
    check() is False, so a re-run on an upgrade will (re)install the engine (PORT-01/PORT-03)."""
    monkeypatch.setattr(registry_mod, "_diarization_engine_importable", lambda: False)
    cfg = {"transcription": {"engine": "mlx", "diarization": {"enabled": True}}}
    monkeypatch.setattr(registry_mod, "_load_config", lambda: cfg)
    assert registry_mod._model_present() is False


def test_models_step_apply_skips_when_check_true(monkeypatch):
    """check()==True short-circuits apply() to 'skipped' WITHOUT spawning bash (idempotency)."""
    def _explode(*a, **k):
        raise AssertionError("subprocess.run must NOT run when check() is satisfied")

    monkeypatch.setattr(registry_mod.subprocess, "run", _explode)
    monkeypatch.setattr(registry_mod, "_load_config",
                        lambda: {"transcription": {"engine": "mlx"}})  # diarization off → done
    step = registry_mod.step_by_name("models")
    result = step.apply("release")
    assert result.status == "skipped"


# ════════════════════════════════════════════════════════════════════════════
# probe_diarization tri-state (criterion 4) — always yulu-managed
# ════════════════════════════════════════════════════════════════════════════


def _patch_models(monkeypatch, present: bool, model_dir="/m/diarization"):
    monkeypatch.setattr(diar, "models_present", lambda *a, **k: present)
    monkeypatch.setattr(diar, "diarization_dir", lambda *a, **k: Path(model_dir))
    monkeypatch.setattr(diar, "resolve_model_paths",
                        lambda *a, **k: (Path(model_dir) / "segmentation.onnx",
                                         Path(model_dir) / "campplus.onnx"))


def test_probe_absent_when_models_missing(monkeypatch):
    _patch_models(monkeypatch, present=False)
    cap = probes.probe_diarization()
    assert cap.provenance == Provenance.YULU_MANAGED
    assert cap.status == Status.ABSENT
    assert "missing" in cap.detail


def test_probe_usable_when_models_present_and_sherpa_importable(monkeypatch):
    _patch_models(monkeypatch, present=True)
    monkeypatch.setattr(probes, "probe_importable", lambda mod: (True, "1.13.2"))
    cap = probes.probe_diarization()
    assert cap.provenance == Provenance.YULU_MANAGED
    assert cap.status == Status.USABLE
    assert "1.13.2" in cap.detail


def test_probe_present_but_unverified_when_sherpa_not_importable(monkeypatch):
    _patch_models(monkeypatch, present=True)
    monkeypatch.setattr(probes, "probe_importable",
                        lambda mod: (False, "No module named 'sherpa_onnx'"))
    cap = probes.probe_diarization()
    assert cap.provenance == Provenance.YULU_MANAGED
    assert cap.status == Status.PRESENT_BUT_UNVERIFIED
    assert "not importable" in cap.detail


def test_probe_never_raises_on_internal_error(monkeypatch):
    """The never-raise contract: any internal explosion degrades to an absent() Capability."""
    def _boom(*a, **k):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(diar, "models_present", _boom)
    cap = probes.probe_diarization()
    assert cap.status == Status.ABSENT  # degraded, not raised


def test_probe_is_yulu_managed_in_all_present_states(monkeypatch):
    """Whether usable or present-but-unverified, provenance is ALWAYS yulu-managed (never
    agent-config) — diarization is Yulu-owned, not host-agent-reused."""
    _patch_models(monkeypatch, present=True)
    for importable in (True, False):
        monkeypatch.setattr(probes, "probe_importable", lambda mod, _i=importable: (_i, "x"))
        cap = probes.probe_diarization()
        assert cap.provenance == Provenance.YULU_MANAGED
