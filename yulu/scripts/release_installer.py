#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SEMVER_RE = re.compile(
    r"^v?"
    r"(0|[1-9]\d*)\."
    r"(0|[1-9]\d*)\."
    r"(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"$"
)
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
VERSION_CHECK_TIMEOUT_SECONDS = 10
SETUP_TIMEOUT_SECONDS = 300


class InstallError(RuntimeError):
    pass


@dataclass(frozen=True)
class ReleaseTarget:
    kind: str  # "latest" | "version" | "dev"
    tag: str | None = None


@dataclass(frozen=True)
class ReleaseAsset:
    tag: str
    asset_name: str
    asset_url: str
    checksums_url: str


@dataclass(frozen=True)
class InstallMetadata:
    source: str
    version: str | None = None
    asset: str | None = None
    sha256: str | None = None
    branch: str | None = None
    commit: str | None = None


def normalize_version_tag(value: str) -> str:
    version = value.strip()
    if not SEMVER_RE.match(version):
        raise ValueError(f"{value!r} is not a valid SemVer release tag")
    return version if version.startswith("v") else f"v{version}"


def _tag_without_v(tag: str) -> str:
    return tag[1:] if tag.startswith("v") else tag


def build_target_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--latest", action="store_true")
    group.add_argument("--version")
    group.add_argument("--dev", action="store_true")
    return parser


def parse_target_args(argv: list[str]) -> ReleaseTarget:
    args = build_target_parser().parse_args(argv)
    if args.dev:
        return ReleaseTarget(kind="dev")
    if args.version is not None:
        return ReleaseTarget(kind="version", tag=normalize_version_tag(args.version))
    return ReleaseTarget(kind="latest")


def select_release_asset(release: dict) -> ReleaseAsset:
    tag = str(release.get("tag_name") or "")
    if not tag:
        raise InstallError("GitHub release response did not include tag_name")
    expected_zip = f"yulu-macos-arm64-{tag}.zip"
    assets = release.get("assets") or []
    by_name = {str(asset.get("name")): asset for asset in assets}
    zip_asset = by_name.get(expected_zip)
    checksum_asset = by_name.get("checksums.txt")
    if zip_asset is None:
        raise InstallError(f"Release {tag} does not provide {expected_zip}. It may predate asset-based installs.")
    if checksum_asset is None:
        raise InstallError(f"Release {tag} does not provide checksums.txt.")
    zip_url = str(zip_asset.get("browser_download_url") or "").strip()
    checksums_url = str(checksum_asset.get("browser_download_url") or "").strip()
    if not zip_url:
        raise InstallError(f"Release {tag} asset {expected_zip} did not include a download URL.")
    if not checksums_url:
        raise InstallError(f"Release {tag} asset checksums.txt did not include a checksums.txt download URL.")
    return ReleaseAsset(
        tag=tag,
        asset_name=expected_zip,
        asset_url=zip_url,
        checksums_url=checksums_url,
    )


def parse_checksums(text: str) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) < 2:
            continue
        checksum, name = parts[0], parts[-1].lstrip("*")
        if not SHA256_RE.match(checksum):
            continue
        checksums[name] = checksum
    return checksums


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_checksum(path: Path, expected: str) -> None:
    actual = sha256_file(path)
    if actual.lower() != expected.lower():
        raise InstallError(f"Checksum mismatch for {path.name}: expected {expected}, got {actual}")


