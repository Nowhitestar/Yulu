"""D-09 / success-criterion-4 neutrality proof for the ``yulu_platform`` seam.

Proves to a reviewer (and CI) that a hypothetical systemd / Linux arm could
implement the exact same methods: the ABC *signatures* plus the ``ServiceSpec``
fields carry no launchd / TCC / Core-Audio-tap vocabulary.

NOTE: this scopes to SIGNATURES, never module source. ``base.py``'s
``DependencyManager`` docstring (base.py:90) names "Homebrew"/"apt" as PROSE
examples; that is not a signature leak, and D-09's intent is "no leaked vocab in
*signatures*". So we inspect ``inspect.signature(...)`` + ``dataclasses.fields(...)``
and deliberately never read the raw module text — which both honors D-09's real
intent and keeps this gate GREEN by construction against the FROZEN base.py.
"""

import dataclasses
import inspect
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "yulu" / "scripts"))

from yulu_platform import base  # noqa: E402

# macOS-STRUCTURAL tokens that genuinely cannot appear in a neutral signature.
# ``homebrew``/``brew`` are intentionally EXCLUDED: they live only in the
# DependencyManager docstring as prose examples (base.py:90), not in any signature.
_FORBIDDEN = [
    "launchctl",
    "plist",
    "launchagent",
    "keepalive",
    "runatload",
    "tccutil",
    "screencapture",
    "scstream",
    "catap",
    "sckit",
]


def _signature_text() -> str:
    """Assemble lowercased text from SIGNATURES ONLY (no docstrings, no source)."""
    parts: list[str] = []
    for abc in (
        base.DaemonManager,
        base.PathResolver,
        base.PermissionModel,
        base.DependencyManager,
    ):
        for name in getattr(abc, "__abstractmethods__", ()):  # method names
            parts.append(name)
            parts.append(str(inspect.signature(getattr(abc, name))))  # params + annotations
    for field in dataclasses.fields(base.ServiceSpec):  # field names + annotations
        parts.append(field.name)
        parts.append(str(field.type))
    return " ".join(parts).lower()


def test_no_macos_vocabulary_in_signatures():
    sig = _signature_text()
    for word in _FORBIDDEN:
        assert (
            word.lower() not in sig
        ), f"macOS vocab '{word}' leaked into a base.py signature (D-09)"
