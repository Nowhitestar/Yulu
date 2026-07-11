"""Stdlib-shadow guard for the platform seam (RESEARCH Pitfall 1, threat T-01-01).

The runtime puts ``yulu/scripts`` on ``PYTHONPATH`` and ``doctor.py`` inserts it
on ``sys.path``. If the platform package were ever named ``platform/``
instead of ``yulu_platform/``, ``import platform`` from any process with
``yulu/scripts`` on the path would resolve to OUR package instead of the stdlib
``platform`` module — which ``numpy`` (imported by ``echo_cancel.py``) pulls in
transitively, breaking the daemon. This was verified empirically in RESEARCH.

This test reproduces that path order and asserts stdlib ``platform`` still wins.
It fails loud the moment anyone renames the package back to ``platform/``.
"""

import importlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"


def test_stdlib_platform_not_shadowed():
        # Reproduce the runtime path order: yulu/scripts at the FRONT of sys.path.
    sys.path.insert(0, str(SCRIPTS))
    try:
        # Drop any cached binding so the import re-resolves against the path above.
        sys.modules.pop("platform", None)
        import platform

        resolved = Path(platform.__file__).resolve()
        scripts_dir = SCRIPTS.resolve()
        # The genuine stdlib module must NOT live under yulu/scripts.
        assert scripts_dir not in resolved.parents and resolved.parent != scripts_dir, (
            f"stdlib 'platform' is shadowed by {resolved} under {scripts_dir} — "
            "the platform package must be named 'yulu_platform', never 'platform'"
        )
        # Sanity: it is the real module (has the stdlib API).
        assert hasattr(platform, "system")
    finally:
        # Restore a clean import state for the rest of the suite.
        sys.modules.pop("platform", None)
        importlib.import_module("platform")


def test_yulu_platform_is_the_package_name():
    # The package must import under its safe name and not collide with stdlib.
    sys.path.insert(0, str(SCRIPTS))
    import yulu_platform.base  # must resolve to yulu/scripts/yulu_platform

    # base.py lives at .../yulu/scripts/yulu_platform/base.py — its parent dir
    # (the package root) must be named 'yulu_platform', never 'platform'.
    pkg_path = Path(yulu_platform.base.__file__).resolve()
    assert pkg_path.parent.name == "yulu_platform"
