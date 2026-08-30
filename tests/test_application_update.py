from datetime import datetime, timezone
from pathlib import Path
import io
import json
import os
import re
import sqlite3
import subprocess

import pytest


SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"


def quiesced_owners() -> dict[str, object]:
    return {
        "host": {
            "state": "absent",
            "proof": "tcp-refused-owner-record-absent",
        },
        "capture": {
            "state": "absent",
            "proof": "unix-missing-or-refused",
        },
    }


def begin_idle_update(authority):
    transaction = authority.begin(
        from_version="0.23.0-rc.4",
        from_build="731",
        to_version="0.23.0",
        to_build="732",
    )
    authority.observe_recording(
        transaction_id=transaction["transactionId"],
        nonce=transaction["nonce"],
        recording=False,
    )
    return transaction


def test_cross_language_update_contract_constants_match() -> None:
    python_source = (SCRIPTS / "application_update.py").read_text(encoding="utf-8")
    host_source = (SCRIPTS / "yulu_ui/src/runtimeContract.ts").read_text(
        encoding="utf-8"
    )
    app_source = (SCRIPTS / "yulu_app.swift").read_text(encoding="utf-8")
    capture_source = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")

    def value(source: str, pattern: str) -> int:
        match = re.search(pattern, source)
        assert match is not None, pattern
        return int(match.group(1))

    host_ipc = {
        value(python_source, r"_HOST_IPC_VERSION = (\d+)"),
        value(host_source, r"YULU_HOST_IPC_VERSION = (\d+)"),
        value(app_source, r"static let hostIPCVersion = (\d+)"),
    }
    capture_ipc = {
        value(python_source, r"_CAPTURE_IPC_VERSION = (\d+)"),
        value(host_source, r"YULU_CAPTURE_IPC_VERSION = (\d+)"),
        value(app_source, r"static let captureIPCVersion = (\d+)"),
        value(capture_source, r"CAPTURE_IPC_VERSION = (\d+)"),
    }
    database_schema = {
        value(python_source, r"_HOST_DATABASE_SCHEMA_VERSION = (\d+)"),
        value(host_source, r"YULU_HOST_DATABASE_SCHEMA_VERSION = (\d+)"),
        value(app_source, r"static let hostDatabaseSchemaVersion = (\d+)"),
    }
    minimum_readable = {
        value(
            python_source,
            r"_HOST_DATABASE_MINIMUM_READABLE_VERSION = (\d+)",
        ),
        value(
            host_source,
            r"YULU_HOST_DATABASE_MINIMUM_READABLE_VERSION = (\d+)",
        ),
        value(
            app_source,
            r"static let hostDatabaseMinimumReadableVersion = (\d+)",
        ),
    }
    assert host_ipc == capture_ipc == database_schema == minimum_readable == {1}


@pytest.mark.parametrize(
    ("from_release", "to_release"),
    [
        ("0.23.0-rc.4", "0.23.0-rc.5"),
        ("0.23.0-rc.4", "0.23.0"),
        ("0.23.0-rc.4", "0.24.0"),
        ("0.23.0", "0.24.0"),
    ],
)
def test_release_identity_policy_allows_only_forward_lines(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    from_release: str,
    to_release: str,
) -> None:
    # These are generic update examples, including RC4 -> stable and an N+1
    # release. #171, not this runtime policy, proves same-commit promotion.
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    with ApplicationUpdate(paths) as authority:
        transaction = authority.begin(
            from_version=from_release,
            from_build="731",
            to_version=to_release,
            to_build="732",
        )
    assert transaction["from"] == {"version": from_release, "build": "731"}
    assert transaction["to"] == {"version": to_release, "build": "732"}


@pytest.mark.parametrize(
    ("from_release", "to_release"),
    [
        ("0.23.0", "0.22.9"),
        ("0.23.0-rc.4", "0.22.9"),
        ("0.23.0-rc.4", "0.23.0-rc.3"),
        ("0.23.0-rc.4", "0.23.0-rc.4"),
        ("0.23.0", "0.23.0-rc.5"),
        ("0.23.0", "0.24.0-rc.1"),
        ("0.23", "0.24.0"),
        ("0.23.0-rc4", "0.23.0"),
        ("0.23.0-beta.1", "0.23.0"),
        ("01.23.0", "1.24.0"),
    ],
)
def test_release_identity_policy_rejects_downgrade_and_unknown_formats(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    from_release: str,
    to_release: str,
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    with ApplicationUpdate(paths) as authority:
        with pytest.raises(MigrationBlocked, match="release identity is not monotonic"):
            authority.begin(
                from_version=from_release,
                from_build="731",
                to_version=to_release,
                to_build="732",
            )


def test_recording_or_unknown_capture_state_defers_without_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support" / "Yulu",
        cache_root=tmp_path / "Caches" / "Yulu",
    )
    now = lambda: datetime(2026, 8, 30, tzinfo=timezone.utc)

    for recording in (True, None):
        with ApplicationUpdate(paths, now=now) as authority:
            transaction = authority.begin(
                from_version="0.23.0-rc.4",
                from_build="731",
                to_version="0.23.0",
                to_build="732",
            )
            decision = authority.observe_recording(
                transaction_id=transaction["transactionId"],
                nonce=transaction["nonce"],
                recording=recording,
            )

        assert decision == {
            "action": "defer_installation",
            "reason": "recording-active" if recording else "recording-unknown",
            "transactionId": transaction["transactionId"],
            "nonce": transaction["nonce"],
        }
        journal = paths.journal_path.read_text(encoding="utf-8")
        assert '"phase":"deferred_recording"' in journal
        assert not paths.previous_app_path.exists()
        assert not paths.checkpoint_dir.exists()
        paths.journal_path.unlink()


def test_update_and_migration_share_one_exact_attempt_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import ApplicationMigration, MigrationBlocked
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support" / "Yulu",
        cache_root=tmp_path / "Caches" / "Yulu",
    )
    assert paths.attempt_lock_path == paths.migration_paths.attempt_lock_path

    with ApplicationUpdate(paths):
        with pytest.raises(MigrationBlocked, match="already in progress"):
            with ApplicationMigration(paths.migration_paths):
                pass

    with ApplicationMigration(paths.migration_paths):
        with pytest.raises(MigrationBlocked, match="already in progress"):
            with ApplicationUpdate(paths):
                pass


def test_install_parent_accepts_macos_applications_but_rejects_world_writable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        MigrationBlocked,
        open_existing_trusted_install_directory,
    )

    applications_fd = open_existing_trusted_install_directory(Path("/Applications"))
    assert applications_fd >= 0
    os.close(applications_fd)

    unsafe = tmp_path / "unsafe-install-parent"
    unsafe.mkdir(mode=0o777)
    unsafe.chmod(0o777)
    with pytest.raises(MigrationBlocked, match="unsafe application install directory"):
        open_existing_trusted_install_directory(unsafe)


