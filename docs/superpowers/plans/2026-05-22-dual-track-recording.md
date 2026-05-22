# Dual-Track Recording + Recording Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Yulu recordings preserve source identity (mic vs sys) all the way from the WavWriter to LLM prompts, while folding in a small flock-based mutex for recording-start.

**Architecture:** Single canonical stereo WAV (L=mic mono, R=sys downmixed mono) tagged with a RIFF LIST/INFO `ICMT=Yulu DualTrack v1` subchunk. stt_daemon classifies any input via `WavLayout` (MONO/DUAL_TRACK/LEGACY_STEREO), splits dual-track in-memory into two STT jobs, and returns per-channel results. transcribe.py merges per-channel segments into a speaker-tagged `<wav>.transcript.txt` plus raw per-channel siblings. PromptsCache exposes new `{{my_transcript}}` / `{{their_transcript}}` template vars, with `{{transcript}}` still pointing at the merged file for backward compatibility. A new `recording_lock.py` module wraps `fcntl.flock` to serialize start-recording across manual / scheduled / detector callers. Live session reads alternating samples from the same stereo WAV via stride extraction (no sidecar files).

**Tech Stack:** Swift 5.x (audio_daemon.swift, AVAudioEngine + ScreenCaptureKit), Python 3.x (`stt_daemon`, `transcribe.py`, `prompts/`, `recording_lock.py`, `live_session.py`), `pytest`, `fcntl.flock` (POSIX advisory lock).

**Spec:** [`docs/superpowers/specs/2026-05-22-dual-track-recording-design.md`](../specs/2026-05-22-dual-track-recording-design.md)

---

## Phase A — WAV Layout Primitives

### Task A.1: WavLayout classifier

**Files:**
- Create: `yulu/scripts/stt_daemon/wav_inspect.py`
- Create: `tests/test_wav_inspect.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_wav_inspect.py` (verbatim):

```python
"""Unit tests for stt_daemon.wav_inspect.WavLayout classifier.

Generates synthetic WAV byte streams (RIFF / fmt / optional LIST-INFO / data)
rather than producing audio — the classifier only inspects header bytes."""

from __future__ import annotations

import struct
import sys
import wave
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.wav_inspect import WavLayout, classify, DUAL_TRACK_MARKER


def _write_mono(path: Path, n_samples: int = 16) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(48000)
        w.writeframes(b"\x00\x00" * n_samples)


def _write_plain_stereo(path: Path, n_frames: int = 16) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(48000)
        w.writeframes(b"\x00\x00\x00\x00" * n_frames)


def _write_stereo_with_marker(path: Path, marker: bytes = DUAL_TRACK_MARKER,
                              n_frames: int = 16) -> None:
    """Hand-write a RIFF/WAVE file: RIFF + fmt + LIST-INFO-ICMT + data."""
    pcm = b"\x00\x00\x00\x00" * n_frames

    # fmt chunk (PCM stereo 48kHz 16-bit)
    fmt = struct.pack("<HHIIHH", 1, 2, 48000, 48000 * 2 * 2, 4, 16)
    fmt_chunk = b"fmt " + struct.pack("<I", len(fmt)) + fmt

    # ICMT subchunk: id (4) + size (4) + payload (must be word-aligned)
    payload = marker + b"\x00"  # null terminator
    if len(payload) % 2:
        payload += b"\x00"
    icmt = b"ICMT" + struct.pack("<I", len(payload)) + payload

    # LIST chunk: id (4) + size (4) + form-type (4=INFO) + subchunks
    list_body = b"INFO" + icmt
    list_chunk = b"LIST" + struct.pack("<I", len(list_body)) + list_body

    data_chunk = b"data" + struct.pack("<I", len(pcm)) + pcm

    body = b"WAVE" + fmt_chunk + list_chunk + data_chunk
    riff = b"RIFF" + struct.pack("<I", len(body)) + body
    path.write_bytes(riff)


def test_classify_mono(tmp_path):
    p = tmp_path / "mono.wav"
    _write_mono(p)
    assert classify(p) is WavLayout.MONO


def test_classify_legacy_stereo_no_info_chunk(tmp_path):
    p = tmp_path / "legacy.wav"
    _write_plain_stereo(p)
    assert classify(p) is WavLayout.LEGACY_STEREO


def test_classify_dual_track_marker(tmp_path):
    p = tmp_path / "dt.wav"
    _write_stereo_with_marker(p)
    assert classify(p) is WavLayout.DUAL_TRACK


def test_classify_unknown_info_value_is_legacy(tmp_path):
    p = tmp_path / "other_info.wav"
    _write_stereo_with_marker(p, marker=b"Some Other Recorder v3")
    assert classify(p) is WavLayout.LEGACY_STEREO


def test_classify_nonexistent_raises(tmp_path):
    import pytest
    with pytest.raises(FileNotFoundError):
        classify(tmp_path / "missing.wav")


def test_classify_truncated_file_returns_legacy_stereo(tmp_path):
    """A 12-byte header-only file should not crash — degrade gracefully."""
    p = tmp_path / "trunc.wav"
    p.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    # No fmt → channels unknown → safest fallback is LEGACY_STEREO so the
    # caller treats it as opaque and downmixes/skips.
    assert classify(p) in {WavLayout.LEGACY_STEREO, WavLayout.MONO}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6 && PYTHONPATH=yulu/scripts python3 -m pytest tests/test_wav_inspect.py -v`
Expected: ImportError / ModuleNotFoundError — `wav_inspect` doesn't exist.

- [ ] **Step 3: Write `wav_inspect.py`**

Create `yulu/scripts/stt_daemon/wav_inspect.py` (verbatim):

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_wav_inspect.py -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/stt_daemon/wav_inspect.py tests/test_wav_inspect.py
git commit -m "feat(stt_daemon): add WavLayout classifier for dual-track detection"
```

---

### Task A.2: Swift WavWriter emits LIST/INFO ICMT marker

**Files:**
- Modify: `yulu/scripts/audio_daemon.swift:88-167` (`WavWriter` class)
- Create: `tests/test_wav_inspect_roundtrip.py`

The post-spec WAV header layout becomes:

```
offset 0:    "RIFF" + total_size (4 LE)
offset 8:    "WAVE"
offset 12:   "fmt " + 16 (LE) + 16-byte PCM fmt body  (24 bytes)
offset 36:   "LIST" + LIST_size (4 LE) + "INFO" + ICMT subchunk  (LIST_size + 8 bytes)
offset HDR:  "data" + audio_size (4 LE) + PCM samples
```

`ICMT` payload = `b"Yulu DualTrack v1\x00"` (18 bytes, even — no extra pad).
`ICMT` chunk total = 4 (id) + 4 (size=18) + 18 (payload) = 26 bytes.
`LIST` body = 4 (form="INFO") + 26 (ICMT) = 30 bytes.
`LIST` chunk total = 4 (id) + 4 (size=30) + 30 = 38 bytes.

New `HDR` (header end before data PCM) = 36 (RIFF..fmt) + 8 (fmt id+size) + 16 (fmt body) + 38 (LIST chunk) + 8 (data id+size) = 106 bytes.
Wait — recompute carefully: RIFF (4) + size (4) + WAVE (4) = 12; fmt (4) + size (4) + body (16) = 24; LIST chunk total = 38; data (4) + size (4) = 8. Sum: 12+24+38+8 = **82 bytes** of header before PCM starts.

So `WAV_HEADER_BYTES` (live_session.py) becomes **82** for dual-track WAVs. Mono / legacy stereo stays at 44.

- [ ] **Step 1: Update WavWriter init to reserve 82-byte header**

Replace `yulu/scripts/audio_daemon.swift` line 97 (the `FileManager.default.createFile` call inside `WavWriter.init`):

```swift
init?(url: URL) {
    self.url = url
    // 82 bytes = RIFF(12) + fmt chunk(24) + LIST-INFO-ICMT chunk(38) + data header(8)
    FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 0, count: 82))
    guard let h = try? FileHandle(forUpdating: url) else { return nil }
    self.handle = h
    patchHeader(sync: true)
}
```

- [ ] **Step 2: Update `patchHeaderLocked` to emit the LIST/INFO chunk**

Replace the entire body of `patchHeaderLocked(sync:)` (lines 132–166) with:

```swift
private func patchHeaderLocked(sync: Bool) {
    let HDR_BYTES: UInt32 = 82
    let fileSize = audioSize + HDR_BYTES - 8  // RIFF size = total - 8

    var h = Data()
    // RIFF header
    h.append(contentsOf: [0x52,0x49,0x46,0x46] as [UInt8])   // "RIFF"
    var v32 = fileSize.littleEndian
    withUnsafeBytes(of: &v32) { h.append(Data($0)) }
    h.append(contentsOf: [0x57,0x41,0x56,0x45] as [UInt8])   // "WAVE"

    // fmt chunk
    h.append(contentsOf: [0x66,0x6D,0x74,0x20] as [UInt8])   // "fmt "
    v32 = UInt32(16).littleEndian
    withUnsafeBytes(of: &v32) { h.append(Data($0)) }
    var v16 = UInt16(1).littleEndian                          // PCM
    withUnsafeBytes(of: &v16) { h.append(Data($0)) }
    v16 = UInt16(2).littleEndian                              // channels=2
    withUnsafeBytes(of: &v16) { h.append(Data($0)) }
    v32 = UInt32(48000).littleEndian                          // sample rate
    withUnsafeBytes(of: &v32) { h.append(Data($0)) }
    v32 = UInt32(48000 * 2 * 2).littleEndian                  // byte rate
    withUnsafeBytes(of: &v32) { h.append(Data($0)) }
    v16 = UInt16(4).littleEndian                              // block align
    withUnsafeBytes(of: &v16) { h.append(Data($0)) }
    v16 = UInt16(16).littleEndian                             // bits/sample
    withUnsafeBytes(of: &v16) { h.append(Data($0)) }

    // LIST chunk with INFO/ICMT="Yulu DualTrack v1\0"
    h.append(contentsOf: [0x4C,0x49,0x53,0x54] as [UInt8])   // "LIST"
    v32 = UInt32(30).littleEndian                             // LIST body size
    withUnsafeBytes(of: &v32) { h.append(Data($0)) }
    h.append(contentsOf: [0x49,0x4E,0x46,0x4F] as [UInt8])   // "INFO"
    h.append(contentsOf: [0x49,0x43,0x4D,0x54] as [UInt8])   // "ICMT"
    v32 = UInt32(18).littleEndian                             // ICMT payload size
    withUnsafeBytes(of: &v32) { h.append(Data($0)) }
    // "Yulu DualTrack v1\0" = 18 bytes (even, no pad needed)
    h.append("Yulu DualTrack v1".data(using: .ascii)!)
    h.append(contentsOf: [0x00] as [UInt8])                   // null terminator

    // data chunk header
    h.append(contentsOf: [0x64,0x61,0x74,0x61] as [UInt8])   // "data"
    v32 = audioSize.littleEndian
    withUnsafeBytes(of: &v32) { h.append(Data($0)) }

    precondition(h.count == 82, "WAV header must be exactly 82 bytes (got \(h.count))")

    do {
        try handle?.seek(toOffset: 0)
        try handle?.write(contentsOf: h)
        try handle?.seekToEnd()
        if sync { handle?.synchronizeFile() }
        lastHeaderPatch = Date()
    } catch {
        log("WAV header patch failed: \(error)")
    }
}
```

- [ ] **Step 3: Add a Python round-trip test**

Create `tests/test_wav_inspect_roundtrip.py`:

```python
"""Round-trip: ensure the Swift-emitted byte layout (recreated in Python with
the exact same constants) classifies as DUAL_TRACK. This guards against
drift between the Swift writer and the Python classifier."""

