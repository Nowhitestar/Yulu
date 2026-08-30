"""Phase 5 DATA-01: content-root literals route through PathResolver.data_dir().

The hardcoded ``~/Movies/Yulu`` literals (``search.indexer.CORPUS_ROOT`` and
``record_audio``'s output_dir fallback) must follow the configurable
``data_dir()`` — NOT a bare literal — so a configured data-folder moves new
content. The runtime side (``SEARCH_DB_PATH``) must instead route through
``runtime_dir()`` and stay machine-local (``~/.config/yulu``): the
runtime/content split must hold.

These module-level names are computed at import time. Rather than ``importlib.
reload`` the shared modules under a temp config (which pollutes module-level
dataclass / exception identity and breaks unrelated tests via cross-class ``==``),
this suite tests the *resolver helpers* directly under a monkeypatched config —
they are pure functions with no module-state side effects — and asserts that each
module-level constant is wired to the matching helper output.

Darwin-gated for the resolved-value assertions (``MacOSPathResolver`` raises off
Darwin); the import-fallback assertions run on every OS.
"""

import platform
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import record_audio  # noqa: E402
from search import indexer  # noqa: E402

_DARWIN = platform.system() == "Darwin"
darwin_only = pytest.mark.skipif(not _DARWIN, reason="MacOSPathResolver requires Darwin")


def _write_config(tmp_path, monkeypatch, content_dir):
    """Point home + $YULU_CONFIG_DIR at a temp tree whose config.json sets
    audio.output_dir to *content_dir*; return the config dir."""
    cfg_home = tmp_path / "home"
    cfg_dir = cfg_home / ".config/yulu"
    cfg_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: cfg_home))
    monkeypatch.setenv("YULU_CONFIG_DIR", str(cfg_dir))
    monkeypatch.delenv("YULU_OUTPUT_DIR", raising=False)
    (cfg_dir / "config.json").write_text(
        '{"audio": {"output_dir": "%s"}}' % content_dir, encoding="utf-8"
    )
    return cfg_dir


# --- The three content literals are wired to a data_dir() helper ----------------


@darwin_only
def test_indexer_data_helper_follows_config(tmp_path, monkeypatch):
    """search.indexer._resolve_data_dir() == data_dir() under a configured
    output_dir — NOT the bare ~/Movies/Yulu literal."""
    from yulu_platform.macos.path_resolver import MacOSPathResolver

    custom = tmp_path / "MyCloudFolder" / "Yulu"
    _write_config(tmp_path, monkeypatch, custom)

    assert indexer._resolve_data_dir() == MacOSPathResolver().application_paths().media_library_dir
    assert indexer._resolve_data_dir() == custom
    assert indexer._resolve_data_dir() != Path.home() / "Movies" / "Yulu"


@darwin_only
def test_record_audio_fallback_follows_config(tmp_path, monkeypatch):
    """record_audio._resolve_data_dir() (the output_dir fallback) == data_dir(),
    not the old repo-relative meeting-recordings dir."""
    from yulu_platform.macos.path_resolver import MacOSPathResolver

    custom = tmp_path / "MyCloudFolder" / "Yulu"
    _write_config(tmp_path, monkeypatch, custom)

    assert record_audio._resolve_data_dir() == MacOSPathResolver().application_paths().media_library_dir
    assert record_audio._resolve_data_dir() == custom
    # The old repo-relative fallback must be gone.
    assert "meeting-recordings" not in str(record_audio._resolve_data_dir())


# --- The module-level constants are wired to the helpers (default-config) --------


def test_corpus_root_wired_to_data_helper():
    """CORPUS_ROOT is the data_dir() helper output (content), not an independent
    literal — they must agree under the ambient (default) config."""
    assert indexer.CORPUS_ROOT == indexer._resolve_data_dir()


# --- The runtime/content split holds: SEARCH_DB_PATH is RUNTIME -----------------


@darwin_only
def test_search_db_path_routes_through_standard_durable_not_data(tmp_path, monkeypatch):
    """SEARCH_DB_PATH resolves under Application Support, NEVER under
    a configured data_dir() — the runtime/content split holds."""
    from yulu_platform.macos.path_resolver import MacOSPathResolver

    custom = tmp_path / "MyCloudFolder" / "Yulu"
    _write_config(tmp_path, monkeypatch, custom)
    resolver = MacOSPathResolver()
    application = resolver.application_paths()

    # The runtime helper points at the locked runtime dir, not the content dir —
    # under the configured output_dir, runtime resolves to ~/.config/yulu, data to custom.
    assert indexer._resolve_runtime_dir() == application.durable_data_dir
    assert indexer._resolve_runtime_dir() != application.media_library_dir
    # The module-level DB name is search.sqlite under Application Support
    # (frozen at import time), and crucially is NEVER under a configured content dir.
    assert indexer.SEARCH_DB_PATH.name == "search.sqlite"
    assert indexer.SEARCH_DB_PATH.parent.name == "Yulu"
    assert indexer.SEARCH_DB_PATH.parent.parent.name == "Application Support"
    assert custom not in indexer.SEARCH_DB_PATH.parents
    assert application.media_library_dir not in indexer.SEARCH_DB_PATH.parents


# --- Import-fallback: resolver unavailable → historical literal, never crash -----


def test_indexer_data_helper_falls_back_when_resolver_unavailable(tmp_path, monkeypatch):
    """With MacOSPathResolver forced unimportable (off-Darwin / sibling absent),
    the content helper falls back to ~/Movies/Yulu — the module never crashes."""
    import builtins

    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    monkeypatch.delenv("YULU_CONFIG_DIR", raising=False)
    monkeypatch.delenv("YULU_OUTPUT_DIR", raising=False)

    real_import = builtins.__import__

    def blocked_import(name, *args, **kwargs):
        if "path_resolver" in name:
            raise ImportError("simulated: resolver unavailable")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked_import)

    assert indexer._resolve_data_dir() == fake_home / "Movies" / "Yulu"


def test_indexer_runtime_helper_falls_back_when_resolver_unavailable(tmp_path, monkeypatch):
    """The runtime helper falls back to Application Support when the resolver is
    unimportable — machine-local default, never crashes."""
    import builtins

    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    monkeypatch.delenv("YULU_CONFIG_DIR", raising=False)

    real_import = builtins.__import__

    def blocked_import(name, *args, **kwargs):
        if "path_resolver" in name:
            raise ImportError("simulated: resolver unavailable")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked_import)

    assert indexer._resolve_runtime_dir() == fake_home / "Library" / "Application Support" / "Yulu"


def test_search_path_resolution_fails_closed_on_unsafe_authority(monkeypatch):
    from yulu_platform.macos import path_resolver
    from search import roots

    class UnsafeResolver:
        def application_paths(self):
            raise RuntimeError("unsafe Yulu path alias")

    monkeypatch.setattr(path_resolver, "MacOSPathResolver", UnsafeResolver)

    with pytest.raises(RuntimeError, match="unsafe Yulu path alias"):
        indexer._resolve_runtime_dir()
    with pytest.raises(RuntimeError, match="unsafe Yulu path alias"):
        indexer._resolve_data_dir()
    with pytest.raises(RuntimeError, match="unsafe Yulu path alias"):
        roots._resolve_runtime_dir()
    with pytest.raises(RuntimeError, match="unsafe Yulu path alias"):
        roots._resolve_data_dir()