def test_copy_previous_whole_app_preserves_framework_symlinks_and_xattrs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import copy_application_bundle

    source = tmp_path / "source" / "Yulu.app"
    version = source / "Contents/Frameworks/Sparkle.framework/Versions/A"
    version.mkdir(parents=True)
    (version / "Sparkle").write_bytes(b"signed-framework")
    versions = version.parent
    (versions / "Current").symlink_to("A")
    framework = versions.parent
    (framework / "Sparkle").symlink_to("Versions/Current/Sparkle")
    subprocess.run(
        ["/usr/bin/xattr", "-w", "com.yulu.snapshot-test", "preserved", str(source)],
        check=True,
    )

    destination = tmp_path / "snapshot" / "Yulu.app"
    destination.parent.mkdir(mode=0o700)
    copy_application_bundle(source, destination)

    assert (destination / "Contents/Frameworks/Sparkle.framework/Versions/Current").is_symlink()
    assert os.readlink(
        destination / "Contents/Frameworks/Sparkle.framework/Versions/Current"
    ) == "A"
    assert os.readlink(
        destination / "Contents/Frameworks/Sparkle.framework/Sparkle"
    ) == "Versions/Current/Sparkle"
    assert subprocess.run(
        ["/usr/bin/xattr", "-p", "com.yulu.snapshot-test", str(destination)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip() == "preserved"


def test_previous_app_then_quiescence_then_database_checkpoint_authorizes_install(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support" / "Yulu",
        cache_root=tmp_path / "Caches" / "Yulu",
    )
    source_app = tmp_path / "Applications" / "Yulu.app"
    source_app.mkdir(parents=True)
    database = paths.durable_root / "host.sqlite"
    database.parent.mkdir(parents=True, mode=0o700)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
        connection.execute("INSERT INTO agent_tasks VALUES ('durable-task')")
    database.chmod(0o600)

    copied: list[tuple[Path, Path]] = []

    def copy_application(source: Path, destination: Path) -> None:
        copied.append((source, destination))
        destination.mkdir(parents=True)

    previous_identity = {
        "identifier": "com.yulu.app",
        "teamIdentifier": "WMU9678ZQL",
        "cdHash": "a" * 40,
        "version": "0.23.0-rc.4",
        "build": "731",
    }

    with ApplicationUpdate(paths) as authority:
        transaction = begin_idle_update(authority)
        with pytest.raises(MigrationBlocked, match="services are not quiesced"):
            authority.checkpoint_databases(
                transaction_id=transaction["transactionId"],
                nonce=transaction["nonce"],
                databases={"host": database},
            )

        unregister = authority.preserve_previous_application(
            transaction_id=transaction["transactionId"],
            nonce=transaction["nonce"],
            application_path=source_app,
            copy_application=copy_application,
            verify_application=lambda _: previous_identity,
        )
        assert unregister["action"] == "unregister_services"
        assert copied == [(source_app, paths.previous_app_path)]

        checkpoint = authority.observe_services_quiesced(
            transaction_id=transaction["transactionId"],
            nonce=transaction["nonce"],
            statuses={
                "com.yulu.ui.plist": "notRegistered",
                "com.yulu.audiodaemon.plist": "notRegistered",
            },
            owners=quiesced_owners(),
        )
        assert checkpoint["action"] == "checkpoint_data"

        install = authority.checkpoint_databases(
            transaction_id=transaction["transactionId"],
            nonce=transaction["nonce"],
            databases={"host": database},
        )
        assert install["action"] == "install_update"

    persisted = json.loads(paths.journal_path.read_text(encoding="utf-8"))
    assert persisted["phase"] == "install_authorized"
    assert persisted["previousApplication"] == previous_identity
    snapshot = paths.checkpoint_dir / "host.sqlite"
    with sqlite3.connect(f"file:{snapshot}?mode=ro", uri=True) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("SELECT id FROM agent_tasks").fetchall() == [
            ("durable-task",)
        ]


@pytest.mark.parametrize(
    "owner",
    [
        {"state": "unknown", "proof": "attestation-timeout"},
        {"state": "present-attested", "pid": 4242},
        None,
    ],
)
def test_quiescence_requires_explicit_kernel_proven_absence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    owner: object,
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    source_app = tmp_path / "Applications/Yulu.app"
    source_app.mkdir(parents=True)
    with ApplicationUpdate(paths) as authority:
        transaction = begin_idle_update(authority)
        authority.preserve_previous_application(
            transaction_id=transaction["transactionId"],
            nonce=transaction["nonce"],
            application_path=source_app,
            copy_application=lambda _, destination: destination.mkdir(parents=True),
            verify_application=lambda _: {
                "identifier": "com.yulu.app",
                "teamIdentifier": "WMU9678ZQL",
                "cdHash": "a" * 40,
                "version": "0.23.0-rc.4",
                "build": "731",
            },
        )
        owners = quiesced_owners()
        owners["host"] = owner
        with pytest.raises(MigrationBlocked, match="runtime owners are not quiesced"):
            authority.observe_services_quiesced(
                transaction_id=transaction["transactionId"],
                nonce=transaction["nonce"],
                statuses={
                    "com.yulu.ui.plist": "notRegistered",
                    "com.yulu.audiodaemon.plist": "notRegistered",
                },
                owners=owners,
            )


def prepare_install_authority(
    authority,
    paths: "ApplicationUpdatePaths",
    source_app: Path,
    database: Path,
):
    transaction = begin_idle_update(authority)

    def copy_application(_: Path, destination: Path) -> None:
        destination.mkdir(parents=True)

    authority.preserve_previous_application(
        transaction_id=transaction["transactionId"],
        nonce=transaction["nonce"],
        application_path=source_app,
        copy_application=copy_application,
        verify_application=lambda _: {
            "identifier": "com.yulu.app",
            "teamIdentifier": "WMU9678ZQL",
            "cdHash": "a" * 40,
            "version": "0.23.0-rc.4",
            "build": "731",
        },
    )
    authority.observe_services_quiesced(
        transaction_id=transaction["transactionId"],
        nonce=transaction["nonce"],
        statuses={
            "com.yulu.ui.plist": "notRegistered",
            "com.yulu.audiodaemon.plist": "notRegistered",
        },
        owners=quiesced_owners(),
    )
    authority.checkpoint_databases(
        transaction_id=transaction["transactionId"],
        nonce=transaction["nonce"],
        databases={"host": database},
    )
    return transaction


def test_crash_resume_only_registers_target_services_after_checkpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support" / "Yulu",
        cache_root=tmp_path / "Caches" / "Yulu",
    )
    source_app = tmp_path / "Applications/Yulu.app"
    source_app.mkdir(parents=True)
    database = paths.durable_root / "host.sqlite"
    database.parent.mkdir(parents=True, mode=0o700)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
    database.chmod(0o600)

    with ApplicationUpdate(paths) as authority:
        transaction = prepare_install_authority(
            authority, paths, source_app, database
        )
        installing = authority.mark_installing(
            transaction_id=transaction["transactionId"],
            nonce=transaction["nonce"],
        )
        assert installing["action"] == "invoke_install_handler"

    with ApplicationUpdate(paths) as relaunched:
        register = relaunched.resume(
            current_version="0.23.0",
            current_build="732",
        )
        assert register["action"] == "register_services"
        health = relaunched.observe_service_statuses(
            transaction_id=register["transactionId"],
            nonce=register["nonce"],
            statuses={
                "com.yulu.ui.plist": "enabled",
                "com.yulu.audiodaemon.plist": "enabled",
            },
        )
        assert health["action"] == "verify_update_health"

    persisted = json.loads(paths.journal_path.read_text(encoding="utf-8"))
    assert persisted["phase"] == "services_reconciled"


def test_preparation_failure_after_quiescence_restores_old_services(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support" / "Yulu",
        cache_root=tmp_path / "Caches" / "Yulu",
    )
    source_app = tmp_path / "Applications/Yulu.app"
    source_app.mkdir(parents=True)
    database = paths.durable_root / "host.sqlite"
    database.parent.mkdir(parents=True, mode=0o700)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
    database.chmod(0o600)

    with ApplicationUpdate(paths) as authority:
        transaction = begin_idle_update(authority)

        def copy_application(_: Path, destination: Path) -> None:
            destination.mkdir(parents=True)

        authority.preserve_previous_application(
            transaction_id=transaction["transactionId"],
            nonce=transaction["nonce"],
            application_path=source_app,
            copy_application=copy_application,
            verify_application=lambda _: {
                "identifier": "com.yulu.app",
                "teamIdentifier": "WMU9678ZQL",
                "cdHash": "a" * 40,
                "version": "0.23.0-rc.4",
                "build": "731",
            },
        )
        authority.observe_services_quiesced(
            transaction_id=transaction["transactionId"],
            nonce=transaction["nonce"],
            statuses={
                "com.yulu.ui.plist": "notRegistered",
                "com.yulu.audiodaemon.plist": "notRegistered",
            },
            owners=quiesced_owners(),
        )
        restore = authority.record_preparation_failure(
            transaction_id=transaction["transactionId"],
            nonce=transaction["nonce"],
            failure="database-checkpoint-failed",
        )
        assert restore["action"] == "register_services"
        assert restore["restorePrevious"] is True


def exact_update_health() -> dict[str, object]:
    return {
        "application": {
            "identifier": "com.yulu.app",
            "teamIdentifier": "WMU9678ZQL",
            "cdHash": "a" * 40,
            "version": "0.23.0",
            "build": "732",
            "pid": 101,
            "uid": os.geteuid(),
            "generation": "100:1",
            "executable": "/Applications/Yulu.app/Contents/MacOS/yulu_app",
        },
        "host": {
            "identifier": "node",
            "teamIdentifier": "WMU9678ZQL",
            "cdHash": "b" * 40,
            "productVersion": "0.23.0",
            "bundleVersion": "732",
            "hostIPCVersion": 1,
            "serviceOwner": "com.yulu.ui",
            "pid": 102,
            "uid": os.geteuid(),
            "generation": "100:2",
            "executable": (
                "/Applications/Yulu.app/Contents/Resources/runtime/bin/node"
            ),
            "hostNonce": "11111111-1111-4111-8111-111111111111",
            "instanceLockToken": "host-lock-token-1234",
            "portOwnerPID": 102,
            "database": {
                "status": "ok",
                "quickCheck": "ok",
                "schemaVersion": 1,
                "minimumReadableVersion": 1,
            },
        },
        "capture": {
            "identifier": "com.yulu.audiodaemon",
            "teamIdentifier": "WMU9678ZQL",
            "cdHash": "c" * 40,
            "productVersion": "0.23.0",
            "bundleVersion": "732",
            "captureIPCVersion": 1,
            "serviceOwner": "com.yulu.audiodaemon",
            "pid": 103,
            "uid": os.geteuid(),
            "generation": "100:3",
            "executable": (
                "/Applications/Yulu.app/Contents/Helpers/"
                "YuluCapture.app/Contents/MacOS/audio_daemon"
            ),
            "socketOwnerPID": 103,
        },
        "services": {
            "com.yulu.ui.plist": "enabled",
            "com.yulu.audiodaemon.plist": "enabled",
        },
    }


def test_health_gate_commits_only_exact_app_helper_database_service_and_ipc_versions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support" / "Yulu",
        cache_root=tmp_path / "Caches" / "Yulu",
    )
    source_app = tmp_path / "Applications/Yulu.app"
    source_app.mkdir(parents=True)
    database = paths.durable_root / "host.sqlite"
    database.parent.mkdir(parents=True, mode=0o700)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
    database.chmod(0o600)

    with ApplicationUpdate(paths) as authority:
        transaction = prepare_install_authority(authority, paths, source_app, database)
        authority.mark_installing(
            transaction_id=transaction["transactionId"], nonce=transaction["nonce"]
        )
    with ApplicationUpdate(paths) as authority:
        register = authority.resume(current_version="0.23.0", current_build="732")
        verify = authority.observe_service_statuses(
            transaction_id=register["transactionId"],
            nonce=register["nonce"],
            statuses=exact_update_health()["services"],
        )
        committed = authority.observe_health(
            transaction_id=verify["transactionId"],
            nonce=verify["nonce"],
            health=exact_update_health(),
        )
        assert committed["action"] == "committed"


