"""Native notification content / safe routing contracts (isolated executable)."""
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def native_notice_binary(tmp_path_factory):
    build = tmp_path_factory.mktemp("native-notice")
    main = build / "main.swift"
    main.write_text('''
import Cocoa
let input = FileHandle.standardInput.readDataToEndOfFile()
let payload = try JSONSerialization.jsonObject(with: input) as! [String: Any]
var output: [String: Any] = ["valid": false]
if let notice = YuluNotice(payload) {
    let copy = notice.copy(english: payload["english"] as? Bool == true)
    output = ["valid": true, "title": copy.title, "body": copy.body,
              "route": notice.route, "group": notice.group, "key": notice.key,
              "audible": notice.audible, "payload": notice.payload]
}
let result = try JSONSerialization.data(withJSONObject: output)
print(String(data: result, encoding: .utf8)!)
''')
    binary = build / "notice"
    result = subprocess.run([
        "swiftc", "-target", "arm64-apple-macosx13.0", "-module-cache-path", "/private/tmp/yulu-swift-module-cache",
        str(ROOT / "yulu/scripts/native_notifications.swift"), str(main),
        "-framework", "Cocoa", "-framework", "UserNotifications", "-o", str(binary),
    ], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return binary


def present(binary, **overrides):
    payload = {"kind": "recording_saved", "id": "recording1", "title": "产品评审会议", "stem": "sync_20260918", **overrides}
    run = subprocess.run([str(binary)], input=json.dumps(payload), capture_output=True, text=True, check=True)
    return json.loads(run.stdout)


def test_saved_and_ready_share_one_recording_destination(native_notice_binary):
    saved = present(native_notice_binary)
    ready = present(native_notice_binary, kind="summary_ready", id="task:1")
    assert saved["title"] == "录音已保存"
    assert ready["title"] == "纪要已完成"
    assert saved["body"] == ready["body"] == "产品评审会议"
    assert saved["group"] == ready["group"]
    assert saved["key"] != ready["key"]
    assert saved["route"] == ready["route"] == "/inbox/sync_20260918"
    assert saved["audible"] is False


def test_titles_are_bounded_single_line_unicode_not_repeated(native_notice_binary):
    result = present(native_notice_binary, title=("研发 🎙️ \n" * 60))
    assert "\n" not in result["body"]
    assert result["body"].endswith("…")
    assert len(result["body"]) < 140  # Swift truncates graphemes, not UTF-16 units.
    assert "Yulu" not in result["title"]


@pytest.mark.parametrize("stem", ["../private", "..", ".", "a/b", "a\\b", "a\x00b", "", "a" * 256])
def test_unsafe_destinations_are_rejected(native_notice_binary, stem):
    assert present(native_notice_binary, stem=stem) == {"valid": False}


def test_click_route_cannot_be_replaced_with_an_external_url(native_notice_binary):
    result = present(native_notice_binary, stem="会议 #?%", route="https://example.com/private")
    assert result["route"] == "/inbox/会议%20%23%3F%25" or result["route"] == "/inbox/%E4%BC%9A%E8%AE%AE%20%23%3F%25"
    assert "route" not in result["payload"]


def test_english_copy_and_actionable_service_destinations(native_notice_binary):
    saved = present(native_notice_binary, english=True)
    assert saved["title"] == "Recording saved"
    calendar = present(native_notice_binary, kind="calendar_empty", stem=None)
    assert calendar["route"] == "/settings/meetings"
    audio = present(native_notice_binary, kind="audio_unavailable", stem=None)
    assert audio["route"] == "/health"
    assert audio["audible"] is True


def test_unknown_notification_types_and_missing_summary_destination_fail_closed(native_notice_binary):
    assert present(native_notice_binary, kind="arbitrary") == {"valid": False}
    assert present(native_notice_binary, kind="summary_ready", stem=None) == {"valid": False}
    assert present(native_notice_binary, id="bad\nidentity") == {"valid": False}
