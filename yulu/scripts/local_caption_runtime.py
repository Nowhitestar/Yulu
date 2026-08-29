#!/usr/bin/env python3
"""Install and inspect Yulu's optional local streaming-caption runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
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
PACK_DEFINITION_PATH = Path(__file__).with_name("local_caption_runtime_pack.json")


def _emit(event: str, **payload: Any) -> None:
    print(json.dumps({"event": event, **payload}, ensure_ascii=False), flush=True)


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def runtime_paths(config_dir: Path) -> dict[str, Path]:
    runtime = config_dir / "local-caption"
    pack = runtime / "YuluLocalCaptionRuntime.bundle"
    return {
        "runtime": runtime,
        "pack": pack,
        "site_packages": pack / "Contents" / "Resources" / "site-packages",
        "python": Path(os.environ.get("YULU_PYTHON", sys.executable)).resolve(),
        "model": config_dir / "models" / MODEL_NAME,
        "manifest": runtime / "manifest.json",
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


def _load_runtime_pack_definition() -> dict[str, Any]:
    definition = json.loads(PACK_DEFINITION_PATH.read_text(encoding="utf-8"))
    required = {
        "schema": 1,
        "id": "sherpa-onnx-1.13.2-cp313-macos-arm64",
        "version": SHERPA_VERSION,
        "architecture": "arm64",
        "pythonAbi": "cp313",
        "bundleName": "YuluLocalCaptionRuntime.bundle",
        "bundleIdentifier": "com.yulu.runtime.local-caption",
    }
    for key, expected in required.items():
        if definition.get(key) != expected:
            raise RuntimeError(f"invalid local caption Runtime Pack definition: {key}")
    if "{tag}" not in str(definition.get("assetUrlTemplate", "")):
        raise RuntimeError("invalid local caption Runtime Pack asset URL")
    return definition


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _pack_manifest(pack: Path, definition: dict[str, Any]) -> dict[str, Any]:
    manifest_path = pack / "Contents" / "Resources" / "runtime-pack.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RuntimeError("Runtime Pack manifest is missing or invalid") from exc
    for key in ("schema", "id", "version", "architecture", "pythonAbi"):
        if manifest.get(key) != definition.get(key):
            raise RuntimeError(f"Runtime Pack manifest identity mismatch: {key}")
    return manifest


def _verify_pack_payload(pack: Path, definition: dict[str, Any]) -> None:
    site_packages = pack / "Contents" / "Resources" / "site-packages"
    if not site_packages.is_dir():
        raise RuntimeError("Runtime Pack site-packages is missing")
    manifest = _pack_manifest(pack, definition)
    expected: dict[str, str] = {}
    for entry in manifest.get("files", []):
        if not isinstance(entry, dict):
            raise RuntimeError("Runtime Pack inventory entry is invalid")
        relative = entry.get("path")
        digest = entry.get("sha256")
        if (
            not isinstance(relative, str)
            or not relative
            or relative.startswith("/")
            or ".." in Path(relative).parts
            or not isinstance(digest, str)
            or len(digest) != 64
            or relative in expected
        ):
            raise RuntimeError("Runtime Pack inventory entry is invalid")
        expected[relative] = digest
    actual: dict[str, Path] = {}
    for path in site_packages.rglob("*"):
        if path.is_symlink():
            raise RuntimeError("Runtime Pack payload must not contain symlinks")
        if path.is_file():
            actual[path.relative_to(site_packages).as_posix()] = path
    if set(actual) != set(expected):
        raise RuntimeError("Runtime Pack file inventory does not match its payload")
    for relative, path in actual.items():
        if _sha256_file(path) != expected[relative]:
            raise RuntimeError(f"Runtime Pack payload hash mismatch: {relative}")


def _codesign_metadata(path: Path) -> tuple[str, str]:
    result = subprocess.run(
        ["/usr/bin/codesign", "--display", "--verbose=2", str(path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Runtime Pack signature metadata unavailable: {path.name}")
    output = result.stdout + result.stderr
    identifier = ""
    team = ""
    for line in output.splitlines():
        if line.startswith("Identifier="):
            identifier = line.split("=", 1)[1].strip()
        elif line.startswith("TeamIdentifier="):
            team = line.split("=", 1)[1].strip()
    return identifier, team


def _verify_pack_code_signatures(pack: Path, definition: dict[str, Any]) -> None:
    verified = subprocess.run(
        ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(pack)],
        capture_output=True,
        text=True,
    )
    if verified.returncode != 0:
        raise RuntimeError("Runtime Pack signature verification failed")
    identifier, pack_team = _codesign_metadata(pack)
    if identifier != definition["bundleIdentifier"]:
        raise RuntimeError("Runtime Pack bundle identifier is invalid")
    _, python_team = _codesign_metadata(Path(sys.executable).resolve())
    allow_adhoc = os.environ.get("YULU_ALLOW_ADHOC_RUNTIME_PACK") == "1"
    pack_has_team = bool(pack_team and pack_team != "not set")
    python_has_team = bool(python_team and python_team != "not set")
    if not pack_has_team or not python_has_team:
        if not allow_adhoc or pack_has_team or python_has_team:
            raise RuntimeError("Runtime Pack and bundled Python require the same Developer ID Team")
    elif pack_team != python_team:
        raise RuntimeError("Runtime Pack is not signed by the Application Runtime Team")

    site_packages = pack / "Contents" / "Resources" / "site-packages"
    for path in site_packages.rglob("*"):
        if not path.is_file():
            continue
        description = subprocess.run(
            ["/usr/bin/file", "-b", str(path)], capture_output=True, text=True
        )
        if description.returncode != 0 or "Mach-O" not in description.stdout:
            continue
        architecture = subprocess.run(
            ["/usr/bin/lipo", "-archs", str(path)], capture_output=True, text=True
        )
        if architecture.returncode != 0 or architecture.stdout.strip() != "arm64":
            raise RuntimeError(f"Runtime Pack native code is not arm64-only: {path.name}")
        signature = subprocess.run(
            ["/usr/bin/codesign", "--verify", "--strict", str(path)],
            capture_output=True,
            text=True,
        )
        if signature.returncode != 0:
            raise RuntimeError(f"Runtime Pack native signature is invalid: {path.name}")
        _, native_team = _codesign_metadata(path)
        if pack_team and pack_team != "not set" and native_team != pack_team:
            raise RuntimeError(f"Runtime Pack native code has the wrong signing Team: {path.name}")


def _runtime_pack_ok(pack: Path, definition: dict[str, Any]) -> bool:
    if not pack.is_dir():
        return False
    try:
        _verify_pack_payload(pack, definition)
        _verify_pack_code_signatures(pack, definition)
        return True
    except (OSError, RuntimeError, subprocess.SubprocessError):
        return False


def verify_runtime_pack(pack: Path) -> None:
    definition = _load_runtime_pack_definition()
    expected = definition["bundleName"]
    if pack.name != expected:
        raise RuntimeError(f"unexpected Runtime Pack bundle name: {pack.name}")
    _verify_pack_payload(pack, definition)
    _verify_pack_code_signatures(pack, definition)


def _sherpa_import_ok(python: Path, site_packages: Path) -> bool:
    if not python.is_file():
        return False
    try:
        environment = os.environ.copy()
        environment["PYTHONNOUSERSITE"] = "1"
        result = subprocess.run(
            [
                str(python),
                "-I",
                "-S",
                "-c",
                (
                    "import sys; sys.path.insert(0, sys.argv[1]); "
                    "import sherpa_onnx; print(sherpa_onnx.__version__)"
                ),
                str(site_packages),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            env=environment,
        )
        return result.returncode == 0 and result.stdout.strip() == SHERPA_VERSION
    except (OSError, subprocess.SubprocessError):
        return False


def status(config_dir: Path) -> dict[str, Any]:
    paths = runtime_paths(config_dir)
    try:
        definition = _load_runtime_pack_definition()
        pack_ok = _runtime_pack_ok(paths["pack"], definition)
    except (OSError, RuntimeError, ValueError):
        pack_ok = False
    runtime_ok = pack_ok and _sherpa_import_ok(paths["python"], paths["site_packages"])
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
        "pythonPath": str(paths["site_packages"]),
        "runtimePack": str(paths["pack"]),
        "modelDir": str(paths["model"]),
    }


def _release_tag() -> str:
    override = os.environ.get("YULU_LOCAL_CAPTION_RUNTIME_PACK_TAG", "").strip()
    if override:
        return override
    executable = Path(sys.executable).resolve()
    for parent in executable.parents:
        if parent.suffix != ".app":
            continue
        info = parent / "Contents" / "Info.plist"
        try:
            with info.open("rb") as source:
                version = str(plistlib.load(source).get("YuluVersion", "")).strip()
        except (OSError, plistlib.InvalidFileException):
            break
        if version:
            return version if version.startswith("v") else f"v{version}"
    raise RuntimeError("无法确定当前 Yulu 版本，不能选择 Runtime Pack")


def _safe_extract_runtime_pack(archive: Path, destination: Path, bundle_name: str) -> Path:
    with zipfile.ZipFile(archive) as bundle:
        seen: set[str] = set()
        for entry in bundle.infolist():
            relative = Path(entry.filename)
            if (
                not entry.filename
                or entry.filename.startswith("/")
                or ".." in relative.parts
                or relative.parts[0] != bundle_name
                or entry.filename in seen
            ):
                raise RuntimeError("Runtime Pack archive contains an unsafe path")
            seen.add(entry.filename)
            mode = (entry.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                raise RuntimeError("Runtime Pack archive must not contain symlinks")
            target = destination.joinpath(*relative.parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(entry) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
            permissions = stat.S_IMODE(mode)
            if permissions:
                target.chmod(permissions)
    pack = destination / bundle_name
    if not pack.is_dir():
        raise RuntimeError("Runtime Pack archive is missing its signed bundle")
    return pack


def _install_runtime_pack(runtime_dir: Path, definition: dict[str, Any]) -> None:
    target = runtime_dir / str(definition["bundleName"])
    if _runtime_pack_ok(target, definition):
        _emit("progress", phase="runtime", message="本地识别 Runtime Pack 已就绪")
        return
    runtime_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".local-caption-pack-", dir=runtime_dir.parent) as temporary:
        temporary_path = Path(temporary)
        archive = temporary_path / "runtime-pack.zip"
        supplied = os.environ.get("YULU_LOCAL_CAPTION_RUNTIME_PACK_ARCHIVE", "").strip()
        if supplied:
            source = Path(supplied)
            if not source.is_file():
                raise RuntimeError("指定的 Runtime Pack 不存在")
            shutil.copy2(source, archive)
        else:
            tag = _release_tag()
            url = str(definition["assetUrlTemplate"]).format(tag=tag)
            _emit("progress", phase="runtime", message=f"下载本地识别 Runtime Pack {tag}")
            urllib.request.urlretrieve(url, archive)
        staging = temporary_path / "staging"
        staging.mkdir()
        pack = _safe_extract_runtime_pack(archive, staging, str(definition["bundleName"]))
        _verify_pack_payload(pack, definition)
        _verify_pack_code_signatures(pack, definition)

        runtime_dir.mkdir(parents=True, exist_ok=True)
        backup = runtime_dir / f".{definition['bundleName']}.previous"
        shutil.rmtree(backup, ignore_errors=True)
        if target.exists():
            os.replace(target, backup)
        try:
            os.replace(pack, target)
            _verify_pack_payload(target, definition)
            _verify_pack_code_signatures(target, definition)
        except Exception:
            shutil.rmtree(target, ignore_errors=True)
            if backup.exists():
                os.replace(backup, target)
            raise
        shutil.rmtree(backup, ignore_errors=True)


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
    definition = _load_runtime_pack_definition()
    _install_runtime_pack(paths["runtime"], definition)
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
        "runtimePack": definition["id"],
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