@pytest.mark.parametrize(
    ("path", "wrong"),
    [
        (("application", "identifier"), "com.attacker.app"),
        (("application", "teamIdentifier"), "ATTACKER00"),
        (("application", "cdHash"), "not-a-cdhash"),
        (("application", "version"), "0.23.0-rc.4"),
        (("application", "build"), "731"),
        (("application", "pid"), 1),
        (("application", "uid"), os.geteuid() + 1),
        (("application", "generation"), "unstable"),
        (("application", "executable"), "/tmp/yulu_app"),
        (("host", "identifier"), "attacker-host"),
        (("host", "teamIdentifier"), "ATTACKER00"),
        (("host", "cdHash"), "not-a-cdhash"),
        (("host", "productVersion"), "0.23.0-rc.4"),
        (("host", "bundleVersion"), "731"),
        (("host", "hostIPCVersion"), 2),
        (("host", "serviceOwner"), "unmanaged"),
        (("host", "pid"), 1),
        (("host", "uid"), os.geteuid() + 1),
        (("host", "generation"), "unstable"),
        (("host", "executable"), "/tmp/node"),
        (("host", "hostNonce"), "not-a-nonce"),
        (("host", "instanceLockToken"), "short"),
        (("host", "portOwnerPID"), 999),
        (("host", "database", "status"), "corrupt"),
        (("host", "database", "quickCheck"), "corrupt"),
        (("host", "database", "schemaVersion"), 2),
        (("host", "database", "minimumReadableVersion"), 2),
        (("capture", "identifier"), "attacker-capture"),
        (("capture", "teamIdentifier"), "ATTACKER00"),
        (("capture", "cdHash"), "not-a-cdhash"),
        (("capture", "productVersion"), "0.23.0-rc.4"),
        (("capture", "bundleVersion"), "731"),
        (("capture", "captureIPCVersion"), 2),
        (("capture", "serviceOwner"), "unmanaged"),
        (("capture", "pid"), 1),
        (("capture", "uid"), os.geteuid() + 1),
        (("capture", "generation"), "unstable"),
        (("capture", "executable"), "/tmp/audio_daemon"),
        (("capture", "socketOwnerPID"), 999),
        (("services", "com.yulu.ui.plist"), "requiresApproval"),
    ],
)
def test_health_mismatch_offers_verified_previous_whole_app(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    path: tuple[str, ...],
    wrong: object,
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support" / "Yulu",
        cache_root=tmp_path / "Caches" / "Yulu",
    )
    source_app = tmp_path / "Applications/Yulu.app"
    source_app.mkdir(parents=True)
    database = paths.durable_root / "host.sqlite"
    database.parent.mkdir(parents=True, mode=0o700)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
    database.chmod(0o600)

    with ApplicationUpdate(paths) as authority:
        transaction = prepare_install_authority(authority, paths, source_app, database)
        authority.mark_installing(
            transaction_id=transaction["transactionId"], nonce=transaction["nonce"]
        )
    with ApplicationUpdate(paths) as authority:
        register = authority.resume(current_version="0.23.0", current_build="732")
        verify = authority.observe_service_statuses(
            transaction_id=register["transactionId"],
            nonce=register["nonce"],
            statuses=exact_update_health()["services"],
        )
        health = exact_update_health()
        target: dict[str, object] = health
        for key in path[:-1]:
            nested = target[key]
            assert isinstance(nested, dict)
            target = nested
        target[path[-1]] = wrong
        offered = authority.observe_health(
            transaction_id=verify["transactionId"],
            nonce=verify["nonce"],
            health=health,
        )
        assert offered["action"] == "offer_return_to_previous_application"
        assert offered["failure"] == "health-gate-failed"
        assert paths.previous_app_path.exists()


