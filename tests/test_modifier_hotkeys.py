"""Exercise native shortcut matching without posting keyboard events or recording."""
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FN = 0x800000
SHIFT = 0x20000
COMMAND = 0x100000


@pytest.fixture(scope="module")
def shortcut_binary(tmp_path_factory):
    build = tmp_path_factory.mktemp("modifier-shortcuts")
    main = build / "main.swift"
    main.write_text('''
import Cocoa
let data = FileHandle.standardInput.readDataToEndOfFile()
let input = try JSONSerialization.jsonObject(with: data) as! [String: Any]
let rawSpecs = input["specs"] as? [[String: Any]]
let specs = rawSpecs?.map { raw in
    HotkeySpec(action: raw["action"] as! String, keyCode: UInt32(raw["code"] as! Int), modifierMask: 0,
        label: "", targetLanguage: "", inputMode: raw["mode"] as? String ?? "toggle",
        key: raw["key"] as! String, modifiers: raw["modifiers"] as? [String] ?? [])
} ?? defaultHotkeySpecs()
var state = ModifierShortcutState(specs: specs)
var signals: [[String: Any]] = []
var consumed: [Bool] = []
for event in input["events"] as! [[String: Any]] {
    let kind = event["kind"] as? String ?? "flags"
    let time = event["at"] as? Double ?? 0
    let result: (signals: [(Int, Bool)], consume: Bool)
    if kind == "tick" { result = (state.tick(now: time), false) }
    else if kind == "reset" { result = (state.reset(), false) }
    else {
        result = state.event(type: kind == "down" ? .keyDown : kind == "up" ? .keyUp : kind == "click" ? .leftMouseDown : .flagsChanged,
            keyCode: UInt32(event["code"] as? Int ?? 63), flags: UInt64(event["flags"] as? Int ?? 0),
            repeated: event["repeat"] as? Bool ?? false, now: time)
    }
    signals += result.signals.map { ["action": specs[$0.0].action, "down": $0.1] }
    consumed.append(result.consume)
}
let out = try JSONSerialization.data(withJSONObject: ["signals": signals, "consumed": consumed])
print(String(data: out, encoding: .utf8)!)
''')
    binary = build / "shortcuts"
    result = subprocess.run([
        "swiftc", "-D", "YULU_NATIVE_RECORDING_LIBRARY", "-module-cache-path", "/private/tmp/yulu-swift-module-cache",
        str(ROOT / "yulu/scripts/status_agent.swift"), str(ROOT / "yulu/scripts/native_notifications.swift"),
        str(main), "-framework", "Cocoa", "-framework", "Carbon", "-framework", "WebKit", "-framework", "UserNotifications", "-o", str(binary),
    ], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return binary


def run(binary, events, specs=None):
    payload = {"events": events}
    if specs is not None:
        payload["specs"] = specs
    result = subprocess.run([str(binary)], input=json.dumps(payload), capture_output=True, text=True, timeout=5, check=True)
    return json.loads(result.stdout)


def pair(action):
    return [{"action": action, "down": True}, {"action": action, "down": False}]


def test_fn_tap_resolves_only_on_release(shortcut_binary):
    assert run(shortcut_binary, [{"flags": FN}])["signals"] == []
    assert run(shortcut_binary, [{"flags": FN}, {"flags": 0}])["signals"] == pair("dictate")


@pytest.mark.parametrize("code,side", [(56, 2), (60, 4)])
@pytest.mark.parametrize("reverse", [False, True])
def test_fn_shift_never_also_triggers_fn(shortcut_binary, code, side, reverse):
    events = [{"flags": FN}, {"code": code, "flags": FN | SHIFT | side}]
    if reverse:
        events = [{"code": code, "flags": SHIFT | side}, {"flags": FN | SHIFT | side}]
    events += [{"code": code, "flags": FN}, {"flags": 0}]
    assert run(shortcut_binary, events)["signals"] == pair("translate")


def test_fn_space_consumes_repeat_and_release_without_fn_action(shortcut_binary):
    result = run(shortcut_binary, [
        {"flags": FN}, {"kind": "down", "code": 49, "flags": FN},
        {"kind": "down", "code": 49, "flags": FN, "repeat": True},
        {"flags": 0}, {"kind": "up", "code": 49},
    ])
    assert result["signals"] == pair("voice_chat")
    assert all(result["consumed"])


def test_fn_with_unrelated_key_does_not_start_capture(shortcut_binary):
    result = run(shortcut_binary, [{"flags": FN}, {"kind": "down", "code": 123, "flags": FN},
                                    {"kind": "up", "code": 123, "flags": FN}, {"flags": 0}])
    assert result["signals"] == []
    assert result["consumed"][1:3] == [False, False]


@pytest.mark.parametrize("key,code,group,left,right", [
    ("Command", 55, 0x100000, 0x8, 0x10), ("Shift", 56, 0x20000, 0x2, 0x4),
    ("Option", 58, 0x80000, 0x20, 0x40), ("Control", 59, 0x40000, 0x1, 0x2000),
])
def test_modifier_sides_and_unrelated_combinations(shortcut_binary, key, code, group, left, right):
    specs = [{"action": "left", "key": "Left" + key, "code": code}, {"action": "right", "key": "Right" + key, "code": code}]
    assert run(shortcut_binary, [{"code": code, "flags": group | left}, {"code": code}], specs)["signals"] == pair("left")
    assert run(shortcut_binary, [{"code": code, "flags": group | right}, {"code": code}], specs)["signals"] == pair("right")
    assert run(shortcut_binary, [{"code": code, "flags": group | left | right}, {"code": code}], specs)["signals"] == []
    result = run(shortcut_binary, [{"code": code, "flags": group | left},
        {"kind": "down", "code": 8, "flags": group | left}, {"kind": "up", "code": 8, "flags": group | left}, {"code": code}], specs)
    assert result["signals"] == []
    assert not any(result["consumed"])


def test_sided_modifier_combination_does_not_match_other_side(shortcut_binary):
    specs = [{"action": "right", "key": "Space", "code": 49, "modifiers": ["right_cmd"]}]
    for side, expected in [(8, []), (16, pair("right"))]:
        events = [{"kind": "down", "code": 49, "flags": COMMAND | side}, {"kind": "up", "code": 49, "flags": COMMAND | side}]
        assert run(shortcut_binary, events, specs)["signals"] == expected


def test_command_click_does_not_trigger_command_only_shortcut(shortcut_binary):
    specs = [{"action": "voice", "key": "Command", "code": 55}]
    result = run(shortcut_binary, [{"code": 55, "flags": COMMAND | 8},
        {"kind": "click", "flags": COMMAND | 8}, {"code": 55}], specs)
    assert result["signals"] == []
    assert not any(result["consumed"])


def test_normal_click_does_not_disable_the_next_fn_tap(shortcut_binary):
    assert run(shortcut_binary, [{"kind": "click"}, {"flags": FN}, {"flags": 0}])["signals"] == pair("dictate")


def test_hold_delays_modifier_prefix_and_finishes_on_reset(shortcut_binary):
    specs = [{"action": "voice", "key": "Fn", "code": 63, "mode": "hold"},
             {"action": "translate", "key": "Fn", "code": 63, "modifiers": ["shift"], "mode": "hold"}]
    events = [{"flags": FN, "at": 0}, {"kind": "tick", "at": .1},
              {"code": 56, "flags": FN | SHIFT | 2, "at": .15}, {"kind": "tick", "at": .4}, {"kind": "reset"}]
    assert run(shortcut_binary, events, specs)["signals"] == pair("translate")
