"""Phase 5 DATA-01: content-root literals route through PathResolver.data_dir().

The three hardcoded ``~/Movies/Yulu`` literals (``search.indexer.CORPUS_ROOT``,
``voicemail.repo.VOICEMAIL_DIR_DEFAULT``, and ``record_audio``'s output_dir
fallback) must follow the configurable ``data_dir()`` — NOT a bare literal — so a
configured data-folder moves new content. The runtime side (``SEARCH_DB_PATH``)
must instead route through ``runtime_dir()`` and stay machine-local
(``~/.config/yulu``): the runtime/content split must hold.

These module-level names are computed at import time, so each test sets the
environment, then ``importlib.reload``s the module to re-evaluate them under the
monkeypatched config — and reloads back to the default state on teardown so the
shared session is left clean.

Darwin-gated for the resolved-value assertions (``MacOSPathResolver`` raises off
Darwin); the import-fallback assertion runs on every OS.
"""

import importlib
import platform
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

_DARWIN = platform.system() == "Darwin"
darwin_only = pytest.mark.skipif(not _DARWIN, reason="MacOSPathResolver requires Darwin")


def _reload(module_name):
    import importlib as _il

    mod = _il.import_module(module_name)
    return _il.reload(mod)


@pytest.fixture
def restore_modules():
    """Reload the touched modules back to default (no env) after each test, so a
    reloaded module computed under a temp config doesn't leak into other tests."""
    yield
    import os

    for key in ("YULU_CONFIG_DIR", "YULU_OUTPUT_DIR"):
        os.environ.pop(key, None)
    for name in ("search.indexer", "voicemail.repo", "search", "search.reader"):
        if name in sys.modules:
            try:
                importlib.reload(sys.modules[name])
            except Exception:
                pass


@darwin_only
def test_corpus_root_follows_configured_data_dir(tmp_path, monkeypatch, restore_modules):
    """search.indexer.CORPUS_ROOT == data_dir() when config sets audio.output_dir,
    NOT the bare ~/Movies/Yulu literal."""
    cfg_home = tmp_path / "home"
    cfg_dir = cfg_home / ".config/yulu"
    cfg_dir.mkdir(parents=True)
    custom_content = tmp_path / "MyCloudFolder" / "Yulu"
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: cfg_home))
    monkeypatch.setenv("YULU_CONFIG_DIR", str(cfg_dir))
    monkeypatch.delenv("YULU_OUTPUT_DIR", raising=False)
    (cfg_dir / "config.json").write_text(
        '{"audio": {"output_dir": "%s"}}' % custom_content, encoding="utf-8"
    )

    indexer = _reload("search.indexer")

    from yulu_platform.macos.path_resolver import MacOSPathResolver

    expected = MacOSPathResolver().data_dir()
    assert indexer.CORPUS_ROOT == expected
    assert indexer.CORPUS_ROOT == custom_content
    # The bare literal must NOT survive.
    assert indexer.CORPUS_ROOT != Path.home() / "Movies" / "Yulu"


@darwin_only
def test_voicemail_dir_default_follows_data_dir(tmp_path, monkeypatch, restore_modules):
    """voicemail.repo.VOICEMAIL_DIR_DEFAULT == data_dir()/'voicemails'."""
    cfg_home = tmp_path / "home"
    cfg_dir = cfg_home / ".config/yulu"
    cfg_dir.mkdir(parents=True)
    custom_content = tmp_path / "MyCloudFolder" / "Yulu"
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: cfg_home))
    monkeypatch.setenv("YULU_CONFIG_DIR", str(cfg_dir))
    monkeypatch.delenv("YULU_OUTPUT_DIR", raising=False)
    (cfg_dir / "config.json").write_text(
        '{"audio": {"output_dir": "%s"}}' % custom_content, encoding="utf-8"
    )

    repo = _reload("voicemail.repo")

    from yulu_platform.macos.path_resolver import MacOSPathResolver

    assert repo.VOICEMAIL_DIR_DEFAULT == MacOSPathResolver().data_dir() / "voicemails"
    assert repo.VOICEMAIL_DIR_DEFAULT == custom_content / "voicemails"


@darwin_only
def test_search_db_path_routes_through_runtime_dir(tmp_path, monkeypatch, restore_modules):
    """SEARCH_DB_PATH (runtime) resolves under runtime_dir() (== ~/.config/yulu),
    NEVER under data_dir() — the runtime/content split holds even when the content
    folder is configured elsewhere."""
    cfg_home = tmp_path / "home"
    cfg_dir = cfg_home / ".config/yulu"
    cfg_dir.mkdir(parents=True)
    custom_content = tmp_path / "MyCloudFolder" / "Yulu"
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: cfg_home))
    monkeypatch.setenv("YULU_CONFIG_DIR", str(cfg_dir))
    monkeypatch.delenv("YULU_OUTPUT_DIR", raising=False)
    (cfg_dir / "config.json").write_text(
        '{"audio": {"output_dir": "%s"}}' % custom_content, encoding="utf-8"
    )

    indexer = _reload("search.indexer")

    from yulu_platform.macos.path_resolver import MacOSPathResolver

    resolver = MacOSPathResolver()
    # Runtime DB lives under the LOCKED runtime dir, same value as today.
    assert indexer.SEARCH_DB_PATH == resolver.runtime_dir() / "search.sqlite"
    assert indexer.SEARCH_DB_PATH == cfg_dir / "search.sqlite"
    # And NOT under the configured content folder.
    assert custom_content not in indexer.SEARCH_DB_PATH.parents


def test_corpus_root_falls_back_when_resolver_unavailable(tmp_path, monkeypatch, restore_modules):
    """With the resolver forced unavailable (simulate off-Darwin / ImportError),
    CORPUS_ROOT falls back to ~/Movies/Yulu — the module always imports."""
    import builtins

    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    monkeypatch.delenv("YULU_CONFIG_DIR", raising=False)
    monkeypatch.delenv("YULU_OUTPUT_DIR", raising=False)

    real_import = builtins.__import__

    def blocked_import(name, *args, **kwargs):
        if "path_resolver" in name or name.endswith("yulu_platform.macos"):
            raise ImportError("simulated: resolver unavailable")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked_import)

    indexer = _reload("search.indexer")

    # Historical literal fallback — never crashes on import.
    assert indexer.CORPUS_ROOT == fake_home / "Movies" / "Yulu"
