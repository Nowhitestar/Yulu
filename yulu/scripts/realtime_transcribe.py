#!/usr/bin/env python3
"""Realtime-ish transcription for Meeting Assistant.

Watches the growing 16-bit stereo 48k WAV written by Yulu, cuts stable PCM
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
import re
import shlex
import signal
import struct
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from queue_store import append_event
from state_store import is_recording_active, load_state, recording_info

CONFIG_DIR = Path.home() / ".config" / "yulu"
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
    "-m", str(Path.home() / ".config/yulu/models/ggml-large-v3.bin"),
    "-l", "zh",
    "-otxt",
    "-of", "{{output_stem}}",
    "{{input}}",
]
DEFAULT_MLX_PYTHON = str(Path.home() / ".config/yulu/venv-mlx-whisper/bin/python")
DEFAULT_MLX_MODEL = "mlx-community/whisper-large-v3-mlx"
DEFAULT_GLOSSARY = [
    "AgentKey", "OpenClaw", "OpenAI", "Claude", "Cursor", "Deal Hub",
    "Portfolio", "GitHub", "Yulu",
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
    engine = realtime.get("engine") or trans.get("final_engine") or "whisper"
    language = trans.get("language") or realtime.get("language") or "zh"
    chunk_sec = int(os.environ.get("YULU_RT_CHUNK_SEC") or realtime.get("chunk_sec", 60))
    base = {
        "engine": engine,
        "language": language,
        "chunk_sec": chunk_sec,
        "poll_sec": float(realtime.get("poll_sec", 2)),
        "min_final_sec": int(realtime.get("min_final_sec", 8)),
        "timeout_sec": int(realtime.get("timeout_sec", 1800)),
        "initial_prompt": realtime.get("initial_prompt") or trans.get("initial_prompt"),
        "glossary": trans.get("glossary") or DEFAULT_GLOSSARY,
    }
    if engine == "mlx":
        mlx_cfg = trans.get("mlx", {}) if isinstance(trans.get("mlx", {}), dict) else {}
        base.update({
            "mlx_python": realtime.get("mlx_python") or trans.get("mlx_python") or mlx_cfg.get("python") or DEFAULT_MLX_PYTHON,
            "mlx_model": realtime.get("mlx_model") or trans.get("mlx_model") or mlx_cfg.get("model") or DEFAULT_MLX_MODEL,
        })
        return base

    cmd = trans.get("command")
    if not cmd:
        whisper_cli = trans.get("whisper_cli") or "whisper-cli"
        model_path = trans.get("local_model_path") or str(Path.home() / ".config/yulu/models/ggml-large-v3.bin")
        cmd = [
            whisper_cli,
            "-m", str(Path(model_path).expanduser()),
            "-l", language,
            "-otxt",
            "-of", "{{output_stem}}",
            "{{input}}",
        ]
    base["command"] = cmd
    return base


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


def notify(event_type, **kwargs):
    append_event(event_type, **kwargs)


def _glossary_prompt(cfg, title):
    glossary = cfg.get("glossary", DEFAULT_GLOSSARY)
    if isinstance(glossary, str):
        glossary = [x.strip() for x in re.split(r"[,\n]", glossary) if x.strip()]
    terms = ", ".join(dict.fromkeys([*DEFAULT_GLOSSARY, *glossary]))
    return (
        "以下是一次中文为主、中英混杂的会议。"
        "请保留英文专有名词，不要翻译人名、产品名和公司名。"
        f"会议标题：{title}。常见术语：{terms}。"
    )


def transcribe_chunk_whisper(chunk_path, cmd_template):
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


def transcribe_chunk_mlx(chunk_path, cfg, title):
    py = cfg["mlx_python"]
    model = cfg["mlx_model"]
    prompt = cfg.get("initial_prompt") or _glossary_prompt(cfg, title)
    language = cfg.get("language") or "zh"
    if not Path(py).exists():
        raise RuntimeError(f"mlx-whisper python not found: {py}")
    code = """
import sys
import mlx_whisper

audio, model, prompt, language = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
res = mlx_whisper.transcribe(
    audio,
    path_or_hf_repo=model,
    language=language,
    task="transcribe",
    verbose=False,
    initial_prompt=prompt,
    condition_on_previous_text=True,
    word_timestamps=False,
    hallucination_silence_threshold=2.0,
)
segments = res.get("segments") or []
if segments:
    print("\\n".join((seg.get("text") or "").strip() for seg in segments if (seg.get("text") or "").strip()))
else:
    print((res.get("text") or "").strip())
"""
    cmd = [py, "-c", code, str(chunk_path), model, prompt, language]
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] mlx chunk: {shlex.join([py, '-c', '<code>', str(chunk_path), model, '<prompt>', language])}", flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=cfg["timeout_sec"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"mlx-whisper failed: {result.returncode}")
    return result.stdout.strip()


def transcribe_chunk(chunk_path, cfg, title):
    if cfg.get("engine") == "mlx":
        return transcribe_chunk_mlx(chunk_path, cfg, title)
    return transcribe_chunk_whisper(chunk_path, cfg["command"])


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
        state = load_state(STATE_PATH)
        rec = recording_info(state)
        current_path = rec.get("audio_path") or rec.get("file_path")
        still_recording = is_recording_active(state) and current_path == str(audio_path)

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
                    text = transcribe_chunk(chunk, cfg, title)
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
