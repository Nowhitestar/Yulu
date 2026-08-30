#!/usr/bin/env python3
"""Transactional migration authority for the installed Yulu application."""

from __future__ import annotations

import ctypes
import argparse
import errno
import fcntl
import hashlib
import json
import os
import plistlib
import re
import select
import signal
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import uuid
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable


class MigrationBlocked(RuntimeError):
    """Raised when migration cannot safely change legacy ownership."""


@dataclass(frozen=True)
class CaptureJobSnapshot:
    loaded: bool
    executable: Path


LEGACY_JOB_LABELS = (
    "com.yulu.ui",
    "com.yulu.audiodaemon",
    "com.yulu.statusagent",
    "com.yulu.scheduler",
    "com.yulu.detector",
    "com.yulu.calendar",
    "com.yulu.sttdaemon",
    "com.yulu.agentqueue",
)


@dataclass(frozen=True)
class MigrationPaths:
    durable_root: Path
    cache_root: Path

    @property
    def journal_dir(self) -> Path:
        return self.durable_root / "application-migration"

    @property
    def journal_path(self) -> Path:
        return self.journal_dir / "journal.json"

    @property
    def lock_dir(self) -> Path:
        return self.cache_root / "application-migration"

    @property
    def attempt_lock_path(self) -> Path:
        return self.lock_dir / "attempt.lock"


_SOL_LOCAL = 0
_LOCAL_PEERPID = 0x002
_MAX_PATH_BYTES = 4096
_MAX_STATUS_BYTES = 64 * 1024
_PROC_PIDTBSDINFO = 3
_MAX_PLIST_BYTES = 1024 * 1024
_MAX_JOURNAL_BYTES = 4 * 1024 * 1024
_MAX_SESSION_MESSAGE_BYTES = 64 * 1024
_MAX_LEGACY_QUEUE_BYTES = 16 * 1024 * 1024
_MAX_LEGACY_QUEUE_OUTPUT_BYTES = 32 * 1024 * 1024
_MAX_TRANSACTION_TREE_ENTRIES = 10_000
_MAX_TRANSACTION_TREE_DEPTH = 64
_MAX_TRANSACTION_TREE_PATH_BYTES = 4 * 1024
_MAX_TRANSACTION_TREE_TOTAL_PATH_BYTES = 1024 * 1024
_MAX_TRANSACTION_TREE_SERIALIZED_BYTES = 2 * 1024 * 1024
_SESSION_RESPONSE_TIMEOUT_SECONDS = 30.0
_NODE_LEAF_TIMEOUT_SECONDS = 120.0
_NODE_LEAF_TERMINATION_GRACE_SECONDS = 2.0
_APPROVAL_TIMEOUT = timedelta(minutes=10)
_BUNDLED_SERVICE_PLISTS = (
    "com.yulu.ui.plist",
    "com.yulu.audiodaemon.plist",
)
_PRODUCT_TEAM_IDENTIFIER = "WMU9678ZQL"
_PRODUCT_SIGNING_IDENTIFIERS = {
    "app": "com.yulu.app",
    "host": "node",
    "capture": "com.yulu.audiodaemon",
}
_APPLICATION_BUNDLE_FILE_NAMES = {
    "Info.plist",
    "yulu_app",
    "node",
    "server.js",
    "audio_daemon",
}
_ORDINARY_FILE_OUTPUTS = (
    ("config.json", "config.json"),
    ("agent-sessions.json", "agent-sessions.json"),
    ("mcp-token.json", "mcp-token.json"),
)
_DIRECTORY_OUTPUTS = (
    ("models", "Models"),
    ("agent-tasks", "agent-tasks"),
    ("local-caption", "local-caption"),
)
_SQLITE_OUTPUTS = (
    ("prompts.sqlite", "prompts"),
    ("vocab.sqlite", "vocab"),
    ("search.sqlite", "search"),
    ("host.sqlite", "host"),
)


class _ProcBSDInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16),
        ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


def _run_launchctl(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["/bin/launchctl", *arguments],
        text=True,
        capture_output=True,
        check=False,
    )


def _run_node_leaf_bounded(
    arguments: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    pass_fds: tuple[int, ...],
    text: bool = True,
    capture_output: bool = True,
    check: bool = False,
    timeout_seconds: float = _NODE_LEAF_TIMEOUT_SECONDS,
    termination_grace_seconds: float = _NODE_LEAF_TERMINATION_GRACE_SECONDS,
) -> subprocess.CompletedProcess[str]:
    del text, capture_output, check
    try:
        process = subprocess.Popen(
            arguments,
            cwd=cwd,
            env=env,
            pass_fds=pass_fds,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except OSError as exc:
        raise MigrationBlocked("Host data preparation leaf could not start") from exc
    try:
        try:
            returncode = process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=termination_grace_seconds)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=termination_grace_seconds)
                except subprocess.TimeoutExpired as exc:
                    raise MigrationBlocked(
                        "Host data preparation leaf could not be reaped"
                    ) from exc
            raise MigrationBlocked("Host data preparation leaf timed out")
        return subprocess.CompletedProcess(arguments, returncode, "", "")
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=termination_grace_seconds)
            except subprocess.TimeoutExpired as exc:
                raise MigrationBlocked(
                    "Host data preparation leaf could not be reaped"
                ) from exc


def _disabled_labels(output: str) -> set[str]:
    return {
        match.group(1)
        for match in re.finditer(r'"([A-Za-z0-9._-]+)"\s*=>\s*true', output)
    }


def _read_plist_at(directory_fd: int, name: str) -> tuple[bytes, int] | None:
    try:
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(file_fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or info.st_size > _MAX_PLIST_BYTES
        ):
            raise MigrationBlocked(f"unsafe legacy LaunchAgent plist: {name}")
        chunks = bytearray()
        while len(chunks) <= _MAX_PLIST_BYTES:
            chunk = os.read(file_fd, min(64 * 1024, _MAX_PLIST_BYTES + 1 - len(chunks)))
            if not chunk:
                break
            chunks.extend(chunk)
        if len(chunks) > _MAX_PLIST_BYTES:
            raise MigrationBlocked(f"legacy LaunchAgent plist is too large: {name}")
        return bytes(chunks), stat.S_IMODE(info.st_mode)
    finally:
        os.close(file_fd)


def _restore_plist_mode_at(directory_fd: int, name: str, expected_mode: object) -> None:
    if type(expected_mode) is not int or expected_mode < 0 or expected_mode > 0o7777:
        raise MigrationBlocked(f"legacy LaunchAgent plist mode is invalid: {name}")
    try:
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
    except OSError as exc:
        raise MigrationBlocked(f"cannot restore legacy LaunchAgent plist mode: {name}") from exc
    try:
        info = os.fstat(file_fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
        ):
            raise MigrationBlocked(f"unsafe legacy LaunchAgent plist: {name}")
        if stat.S_IMODE(info.st_mode) != expected_mode:
            os.fchmod(file_fd, expected_mode)
        os.fsync(file_fd)
    finally:
        os.close(file_fd)


def _open_legacy_agent_queue(legacy_root: Path) -> int | None:
    try:
        root_fd = os.open(
            legacy_root,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        )
    except OSError as exc:
        raise MigrationBlocked("legacy Agent queue root is unsafe") from exc
    try:
        root_info = os.fstat(root_fd)
        if root_info.st_uid != os.geteuid():
            raise MigrationBlocked("legacy Agent queue root is unsafe")
        try:
            queue_fd = os.open(
                "agent-queue.json",
                os.O_RDONLY | os.O_NOFOLLOW,
                dir_fd=root_fd,
            )
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise MigrationBlocked("legacy Agent queue is unsafe") from exc
        queue_info = os.fstat(queue_fd)
        if (
            not stat.S_ISREG(queue_info.st_mode)
            or queue_info.st_uid != os.geteuid()
            or queue_info.st_nlink != 1
            or queue_info.st_size < 0
            or queue_info.st_size > _MAX_LEGACY_QUEUE_BYTES
        ):
            os.close(queue_fd)
            raise MigrationBlocked("legacy Agent queue is unsafe")
        return queue_fd
    finally:
        os.close(root_fd)


