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
