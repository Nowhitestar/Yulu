import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from search.roots import DEFAULT_ROOT_ID, build_registry, content_roots  # noqa: E402


def test_content_roots_default_to_single_yulu_data_root(tmp_path):
    data_root = tmp_path / "Movies" / "Yulu"
    runtime = tmp_path / ".config" / "yulu"

    registry = build_registry(fallback_root=data_root, runtime_dir=runtime)

    assert [root.id for root in registry.roots] == [DEFAULT_ROOT_ID]
    assert registry.paths() == [data_root]
    assert registry.roots[0].read_only is True
    assert registry.rejected_roots == ()


def test_runtime_root_is_rejected_as_search_content(tmp_path):
    runtime = tmp_path / ".config" / "yulu"

    registry = build_registry(fallback_root=runtime, runtime_dir=runtime)

    assert registry.roots == ()
    assert registry.rejected_roots[0]["id"] == DEFAULT_ROOT_ID
    assert "runtime roots" in registry.rejected_roots[0]["reason"]
    assert content_roots(fallback_root=runtime, runtime_dir=runtime) == []


def test_parent_of_runtime_root_is_rejected(tmp_path):
    runtime = tmp_path / ".config" / "yulu"

    registry = build_registry(fallback_root=tmp_path, runtime_dir=runtime)

    assert registry.paths() == []
    assert registry.rejected_roots[0]["path"] == str(tmp_path)
