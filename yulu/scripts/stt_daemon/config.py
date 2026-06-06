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
    # The realtime/live tail must keep up with wall-clock audio, so it runs a
    # FASTER model than the final pass. large-v3 is far too slow to transcribe
    # a chunk in real time on most machines; the turbo model is ~4-8x faster
    # with a small accuracy cost that the final re-pass (large-v3) recovers.
    # Read from transcription.realtime.mlx_model; defaults to turbo even when
    # the final model is large-v3.
    realtime_mlx_model: str = "mlx-community/whisper-large-v3-turbo"
    whisper_cli: str = "whisper-cli"
    whisper_model: str = ""
    # Final-transcription mode (transcription.mode): "local" keeps everything on
    # this machine (default); "cloud-fallback" tries local then the user's
    # cloud_command; "cloud-priority" tries cloud_command first then local.
    mode: str = "local"
    # The user's OWN cloud-transcription command array (transcription.cloud_command).
    # Yulu holds no cloud keys — it just spawns this, mirroring the llm.command boundary.
    cloud_command: list[str] = field(default_factory=list)
    live_chunk_max_per_session: int = 4
    # Upper bound (seconds) on how much audio a single live_chunk transcribes.
    # Without this, a tail loop that has fallen behind reads ALL accumulated
    # audio in one chunk, which only makes it slower and can starve later
    # chunks. Capping the read keeps each live_chunk bounded so the loop can
    # catch up incrementally instead of producing one giant slow chunk.
    live_chunk_max_sec: float = 30.0
    max_concurrent_connections: int = 100

    # ── Diarization (v0.6, transcription.diarization.*) ──────────────────────
    # Config-SELECTED sibling stage (DIAR-01). The diarize backend is built OFF the ASR
    # `backends` dict (see __main__._build_diarize_backend) so the ASR fallback chain can
    # never route to it. `diarize_enabled=False` by default → the backend is simply not
    # constructed and today's pipeline is unchanged.
    diarize_enabled: bool = False
    diarize_provider: str = "sherpa-onnx"
    # Empty → resolve canonical paths under <models_dir>/diarization (backends.diarize).
    diarize_seg_model: str = ""
    diarize_emb_model: str = ""
    # None / <=0 → auto threshold-based clustering (count strategy is Phase 12).
    diarize_num_speakers: Optional[int] = None
    diarize_threshold: float = 0.5

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
        realtime = trans.get("realtime", {}) if isinstance(trans.get("realtime"), dict) else {}
        if mlx.get("python"):
            cfg.mlx_python = str(Path(mlx["python"]).expanduser())
        if mlx.get("model"):
            cfg.mlx_model = mlx["model"]
        # Realtime model: honor transcription.realtime.mlx_model when present.
        # Fall back to the default turbo model (NOT the final model) so the
        # live tail stays fast even on configs that never set it.
        if realtime.get("mlx_model"):
            cfg.realtime_mlx_model = realtime["mlx_model"]
        if realtime.get("chunk_max_sec"):
            cfg.live_chunk_max_sec = float(realtime["chunk_max_sec"])
        if trans.get("whisper_cli"):
            cfg.whisper_cli = trans["whisper_cli"]
        if trans.get("local_model_path"):
            cfg.whisper_model = str(Path(trans["local_model_path"]).expanduser())
        if trans.get("language"):
            cfg.default_language = trans["language"]
        if trans.get("mode"):
            cfg.mode = str(trans["mode"]).strip().lower()
        cloud_cmd = trans.get("cloud_command")
        if isinstance(cloud_cmd, list):
            cfg.cloud_command = [str(part) for part in cloud_cmd]
        if sd.get("default_engine"):
            cfg.default_engine = sd["default_engine"]
        if sd.get("live_chunk_max_per_session"):
            cfg.live_chunk_max_per_session = int(sd["live_chunk_max_per_session"])
        # Diarization (transcription.diarization.*) — all optional, all defaulted.
        diar = trans.get("diarization", {}) if isinstance(trans.get("diarization"), dict) else {}
        if "enabled" in diar:
            cfg.diarize_enabled = bool(diar["enabled"])
        if diar.get("provider"):
            cfg.diarize_provider = str(diar["provider"]).strip().lower()
        if diar.get("seg_model"):
            cfg.diarize_seg_model = str(Path(diar["seg_model"]).expanduser())
        if diar.get("emb_model"):
            cfg.diarize_emb_model = str(Path(diar["emb_model"]).expanduser())
        if diar.get("num_speakers") is not None:
            try:
                cfg.diarize_num_speakers = int(diar["num_speakers"])
            except (TypeError, ValueError):
                cfg.diarize_num_speakers = None
        if diar.get("threshold") is not None:
            try:
                cfg.diarize_threshold = float(diar["threshold"])
            except (TypeError, ValueError):
                pass
        return cfg
