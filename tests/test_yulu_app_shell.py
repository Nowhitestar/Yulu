from pathlib import Path
import ctypes
import fcntl
import io
import plistlib
import json
import os
import subprocess
import shutil
import socket
import sqlite3
import sys
import tempfile
import threading
import unicodedata

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
OUTER_INFO = SCRIPTS / "Yulu.app" / "Contents" / "Info.plist"
CAPTURE_INFO = (
    SCRIPTS
    / "Yulu.app"
    / "Contents"
    / "Helpers"
    / "YuluCapture.app"
    / "Contents"
    / "Info.plist"
)


def read_plist(path: Path) -> dict[str, object]:
    with path.open("rb") as handle:
        return plistlib.load(handle)


def compile_yulu_app_inspector(tmp_path: Path) -> Path:
    binary = tmp_path / "yulu_app"
    result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "ServiceManagement",
            "-framework",
            "Security",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return binary


def compile_audio_daemon_inspector(tmp_path: Path) -> Path:
    binary = tmp_path / "audio_daemon"
    result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "audio-swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "audio_daemon.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "ScreenCaptureKit",
            "-framework",
            "AVFoundation",
            "-framework",
            "CoreMedia",
            "-framework",
            "CoreAudio",
            "-framework",
            "AudioToolbox",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return binary


