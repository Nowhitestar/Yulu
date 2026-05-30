"""DATA-03 cloud-sync-root detection tests — fully mocked, OS-independent.

``yulu_platform.macos.cloud_detect`` is pure stdlib (os, stat, dataclasses,
pathlib) with NO Darwin gate at import time, so this whole module imports and
runs on any OS (Linux CI included). The two cloud-root families are matched by
PATH PREFIX (relative to ``Path.home()``), so we pin a fake home via monkeypatch
and the prefix logic is deterministic everywhere — no real iCloud/CloudStorage
folder, and no real Darwin ``st_flags`` bit, is required.

Eviction (``SF_DATALESS = 0x40000000``) is exercised by mocking ``os.stat`` to
return an object carrying a synthetic ``st_flags`` — never by touching a real
dataless file. The detector must use ``stat.SF_DATALESS`` and NEVER ``os.getxattr``
(absent on macOS CPython — RESEARCH Pitfall 2).
"""

import os
import stat
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "yulu" / "scripts"))

# Imports on ANY OS — no Darwin gate (the no-shadow/stub tests rely on this, and
# Plan 01 imports it lazily). A failure here is itself a regression.
from yulu_platform.macos import cloud_detect  # noqa: E402
from yulu_platform.macos.cloud_detect import (  # noqa: E402
    CloudRootResult,
    is_cloud_root,
    is_evicted,
)


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    """Pin ``Path.home()`` so the path-prefix classification is hermetic on any OS."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    return home


def _no_dataless(monkeypatch):
    """Force ``_is_dataless`` to always be False so path-prefix tests don't depend
    on the real ``st_flags`` of a tmp dir (clean on Darwin, AttributeError off it)."""
    monkeypatch.setattr(cloud_detect, "_is_dataless", lambda p: False)


# ── Path-prefix family classification ────────────────────────────────────────


def test_icloud_drive_is_cloud(fake_home, monkeypatch):
    _no_dataless(monkeypatch)
    target = fake_home / "Library/Mobile Documents/com~apple~CloudDocs/Yulu"
    target.mkdir(parents=True)
    result = is_cloud_root(target)
    assert isinstance(result, CloudRootResult)
    assert result.is_cloud is True
    assert result.engine == "icloud"
    assert "icloud" in result.reason.lower()


def test_google_drive_cloudstorage_is_cloud_and_named(fake_home, monkeypatch):
    _no_dataless(monkeypatch)
    target = fake_home / "Library/CloudStorage/GoogleDrive-me@x.com/Yulu"
    target.mkdir(parents=True)
    result = is_cloud_root(target)
    assert result.is_cloud is True
    assert result.engine == "google-drive"


def test_dropbox_cloudstorage_is_cloud(fake_home, monkeypatch):
    _no_dataless(monkeypatch)
    target = fake_home / "Library/CloudStorage/Dropbox/Yulu"
    target.mkdir(parents=True)
    result = is_cloud_root(target)
    assert result.is_cloud is True
    assert result.engine == "dropbox"


def test_onedrive_cloudstorage_is_cloud(fake_home, monkeypatch):
    _no_dataless(monkeypatch)
    target = fake_home / "Library/CloudStorage/OneDrive-Personal/Yulu"
    target.mkdir(parents=True)
    result = is_cloud_root(target)
    assert result.is_cloud is True
    assert result.engine == "onedrive"


def test_unknown_cloudstorage_engine_still_cloud(fake_home, monkeypatch):
    _no_dataless(monkeypatch)
    target = fake_home / "Library/CloudStorage/SomeNewEngine-acct/Yulu"
    target.mkdir(parents=True)
    result = is_cloud_root(target)
    assert result.is_cloud is True
    assert result.engine == "cloudstorage"


def test_config_yulu_is_not_cloud(fake_home, monkeypatch):
    _no_dataless(monkeypatch)
    target = fake_home / ".config/yulu"
    target.mkdir(parents=True)
    result = is_cloud_root(target)
    assert result.is_cloud is False
    assert result.engine == ""


def test_movies_yulu_is_not_cloud(fake_home, monkeypatch):
    _no_dataless(monkeypatch)
    target = fake_home / "Movies/Yulu"
    target.mkdir(parents=True)
    result = is_cloud_root(target)
    assert result.is_cloud is False


def test_path_outside_home_is_not_cloud(fake_home, monkeypatch):
    """A path that does not live under home (relative_to raises) is not cloud."""
    _no_dataless(monkeypatch)
    result = is_cloud_root("/tmp/somewhere/else/yulu")
    assert result.is_cloud is False


# ── SF_DATALESS eviction signal (mocked os.stat — never a real dataless file) ──


class _FakeStat:
    def __init__(self, st_flags):
        self.st_flags = st_flags


def test_is_evicted_true_when_sf_dataless_set(monkeypatch):
    monkeypatch.setattr(
        os, "stat", lambda *a, **k: _FakeStat(stat.SF_DATALESS | 0o60)
    )
    assert is_evicted("/any/path") is True


def test_is_evicted_false_when_bit_clear(monkeypatch):
    monkeypatch.setattr(os, "stat", lambda *a, **k: _FakeStat(0))
    assert is_evicted("/any/path") is False


def test_is_evicted_false_on_oserror(monkeypatch):
    def _raise(*a, **k):
        raise OSError("boom")

    monkeypatch.setattr(os, "stat", _raise)
    assert is_evicted("/any/path") is False  # never raises


def test_dataless_belt_and_suspenders_flags_non_root_path(fake_home, monkeypatch):
    """A path under NEITHER cloud family but whose os.stat reports SF_DATALESS is
    still flagged is_cloud (the OS already evicted it → some sync engine owns it)."""
    target = fake_home / "Documents/weird"
    target.mkdir(parents=True)
    monkeypatch.setattr(
        os, "stat", lambda *a, **k: _FakeStat(stat.SF_DATALESS)
    )
    result = is_cloud_root(target)
    assert result.is_cloud is True
    assert result.dataless_sample is True


# ── Never-raise contract ─────────────────────────────────────────────────────


def test_garbage_path_returns_not_cloud_without_raising():
    # A type the path machinery can choke on must degrade, not raise.
    result = is_cloud_root(object())  # type: ignore[arg-type]
    assert isinstance(result, CloudRootResult)
    assert result.is_cloud is False


def test_module_uses_sf_dataless_not_getxattr():
    """RESEARCH Pitfall 2: detection must use SF_DATALESS (stdlib), never
    os.getxattr (absent on macOS CPython)."""
    src = Path(cloud_detect.__file__).read_text(encoding="utf-8")
    assert "SF_DATALESS" in src
    assert "getxattr" not in src
