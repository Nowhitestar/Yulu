#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
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
    required = [
        runtime_dir / "VERSION",
        runtime_dir / "yulu" / "scripts" / "setup.sh",
        runtime_dir / "yulu" / "scripts" / "yulu",
        runtime_dir / "yulu" / "scripts" / "version.py",
    ]
    for path in required:
        if not path.exists():
            raise InstallError(f"Invalid release asset: missing {path.relative_to(runtime_dir)}")

    version = (runtime_dir / "VERSION").read_text(encoding="utf-8").strip()
    if version != _tag_without_v(tag):
        raise InstallError(f"VERSION {version!r} does not match release tag {tag!r}")

    result = subprocess.run(
        ["python3", str(runtime_dir / "yulu" / "scripts" / "version.py"), "--check"],
        cwd=str(runtime_dir),
        capture_output=True,
        text=True,
    )
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
