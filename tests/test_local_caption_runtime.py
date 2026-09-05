import hashlib
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
import yulu.scripts.local_caption_runtime as runtime


def test_cli_status_starts_isolated_without_loading_cwd_or_pythonpath_modules(tmp_path):
    untrusted = tmp_path / "untrusted"
    untrusted.mkdir()
    marker = tmp_path / "untrusted-module-ran"
    for name in ("application_paths.py", "sitecustomize.py", "json.py"):
        (untrusted / name).write_text(
            f"from pathlib import Path\nPath({str(marker)!r}).write_text('unsafe')\n",
            encoding="utf-8",
        )
    config_dir = tmp_path / "Application Support" / "Yulu"
    models_dir = config_dir / "Models"

    result = subprocess.run(
        [
            sys.executable, "-I", "-S", "-B", str(Path(runtime.__file__).resolve()),
            "status", "--config-dir", str(config_dir), "--models-dir", str(models_dir),
        ],
        cwd=untrusted,
        env={**os.environ, "PYTHONPATH": str(untrusted)},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    event = json.loads(result.stdout)
    assert event["event"] == "result"
    assert event["ok"] is True
    assert event["status"]["installed"] is False
    assert event["status"]["modelDir"] == str(models_dir / runtime.MODEL_NAME)
    assert not marker.exists()
    assert not config_dir.exists()


def create_complete_runtime(config_dir: Path):
    paths = runtime.runtime_paths(config_dir)
    paths["pack"].mkdir(parents=True)
    paths["site_packages"].mkdir(parents=True)
    (paths["site_packages"] / "sherpa_onnx.py").write_text("fixture\n", encoding="utf-8")
    paths["model"].mkdir(parents=True)
    for name in runtime.MODEL_FILES:
        (paths["model"] / name).write_bytes(name.encode())
    return paths


def test_runtime_paths_keep_runtime_in_durable_data_and_models_in_standard_child(tmp_path):
    data_dir = tmp_path / "Library" / "Application Support" / "Yulu"
    models_dir = data_dir / "Models"

    paths = runtime.runtime_paths(data_dir, models_dir=models_dir)

    assert paths["runtime"] == data_dir / "local-caption"
    assert paths["model"] == models_dir / runtime.MODEL_NAME


def test_cli_defaults_to_standard_durable_and_models_roots(monkeypatch):
    observed = {}
    monkeypatch.setattr(runtime, "status", lambda config_dir, *, models_dir=None: (
        observed.update(config_dir=config_dir, models_dir=models_dir)
        or {"installed": False}
    ))

    assert runtime.main(["status"]) == 0
    assert observed == {
        "config_dir": runtime.DURABLE_DATA_DIR,
        "models_dir": runtime.MODELS_DIR,
    }


def test_status_requires_both_runtime_and_all_int8_model_files(monkeypatch, tmp_path):
    paths = create_complete_runtime(tmp_path)
    monkeypatch.setattr(runtime, "_runtime_pack_ok", lambda pack, _definition: pack == paths["pack"])
    monkeypatch.setattr(
        runtime,
        "_sherpa_import_ok",
        lambda python, site_packages: python == paths["python"] and site_packages == paths["site_packages"],
    )
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
    monkeypatch.setattr(runtime, "_runtime_pack_ok", lambda _pack, _definition: False)

    result = runtime.uninstall(tmp_path)

    assert result["installed"] is False
    assert not paths["runtime"].exists()
    assert not paths["model"].exists()
    assert other_model.read_text(encoding="utf-8") == "keep"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def create_pack_archive(tmp_path: Path, *, manifest_hash: str | None = None, extra: bool = False) -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    package = b"__version__ = '1.13.2'\n"
    native = b"arm64 native addon\n"
    manifest = {
        "schema": 1,
        "id": "sherpa-onnx-1.13.2-cp313-macos-arm64",
        "version": "1.13.2",
        "architecture": "arm64",
        "pythonAbi": "cp313",
        "files": [
            {"path": "sherpa_onnx/__init__.py", "sha256": manifest_hash or _sha256(package)},
            {"path": "sherpa_onnx/lib/_sherpa_onnx.cpython-313-darwin.so", "sha256": _sha256(native)},
        ],
    }
    bundle = "YuluLocalCaptionRuntime.bundle"
    archive = tmp_path / "runtime-pack.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr(f"{bundle}/Contents/Info.plist", "fixture")
        output.writestr(
            f"{bundle}/Contents/Resources/runtime-pack.json",
            json.dumps(manifest),
        )
        output.writestr(f"{bundle}/Contents/Resources/site-packages/sherpa_onnx/__init__.py", package)
        output.writestr(
            f"{bundle}/Contents/Resources/site-packages/sherpa_onnx/lib/_sherpa_onnx.cpython-313-darwin.so",
            native,
        )
        if extra:
            output.writestr(f"{bundle}/Contents/Resources/site-packages/unexpected.py", "tampered")
    return archive


def pack_definition() -> dict[str, object]:
    return {
        "schema": 1,
        "id": "sherpa-onnx-1.13.2-cp313-macos-arm64",
        "version": "1.13.2",
        "architecture": "arm64",
        "pythonAbi": "cp313",
        "bundleName": "YuluLocalCaptionRuntime.bundle",
        "bundleIdentifier": "com.yulu.runtime.local-caption",
        "assetUrlTemplate": "https://example.invalid/{tag}/runtime-pack.zip",
    }


def test_runtime_pack_is_inventory_checked_and_activated_without_package_manager(
    monkeypatch,
    tmp_path,
):
    archive = create_pack_archive(tmp_path)
    runtime_dir = tmp_path / "config" / "local-caption"
    monkeypatch.setenv("YULU_LOCAL_CAPTION_RUNTIME_PACK_ARCHIVE", str(archive))
    monkeypatch.setattr(runtime, "_verify_pack_code_signatures", lambda _pack, _definition: None)
    monkeypatch.setattr(
        runtime.subprocess,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("installer invoked a subprocess")),
    )

    runtime._install_runtime_pack(runtime_dir, pack_definition())

    active = runtime_dir / "YuluLocalCaptionRuntime.bundle"
    assert (active / "Contents/Resources/site-packages/sherpa_onnx/__init__.py").is_file()
    assert runtime._runtime_pack_ok(active, pack_definition()) is True