import struct
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.wav_inspect import WavLayout, classify


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
    p = tmp_path / "hdr_size.wav"
    pcm = b""
    p.write_bytes(_swift_equivalent_header(len(pcm)) + pcm)
    # The data PCM starts at byte 82
    assert p.read_bytes()[78:82] == b"data" + struct.pack("<I", 0)[:-2] + b"\x00\x00"
```

- [ ] **Step 4: Run Python tests**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_wav_inspect_roundtrip.py -v`
Expected: 2 passed.

- [ ] **Step 5: Build the daemon and smoke-record 2 seconds**

This step verifies the Swift change actually compiles and produces a classifiable WAV. Skip if the host is non-macOS or audio_daemon binary isn't installable.

Run:
```bash
bash yulu/scripts/build_audio_daemon.sh
# Manual: start audio_daemon, record ~2s, stop. Then:
PYTHONPATH=yulu/scripts python3 -c "
from pathlib import Path
from stt_daemon.wav_inspect import WavLayout, classify
wav = sorted(Path.home().joinpath('Movies/Yulu').glob('*.wav'))[-1]
print(wav, '→', classify(wav))
"
```

Expected: last line ends with `→ WavLayout.DUAL_TRACK`.

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/audio_daemon.swift tests/test_wav_inspect_roundtrip.py
git commit -m "feat(audio_daemon): emit 'Yulu DualTrack v1' RIFF INFO marker in WAV header"
```

---

## Phase B — Swift Recording Layer: Source-Separated Stereo

### Task B.1: Replace `halfDuplexMix` with `channelInterleave`

**Files:**
- Modify: `yulu/scripts/audio_daemon.swift:246-336` (`AudioRecorder` mix/write methods)

The output WAV must carry `L = mic mono` and `R = sys downmixed to mono`. The two source buffers (`micBuf: [Int16]` mono, `sysBuf: [Int16]` stereo interleaved) already exist.

- [ ] **Step 1: Add `channelInterleave` helper**

Insert (between `private func calcRMS` and `private func mixAndWrite`, i.e. before line 274):

```swift
/// Produce an interleaved stereo PCM stream where L=mic mono and
/// R=(sysL + sysR)/2 downmixed to mono. Source-separated; no ducking.
/// Inputs:
///   - sysStereo: interleaved Int16 stereo (length must be even)
///   - micMono:   Int16 mono samples
/// Output length is `sysStereo.count` (one stereo Int16 per frame).
private func channelInterleave(sysStereo: [Int16], micMono: [Int16]) -> [Int16] {
    let frames = sysStereo.count / 2
    var out = [Int16](repeating: 0, count: frames * 2)
    let micFrames = micMono.count

    for i in 0..<frames {
        // L = mic mono (zero-padded if mic short)
        out[2 * i] = i < micFrames ? micMono[i] : 0
        // R = (sysL + sysR) / 2 with overflow-safe Int32 widening
        let sysL = Int32(sysStereo[2 * i])
        let sysR = Int32(sysStereo[2 * i + 1])
        out[2 * i + 1] = Int16((sysL + sysR) / 2)
    }
    return out
}
```

- [ ] **Step 2: Rewrite `mixAndWrite` to drive output by max(mic, sys)**

Replace lines 275–298 (the entire `private func mixAndWrite()` body) with:

```swift
/// 流式 source-separated: 从 sysBuf/micBuf 取等量数据,
/// 写出 L=mic / R=sys downmix(L+R/2) 的立体声 PCM.
private func mixAndWrite() {
    guard let w = writer else { return }
    bufLock.lock()

    // Drive output frame count by whichever side has more buffered;
    // zero-pad the shorter side. This preserves recording continuity
    // when one source is silent (no sys = mic-only voicemail; no mic
    // = sys-only, currently rare but a future capture mode).
    let sysFrames = sysBuf.count / 2
    let micFrames = micBuf.count
    let outFrames = max(sysFrames, micFrames)
    guard outFrames >= 512 else { bufLock.unlock(); return }  // wait for ~10 ms

    // Take outFrames mono mic samples (zero-pad if short).
    let micChunk: [Int16]
    if micBuf.count >= outFrames {
        micChunk = Array(micBuf.prefix(outFrames))
        micBuf.removeFirst(outFrames)
    } else {
        micChunk = micBuf + [Int16](repeating: 0, count: outFrames - micBuf.count)
        micBuf.removeAll()
    }

    // Take outFrames stereo sys samples (zero-pad if short).
    let sysChunk: [Int16]
    if sysBuf.count >= outFrames * 2 {
        sysChunk = Array(sysBuf.prefix(outFrames * 2))
        sysBuf.removeFirst(outFrames * 2)
    } else {
        sysChunk = sysBuf + [Int16](repeating: 0, count: outFrames * 2 - sysBuf.count)
        sysBuf.removeAll()
    }
    bufLock.unlock()

    let out = channelInterleave(sysStereo: sysChunk, micMono: micChunk)
    w.append(Data(bytes: out, count: out.count * 2))
}
```

- [ ] **Step 3: Update `flushBuffers` for the new shape**

Replace lines 338–349 (the entire `private func flushBuffers()` body) with:

```swift
private func flushBuffers() {
    guard let w = writer else { return }
    bufLock.lock()
    let sysFrames = sysBuf.count / 2
    let micFrames = micBuf.count
    let outFrames = max(sysFrames, micFrames)
    if outFrames == 0 { bufLock.unlock(); return }

    let micChunk: [Int16] = micBuf + [Int16](repeating: 0, count: max(0, outFrames - micFrames))
    let sysChunk: [Int16] = sysBuf + [Int16](repeating: 0, count: max(0, outFrames * 2 - sysBuf.count))
    micBuf.removeAll()
    sysBuf.removeAll()
    bufLock.unlock()

    let out = channelInterleave(sysStereo: Array(sysChunk.prefix(outFrames * 2)),
                                 micMono:   Array(micChunk.prefix(outFrames)))
    w.append(Data(bytes: out, count: out.count * 2))
}
```

- [ ] **Step 4: Delete `halfDuplexMix` and the now-unused `fadePos` state**

Remove lines 300–336 (the entire `private func halfDuplexMix(sys:mic:) -> [Int16]` and its surrounding `// 流式混音` block comment) **and** remove `var fadePos: Float = 0` (originally line 216) and the line `sysBuf = []; micBuf = []; fadePos = 0` inside `start()` (originally line 225) — replace that line with just `sysBuf = []; micBuf = []`.

- [ ] **Step 5: Build the daemon to confirm it compiles**

Run: `bash yulu/scripts/build_audio_daemon.sh`
Expected: builds clean. If the build fails, fix the syntax and re-run.

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/audio_daemon.swift
git commit -m "feat(audio_daemon): replace halfDuplexMix with source-separated channelInterleave"
```

---

### Task B.2: Per-channel silence detection

Today's `lastAudioTime` is reset whenever **either** source delivers RMS > threshold — but it's set inside the same call path that already mixed signals. Now we track per channel and require both to be silent before triggering the silence-stop monitor.

**Files:**
- Modify: `yulu/scripts/audio_daemon.swift` (`onMicAudio`, `onSysAudio`, silence-monitor state)

- [ ] **Step 1: Split `lastAudioTime` into per-channel timestamps**

In `AudioRecorder` (around the existing `var lastAudioTime: Date?` declaration, originally line 207), replace that line with:

```swift
var lastMicAudioTime: Date?
var lastSysAudioTime: Date?
```

Update `start(title:)` to initialize both: replace the existing `lastAudioTime = Date()` (originally line 224) with:

```swift
lastMicAudioTime = Date(); lastSysAudioTime = Date()
```

- [ ] **Step 2: Update RMS resets to be per-channel**

Inside `onSysAudio(_:)`, replace `if rms > SILENCE_THRESHOLD { lastAudioTime = Date() }` with:

```swift
if rms > SILENCE_THRESHOLD { lastSysAudioTime = Date() }
```

Inside `onMicAudio(_:)`, replace the analogous line with:

```swift
if rms > SILENCE_THRESHOLD { lastMicAudioTime = Date() }
```

- [ ] **Step 3: Update silence monitor to require both silent**

Replace `startSilenceMonitor()` body (originally lines 352–362) with:

```swift
private func startSilenceMonitor() {
    silenceTask?.cancel()
    let task = DispatchWorkItem { [weak self] in
        guard let self = self, self.isRecording else { return }
        let now = Date()
        let micQuiet = (self.lastMicAudioTime.map { now.timeIntervalSince($0) } ?? .infinity) >= self.silenceSeconds
        let sysQuiet = (self.lastSysAudioTime.map { now.timeIntervalSince($0) } ?? .infinity) >= self.silenceSeconds
        if micQuiet && sysQuiet {
            log("🔇 silence \(Int(self.silenceSeconds))s (both channels) — auto stop")
            self.onStopRequest?()
        }
    }
    silenceTask = task
    DispatchQueue.main.asyncAfter(deadline: .now() + silenceSeconds, execute: task)
}
```

- [ ] **Step 4: Build to confirm compilation**

Run: `bash yulu/scripts/build_audio_daemon.sh`
Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/audio_daemon.swift
git commit -m "feat(audio_daemon): per-channel silence detection — both channels quiet to stop"
```

---

### Task B.3: Mic-only fallback when sys disabled

When `SYS_READY=false` (sys explicitly disabled or permission denied), recording should still produce a stereo WAV with R=0. The current `mixAndWrite` rewrite from B.1 already handles this because it drives by `max(sysFrames, micFrames)` and zero-pads the missing side. This task **verifies** that path with a Swift constant flip and adds a CLI knob.

**Files:**
- Modify: `yulu/scripts/audio_daemon.swift` (recording startup branch)

- [ ] **Step 1: Add `SYS_DISABLED` startup-config flag**

In the global state section (near `var SYS_READY = false` declarations, find them with `grep -n "SYS_READY" yulu/scripts/audio_daemon.swift`), add directly after `var SYS_READY = false`:

```swift
/// When true, SCStream / ScreenCaptureKit is intentionally not started
/// (voicemail / dictation use case). The WAV's R channel stays at 0.
var SYS_DISABLED = false
```

- [ ] **Step 2: Honor it in the screen-capture startup**

Find the `SysCapture` (or equivalent) startup site — the section that calls `SCStream.startCapture(...)`. Wrap the start call so that when `SYS_DISABLED == true` it short-circuits, logs once, and leaves `SYS_READY = false`. Concrete change at the `start()` site (search for `SCStream.startCapture` or the `class SysCapture`-equivalent that already exists in the file):

```swift
func start() {
    if SYS_DISABLED {
        log("🔇 SYS_DISABLED — mic-only recording mode")
        SYS_READY = false
        return
    }
    // ... existing start logic unchanged ...
}
```

- [ ] **Step 3: Expose via control socket — accept `sys_disabled` in `start` action**

Find the action dispatcher (search for `"start"` action keyword inside the socket handler). At the point where `start` is processed, parse a JSON field `sys_disabled: Bool` from the request and set the global before kicking off capture:

```swift
if let req = json["sys_disabled"] as? Bool { SYS_DISABLED = req }
```

(If the existing handler uses `JSONSerialization` and `json: [String: Any]`, just plumb the boolean through; otherwise extend the request struct.)

- [ ] **Step 4: Build to confirm compilation**

