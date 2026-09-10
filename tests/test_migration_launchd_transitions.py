"""Exercise launchd's asynchronous removal and rollback on isolated fixtures."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture
def migration_case(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "yulu/scripts"))
    import application_migration as migration

    agents = tmp_path / "LaunchAgents"
    agents.mkdir(mode=0o755)
    plist = agents / "com.yulu.ui.plist"
    plist.write_bytes(b"original legacy Host plist\n")
    plist.chmod(0o644)
    legacy = tmp_path / "legacy"
    legacy.mkdir(mode=0o700)
    (legacy / "config.json").write_text("{}\n")
    paths = migration.MigrationPaths(tmp_path / "durable", tmp_path / "cache")
    archive = tmp_path / "archive"
    loaded = {"com.yulu.ui"}
    pending_stop = {}
    pending_start = {}
    events = []
    delays = {"bootout": 3, "bootstrap": 2}

    def launchctl(arguments):
        events.append(tuple(arguments))
        action = arguments[0]
        if action == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        label = arguments[-1].rsplit("/", 1)[-1]
        if action == "bootout":
            pending_stop[label] = delays["bootout"]
        elif action == "bootstrap":
            pending_start[Path(arguments[-1]).stem] = delays["bootstrap"]
        elif action == "print":
            for pending, is_start in ((pending_stop, False), (pending_start, True)):
                if label in pending:
                    if pending[label] == 0:
                        del pending[label]
                        (loaded.add if is_start else loaded.discard)(label)
                    else:
                        pending[label] -= 1
            return SimpleNamespace(
                returncode=0 if label in loaded else 113, stdout="", stderr=""
            )
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    snapshot = migration.snapshot_legacy_jobs(agents, launchctl=launchctl)
    with migration.ApplicationMigration(paths) as authority:
        authority.begin()
        snapshot = authority.record_job_snapshot(snapshot)
    common = dict(
        paths=paths,
        home_dir=tmp_path,
        legacy_root=legacy,
        launch_agents_dir=agents,
        archive_dir=archive,
        legacy_capture_socket=legacy / "audio_daemon.sock",
        node_executable=tmp_path / "unused-node",
        server_js=tmp_path / "unused-server.js",
        launchctl=launchctl,
    )
    return SimpleNamespace(
        migration=migration, paths=paths, agents=agents, plist=plist,
        archive=archive, loaded=loaded, delays=delays, events=events,
        pending_stop=pending_stop, launchctl=launchctl, snapshot=snapshot,
        common=common,
    )


def test_quiesce_and_rollback_wait_for_asynchronous_launchd_states(migration_case):
    case = migration_case
    with case.migration.ApplicationMigration(case.paths) as authority:
        authority.quiesce_legacy_jobs(
            case.snapshot, launch_agents_dir=case.agents,
            archive_dir=case.archive, launchctl=case.launchctl,
        )
        assert case.loaded == set()
        assert not case.plist.exists()
        assert "pendingLegacyBootout" not in authority._journal
        authority.rollback_legacy_jobs(
            case.snapshot, launch_agents_dir=case.agents,
            archive_dir=case.archive, launchctl=case.launchctl,
        )
    assert case.loaded == {"com.yulu.ui"}
    assert case.plist.read_bytes() == b"original legacy Host plist\n"
    assert case.plist.stat().st_mode & 0o777 == 0o644
    assert json.loads(case.paths.journal_path.read_text())["phase"] == "rolled_back"
    assert sum(event[0] == "bootout" for event in case.events) == 1
    assert sum(event[0] == "bootstrap" for event in case.events) == 1


def test_timed_out_bootout_is_settled_before_rollback_bootstrap(migration_case, monkeypatch):
    case = migration_case
    monkeypatch.setattr(case.migration, "_LEGACY_JOB_TRANSITION_TIMEOUT_SECONDS", 0)
    with case.migration.ApplicationMigration(case.paths) as authority:
        with pytest.raises(case.migration.MigrationBlocked, match="did not stop"):
            authority.quiesce_legacy_jobs(
                case.snapshot, launch_agents_dir=case.agents,
                archive_dir=case.archive, launchctl=case.launchctl,
            )
        assert authority._journal["pendingLegacyBootout"] == "com.yulu.ui"
        assert case.plist.exists()
        assert not case.archive.exists()
        # The previous bootout is still removing the old service. Merely seeing
        # it loaded must not make rollback skip the eventual bootstrap.
        assert case.loaded == {"com.yulu.ui"}
        monkeypatch.setattr(case.migration, "_LEGACY_JOB_TRANSITION_TIMEOUT_SECONDS", 2)
        authority.rollback_legacy_jobs(
            case.snapshot, launch_agents_dir=case.agents,
            archive_dir=case.archive, launchctl=case.launchctl,
        )
        assert authority._journal["phase"] == "rolled_back"
        assert "pendingLegacyBootout" not in authority._journal
        retry = authority.begin_retry(archive_dir=case.archive)
        assert retry["attemptNumber"] == 2
    assert case.loaded == {"com.yulu.ui"}
    assert sum(event[0] == "bootstrap" for event in case.events) == 1


def test_unknown_launchctl_state_fails_closed_without_archiving(migration_case):
    case = migration_case

    def launchctl(arguments):
        if arguments[0] == "print":
            return SimpleNamespace(returncode=77, stdout="", stderr="not authorized")
        return case.launchctl(arguments)

    with case.migration.ApplicationMigration(case.paths) as authority:
        with pytest.raises(case.migration.MigrationBlocked):
            authority.quiesce_legacy_jobs(
                case.snapshot, launch_agents_dir=case.agents,
                archive_dir=case.archive, launchctl=launchctl,
            )
    assert case.plist.exists()
    assert not case.archive.exists()


def test_pre_registration_blocked_rollback_recovers_then_allows_retry(migration_case):
    case = migration_case
    case.loaded.clear()
    with case.migration.ApplicationMigration(case.paths) as authority:
        authority.transition("rollback_blocked", intent={
            "action": "manual-remediation",
            "detail": "legacy job state was not restored: com.yulu.ui",
        })
        previous_id = authority._journal["transactionId"]

    action = case.migration.run_migration_step(**case.common)
    assert action == {"action": "rolled_back"}
    assert case.loaded == {"com.yulu.ui"}
    with case.migration.ApplicationMigration(case.paths) as authority:
        retry = authority.begin_retry(archive_dir=case.archive)
    assert retry["retryOf"] == previous_id
    assert retry["attemptNumber"] == 2
    assert case.plist.read_bytes() == b"original legacy Host plist\n"


def test_blocked_registered_rollback_requires_bundled_unregister_proof(migration_case):
    case = migration_case
    case.loaded.clear()
    with case.migration.ApplicationMigration(case.paths) as authority:
        authority.transition("data_published", intent={"action": "test-ready"})
        registration = authority.request_registration()
        authority.transition("rollback_blocked", intent={"action": "manual-service-remediation"})

    action = case.migration.run_migration_step(**case.common)
    assert action["action"] == "unregister_services"
    assert action["transactionId"] == registration["transactionId"]
    assert action["nonce"] == registration["nonce"]
    assert not any(event[0] == "bootstrap" for event in case.events)
    with pytest.raises(case.migration.MigrationBlocked, match="registered services remain"):
        case.migration.run_migration_step(**case.common, observation={
            "kind": "services", "transactionId": action["transactionId"],
            "nonce": action["nonce"], "statuses": {
                "com.yulu.ui.plist": "enabled",
                "com.yulu.audiodaemon.plist": "notRegistered",
            },
        })
    assert not any(event[0] == "bootstrap" for event in case.events)

    action = case.migration.run_migration_step(**case.common)
    recovered = case.migration.run_migration_step(**case.common, observation={
        "kind": "services", "transactionId": action["transactionId"],
        "nonce": action["nonce"], "statuses": {
            "com.yulu.ui.plist": "notRegistered",
            "com.yulu.audiodaemon.plist": "notRegistered",
        },
    })
    assert recovered["action"] == "rolled_back"
    assert case.loaded == {"com.yulu.ui"}


def test_blocked_rollback_does_not_restore_changed_plist(migration_case):
    case = migration_case
    case.loaded.clear()
    with case.migration.ApplicationMigration(case.paths) as authority:
        authority.transition("rollback_blocked", intent={"action": "manual-remediation"})
    case.plist.write_bytes(b"user changed this plist\n")
    with pytest.raises(case.migration.MigrationBlocked, match="destination is occupied"):
        case.migration.run_migration_step(**case.common)
    assert not any(event[0] == "bootstrap" for event in case.events)
    assert case.plist.read_bytes() == b"user changed this plist\n"


def test_blocked_recovery_does_not_interrupt_a_new_recording(migration_case, monkeypatch):
    case = migration_case
    with case.migration.ApplicationMigration(case.paths) as authority:
        authority.transition("rollback_blocked", intent={"action": "manual-remediation"})
    before = case.paths.journal_path.read_bytes()

    def recording_active(_snapshot, _socket_path):
        raise case.migration.MigrationBlocked("legacy Capture recording is active")

    monkeypatch.setattr(case.migration, "assert_legacy_capture_idle", recording_active)
    with pytest.raises(case.migration.MigrationBlocked, match="recording is active"):
        case.migration.run_migration_step(**case.common)
    assert case.paths.journal_path.read_bytes() == before
    assert not any(event[0] in {"enable", "disable", "bootstrap", "bootout"}
                   for event in case.events)
