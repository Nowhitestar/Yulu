from pathlib import Path

import yulu.scripts.local_caption_runtime as runtime


def create_complete_runtime(config_dir: Path):
    paths = runtime.runtime_paths(config_dir)
    paths["python"].parent.mkdir(parents=True)
    paths["python"].write_text("python", encoding="utf-8")
    paths["model"].mkdir(parents=True)
    for name in runtime.MODEL_FILES:
        (paths["model"] / name).write_bytes(name.encode())
    return paths


def test_status_requires_both_runtime_and_all_int8_model_files(monkeypatch, tmp_path):
    paths = create_complete_runtime(tmp_path)
    monkeypatch.setattr(runtime, "_sherpa_import_ok", lambda python: python == paths["python"])
    monkeypatch.setattr(runtime, "_verify_model_hashes", runtime._model_complete)

    current = runtime.status(tmp_path)

    assert current["installed"] is True
    assert current["runtimeReady"] is True
    assert current["modelReady"] is True
    assert current["runtimeBytes"] > 0
    assert current["modelBytes"] > 0

    (paths["model"] / "decoder.int8.onnx").unlink()
    assert runtime.status(tmp_path)["installed"] is False


def test_uninstall_removes_only_the_managed_runtime_and_model(monkeypatch, tmp_path):
    paths = create_complete_runtime(tmp_path)
    other_model = tmp_path / "models" / "keep-me" / "model.bin"
    other_model.parent.mkdir(parents=True)
    other_model.write_text("keep", encoding="utf-8")
    monkeypatch.setattr(runtime, "_sherpa_import_ok", lambda _python: False)

    result = runtime.uninstall(tmp_path)

    assert result["installed"] is False
    assert not paths["runtime"].exists()
    assert not paths["model"].exists()
    assert other_model.read_text(encoding="utf-8") == "keep"
