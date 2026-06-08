"""MLX capability probe semantics.

The settings page must not report a package as truly usable unless the daemon interpreter can
fully import it. It also must not call an installed-but-runtime-blocked package "absent"; that
state needs to stay visible so provisioning can repair it and users can see the real reason.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import pytest

from capabilities import probes  # noqa: E402
from capabilities.report import Provenance, Status  # noqa: E402


@pytest.fixture(autouse=True)
def clear_mlx_probe_cache():
    probes.probe_mlx_whisper.cache_clear()
    yield
    probes.probe_mlx_whisper.cache_clear()


def test_mlx_probe_absent_when_package_spec_missing(monkeypatch):
    monkeypatch.setattr(probes, "probe_module_spec", lambda mod: (False, "mlx_whisper not installed"))

    cap = probes.probe_mlx_whisper()

    assert cap.provenance is Provenance.ABSENT
    assert cap.status is Status.ABSENT
    assert "not installed" in cap.detail


def test_mlx_probe_present_unverified_when_dependency_missing(monkeypatch):
    def _spec(mod):
        if mod == "mlx_whisper":
            return True, "/site/mlx_whisper/__init__.py"
        return False, "yaml not installed"

    monkeypatch.setattr(probes, "probe_module_spec", _spec)
    monkeypatch.setattr(probes, "daemon_python", lambda: "/usr/bin/python3")

    cap = probes.probe_mlx_whisper()

    assert cap.provenance is Provenance.HOST_PATH
    assert cap.status is Status.PRESENT_BUT_UNVERIFIED
    assert cap.resolved_path == "/usr/bin/python3"
    assert "installed at /site/mlx_whisper/__init__.py" in cap.detail
    assert "dependency yaml missing" in cap.detail


def test_mlx_probe_present_unverified_without_deep_probe(monkeypatch):
    def _spec(mod):
        return True, f"/site/{mod}/__init__.py"

    def _explode(mod):
        raise AssertionError("deep import must not run by default")

    monkeypatch.setattr(probes, "probe_module_spec", _spec)
    monkeypatch.setattr(probes, "probe_importable", _explode)
    monkeypatch.setattr(probes, "daemon_python", lambda: "/usr/bin/python3")

    cap = probes.probe_mlx_whisper()

    assert cap.provenance is Provenance.HOST_PATH
    assert cap.status is Status.PRESENT_BUT_UNVERIFIED
    assert "runtime warm-up not run" in cap.detail


def test_mlx_probe_usable_only_after_explicit_deep_import_succeeds(monkeypatch):
    monkeypatch.setenv("YULU_DEEP_CAPABILITY_PROBES", "1")
    monkeypatch.setattr(probes, "probe_module_spec", lambda mod: (True, f"/site/{mod}/__init__.py"))
    monkeypatch.setattr(probes, "probe_importable", lambda mod: (True, "0.4.2"))
    monkeypatch.setattr(probes, "daemon_python", lambda: "/usr/bin/python3")

    cap = probes.probe_mlx_whisper()

    assert cap.provenance is Provenance.HOST_PATH
    assert cap.status is Status.USABLE
    assert cap.detail == "mlx_whisper 0.4.2"
