#!/usr/bin/env python3
"""Transactional authority for replacing the installed Yulu application."""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import re
import stat
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, TextIO

from application_migration import (
    ApplicationMigration,
    MigrationBlocked,
    MigrationPaths,
    _atomic_write_json_at,
    _ensure_private_directory,
    _open_existing_private_directory,
    _process_generation,
    _read_journal_at,
    _remove_owned_tree_at,
    _rename_exclusive_at,
    checkpoint_sqlite_database,
    open_existing_trusted_install_directory,
    swap_entries_at,
)


_PRODUCT_IDENTIFIER = "com.yulu.app"
_PRODUCT_TEAM_IDENTIFIER = "WMU9678ZQL"
_BUNDLED_SERVICES = {
    "com.yulu.ui.plist",
    "com.yulu.audiodaemon.plist",
}
_HOST_IPC_VERSION = 1
_CAPTURE_IPC_VERSION = 1
_HOST_DATABASE_SCHEMA_VERSION = 1
_HOST_DATABASE_MINIMUM_READABLE_VERSION = 1
_QUIESCENCE_PROOFS = {
    "host": "tcp-refused-owner-record-absent",
    "capture": "unix-missing-or-refused",
}
_APPLICATION_EXECUTABLE = "/Applications/Yulu.app/Contents/MacOS/yulu_app"
_HOST_EXECUTABLE = "/Applications/Yulu.app/Contents/Resources/runtime/bin/node"
_CAPTURE_EXECUTABLE = (
    "/Applications/Yulu.app/Contents/Helpers/"
    "YuluCapture.app/Contents/MacOS/audio_daemon"
)
_RELEASE_IDENTITY_PATTERN = re.compile(
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.([1-9][0-9]*))?"
)


def _parse_release_identity(value: str) -> tuple[tuple[int, int, int], int | None] | None:
    match = _RELEASE_IDENTITY_PATTERN.fullmatch(value)
    if match is None:
        return None
    return (
        (int(match.group(1)), int(match.group(2)), int(match.group(3))),
        int(match.group(4)) if match.group(4) is not None else None,
    )


def _release_identity_is_forward(source: str, target: str) -> bool:
    # This runtime gate is intentionally generic. #171 owns proving source-commit
    # equality for a particular RC-to-stable artifact promotion at publication.
    source_identity = _parse_release_identity(source)
    target_identity = _parse_release_identity(target)
    if source_identity is None or target_identity is None:
        return False
    source_base, source_rc = source_identity
    target_base, target_rc = target_identity
    if target_base < source_base:
        return False
    if target_base > source_base:
        return target_rc is None
    if source_rc is None:
        return False
    return target_rc is None or target_rc > source_rc


def _runtime_owners_are_absent(owners: dict[str, object]) -> bool:
    if set(owners) != set(_QUIESCENCE_PROOFS):
        return False
    for kind, proof in _QUIESCENCE_PROOFS.items():
        evidence = owners.get(kind)
        if (
            not isinstance(evidence, dict)
            or set(evidence) != {"state", "proof"}
            or evidence.get("state") != "absent"
            or evidence.get("proof") != proof
        ):
            return False
    return True


def _valid_runtime_identity(
    evidence: object,
    *,
    identifier: str,
    version_key: str,
    version: object,
    build: object,
    executable: str,
) -> bool:
    if not isinstance(evidence, dict):
        return False
    pid = evidence.get("pid")
    generation = evidence.get("generation")
    return (
        evidence.get("identifier") == identifier
        and evidence.get("teamIdentifier") == _PRODUCT_TEAM_IDENTIFIER
        and re.fullmatch(r"[0-9a-f]{40,64}", str(evidence.get("cdHash", "")))
        is not None
        and evidence.get(version_key) == version
        and evidence.get("build" if version_key == "version" else "bundleVersion")
        == build
        and type(pid) is int
        and pid > 1
        and evidence.get("uid") == os.geteuid()
        and isinstance(generation, str)
        and re.fullmatch(r"[1-9][0-9]*:[0-9]+", generation) is not None
        and evidence.get("executable") == executable
    )


def _valid_update_health(
    health: dict[str, object],
    *,
    expected: dict[str, object],
) -> bool:
    application = health.get("application")
    host = health.get("host")
    capture = health.get("capture")
    services = health.get("services")
    if not (
        _valid_runtime_identity(
            application,
            identifier=_PRODUCT_IDENTIFIER,
            version_key="version",
            version=expected.get("version"),
            build=expected.get("build"),
            executable=_APPLICATION_EXECUTABLE,
        )
        and _valid_runtime_identity(
            host,
            identifier="node",
            version_key="productVersion",
            version=expected.get("version"),
            build=expected.get("build"),
            executable=_HOST_EXECUTABLE,
        )
        and _valid_runtime_identity(
            capture,
            identifier="com.yulu.audiodaemon",
            version_key="productVersion",
            version=expected.get("version"),
            build=expected.get("build"),
            executable=_CAPTURE_EXECUTABLE,
        )
        and isinstance(application, dict)
        and isinstance(host, dict)
        and isinstance(capture, dict)
    ):
        return False
    host_pid = host.get("pid")
    capture_pid = capture.get("pid")
    database = host.get("database")
    host_nonce = host.get("hostNonce")
    try:
        nonce_is_valid = (
            isinstance(host_nonce, str)
            and str(uuid.UUID(host_nonce)) == host_nonce.lower()
        )
    except ValueError:
        nonce_is_valid = False
    return (
        host.get("hostIPCVersion") == _HOST_IPC_VERSION
        and host.get("serviceOwner") == "com.yulu.ui"
        and host.get("portOwnerPID") == host_pid
        and nonce_is_valid
        and re.fullmatch(
            r"[A-Za-z0-9-]{16,}", str(host.get("instanceLockToken", ""))
        )
        is not None
        and isinstance(database, dict)
        and database.get("status") == "ok"
        and database.get("quickCheck") == "ok"
        and database.get("schemaVersion") == _HOST_DATABASE_SCHEMA_VERSION
        and database.get("minimumReadableVersion")
        == _HOST_DATABASE_MINIMUM_READABLE_VERSION
        and capture.get("captureIPCVersion") == _CAPTURE_IPC_VERSION
        and capture.get("serviceOwner") == "com.yulu.audiodaemon"
        and capture.get("socketOwnerPID") == capture_pid
        and isinstance(services, dict)
        and set(services) == _BUNDLED_SERVICES
        and all(status == "enabled" for status in services.values())
    )