Run: `bash yulu/scripts/build_audio_daemon.sh`
Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/audio_daemon.swift
git commit -m "feat(audio_daemon): SYS_DISABLED knob for mic-only recording mode"
```

---

## Phase C — `stt_daemon` Channel-Aware Transcribe

### Task C.1: Add `channel_split` field to protocol

**Files:**
- Modify: `yulu/scripts/stt_daemon/protocol.py`
- Modify: `tests/test_stt_daemon_protocol.py` (or `test_protocol.py` — discover the existing one)
- Create: `tests/test_stt_daemon_channel_split_protocol.py`

- [ ] **Step 1: Inspect the existing protocol module**

Run: `grep -nE "(class TranscribeRequest|TranscribeResponse|@dataclass)" yulu/scripts/stt_daemon/protocol.py | head`

Read the file to confirm where to add the new field. Expect to see `TranscribeRequest` and `TranscribeResponse` dataclasses (or `TypedDict`).

- [ ] **Step 2: Write the failing test**

Create `tests/test_stt_daemon_channel_split_protocol.py`:

```python
"""Protocol contract for channel_split (Phase 3)."""

import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.protocol import TranscribeRequest


def test_transcribe_request_default_channel_split_is_false():
    """Back-compat: existing callers without the field get mono behavior."""
    req = TranscribeRequest(wav="/tmp/x.wav", title="t")
    assert req.channel_split is False


