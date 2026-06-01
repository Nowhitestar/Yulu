"""Wave-0 contract for capabilities.probes.list_models() — the SET-04 model pick-list source.

``list_models()`` is an ADDITIVE sibling to ``scan_models`` (Phase 3 frozen contract): where
``scan_models`` returns an aggregate Capability ("N models, X bytes"), ``list_models`` returns a
plain list of per-model ``{name, path, size}`` dicts so the Phase 4 UI model selector (04-03)
has real, selectable options.

Locked invariants (mirror the scan_models discipline — same fixed ``_model_roots()`` allowlist):

- Per-file listing: each entry has exactly ``name`` / ``path`` / ``size`` keys.
- Resolved-path dedupe: a file reachable via two overlapping globs (``*.bin`` and ``**/*.bin``)
  appears once, not twice (T-04-01 — same as scan_models).
- Never-raise: returns ``[]`` when no roots exist / on any OSError (scan_models never-raise contract).
- Path-bounding (T-04-01): only files under the fixed ``_model_roots()`` are listed — a file
  outside those roots is NEVER returned (no traversal outside the allowlist).
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "yulu" / "scripts"))

from capabilities import probes  # noqa: E402


# ── Test 1: per-model name/path/size from two seeded files ──


def test_list_models_returns_name_path_size_per_file(monkeypatch, tmp_path):
    root = tmp_path / "models"
    root.mkdir(parents=True)
    (root / "ggml-large-v3.bin").write_bytes(b"x" * 1024)
    (root / "ggml-base.bin").write_bytes(b"y" * 2048)
    monkeypatch.setattr(probes, "_model_roots", lambda: [root])

    models = probes.list_models()
    assert isinstance(models, list)
    assert len(models) == 2
    for entry in models:
        assert set(entry.keys()) == {"name", "path", "size"}

    by_name = {m["name"]: m for m in models}
    # Names match the file basenames/stems.
    assert "ggml-large-v3.bin" in by_name
    assert "ggml-base.bin" in by_name
    assert by_name["ggml-large-v3.bin"]["size"] == 1024
    assert by_name["ggml-base.bin"]["size"] == 2048
    # Paths are resolved absolute strings pointing at the seeded files.
    assert by_name["ggml-large-v3.bin"]["path"].endswith("ggml-large-v3.bin")
    assert Path(by_name["ggml-large-v3.bin"]["path"]).is_absolute()
    # Stable output: sorted by name.
    assert [m["name"] for m in models] == sorted(m["name"] for m in models)


# ── Test 2: resolved-path dedupe across overlapping globs (T-04-01, same as scan_models) ──


def test_list_models_dedupes_overlapping_globs(monkeypatch, tmp_path):
    # A nested file is reachable by BOTH `*.bin` (no — it's nested) and `**/*.bin`; and a
    # top-level file is reachable by `*.bin` and `**/*.bin`. The top-level one is the overlap.
    root = tmp_path / "models"
    root.mkdir(parents=True)
    (root / "ggml-top.bin").write_bytes(b"z" * 512)  # matched by *.bin AND **/*.bin
    nested = root / "sub"
    nested.mkdir()
    (nested / "ggml-nested.bin").write_bytes(b"w" * 256)  # matched by **/*.bin only
    monkeypatch.setattr(probes, "_model_roots", lambda: [root])

    models = probes.list_models()
    paths = [m["path"] for m in models]
    # No duplicate paths even though ggml-top.bin matches two glob patterns.
    assert len(paths) == len(set(paths))
    names = sorted(m["name"] for m in models)
    assert names == ["ggml-nested.bin", "ggml-top.bin"]


# ── Test 3: never-raise — [] when no roots exist / on OSError (scan_models contract) ──


def test_list_models_returns_empty_when_no_roots(monkeypatch, tmp_path):
    monkeypatch.setattr(probes, "_model_roots", lambda: [tmp_path / "does-not-exist"])
    assert probes.list_models() == []


def test_list_models_never_raises_on_oserror(monkeypatch):
    def boom():
        raise OSError("boom")

    # Even if root resolution itself explodes, list_models degrades to [].
    monkeypatch.setattr(probes, "_model_roots", boom)
    assert probes.list_models() == []


# ── Test 4: path-bounding — a file outside _model_roots() is NEVER listed (T-04-01) ──


def test_list_models_only_lists_files_under_known_roots(monkeypatch, tmp_path):
    known = tmp_path / "known"
    known.mkdir()
    (known / "ggml-inside.bin").write_bytes(b"a" * 64)

    # A model-looking file OUTSIDE the allowlisted roots — must never appear.
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "ggml-outside.bin").write_bytes(b"b" * 64)

    monkeypatch.setattr(probes, "_model_roots", lambda: [known])

    models = probes.list_models()
    names = {m["name"] for m in models}
    assert "ggml-inside.bin" in names
    assert "ggml-outside.bin" not in names
    # And no listed path escapes the known root.
    for m in models:
        assert str(known.resolve()) in m["path"]
