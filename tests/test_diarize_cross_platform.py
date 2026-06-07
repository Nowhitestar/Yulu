"""PORT-01 (Phase 15) — the diarization stack is platform-agnostic (no macOS coupling).

The milestone mandate: sherpa-onnx + ONNX models resolve behind the abstraction with NO
macOS-specific code (macOS impl now; non-macOS verified/stubbed per the v0.5 pattern). The
diarization engine is pure Python + onnxruntime with cross-platform wheels (cp37–cp314 for
macOS/Linux/Windows), so unlike audio-capture / launchd / TCC it needs NO OS-specific arm — it
is portable by construction. These tests enforce that property so a regression can't silently
re-couple it to macOS:

  1. STATIC GUARD: the diarization source files contain none of the macOS-only tokens that the
     v0.5 platform-coupling table enumerates (launchd/TCC/Cocoa/ScreenCaptureKit/homebrew paths/
     Darwin branching). A reviewer must be able to imagine the exact same module running on Linux.
  2. IMPORTABLE ANYWHERE: the backend + pipeline modules import with NO sherpa installed and NO
     macOS frameworks (sherpa is lazy-imported only inside warm_up/diarize), so CI on any OS loads
     them; usability is gated by the runtime probe, not import.
  3. The DiarizeBackend Protocol is the swappable seam (config-selected provider), NOT a macOS-
     coupled class — a future Linux/Windows or alternate-engine impl satisfies the same Protocol.

CI-safe: pure import + source-text inspection; no sherpa, no models, no network.
"""

import importlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

# The diarization-stack source files that must stay portable.
DIARIZATION_SOURCES = [
    SCRIPTS / "stt_daemon" / "backends" / "diarize.py",
    SCRIPTS / "stt_daemon" / "diarize_pipeline.py",
    SCRIPTS / "stt_daemon" / "speaker_merge.py",
    SCRIPTS / "stt_daemon" / "speaker_count.py",
]

# macOS-only tokens drawn from the PROJECT/ARCHITECTURE platform-coupling table. None of these
# may appear in the diarization stack (it must be OS-neutral). ``darwin``/``Darwin`` included so a
# ``sys.platform == 'darwin'`` branch can't sneak in.
MACOS_TOKENS = [
    "launchctl", "launchd", "tccutil", "osascript", "ScreenCaptureKit", "AVFoundation",
    "import Cocoa", "import AppKit", "import Foundation", "import objc",
    "/opt/homebrew", "com.apple", "terminal-notifier", "Darwin", "darwin",
]


@pytest.mark.parametrize("src", DIARIZATION_SOURCES, ids=lambda p: p.name)
def test_diarization_source_has_no_macos_coupling(src):
    assert src.is_file(), f"{src} must exist"
    text = src.read_text(encoding="utf-8")
    offenders = [tok for tok in MACOS_TOKENS if tok in text]
    assert not offenders, f"{src.name} leaked macOS-only tokens (must be portable): {offenders}"


def test_diarize_backend_imports_without_sherpa_or_macos():
    """The backend module imports with NO sherpa installed (lazy import) — so CI on any OS loads
    it; ``SherpaDiarizeBackend`` / the ``DiarizeBackend`` Protocol are accessible without sherpa."""
    mod = importlib.import_module("stt_daemon.backends.diarize")
    assert hasattr(mod, "SherpaDiarizeBackend")
    assert hasattr(mod, "DiarizeBackend")
    # Constructing the backend must NOT import sherpa (only warm_up/diarize do).
    backend = mod.SherpaDiarizeBackend(seg_model="/nope/seg.onnx", emb_model="/nope/emb.onnx")
    assert backend.is_ready() is False


def test_diarize_pipeline_imports_without_sherpa_or_macos():
    mod = importlib.import_module("stt_daemon.diarize_pipeline")
    assert hasattr(mod, "run_diarize_stage")
    assert hasattr(mod, "diarization_enabled")


def test_diarize_backend_protocol_is_runtime_checkable_seam():
    """The provider seam is a runtime-checkable Protocol — a non-sherpa/non-macOS impl satisfying
    warm_up/diarize/is_ready/release is a drop-in (config-selected), not a macOS subclass."""
    mod = importlib.import_module("stt_daemon.backends.diarize")
    proto = mod.DiarizeBackend

    class _FakePortableBackend:
        async def warm_up(self): ...
        async def diarize(self, *, audio_path, num_speakers, cancel_token): return []
        def is_ready(self): return True
        def release(self): ...

    assert isinstance(_FakePortableBackend(), proto)