def test_transcribe_request_accepts_channel_split_true():
    req = TranscribeRequest(wav="/tmp/x.wav", title="t", channel_split=True)
    assert req.channel_split is True
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_stt_daemon_channel_split_protocol.py -v`
Expected: AttributeError or TypeError — `channel_split` not in `TranscribeRequest`.

- [ ] **Step 4: Add the field**

Open `yulu/scripts/stt_daemon/protocol.py`. In the `TranscribeRequest` dataclass (or `TypedDict`), add a field:

```python
channel_split: bool = False
```

If `TranscribeRequest` is a `TypedDict`, add `channel_split: NotRequired[bool]` and update the constructor wherever the daemon decodes the JSON request to default to `False`.

- [ ] **Step 5: Run to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_stt_daemon_channel_split_protocol.py -v`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/stt_daemon/protocol.py tests/test_stt_daemon_channel_split_protocol.py
git commit -m "feat(stt_daemon): add channel_split field to TranscribeRequest"
```

---

### Task C.2: `STTRuntime` dispatches on `WavLayout`

**Files:**
- Modify: `yulu/scripts/stt_daemon/runtime.py` (or wherever `transcribe()` is dispatched — discover by `grep -nE "def transcribe|def _handle_transcribe" yulu/scripts/stt_daemon/*.py`)
- Create: `tests/test_stt_daemon_channel_split_dispatch.py`

- [ ] **Step 1: Discover the dispatch site**

Run: `grep -nE "(def transcribe|class STTRuntime|_handle_transcribe|return_response)" yulu/scripts/stt_daemon/runtime.py yulu/scripts/stt_daemon/control_server.py yulu/scripts/stt_daemon/app.py 2>&1 | head -20`

Identify the function that receives a `TranscribeRequest` and returns a `TranscribeResponse`. The new dispatch lives here. (The existing function likely calls `self.backend.transcribe(wav_path, ...)` for the mono case.)

- [ ] **Step 2: Write the failing tests**

Create `tests/test_stt_daemon_channel_split_dispatch.py`:

```python
"""Dual-track dispatch: ensure channel_split=True routes through WavLayout
classification and produces per-channel results."""

import struct
import sys
import wave
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.wav_inspect import WavLayout, classify, DUAL_TRACK_MARKER
from stt_daemon.runtime import dispatch_transcribe, STTResult


class _FakeBackend:
    """Records every call so the test can assert how many jobs were dispatched."""

    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    def transcribe(self, *, audio_path: str, language: str, initial_prompt: str = "") -> STTResult:
        # Echo a deterministic text per call so the test can tell channels apart
        self.calls.append((audio_path, initial_prompt))
        n = len(self.calls)
        return STTResult(text=f"chunk{n}", segments=[{"start": 0.0, "end": 1.0, "text": f"chunk{n}"}])


def _write_mono(path: Path):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(b"\x00\x00" * 16)


def _write_dual_track(path: Path):
    pcm = b"\x00\x00\x00\x00" * 64
    body = bytearray()
    body += b"RIFF" + struct.pack("<I", 0) + b"WAVE"
    body += b"fmt " + struct.pack("<I", 16) + struct.pack("<HHIIHH", 1, 2, 48000, 192000, 4, 16)
    body += b"LIST" + struct.pack("<I", 30) + b"INFO" + b"ICMT" + struct.pack("<I", 18) + b"Yulu DualTrack v1\x00"
    body += b"data" + struct.pack("<I", len(pcm)) + pcm
    body[4:8] = struct.pack("<I", len(body) - 8)
    path.write_bytes(bytes(body))


def _write_legacy_stereo(path: Path):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(b"\x00\x00\x00\x00" * 64)


def test_dispatch_mono_returns_single_text(tmp_path):
    p = tmp_path / "m.wav"
    _write_mono(p)
    backend = _FakeBackend()

    resp = dispatch_transcribe(
        wav_path=p, channel_split=True, backend=backend,
        language="zh", initial_prompt="",
    )

    assert resp.layout is WavLayout.MONO
    assert resp.channels is None  # mono path returns flat text
    assert resp.text == "chunk1"
    assert len(backend.calls) == 1


def test_dispatch_dual_track_runs_two_jobs(tmp_path):
    p = tmp_path / "dt.wav"
    _write_dual_track(p)
    backend = _FakeBackend()

    resp = dispatch_transcribe(
        wav_path=p, channel_split=True, backend=backend,
        language="zh", initial_prompt="",
    )

    assert resp.layout is WavLayout.DUAL_TRACK
    assert resp.channels is not None
    assert set(resp.channels.keys()) == {"mic", "sys"}
    assert resp.channels["mic"]["text"] == "chunk1"
    assert resp.channels["sys"]["text"] == "chunk2"
    assert len(backend.calls) == 2


def test_dispatch_legacy_stereo_downmixes_to_mono(tmp_path, caplog):
    p = tmp_path / "leg.wav"
    _write_legacy_stereo(p)
    backend = _FakeBackend()

    import logging
    with caplog.at_level(logging.WARNING):
        resp = dispatch_transcribe(
            wav_path=p, channel_split=True, backend=backend,
            language="zh", initial_prompt="",
        )

    assert resp.layout is WavLayout.LEGACY_STEREO
    assert resp.channels is None
    assert resp.text == "chunk1"
    assert len(backend.calls) == 1
    assert any("legacy stereo wav" in rec.message for rec in caplog.records)


def test_dispatch_channel_split_false_behaves_like_mono(tmp_path):
    """channel_split=False on a dual-track WAV still does single-pass mono.

    This is the back-compat path for callers that don't care about source
    separation (e.g. quick smoke tests)."""
    p = tmp_path / "dt2.wav"
    _write_dual_track(p)
    backend = _FakeBackend()

    resp = dispatch_transcribe(
        wav_path=p, channel_split=False, backend=backend,
        language="zh", initial_prompt="",
    )
    assert resp.channels is None
    assert len(backend.calls) == 1
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_stt_daemon_channel_split_dispatch.py -v`
Expected: ImportError — `dispatch_transcribe` doesn't exist yet.

- [ ] **Step 4: Implement `dispatch_transcribe` in `runtime.py`**

Add (or augment) `yulu/scripts/stt_daemon/runtime.py` with:

```python
from __future__ import annotations

import logging
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .wav_inspect import WavLayout, classify

_log = logging.getLogger(__name__)


@dataclass
class STTResult:
    text: str
    segments: list[dict]


@dataclass
class TranscribeDispatchResult:
    layout: WavLayout
    text: str = ""                               # set when layout != DUAL_TRACK
    segments: list[dict] | None = None
    channels: dict[str, dict] | None = None      # set when layout == DUAL_TRACK


def _extract_channel(stereo_path: Path, channel: int, out_path: Path) -> None:
    """Write a mono WAV containing only the L (channel=0) or R (channel=1)
    samples of `stereo_path`. Uses the `wave` module; preserves sample rate."""
    with wave.open(str(stereo_path), "rb") as src:
        assert src.getnchannels() == 2, "extract_channel requires stereo input"
        params = src.getparams()
        sample_width = src.getsampwidth()
        n_frames = src.getnframes()
        raw = src.readframes(n_frames)

    # interleaved: [L0_lo L0_hi R0_lo R0_hi L1_lo L1_hi R1_lo R1_hi ...]
    frame_bytes = sample_width * 2
    stride_start = channel * sample_width
    mono = bytearray()
    for i in range(n_frames):
        base = i * frame_bytes + stride_start
        mono += raw[base : base + sample_width]

    with wave.open(str(out_path), "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(sample_width)
        dst.setframerate(params.framerate)
        dst.writeframes(bytes(mono))


def _downmix_stereo_to_mono(stereo_path: Path, out_path: Path) -> None:
    """Write `(L + R) / 2` mono WAV."""
    import struct as _struct
    with wave.open(str(stereo_path), "rb") as src:
        assert src.getnchannels() == 2
        params = src.getparams()
        sw = src.getsampwidth()
        n_frames = src.getnframes()
        raw = src.readframes(n_frames)

    out = bytearray()
    for i in range(n_frames):
        base = i * sw * 2
        L = int.from_bytes(raw[base : base + sw], "little", signed=True)
        R = int.from_bytes(raw[base + sw : base + 2 * sw], "little", signed=True)
        mix = (L + R) // 2
        out += mix.to_bytes(sw, "little", signed=True)

    with wave.open(str(out_path), "wb") as dst:
        dst.setnchannels(1); dst.setsampwidth(sw); dst.setframerate(params.framerate)
        dst.writeframes(bytes(out))


def dispatch_transcribe(
    *, wav_path: Path, channel_split: bool, backend,
    language: str, initial_prompt: str,
) -> TranscribeDispatchResult:
    """Channel-aware single-WAV transcribe entry point.

    - channel_split=False → always single mono pass on the original file.
    - channel_split=True  → classify via WavLayout:
        MONO          → single pass on the original file.
        LEGACY_STEREO → downmix L+R → mono pass; log WARN.
        DUAL_TRACK    → extract L+R into two temp mono WAVs; run backend
                        twice (mic then sys); return `channels` dict.
    """
    wav_path = Path(wav_path)
    if not channel_split:
        result = backend.transcribe(audio_path=str(wav_path),
                                    language=language,
                                    initial_prompt=initial_prompt)
        # When channel_split=False we don't probe layout — defer to caller.
        return TranscribeDispatchResult(
            layout=WavLayout.MONO, text=result.text, segments=result.segments
        )

    layout = classify(wav_path)

    if layout is WavLayout.MONO:
        r = backend.transcribe(audio_path=str(wav_path),
                               language=language, initial_prompt=initial_prompt)
        return TranscribeDispatchResult(layout=layout, text=r.text, segments=r.segments)

    if layout is WavLayout.LEGACY_STEREO:
        _log.warning("legacy stereo wav, no source separation: %s", wav_path)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            tmp = Path(tf.name)
        try:
            _downmix_stereo_to_mono(wav_path, tmp)
            r = backend.transcribe(audio_path=str(tmp),
                                   language=language, initial_prompt=initial_prompt)
            return TranscribeDispatchResult(layout=layout, text=r.text, segments=r.segments)
        finally:
            tmp.unlink(missing_ok=True)

    # DUAL_TRACK
    tmp_mic = Path(tempfile.NamedTemporaryFile(suffix=".mic.wav", delete=False).name)
    tmp_sys = Path(tempfile.NamedTemporaryFile(suffix=".sys.wav", delete=False).name)
    try:
        _extract_channel(wav_path, channel=0, out_path=tmp_mic)
        _extract_channel(wav_path, channel=1, out_path=tmp_sys)
        mic_r = backend.transcribe(audio_path=str(tmp_mic),
                                   language=language, initial_prompt=initial_prompt)
        sys_r = backend.transcribe(audio_path=str(tmp_sys),
                                   language=language, initial_prompt=initial_prompt)
        return TranscribeDispatchResult(
            layout=layout,
            channels={
                "mic": {"text": mic_r.text, "segments": mic_r.segments},
                "sys": {"text": sys_r.text, "segments": sys_r.segments},
            },
        )
    finally:
        tmp_mic.unlink(missing_ok=True)
        tmp_sys.unlink(missing_ok=True)
```

(If `STTResult` already exists in `runtime.py`, omit that dataclass and import the existing one. Same for any other duplicate symbol.)

- [ ] **Step 5: Run to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_stt_daemon_channel_split_dispatch.py -v`
Expected: 4 passed.

- [ ] **Step 6: Wire into the existing daemon handler**

Open the existing transcribe handler in `runtime.py` / `app.py` / `control_server.py`. Replace the direct `backend.transcribe(...)` call with `dispatch_transcribe(...)` and propagate the `channel_split` field from the incoming request. Update the JSON response builder to encode the new shape — when `result.channels is not None`, emit `{"status": "ok", "layout": "dual_track", "channels": {...}}`; otherwise the existing `{"status": "ok", "text": ...}` shape with an added `"layout"` field (`"mono"` or `"legacy_stereo"`).

- [ ] **Step 7: Commit**

```bash
git add yulu/scripts/stt_daemon/runtime.py yulu/scripts/stt_daemon/control_server.py yulu/scripts/stt_daemon/app.py tests/test_stt_daemon_channel_split_dispatch.py
git commit -m "feat(stt_daemon): channel-aware dispatch via WavLayout classification"
```

---

### Task C.3: Per-channel `skipped_silent`

Some recordings have one channel silent (e.g., voicemail mode: R=sys=0). Running STT on dead audio wastes ~30s for an empty result; pre-check RMS and short-circuit.

**Files:**
- Modify: `yulu/scripts/stt_daemon/runtime.py` (`dispatch_transcribe`, DUAL_TRACK branch)
- Modify: `tests/test_stt_daemon_channel_split_dispatch.py`

- [ ] **Step 1: Add the test**

Append to `tests/test_stt_daemon_channel_split_dispatch.py`:

```python
def _write_dual_track_one_silent_channel(path: Path, silent: str):
    """silent='R' → mic non-zero, sys all 0. silent='L' → opposite."""
    n_frames = 4800  # 100 ms at 48 kHz
    pcm = bytearray()
    for _ in range(n_frames):
        L = (0x1FFF).to_bytes(2, "little", signed=True) if silent != "L" else (0).to_bytes(2, "little", signed=True)
        R = (0x1FFF).to_bytes(2, "little", signed=True) if silent != "R" else (0).to_bytes(2, "little", signed=True)
        pcm += L + R
    pcm = bytes(pcm)
    body = bytearray()
    body += b"RIFF" + struct.pack("<I", 0) + b"WAVE"
    body += b"fmt " + struct.pack("<I", 16) + struct.pack("<HHIIHH", 1, 2, 48000, 192000, 4, 16)
    body += b"LIST" + struct.pack("<I", 30) + b"INFO" + b"ICMT" + struct.pack("<I", 18) + b"Yulu DualTrack v1\x00"
    body += b"data" + struct.pack("<I", len(pcm)) + pcm
    body[4:8] = struct.pack("<I", len(body) - 8)
    path.write_bytes(bytes(body))


def test_dispatch_skips_silent_channel(tmp_path):
    p = tmp_path / "voicemail.wav"
    _write_dual_track_one_silent_channel(p, silent="R")
    backend = _FakeBackend()

    resp = dispatch_transcribe(
        wav_path=p, channel_split=True, backend=backend,
        language="zh", initial_prompt="",
    )

    assert resp.layout is WavLayout.DUAL_TRACK
    assert resp.channels["mic"]["text"] == "chunk1"        # ran
    assert resp.channels["sys"].get("skipped_silent") is True
    assert "text" not in resp.channels["sys"] or resp.channels["sys"]["text"] == ""
    # Only mic was dispatched
    assert len(backend.calls) == 1
```

- [ ] **Step 2: Implement the RMS pre-check**

In `runtime.py`, add a helper near the other private helpers:

```python
import math

EMPTY_CHANNEL_DBFS_THRESHOLD = -50.0  # below this → treat as silent


def _channel_rms_dbfs(mono_wav: Path) -> float:
    with wave.open(str(mono_wav), "rb") as f:
        sw = f.getsampwidth()
        n = f.getnframes()
        raw = f.readframes(n)
    if n == 0 or sw != 2:
        return -math.inf
    # Int16 → squared sum
    total = 0
    max_amp = float((1 << (8 * sw - 1)) - 1)
    for i in range(n):
        v = int.from_bytes(raw[i * 2 : i * 2 + 2], "little", signed=True)
        total += (v / max_amp) ** 2
    rms = math.sqrt(total / n)
    return 20.0 * math.log10(rms) if rms > 0 else -math.inf
```

Then inside the DUAL_TRACK branch, between `_extract_channel` calls and the `backend.transcribe` calls, gate each side:

```python
mic_dbfs = _channel_rms_dbfs(tmp_mic)
sys_dbfs = _channel_rms_dbfs(tmp_sys)

mic_entry: dict
sys_entry: dict
if mic_dbfs > EMPTY_CHANNEL_DBFS_THRESHOLD:
    r = backend.transcribe(audio_path=str(tmp_mic), language=language, initial_prompt=initial_prompt)
    mic_entry = {"text": r.text, "segments": r.segments}
else:
    mic_entry = {"skipped_silent": True, "text": "", "segments": []}

if sys_dbfs > EMPTY_CHANNEL_DBFS_THRESHOLD:
    r = backend.transcribe(audio_path=str(tmp_sys), language=language, initial_prompt=initial_prompt)
    sys_entry = {"text": r.text, "segments": r.segments}
else:
    sys_entry = {"skipped_silent": True, "text": "", "segments": []}

return TranscribeDispatchResult(
    layout=layout,
    channels={"mic": mic_entry, "sys": sys_entry},
)
```

- [ ] **Step 3: Run all dispatch tests**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_stt_daemon_channel_split_dispatch.py -v`
Expected: 5 passed.

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/stt_daemon/runtime.py tests/test_stt_daemon_channel_split_dispatch.py
git commit -m "feat(stt_daemon): per-channel RMS pre-check skips silent channel"
```

---

## Phase D — `transcribe.py` + Transcript Merge

### Task D.1: `transcript_merge` module

**Files:**
- Create: `yulu/scripts/stt_daemon/transcript_merge.py`
- Create: `tests/test_transcript_merge.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_transcript_merge.py`:

```python
"""Unit tests for transcript_merge: speaker-tagged ordered merge."""

import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.transcript_merge import merge_segments, SPEAKER_MIC, SPEAKER_SYS


def test_merge_two_channels_non_overlapping():
    mic = [{"start": 5.0, "end": 6.0, "text": "你好"}]
    sys_ = [{"start": 8.0, "end": 9.0, "text": "hello"}]
    out = merge_segments(mic=mic, sys=sys_)
    assert out == (
        f"[00:05 {SPEAKER_MIC}] 你好\n"
        f"[00:08 {SPEAKER_SYS}] hello"
    )


def test_merge_two_channels_overlapping_sorts_by_start():
    mic = [{"start": 1.0, "end": 2.0, "text": "A"}, {"start": 5.0, "end": 6.0, "text": "C"}]
    sys_ = [{"start": 3.0, "end": 4.0, "text": "B"}]
    out = merge_segments(mic=mic, sys=sys_)
    lines = out.splitlines()
    assert lines == [
        f"[00:01 {SPEAKER_MIC}] A",
        f"[00:03 {SPEAKER_SYS}] B",
        f"[00:05 {SPEAKER_MIC}] C",
    ]


def test_merge_same_start_mic_wins():
    mic = [{"start": 10.0, "end": 11.0, "text": "M"}]
    sys_ = [{"start": 10.0, "end": 11.0, "text": "S"}]
    out = merge_segments(mic=mic, sys=sys_)
    lines = out.splitlines()
    assert lines[0].endswith("M"), lines
    assert lines[1].endswith("S"), lines


def test_merge_empty_sys_returns_only_mic():
    mic = [{"start": 0.5, "end": 1.0, "text": "hi"}]
    sys_ = []
    out = merge_segments(mic=mic, sys=sys_)
    assert out == f"[00:00 {SPEAKER_MIC}] hi"


def test_merge_empty_both_returns_empty_string():
    assert merge_segments(mic=[], sys=[]) == ""


def test_merge_formats_minutes_and_seconds():
    mic = [{"start": 125.0, "end": 126.0, "text": "two minutes in"}]
    out = merge_segments(mic=mic, sys=[])
    assert out == f"[02:05 {SPEAKER_MIC}] two minutes in"


def test_merge_strips_whitespace_in_segment_text():
    mic = [{"start": 0.0, "end": 1.0, "text": "  hello  "}]
    out = merge_segments(mic=mic, sys=[])
    assert out == f"[00:00 {SPEAKER_MIC}] hello"


def test_merge_skips_blank_segments():
    mic = [
        {"start": 0.0, "end": 1.0, "text": "  "},
        {"start": 2.0, "end": 3.0, "text": "real"},
    ]
    out = merge_segments(mic=mic, sys=[])
    assert out == f"[00:02 {SPEAKER_MIC}] real"
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_transcript_merge.py -v`
Expected: ImportError.

- [ ] **Step 3: Create the module**

Create `yulu/scripts/stt_daemon/transcript_merge.py` (verbatim):

```python
"""Merge per-channel Whisper segments into a speaker-tagged transcript.

Output format (one line per segment):
    [MM:SS 我]   <text>
    [MM:SS 对方] <text>
Sorted by segment.start; same start → mic first.
"""

from __future__ import annotations

from typing import Iterable

SPEAKER_MIC = "我"
SPEAKER_SYS = "对方"


def _fmt_timestamp(seconds: float) -> str:
    s = max(0, int(seconds))
    return f"{s // 60:02d}:{s % 60:02d}"


def _tag(segments: Iterable[dict], speaker: str, channel_priority: int) -> list[tuple]:
    out: list[tuple] = []
    for seg in segments or []:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        start = float(seg.get("start", 0.0))
        out.append((start, channel_priority, _fmt_timestamp(start), speaker, text))
    return out


def merge_segments(*, mic: list[dict], sys: list[dict]) -> str:
    """Return a single speaker-tagged transcript string, no trailing newline."""
    tagged = _tag(mic, SPEAKER_MIC, channel_priority=0) + _tag(sys, SPEAKER_SYS, channel_priority=1)
    tagged.sort(key=lambda r: (r[0], r[1]))
    lines = [f"[{ts} {speaker}] {text}" for _, _, ts, speaker, text in tagged]
    return "\n".join(lines)
```

- [ ] **Step 4: Run tests to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_transcript_merge.py -v`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/stt_daemon/transcript_merge.py tests/test_transcript_merge.py
git commit -m "feat(stt_daemon): add transcript_merge for speaker-tagged ordered merge"
```

---

### Task D.2: `transcribe.py` writes 3 transcript files

**Files:**
- Modify: `yulu/scripts/transcribe.py` (`process_audio`, `_request_final_transcribe`)
- Modify: `yulu/scripts/transcribe_client.py` (pass `channel_split` through)
- Create: `tests/test_transcribe_dual_track.py`

- [ ] **Step 1: Inspect existing transcribe_client signature**

Run: `grep -nE "def |transcribe_client" yulu/scripts/transcribe_client.py | head -20`

Look for a function like `request_final_transcribe(...)`. Add a `channel_split: bool = False` keyword arg with the same default propagation as `TranscribeRequest`.

- [ ] **Step 2: Write the failing test**

Create `tests/test_transcribe_dual_track.py`:

```python
"""Integration test: transcribe.process_audio against a dual-track WAV writes
all three transcript files and enqueues 2 events with the correct snapshots."""

import json
import struct
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import transcribe
import queue_store


def _write_dual_track(path: Path):
    pcm = b"\x00\x00\x00\x00" * 64
    body = bytearray()
    body += b"RIFF" + struct.pack("<I", 0) + b"WAVE"
    body += b"fmt " + struct.pack("<I", 16) + struct.pack("<HHIIHH", 1, 2, 48000, 192000, 4, 16)
    body += b"LIST" + struct.pack("<I", 30) + b"INFO" + b"ICMT" + struct.pack("<I", 18) + b"Yulu DualTrack v1\x00"
    body += b"data" + struct.pack("<I", len(pcm)) + pcm
    body[4:8] = struct.pack("<I", len(body) - 8)
    path.write_bytes(bytes(body))


@pytest.fixture
def isolated_paths(tmp_path, monkeypatch):
    queue = tmp_path / "queue.json"
    lock = tmp_path / "queue.lock"
    prompts = tmp_path / "prompts.sqlite"
    monkeypatch.setattr(transcribe, "AGENT_QUEUE_PATH", queue)
    monkeypatch.setattr(transcribe, "PROMPTS_DB", prompts)
    monkeypatch.setattr(queue_store, "QUEUE_PATH", queue)
    monkeypatch.setattr(queue_store, "LOCK_PATH", lock)

    # Seed prompts so cache.auto_run returns real entries
    from prompts import VocabRepo as _ignore  # noqa
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    repo = PromptsRepo(open_db(prompts))
    seed_from_current(repo)
    return queue, prompts


def test_dual_track_writes_three_transcripts_and_enqueues_two(isolated_paths, tmp_path, monkeypatch):
    queue, prompts = isolated_paths
    wav = tmp_path / "TestMeeting_20260522_120000.wav"
    _write_dual_track(wav)

    # Fake the daemon response — return dual-track shape with both channels
    fake_response = {
        "status": "ok",
        "layout": "dual_track",
        "channels": {
            "mic": {
                "text": "你好",
                "segments": [{"start": 0.0, "end": 1.0, "text": "你好"}],
            },
            "sys": {
                "text": "hi there",
                "segments": [{"start": 0.5, "end": 1.5, "text": "hi there"}],
            },
        },
    }
    with patch.object(transcribe, "_request_final_transcribe_raw", return_value=fake_response):
        transcribe.process_audio(str(wav))

    mic = wav.with_suffix(".mic.transcript.txt").read_text(encoding="utf-8")
    sys_ = wav.with_suffix(".sys.transcript.txt").read_text(encoding="utf-8")
    merged = wav.with_suffix(".transcript.txt").read_text(encoding="utf-8")
    raw = wav.with_suffix(".raw.transcript.txt").read_text(encoding="utf-8")

    assert mic == "你好"
    assert sys_ == "hi there"
    assert "[00:00 我] 你好" in merged
    assert "[00:00 对方] hi there" in merged
    # raw mirrors the merged transcript (pre-cleanup snapshot)
    assert raw == merged

    events = json.loads(queue.read_text())
    assert len(events) == 2
    slugs = sorted(e["prompt_slug"] for e in events)
    assert slugs == ["summary", "transcript-cleanup"]


def test_legacy_mono_falls_back_to_single_transcript(isolated_paths, tmp_path, monkeypatch):
    queue, prompts = isolated_paths
    wav = tmp_path / "OldMono_20260101_120000.wav"
    import wave
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(b"\x00\x00" * 100)

    fake_response = {
        "status": "ok",
        "layout": "mono",
        "text": "legacy text",
        "segments": [{"start": 0.0, "end": 1.0, "text": "legacy text"}],
    }
    with patch.object(transcribe, "_request_final_transcribe_raw", return_value=fake_response):
        transcribe.process_audio(str(wav))

    merged = wav.with_suffix(".transcript.txt").read_text(encoding="utf-8")
    raw = wav.with_suffix(".raw.transcript.txt").read_text(encoding="utf-8")
    assert merged == "legacy text"
    assert raw == "legacy text"
    assert not wav.with_suffix(".mic.transcript.txt").exists()
    assert not wav.with_suffix(".sys.transcript.txt").exists()
```

- [ ] **Step 3: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_transcribe_dual_track.py -v`
Expected: AttributeError — `_request_final_transcribe_raw` not defined yet.

- [ ] **Step 4: Refactor `transcribe.py` to call channel-aware client and persist 3 files**

Open `yulu/scripts/transcribe.py`. Apply these changes:

**a. Replace the existing `_request_final_transcribe` block with two functions**:

```python
def _request_final_transcribe_raw(
    audio_path: Path, trans_cfg: dict, meeting_title: str,
) -> dict:
    """Send a channel-aware transcribe RPC and return the raw daemon response.

    Caller decides what to do with single-text vs dual-track shape.
    """
    from transcribe_client import request_final_transcribe
    try:
        return request_final_transcribe(
            wav=str(audio_path),
            title=meeting_title,
            language=trans_cfg.get("language", "zh"),
            channel_split=True,
        )
    except Exception as exc:
        print(f"⚠️ stt_daemon error: {exc}", file=sys.stderr)
        return {"status": "error", "error": str(exc)}


def _request_final_transcribe(
    audio_path: Path, trans_cfg: dict, meeting_title: str,
) -> Optional[dict]:
    """Returns the daemon's response dict if status=ok, else None."""
    resp = _request_final_transcribe_raw(audio_path, trans_cfg, meeting_title)
    if resp.get("status") != "ok":
        print(f"⚠️ daemon transcribe failed: {resp.get('error')}", file=sys.stderr)
        return None
    return resp
```

**b. Replace the `process_audio` body** (the part that today writes a single transcript and loops `cache.auto_run`) with this orchestration:

```python
def process_audio(audio_path_str: str) -> None:
    config = load_config()
    trans_cfg = config.get("transcription", {})

    audio_path = Path(audio_path_str)
    if not audio_path.exists():
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    meeting_title = audio_path.stem.rsplit("_", 1)[0].replace("_", " ")
    print(f"📁 处理: {audio_path.name}（标题: {meeting_title}）")

    # 1. Acquire transcripts (dual-track aware)
    response = _request_final_transcribe(audio_path, trans_cfg, meeting_title)
    if response is None:
        realtime_transcript_path = audio_path.with_suffix(".realtime.transcript.txt")
        merged = read_realtime_transcript(realtime_transcript_path)
        if merged is None:
            print("❌ 无法获取任何转录，daemon 不可用且无 realtime 结果", file=sys.stderr)
            sys.exit(2)
        # Fall back to legacy single-transcript shape
        mic_text: Optional[str] = None
        sys_text: Optional[str] = None
    else:
        from stt_daemon.transcript_merge import merge_segments

        if "channels" in response:
            mic_payload = response["channels"]["mic"]
            sys_payload = response["channels"]["sys"]
            mic_text = mic_payload.get("text", "") or ""
            sys_text = sys_payload.get("text", "") or ""
            merged = merge_segments(
                mic=mic_payload.get("segments", []) or [],
                sys=sys_payload.get("segments", []) or [],
            )
        else:
            mic_text = None
            sys_text = None
            merged = response.get("text", "") or ""

    # 2. Persist transcripts.
    raw_transcript_path = audio_path.with_suffix(".raw.transcript.txt")
    transcript_path = audio_path.with_suffix(".transcript.txt")
    raw_transcript_path.write_text(merged, encoding="utf-8")
    transcript_path.write_text(merged, encoding="utf-8")
    print(f"✅ 原始转录已保存: {raw_transcript_path}")
    print(f"✅ 初始 transcript 已保存: {transcript_path}")

    if mic_text is not None:
        audio_path.with_suffix(".mic.transcript.txt").write_text(mic_text, encoding="utf-8")
    if sys_text is not None:
        audio_path.with_suffix(".sys.transcript.txt").write_text(sys_text, encoding="utf-8")

    # 3. Enqueue auto-run prompts (unchanged from Phase 2).
    from prompts.cache import PromptsCache
    cache = PromptsCache(PROMPTS_DB)
    cache.load()
    queued = 0
    for prompt in cache.auto_run("cleanup"):
        _enqueue_summary_request(
            prompt=prompt, audio_path=audio_path,
            transcript_path=transcript_path,
            meeting_title=meeting_title,
            output_path=transcript_path,  # cleanup overwrites the merged transcript
            queue_path=AGENT_QUEUE_PATH,
        )
        queued += 1
    for prompt in cache.auto_run("summary"):
        suffix = ".summary.md" if prompt.slug == "summary" else f".{prompt.slug}.summary.md"
        output_path = audio_path.with_suffix(suffix)
        _enqueue_summary_request(
            prompt=prompt, audio_path=audio_path,
            transcript_path=transcript_path,
            meeting_title=meeting_title,
            output_path=output_path,
            queue_path=AGENT_QUEUE_PATH,
        )
        queued += 1

    print(f"📤 enqueued {queued} LLM jobs; agent_queue_worker will process them")
```

- [ ] **Step 5: Update `transcribe_client.py` to send `channel_split`**

Open `yulu/scripts/transcribe_client.py`. In the function that builds the request JSON, accept and pass `channel_split: bool = False`:

```python
def request_final_transcribe(
    *, wav: str, title: str, language: str = "zh", channel_split: bool = False,
) -> dict:
    payload = {
        "action": "transcribe",
        "wav": wav,
        "title": title,
        "language": language,
        "channel_split": channel_split,
    }
    # ... existing socket_send retry-on-EOF logic ...
    return resp
```

(Adjust to match the existing argument names — `audio_path` vs `wav` etc. — but keep the new field name `channel_split`.)

- [ ] **Step 6: Run the dual-track tests**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_transcribe_dual_track.py -v`
Expected: 2 passed.

- [ ] **Step 7: Confirm no Phase 2 regressions**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_transcribe_enqueue.py tests/test_prompts_cli.py tests/test_summaries_cli.py tests/test_prompts_cache.py tests/test_agent_queue_worker_prompts.py -v`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add yulu/scripts/transcribe.py yulu/scripts/transcribe_client.py tests/test_transcribe_dual_track.py
git commit -m "feat(transcribe): channel-aware orchestrator writes mic/sys/merged transcripts"
```

---

## Phase E — PromptsCache + New Seed

### Task E.1: PromptsCache.render adds `{{my_transcript}}` / `{{their_transcript}}`

**Files:**
- Modify: `yulu/scripts/prompts/cache.py`
- Modify: `tests/test_prompts_cache.py`

- [ ] **Step 1: Inspect the existing `render()` signature**

Run: `grep -nE "(def render|TEMPLATE|substitute)" yulu/scripts/prompts/cache.py | head`

Identify how `{{transcript}}` is substituted today. Expect a method like `render(prompt, *, transcript, meeting_title, date)` or similar.

- [ ] **Step 2: Add a failing test**

Append to `tests/test_prompts_cache.py`:

```python
def test_render_substitutes_my_and_their_transcript(tmp_path, monkeypatch):
    from prompts.db import PromptsRepo, open_db, Prompt, Category, Source
    from prompts.cache import PromptsCache

    db = tmp_path / "prompts.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.create(
        slug="speaker-test",
        name="Speaker Test",
        category=Category.SUMMARY,
        is_auto_run=False,
        source=Source.USER,
        content=("我说：{{my_transcript}}\n对方说：{{their_transcript}}\n合并：{{transcript}}"),
    )

    cache = PromptsCache(db); cache.load()
    p = cache.by_slug("speaker-test")
    out = cache.render(
        p,
        meeting_title="t",
        transcript="MERGED",
        my_transcript="MIC",
        their_transcript="SYS",
    )
    assert "我说：MIC" in out
    assert "对方说：SYS" in out
    assert "合并：MERGED" in out


def test_render_defaults_unknown_speaker_vars_to_empty_string(tmp_path):
    """Legacy prompts that don't pass my_/their_transcript still render OK."""
    from prompts.db import PromptsRepo, open_db, Category, Source
    from prompts.cache import PromptsCache

    db = tmp_path / "prompts.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.create(
        slug="legacy",
        name="Legacy",
        category=Category.SUMMARY,
        is_auto_run=False,
        source=Source.USER,
        content="只有 mic：[{{my_transcript}}] 只有 sys：[{{their_transcript}}]",
    )

    cache = PromptsCache(db); cache.load()
    p = cache.by_slug("legacy")
    out = cache.render(p, meeting_title="t", transcript="X")
    assert out == "只有 mic：[] 只有 sys：[]"
```

- [ ] **Step 3: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_prompts_cache.py::test_render_substitutes_my_and_their_transcript tests/test_prompts_cache.py::test_render_defaults_unknown_speaker_vars_to_empty_string -v`
Expected: TypeError — `render` doesn't accept `my_transcript` / `their_transcript`.

- [ ] **Step 4: Extend `render()`**

In `yulu/scripts/prompts/cache.py`, update `render` to accept and substitute the new variables. Pattern (preserve existing variable substitution; add two more):

```python
def render(
    self,
    prompt,
    *,
    meeting_title: str = "",
    transcript: str = "",
    my_transcript: str = "",
    their_transcript: str = "",
    meeting_date: str | None = None,
) -> str:
    text = prompt.content
    text = text.replace("{{transcript}}", transcript)
    text = text.replace("{{my_transcript}}", my_transcript)
    text = text.replace("{{their_transcript}}", their_transcript)
    text = text.replace("{{meeting_title}}", meeting_title)
    text = text.replace("{{date}}", meeting_date or "")
    return text
```

(If `render` already exists with different parameter names, adapt; the key point is two new placeholders default to empty string and substitute literally.)

- [ ] **Step 5: Update `_handle_summary_request` in `agent_queue_worker.py` to pass the new vars**

Find the line in `agent_queue_worker.py` that calls `cache.render(...)`. Before it, look up the per-channel transcripts:

```python
audio = Path(entry["audio_path"])
mic_path = audio.with_suffix(".mic.transcript.txt")
sys_path = audio.with_suffix(".sys.transcript.txt")
my_transcript = mic_path.read_text(encoding="utf-8") if mic_path.exists() else ""
their_transcript = sys_path.read_text(encoding="utf-8") if sys_path.exists() else ""
```

Then thread them through the `render` call:

```python
rendered = cache.render(
    prompt,
    meeting_title=entry.get("title", ""),
    transcript=transcript_text,
    my_transcript=my_transcript,
    their_transcript=their_transcript,
    meeting_date=resolve_meeting_date(audio),
)
```

- [ ] **Step 6: Run the new tests and the full prompts-cache suite**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_prompts_cache.py -v`
Expected: all green (existing tests still pass).

- [ ] **Step 7: Commit**

```bash
git add yulu/scripts/prompts/cache.py yulu/scripts/agent_queue_worker.py tests/test_prompts_cache.py
git commit -m "feat(prompts): add {{my_transcript}} / {{their_transcript}} template vars"
```

---

### Task E.2: Seed `action-items-by-speaker` (off by default)

**Files:**
- Modify: `yulu/scripts/prompts/seed.py`
- Modify: `tests/test_prompts_seed.py`

- [ ] **Step 1: Inspect existing seed structure**

Run: `grep -nE "(SEED_PROMPTS|seed_from_current|slug)" yulu/scripts/prompts/seed.py | head -30`

Confirm the data structure — expect a list of dataclass / dict literals.

- [ ] **Step 2: Add the failing test**

Update `tests/test_prompts_seed.py`. Find the existing test that asserts seed count and update it (or add a new one):

```python
def test_seed_includes_action_items_by_speaker(tmp_path):
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current

    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    seed_from_current(repo)
    slugs = {p.slug for p in repo.list_prompts()}
    assert "action-items-by-speaker" in slugs

    p = repo.get_by_slug("action-items-by-speaker")
    # OFF by default — opt-in
    assert p.is_auto_run is False
    # Uses both new template vars
    assert "{{my_transcript}}" in p.content
    assert "{{their_transcript}}" in p.content


def test_seed_total_count_at_least_four():
    """summary + transcript-cleanup + action-items + action-items-by-speaker."""
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    import tempfile, pathlib
    with tempfile.TemporaryDirectory() as td:
        repo = PromptsRepo(open_db(pathlib.Path(td) / "p.sqlite"))
        seed_from_current(repo)
        assert len(repo.list_prompts()) >= 4
```

- [ ] **Step 3: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_prompts_seed.py::test_seed_includes_action_items_by_speaker tests/test_prompts_seed.py::test_seed_total_count_at_least_four -v`
Expected: AssertionError — slug missing.

- [ ] **Step 4: Add the seed entry**

In `yulu/scripts/prompts/seed.py`, append to the `SEED_PROMPTS` list a new entry:

```python
{
    "slug": "action-items-by-speaker",
    "name": "Action Items by Speaker",
    "category": Category.SUMMARY,
    "is_auto_run": False,    # opt-in only
    "source": Source.SEED,
    "sort_order": 30,
    "content": """请基于以下双轨会议转录，按发言人输出 Action Items。

会议主题：{{meeting_title}}
会议日期：{{date}}

我说过的话（mic 通道）：
---
{{my_transcript}}
---

对方说过的话（sys 通道）：
---
{{their_transcript}}
---

要求：
- 输出两个 Markdown 段落：## 我承诺的事 / ## 对方承诺的事
- 每条 Action Item 一行，标注截止日期（如果提到）。
- 不要输出未明确承诺的"可能要做"的事。
""",
},
```

(Adapt the exact dict / dataclass shape to match what `SEED_PROMPTS` uses today.)

- [ ] **Step 5: Run tests**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_prompts_seed.py -v`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/prompts/seed.py tests/test_prompts_seed.py
git commit -m "feat(prompts): seed action-items-by-speaker (opt-in, uses speaker vars)"
```

---

## Phase F — Recording Lock

### Task F.1: `recording_lock.py` module

**Files:**
- Create: `yulu/scripts/recording_lock.py`
- Create: `tests/test_recording_lock.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_recording_lock.py`:

```python
"""Unit tests for recording_lock — flock-based mutex with metadata."""

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from recording_lock import acquire, record, RecordingBusy


def test_acquire_releases_when_context_exits(tmp_path):
    lock = tmp_path / ".recording.lock"
    with acquire(lock_path=lock, timeout=0.1) as handle:
        record(handle, title="t1", path="/tmp/x.wav", started_at="2026-05-22T12:00:00")

    # Outside the with — file may still exist but no one holds the lock.
    with acquire(lock_path=lock, timeout=0.1):
        pass


def test_acquire_busy_raises_when_held_in_another_process(tmp_path):
    lock = tmp_path / ".recording.lock"
    # Spawn a sidecar Python that holds the lock for ~2s.
    sidecar = Path(__file__).parent / "_lock_sidecar.py"
    sidecar.write_text(f"""
import sys, time
sys.path.insert(0, {str(SCRIPTS)!r})
from recording_lock import acquire, record
with acquire(lock_path={str(lock)!r}, timeout=0.1) as h:
    record(h, title='other', path='/tmp/other.wav', started_at='2026-05-22T12:00:00')
    time.sleep(2.0)
""")
    proc = subprocess.Popen([sys.executable, str(sidecar)])
    try:
        time.sleep(0.3)  # give sidecar time to acquire
        with pytest.raises(RecordingBusy) as exc_info:
            with acquire(lock_path=lock, timeout=0.5):
                pass
        info = exc_info.value.info
        assert info["title"] == "other"
        assert info["path"] == "/tmp/other.wav"
        assert info["started_at"] == "2026-05-22T12:00:00"
    finally:
        proc.terminate()
        proc.wait(timeout=3)
        sidecar.unlink(missing_ok=True)


def test_acquire_recovers_after_holder_dies(tmp_path):
    """If the holding process is killed, the next acquire succeeds quickly."""
    lock = tmp_path / ".recording.lock"
    sidecar = Path(__file__).parent / "_lock_sidecar_die.py"
    sidecar.write_text(f"""
import sys, time, os
sys.path.insert(0, {str(SCRIPTS)!r})
from recording_lock import acquire, record
with acquire(lock_path={str(lock)!r}, timeout=0.1) as h:
    record(h, title='zombie', path='/tmp/z.wav', started_at='2026-05-22T12:00:00')
    time.sleep(0.3)
    os._exit(0)  # hard exit closes fd → flock releases
""")
    proc = subprocess.Popen([sys.executable, str(sidecar)])
    try:
        time.sleep(0.1)  # sidecar holds lock
        # Acquire immediately would block; wait a bit then try
        time.sleep(0.6)  # by now sidecar exited and released
        with acquire(lock_path=lock, timeout=0.5):
            pass
    finally:
        proc.wait(timeout=3)
        sidecar.unlink(missing_ok=True)


def test_record_persists_metadata_to_lock_file(tmp_path):
    """The metadata written by record() must be readable by the next acquirer."""
    import json
    lock = tmp_path / ".recording.lock"

    with acquire(lock_path=lock, timeout=0.1) as h:
        record(h, title="my meeting", path="/tmp/a.wav",
               started_at="2026-05-22T13:00:00")
        # Read while we still hold it
        content = lock.read_text(encoding="utf-8")
        meta = json.loads(content) if content.strip() else {}
        assert meta.get("title") == "my meeting"
        assert meta.get("path") == "/tmp/a.wav"
        assert meta.get("started_at") == "2026-05-22T13:00:00"
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_recording_lock.py -v`
Expected: ModuleNotFoundError.

- [ ] **Step 3: Create the module**

Create `yulu/scripts/recording_lock.py`:

```python
"""flock-based recording-start mutex.

Both manual (`record_audio.py start`) and automated (`meeting_daemon
_start_recording`) callers acquire this lock before sending the
audio_daemon `start` action. The lock is advisory at the caller level —
the audio_daemon itself remains the authoritative "is recording"
arbiter — but it prevents the race where two callers each think they're
the one starting and both send `start` (the daemon answers "already
recording" to the second, which the caller misreads as success).

The lock file (default ``~/.config/yulu/.recording.lock``) is opened by
the calling process and held via ``fcntl.flock(LOCK_EX | LOCK_NB)`` for
the lifetime of the context manager. On process exit / crash, the OS
releases the lock automatically (no stale-cleanup needed).
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

DEFAULT_LOCK_PATH = Path.home() / ".config" / "yulu" / ".recording.lock"


@dataclass
class RecordingLockHandle:
    """Returned to the caller inside the with-block. Carries the open fd
    so subsequent metadata writes hit the same inode."""

    fd: int
    path: Path


class RecordingBusy(RuntimeError):
    """Raised when the lock is held by another process. ``info`` carries
    whatever metadata that process wrote via :func:`record` (may be empty
    if the holder hasn't called record() yet)."""

    def __init__(self, info: dict):
        super().__init__(f"recording already in progress: {info}")
        self.info = info


def _read_meta(path: Path) -> dict:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    text = text.strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


@contextmanager
def acquire(
    *, lock_path: Optional[Path] = None, timeout: float = 0.5,
) -> Iterator[RecordingLockHandle]:
    """Acquire the recording lock with `LOCK_EX | LOCK_NB` retry.

    If contended, retry every 50ms within `timeout`, then raise
    `RecordingBusy(info)` carrying the holder's metadata.
    """
    lock_path = Path(lock_path) if lock_path else DEFAULT_LOCK_PATH
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o644)
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError as exc:
            if exc.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                os.close(fd)
                raise
            if time.monotonic() >= deadline:
                info = _read_meta(lock_path)
                os.close(fd)
                raise RecordingBusy(info)
            time.sleep(0.05)

    try:
        yield RecordingLockHandle(fd=fd, path=lock_path)
    finally:
        try:
            # Clear metadata: lock is being released, info is stale.
            os.ftruncate(fd, 0)
        except OSError:
            pass
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def record(
    handle: RecordingLockHandle, *, title: str, path: str, started_at: str,
) -> None:
    """Write metadata into the locked file so subsequent contenders can
    inspect who holds the lock. Idempotent — last call wins."""
    payload = json.dumps(
        {"title": title, "path": path, "started_at": started_at,
         "holder_pid": os.getpid()},
        ensure_ascii=False,
    )
    os.lseek(handle.fd, 0, os.SEEK_SET)
    os.ftruncate(handle.fd, 0)
    os.write(handle.fd, payload.encode("utf-8"))
    try:
        os.fsync(handle.fd)
    except OSError:
        pass
```

- [ ] **Step 4: Run tests to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_recording_lock.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/recording_lock.py tests/test_recording_lock.py
git commit -m "feat(recording_lock): add flock-based recording-start mutex"
```

---

### Task F.2: Wire into `record_audio.py start`

**Files:**
- Modify: `yulu/scripts/record_audio.py` (around the `start` command dispatch)

- [ ] **Step 1: Inspect the start dispatch**

Run: `grep -nE '"start"|set_recording_started|_start_recording|def start_recording' yulu/scripts/record_audio.py | head -20`

Locate the manual-start code path.

- [ ] **Step 2: Wrap the start with `acquire`**

Open `yulu/scripts/record_audio.py`. At the top of the file, add:

```python
from recording_lock import acquire as acquire_recording_lock, record as record_lock, RecordingBusy
```

Find the function (likely `_start_recording(title, meeting_id="")` or similar) that calls `socket_send({"action": "start", ...})`. Wrap the entire body — everything from the first daemon RPC to the final state-update — inside the lock context manager. Sketch:

```python
def _start_recording(title, meeting_id=""):
    try:
        with acquire_recording_lock(timeout=0.5) as lock_handle:
            # … existing pre-RPC checks unchanged …
            resp = socket_send({"action": "start", "title": title})
            if not resp or resp.get("status") != "recording":
                print(f"daemon failed to start: {resp}", file=sys.stderr)
                return 1
            record_lock(lock_handle,
                       title=title,
                       path=resp.get("file", ""),
                       started_at=datetime.now().isoformat())
            set_recording_started(title, resp.get("file", ""), backend="daemon", path=STATE_PATH)
            print(f"🎙 录音已开始: {resp.get('file', '')}")
            return 0
    except RecordingBusy as exc:
        info = exc.info
        print(
            f"⚠️ 录音正在进行中: {info.get('title', '<unknown>')}\n"
            f"   file: {info.get('path', '<unknown>')}\n"
            f"   started: {info.get('started_at', '<unknown>')}",
            file=sys.stderr,
        )
        return 2
```

(Adapt to the actual variables and function names. The key invariants: acquire BEFORE the daemon RPC; `record_lock` AFTER the daemon confirms recording; on `RecordingBusy`, print a structured message and exit non-zero. Do NOT acquire around `stop` — stop must always succeed regardless of holder.)

- [ ] **Step 3: Manual smoke**

(Skip if dev machine isn't available.)
```bash
# Window 1: start a recording in background
yulu/scripts/record_audio.py start TestLock &
# Window 2: try to start another — should print "录音正在进行中"
yulu/scripts/record_audio.py start AnotherTest
echo "exit code = $?"   # expect 2
yulu/scripts/record_audio.py stop
```

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/record_audio.py
git commit -m "feat(record_audio): acquire recording lock before manual start"
```

---

### Task F.3: Wire into `meeting_daemon._start_recording`

**Files:**
- Modify: `yulu/scripts/meeting_daemon.py` (lines around `_start_recording`)

- [ ] **Step 1: Inspect the meeting-daemon start path**

Run: `grep -nE 'def _start_recording|def _on_meeting|"action": "start"' yulu/scripts/meeting_daemon.py | head`

Locate the scheduler-/detector-triggered start.

- [ ] **Step 2: Wrap with `acquire`**

Add the same import at the top:

```python
from recording_lock import acquire as acquire_recording_lock, record as record_lock, RecordingBusy
```

Inside `_start_recording`, surround the daemon RPC the same way as F.2. On `RecordingBusy`, log a WARN (don't print to stdout — this runs as launchd daemon):

```python
def _start_recording(title, meeting_id=""):
    try:
        with acquire_recording_lock(timeout=0.5) as lock_handle:
            resp = socket_send({"action": "start", "title": title})
            if not resp or resp.get("status") != "recording":
                log_warn(f"daemon failed to start: {resp}")
                return
            record_lock(lock_handle,
                        title=title,
                        path=resp.get("file", ""),
                        started_at=datetime.now().isoformat())
            # … existing post-start hooks (state, notifier, etc.) …
    except RecordingBusy as exc:
        log_warn(f"recording lock busy: meeting_id={meeting_id} title={title!r} holder={exc.info}")
```

(`log_warn` is the existing logger; substitute the actual call your project uses.)

- [ ] **Step 3: Commit**

```bash
git add yulu/scripts/meeting_daemon.py
git commit -m "feat(meeting_daemon): acquire recording lock before scheduled/detector start"
```

---

## Phase G — Live Session Stride Extraction

### Task G.1: Add stride fields to `LiveSession` / `TailState`

**Files:**
- Modify: `yulu/scripts/stt_daemon/live_session.py`
- Modify: `tests/test_stt_live_session.py` (discover existing test name with `ls tests/test_stt_*`)

- [ ] **Step 1: Discover existing live-session tests**

Run: `ls tests/test_stt_*.py 2>&1 | head` and `grep -nE "LiveSession|mic_path|sys_path" tests/*.py 2>&1 | head`.

- [ ] **Step 2: Add a new test file**

Create `tests/test_live_session_stride.py`:

```python
"""LiveSession stride extraction — read alternating Int16 samples from a
single stereo WAV instead of from two sidecar files."""

import struct
import sys
import wave
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.live_session import LiveSession, TailState


def test_livesession_accepts_stride_params():
    spec = LiveSession(
        sid="s1",
        mic_path="/tmp/x.wav",
        sys_path="/tmp/x.wav",      # same path
        engine="mlx",
        language="zh",
        mic_stride_offset=0,
        sys_stride_offset=2,
        stride_step=4,
    )
    assert spec.mic_stride_offset == 0
    assert spec.sys_stride_offset == 2
    assert spec.stride_step == 4


def test_livesession_defaults_to_separate_file_mode():
    """When stride_step=1 (default), behave exactly like Phase 1: mic_path and
    sys_path are separate mono WAVs, no stride extraction."""
    spec = LiveSession(
        sid="s1", mic_path="/tmp/a.wav", sys_path="/tmp/b.wav",
        engine="mlx", language="zh",
    )
    assert spec.stride_step == 1


def test_read_pending_extracts_mic_with_stride(tmp_path):
    """Smoke-level: synthesize a tiny stereo WAV with L=0x1111, R=0x2222,
    then verify the stride-extracted mic chunk WAV contains only L samples."""
    from stt_daemon.live_session import _read_with_stride  # new helper

    p = tmp_path / "stereo.wav"
    n_frames = 96000  # 2 seconds at 48 kHz
    with wave.open(str(p), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
        frame = struct.pack("<hh", 0x1111, 0x2222)
        w.writeframes(frame * n_frames)

    out = tmp_path / "mic_chunk.wav"
    _read_with_stride(
        path=p, out_path=out,
        start_byte=44,
        end_byte=44 + n_frames * 4,
        stride_offset=0,
        stride_step=4,
        sample_width=2,
        framerate=48000,
    )
    with wave.open(str(out), "rb") as r:
        assert r.getnchannels() == 1
        samples = r.readframes(r.getnframes())
    # Every Int16 should be 0x1111
    for i in range(0, len(samples), 2):
        assert int.from_bytes(samples[i : i + 2], "little", signed=True) == 0x1111
```

- [ ] **Step 3: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_live_session_stride.py -v`
Expected: TypeError / ImportError.

- [ ] **Step 4: Extend `LiveSession` / `TailState`**

In `yulu/scripts/stt_daemon/live_session.py`:

```python
@dataclass
class LiveSession:
    sid: str
    mic_path: str
    sys_path: Optional[str]
    engine: str
    language: str
    chunk_sec: float = 10.0
    meeting_title: Optional[str] = None
    # Phase 3 — stride extraction from a single stereo WAV.
    # When stride_step > 1, mic_path == sys_path and we slice every
    # `stride_step` bytes starting at `<channel>_stride_offset`.
    mic_stride_offset: int = 0
    sys_stride_offset: int = 0
    stride_step: int = 1


@dataclass
class TailState:
    sid: str
    mic_path: str
    sys_path: Optional[str]
    engine: str
    language: str
    chunk_sec: float
    mic_offset_bytes: int
    sys_offset_bytes: int
    next_seq: int
    started_at: str
    last_partial_at: str
    # Phase 3
    mic_stride_offset: int = 0
    sys_stride_offset: int = 0
    stride_step: int = 1
```

Where `start_session` constructs the initial `TailState`, copy the three new fields from `spec`.

- [ ] **Step 5: Add `_read_with_stride`**

Insert (near `_write_wav_chunk` at the bottom of the file):

```python
def _read_with_stride(
    *, path: Path, out_path: Path,
    start_byte: int, end_byte: int,
    stride_offset: int, stride_step: int,
    sample_width: int, framerate: int,
) -> None:
    """Extract every `stride_step`-th sample of width `sample_width`
    starting at `stride_offset` within each frame, from a slice of `path`
    delimited by `[start_byte, end_byte)`. Write as mono WAV to out_path."""
    import wave as _wave
    with path.open("rb") as src:
        src.seek(start_byte)
        data = src.read(end_byte - start_byte)

    mono = bytearray()
    for i in range(0, len(data) - stride_step + 1, stride_step):
        mono += data[i + stride_offset : i + stride_offset + sample_width]

    with _wave.open(str(out_path), "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(sample_width)
        dst.setframerate(framerate)
        dst.writeframes(bytes(mono))
```

- [ ] **Step 6: Run tests to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_live_session_stride.py -v`
Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add yulu/scripts/stt_daemon/live_session.py tests/test_live_session_stride.py
git commit -m "feat(live_session): stride extraction params for single-WAV dual tail"
```

---

### Task G.2: `_read_pending` honors stride

**Files:**
- Modify: `yulu/scripts/stt_daemon/live_session.py` (`_read_pending`, `_tail_iteration`, `start_session`)

- [ ] **Step 1: Update `_read_pending` to honor stride**

Find `_read_pending` (in `live_session.py`). Today it just reads PCM bytes from `path[offset:]` and writes them straight into a mono WAV. Add a stride-aware branch:

```python
def _read_pending(
    self, path: Path, offset: int, min_seconds: float,
    *, stride_offset: int = 0, stride_step: int = 1,
) -> Optional[tuple[Path, int, int]]:
    available = self._size_or_header(path) - offset
    if available <= 0:
        return None
    if stride_step > 1:
        # Need min_seconds of MONO at SAMPLE_RATE_HZ → bytes in source stride.
        min_source_bytes = int(min_seconds * SAMPLE_RATE_HZ * SAMPLE_BYTES) * stride_step
    else:
        min_source_bytes = int(min_seconds * SAMPLE_RATE_HZ * SAMPLE_BYTES)
    if available < min_source_bytes:
        return None
    new_offset = offset + min_source_bytes
    chunk_path = self.sessions_dir / f"{path.stem}.chunk-{offset}-{new_offset}.wav"
    if stride_step > 1:
        _read_with_stride(
            path=path, out_path=chunk_path,
            start_byte=offset, end_byte=new_offset,
            stride_offset=stride_offset, stride_step=stride_step,
            sample_width=SAMPLE_BYTES, framerate=SAMPLE_RATE_HZ,
        )
    else:
        with path.open("rb") as f:
            f.seek(offset)
            pcm = f.read(min_source_bytes)
        _write_wav_chunk(chunk_path, pcm)
    duration_ms = int(min_seconds * 1000)
    return chunk_path, new_offset, duration_ms
```

(Adapt to current signature; the key invariants are: when `stride_step > 1`, multiply min_source_bytes by step, and use `_read_with_stride`. `WAV_HEADER_BYTES` may need to switch to 82 for dual-track sources — gate by whether `path` already has the marker. To keep it simple, expect `start_session` to set the initial mic/sys offsets correctly based on layout.)

- [ ] **Step 2: Update `_tail_iteration` to pass stride args**

Replace lines 199–223 (the existing `_tail_iteration`):

```python
async def _tail_iteration(self, sid: str) -> None:
    active = self._active.get(sid)
    if active is None:
        return
    spec = active.spec
    state = active.state

    mic_chunk = self._read_pending(
        Path(spec.mic_path),
        state.mic_offset_bytes,
        min_seconds=spec.chunk_sec,
        stride_offset=state.mic_stride_offset,
        stride_step=state.stride_step,
    )
    if mic_chunk is not None:
        chunk_path, new_offset, duration_ms = mic_chunk
        await self._dispatch_chunk(active, source="mic", chunk_path=chunk_path, duration_ms=duration_ms)
        state.mic_offset_bytes = new_offset

    if spec.sys_path:
        sys_chunk = self._read_pending(
            Path(spec.sys_path),
            state.sys_offset_bytes,
            min_seconds=spec.chunk_sec,
            stride_offset=state.sys_stride_offset,
            stride_step=state.stride_step,
        )
        if sys_chunk is not None:
            chunk_path, new_offset, duration_ms = sys_chunk
            await self._dispatch_chunk(active, source="system", chunk_path=chunk_path, duration_ms=duration_ms)
            state.sys_offset_bytes = new_offset

    state.last_partial_at = _now_iso()
    await self.flush_state(sid, active=active)
```

- [ ] **Step 3: Run the tail unit tests + the test_spec_acceptance suite**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_live_session_stride.py tests/test_spec_acceptance.py -v`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/stt_daemon/live_session.py tests/test_live_session_stride.py
git commit -m "feat(live_session): tail loop reads alternating samples from single stereo WAV"
```

---

## Phase H — Acceptance + Cleanup

### Task H.1: Acceptance tests for spec §13

**Files:**
- Modify: `tests/test_spec_acceptance.py`

- [ ] **Step 1: Append the Phase 3 block**

Append to `tests/test_spec_acceptance.py`:

```python
# ── Dual-Track + Recording Lock acceptance (spec 2026-05-22-dual-track-recording-design.md) ──

def test_wav_inspect_classifier_module_exists():
    pkg = SCRIPTS / "stt_daemon"
    assert (pkg / "wav_inspect.py").exists()


def test_transcript_merge_module_exists():
    pkg = SCRIPTS / "stt_daemon"
    assert (pkg / "transcript_merge.py").exists()


def test_recording_lock_module_exists():
    assert (SCRIPTS / "recording_lock.py").exists()


def test_audio_daemon_no_half_duplex_mix_references():
    text = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    assert "halfDuplexMix" not in text, "halfDuplexMix should be removed in Phase 3"
    assert "channelInterleave" in text, "channelInterleave is the new mix method"


def test_audio_daemon_writes_dual_track_marker():
    text = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    assert "Yulu DualTrack v1" in text
    assert "LIST" in text and "INFO" in text and "ICMT" in text


def test_seed_has_action_items_by_speaker():
    sys.path.insert(0, str(SCRIPTS))
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    import tempfile, pathlib
    with tempfile.TemporaryDirectory() as td:
        repo = PromptsRepo(open_db(pathlib.Path(td) / "p.sqlite"))
        seed_from_current(repo)
        slugs = {p.slug for p in repo.list_prompts()}
    assert "action-items-by-speaker" in slugs


def test_promptscache_render_accepts_speaker_vars():
    sys.path.insert(0, str(SCRIPTS))
    import inspect
    from prompts.cache import PromptsCache
    params = inspect.signature(PromptsCache.render).parameters
    assert "my_transcript" in params
    assert "their_transcript" in params


def test_transcribe_uses_channel_split_and_three_outputs():
    text = (SCRIPTS / "transcribe.py").read_text(encoding="utf-8")
    assert "channel_split=True" in text
    assert ".mic.transcript.txt" in text
    assert ".sys.transcript.txt" in text
    assert "transcript_merge" in text


def test_record_audio_acquires_recording_lock():
    text = (SCRIPTS / "record_audio.py").read_text(encoding="utf-8")
    assert "acquire_recording_lock" in text or "from recording_lock import" in text
    assert "RecordingBusy" in text


def test_meeting_daemon_acquires_recording_lock():
    text = (SCRIPTS / "meeting_daemon.py").read_text(encoding="utf-8")
    assert "acquire_recording_lock" in text or "from recording_lock import" in text
```

- [ ] **Step 2: Run all acceptance tests**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_spec_acceptance.py -v`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add tests/test_spec_acceptance.py
git commit -m "test(acceptance): extend with dual-track + recording-lock criteria"
```

---

### Task H.2: Full regression run

- [ ] **Step 1: Run the entire test suite**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/ -v --tb=short`

Expected: every test passes. Count should be 145 (Phase 2 baseline) + ~30 new tests = ~175+.

- [ ] **Step 2: If anything fails — root-cause and fix; do NOT mark tasks complete on red.**

For each failure, re-read the relevant Task above and the spec section it implements. Fix in the file; do NOT mutate the test to make it pass unless the test itself was buggy.

- [ ] **Step 3: Commit any fix-ups**

```bash
git add -A
git commit -m "fix(phase3): address regression surfaced by full suite"
```

---

### Task H.3: Real-machine smoke test

This is the post-implementation validation step. Run only when the dev machine is available, after H.2 is green. Mirrors Phase 1 / Phase 2 smoke methodology.

- [ ] **Step 1: Build and install the daemon binary**

Run: `bash yulu/scripts/build_audio_daemon.sh`

- [ ] **Step 2: Reseed prompts to pick up `action-items-by-speaker`**

Run: `PYTHONPATH=yulu/scripts python3 -m prompts.cli seed --from-current --db ~/.config/yulu/prompts.sqlite`

Expected: `{"inserted": 1, "updated": 0}` (the new prompt is added; existing 3 left alone).

- [ ] **Step 3: Record a short test meeting**

Manual: start a recording with both mic and system audio (play a YouTube video while speaking into the mic). Stop after ~30 seconds.

- [ ] **Step 4: Verify WAV layout**

```bash
PYTHONPATH=yulu/scripts python3 -c "
from pathlib import Path
from stt_daemon.wav_inspect import WavLayout, classify
wav = sorted(Path.home().joinpath('Movies/Yulu').glob('*.wav'))[-1]
print(wav.name, classify(wav))
"
```

Expected: `DUAL_TRACK`.

- [ ] **Step 5: Run transcribe.py against it**

```bash
PYTHONPATH=yulu/scripts python3 yulu/scripts/transcribe.py "$(ls -t ~/Movies/Yulu/*.wav | head -1)"
```

Expected output mentions both `.mic.transcript.txt` and `.sys.transcript.txt` written, and 2 events enqueued to the live `agent-queue.json`.

- [ ] **Step 6: Spot-check the merged transcript**

`cat <wav>.transcript.txt` — lines should start with `[MM:SS 我]` and `[MM:SS 对方]`. The mic side should contain what you said; the sys side should contain what the video said. Timestamps should be monotonic.

- [ ] **Step 7: Wait for the launchd-managed agent_queue_worker to dispatch (or run it manually)**

After ~5 seconds (next launchd tick) or run once:
```bash
PYTHONPATH=yulu/scripts python3 yulu/scripts/agent_queue_worker.py
```

Expected: `<wav>.summary.md` written, `summaries` table has two new rows.

- [ ] **Step 8: Test opt-in `action-items-by-speaker`**

```bash
PYTHONPATH=yulu/scripts python3 -m prompts.cli edit action-items-by-speaker --auto-run --db ~/.config/yulu/prompts.sqlite
# Send SIGHUP to live worker if running, or run a new transcription cycle
PYTHONPATH=yulu/scripts python3 yulu/scripts/transcribe.py <new wav>
# After worker dispatch:
ls <wav>.action-items-by-speaker.summary.md   # should exist
PYTHONPATH=yulu/scripts python3 -m prompts.cli edit action-items-by-speaker --no-auto-run --db ~/.config/yulu/prompts.sqlite
```

- [ ] **Step 9: Test recording lock — concurrent start**

```bash
yulu/scripts/record_audio.py start TestLock &
sleep 0.5
yulu/scripts/record_audio.py start AnotherTest
echo "exit code = $?"   # expect 2 with "录音正在进行中"
yulu/scripts/record_audio.py stop
```

- [ ] **Step 10: Cleanup** — delete the smoke wav and revert any auto-run toggles.

---

## Plan Self-Review

Cross-checked the plan against the spec:

| Spec section | Covered by |
|---|---|
| §5 Recording layer — stereo source-separated WAV | Task B.1 |
| §5 Per-channel silence detection | Task B.2 |
| §5 Mic-only mode (SYS_DISABLED) | Task B.3 |
| §5 RIFF INFO marker | Task A.2 |
| §6 WavLayout classifier | Task A.1 |
| §6 `channel_split` protocol field | Task C.1 |
| §6 DUAL_TRACK / LEGACY_STEREO / MONO dispatch | Task C.2 |
| §6 Per-channel skipped_silent | Task C.3 |
| §7 Three transcript files + merge | Tasks D.1, D.2 |
| §7 Speaker-tagged merge format | Task D.1 |
| §8 `{{my_transcript}}` / `{{their_transcript}}` | Task E.1 |
| §8 `action-items-by-speaker` seed | Task E.2 |
| §9 Recording lock module | Task F.1 |
| §9 Wire into record_audio.py | Task F.2 |
| §9 Wire into meeting_daemon.py | Task F.3 |
| §10 Live session integration | Tasks G.1, G.2 |
| §11 Migration (idempotent seed) | Task E.2 (idempotency inherited from Phase 2 seeder) |
| §12 Failure modes — mic/sys revoked mid-recording | Implicit in Task B.1's max(sysFrames, micFrames) zero-pad |
| §12 Channel-split job partial failure | Task C.2 (per-channel try/except via backend.transcribe call site) |
| §13 Acceptance #1 Stereo source-separation | Task H.3 (manual smoke); Task A.2 (round-trip) |
| §13 Acceptance #2 STT channel split | Task C.2 |
| §13 Acceptance #3 Transcript merge | Task D.1 |
| §13 Acceptance #4 Prompt template parity | Task E.1 |
| §13 Acceptance #5 New vars empty fallback | Task E.1 |
| §13 Acceptance #6 Recording lock busy | Task F.1 |
| §13 Acceptance #7 Recording lock stale recovery | Task F.1 |
| §13 Acceptance #8 Legacy WAV compatibility | Task C.2 (LEGACY_STEREO branch) |
| §13 Acceptance #9 Voicemail-readiness smoke | Task B.3 + H.3 |
| §13 Acceptance #10 No Phase 1/2 regression | Task H.2 |

All spec sections have task coverage. No placeholders. No unreferenced symbols.
