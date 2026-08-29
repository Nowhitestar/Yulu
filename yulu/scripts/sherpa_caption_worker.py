#!/usr/bin/env python3
"""Local sherpa-onnx streaming caption worker.

The Yulu Host owns this child process and communicates over newline-delimited
JSON on stdin/stdout. Audio never leaves the machine. The worker deliberately
does not write transcript artifacts; the Host remains the owner of caption
state and persistence.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SAMPLE_RATE = 16_000
SOURCES = ("mic", "system")


def _result_text(recognizer: Any, stream: Any) -> str:
    result = recognizer.get_result(stream)
    value = result if isinstance(result, str) else getattr(result, "text", "")
    return str(value).strip()


def _decode_pcm16(value: str) -> list[float]:
    raw = base64.b64decode(value, validate=True)
    if len(raw) % 2:
        raise ValueError("PCM payload must contain complete signed 16-bit samples")
    samples = array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    return [sample / 32768.0 for sample in samples]


@dataclass
class SourceState:
    stream: Any
    samples: int = 0


class CaptionWorker:
    def __init__(self, model_dir: Path, *, threads: int = 4) -> None:
        import sherpa_onnx

        required = ("tokens.txt", "encoder.int8.onnx", "decoder.int8.onnx")
        missing = [name for name in required if not (model_dir / name).is_file()]
        if missing:
            raise FileNotFoundError(f"sherpa model is incomplete: {', '.join(missing)}")
        self.recognizer = sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=str(model_dir / "tokens.txt"),
            encoder=str(model_dir / "encoder.int8.onnx"),
            decoder=str(model_dir / "decoder.int8.onnx"),
            num_threads=threads,
            sample_rate=SAMPLE_RATE,
            feature_dim=80,
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=1.6,
            rule2_min_trailing_silence=0.8,
            rule3_min_utterance_length=15.0,
            decoding_method="greedy_search",
            provider="cpu",
        )
        self.sources: dict[str, SourceState] = {}
        self.warmed = False

    def warm(self) -> dict[str, Any]:
        if not self.warmed:
            stream = self.recognizer.create_stream()
            stream.accept_waveform(SAMPLE_RATE, [0.0] * int(SAMPLE_RATE * 0.8))
            stream.input_finished()
            while self.recognizer.is_ready(stream):
                self.recognizer.decode_stream(stream)
            self.warmed = True
        return {"provider": "sherpa-onnx-paraformer-int8", "ready": True}

    def start(self) -> dict[str, Any]:
        self.sources = {
            source: SourceState(stream=self.recognizer.create_stream())
            for source in SOURCES
        }
        return {"provider": "sherpa-onnx-paraformer-int8", "sampleRate": SAMPLE_RATE}

    def _decode(self, source: str) -> dict[str, Any]:
        state = self.sources[source]
        stable: list[dict[str, Any]] = []
        while self.recognizer.is_ready(state.stream):
            self.recognizer.decode_stream(state.stream)
        text = _result_text(self.recognizer, state.stream)
        if self.recognizer.is_endpoint(state.stream):
            if text:
                stable.append({
                    "text": text,
                    "endMs": round(state.samples / SAMPLE_RATE * 1000),
                })
            self.recognizer.reset(state.stream)
            text = ""
        return {
            "partial": text,
            "stable": stable,
            "audioMs": round(state.samples / SAMPLE_RATE * 1000),
        }

    def feed(self, chunks: dict[str, str]) -> dict[str, Any]:
        if not self.sources:
            raise RuntimeError("caption session is not active")
        updates: dict[str, Any] = {}
        for source in SOURCES:
            encoded = chunks.get(source)
            if not encoded:
                continue
            samples = _decode_pcm16(encoded)
            state = self.sources[source]
            state.samples += len(samples)
            state.stream.accept_waveform(SAMPLE_RATE, samples)
            updates[source] = self._decode(source)
        return {"updates": updates}

    def finish(self) -> dict[str, Any]:
        if not self.sources:
            return {"updates": {}}
        updates: dict[str, Any] = {}
        for source in SOURCES:
            state = self.sources[source]
            state.stream.accept_waveform(SAMPLE_RATE, [0.0] * int(SAMPLE_RATE * 0.8))
            state.stream.input_finished()
            update = self._decode(source)
            final_text = _result_text(self.recognizer, state.stream)
            if final_text:
                update["stable"].append({
                    "text": final_text,
                    "endMs": round(state.samples / SAMPLE_RATE * 1000),
                })
            update["partial"] = ""
            updates[source] = update
        self.sources = {}
        return {"updates": updates}

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        action = request.get("action")
        if action == "ping":
            return self.warm()
        if action == "start":
            return self.start()
        if action == "feed":
            chunks = request.get("chunks")
            if not isinstance(chunks, dict):
                raise ValueError("feed requires a chunks object")
            return self.feed({str(key): str(value) for key, value in chunks.items()})
        if action == "finish":
            return self.finish()
        if action == "abort":
            self.sources = {}
            return {"aborted": True}
        if action == "shutdown":
            self.sources = {}
            return {"shutdown": True}
        raise ValueError(f"unknown action: {action}")


def _reply(request_id: Any, *, result: dict[str, Any] | None = None, error: str | None = None) -> None:
    payload = {"id": request_id, "ok": error is None}
    if error is None:
        payload["result"] = result or {}
    else:
        payload["error"] = error
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Yulu local sherpa caption worker")
    parser.add_argument("--runtime-pack", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args(argv)
    try:
        trusted_script_dir = Path(__file__).resolve().parent
        sys.path.insert(0, str(trusted_script_dir))
        from local_caption_runtime import verify_runtime_pack

        runtime_pack = args.runtime_pack.expanduser().resolve()
        verify_runtime_pack(runtime_pack)
        sys.path.insert(0, str(runtime_pack / "Contents/Resources/site-packages"))
        worker = CaptionWorker(args.model_dir.expanduser().resolve(), threads=max(1, args.threads))
    except Exception as exc:
        print(json.dumps({"fatal": str(exc)}, ensure_ascii=False), file=sys.stderr, flush=True)
        return 2

    for raw in sys.stdin:
        request: dict[str, Any] | None = None
        try:
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise ValueError("request must be a JSON object")
            request_id = request.get("id")
            result = worker.handle(request)
            _reply(request_id, result=result)
            if request.get("action") == "shutdown":
                return 0
        except Exception as exc:
            request_id = request.get("id") if isinstance(request, dict) else None
            _reply(request_id, error=str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