def move_to_rollback_offer(authority, transaction: dict[str, object]) -> None:
    authority.mark_installing(
        transaction_id=transaction["transactionId"], nonce=transaction["nonce"]
    )


def test_tampered_previous_app_is_rejected_before_rollback_service_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    paths.journal_dir.mkdir(parents=True, mode=0o700)
    paths.rollback_dir.mkdir(mode=0o700)
    paths.previous_app_path.mkdir()
    journal = {
        "schemaVersion": 1,
        "transactionId": "a" * 32,
        "nonce": "b" * 32,
        "phase": "rollback_offered",
        "createdAt": "2026-08-30T00:00:00+00:00",
        "from": {"version": "0.23.0-rc.4", "build": "731"},
        "to": {"version": "0.23.0", "build": "732"},
        "previousApplication": {
            "identifier": "com.yulu.app",
            "teamIdentifier": "WMU9678ZQL",
            "cdHash": "a" * 40,
            "version": "0.23.0-rc.4",
            "build": "731",
        },
        "failure": "health-gate-failed",
        "intent": {"action": "offer-return-to-previous-application"},
    }
    paths.journal_path.write_text(json.dumps(journal), encoding="utf-8")
    paths.journal_path.chmod(0o600)

    with ApplicationUpdate(paths) as authority:
        with pytest.raises(MigrationBlocked, match="changed or is invalid"):
            authority.request_return_to_previous_application(
                transaction_id=journal["transactionId"],
                nonce=journal["nonce"],
                installed_application=tmp_path / "Applications/Yulu.app",
                verify_application=lambda _: {
                    **journal["previousApplication"],
                    "cdHash": "c" * 40,
                },
            )

    assert json.loads(paths.journal_path.read_text())["phase"] == "rollback_offered"


def test_verified_previous_app_replaces_new_app_only_after_new_app_exit_and_keeps_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import (
        ApplicationUpdate,
        ApplicationUpdatePaths,
        restore_previous_application,
    )

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    paths.journal_dir.mkdir(parents=True, mode=0o700)
    paths.rollback_dir.mkdir(mode=0o700)
    paths.previous_app_path.mkdir()
    (paths.previous_app_path / "marker").write_text("previous", encoding="utf-8")
    recovery_python = (
        paths.previous_app_path / "Contents/Resources/runtime/python/bin/python3"
    )
    recovery_python.parent.mkdir(parents=True)
    recovery_python.write_bytes(b"signed-python")
    recovery_python.chmod(0o500)
    recovery_script = (
        paths.previous_app_path
        / "Contents/Resources/runtime/yulu/scripts/application_update.py"
    )
    recovery_script.parent.mkdir(parents=True)
    recovery_script.write_text("# signed recovery\n", encoding="utf-8")
    database = paths.durable_root / "host.sqlite"
    database.write_bytes(b"live-new-data")
    data_before = database.read_bytes()
    expected = {
        "identifier": "com.yulu.app",
        "teamIdentifier": "WMU9678ZQL",
        "cdHash": "a" * 40,
        "version": "0.23.0-rc.4",
        "build": "731",
    }
    target_identity = {
        **expected,
        "cdHash": "d" * 40,
        "version": "0.23.0",
        "build": "732",
    }
    journal = {
        "schemaVersion": 1,
        "transactionId": "a" * 32,
        "nonce": "b" * 32,
        "phase": "rollback_offered",
        "createdAt": "2026-08-30T00:00:00+00:00",
        "from": {"version": "0.23.0-rc.4", "build": "731"},
        "to": {"version": "0.23.0", "build": "732"},
        "previousApplication": expected,
        "failure": "health-gate-failed",
        "intent": {"action": "offer-return-to-previous-application"},
    }
    paths.journal_path.write_text(json.dumps(journal), encoding="utf-8")
    paths.journal_path.chmod(0o600)
    installed = tmp_path / "Applications/Yulu.app"
    installed.mkdir(parents=True)
    (installed / "marker").write_text("new", encoding="utf-8")

    verify_calls: list[Path] = []

    def verify(application: Path) -> dict[str, object]:
        verify_calls.append(application)
        if (application / "marker").read_text(encoding="utf-8") != "previous":
            return target_identity
        return expected

    with ApplicationUpdate(paths) as authority:
        unregister = authority.request_return_to_previous_application(
            transaction_id=journal["transactionId"],
            nonce=journal["nonce"],
            installed_application=installed,
            verify_application=verify,
        )
        assert unregister["action"] == "unregister_services_for_rollback"
        launch = authority.observe_rollback_services_quiesced(
            transaction_id=journal["transactionId"],
            nonce=journal["nonce"],
            statuses={
                "com.yulu.ui.plist": "notRegistered",
                "com.yulu.audiodaemon.plist": "notRegistered",
            },
            owners=quiesced_owners(),
            verify_application=verify,
        )
        assert launch["action"] == "launch_rollback_helper"
        persisted = json.loads(paths.journal_path.read_text())
        assert persisted["failedTargetApplication"] == target_identity

    events: list[str] = []
    failed = restore_previous_application(
        installed_application=installed,
        previous_application=paths.previous_app_path,
        transaction_id=journal["transactionId"],
        expected_identity=expected,
        expected_target_identity=target_identity,
        parent_pid=4242,
        parent_generation=(10, 20),
        wait_for_exit=lambda pid, generation: events.append(
            f"wait:{pid}:{generation[0]}:{generation[1]}"
        ),
        verify_application=lambda application: (
            events.append(f"verify:{application.name}") or verify(application)
        ),
        relaunch=lambda application: events.append(f"relaunch:{application.name}"),
    )

    assert events[0] == "wait:4242:10:20"
    assert (installed / "marker").read_text(encoding="utf-8") == "previous"
    assert (failed / "marker").read_text(encoding="utf-8") == "new"
    assert database.read_bytes() == data_before
    assert events[-1] == "relaunch:Yulu.app"


def test_session_transcript_never_registers_new_host_before_checkpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdatePaths, run_update_session

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    application = tmp_path / "Applications/Yulu.app"
    application.mkdir(parents=True)
    database = paths.durable_root / "host.sqlite"
    database.parent.mkdir(parents=True, mode=0o700)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
        connection.execute("INSERT INTO agent_tasks VALUES ('before-update')")
    database.chmod(0o600)

    messages = io.StringIO(
        "\n".join(
            json.dumps(message)
            for message in [
                {"recording": False},
                {"recording": False},
                {
                    "statuses": {
                        "com.yulu.ui.plist": "notRegistered",
                        "com.yulu.audiodaemon.plist": "notRegistered",
                    },
                        "owners": quiesced_owners(),
                },
                {"action": "authorize_install"},
            ]
        )
        + "\n"
    )
    output = io.StringIO()

    run_update_session(
        paths=paths,
        application_path=application,
        current_version="0.23.0-rc.4",
        current_build="731",
        target_version="0.23.0",
        target_build="732",
        databases={"host": database},
        input_stream=messages,
        output_stream=output,
        copy_application=lambda _, destination: destination.mkdir(parents=True),
        verify_application=lambda _: {
            "identifier": "com.yulu.app",
            "teamIdentifier": "WMU9678ZQL",
            "cdHash": "a" * 40,
            "version": "0.23.0-rc.4",
            "build": "731",
        },
    )

    actions = [json.loads(line)["action"] for line in output.getvalue().splitlines()]
    assert actions == [
        "observe_recording",
        "observe_recording",
        "unregister_services",
        "install_update",
        "invoke_install_handler",
    ]
    assert actions.index("install_update") > actions.index("unregister_services")
    assert (paths.checkpoint_dir / "host.sqlite").exists()


