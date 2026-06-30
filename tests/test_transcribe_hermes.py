import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import transcribe


def test_hermes_diarization_requires_final_provider_pass():
    assert transcribe._provider_diarization_requested({
        "final_engine": "hermes",
        "hermes": {"diarize": True},
    }) is True
    assert transcribe._provider_diarization_requested({
        "final_engine": "hermes",
        "hermes": {"diarize": False},
    }) is False
    assert transcribe._provider_diarization_requested({
        "final_engine": "mlx",
    }) is False
