"""Round-trip: ensure the Swift-emitted byte layout (recreated in Python with
the exact same constants) classifies as DUAL_TRACK. This guards against
drift between the Swift writer and the Python classifier."""

import struct
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from wav_inspect import WavLayout, classify


def _swift_equivalent_header(audio_size: int) -> bytes:
    """Mirror the exact bytes audio_daemon.swift::patchHeaderLocked writes."""
    HDR = 82
    file_size = audio_size + HDR - 8
    out = bytearray()
    out += b"RIFF" + struct.pack("<I", file_size) + b"WAVE"
    out += b"fmt " + struct.pack("<I", 16)
    out += struct.pack("<HHIIHH", 1, 2, 48000, 48000 * 2 * 2, 4, 16)
    out += b"LIST" + struct.pack("<I", 30) + b"INFO"
    out += b"ICMT" + struct.pack("<I", 18) + b"Yulu DualTrack v1\x00"
    out += b"data" + struct.pack("<I", audio_size)
    assert len(out) == HDR
    return bytes(out)


def test_swift_byte_layout_classifies_as_dual_track(tmp_path):
    p = tmp_path / "swift_like.wav"
    pcm = b"\x00\x00\x00\x00" * 32  # 32 stereo frames
    p.write_bytes(_swift_equivalent_header(len(pcm)) + pcm)

    assert classify(p) is WavLayout.DUAL_TRACK


def test_swift_byte_layout_header_is_exactly_82(tmp_path):
    """The data PCM begins at byte 82."""
    p = tmp_path / "hdr_size.wav"
    pcm = b""
    p.write_bytes(_swift_equivalent_header(len(pcm)) + pcm)
    # Byte 74 should be the 'd' of 'data'; bytes 74-77 = 'data'; 78-81 = size (LE u32 = 0)
    bytes_ = p.read_bytes()
    assert bytes_[74:78] == b"data"
    assert struct.unpack("<I", bytes_[78:82])[0] == 0  # audio_size = 0
