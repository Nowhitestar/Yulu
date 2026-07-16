#!/usr/bin/env python3
"""Install and inspect Yulu's optional local streaming-caption runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from typing import Any


MODEL_NAME = "sherpa-onnx-streaming-paraformer-bilingual-zh-en"
MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    f"{MODEL_NAME}.tar.bz2"
)
MODEL_SHA256 = "5462a1fce42693deae572af1e8c4687124b12aa85fe61ff4d3168bb5280e205f"
SHERPA_VERSION = "1.13.2"
MODEL_FILES = ("tokens.txt", "encoder.int8.onnx", "decoder.int8.onnx")
MODEL_FILE_SHA256 = {
    "tokens.txt": "59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6",
    "encoder.int8.onnx": "81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a",
    "decoder.int8.onnx": "f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f",
}


def _emit(event: str, **payload: Any) -> None:
    print(json.dumps({"event": event, **payload}, ensure_ascii=False), flush=True)


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def runtime_paths(config_dir: Path) -> dict[str, Path]:
    return {
        "runtime": config_dir / "local-caption",
        "venv": config_dir / "local-caption" / "venv",
        "python": config_dir / "local-caption" / "venv" / "bin" / "python",
        "model": config_dir / "models" / MODEL_NAME,
        "manifest": config_dir / "local-caption" / "manifest.json",
    }


def _model_complete(model_dir: Path) -> bool:
    return all((model_dir / name).is_file() and (model_dir / name).stat().st_size > 0 for name in MODEL_FILES)


def _verify_model_hashes(model_dir: Path) -> bool:
    if not _model_complete(model_dir):
        return False
    for name, expected in MODEL_FILE_SHA256.items():
        digest = hashlib.sha256()
        with (model_dir / name).open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            return False
    return True


def _sherpa_import_ok(python: Path) -> bool:
    if not python.is_file():
        return False
    try:
        result = subprocess.run(
            [str(python), "-c", "import sherpa_onnx; print(sherpa_onnx.__version__)"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0 and result.stdout.strip() == SHERPA_VERSION
    except (OSError, subprocess.SubprocessError):
        return False


def status(config_dir: Path) -> dict[str, Any]:
    paths = runtime_paths(config_dir)
    runtime_ok = _sherpa_import_ok(paths["python"])
    model_ok = _verify_model_hashes(paths["model"])
    return {
        "installed": runtime_ok and model_ok,
        "runtimeReady": runtime_ok,
        "modelReady": model_ok,
        "provider": "sherpa-onnx-paraformer-int8",
        "version": SHERPA_VERSION,
        "model": MODEL_NAME,
        "runtimeBytes": _dir_size(paths["runtime"]),
        "modelBytes": _dir_size(paths["model"]),
        "python": str(paths["python"]),
        "modelDir": str(paths["model"]),
    }


def _python_candidates() -> list[Path]:
    configured = os.environ.get("YULU_LOCAL_CAPTION_BOOTSTRAP_PYTHON", "").strip()
    candidates = [Path(configured)] if configured else []
    for path in (
        "/opt/homebrew/bin/python3.13",
        "/opt/homebrew/bin/python3.12",
        "/opt/homebrew/bin/python3.11",
        "/opt/homebrew/bin/python3.10",
        "/usr/local/bin/python3.13",
        "/usr/local/bin/python3.12",
        "/usr/local/bin/python3.11",
        "/usr/local/bin/python3.10",
        "/usr/bin/python3",
    ):
        candidates.append(Path(path))
    current = Path(sys.executable)
    if sys.version_info < (3, 14):
        candidates.insert(0, current)
    out: list[Path] = []
    for candidate in candidates:
        if candidate.is_file() and candidate not in out:
            out.append(candidate)
    return out


def _install_runtime(venv: Path) -> None:
    if _sherpa_import_ok(venv / "bin/python"):
        _emit("progress", phase="runtime", message="本地识别运行时已就绪")
        return
    shutil.rmtree(venv, ignore_errors=True)
    last_error = "no compatible Python runtime found"
    for python in _python_candidates():
        _emit("progress", phase="runtime", message=f"使用 {python.name} 创建本地环境")
        result = subprocess.run([str(python), "-m", "venv", str(venv)], capture_output=True, text=True)
        if result.returncode != 0:
            last_error = (result.stderr or result.stdout).strip()
            shutil.rmtree(venv, ignore_errors=True)
            continue
        pip = venv / "bin/pip"
        result = subprocess.run(
            [
                str(pip), "install", "--disable-pip-version-check", "--only-binary=:all:",
                f"sherpa-onnx=={SHERPA_VERSION}",
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and _sherpa_import_ok(venv / "bin/python"):
            return
        last_error = (result.stderr or result.stdout).strip()
        shutil.rmtree(venv, ignore_errors=True)
    raise RuntimeError(f"无法安装 sherpa-onnx 运行时: {last_error}")


def _copy_benchmark_model(model_dir: Path) -> bool:
    source = Path.home() / ".cache/yulu-asr-benchmark/models" / MODEL_NAME
    if not _verify_model_hashes(source):
        return False
    model_dir.mkdir(parents=True, exist_ok=True)
    for name in MODEL_FILES:
        shutil.copy2(source / name, model_dir / name)
    return True


def _download_model(model_dir: Path) -> None:
    model_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="yulu-caption-model-") as temp:
        archive = Path(temp) / f"{MODEL_NAME}.tar.bz2"
        last_percent = -1

        def progress(blocks: int, block_size: int, total: int) -> None:
            nonlocal last_percent
            if total <= 0:
                return
            percent = min(100, blocks * block_size * 100 // total)
            if percent >= last_percent + 5:
                last_percent = percent
                _emit("progress", phase="download", percent=percent, message=f"下载模型 {percent}%")

        urllib.request.urlretrieve(MODEL_URL, archive, progress)
        digest_state = hashlib.sha256()
        with archive.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest_state.update(chunk)
        digest = digest_state.hexdigest()
        if digest != MODEL_SHA256:
            raise RuntimeError(f"模型校验失败: expected {MODEL_SHA256}, got {digest}")
        staging = Path(temp) / "model"
        staging.mkdir()
        with tarfile.open(archive, "r:bz2") as bundle:
            members = {member.name: member for member in bundle.getmembers()}
            for name in MODEL_FILES:
                member_name = f"{MODEL_NAME}/{name}"
                member = members.get(member_name)
                if member is None or not member.isfile():
                    raise RuntimeError(f"模型包缺少 {member_name}")
                source = bundle.extractfile(member)
                if source is None:
                    raise RuntimeError(f"无法读取 {member_name}")
                with source, (staging / name).open("wb") as target:
                    shutil.copyfileobj(source, target)
        if not _verify_model_hashes(staging):
            raise RuntimeError("解压后的 INT8 模型校验失败")
        shutil.rmtree(model_dir, ignore_errors=True)
        shutil.move(str(staging), str(model_dir))


def install(config_dir: Path) -> dict[str, Any]:
    paths = runtime_paths(config_dir)
    paths["runtime"].mkdir(parents=True, exist_ok=True)
    _install_runtime(paths["venv"])
    if not _verify_model_hashes(paths["model"]):
        _emit("progress", phase="model", message="准备 INT8 中英双语模型")
        if not _copy_benchmark_model(paths["model"]):
            _download_model(paths["model"])
    manifest = {
        "schema": 1,
        "provider": "sherpa-onnx-paraformer-int8",
        "version": SHERPA_VERSION,
        "model": MODEL_NAME,
        "modelSha256": MODEL_SHA256,
    }
    paths["manifest"].write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    result = status(config_dir)
    if not result["installed"]:
        raise RuntimeError("本地实时转录运行时安装后未通过自检")
    return result


def uninstall(config_dir: Path) -> dict[str, Any]:
    paths = runtime_paths(config_dir)
    shutil.rmtree(paths["runtime"], ignore_errors=True)
    shutil.rmtree(paths["model"], ignore_errors=True)
    return status(config_dir)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Manage Yulu local caption runtime")
    parser.add_argument("action", choices=("status", "install", "uninstall"))
    parser.add_argument("--config-dir", type=Path, default=Path.home() / ".config/yulu")
    args = parser.parse_args(argv)
    try:
        if args.action == "install":
            result = install(args.config_dir.expanduser())
        elif args.action == "uninstall":
            result = uninstall(args.config_dir.expanduser())
        else:
            result = status(args.config_dir.expanduser())
        _emit("result", ok=True, status=result)
        return 0
    except Exception as exc:
        _emit("result", ok=False, error=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