def copy_application_bundle(
    source: Path,
    destination: Path,
    *,
    trusted_install_destination: bool = False,
) -> None:
    """Copy a whole App with macOS metadata and framework symlinks intact."""
    if not source.is_absolute() or not destination.is_absolute():
        raise MigrationBlocked("application snapshot paths must be absolute")
    try:
        source_info = source.lstat()
    except OSError as exc:
        raise MigrationBlocked("previous application is missing") from exc
    if (
        not stat.S_ISDIR(source_info.st_mode)
        or source_info.st_uid not in {0, os.geteuid()}
        or source_info.st_mode & 0o022
    ):
        raise MigrationBlocked("previous application path is unsafe")
    if destination.exists() or destination.is_symlink():
        raise MigrationBlocked("previous application snapshot already exists")
    parent_fd = (
        open_existing_trusted_install_directory(destination.parent)
        if trusted_install_destination
        else _open_existing_private_directory(destination.parent)
    )
    if parent_fd < 0:
        raise MigrationBlocked("application snapshot directory is missing")
    try:
        result = subprocess.run(
            [
                "/usr/bin/ditto",
                "--rsrc",
                "--extattr",
                "--qtn",
                "--acl",
                "--preserveHFSCompression",
                "--clone",
                str(source),
                str(destination),
            ],
            env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        if result.returncode != 0:
            raise MigrationBlocked("cannot preserve previous whole application")
        try:
            destination_info = destination.lstat()
        except OSError as exc:
            raise MigrationBlocked("previous application snapshot is missing") from exc
        if not stat.S_ISDIR(destination_info.st_mode):
            raise MigrationBlocked("previous application snapshot is unsafe")
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def wait_for_process_exit(
    pid: int,
    generation: tuple[int, int],
    *,
    timeout: float = 60.0,
) -> None:
    if pid <= 1 or generation[0] <= 0 or generation[1] < 0:
        raise MigrationBlocked("rollback parent identity is invalid")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            current = _process_generation(pid)
        except OSError:
            return
        if current != generation:
            return
        time.sleep(0.1)
    raise MigrationBlocked("new application did not exit for rollback")


def _relaunch_application(application: Path) -> None:
    try:
        subprocess.Popen(
            ["/usr/bin/open", str(application)],
            env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as exc:
        raise MigrationBlocked("cannot relaunch previous application") from exc


def restore_previous_application(
    *,
    installed_application: Path,
    previous_application: Path,
    transaction_id: str,
    expected_identity: dict[str, object],
    expected_target_identity: dict[str, object],
    parent_pid: int,
    parent_generation: tuple[int, int],
    wait_for_exit: Callable[[int, tuple[int, int]], None] = wait_for_process_exit,
    verify_application: Callable[[Path], dict[str, object]] | None = None,
    relaunch: Callable[[Path], None] = _relaunch_application,
) -> Path:
    """Restore a verified whole App after the failed new App has exited."""
    if re.fullmatch(r"[0-9a-f]{32}", transaction_id) is None:
        raise MigrationBlocked("rollback transaction identifier is invalid")
    wait_for_exit(parent_pid, parent_generation)
    verifier = verify_application or verify_application_bundle
    if verifier(previous_application) != expected_identity:
        raise MigrationBlocked("previous application changed or is invalid")
    if installed_application.name != "Yulu.app":
        raise MigrationBlocked("installed application path is invalid")
    parent_fd = open_existing_trusted_install_directory(installed_application.parent)
    if parent_fd < 0:
        raise MigrationBlocked("application install directory is missing")
    staging_name = f".Yulu.rollback.{transaction_id}.app"
    failed_name = f".Yulu.failed.{transaction_id}.app"
    staging_path = installed_application.parent / staging_name
    failed_path = installed_application.parent / failed_name
    swapped_name: str | None = None
    try:
        staging_exists = False
        failed_exists = False
        for name in (installed_application.name, staging_name, failed_name):
            try:
                info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                if name == installed_application.name:
                    raise MigrationBlocked("installed application is missing")
                continue
            if not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, os.geteuid()}:
                raise MigrationBlocked("rollback install destination is occupied or unsafe")
            staging_exists = staging_exists or name == staging_name
            failed_exists = failed_exists or name == failed_name
        def verified_identity(name: str, path: Path) -> dict[str, object]:
            try:
                before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except OSError as exc:
                raise MigrationBlocked("rollback application entry is unavailable") from exc
            if not stat.S_ISDIR(before.st_mode) or before.st_uid not in {0, os.geteuid()}:
                raise MigrationBlocked("rollback application entry is unsafe")
            identity = verifier(path)
            try:
                after = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except OSError as exc:
                raise MigrationBlocked("rollback application entry changed") from exc
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                raise MigrationBlocked("rollback application entry changed")
            return identity

        installed_identity = verified_identity(
            installed_application.name, installed_application
        )
        installed_is_previous = installed_identity == expected_identity
        installed_is_target = installed_identity == expected_target_identity
        if failed_exists:
            failed_identity = verified_identity(failed_name, failed_path)
            if (
                staging_exists
                or not installed_is_previous
                or failed_identity != expected_target_identity
            ):
                raise MigrationBlocked("rollback recovery state is inconsistent")
            return failed_path
        if staging_exists and installed_is_previous:
            if verified_identity(staging_name, staging_path) != expected_target_identity:
                raise MigrationBlocked("failed target application changed or is invalid")
            if not _rename_exclusive_at(parent_fd, staging_name, parent_fd, failed_name):
                raise MigrationBlocked("failed application quarantine is occupied")
            os.fsync(parent_fd)
            if verifier(installed_application) != expected_identity:
                raise MigrationBlocked("restored previous application changed or is invalid")
            relaunch(installed_application)
            return failed_path
        if staging_exists:
            if not installed_is_target:
                raise MigrationBlocked("failed target application changed or is invalid")
            if verified_identity(staging_name, staging_path) != expected_identity:
                raise MigrationBlocked("rollback recovery staging is inconsistent")
        else:
            if installed_is_previous:
                raise MigrationBlocked("rollback recovery state is inconsistent")
            if not installed_is_target:
                raise MigrationBlocked("failed target application changed or is invalid")
            copy_application_bundle(
                previous_application,
                staging_path,
                trusted_install_destination=True,
            )
            if verifier(staging_path) != expected_identity:
                raise MigrationBlocked("staged previous application changed or is invalid")
        swap_entries_at(parent_fd, installed_application.name, staging_name)
        swapped_name = staging_name
        if verified_identity(staging_name, staging_path) != expected_target_identity:
            raise MigrationBlocked("failed target application changed or is invalid")
        if not _rename_exclusive_at(parent_fd, staging_name, parent_fd, failed_name):
            raise MigrationBlocked("failed application quarantine is occupied")
        swapped_name = failed_name
        os.fsync(parent_fd)
        if verifier(installed_application) != expected_identity:
            raise MigrationBlocked("restored previous application changed or is invalid")
        swapped_name = None
        relaunch(installed_application)
        return failed_path
    except Exception:
        if swapped_name is not None:
            try:
                swap_entries_at(parent_fd, installed_application.name, swapped_name)
            except MigrationBlocked:
                pass
        raise
    finally:
        os.close(parent_fd)


def verify_application_bundle(application_path: Path) -> dict[str, object]:
    """Verify the static code seal and return rollback-bound App identity."""
    result = subprocess.run(
        [
            "/usr/bin/codesign",
            "--verify",
            "--strict",
            "--deep",
            "--all-architectures",
            "--verbose=4",
            str(application_path),
        ],
        env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if result.returncode != 0:
        raise MigrationBlocked("previous application code signature is invalid")
    display = subprocess.run(
        [
            "/usr/bin/codesign",
            "--display",
            "--verbose=4",
            str(application_path),
        ],
        env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if display.returncode != 0:
        raise MigrationBlocked("previous application identity is unavailable")
    fields: dict[str, str] = {}
    for line in display.stderr.splitlines():
        key, separator, value = line.partition("=")
        if separator and key in {"Identifier", "TeamIdentifier", "CDHash"}:
            fields[key] = value.strip()
    try:
        with (application_path / "Contents/Info.plist").open("rb") as handle:
            info = plistlib.load(handle)
    except (OSError, plistlib.InvalidFileException) as exc:
        raise MigrationBlocked("previous application Info.plist is invalid") from exc
    identity: dict[str, object] = {
        "identifier": fields.get("Identifier"),
        "teamIdentifier": fields.get("TeamIdentifier"),
        "cdHash": fields.get("CDHash", "").lower(),
        "version": info.get("YuluReleaseVersion"),
        "build": info.get("CFBundleVersion"),
    }
    if (
        identity["identifier"] != _PRODUCT_IDENTIFIER
        or identity["teamIdentifier"] != _PRODUCT_TEAM_IDENTIFIER
        or re.fullmatch(r"[0-9a-f]{40,64}", str(identity["cdHash"])) is None
        or re.fullmatch(
            r"[0-9]+(?:[.][0-9]+){2}(?:-[0-9A-Za-z]+(?:[.][0-9A-Za-z]+)*)?",
            str(identity["version"]),
        )
        is None
        or re.fullmatch(r"[1-9][0-9]*", str(identity["build"])) is None
    ):
        raise MigrationBlocked("previous application identity is invalid")
    return identity


@dataclass(frozen=True)
class ApplicationUpdatePaths:
    durable_root: Path
    cache_root: Path

    @property
    def journal_dir(self) -> Path:
        return self.durable_root / "application-update"

    @property
    def journal_path(self) -> Path:
        return self.journal_dir / "journal.json"

    @property
    def rollback_dir(self) -> Path:
        return self.journal_dir / "rollback"

    @property
    def previous_app_path(self) -> Path:
        return self.rollback_dir / "Yulu.app"

    @property
    def checkpoint_dir(self) -> Path:
        return self.journal_dir / "checkpoint"

    @property
    def migration_paths(self) -> MigrationPaths:
        return MigrationPaths(
            durable_root=self.durable_root,
            cache_root=self.cache_root,
        )

    @property
    def lock_dir(self) -> Path:
        return self.migration_paths.lock_dir

    @property
    def attempt_lock_path(self) -> Path:
        return self.migration_paths.attempt_lock_path


class ApplicationUpdate:
    """Own one update journal while holding Application Migration's exact lock."""

    def __init__(
        self,
        paths: ApplicationUpdatePaths,
        *,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self.paths = paths
        self._now = now
        self._migration_authority: ApplicationMigration | None = None
        self._journal_dir_fd = -1
        self._journal: dict[str, object] | None = None

    def __enter__(self) -> "ApplicationUpdate":
        migration_authority = ApplicationMigration(self.paths.migration_paths)
        migration_authority.__enter__()
        self._migration_authority = migration_authority
        try:
            self._journal_dir_fd = _open_existing_private_directory(
                self.paths.journal_dir
            )
            if self._journal_dir_fd >= 0:
                self._journal = _read_journal_at(
                    self._journal_dir_fd, self.paths.journal_path.name
                )
            return self
        except Exception:
            self.close()
            raise

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        if self._journal_dir_fd >= 0:
            os.close(self._journal_dir_fd)
            self._journal_dir_fd = -1
        if self._migration_authority is not None:
            self._migration_authority.close()
            self._migration_authority = None

    def _write_journal(self) -> None:
        if self._journal is None:
            raise RuntimeError("application update authority is not active")
        if self._journal_dir_fd < 0:
            _ensure_private_directory(self.paths.journal_dir)
            self._journal_dir_fd = _open_existing_private_directory(
                self.paths.journal_dir
            )
        if self._journal_dir_fd < 0:
            raise MigrationBlocked("application update journal directory is missing")
        _atomic_write_json_at(
            self._journal_dir_fd,
            self.paths.journal_path.name,
            self._journal,
        )

    def retire_terminal_transaction(self) -> None:
        if self._journal_dir_fd < 0 or self._journal is None:
            raise RuntimeError("application update authority is not active")
        phase = self._journal.get("phase")
        if phase not in {"committed", "update_aborted", "rolled_back"}:
            raise MigrationBlocked("active application update cannot be retired")
        transaction_id = str(self._journal.get("transactionId", ""))
        if re.fullmatch(r"[0-9a-f]{32}", transaction_id) is None:
            raise MigrationBlocked("terminal application update identity is invalid")
        archive_name = f"journal.{transaction_id}.{phase}.json"
        if not _rename_exclusive_at(
            self._journal_dir_fd,
            self.paths.journal_path.name,
            self._journal_dir_fd,
            archive_name,
        ):
            raise MigrationBlocked("application update journal archive is occupied")
        for path in (self.paths.rollback_dir, self.paths.checkpoint_dir):
            directory_fd = _open_existing_private_directory(path)
            if directory_fd < 0:
                continue
            try:
                _remove_owned_tree_at(directory_fd)
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            os.rmdir(path.name, dir_fd=self._journal_dir_fd)
        os.fsync(self._journal_dir_fd)
        self._journal = None

    def begin(
        self,
        *,
        from_version: str,
        from_build: str,
        to_version: str,
        to_build: str,
    ) -> dict[str, object]:
        if self._migration_authority is None:
            raise RuntimeError("application update authority must hold its lock")
        if self._journal is not None:
            raise MigrationBlocked("an application update journal already exists")
        if not _release_identity_is_forward(from_version, to_version):
            raise MigrationBlocked("application update release identity is not monotonic")
        if (
            re.fullmatch(r"[1-9][0-9]*", from_build) is None
            or re.fullmatch(r"[1-9][0-9]*", to_build) is None
            or int(to_build) <= int(from_build)
        ):
            raise MigrationBlocked("application update build is not monotonic")
        self._journal = {
            "schemaVersion": 1,
            "transactionId": uuid.uuid4().hex,
            "nonce": uuid.uuid4().hex,
            "phase": "candidate_bound",
            "createdAt": self._now().isoformat(),
            "from": {"version": from_version, "build": from_build},
            "to": {"version": to_version, "build": to_build},
            "intent": {"action": "observe-recording"},
        }
        self._write_journal()
        return dict(self._journal)

    def _require_binding(self, transaction_id: str, nonce: str) -> None:
        if self._journal is None:
            raise MigrationBlocked("application update journal is missing")
        if (
            self._journal.get("transactionId") != transaction_id
            or self._journal.get("nonce") != nonce
        ):
            raise MigrationBlocked("stale application update observation")

    def observe_recording(
        self,
        *,
        transaction_id: str,
        nonce: str,
        recording: bool | None,
    ) -> dict[str, object]:
        self._require_binding(transaction_id, nonce)
        assert self._journal is not None
        if self._journal.get("phase") not in {
            "candidate_bound",
            "deferred_recording",
        }:
            raise MigrationBlocked("recording was observed in the wrong update phase")
        if recording is not False:
            reason = "recording-active" if recording is True else "recording-unknown"
            self._journal = {
                **self._journal,
                "phase": "deferred_recording",
                "intent": {"action": "observe-recording", "reason": reason},
            }
            self._write_journal()
            return {
                "action": "defer_installation",
                "reason": reason,
                "transactionId": transaction_id,
                "nonce": nonce,
            }
        self._journal = {
            **self._journal,
            "phase": "preparing",
            "intent": {"action": "preserve-previous-application"},
        }
        self._write_journal()
        return {
            "action": "preserve_previous_application",
            "transactionId": transaction_id,
            "nonce": nonce,
        }

    def preserve_previous_application(
        self,
        *,
        transaction_id: str,
        nonce: str,
        application_path: Path,
        copy_application: Callable[[Path, Path], None] = copy_application_bundle,
        verify_application: Callable[[Path], dict[str, object]] = verify_application_bundle,
    ) -> dict[str, object]:
        self._require_binding(transaction_id, nonce)
        assert self._journal is not None
        if self._journal.get("phase") != "preparing":
            raise MigrationBlocked("previous application was preserved out of phase")
        _ensure_private_directory(self.paths.rollback_dir)
        copy_application(application_path, self.paths.previous_app_path)
        identity = verify_application(self.paths.previous_app_path)
        expected = self._journal.get("from")
        if (
            not isinstance(expected, dict)
            or identity.get("identifier") != _PRODUCT_IDENTIFIER
            or identity.get("teamIdentifier") != _PRODUCT_TEAM_IDENTIFIER
            or identity.get("version") != expected.get("version")
            or identity.get("build") != expected.get("build")
            or re.fullmatch(r"[0-9a-f]{40,64}", str(identity.get("cdHash", "")))
            is None
        ):
            raise MigrationBlocked("previous application does not match the update")
        self._journal = {
            **self._journal,
            "phase": "previous_app_preserved",
            "previousApplication": dict(identity),
            "intent": {"action": "unregister-services"},
        }
        self._write_journal()
        return {
            "action": "unregister_services",
            "services": sorted(_BUNDLED_SERVICES),
            "transactionId": transaction_id,
            "nonce": nonce,
        }

    def observe_services_quiesced(
        self,
        *,
        transaction_id: str,
        nonce: str,
        statuses: dict[str, str],
        owners: dict[str, object],
    ) -> dict[str, object]:
        self._require_binding(transaction_id, nonce)
        assert self._journal is not None
        if self._journal.get("phase") != "previous_app_preserved":
            raise MigrationBlocked("services were observed in the wrong update phase")
        if set(statuses) != _BUNDLED_SERVICES or any(
            status != "notRegistered" for status in statuses.values()
        ):
            raise MigrationBlocked("application services are not quiesced")
        if not _runtime_owners_are_absent(owners):
            raise MigrationBlocked("application runtime owners are not quiesced")
        self._journal = {
            **self._journal,
            "phase": "services_quiesced",
            "serviceStatuses": dict(statuses),
            "intent": {"action": "checkpoint-data"},
        }
        self._write_journal()
        return {
            "action": "checkpoint_data",
            "transactionId": transaction_id,
            "nonce": nonce,
        }

    def checkpoint_databases(
        self,
        *,
        transaction_id: str,
        nonce: str,
        databases: dict[str, Path],
    ) -> dict[str, object]:
        self._require_binding(transaction_id, nonce)
        assert self._journal is not None
        if self._journal.get("phase") != "services_quiesced":
            raise MigrationBlocked("services are not quiesced before data checkpoint")
        if not databases or not set(databases) <= {"host", "prompts", "vocab", "search"}:
            raise MigrationBlocked("application database checkpoint set is invalid")
        _ensure_private_directory(self.paths.checkpoint_dir)
        identities: dict[str, dict[str, str]] = {}
        for kind in sorted(databases):
            source = databases[kind]
            try:
                source.relative_to(self.paths.durable_root)
            except ValueError as exc:
                raise MigrationBlocked("application database is outside durable data") from exc
            destination = self.paths.checkpoint_dir / f"{kind}.sqlite"
            identities[kind] = checkpoint_sqlite_database(source, destination, kind)
        self._journal = {
            **self._journal,
            "phase": "install_authorized",
            "dataCheckpoint": identities,
            "intent": {"action": "install-update"},
        }
        self._write_journal()
        target = self._journal["to"]
        assert isinstance(target, dict)
        return {
            "action": "install_update",
            "target": dict(target),
            "transactionId": transaction_id,
            "nonce": nonce,
        }

    def mark_installing(
        self,
        *,
        transaction_id: str,
        nonce: str,
    ) -> dict[str, object]:
        self._require_binding(transaction_id, nonce)
        assert self._journal is not None
        if self._journal.get("phase") != "install_authorized":
            raise MigrationBlocked("application install was invoked before authorization")
        self._journal = {
            **self._journal,
            "phase": "installing",
            "intent": {"action": "invoke-install-handler"},
        }
        self._write_journal()
        return {
            "action": "invoke_install_handler",
            "transactionId": transaction_id,
            "nonce": nonce,
        }

    def resume(
        self,
        *,
        current_version: str,
        current_build: str,
        verify_application: Callable[[Path], dict[str, object]] = verify_application_bundle,
    ) -> dict[str, object]:
        if self._journal is None:
            return {"action": "idle"}
        transaction_id = str(self._journal["transactionId"])
        nonce = str(self._journal["nonce"])
        phase = self._journal.get("phase")
        current = {"version": current_version, "build": current_build}
        previous = self._journal.get("from")
        target = self._journal.get("to")
        if phase in {
            "candidate_bound",
            "deferred_recording",
            "preparing",
            "previous_app_preserved",
            "services_quiesced",
            "install_authorized",
        }:
            if current == target:
                if not isinstance(self._journal.get("dataCheckpoint"), dict):
                    self._journal = {
                        **self._journal,
                        "phase": "pre_handler_identity_blocked",
                        "failure": "target-started-before-data-checkpoint",
                        "intent": {"action": "none"},
                    }
                    self._write_journal()
                    return {
                        "action": "blocked",
                        "failure": "target-started-before-data-checkpoint",
                    }
                self._journal = {
                    **self._journal,
                    "phase": "target_launched",
                    "intent": {"action": "register-services"},
                }
                self._write_journal()
                return {
                    "action": "register_services",
                    "services": sorted(_BUNDLED_SERVICES),
                    "transactionId": transaction_id,
                    "nonce": nonce,
                }
            if current != previous:
                self._journal = {
                    **self._journal,
                    "phase": "pre_handler_identity_blocked",
                    "failure": "pre-handler-application-identity-mismatch",
                    "intent": {"action": "none"},
                }
                self._write_journal()
                return {
                    "action": "blocked",
                    "failure": "pre-handler-application-identity-mismatch",
                }
            return self._restore_previous_services(
                failure="pre-handler-session-lost",
                terminal_phase="update_aborted",
            )
        if phase == "installing":
            if current == target:
                self._journal = {
                    **self._journal,
                    "phase": "target_launched",
                    "intent": {"action": "register-services"},
                }
                self._write_journal()
                return {
                    "action": "register_services",
                    "services": sorted(_BUNDLED_SERVICES),
                    "transactionId": transaction_id,
                    "nonce": nonce,
                }
            if current == previous:
                self._journal = {
                    **self._journal,
                    "phase": "restoring_old_services",
                    "failure": "installation-did-not-replace-application",
                    "intent": {"action": "register-services"},
                }
                self._write_journal()
                return {
                    "action": "register_services",
                    "services": sorted(_BUNDLED_SERVICES),
                    "restorePrevious": True,
                    "transactionId": transaction_id,
                    "nonce": nonce,
                }
            return self._offer_rollback("installed-application-identity-mismatch")
        if phase in {"target_launched", "registration_requested"}:
            if current != target:
                return self._offer_rollback("target-application-identity-mismatch")
            return {
                "action": "register_services",
                "services": sorted(_BUNDLED_SERVICES),
                "transactionId": transaction_id,
                "nonce": nonce,
            }
        if phase == "awaiting_service_approval":
            return {
                "action": "observe_services",
                "transactionId": transaction_id,
                "nonce": nonce,
            }
        if phase == "services_reconciled":
            return {
                "action": "verify_update_health",
                "transactionId": transaction_id,
                "nonce": nonce,
            }
        if phase in {"restoring_old_services", "previous_health_failed"}:
            return {
                "action": "register_services",
                "services": sorted(_BUNDLED_SERVICES),
                "restorePrevious": True,
                "transactionId": transaction_id,
                "nonce": nonce,
            }
        if phase == "previous_services_reconciled":
            return {
                "action": "verify_previous_health",
                "transactionId": transaction_id,
                "nonce": nonce,
            }
        if phase == "rollback_quiescing":
            return {
                "action": "unregister_services_for_rollback",
                "services": sorted(_BUNDLED_SERVICES),
                "transactionId": transaction_id,
                "nonce": nonce,
            }
        if phase == "rollback_ready":
            return self._rollback_helper_action(
                transaction_id=transaction_id,
                nonce=nonce,
                verify_application=verify_application,
            )
        if phase == "rollback_offered":
            return {
                "action": "offer_return_to_previous_application",
                "failure": self._journal.get("failure"),
                "transactionId": transaction_id,
                "nonce": nonce,
            }
        if phase == "rollback_swapped":
            if current != previous:
                return {
                    "action": "blocked",
                    "failure": "restored-application-identity-mismatch",
                }
            return self._restore_previous_services(
                failure="rollback-services-not-restored",
                terminal_phase="rolled_back",
            )
        if phase == "committed":
            return {"action": "committed"}
        if phase == "update_aborted":
            return {"action": "aborted", "failure": self._journal.get("failure")}
        if phase == "rolled_back":
            return {"action": "rolled_back"}
        raise MigrationBlocked("application update journal phase is invalid")

    def observe_service_statuses(
        self,
        *,
        transaction_id: str,
        nonce: str,
        statuses: dict[str, str],
    ) -> dict[str, object]:
        self._require_binding(transaction_id, nonce)
        assert self._journal is not None
        phase = self._journal.get("phase")
        if phase not in {
            "target_launched",
            "registration_requested",
            "awaiting_service_approval",
            "restoring_old_services",
            "previous_health_failed",
        }:
            raise MigrationBlocked("service registration was observed out of phase")
        if set(statuses) != _BUNDLED_SERVICES:
            raise MigrationBlocked("application service observation is incomplete")
        if phase in {"restoring_old_services", "previous_health_failed"}:
            if any(status != "enabled" for status in statuses.values()):
                self._journal = {
                    **self._journal,
                    "serviceStatuses": dict(statuses),
                    "intent": {"action": "register-services"},
                }
                self._write_journal()
                return {
                    "action": "register_services",
                    "services": sorted(_BUNDLED_SERVICES),
                    "restorePrevious": True,
                    "transactionId": transaction_id,
                    "nonce": nonce,
                }
            self._journal = {
                **self._journal,
                "phase": "previous_services_reconciled",
                "serviceStatuses": dict(statuses),
                "intent": {"action": "verify-previous-health"},
            }
            self._write_journal()
            return {
                "action": "verify_previous_health",
                "transactionId": transaction_id,
                "nonce": nonce,
            }
        if any(status == "requiresApproval" for status in statuses.values()):
            self._journal = {
                **self._journal,
                "phase": "awaiting_service_approval",
                "serviceStatuses": dict(statuses),
                "intent": {"action": "observe-services"},
            }
            self._write_journal()
            return {
                "action": "observe_services",
                "transactionId": transaction_id,
                "nonce": nonce,
            }
        if any(status != "enabled" for status in statuses.values()):
            self._journal = {
                **self._journal,
                "phase": "registration_requested",
                "serviceStatuses": dict(statuses),
                "intent": {"action": "register-services"},
            }
            self._write_journal()
            return {
                "action": "register_services",
                "services": sorted(_BUNDLED_SERVICES),
                "transactionId": transaction_id,
                "nonce": nonce,
            }
        self._journal = {
            **self._journal,
            "phase": "services_reconciled",
            "serviceStatuses": dict(statuses),
            "intent": {"action": "verify-update-health"},
        }
        self._write_journal()
        return {
            "action": "verify_update_health",
            "transactionId": transaction_id,
            "nonce": nonce,
        }

    def record_preparation_failure(
        self,
        *,
        transaction_id: str,
        nonce: str,
        failure: str,
    ) -> dict[str, object]:
        self._require_binding(transaction_id, nonce)
        assert self._journal is not None
        if re.fullmatch(r"[a-z0-9-]{1,80}", failure) is None:
            raise MigrationBlocked("application update failure code is invalid")
        phase = self._journal.get("phase")
        if phase in {"services_quiesced", "install_authorized"}:
            return self._restore_previous_services(
                failure=failure,
                terminal_phase="update_aborted",
            )
        if phase in {"candidate_bound", "deferred_recording", "preparing"}:
            self._journal = {
                **self._journal,
                "phase": "update_aborted",
                "failure": failure,
                "intent": {"action": "none"},
            }
            self._write_journal()
            return {"action": "aborted", "failure": failure}
        raise MigrationBlocked("application update failure was recorded out of phase")

    def observe_health(
        self,
        *,
        transaction_id: str,
        nonce: str,
        health: dict[str, object],
    ) -> dict[str, object]:
        self._require_binding(transaction_id, nonce)
        assert self._journal is not None
        phase = self._journal.get("phase")
        if phase not in {"services_reconciled", "previous_services_reconciled"}:
            raise MigrationBlocked("application health was observed out of phase")
        target = self._journal.get(
            "from" if phase == "previous_services_reconciled" else "to"
        )
        healthy = isinstance(target, dict) and _valid_update_health(
            health,
            expected=target,
        )
        if not healthy:
            if phase == "previous_services_reconciled":
                self._journal = {
                    **self._journal,
                    "phase": "previous_health_failed",
                    "failure": "previous-health-gate-failed",
                    "intent": {"action": "none"},
                }
                self._write_journal()
                return {
                    "action": "blocked",
                    "failure": "previous-health-gate-failed",
                }
            return self._offer_rollback("health-gate-failed")
        if phase == "previous_services_reconciled":
            terminal_phase = self._journal.get("recoveryTerminal")
            if terminal_phase not in {"update_aborted", "rolled_back"}:
                raise MigrationBlocked("previous application recovery target is invalid")
            self._journal = {
                **self._journal,
                "phase": terminal_phase,
                "recoveredAt": self._now().isoformat(),
                "intent": {"action": "previous-runtime-healthy"},
            }
            self._write_journal()
            return {
                "action": "rolled_back" if terminal_phase == "rolled_back" else "aborted",
                "failure": self._journal.get("failure"),
            }
        self._journal = {
            **self._journal,
            "phase": "committed",
            "committedAt": self._now().isoformat(),
            "intent": {"action": "update-complete"},
        }
        self._write_journal()
        return {"action": "committed"}

    def request_return_to_previous_application(
        self,
        *,
        transaction_id: str,
        nonce: str,
        installed_application: Path,
        verify_application: Callable[[Path], dict[str, object]] = verify_application_bundle,
    ) -> dict[str, object]:
        self._require_binding(transaction_id, nonce)
        assert self._journal is not None
        if self._journal.get("phase") != "rollback_offered":
            raise MigrationBlocked("return to previous application was requested out of phase")
        expected = self._journal.get("previousApplication")
        if not isinstance(expected, dict) or verify_application(
            self.paths.previous_app_path
        ) != expected:
            raise MigrationBlocked("previous application changed or is invalid")
        target = self._journal.get("to")
        failed_target = verify_application(installed_application)
        if (
            not isinstance(target, dict)
            or failed_target.get("identifier") != _PRODUCT_IDENTIFIER
            or failed_target.get("teamIdentifier") != _PRODUCT_TEAM_IDENTIFIER
            or failed_target.get("version") != target.get("version")
            or failed_target.get("build") != target.get("build")
            or re.fullmatch(
                r"[0-9a-f]{40,64}", str(failed_target.get("cdHash", ""))
            )
            is None
        ):
            raise MigrationBlocked("failed target application changed or is invalid")
        self._journal = {
            **self._journal,
            "phase": "rollback_quiescing",
            "failedTargetApplication": dict(failed_target),
            "intent": {"action": "unregister-services-for-rollback"},
        }
        self._write_journal()
        return {
            "action": "unregister_services_for_rollback",
            "services": sorted(_BUNDLED_SERVICES),
            "transactionId": transaction_id,
            "nonce": nonce,
        }

    def observe_rollback_services_quiesced(
        self,
        *,
        transaction_id: str,
        nonce: str,
        statuses: dict[str, str],
        owners: dict[str, object],
        verify_application: Callable[[Path], dict[str, object]] = verify_application_bundle,
    ) -> dict[str, object]:
        self._require_binding(transaction_id, nonce)
        assert self._journal is not None
        if self._journal.get("phase") != "rollback_quiescing":
            raise MigrationBlocked("rollback services were observed out of phase")
        if set(statuses) != _BUNDLED_SERVICES or any(
            status != "notRegistered" for status in statuses.values()
        ):
            raise MigrationBlocked("application services are not quiesced for rollback")
        if not _runtime_owners_are_absent(owners):
            raise MigrationBlocked("application runtime owners are not quiesced for rollback")
        expected = self._journal.get("previousApplication")
        failed_target = self._journal.get("failedTargetApplication")
        if not isinstance(expected, dict) or verify_application(
            self.paths.previous_app_path
        ) != expected:
            raise MigrationBlocked("previous application changed or is invalid")
        if not isinstance(failed_target, dict):
            raise MigrationBlocked("failed target application identity is missing")
        self._journal = {
            **self._journal,
            "phase": "rollback_ready",
            "intent": {"action": "launch-rollback-helper"},
        }
        self._write_journal()
        return self._rollback_helper_action(
            transaction_id=transaction_id,
            nonce=nonce,
            verify_application=verify_application,
        )

    def _rollback_helper_action(
        self,
        *,
        transaction_id: str,
        nonce: str,
        verify_application: Callable[[Path], dict[str, object]] = verify_application_bundle,
    ) -> dict[str, object]:
        self._require_binding(transaction_id, nonce)
        assert self._journal is not None
        if self._journal.get("phase") != "rollback_ready":
            raise MigrationBlocked("rollback helper was requested out of phase")
        expected = self._journal.get("previousApplication")
        failed_target = self._journal.get("failedTargetApplication")
        if not isinstance(expected, dict) or verify_application(
            self.paths.previous_app_path
        ) != expected:
            raise MigrationBlocked("previous application changed or is invalid")
        if not isinstance(failed_target, dict):
            raise MigrationBlocked("failed target application identity is missing")
        python_path = (
            self.paths.previous_app_path
            / "Contents/Resources/runtime/python/bin/python3"
        )
        script_path = (
            self.paths.previous_app_path
            / "Contents/Resources/runtime/yulu/scripts/application_update.py"
        )
        for path, executable in ((python_path, True), (script_path, False)):
            try:
                info = path.lstat()
            except OSError as exc:
                raise MigrationBlocked("signed rollback helper is missing") from exc
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.geteuid()
                or info.st_nlink != 1
                or (executable and not info.st_mode & stat.S_IXUSR)
            ):
                raise MigrationBlocked("signed rollback helper is unsafe")
        return {
            "action": "launch_rollback_helper",
            "executable": str(python_path),
            "script": str(script_path),
            "transactionId": transaction_id,
            "nonce": nonce,
        }

    def complete_rollback(
        self,
        *,
        transaction_id: str,
        nonce: str,
        failed_application: Path,
    ) -> dict[str, object]:
        self._require_binding(transaction_id, nonce)
        assert self._journal is not None
        if self._journal.get("phase") != "rollback_ready":
            raise MigrationBlocked("application rollback completed out of phase")
        if not failed_application.is_absolute() or failed_application.name != (
            f".Yulu.failed.{transaction_id}.app"
        ):
            raise MigrationBlocked("failed application quarantine is invalid")
        self._journal = {
            **self._journal,
            "phase": "rollback_swapped",
            "rollbackSwappedAt": self._now().isoformat(),
            "failedApplication": str(failed_application),
            "intent": {"action": "relaunch-previous-application"},
        }
        self._write_journal()
        return {"action": "rollback_swapped"}

    def _restore_previous_services(
        self,
        *,
        failure: str,
        terminal_phase: str,
    ) -> dict[str, object]:
        assert self._journal is not None
        if terminal_phase not in {"update_aborted", "rolled_back"}:
            raise MigrationBlocked("previous application recovery target is invalid")
        self._journal = {
            **self._journal,
            "phase": "restoring_old_services",
            "failure": failure,
            "recoveryTerminal": terminal_phase,
            "intent": {"action": "register-services"},
        }
        self._write_journal()
        return {
            "action": "register_services",
            "services": sorted(_BUNDLED_SERVICES),
            "restorePrevious": True,
            "transactionId": self._journal["transactionId"],
            "nonce": self._journal["nonce"],
        }

    def _offer_rollback(self, failure: str) -> dict[str, object]:
        assert self._journal is not None
        self._journal = {
            **self._journal,
            "phase": "rollback_offered",
            "failure": failure,
            "intent": {"action": "offer-return-to-previous-application"},
        }
        self._write_journal()
        return {
            "action": "offer_return_to_previous_application",
            "failure": failure,
            "transactionId": self._journal["transactionId"],
            "nonce": self._journal["nonce"],
        }


def _read_session_message(stream: TextIO) -> dict[str, object]:
    encoded = stream.readline(64 * 1024 + 1)
    if not encoded or len(encoded.encode()) > 64 * 1024:
        raise MigrationBlocked("application update session response is missing or too large")
    try:
        payload = json.loads(encoded)
    except json.JSONDecodeError as exc:
        raise MigrationBlocked("application update session response is invalid") from exc
    if not isinstance(payload, dict):
        raise MigrationBlocked("application update session response is invalid")
    return payload


def _write_session_action(stream: TextIO, action: dict[str, object]) -> None:
    stream.write(json.dumps(action, sort_keys=True, separators=(",", ":")) + "\n")
    stream.flush()


def run_update_session(
    *,
    paths: ApplicationUpdatePaths,
    application_path: Path,
    current_version: str,
    current_build: str,
    databases: dict[str, Path],
    input_stream: TextIO,
    output_stream: TextIO,
    target_version: str | None = None,
    target_build: str | None = None,
    request_rollback: bool = False,
    copy_application: Callable[[Path, Path], None] = copy_application_bundle,
    verify_application: Callable[[Path], dict[str, object]] = verify_application_bundle,
) -> dict[str, object]:
    """Run one lock-held Swift↔Python update transaction session."""
    if target_version is not None and target_build is not None:
        _write_session_action(
            output_stream,
            {"action": "observe_recording", "scope": "preflight"},
        )
        preflight = _read_session_message(input_stream).get("recording")
        if preflight is not None and type(preflight) is not bool:
            raise MigrationBlocked("Capture recording observation is invalid")
        if preflight is not False:
            reason = "recording-active" if preflight is True else "recording-unknown"
            action = {"action": "defer_installation", "reason": reason}
            _write_session_action(output_stream, action)
            return action
    with ApplicationUpdate(paths) as authority:
        if (
            authority._journal is not None
            and target_version is not None
            and target_build is not None
            and authority._journal.get("phase")
            in {"committed", "update_aborted", "rolled_back"}
        ):
            authority.retire_terminal_transaction()
        if authority._journal is None:
            if target_version is None or target_build is None:
                action: dict[str, object] = {"action": "idle"}
            else:
                _write_session_action(
                    output_stream,
                    {"action": "observe_recording", "scope": "locked"},
                )
                locked_recording = _read_session_message(input_stream).get("recording")
                if locked_recording is not None and type(locked_recording) is not bool:
                    raise MigrationBlocked("Capture recording observation is invalid")
                if locked_recording is not False:
                    reason = (
                        "recording-active"
                        if locked_recording is True
                        else "recording-unknown"
                    )
                    action = {"action": "defer_installation", "reason": reason}
                    _write_session_action(output_stream, action)
                    return action
                transaction = authority.begin(
                    from_version=current_version,
                    from_build=current_build,
                    to_version=target_version,
                    to_build=target_build,
                )
                action = authority.observe_recording(
                    transaction_id=str(transaction["transactionId"]),
                    nonce=str(transaction["nonce"]),
                    recording=False,
                )
        else:
            action = authority.resume(
                current_version=current_version,
                current_build=current_build,
            )
        if request_rollback:
            if action.get("action") != "offer_return_to_previous_application":
                raise MigrationBlocked("rollback was requested without a failed health gate")
            action = authority.request_return_to_previous_application(
                transaction_id=str(action["transactionId"]),
                nonce=str(action["nonce"]),
                installed_application=application_path,
                verify_application=verify_application,
            )

        while True:
            action_name = action.get("action")
            transaction_id = str(action.get("transactionId", ""))
            nonce = str(action.get("nonce", ""))
            if action_name == "preserve_previous_application":
                try:
                    action = authority.preserve_previous_application(
                        transaction_id=transaction_id,
                        nonce=nonce,
                        application_path=application_path,
                        copy_application=copy_application,
                        verify_application=verify_application,
                    )
                except MigrationBlocked:
                    action = authority.record_preparation_failure(
                        transaction_id=transaction_id,
                        nonce=nonce,
                        failure="previous-application-preservation-failed",
                    )
                continue
            if action_name == "checkpoint_data":
                try:
                    action = authority.checkpoint_databases(
                        transaction_id=transaction_id,
                        nonce=nonce,
                        databases=databases,
                    )
                except MigrationBlocked:
                    action = authority.record_preparation_failure(
                        transaction_id=transaction_id,
                        nonce=nonce,
                        failure="database-checkpoint-failed",
                    )
                continue

            _write_session_action(output_stream, action)
            if action_name in {
                "idle",
                "defer_installation",
                "invoke_install_handler",
                "offer_return_to_previous_application",
                "launch_rollback_helper",
                "committed",
                "aborted",
                "rolled_back",
                "blocked",
            }:
                return action

            message = _read_session_message(input_stream)
            if action_name == "observe_recording":
                recording = message.get("recording")
                if recording is not None and type(recording) is not bool:
                    raise MigrationBlocked("Capture recording observation is invalid")
                action = authority.observe_recording(
                    transaction_id=transaction_id,
                    nonce=nonce,
                    recording=recording,
                )
            elif action_name in {"unregister_services", "unregister_services_for_rollback"}:
                statuses = message.get("statuses")
                owners = message.get("owners")
                if not isinstance(statuses, dict) or not isinstance(owners, dict):
                    raise MigrationBlocked("service quiescence observation is invalid")
                typed_statuses = {str(key): str(value) for key, value in statuses.items()}
                if action_name == "unregister_services":
                    action = authority.observe_services_quiesced(
                        transaction_id=transaction_id,
                        nonce=nonce,
                        statuses=typed_statuses,
                        owners=owners,
                    )
                else:
                    action = authority.observe_rollback_services_quiesced(
                        transaction_id=transaction_id,
                        nonce=nonce,
                        statuses=typed_statuses,
                        owners=owners,
                        verify_application=verify_application,
                    )
            elif action_name == "install_update":
                if message.get("action") != "authorize_install":
                    raise MigrationBlocked("Sparkle install authorization is invalid")
                action = authority.mark_installing(
                    transaction_id=transaction_id,
                    nonce=nonce,
                )
            elif action_name in {"register_services", "observe_services"}:
                statuses = message.get("statuses")
                if not isinstance(statuses, dict):
                    raise MigrationBlocked("service registration observation is invalid")
                action = authority.observe_service_statuses(
                    transaction_id=transaction_id,
                    nonce=nonce,
                    statuses={str(key): str(value) for key, value in statuses.items()},
                )
            elif action_name in {"verify_update_health", "verify_previous_health"}:
                health = message.get("health")
                if not isinstance(health, dict):
                    raise MigrationBlocked("application health observation is invalid")
                action = authority.observe_health(
                    transaction_id=transaction_id,
                    nonce=nonce,
                    health=health,
                )
            else:
                raise MigrationBlocked("application update session action is invalid")


def _database_arguments(arguments: argparse.Namespace) -> dict[str, Path]:
    databases = {"host": Path(arguments.host_database)}
    for kind in ("prompts", "vocab", "search"):
        value = getattr(arguments, f"{kind}_database")
        if value and Path(value).exists():
            databases[kind] = Path(value)
    return databases


def _run_recovery(arguments: argparse.Namespace) -> int:
    paths = ApplicationUpdatePaths(
        durable_root=Path(arguments.durable),
        cache_root=Path(arguments.cache),
    )
    with ApplicationUpdate(paths) as authority:
        journal = authority._journal
        if (
            not isinstance(journal, dict)
            or journal.get("phase") != "rollback_ready"
            or journal.get("transactionId") != arguments.transaction_id
            or not isinstance(journal.get("previousApplication"), dict)
            or not isinstance(journal.get("failedTargetApplication"), dict)
        ):
            raise MigrationBlocked("rollback journal is not ready")
        expected_identity = dict(journal["previousApplication"])
        expected_target_identity = dict(journal["failedTargetApplication"])
        nonce = str(journal["nonce"])
    failed_application = restore_previous_application(
        installed_application=Path(arguments.application),
        previous_application=paths.previous_app_path,
        transaction_id=arguments.transaction_id,
        expected_identity=expected_identity,
        expected_target_identity=expected_target_identity,
        parent_pid=arguments.parent_pid,
        parent_generation=(arguments.parent_start_seconds, arguments.parent_start_microseconds),
        relaunch=lambda _: None,
    )
    with ApplicationUpdate(paths) as authority:
        authority.complete_rollback(
            transaction_id=arguments.transaction_id,
            nonce=nonce,
            failed_application=failed_application,
        )
    _relaunch_application(Path(arguments.application))
    return 0


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Yulu whole-application update transaction authority"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    session = subparsers.add_parser("session")
    session.add_argument("--durable", required=True)
    session.add_argument("--cache", required=True)
    session.add_argument("--application", required=True)
    session.add_argument("--current-version", required=True)
    session.add_argument("--current-build", required=True)
    session.add_argument("--target-version")
    session.add_argument("--target-build")
    session.add_argument("--host-database", required=True)
    session.add_argument("--prompts-database")
    session.add_argument("--vocab-database")
    session.add_argument("--search-database")
    session.add_argument("--request-rollback", action="store_true")

    recovery = subparsers.add_parser("recover")
    recovery.add_argument("--durable", required=True)
    recovery.add_argument("--cache", required=True)
    recovery.add_argument("--application", required=True)
    recovery.add_argument("--transaction-id", required=True)
    recovery.add_argument("--parent-pid", required=True, type=int)
    recovery.add_argument("--parent-start-seconds", required=True, type=int)
    recovery.add_argument("--parent-start-microseconds", required=True, type=int)
    return parser


def main() -> int:
    arguments = build_argument_parser().parse_args()
    try:
        if arguments.command == "recover":
            return _run_recovery(arguments)
        action = run_update_session(
            paths=ApplicationUpdatePaths(
                durable_root=Path(arguments.durable),
                cache_root=Path(arguments.cache),
            ),
            application_path=Path(arguments.application),
            current_version=arguments.current_version,
            current_build=arguments.current_build,
            target_version=arguments.target_version,
            target_build=arguments.target_build,
            databases=_database_arguments(arguments),
            input_stream=sys.stdin,
            output_stream=sys.stdout,
            request_rollback=arguments.request_rollback,
        )
        return 0 if action.get("action") in {"idle", "committed", "invoke_install_handler"} else 75
    except MigrationBlocked:
        _write_session_action(sys.stdout, {"action": "blocked"})
        return 75


if __name__ == "__main__":
    raise SystemExit(main())