def test_terminal_transaction_is_archived_before_a_later_update_begins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    paths.journal_dir.mkdir(parents=True, mode=0o700)
    paths.rollback_dir.mkdir(mode=0o700)
    (paths.rollback_dir / "old-snapshot").write_text("old", encoding="utf-8")
    paths.checkpoint_dir.mkdir(mode=0o700)
    (paths.checkpoint_dir / "host.sqlite").write_bytes(b"old-checkpoint")
    transaction_id = "a" * 32
    journal = {
        "schemaVersion": 1,
        "transactionId": transaction_id,
        "nonce": "b" * 32,
        "phase": "committed",
        "createdAt": "2026-08-30T00:00:00+00:00",
        "from": {"version": "0.23.0-rc.4", "build": "731"},
        "to": {"version": "0.23.0", "build": "732"},
        "intent": {"action": "update-complete"},
    }
    paths.journal_path.write_text(json.dumps(journal), encoding="utf-8")
    paths.journal_path.chmod(0o600)

    with ApplicationUpdate(paths) as authority:
        authority.retire_terminal_transaction()
        next_transaction = authority.begin(
            from_version="0.23.0",
            from_build="732",
            to_version="0.24.0",
            to_build="740",
        )

    assert next_transaction["transactionId"] != transaction_id
    assert (
        paths.journal_dir / f"journal.{transaction_id}.committed.json"
    ).is_file()
    assert not paths.rollback_dir.exists()
    assert not paths.checkpoint_dir.exists()


def test_rollback_ready_resume_reverifies_helper_and_completed_swap_is_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import (
        ApplicationUpdate,
        ApplicationUpdatePaths,
        restore_previous_application,
    )

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    paths.journal_dir.mkdir(parents=True, mode=0o700)
    paths.rollback_dir.mkdir(mode=0o700)
    paths.previous_app_path.mkdir()
    (paths.previous_app_path / "marker").write_text("previous", encoding="utf-8")
    python = paths.previous_app_path / "Contents/Resources/runtime/python/bin/python3"
    python.parent.mkdir(parents=True)
    python.write_bytes(b"python")
    python.chmod(0o500)
    script = (
        paths.previous_app_path
        / "Contents/Resources/runtime/yulu/scripts/application_update.py"
    )
    script.parent.mkdir(parents=True)
    script.write_text("# recovery\n", encoding="utf-8")
    expected = {
        "identifier": "com.yulu.app",
        "teamIdentifier": "WMU9678ZQL",
        "cdHash": "a" * 40,
        "version": "0.23.0-rc.4",
        "build": "731",
    }
    target_identity = {
        **expected,
        "cdHash": "b" * 40,
        "version": "0.23.0",
        "build": "732",
    }
    transaction_id = "c" * 32
    journal = {
        "schemaVersion": 1,
        "transactionId": transaction_id,
        "nonce": "d" * 32,
        "phase": "rollback_ready",
        "createdAt": "2026-08-30T00:00:00+00:00",
        "from": {"version": "0.23.0-rc.4", "build": "731"},
        "to": {"version": "0.23.0", "build": "732"},
        "previousApplication": expected,
        "failedTargetApplication": target_identity,
        "intent": {"action": "launch-rollback-helper"},
    }
    paths.journal_path.write_text(json.dumps(journal), encoding="utf-8")
    paths.journal_path.chmod(0o600)
    def verify(application: Path) -> dict[str, object]:
        if (application / "marker").read_text(encoding="utf-8") == "previous":
            return expected
        return target_identity

    with ApplicationUpdate(paths) as authority:
        action = authority.resume(
            current_version="0.23.0",
            current_build="732",
            verify_application=verify,
        )
    assert action["action"] == "launch_rollback_helper"

    installed = tmp_path / "Applications/Yulu.app"
    installed.mkdir(parents=True)
    (installed / "marker").write_text("new", encoding="utf-8")
    failed = restore_previous_application(
        installed_application=installed,
        previous_application=paths.previous_app_path,
        transaction_id=transaction_id,
        expected_identity=expected,
        expected_target_identity=target_identity,
        parent_pid=42,
        parent_generation=(1, 2),
        wait_for_exit=lambda *_: None,
        verify_application=verify,
        relaunch=lambda _: None,
    )
    resumed = restore_previous_application(
        installed_application=installed,
        previous_application=paths.previous_app_path,
        transaction_id=transaction_id,
        expected_identity=expected,
        expected_target_identity=target_identity,
        parent_pid=42,
        parent_generation=(1, 2),
        wait_for_exit=lambda *_: None,
        verify_application=verify,
        relaunch=lambda _: None,
    )
    assert resumed == failed
    assert (installed / "marker").read_text(encoding="utf-8") == "previous"
    assert (failed / "marker").read_text(encoding="utf-8") == "new"


@pytest.mark.parametrize("crash_point", ["after-copy", "after-swap"])
def test_rollback_recovery_resumes_from_each_whole_app_swap_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    crash_point: str,
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import restore_previous_application

    transaction_id = "e" * 32
    applications = tmp_path / "Applications"
    installed = applications / "Yulu.app"
    previous = tmp_path / "rollback/Yulu.app"
    staging = applications / f".Yulu.rollback.{transaction_id}.app"
    failed = applications / f".Yulu.failed.{transaction_id}.app"
    previous.mkdir(parents=True)
    (previous / "marker").write_text("previous", encoding="utf-8")
    installed.mkdir(parents=True)
    staging.mkdir()
    if crash_point == "after-copy":
        (installed / "marker").write_text("new", encoding="utf-8")
        (staging / "marker").write_text("previous", encoding="utf-8")
    else:
        (installed / "marker").write_text("previous", encoding="utf-8")
        (staging / "marker").write_text("new", encoding="utf-8")

    expected = {
        "identifier": "com.yulu.app",
        "teamIdentifier": "WMU9678ZQL",
        "cdHash": "a" * 40,
        "version": "0.23.0-rc.4",
        "build": "731",
    }
    target_identity = {
        **expected,
        "cdHash": "b" * 40,
        "version": "0.23.0",
        "build": "732",
    }

    def verify(application: Path) -> dict[str, object]:
        if (application / "marker").read_text(encoding="utf-8") == "previous":
            return expected
        return target_identity

    relaunched: list[Path] = []
    result = restore_previous_application(
        installed_application=installed,
        previous_application=previous,
        transaction_id=transaction_id,
        expected_identity=expected,
        expected_target_identity=target_identity,
        parent_pid=42,
        parent_generation=(1, 2),
        wait_for_exit=lambda *_: None,
        verify_application=verify,
        relaunch=relaunched.append,
    )

    assert result == failed
    assert (installed / "marker").read_text(encoding="utf-8") == "previous"
    assert (failed / "marker").read_text(encoding="utf-8") == "new"
    assert relaunched == [installed]


