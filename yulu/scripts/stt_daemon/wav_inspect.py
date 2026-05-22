"""Inspect WAV header / RIFF chunks to classify a recording into one of:

- MONO              — channels == 1
- DUAL_TRACK        — channels == 2 AND LIST/INFO/ICMT carries the
                      `Yulu DualTrack v1` marker
- LEGACY_STEREO     — channels == 2 otherwise

This is the only mechanism that distinguishes a post-Phase-3 dual-track
WAV (true L=mic / R=sys separation) from a pre-Phase-3 mixed-stereo WAV
(both channels carry halfDuplexMix). Their PCM content alone is
indistinguishable.

The module reads only the RIFF chunk skeleton — no audio data is decoded.
"""

from __future__ import annotations

import struct
from enum import Enum
from pathlib import Path

DUAL_TRACK_MARKER = b"Yulu DualTrack v1"


class WavLayout(Enum):
    MONO = "mono"
    DUAL_TRACK = "dual_track"
    LEGACY_STEREO = "legacy_stereo"


def classify(path: Path) -> WavLayout:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(path)

    with path.open("rb") as f:
        riff = f.read(12)
        if len(riff) < 12 or riff[:4] != b"RIFF" or riff[8:12] != b"WAVE":
            return WavLayout.LEGACY_STEREO

        channels = None
        has_marker = False

        while True:
            head = f.read(8)
            if len(head) < 8:
                break
            chunk_id, chunk_size = head[:4], struct.unpack("<I", head[4:8])[0]

            if chunk_id == b"fmt ":
                fmt = f.read(chunk_size)
                if len(fmt) >= 4:
                    # AudioFormat (2 bytes) + NumChannels (2 bytes)
                    channels = struct.unpack("<H", fmt[2:4])[0]
                # Align to even byte (RIFF requires word-aligned chunks)
                if chunk_size % 2:
                    f.read(1)

            elif chunk_id == b"LIST":
                body = f.read(chunk_size)
                if body[:4] == b"INFO" and DUAL_TRACK_MARKER in body:
                    has_marker = True
                if chunk_size % 2:
                    f.read(1)

            elif chunk_id == b"data":
                # Stop reading once data chunk hits — INFO is always written
                # before data per the writer contract.
                break

            else:
                f.seek(chunk_size, 1)
                if chunk_size % 2:
                    f.read(1)

    if channels == 1:
        return WavLayout.MONO
    if channels == 2 and has_marker:
        return WavLayout.DUAL_TRACK
    return WavLayout.LEGACY_STEREO