def test_runtime_pack_tamper_or_extra_file_never_replaces_active_pack(monkeypatch, tmp_path):
    runtime_dir = tmp_path / "config" / "local-caption"
    active_marker = runtime_dir / "YuluLocalCaptionRuntime.bundle" / "active.txt"
    active_marker.parent.mkdir(parents=True)
    active_marker.write_text("keep", encoding="utf-8")
    monkeypatch.setattr(runtime, "_verify_pack_code_signatures", lambda _pack, _definition: None)

    for index, archive in enumerate(
        (
            create_pack_archive(tmp_path / "bad-hash", manifest_hash="0" * 64),
            create_pack_archive(tmp_path / "extra", extra=True),
        )
    ):
        monkeypatch.setenv("YULU_LOCAL_CAPTION_RUNTIME_PACK_ARCHIVE", str(archive))
        try:
            runtime._install_runtime_pack(runtime_dir, pack_definition())
        except RuntimeError:
            pass
        else:
            raise AssertionError(f"tampered pack {index} unexpectedly activated")
        assert active_marker.read_text(encoding="utf-8") == "keep"


@pytest.mark.parametrize(
    ("pack_team", "python_team"),
    (("", "WMU9678ZQL"), ("WMU9678ZQL", "")),
)
def test_adhoc_pack_bypass_rejects_mixed_team_identities(
    monkeypatch,
    tmp_path,
    pack_team,
    python_team,
):
    pack = tmp_path / "YuluLocalCaptionRuntime.bundle"
    (pack / "Contents/Resources/site-packages").mkdir(parents=True)
    python = Path(runtime.sys.executable).resolve()
    monkeypatch.setenv("YULU_ALLOW_ADHOC_RUNTIME_PACK", "1")
    monkeypatch.setattr(
        runtime,
        "_codesign_metadata",
        lambda path: (
            ("com.yulu.runtime.local-caption", pack_team)
            if path == pack
            else ("python", python_team)
            if path == python
            else ("native", pack_team)
        ),
    )
    monkeypatch.setattr(
        runtime.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout="", stderr=""),
    )

    with pytest.raises(RuntimeError, match="Developer ID Team"):
        runtime._verify_pack_code_signatures(pack, pack_definition())


def test_sherpa_import_probe_does_not_run_pack_sitecustomize(tmp_path):
    site_packages = tmp_path / "site-packages"
    package = site_packages / "sherpa_onnx"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("__version__ = '1.13.2'\n", encoding="utf-8")
    marker = tmp_path / "sitecustomize-ran"
    (site_packages / "sitecustomize.py").write_text(
        f"from pathlib import Path\nPath({str(marker)!r}).write_text('unsafe')\n",
        encoding="utf-8",
    )

    assert runtime._sherpa_import_ok(Path(runtime.sys.executable), site_packages) is True
    assert not marker.exists()
