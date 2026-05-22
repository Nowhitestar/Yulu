"""JSON line logger for stt_daemon."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, TextIO


class JsonLogger:
    def __init__(self, sink: TextIO = sys.stderr):
        self.sink = sink

    def _emit(self, level: str, event: str, **fields: Any) -> None:
        line = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "level": level,
            "event": event,
            **fields,
        }
        self.sink.write(json.dumps(line, ensure_ascii=False) + "\n")
        self.sink.flush()

    def info(self, event: str, **fields: Any) -> None:
        self._emit("info", event, **fields)

    def warn(self, event: str, **fields: Any) -> None:
        self._emit("warn", event, **fields)

    def error(self, event: str, **fields: Any) -> None:
        self._emit("error", event, **fields)


def open_log_sink(path: Optional[Path]) -> TextIO:
    if path is None:
        return sys.stderr
    path.parent.mkdir(parents=True, exist_ok=True)
    return path.open("a", encoding="utf-8")
