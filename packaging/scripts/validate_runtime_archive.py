#!/usr/bin/env python3
"""Fail closed on unsafe members before a locked runtime archive is extracted."""

from __future__ import annotations

import posixpath
import sys
import tarfile
from pathlib import Path, PurePosixPath


def _archive_path(name: str) -> str:
    if not name or PurePosixPath(name).is_absolute():
        raise ValueError(f"archive member has an absolute or empty path: {name!r}")
    normalized = posixpath.normpath(name)
    if normalized == ".." or normalized.startswith("../"):
        raise ValueError(f"archive member escapes the extraction root: {name!r}")
    return normalized


def validate(archive: Path, expected_regular_member: str | None = None) -> None:
    seen: set[str] = set()
    with tarfile.open(archive, "r:*") as bundle:
        members = bundle.getmembers()
        if not members:
            raise ValueError("runtime archive is empty")
        normalized_members: list[tuple[tarfile.TarInfo, str]] = []
        for member in members:
            normalized = _archive_path(member.name)
            if normalized in seen:
                raise ValueError(f"archive contains a duplicate member: {normalized}")
            seen.add(normalized)
            normalized_members.append((member, normalized))

        symlinks = {
            normalized for member, normalized in normalized_members if member.issym()
        }
        for member, normalized in normalized_members:
            parts = PurePosixPath(normalized).parts
            parent_prefixes = (
                "/".join(parts[:index]) for index in range(1, len(parts))
            )
            if any(prefix in symlinks for prefix in parent_prefixes):
                raise ValueError(f"archive member has a symlinked parent: {member.name}")

            if member.islnk():
                raise ValueError(f"archive hardlinks are not allowed: {member.name}")
            if member.issym():
                if PurePosixPath(member.linkname).is_absolute():
                    raise ValueError(f"archive symlink has an absolute target: {member.name}")
                target = posixpath.normpath(
                    posixpath.join(posixpath.dirname(normalized), member.linkname)
                )
                if target == ".." or target.startswith("../"):
                    raise ValueError(f"archive symlink escapes the extraction root: {member.name}")
                target_parts = PurePosixPath(target).parts
                target_prefixes = (
                    "/".join(target_parts[:index])
                    for index in range(1, len(target_parts) + 1)
                )
                if any(prefix in symlinks for prefix in target_prefixes):
                    raise ValueError(f"archive symlink target traverses another symlink: {member.name}")
                continue
            if not (member.isdir() or member.isreg()):
                raise ValueError(f"archive contains a special file: {member.name}")

        if expected_regular_member is not None:
            expected = _archive_path(expected_regular_member)
            selected = [
                member
                for member, normalized in normalized_members
                if normalized == expected
            ]
            if len(selected) != 1 or not selected[0].isreg():
                raise ValueError(
                    f"archive does not contain the expected regular member: {expected}"
                )
            parts = PurePosixPath(expected).parts
            parent_prefixes = (
                "/".join(parts[:index]) for index in range(1, len(parts))
            )
            if any(prefix in symlinks for prefix in parent_prefixes):
                raise ValueError(
                    f"archive expected member has a symlinked parent: {expected}"
                )


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3):
        print(
            "usage: validate_runtime_archive.py ARCHIVE [EXPECTED_REGULAR_MEMBER]",
            file=sys.stderr,
        )
        return 2
    try:
        validate(Path(argv[1]), argv[2] if len(argv) == 3 else None)
    except (OSError, tarfile.TarError, ValueError) as exc:
        print(f"validate_runtime_archive.py: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
