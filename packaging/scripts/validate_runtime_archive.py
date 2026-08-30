#!/usr/bin/env python3
"""Fail closed on unsafe members before a locked runtime archive is extracted."""

from __future__ import annotations

import posixpath
import sys
import tarfile
import stat
import zipfile
from pathlib import Path, PurePosixPath


def _archive_path(name: str) -> str:
    if not name or PurePosixPath(name).is_absolute():
        raise ValueError(f"archive member has an absolute or empty path: {name!r}")
    normalized = posixpath.normpath(name)
    if normalized == ".." or normalized.startswith("../"):
        raise ValueError(f"archive member escapes the extraction root: {name!r}")
    return normalized


def _validate_expected_member(
    expected_regular_member: str | None,
    regular: set[str],
    symlinks: set[str],
) -> None:
    if expected_regular_member is None:
        return
    expected = _archive_path(expected_regular_member)
    if expected not in regular:
        raise ValueError(
            f"archive does not contain the expected regular member: {expected}"
        )
    parts = PurePosixPath(expected).parts
    if any(
        "/".join(parts[:index]) in symlinks for index in range(1, len(parts))
    ):
        raise ValueError(f"archive expected member has a symlinked parent: {expected}")


def _validate_zip(archive: Path, expected_regular_member: str | None) -> None:
    seen: set[str] = set()
    symlinks: dict[str, str] = {}
    regular: set[str] = set()
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        if not members or len(members) > 100_000:
            raise ValueError("runtime archive is empty or has too many members")
        if sum(member.file_size for member in members) > 1024 * 1024 * 1024:
            raise ValueError("runtime archive expands beyond its size limit")
        normalized_members: list[tuple[zipfile.ZipInfo, str]] = []
        for member in members:
            normalized = _archive_path(member.filename)
            if normalized in seen:
                raise ValueError(f"archive contains a duplicate member: {normalized}")
            seen.add(normalized)
            normalized_members.append((member, normalized))
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode):
                symlinks[normalized] = bundle.read(member).decode("utf-8")
            elif member.is_dir() or stat.S_ISDIR(mode):
                continue
            elif stat.S_ISREG(mode) or mode == 0:
                regular.add(normalized)
            else:
                raise ValueError(f"archive contains a special file: {member.filename}")

        for member, normalized in normalized_members:
            parts = PurePosixPath(normalized).parts
            if any(
                "/".join(parts[:index]) in symlinks
                for index in range(1, len(parts))
            ):
                raise ValueError(f"archive member has a symlinked parent: {member.filename}")
            if normalized not in symlinks:
                continue
            linkname = symlinks[normalized]
            if PurePosixPath(linkname).is_absolute():
                raise ValueError(f"archive symlink has an absolute target: {member.filename}")
            target = posixpath.normpath(
                posixpath.join(posixpath.dirname(normalized), linkname)
            )
            if target == ".." or target.startswith("../"):
                raise ValueError(f"archive symlink escapes the extraction root: {member.filename}")
        _validate_expected_member(expected_regular_member, regular, set(symlinks))


def _validate_tar(archive: Path, expected_regular_member: str | None) -> None:
    seen: set[str] = set()
    regular: set[str] = set()
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
            if member.isreg():
                regular.add(normalized)
        symlinks = {
            normalized for member, normalized in normalized_members if member.issym()
        }
        for member, normalized in normalized_members:
            parts = PurePosixPath(normalized).parts
            if any(
                "/".join(parts[:index]) in symlinks
                for index in range(1, len(parts))
            ):
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
                continue
            if not (member.isdir() or member.isreg()):
                raise ValueError(f"archive contains a special file: {member.name}")
        _validate_expected_member(expected_regular_member, regular, symlinks)


def validate(archive: Path, expected_regular_member: str | None = None) -> None:
    if zipfile.is_zipfile(archive):
        _validate_zip(archive, expected_regular_member)
    else:
        _validate_tar(archive, expected_regular_member)


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
