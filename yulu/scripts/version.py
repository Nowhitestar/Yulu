#!/usr/bin/env python3
"""Central Yulu version helpers.

The repository root VERSION file is the single source of truth. Runtime helpers
may add git metadata for support/debugging, but they do not invent a version.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_DIR = SCRIPT_DIR.parent.parent
VERSION_PATH = REPO_DIR / "VERSION"
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


def read_version(path: Path = VERSION_PATH) -> str:
    try:
        version = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return "0.0.0+unknown"
    return version or "0.0.0+unknown"


def validate_version(version: str) -> bool:
    return bool(VERSION_RE.match(version))


def _git(args: list[str], repo_dir: Path = REPO_DIR) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_dir), *args],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def git_commit(repo_dir: Path = REPO_DIR) -> str | None:
    return _git(["rev-parse", "--short", "HEAD"], repo_dir)


def git_tag(repo_dir: Path = REPO_DIR) -> str | None:
    return _git(["describe", "--tags", "--exact-match"], repo_dir)


def git_dirty(repo_dir: Path = REPO_DIR) -> bool | None:
    if _git(["rev-parse", "--is-inside-work-tree"], repo_dir) != "true":
        return None
    status = _git(["status", "--porcelain"], repo_dir)
    return bool(status)


def read_install_metadata(repo_dir: Path = REPO_DIR) -> dict[str, object]:
    path = repo_dir / ".yulu-install.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def version_info(repo_dir: Path = REPO_DIR, version_path: Path = VERSION_PATH) -> dict[str, object]:
    version = read_version(version_path)
    return {
        "name": "Yulu",
        "version": version,
        "valid_semver": validate_version(version),
        "git_commit": git_commit(repo_dir),
        "git_tag": git_tag(repo_dir),
        "git_dirty": git_dirty(repo_dir),
        "install": read_install_metadata(repo_dir),
        "version_file": str(version_path),
    }


def format_version(info: dict[str, object], short: bool = False) -> str:
    version = str(info["version"])
    if short:
        return version

    parts = [f"Yulu {version}"]
    git_bits = []
    commit = info.get("git_commit")
    if commit:
        git_bits.append(str(commit))
        if info.get("git_dirty") is True:
            git_bits.append("dirty")
        tag = info.get("git_tag")
        if tag:
            git_bits.append(str(tag))
    install = info.get("install")
    if isinstance(install, dict):
        source = install.get("source")
        if source == "release" and install.get("version"):
            git_bits.append(f"release {install['version']}")
        elif source == "dev" and install.get("branch"):
            git_bits.append(f"dev {install['branch']}")
    if git_bits:
        parts.append(f"({', '.join(git_bits)})")
    if not info.get("valid_semver"):
        parts.append("[invalid VERSION]")
    return " ".join(parts)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Print Yulu version information")
    parser.add_argument("--short", action="store_true", help="print only the VERSION value")
    parser.add_argument("--json", action="store_true", help="print machine-readable version metadata")
    parser.add_argument("--check", action="store_true", help="fail if VERSION is not valid SemVer")
    args = parser.parse_args(argv)

    info = version_info()
    if args.json:
        print(json.dumps(info, indent=2, ensure_ascii=False))
    else:
        print(format_version(info, short=args.short))

    if args.check and not info["valid_semver"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