def _regular_file_digest(path: Path) -> str:
    file_fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(file_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid():
            raise MigrationBlocked(f"unsafe migration file: {path.name}")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(file_fd, 64 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(file_fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            raise MigrationBlocked(f"migration file changed while hashing: {path.name}")
        return digest.hexdigest()
    finally:
        os.close(file_fd)


def _regular_file_identity_at(parent_fd: int, name: str) -> dict[str, object] | None:
    try:
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise MigrationBlocked(f"unsafe migration file: {Path(name).name}") from exc
    try:
        before = os.fstat(file_fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.geteuid()
            or before.st_nlink != 1
        ):
            raise MigrationBlocked(f"unsafe migration file: {Path(name).name}")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(file_fd, 64 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(file_fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            raise MigrationBlocked(f"migration file changed: {Path(name).name}")
        return {
            "device": before.st_dev,
            "inode": before.st_ino,
            "size": before.st_size,
            "mode": stat.S_IMODE(before.st_mode),
            "sha256": digest.hexdigest(),
        }
    finally:
        os.close(file_fd)


def _regular_file_identity(path: Path) -> dict[str, object]:
    parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        identity = _regular_file_identity_at(parent_fd, path.name)
        if identity is None:
            raise MigrationBlocked(f"migration file is missing: {path.name}")
        return identity
    finally:
        os.close(parent_fd)


def _bundled_regular_file_digest(path: Path) -> str:
    file_fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(file_fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid not in {0, os.geteuid()}
            or stat.S_IMODE(before.st_mode) & 0o022
            or before.st_nlink != 1
        ):
            raise MigrationBlocked(f"unsafe bundled migration file: {path.name}")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(file_fd, 64 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(file_fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            raise MigrationBlocked(f"bundled migration file changed: {path.name}")
        return digest.hexdigest()
    finally:
        os.close(file_fd)


def _tree_manifest(root: Path) -> list[dict[str, object]]:
    root_info = root.lstat()
    if root_info.st_uid != os.geteuid() or not stat.S_ISDIR(root_info.st_mode):
        raise MigrationBlocked(f"unsafe migration directory: {root.name}")
    entries: list[dict[str, object]] = []
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        directory_names.sort()
        file_names.sort()
        current_path = Path(current)
        for directory_name in directory_names:
            directory = current_path / directory_name
            info = directory.lstat()
            if info.st_uid != os.geteuid() or not stat.S_ISDIR(info.st_mode):
                raise MigrationBlocked(f"unsafe migration directory entry: {directory}")
            entries.append({"path": directory.relative_to(root).as_posix(), "kind": "dir"})
        for file_name in file_names:
            file = current_path / file_name
            entries.append(
                {
                    "path": file.relative_to(root).as_posix(),
                    "kind": "file",
                    "sha256": _regular_file_digest(file),
                }
            )
    return entries


def _bounded_sorted_directory_names(directory_fd: int) -> list[str]:
    names: list[str] = []
    with os.scandir(directory_fd) as entries:
        for entry in entries:
            if len(names) >= _MAX_TRANSACTION_TREE_ENTRIES:
                raise MigrationBlocked("transaction directory has too many entries")
            names.append(entry.name)
    names.sort()
    return names


def _directory_identity_at(parent_fd: int, name: str) -> dict[str, object] | None:
    try:
        directory_fd = os.open(
            name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=parent_fd,
        )
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise MigrationBlocked(f"unsafe migration directory: {Path(name).name}") from exc

    try:
        info = os.fstat(directory_fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
            raise MigrationBlocked(f"unsafe migration directory: {Path(name).name}")
        tree_digest = hashlib.sha256()
        entry_count = 0
        total_path_bytes = 0
        serialized_bytes = 0
        root_frame_fd = os.dup(directory_fd)
        try:
            root_names = _bounded_sorted_directory_names(root_frame_fd)
            root_frame_info = os.fstat(root_frame_fd)
        except Exception:
            os.close(root_frame_fd)
            raise
        stack: list[dict[str, object]] = [
            {
                "fd": root_frame_fd,
                "prefix": "",
                "depth": 0,
                "before": root_frame_info,
                "names": root_names,
                "index": 0,
            }
        ]
        try:
            while stack:
                frame = stack[-1]
                frame_fd = int(frame["fd"])
                child_names = frame["names"]
                assert isinstance(child_names, list)
                index = int(frame["index"])
                if index >= len(child_names):
                    before = frame["before"]
                    assert isinstance(before, os.stat_result)
                    after = os.fstat(frame_fd)
                    if _bounded_sorted_directory_names(frame_fd) != child_names or (
                        after.st_dev,
                        after.st_ino,
                        stat.S_IMODE(after.st_mode),
                        after.st_mtime_ns,
                    ) != (
                        before.st_dev,
                        before.st_ino,
                        stat.S_IMODE(before.st_mode),
                        before.st_mtime_ns,
                    ):
                        raise MigrationBlocked(
                            "migration directory changed while recording"
                        )
                    os.close(frame_fd)
                    stack.pop()
                    continue
                if entry_count + len(child_names) - index > _MAX_TRANSACTION_TREE_ENTRIES:
                    raise MigrationBlocked("transaction directory has too many entries")
                child_name = child_names[index]
                assert isinstance(child_name, str)
                frame["index"] = index + 1
                prefix = str(frame["prefix"])
                child_path = f"{prefix}/{child_name}" if prefix else child_name
                encoded_path = os.fsencode(child_path)
                if len(encoded_path) > _MAX_TRANSACTION_TREE_PATH_BYTES:
                    raise MigrationBlocked("transaction directory path is too long")
                total_path_bytes += len(encoded_path)
                if total_path_bytes > _MAX_TRANSACTION_TREE_TOTAL_PATH_BYTES:
                    raise MigrationBlocked("transaction directory paths are too large")
                try:
                    child_info = os.stat(
                        child_name,
                        dir_fd=frame_fd,
                        follow_symlinks=False,
                    )
                except OSError as exc:
                    raise MigrationBlocked(
                        f"unsafe migration directory entry: {child_path}"
                    ) from exc
                if child_info.st_uid != os.geteuid():
                    raise MigrationBlocked(
                        f"unsafe migration directory entry: {child_path}"
                    )
                if stat.S_ISREG(child_info.st_mode):
                    identity = _regular_file_identity_at(frame_fd, child_name)
                    if identity is None or (
                        identity.get("device"),
                        identity.get("inode"),
                    ) != (child_info.st_dev, child_info.st_ino):
                        raise MigrationBlocked(
                            f"migration directory entry changed: {child_path}"
                        )
                    entry = {"path": child_path, "kind": "file", **identity}
                elif stat.S_ISDIR(child_info.st_mode):
                    child_depth = int(frame["depth"]) + 1
                    if child_depth > _MAX_TRANSACTION_TREE_DEPTH:
                        raise MigrationBlocked(
                            "transaction directory is too deeply nested"
                        )
                    try:
                        child_fd = os.open(
                            child_name,
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=frame_fd,
                        )
                    except OSError as exc:
                        raise MigrationBlocked(
                            f"unsafe migration directory entry: {child_path}"
                        ) from exc
                    try:
                        opened_info = os.fstat(child_fd)
                    except Exception:
                        os.close(child_fd)
                        raise
                    if (
                        opened_info.st_uid != os.geteuid()
                        or (opened_info.st_dev, opened_info.st_ino)
                        != (child_info.st_dev, child_info.st_ino)
                    ):
                        os.close(child_fd)
                        raise MigrationBlocked(
                            f"migration directory entry changed: {child_path}"
                        )
                    entry = {
                        "path": child_path,
                        "kind": "directory",
                        "device": opened_info.st_dev,
                        "inode": opened_info.st_ino,
                        "mode": stat.S_IMODE(opened_info.st_mode),
                    }
                else:
                    raise MigrationBlocked(
                        f"unsafe migration directory entry: {child_path}"
                    )
                encoded_entry = (
                    json.dumps(entry, sort_keys=True, separators=(",", ":")) + "\n"
                ).encode()
                serialized_bytes += len(encoded_entry)
                if serialized_bytes > _MAX_TRANSACTION_TREE_SERIALIZED_BYTES:
                    if stat.S_ISDIR(child_info.st_mode):
                        os.close(child_fd)
                    raise MigrationBlocked(
                        "transaction directory identity is too large"
                    )
                tree_digest.update(encoded_entry)
                entry_count += 1
                if stat.S_ISDIR(child_info.st_mode):
                    try:
                        child_names_for_frame = _bounded_sorted_directory_names(
                            child_fd
                        )
                    except Exception:
                        os.close(child_fd)
                        raise
                    stack.append(
                        {
                            "fd": child_fd,
                            "prefix": child_path,
                            "depth": child_depth,
                            "before": opened_info,
                            "names": child_names_for_frame,
                            "index": 0,
                        }
                    )
        finally:
            for frame in stack:
                try:
                    os.close(int(frame["fd"]))
                except OSError:
                    pass
        after = os.fstat(directory_fd)
        if (
            after.st_dev,
            after.st_ino,
            stat.S_IMODE(after.st_mode),
            after.st_mtime_ns,
        ) != (
            info.st_dev,
            info.st_ino,
            stat.S_IMODE(info.st_mode),
            info.st_mtime_ns,
        ):
            raise MigrationBlocked(
                f"migration directory changed: {Path(name).name}"
            )
        return {
            "device": info.st_dev,
            "inode": info.st_ino,
            "mode": stat.S_IMODE(info.st_mode),
            "treeSHA256": tree_digest.hexdigest(),
            "entryCount": entry_count,
            "pathBytes": total_path_bytes,
            "serializedBytes": serialized_bytes,
        }
    finally:
        os.close(directory_fd)


def _remove_owned_tree_at(directory_fd: int) -> None:
    for name in os.listdir(directory_fd):
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if info.st_uid != os.geteuid():
            raise MigrationBlocked("transaction output has unsafe ownership")
        if stat.S_ISREG(info.st_mode):
            os.unlink(name, dir_fd=directory_fd)
            continue
        if not stat.S_ISDIR(info.st_mode):
            raise MigrationBlocked("transaction output has an unsafe entry")
        child_fd = os.open(
            name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=directory_fd,
        )
        try:
            _remove_owned_tree_at(child_fd)
            os.fsync(child_fd)
        finally:
            os.close(child_fd)
        os.rmdir(name, dir_fd=directory_fd)


def _present_kind(path: Path) -> str | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode):
        raise MigrationBlocked(f"unsafe migration output: {path.name}")
    if stat.S_ISREG(info.st_mode):
        return "file"
    if stat.S_ISDIR(info.st_mode):
        return "dir"
    raise MigrationBlocked(f"unsafe migration output: {path.name}")


def _sqlite_identity(path: Path, kind: str) -> dict[str, str]:
    source: sqlite3.Connection | None = None
    snapshot: sqlite3.Connection | None = None
    try:
        source = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        snapshot = sqlite3.connect(":memory:")
        source.backup(snapshot)
        integrity = snapshot.execute("PRAGMA integrity_check").fetchone()
        if integrity != ("ok",):
            raise MigrationBlocked(f"invalid SQLite output: {path.name}")
        tables = {
            row[0]
            for row in snapshot.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
            )
        }
        recognized = (
            (kind == "prompts" and "prompts" in tables)
            or (kind == "vocab" and bool({"custom_words", "vocab"} & tables))
            or (kind == "search" and {"docs", "docs_meta"} <= tables)
            or (kind == "host" and "agent_tasks" in tables)
        )
        if not recognized:
            raise MigrationBlocked(f"invalid SQLite schema: {path.name}")
        if kind != "host" and "meta" in tables:
            version = snapshot.execute(
                "SELECT value FROM meta WHERE key = 'schema_version'"
            ).fetchone()
            if version is not None and version[0] != "1":
                raise MigrationBlocked(f"invalid SQLite schema: {path.name}")
        schema_rows = snapshot.execute(
            "SELECT type, name, tbl_name, COALESCE(sql, '') FROM sqlite_master "
            "ORDER BY type, name, tbl_name, sql"
        ).fetchall()
        schema_encoded = json.dumps(schema_rows, separators=(",", ":")).encode()
        dump = "\n".join(snapshot.iterdump()).encode()
        return {
            "schemaSHA256": hashlib.sha256(schema_encoded).hexdigest(),
            "contentSHA256": hashlib.sha256(dump).hexdigest(),
        }
    except MigrationBlocked:
        raise
    except (OSError, sqlite3.Error) as exc:
        raise MigrationBlocked(f"invalid SQLite output: {path.name}") from exc
    finally:
        if snapshot is not None:
            snapshot.close()
        if source is not None:
            source.close()


def preflight_standard_outputs(
    legacy_root: Path,
    durable_root: Path,
) -> dict[str, dict[str, object]]:
    """Fail before mutation when an existing standard output conflicts."""
    manifest: dict[str, dict[str, object]] = {}
    for source_name, destination_name in _ORDINARY_FILE_OUTPUTS:
        source = legacy_root / source_name
        destination = durable_root / destination_name
        source_kind = _present_kind(source)
        destination_kind = _present_kind(destination)
        if source_kind not in (None, "file") or destination_kind not in (None, "file"):
            raise MigrationBlocked(f"standard output conflicts: {destination_name}")
        source_digest = _regular_file_digest(source) if source_kind else None
        destination_digest = (
            _regular_file_digest(destination) if destination_kind else None
        )
        if source_digest is not None and destination_digest not in (None, source_digest):
            raise MigrationBlocked(f"standard output conflicts: {destination_name}")
        manifest[destination_name] = {
            "kind": "file",
            "sourceSHA256": source_digest,
            "destinationSHA256": destination_digest,
            "reused": destination_digest is not None,
        }

    for source_name, destination_name in _DIRECTORY_OUTPUTS:
        source = legacy_root / source_name
        destination = durable_root / destination_name
        source_kind = _present_kind(source)
        destination_kind = _present_kind(destination)
        if source_kind not in (None, "dir") or destination_kind not in (None, "dir"):
            raise MigrationBlocked(f"standard output conflicts: {destination_name}")
        source_manifest = _tree_manifest(source) if source_kind else None
        destination_manifest = _tree_manifest(destination) if destination_kind else None
        if source_manifest is not None and destination_manifest not in (
            None,
            source_manifest,
        ):
            raise MigrationBlocked(f"standard output conflicts: {destination_name}")
        manifest[destination_name] = {
            "kind": "directory",
            "sourceEntries": source_manifest,
            "destinationEntries": destination_manifest,
            "reused": destination_manifest is not None,
        }

    for name, kind in _SQLITE_OUTPUTS:
        source = legacy_root / name
        destination = durable_root / name
        source_kind = _present_kind(source)
        destination_kind = _present_kind(destination)
        source_sidecars = {
            suffix: (
                _regular_file_identity(legacy_root / f"{name}{suffix}")
                if _present_kind(legacy_root / f"{name}{suffix}") == "file"
                else None
            )
            for suffix in ("-wal", "-shm")
        }
        destination_sidecars = {
            suffix: (
                _regular_file_identity(durable_root / f"{name}{suffix}")
                if _present_kind(durable_root / f"{name}{suffix}") == "file"
                else None
            )
            for suffix in ("-wal", "-shm")
        }
        for root, sidecars in (
            (legacy_root, source_sidecars),
            (durable_root, destination_sidecars),
        ):
            for suffix in ("-wal", "-shm"):
                sidecar_kind = _present_kind(root / f"{name}{suffix}")
                if sidecar_kind not in (None, "file"):
                    raise MigrationBlocked(f"standard SQLite sidecar conflicts: {name}")
            if root == legacy_root and source_kind is None and any(sidecars.values()):
                raise MigrationBlocked(f"standard SQLite sidecar conflicts: {name}")
            if root == durable_root and destination_kind is None and any(sidecars.values()):
                raise MigrationBlocked(f"standard SQLite sidecar conflicts: {name}")
        if source_kind not in (None, "file") or destination_kind not in (None, "file"):
            raise MigrationBlocked(f"standard SQLite conflicts: {name}")
        source_identity = _sqlite_identity(source, kind) if source_kind else None
        destination_identity = (
            _sqlite_identity(destination, kind) if destination_kind else None
        )
        if (
            source_identity is not None
            and destination_identity not in (None, source_identity)
        ):
            raise MigrationBlocked(f"standard SQLite conflicts: {name}")
        manifest[name] = {
            "kind": "sqlite",
            "sourceSchemaSHA256": (
                source_identity["schemaSHA256"] if source_identity else None
            ),
            "sourceContentSHA256": (
                source_identity["contentSHA256"] if source_identity else None
            ),
            "destinationSchemaSHA256": (
                destination_identity["schemaSHA256"] if destination_identity else None
            ),
            "destinationContentSHA256": (
                destination_identity["contentSHA256"] if destination_identity else None
            ),
            "sourceSidecars": source_sidecars,
            "destinationSidecars": destination_sidecars,
            "reused": destination_identity is not None,
        }
    return manifest


def verify_final_commit_inputs(
    *,
    legacy_root: Path,
    durable_root: Path,
    data_manifest: dict[str, object],
    app_bundle: Path,
    app_observation: dict[str, object],
    bundle_manifest: dict[str, object],
    allow_development_adhoc: bool = False,
    required_app_bundle: Path = Path("/Applications/Yulu.app"),
) -> None:
    """Reopen durable databases and bind App evidence before commit."""
    try:
        bundle_info = app_bundle.lstat()
        actual_bundle = app_bundle.resolve(strict=True)
        required_bundle = required_app_bundle.resolve(strict=True)
    except OSError as exc:
        raise MigrationBlocked("installed application evidence is unavailable") from exc
    executable = app_bundle / "Contents/MacOS/yulu_app"
    if (
        not stat.S_ISDIR(bundle_info.st_mode)
        or bundle_info.st_uid not in {0, os.geteuid()}
        or stat.S_IMODE(bundle_info.st_mode) & 0o022
        or actual_bundle != required_bundle
        or app_observation.get("installed") is not True
        or app_observation.get("bundlePath") != str(actual_bundle)
        or app_observation.get("executablePath") != str(executable.resolve(strict=False))
    ):
        raise MigrationBlocked("installed application evidence does not match")
    _validate_code_identity_observation(
        app_observation.get("codeIdentity"),
        expected_identifier=_PRODUCT_SIGNING_IDENTIFIERS["app"],
        allow_development_adhoc=allow_development_adhoc,
    )
    expected_files = _application_bundle_files(app_bundle)
    if set(bundle_manifest) != set(expected_files):
        raise MigrationBlocked("installed application manifest is invalid")
    for name, file in expected_files.items():
        try:
            digest = _bundled_regular_file_digest(file)
        except (OSError, MigrationBlocked) as exc:
            raise MigrationBlocked("installed application evidence does not match") from exc
        if bundle_manifest.get(name) != digest:
            raise MigrationBlocked("installed application evidence changed")

    if not isinstance(data_manifest, dict):
        raise MigrationBlocked("published data manifest is unavailable")
    for name, kind in _SQLITE_OUTPUTS:
        manifest_entry = data_manifest.get(name)
        if manifest_entry is not None and not isinstance(manifest_entry, dict):
            raise MigrationBlocked("published SQLite manifest is invalid")
        expected_schema = None
        if isinstance(manifest_entry, dict):
            expected_schema = manifest_entry.get("destinationSchemaSHA256") or manifest_entry.get(
                "sourceSchemaSHA256"
            )
        database = durable_root / name
        current_kind = _present_kind(database)
        if expected_schema is not None and current_kind is None:
            raise MigrationBlocked(f"published SQLite is missing: {name}")
        if current_kind is None:
            continue
        if current_kind != "file":
            raise MigrationBlocked(f"invalid SQLite output: {name}")
        identity = _sqlite_identity(database, kind)
        if expected_schema is not None and identity["schemaSHA256"] != expected_schema:
            raise MigrationBlocked(f"invalid SQLite schema: {name}")


def _application_bundle_files(app_bundle: Path) -> dict[str, Path]:
    return {
        "Info.plist": app_bundle / "Contents/Info.plist",
        "yulu_app": app_bundle / "Contents/MacOS/yulu_app",
        "node": app_bundle / "Contents/Resources/runtime/bin/node",
        "server.js": app_bundle / "Contents/Resources/Host/server.js",
        "audio_daemon": app_bundle
        / "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
    }


def _application_bundle_manifest(app_bundle: Path) -> dict[str, str]:
    try:
        return {
            name: _bundled_regular_file_digest(path)
            for name, path in _application_bundle_files(app_bundle).items()
        }
    except (OSError, MigrationBlocked) as exc:
        raise MigrationBlocked("installed application evidence is unavailable") from exc


def _validate_code_identity_observation(
    raw: object,
    *,
    expected_identifier: str,
    allow_development_adhoc: bool,
) -> None:
    if not isinstance(raw, dict):
        raise MigrationBlocked("code identity evidence is missing")
    expected_team = "adhoc" if allow_development_adhoc else _PRODUCT_TEAM_IDENTIFIER
    cd_hash = raw.get("cdHash")
    if (
        raw.get("accepted") is not True
        or raw.get("identifier") != expected_identifier
        or raw.get("teamIdentifier") != expected_team
        or raw.get("staticSealValid") is not True
        or raw.get("dynamicValid") is not True
        or raw.get("staticDynamicMatch") is not True
        or not isinstance(cd_hash, str)
        or re.fullmatch(r"[0-9a-f]{40,128}", cd_hash) is None
    ):
        raise MigrationBlocked("code identity evidence does not match")


def _capture_snapshot_from_jobs(
    snapshot: dict[str, dict[str, object]], home_dir: Path
) -> CaptureJobSnapshot:
    capture = snapshot["com.yulu.audiodaemon"]
    if not capture["loaded"]:
        return CaptureJobSnapshot(loaded=False, executable=Path("/dev/null"))
    raw = capture.get("plistBytes")
    if not isinstance(raw, str):
        raise MigrationBlocked("loaded legacy Capture has no executable snapshot")
    try:
        payload = plistlib.loads(bytes.fromhex(raw))
    except (ValueError, plistlib.InvalidFileException) as exc:
        raise MigrationBlocked("legacy Capture plist is invalid") from exc
    executable = payload.get("Program")
    if not isinstance(executable, str):
        arguments = payload.get("ProgramArguments")
        executable = arguments[0] if isinstance(arguments, list) and arguments else None
    if not isinstance(executable, str) or not executable:
        raise MigrationBlocked("loaded legacy Capture has no executable snapshot")
    if executable.startswith("~/"):
        executable = str(home_dir / executable[2:])
    executable_path = Path(executable)
    if not executable_path.is_absolute():
        raise MigrationBlocked("legacy Capture executable is not absolute")
    return CaptureJobSnapshot(loaded=True, executable=executable_path)


def _launch_agents_identity(
    snapshot: dict[str, dict[str, object]],
) -> tuple[int, int]:
    identities = {
        (entry.get("launchAgentsDevice"), entry.get("launchAgentsInode"))
        for entry in snapshot.values()
    }
    if (
        len(identities) != 1
        or not all(type(value) is int for value in next(iter(identities)))
    ):
        raise MigrationBlocked("legacy LaunchAgents directory identity is invalid")
    device, inode = next(iter(identities))
    return int(device), int(inode)


def legacy_install_present(
    *,
    legacy_root: Path,
    launch_agents_dir: Path,
    launchctl: Callable[[list[str]], object] = _run_launchctl,
) -> bool:
    """Inspect legacy ownership without creating migration or application state."""
    try:
        legacy_root.lstat()
        return True
    except FileNotFoundError:
        pass

    uid = os.geteuid()
    disabled = launchctl(["print-disabled", f"gui/{uid}"])
    if getattr(disabled, "returncode", 1) != 0:
        return True
    disabled_output = str(getattr(disabled, "stdout", ""))
    if any(
        re.search(rf'"{re.escape(label)}"\s*=>', disabled_output)
        for label in LEGACY_JOB_LABELS
    ):
        return True
    for label in LEGACY_JOB_LABELS:
        observed = launchctl(["print", f"gui/{uid}/{label}"])
        returncode = int(getattr(observed, "returncode", 1))
        if returncode == 0:
            return True
        if returncode != 113:
            return True

    try:
        directory_fd = os.open(
            launch_agents_dir,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        )
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise MigrationBlocked(
            "cannot safely inspect the legacy LaunchAgents directory"
        ) from exc
    try:
        info = os.fstat(directory_fd)
        if info.st_uid != uid:
            raise MigrationBlocked("legacy LaunchAgents directory has unsafe ownership")
        return any(
            _read_plist_at(directory_fd, f"{label}.plist") is not None
            for label in LEGACY_JOB_LABELS
        )
    finally:
        os.close(directory_fd)


def run_migration_step(
    *,
    paths: MigrationPaths,
    home_dir: Path,
    legacy_root: Path,
    launch_agents_dir: Path,
    archive_dir: Path,
    legacy_capture_socket: Path,
    node_executable: Path,
    server_js: Path,
    app_bundle: Path | None = None,
    required_app_bundle: Path = Path("/Applications/Yulu.app"),
    allow_development_adhoc: bool = False,
    launchctl: Callable[[list[str]], object] = _run_launchctl,
    run_node: Callable[..., object] | None = None,
    attempt_fd: int | None = None,
    authority: ApplicationMigration | None = None,
    event: str | None = None,
    observation: dict[str, object] | None = None,
) -> dict[str, object]:
    """Advance one durable transaction step and return the next Swift action."""
    authority_scope = (
        ApplicationMigration(paths, attempt_fd=attempt_fd)
        if authority is None
        else nullcontext(authority)
    )
    with authority_scope as authority:
        if authority._journal is None:
            authority.begin()
            if app_bundle is not None:
                authority.record_bundle_manifest(
                    _application_bundle_manifest(app_bundle)
                )
            preflight_standard_outputs(legacy_root, paths.durable_root)
            launch_agents_fd = authority.launch_agents_fd(launch_agents_dir)
            try:
                snapshot = snapshot_legacy_jobs(
                    launch_agents_dir,
                    launchctl=launchctl,
                    directory_fd=launch_agents_fd,
                )
            finally:
                os.close(launch_agents_fd)
            capture_snapshot = _capture_snapshot_from_jobs(snapshot, home_dir)
            authority.transition("guarded", intent={"action": "capture-guard-ready"})
            snapshot = authority.record_job_snapshot(snapshot)
            authority.quiesce_legacy_jobs(
                snapshot,
                launch_agents_dir=launch_agents_dir,
                archive_dir=archive_dir,
                launchctl=launchctl,
                final_capture_idle=lambda: assert_legacy_capture_idle(
                    capture_snapshot,
                    legacy_capture_socket,
                ),
            )
            from dictate import migrate_legacy_dictation_media

            migrate_legacy_dictation_media(
                legacy_dir=legacy_root / "dictation",
                media_dir=home_dir / "Movies" / "Yulu" / "Dictation",
                manifest_path=paths.journal_dir / "dictation-media.json",
            )
            authority.publish_standard_data(
                legacy_root=legacy_root,
                node_executable=node_executable,
                server_js=server_js,
                run=run_node,
            )
            return authority.request_registration()

        phase = str(authority._journal["phase"])
        if event == "cancel" and phase in {
            "registration_requested",
            "awaiting_approval",
            "services_enabled",
            "verifying",
        }:
            return authority.request_rollback("user_cancelled")
        if observation is not None:
            kind = observation.get("kind")
            if kind == "services":
                statuses = observation.get("statuses")
                if not isinstance(statuses, dict):
                    raise MigrationBlocked("invalid service observation")
                if phase == "rollback_requested":
                    action = authority.confirm_services_unregistered(
                        transaction_id=observation.get("transactionId"),
                        nonce=observation.get("nonce"),
                        statuses=statuses,
                    )
                    if action["action"] == "restore_legacy":
                        job_snapshot = authority._journal.get("jobSnapshot")
                        if not isinstance(job_snapshot, dict):
                            raise MigrationBlocked("rollback job snapshot is missing")
                        authority.rollback_legacy_jobs(
                            job_snapshot,
                            launch_agents_dir=launch_agents_dir,
                            archive_dir=archive_dir,
                            launchctl=launchctl,
                        )
                        return authority._service_action("rolled_back")
                return authority.observe_service_statuses(
                    transaction_id=observation.get("transactionId"),
                    nonce=observation.get("nonce"),
                    statuses=statuses,
                )
            if kind == "health":
                host = observation.get("host")
                capture = observation.get("capture")
                app = observation.get("app")
                if (
                    not isinstance(host, dict)
                    or not isinstance(capture, dict)
                    or not isinstance(app, dict)
                    or app_bundle is None
                ):
                    raise MigrationBlocked("invalid health observation")
                data_manifest = authority._journal.get("dataManifest")
                bundle_manifest = authority._journal.get("bundleManifest")
                if not isinstance(data_manifest, dict):
                    raise MigrationBlocked("published data manifest is unavailable")
                if not isinstance(bundle_manifest, dict):
                    raise MigrationBlocked("installed application manifest is unavailable")
                _validate_code_identity_observation(
                    host.get("codeIdentity"),
                    expected_identifier=_PRODUCT_SIGNING_IDENTIFIERS["host"],
                    allow_development_adhoc=allow_development_adhoc,
                )
                _validate_code_identity_observation(
                    capture.get("codeIdentity"),
                    expected_identifier=_PRODUCT_SIGNING_IDENTIFIERS["capture"],
                    allow_development_adhoc=allow_development_adhoc,
                )
                verify_final_commit_inputs(
                    legacy_root=legacy_root,
                    durable_root=paths.durable_root,
                    data_manifest=data_manifest,
                    app_bundle=app_bundle,
                    required_app_bundle=required_app_bundle,
                    app_observation=app,
                    bundle_manifest=bundle_manifest,
                    allow_development_adhoc=allow_development_adhoc,
                )
                return authority.observe_commit_health(
                    transaction_id=observation.get("transactionId"),
                    nonce=observation.get("nonce"),
                    host=host,
                    capture=capture,
                )
            raise MigrationBlocked("unknown migration observation")

        if phase == "awaiting_approval":
            return authority.resume_pending_registration()
        if phase in {"registration_requested", "services_enabled", "verifying"}:
            return authority.request_rollback("crash_recovery")
        if phase == "rollback_requested":
            return authority._service_action(
                "unregister_services",
                reason="recovery",
                services=list(_BUNDLED_SERVICE_PLISTS),
            )
        if phase in {"preflight", "guarded"}:
            authority.transition(
                "rolled_back", intent={"action": "crash-recovery-no-mutation"}
            )
            return {"action": "rolled_back"}
        if phase in {
            "snapshotted",
            "legacy_quiescing",
            "legacy_quiesced",
            "data_publishing",
            "data_published",
            "rolling_back",
        }:
            job_snapshot = authority._journal.get("jobSnapshot")
            if not isinstance(job_snapshot, dict):
                raise MigrationBlocked("rollback job snapshot is missing")
            authority.rollback_legacy_jobs(
                job_snapshot,
                launch_agents_dir=launch_agents_dir,
                archive_dir=archive_dir,
                launchctl=launchctl,
            )
            return {"action": "rolled_back"}
        if phase == "committed":
            return authority._service_action("committed")
        if phase == "rolled_back":
            return {"action": "rolled_back"}
        raise MigrationBlocked(f"migration recovery requires rollback from phase: {phase}")


def run_bundled_service_adapter(
    action: dict[str, object],
    *,
    app_bundle: Path,
    run: Callable[..., object] = subprocess.run,
) -> dict[str, str]:
    """Apply one bound rollback action through the installed outer App."""
    if (
        action.get("action") != "unregister_services"
        or not isinstance(action.get("transactionId"), str)
        or not isinstance(action.get("nonce"), str)
        or action.get("services") != list(_BUNDLED_SERVICE_PLISTS)
    ):
        raise MigrationBlocked("service rollback adapter received an invalid action")
    executable = app_bundle / "Contents/MacOS/yulu_app"
    _bundled_regular_file_digest(executable)
    encoded_action = json.dumps(action, sort_keys=True, separators=(",", ":"))
    environment = {
        key: value
        for key, value in os.environ.items()
        if key not in {"NODE_OPTIONS", "NODE_PATH"}
        and not key.startswith("PYTHON")
        and not key.startswith("DYLD_")
    }
    result = run(
        [
            str(executable),
            "--apply-migration-service-action",
            encoded_action,
        ],
        env=environment,
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )
    output = str(getattr(result, "stdout", ""))
    if getattr(result, "returncode", 1) != 0 or not output or len(output) > 64 * 1024:
        raise MigrationBlocked("bundled service rollback adapter failed")
    try:
        response = json.loads(output)
    except json.JSONDecodeError as exc:
        raise MigrationBlocked("bundled service rollback adapter returned invalid JSON") from exc
    statuses = response.get("statuses") if isinstance(response, dict) else None
    if (
        not isinstance(statuses, dict)
        or set(statuses) != set(_BUNDLED_SERVICE_PLISTS)
        or any(
            status not in {"notRegistered", "notFound"}
            for status in statuses.values()
        )
    ):
        raise MigrationBlocked("bundled service rollback adapter did not unregister services")
    return {str(name): str(status) for name, status in statuses.items()}


def _compensate_session(
    action: dict[str, object],
    *,
    paths: MigrationPaths,
    step: Callable[..., dict[str, object]],
    service_adapter: Callable[[dict[str, object]], dict[str, str]] | None,
    step_arguments: dict[str, object],
) -> dict[str, object]:
    rollback_action = action
    if rollback_action.get("action") != "unregister_services":
        rollback_action = step(
            paths=paths,
            event="cancel",
            observation=None,
            **step_arguments,
        )
    if rollback_action.get("action") != "unregister_services":
        raise MigrationBlocked(
            "migration session ended before rollback could unregister services"
        )
    if service_adapter is None:
        raise MigrationBlocked(
            "migration session ended without a service rollback adapter"
        )
    statuses = service_adapter(rollback_action)
    return step(
        paths=paths,
        event=None,
        observation={
            "kind": "services",
            "transactionId": rollback_action.get("transactionId"),
            "nonce": rollback_action.get("nonce"),
            "statuses": statuses,
        },
        **step_arguments,
    )


def _mark_session_rollback_blocked(
    paths: MigrationPaths,
    failure: Exception,
    *,
    attempt_fd: int | None,
    authority: ApplicationMigration | None,
) -> dict[str, object]:
    detail = str(failure)[:512] or "migration rollback failed"
    try:
        authority_scope = (
            nullcontext(authority)
            if authority is not None
            else ApplicationMigration(paths, attempt_fd=attempt_fd)
        )
        with authority_scope as authority:
            if authority._journal is not None and authority._journal.get("phase") not in {
                "committed",
                "rolled_back",
            }:
                authority.transition(
                    "rollback_blocked",
                    intent={"action": "manual-remediation", "detail": detail},
                )
    except Exception:
        pass
    return {"action": "blocked", "detail": detail}


def _recover_live_session_failure(
    failure: Exception,
    *,
    paths: MigrationPaths,
    step: Callable[..., dict[str, object]],
    service_adapter: Callable[[dict[str, object]], dict[str, str]] | None,
    step_arguments: dict[str, object],
) -> dict[str, object]:
    try:
        action = step(
            paths=paths,
            event="cancel",
            observation=None,
            **step_arguments,
        )
        if action.get("action") == "unregister_services":
            if service_adapter is None:
                raise MigrationBlocked(
                    "live migration failure has no service rollback adapter"
                )
            statuses = service_adapter(action)
            action = step(
                paths=paths,
                event=None,
                observation={
                    "kind": "services",
                    "transactionId": action.get("transactionId"),
                    "nonce": action.get("nonce"),
                    "statuses": statuses,
                },
                **step_arguments,
            )
        if action.get("action") not in {"rolled_back", "blocked"}:
            raise MigrationBlocked(
                f"live migration failure did not reach rollback: {failure}"
            )
        return action
    except Exception as recovery_failure:
        raw_attempt_fd = step_arguments.get("attempt_fd")
        raw_authority = step_arguments.get("authority")
        return _mark_session_rollback_blocked(
            paths,
            recovery_failure,
            attempt_fd=raw_attempt_fd if isinstance(raw_attempt_fd, int) else None,
            authority=(
                raw_authority
                if isinstance(raw_authority, ApplicationMigration)
                else None
            ),
        )


def run_migration_session(
    *,
    paths: MigrationPaths,
    step: Callable[..., dict[str, object]] = run_migration_step,
    input_stream=None,
    output_stream=None,
    service_adapter: Callable[[dict[str, object]], dict[str, str]] | None = None,
    response_timeout_seconds: float = _SESSION_RESPONSE_TIMEOUT_SECONDS,
    session_now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    **step_arguments: object,
) -> int:
    """Hold one OS lock while Swift and the Python authority exchange actions."""
    input_stream = input_stream or sys.stdin.buffer
    output_stream = output_stream or sys.stdout.buffer
    attempt_fd = -1
    attempt_locked = False
    session_authority: ApplicationMigration | None = None
    if step is run_migration_step:
        legacy_root = step_arguments.get("legacy_root")
        launch_agents_dir = step_arguments.get("launch_agents_dir")
        launchctl = step_arguments.get("launchctl", _run_launchctl)
        if (
            not isinstance(legacy_root, Path)
            or not isinstance(launch_agents_dir, Path)
            or not callable(launchctl)
        ):
            raise MigrationBlocked("migration session legacy inspection is incomplete")
        legacy_present = legacy_install_present(
            legacy_root=legacy_root,
            launch_agents_dir=launch_agents_dir,
            launchctl=launchctl,
        )
        if not legacy_present:
            journal_present = _migration_journal_entry_present(paths.journal_path)
            attempt_fd = _open_existing_attempt_lock(paths.attempt_lock_path)
            if attempt_fd >= 0:
                try:
                    fcntl.flock(attempt_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    output_stream.write(b'{"action":"busy"}\n')
                    output_stream.flush()
                    os.close(attempt_fd)
                    return 75
                attempt_locked = True
                journal_present = _migration_journal_entry_present(paths.journal_path)
                legacy_present = legacy_install_present(
                    legacy_root=legacy_root,
                    launch_agents_dir=launch_agents_dir,
                    launchctl=launchctl,
                )
            if not journal_present and not legacy_present:
                output_stream.write(b'{"action":"fresh_install"}\n')
                output_stream.flush()
                if attempt_fd >= 0:
                    os.close(attempt_fd)
                return 0
    if attempt_fd < 0:
        _ensure_private_directory(paths.lock_dir)
        attempt_fd = os.open(
            paths.attempt_lock_path,
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
            0o600,
        )
    try:
        attempt_info = os.fstat(attempt_fd)
        if (
            not stat.S_ISREG(attempt_info.st_mode)
            or attempt_info.st_uid != os.geteuid()
            or attempt_info.st_nlink != 1
        ):
            raise MigrationBlocked("migration attempt lock has unsafe ownership or type")
        os.fchmod(attempt_fd, 0o600)
        if not attempt_locked:
            try:
                fcntl.flock(attempt_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                output_stream.write(b'{"action":"busy"}\n')
                output_stream.flush()
                return 75

        if step is run_migration_step or _migration_journal_entry_present(
            paths.journal_path
        ):
            session_authority = ApplicationMigration(
                paths,
                attempt_fd=attempt_fd,
            ).__enter__()
            step_arguments = {
                **step_arguments,
                "attempt_fd": attempt_fd,
                "authority": session_authority,
            }

        try:
            action = step(paths=paths, **step_arguments)
        except Exception as failure:
            action = _recover_live_session_failure(
                failure,
                paths=paths,
                step=step,
                service_adapter=service_adapter,
                step_arguments=step_arguments,
            )
        while True:
            try:
                output_stream.write(
                    (json.dumps(action, sort_keys=True, separators=(",", ":")) + "\n").encode()
                )
                output_stream.flush()
            except (BrokenPipeError, OSError) as failure:
                if action.get("action") in {"committed", "rolled_back", "fresh_install"}:
                    return 0
                try:
                    action = _compensate_session(
                        action,
                        paths=paths,
                        step=step,
                        service_adapter=service_adapter,
                        step_arguments=step_arguments,
                    )
                except Exception as compensation_failure:
                    action = _recover_live_session_failure(
                        compensation_failure,
                        paths=paths,
                        step=step,
                        service_adapter=service_adapter,
                        step_arguments=step_arguments,
                    )
                return 0 if action.get("action") == "rolled_back" else 75
            if action.get("action") in {
                "committed",
                "rolled_back",
                "blocked",
                "fresh_install",
            }:
                return 0 if action.get("action") != "blocked" else 75
            try:
                wait_timeout = response_timeout_seconds
                if action.get("action") == "await_approval":
                    raw_deadline = action.get("deadlineAt")
                    if not isinstance(raw_deadline, str):
                        raise MigrationBlocked("approval action deadline is invalid")
                    try:
                        deadline = datetime.fromisoformat(raw_deadline)
                    except ValueError as exc:
                        raise MigrationBlocked("approval action deadline is invalid") from exc
                    if deadline.tzinfo is None:
                        raise MigrationBlocked("approval action deadline is invalid")
                    wait_timeout = max(
                        0.0,
                        min(_APPROVAL_TIMEOUT.total_seconds(), (deadline - session_now()).total_seconds()),
                    )
                ready, _, _ = select.select(
                    [input_stream], [], [], wait_timeout
                )
                if not ready:
                    if action.get("action") == "await_approval":
                        try:
                            action = step(
                                paths=paths,
                                event="resume",
                                observation=None,
                                **step_arguments,
                            )
                        except Exception as failure:
                            action = _recover_live_session_failure(
                                failure,
                                paths=paths,
                                step=step,
                                service_adapter=service_adapter,
                                step_arguments=step_arguments,
                            )
                        continue
                    raise MigrationBlocked("migration session response timed out")
                encoded = input_stream.readline(_MAX_SESSION_MESSAGE_BYTES + 1)
                if not encoded:
                    raise MigrationBlocked("migration session input ended")
                if len(encoded) > _MAX_SESSION_MESSAGE_BYTES or not encoded.endswith(b"\n"):
                    raise MigrationBlocked("migration session message is too large")
                try:
                    message = json.loads(encoded)
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise MigrationBlocked("migration session message is invalid") from exc
                if not isinstance(message, dict):
                    raise MigrationBlocked("migration session message must be an object")
                if (
                    message.get("transactionId") != action.get("transactionId")
                    or message.get("nonce") != action.get("nonce")
                    or not isinstance(message.get("transactionId"), str)
                    or not isinstance(message.get("nonce"), str)
                ):
                    raise MigrationBlocked("migration session message is stale")
                event = message.get("event")
                observation = message.get("observation")
                if event not in {None, "resume", "cancel"}:
                    raise MigrationBlocked("migration session event is invalid")
                if observation is not None and not isinstance(observation, dict):
                    raise MigrationBlocked("migration session observation is invalid")
                if (event is None) == (observation is None):
                    raise MigrationBlocked("migration session message must have one payload")
            except MigrationBlocked:
                try:
                    action = _compensate_session(
                        action,
                        paths=paths,
                        step=step,
                        service_adapter=service_adapter,
                        step_arguments=step_arguments,
                    )
                except Exception as failure:
                    action = _recover_live_session_failure(
                        failure,
                        paths=paths,
                        step=step,
                        service_adapter=service_adapter,
                        step_arguments=step_arguments,
                    )
                continue
            try:
                action = step(
                    paths=paths,
                    event=event,
                    observation=observation,
                    **step_arguments,
                )
            except Exception as failure:
                action = _recover_live_session_failure(
                    failure,
                    paths=paths,
                    step=step,
                    service_adapter=service_adapter,
                    step_arguments=step_arguments,
                )
    finally:
        if session_authority is not None:
            session_authority.close()
        os.close(attempt_fd)


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["session"])
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--durable", required=True, type=Path)
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--legacy", required=True, type=Path)
    parser.add_argument("--launch-agents", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--capture-socket", required=True, type=Path)
    parser.add_argument("--node", required=True, type=Path)
    parser.add_argument("--server", required=True, type=Path)
    parser.add_argument("--app", type=Path)
    parser.add_argument("--allow-development-adhoc", action="store_true")
    options = parser.parse_args(arguments)
    try:
        paths = MigrationPaths(
            durable_root=options.durable,
            cache_root=options.cache,
        )
        step_arguments = {
            "home_dir": options.home,
            "legacy_root": options.legacy,
            "launch_agents_dir": options.launch_agents,
            "archive_dir": options.archive,
            "legacy_capture_socket": options.capture_socket,
            "node_executable": options.node,
            "server_js": options.server,
        }
        if options.app is not None:
            step_arguments["app_bundle"] = options.app
        if options.allow_development_adhoc:
            step_arguments["allow_development_adhoc"] = True
        service_adapter = None
        if options.app is not None:
            service_adapter = lambda action: run_bundled_service_adapter(
                action,
                app_bundle=options.app,
            )
        return run_migration_session(
            paths=paths,
            service_adapter=service_adapter,
            **step_arguments,
        )
    except MigrationBlocked as exc:
        print(json.dumps({"action": "blocked", "detail": str(exc)}, sort_keys=True))
        return 75


def snapshot_legacy_jobs(
    launch_agents_dir: Path,
    *,
    launchctl: Callable[[list[str]], object] = _run_launchctl,
    directory_fd: int | None = None,
) -> dict[str, dict[str, object]]:
    """Snapshot only Yulu's fixed legacy LaunchAgent allowlist."""
    uid = os.geteuid()
    disabled_result = launchctl(["print-disabled", f"gui/{uid}"])
    if getattr(disabled_result, "returncode", 1) != 0:
        raise MigrationBlocked("cannot snapshot launchd disabled state")
    disabled = _disabled_labels(str(getattr(disabled_result, "stdout", "")))

    if directory_fd is None:
        try:
            opened_directory_fd = os.open(
                launch_agents_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            )
        except OSError as exc:
            raise MigrationBlocked("cannot safely open the legacy LaunchAgents directory") from exc
    else:
        opened_directory_fd = os.dup(directory_fd)
    try:
        directory_info = os.fstat(opened_directory_fd)
        if directory_info.st_uid != uid:
            raise MigrationBlocked("legacy LaunchAgents directory has unsafe ownership")
        snapshot: dict[str, dict[str, object]] = {}
        for label in LEGACY_JOB_LABELS:
            result = launchctl(["print", f"gui/{uid}/{label}"])
            returncode = int(getattr(result, "returncode", 1))
            if returncode not in (0, 113):
                raise MigrationBlocked(f"cannot snapshot launchd job state: {label}")
            loaded = returncode == 0
            plist = _read_plist_at(opened_directory_fd, f"{label}.plist")
            if loaded and plist is None:
                raise MigrationBlocked(f"loaded legacy job has no plist: {label}")
            plist_bytes, plist_mode = plist if plist is not None else (None, None)
            snapshot[label] = {
                "loaded": loaded,
                "disabled": label in disabled,
                "launchAgentsDevice": directory_info.st_dev,
                "launchAgentsInode": directory_info.st_ino,
                "plistBytes": plist_bytes.hex() if plist_bytes is not None else None,
                "plistSHA256": (
                    hashlib.sha256(plist_bytes).hexdigest()
                    if plist_bytes is not None
                    else None
                ),
                "plistMode": plist_mode,
            }
        return snapshot
    finally:
        os.close(opened_directory_fd)


def _open_existing_private_directory(path: Path) -> int:
    if not path.is_absolute() or any(part in {".", ".."} for part in path.parts):
        raise MigrationBlocked("private migration directory must be absolute")
    current_fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:]:
            try:
                next_fd = os.open(
                    component,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=current_fd,
                )
            except FileNotFoundError:
                return -1
            except OSError as exc:
                raise MigrationBlocked("unsafe private migration directory") from exc
            os.close(current_fd)
            current_fd = next_fd
        info = os.fstat(current_fd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise MigrationBlocked("unsafe private migration directory owner or mode")
        result = current_fd
        current_fd = -1
        return result
    finally:
        if current_fd >= 0:
            os.close(current_fd)


def _migration_journal_entry_present(path: Path) -> bool:
    parent_fd = _open_existing_private_directory(path.parent)
    if parent_fd < 0:
        return False
    try:
        try:
            journal_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
        except FileNotFoundError:
            return False
        except OSError as exc:
            raise MigrationBlocked("migration journal has unsafe ownership or type") from exc
        try:
            info = os.fstat(journal_fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_nlink != 1
                or info.st_size <= 0
                or info.st_size > _MAX_JOURNAL_BYTES
            ):
                raise MigrationBlocked("migration journal has unsafe ownership or type")
            return True
        finally:
            os.close(journal_fd)
    finally:
        os.close(parent_fd)


def _open_existing_attempt_lock(path: Path) -> int:
    parent_fd = _open_existing_private_directory(path.parent)
    if parent_fd < 0:
        return -1
    try:
        try:
            lock_fd = os.open(path.name, os.O_RDWR | os.O_NOFOLLOW, dir_fd=parent_fd)
        except FileNotFoundError:
            return -1
        except OSError as exc:
            raise MigrationBlocked("migration attempt lock has unsafe ownership or type") from exc
        info = os.fstat(lock_fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
        ):
            os.close(lock_fd)
            raise MigrationBlocked("migration attempt lock has unsafe ownership or type")
        return lock_fd
    finally:
        os.close(parent_fd)


def _ensure_private_directory(path: Path) -> None:
    if not path.is_absolute() or any(part in {".", ".."} for part in path.parts):
        raise MigrationBlocked("private migration directory must be absolute")
    current_fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        components = path.parts[1:]
        for index, component in enumerate(components):
            created = False
            try:
                os.mkdir(component, 0o700, dir_fd=current_fd)
                created = True
            except FileExistsError:
                pass
            try:
                next_fd = os.open(
                    component,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=current_fd,
                )
            except OSError as exc:
                raise MigrationBlocked("unsafe private migration directory") from exc
            info = os.fstat(next_fd)
            if created or index == len(components) - 1:
                if info.st_uid != os.geteuid():
                    os.close(next_fd)
                    raise MigrationBlocked("unsafe private migration directory owner")
                os.fchmod(next_fd, 0o700)
            os.close(current_fd)
            current_fd = next_fd
    finally:
        os.close(current_fd)


def _write_all(file_fd: int, encoded: bytes) -> None:
    view = memoryview(encoded)
    while view:
        written = os.write(file_fd, view)
        if written <= 0:
            raise MigrationBlocked("migration state write was incomplete")
        view = view[written:]


def _open_private_child_directory_at(
    parent_fd: int,
    name: str,
    *,
    create: bool,
) -> int:
    if not name or name in {".", ".."} or "/" in name:
        raise MigrationBlocked("invalid private migration directory name")
    created = False
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
            created = True
            os.fsync(parent_fd)
        except FileExistsError:
            pass
    try:
        child_fd = os.open(
            name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=parent_fd,
        )
    except OSError as exc:
        raise MigrationBlocked("private migration snapshot directory is unsafe") from exc
    try:
        info = os.fstat(child_fd)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o700
        ):
            raise MigrationBlocked("private migration snapshot directory is unsafe")
        if created:
            os.fsync(child_fd)
        result = child_fd
        child_fd = -1
        return result
    finally:
        if child_fd >= 0:
            os.close(child_fd)


def _require_child_directory_identity_at(
    parent_fd: int,
    name: str,
    expected_fd: int,
) -> None:
    try:
        observed_fd = _open_private_child_directory_at(parent_fd, name, create=False)
    except MigrationBlocked as exc:
        raise MigrationBlocked("private migration directory changed") from exc
    try:
        expected = os.fstat(expected_fd)
        observed = os.fstat(observed_fd)
        if (expected.st_dev, expected.st_ino) != (observed.st_dev, observed.st_ino):
            raise MigrationBlocked("private migration directory changed")
    finally:
        os.close(observed_fd)


def _rename_exclusive_at(
    source_fd: int,
    source_name: str,
    destination_fd: int,
    destination_name: str,
) -> bool:
    """Move one entry without ever replacing an existing destination."""
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        renameatx_np = libc.renameatx_np
    except AttributeError as exc:
        raise MigrationBlocked("exclusive migration restore is unavailable") from exc
    renameatx_np.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameatx_np.restype = ctypes.c_int
    result = renameatx_np(
        source_fd,
        os.fsencode(source_name),
        destination_fd,
        os.fsencode(destination_name),
        0x00000004,  # RENAME_EXCL
    )
    if result == 0:
        return True
    error = ctypes.get_errno()
    if error in {errno.EEXIST, errno.ENOTEMPTY}:
        return False
    raise MigrationBlocked("exclusive migration restore failed") from OSError(
        error, os.strerror(error)
    )


def _read_private_file_at(parent_fd: int, name: str) -> bytes:
    try:
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    except OSError as exc:
        raise MigrationBlocked("private migration snapshot is missing or unsafe") from exc
    try:
        before = os.fstat(file_fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.geteuid()
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_nlink != 1
            or before.st_size < 0
            or before.st_size > _MAX_PLIST_BYTES
        ):
            raise MigrationBlocked("private migration snapshot is unsafe")
        contents = bytearray()
        while len(contents) <= _MAX_PLIST_BYTES:
            chunk = os.read(
                file_fd,
                min(64 * 1024, _MAX_PLIST_BYTES + 1 - len(contents)),
            )
            if not chunk:
                break
            contents.extend(chunk)
        after = os.fstat(file_fd)
        if len(contents) > _MAX_PLIST_BYTES or (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            raise MigrationBlocked("private migration snapshot changed while reading")
        return bytes(contents)
    finally:
        os.close(file_fd)


def _publish_private_file_at(parent_fd: int, name: str, contents: bytes) -> bool:
    if not name or name in {".", ".."} or "/" in name:
        raise MigrationBlocked("invalid private migration snapshot name")
    temporary_name = f".{name}.{uuid.uuid4().hex}.tmp"
    temporary_fd = -1
    linked_new = False
    publication_verified = False
    try:
        temporary_fd = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent_fd,
        )
        _write_all(temporary_fd, contents)
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = -1
        try:
            os.link(
                temporary_name,
                name,
                src_dir_fd=parent_fd,
                dst_dir_fd=parent_fd,
                follow_symlinks=False,
            )
            linked_new = True
        except FileExistsError:
            if _read_private_file_at(parent_fd, name) != contents:
                raise MigrationBlocked("private migration snapshot conflicts")
        os.unlink(temporary_name, dir_fd=parent_fd)
        os.fsync(parent_fd)
        if _read_private_file_at(parent_fd, name) != contents:
            raise MigrationBlocked("private migration snapshot publication failed")
        publication_verified = True
        return linked_new
    finally:
        if temporary_fd >= 0:
            os.close(temporary_fd)
        try:
            os.unlink(temporary_name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        if linked_new and not publication_verified:
            try:
                os.unlink(name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
            os.fsync(parent_fd)


def _read_bounded_regular_fd(
    file_fd: int,
    *,
    maximum_bytes: int,
    description: str,
    require_empty: bool = False,
    require_private_mode: bool = True,
) -> bytes:
    before = os.fstat(file_fd)
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_uid != os.geteuid()
        or (require_private_mode and stat.S_IMODE(before.st_mode) != 0o600)
        or before.st_nlink != 1
        or before.st_size < 0
        or before.st_size > maximum_bytes
        or (require_empty and before.st_size != 0)
    ):
        raise MigrationBlocked(f"{description} is unsafe")
    contents = bytearray()
    offset = 0
    while len(contents) <= maximum_bytes:
        chunk = os.pread(
            file_fd,
            min(64 * 1024, maximum_bytes + 1 - len(contents)),
            offset,
        )
        if not chunk:
            break
        contents.extend(chunk)
        offset += len(chunk)
    after = os.fstat(file_fd)
    if len(contents) > maximum_bytes or (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    ) != (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    ):
        raise MigrationBlocked(f"{description} changed while reading")
    return bytes(contents)


def _create_private_output_at(parent_fd: int, prefix: str) -> tuple[str, int]:
    name = f".{prefix}.{uuid.uuid4().hex}.tmp"
    try:
        file_fd = os.open(
            name,
            os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent_fd,
        )
    except OSError as exc:
        raise MigrationBlocked("cannot create private migration output") from exc
    return name, file_fd


def _read_private_output_at(parent_fd: int, name: str, maximum_bytes: int) -> bytes:
    try:
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    except OSError as exc:
        raise MigrationBlocked("private migration output is missing or unsafe") from exc
    try:
        return _read_bounded_regular_fd(
            file_fd,
            maximum_bytes=maximum_bytes,
            description="private migration output",
        )
    finally:
        os.close(file_fd)


def _publish_private_output_at(
    parent_fd: int,
    temporary_name: str,
    destination_name: str,
    expected: bytes,
) -> None:
    actual = _read_private_output_at(
        parent_fd,
        temporary_name,
        _MAX_LEGACY_QUEUE_OUTPUT_BYTES,
    )
    if actual != expected:
        raise MigrationBlocked("Host queue migration output did not match")
    try:
        os.link(
            temporary_name,
            destination_name,
            src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd,
            follow_symlinks=False,
        )
    except FileExistsError:
        existing = _read_private_output_at(
            parent_fd,
            destination_name,
            _MAX_LEGACY_QUEUE_OUTPUT_BYTES,
        )
        if existing != expected:
            raise MigrationBlocked("Host queue migration output conflicts")
    os.unlink(temporary_name, dir_fd=parent_fd)
    os.fsync(parent_fd)


def _atomic_write_json_at(
    parent_fd: int,
    name: str,
    payload: dict[str, object],
) -> None:
    encoded = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if len(encoded) > _MAX_JOURNAL_BYTES:
        raise MigrationBlocked("migration journal is too large")
    temporary_name = f".{name}.{uuid.uuid4().hex}.tmp"
    temporary_fd = -1
    try:
        temporary_fd = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent_fd,
        )
        _write_all(temporary_fd, encoded)
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = -1
        os.replace(temporary_name, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        if temporary_fd >= 0:
            os.close(temporary_fd)
        try:
            os.unlink(temporary_name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass


def _atomic_write_json(path: Path, payload: dict[str, object]) -> None:
    parent_fd = _open_existing_private_directory(path.parent)
    if parent_fd < 0:
        raise MigrationBlocked("migration journal directory is missing")
    try:
        _atomic_write_json_at(parent_fd, path.name, payload)
    finally:
        os.close(parent_fd)


def _read_journal_at(parent_fd: int, name: str) -> dict[str, object] | None:
    try:
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(file_fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_size > _MAX_JOURNAL_BYTES
        ):
            raise MigrationBlocked("migration journal has unsafe ownership or type")
        encoded = bytearray()
        while len(encoded) <= _MAX_JOURNAL_BYTES:
            chunk = os.read(file_fd, min(64 * 1024, _MAX_JOURNAL_BYTES + 1 - len(encoded)))
            if not chunk:
                break
            encoded.extend(chunk)
        if not encoded or len(encoded) > _MAX_JOURNAL_BYTES:
            raise MigrationBlocked("migration journal is missing or too large")
        payload = json.loads(encoded)
        if (
            not isinstance(payload, dict)
            or payload.get("schemaVersion") != 1
            or not isinstance(payload.get("transactionId"), str)
            or not isinstance(payload.get("phase"), str)
        ):
            raise MigrationBlocked("migration journal is invalid")
        return payload
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MigrationBlocked("migration journal is invalid") from exc
    finally:
        os.close(file_fd)


def _read_journal(path: Path) -> dict[str, object] | None:
    parent_fd = _open_existing_private_directory(path.parent)
    if parent_fd < 0:
        return None
    try:
        return _read_journal_at(parent_fd, path.name)
    finally:
        os.close(parent_fd)


class ApplicationMigration:
    """The sole lock and durable journal authority for application migration."""

    def __init__(
        self,
        paths: MigrationPaths,
        *,
        attempt_fd: int | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self.paths = paths
        self._now = now
        self._provided_attempt_fd = attempt_fd
        self._attempt_fd = -1
        self._durable_root_fd = -1
        self._journal_dir_fd = -1
        self._launch_agents_fd = -1
        self._archive_dir_fd = -1
        self._journal: dict[str, object] | None = None

    def __enter__(self) -> "ApplicationMigration":
        _ensure_private_directory(self.paths.lock_dir)
        if self._provided_attempt_fd is None:
            self._attempt_fd = os.open(
                self.paths.attempt_lock_path,
                os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
                0o600,
            )
        else:
            self._attempt_fd = os.dup(self._provided_attempt_fd)
        info = os.fstat(self._attempt_fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
        ):
            self.close()
            raise MigrationBlocked("migration attempt lock has unsafe ownership or type")
        if self._provided_attempt_fd is None:
            os.fchmod(self._attempt_fd, 0o600)
            try:
                fcntl.flock(self._attempt_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                self.close()
                raise MigrationBlocked("application migration is already in progress") from exc
        _ensure_private_directory(self.paths.durable_root)
        self._durable_root_fd = _open_existing_private_directory(self.paths.durable_root)
        if self._durable_root_fd < 0:
            self.close()
            raise MigrationBlocked("standard application data root is missing")
        _ensure_private_directory(self.paths.journal_dir)
        self._journal_dir_fd = _open_existing_private_directory(self.paths.journal_dir)
        if self._journal_dir_fd < 0:
            self.close()
            raise MigrationBlocked("migration journal directory is missing")
        self._journal = _read_journal_at(self._journal_dir_fd, self.paths.journal_path.name)
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        if self._archive_dir_fd >= 0:
            os.close(self._archive_dir_fd)
            self._archive_dir_fd = -1
        if self._launch_agents_fd >= 0:
            os.close(self._launch_agents_fd)
            self._launch_agents_fd = -1
        if self._journal_dir_fd >= 0:
            os.close(self._journal_dir_fd)
            self._journal_dir_fd = -1
        if self._durable_root_fd >= 0:
            os.close(self._durable_root_fd)
            self._durable_root_fd = -1
        if self._attempt_fd >= 0:
            os.close(self._attempt_fd)
            self._attempt_fd = -1

    def launch_agents_fd(self, path: Path) -> int:
        if self._launch_agents_fd < 0:
            self._launch_agents_fd = _open_existing_private_directory(path)
            if self._launch_agents_fd < 0:
                raise MigrationBlocked("legacy LaunchAgents directory is missing")
        return os.dup(self._launch_agents_fd)

    def require_launch_agents_path(self, path: Path) -> None:
        if self._launch_agents_fd < 0:
            raise MigrationBlocked("legacy LaunchAgents directory is not anchored")
        try:
            observed_fd = _open_existing_private_directory(path)
        except MigrationBlocked as exc:
            raise MigrationBlocked("legacy LaunchAgents directory changed") from exc
        if observed_fd < 0:
            raise MigrationBlocked("legacy LaunchAgents directory changed")
        try:
            expected = os.fstat(self._launch_agents_fd)
            observed = os.fstat(observed_fd)
            if (expected.st_dev, expected.st_ino) != (observed.st_dev, observed.st_ino):
                raise MigrationBlocked("legacy LaunchAgents directory changed")
        finally:
            os.close(observed_fd)

    def archive_dir_fd(self, path: Path, *, create: bool) -> int:
        if self._archive_dir_fd < 0:
            if create:
                _ensure_private_directory(path)
            self._archive_dir_fd = _open_existing_private_directory(path)
            if self._archive_dir_fd < 0:
                return -1
        return os.dup(self._archive_dir_fd)

    def require_archive_path(self, path: Path) -> None:
        if self._archive_dir_fd < 0:
            raise MigrationBlocked("rollback archive is not anchored")
        try:
            observed_fd = _open_existing_private_directory(path)
        except MigrationBlocked as exc:
            raise MigrationBlocked("rollback archive changed") from exc
        if observed_fd < 0:
            raise MigrationBlocked("rollback archive changed")
        try:
            expected = os.fstat(self._archive_dir_fd)
            observed = os.fstat(observed_fd)
            if (expected.st_dev, expected.st_ino) != (observed.st_dev, observed.st_ino):
                raise MigrationBlocked("rollback archive changed")
        finally:
            os.close(observed_fd)

    def _write_journal(self) -> None:
        if self._journal_dir_fd < 0 or self._journal is None:
            raise RuntimeError("migration authority is not active")
        _atomic_write_json_at(
            self._journal_dir_fd,
            self.paths.journal_path.name,
            self._journal,
        )

    def begin(self) -> dict[str, object]:
        if self._attempt_fd < 0:
            raise RuntimeError("migration authority must hold its lock")
        if self._journal is not None:
            raise MigrationBlocked("an application migration journal already exists")
        self._journal = {
            "schemaVersion": 1,
            "transactionId": uuid.uuid4().hex,
            "phase": "preflight",
            "createdAt": self._now().isoformat(),
            "intent": None,
        }
        self._write_journal()
        return dict(self._journal)

    def record_bundle_manifest(self, manifest: dict[str, str]) -> None:
        if self._journal is None or self._journal.get("phase") != "preflight":
            raise MigrationBlocked("application bundle manifest is out of phase")
        if (
            set(manifest) != _APPLICATION_BUNDLE_FILE_NAMES
            or any(re.fullmatch(r"[0-9a-f]{64}", value) is None for value in manifest.values())
        ):
            raise MigrationBlocked("application bundle manifest is invalid")
        self._journal = {**self._journal, "bundleManifest": dict(manifest)}
        self._write_journal()

    def _service_action(self, action: str, **fields: object) -> dict[str, object]:
        assert self._journal is not None
        return {
            "action": action,
            "transactionId": self._journal["transactionId"],
            "nonce": self._journal["serviceNonce"],
            **fields,
        }

    def request_registration(self) -> dict[str, object]:
        if self._journal is None or self._journal.get("phase") != "data_published":
            raise MigrationBlocked("service registration was requested in the wrong phase")
        deadline = self._now() + _APPROVAL_TIMEOUT
        nonce = uuid.uuid4().hex
        self.transition("registration_requested", intent={"action": "register-services"})
        assert self._journal is not None
        self._journal = {
            **self._journal,
            "serviceNonce": nonce,
            "approvalDeadlineAt": deadline.isoformat(),
        }
        self._write_journal()
        return self._service_action(
            "register_services",
            services=list(_BUNDLED_SERVICE_PLISTS),
            deadlineAt=deadline.isoformat(),
        )

    def observe_service_statuses(
        self,
        *,
        transaction_id: object,
        nonce: object,
        statuses: dict[str, str],
    ) -> dict[str, object]:
        if (
            self._journal is None
            or transaction_id != self._journal.get("transactionId")
            or nonce != self._journal.get("serviceNonce")
        ):
            raise MigrationBlocked("stale service observation")
        if self._journal.get("phase") not in {
            "registration_requested",
            "awaiting_approval",
        }:
            raise MigrationBlocked("service observation arrived in the wrong phase")
        if set(statuses) != set(_BUNDLED_SERVICE_PLISTS) or any(
            status not in {"notRegistered", "enabled", "requiresApproval", "notFound"}
            for status in statuses.values()
        ):
            raise MigrationBlocked("invalid service observation")
        if all(status == "enabled" for status in statuses.values()):
            self.transition("services_enabled", intent={"action": "verify-health"})
            return self._service_action("verify_health")
        if any(status == "requiresApproval" for status in statuses.values()) and all(
            status in {"enabled", "requiresApproval"} for status in statuses.values()
        ):
            self.transition("awaiting_approval", intent={"action": "await-approval"})
            assert self._journal is not None
            return self._service_action(
                "await_approval",
                deadlineAt=self._journal["approvalDeadlineAt"],
            )
        return self.request_rollback("registration_failed")

    def request_rollback(self, reason: str) -> dict[str, object]:
        if self._journal is None or not isinstance(self._journal.get("serviceNonce"), str):
            raise MigrationBlocked("service rollback has no bound transaction")
        self.transition(
            "rollback_requested",
            intent={"action": "unregister-services", "reason": reason},
        )
        return self._service_action(
            "unregister_services",
            reason=reason,
            services=list(_BUNDLED_SERVICE_PLISTS),
        )

    def resume_pending_registration(self) -> dict[str, object]:
        if self._journal is None or self._journal.get("phase") != "awaiting_approval":
            raise MigrationBlocked("there is no pending service approval")
        try:
            deadline = datetime.fromisoformat(str(self._journal["approvalDeadlineAt"]))
        except (KeyError, ValueError) as exc:
            raise MigrationBlocked("pending approval deadline is invalid") from exc
        if self._now() >= deadline:
            return self.request_rollback("approval_timeout")
        return self._service_action("observe_services")

    def confirm_services_unregistered(
        self,
        *,
        transaction_id: object,
        nonce: object,
        statuses: dict[str, str],
    ) -> dict[str, object]:
        if (
            self._journal is None
            or self._journal.get("phase") != "rollback_requested"
            or transaction_id != self._journal.get("transactionId")
            or nonce != self._journal.get("serviceNonce")
            or set(statuses) != set(_BUNDLED_SERVICE_PLISTS)
        ):
            raise MigrationBlocked("stale service observation")
        if not all(
            status in {"notRegistered", "notFound"} for status in statuses.values()
        ):
            self.transition(
                "rollback_blocked",
                intent={"action": "manual-service-remediation"},
            )
            raise MigrationBlocked("registered services remain; rollback is blocked")
        self.transition("rolling_back", intent={"action": "restore-legacy"})
        return self._service_action("restore_legacy")

    def observe_commit_health(
        self,
        *,
        transaction_id: object,
        nonce: object,
        host: dict[str, object],
        capture: dict[str, object],
    ) -> dict[str, object]:
        if (
            self._journal is None
            or self._journal.get("phase") != "services_enabled"
            or transaction_id != self._journal.get("transactionId")
            or nonce != self._journal.get("serviceNonce")
        ):
            raise MigrationBlocked("stale health observation")
        self.transition("verifying", intent={"action": "verify-runtime-owners"})
        host_pid = host.get("ownerPID")
        capture_pid = capture.get("ownerPID")
        healthy = (
            host.get("running") is True
            and type(host_pid) is int
            and host_pid > 1
            and host.get("port") == 7777
            and capture.get("running") is True
            and type(capture_pid) is int
            and capture_pid > 1
            and capture.get("socketOwned") is True
            and host_pid != capture_pid
        )
        if not healthy:
            return self.request_rollback("commit_health_failed")
        self.transition("committed", intent={"action": "commit-complete"})
        return self._service_action("committed")

    def transition(
        self, phase: str, *, intent: dict[str, object]
    ) -> dict[str, object]:
        if self._attempt_fd < 0 or self._journal is None:
            raise RuntimeError("migration transaction has not begun")
        self._journal = {
            **self._journal,
            "phase": phase,
            "intent": intent,
            "updatedAt": self._now().isoformat(),
        }
        self._write_journal()
        return dict(self._journal)

    def _snapshot_plist_bytes(
        self,
        label: str,
        entry: dict[str, object],
    ) -> bytes | None:
        expected_digest = entry.get("plistSHA256")
        raw = entry.get("plistBytes")
        if raw is not None:
            if not isinstance(raw, str):
                raise MigrationBlocked("legacy plist snapshot is invalid")
            try:
                contents = bytes.fromhex(raw)
            except ValueError as exc:
                raise MigrationBlocked("legacy plist snapshot is invalid") from exc
        else:
            snapshot_path = entry.get("plistSnapshot")
            if snapshot_path is None and expected_digest is None:
                return None
            assert self._journal is not None
            transaction_id = self._journal.get("transactionId")
            expected_path = f"rollback-snapshots/{transaction_id}/{label}.plist"
            if snapshot_path != expected_path:
                raise MigrationBlocked("legacy plist snapshot reference is invalid")
            snapshots_fd = _open_private_child_directory_at(
                self._journal_dir_fd,
                "rollback-snapshots",
                create=False,
            )
            try:
                transaction_fd = _open_private_child_directory_at(
                    snapshots_fd,
                    str(transaction_id),
                    create=False,
                )
                try:
                    contents = _read_private_file_at(
                        transaction_fd,
                        f"{label}.plist",
                    )
                finally:
                    os.close(transaction_fd)
            finally:
                os.close(snapshots_fd)
        if (
            len(contents) > _MAX_PLIST_BYTES
            or not isinstance(expected_digest, str)
            or hashlib.sha256(contents).hexdigest() != expected_digest
        ):
            raise MigrationBlocked("legacy plist snapshot digest does not match")
        return contents

    def record_job_snapshot(
        self, snapshot: dict[str, dict[str, object]]
    ) -> dict[str, dict[str, object]]:
        if set(snapshot) != set(LEGACY_JOB_LABELS):
            raise MigrationBlocked("legacy job snapshot does not match the allowlist")
        assert self._journal is not None
        transaction_id = self._journal.get("transactionId")
        if not isinstance(transaction_id, str) or not re.fullmatch(
            r"[0-9a-f]{32}", transaction_id
        ):
            raise MigrationBlocked("migration transaction identifier is invalid")
        snapshots_fd = _open_private_child_directory_at(
            self._journal_dir_fd,
            "rollback-snapshots",
            create=True,
        )
        sanitized: dict[str, dict[str, object]] = {}
        transaction_fd = -1
        created_links: list[str] = []
        completed = False
        remove_empty_transaction_directory = False
        try:
            transaction_fd = _open_private_child_directory_at(
                snapshots_fd,
                transaction_id,
                create=True,
            )
            for label in LEGACY_JOB_LABELS:
                entry = snapshot[label]
                if not isinstance(entry, dict):
                    raise MigrationBlocked("legacy job snapshot is invalid")
                raw = entry.get("plistBytes")
                digest = entry.get("plistSHA256")
                mode = entry.get("plistMode")
                if raw is None:
                    if digest is not None or mode is not None:
                        raise MigrationBlocked("legacy plist snapshot is invalid")
                    reference = None
                else:
                    if (
                        not isinstance(raw, str)
                        or not isinstance(digest, str)
                        or type(mode) is not int
                        or mode < 0
                        or mode > 0o7777
                    ):
                        raise MigrationBlocked("legacy plist snapshot is invalid")
                    try:
                        contents = bytes.fromhex(raw)
                    except ValueError as exc:
                        raise MigrationBlocked("legacy plist snapshot is invalid") from exc
                    if (
                        len(contents) > _MAX_PLIST_BYTES
                        or hashlib.sha256(contents).hexdigest() != digest
                    ):
                        raise MigrationBlocked("legacy plist snapshot digest does not match")
                    name = f"{label}.plist"
                    if _publish_private_file_at(transaction_fd, name, contents):
                        created_links.append(name)
                    reference = f"rollback-snapshots/{transaction_id}/{label}.plist"
                sanitized[label] = {
                    key: value
                    for key, value in entry.items()
                    if key != "plistBytes"
                }
                sanitized[label]["plistSnapshot"] = reference
            self._journal = {
                **self._journal,
                "phase": "snapshotted",
                "intent": {"action": "snapshot-jobs"},
                "updatedAt": self._now().isoformat(),
                "jobSnapshot": sanitized,
            }
            self._write_journal()
            completed = True
        finally:
            if not completed and len(sanitized) == len(LEGACY_JOB_LABELS):
                try:
                    durable_journal = _read_journal_at(
                        self._journal_dir_fd,
                        self.paths.journal_path.name,
                    )
                except MigrationBlocked:
                    durable_journal = None
                if (
                    isinstance(durable_journal, dict)
                    and durable_journal.get("phase") == "snapshotted"
                    and durable_journal.get("jobSnapshot") == sanitized
                ):
                    self._journal = durable_journal
                    completed = True
            if transaction_fd >= 0 and not completed:
                for name in created_links:
                    try:
                        os.unlink(name, dir_fd=transaction_fd)
                    except FileNotFoundError:
                        pass
                os.fsync(transaction_fd)
                remove_empty_transaction_directory = not os.listdir(transaction_fd)
            if transaction_fd >= 0:
                os.close(transaction_fd)
            if remove_empty_transaction_directory:
                try:
                    os.rmdir(transaction_id, dir_fd=snapshots_fd)
                except FileNotFoundError:
                    pass
                os.fsync(snapshots_fd)
            os.close(snapshots_fd)
        return sanitized

    def quiesce_legacy_jobs(
        self,
        snapshot: dict[str, dict[str, object]],
        *,
        launch_agents_dir: Path,
        archive_dir: Path,
        launchctl: Callable[[list[str]], object] = _run_launchctl,
        final_capture_idle: Callable[[], None] | None = None,
    ) -> None:
        source_fd = self.launch_agents_fd(launch_agents_dir)
        try:
            source_info = os.fstat(source_fd)
            if (source_info.st_dev, source_info.st_ino) != _launch_agents_identity(
                snapshot
            ):
                raise MigrationBlocked("legacy LaunchAgents directory changed")
            self.transition(
                "legacy_quiescing", intent={"action": "bootout-and-archive"}
            )
            uid = os.geteuid()
            capture_label = "com.yulu.audiodaemon"

            def stop_loaded_job(label: str) -> None:
                if not snapshot[label]["loaded"]:
                    return
                result = launchctl(["bootout", f"gui/{uid}/{label}"])
                if getattr(result, "returncode", 1) != 0:
                    raise MigrationBlocked(f"cannot stop legacy job: {label}")
                observed = launchctl(["print", f"gui/{uid}/{label}"])
                if getattr(observed, "returncode", 0) != 113:
                    raise MigrationBlocked(f"legacy job did not stop: {label}")

            for label in LEGACY_JOB_LABELS:
                if label != capture_label:
                    stop_loaded_job(label)
            if snapshot[capture_label]["loaded"]:
                if final_capture_idle is None:
                    raise MigrationBlocked("legacy Capture final idle guard is missing")
                final_capture_idle()
                stop_loaded_job(capture_label)

            archive_fd = self.archive_dir_fd(archive_dir, create=True)
            try:
                archive_info = os.fstat(archive_fd)
                assert self._journal is not None
                self._journal = {
                    **self._journal,
                    "archiveDirectory": {
                        "device": archive_info.st_dev,
                        "inode": archive_info.st_ino,
                    },
                }
                self._write_journal()
                for label in LEGACY_JOB_LABELS:
                    expected = self._snapshot_plist_bytes(label, snapshot[label])
                    if expected is None:
                        continue
                    name = f"{label}.plist"
                    current = _read_plist_at(source_fd, name)
                    if current is None or current[0] != expected:
                        raise MigrationBlocked(
                            f"legacy plist changed after snapshot: {label}"
                        )
                    if _read_plist_at(archive_fd, name) is not None:
                        raise MigrationBlocked(
                            f"rollback archive already contains: {label}"
                        )
                    os.rename(name, name, src_dir_fd=source_fd, dst_dir_fd=archive_fd)
                    os.fsync(source_fd)
                    os.fsync(archive_fd)
            finally:
                os.close(archive_fd)
        finally:
            os.close(source_fd)
        self.transition("legacy_quiesced", intent={"action": "legacy-jobs-quiesced"})

    def publish_standard_data(
        self,
        *,
        legacy_root: Path,
        node_executable: Path,
        server_js: Path,
        run: Callable[..., object] | None = None,
    ) -> None:
        queue_fd = _open_legacy_agent_queue(legacy_root)
        queue_archive_dir_fd = -1
        queue_archive_fd = -1
        queue_audit_fd = -1
        queue_archive_temporary = ""
        queue_audit_temporary = ""
        queue_archive_name = ""
        queue_audit_name = ""
        queue_raw: bytes | None = None
        try:
            preflight = preflight_standard_outputs(legacy_root, self.paths.durable_root)
        except Exception:
            if queue_fd is not None:
                os.close(queue_fd)
            raise
        durable_info = os.fstat(self._durable_root_fd)
        if (
            not stat.S_ISDIR(durable_info.st_mode)
            or durable_info.st_uid != os.geteuid()
        ):
            raise MigrationBlocked("standard application data root is unsafe")
        self.transition("data_publishing", intent={"action": "run-node-data-leaf"})
        assert self._journal is not None
        self._journal = {
            **self._journal,
            "preflightDataManifest": preflight,
            "durableDirectory": {
                "device": durable_info.st_dev,
                "inode": durable_info.st_ino,
            },
        }
        self._write_journal()

        node_digest = _bundled_regular_file_digest(node_executable)
        server_digest = _bundled_regular_file_digest(server_js)
        assert self._journal is not None
        bundle_manifest = self._journal.get("bundleManifest")
        if isinstance(bundle_manifest, dict) and (
            bundle_manifest.get("node") != node_digest
            or bundle_manifest.get("server.js") != server_digest
        ):
            raise MigrationBlocked("installed application evidence changed")
        environment = {
            key: value
            for key, value in os.environ.items()
            if key not in {"NODE_OPTIONS", "NODE_PATH"}
            and not key.startswith("PYTHON")
            and not key.startswith("DYLD_")
        }
        environment.update(
            {
                "YULU_APPLICATION_SUPPORT_DIR": str(self.paths.durable_root),
                "YULU_LEGACY_READ_ONLY_DATA_DIR": str(legacy_root),
                "YULU_MODELS_DIR": str(self.paths.durable_root / "Models"),
                "YULU_CACHE_DIR": str(self.paths.cache_root),
                "YULU_IPC_DIR": str(self.paths.cache_root),
            }
        )
        if queue_fd is not None:
            queue_raw = _read_bounded_regular_fd(
                queue_fd,
                maximum_bytes=_MAX_LEGACY_QUEUE_BYTES,
                description="legacy Agent queue",
                require_private_mode=False,
            )
            queue_stamp = hashlib.sha256(queue_raw).hexdigest()[:16]
            queue_archive_name = f"agent-queue.legacy.{queue_stamp}.json"
            queue_audit_name = f"agent-queue.migration.{queue_stamp}.json"
            queue_archive_dir_fd = _open_private_child_directory_at(
                self._durable_root_fd,
                "legacy-agent-queue",
                create=True,
            )
            queue_archive_temporary, queue_archive_fd = _create_private_output_at(
                queue_archive_dir_fd,
                "agent-queue-archive",
            )
            queue_audit_temporary, queue_audit_fd = _create_private_output_at(
                queue_archive_dir_fd,
                "agent-queue-audit",
            )
            os.fsync(queue_archive_dir_fd)
            environment["YULU_LEGACY_AGENT_QUEUE_FD"] = str(queue_fd)
            environment["YULU_LEGACY_AGENT_QUEUE_ARCHIVE_FD"] = str(queue_archive_fd)
            environment["YULU_LEGACY_AGENT_QUEUE_AUDIT_FD"] = str(queue_audit_fd)
            environment["YULU_LEGACY_AGENT_QUEUE_ARCHIVE_NAME"] = queue_archive_name
            environment["YULU_LEGACY_AGENT_QUEUE_AUDIT_NAME"] = queue_audit_name
            assert self._journal is not None
            environment["YULU_MIGRATION_TIMESTAMP"] = str(self._journal["createdAt"])
        leaf_completed = False
        try:
            try:
                result = (run or _run_node_leaf_bounded)(
                    [str(node_executable), str(server_js), "--prepare-application-data"],
                    cwd=server_js.parent,
                    env=environment,
                    pass_fds=(
                        (queue_fd, queue_archive_fd, queue_audit_fd)
                        if queue_fd is not None
                        else ()
                    ),
                    text=True,
                    capture_output=True,
                    check=False,
                )
            finally:
                self.record_transaction_output_identities(preflight)
            leaf_completed = True
        finally:
            if queue_audit_fd >= 0:
                os.close(queue_audit_fd)
                queue_audit_fd = -1
            if queue_archive_fd >= 0:
                os.close(queue_archive_fd)
                queue_archive_fd = -1
            if queue_fd is not None:
                os.close(queue_fd)
            if not leaf_completed and queue_archive_dir_fd >= 0:
                for temporary_name in (
                    queue_archive_temporary,
                    queue_audit_temporary,
                ):
                    if temporary_name:
                        try:
                            os.unlink(temporary_name, dir_fd=queue_archive_dir_fd)
                        except FileNotFoundError:
                            pass
                os.fsync(queue_archive_dir_fd)
                os.close(queue_archive_dir_fd)
                queue_archive_dir_fd = -1
        if getattr(result, "returncode", 1) != 0:
            if queue_archive_dir_fd >= 0:
                for temporary_name in (
                    queue_archive_temporary,
                    queue_audit_temporary,
                ):
                    if temporary_name:
                        try:
                            os.unlink(temporary_name, dir_fd=queue_archive_dir_fd)
                        except FileNotFoundError:
                            pass
                os.fsync(queue_archive_dir_fd)
                os.close(queue_archive_dir_fd)
                queue_archive_dir_fd = -1
            raise MigrationBlocked("Host data preparation leaf failed")

        if queue_raw is not None:
            try:
                _require_child_directory_identity_at(
                    self._durable_root_fd,
                    "legacy-agent-queue",
                    queue_archive_dir_fd,
                )
                archive_output = _read_private_output_at(
                    queue_archive_dir_fd,
                    queue_archive_temporary,
                    _MAX_LEGACY_QUEUE_OUTPUT_BYTES,
                )
                audit_output = _read_private_output_at(
                    queue_archive_dir_fd,
                    queue_audit_temporary,
                    _MAX_LEGACY_QUEUE_OUTPUT_BYTES,
                )
                if archive_output != queue_raw:
                    raise MigrationBlocked("Host queue archive did not preserve source bytes")
                try:
                    audit = json.loads(audit_output)
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise MigrationBlocked("Host queue migration audit is invalid") from exc
                if (
                    not isinstance(audit, dict)
                    or audit.get("version") != 2
                    or audit.get("sourcePath") != str(legacy_root / "agent-queue.json")
                    or audit.get("archivePath") != queue_archive_name
                    or audit.get("auditPath") != queue_audit_name
                    or type(audit.get("total")) is not int
                    or not isinstance(audit.get("items"), list)
                ):
                    raise MigrationBlocked("Host queue migration audit is invalid")
                _publish_private_output_at(
                    queue_archive_dir_fd,
                    queue_archive_temporary,
                    queue_archive_name,
                    archive_output,
                )
                queue_archive_temporary = ""
                _publish_private_output_at(
                    queue_archive_dir_fd,
                    queue_audit_temporary,
                    queue_audit_name,
                    audit_output,
                )
                queue_audit_temporary = ""
            finally:
                for temporary_name in (
                    queue_archive_temporary,
                    queue_audit_temporary,
                ):
                    if temporary_name:
                        try:
                            os.unlink(temporary_name, dir_fd=queue_archive_dir_fd)
                        except FileNotFoundError:
                            pass
                os.fsync(queue_archive_dir_fd)
                os.close(queue_archive_dir_fd)
                queue_archive_dir_fd = -1

        published = preflight_standard_outputs(legacy_root, self.paths.durable_root)
        for name, entry in published.items():
            before = preflight[name]
            if any(
                before.get(key) != entry.get(key)
                for key in (
                    "sourceSHA256",
                    "sourceEntries",
                    "sourceSchemaSHA256",
                    "sourceContentSHA256",
                )
            ):
                raise MigrationBlocked(f"legacy data changed during publication: {name}")
            source_present = any(
                entry.get(key) is not None
                for key in ("sourceSHA256", "sourceEntries", "sourceSchemaSHA256")
            )
            if source_present and not entry["reused"]:
                raise MigrationBlocked(f"Host data preparation did not publish: {name}")
        self.transition("data_published", intent={"action": "data-verified"})
        assert self._journal is not None
        self._journal = {**self._journal, "dataManifest": published}
        self._write_journal()

    def record_transaction_output_identities(
        self,
        preflight: dict[str, dict[str, object]],
    ) -> None:
        identities: dict[str, dict[str, object]] = {}
        directory_names = {destination for _, destination in _DIRECTORY_OUTPUTS}
        expected_names = {
            destination for _, destination in _ORDINARY_FILE_OUTPUTS
        } | directory_names | {name for name, _ in _SQLITE_OUTPUTS}
        if not expected_names <= set(preflight):
            raise MigrationBlocked("transaction output manifest is incomplete")
        for name in sorted(expected_names):
            entry = preflight.get(name)
            if not isinstance(entry, dict) or type(entry.get("reused")) is not bool:
                raise MigrationBlocked("transaction output manifest is invalid")
            if entry["reused"]:
                continue
            identity = (
                _directory_identity_at(self._durable_root_fd, name)
                if name in directory_names
                else _regular_file_identity_at(self._durable_root_fd, name)
            )
            if identity is not None:
                identities[name] = identity
        for name, _kind in _SQLITE_OUTPUTS:
            entry = preflight.get(name)
            if not isinstance(entry, dict):
                raise MigrationBlocked("transaction output manifest is invalid")
            destination_sidecars = entry.get("destinationSidecars")
            if not isinstance(destination_sidecars, dict):
                raise MigrationBlocked("transaction SQLite sidecar manifest is invalid")
            for suffix in ("-wal", "-shm"):
                if destination_sidecars.get(suffix) is not None:
                    continue
                sidecar_name = f"{name}{suffix}"
                sidecar_identity = _regular_file_identity_at(
                    self._durable_root_fd,
                    sidecar_name,
                )
                if sidecar_identity is not None:
                    identities[sidecar_name] = sidecar_identity
        assert self._journal is not None
        self._journal = {
            **self._journal,
            "transactionOutputIdentities": identities,
        }
        self._write_journal()

    def remove_transaction_outputs(self) -> None:
        assert self._journal is not None
        preflight = self._journal.get("preflightDataManifest")
        durable_identity = self._journal.get("durableDirectory")
        if preflight is None:
            return
        if not isinstance(preflight, dict) or not isinstance(durable_identity, dict):
            raise MigrationBlocked("transaction output manifest is invalid")
        transaction_identities = self._journal.get("transactionOutputIdentities", {})
        if not isinstance(transaction_identities, dict):
            raise MigrationBlocked("transaction output identities are invalid")
        transaction_id = self._journal.get("transactionId")
        if not isinstance(transaction_id, str) or re.fullmatch(
            r"[0-9a-f]{32}", transaction_id
        ) is None:
            raise MigrationBlocked("application migration transaction is invalid")
        root_fd = os.dup(self._durable_root_fd)
        try:
            info = os.fstat(root_fd)
            if (
                info.st_uid != os.geteuid()
                or (info.st_dev, info.st_ino)
                != (durable_identity.get("device"), durable_identity.get("inode"))
            ):
                raise MigrationBlocked("standard application data root changed")
            expected_names = {
                destination for _, destination in _ORDINARY_FILE_OUTPUTS
            } | {destination for _, destination in _DIRECTORY_OUTPUTS} | {
                name for name, _ in _SQLITE_OUTPUTS
            }
            if not expected_names <= set(preflight):
                raise MigrationBlocked("transaction output manifest is incomplete")
            directory_names = {destination for _, destination in _DIRECTORY_OUTPUTS}
            allowed_created_names = set(expected_names) | {
                f"{name}{suffix}"
                for name, _kind in _SQLITE_OUTPUTS
                for suffix in ("-wal", "-shm")
            }
            if not set(transaction_identities) <= allowed_created_names:
                raise MigrationBlocked("transaction output identities are invalid")
            deletions: list[tuple[str, str, dict[str, object]]] = []
            for name in sorted(expected_names):
                entry = preflight[name]
                if not isinstance(entry, dict) or type(entry.get("reused")) is not bool:
                    raise MigrationBlocked("transaction output manifest is invalid")
                if name.endswith(".sqlite"):
                    destination_sidecars = entry.get("destinationSidecars")
                    if not isinstance(destination_sidecars, dict):
                        raise MigrationBlocked(
                            "transaction SQLite sidecar manifest is invalid"
                        )
                    for suffix in ("-wal", "-shm"):
                        sidecar = f"{name}{suffix}"
                        current_sidecar = _regular_file_identity_at(root_fd, sidecar)
                        before_sidecar = destination_sidecars.get(suffix)
                        if before_sidecar is not None:
                            if current_sidecar != before_sidecar:
                                raise MigrationBlocked(
                                    "preexisting SQLite sidecar changed"
                                )
                            continue
                        expected_sidecar = transaction_identities.get(sidecar)
                        if expected_sidecar is None:
                            if current_sidecar is not None:
                                raise MigrationBlocked("transaction output changed")
                            continue
                        if not isinstance(expected_sidecar, dict):
                            raise MigrationBlocked(
                                "transaction output identities are invalid"
                            )
                        if current_sidecar not in (None, expected_sidecar):
                            raise MigrationBlocked("transaction output changed")
                        deletions.append((sidecar, "file", expected_sidecar))
                if entry["reused"]:
                    continue
                expected_identity = transaction_identities.get(name)
                if expected_identity is None:
                    continue
                if not isinstance(expected_identity, dict):
                    raise MigrationBlocked("transaction output identities are invalid")
                current_identity = (
                    _directory_identity_at(root_fd, name)
                    if name in directory_names
                    else _regular_file_identity_at(root_fd, name)
                )
                if current_identity not in (None, expected_identity):
                    raise MigrationBlocked("transaction output changed")
                deletions.append(
                    (
                        name,
                        "directory" if name in directory_names else "file",
                        expected_identity,
                    )
                )

            quarantine_root_fd = _open_private_child_directory_at(
                self._journal_dir_fd,
                "rollback-quarantine",
                create=True,
            )
            try:
                quarantine_fd = _open_private_child_directory_at(
                    quarantine_root_fd,
                    transaction_id,
                    create=True,
                )
                try:
                    for name, kind, expected_identity in deletions:
                        identity_at = (
                            _directory_identity_at
                            if kind == "directory"
                            else _regular_file_identity_at
                        )
                        quarantined_identity = identity_at(quarantine_fd, name)
                        if quarantined_identity is not None:
                            if identity_at(root_fd, name) is not None:
                                raise MigrationBlocked(
                                    "transaction output quarantine conflicts"
                                )
                        else:
                            current_identity = identity_at(root_fd, name)
                            if current_identity is None:
                                continue
                            if current_identity != expected_identity:
                                raise MigrationBlocked("transaction output changed")
                            if not _rename_exclusive_at(
                                root_fd,
                                name,
                                quarantine_fd,
                                name,
                            ):
                                raise MigrationBlocked(
                                    "transaction output quarantine conflicts"
                                )
                            os.fsync(root_fd)
                            os.fsync(quarantine_fd)
                            quarantined_identity = identity_at(quarantine_fd, name)

                        if quarantined_identity != expected_identity:
                            restored = _rename_exclusive_at(
                                quarantine_fd,
                                name,
                                root_fd,
                                name,
                            )
                            if restored:
                                os.fsync(quarantine_fd)
                                os.fsync(root_fd)
                            raise MigrationBlocked("transaction output changed")

                        if kind == "directory":
                            child_fd = os.open(
                                name,
                                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=quarantine_fd,
                            )
                            try:
                                _remove_owned_tree_at(child_fd)
                                os.fsync(child_fd)
                            finally:
                                os.close(child_fd)
                            os.rmdir(name, dir_fd=quarantine_fd)
                        else:
                            os.unlink(name, dir_fd=quarantine_fd)
                        os.fsync(quarantine_fd)
                finally:
                    os.close(quarantine_fd)
            finally:
                os.close(quarantine_root_fd)
        finally:
            os.close(root_fd)

    def rollback_legacy_jobs(
        self,
        snapshot: dict[str, dict[str, object]],
        *,
        launch_agents_dir: Path,
        archive_dir: Path,
        launchctl: Callable[[list[str]], object] = _run_launchctl,
    ) -> None:
        assert self._journal is not None
        if self._journal.get("phase") != "rolling_back":
            self.transition("rollback_requested", intent={"action": "restore-legacy-jobs"})
            self.transition("rolling_back", intent={"action": "restore-plists"})
        destination_fd = self.launch_agents_fd(launch_agents_dir)
        source_fd = -1
        try:
            self.require_launch_agents_path(launch_agents_dir)
            source_fd = self.archive_dir_fd(archive_dir, create=False)
            if source_fd >= 0:
                self.require_archive_path(archive_dir)
            expected_archive = self._journal.get("archiveDirectory")
            if source_fd >= 0:
                source_info = os.fstat(source_fd)
                if isinstance(expected_archive, dict):
                    if (
                        source_info.st_dev,
                        source_info.st_ino,
                    ) != (
                        expected_archive.get("device"),
                        expected_archive.get("inode"),
                    ):
                        raise MigrationBlocked("rollback archive changed")
                elif any(
                    _read_plist_at(source_fd, f"{label}.plist") is not None
                    for label in LEGACY_JOB_LABELS
                ):
                    raise MigrationBlocked("rollback archive is not transaction-bound")
            destination_info = os.fstat(destination_fd)
            if (
                destination_info.st_dev,
                destination_info.st_ino,
            ) != _launch_agents_identity(snapshot):
                raise MigrationBlocked("legacy LaunchAgents directory changed")
            for label in LEGACY_JOB_LABELS:
                expected = self._snapshot_plist_bytes(label, snapshot[label])
                if expected is None:
                    continue
                name = f"{label}.plist"
                archived = _read_plist_at(source_fd, name) if source_fd >= 0 else None
                destination = _read_plist_at(destination_fd, name)
                if destination is not None:
                    if destination[0] != expected or archived is not None:
                        raise MigrationBlocked(
                            f"legacy plist destination is occupied: {label}"
                        )
                    _restore_plist_mode_at(
                        destination_fd, name, snapshot[label].get("plistMode")
                    )
                    continue
                if archived is None or archived[0] != expected:
                    raise MigrationBlocked(f"rollback archive changed: {label}")
                _restore_plist_mode_at(
                    source_fd, name, snapshot[label].get("plistMode")
                )
                os.rename(name, name, src_dir_fd=source_fd, dst_dir_fd=destination_fd)
                os.fsync(source_fd)
                os.fsync(destination_fd)
        finally:
            os.close(destination_fd)
            if source_fd >= 0:
                os.close(source_fd)

        self.transition("rolling_back", intent={"action": "restore-launchd-state"})
        uid = os.geteuid()
        for label in LEGACY_JOB_LABELS:
            enable_action = "disable" if snapshot[label]["disabled"] else "enable"
            result = launchctl([enable_action, f"gui/{uid}/{label}"])
            if getattr(result, "returncode", 1) != 0:
                raise MigrationBlocked(f"cannot restore launchd disabled state: {label}")
            observed = launchctl(["print", f"gui/{uid}/{label}"])
            loaded = getattr(observed, "returncode", 1) == 0
            if snapshot[label]["loaded"] and not loaded:
                plist_path = launch_agents_dir / f"{label}.plist"
                result = launchctl(["bootstrap", f"gui/{uid}", str(plist_path)])
                if getattr(result, "returncode", 1) != 0:
                    raise MigrationBlocked(f"cannot restore legacy job: {label}")
            elif not snapshot[label]["loaded"] and loaded:
                result = launchctl(["bootout", f"gui/{uid}/{label}"])
                if getattr(result, "returncode", 1) != 0:
                    raise MigrationBlocked(f"cannot restore unloaded legacy job: {label}")
        disabled_result = launchctl(["print-disabled", f"gui/{uid}"])
        if getattr(disabled_result, "returncode", 1) != 0:
            raise MigrationBlocked("cannot verify restored launchd disabled state")
        restored_disabled = _disabled_labels(
            str(getattr(disabled_result, "stdout", ""))
        )
        for label in LEGACY_JOB_LABELS:
            if (label in restored_disabled) is not bool(snapshot[label]["disabled"]):
                raise MigrationBlocked(
                    f"legacy launchd disabled state was not restored: {label}"
                )
            observed = launchctl(["print", f"gui/{uid}/{label}"])
            returncode = int(getattr(observed, "returncode", 1))
            expected_returncode = 0 if snapshot[label]["loaded"] else 113
            if returncode != expected_returncode:
                raise MigrationBlocked(f"legacy job state was not restored: {label}")
        self.remove_transaction_outputs()
        self.transition("rolled_back", intent={"action": "rollback-complete"})


def _peer_identity(client: socket.socket) -> tuple[int, int]:
    raw_pid = client.getsockopt(_SOL_LOCAL, _LOCAL_PEERPID, struct.calcsize("i"))
    peer_pid = struct.unpack("i", raw_pid)[0]
    peer_uid = ctypes.c_uint()
    peer_gid = ctypes.c_uint()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.getpeereid(client.fileno(), ctypes.byref(peer_uid), ctypes.byref(peer_gid)) != 0:
        raise OSError(ctypes.get_errno(), "getpeereid failed")
    return peer_pid, int(peer_uid.value)


def _process_executable(pid: int) -> Path:
    buffer = ctypes.create_string_buffer(_MAX_PATH_BYTES)
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    count = libproc.proc_pidpath(pid, buffer, len(buffer))
    if count <= 0:
        raise OSError(ctypes.get_errno(), "proc_pidpath failed")
    return Path(os.fsdecode(buffer.value)).resolve()


def _process_generation(pid: int) -> tuple[int, int]:
    info = _ProcBSDInfo()
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    count = libproc.proc_pidinfo(
        pid,
        _PROC_PIDTBSDINFO,
        0,
        ctypes.byref(info),
        ctypes.sizeof(info),
    )
    if count != ctypes.sizeof(info):
        raise OSError(ctypes.get_errno(), "proc_pidinfo failed")
    return int(info.pbi_start_tvsec), int(info.pbi_start_tvusec)


def _read_status(client: socket.socket) -> dict[str, object]:
    client.sendall(b'{"action":"status"}')
    client.shutdown(socket.SHUT_WR)
    response = bytearray()
    while len(response) <= _MAX_STATUS_BYTES:
        chunk = client.recv(min(4096, _MAX_STATUS_BYTES + 1 - len(response)))
        if not chunk:
            break
        response.extend(chunk)
    if not response or len(response) > _MAX_STATUS_BYTES:
        raise OSError("legacy Capture status response is missing or too large")
    payload = json.loads(response)
    if not isinstance(payload, dict) or type(payload.get("recording")) is not bool:
        raise OSError("legacy Capture returned an invalid status response")
    return payload


def assert_legacy_capture_idle(
    snapshot: CaptureJobSnapshot,
    socket_path: Path,
) -> None:
    """Refuse unless a loaded legacy Capture can prove that it is idle."""
    if not snapshot.loaded:
        return

    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(2)
        client.connect(str(socket_path))
        peer_pid, peer_uid = _peer_identity(client)
        generation_before = _process_generation(peer_pid)
        if (
            peer_pid <= 1
            or peer_uid != os.geteuid()
            or _process_executable(peer_pid) != snapshot.executable.resolve()
        ):
            raise MigrationBlocked("legacy Capture identity does not match its job snapshot")
        status = _read_status(client)
        if _process_generation(peer_pid) != generation_before:
            raise MigrationBlocked("legacy Capture identity changed during status check")
        if status["recording"]:
            raise MigrationBlocked("legacy Capture recording is active")
    except OSError as exc:
        raise MigrationBlocked(
            "cannot prove legacy Capture is idle while its job is loaded"
        ) from exc
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
