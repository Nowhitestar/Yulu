#!/usr/bin/env python3
"""Read the exact Node release version from the Application Runtime lock."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


STRICT_RELEASE_SEMVER = re.compile(
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
)


def runtime_node_version(lock_path: Path) -> str:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if lock.get("schema") != 1:
        raise ValueError("runtime lock schema must be 1")
    version = lock.get("node", {}).get("version")
    if not isinstance(version, str) or STRICT_RELEASE_SEMVER.fullmatch(version) is None:
        raise ValueError("node.version must be a strict release semver (x.y.z)")
    return version


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: runtime_node_version.py <runtime-lock.json>", file=sys.stderr)
        return 2
    try:
        version = runtime_node_version(Path(argv[1]))
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as error:
        print(f"runtime_node_version.py: {error}", file=sys.stderr)
        return 2
    print(version)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
