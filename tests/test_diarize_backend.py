"""Unit tests for the diarization backend (DIAR-01/02/05) — CI-safe, sherpa MOCKED.

Locks the Phase-10 backend invariants WITHOUT installing sherpa-onnx or any model:

- the backend mirrors the STT lifecycle (warm_up / is_ready / release) and returns SpeakerTurns;
- it is config-SELECTED and constructed OFF the ASR runtime dict (the ASR fallback chain can
  never route to it) — ARCHITECTURE Anti-Pattern 1;
- warm_up() runs a dummy pass to amortize the first-run cold-start (criterion 5);
- backend output feeds Phase-9 speaker_merge.assign_speakers verbatim (the SpeakerTurn contract).

Import style mirrors the repo (sys.path.insert + `from stt_daemon...`).
"""

import asyncio
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from stt_daemon.backends import diarize as diar  # noqa: E402
from stt_daemon.backends.diarize import (  # noqa: E402
    DiarizeBackend,
    SherpaDiarizeBackend,
    SpeakerTurn,
    models_present,
    resolve_model_paths,
)
from stt_daemon.runtime import CancelToken  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


# ════════════════════════════════════════════════════════════════════════════
# A fake sherpa_onnx module — records construction + serves canned turns.
# ════════════════════════════════════════════════════════════════════════════


class _FakeSeg:
    def __init__(self, start, end, speaker):
        self.start = start
        self.end = end
        self.speaker = speaker


class _FakeProcessResult:
    def __init__(self, segs):
        self._segs = segs

    def sort_by_start_time(self):
        return sorted(self._segs, key=lambda s: s.start)


class _FakeSD:
    """Stand-in for OfflineSpeakerDiarization."""

    instances: list = []
    sample_rate = 16000

    def __init__(self, config):
        self.config = config
        self.process_calls = []
        _FakeSD.instances.append(self)

    def process(self, audio):
        self.process_calls.append(len(audio))
        # Silence (warm-up dummy) → 0 turns; otherwise two canned turns.
        if len(audio) <= self.sample_rate:
            return _FakeProcessResult([])
        return _FakeProcessResult([
            _FakeSeg(0.0, 3.0, 0),
            _FakeSeg(3.0, 6.0, 1),
        ])


def _make_fake_sherpa():
    m = types.ModuleType("sherpa_onnx")

    # Config classes just capture kwargs (the backend only constructs them).
    def _cfg(name):
        def _init(self, **kw):
            self.__dict__.update(kw)
        return type(name, (), {"__init__": _init})

    m.OfflineSpeakerDiarizationConfig = _cfg("OfflineSpeakerDiarizationConfig")
    m.OfflineSpeakerSegmentationModelConfig = _cfg("OfflineSpeakerSegmentationModelConfig")
    m.OfflineSpeakerSegmentationPyannoteModelConfig = _cfg("OfflineSpeakerSegmentationPyannoteModelConfig")
    m.SpeakerEmbeddingExtractorConfig = _cfg("SpeakerEmbeddingExtractorConfig")
    m.FastClusteringConfig = _cfg("FastClusteringConfig")
    m.OfflineSpeakerDiarization = _FakeSD
    return m


@pytest.fixture
def fake_sherpa(monkeypatch, tmp_path):
    """Install a fake sherpa_onnx + two dummy model files so warm_up/diarize run offline."""
    _FakeSD.instances = []
    seg = tmp_path / "segmentation.onnx"
    emb = tmp_path / "campplus.onnx"
    seg.write_bytes(b"seg")
    emb.write_bytes(b"emb")
    monkeypatch.setitem(sys.modules, "sherpa_onnx", _make_fake_sherpa())
    # numpy/soundfile are imported lazily inside the backend; provide minimal fakes for diarize().
    return {"seg": str(seg), "emb": str(emb)}


# ════════════════════════════════════════════════════════════════════════════
# Criterion 1 — Protocol shape + lifecycle mirror
# ════════════════════════════════════════════════════════════════════════════


def test_sherpa_backend_satisfies_protocol():
    b = SherpaDiarizeBackend(seg_model="/a.onnx", emb_model="/b.onnx")
    assert isinstance(b, DiarizeBackend)  # runtime_checkable Protocol
    # The lifecycle trio is present and is the STT shape.
    assert hasattr(b, "warm_up") and hasattr(b, "is_ready") and hasattr(b, "release")
    assert hasattr(b, "diarize")


def test_not_ready_before_warmup():
    b = SherpaDiarizeBackend(seg_model="/a.onnx", emb_model="/b.onnx")
    assert b.is_ready() is False


def test_warmup_loads_pipeline_and_runs_dummy_pass(fake_sherpa):
    """Criterion 5: warm_up builds the resident pipeline AND runs a dummy (silent) pass."""
    b = SherpaDiarizeBackend(seg_model=fake_sherpa["seg"], emb_model=fake_sherpa["emb"])
    _run(b.warm_up())
    assert b.is_ready() is True
    assert len(_FakeSD.instances) == 1
    # The dummy pass primed the graph: process() was called once with ~1s of silence.
    sd = _FakeSD.instances[0]
    assert sd.process_calls == [_FakeSD.sample_rate]


