from pathlib import Path
import fcntl
import hashlib
import io
import json
import os
import plistlib
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest


SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"


def development_code_identity(identifier: str) -> dict[str, object]:
    return {
        "accepted": True,
        "identifier": identifier,
        "teamIdentifier": "adhoc",
        "cdHash": "a" * 40,
        "staticSealValid": True,
        "dynamicValid": True,
        "staticDynamicMatch": True,
    }


def test_bundled_python_cli_rejects_short_step_lock_bypass(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import ApplicationMigration, MigrationPaths

    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.transition("rolled_back", intent={"action": "test-complete"})

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "application_migration.py"),
            "step",
            "--home",
            str(tmp_path),
            "--durable",
            str(paths.durable_root),
            "--cache",
            str(paths.cache_root),
            "--legacy",
            str(tmp_path / "legacy"),
            "--launch-agents",
            str(tmp_path / "LaunchAgents"),
            "--archive",
            str(tmp_path / "archive"),
            "--capture-socket",
            str(tmp_path / "capture.sock"),
            "--node",
            str(tmp_path / "node"),
            "--server",
            str(tmp_path / "server.js"),
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    assert "invalid choice: 'step'" in result.stderr


def test_python_session_holds_one_attempt_lock_until_process_exit(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import ApplicationMigration, MigrationPaths

    legacy = tmp_path / "legacy"
    legacy.mkdir(mode=0o700)
    (legacy / "config.json").write_text("{}\n")
    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.transition("data_published", intent={"action": "test-ready"})
        registration = authority.request_registration()
        authority.observe_service_statuses(
            transaction_id=registration["transactionId"],
            nonce=registration["nonce"],
            statuses={
                "com.yulu.ui.plist": "requiresApproval",
                "com.yulu.audiodaemon.plist": "requiresApproval",
            },
        )

    arguments = [
        sys.executable,
        str(SCRIPTS / "application_migration.py"),
        "session",
        "--home", str(tmp_path),
        "--durable", str(paths.durable_root),
        "--cache", str(paths.cache_root),
        "--legacy", str(legacy),
        "--launch-agents", str(tmp_path / "LaunchAgents"),
        "--archive", str(tmp_path / "archive"),
        "--capture-socket", str(legacy / "audio_daemon.sock"),
        "--node", str(tmp_path / "node"),
        "--server", str(tmp_path / "server.js"),
        "--app", str(tmp_path / "Yulu.app"),
    ]
    first = subprocess.Popen(
        arguments,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        first_action = json.loads(first.stdout.readline())
        assert first_action["action"] == "observe_services"
        journal_before = paths.journal_path.read_bytes()
        second = subprocess.run(
            arguments,
            input="",
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
        )
        assert second.returncode == 75
        assert json.loads(second.stdout) == {"action": "busy"}
        assert paths.journal_path.read_bytes() == journal_before
        assert first.poll() is None
    finally:
        first.kill()
        first.wait(timeout=5)


def test_existing_journal_without_legacy_markers_is_busy_then_recovers(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationPaths,
        run_migration_session,
    )

    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.transition("guarded", intent={"action": "test-recovery"})

    journal_before = paths.journal_path.read_bytes()
    attempt_fd = os.open(
        paths.attempt_lock_path,
        os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
        0o600,
    )
    fcntl.flock(attempt_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(returncode=113, stdout="", stderr="")

    arguments = {
        "paths": paths,
        "home_dir": tmp_path / "empty-home",
        "legacy_root": tmp_path / "missing-legacy",
        "launch_agents_dir": tmp_path / "missing-agents",
        "archive_dir": tmp_path / "archive",
        "legacy_capture_socket": tmp_path / "missing.sock",
        "node_executable": tmp_path / "missing-node",
        "server_js": tmp_path / "missing-server.js",
        "launchctl": launchctl,
        "input_stream": io.BytesIO(),
    }
    busy_output = io.BytesIO()
    try:
        busy = run_migration_session(output_stream=busy_output, **arguments)
    finally:
        os.close(attempt_fd)

    assert busy == 75
    assert json.loads(busy_output.getvalue()) == {"action": "busy"}
    assert paths.journal_path.read_bytes() == journal_before

    recovery_output = io.BytesIO()
    recovered = run_migration_session(output_stream=recovery_output, **arguments)

    assert recovered == 0
    assert json.loads(recovery_output.getvalue()) == {"action": "rolled_back"}
    assert json.loads(paths.journal_path.read_text())["phase"] == "rolled_back"


def test_attempt_lock_rejects_a_hardlinked_external_file_without_mutation(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, MigrationPaths, run_migration_session

    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    paths.lock_dir.mkdir(parents=True, mode=0o700)
    outside = tmp_path / "outside.lock"
    outside.write_bytes(b"external")
    outside.chmod(0o644)
    os.link(outside, paths.attempt_lock_path)

    with pytest.raises(MigrationBlocked, match="attempt lock"):
        run_migration_session(
            paths=paths,
            step=lambda **_arguments: {"action": "rolled_back"},
            input_stream=io.BytesIO(),
            output_stream=io.BytesIO(),
        )

    assert outside.read_bytes() == b"external"
    assert outside.stat().st_mode & 0o777 == 0o644


def test_empty_home_takes_fresh_install_path_without_any_migration_mutation(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationPaths, run_migration_session

    home = tmp_path / "empty-home"
    durable = home / "Library/Application Support/Yulu"
    cache = home / "Library/Caches/Yulu"
    legacy = home / ".config/yulu"
    agents = home / "Library/LaunchAgents"
    output = io.BytesIO()

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(returncode=113, stdout="", stderr="")

    result = run_migration_session(
        paths=MigrationPaths(durable_root=durable, cache_root=cache),
        home_dir=home,
        legacy_root=legacy,
        launch_agents_dir=agents,
        archive_dir=durable / "application-migration/rollback/LaunchAgents",
        legacy_capture_socket=legacy / "audio_daemon.sock",
        node_executable=tmp_path / "missing-node",
        server_js=tmp_path / "missing-server.js",
        launchctl=launchctl,
        input_stream=io.BytesIO(),
        output_stream=output,
    )

    assert result == 0
    assert json.loads(output.getvalue()) == {"action": "fresh_install"}
    assert not home.exists()
    assert not durable.exists()
    assert not cache.exists()
    assert not legacy.exists()
    assert not agents.exists()


def test_disabled_state_residue_without_legacy_artifacts_is_fresh_install(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        LEGACY_JOB_LABELS,
        MigrationPaths,
        run_migration_session,
    )

    home = tmp_path / "empty-home"
    durable = home / "Library/Application Support/Yulu"
    cache = home / "Library/Caches/Yulu"
    legacy = home / ".config/yulu"
    agents = home / "Library/LaunchAgents"
    output = io.BytesIO()
    commands = []

    def launchctl(arguments):
        commands.append(arguments)
        if arguments[0] == "print-disabled":
            return SimpleNamespace(
                returncode=0,
                stdout=(
                    'disabled services = {\n'
                    '"com.yulu.ui" => false\n'
                    '"com.yulu.audiodaemon" => true\n'
                    "}"
                ),
                stderr="",
            )
        return SimpleNamespace(returncode=113, stdout="", stderr="")

    result = run_migration_session(
        paths=MigrationPaths(durable_root=durable, cache_root=cache),
        home_dir=home,
        legacy_root=legacy,
        launch_agents_dir=agents,
        archive_dir=durable / "application-migration/rollback/LaunchAgents",
        legacy_capture_socket=legacy / "audio_daemon.sock",
        node_executable=tmp_path / "missing-node",
        server_js=tmp_path / "missing-server.js",
        launchctl=launchctl,
        input_stream=io.BytesIO(),
        output_stream=output,
    )

    assert result == 0
    assert json.loads(output.getvalue()) == {"action": "fresh_install"}
    assert commands == [
        ["print-disabled", f"gui/{os.geteuid()}"],
        *[
            ["print", f"gui/{os.geteuid()}/{label}"]
            for label in LEGACY_JOB_LABELS
        ],
    ]
    assert not home.exists()
    assert not durable.exists()
    assert not cache.exists()
    assert not legacy.exists()
    assert not agents.exists()


def test_loaded_legacy_job_without_files_still_requires_migration(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import LEGACY_JOB_LABELS, legacy_install_present

    loaded_label = LEGACY_JOB_LABELS[0]

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        label = arguments[-1].rsplit("/", 1)[-1]
        return SimpleNamespace(
            returncode=0 if label == loaded_label else 113,
            stdout="service" if label == loaded_label else "",
            stderr="",
        )

    assert legacy_install_present(
        legacy_root=tmp_path / "missing-legacy",
        launch_agents_dir=tmp_path / "missing-launch-agents",
        launchctl=launchctl,
    )


def test_python_session_stdin_eof_compensates_before_releasing_attempt_lock(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationPaths, run_migration_session

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    agents = tmp_path / "LaunchAgents"
    archive = tmp_path / "archive"
    for directory in (legacy, durable, agents):
        directory.mkdir(mode=0o700)
    (legacy / "config.json").write_text("{}\n")
    plist_bytes = b"legacy ui plist\n"
    (agents / "com.yulu.ui.plist").write_bytes(plist_bytes)
    loaded = {"com.yulu.ui"}

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        label = arguments[-1].rsplit("/", 1)[-1]
        if arguments[0] == "print":
            return SimpleNamespace(
                returncode=0 if label in loaded else 113, stdout="", stderr=""
            )
        if arguments[0] == "bootout":
            loaded.discard(label)
        elif arguments[0] == "bootstrap":
            loaded.add(Path(arguments[-1]).stem)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    node = tmp_path / "node"
    server_js = tmp_path / "server.js"
    node.write_bytes(b"node")
    server_js.write_bytes(b"server")

    def run_node(_arguments, **_options):
        (durable / "config.json").write_text("{}\n")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    read_fd, write_fd = os.pipe()
    os.close(write_fd)
    input_stream = os.fdopen(read_fd, "rb", buffering=0)
    service_actions = []

    def unregister(action):
        service_actions.append(action)
        return {
            "com.yulu.ui.plist": "notRegistered",
            "com.yulu.audiodaemon.plist": "notFound",
        }

    try:
        result = run_migration_session(
            paths=MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache"),
            home_dir=tmp_path,
            legacy_root=legacy,
            launch_agents_dir=agents,
            archive_dir=archive,
            legacy_capture_socket=legacy / "audio_daemon.sock",
            node_executable=node,
            server_js=server_js,
            launchctl=launchctl,
            run_node=run_node,
            input_stream=input_stream,
            output_stream=io.BytesIO(),
            service_adapter=unregister,
        )
    finally:
        input_stream.close()

    assert result == 0
    assert service_actions[0]["action"] == "unregister_services"
    assert (agents / "com.yulu.ui.plist").read_bytes() == plist_bytes
    assert loaded == {"com.yulu.ui"}
    journal = json.loads(
        (durable / "application-migration/journal.json").read_text()
    )
    assert journal["phase"] == "rolled_back"


def test_service_rollback_adapter_uses_the_installed_app_and_bounded_json(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import run_bundled_service_adapter

    app = tmp_path / "Yulu.app"
    executable = app / "Contents/MacOS/yulu_app"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"app")
    action = {
        "action": "unregister_services",
        "transactionId": "transaction-123",
        "nonce": "nonce-123",
        "services": ["com.yulu.ui.plist", "com.yulu.audiodaemon.plist"],
    }
    observed = {}

    def run(arguments, **options):
        observed["arguments"] = arguments
        observed["options"] = options
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                {
                    "statuses": {
                        "com.yulu.ui.plist": "notRegistered",
                        "com.yulu.audiodaemon.plist": "notFound",
                    }
                }
            )
            + "\n",
            stderr="",
        )

    statuses = run_bundled_service_adapter(
        action,
        app_bundle=app,
        run=run,
    )

    assert observed["arguments"] == [
        str(executable),
        "--apply-migration-service-action",
        json.dumps(action, sort_keys=True, separators=(",", ":")),
    ]
    assert observed["options"]["timeout"] == 15
    assert statuses == {
        "com.yulu.ui.plist": "notRegistered",
        "com.yulu.audiodaemon.plist": "notFound",
    }


@pytest.mark.parametrize(
    "payload",
    [
        b"[]\n",
        b'{"transactionId":"stale","nonce":"nonce-123","event":"cancel"}\n',
        b'{"transactionId":"transaction-123","nonce":"nonce-123","observation":[]}\n',
        b"x" * (64 * 1024 + 1),
    ],
)
def test_session_protocol_failure_compensates_under_the_attempt_lock(
    tmp_path, monkeypatch, payload
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationPaths, run_migration_session

    calls = []

    def step(**arguments):
        calls.append(arguments)
        if len(calls) == 1:
            return {
                "action": "register_services",
                "transactionId": "transaction-123",
                "nonce": "nonce-123",
            }
        if arguments.get("event") == "cancel":
            return {
                "action": "unregister_services",
                "transactionId": "transaction-123",
                "nonce": "nonce-123",
                "services": [
                    "com.yulu.ui.plist",
                    "com.yulu.audiodaemon.plist",
                ],
            }
        assert arguments["observation"]["kind"] == "services"
        return {"action": "rolled_back"}

    with tempfile.TemporaryFile() as input_stream:
        input_stream.write(payload)
        input_stream.seek(0)
        result = run_migration_session(
            paths=MigrationPaths(
                durable_root=tmp_path / "durable",
                cache_root=tmp_path / "cache",
            ),
            step=step,
            input_stream=input_stream,
            output_stream=io.BytesIO(),
            service_adapter=lambda _action: {
                "com.yulu.ui.plist": "notRegistered",
                "com.yulu.audiodaemon.plist": "notFound",
            },
        )

    assert result == 0
    assert calls[1]["event"] == "cancel"
    assert calls[2]["observation"]["statuses"]["com.yulu.ui.plist"] == "notRegistered"


def test_session_response_timeout_compensates_under_the_attempt_lock(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationPaths, run_migration_session

    calls = []

    def step(**arguments):
        calls.append(arguments)
        if len(calls) == 1:
            return {
                "action": "register_services",
                "transactionId": "transaction-123",
                "nonce": "nonce-123",
            }
        if arguments.get("event") == "cancel":
            return {
                "action": "unregister_services",
                "transactionId": "transaction-123",
                "nonce": "nonce-123",
                "services": [
                    "com.yulu.ui.plist",
                    "com.yulu.audiodaemon.plist",
                ],
            }
        assert arguments["observation"]["kind"] == "services"
        return {"action": "rolled_back"}

    read_fd, write_fd = os.pipe()
    input_stream = os.fdopen(read_fd, "rb", buffering=0)
    try:
        result = run_migration_session(
            paths=MigrationPaths(
                durable_root=tmp_path / "durable",
                cache_root=tmp_path / "cache",
            ),
            step=step,
            input_stream=input_stream,
            output_stream=io.BytesIO(),
            response_timeout_seconds=0.01,
            service_adapter=lambda _action: {
                "com.yulu.ui.plist": "notRegistered",
                "com.yulu.audiodaemon.plist": "notFound",
            },
        )
    finally:
        os.close(write_fd)
        input_stream.close()

    assert result == 0
    assert calls[1]["event"] == "cancel"
    assert calls[2]["observation"]["kind"] == "services"


def test_awaiting_approval_uses_its_bound_ten_minute_deadline(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import application_migration
    from application_migration import MigrationPaths, run_migration_session

    now = datetime(2026, 8, 30, tzinfo=timezone.utc)
    observed_timeout = []
    calls = []

    def step(**arguments):
        calls.append(arguments)
        if len(calls) == 1:
            return {
                "action": "await_approval",
                "transactionId": "transaction-123",
                "nonce": "nonce-123",
                "deadlineAt": (now + timedelta(minutes=10)).isoformat(),
            }
        if arguments.get("event") == "resume":
            return {
                "action": "unregister_services",
                "transactionId": "transaction-123",
                "nonce": "nonce-123",
                "services": [
                    "com.yulu.ui.plist",
                    "com.yulu.audiodaemon.plist",
                ],
            }
        assert arguments["observation"]["kind"] == "services"
        return {"action": "rolled_back"}

    selection_count = 0

    def select_once(read, _write, _errors, timeout):
        nonlocal selection_count
        selection_count += 1
        observed_timeout.append(timeout)
        return ([], [], []) if selection_count == 1 else (read, [], [])

    monkeypatch.setattr(application_migration.select, "select", select_once)
    message = {
        "transactionId": "transaction-123",
        "nonce": "nonce-123",
        "observation": {
            "kind": "services",
            "transactionId": "transaction-123",
            "nonce": "nonce-123",
            "statuses": {
                "com.yulu.ui.plist": "notRegistered",
                "com.yulu.audiodaemon.plist": "notFound",
            },
        },
    }
    with tempfile.TemporaryFile() as input_stream:
        input_stream.write((json.dumps(message) + "\n").encode())
        input_stream.seek(0)
        result = run_migration_session(
            paths=MigrationPaths(
                durable_root=tmp_path / "durable",
                cache_root=tmp_path / "cache",
            ),
            step=step,
            input_stream=input_stream,
            output_stream=io.BytesIO(),
            response_timeout_seconds=30,
            session_now=lambda: now,
        )

    assert result == 0
    assert observed_timeout == [600.0, 30]
    assert calls[1]["event"] == "resume"


def test_broken_swift_output_pipe_compensates_before_releasing_attempt_lock(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationPaths, run_migration_session

    calls = []

    def step(**arguments):
        calls.append(arguments)
        if len(calls) == 1:
            return {
                "action": "register_services",
                "transactionId": "transaction-123",
                "nonce": "nonce-123",
            }
        if arguments.get("event") == "cancel":
            return {
                "action": "unregister_services",
                "transactionId": "transaction-123",
                "nonce": "nonce-123",
                "services": [
                    "com.yulu.ui.plist",
                    "com.yulu.audiodaemon.plist",
                ],
            }
        return {"action": "rolled_back"}

    class BrokenOutput:
        def write(self, _payload):
            raise BrokenPipeError("Swift exited")

        def flush(self):
            raise AssertionError("flush must not follow a failed write")

    result = run_migration_session(
        paths=MigrationPaths(
            durable_root=tmp_path / "durable",
            cache_root=tmp_path / "cache",
        ),
        step=step,
        input_stream=io.BytesIO(),
        output_stream=BrokenOutput(),
        service_adapter=lambda _action: {
            "com.yulu.ui.plist": "notRegistered",
            "com.yulu.audiodaemon.plist": "notFound",
        },
    )

    assert result == 0
    assert calls[1]["event"] == "cancel"
    assert calls[2]["observation"]["kind"] == "services"


def test_loaded_legacy_capture_without_a_socket_blocks_migration(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        CaptureJobSnapshot,
        MigrationBlocked,
        assert_legacy_capture_idle,
    )

    with pytest.raises(MigrationBlocked, match="cannot prove legacy Capture is idle"):
        assert_legacy_capture_idle(
            CaptureJobSnapshot(loaded=True, executable=Path("/legacy/audio_daemon")),
            tmp_path / "missing.sock",
        )


def test_loaded_legacy_capture_requires_the_snapshotted_executable(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        CaptureJobSnapshot,
        MigrationBlocked,
        assert_legacy_capture_idle,
    )

    with tempfile.TemporaryDirectory(prefix="yulu-mig-", dir="/tmp") as root:
        socket_path = Path(root) / "capture.sock"
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(socket_path))
        server.listen(1)

        def accept_once():
            connection, _ = server.accept()
            connection.close()

        thread = threading.Thread(target=accept_once)
        thread.start()
        try:
            with pytest.raises(MigrationBlocked, match="legacy Capture identity"):
                assert_legacy_capture_idle(
                    CaptureJobSnapshot(loaded=True, executable=Path("/not/the/peer")),
                    socket_path,
                )
        finally:
            thread.join(timeout=2)
            server.close()


def test_loaded_legacy_capture_blocks_when_authenticated_peer_is_recording(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        CaptureJobSnapshot,
        MigrationBlocked,
        _process_executable,
        assert_legacy_capture_idle,
    )

    with tempfile.TemporaryDirectory(prefix="yulu-mig-", dir="/tmp") as root:
        socket_path = Path(root) / "capture.sock"
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(socket_path))
        server.listen(1)

        def report_recording():
            connection, _ = server.accept()
            with connection:
                request = connection.recv(4096)
                if request:
                    connection.sendall(json.dumps({"recording": True}).encode() + b"\n")

        thread = threading.Thread(target=report_recording)
        thread.start()
        try:
            with pytest.raises(MigrationBlocked, match="recording is active"):
                assert_legacy_capture_idle(
                    CaptureJobSnapshot(
                        loaded=True,
                        executable=_process_executable(os.getpid()),
                    ),
                    socket_path,
                )
        finally:
            thread.join(timeout=2)
            server.close()


def test_migration_authority_owns_one_exclusive_lock_and_atomic_journal(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
    )

    paths = MigrationPaths(
        durable_root=tmp_path / "Application Support" / "Yulu",
        cache_root=tmp_path / "Caches" / "Yulu",
    )
    now = lambda: datetime(2026, 8, 30, tzinfo=timezone.utc)

    with ApplicationMigration(paths, now=now) as authority:
        journal = authority.begin()
        assert journal["phase"] == "preflight"
        assert journal["transactionId"]

        persisted = json.loads(paths.journal_path.read_text())
        assert persisted == journal
        assert paths.journal_path.stat().st_mode & 0o777 == 0o600

        with pytest.raises(MigrationBlocked, match="already in progress"):
            with ApplicationMigration(paths, now=now):
                pass

        guarded = authority.transition("guarded", intent={"check": "capture-idle"})
        assert guarded["phase"] == "guarded"
        assert guarded["intent"] == {"check": "capture-idle"}
        assert json.loads(paths.journal_path.read_text()) == guarded

    with ApplicationMigration(paths, now=now):
        pass


def test_session_attempt_lock_is_the_only_lock_and_journal_writes_stay_anchored(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import ApplicationMigration, MigrationPaths

    paths = MigrationPaths(
        durable_root=tmp_path / "Application Support" / "Yulu",
        cache_root=tmp_path / "Caches" / "Yulu",
    )
    paths.lock_dir.mkdir(parents=True, mode=0o700)
    attempt_fd = os.open(
        paths.attempt_lock_path,
        os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
        0o600,
    )
    fcntl.flock(attempt_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    external_lock = tmp_path / "external.lock"
    external_lock.write_bytes(b"external-lock")
    external_lock.chmod(0o644)
    os.link(external_lock, paths.lock_dir / "migration.lock")
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    anchored = tmp_path / "anchored-journal"

    try:
        with ApplicationMigration(paths, attempt_fd=attempt_fd) as authority:
            authority.begin()
            paths.journal_dir.rename(anchored)
            paths.journal_dir.symlink_to(outside, target_is_directory=True)
            authority.transition("guarded", intent={"action": "anchored"})
    finally:
        os.close(attempt_fd)

    assert external_lock.read_bytes() == b"external-lock"
    assert external_lock.stat().st_mode & 0o777 == 0o644
    assert json.loads((anchored / "journal.json").read_text())["phase"] == "guarded"
    assert not (outside / "journal.json").exists()


def test_transaction_output_cleanup_uses_the_anchored_application_support_root(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationPaths,
        _DIRECTORY_OUTPUTS,
        _ORDINARY_FILE_OUTPUTS,
        _SQLITE_OUTPUTS,
    )

    paths = MigrationPaths(
        durable_root=tmp_path / "Application Support" / "Yulu",
        cache_root=tmp_path / "Caches" / "Yulu",
    )
    anchored = tmp_path / "anchored-support"
    outside = tmp_path / "outside-support"
    outside.mkdir(mode=0o700)
    (outside / "config.json").write_bytes(b"outside")

    with ApplicationMigration(paths) as authority:
        authority.begin()
        (paths.durable_root / "config.json").write_bytes(b"transaction")
        durable_info = os.fstat(authority._durable_root_fd)
        names = {
            destination for _, destination in _ORDINARY_FILE_OUTPUTS
        } | {
            destination for _, destination in _DIRECTORY_OUTPUTS
        } | {
            name for name, _ in _SQLITE_OUTPUTS
        }
        authority._journal = {
            **authority._journal,
            "preflightDataManifest": {
                name: {
                    "reused": name != "config.json",
                    **(
                        {"destinationSidecars": {"-wal": None, "-shm": None}}
                        if name.endswith(".sqlite")
                        else {}
                    ),
                }
                for name in names
            },
            "durableDirectory": {
                "device": durable_info.st_dev,
                "inode": durable_info.st_ino,
            },
        }
        authority._write_journal()
        authority.record_transaction_output_identities(
            authority._journal["preflightDataManifest"]
        )
        paths.durable_root.rename(anchored)
        paths.durable_root.symlink_to(outside, target_is_directory=True)
        authority.remove_transaction_outputs()

    assert not (anchored / "config.json").exists()
    assert (outside / "config.json").read_bytes() == b"outside"


def test_migration_authority_rejects_symlinked_private_roots_without_touching_target(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
    )

    outside = tmp_path / "outside"
    outside.mkdir(mode=0o755)
    sentinel = outside / "sentinel"
    sentinel.write_bytes(b"external-state")
    cache = tmp_path / "cache"
    cache.mkdir(mode=0o700)
    (cache / "application-migration").symlink_to(outside, target_is_directory=True)

    with pytest.raises(MigrationBlocked, match="private migration directory"):
        with ApplicationMigration(
            MigrationPaths(durable_root=tmp_path / "durable", cache_root=cache)
        ):
            raise AssertionError("unsafe authority root was accepted")

    assert outside.stat().st_mode & 0o777 == 0o755
    assert sentinel.read_bytes() == b"external-state"
    assert not (outside / "migration.lock").exists()


def test_legacy_job_snapshot_uses_fixed_allowlist_and_records_launchd_state(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import LEGACY_JOB_LABELS, snapshot_legacy_jobs

    agents = tmp_path / "LaunchAgents"
    agents.mkdir(mode=0o700)
    legacy_bytes = b'<?xml version="1.0"?><plist><dict/></plist>\n'
    legacy_plist = agents / "com.yulu.ui.plist"
    legacy_plist.write_bytes(legacy_bytes)
    legacy_plist.chmod(0o640)
    (agents / "com.example.unrelated.plist").write_text("leave me")

    commands = []

    def launchctl(arguments):
        commands.append(arguments)
        if arguments == ["print-disabled", f"gui/{os.geteuid()}"]:
            return SimpleNamespace(
                returncode=0,
                stdout='disabled services = {\n"com.yulu.ui" => true\n}',
                stderr="",
            )
        label = arguments[-1].rsplit("/", 1)[-1]
        return SimpleNamespace(
            returncode=0 if label == "com.yulu.ui" else 113,
            stdout="service" if label == "com.yulu.ui" else "",
            stderr="",
        )

    snapshot = snapshot_legacy_jobs(agents, launchctl=launchctl)

    assert set(snapshot) == set(LEGACY_JOB_LABELS)
    assert snapshot["com.yulu.ui"] == {
        "loaded": True,
        "disabled": True,
        "launchAgentsDevice": agents.stat().st_dev,
        "launchAgentsInode": agents.stat().st_ino,
        "plistBytes": legacy_bytes.hex(),
        "plistSHA256": __import__("hashlib").sha256(legacy_bytes).hexdigest(),
        "plistMode": 0o640,
    }
    assert snapshot["com.yulu.calendar"]["loaded"] is False
    assert snapshot["com.yulu.calendar"]["plistBytes"] is None
    assert commands[0] == ["print-disabled", f"gui/{os.geteuid()}"]
    assert ["print", f"gui/{os.geteuid()}/com.yulu.ui"] in commands


def test_large_plist_bytes_are_private_snapshot_files_not_journal_payload(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        LEGACY_JOB_LABELS,
        MigrationPaths,
        snapshot_legacy_jobs,
    )

    agents = tmp_path / "LaunchAgents"
    agents.mkdir(mode=0o700)
    payloads = {}
    for index, label in enumerate(LEGACY_JOB_LABELS):
        payload = f"SENSITIVE-{index}-".encode() + b"x" * (700 * 1024)
        payloads[label] = payload
        plist = agents / f"{label}.plist"
        plist.write_bytes(payload)
        plist.chmod(0o640 if index % 2 == 0 else 0o600)

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(returncode=113, stdout="", stderr="")

    snapshot = snapshot_legacy_jobs(agents, launchctl=launchctl)
    paths = MigrationPaths(durable_root=tmp_path / "durable", cache_root=tmp_path / "cache")
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.record_job_snapshot(snapshot)

    journal_bytes = paths.journal_path.read_bytes()
    journal = json.loads(journal_bytes)
    assert len(journal_bytes) < 64 * 1024
    assert b"SENSITIVE-" not in journal_bytes
    for index, label in enumerate(LEGACY_JOB_LABELS):
        entry = journal["jobSnapshot"][label]
        assert "plistBytes" not in entry
        snapshot_path = paths.journal_dir / entry["plistSnapshot"]
        assert snapshot_path.read_bytes() == payloads[label]
        assert snapshot_path.stat().st_mode & 0o777 == 0o600
        assert snapshot_path.stat().st_nlink == 1
        assert entry["plistMode"] == (0o640 if index % 2 == 0 else 0o600)


def test_private_snapshot_and_journal_writes_retry_short_os_writes(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import application_migration
    from application_migration import (
        ApplicationMigration,
        LEGACY_JOB_LABELS,
        MigrationPaths,
        snapshot_legacy_jobs,
    )

    agents = tmp_path / "LaunchAgents"
    agents.mkdir(mode=0o700)
    payload = b"legacy plist bytes that must survive short writes"
    (agents / "com.yulu.ui.plist").write_bytes(payload)

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(returncode=113, stdout="", stderr="")

    snapshot = snapshot_legacy_jobs(agents, launchctl=launchctl)
    paths = MigrationPaths(durable_root=tmp_path / "durable", cache_root=tmp_path / "cache")
    original_write = application_migration.os.write

    def short_write(file_fd, contents):
        return original_write(file_fd, bytes(contents[:7]))

    with ApplicationMigration(paths) as authority:
        authority.begin()
        monkeypatch.setattr(application_migration.os, "write", short_write)
        authority.record_job_snapshot(snapshot)

    journal = json.loads(paths.journal_path.read_bytes())
    assert set(journal["jobSnapshot"]) == set(LEGACY_JOB_LABELS)
    entry = journal["jobSnapshot"]["com.yulu.ui"]
    assert (paths.journal_dir / entry["plistSnapshot"]).read_bytes() == payload


def test_private_snapshot_readback_failure_removes_the_unjournaled_link(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import application_migration
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
        snapshot_legacy_jobs,
    )

    agents = tmp_path / "LaunchAgents"
    agents.mkdir(mode=0o700)
    (agents / "com.yulu.ui.plist").write_bytes(b"sensitive legacy plist")

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(returncode=113, stdout="", stderr="")

    snapshot = snapshot_legacy_jobs(agents, launchctl=launchctl)
    paths = MigrationPaths(durable_root=tmp_path / "durable", cache_root=tmp_path / "cache")
    with ApplicationMigration(paths) as authority:
        transaction_id = authority.begin()["transactionId"]

        def reject_readback(*_arguments, **_options):
            raise MigrationBlocked("injected snapshot readback failure")

        monkeypatch.setattr(
            application_migration, "_read_private_file_at", reject_readback
        )
        with pytest.raises(MigrationBlocked, match="injected snapshot readback failure"):
            authority.record_job_snapshot(snapshot)

    transaction_dir = paths.journal_dir / "rollback-snapshots" / transaction_id
    assert not transaction_dir.exists()


@pytest.mark.parametrize("preexisting_first_snapshot", [False, True])
def test_job_snapshot_loop_failure_cleans_only_links_created_by_that_call(
    preexisting_first_snapshot, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import application_migration
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
        snapshot_legacy_jobs,
    )

    agents = tmp_path / "LaunchAgents"
    agents.mkdir(mode=0o700)
    first_contents = b"legacy ui plist"
    second_contents = b"legacy capture plist"
    (agents / "com.yulu.ui.plist").write_bytes(first_contents)
    (agents / "com.yulu.audiodaemon.plist").write_bytes(second_contents)

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(returncode=113, stdout="", stderr="")

    snapshot = snapshot_legacy_jobs(agents, launchctl=launchctl)
    paths = MigrationPaths(durable_root=tmp_path / "durable", cache_root=tmp_path / "cache")
    original_publish = application_migration._publish_private_file_at
    with ApplicationMigration(paths) as authority:
        transaction_id = authority.begin()["transactionId"]
        transaction_dir = paths.journal_dir / "rollback-snapshots" / transaction_id
        if preexisting_first_snapshot:
            transaction_dir.parent.mkdir(mode=0o700)
            transaction_dir.mkdir(mode=0o700)
            first = transaction_dir / "com.yulu.ui.plist"
            first.write_bytes(first_contents)
            first.chmod(0o600)
        calls = 0

        def fail_second(parent_fd, name, contents):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise MigrationBlocked("injected second snapshot failure")
            return original_publish(parent_fd, name, contents)

        monkeypatch.setattr(
            application_migration, "_publish_private_file_at", fail_second
        )
        with pytest.raises(MigrationBlocked, match="injected second snapshot failure"):
            authority.record_job_snapshot(snapshot)

    if preexisting_first_snapshot:
        assert transaction_dir.is_dir()
        assert (transaction_dir / "com.yulu.ui.plist").read_bytes() == first_contents
        assert list(transaction_dir.iterdir()) == [
            transaction_dir / "com.yulu.ui.plist"
        ]
    else:
        assert not transaction_dir.exists()


def test_loaded_allowlisted_job_without_a_plist_blocks_before_mutation(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, snapshot_legacy_jobs

    agents = tmp_path / "LaunchAgents"
    agents.mkdir(mode=0o700)

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(
            returncode=(
                0 if arguments[-1].rsplit("/", 1)[-1] == "com.yulu.ui" else 113
            ),
            stdout="",
            stderr="",
        )

    with pytest.raises(MigrationBlocked, match="loaded legacy job has no plist"):
        snapshot_legacy_jobs(agents, launchctl=launchctl)


def test_quiesce_rejects_launchagents_parent_replacement_after_snapshot(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
        snapshot_legacy_jobs,
    )

    agents = tmp_path / "LaunchAgents"
    original_agents = tmp_path / "Original LaunchAgents"
    archive = tmp_path / "archive"
    agents.mkdir(mode=0o700)
    plist_bytes = b"exact legacy plist\n"
    (agents / "com.yulu.ui.plist").write_bytes(plist_bytes)

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(returncode=113, stdout="", stderr="")

    snapshot = snapshot_legacy_jobs(agents, launchctl=launchctl)
    agents.rename(original_agents)
    agents.mkdir(mode=0o700)
    (agents / "com.yulu.ui.plist").write_bytes(plist_bytes)

    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.record_job_snapshot(snapshot)
        with pytest.raises(MigrationBlocked, match="LaunchAgents directory changed"):
            authority.quiesce_legacy_jobs(
                snapshot,
                launch_agents_dir=agents,
                archive_dir=archive,
                launchctl=launchctl,
            )

    assert (original_agents / "com.yulu.ui.plist").read_bytes() == plist_bytes
    assert (agents / "com.yulu.ui.plist").read_bytes() == plist_bytes
    assert not (archive / "com.yulu.ui.plist").exists()


def test_quiesce_archives_allowlisted_plists_and_rollback_restores_exact_state(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationPaths,
        snapshot_legacy_jobs,
    )

    agents = tmp_path / "LaunchAgents"
    archive = tmp_path / "Rollback" / "LaunchAgents"
    agents.mkdir(mode=0o700)
    ui_bytes = b"ui legacy plist\n"
    calendar_bytes = b"calendar legacy plist\n"
    (agents / "com.yulu.ui.plist").write_bytes(ui_bytes)
    (agents / "com.yulu.ui.plist").chmod(0o640)
    (agents / "com.yulu.calendar.plist").write_bytes(calendar_bytes)
    (agents / "com.yulu.calendar.plist").chmod(0o600)

    loaded = {"com.yulu.ui"}
    disabled = {"com.yulu.calendar"}
    mutations = []
    events = []

    def launchctl(arguments):
        events.append(tuple(arguments))
        if arguments[0] == "print-disabled":
            body = "\n".join(f'"{label}" => true' for label in disabled)
            return SimpleNamespace(returncode=0, stdout=body, stderr="")
        if arguments[0] == "print":
            label = arguments[-1].rsplit("/", 1)[-1]
            return SimpleNamespace(
                returncode=0 if label in loaded else 113, stdout="", stderr=""
            )
        mutations.append(arguments)
        label = arguments[-1].rsplit("/", 1)[-1]
        if arguments[0] == "bootout":
            loaded.discard(label)
        elif arguments[0] == "bootstrap":
            loaded.add(Path(arguments[-1]).stem)
        elif arguments[0] == "disable":
            disabled.add(label)
        elif arguments[0] == "enable":
            disabled.discard(label)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    snapshot = snapshot_legacy_jobs(agents, launchctl=launchctl)
    paths = MigrationPaths(
        durable_root=tmp_path / "Application Support" / "Yulu",
        cache_root=tmp_path / "Caches" / "Yulu",
    )
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.record_job_snapshot(snapshot)
        authority.quiesce_legacy_jobs(
            snapshot,
            launch_agents_dir=agents,
            archive_dir=archive,
            launchctl=launchctl,
        )

        assert not (agents / "com.yulu.ui.plist").exists()
        assert not (agents / "com.yulu.calendar.plist").exists()
        assert (archive / "com.yulu.ui.plist").read_bytes() == ui_bytes
        assert (archive / "com.yulu.ui.plist").stat().st_mode & 0o777 == 0o640
        assert json.loads(paths.journal_path.read_text())["phase"] == "legacy_quiesced"

        # The journaled mode is part of the rollback contract, not incidental
        # metadata inherited from whatever state the archive currently has.
        (archive / "com.yulu.ui.plist").chmod(0o600)

        authority.rollback_legacy_jobs(
            snapshot,
            launch_agents_dir=agents,
            archive_dir=archive,
            launchctl=launchctl,
        )

    assert (agents / "com.yulu.ui.plist").read_bytes() == ui_bytes
    assert (agents / "com.yulu.calendar.plist").read_bytes() == calendar_bytes
    assert (agents / "com.yulu.ui.plist").stat().st_mode & 0o777 == 0o640
    assert (agents / "com.yulu.calendar.plist").stat().st_mode & 0o777 == 0o600
    assert loaded == {"com.yulu.ui"}
    assert disabled == {"com.yulu.calendar"}
    assert ["bootout", f"gui/{os.geteuid()}/com.yulu.ui"] in mutations
    assert ["disable", f"gui/{os.geteuid()}/com.yulu.calendar"] in mutations
    bootstrap_index = events.index(
        ("bootstrap", f"gui/{os.geteuid()}", str(agents / "com.yulu.ui.plist"))
    )
    assert (
        "print",
        f"gui/{os.geteuid()}/com.yulu.ui",
    ) in events[bootstrap_index + 1 :]
    disable_index = events.index(
        ("disable", f"gui/{os.geteuid()}/com.yulu.calendar")
    )
    assert (
        "print-disabled",
        f"gui/{os.geteuid()}",
    ) in events[disable_index + 1 :]
    assert json.loads(paths.journal_path.read_text())["phase"] == "rolled_back"


def test_rollback_fails_closed_when_launchagents_and_archive_paths_are_swapped(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
        snapshot_legacy_jobs,
    )

    agents = tmp_path / "LaunchAgents"
    archive = tmp_path / "rollback" / "LaunchAgents"
    agents.mkdir(mode=0o700)
    plist_bytes = b"legacy ui\n"
    (agents / "com.yulu.ui.plist").write_bytes(plist_bytes)

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(returncode=113, stdout="", stderr="")

    snapshot = snapshot_legacy_jobs(agents, launchctl=launchctl)
    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    anchored_agents = tmp_path / "anchored-agents"
    anchored_archive = tmp_path / "anchored-archive"
    outside_agents = tmp_path / "outside-agents"
    outside_archive = tmp_path / "outside-archive"
    outside_agents.mkdir(mode=0o700)
    outside_archive.mkdir(mode=0o700)

    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.record_job_snapshot(snapshot)
        authority.quiesce_legacy_jobs(
            snapshot,
            launch_agents_dir=agents,
            archive_dir=archive,
            launchctl=launchctl,
        )
        agents.rename(anchored_agents)
        agents.symlink_to(outside_agents, target_is_directory=True)
        archive.rename(anchored_archive)
        archive.symlink_to(outside_archive, target_is_directory=True)

        with pytest.raises(MigrationBlocked, match="LaunchAgents directory changed"):
            authority.rollback_legacy_jobs(
                snapshot,
                launch_agents_dir=agents,
                archive_dir=archive,
                launchctl=launchctl,
            )

    assert (anchored_archive / "com.yulu.ui.plist").read_bytes() == plist_bytes
    assert list(outside_agents.iterdir()) == []
    assert list(outside_archive.iterdir()) == []


def test_quiesce_stops_every_recording_initiator_then_checks_idle_and_stops_capture_last(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        LEGACY_JOB_LABELS,
        MigrationPaths,
        snapshot_legacy_jobs,
    )

    agents = tmp_path / "LaunchAgents"
    archive = tmp_path / "archive"
    agents.mkdir(mode=0o700)
    for label in LEGACY_JOB_LABELS:
        (agents / f"{label}.plist").write_bytes(f"{label}\n".encode())
    loaded = set(LEGACY_JOB_LABELS)
    events = []

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        label = arguments[-1].rsplit("/", 1)[-1]
        if arguments[0] == "print":
            return SimpleNamespace(
                returncode=0 if label in loaded else 113, stdout="", stderr=""
            )
        if arguments[0] == "bootout":
            events.append(f"bootout:{label}")
            loaded.remove(label)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    snapshot = snapshot_legacy_jobs(agents, launchctl=launchctl)

    def final_idle_check():
        assert loaded == {"com.yulu.audiodaemon"}
        events.append("capture-idle")

    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.record_job_snapshot(snapshot)
        authority.quiesce_legacy_jobs(
            snapshot,
            launch_agents_dir=agents,
            archive_dir=archive,
            launchctl=launchctl,
            final_capture_idle=final_idle_check,
        )

    assert events[-2:] == ["capture-idle", "bootout:com.yulu.audiodaemon"]
    assert events[:-2] == [
        f"bootout:{label}"
        for label in LEGACY_JOB_LABELS
        if label != "com.yulu.audiodaemon"
    ]


def test_final_capture_idle_failure_rolls_back_in_the_same_live_session(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import application_migration
    from application_migration import (
        LEGACY_JOB_LABELS,
        MigrationBlocked,
        MigrationPaths,
        run_migration_session,
    )

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    agents = tmp_path / "LaunchAgents"
    archive = tmp_path / "archive"
    for directory in (legacy, durable, agents):
        directory.mkdir(mode=0o700)
    (legacy / "config.json").write_text("{}\n")
    for label in LEGACY_JOB_LABELS:
        payload = (
            plistlib.dumps({"Program": sys.executable})
            if label == "com.yulu.audiodaemon"
            else f"{label}\n".encode()
        )
        (agents / f"{label}.plist").write_bytes(payload)
    loaded = set(LEGACY_JOB_LABELS)
    events = []

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        label = arguments[-1].rsplit("/", 1)[-1]
        if arguments[0] == "print":
            return SimpleNamespace(
                returncode=0 if label in loaded else 113, stdout="", stderr=""
            )
        if arguments[0] == "bootout":
            events.append(f"bootout:{label}")
            loaded.discard(label)
        elif arguments[0] == "bootstrap":
            loaded.add(Path(arguments[-1]).stem)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    def reject_recording_window(_snapshot, _socket_path):
        assert loaded == {"com.yulu.audiodaemon"}
        events.append("final-idle-check")
        raise MigrationBlocked("legacy Capture recording began during quiesce")

    monkeypatch.setattr(
        application_migration,
        "assert_legacy_capture_idle",
        reject_recording_window,
    )
    node = tmp_path / "node"
    server = tmp_path / "server.js"
    node.write_bytes(b"node")
    server.write_bytes(b"server")

    result = run_migration_session(
        paths=MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache"),
        home_dir=tmp_path,
        legacy_root=legacy,
        launch_agents_dir=agents,
        archive_dir=archive,
        legacy_capture_socket=legacy / "audio_daemon.sock",
        node_executable=node,
        server_js=server,
        launchctl=launchctl,
        input_stream=io.BytesIO(),
        output_stream=io.BytesIO(),
    )

    assert result == 0
    assert events[-1] == "final-idle-check"
    assert loaded == set(LEGACY_JOB_LABELS)
    assert json.loads(
        (durable / "application-migration/journal.json").read_text()
    )["phase"] == "rolled_back"


@pytest.mark.parametrize(
    "phase",
    ["registration_requested", "awaiting_approval", "services_enabled", "verifying"],
)
def test_live_service_phase_failure_unregisters_and_rolls_back_in_the_same_session(
    phase, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
        run_migration_session,
        run_migration_step,
        snapshot_legacy_jobs,
    )

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    agents = tmp_path / "LaunchAgents"
    archive = tmp_path / "archive"
    for directory in (legacy, durable, agents):
        directory.mkdir(mode=0o700)
    (legacy / "config.json").write_text("{}\n")

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(returncode=113 if arguments[0] == "print" else 0, stdout="", stderr="")

    paths = MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")
    with ApplicationMigration(paths) as authority:
        authority.begin()
        snapshot = snapshot_legacy_jobs(agents, launchctl=launchctl)
        authority.record_job_snapshot(snapshot)
        authority.transition("data_published", intent={"action": "test-ready"})
        registration = authority.request_registration()
        if phase == "awaiting_approval":
            authority.observe_service_statuses(
                transaction_id=registration["transactionId"],
                nonce=registration["nonce"],
                statuses={
                    "com.yulu.ui.plist": "requiresApproval",
                    "com.yulu.audiodaemon.plist": "requiresApproval",
                },
            )
        elif phase in {"services_enabled", "verifying"}:
            authority.observe_service_statuses(
                transaction_id=registration["transactionId"],
                nonce=registration["nonce"],
                statuses={
                    "com.yulu.ui.plist": "enabled",
                    "com.yulu.audiodaemon.plist": "enabled",
                },
            )
            if phase == "verifying":
                authority.transition("verifying", intent={"action": "test-failure"})

    failed = False

    def fail_once(**arguments):
        nonlocal failed
        if not failed:
            failed = True
            raise MigrationBlocked(f"injected live failure in {phase}")
        return run_migration_step(**arguments)

    adapter_actions = []
    node = tmp_path / "node"
    server = tmp_path / "server.js"
    node.write_bytes(b"node")
    server.write_bytes(b"server")
    result = run_migration_session(
        paths=paths,
        step=fail_once,
        home_dir=tmp_path,
        legacy_root=legacy,
        launch_agents_dir=agents,
        archive_dir=archive,
        legacy_capture_socket=legacy / "audio_daemon.sock",
        node_executable=node,
        server_js=server,
        launchctl=launchctl,
        input_stream=io.BytesIO(),
        output_stream=io.BytesIO(),
        service_adapter=lambda action: adapter_actions.append(action) or {
            "com.yulu.ui.plist": "notRegistered",
            "com.yulu.audiodaemon.plist": "notFound",
        },
    )

    assert result == 0
    assert [action["action"] for action in adapter_actions] == ["unregister_services"]
    assert json.loads(paths.journal_path.read_text())["phase"] == "rolled_back"


def test_live_node_failure_removes_transaction_outputs_and_restores_legacy(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationPaths, run_migration_session

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    agents = tmp_path / "LaunchAgents"
    archive = tmp_path / "archive"
    for directory in (legacy, durable, agents):
        directory.mkdir(mode=0o700)
    legacy_config = b'{"legacy":true}\n'
    (legacy / "config.json").write_bytes(legacy_config)
    plist_bytes = b"legacy ui plist\n"
    (agents / "com.yulu.ui.plist").write_bytes(plist_bytes)
    loaded = {"com.yulu.ui"}

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        label = arguments[-1].rsplit("/", 1)[-1]
        if arguments[0] == "print":
            return SimpleNamespace(
                returncode=0 if label in loaded else 113, stdout="", stderr=""
            )
        if arguments[0] == "bootout":
            loaded.discard(label)
        elif arguments[0] == "bootstrap":
            loaded.add(Path(arguments[-1]).stem)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    node = tmp_path / "node"
    server = tmp_path / "server.js"
    node.write_bytes(b"node")
    server.write_bytes(b"server")

    def fail_after_partial_publication(_arguments, **_options):
        (durable / "config.json").write_bytes(legacy_config)
        database = sqlite3.connect(durable / "prompts.sqlite")
        database.execute("CREATE TABLE prompts(id INTEGER PRIMARY KEY, text TEXT)")
        database.commit()
        database.close()
        return SimpleNamespace(returncode=1, stdout="", stderr="injected failure")

    paths = MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")
    result = run_migration_session(
        paths=paths,
        home_dir=tmp_path,
        legacy_root=legacy,
        launch_agents_dir=agents,
        archive_dir=archive,
        legacy_capture_socket=legacy / "audio_daemon.sock",
        node_executable=node,
        server_js=server,
        launchctl=launchctl,
        run_node=fail_after_partial_publication,
        input_stream=io.BytesIO(),
        output_stream=io.BytesIO(),
    )

    assert result == 0
    assert not (durable / "config.json").exists()
    assert not (durable / "prompts.sqlite").exists()
    assert (legacy / "config.json").read_bytes() == legacy_config
    assert (agents / "com.yulu.ui.plist").read_bytes() == plist_bytes
    assert loaded == {"com.yulu.ui"}
    assert json.loads(paths.journal_path.read_text())["phase"] == "rolled_back"


def test_live_snapshot_failure_makes_no_legacy_or_service_mutation(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationPaths, run_migration_session

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    agents = tmp_path / "LaunchAgents"
    for directory in (legacy, durable, agents):
        directory.mkdir(mode=0o700)
    legacy_bytes = b'{"legacy":"unchanged"}\n'
    plist_bytes = b"legacy ui plist\n"
    (legacy / "config.json").write_bytes(legacy_bytes)
    (agents / "com.yulu.ui.plist").write_bytes(plist_bytes)
    commands = []

    def launchctl(arguments):
        commands.append(arguments)
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=1, stdout="", stderr="injected")
        raise AssertionError("snapshot failure must precede job mutation")

    node = tmp_path / "node"
    server = tmp_path / "server.js"
    node.write_bytes(b"node")
    server.write_bytes(b"server")
    paths = MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")
    result = run_migration_session(
        paths=paths,
        home_dir=tmp_path,
        legacy_root=legacy,
        launch_agents_dir=agents,
        archive_dir=tmp_path / "archive",
        legacy_capture_socket=legacy / "audio_daemon.sock",
        node_executable=node,
        server_js=server,
        launchctl=launchctl,
        input_stream=io.BytesIO(),
        output_stream=io.BytesIO(),
    )

    assert result == 0
    assert commands == [["print-disabled", f"gui/{os.geteuid()}"]]
    assert (legacy / "config.json").read_bytes() == legacy_bytes
    assert (agents / "com.yulu.ui.plist").read_bytes() == plist_bytes
    assert not (durable / "config.json").exists()
    assert json.loads(paths.journal_path.read_text())["phase"] == "rolled_back"


def test_live_partial_archive_failure_restores_moved_plist_and_stopped_jobs(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import application_migration
    from application_migration import MigrationPaths, run_migration_session

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    agents = tmp_path / "LaunchAgents"
    archive = tmp_path / "archive"
    for directory in (legacy, durable, agents):
        directory.mkdir(mode=0o700)
    (legacy / "config.json").write_text("{}\n")
    expected = {
        "com.yulu.ui": b"legacy ui\n",
        "com.yulu.calendar": b"legacy calendar\n",
    }
    for label, payload in expected.items():
        (agents / f"{label}.plist").write_bytes(payload)
    loaded = set(expected)

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        label = arguments[-1].rsplit("/", 1)[-1]
        if arguments[0] == "print":
            return SimpleNamespace(
                returncode=0 if label in loaded else 113, stdout="", stderr=""
            )
        if arguments[0] == "bootout":
            loaded.discard(label)
        elif arguments[0] == "bootstrap":
            loaded.add(Path(arguments[-1]).stem)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    real_rename = application_migration.os.rename
    rename_count = 0

    def fail_second_archive_move(*arguments, **options):
        nonlocal rename_count
        rename_count += 1
        if rename_count == 2:
            raise OSError("injected archive failure")
        return real_rename(*arguments, **options)

    monkeypatch.setattr(application_migration.os, "rename", fail_second_archive_move)
    node = tmp_path / "node"
    server = tmp_path / "server.js"
    node.write_bytes(b"node")
    server.write_bytes(b"server")
    paths = MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")
    result = run_migration_session(
        paths=paths,
        home_dir=tmp_path,
        legacy_root=legacy,
        launch_agents_dir=agents,
        archive_dir=archive,
        legacy_capture_socket=legacy / "audio_daemon.sock",
        node_executable=node,
        server_js=server,
        launchctl=launchctl,
        input_stream=io.BytesIO(),
        output_stream=io.BytesIO(),
    )

    assert result == 0
    assert loaded == set(expected)
    for label, payload in expected.items():
        assert (agents / f"{label}.plist").read_bytes() == payload
        assert not (archive / f"{label}.plist").exists()
    assert json.loads(paths.journal_path.read_text())["phase"] == "rolled_back"


def test_rollback_rejects_archive_directory_replacement(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
        snapshot_legacy_jobs,
    )

    agents = tmp_path / "LaunchAgents"
    archive = tmp_path / "archive"
    original_archive = tmp_path / "original-archive"
    agents.mkdir(mode=0o700)
    plist_bytes = b"legacy plist\n"
    (agents / "com.yulu.ui.plist").write_bytes(plist_bytes)

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(returncode=113, stdout="", stderr="")

    snapshot = snapshot_legacy_jobs(agents, launchctl=launchctl)
    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.record_job_snapshot(snapshot)
        authority.quiesce_legacy_jobs(
            snapshot,
            launch_agents_dir=agents,
            archive_dir=archive,
            launchctl=launchctl,
        )
        archive.rename(original_archive)
        archive.mkdir(mode=0o700)
        (archive / "com.yulu.ui.plist").write_bytes(plist_bytes)

        with pytest.raises(MigrationBlocked, match="rollback archive changed"):
            authority.rollback_legacy_jobs(
                snapshot,
                launch_agents_dir=agents,
                archive_dir=archive,
                launchctl=launchctl,
            )

    assert not (agents / "com.yulu.ui.plist").exists()
    assert (original_archive / "com.yulu.ui.plist").read_bytes() == plist_bytes
    assert (archive / "com.yulu.ui.plist").read_bytes() == plist_bytes


def test_preexisting_standard_files_must_match_the_legacy_manifest(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, preflight_standard_outputs

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    legacy.mkdir(mode=0o700)
    durable.mkdir(mode=0o700)
    (legacy / "config.json").write_bytes(b'{"source":"legacy"}\n')
    (durable / "config.json").write_bytes(b'{"source":"other"}\n')

    with pytest.raises(MigrationBlocked, match="standard output conflicts"):
        preflight_standard_outputs(legacy, durable)

    (durable / "config.json").write_bytes((legacy / "config.json").read_bytes())
    manifest = preflight_standard_outputs(legacy, durable)
    assert manifest["config.json"]["reused"] is True
    assert manifest["config.json"]["sourceSHA256"] == manifest["config.json"][
        "destinationSHA256"
    ]


def test_preexisting_standard_directory_must_match_the_complete_legacy_tree(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, preflight_standard_outputs

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    (legacy / "models").mkdir(parents=True, mode=0o700)
    (durable / "Models").mkdir(parents=True, mode=0o700)
    (legacy / "models" / "model.bin").write_bytes(b"legacy-model")
    (durable / "Models" / "partial.bin").write_bytes(b"partial")

    with pytest.raises(MigrationBlocked, match="standard output conflicts"):
        preflight_standard_outputs(legacy, durable)


def test_preexisting_standard_sqlite_requires_integrity_schema_and_content_match(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, preflight_standard_outputs

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    legacy.mkdir(mode=0o700)
    durable.mkdir(mode=0o700)

    for root in (legacy, durable):
        database = sqlite3.connect(root / "host.sqlite")
        database.executescript(
            "CREATE TABLE agent_tasks(id INTEGER PRIMARY KEY, value TEXT NOT NULL);"
            "INSERT INTO agent_tasks(value) VALUES ('same');"
        )
        database.close()

    manifest = preflight_standard_outputs(legacy, durable)
    assert manifest["host.sqlite"]["reused"] is True
    assert manifest["host.sqlite"]["sourceSchemaSHA256"] == manifest[
        "host.sqlite"
    ]["destinationSchemaSHA256"]
    assert manifest["host.sqlite"]["sourceContentSHA256"] == manifest[
        "host.sqlite"
    ]["destinationContentSHA256"]

    database = sqlite3.connect(durable / "host.sqlite")
    database.execute("UPDATE agent_tasks SET value = 'conflict'")
    database.commit()
    database.close()
    with pytest.raises(MigrationBlocked, match="standard SQLite conflicts"):
        preflight_standard_outputs(legacy, durable)


def test_invalid_preexisting_standard_sqlite_fails_closed(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, preflight_standard_outputs

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    legacy.mkdir(mode=0o700)
    durable.mkdir(mode=0o700)
    (durable / "prompts.sqlite").write_bytes(b"not sqlite")

    with pytest.raises(MigrationBlocked, match="invalid SQLite"):
        preflight_standard_outputs(legacy, durable)


def test_preexisting_orphan_sqlite_sidecar_blocks_preflight_without_deletion(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, preflight_standard_outputs

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    legacy.mkdir(mode=0o700)
    durable.mkdir(mode=0o700)
    sidecar = durable / "prompts.sqlite-wal"
    sidecar.write_bytes(b"preexisting-wal")

    with pytest.raises(MigrationBlocked, match="SQLite sidecar conflicts"):
        preflight_standard_outputs(legacy, durable)

    assert sidecar.read_bytes() == b"preexisting-wal"


def test_rollback_only_deletes_the_recorded_transaction_sqlite_sidecar(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
        _regular_file_identity,
        preflight_standard_outputs,
    )

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    legacy.mkdir(mode=0o700)
    durable.mkdir(mode=0o700)
    paths = MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")

    with ApplicationMigration(paths) as authority:
        authority.begin()
        preflight = preflight_standard_outputs(legacy, durable)
        sidecar = durable / "prompts.sqlite-wal"
        sidecar.write_bytes(b"transaction-wal")
        created = _regular_file_identity(sidecar)
        authority._journal = {
            **authority._journal,
            "preflightDataManifest": preflight,
            "transactionOutputIdentities": {
                "prompts.sqlite-wal": created,
            },
            "durableDirectory": {
                "device": os.fstat(authority._durable_root_fd).st_dev,
                "inode": os.fstat(authority._durable_root_fd).st_ino,
            },
        }
        authority._write_journal()
        authority.remove_transaction_outputs()
        assert not sidecar.exists()
        sidecar.write_bytes(b"replacement-wal")

        with pytest.raises(MigrationBlocked, match="transaction output changed"):
            authority.remove_transaction_outputs()

    assert sidecar.read_bytes() == b"replacement-wal"


@pytest.mark.parametrize(
    ("output_name", "is_directory"),
    [
        ("config.json", False),
        ("prompts.sqlite", False),
        ("Models", True),
    ],
)
def test_rollback_preserves_changed_transaction_created_outputs(
    output_name, is_directory, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
        preflight_standard_outputs,
    )

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    legacy.mkdir(mode=0o700)
    durable.mkdir(mode=0o700)
    paths = MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")

    with ApplicationMigration(paths) as authority:
        authority.begin()
        preflight = preflight_standard_outputs(legacy, durable)
        output = durable / output_name
        if is_directory:
            output.mkdir(mode=0o700)
            (output / "model.bin").write_bytes(b"transaction model")
        else:
            output.write_bytes(b"transaction output")
        durable_info = os.fstat(authority._durable_root_fd)
        authority._journal = {
            **authority._journal,
            "preflightDataManifest": preflight,
            "durableDirectory": {
                "device": durable_info.st_dev,
                "inode": durable_info.st_ino,
            },
        }
        authority._write_journal()
        authority.record_transaction_output_identities(preflight)
        recorded = json.loads(paths.journal_path.read_text())[
            "transactionOutputIdentities"
        ][output_name]
        if is_directory:
            assert recorded["entryCount"] == 1
            assert len(recorded["treeSHA256"]) == 64
            assert recorded["serializedBytes"] > 0
        else:
            assert recorded["sha256"] == hashlib.sha256(
                b"transaction output"
            ).hexdigest()

        if is_directory:
            child = output / "model.bin"
            child.unlink()
            child.write_bytes(b"replacement model")
        else:
            output.unlink()
            output.write_bytes(b"replacement output")

        with pytest.raises(MigrationBlocked, match="transaction output changed"):
            authority.remove_transaction_outputs()

    if is_directory:
        assert (output / "model.bin").read_bytes() == b"replacement model"
    else:
        assert output.read_bytes() == b"replacement output"


@pytest.mark.parametrize(
    ("output_name", "is_directory"),
    [("config.json", False), ("Models", True)],
)
def test_rollback_does_not_delete_a_replacement_swapped_after_identity_check(
    output_name, is_directory, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import application_migration
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
        preflight_standard_outputs,
    )

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    legacy.mkdir(mode=0o700)
    durable.mkdir(mode=0o700)
    paths = MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")

    with ApplicationMigration(paths) as authority:
        authority.begin()
        preflight = preflight_standard_outputs(legacy, durable)
        output = durable / output_name
        if is_directory:
            output.mkdir(mode=0o700)
            (output / "transaction.bin").write_bytes(b"transaction")
        else:
            output.write_bytes(b"transaction")
        durable_info = os.fstat(authority._durable_root_fd)
        authority._journal = {
            **authority._journal,
            "preflightDataManifest": preflight,
            "durableDirectory": {
                "device": durable_info.st_dev,
                "inode": durable_info.st_ino,
            },
        }
        authority._write_journal()
        authority.record_transaction_output_identities(preflight)

        calls = 0
        durable_identity = (durable_info.st_dev, durable_info.st_ino)
        helper_name = (
            "_directory_identity_at" if is_directory else "_regular_file_identity_at"
        )
        original_identity = getattr(application_migration, helper_name)

        def swap_after_second_check(parent_fd, name):
            nonlocal calls
            identity = original_identity(parent_fd, name)
            parent_info = os.fstat(parent_fd)
            if name == output_name and (
                parent_info.st_dev,
                parent_info.st_ino,
            ) == durable_identity:
                calls += 1
                if calls == 2:
                    if is_directory:
                        os.rename(
                            name,
                            f".{name}.recorded",
                            src_dir_fd=parent_fd,
                            dst_dir_fd=parent_fd,
                        )
                        os.mkdir(name, 0o700, dir_fd=parent_fd)
                        replacement_dir_fd = os.open(
                            name,
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=parent_fd,
                        )
                        try:
                            replacement_fd = os.open(
                                "replacement.bin",
                                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                                0o600,
                                dir_fd=replacement_dir_fd,
                            )
                            os.write(replacement_fd, b"replacement")
                            os.close(replacement_fd)
                        finally:
                            os.close(replacement_dir_fd)
                    else:
                        os.unlink(name, dir_fd=parent_fd)
                        replacement_fd = os.open(
                            name,
                            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                            0o600,
                            dir_fd=parent_fd,
                        )
                        os.write(replacement_fd, b"replacement")
                        os.close(replacement_fd)
            return identity

        monkeypatch.setattr(
            application_migration,
            helper_name,
            swap_after_second_check,
        )
        with pytest.raises(MigrationBlocked, match="transaction output changed"):
            authority.remove_transaction_outputs()

    if is_directory:
        assert (output / "replacement.bin").read_bytes() == b"replacement"
    else:
        assert output.read_bytes() == b"replacement"


@pytest.mark.parametrize("nested", [False, True])
def test_transaction_directory_identity_rejects_too_many_entries_before_journal(
    nested, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
        preflight_standard_outputs,
    )

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    legacy.mkdir(mode=0o700)
    durable.mkdir(mode=0o700)
    paths = MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")
    preflight = preflight_standard_outputs(legacy, durable)
    output = durable / "Models"
    output.mkdir(mode=0o700)
    entry_root = output
    if nested:
        entry_root = output / "nested"
        entry_root.mkdir(mode=0o700)
    for index in range(10_001):
        (entry_root / f"entry-{index:05d}").touch(mode=0o600)

    with ApplicationMigration(paths) as authority:
        authority.begin()
        durable_info = os.fstat(authority._durable_root_fd)
        authority._journal = {
            **authority._journal,
            "preflightDataManifest": preflight,
            "durableDirectory": {
                "device": durable_info.st_dev,
                "inode": durable_info.st_ino,
            },
        }
        authority._write_journal()
        journal_before = paths.journal_path.read_bytes()
        descriptor_count_before = len(os.listdir("/dev/fd"))
        with pytest.raises(MigrationBlocked, match="too many entries"):
            authority.record_transaction_output_identities(preflight)
        assert paths.journal_path.read_bytes() == journal_before
        assert not (paths.journal_dir / "rollback-quarantine").exists()
        assert len(os.listdir("/dev/fd")) == descriptor_count_before


def test_transaction_directory_identity_rejects_excessive_depth_before_journal(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
        preflight_standard_outputs,
    )

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    legacy.mkdir(mode=0o700)
    durable.mkdir(mode=0o700)
    paths = MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")
    preflight = preflight_standard_outputs(legacy, durable)
    output = durable / "Models"
    output.mkdir(mode=0o700)
    current = output
    for index in range(65):
        current = current / f"d{index}"
        current.mkdir(mode=0o700)

    with ApplicationMigration(paths) as authority:
        authority.begin()
        durable_info = os.fstat(authority._durable_root_fd)
        authority._journal = {
            **authority._journal,
            "preflightDataManifest": preflight,
            "durableDirectory": {
                "device": durable_info.st_dev,
                "inode": durable_info.st_ino,
            },
        }
        authority._write_journal()
        journal_before = paths.journal_path.read_bytes()
        with pytest.raises(MigrationBlocked, match="too deeply nested"):
            authority.record_transaction_output_identities(preflight)
        assert paths.journal_path.read_bytes() == journal_before
        assert not (paths.journal_dir / "rollback-quarantine").exists()


@pytest.mark.parametrize("failing_fstat_call", [2, 3])
def test_transaction_directory_identity_closes_fds_when_fstat_fails(
    failing_fstat_call, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import application_migration

    durable = tmp_path / "durable"
    output = durable / "Models"
    (output / "nested").mkdir(parents=True, mode=0o700)
    root_fd = os.open(durable, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    original_fstat = application_migration.os.fstat
    calls = 0

    def fail_selected_fstat(file_fd):
        nonlocal calls
        calls += 1
        if calls == failing_fstat_call:
            raise OSError("injected fstat failure")
        return original_fstat(file_fd)

    descriptor_count_before = len(os.listdir("/dev/fd"))
    monkeypatch.setattr(application_migration.os, "fstat", fail_selected_fstat)
    try:
        with pytest.raises(OSError, match="injected fstat failure"):
            application_migration._directory_identity_at(root_fd, "Models")
    finally:
        monkeypatch.setattr(application_migration.os, "fstat", original_fstat)
        os.close(root_fd)
    assert len(os.listdir("/dev/fd")) == descriptor_count_before - 1


@pytest.mark.parametrize("failure", ["fstat", "fsync"])
def test_private_child_directory_closes_fd_when_validation_fails(
    failure, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import application_migration

    parent = tmp_path / "private"
    parent.mkdir(mode=0o700)
    parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    original_fstat = application_migration.os.fstat
    original_fsync = application_migration.os.fsync
    fsync_calls = 0

    def injected_fstat(file_fd):
        raise OSError("injected fstat failure")

    def fail_child_fsync(file_fd):
        nonlocal fsync_calls
        fsync_calls += 1
        if fsync_calls == 2:
            raise OSError("injected fsync failure")
        return original_fsync(file_fd)

    if failure == "fstat":
        monkeypatch.setattr(application_migration.os, "fstat", injected_fstat)
    else:
        monkeypatch.setattr(application_migration.os, "fsync", fail_child_fsync)
    descriptor_count_before = len(os.listdir("/dev/fd"))
    try:
        with pytest.raises(OSError, match=f"injected {failure} failure"):
            application_migration._open_private_child_directory_at(
                parent_fd,
                "child",
                create=True,
            )
    finally:
        monkeypatch.setattr(application_migration.os, "fstat", original_fstat)
        monkeypatch.setattr(application_migration.os, "fsync", original_fsync)
        os.close(parent_fd)
    assert len(os.listdir("/dev/fd")) == descriptor_count_before - 1


def test_python_authority_runs_exact_node_leaf_and_journals_verified_publication(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import ApplicationMigration, MigrationPaths

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    legacy.mkdir(mode=0o700)
    durable.mkdir(mode=0o700)
    (legacy / "config.json").write_bytes(b'{"legacy":true}\n')
    node = tmp_path / "Yulu.app" / "Contents" / "Resources" / "node" / "bin" / "node"
    server_js = tmp_path / "Yulu.app" / "Contents" / "Resources" / "yulu_ui" / "dist" / "server.js"
    node.parent.mkdir(parents=True)
    server_js.parent.mkdir(parents=True)
    node.write_bytes(b"node")
    server_js.write_bytes(b"server")
    calls = []

    def run(arguments, **options):
        calls.append((arguments, options))
        (durable / "config.json").write_bytes((legacy / "config.json").read_bytes())
        return SimpleNamespace(returncode=0, stdout="prepared\n", stderr="")

    paths = MigrationPaths(
        durable_root=durable,
        cache_root=tmp_path / "cache",
    )
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.publish_standard_data(
            legacy_root=legacy,
            node_executable=node,
            server_js=server_js,
            run=run,
        )

    assert calls[0][0] == [str(node), str(server_js), "--prepare-application-data"]
    assert calls[0][1]["cwd"] == server_js.parent
    assert calls[0][1]["env"]["YULU_APPLICATION_SUPPORT_DIR"] == str(durable)
    assert calls[0][1]["env"]["YULU_LEGACY_READ_ONLY_DATA_DIR"] == str(legacy)
    journal = json.loads(paths.journal_path.read_text())
    assert journal["phase"] == "data_published"
    assert journal["dataManifest"]["config.json"]["reused"] is True


@pytest.mark.parametrize("unsafe", ["root_symlink", "queue_symlink"])
def test_python_authority_rejects_unsafe_legacy_queue_before_node_leaf(
    unsafe, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import ApplicationMigration, MigrationBlocked, MigrationPaths

    actual_legacy = tmp_path / "actual-legacy"
    actual_legacy.mkdir(mode=0o700)
    outside = tmp_path / "outside-queue.json"
    outside.write_text("[]\n")
    if unsafe == "root_symlink":
        legacy = tmp_path / "legacy"
        legacy.symlink_to(actual_legacy, target_is_directory=True)
        (actual_legacy / "agent-queue.json").write_text("[]\n")
    else:
        legacy = actual_legacy
        (legacy / "agent-queue.json").symlink_to(outside)
    node = tmp_path / "node"
    server = tmp_path / "server.js"
    node.write_bytes(b"node")
    server.write_bytes(b"server")
    calls = []

    with ApplicationMigration(
        MigrationPaths(
            durable_root=tmp_path / "durable",
            cache_root=tmp_path / "cache",
        )
    ) as authority:
        authority.begin()
        with pytest.raises(MigrationBlocked, match="legacy Agent queue"):
            authority.publish_standard_data(
                legacy_root=legacy,
                node_executable=node,
                server_js=server,
                run=lambda *arguments, **options: calls.append((arguments, options)),
            )

    assert calls == []
    assert outside.read_text() == "[]\n"


def test_python_authority_publishes_queue_outputs_from_inherited_fds_only(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import application_migration
    from application_migration import ApplicationMigration, MigrationBlocked, MigrationPaths

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    legacy.mkdir(mode=0o700)
    durable.mkdir(mode=0o700)
    queue_raw = b"[]\n"
    (legacy / "agent-queue.json").write_bytes(queue_raw)
    node = tmp_path / "node"
    server = tmp_path / "server.js"
    node.write_bytes(b"node")
    server.write_bytes(b"server")
    observed = {}
    fsynced_directories = []
    original_fsync = application_migration.os.fsync

    def track_fsync(file_fd):
        info = os.fstat(file_fd)
        if stat.S_ISDIR(info.st_mode):
            fsynced_directories.append((info.st_dev, info.st_ino))
        return original_fsync(file_fd)

    monkeypatch.setattr(application_migration.os, "fsync", track_fsync)

    def run(_arguments, **options):
        environment = options["env"]
        observed["pass_fds"] = options["pass_fds"]
        assert "YULU_LEGACY_AGENT_QUEUE_ARCHIVE_PATH" not in environment
        assert "YULU_LEGACY_AGENT_QUEUE_AUDIT_PATH" not in environment
        archive_fd = int(environment["YULU_LEGACY_AGENT_QUEUE_ARCHIVE_FD"])
        audit_fd = int(environment["YULU_LEGACY_AGENT_QUEUE_AUDIT_FD"])
        os.write(archive_fd, queue_raw)
        audit = {
            "version": 2,
            "migratedAt": environment["YULU_MIGRATION_TIMESTAMP"],
            "sourcePath": str(legacy / "agent-queue.json"),
            "archivePath": environment["YULU_LEGACY_AGENT_QUEUE_ARCHIVE_NAME"],
            "auditPath": environment["YULU_LEGACY_AGENT_QUEUE_AUDIT_NAME"],
            "total": 0,
            "actionable": 0,
            "alreadyMaterialized": 0,
            "retiredPending": 0,
            "unresolvable": 0,
            "archived": 0,
            "items": [],
        }
        os.write(audit_fd, (json.dumps(audit) + "\n").encode())
        os.fsync(archive_fd)
        os.fsync(audit_fd)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    paths = MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.publish_standard_data(
            legacy_root=legacy,
            node_executable=node,
            server_js=server,
            run=run,
        )
        stamp = hashlib.sha256(queue_raw).hexdigest()[:16]
        archive = durable / "legacy-agent-queue" / f"agent-queue.legacy.{stamp}.json"
        audit = durable / "legacy-agent-queue" / f"agent-queue.migration.{stamp}.json"
        assert archive.read_bytes() == queue_raw
        assert json.loads(audit.read_bytes())["total"] == 0

        authority.publish_standard_data(
            legacy_root=legacy,
            node_executable=node,
            server_js=server,
            run=run,
        )
        assert archive.read_bytes() == queue_raw

        archive.write_bytes(b"preexisting-conflict")
        with pytest.raises(MigrationBlocked, match="output conflicts"):
            authority.publish_standard_data(
                legacy_root=legacy,
                node_executable=node,
                server_js=server,
                run=run,
            )
        assert archive.read_bytes() == b"preexisting-conflict"

    assert all(type(file_fd) is int for file_fd in observed["pass_fds"])
    archive_info = (durable / "legacy-agent-queue").stat()
    assert (archive_info.st_dev, archive_info.st_ino) in fsynced_directories
    assert (legacy / "agent-queue.json").read_bytes() == queue_raw


def test_python_queue_publish_fails_closed_when_archive_directory_is_swapped(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import ApplicationMigration, MigrationBlocked, MigrationPaths

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    outside = tmp_path / "outside"
    anchored = tmp_path / "anchored"
    for directory in (legacy, durable, outside):
        directory.mkdir(mode=0o700)
    queue_raw = b"[]\n"
    (legacy / "agent-queue.json").write_bytes(queue_raw)
    node = tmp_path / "node"
    server = tmp_path / "server.js"
    node.write_bytes(b"node")
    server.write_bytes(b"server")

    def run(_arguments, **options):
        environment = options["env"]
        archive_dir = durable / "legacy-agent-queue"
        archive_dir.rename(anchored)
        archive_dir.symlink_to(outside, target_is_directory=True)
        os.write(int(environment["YULU_LEGACY_AGENT_QUEUE_ARCHIVE_FD"]), queue_raw)
        os.write(
            int(environment["YULU_LEGACY_AGENT_QUEUE_AUDIT_FD"]),
            json.dumps({"version": 2, "items": [], "total": 0}).encode(),
        )
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    with ApplicationMigration(
        MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")
    ) as authority:
        authority.begin()
        with pytest.raises(MigrationBlocked, match="private migration directory changed"):
            authority.publish_standard_data(
                legacy_root=legacy,
                node_executable=node,
                server_js=server,
                run=run,
            )

    assert list(outside.iterdir()) == []
    assert list(anchored.iterdir()) == []
    assert (legacy / "agent-queue.json").read_bytes() == queue_raw


def test_node_leaf_timeout_kills_its_process_group_and_reaps_the_child(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, _run_node_leaf_bounded

    pid_file = tmp_path / "leaf.pid"
    descendant_pid_file = tmp_path / "leaf-descendant.pid"
    descendant_program = (
        "import os,signal,time,pathlib;"
        f"pathlib.Path({str(descendant_pid_file)!r}).write_text(str(os.getpid()));"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN);"
        "time.sleep(60)"
    )
    program = (
        "import os,signal,time,pathlib,subprocess,sys;"
        f"pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()));"
        f"subprocess.Popen([sys.executable,'-c',{descendant_program!r}]);"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN);"
        "time.sleep(60)"
    )
    with pytest.raises(MigrationBlocked, match="timed out"):
        _run_node_leaf_bounded(
            [sys.executable, "-c", program],
            cwd=tmp_path,
            env={},
            pass_fds=(),
            timeout_seconds=0.25,
            termination_grace_seconds=0.05,
        )

    pids = [int(pid_file.read_text()), int(descendant_pid_file.read_text())]
    deadline = time.monotonic() + 3
    for pid in pids:
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            if time.monotonic() >= deadline:
                pytest.fail(f"timed-out Node leaf process remained alive: {pid}")
            time.sleep(0.01)


def test_python_authority_rejects_node_leaf_that_mutates_legacy_data(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
    )

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    legacy.mkdir(mode=0o700)
    durable.mkdir(mode=0o700)
    original = b'{"source":"legacy"}\n'
    tampered = b'{"source":"mutated-by-leaf"}\n'
    (legacy / "config.json").write_bytes(original)
    node = tmp_path / "node"
    server_js = tmp_path / "server.js"
    node.write_bytes(b"node")
    server_js.write_bytes(b"server")

    def run(_arguments, **_options):
        (legacy / "config.json").write_bytes(tampered)
        (durable / "config.json").write_bytes(tampered)
        return SimpleNamespace(returncode=0, stdout="prepared\n", stderr="")

    paths = MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")
    with ApplicationMigration(paths) as authority:
        authority.begin()
        with pytest.raises(MigrationBlocked, match="legacy data changed"):
            authority.publish_standard_data(
                legacy_root=legacy,
                node_executable=node,
                server_js=server_js,
                run=run,
            )

    assert json.loads(paths.journal_path.read_text())["phase"] == "data_publishing"


def test_requires_approval_resumes_then_times_out_to_unregister_before_rollback(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import ApplicationMigration, MigrationPaths

    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    current = [datetime(2026, 8, 30, 7, 0, tzinfo=timezone.utc)]
    now = lambda: current[0]
    with ApplicationMigration(paths, now=now) as authority:
        authority.begin()
        authority.transition("data_published", intent={"action": "test-ready"})
        registration = authority.request_registration()
        awaiting = authority.observe_service_statuses(
            transaction_id=registration["transactionId"],
            nonce=registration["nonce"],
            statuses={
                "com.yulu.ui.plist": "requiresApproval",
                "com.yulu.audiodaemon.plist": "requiresApproval",
            },
        )

    assert awaiting["action"] == "await_approval"
    assert datetime.fromisoformat(awaiting["deadlineAt"]) - current[0] == timedelta(
        minutes=10
    )

    current[0] += timedelta(minutes=9, seconds=59)
    with ApplicationMigration(paths, now=now) as resumed:
        action = resumed.resume_pending_registration()
    assert action["action"] == "observe_services"
    assert action["nonce"] == registration["nonce"]

    current[0] += timedelta(seconds=2)
    with ApplicationMigration(paths, now=now) as expired:
        action = expired.resume_pending_registration()
    assert action == {
        "action": "unregister_services",
        "reason": "approval_timeout",
        "transactionId": registration["transactionId"],
        "nonce": registration["nonce"],
        "services": ["com.yulu.ui.plist", "com.yulu.audiodaemon.plist"],
    }
    assert json.loads(paths.journal_path.read_text())["phase"] == "rollback_requested"


def test_registration_observation_is_transaction_and_nonce_bound(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
    )

    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.transition("data_published", intent={"action": "test-ready"})
        action = authority.request_registration()
        with pytest.raises(MigrationBlocked, match="stale service observation"):
            authority.observe_service_statuses(
                transaction_id=action["transactionId"],
                nonce="stale",
                statuses={
                    "com.yulu.ui.plist": "enabled",
                    "com.yulu.audiodaemon.plist": "enabled",
                },
            )
        result = authority.observe_service_statuses(
            transaction_id=action["transactionId"],
            nonce=action["nonce"],
            statuses={
                "com.yulu.ui.plist": "enabled",
                "com.yulu.audiodaemon.plist": "enabled",
            },
        )

    assert result["action"] == "verify_health"
    assert json.loads(paths.journal_path.read_text())["phase"] == "services_enabled"


def test_user_cancel_requires_confirmed_unregistration_before_legacy_restore(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
    )

    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.transition("data_published", intent={"action": "test-ready"})
        registration = authority.request_registration()
        unregister = authority.request_rollback("user_cancelled")
        assert unregister["action"] == "unregister_services"
        with pytest.raises(MigrationBlocked, match="registered services remain"):
            authority.confirm_services_unregistered(
                transaction_id=registration["transactionId"],
                nonce=registration["nonce"],
                statuses={
                    "com.yulu.ui.plist": "enabled",
                    "com.yulu.audiodaemon.plist": "notRegistered",
                },
            )

    assert json.loads(paths.journal_path.read_text())["phase"] == "rollback_blocked"

    # A fresh transaction demonstrates the successful, fail-closed branch.
    second_paths = MigrationPaths(
        durable_root=tmp_path / "durable-2",
        cache_root=tmp_path / "cache-2",
    )
    with ApplicationMigration(second_paths) as authority:
        authority.begin()
        authority.transition("data_published", intent={"action": "test-ready"})
        registration = authority.request_registration()
        authority.request_rollback("user_cancelled")
        action = authority.confirm_services_unregistered(
            transaction_id=registration["transactionId"],
            nonce=registration["nonce"],
            statuses={
                "com.yulu.ui.plist": "notRegistered",
                "com.yulu.audiodaemon.plist": "notFound",
            },
        )

    assert action["action"] == "restore_legacy"
    assert json.loads(second_paths.journal_path.read_text())["phase"] == "rolling_back"


def test_commit_health_is_nonce_bound_and_requires_two_distinct_attested_owners(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationBlocked,
        MigrationPaths,
    )

    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.transition("data_published", intent={"action": "test-ready"})
        registration = authority.request_registration()
        authority.observe_service_statuses(
            transaction_id=registration["transactionId"],
            nonce=registration["nonce"],
            statuses={
                "com.yulu.ui.plist": "enabled",
                "com.yulu.audiodaemon.plist": "enabled",
            },
        )
        with pytest.raises(MigrationBlocked, match="stale health observation"):
            authority.observe_commit_health(
                transaction_id=registration["transactionId"],
                nonce="stale",
                host={"running": True, "ownerPID": 101, "port": 7777},
                capture={"running": True, "ownerPID": 202, "socketOwned": True},
            )
        result = authority.observe_commit_health(
            transaction_id=registration["transactionId"],
            nonce=registration["nonce"],
            host={"running": True, "ownerPID": 101, "port": 7777},
            capture={"running": True, "ownerPID": 202, "socketOwned": True},
        )
        with pytest.raises(MigrationBlocked, match="wrong phase"):
            authority.observe_service_statuses(
                transaction_id=registration["transactionId"],
                nonce=registration["nonce"],
                statuses={
                    "com.yulu.ui.plist": "enabled",
                    "com.yulu.audiodaemon.plist": "enabled",
                },
            )

    assert result["action"] == "committed"
    assert json.loads(paths.journal_path.read_text())["phase"] == "committed"


def test_commit_health_rejects_one_process_claiming_both_runtime_owners(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import ApplicationMigration, MigrationPaths

    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.transition("data_published", intent={"action": "test-ready"})
        registration = authority.request_registration()
        authority.observe_service_statuses(
            transaction_id=registration["transactionId"],
            nonce=registration["nonce"],
            statuses={
                "com.yulu.ui.plist": "enabled",
                "com.yulu.audiodaemon.plist": "enabled",
            },
        )
        result = authority.observe_commit_health(
            transaction_id=registration["transactionId"],
            nonce=registration["nonce"],
            host={"running": True, "ownerPID": 101, "port": 7777},
            capture={"running": True, "ownerPID": 101, "socketOwned": True},
        )

    assert result["action"] == "unregister_services"
    assert result["reason"] == "commit_health_failed"
    assert json.loads(paths.journal_path.read_text())["phase"] == "rollback_requested"


@pytest.mark.parametrize(
    "corrupt_name",
    ["prompts.sqlite", "vocab.sqlite", "search.sqlite", "host.sqlite"],
)
def test_final_commit_reopens_all_standard_sqlite_and_validates_installed_app(
    corrupt_name, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        MigrationBlocked,
        _application_bundle_manifest,
        _sqlite_identity,
        verify_final_commit_inputs,
    )

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    app = tmp_path / "Yulu.app"
    legacy.mkdir(mode=0o700)
    durable.mkdir(mode=0o700)
    required_files = [
        app / "Contents/Info.plist",
        app / "Contents/MacOS/yulu_app",
        app / "Contents/Resources/runtime/bin/node",
        app / "Contents/Resources/Host/server.js",
        app / "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
    ]
    for file in required_files:
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b"bundled file")

    schemas = {
        "prompts.sqlite": ("prompts", ["CREATE TABLE prompts(id INTEGER PRIMARY KEY, text TEXT)"]),
        "vocab.sqlite": ("vocab", ["CREATE TABLE custom_words(id INTEGER PRIMARY KEY, word TEXT)"]),
        "search.sqlite": (
            "search",
            [
                "CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT)",
                "CREATE TABLE docs_meta(id INTEGER PRIMARY KEY, source TEXT)",
            ],
        ),
        "host.sqlite": ("host", ["CREATE TABLE agent_tasks(id INTEGER PRIMARY KEY, state TEXT)"]),
    }
    manifest = {}
    for name, (kind, statements) in schemas.items():
        path = durable / name
        database = sqlite3.connect(path)
        for statement in statements:
            database.execute(statement)
        database.commit()
        database.close()
        identity = _sqlite_identity(path, kind)
        manifest[name] = {
            "kind": "sqlite",
            "sourceSchemaSHA256": identity["schemaSHA256"],
            "destinationSchemaSHA256": identity["schemaSHA256"],
        }
    app_observation = {
        "installed": True,
        "bundlePath": str(app.resolve()),
        "executablePath": str((app / "Contents/MacOS/yulu_app").resolve()),
        "codeIdentity": development_code_identity("com.yulu.app"),
    }
    bundle_manifest = _application_bundle_manifest(app)

    verify_final_commit_inputs(
        legacy_root=legacy,
        durable_root=durable,
        data_manifest=manifest,
        app_bundle=app,
        required_app_bundle=app,
        app_observation=app_observation,
        bundle_manifest=bundle_manifest,
        allow_development_adhoc=True,
    )

    with pytest.raises(MigrationBlocked, match="code identity evidence"):
        verify_final_commit_inputs(
            legacy_root=legacy,
            durable_root=durable,
            data_manifest=manifest,
            app_bundle=app,
            required_app_bundle=app,
            app_observation=app_observation,
            bundle_manifest=bundle_manifest,
        )

    server = app / "Contents/Resources/Host/server.js"
    server.write_bytes(b"changed after preflight")
    with pytest.raises(MigrationBlocked, match="evidence changed"):
        verify_final_commit_inputs(
            legacy_root=legacy,
            durable_root=durable,
            data_manifest=manifest,
            app_bundle=app,
            required_app_bundle=app,
            app_observation=app_observation,
            bundle_manifest=bundle_manifest,
            allow_development_adhoc=True,
        )
    server.write_bytes(b"bundled file")

    (durable / corrupt_name).write_bytes(b"not sqlite")
    with pytest.raises(MigrationBlocked, match="invalid SQLite"):
        verify_final_commit_inputs(
            legacy_root=legacy,
            durable_root=durable,
            data_manifest=manifest,
            app_bundle=app,
            required_app_bundle=app,
            app_observation=app_observation,
            bundle_manifest=bundle_manifest,
            allow_development_adhoc=True,
        )
    with pytest.raises(MigrationBlocked, match="installed application evidence"):
        verify_final_commit_inputs(
            legacy_root=legacy,
            durable_root=durable,
            data_manifest=manifest,
            app_bundle=app,
            required_app_bundle=app,
            app_observation={**app_observation, "bundlePath": str(tmp_path / "Other.app")},
            bundle_manifest=bundle_manifest,
            allow_development_adhoc=True,
        )


@pytest.mark.parametrize(
    ("identifier", "expected"),
    [
        ("com.yulu.app", "com.yulu.app"),
        ("node", "node"),
        ("com.yulu.audiodaemon", "com.yulu.audiodaemon"),
    ],
)
def test_code_identity_observations_require_exact_product_identity(identifier, expected, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, _validate_code_identity_observation

    valid = {
        **development_code_identity(identifier),
        "teamIdentifier": "WMU9678ZQL",
    }
    _validate_code_identity_observation(
        valid,
        expected_identifier=expected,
        allow_development_adhoc=False,
    )
    for replacement in (
        {**valid, "accepted": False},
        {**valid, "identifier": "com.attacker.service"},
        {**valid, "teamIdentifier": "EVILTEAM01"},
        {**valid, "staticDynamicMatch": False},
        {**valid, "cdHash": "not-a-hash"},
    ):
        with pytest.raises(MigrationBlocked, match="code identity evidence"):
            _validate_code_identity_observation(
                replacement,
                expected_identifier=expected,
                allow_development_adhoc=False,
            )


@pytest.mark.parametrize(
    "failure",
    ["database", "application", "host_identity", "capture_identity"],
)
def test_final_commit_input_failure_unregisters_before_same_session_rollback(
    failure, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationPaths,
        _application_bundle_manifest,
        _atomic_write_json,
        _sqlite_identity,
        run_migration_session,
        run_migration_step,
        snapshot_legacy_jobs,
    )

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    agents = tmp_path / "LaunchAgents"
    app = tmp_path / "Yulu.app"
    for directory in (legacy, durable, agents):
        directory.mkdir(mode=0o700)
    (legacy / "config.json").write_text("{}\n")
    for file in (
        app / "Contents/Info.plist",
        app / "Contents/MacOS/yulu_app",
        app / "Contents/Resources/runtime/bin/node",
        app / "Contents/Resources/Host/server.js",
        app / "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
    ):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b"bundled file")
    prompts = durable / "prompts.sqlite"
    database = sqlite3.connect(prompts)
    database.execute("CREATE TABLE prompts(id INTEGER PRIMARY KEY, text TEXT)")
    database.commit()
    database.close()
    identity = _sqlite_identity(prompts, "prompts")

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(returncode=113 if arguments[0] == "print" else 0, stdout="", stderr="")

    paths = MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")
    with ApplicationMigration(paths) as authority:
        authority.begin()
        authority.record_bundle_manifest(_application_bundle_manifest(app))
        authority.record_job_snapshot(snapshot_legacy_jobs(agents, launchctl=launchctl))
        authority.transition("data_published", intent={"action": "test-ready"})
        authority._journal = {
            **authority._journal,
            "dataManifest": {
                "prompts.sqlite": {
                    "kind": "sqlite",
                    "sourceSchemaSHA256": identity["schemaSHA256"],
                    "destinationSchemaSHA256": identity["schemaSHA256"],
                }
            },
        }
        _atomic_write_json(paths.journal_path, authority._journal)
        registration = authority.request_registration()
        authority.observe_service_statuses(
            transaction_id=registration["transactionId"],
            nonce=registration["nonce"],
            statuses={
                "com.yulu.ui.plist": "enabled",
                "com.yulu.audiodaemon.plist": "enabled",
            },
        )

    app_evidence = {
        "installed": True,
        "bundlePath": str(app.resolve()),
        "executablePath": str((app / "Contents/MacOS/yulu_app").resolve()),
        "codeIdentity": development_code_identity("com.yulu.app"),
    }
    if failure == "database":
        prompts.write_bytes(b"not sqlite")
    elif failure == "application":
        app_evidence["bundlePath"] = str(tmp_path / "Other.app")
    host_identity = development_code_identity("node")
    capture_identity = development_code_identity("com.yulu.audiodaemon")
    if failure == "host_identity":
        host_identity["identifier"] = "com.attacker.host"
    elif failure == "capture_identity":
        capture_identity["staticDynamicMatch"] = False
    message = {
        "transactionId": registration["transactionId"],
        "nonce": registration["nonce"],
        "observation": {
            "kind": "health",
            "transactionId": registration["transactionId"],
            "nonce": registration["nonce"],
            "app": app_evidence,
            "host": {
                "running": True,
                "ownerPID": 101,
                "port": 7777,
                "codeIdentity": host_identity,
            },
            "capture": {
                "running": True,
                "ownerPID": 202,
                "socketOwned": True,
                "codeIdentity": capture_identity,
            },
        },
    }
    input_stream = tempfile.TemporaryFile()
    input_stream.write((json.dumps(message) + "\n").encode())
    input_stream.seek(0)
    first = True

    def active_health_step(**arguments):
        nonlocal first
        if first:
            first = False
            with ApplicationMigration(paths) as authority:
                return authority._service_action("verify_health")
        return run_migration_step(**arguments)

    adapter_actions = []
    try:
        result = run_migration_session(
            paths=paths,
            step=active_health_step,
            home_dir=tmp_path,
            legacy_root=legacy,
            launch_agents_dir=agents,
            archive_dir=tmp_path / "archive",
            legacy_capture_socket=legacy / "audio_daemon.sock",
            node_executable=app / "Contents/Resources/runtime/bin/node",
            server_js=app / "Contents/Resources/Host/server.js",
            app_bundle=app,
            required_app_bundle=app,
            allow_development_adhoc=True,
            launchctl=launchctl,
            input_stream=input_stream,
            output_stream=io.BytesIO(),
            service_adapter=lambda action: adapter_actions.append(action) or {
                "com.yulu.ui.plist": "notRegistered",
                "com.yulu.audiodaemon.plist": "notFound",
            },
        )
    finally:
        input_stream.close()

    assert result == 0
    assert [action["action"] for action in adapter_actions] == ["unregister_services"]
    assert json.loads(paths.journal_path.read_text())["phase"] == "rolled_back"


def test_fresh_migration_step_runs_the_single_authority_to_registration_request(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationPaths, run_migration_step

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    cache = tmp_path / "cache"
    agents = tmp_path / "LaunchAgents"
    archive = tmp_path / "archive"
    for directory in (legacy, durable, agents):
        directory.mkdir(mode=0o700)
    custom_media = tmp_path / "Custom Media" / "Yulu"
    protected_roots = {
        "keychain": tmp_path / "Library" / "Keychains",
        "tcc": tmp_path / "Library" / "Application Support" / "com.apple.TCC",
        "agent_credentials": tmp_path / "External Agent" / "credentials",
        "custom_media": custom_media,
    }
    for name, directory in protected_roots.items():
        directory.mkdir(parents=True, mode=0o700)
        marker = directory / f"{name}.sentinel"
        marker.write_bytes(f"protected-{name}".encode())
        marker.chmod(0o600)

    def protected_snapshot():
        return {
            name: [
                (
                    str(path.relative_to(directory)),
                    path.read_bytes(),
                    path.stat().st_mode & 0o777,
                )
                for path in sorted(directory.rglob("*"))
                if path.is_file()
            ]
            for name, directory in protected_roots.items()
        }

    protected_before = protected_snapshot()
    (legacy / "config.json").write_text(
        json.dumps({"legacy": True, "audio": {"output_dir": str(custom_media)}})
        + "\n"
    )
    node = tmp_path / "Yulu.app" / "Contents/Resources/runtime/bin/node"
    server_js = tmp_path / "Yulu.app" / "Contents/Resources/Host/server.js"
    node.parent.mkdir(parents=True)
    server_js.parent.mkdir(parents=True)
    node.write_bytes(b"node")
    server_js.write_bytes(b"server")

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(returncode=113, stdout="", stderr="")

    def run_node(arguments, **options):
        (durable / "config.json").write_bytes((legacy / "config.json").read_bytes())
        return SimpleNamespace(returncode=0, stdout="prepared\n", stderr="")

    action = run_migration_step(
        paths=MigrationPaths(durable_root=durable, cache_root=cache),
        home_dir=tmp_path,
        legacy_root=legacy,
        launch_agents_dir=agents,
        archive_dir=archive,
        legacy_capture_socket=legacy / "audio_daemon.sock",
        node_executable=node,
        server_js=server_js,
        launchctl=launchctl,
        run_node=run_node,
    )

    assert action["action"] == "register_services"
    assert action["services"] == [
        "com.yulu.ui.plist",
        "com.yulu.audiodaemon.plist",
    ]
    journal = json.loads((durable / "application-migration/journal.json").read_text())
    assert journal["phase"] == "registration_requested"
    assert set(journal["jobSnapshot"]) == {
        "com.yulu.ui",
        "com.yulu.audiodaemon",
        "com.yulu.statusagent",
        "com.yulu.scheduler",
        "com.yulu.detector",
        "com.yulu.calendar",
        "com.yulu.sttdaemon",
        "com.yulu.agentqueue",
    }
    assert protected_snapshot() == protected_before


def _prepare_user_cancelled_migration(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationPaths, run_migration_step

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    cache = tmp_path / "cache"
    agents = tmp_path / "LaunchAgents"
    archive = tmp_path / "archive"
    app = tmp_path / "Yulu.app"
    for directory in (legacy, durable, agents):
        directory.mkdir(mode=0o700)
    (legacy / "config.json").write_text('{"legacy":true}\n')
    for file in (
        app / "Contents/Info.plist",
        app / "Contents/MacOS/yulu_app",
        app / "Contents/Resources/runtime/bin/node",
        app / "Contents/Resources/Host/server.js",
        app / "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
    ):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b"bundled file")

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        return SimpleNamespace(
            returncode=113 if arguments[0] == "print" else 0,
            stdout="",
            stderr="",
        )

    def run_node(_arguments, **_options):
        (durable / "config.json").write_bytes((legacy / "config.json").read_bytes())
        return SimpleNamespace(returncode=0, stdout="prepared\n", stderr="")

    paths = MigrationPaths(durable_root=durable, cache_root=cache)
    common = {
        "paths": paths,
        "home_dir": tmp_path,
        "legacy_root": legacy,
        "launch_agents_dir": agents,
        "archive_dir": archive,
        "legacy_capture_socket": legacy / "audio_daemon.sock",
        "node_executable": app / "Contents/Resources/runtime/bin/node",
        "server_js": app / "Contents/Resources/Host/server.js",
        "launchctl": launchctl,
        "run_node": run_node,
    }
    registration = run_migration_step(**common)
    unregister = run_migration_step(**common, event="cancel")
    rolled_back = run_migration_step(
        **common,
        observation={
            "kind": "services",
            "transactionId": unregister["transactionId"],
            "nonce": unregister["nonce"],
            "statuses": {
                "com.yulu.ui.plist": "notRegistered",
                "com.yulu.audiodaemon.plist": "notFound",
            },
        },
    )
    assert rolled_back["action"] == "rolled_back"
    assert not (durable / "config.json").exists()
    return paths, common, app, registration


def test_explicit_retry_restarts_a_user_cancelled_transaction_and_can_commit(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, run_migration_step

    paths, common, app, previous = _prepare_user_cancelled_migration(
        tmp_path, monkeypatch
    )
    previous_journal = json.loads(paths.journal_path.read_text())
    previous_transaction = previous_journal["transactionId"]
    previous_nonce = previous["nonce"]
    assert run_migration_step(**common) == {"action": "rolled_back"}
    assert json.loads(paths.journal_path.read_text()) == previous_journal

    registration = run_migration_step(
        **common,
        app_bundle=app,
        required_app_bundle=app,
        allow_development_adhoc=True,
        request_retry=True,
    )
    retried_journal = json.loads(paths.journal_path.read_text())
    assert registration["action"] == "register_services"
    assert registration["transactionId"] != previous_transaction
    assert registration["nonce"] != previous_nonce
    assert retried_journal["retryOf"] == previous_transaction
    assert retried_journal["attemptNumber"] == 2
    assert all(
        entry["plistSnapshot"] is None
        or f"/{registration['transactionId']}/" in entry["plistSnapshot"]
        for entry in retried_journal["jobSnapshot"].values()
    )
    snapshots = paths.journal_dir / "rollback-snapshots"
    assert (snapshots / previous_transaction).is_dir()
    assert (snapshots / registration["transactionId"]).is_dir()

    stale_observation = {
        "kind": "services",
        "transactionId": previous_transaction,
        "nonce": previous_nonce,
        "statuses": {
            "com.yulu.ui.plist": "enabled",
            "com.yulu.audiodaemon.plist": "enabled",
        },
    }
    with pytest.raises(MigrationBlocked, match="stale service observation"):
        run_migration_step(**common, observation=stale_observation)
    assert json.loads(paths.journal_path.read_text())["phase"] == "registration_requested"

    verify = run_migration_step(
        **common,
        observation={
            **stale_observation,
            "transactionId": registration["transactionId"],
            "nonce": registration["nonce"],
        },
    )
    assert verify["action"] == "verify_health"
    committed = run_migration_step(
        **common,
        app_bundle=app,
        required_app_bundle=app,
        allow_development_adhoc=True,
        observation={
            "kind": "health",
            "transactionId": registration["transactionId"],
            "nonce": registration["nonce"],
            "app": {
                "installed": True,
                "bundlePath": str(app.resolve()),
                "executablePath": str((app / "Contents/MacOS/yulu_app").resolve()),
                "codeIdentity": development_code_identity("com.yulu.app"),
            },
            "host": {
                "running": True,
                "ownerPID": 101,
                "port": 7777,
                "codeIdentity": development_code_identity("node"),
            },
            "capture": {
                "running": True,
                "ownerPID": 202,
                "socketOwned": True,
                "codeIdentity": development_code_identity("com.yulu.audiodaemon"),
            },
        },
    )
    assert committed["action"] == "committed"
    assert json.loads(paths.journal_path.read_text())["phase"] == "committed"


def test_retry_resnapshots_legal_legacy_changes_after_rollback(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import run_migration_step

    paths, common, _app, _previous = _prepare_user_cancelled_migration(
        tmp_path, monkeypatch
    )
    changed = b'{"changed-after-rollback":true}\n'
    (common["legacy_root"] / "config.json").write_bytes(changed)
    changed_plist = b"changed legacy job\n"
    (common["launch_agents_dir"] / "com.yulu.ui.plist").write_bytes(changed_plist)

    registration = run_migration_step(**common, request_retry=True)

    journal = json.loads(paths.journal_path.read_text())
    assert registration["action"] == "register_services"
    assert journal["preflightDataManifest"]["config.json"]["sourceSHA256"] == (
        hashlib.sha256(changed).hexdigest()
    )
    assert journal["jobSnapshot"]["com.yulu.ui"]["plistSHA256"] == (
        hashlib.sha256(changed_plist).hexdigest()
    )
    assert journal["jobSnapshot"]["com.yulu.ui"]["plistSnapshot"].startswith(
        f"rollback-snapshots/{registration['transactionId']}/"
    )
    assert (paths.durable_root / "config.json").read_bytes() == changed


@pytest.mark.parametrize(
    "unsafe_state",
    [
        "missing-legacy",
        "capture-active",
        "rollback-residue",
        "transaction-output-residue",
    ],
)
def test_retry_fails_closed_if_rollback_is_not_clean(
    unsafe_state, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationBlocked, run_migration_step

    paths, common, _app, _previous = _prepare_user_cancelled_migration(
        tmp_path, monkeypatch
    )
    journal_before = paths.journal_path.read_bytes()
    if unsafe_state == "missing-legacy":
        (common["legacy_root"] / "config.json").unlink()
        common["legacy_root"].rmdir()
    elif unsafe_state == "capture-active":
        capture = common["launch_agents_dir"] / "com.yulu.audiodaemon.plist"
        capture.write_bytes(
            plistlib.dumps({"Program": str(tmp_path / "legacy-capture")})
        )

        def launchctl(arguments):
            if arguments[0] == "print-disabled":
                return SimpleNamespace(returncode=0, stdout="{}", stderr="")
            label = arguments[-1].rsplit("/", 1)[-1]
            return SimpleNamespace(
                returncode=(
                    0
                    if arguments[0] == "print"
                    and label == "com.yulu.audiodaemon"
                    else 113
                    if arguments[0] == "print"
                    else 0
                ),
                stdout="",
                stderr="",
            )

        common["launchctl"] = launchctl
    elif unsafe_state == "rollback-residue":
        (common["archive_dir"] / "unexpected.plist").write_text("residue\n")
    else:
        (paths.durable_root / "config.json").write_bytes(
            (common["legacy_root"] / "config.json").read_bytes()
        )

    with pytest.raises(
        MigrationBlocked,
        match="retry preflight|legacy install|cannot prove legacy Capture is idle",
    ):
        run_migration_step(**common, request_retry=True)

    assert paths.journal_path.read_bytes() == journal_before


@pytest.mark.parametrize(
    "phase",
    [None, "preflight", "blocked", "committed"],
)
def test_retry_flag_is_rejected_outside_exact_rolled_back_phase(
    phase, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import ApplicationMigration, MigrationBlocked, MigrationPaths

    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    with ApplicationMigration(paths) as authority:
        if phase is not None:
            authority.begin()
            if phase != "preflight":
                authority.transition(phase, intent={"action": "test"})
        with pytest.raises(MigrationBlocked, match="rolled-back"):
            authority.begin_retry(archive_dir=tmp_path / "archive")


def test_session_retry_flag_is_explicit_and_only_reaches_the_initial_step(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import MigrationPaths, run_migration_session

    calls = []

    def step(**arguments):
        calls.append(arguments)
        if len(calls) == 1:
            return {
                "action": "observe_services",
                "transactionId": "transaction-123",
                "nonce": "nonce-123",
            }
        return {"action": "committed"}

    message = {
        "transactionId": "transaction-123",
        "nonce": "nonce-123",
        "observation": {
            "kind": "services",
            "transactionId": "transaction-123",
            "nonce": "nonce-123",
            "statuses": {},
        },
    }
    output = io.BytesIO()
    with tempfile.TemporaryFile() as input_stream:
        input_stream.write((json.dumps(message) + "\n").encode())
        input_stream.seek(0)
        result = run_migration_session(
            paths=MigrationPaths(
                durable_root=tmp_path / "durable",
                cache_root=tmp_path / "cache",
            ),
            step=step,
            request_retry=True,
            input_stream=input_stream,
            output_stream=output,
        )

    assert result == 0
    assert calls[0]["request_retry"] is True
    assert "request_retry" not in calls[1]


def test_session_retry_rejection_does_not_recover_or_mutate_an_active_transaction(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationPaths,
        run_migration_session,
    )

    legacy = tmp_path / "legacy"
    legacy.mkdir(mode=0o700)
    paths = MigrationPaths(
        durable_root=tmp_path / "durable",
        cache_root=tmp_path / "cache",
    )
    with ApplicationMigration(paths) as authority:
        authority.begin()
    journal_before = paths.journal_path.read_bytes()
    output = io.BytesIO()

    result = run_migration_session(
        paths=paths,
        home_dir=tmp_path,
        legacy_root=legacy,
        launch_agents_dir=tmp_path / "LaunchAgents",
        archive_dir=tmp_path / "archive",
        legacy_capture_socket=legacy / "audio_daemon.sock",
        node_executable=tmp_path / "node",
        server_js=tmp_path / "server.js",
        request_retry=True,
        input_stream=io.BytesIO(),
        output_stream=output,
    )

    assert result == 75
    assert json.loads(output.getvalue())["action"] == "blocked"
    assert paths.journal_path.read_bytes() == journal_before


def test_retry_journal_stages_only_fresh_pre_mutation_recovery_metadata(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import ApplicationMigration

    paths, common, _app, _previous = _prepare_user_cancelled_migration(
        tmp_path, monkeypatch
    )
    previous = json.loads(paths.journal_path.read_text())

    with ApplicationMigration(paths) as authority:
        retried = authority.begin_retry(archive_dir=common["archive_dir"])

    assert retried["retryPreflightOnly"] is True
    assert retried["archiveDirectory"] == previous["archiveDirectory"]
    assert retried["transactionOutputIdentities"] == {}
    assert "jobSnapshot" not in retried
    assert retried["retryOf"] == previous["transactionId"]
    assert retried["attemptNumber"] == 2


def test_session_pre_mutation_retry_failure_rolls_back_and_allows_attempt_three(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import application_migration
    from application_migration import (
        MigrationBlocked,
        run_migration_session,
        run_migration_step,
    )

    paths, common, app, _previous = _prepare_user_cancelled_migration(
        tmp_path, monkeypatch
    )
    first = json.loads(paths.journal_path.read_text())
    original_preflight = application_migration.preflight_standard_outputs
    preflight_calls = 0

    def fail_after_retry_begins(*arguments, **options):
        nonlocal preflight_calls
        preflight_calls += 1
        if preflight_calls == 2:
            raise MigrationBlocked("injected post-begin retry preflight failure")
        return original_preflight(*arguments, **options)

    monkeypatch.setattr(
        application_migration,
        "preflight_standard_outputs",
        fail_after_retry_begins,
    )
    output = io.BytesIO()
    session_arguments = {key: value for key, value in common.items() if key != "paths"}
    result = run_migration_session(
        paths=paths,
        request_retry=True,
        input_stream=io.BytesIO(),
        output_stream=output,
        **session_arguments,
    )

    assert result == 0
    assert json.loads(output.getvalue()) == {"action": "rolled_back"}
    failed = json.loads(paths.journal_path.read_text())
    assert failed["transactionId"] != first["transactionId"]
    assert failed["retryOf"] == first["transactionId"]
    assert failed["attemptNumber"] == 2
    assert failed["phase"] == "rolled_back"
    assert failed["retryPreflightOnly"] is True
    assert not (paths.durable_root / "config.json").exists()
    assert not os.listdir(common["archive_dir"])
    assert run_migration_step(**common) == {"action": "rolled_back"}

    monkeypatch.setattr(
        application_migration,
        "preflight_standard_outputs",
        original_preflight,
    )
    registration = run_migration_step(
        **common,
        app_bundle=app,
        request_retry=True,
    )
    third = json.loads(paths.journal_path.read_text())
    assert registration["action"] == "register_services"
    assert third["transactionId"] != failed["transactionId"]
    assert third["retryOf"] == failed["transactionId"]
    assert third["retryRoot"] == first["transactionId"]
    assert third["attemptNumber"] == 3
    assert "retryPreflightOnly" not in third
    snapshots = paths.journal_dir / "rollback-snapshots"
    assert (snapshots / first["transactionId"]).is_dir()
    assert not (snapshots / failed["transactionId"]).exists()
    assert (snapshots / third["transactionId"]).is_dir()

    verify = run_migration_step(
        **common,
        observation={
            "kind": "services",
            "transactionId": registration["transactionId"],
            "nonce": registration["nonce"],
            "statuses": {
                "com.yulu.ui.plist": "enabled",
                "com.yulu.audiodaemon.plist": "enabled",
            },
        },
    )
    assert verify["action"] == "verify_health"
    committed = run_migration_step(
        **common,
        app_bundle=app,
        required_app_bundle=app,
        allow_development_adhoc=True,
        observation={
            "kind": "health",
            "transactionId": registration["transactionId"],
            "nonce": registration["nonce"],
            "app": {
                "installed": True,
                "bundlePath": str(app.resolve()),
                "executablePath": str(
                    (app / "Contents/MacOS/yulu_app").resolve()
                ),
                "codeIdentity": development_code_identity("com.yulu.app"),
            },
            "host": {
                "running": True,
                "ownerPID": 303,
                "port": 7777,
                "codeIdentity": development_code_identity("node"),
            },
            "capture": {
                "running": True,
                "ownerPID": 404,
                "socketOwned": True,
                "codeIdentity": development_code_identity(
                    "com.yulu.audiodaemon"
                ),
            },
        },
    )
    assert committed["action"] == "committed"
    assert json.loads(paths.journal_path.read_text())["phase"] == "committed"


@pytest.mark.parametrize(
    "phase",
    [
        "preflight",
        "guarded",
        "snapshotted",
        "legacy_quiescing",
        "legacy_quiesced",
        "data_publishing",
        "data_published",
        "registration_requested",
        "awaiting_approval",
        "services_enabled",
        "verifying",
    ],
)
def test_crash_recovery_at_each_phase_restores_old_runnable_state_or_resumes_approval(
    phase, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_migration import (
        ApplicationMigration,
        MigrationPaths,
        _atomic_write_json,
        run_migration_step,
        snapshot_legacy_jobs,
    )

    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    agents = tmp_path / "LaunchAgents"
    archive = tmp_path / "archive"
    for directory in (legacy, durable, agents):
        directory.mkdir(mode=0o700)
    legacy_config = b'{"rollback":"readable"}\n'
    (legacy / "config.json").write_bytes(legacy_config)
    plist_bytes = plistlib.dumps(
        {
            "Label": "com.yulu.ui",
            "ProgramArguments": ["/legacy/yulu"],
        }
    )
    (agents / "com.yulu.ui.plist").write_bytes(plist_bytes)
    (agents / "com.yulu.ui.plist").chmod(0o640)
    loaded = {"com.yulu.ui"}
    disabled = {"com.yulu.calendar"}

    def launchctl(arguments):
        if arguments[0] == "print-disabled":
            body = "\n".join(f'"{label}" => true' for label in disabled)
            return SimpleNamespace(returncode=0, stdout=body, stderr="")
        if arguments[0] == "print":
            label = arguments[-1].rsplit("/", 1)[-1]
            return SimpleNamespace(
                returncode=0 if label in loaded else 113, stdout="", stderr=""
            )
        if arguments[0] == "bootout":
            loaded.discard(arguments[-1].rsplit("/", 1)[-1])
        elif arguments[0] == "bootstrap":
            loaded.add(Path(arguments[-1]).stem)
        elif arguments[0] == "disable":
            disabled.add(arguments[-1].rsplit("/", 1)[-1])
        elif arguments[0] == "enable":
            disabled.discard(arguments[-1].rsplit("/", 1)[-1])
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    paths = MigrationPaths(durable_root=durable, cache_root=tmp_path / "cache")
    registration = None
    with ApplicationMigration(paths) as authority:
        authority.begin()
        if phase != "preflight":
            authority.transition("guarded", intent={"action": "injected-crash"})
        snapshot = None
        if phase not in {"preflight", "guarded"}:
            snapshot = snapshot_legacy_jobs(agents, launchctl=launchctl)
            authority.record_job_snapshot(snapshot)
        if phase in {
            "legacy_quiescing",
            "legacy_quiesced",
            "data_publishing",
            "data_published",
            "registration_requested",
            "awaiting_approval",
            "services_enabled",
            "verifying",
        }:
            archive.mkdir(mode=0o700)
            archive_info = archive.stat()
            authority._journal = {
                **authority._journal,
                "archiveDirectory": {
                    "device": archive_info.st_dev,
                    "inode": archive_info.st_ino,
                },
            }
            _atomic_write_json(paths.journal_path, authority._journal)
            (agents / "com.yulu.ui.plist").rename(archive / "com.yulu.ui.plist")
            loaded.clear()
            authority.transition(phase if phase.startswith("legacy_") else "legacy_quiesced", intent={"action": "injected-crash"})
        if phase in {"data_publishing", "data_published", "registration_requested", "awaiting_approval", "services_enabled", "verifying"}:
            authority.transition(
                "data_published" if phase != "data_publishing" else "data_publishing",
                intent={"action": "injected-crash"},
            )
        if phase in {"registration_requested", "awaiting_approval", "services_enabled", "verifying"}:
            if phase == "data_publishing":
                raise AssertionError("unreachable")
            registration = authority.request_registration()
        if phase == "awaiting_approval":
            authority.observe_service_statuses(
                transaction_id=registration["transactionId"],
                nonce=registration["nonce"],
                statuses={
                    "com.yulu.ui.plist": "requiresApproval",
                    "com.yulu.audiodaemon.plist": "requiresApproval",
                },
            )
        elif phase in {"services_enabled", "verifying"}:
            authority.observe_service_statuses(
                transaction_id=registration["transactionId"],
                nonce=registration["nonce"],
                statuses={
                    "com.yulu.ui.plist": "enabled",
                    "com.yulu.audiodaemon.plist": "enabled",
                },
            )
            if phase == "verifying":
                authority.transition("verifying", intent={"action": "injected-crash"})

    node = tmp_path / "node"
    server_js = tmp_path / "server.js"
    node.write_bytes(b"unused")
    server_js.write_bytes(b"unused")
    common = dict(
        paths=paths,
        home_dir=tmp_path,
        legacy_root=legacy,
        launch_agents_dir=agents,
        archive_dir=archive,
        legacy_capture_socket=legacy / "audio_daemon.sock",
        node_executable=node,
        server_js=server_js,
        launchctl=launchctl,
    )
    action = run_migration_step(**common)
    if phase == "awaiting_approval":
        assert action["action"] == "observe_services"
        assert not (agents / "com.yulu.ui.plist").exists()
        return
    if action["action"] == "unregister_services":
        action = run_migration_step(
            **common,
            observation={
                "kind": "services",
                "transactionId": action["transactionId"],
                "nonce": action["nonce"],
                "statuses": {
                    "com.yulu.ui.plist": "notRegistered",
                    "com.yulu.audiodaemon.plist": "notFound",
                },
            },
        )
    assert action["action"] == "rolled_back"
    assert (agents / "com.yulu.ui.plist").read_bytes() == plist_bytes
    assert (agents / "com.yulu.ui.plist").stat().st_mode & 0o777 == 0o640
    assert loaded == {"com.yulu.ui"}
    assert disabled == {"com.yulu.calendar"}
    assert (legacy / "config.json").read_bytes() == legacy_config
