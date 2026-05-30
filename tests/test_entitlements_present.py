"""Static assertions on the committed code-signing entitlements (BUILD-02).

These guard the least-privilege contract for the hardened-runtime signing:
- Yulu.app (audio daemon) must declare the microphone entitlement AVFoundation
  needs under the hardened runtime, and must NOT declare any screen/system-audio
  capture entitlement (ScreenCaptureKit is purely TCC-gated, no entitlement).
- StatusAgent.app must declare only the Apple Events automation entitlement it
  needs to open Terminal.

Parsing is done with stdlib ``plistlib`` so the assertions check the real plist
keys, not incidental substrings in comments.
"""

import plistlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
YULU_ENTITLEMENTS = SCRIPTS / "Yulu.app.entitlements"
STATUS_ENTITLEMENTS = SCRIPTS / "StatusAgent.app.entitlements"

AUDIO_INPUT = "com.apple.security.device.audio-input"
APPLE_EVENTS = "com.apple.security.automation.apple-events"


def _load(path: Path) -> dict:
    with path.open("rb") as fh:
        data = plistlib.load(fh)
    assert isinstance(data, dict), f"{path} must be a plist dict"
    return data


def test_entitlements_files_exist():
    assert YULU_ENTITLEMENTS.is_file(), f"missing {YULU_ENTITLEMENTS}"
    assert STATUS_ENTITLEMENTS.is_file(), f"missing {STATUS_ENTITLEMENTS}"


def test_yulu_entitlements_grant_microphone():
    keys = _load(YULU_ENTITLEMENTS)
    assert keys.get(AUDIO_INPUT) is True, f"{AUDIO_INPUT} must be true"


def test_yulu_entitlements_have_no_capture_entitlement():
    """ScreenCaptureKit is TCC-gated; no screen/system-audio capture entitlement
    exists, so none may be declared (least-privilege)."""
    keys = _load(YULU_ENTITLEMENTS)
    for key in keys:
        assert "screen-capture" not in key, f"unexpected capture entitlement: {key}"
        assert "screen_capture" not in key, f"unexpected capture entitlement: {key}"


def test_yulu_entitlements_are_least_privilege():
    """Only the microphone entitlement — nothing broader."""
    keys = _load(YULU_ENTITLEMENTS)
    assert set(keys) == {AUDIO_INPUT}, f"unexpected keys: {sorted(keys)}"


def test_status_agent_entitlements_grant_apple_events():
    keys = _load(STATUS_ENTITLEMENTS)
    assert keys.get(APPLE_EVENTS) is True, f"{APPLE_EVENTS} must be true"


def test_status_agent_entitlements_are_least_privilege():
    """Only the Apple Events entitlement — and explicitly no audio-input key."""
    keys = _load(STATUS_ENTITLEMENTS)
    assert AUDIO_INPUT not in keys, "StatusAgent must not request microphone access"
    assert set(keys) == {APPLE_EVENTS}, f"unexpected keys: {sorted(keys)}"
