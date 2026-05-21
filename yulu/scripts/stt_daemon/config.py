"""Daemon config — loaded from ~/.config/yulu/config.json `stt_daemon` section."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


HOME_DIR = Path.home() / ".config" / "yulu"


@dataclass
class DaemonConfig:
    socket_path: Path = field(default_factory=lambda: HOME_DIR / "stt_daemon.sock")
    pid_file: Path = field(default_factory=lambda: HOME_DIR / "stt_daemon.pid")
    log_path: Optional[Path] = field(default_factory=lambda: HOME_DIR / "logs" / "stt_daemon.log")
    vocab_db_path: Path = field(default_factory=lambda: HOME_DIR / "vocab.sqlite")
    sessions_dir: Path = field(default_factory=lambda: HOME_DIR / "sessions")
    default_engine: str = "mlx"
    default_language: str = "zh"
    mlx_python: str = ""
    mlx_model: str = "mlx-community/whisper-large-v3-mlx"
    whisper_cli: str = "whisper-cli"
    whisper_model: str = ""
    live_chunk_max_per_session: int = 4
    max_concurrent_connections: int = 100

    @classmethod
    def from_user_config(cls, path: Optional[Path] = None) -> "DaemonConfig":
        if path is None:
            path = HOME_DIR / "config.json"
        cfg = cls()
        if not path.exists():
            return cfg
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return cfg
        sd = data.get("stt_daemon", {})
        trans = data.get("transcription", {})
        mlx = trans.get("mlx", {})
        if mlx.get("python"):
            cfg.mlx_python = str(Path(mlx["python"]).expanduser())
        if mlx.get("model"):
            cfg.mlx_model = mlx["model"]
        if trans.get("whisper_cli"):
            cfg.whisper_cli = trans["whisper_cli"]
        if trans.get("local_model_path"):
            cfg.whisper_model = str(Path(trans["local_model_path"]).expanduser())
        if trans.get("language"):
            cfg.default_language = trans["language"]
        if sd.get("default_engine"):
            cfg.default_engine = sd["default_engine"]
        if sd.get("live_chunk_max_per_session"):
            cfg.live_chunk_max_per_session = int(sd["live_chunk_max_per_session"])
        return cfg
