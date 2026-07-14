"""Static gate for the Swift CaptureBackend seam (PLAT-01 / D-02 / D-03 / D-09).

These are source-static asserts (no swiftc, no runtime): a reviewer-grade proof
that audio_daemon.swift declares the neutral CaptureBackend protocol, that the
existing ScreenCaptureKit capture conforms to it as ScreenCaptureKitBackend
(wrapped, not rewritten), and that the protocol signature stays free of
ScreenCaptureKit / Core-Audio-tap vocabulary (D-09). Mirrors the static-assert
style of the Swift checks in test_status_agent_config.py.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DAEMON = ROOT / "yulu" / "scripts" / "audio_daemon.swift"


def _source() -> str:
    return DAEMON.read_text(encoding="utf-8")


def _protocol_block() -> str:
    """Return only the `protocol CaptureBackend { ... }` declaration body.

    D-09 is scoped to the protocol (and CaptureSource) signature — NOT to the
    whole module, whose SCK arm legitimately uses SCStreamConfiguration. We slice
    from `protocol CaptureBackend` to its matching closing brace via depth count.
    """
    src = _source()
    start = src.index("protocol CaptureBackend")
    # Find the opening brace of the protocol body.
    brace = src.index("{", start)
    depth = 0
    for i in range(brace, len(src)):
        ch = src[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[start : i + 1]
    raise AssertionError("unbalanced braces: protocol CaptureBackend never closes")


def test_daemon_source_exists():
    assert DAEMON.exists(), f"missing {DAEMON}"


def test_capture_backend_protocol_declared():
    assert "protocol CaptureBackend" in _source()


def test_capture_source_struct_declared():
    assert "struct CaptureSource" in _source()


def test_protocol_carries_neutral_members():
    block = _protocol_block()
    for member in (
        "var isReady: Bool",
        "var lastError: String",
        "func probePermission()",
        "func startCapture()",
        "func stopCapture()",
        "func sources() -> [CaptureSource]",
    ):
        assert member in block, f"protocol missing neutral member: {member}"


def test_screencapturekit_backend_conforms():
    src = _source()
    assert "class ScreenCaptureKitBackend" in src
    # Conformance is declared on the type (": CaptureBackend" somewhere on the
    # class line). Match the declaration line and assert the conformance token.
    m = re.search(r"class ScreenCaptureKitBackend[^\n{]*", src)
    assert m, "ScreenCaptureKitBackend declaration not found"
    assert "CaptureBackend" in m.group(0), (
        "ScreenCaptureKitBackend must conform to CaptureBackend"
    )


def test_old_audiocapture_type_renamed_away():
    # The wrap-don't-rewrite refactor renames AudioCapture -> ScreenCaptureKitBackend;
    # no stale `AudioCapture` type reference should remain.
    assert not re.search(r"\bAudioCapture\b", _source()), (
        "stale AudioCapture reference remains after rename"
    )


def test_appdelegate_consumes_protocol_not_concrete():
    # The consumer is retyped against the seam (D-02): the stored property is the
    # protocol type, so 02-04 can drop in the tap arm without touching AppDelegate.
    assert "var audioCapture: CaptureBackend?" in _source()


def test_sysaudio_conversion_kept_verbatim():
    # D-03: the planar-Float32 -> interleaved-Int16 conversion is battle-tested and
    # must survive byte-for-byte. Assert both the interleave loop and the clamp.
    src = _source()
    assert "interleaved.append(floats[frames + i])" in src, (
        "planar interleave loop changed/removed"
    )
    assert "Int16(max(-1.0, min(1.0, $0)) * Float(Int16.max))" in src, (
        "Int16 clamp conversion changed/removed"
    )


def test_mic_capture_downmixes_channels_and_applies_gain():
    src = _source()
    assert "let DEFAULT_MIC_GAIN: Float" in src
    assert "private var micGainState: Float = DEFAULT_MIC_GAIN" in src
    assert "for channel in 0..<channels" in src
    assert "let gain = self.micGainState" in src
    assert "$0 * gain" in src


def test_audio_callbacks_do_not_sync_read_recorder_state():
    src = _source()
    assert "guard let self = self, self.recorder.isRecording else" not in src
    assert "guard type == .audio, recorder.isRecording else" not in src
    assert "guard recorder.isRecording else" not in src


def test_protocol_block_has_no_sck_or_tap_vocabulary():
    # D-09 (success criterion 4): the protocol signature must not leak the
    # ScreenCaptureKit or Core-Audio-tap vocabulary. Scoped to the protocol block.
    block = _protocol_block()
    for forbidden in (
        "SCStreamConfiguration",
        "SCContentFilter",
        "SCStream",
        "CATapDescription",
        "tccutil",
    ):
        assert forbidden not in block, (
            f"D-09 violation: '{forbidden}' appears in the CaptureBackend protocol block"
        )


def test_capture_source_struct_is_neutral():
    # CaptureSource must speak only neutral id/name/kind strings — no SCK/tap types.
    src = _source()
    start = src.index("struct CaptureSource")
    brace = src.index("{", start)
    depth = 0
    block = ""
    for i in range(brace, len(src)):
        ch = src[i]
        block += ch
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                break
    for field in ("let id: String", "let name: String", "let kind: String"):
        assert field in block, f"CaptureSource missing neutral field: {field}"
    for forbidden in ("SCStream", "SCDisplay", "CATap", "SCContentFilter"):
        assert forbidden not in block, (
            f"D-09 violation: '{forbidden}' appears in CaptureSource"
        )


# ── 02-04: Core Audio process-tap arm (PLAT-02 / D-01 / D-03) ────────────────
#
# The 14.4+ tap arm (ProcessTapBackend) must exist, conform to CaptureBackend,
# be selected behind `if #available(macOS 14.4, *)` with the SCK arm as the
# `else`, and carry the Pitfall-3 teardown+rebuild destroy order. The macOS floor
# stays 13+ — the gate must be 14.4 and must NOT be lowered to 14.2.


def test_process_tap_backend_declared_and_conforms():
    src = _source()
    assert "ProcessTapBackend" in src, "ProcessTapBackend (14.4+ tap arm) is missing"
    # class decl line carries both the type name and CaptureBackend conformance.
    m = re.search(r"class ProcessTapBackend[^\n{]*", src)
    assert m, "ProcessTapBackend declaration not found"
    assert "CaptureBackend" in m.group(0), (
        "ProcessTapBackend must conform to CaptureBackend"
    )


def test_process_tap_backend_referenced_at_least_twice():
    # Once for the class declaration, once for the AppDelegate selection — proves
    # the consumer actually switches to the tap arm, not just declares it.
    src = _source()
    assert src.count("ProcessTapBackend") >= 2, (
        "ProcessTapBackend must appear at least twice (declaration + AppDelegate selection)"
    )


def test_tap_arm_gated_at_14_4_not_lowered():
    src = _source()
    assert "#available(macOS 14.4" in src, (
        "the tap arm must be gated behind `if #available(macOS 14.4, *)`"
    )
    # D-01/D-03: the gate must NOT be lowered to 14.2 (symbols exist there but the
    # runtime is unreliable). A 14.2 gate anywhere is a regression.
    assert "#available(macOS 14.2" not in src, (
        "the capture gate was lowered to 14.2 — D-01/D-03 require exactly 14.4"
    )


def test_tap_arm_availability_attribute_present():
    # The class itself must be @available(macOS 14.4, *) so the tap symbols are
    # only referenced where they exist.
    assert "@available(macOS 14.4, *)" in _source(), (
        "ProcessTapBackend must be annotated @available(macOS 14.4, *)"
    )


def test_sck_arm_is_the_else_branch():
    # The selection must fall back to ScreenCaptureKitBackend on < 14.4 — the floor
    # stays 13+. Anchor on the ACTUAL construction site (ProcessTapBackend(recorder:)),
    # not the class doc-comment, then assert the enclosing availability switch.
    src = _source()
    ctor = src.index("ProcessTapBackend(recorder:")
    # The `if #available(macOS 14.4, *)` guard must immediately precede the ctor.
    preceding = src[max(0, ctor - 200) : ctor]
    assert "#available(macOS 14.4" in preceding, (
        "the ProcessTapBackend construction must sit inside `if #available(macOS 14.4, *)`"
    )
    following = src[ctor : ctor + 200]
    assert "else" in following and "ScreenCaptureKitBackend(recorder:" in following, (
        "the else branch must construct ScreenCaptureKitBackend(recorder:) (floor stays 13+)"
    )


def test_pitfall3_teardown_destroy_order_present():
    # Pitfall 3 recovery (02-RESEARCH.md:399-403): all three Core Audio destroy
    # calls must be wired so the zero-buffer teardown+rebuild actually frees the
    # tap + aggregate stack (not merely logs).
    src = _source()
    for symbol in (
        "AudioDeviceDestroyIOProcID",
        "AudioHardwareDestroyAggregateDevice",
        "AudioHardwareDestroyProcessTap",
    ):
        assert symbol in src, f"Pitfall-3 teardown is missing {symbol}"


def test_pitfall3_zero_buffer_detection_and_rebuild():
    # The all-zero-buffer bug must be DETECTED (frameCount>0 yet all samples 0.0)
    # and RECOVERED via a rebuild, not just logged.
    src = _source()
    assert "allSatisfy { $0 == 0.0 }" in src, (
        "zero-buffer detection (allSatisfy { $0 == 0.0 }) is missing"
    )
    assert "buildTap" in src, "tap (re)build entry point buildTap is missing"


def test_pitfall3_zero_buffer_recovery_is_bounded_and_generation_scoped():
    src = _source()
    assert "ZeroBufferRecoveryPolicy" in src
    assert "maxAttempts: 3" in src
    assert "captureGeneration" in src
    assert "recoverFromZeroBuffers(generation:" in src

    start = src.index("private func recoverFromZeroBuffers(generation:")
    end = src.index("private func teardown()", start)
    body = src[start:end]
    assert body.index("captureGeneration == generation") < body.index("teardown()")


def test_mic_capture_restarts_after_audio_route_change():
    src = _source()
    start = src.index("class MicCapture")
    end = src.index("// ─── SCStream", start)
    body = src[start:end]
    assert ".AVAudioEngineConfigurationChange" in body
    assert "restartAfterConfigurationChange" in body
    assert "noteCaptureRouteChange" in body


def test_meeting_silence_threshold_prompts_instead_of_stopping_capture_directly():
    src = _source()
    start = src.index("rec.onStopRequest =")
    end = src.index("// Probe TCC permissions", start)
    body = src[start:end]
    assert "launchMeetingSilencePrompt()" in body
    assert "SYS_DISABLED" in body
    assert 'appendingPathComponent("meeting_daemon.py")' in src
    assert 'meetingDaemon.path, "auto_stop"' in src


def test_tap_feeds_existing_sink():
    # The tap must push into the SAME frame sink as the SCK arm and reuse the
    # exact SysAudioOutput Int16 clamp (no re-derivation).
    src = _source()
    # recorder.onSysAudio appears for both SCK (SysAudioOutput) and the tap.
    assert src.count("recorder.onSysAudio(") >= 2, (
        "the tap arm must feed recorder.onSysAudio like the SCK arm"
    )
    assert src.count("Int16(max(-1.0, min(1.0, $0)) * Float(Int16.max))") >= 2, (
        "the tap must reuse the SysAudioOutput Int16 clamp verbatim (no re-derivation)"
    )


def test_dual_source_recording_writes_common_frames_not_zero_padded_max():
    src = _source()
    start = src.index("private func mixAndWriteOnQueue()")
    end = src.index("private func flushBuffersOnQueue()", start)
    body = src[start:end]
    assert "min(sysFrames, micFrames)" in body, (
        "dual-source recording must write only common mic/sys frames"
    )
    assert "max(sysFrames, micFrames)" not in body, (
        "max(sysFrames, micFrames) zero-pads async callbacks and stretches the WAV timeline"
    )
    assert "let micOnly = SYS_DISABLED" in body, (
        "mic-only recordings must remain explicitly gated by SYS_DISABLED"
    )
