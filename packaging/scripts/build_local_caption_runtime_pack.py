#!/usr/bin/env python3
"""Build Yulu's versioned, same-Team signed local-caption Runtime Pack."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import shutil
import stat
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DEFINITION = ROOT / "yulu" / "scripts" / "local_caption_runtime_pack.json"


def _fail(message: str) -> RuntimeError:
    return RuntimeError(f"build_local_caption_runtime_pack.py: {message}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_definition(path: Path) -> dict[str, Any]:
    definition = json.loads(path.read_text(encoding="utf-8"))
    required = {
        "schema": 1,
        "architecture": "arm64",
        "pythonAbi": "cp313",
        "bundleName": "YuluLocalCaptionRuntime.bundle",
        "bundleIdentifier": "com.yulu.runtime.local-caption",
    }
    for key, expected in required.items():
        if definition.get(key) != expected:
            raise _fail(f"invalid definition field: {key}")
    wheels = definition.get("wheels")
    if not isinstance(wheels, list) or len(wheels) != 2:
        raise _fail("definition must pin exactly the sherpa-onnx and core wheels")
    for wheel in wheels:
        if (
            not isinstance(wheel, dict)
            or not str(wheel.get("url", "")).startswith("https://files.pythonhosted.org/")
            or len(str(wheel.get("sha256", ""))) != 64
            or not str(wheel.get("filename", "")).endswith(".whl")
        ):
            raise _fail("invalid pinned wheel definition")
    return definition


def _obtain_wheel(wheel: dict[str, Any], destination: Path) -> None:
    override_name = str(wheel["archiveOverrideEnvironment"])
    supplied = os.environ.get(override_name, "").strip()
    if supplied:
        source = Path(supplied)
        if not source.is_file():
            raise _fail(f"{override_name} does not name a file")
        shutil.copy2(source, destination)
    else:
        urllib.request.urlretrieve(str(wheel["url"]), destination)
    actual = _sha256(destination)
    if actual != wheel["sha256"]:
        raise _fail(f"wheel checksum mismatch for {wheel['name']}: {actual}")


def _extract_wheel(archive: Path, destination: Path, files: set[str]) -> None:
    with zipfile.ZipFile(archive) as wheel:
        seen: set[str] = set()
        for entry in wheel.infolist():
            relative = Path(entry.filename)
            if (
                not entry.filename
                or entry.filename.startswith("/")
                or ".." in relative.parts
                or entry.filename in seen
            ):
                raise _fail(f"unsafe wheel path: {entry.filename}")
            seen.add(entry.filename)
            mode = (entry.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                raise _fail(f"wheel contains a symlink: {entry.filename}")
            target = destination.joinpath(*relative.parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if entry.filename in files or target.exists():
                raise _fail(f"wheel payload collision: {entry.filename}")
            files.add(entry.filename)
            target.parent.mkdir(parents=True, exist_ok=True)
            with wheel.open(entry) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
            permissions = stat.S_IMODE(mode)
            target.chmod(permissions or 0o644)


def _command(arguments: list[str], message: str) -> str:
    result = subprocess.run(arguments, capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise _fail(f"{message}: {detail}")
    return (result.stdout + result.stderr).strip()


def _sign_payload(site_packages: Path, identity: str) -> list[Path]:
    native: list[Path] = []
    for path in sorted(site_packages.rglob("*")):
        if not path.is_file():
            continue
        description = _command(["/usr/bin/file", "-b", str(path)], f"cannot inspect {path.name}")
        if "Mach-O" not in description:
            continue
        architecture = _command(["/usr/bin/lipo", "-archs", str(path)], f"cannot inspect {path.name}")
        if architecture.strip() != "arm64":
            raise _fail(f"native payload must be arm64-only: {path.name} ({architecture})")
        arguments = ["/usr/bin/codesign", "--force", "--options", "runtime"]
        if identity != "-":
            arguments.append("--timestamp")
        arguments.extend(["--sign", identity, str(path)])
        _command(arguments, f"cannot sign {path.name}")
        _command(
            ["/usr/bin/codesign", "--verify", "--strict", str(path)],
            f"signature verification failed for {path.name}",
        )
        native.append(path)
    if not native:
        raise _fail("wheel payload contains no native code")
    return native


def _write_manifest(site_packages: Path, destination: Path, definition: dict[str, Any]) -> None:
    files = []
    for path in sorted(site_packages.rglob("*")):
        if path.is_symlink():
            raise _fail(f"payload contains a symlink: {path}")
        if path.is_file():
            files.append(
                {
                    "path": path.relative_to(site_packages).as_posix(),
                    "sha256": _sha256(path),
                }
            )
    payload = {
        "schema": definition["schema"],
        "id": definition["id"],
        "version": definition["version"],
        "architecture": definition["architecture"],
        "pythonAbi": definition["pythonAbi"],
        "files": files,
    }
    destination.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_zip(bundle: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".zip.tmp")
    temporary.unlink(missing_ok=True)
    paths = [bundle, *sorted(bundle.rglob("*"))]
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in paths:
            relative = path.relative_to(bundle.parent).as_posix()
            if path.is_dir():
                relative += "/"
            info = zipfile.ZipInfo(relative, (2020, 1, 1, 0, 0, 0))
            info.create_system = 3
            mode = stat.S_IMODE(path.lstat().st_mode)
            kind = stat.S_IFDIR if path.is_dir() else stat.S_IFREG
            info.external_attr = (kind | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, b"" if path.is_dir() else path.read_bytes())
    os.replace(temporary, destination)


def build_pack(
    definition_path: Path,
    output: Path,
    identity: str,
) -> Path:
    definition = _load_definition(definition_path)
    with tempfile.TemporaryDirectory(prefix="yulu-local-caption-pack-") as temporary:
        root = Path(temporary)
        bundle = root / definition["bundleName"]
        contents = bundle / "Contents"
        resources = contents / "Resources"
        site_packages = resources / "site-packages"
        site_packages.mkdir(parents=True)
        info = {
            "CFBundleIdentifier": definition["bundleIdentifier"],
            "CFBundleName": "Yulu Local Caption Runtime",
            "CFBundlePackageType": "BNDL",
            "CFBundleShortVersionString": definition["version"],
            "CFBundleVersion": "1",
            "YuluRuntimePackArchitecture": definition["architecture"],
            "YuluRuntimePackIdentifier": definition["id"],
            "YuluRuntimePackPythonABI": definition["pythonAbi"],
        }
        with (contents / "Info.plist").open("wb") as target:
            plistlib.dump(info, target, sort_keys=True)

        wheel_files: set[str] = set()
        for index, wheel in enumerate(definition["wheels"]):
            archive = root / f"wheel-{index}.whl"
            _obtain_wheel(wheel, archive)
            _extract_wheel(archive, site_packages, wheel_files)

        _sign_payload(site_packages, identity)
        _write_manifest(site_packages, resources / "runtime-pack.json", definition)
        arguments = ["/usr/bin/codesign", "--force", "--options", "runtime"]
        if identity != "-":
            arguments.append("--timestamp")
        arguments.extend(["--sign", identity, str(bundle)])
        _command(arguments, "cannot sign Runtime Pack bundle")
        _command(
            ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(bundle)],
            "Runtime Pack bundle signature verification failed",
        )
        _write_zip(bundle, output)
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build Yulu local-caption Runtime Pack")
    parser.add_argument("--definition", type=Path, default=DEFAULT_DEFINITION)
    parser.add_argument("--identity", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        output = build_pack(args.definition.resolve(), args.output.resolve(), args.identity)
        print(output)
        return 0
    except Exception as exc:
        print(str(exc), file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