def inspect_recording_start_gate(binary: Path, cache_root: Path) -> str:
    result = subprocess.run(
        [str(binary), "--inspect-recording-start-gate", str(cache_root)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)["state"]


def test_capture_bundled_python_disables_bytecode_writes_explicitly():
    source = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    prompt = source.split("func launchMeetingSilencePrompt() -> Bool {", 1)[1].split(
        "\n}\n", 1
    )[0]

    assert 'task.arguments = ["-B", meetingDaemon.path, "auto_stop"]' in prompt
    assert 'environment["PYTHONDONTWRITEBYTECODE"] = "1"' in prompt


def test_update_public_swift_contracts_are_fail_closed_and_use_bundled_authority(
    tmp_path: Path,
):
    binary = compile_yulu_app_inspector(tmp_path)

    def inspect_configuration(payload: dict[str, object]) -> dict[str, object]:
        plist_path = tmp_path / "UpdateInfo.plist"
        with plist_path.open("wb") as handle:
            plistlib.dump(payload, handle)
        result = subprocess.run(
            [str(binary), "--inspect-update-configuration", str(plist_path)],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    secure = {
        "SUFeedURL": "https://updates.yulu.app/appcast.xml",
        "SUPublicEDKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "SUVerifyUpdateBeforeExtraction": True,
        "SURequireSignedFeed": True,
        "SUSignedFeedFailureExpirationInterval": 0,
        "SUEnableAutomaticChecks": True,
        "SUAllowsAutomaticUpdates": False,
        "SUAutomaticallyUpdate": False,
    }
    assert inspect_configuration(secure) == {
        "automaticChecks": True,
        "enabled": True,
        "explicitInstallOnly": True,
        "reason": None,
    }
    for mutation in (
        {"SUFeedURL": "http://updates.yulu.app/appcast.xml"},
        {"SUPublicEDKey": "not-a-public-key"},
        {"SUVerifyUpdateBeforeExtraction": False},
        {"SURequireSignedFeed": False},
        {"SUSignedFeedFailureExpirationInterval": 1},
        {"SUSignedFeedFailureExpirationInterval": False},
        {"SUSignedFeedFailureExpirationInterval": 0.0},
        {"SUSignedFeedFailureExpirationInterval": "0"},
        {"SUAllowsAutomaticUpdates": True},
        {"SUAutomaticallyUpdate": True},
    ):
        invalid = secure | mutation
        assert inspect_configuration(invalid)["enabled"] is False
    missing_expiration = dict(secure)
    missing_expiration.pop("SUSignedFeedFailureExpirationInterval")
    assert inspect_configuration(missing_expiration)["enabled"] is False

    termination_cases = {
        ("0", "0", "0"): True,
        ("1", "0", "0"): False,
        ("1", "1", "0"): True,
        ("1", "0", "1"): True,
    }
    for arguments, expected in termination_cases.items():
        result = subprocess.run(
            [str(binary), "--inspect-update-termination", *arguments],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == {"allowTermination": expected}

    home = tmp_path / "home"
    home.mkdir()
    result = subprocess.run(
        [
            str(binary),
            "--inspect-update-command",
            "/Applications/Yulu.app",
            str(home),
            "0.24.0",
            "741",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    command = json.loads(result.stdout)
    assert command["executable"] == (
        "/Applications/Yulu.app/Contents/Resources/runtime/python/bin/python3"
    )
    assert command["arguments"][:3] == [
        "-B",
        "/Applications/Yulu.app/Contents/Resources/runtime/yulu/scripts/application_update.py",
        "session",
    ]
    assert command["arguments"][-4:] == [
        "--target-version",
        "0.24.0",
        "--target-build",
        "741",
    ]
    assert "--host-database" in command["arguments"]


def test_update_health_payload_contains_concrete_runtime_attestation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    binary = compile_yulu_app_inspector(tmp_path)
    result = subprocess.run(
        [str(binary), "--inspect-update-health-payload", "/Applications/Yulu.app"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    health = json.loads(result.stdout)

    assert health["application"] == {
        "identifier": "com.yulu.app",
        "teamIdentifier": "WMU9678ZQL",
        "cdHash": "a" * 40,
        "version": "0.23.0",
        "build": "732",
        "pid": 101,
        "uid": os.geteuid(),
        "generation": "100:1",
        "executable": "/Applications/Yulu.app/Contents/MacOS/yulu_app",
    }
    assert health["host"] == {
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
        "executable": "/Applications/Yulu.app/Contents/Resources/runtime/bin/node",
        "hostNonce": "11111111-1111-4111-8111-111111111111",
        "instanceLockToken": "host-lock-token-1234",
        "portOwnerPID": 102,
        "database": {
            "status": "ok",
            "quickCheck": "ok",
            "schemaVersion": 1,
            "minimumReadableVersion": 1,
        },
    }
    assert health["capture"] == {
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
    }
    assert health["services"] == {
        "com.yulu.ui.plist": "enabled",
        "com.yulu.audiodaemon.plist": "enabled",
    }

    monkeypatch.syspath_prepend(str(SCRIPTS))
    from application_update import _valid_update_health

    assert _valid_update_health(
        health,
        expected={"version": "0.23.0", "build": "732"},
    )
    assert "accepted" not in json.dumps(health)


def test_capture_start_uses_the_shared_attempt_lock_and_rejects_unsafe_entries(
    tmp_path: Path,
) -> None:
    binary = compile_audio_daemon_inspector(tmp_path)
    cache_root = tmp_path / "Caches/Yulu"
    lock_dir = cache_root / "application-migration"
    lock_dir.mkdir(parents=True, mode=0o700)
    lock_path = lock_dir / "attempt.lock"

    assert inspect_recording_start_gate(binary, cache_root) == "available"
    lock_path.touch(mode=0o600)
    lock_path.chmod(0o600)
    with lock_path.open("r+") as lock_handle:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert inspect_recording_start_gate(binary, cache_root) == "busy"
    assert inspect_recording_start_gate(binary, cache_root) == "available"

    lock_path.chmod(0o644)
    assert inspect_recording_start_gate(binary, cache_root) == "unsafe"
    lock_path.unlink()
    outside = tmp_path / "outside-lock"
    outside.touch(mode=0o600)
    outside.chmod(0o600)
    os.link(outside, lock_path)
    assert inspect_recording_start_gate(binary, cache_root) == "unsafe"
    lock_path.unlink()
    lock_path.symlink_to(outside)
    assert inspect_recording_start_gate(binary, cache_root) == "unsafe"


def test_update_session_and_capture_start_share_one_live_attempt_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    binary = compile_audio_daemon_inspector(tmp_path)
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
    database.chmod(0o600)

    class GateObservingInput(io.StringIO):
        def __init__(self, messages: list[dict[str, object]]) -> None:
            super().__init__(
                "\n".join(json.dumps(message) for message in messages) + "\n"
            )
            self.states: list[str] = []

        def readline(self, *args, **kwargs):
            self.states.append(inspect_recording_start_gate(binary, paths.cache_root))
            return super().readline(*args, **kwargs)

    # A start can win before the updater locks; the authoritative locked
    # recording recheck then defers without creating any update journal.
    raced_input = GateObservingInput([{"recording": False}, {"recording": True}])
    raced = run_update_session(
        paths=paths,
        application_path=application,
        current_version="0.23.0-rc.4",
        current_build="731",
        target_version="0.23.0",
        target_build="732",
        databases={"host": database},
        input_stream=raced_input,
        output_stream=io.StringIO(),
    )
    assert raced["action"] == "defer_installation"
    assert raced_input.states == ["available", "busy"]
    assert not paths.journal_dir.exists()

    class GateObservingOutput(io.StringIO):
        def __init__(self) -> None:
            super().__init__()
            self.handler_state: str | None = None

        def write(self, value: str) -> int:
            if '"action":"invoke_install_handler"' in value:
                self.handler_state = inspect_recording_start_gate(
                    binary, paths.cache_root
                )
            return super().write(value)

    locked_input = GateObservingInput(
        [
            {"recording": False},
            {"recording": False},
            {
                "statuses": {
                    "com.yulu.ui.plist": "notRegistered",
                    "com.yulu.audiodaemon.plist": "notRegistered",
                },
                "owners": {
                    "host": {
                        "state": "absent",
                        "proof": "tcp-refused-owner-record-absent",
                    },
                    "capture": {
                        "state": "absent",
                        "proof": "unix-missing-or-refused",
                    },
                },
            },
            {"action": "authorize_install"},
        ]
    )
    output = GateObservingOutput()
    terminal = run_update_session(
        paths=paths,
        application_path=application,
        current_version="0.23.0-rc.4",
        current_build="731",
        target_version="0.23.0",
        target_build="732",
        databases={"host": database},
        input_stream=locked_input,
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
    assert terminal["action"] == "invoke_install_handler"
    assert locked_input.states == ["available", "busy", "busy", "busy"]
    assert output.handler_state == "busy"


def test_all_capture_recording_starts_are_guarded_before_mutation() -> None:
    source = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    start_case = source.split('case "start":', 1)[1].split('case "stop":', 1)[0]
    assert start_case.index("acquireRecordingStartGate") < start_case.index(
        "SYS_DISABLED ="
    )
    assert source.count("recorder.start(title:") == 1
    assert source.count("rec.start(title:") == 1
    assert source.count("acquireRecordingStartGate") >= 4


def test_sparkle_adapter_routes_every_install_handler_through_update_authority():
    source = (SCRIPTS / "yulu_app.swift").read_text(encoding="utf-8")
    capture_source = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    assert "SPUStandardUpdaterController" in source
    assert "shouldPostponeRelaunchForUpdate" in source
    assert "willInstallUpdateOnQuit" not in source
    assert 'item.installationType == "application"' in source
    assert "item.deltaUpdates?[currentBuild] == nil" in source
    assert "applicationShouldTerminate(_ sender: NSApplication)" in source
    assert "UpdateTerminationGate.allowTermination" in source
    assert 'forInfoDictionaryKey: "YuluReleaseVersion"' in source
    assert 'info["YuluReleaseVersion"]' in source
    assert 'forInfoDictionaryKey: "YuluReleaseVersion"' in capture_source
    coordinator = source.split("final class ApplicationUpdateCoordinator", 1)[1].split(
        "func writeJSON", 1
    )[0]
    install = coordinator.split('case "invoke_install_handler":', 1)[1].split(
        'case "register_services":', 1
    )[0]
    rollback = coordinator.split("private func launchRollbackHelper", 1)[1]
    assert 'helper.arguments = [\n            "-B",\n            script,' in rollback
    assert 'environment["PYTHONDONTWRITEBYTECODE"] = "1"' in rollback
    assert install.index("installAuthorized = true") < install.index("handler()")
    adapter = source.split("final class SparkleUpdateAdapter", 1)[1].split(
        "final class YuluApplication", 1
    )[0]
    assert adapter.count("coordinator.prepareInstall(") == 1
    termination = coordinator.split("child.terminationHandler =", 1)[1].split(
        "do {", 1
    )[0]
    assert termination.index("self.process = nil") < termination.index(
        "self.onCanStartMigration?()"
    )


def test_update_quiescence_is_tri_state_and_only_kernel_absence_passes(
    tmp_path: Path,
):
    binary = compile_yulu_app_inspector(tmp_path)
    owner = tmp_path / "host-instance.lock/owner.json"
    executable = tmp_path / "node"
    entry = tmp_path / "server.js"
    executable.write_bytes(b"")
    entry.write_bytes(b"")

    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()

    def host() -> dict[str, object]:
        result = subprocess.run(
            [
                str(binary),
                "--inspect-host-quiescence",
                str(owner),
                str(executable),
                str(entry),
                str(port),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    assert host() == {
        "state": "absent",
        "proof": "tcp-refused-owner-record-absent",
    }

    owner.parent.mkdir(mode=0o700)
    owner.write_text("not-json", encoding="utf-8")
    owner.chmod(0o600)
    assert host()["state"] == "unknown"
    owner.unlink()

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", port))
    listener.listen(1)
    try:
        assert host()["state"] == "unknown"
    finally:
        listener.close()

    capture = subprocess.run(
        [
            str(binary),
            "--inspect-capture-quiescence",
            f"/tmp/yulu-quiescence-{os.getpid()}.sock",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert capture.returncode == 0, capture.stderr
    assert json.loads(capture.stdout) == {
        "state": "absent",
        "proof": "unix-missing-or-refused",
    }


def test_one_visible_app_contains_the_established_capture_identity():
    outer = read_plist(OUTER_INFO)
    capture = read_plist(CAPTURE_INFO)

    assert outer["CFBundleExecutable"] == "yulu_app"
    assert outer["CFBundleIdentifier"] == "com.yulu.app"
    assert outer.get("LSUIElement") is not True
    assert capture["CFBundleExecutable"] == "audio_daemon"
    assert capture["CFBundleIdentifier"] == "com.yulu.audiodaemon"
    assert capture["LSUIElement"] is True

    build = (SCRIPTS / "build_audio_daemon.sh").read_text(encoding="utf-8")
    assert 'CAPTURE_APP="$APP/Contents/Helpers/YuluCapture.app"' in build
    assert '--entitlements "$CAPTURE_ENTITLEMENTS" --sign "$IDENTITY" "$CAPTURE_APP"' in build
    assert '--entitlements "$SHELL_ENTITLEMENTS" --sign "$IDENTITY" "$APP"' in build


def test_bundled_background_owners_use_only_bundle_relative_smappservice_programs():
    launch_agents = SCRIPTS / "Yulu.app" / "Contents" / "Library" / "LaunchAgents"
    expected = {
        "com.yulu.ui.plist": (
            "com.yulu.ui",
            "Contents/MacOS/yulu_app",
            ["yulu_app", "--run-host-service"],
        ),
        "com.yulu.audiodaemon.plist": (
            "com.yulu.audiodaemon",
            "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
            ["audio_daemon"],
        ),
    }

    assert {path.name for path in launch_agents.glob("*.plist")} == set(expected)
    for filename, (label, bundle_program, arguments) in expected.items():
        payload = read_plist(launch_agents / filename)
        assert payload["Label"] == label
        assert payload["BundleProgram"] == bundle_program
        assert payload["ProgramArguments"] == arguments
        assert "Program" not in payload
        assert not payload["ProgramArguments"][0].startswith("/")


def test_clean_app_output_copies_embedded_smappservice_agents_before_signing():
    build = (SCRIPTS / "build_audio_daemon.sh").read_text(encoding="utf-8")
    output_branch = build.split('if [[ "$APP" != "$APP_TEMPLATE" ]]', 1)[1].split("fi", 1)[0]

    assert 'cp -R "$APP_TEMPLATE/Contents/Library" "$APP/Contents/Library"' in output_branch


def test_runtime_node_signing_pins_the_host_code_identifier_only_for_node():
    build = (SCRIPTS / "build_audio_daemon.sh").read_text(encoding="utf-8")
    runtime_signing = build.split(
        "while IFS= read -r -d '' runtime_code; do", 1
    )[1].split("done < <", 1)[0]
    node_branch, other_runtime_code = runtime_signing.split("else", 1)

    assert '--identifier node' in node_branch
    assert '--identifier node' not in other_runtime_code
    assert build.count('--identifier node') == 1


def test_migration_stderr_is_drained_concurrently_bounded_and_redacted(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-D",
            "YULU_DEVELOPMENT_SMOKE",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "ServiceManagement",
            "-framework",
            "Security",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    lock_path = tmp_path / "attempt.lock"
    child = tmp_path / "stderr_child.py"
    secret = "migration-secret-must-never-surface"
    child.write_text(
        "import fcntl, os, sys\n"
        f"handle = open({str(lock_path)!r}, 'w')\n"
        "fcntl.flock(handle, fcntl.LOCK_EX)\n"
        f"os.write(2, ({secret!r} * 8192).encode())\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        [
            str(binary),
            "--inspect-migration-stderr-drain",
            sys.executable,
            str(child),
        ],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    observation = json.loads(result.stdout)
    assert observation == {
        "exited": True,
        "hadStderr": True,
        "redacted": True,
        "truncated": True,
    }
    assert secret not in result.stdout
    assert secret not in result.stderr
    with lock_path.open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)


def test_shell_plans_persistent_service_registration_only_from_applications(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "ServiceManagement",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    def inspect(path: str) -> dict[str, object]:
        result = subprocess.run(
            [str(binary), "--inspect-service-actions", path],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    assert inspect("/Applications/Yulu.app") == {
        "persistentFileWrites": [],
        "register": ["com.yulu.ui.plist", "com.yulu.audiodaemon.plist"],
        "unregister": [],
    }
    for path in ("/Volumes/Yulu/Yulu.app", "/Users/me/Downloads/Yulu.app"):
        assert inspect(path) == {
            "persistentFileWrites": [],
            "register": [],
            "unregister": [],
        }


def test_transaction_actions_are_nonce_bound_and_cannot_mutate_outside_applications(
    tmp_path: Path,
):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "ServiceManagement",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    action = json.dumps(
        {
            "action": "register_services",
            "transactionId": "transaction-1",
            "nonce": "nonce-1",
            "services": ["com.yulu.ui.plist", "com.yulu.audiodaemon.plist"],
        }
    )

    def inspect(bundle_path: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                str(binary),
                "--inspect-migration-service-action",
                bundle_path,
                action,
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )

    installed = inspect("/Applications/Yulu.app")
    assert installed.returncode == 0, installed.stderr
    assert json.loads(installed.stdout) == {
        "persistentFileWrites": [],
        "register": ["com.yulu.ui.plist", "com.yulu.audiodaemon.plist"],
        "unregister": [],
    }

    outside = inspect("/Volumes/Yulu/Yulu.app")
    assert outside.returncode == 0, outside.stderr
    assert json.loads(outside.stdout) == {
        "persistentFileWrites": [],
        "register": [],
        "unregister": [],
    }


def test_installed_shell_uses_the_bundled_python_migration_authority_command(
    tmp_path: Path,
):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "ServiceManagement",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    home = tmp_path / "home"
    home.mkdir()
    installed = subprocess.run(
        [
            str(binary),
            "--inspect-migration-command",
            "/Applications/Yulu.app",
            str(home),
        ],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert installed.returncode == 0, installed.stderr
    payload = json.loads(installed.stdout)
    assert payload["executable"] == (
        "/Applications/Yulu.app/Contents/Resources/runtime/python/bin/python3"
    )
    assert payload["arguments"][0] == "-B"
    assert payload["arguments"][1] == (
        "/Applications/Yulu.app/Contents/Resources/runtime/yulu/scripts/"
        "application_migration.py"
    )
    assert payload["arguments"][2] == "session"
    assert payload["arguments"] == [
        "-B",
        payload["arguments"][1],
        "session",
        "--home",
        str(home),
        "--durable",
        str(home / "Library/Application Support/Yulu"),
        "--cache",
        str(home / "Library/Caches/Yulu"),
        "--legacy",
        str(home / ".config/yulu"),
        "--launch-agents",
        str(home / "Library/LaunchAgents"),
        "--archive",
        str(
            home
            / "Library/Application Support/Yulu/application-migration/rollback/LaunchAgents"
        ),
        "--capture-socket",
        str(home / ".config/yulu/audio_daemon.sock"),
        "--node",
        "/Applications/Yulu.app/Contents/Resources/runtime/bin/node",
        "--server",
        "/Applications/Yulu.app/Contents/Resources/Host/server.js",
        "--app",
        "/Applications/Yulu.app",
    ]

    outside = subprocess.run(
        [
            str(binary),
            "--inspect-migration-command",
            "/Volumes/Yulu/Yulu.app",
            str(home),
        ],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert outside.returncode == 0, outside.stderr
    assert json.loads(outside.stdout) is None

    rollback_action = json.dumps(
        {
            "action": "unregister_services",
            "transactionId": "transaction-123",
            "nonce": "nonce-123",
            "services": ["com.yulu.ui.plist", "com.yulu.audiodaemon.plist"],
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    outside_adapter = subprocess.run(
        [str(binary), "--apply-migration-service-action", rollback_action],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert outside_adapter.returncode == 78

    source = (SCRIPTS / "yulu_app.swift").read_text(encoding="utf-8")
    launch_body = source.split(
        "func applicationDidFinishLaunching(_ notification: Notification)", 1
    )[1].split("func applicationShouldTerminateAfterLastWindowClosed", 1)[0]
    assert "backgroundServices.registerBundledOwners(policy: launchPolicy)" not in launch_body
    assert "coordinator.resume()" in launch_body
    assert "self?.startMigration()" in launch_body
    active_body = source.split(
        "func applicationDidBecomeActive(_ notification: Notification)", 1
    )[1].split("func applicationShouldHandleReopen", 1)[0]
    assert 'migrationCoordinator?.advance(event: "resume")' in active_body
    coordinator = source.split("final class ApplicationMigrationCoordinator", 1)[1].split(
        "func writeJSON", 1
    )[0]
    assert "process.standardInput = input" in coordinator
    assert "migrationProcess" in coordinator
    assert "JSONSerialization.data(withJSONObject: envelope)" in coordinator
    assert "migrationProcess?.terminate()" not in coordinator
    assert "migrationInput?.closeFile()" in coordinator
    fresh_path = coordinator.split('case "fresh_install":', 1)[1].split("case ", 1)[0]
    assert "services.registerBundledOwners(policy: policy)" in fresh_path
    assert 'onStateChange?("committed", nil)' in fresh_path


def test_service_state_contract_never_treats_approval_as_health_or_readiness(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "ServiceManagement",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    def inspect(status: str, running: str, ready: str) -> dict[str, str]:
        result = subprocess.run(
            [str(binary), "--inspect-service-state", status, running, ready],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    assert inspect("notRegistered", "unknown", "unknown") == {
        "capabilityReadiness": "unknown",
        "registration": "not_registered",
        "runningHealth": "unknown",
        "systemApproval": "unknown",
    }
    assert inspect("requiresApproval", "false", "false") == {
        "capabilityReadiness": "blocked",
        "registration": "registered",
        "runningHealth": "stopped",
        "systemApproval": "requires_approval",
    }
    assert inspect("enabled", "true", "false") == {
        "capabilityReadiness": "blocked",
        "registration": "registered",
        "runningHealth": "healthy",
        "systemApproval": "approved",
    }
    assert inspect("enabled", "true", "true") == {
        "capabilityReadiness": "ready",
        "registration": "registered",
        "runningHealth": "healthy",
        "systemApproval": "approved",
    }


def test_requires_approval_uses_login_items_settings_and_resumes_on_return(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "ServiceManagement",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    result = subprocess.run(
        [str(binary), "--inspect-approval-remediation"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "action": "open_login_items_settings",
        "path": "System Settings → General → Login Items → Allow in the Background",
        "resumeOn": "applicationDidBecomeActive",
    }

    source = (SCRIPTS / "yulu_app.swift").read_text(encoding="utf-8")
    assert "SMAppService.openSystemSettingsLoginItems()" in source
    assert "func applicationDidBecomeActive(" in source


def test_host_smappservice_mode_executes_the_bundled_host_on_the_declared_port(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-D",
            "YULU_DEVELOPMENT_SMOKE",
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "ServiceManagement",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    fake_home = tmp_path / "home"
    fake_home.mkdir()
    result = subprocess.run(
        [
            str(binary),
            "--inspect-host-service",
            "/Applications/Yulu.app",
            str(fake_home),
        ],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "arguments": ["/Applications/Yulu.app/Contents/Resources/Host/server.js"],
        "executable": "/Applications/Yulu.app/Contents/Resources/runtime/bin/node",
        "port": 7777,
        "serviceOwner": "com.yulu.ui",
    }

    source = (SCRIPTS / "yulu_app.swift").read_text(encoding="utf-8")
    assert "Darwin.execve(" in source
    assert "Darwin.execv(" not in source
    assert 'CommandLine.arguments[1] == "--run-host-service"' in source

    fake_bundle = tmp_path / "Yulu.app"
    fake_node = fake_bundle / "Contents/Resources/runtime/bin/node"
    fake_node.parent.mkdir(parents=True)
    fake_node.write_text("#!/bin/sh\n/usr/bin/env\n")
    fake_node.chmod(0o755)
    (fake_bundle / "Contents/Resources/Host").mkdir(parents=True)
    (fake_bundle / "Contents/Resources/Host/server.js").write_text("// fixture\n")
    executed = subprocess.run(
        [
            str(binary),
            "--development-run-host-service",
            str(fake_bundle),
            str(fake_home),
        ],
        env={
            **os.environ,
            "NODE_OPTIONS": "--require=/tmp/hostile.js",
            "NODE_PATH": "/tmp/hostile-node-path",
            "PYTHONPATH": "/tmp/hostile-python-path",
            "PYTHONHOME": "/tmp/hostile-python-home",
            "DYLD_TEST_HOSTILE": "must-not-survive",
        },
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert executed.returncode == 0, executed.stderr
    executed_environment = dict(
        line.split("=", 1) for line in executed.stdout.splitlines() if "=" in line
    )
    for name in (
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONPATH",
        "PYTHONHOME",
        "DYLD_TEST_HOSTILE",
    ):
        assert name not in executed_environment
    assert executed_environment["YULU_UI_PORT"] == "7777"
    assert executed_environment["YULU_SERVICE_OWNER"] == "com.yulu.ui"


def test_capture_smappservice_reports_its_owner_and_capability_readiness():
    launch_agent = read_plist(
        SCRIPTS
        / "Yulu.app"
        / "Contents"
        / "Library"
        / "LaunchAgents"
        / "com.yulu.audiodaemon.plist"
    )
    assert launch_agent["EnvironmentVariables"] == {
        "YULU_SERVICE_OWNER": "com.yulu.audiodaemon",
    }

    capture = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    assert 'let SERVICE_OWNER = ProcessInfo.processInfo.environment["YULU_SERVICE_OWNER"]' in capture
    assert '"serviceOwner": SERVICE_OWNER' in capture
    assert '"pid": ProcessInfo.processInfo.processIdentifier' in capture
    assert '"sysReady": SYS_READY' in capture
    assert '"micReady": MIC_READY' in capture


def test_runtime_evidence_requires_the_expected_owner_and_keeps_capability_separate(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-D",
            "YULU_DEVELOPMENT_SMOKE",
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "ServiceManagement",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    def inspect(
        kind: str,
        payload: dict[str, object],
        attestation: dict[str, object],
    ) -> dict[str, object]:
        result = subprocess.run(
            [
                str(binary),
                "--inspect-runtime-evidence",
                kind,
                json.dumps(payload),
                json.dumps(attestation),
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    assert inspect("host", {
        "status": "ok",
        "serviceOwner": "com.yulu.ui",
        "pid": 2468,
        "instanceLockToken": "host-lock-generation",
        "instanceNonce": "host-instance-nonce",
    }, {
        "ownerPID": 2468,
        "authorityToken": "host-lock-generation",
        "generation": "host-os-generation",
        "executableMatches": True,
        "argumentsMatch": True,
        "generationStable": True,
        "ownerUID": os.geteuid(),
        "executablePath": "/Applications/Yulu.app/Contents/Resources/runtime/node/bin/node",
    }) == {
        "capabilityReady": None,
        "ownerPID": 2468,
        "running": True,
    }
    assert inspect("capture", {
        "serviceOwner": "com.yulu.audiodaemon",
        "pid": 1357,
        "micReady": True,
        "sysReady": False,
    }, {
        "ownerPID": 1357,
        "generation": "capture-start-generation",
        "executableMatches": True,
        "argumentsMatch": True,
        "generationStable": True,
        "ownerUID": os.geteuid(),
        "executablePath": (
            "/Applications/Yulu.app/Contents/Helpers/"
            "YuluCapture.app/Contents/MacOS/audio_daemon"
        ),
    }) == {
        "capabilityReady": False,
        "ownerPID": 1357,
        "running": True,
    }
    assert inspect("host", {
        "status": "ok",
        "serviceOwner": "legacy-or-unmanaged",
        "pid": 9999,
    }, {
        "ownerPID": 9999,
        "authorityToken": "forged-lock-generation",
        "generation": "forged",
        "executableMatches": True,
        "argumentsMatch": True,
        "generationStable": True,
    }) == {
        "capabilityReady": None,
        "ownerPID": None,
        "running": False,
    }
    assert inspect("host", {
        "status": "ok",
        "serviceOwner": "com.yulu.ui",
        "pid": 2468,
        "instanceLockToken": "public-forgery",
    }, {
        "ownerPID": 9753,
        "authorityToken": "real-lock-generation",
        "generation": "real-lock-generation",
        "executableMatches": True,
        "argumentsMatch": True,
        "generationStable": True,
    })["running"] is False

    lock_dir = tmp_path / "host-instance.lock"
    lock_dir.mkdir()
    lock_dir.chmod(0o700)
    owner_file = lock_dir / "owner.json"
    host_process = subprocess.Popen(["/bin/sleep", "30"])
    try:
        owner_file.write_text(json.dumps({
            "pid": host_process.pid,
            "token": "host-lock-generation",
        }))
        owner_file.chmod(0o600)
        attested = subprocess.run(
            [
                str(binary),
                "--inspect-host-lock-attestation",
                str(owner_file),
                "/bin/sleep",
                "30",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        assert attested.returncode == 0, attested.stderr
        host_attestation = json.loads(attested.stdout)
        assert host_attestation["executableMatches"] is True
        assert host_attestation["argumentsMatch"] is True
        assert host_attestation["generationStable"] is True
        assert host_attestation["generation"]
        assert host_attestation["authorityToken"] == "host-lock-generation"
        assert host_attestation["ownerPID"] == host_process.pid

        wrong_argv = subprocess.run(
            [
                str(binary),
                "--inspect-host-lock-attestation",
                str(owner_file),
                "/bin/sleep",
                "31",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        assert wrong_argv.returncode == 0, wrong_argv.stderr
        assert json.loads(wrong_argv.stdout)["argumentsMatch"] is False

        replacement_dir = tmp_path / "replacement-host-instance.lock"
        replacement_dir.mkdir(mode=0o700)
        replacement_owner = replacement_dir / "owner.json"
        replacement_owner.write_text(json.dumps({
            "pid": os.getpid(),
            "token": "substituted-lock-generation",
        }))
        replacement_owner.chmod(0o600)
        anchored = subprocess.run(
            [
                str(binary),
                "--inspect-host-lock-attestation",
                str(owner_file),
                "/bin/sleep",
                "30",
            ],
            env={
                **os.environ,
                "YULU_TEST_SWAP_HOST_LOCK_WITH": str(replacement_dir),
            },
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        assert anchored.returncode == 0, anchored.stderr
        anchored_attestation = json.loads(anchored.stdout)
        assert anchored_attestation["ownerPID"] == host_process.pid
        assert anchored_attestation["authorityToken"] == "host-lock-generation"

        parked_lock_dir = tmp_path / "host-instance.lock.anchored-original"
        assert parked_lock_dir.is_dir()
        lock_dir = tmp_path / "host-instance.lock"
        owner_file = lock_dir / "owner.json"

        real_owner = tmp_path / "outside-owner.json"
        real_owner.write_text(owner_file.read_text())
        owner_file.unlink()
        owner_file.symlink_to(real_owner)
        rejected_symlink = subprocess.run(
            [
                str(binary),
                "--inspect-host-lock-attestation",
                str(owner_file),
                "/bin/sleep",
                "30",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        assert rejected_symlink.returncode != 0
    finally:
        host_process.terminate()
        host_process.wait(timeout=5)

    executable_buffer = ctypes.create_string_buffer(4096)
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
    assert libproc.proc_pidpath(os.getpid(), executable_buffer, len(executable_buffer)) > 0
    owner_executable = executable_buffer.value.decode()

    socket_root = Path(tempfile.mkdtemp(prefix="yulu-p164-peer-", dir="/private/tmp"))
    try:
        def inspect_capture(payload: dict[str, object]) -> dict[str, object]:
            socket_path = socket_root / f"capture-{len(list(socket_root.iterdir()))}.sock"
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(socket_path))
            server.listen(1)

            def respond() -> None:
                connection, _ = server.accept()
                with connection:
                    connection.recv(4096)
                    connection.sendall(json.dumps(payload).encode())
                server.close()

            thread = threading.Thread(target=respond)
            thread.start()
            result = subprocess.run(
                [
                    str(binary),
                    "--inspect-capture-runtime",
                    str(socket_path),
                    owner_executable,
                ],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            thread.join(timeout=5)
            assert not thread.is_alive()
            assert result.returncode == 0, result.stderr
            return json.loads(result.stdout)

        assert inspect_capture({
            "serviceOwner": "com.yulu.audiodaemon",
            "pid": os.getpid(),
            "micReady": True,
            "sysReady": True,
        }) == {
            "capabilityReady": True,
            "ownerPID": os.getpid(),
            "running": True,
        }
        assert inspect_capture({
            "serviceOwner": "com.yulu.audiodaemon",
            "pid": os.getpid() + 1,
            "micReady": True,
            "sysReady": True,
        })["running"] is False

        exiting_socket = socket_root / "capture-exiting.sock"
        identity_checked_marker = socket_root / "capture-identity-checked"
        peer = subprocess.Popen(
            [
                sys.executable,
                "-c",
                """
import ctypes, json, os, socket, sys, time
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(sys.argv[1])
server.listen(1)
buffer = ctypes.create_string_buffer(4096)
libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
assert libproc.proc_pidpath(os.getpid(), buffer, len(buffer)) > 0
print(json.dumps({'pid': os.getpid(), 'executable': buffer.value.decode()}), flush=True)
connection, _ = server.accept()
with connection:
    connection.recv(4096)
    connection.sendall(json.dumps({
        'serviceOwner': 'com.yulu.audiodaemon',
        'pid': os.getpid(),
        'micReady': True,
        'sysReady': True,
    }).encode())
for _ in range(100):
    if os.path.exists(sys.argv[2]):
        break
    time.sleep(0.01)
server.close()
""",
                str(exiting_socket),
                str(identity_checked_marker),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert peer.stdout is not None
        peer_identity = json.loads(peer.stdout.readline())
        waiter = threading.Thread(target=peer.wait)
        waiter.start()
        exited_peer_result = subprocess.run(
            [
                str(binary),
                "--inspect-capture-runtime",
                str(exiting_socket),
                peer_identity["executable"],
            ],
            env={
                **os.environ,
                "YULU_TEST_CAPTURE_AFTER_IDENTITY_MARKER": str(identity_checked_marker),
                "YULU_TEST_CAPTURE_POST_IDENTITY_DELAY_US": "250000",
            },
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        waiter.join(timeout=5)
        assert not waiter.is_alive()
        assert peer.returncode == 0, peer.stderr.read() if peer.stderr else ""
        assert exited_peer_result.returncode == 0, exited_peer_result.stderr
        assert json.loads(exited_peer_result.stdout)["running"] is False
    finally:
        shutil.rmtree(socket_root)
    assert inspect("capture", {
        "serviceOwner": "com.yulu.audiodaemon",
        "pid": 1357,
        "micReady": True,
        "sysReady": True,
    }, {
        "ownerPID": 8642,
        "generation": "capture-start-generation",
        "executableMatches": True,
        "argumentsMatch": True,
        "generationStable": True,
    })["running"] is False

    assert inspect("capture", {
        "serviceOwner": "com.yulu.audiodaemon",
        "pid": 1357,
        "micReady": True,
        "sysReady": True,
    }, {
        "ownerPID": 1357,
        "generation": "reused-pid-generation",
        "executableMatches": True,
        "argumentsMatch": True,
        "generationStable": False,
    })["running"] is False


def test_native_service_presentation_shows_four_states_and_approval_remediation(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "ServiceManagement",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    result = subprocess.run(
        [
            str(binary),
            "--inspect-service-presentation",
            "requiresApproval",
            "false",
            "false",
        ],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "remediation": {
            "action": "open_login_items_settings",
            "path": "System Settings → General → Login Items → Allow in the Background",
            "resumeOn": "applicationDidBecomeActive",
        },
        "rows": [
            {"label": "Registration", "value": "Registered"},
            {"label": "System approval", "value": "Requires approval"},
            {"label": "Running health", "value": "Stopped"},
            {"label": "Capability readiness", "value": "Blocked"},
        ],
        "title": "Background Services",
    }


def test_production_startup_plan_has_smappservice_owners_and_no_direct_children(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "ServiceManagement",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    def inspect(bundle_path: str) -> dict[str, object]:
        result = subprocess.run(
            [str(binary), "--inspect-startup-plan", bundle_path],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    assert inspect("/Applications/Yulu.app") == {
        "directChildren": [],
        "hostHealthURL": "http://127.0.0.1:7777/healthz",
        "persistentRegistrations": [
            "com.yulu.ui.plist",
            "com.yulu.audiodaemon.plist",
        ],
    }
    assert inspect("/Users/test/Downloads/Yulu.app") == {
        "directChildren": [],
        "hostHealthURL": None,
        "persistentRegistrations": [],
    }


def test_production_application_routes_smappservice_through_the_migration_coordinator():
    source = (SCRIPTS / "yulu_app.swift").read_text()
    application = source.split("final class YuluApplication", 1)[1].split(
        "let policy = LaunchPolicy.evaluate", 1
    )[0]

    assert "ApplicationMigrationCoordinator(" in application
    assert "coordinator.advance()" in application
    assert "backgroundServices.registerBundledOwners(policy: launchPolicy)" not in application
    assert "ProductSupervisor(" not in application
    assert "supervisor.start()" not in application
    assert "supervisor?.restart" not in application
    did_become_active = application.split(
        "func applicationDidBecomeActive", 1
    )[1].split("func applicationShouldHandleReopen", 1)[0]
    assert "registerBundledOwners" not in did_become_active
    assert 'migrationCoordinator?.advance(event: "resume")' in did_become_active
    assert "refreshServiceWindow()" in did_become_active
    assert "beginServicePolling()" in did_become_active

    polling = application.split("private func beginServicePolling()", 1)[1].split(
        "private func open(route:", 1
    )[0]
    assert "pollGeneration += 1" in polling
    assert "pollHost(generation: pollGeneration)" in polling
    assert "generation == pollGeneration" in polling


def test_registration_decision_only_mutates_not_registered_installed_services(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "ServiceManagement",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    def inspect(bundle_path: str, status: str) -> dict[str, object]:
        result = subprocess.run(
            [str(binary), "--inspect-registration-decision", bundle_path, status],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    assert inspect("/Applications/Yulu.app", "notRegistered") == {
        "register": True,
        "unregister": False,
    }
    for status in ("enabled", "requiresApproval", "notFound"):
        assert inspect("/Applications/Yulu.app", status) == {
            "register": False,
            "unregister": False,
        }
    assert inspect("/Users/test/Downloads/Yulu.app", "notRegistered") == {
        "register": False,
        "unregister": False,
    }


def test_native_background_services_view_reports_both_owner_states(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "ServiceManagement",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    result = subprocess.run(
        [
            str(binary),
            "--inspect-owner-presentations",
            "enabled",
            "true",
            "true",
            "requiresApproval",
            "false",
            "false",
        ],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    presentation = json.loads(result.stdout)
    assert [service["label"] for service in presentation["services"]] == [
        "Host — com.yulu.ui",
        "Capture — com.yulu.audiodaemon",
    ]
    assert presentation["services"][0]["state"]["rows"] == [
        {"label": "Registration", "value": "Registered"},
        {"label": "System approval", "value": "Approved"},
        {"label": "Running health", "value": "Healthy"},
        {"label": "Capability readiness", "value": "Ready"},
    ]
    assert presentation["services"][0]["state"].get("remediation") is None
    assert presentation["services"][1]["state"]["remediation"]["action"] == (
        "open_login_items_settings"
    )


def test_shell_allows_product_startup_only_from_applications(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    def inspect(path: str) -> dict[str, object]:
        result = subprocess.run(
            [str(binary), "--inspect-launch", path],
            env={**os.environ, "HOME": str(tmp_path / "home")},
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    installed = inspect("/Applications/Yulu.app")
    assert installed == {
        "installed": True,
        "persistentRegistrationAllowed": True,
        "componentsStarted": True,
        "guidance": None,
    }

    for path in ("/Volumes/Yulu/Yulu.app", "/Users/me/Downloads/Yulu.app"):
        outside = inspect(path)
        assert outside == {
            "installed": False,
            "persistentRegistrationAllowed": False,
            "componentsStarted": False,
            "guidance": "Drag Yulu to Applications before opening it.",
        }


def test_shell_owns_window_while_smappservice_owns_the_two_components(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    result = subprocess.run(
        [str(binary), "--inspect-bundle", "/Applications/Yulu.app"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    contract = json.loads(result.stdout)
    assert contract == {
        "windowURL": "http://127.0.0.1:7777/",
        "menuRoutes": ["/", "/onboarding", "/inbox", "/settings"],
        "host": {
            "servicePlist": "com.yulu.ui.plist",
            "bundleProgram": "Contents/MacOS/yulu_app",
            "arguments": ["yulu_app", "--run-host-service"],
            "directlySpawned": False,
        },
        "capture": {
            "servicePlist": "com.yulu.audiodaemon.plist",
            "bundleProgram": (
                "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon"
            ),
            "arguments": ["audio_daemon"],
            "directlySpawned": False,
        },
    }


def test_release_shell_excludes_the_development_smoke_entrypoint(tmp_path: Path):
    release_binary = tmp_path / "yulu_app-release"
    development_binary = tmp_path / "yulu_app-development"

    for binary, extra_flags in (
        (release_binary, []),
        (development_binary, ["-D", "YULU_DEVELOPMENT_SMOKE"]),
    ):
        result = subprocess.run(
            [
                "swiftc",
                "-module-cache-path",
                str(tmp_path / "swift-cache"),
                *extra_flags,
                "-o",
                str(binary),
                str(SCRIPTS / "yulu_app.swift"),
                "-framework",
                "Cocoa",
                "-framework",
                "WebKit",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr

    release = subprocess.run(
        [str(release_binary), "--inspect-build"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    development = subprocess.run(
        [str(development_binary), "--inspect-build"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )

    assert json.loads(release.stdout) == {"developmentSmoke": False}
    assert json.loads(development.stdout) == {"developmentSmoke": True}


def test_compiled_code_identity_attestation_binds_static_and_live_code(tmp_path: Path):
    binary = tmp_path / "yulu_app_identity_probe"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-D",
            "YULU_DEVELOPMENT_SMOKE",
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
            "-framework",
            "Security",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr
    signed = subprocess.run(
        [
            "/usr/bin/codesign",
            "--force",
            "--sign",
            "-",
            "--identifier",
            binary.name,
            str(binary),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert signed.returncode == 0, signed.stderr

    self_result = subprocess.run(
        [
            str(binary),
            "--inspect-code-identity",
            "self",
            str(binary),
            binary.name,
            "adhoc",
            "1",
        ],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert self_result.returncode == 0, self_result.stderr
    self_evidence = json.loads(self_result.stdout)
    assert self_evidence == {
        "accepted": True,
        "identifier": binary.name,
        "teamIdentifier": "adhoc",
        "cdHash": self_evidence["cdHash"],
        "staticSealValid": True,
        "dynamicValid": True,
        "staticDynamicMatch": True,
    }
    assert len(self_evidence["cdHash"]) >= 40

    sleeper = subprocess.Popen(["/bin/sleep", "30"])
    try:
        mixed = subprocess.run(
            [
                str(binary),
                "--inspect-code-identity",
                str(sleeper.pid),
                str(binary),
                binary.name,
                "adhoc",
                "1",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    finally:
        sleeper.terminate()
        sleeper.wait(timeout=5)
    assert mixed.returncode == 0, mixed.stderr
    assert json.loads(mixed.stdout)["accepted"] is False


def test_development_smoke_resolves_component_paths_from_its_fake_home(tmp_path: Path):
    binary = tmp_path / "yulu_app-development"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-D",
            "YULU_DEVELOPMENT_SMOKE",
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    fake_home = tmp_path / "smoke-home"
    (fake_home / ".config/yulu").mkdir(parents=True)
    inspected = subprocess.run(
        [str(binary), "--inspect-development-smoke-paths"],
        env={**os.environ, "HOME": str(fake_home)},
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )

    assert inspected.returncode == 0, inspected.stderr
    paths = json.loads(inspected.stdout)
    assert paths["durableDataDir"] == str(fake_home / "Library/Application Support/Yulu")
    assert paths["legacyReadOnlyDataDir"] == str(fake_home / ".config/yulu")


def test_development_smoke_prints_captured_host_failure_diagnostics():
    smoke = (SCRIPTS / "smoke_yulu_app.sh").read_text(encoding="utf-8")

    assert 'if ! HOME="$SMOKE_ROOT/home" \\' in smoke
    assert 'echo "Development Yulu.app smoke failed:" >&2' in smoke
    assert 'sed \'s/^/  /\' "$SMOKE_ROOT/smoke-error.txt" >&2' in smoke


def test_development_smoke_uses_a_real_fake_home_custom_media_library():
    smoke = (SCRIPTS / "smoke_yulu_app.sh").read_text(encoding="utf-8")

    assert 'SMOKE_MEDIA_LIBRARY="$SMOKE_ROOT/home/Custom Media/Yulu"' in smoke
    assert 'config.audio.output_dir = mediaLibrary' in smoke
    assert 'cp "$SCRIPT_DIR/config.example.json"' not in smoke
    assert '[[ -d "$SMOKE_MEDIA_LIBRARY" ]]' in smoke


def test_shell_authenticates_host_and_capture_uses_stable_runtime_paths():
    shell = (SCRIPTS / "yulu_app.swift").read_text(encoding="utf-8")
    capture = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    host = (SCRIPTS / "yulu_ui" / "src" / "server.ts").read_text(encoding="utf-8")

    assert 'hostEnvironment["YULU_HOST_NONCE"]' in shell
    assert 'json["instanceNonce"] as? String == nonce' in shell
    assert "hostIsRunning" in shell
    assert "Int.random(in: 49152...65535)" not in shell
    assert "let port = HostServiceExecution.declaredPort" in shell
    assert "LOCAL_PEERPID" in shell
    assert "proc_pidpath" in shell
    assert 'appendingPathComponent("host-instance.lock/owner.json")' in shell
    assert "let ownerURL = applicationPaths.durableDataDir" in shell
    assert 'process.env.YULU_HOST_NONCE ?? null' in host

    for name in (
        "YULU_MEDIA_LIBRARY_DIR",
        "YULU_APPLICATION_SUPPORT_DIR",
        "YULU_IPC_DIR",
        "YULU_LOG_DIR",
    ):
        assert name in capture
    assert 'SOCKET_PATH = IPC_DIR.appendingPathComponent("audio_daemon.sock")' in capture
    assert 'LOG_PATH = LOGS_DIR.appendingPathComponent("audio_daemon.log")' in capture
    assert "for configPath in CONFIG_READ_PATHS" in capture
    assert "func configuredRecordingDirectory(_ raw: String) -> URL?" in capture
    assert 'ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]' in capture
    assert 'appendingPathComponent("Contents/Resources/runtime/yulu/scripts"' in capture


def test_shell_propagates_the_standard_path_contract_to_both_runtimes():
    shell = (SCRIPTS / "yulu_app.swift").read_text(encoding="utf-8")

    for name in (
        "YULU_APPLICATION_SUPPORT_DIR",
        "YULU_MODELS_DIR",
        "YULU_CACHE_DIR",
        "YULU_IPC_DIR",
        "YULU_LOG_DIR",
        "YULU_MEDIA_LIBRARY_DIR",
        "YULU_LEGACY_READ_ONLY_DATA_DIR",
    ):
        assert name in shell
    assert "applicationPaths.environment" in shell
    assert "hostEnvironment.merge" in shell
    assert "captureEnvironment.merge" in shell


def test_native_capture_companions_use_standard_paths_with_legacy_config_reads():
    status_agent = (SCRIPTS / "status_agent.swift").read_text(encoding="utf-8")
    recorder_status = (SCRIPTS / "recorder_status.swift").read_text(encoding="utf-8")
    meeting_prompt = (SCRIPTS / "meeting_prompt.swift").read_text(encoding="utf-8")

    for source in (status_agent, recorder_status, meeting_prompt):
        assert "YULU_APPLICATION_SUPPORT_DIR" in source
        assert "YULU_LEGACY_READ_ONLY_DATA_DIR" in source
        assert "CONFIG_READ_PATHS" in source

    for name in ("YULU_IPC_DIR", "YULU_LOG_DIR", "YULU_MEDIA_LIBRARY_DIR"):
        assert name in status_agent
    assert 'PID_FILE = "\\(IPC_DIR)/status_agent.pid"' in status_agent
    assert 'LOG_FILE = "\\(LOGS_DIR)/status_agent.log"' in status_agent
    assert 'IPC_SOCKET_PATH = "\\(IPC_DIR)/status_agent.sock"' in status_agent
    assert 'static let socketPath = "\\(IPC_DIR)/audio_daemon.sock"' in status_agent
    assert 'let socketPath = "\\(IPC_DIR)/audio_daemon.sock"' in recorder_status
    assert "func configuredRecordingDirectory(_ raw: String) -> String?" in status_agent


def test_native_capture_rejects_unsafe_media_aliases_and_request_overrides():
    capture = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    status_agent = (SCRIPTS / "status_agent.swift").read_text(encoding="utf-8")

    for source in (capture, status_agent):
        assert "func canonicalDirectory(" in source
        assert "func pathsOverlap(" in source
        assert "func safeMediaDirectory(" in source
        assert "resolvingSymlinksInPath()" in source
    assert "func safeRecordingSubdirectory(" in capture
    assert 'resp = ["error":"unsafe_output_dir"]' in capture
    assert 'outputDir = URL(fileURLWithPath: dir)' not in capture


def test_native_capture_anchors_media_directory_at_recording_start():
    capture = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")

    assert "class AnchoredRecordingDirectory" in capture
    assert "Darwin.openat(" in capture
    assert "O_DIRECTORY | O_NOFOLLOW" in capture
    assert "Darwin.unlinkat(" in capture
    assert 'CommandLine.arguments.contains("--path-contract-self-test")' in capture
    assert "root swap unexpectedly created external audio" in capture


def test_shell_path_contract_reads_legacy_media_without_using_developer_home(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    fake_home = tmp_path / "isolated-home"
    legacy = fake_home / ".config/yulu"
    legacy.mkdir(parents=True)
    custom_media = tmp_path / "external-media" / "Yulu"
    (legacy / "config.json").write_text(
        json.dumps({"audio": {"output_dir": str(custom_media)}}),
        encoding="utf-8",
    )

    inspected = subprocess.run(
        [str(binary), "--inspect-paths", str(fake_home)],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )

    assert inspected.returncode == 0, inspected.stderr
    assert json.loads(inspected.stdout) == {
        "cacheDir": str(fake_home / "Library/Caches/Yulu"),
        "configFile": str(fake_home / "Library/Application Support/Yulu/config.json"),
        "configReadFiles": [
            str(fake_home / "Library/Application Support/Yulu/config.json"),
            str(legacy / "config.json"),
        ],
        "durableDataDir": str(fake_home / "Library/Application Support/Yulu"),
        "ipcDir": str(fake_home / "Library/Caches/Yulu"),
        "legacyReadOnlyDataDir": str(legacy),
        "logsDir": str(fake_home / "Library/Logs/Yulu"),
        "mediaLibraryDir": str(custom_media),
        "modelsDir": str(fake_home / "Library/Application Support/Yulu/Models"),
    }

    standard = fake_home / "Library/Application Support/Yulu/config.json"
    standard.parent.mkdir(parents=True)
    standard_media = tmp_path / "standard-media" / "Yulu"
    standard.write_text(
        json.dumps({"audio": {"output_dir": str(standard_media)}}),
        encoding="utf-8",
    )
    propagated = subprocess.run(
        [str(binary), "--inspect-component-paths", str(fake_home)],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert propagated.returncode == 0, propagated.stderr
    expected_environment = {
        "YULU_APPLICATION_SUPPORT_DIR": str(fake_home / "Library/Application Support/Yulu"),
        "YULU_CACHE_DIR": str(fake_home / "Library/Caches/Yulu"),
        "YULU_IPC_DIR": str(fake_home / "Library/Caches/Yulu"),
        "YULU_LEGACY_READ_ONLY_DATA_DIR": str(legacy),
        "YULU_LOG_DIR": str(fake_home / "Library/Logs/Yulu"),
        "YULU_MEDIA_LIBRARY_DIR": str(standard_media),
        "YULU_MODELS_DIR": str(fake_home / "Library/Application Support/Yulu/Models"),
    }
    assert json.loads(propagated.stdout) == {
        "capture": expected_environment,
        "host": expected_environment,
    }

    cache = fake_home / "Library/Caches/Yulu"
    cache.mkdir(parents=True)
    media_alias = fake_home / "media-alias"
    media_alias.symlink_to(cache, target_is_directory=True)
    standard.write_text(
        json.dumps({"audio": {"output_dir": str(media_alias)}}),
        encoding="utf-8",
    )
    (legacy / "config.json").write_text(
        json.dumps({"audio": {"output_dir": "../relative-media"}}),
        encoding="utf-8",
    )
    rejected = subprocess.run(
        [str(binary), "--inspect-paths", str(fake_home)],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert rejected.returncode == 0, rejected.stderr
    assert json.loads(rejected.stdout)["mediaLibraryDir"] == str(fake_home / "Movies/Yulu")

    durable = fake_home / "Library/Application Support/Yulu"
    legacy_alias = fake_home / "legacy-alias"
    legacy_alias.symlink_to(durable, target_is_directory=True)
    unsafe = subprocess.run(
        [str(binary), "--inspect-paths-environment", str(fake_home)],
        env={
            **os.environ,
            "YULU_APPLICATION_SUPPORT_DIR": "../relative-data",
            "YULU_MODELS_DIR": str(legacy),
            "YULU_CACHE_DIR": str(cache / "../../Application Support/Yulu"),
            "YULU_IPC_DIR": str(fake_home / "outside-ipc"),
            "YULU_LOG_DIR": str(durable),
            "YULU_MEDIA_LIBRARY_DIR": str(media_alias),
            "YULU_LEGACY_READ_ONLY_DATA_DIR": str(legacy_alias),
        },
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert unsafe.returncode == 0, unsafe.stderr
    unsafe_paths = json.loads(unsafe.stdout)
    assert unsafe_paths["durableDataDir"] == str(durable)
    assert unsafe_paths["modelsDir"] == str(durable / "Models")
    assert unsafe_paths["cacheDir"] == str(cache)
    assert unsafe_paths["ipcDir"] == str(cache)
    assert unsafe_paths["logsDir"] == str(fake_home / "Library/Logs/Yulu")
    assert unsafe_paths["mediaLibraryDir"] == str(fake_home / "Movies/Yulu")
    assert unsafe_paths["legacyReadOnlyDataDir"] == str(legacy)

    legacy_media_collision = subprocess.run(
        [str(binary), "--inspect-paths-environment", str(fake_home)],
        env={
            **os.environ,
            "YULU_LEGACY_READ_ONLY_DATA_DIR": str(fake_home / "Movies/Yulu"),
        },
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert legacy_media_collision.returncode == 0, legacy_media_collision.stderr
    collision_paths = json.loads(legacy_media_collision.stdout)
    assert collision_paths["legacyReadOnlyDataDir"] == str(legacy)
    assert collision_paths["mediaLibraryDir"] == str(fake_home / "Movies/Yulu")

    loop = fake_home / "media-loop"
    dangling = fake_home / "media-dangling"
    blocked = fake_home / "not-a-directory"
    loop.symlink_to(loop, target_is_directory=True)
    dangling.symlink_to(fake_home / "missing-target", target_is_directory=True)
    blocked.write_text("file")
    standard.write_text(
        json.dumps({"audio": {"output_dir": f"{fake_home}/bad\0path"}}),
        encoding="utf-8",
    )
    (legacy / "config.json").write_text(
        json.dumps({"audio": {"output_dir": str(dangling)}}),
        encoding="utf-8",
    )
    malformed = subprocess.run(
        [str(binary), "--inspect-paths-environment", str(fake_home)],
        env={**os.environ, "YULU_MEDIA_LIBRARY_DIR": str(loop)},
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert malformed.returncode == 0, malformed.stderr
    assert json.loads(malformed.stdout)["mediaLibraryDir"] == str(
        fake_home / "Movies/Yulu"
    )

    standard.write_text(
        json.dumps({"audio": {"output_dir": str(blocked / "child")}}),
        encoding="utf-8",
    )
    unusable = subprocess.run(
        [str(binary), "--inspect-paths-environment", str(fake_home)],
        env={**os.environ, "YULU_MEDIA_LIBRARY_DIR": str(dangling)},
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert unusable.returncode == 0, unusable.stderr
    assert json.loads(unusable.stdout)["mediaLibraryDir"] == str(
        fake_home / "Movies/Yulu"
    )

    durable_target = fake_home / "targets/durable"
    media_target = fake_home / "targets/media"
    durable_target.mkdir(parents=True)
    media_target.mkdir(parents=True)
    durable_alias = fake_home / "durable-stable-alias"
    media_stable_alias = fake_home / "media-stable-alias"
    durable_alias.symlink_to(durable_target, target_is_directory=True)
    media_stable_alias.symlink_to(media_target, target_is_directory=True)
    stable = subprocess.run(
        [str(binary), "--inspect-component-paths-environment", str(fake_home)],
        env={
            **os.environ,
            "YULU_APPLICATION_SUPPORT_DIR": str(durable_alias),
            "YULU_MEDIA_LIBRARY_DIR": str(media_stable_alias),
        },
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert stable.returncode == 0, stable.stderr
    stable_paths = json.loads(stable.stdout)
    for component in ("host", "capture"):
        assert stable_paths[component]["YULU_APPLICATION_SUPPORT_DIR"] == str(
            durable_target.resolve(strict=True)
        )
        assert stable_paths[component]["YULU_MODELS_DIR"] == str(
            durable_target.resolve(strict=True) / "Models"
        )
        assert stable_paths[component]["YULU_MEDIA_LIBRARY_DIR"] == str(
            media_target.resolve(strict=True)
        )

    durable_alias.unlink()
    media_stable_alias.unlink()
    durable_alias.symlink_to(legacy, target_is_directory=True)
    media_stable_alias.symlink_to(legacy, target_is_directory=True)
    for component in ("host", "capture"):
        assert stable_paths[component]["YULU_APPLICATION_SUPPORT_DIR"] == str(
            durable_target.resolve(strict=True)
        )
        assert stable_paths[component]["YULU_MEDIA_LIBRARY_DIR"] == str(
            media_target.resolve(strict=True)
        )

    case_alias = subprocess.run(
        [str(binary), "--inspect-component-paths-environment", str(fake_home)],
        env={
            **os.environ,
            "YULU_APPLICATION_SUPPORT_DIR": str(fake_home / "CaseRoot/Yulu"),
            "YULU_MODELS_DIR": str(fake_home / "caseroot/yulu"),
            "YULU_MEDIA_LIBRARY_DIR": str(fake_home / "caseroot/yulu/Recordings"),
        },
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert case_alias.returncode == 0, case_alias.stderr
    for component in ("host", "capture"):
        case_child_paths = json.loads(case_alias.stdout)[component]
        assert case_child_paths["YULU_MODELS_DIR"] == str(
            fake_home / "CaseRoot/Yulu/Models"
        )
        assert case_child_paths["YULU_MEDIA_LIBRARY_DIR"] == str(
            fake_home / "Movies/Yulu"
        )

    composed_durable = fake_home / "Operational/M\u00e9dia"
    decomposed_nested_media = fake_home / "operational/ME\u0301DIA/Recordings"
    unicode_alias = subprocess.run(
        [str(binary), "--inspect-component-paths-environment", str(fake_home)],
        env={
            **os.environ,
            "YULU_APPLICATION_SUPPORT_DIR": str(composed_durable),
            "YULU_MODELS_DIR": str(fake_home / "operational/ME\u0301DIA"),
            "YULU_MEDIA_LIBRARY_DIR": str(decomposed_nested_media),
        },
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert unicode_alias.returncode == 0, unicode_alias.stderr
    unicode_child_paths = json.loads(unicode_alias.stdout)
    for component in ("host", "capture"):
        assert unicodedata.normalize(
            "NFC",
            unicode_child_paths[component]["YULU_APPLICATION_SUPPORT_DIR"],
        ) == str(composed_durable)
        assert unicodedata.normalize(
            "NFC",
            unicode_child_paths[component]["YULU_MODELS_DIR"],
        ) == str(composed_durable / "Models")
        assert unicode_child_paths[component]["YULU_MEDIA_LIBRARY_DIR"] == str(
            fake_home / "Movies/Yulu"
        )


def test_development_smoke_probes_the_native_better_sqlite_binding():
    verifier = (
        ROOT / "packaging" / "scripts" / "verify_application_runtime.sh"
    ).read_text(encoding="utf-8")

    assert "const Database=require('better-sqlite3')" in verifier
    assert "const db=new Database(':memory:'); db.close()" in verifier


def development_shell_smoke_runtime_available() -> bool:
    if shutil.which("swiftc") is None:
        return False
    return all(
        (value := os.environ.get(name)) is not None and Path(value).is_file()
        for name in (
            "YULU_NODE_ARCHIVE",
            "YULU_PYTHON_ARCHIVE",
            "YULU_FFMPEG_SOURCE_ARCHIVE",
        )
    )


@pytest.mark.skipif(
    not development_shell_smoke_runtime_available(),
    reason="development Yulu.app smoke requires Swift and the three pinned runtime archives",
)
def test_development_shell_reaches_a_healthy_bundled_host():
    result = subprocess.run(
        ["bash", str(SCRIPTS / "smoke_yulu_app.sh")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    report = json.loads(result.stdout.splitlines()[-1])
    assert report["status"] == "ok"
    assert report["hostEntry"].endswith("Yulu.app/Contents/Resources/Host/server.js")
    assert report["captureStarted"] is False


def test_ci_runs_development_shell_smoke_after_node_dependencies_and_build():
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    node_job = workflow.split("  yulu_ui:\n", 1)[1]

    install = node_job.index("      - name: Install dependencies\n")
    build = node_job.index("      - name: Build\n")
    smoke = node_job.index("      - name: Development Yulu.app bundled Host smoke\n")

    assert install < build < smoke
    assert "        run: bash ../smoke_yulu_app.sh\n" in node_job[smoke:]


def test_release_gates_cover_the_shell_and_nested_capture():
    package = (ROOT / "packaging" / "scripts" / "package.sh").read_text(encoding="utf-8")
    signing = (ROOT / "packaging" / "scripts" / "sign_and_notarize.sh").read_text(encoding="utf-8")
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    release = (ROOT / ".github" / "workflows" / "release-publish.yml").read_text(encoding="utf-8")

    for output in (
        "yulu/scripts/Yulu.app/Contents/MacOS/yulu_app",
        "yulu/scripts/Yulu.app/Contents/Helpers/YuluCapture.app/Contents/Info.plist",
        "yulu/scripts/Yulu.app/Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
        "yulu/scripts/Yulu.app/Contents/Helpers/YuluCapture.app/Contents/_CodeSignature/CodeResources",
    ):
        assert output in package

    manifest_resign = signing.split("# The build script signed Yulu.app", 1)[1]
    assert '--entitlements "$SCRIPTS_DIR/YuluShell.app.entitlements"' in manifest_resign
    assert '--entitlements "$SCRIPTS_DIR/Yulu.app.entitlements"' not in manifest_resign

    assert ".ci-build/yulu_app" in ci
    for binary in (
        "yulu/scripts/Yulu.app/Contents/MacOS/yulu_app",
        "yulu/scripts/Yulu.app/Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
    ):
        assert binary in release
