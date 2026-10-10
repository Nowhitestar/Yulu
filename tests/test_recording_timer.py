"""Exercise the capture clock without opening audio hardware or user data."""

import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

import pytest


SCRIPTS = Path(__file__).resolve().parents[1] / "yulu/scripts"
pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="Native macOS recorder")


def test_capture_clock_survives_status_reads_and_resets_for_next_recording(tmp_path):
    # Use the real recorder, file writer, and IPC status handler. Replace only
    # the application entry point so no microphone/system capture is started.
    source = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    source = source[:source.index("// ─── 入口")]
    source += r'''
for directory in [DURABLE_DATA_DIR, IPC_DIR, LOGS_DIR, RECORDING_DIR] {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
}
let recorder = AudioRecorder()
let server = SocketServer(recorder)
precondition(server.start())
defer { server.stop() }
SYS_READY = true
MIC_READY = true

func request(_ body: [String: Any]) -> [String: Any] {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    precondition(fd >= 0)
    defer { close(fd) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    _ = SOCKET_PATH.path.withCString { strncpy(&address.sun_path.0, $0, 103) }
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    precondition(connected == 0)
    let data = try! JSONSerialization.data(withJSONObject: body)
    data.withUnsafeBytes { precondition(write(fd, $0.baseAddress, data.count) == data.count) }
    shutdown(fd, SHUT_WR)
    var bytes = [UInt8](repeating: 0, count: 65536)
    let count = read(fd, &bytes, bytes.count)
    precondition(count > 0)
    return try! JSONSerialization.jsonObject(with: Data(bytes.prefix(count))) as! [String: Any]
}

precondition(request(["action": "status"])["recordingStartedAt"] == nil)
let before = Date().timeIntervalSince1970 * 1_000
_ = request(["action": "start", "title": "clock-first"])
let first = request(["action": "status"])
precondition(first["recording"] as? Bool == true)
let startedAt = first["recordingStartedAt"] as! Double
precondition(startedAt >= before && startedAt <= Date().timeIntervalSince1970 * 1_000)
Thread.sleep(forTimeInterval: 0.05)
// A new status connection (like reopening the UI) and a duplicate start must
// return the original capture timestamp, not the time of the latest request.
_ = request(["action": "start", "title": "duplicate"])
precondition(request(["action": "status"])["recordingStartedAt"] as? Double == startedAt)
_ = request(["action": "stop"])
let idle = request(["action": "status"])
precondition(idle["recording"] as? Bool == false && idle["recordingStartedAt"] == nil)
_ = request(["action": "start", "title": "clock-next"])
let next = request(["action": "status"])
precondition(next["recordingStartedAt"] as! Double > startedAt)
_ = request(["action": "stop"])
print("capture-clock-ok")
'''
    swift = tmp_path / "clock.swift"
    swift.write_text(source, encoding="utf-8")
    binary = tmp_path / "clock"
    result = subprocess.run([
        "swiftc", str(swift), "-module-cache-path", str(tmp_path / "swift-cache"),
        "-framework", "Cocoa", "-framework", "ScreenCaptureKit", "-framework", "AVFoundation",
        "-framework", "CoreMedia", "-framework", "CoreAudio", "-framework", "AudioToolbox",
        "-o", str(binary),
    ], capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stderr
    # Unix sockets on macOS have a 104-byte path limit.
    with TemporaryDirectory(prefix="yulu-clock-", dir="/private/tmp") as runtime:
        environment = os.environ.copy()
        for key, name in [
            ("YULU_APPLICATION_SUPPORT_DIR", "data"), ("YULU_IPC_DIR", "ipc"),
            ("YULU_LOG_DIR", "logs"), ("YULU_MEDIA_LIBRARY_DIR", "media"),
            ("YULU_LEGACY_READ_ONLY_DATA_DIR", "legacy"),
        ]:
            environment[key] = str(Path(runtime) / name)
        result = subprocess.run([str(binary)], env=environment, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert "capture-clock-ok" in result.stdout
