#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import re
from dataclasses import dataclass
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


def normalize_version_tag(value: str) -> str:
    version = value.strip()
    if not SEMVER_RE.match(version):
        raise ValueError(f"{value!r} is not a valid SemVer release tag")
    return version if version.startswith("v") else f"v{version}"


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
    return ReleaseAsset(
        tag=tag,
        asset_name=expected_zip,
        asset_url=str(zip_asset.get("browser_download_url") or ""),
        checksums_url=str(checksum_asset.get("browser_download_url") or ""),
    )


def parse_checksums(text: str) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.split()
        if len(parts) < 2:
            continue
        checksum, name = parts[0], parts[-1].lstrip("*")
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