def test_warmup_is_idempotent(fake_sherpa):
    b = SherpaDiarizeBackend(seg_model=fake_sherpa["seg"], emb_model=fake_sherpa["emb"])
    _run(b.warm_up())
    _run(b.warm_up())  # second call is a no-op under the lock + _ready flag
    assert len(_FakeSD.instances) == 1


def test_release_resets_state(fake_sherpa):
    b = SherpaDiarizeBackend(seg_model=fake_sherpa["seg"], emb_model=fake_sherpa["emb"])
    _run(b.warm_up())
    b.release()
    assert b.is_ready() is False


def test_warmup_raises_when_model_file_missing(monkeypatch):
    monkeypatch.setitem(sys.modules, "sherpa_onnx", _make_fake_sherpa())
    b = SherpaDiarizeBackend(seg_model="/nope/seg.onnx", emb_model="/nope/emb.onnx")
    with pytest.raises(RuntimeError, match="diarization model not found"):
        _run(b.warm_up())


def test_warmup_raises_without_sherpa(monkeypatch, tmp_path):
    """No sherpa_onnx importable → a clear RuntimeError (not an ImportError leak)."""
    seg = tmp_path / "s.onnx"; seg.write_bytes(b"s")
    emb = tmp_path / "e.onnx"; emb.write_bytes(b"e")
    # Force the lazy import to fail.
    import builtins

    real_import = builtins.__import__

    def _no_sherpa(name, *a, **k):
        if name == "sherpa_onnx":
            raise ImportError("no sherpa")
        return real_import(name, *a, **k)

    monkeypatch.delitem(sys.modules, "sherpa_onnx", raising=False)
    monkeypatch.setattr(builtins, "__import__", _no_sherpa)
    b = SherpaDiarizeBackend(seg_model=str(seg), emb_model=str(emb))
    with pytest.raises((RuntimeError, ImportError)):
        _run(b.warm_up())


# ════════════════════════════════════════════════════════════════════════════
# Criterion 2 — diarize returns SpeakerTurns (mocked engine)
# ════════════════════════════════════════════════════════════════════════════


def test_diarize_returns_speaker_turns(fake_sherpa, monkeypatch):
    """diarize() maps the engine result to SpeakerTurn(seconds, speaker_idx)."""
    # Fake numpy + soundfile so the lazy in-thread import inside diarize() works offline.
    fake_np = types.ModuleType("numpy")
    fake_np.zeros = lambda n, dtype=None: [0.0] * int(n)
    fake_np.linspace = lambda a, b, n, endpoint=True: list(range(int(n)))
    fake_np.arange = lambda n: list(range(int(n)))
    fake_np.interp = lambda x, xp, fp: [0.0] * len(x)
    fake_sf = types.ModuleType("soundfile")
    # 2s of "audio" at 16k → > sample_rate so the fake SD returns the two canned turns.
    fake_sf.read = lambda path, dtype=None, always_2d=None: ([0.0] * (2 * 16000), 16000)
    monkeypatch.setitem(sys.modules, "numpy", fake_np)
    monkeypatch.setitem(sys.modules, "soundfile", fake_sf)

    b = SherpaDiarizeBackend(seg_model=fake_sherpa["seg"], emb_model=fake_sherpa["emb"])
    turns = _run(b.diarize(audio_path="x.wav", num_speakers=None, cancel_token=CancelToken()))
    assert all(isinstance(t, SpeakerTurn) for t in turns)
    assert [(t.start, t.end, t.speaker_idx) for t in turns] == [(0.0, 3.0, 0), (3.0, 6.0, 1)]


def test_diarize_honors_cancel(fake_sherpa):
    b = SherpaDiarizeBackend(seg_model=fake_sherpa["seg"], emb_model=fake_sherpa["emb"])
    tok = CancelToken()
    tok.cancel()
    with pytest.raises(asyncio.CancelledError):
        _run(b.diarize(audio_path="x.wav", num_speakers=None, cancel_token=tok))


# ════════════════════════════════════════════════════════════════════════════
# Criterion 1 — config selection + NOT in the ASR fallback dict
# ════════════════════════════════════════════════════════════════════════════


def test_build_diarize_backend_disabled_returns_none():
    from stt_daemon.config import DaemonConfig
    from stt_daemon.__main__ import _build_diarize_backend

    assert _build_diarize_backend(DaemonConfig()) is None  # default: disabled


def test_build_diarize_backend_selects_sherpa():
    from stt_daemon.config import DaemonConfig
    from stt_daemon.__main__ import _build_diarize_backend

    cfg = DaemonConfig()
    cfg.diarize_enabled = True
    cfg.diarize_provider = "sherpa-onnx"
    cfg.diarize_num_speakers = 3
    cfg.diarize_threshold = 0.6
    b = _build_diarize_backend(cfg)
    assert isinstance(b, SherpaDiarizeBackend)
    assert b.num_speakers == 3 and b.threshold == 0.6


