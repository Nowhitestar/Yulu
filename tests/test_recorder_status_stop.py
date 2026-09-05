"""The packaged presenter stops through the shell, never a host Python."""

import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor

import pytest


SCRIPTS = Path(__file__).resolve().parents[1] / "yulu/scripts"


@pytest.fixture(scope="module")
def presenter(tmp_path_factory):
    binary = tmp_path_factory.mktemp("presenter") / "Yulu.app/Contents/MacOS/recorder_status"
    binary.parent.mkdir(parents=True)
    subprocess.run([
        "swiftc", "-module-cache-path", "/private/tmp/yulu-swift-module-cache",
        "-o", str(binary), str(SCRIPTS / "recorder_status.swift"),
    ], capture_output=True, text=True, check=True)
    return binary


def test_presenter_restores_retry_after_a_failed_or_unknown_stop(presenter):
    result = subprocess.run([str(presenter), "--self-test"], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert "recorder_status self-test ok" in result.stdout


@pytest.mark.parametrize("reply", [{"ok": True}, {"ok": False, "error": "controls_quiescing"}])
def test_packaged_stop_uses_owned_control_endpoint(presenter, reply):
    with tempfile.TemporaryDirectory(prefix="yulu-stop-", dir="/private/tmp") as root:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(Path(root) / "status_agent.sock"))
            server.listen(1)
            server.settimeout(3)

            def respond():
                connection, _ = server.accept()
                with connection:
                    request = json.loads(connection.makefile("rb").readline())
                    connection.sendall(json.dumps(reply).encode() + b"\n")
                    return request

            with ThreadPoolExecutor(max_workers=1) as executor:
                received = executor.submit(respond)
                result = subprocess.run(
                    # The old presenter recognizes --self-test, so a red test
                    # cannot accidentally open its overlay in the desktop.
                    [str(presenter), "--stop", "--self-test"],
                    env={**os.environ, "YULU_IPC_DIR": root,
                         "YULU_PYTHON": "/untrusted/python", "PATH": "/untrusted"},
                    capture_output=True, text=True, timeout=5,
                )
                assert json.loads(result.stdout) == reply
                assert result.returncode == (0 if reply["ok"] else 1)
                assert received.result() == {"action": "stop"}
