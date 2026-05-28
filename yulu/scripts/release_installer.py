#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from dataclasses import dataclass

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