@pytest.mark.parametrize(
    ("recording", "reason"),
    [(True, "recording-active"), (None, "recording-unknown")],
)
def test_session_preflight_recording_defer_creates_no_update_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    recording: bool | None,
    reason: str,
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdatePaths, run_update_session

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    application = tmp_path / "Applications/Yulu.app"
    application.mkdir(parents=True)
    (application / "marker").write_text("unchanged", encoding="utf-8")
    database = paths.durable_root / "host.sqlite"
    database.parent.mkdir(parents=True, mode=0o700)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE durable (value TEXT)")
        connection.execute("INSERT INTO durable VALUES ('unchanged')")
    database.chmod(0o600)
    before_database = database.read_bytes()
    copy_calls: list[tuple[Path, Path]] = []
    output = io.StringIO()

    decision = run_update_session(
        paths=paths,
        application_path=application,
        current_version="0.23.0-rc.4",
        current_build="731",
        target_version="0.23.0",
        target_build="732",
        databases={"host": database},
        input_stream=io.StringIO(json.dumps({"recording": recording}) + "\n"),
        output_stream=output,
        copy_application=lambda source, destination: copy_calls.append(
            (source, destination)
        ),
    )

    assert decision == {"action": "defer_installation", "reason": reason}
    assert [json.loads(line) for line in output.getvalue().splitlines()] == [
        {"action": "observe_recording", "scope": "preflight"},
        {"action": "defer_installation", "reason": reason},
    ]
    assert not paths.journal_dir.exists()
    assert not paths.previous_app_path.exists()
    assert not paths.checkpoint_dir.exists()
    assert copy_calls == []
    assert database.read_bytes() == before_database
    assert (application / "marker").read_text(encoding="utf-8") == "unchanged"


def test_session_lock_held_recording_recheck_defers_before_update_journal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdatePaths, run_update_session

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    application = tmp_path / "Applications/Yulu.app"
    application.mkdir(parents=True)
    database = paths.durable_root / "host.sqlite"
    database.parent.mkdir(parents=True, mode=0o700)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE durable (value TEXT)")
    database.chmod(0o600)
    output = io.StringIO()

    decision = run_update_session(
        paths=paths,
        application_path=application,
        current_version="0.23.0-rc.4",
        current_build="731",
        target_version="0.23.0",
        target_build="732",
        databases={"host": database},
        input_stream=io.StringIO(
            json.dumps({"recording": False})
            + "\n"
            + json.dumps({"recording": True})
            + "\n"
        ),
        output_stream=output,
        copy_application=lambda *_: pytest.fail("snapshot must not start"),
    )

    assert decision == {
        "action": "defer_installation",
        "reason": "recording-active",
    }
    assert [json.loads(line) for line in output.getvalue().splitlines()] == [
        {"action": "observe_recording", "scope": "preflight"},
        {"action": "observe_recording", "scope": "locked"},
        {"action": "defer_installation", "reason": "recording-active"},
    ]
    assert not paths.journal_dir.exists()