def test_build_diarize_backend_unknown_provider_returns_none():
    from stt_daemon.config import DaemonConfig
    from stt_daemon.__main__ import _build_diarize_backend

    cfg = DaemonConfig()
    cfg.diarize_enabled = True
    cfg.diarize_provider = "funasr"  # not shipped → None, not a crash
    assert _build_diarize_backend(cfg) is None


def test_diarize_backend_is_not_in_asr_runtime_dict():
    """THE isolation invariant: the ASR backends dict has no diarize entry, and an STTRuntime
    built from it cannot route any request to diarization (ARCHITECTURE Anti-Pattern 1)."""
    from stt_daemon.config import DaemonConfig
    from stt_daemon.__main__ import _build_real_backends
    from stt_daemon.runtime import STTRuntime

    backends = _build_real_backends(DaemonConfig())
    assert "diarize" not in backends
    assert not any("diar" in k.lower() for k in backends)
    # Only ASR engine keys are present.
    assert set(backends) <= {"mlx", "whisper", "cloud", "mlx-realtime"}

    runtime = STTRuntime(backends=backends)
    # The runtime's engine chain for any known ASR engine never includes a diarize engine.
    for eng in ("mlx", "whisper", "cloud"):
        if eng in backends:
            chain = runtime._engine_chain(eng)
            assert all("diar" not in c.lower() for c in chain)
    # And asking the runtime to transcribe on a "diarize" engine is rejected outright.
    with pytest.raises(ValueError):
        _run(runtime.transcribe(
            audio_path="x.wav", language="zh", initial_prompt="",
            cancel_token=CancelToken(), engine="diarize",
        ))


def test_app_holds_diarize_backend_off_the_runtime(fake_sherpa, monkeypatch):
    """The construction seam attaches the backend to the app WITHOUT entering the runtime dict."""
    from stt_daemon.config import DaemonConfig
    from stt_daemon.__main__ import _build_real_backends, _build_diarize_backend
    from stt_daemon.runtime import STTRuntime

    cfg = DaemonConfig()
    cfg.diarize_enabled = True
    cfg.diarize_seg_model = fake_sherpa["seg"]
    cfg.diarize_emb_model = fake_sherpa["emb"]
    backends = _build_real_backends(cfg)
    runtime = STTRuntime(backends=backends)
    diar_backend = _build_diarize_backend(cfg)
    assert isinstance(diar_backend, SherpaDiarizeBackend)
    # It is a distinct object, never one of the runtime's ASR backends.
    assert diar_backend not in runtime.backends.values()


# ════════════════════════════════════════════════════════════════════════════
# Criterion 2/integration contract — SpeakerTurn feeds Phase-9 speaker_merge
# ════════════════════════════════════════════════════════════════════════════


def test_speaker_turn_dict_feeds_phase9_merge():
    """Backend turns drop straight into assign_speakers (the Phase-9 SpeakerTurn contract)."""
    from stt_daemon.speaker_merge import assign_speakers, SpeakerTurn as MergeTurn

    turns = [SpeakerTurn(0.0, 3.0, 0).to_dict(), SpeakerTurn(3.0, 6.0, 1).to_dict()]
    # Phase-9 from_dict reads the backend's keys.
    mt = MergeTurn.from_dict(turns[0])
    assert (mt.start, mt.end, mt.speaker_idx) == (0.0, 3.0, 0)

    asr = [{"start": 0.5, "end": 2.0, "text": "hello"},
           {"start": 3.5, "end": 5.0, "text": "world"}]
    res = assign_speakers(asr_segments=asr, turns=turns)
    assert "[00:00 Speaker 1] hello" in res.transcript
    assert "[00:03 Speaker 2] world" in res.transcript


# ════════════════════════════════════════════════════════════════════════════
# Model resolution helpers
# ════════════════════════════════════════════════════════════════════════════


def test_resolve_model_paths_defaults_and_overrides(tmp_path):
    seg, emb = resolve_model_paths(tmp_path)
    assert seg == tmp_path / "diarization" / "segmentation.onnx"
    assert emb == tmp_path / "diarization" / "campplus.onnx"
    seg2, emb2 = resolve_model_paths(tmp_path, seg_path="/x/s.onnx", emb_path="/y/e.onnx")
    assert str(seg2) == "/x/s.onnx" and str(emb2) == "/y/e.onnx"


def test_models_present_true_only_when_both_exist(tmp_path):
    d = tmp_path / "diarization"
    d.mkdir()
    assert models_present(tmp_path) is False
    (d / "segmentation.onnx").write_bytes(b"s")
    assert models_present(tmp_path) is False  # only one
    (d / "campplus.onnx").write_bytes(b"e")
    assert models_present(tmp_path) is True