def validate_runtime_layout(runtime_dir: Path, tag: str) -> None:
    runtime_dir = runtime_dir.resolve()
    required = [
        runtime_dir / "VERSION",
        runtime_dir / "yulu" / "scripts" / "setup.sh",
        runtime_dir / "yulu" / "scripts" / "yulu",
        runtime_dir / "yulu" / "scripts" / "version.py",
    ]
    for path in required:
        if not path.is_file():
            raise InstallError(f"Invalid release asset: missing {path.relative_to(runtime_dir)}")

    version = (runtime_dir / "VERSION").read_text(encoding="utf-8").strip()
    if version != _tag_without_v(tag):
        raise InstallError(f"VERSION {version!r} does not match release tag {tag!r}")

    try:
        result = subprocess.run(
            ["python3", str(runtime_dir / "yulu" / "scripts" / "version.py"), "--check"],
            cwd=str(runtime_dir),
            capture_output=True,
            text=True,
            timeout=VERSION_CHECK_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise InstallError(f"version.py --check timed out after {VERSION_CHECK_TIMEOUT_SECONDS}s") from exc
    if result.returncode != 0:
        raise InstallError(f"version.py --check failed: {result.stderr or result.stdout}")


def install_metadata_path(runtime_dir: Path) -> Path:
    return runtime_dir / ".yulu-install.json"


def write_install_metadata(runtime_dir: Path, metadata: InstallMetadata) -> None:
    payload = {
        "schema": 1,
        "source": metadata.source,
        "installed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }
    for key in ("version", "asset", "sha256", "branch", "commit"):
        value = getattr(metadata, key)
        if value is not None:
            payload[key] = value
    install_metadata_path(runtime_dir).write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def read_install_metadata(runtime_dir: Path) -> dict:
    path = install_metadata_path(runtime_dir)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def file_url_to_path(url: str) -> Path:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "file":
        raise InstallError(f"Expected file URL, got {url!r}")
    if parsed.netloc not in ("", "localhost"):
        raise InstallError(f"Refusing non-local file URL host {parsed.netloc!r}")
    return Path(urllib.request.url2pathname(parsed.path))


def download_to_path(url: str, dest: Path) -> None:
    if url.startswith("file://"):
        src = file_url_to_path(url)
        shutil.copy2(src, dest)
        return
    with urllib.request.urlopen(url, timeout=30) as response, dest.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def read_url_text(url: str) -> str:
    if url.startswith("file://"):
        src = file_url_to_path(url)
        return src.read_text(encoding="utf-8")
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read().decode("utf-8")


def _assert_safe_zip_member(dest: Path, member: str) -> None:
    member_path = Path(member)
    if member_path.is_absolute():
        raise InstallError(f"Unsafe zip member {member!r}: absolute paths are not allowed")
    resolved_dest = dest.resolve()
    resolved_member = (dest / member_path).resolve()
    if resolved_dest != resolved_member and resolved_dest not in resolved_member.parents:
        raise InstallError(f"Unsafe zip member {member!r}: path escapes extraction directory")


def extract_release_zip(zip_path: Path, dest: Path) -> Path:
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.namelist():
            _assert_safe_zip_member(dest, member)
        archive.extractall(dest)
    runtime = dest / "yulu"
    if not runtime.exists():
        raise InstallError("Release zip must expand to a top-level yulu/ directory")
    return runtime


def path_exists_or_symlink(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def replace_runtime_with_backup(staged_runtime: Path, install_dir: Path) -> Path | None:
    install_dir.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if path_exists_or_symlink(install_dir):
        # Keep successful-install backups for manual recovery until a later cleanup policy exists.
        backup = Path(
            tempfile.mkdtemp(prefix=f"{install_dir.name}.backup-", dir=str(install_dir.parent))
        )
        backup.rmdir()
        shutil.move(str(install_dir), str(backup))
    try:
        shutil.move(str(staged_runtime), str(install_dir))
    except Exception as move_error:
        if backup is not None:
            try:
                restore_backup(backup, install_dir)
            except Exception as restore_error:
                raise InstallError(
                    f"Failed to replace runtime ({move_error}); backup restore failed ({restore_error})"
                ) from move_error
        raise InstallError(f"Failed to replace runtime: {move_error}") from move_error
    return backup


def restore_backup(backup: Path, install_dir: Path) -> None:
    if path_exists_or_symlink(install_dir):
        if install_dir.is_dir() and not install_dir.is_symlink():
            shutil.rmtree(install_dir)
        else:
            install_dir.unlink()
    shutil.move(str(backup), str(install_dir))


def _run_setup_script(install_dir: Path, upgrade: bool, timeout: float = SETUP_TIMEOUT_SECONDS) -> None:
    setup = install_dir / "yulu" / "scripts" / "setup.sh"
    cmd = ["bash", str(setup)]
    if upgrade:
        cmd.append("--upgrade")
    try:
        result = subprocess.run(cmd, cwd=str(install_dir), timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise InstallError(f"setup.sh timed out after {timeout}s") from exc
    if result.returncode != 0:
        raise InstallError(f"setup.sh failed with exit code {result.returncode}")


run_setup = _run_setup_script


def install_release_from_urls(
    *,
    tag: str,
    asset_name: str,
    asset_url: str,
    checksums_url: str,
    install_dir: Path,
    run_setup: bool = True,
    setup_timeout: float = SETUP_TIMEOUT_SECONDS,
) -> None:
    install_dir.parent.mkdir(parents=True, exist_ok=True)
    existed = path_exists_or_symlink(install_dir)
    with tempfile.TemporaryDirectory(prefix="yulu-install-", dir=str(install_dir.parent)) as tmp:
        tmpdir = Path(tmp)
        zip_path = tmpdir / asset_name
        download_to_path(asset_url, zip_path)
        checksums = parse_checksums(read_url_text(checksums_url))
        expected = checksums.get(asset_name)
        if expected is None:
            raise InstallError(f"checksums.txt does not include {asset_name}")
        verify_checksum(zip_path, expected)
        staged_parent = tmpdir / "staged"
        staged_parent.mkdir()
        staged_runtime = extract_release_zip(zip_path, staged_parent)
        validate_runtime_layout(staged_runtime, tag)
        backup = replace_runtime_with_backup(staged_runtime, install_dir)
        try:
            write_install_metadata(
                install_dir,
                InstallMetadata(source="release", version=tag, asset=asset_name, sha256=expected),
            )
            if run_setup:
                _run_setup_script(install_dir, upgrade=existed, timeout=setup_timeout)
        except Exception as install_error:
            try:
                if backup is not None:
                    restore_backup(backup, install_dir)
                elif path_exists_or_symlink(install_dir):
                    if install_dir.is_dir() and not install_dir.is_symlink():
                        shutil.rmtree(install_dir)
                    else:
                        install_dir.unlink()
            except Exception as rollback_error:
                raise InstallError(
                    f"Install failed ({install_error}); rollback failed ({rollback_error})"
                ) from install_error
            raise