@pytest.mark.parametrize(
    "phase",
    [
        "candidate_bound",
        "deferred_recording",
        "preparing",
        "previous_app_preserved",
        "services_quiesced",
        "install_authorized",
    ],
)
def test_pre_handler_restart_never_reuses_lost_install_handler(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    phase: str,
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    paths.journal_dir.mkdir(parents=True, mode=0o700)
    journal = {
        "schemaVersion": 1,
        "transactionId": "a" * 32,
        "nonce": "b" * 32,
        "phase": phase,
        "createdAt": "2026-08-31T00:00:00+00:00",
        "from": {"version": "0.23.0-rc.4", "build": "731"},
        "to": {"version": "0.23.0", "build": "732"},
        "intent": {"action": "crash-boundary"},
    }
    paths.journal_path.write_text(json.dumps(journal), encoding="utf-8")
    paths.journal_path.chmod(0o600)

    with ApplicationUpdate(paths) as authority:
        action = authority.resume(
            current_version="0.23.0-rc.4",
            current_build="731",
        )

    assert action["action"] == "register_services"
    assert action["restorePrevious"] is True
    assert json.loads(paths.journal_path.read_text())["phase"] == (
        "restoring_old_services"
    )


def test_target_host_never_starts_when_crash_boundary_has_no_data_checkpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    paths.journal_dir.mkdir(parents=True, mode=0o700)
    journal = {
        "schemaVersion": 1,
        "transactionId": "a" * 32,
        "nonce": "b" * 32,
        "phase": "preparing",
        "createdAt": "2026-08-31T00:00:00+00:00",
        "from": {"version": "0.23.0-rc.4", "build": "731"},
        "to": {"version": "0.23.0", "build": "732"},
        "intent": {"action": "preserve-previous-application"},
    }
    paths.journal_path.write_text(json.dumps(journal), encoding="utf-8")
    paths.journal_path.chmod(0o600)

    with ApplicationUpdate(paths) as authority:
        action = authority.resume(current_version="0.23.0", current_build="732")

    assert action == {
        "action": "blocked",
        "failure": "target-started-before-data-checkpoint",
    }


def test_pre_handler_recovery_requires_previous_runtime_health_before_terminal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    paths.journal_dir.mkdir(parents=True, mode=0o700)
    journal = {
        "schemaVersion": 1,
        "transactionId": "a" * 32,
        "nonce": "b" * 32,
        "phase": "restoring_old_services",
        "createdAt": "2026-08-31T00:00:00+00:00",
        "from": {"version": "0.23.0-rc.4", "build": "731"},
        "to": {"version": "0.23.0", "build": "732"},
        "failure": "pre-handler-session-lost",
        "intent": {"action": "register-services"},
    }
    paths.journal_path.write_text(json.dumps(journal), encoding="utf-8")
    paths.journal_path.chmod(0o600)
    statuses = {
        "com.yulu.ui.plist": "enabled",
        "com.yulu.audiodaemon.plist": "enabled",
    }

    with ApplicationUpdate(paths) as authority:
        verify = authority.observe_service_statuses(
            transaction_id=journal["transactionId"],
            nonce=journal["nonce"],
            statuses=statuses,
        )
        assert verify["action"] == "verify_previous_health"
        assert json.loads(paths.journal_path.read_text())["phase"] == (
            "previous_services_reconciled"
        )

        unhealthy = authority.observe_health(
            transaction_id=journal["transactionId"],
            nonce=journal["nonce"],
            health={"application": {"accepted": False}},
        )
        assert unhealthy["action"] == "blocked"
        assert json.loads(paths.journal_path.read_text())["phase"] == (
            "previous_health_failed"
        )


def test_previous_runtime_full_health_is_required_for_abort_terminal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    paths.journal_dir.mkdir(parents=True, mode=0o700)
    journal = {
        "schemaVersion": 1,
        "transactionId": "a" * 32,
        "nonce": "b" * 32,
        "phase": "previous_services_reconciled",
        "createdAt": "2026-08-31T00:00:00+00:00",
        "from": {"version": "0.23.0-rc.4", "build": "731"},
        "to": {"version": "0.23.0", "build": "732"},
        "failure": "pre-handler-session-lost",
        "recoveryTerminal": "update_aborted",
        "intent": {"action": "verify-previous-health"},
    }
    paths.journal_path.write_text(json.dumps(journal), encoding="utf-8")
    paths.journal_path.chmod(0o600)
    health = exact_update_health()
    health["application"]["version"] = "0.23.0-rc.4"
    health["application"]["build"] = "731"
    health["host"]["productVersion"] = "0.23.0-rc.4"
    health["host"]["bundleVersion"] = "731"
    health["capture"]["productVersion"] = "0.23.0-rc.4"
    health["capture"]["bundleVersion"] = "731"

    with ApplicationUpdate(paths) as authority:
        terminal = authority.observe_health(
            transaction_id=journal["transactionId"],
            nonce=journal["nonce"],
            health=health,
        )

    assert terminal == {
        "action": "aborted",
        "failure": "pre-handler-session-lost",
    }
    assert json.loads(paths.journal_path.read_text())["phase"] == "update_aborted"


@pytest.mark.parametrize(
    ("phase", "recovery_terminal", "expected_action"),
    [
        ("restoring_old_services", "update_aborted", "aborted"),
        ("rollback_swapped", None, "rolled_back"),
    ],
)
def test_session_dispatches_previous_health_to_terminal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    phase: str,
    recovery_terminal: str | None,
    expected_action: str,
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdatePaths, run_update_session

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    paths.journal_dir.mkdir(parents=True, mode=0o700)
    journal: dict[str, object] = {
        "schemaVersion": 1,
        "transactionId": "a" * 32,
        "nonce": "b" * 32,
        "phase": phase,
        "createdAt": "2026-08-31T00:00:00+00:00",
        "from": {"version": "0.23.0-rc.4", "build": "731"},
        "to": {"version": "0.23.0", "build": "732"},
        "failure": "pre-handler-session-lost",
        "intent": {"action": "register-services"},
    }
    if recovery_terminal is not None:
        journal["recoveryTerminal"] = recovery_terminal
    paths.journal_path.write_text(json.dumps(journal), encoding="utf-8")
    paths.journal_path.chmod(0o600)

    previous_health = exact_update_health()
    for component in ("application", "host", "capture"):
        version_key = "version" if component == "application" else "productVersion"
        build_key = "build" if component == "application" else "bundleVersion"
        previous_health[component][version_key] = "0.23.0-rc.4"
        previous_health[component][build_key] = "731"
    messages = io.StringIO(
        "\n".join(
            json.dumps(message)
            for message in [
                {"statuses": exact_update_health()["services"]},
                {"health": previous_health},
            ]
        )
        + "\n"
    )
    output = io.StringIO()

    terminal = run_update_session(
        paths=paths,
        application_path=tmp_path / "Applications/Yulu.app",
        current_version="0.23.0-rc.4",
        current_build="731",
        databases={},
        input_stream=messages,
        output_stream=output,
    )

    assert [
        json.loads(line)["action"] for line in output.getvalue().splitlines()
    ] == ["register_services", "verify_previous_health", expected_action]
    assert terminal["action"] == expected_action


def test_rollback_swap_stays_pending_until_restored_previous_health_passes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import ApplicationUpdate, ApplicationUpdatePaths

    paths = ApplicationUpdatePaths(
        durable_root=tmp_path / "Application Support/Yulu",
        cache_root=tmp_path / "Caches/Yulu",
    )
    paths.journal_dir.mkdir(parents=True, mode=0o700)
    journal = {
        "schemaVersion": 1,
        "transactionId": "a" * 32,
        "nonce": "b" * 32,
        "phase": "rollback_ready",
        "createdAt": "2026-08-31T00:00:00+00:00",
        "from": {"version": "0.23.0-rc.4", "build": "731"},
        "to": {"version": "0.23.0", "build": "732"},
        "previousApplication": {
            "identifier": "com.yulu.app",
            "teamIdentifier": "WMU9678ZQL",
            "cdHash": "a" * 40,
            "version": "0.23.0-rc.4",
            "build": "731",
        },
        "failedTargetApplication": {
            "identifier": "com.yulu.app",
            "teamIdentifier": "WMU9678ZQL",
            "cdHash": "b" * 40,
            "version": "0.23.0",
            "build": "732",
        },
        "intent": {"action": "launch-rollback-helper"},
    }
    paths.journal_path.write_text(json.dumps(journal), encoding="utf-8")
    paths.journal_path.chmod(0o600)
    failed = tmp_path / "Applications" / f".Yulu.failed.{journal['transactionId']}.app"

    with ApplicationUpdate(paths) as authority:
        pending = authority.complete_rollback(
            transaction_id=journal["transactionId"],
            nonce=journal["nonce"],
            failed_application=failed,
        )
        assert pending["action"] == "rollback_swapped"
        assert json.loads(paths.journal_path.read_text())["phase"] == "rollback_swapped"

        register = authority.resume(
            current_version="0.23.0-rc.4",
            current_build="731",
        )
        assert register["action"] == "register_services"
        assert register["restorePrevious"] is True
        verify = authority.observe_service_statuses(
            transaction_id=journal["transactionId"],
            nonce=journal["nonce"],
            statuses={
                "com.yulu.ui.plist": "enabled",
                "com.yulu.audiodaemon.plist": "enabled",
            },
        )
        assert verify["action"] == "verify_previous_health"
        health = exact_update_health()
        health["application"]["version"] = "0.23.0-rc.4"
        health["application"]["build"] = "731"
        health["host"]["productVersion"] = "0.23.0-rc.4"
        health["host"]["bundleVersion"] = "731"
        health["capture"]["productVersion"] = "0.23.0-rc.4"
        health["capture"]["bundleVersion"] = "731"
        terminal = authority.observe_health(
            transaction_id=journal["transactionId"],
            nonce=journal["nonce"],
            health=health,
        )
        assert terminal["action"] == "rolled_back"
        assert json.loads(paths.journal_path.read_text())["phase"] == "rolled_back"


def test_rollback_revalidates_failed_target_after_exit_before_any_swap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked
    from application_update import restore_previous_application

    transaction_id = "f" * 32
    installed = tmp_path / "Applications/Yulu.app"
    previous = tmp_path / "rollback/Yulu.app"
    installed.mkdir(parents=True)
    previous.mkdir(parents=True)
    (installed / "marker").write_text("manual-replacement", encoding="utf-8")
    (previous / "marker").write_text("previous", encoding="utf-8")
    previous_identity = {
        "identifier": "com.yulu.app",
        "teamIdentifier": "WMU9678ZQL",
        "cdHash": "a" * 40,
        "version": "0.23.0-rc.4",
        "build": "731",
    }
    target_identity = {
        "identifier": "com.yulu.app",
        "teamIdentifier": "WMU9678ZQL",
        "cdHash": "b" * 40,
        "version": "0.23.0",
        "build": "732",
    }

    def verify(application: Path) -> dict[str, object]:
        marker = (application / "marker").read_text(encoding="utf-8")
        if marker == "previous":
            return previous_identity
        if marker == "target":
            return target_identity
        return {**target_identity, "cdHash": "c" * 40}

    with pytest.raises(MigrationBlocked, match="failed target application changed"):
        restore_previous_application(
            installed_application=installed,
            previous_application=previous,
            transaction_id=transaction_id,
            expected_identity=previous_identity,
            expected_target_identity=target_identity,
            parent_pid=42,
            parent_generation=(1, 2),
            wait_for_exit=lambda *_: None,
            verify_application=verify,
            relaunch=lambda _: pytest.fail("must not relaunch"),
        )

    assert (installed / "marker").read_text(encoding="utf-8") == "manual-replacement"
    assert not (installed.parent / f".Yulu.rollback.{transaction_id}.app").exists()
    assert not (installed.parent / f".Yulu.failed.{transaction_id}.app").exists()


@pytest.mark.parametrize("attack", ["symlink", "hardlink", "wide-mode"])
def test_sqlite_checkpoint_rejects_unsafe_source_entry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    attack: str,
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, checkpoint_sqlite_database

    source_parent = tmp_path / "durable"
    destination_parent = tmp_path / "checkpoint"
    source_parent.mkdir(mode=0o700)
    destination_parent.mkdir(mode=0o700)
    real = source_parent / "real.sqlite"
    with sqlite3.connect(real) as connection:
        connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
    real.chmod(0o600)
    source = source_parent / "host.sqlite"
    if attack == "symlink":
        source.symlink_to(real.name)
    elif attack == "hardlink":
        os.link(real, source)
    else:
        real.rename(source)
        source.chmod(0o640)

    with pytest.raises(MigrationBlocked, match="SQLite checkpoint source is unsafe"):
        checkpoint_sqlite_database(
            source,
            destination_parent / "host.sqlite",
            "host",
        )
    assert not (destination_parent / "host.sqlite").exists()


def test_sqlite_checkpoint_detects_source_replacement_after_backup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, checkpoint_sqlite_database

    source_parent = tmp_path / "durable"
    destination_parent = tmp_path / "checkpoint"
    source_parent.mkdir(mode=0o700)
    destination_parent.mkdir(mode=0o700)
    source = source_parent / "host.sqlite"
    replacement = source_parent / "replacement.sqlite"
    for path in (source, replacement):
        with sqlite3.connect(path) as connection:
            connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
            connection.execute("INSERT INTO agent_tasks VALUES ('same-content')")
        path.chmod(0o600)

    def replace_after_backup() -> None:
        source.unlink()
        replacement.rename(source)

    with pytest.raises(MigrationBlocked, match="SQLite checkpoint source changed"):
        checkpoint_sqlite_database(
            source,
            destination_parent / "host.sqlite",
            "host",
            _after_backup=replace_after_backup,
        )


def test_sqlite_checkpoint_detects_destination_replacement_after_backup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, checkpoint_sqlite_database

    source_parent = tmp_path / "durable"
    destination_parent = tmp_path / "checkpoint"
    source_parent.mkdir(mode=0o700)
    destination_parent.mkdir(mode=0o700)
    source = source_parent / "host.sqlite"
    destination = destination_parent / "host.sqlite"
    replacement = destination_parent / "replacement.sqlite"
    for path in (source, replacement):
        with sqlite3.connect(path) as connection:
            connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
        path.chmod(0o600)

    def replace_after_backup() -> None:
        destination.unlink()
        replacement.rename(destination)

    with pytest.raises(MigrationBlocked, match="SQLite checkpoint destination changed"):
        checkpoint_sqlite_database(
            source,
            destination,
            "host",
            _after_backup=replace_after_backup,
        )


def test_sqlite_checkpoint_recovers_committed_row_left_only_in_wal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import checkpoint_sqlite_database

    source_parent = tmp_path / "durable"
    destination_parent = tmp_path / "checkpoint"
    source_parent.mkdir(mode=0o700)
    destination_parent.mkdir(mode=0o700)
    source = source_parent / "host.sqlite"
    destination = destination_parent / "host.sqlite"
    with sqlite3.connect(source) as connection:
        assert connection.execute("PRAGMA journal_mode=WAL").fetchone() == ("wal",)
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
        connection.commit()
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        connection.execute("INSERT INTO agent_tasks VALUES ('wal-only')")
        connection.commit()
        source.chmod(0o600)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(source) + suffix)
            assert sidecar.exists()
            sidecar.chmod(0o600)

        checkpoint_sqlite_database(source, destination, "host")
        assert list(destination_parent.glob(".sqlite-stage.*")) == []

    with sqlite3.connect(destination) as checkpoint:
        assert checkpoint.execute("SELECT id FROM agent_tasks").fetchall() == [
            ("wal-only",)
        ]


