"""Static asserts for the audio_daemon tap entitlement / usage-description wiring
(PLAT-02 / Pitfall 4 / Assumption A2).

The macOS 14.4+ Core Audio process-tap arm requires:
  * NSAudioCaptureUsageDescription in Info.plist (the "System Audio Recording Only"
    prompt copy) — written at build time by build_audio_daemon.sh's plist ladder,
    which is the single source of truth;
  * the microphone entitlement com.apple.security.device.audio-input RETAINED
    (the tap's aggregate device carries a mic input stream, so mic permission is
    still required — Pitfall 4 / A2);
  * the AudioToolbox framework linked at build time (the tap symbols live there);
  * the entitlements file kept COMMENT-FREE (Phase 1 trap: a `--` inside an XML
    comment breaks strict expat/plistlib parsers).

These are source-static asserts (no swiftc, no signing). Mirrors the static-assert
style of test_status_agent_plist_template.py / test_audiodaemon_plist_direct_launch.py.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
INFO_PLIST = (
    SCRIPTS
    / "Yulu.app"
    / "Contents"
    / "Helpers"
    / "YuluCapture.app"
    / "Contents"
    / "Info.plist"
)
ENTITLEMENTS = SCRIPTS / "Yulu.app.entitlements"
BUILD_SH = SCRIPTS / "build_audio_daemon.sh"


def _info() -> str:
    return INFO_PLIST.read_text(encoding="utf-8")


def _entitlements() -> str:
    return ENTITLEMENTS.read_text(encoding="utf-8")


def _build() -> str:
    return BUILD_SH.read_text(encoding="utf-8")


def test_files_exist():
    assert INFO_PLIST.exists(), f"missing {INFO_PLIST}"
    assert ENTITLEMENTS.exists(), f"missing {ENTITLEMENTS}"
    assert BUILD_SH.exists(), f"missing {BUILD_SH}"


def test_info_plist_has_audio_capture_usage_description():
    """The tap's first-run prompt copy must be present in the bundled Info.plist."""
    text = _info()
    assert "<key>NSAudioCaptureUsageDescription</key>" in text, (
        "Info.plist is missing NSAudioCaptureUsageDescription (Pitfall 4)"
    )
    # The other usage descriptions must NOT be removed by this addition.
    assert "<key>NSMicrophoneUsageDescription</key>" in text, (
        "NSMicrophoneUsageDescription was removed (regression)"
    )
    assert "<key>NSScreenCaptureUsageDescription</key>" in text, (
        "NSScreenCaptureUsageDescription was removed (regression)"
    )


def test_build_ladder_writes_audio_capture_usage_description():
    """build_audio_daemon.sh is the source of truth — it must write the key too."""
    text = _build()
    assert 'plist_set_or_add "$CAPTURE_INFO" NSAudioCaptureUsageDescription' in text, (
        "build_audio_daemon.sh must add an NSAudioCaptureUsageDescription "
        "plist_set_or_add line (the build-time ladder is the source of truth)"
    )


def test_build_links_audiotoolbox_framework():
    """The tap symbols (AudioHardwareCreateProcessTap etc.) live in AudioToolbox."""
    text = _build()
    assert "-framework AudioToolbox" in text, (
        "build_audio_daemon.sh swiftc link list must include -framework AudioToolbox"
    )
    # CoreAudio was already linked before this plan — keep it.
    assert "-framework CoreAudio" in text, (
        "build_audio_daemon.sh must still link -framework CoreAudio"
    )


def test_entitlements_keep_mic_capability():
    """The aggregate device has a mic input stream → mic permission still required."""
    text = _entitlements()
    assert "com.apple.security.device.audio-input" in text, (
        "Yulu.app.entitlements must retain com.apple.security.device.audio-input "
        "(Pitfall 4 / A2 — the tap aggregate has a mic input stream)"
    )


def test_entitlements_have_no_xml_comment():
    """Phase 1 trap: a `--` inside an XML comment breaks strict plist parsers."""
    text = _entitlements()
    assert "<!--" not in text, (
        "Yulu.app.entitlements must stay comment-free (Phase 1 entitlement trap: "
        "the `--` in flag names breaks strict expat/plistlib parsers)"
    )


def test_entitlements_have_no_app_sandbox():
    """A2: do NOT App-Sandbox the daemon; the global-tap path is for non-sandboxed
    apps. Guard against a stray sandbox key creeping in."""
    text = _entitlements()
    assert "com.apple.security.app-sandbox" not in text, (
        "the audio daemon must NOT be App-Sandboxed (the global process-tap path "
        "requires a non-sandboxed app — Assumption A2 / Pitfall 4)"
    )
