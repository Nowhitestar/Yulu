"""Exercise the installed shell's native module through its lifecycle and IPC."""

import json
import os
from pathlib import Path
import select
import socket
import subprocess
import tempfile
import time

import pytest


SCRIPTS = Path(__file__).resolve().parents[1] / "yulu/scripts"


@pytest.fixture(scope="module")
def native_controls_binary(tmp_path_factory):
    build = tmp_path_factory.mktemp("native-controls-build")
    result = subprocess.run(
        [
            "swiftc", "-parse-as-library", "-D", "YULU_NATIVE_RECORDING_LIBRARY",
            "-emit-library", "-static", "-emit-module", "-module-name", "YuluNativeRecording",
            "-emit-module-path", str(build / "YuluNativeRecording.swiftmodule"),
            "-o", str(build / "libYuluNativeRecording.a"), str(SCRIPTS / "status_agent.swift"),
            "-module-cache-path", "/private/tmp/yulu-swift-module-cache",
            "-framework", "Cocoa", "-framework", "Carbon", "-framework", "WebKit",
        ], capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    source = build / "main.swift"
    source.write_text('''
import Cocoa
import YuluNativeRecording
let app = NSApplication.shared
let environment = try JSONDecoder().decode(
    [String: String].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
)
let controls = NativeRecordingControls(environment: environment, openRoute: { _ in })
if CommandLine.arguments.contains("--prepare-only") {
    try controls.prepare()
} else {
    try controls.activate()
}
let mainGate = DispatchSemaphore(value: 0)
DispatchQueue.global().async {
    while let command = readLine() {
        if command == "release-main" {
            mainGate.signal()
            continue
        }
        if command == "quiesce-background" {
            print(controls.quiesce(captureRecording: false) == false ? "ready" : "busy")
            fflush(stdout)
            continue
        }
        DispatchQueue.main.async {
            if command == "hold-main" {
                print("held")
                fflush(stdout)
                _ = mainGate.wait(timeout: .now() + 5)
            } else if command == "quiesce" {
                print(controls.quiesce(captureRecording: false) == false ? "ready" : "busy")
                fflush(stdout)
            } else if command == "readiness" {
                print(controls.isReady ? "ready" : "unavailable")
                fflush(stdout)
            } else if command == "resume" {
                try! controls.activate()
                print("resumed")
                fflush(stdout)
            } else if command == "stop" {
                controls.stop()
                exit(0)
            }
        }
    }
}
app.setActivationPolicy(.accessory)
app.run()
''', encoding="utf-8")
    binary = build / "controls"
    result = subprocess.run(
        [
            "swiftc", "-I", str(build), "-L", str(build), "-lYuluNativeRecording",
            "-module-cache-path", "/private/tmp/yulu-swift-module-cache",
            "-o", str(binary), str(source),
            "-framework", "Cocoa", "-framework", "Carbon", "-framework", "WebKit",
        ], capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    return binary


def ipc(path: Path, action: str, **arguments) -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(5)
        client.connect(str(path))
        client.sendall(json.dumps({"action": action, **arguments}).encode() + b"\n")
        client.shutdown(socket.SHUT_WR)
        return json.loads(client.makefile("rb").readline())


def lifecycle(process, command):
    process.stdin.write(command + "\n")
    process.stdin.flush()
    assert select.select([process.stdout], [], [], 5)[0], "native lifecycle did not respond"
    return process.stdout.readline().strip()


def await_quiescence(process):
    deadline = time.monotonic() + 3
    while lifecycle(process, "quiesce") != "ready":
        assert time.monotonic() < deadline, "native work did not drain"
        time.sleep(0.02)


@pytest.fixture
def running_controls(native_controls_binary, request):
    # Short paths match macOS's Unix-socket limit; no real user roots or Capture.
    with tempfile.TemporaryDirectory(prefix="yulu-nc-", dir="/private/tmp") as root:
        data_root = Path(root)
        python = "/usr/bin/false"
        if getattr(request, "param", "normal") == "slow-hotkeys":
            slow_python = data_root / "slow-python"
            slow_python.write_text(
                f"#!/bin/sh\n/usr/bin/touch '{data_root}/python-started'\nexec /bin/sleep 5\n",
                encoding="utf-8",
            )
            slow_python.chmod(0o755)
            python = str(slow_python)
        elif getattr(request, "param", "normal") == "bundled-python":
            bundled_python = data_root / "bundled-python"
            bundled_python.write_text(
                '#!/bin/sh\n'
                'if [ "$1" = status_agent_config.py ]; then printf "[]\\n"; exit 0; fi\n'
                'if [ "$1" = meeting_daemon.py ]; then '
                'printf \'%s\\n\' "$1" "$2" > "$YULU_IPC_DIR/stop-observed"; exit 0; fi\n'
                'printf \'{"ok":true,"runtime":"bundled","bytecode":"%s","pythonpath":"%s","cwd":"%s"}\\n\' '
                '"$PYTHONDONTWRITEBYTECODE" "$PYTHONPATH" "$PWD"\n',
                encoding="utf-8",
            )
            bundled_python.chmod(0o755)
            python = str(bundled_python)
        config = data_root / "environment.json"
        config.write_text(json.dumps({
            "HOME": str(data_root),
            "YULU_APPLICATION_SUPPORT_DIR": str(data_root / "data"),
            "YULU_IPC_DIR": str(data_root / "ipc"),
            "YULU_LOG_DIR": str(data_root / "logs"),
            "YULU_MEDIA_LIBRARY_DIR": str(data_root / "media"),
            "YULU_LEGACY_READ_ONLY_DATA_DIR": str(data_root / "legacy"),
            "YULU_SCRIPT_DIR": str(SCRIPTS),
            "YULU_PYTHON": python,
            "PATH": "/usr/bin:/bin",
        }), encoding="utf-8")
        started = time.monotonic()
        arguments = [str(native_controls_binary), str(config)]
        if getattr(request, "param", "normal") == "prepare-only":
            arguments.append("--prepare-only")
        process = subprocess.Popen(
            arguments,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env={**os.environ, "PYTHONPATH": "/untrusted-pythonpath", "YULU_SCRIPT_DIR": "/untrusted-scripts"},
        )
        socket_path = data_root / "ipc/status_agent.sock"
        try:
            deadline = time.monotonic() + 8
            while not socket_path.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            assert socket_path.exists(), process.communicate(timeout=1)
            yield process, socket_path, config, started
        finally:
            if process.poll() is None:
                process.communicate("stop\n", timeout=10)
            assert process.returncode == 0
        assert not socket_path.exists()
        assert not (data_root / "ipc/status_agent.pid").exists()


@pytest.mark.parametrize("running_controls", ["normal", "slow-hotkeys"], indirect=True)
def test_native_controls_deliver_an_owned_socket(running_controls):
    process, socket_path, _, started = running_controls
    assert lifecycle(process, "resume") == "resumed"
    status = ipc(socket_path, "status")
    assert time.monotonic() - started < 2, "config loading blocked native control startup"
    assert status["ok"] is True
    assert status["state"] == "daemonDown"  # Never invent an idle Capture.
    assert int(socket_path.with_suffix(".pid").read_text()) == process.pid


def test_second_native_owner_cannot_replace_a_live_control_socket(native_controls_binary, running_controls):
    owner, socket_path, config, _ = running_controls
    identity = socket_path.stat().st_ino
    duplicate = subprocess.Popen(
        [str(native_controls_binary), str(config)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        duplicate.communicate(timeout=5)
        assert duplicate.returncode != 0
        assert socket_path.stat().st_ino == identity
        assert int(socket_path.with_suffix(".pid").read_text()) == owner.pid
        assert ipc(socket_path, "status")["ok"] is True
    finally:
        if duplicate.poll() is None:
            duplicate.terminate()
            duplicate.communicate(timeout=5)


@pytest.mark.parametrize("action", [
    "toggle", "stop", "dictate_toggle", "dictate_translate", "voice_chat",
    "open_inbox", "open_agent_console", "open_voice_chat", "paste_clipboard",
    "preview_sound", "search",
])
def test_quiesced_controls_reject_work_until_resumed(running_controls, action):
    process, socket_path, _, _ = running_controls
    await_quiescence(process)
    assert ipc(socket_path, action) == {"ok": False, "error": "controls_quiescing"}
    assert ipc(socket_path, "status")["ok"] is True
    assert lifecycle(process, "resume") == "resumed"
    assert ipc(socket_path, "search")["error"] != "controls_quiescing"


def test_admitted_main_queue_command_blocks_quiescence(running_controls):
    process, socket_path, _, _ = running_controls
    assert lifecycle(process, "hold-main") == "held"
    try:
        # This reply proves admission while the main queue is deliberately held.
        assert ipc(socket_path, "open_inbox") == {"ok": True}
        assert lifecycle(process, "quiesce-background") == "busy"
    finally:
        process.stdin.write("release-main\n")
        process.stdin.flush()
    await_quiescence(process)
    assert ipc(socket_path, "open_inbox") == {"ok": False, "error": "controls_quiescing"}


@pytest.mark.parametrize(("action", "error"), [
    ("dictate_toggle", "controls_timeout"), ("paste_clipboard", "paste_timeout"),
])
def test_timed_out_native_command_is_not_later_reported_as_success(running_controls, action, error):
    process, socket_path, _, _ = running_controls
    assert lifecycle(process, "hold-main") == "held"
    try:
        assert ipc(socket_path, action) == {"ok": False, "error": error}
        assert lifecycle(process, "quiesce-background") == "busy"
    finally:
        process.stdin.write("release-main\n")
        process.stdin.flush()
    await_quiescence(process)
    assert ipc(socket_path, "status")["dictation_active"] is False


@pytest.mark.parametrize("running_controls", ["prepare-only"], indirect=True)
def test_update_health_can_prepare_the_endpoint_without_admitting_commands(running_controls):
    process, socket_path, _, _ = running_controls
    assert lifecycle(process, "readiness") == "ready"
    assert ipc(socket_path, "status")["ok"] is True
    assert ipc(socket_path, "stop") == {"ok": False, "error": "controls_quiescing"}
    assert lifecycle(process, "resume") == "resumed"
    assert ipc(socket_path, "search")["error"] != "controls_quiescing"


@pytest.mark.parametrize("running_controls", ["prepare-only"], indirect=True)
def test_native_health_does_not_accept_a_replaced_endpoint(running_controls):
    process, socket_path, _, _ = running_controls
    socket_path.unlink()
    socket_path.write_text("not the owned endpoint", encoding="utf-8")
    try:
        assert lifecycle(process, "readiness") == "unavailable"
    finally:
        socket_path.unlink()


@pytest.mark.parametrize("running_controls", ["slow-hotkeys"], indirect=True)
def test_owned_native_work_defers_update_until_it_exits(running_controls):
    process, socket_path, config, _ = running_controls
    marker = config.parent / "python-started"
    deadline = time.monotonic() + 2
    while not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert marker.exists()
    assert lifecycle(process, "quiesce") == "busy"
    deadline = time.monotonic() + 4
    while lifecycle(process, "quiesce") == "busy":
        assert time.monotonic() < deadline
        time.sleep(0.05)
    assert ipc(socket_path, "search")["error"] == "controls_quiescing"


@pytest.mark.parametrize("running_controls", ["bundled-python"], indirect=True)
def test_commands_use_only_the_supplied_application_runtime(running_controls):
    _, socket_path, _, _ = running_controls
    assert ipc(socket_path, "search") == {
        "ok": True, "runtime": "bundled", "bytecode": "1",
        "pythonpath": str(SCRIPTS), "cwd": str(SCRIPTS),
    }


@pytest.mark.parametrize("running_controls", ["bundled-python"], indirect=True)
def test_stop_runs_the_bundled_processing_command_and_respects_quiescence(running_controls):
    process, socket_path, _, _ = running_controls
    result = ipc(socket_path, "stop")
    assert result["ok"] is True
    marker = socket_path.parent / "stop-observed"
    deadline = time.monotonic() + 2
    while not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert marker.read_text() == "meeting_daemon.py\nstop\n"
    while lifecycle(process, "quiesce") != "ready":
        assert time.monotonic() < deadline
        time.sleep(0.02)
    assert ipc(socket_path, "stop") == {"ok": False, "error": "controls_quiescing"}


def test_failed_stop_reports_terminal_failure_after_successful_spawn(running_controls):
    _, socket_path, _, _ = running_controls
    accepted = ipc(socket_path, "stop")
    assert accepted["ok"] is True
    deadline = time.monotonic() + 2
    while True:
        result = ipc(socket_path, "stop_status", launcher_pid=accepted["launcher_pid"])
        assert result["ok"] is True
        if result["state"] != "running":
            break
        assert time.monotonic() < deadline
        time.sleep(0.02)
    assert result["state"] == "failed"
    assert result["exit_status"] != 0