@pytest.mark.parametrize(
    ("suffix", "attack"),
    [("-wal", "symlink"), ("-wal", "hardlink"), ("-shm", "symlink"), ("-shm", "hardlink")],
)
def test_sqlite_checkpoint_rejects_unsafe_wal_triplet_entries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    suffix: str,
    attack: str,
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, checkpoint_sqlite_database

    source_parent = tmp_path / "durable"
    destination_parent = tmp_path / "checkpoint"
    source_parent.mkdir(mode=0o700)
    destination_parent.mkdir(mode=0o700)
    source = source_parent / "host.sqlite"
    with sqlite3.connect(source) as connection:
        connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
    source.chmod(0o600)
    outside = tmp_path / "outside-sidecar"
    outside.write_bytes(b"outside")
    outside.chmod(0o600)
    sidecar = Path(str(source) + suffix)
    if attack == "symlink":
        sidecar.symlink_to(outside)
    else:
        os.link(outside, sidecar)

    with pytest.raises(MigrationBlocked, match="SQLite checkpoint source is unsafe"):
        checkpoint_sqlite_database(
            source,
            destination_parent / "host.sqlite",
            "host",
        )


@pytest.mark.parametrize("suffix", ["-wal", "-shm"])
@pytest.mark.parametrize("attack", ["replacement", "content"])
@pytest.mark.parametrize("boundary", ["capture", "backup"])
def test_sqlite_checkpoint_detects_sidecar_race_at_each_triplet_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    suffix: str,
    attack: str,
    boundary: str,
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, checkpoint_sqlite_database

    source_parent = tmp_path / "durable"
    destination_parent = tmp_path / "checkpoint"
    source_parent.mkdir(mode=0o700)
    destination_parent.mkdir(mode=0o700)
    source = source_parent / "host.sqlite"
    connection = sqlite3.connect(source)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
        connection.execute("INSERT INTO agent_tasks VALUES ('before-race')")
        connection.commit()
        source.chmod(0o600)
        wal = Path(str(source) + "-wal")
        shm = Path(str(source) + "-shm")
        wal.chmod(0o600)
        shm.chmod(0o600)

        def race() -> None:
            sidecar = Path(str(source) + suffix)
            if attack == "replacement":
                captured = sidecar.read_bytes()
                sidecar.unlink()
                sidecar.write_bytes(captured)
                sidecar.chmod(0o600)
            else:
                with sidecar.open("r+b") as handle:
                    original = handle.read(1)
                    handle.seek(0)
                    handle.write(bytes([original[0] ^ 0x01]))
                    handle.flush()
                    os.fsync(handle.fileno())

        with pytest.raises(MigrationBlocked, match="SQLite checkpoint source changed"):
            checkpoint_sqlite_database(
                source,
                destination_parent / "host.sqlite",
                "host",
                _after_source_capture=race if boundary == "capture" else lambda: None,
                _after_backup=race if boundary == "backup" else lambda: None,
            )
        assert list(destination_parent.glob(".sqlite-stage.*")) == []
    finally:
        connection.close()


def test_sqlite_checkpoint_without_wal_triplet_still_passes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import checkpoint_sqlite_database

    source_parent = tmp_path / "durable"
    destination_parent = tmp_path / "checkpoint"
    source_parent.mkdir(mode=0o700)
    destination_parent.mkdir(mode=0o700)
    source = source_parent / "host.sqlite"
    destination = destination_parent / "host.sqlite"
    with sqlite3.connect(source) as connection:
        connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
        connection.execute("INSERT INTO agent_tasks VALUES ('main-only')")
    source.chmod(0o600)
    assert not Path(str(source) + "-wal").exists()
    assert not Path(str(source) + "-shm").exists()

    checkpoint_sqlite_database(source, destination, "host")
    assert list(destination_parent.glob(".sqlite-stage.*")) == []

    with sqlite3.connect(destination) as checkpoint:
        assert checkpoint.execute("SELECT id FROM agent_tasks").fetchone() == (
            "main-only",
        )


@pytest.mark.parametrize("attack", ["symlink", "hardlink"])
def test_sqlite_checkpoint_rejects_occupied_unsafe_destination_entry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    attack: str,
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, checkpoint_sqlite_database

    source_parent = tmp_path / "durable"
    destination_parent = tmp_path / "checkpoint"
    source_parent.mkdir(mode=0o700)
    destination_parent.mkdir(mode=0o700)
    source = source_parent / "host.sqlite"
    destination = destination_parent / "host.sqlite"
    with sqlite3.connect(source) as connection:
        connection.execute("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY)")
    source.chmod(0o600)
    if attack == "symlink":
        destination.symlink_to(source)
    else:
        occupied = destination_parent / "occupied.sqlite"
        occupied.write_bytes(b"occupied")
        occupied.chmod(0o600)
        os.link(occupied, destination)

    with pytest.raises(MigrationBlocked, match="SQLite checkpoint destination is unsafe"):
        checkpoint_sqlite_database(source, destination, "host")
