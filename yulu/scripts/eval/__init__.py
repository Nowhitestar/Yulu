"""Yulu diarization evaluation harness (Phase 11 — the Gate).

**Dev/eval-time only.** Nothing in this package is imported by Yulu's shipped runtime
(``stt_daemon`` / ``transcribe.py`` / ``agent_queue_worker.py``). It exists to convert
"diarization runs" into a defensible *number* — DER / WDER / SER / speaker-count error on a
fixed reference corpus — so the default provider is picked on evidence (the ADR) and the UI's
accuracy copy is sourced from measurement (``ui_copy``), not feel.

Torch-free by construction: the metric math (``metrics``) and the RTTM I/O (``rttm``) are pure
stdlib Python, so the test suite runs in CI with no model, no sherpa, no torch. ``pyannote.metrics``
is used only as an *optional cross-check* in a throwaway eval venv — never added to the runtime.

Modules
-------
- ``rttm``    — NIST RTTM read/write + the ``Timeline``/``Turn`` value types the metrics consume.
- ``metrics`` — DER (collar + overlap toggles), WDER, SER, speaker-count error; pure Python.
- ``corpus``  — CONSTRUCTED-ground-truth corpus generator (macOS ``say`` voices stitched at known
                offsets → exact RTTM by construction, zero anchoring bias) + Audacity→RTTM helper.
- ``harness`` — the re-runnable CLI: provider → hyp RTTM → metric table, bucketed CN/EN.
- ``ui_copy`` — the honest accuracy-hint string set, parameterized by the measured DER.
"""

__all__ = [
    "rttm",
    "metrics",
    "corpus",
    "harness",
    "ui_copy",
]
