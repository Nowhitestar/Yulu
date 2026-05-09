import importlib.util
import os
from pathlib import Path


def _load_module(path):
    spec = importlib.util.spec_from_file_location("codex_llm", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_find_codex_prefers_yulu_codex_bin(tmp_path, monkeypatch):
    codex = tmp_path / "codex"
    codex.write_text("#!/bin/sh\n", encoding="utf-8")
    codex.chmod(0o755)
    monkeypatch.setenv("YULU_CODEX_BIN", str(codex))

    module = _load_module(Path(__file__).resolve().parents[1] / "yulu" / "scripts" / "codex_llm.py")

    assert module.find_codex() == str(codex)


def test_find_codex_falls_back_to_nvm_glob(tmp_path, monkeypatch):
    fake_home = tmp_path / "home"
    codex = fake_home / ".nvm" / "versions" / "node" / "v20.17.0" / "bin" / "codex"
    codex.parent.mkdir(parents=True)
    codex.write_text("#!/bin/sh\n", encoding="utf-8")
    codex.chmod(0o755)
    monkeypatch.delenv("YULU_CODEX_BIN", raising=False)
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("HOME", str(fake_home))

    module = _load_module(Path(__file__).resolve().parents[1] / "yulu" / "scripts" / "codex_llm.py")

    assert module.find_codex() == str(codex)
