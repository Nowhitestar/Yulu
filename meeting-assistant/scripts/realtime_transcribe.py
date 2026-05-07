#!/usr/bin/env python3
"""Realtime-ish transcription for Meeting Assistant.

Watches the growing 16-bit stereo 48k WAV written by AudioDaemon, cuts stable PCM
into small WAV chunks, transcribes chunks with whisper-cli, and appends a rolling
transcript next to the recording:

  <meeting>.realtime.transcript.txt
  <meeting>.realtime/chunk_000001.wav/.txt

This is intentionally chunk-based, not true streaming ASR: it is much more robust
when the recorder crashes because each completed chunk has already been written
and transcribed independently.
"""

import json
import os
import shlex
import signal
import struct
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "meeting-assistant"
CONFIG_PATH = CONFIG_DIR / "config.json"
STATE_PATH = CONFIG_DIR / ".state.json"
QUEUE_PATH = CONFIG_DIR / "agent-queue.json"

SAMPLE_RATE = 48000
CHANNELS = 2
BITS = 16
BYTES_PER_SEC = SAMPLE_RATE * CHANNELS * (BITS // 8)
HEADER_BYTES = 44

DEFAULT_CMD = [
    "whisper-cli",
    "-m", str(Path.home() / "Models/whisper/ggml-medium.bin"),
    "-l", "zh",
    "-otxt",
    "-of", "{{output_stem}}",
    "{{input}}",
]

stop_requested = False


def on_signal(_sig, _frame):
    global stop_requested
    stop_requested = True


signal.signal(signal.SIGTERM, on_signal)
signal.signal(signal.SIGINT, on_signal)


def load_config():
    try:
        cfg = json.loads(CONFIG_PATH.read_text())
    except Exception:
        cfg = {}
    trans = cfg.get("transcription", {})
    realtime = trans.get("realtime", {})
    return {
        "command": trans.get("command") or DEFAULT_CMD,
        "chunk_sec": int(os.environ.get("MEETING_ASSISTANT_RT_CHUNK_SEC") or realtime.get("chunk_sec", 60)),
        "poll_sec": float(realtime.get("poll_sec", 2)),
        "min_final_sec": int(realtime.get("min_final_sec", 8)),
    }


def render_cmd(template, **vars):
    out = []
    for tok in template:
        for k, v in vars.items():
            tok = tok.replace(f"{{{{{k}}}}}", str(v))
        out.append(tok)
    return out


def wav_header(data_size):
    byte_rate = SAMPLE_RATE * CHANNELS * BITS // 8
    block_align = CHANNELS * BITS // 8
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", data_size + 36, b"WAVE", b"fmt ", 16,
        1, CHANNELS, SAMPLE_RATE, byte_rate, block_align, BITS,
        b"data", data_size,
    )


def write_chunk(path, pcm):
    path.write_bytes(wav_header(len(pcm)) + pcm)


def read_state():
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return {}


def notify(event_type, **kwargs):
    entry = {"type": event_type, "ts": datetime.now().isoformat(), **kwargs}
    try:
        queue = json.loads(QUEUE_PATH.read_text()) if QUEUE_PATH.exists() else []
        if not isinstance(queue, list):
            queue = []
    except Exception:
        queue = []
    queue.append(entry)
    QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
    QUEUE_PATH.write_text(json.dumps(queue, indent=2, ensure_ascii=False))


def transcribe_chunk(chunk_path, cmd_template):
    stem = chunk_path.with_suffix("").as_posix() + ".whisper"
    txt = Path(stem + ".txt")
    cmd = render_cmd(cmd_template, input=chunk_path, output_stem=stem)
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] whisper chunk: {shlex.join(map(str, cmd))}", flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"whisper failed: {result.returncode}")
    if not txt.exists():
        raise RuntimeError(f"missing whisper output: {txt}")
    text = txt.read_text(encoding="utf-8").strip()
    txt.unlink(missing_ok=True)
    return text


def append_transcript(transcript_path, index, start_sec, end_sec, text):
    if not text.strip():
        return
    line = f"[{start_sec//60:02d}:{start_sec%60:02d}-{end_sec//60:02d}:{end_sec%60:02d}] {text.strip()}\n"
    with transcript_path.open("a", encoding="utf-8") as f:
        f.write(line)


def main():
    if len(sys.argv) < 2:
        print("Usage: realtime_transcribe.py <audio.wav> [title]", file=sys.stderr)
        sys.exit(2)

    audio_path = Path(sys.argv[1]).expanduser().resolve()
    title = sys.argv[2] if len(sys.argv) > 2 else audio_path.stem.rsplit("_", 1)[0]
    cfg = load_config()
    chunk_bytes = max(5, cfg["chunk_sec"]) * BYTES_PER_SEC
    min_final_bytes = max(1, cfg["min_final_sec"]) * BYTES_PER_SEC

    chunk_dir = audio_path.with_suffix(".realtime")
    chunk_dir.mkdir(parents=True, exist_ok=True)
    transcript_path = audio_path.with_suffix(".realtime.transcript.txt")
    meta_path = audio_path.with_suffix(".realtime.json")
    transcript_path.write_text("", encoding="utf-8")

    offset = HEADER_BYTES
    index = 0
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] realtime transcription started: {audio_path}", flush=True)
    notify("realtime_transcribing", title=title, path=str(transcript_path))

    while True:
        exists = audio_path.exists()
        size = audio_path.stat().st_size if exists else 0
        available = max(0, size - offset)
        state = read_state()
        still_recording = bool(state.get("recording")) and state.get("file_path") == str(audio_path)

        should_process = available >= chunk_bytes
        final_tail = (stop_requested or not still_recording) and available >= min_final_bytes
        if should_process or final_tail:
            take = chunk_bytes if should_process else available
            # Align to complete stereo int16 frames.
            take -= take % (CHANNELS * (BITS // 8))
            with audio_path.open("rb") as f:
                f.seek(offset)
                pcm = f.read(take)
            if pcm:
                index += 1
                start_sec = int((offset - HEADER_BYTES) / BYTES_PER_SEC)
                end_sec = int((offset - HEADER_BYTES + len(pcm)) / BYTES_PER_SEC)
                chunk = chunk_dir / f"chunk_{index:06d}.wav"
                write_chunk(chunk, pcm)
                try:
                    text = transcribe_chunk(chunk, cfg["command"])
                    append_transcript(transcript_path, index, start_sec, end_sec, text)
                    meta_path.write_text(json.dumps({
                        "audio_path": str(audio_path),
                        "transcript_path": str(transcript_path),
                        "chunks": index,
                        "last_end_sec": end_sec,
                        "updated_at": datetime.now().isoformat(),
                    }, indent=2, ensure_ascii=False), encoding="utf-8")
                except Exception as e:
                    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] chunk failed: {e}", file=sys.stderr, flush=True)
                    notify("realtime_transcript_error", title=title, path=str(transcript_path), error=str(e))
                offset += len(pcm)
                continue

        if stop_requested or (exists and not still_recording and available < min_final_bytes):
            break
        time.sleep(cfg["poll_sec"])

    notify("realtime_transcript_ready", title=title, path=str(transcript_path))
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] realtime transcription stopped: {transcript_path}", flush=True)


if __name__ == "__main__":
    main()
