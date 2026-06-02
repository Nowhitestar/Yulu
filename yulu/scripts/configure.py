#!/usr/bin/env python3
"""Small config editor for Yulu runtime switches."""

import json
import sys
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"
DEFAULT_MLX_PYTHON = str(Path.home() / ".config/yulu/venv-mlx-whisper/bin/python")
DEFAULT_MLX_MODEL = "mlx-community/whisper-large-v3-turbo"
# Realtime/live captions always run a fast model so they keep up with
# wall-clock audio, independent of which (possibly slower) model the user
# picks for the final pass. large-v3 is too slow per-chunk for the live tail.
DEFAULT_REALTIME_MLX_MODEL = "mlx-community/whisper-large-v3-turbo"
DEFAULT_WHISPER_MODEL = str(Path.home() / ".config/yulu/models/ggml-large-v3.bin")
FAST_MODE = "fast_summary"
FULL_MODE = "full_transcribe"


def load_config(path=CONFIG_PATH):
    if not path.exists():
        raise SystemExit(f"Config not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def save_config(cfg, path=CONFIG_PATH):
    path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def transcription(cfg):
    return cfg.setdefault("transcription", {})


def normalize_mode(value):
    raw = str(value or "").strip().lower().replace("-", "_")
    aliases = {
        "fast": FAST_MODE,
        "quick": FAST_MODE,
        "realtime": FAST_MODE,
        "realtime_polish": FAST_MODE,
        "fast_summary": FAST_MODE,
        "full": FULL_MODE,
        "quality": FULL_MODE,
        "final": FULL_MODE,
        "full_transcribe": FULL_MODE,
        "final_transcribe": FULL_MODE,
    }
    if raw not in aliases:
        raise SystemExit("mode must be fast or full")
    return aliases[raw]


def set_mode(value, path=CONFIG_PATH):
    cfg = load_config(path)
    mode = normalize_mode(value)
    transcription(cfg)["post_recording_mode"] = mode
    save_config(cfg, path)
    if mode == FAST_MODE:
        print("post_recording_mode=fast_summary")
        print("停止后将优先使用实时转录 -> polish -> summary；没有实时转录时自动回退完整转录。")
    else:
        print("post_recording_mode=full_transcribe")
        print("停止后将对整段音频重新完整转录 -> polish -> summary；更慢但质量更稳。")


def set_engine(engine, model=None, path=CONFIG_PATH):
    cfg = load_config(path)
    trans = transcription(cfg)
    realtime = trans.setdefault("realtime", {})
    engine = str(engine or "").strip().lower()

    if engine == "mlx":
        mlx = trans.setdefault("mlx", {})
        mlx["python"] = mlx.get("python") or DEFAULT_MLX_PYTHON
        mlx["model"] = model or mlx.get("model") or DEFAULT_MLX_MODEL
        mlx["final_model"] = model or mlx.get("final_model") or DEFAULT_MLX_MODEL
        mlx["preprocess_audio"] = mlx.get("preprocess_audio", True)
        trans["final_engine"] = "mlx"
        realtime["engine"] = "mlx"
        # Keep realtime on a fast model regardless of the final model choice.
        # Only seed a default; respect an explicit user override if present.
        realtime["mlx_model"] = realtime.get("mlx_model") or DEFAULT_REALTIME_MLX_MODEL
        realtime.setdefault("chunk_sec", 15)
        realtime.setdefault("chunk_max_sec", 30)
        save_config(cfg, path)
        print(f"final_engine=mlx")
        print(f"mlx.model={mlx['model']}")
        return

    if engine == "whisper":
        model_path = str(Path(model or trans.get("local_model_path") or DEFAULT_WHISPER_MODEL).expanduser())
        language = trans.get("language") or "zh"
        trans["final_engine"] = "whisper"
        trans["local_model_path"] = model_path
        trans["whisper_cli"] = trans.get("whisper_cli") or "whisper-cli"
        trans["command"] = [
            trans["whisper_cli"],
            "-m", model_path,
            "-l", language,
            "-otxt",
            "-of", "{{output_stem}}",
            "{{input}}",
        ]
        realtime["engine"] = "whisper"
        save_config(cfg, path)
        print("final_engine=whisper")
        print(f"local_model_path={model_path}")
        return

    raise SystemExit("engine must be mlx or whisper")


def status(path=CONFIG_PATH):
    cfg = load_config(path)
    trans = transcription(cfg)
    mlx = trans.get("mlx", {}) if isinstance(trans.get("mlx", {}), dict) else {}
    realtime = trans.get("realtime", {}) if isinstance(trans.get("realtime", {}), dict) else {}
    mode = trans.get("post_recording_mode", FAST_MODE)
    engine = trans.get("final_engine", "whisper")
    print(f"post_recording_mode={mode}")
    print(f"final_engine={engine}")
    if engine == "mlx":
        print(f"mlx.python={mlx.get('python') or DEFAULT_MLX_PYTHON}")
        print(f"mlx.model={mlx.get('model') or DEFAULT_MLX_MODEL}")
        print(f"mlx.final_model={mlx.get('final_model') or mlx.get('model') or DEFAULT_MLX_MODEL}")
        print(f"mlx.preprocess_audio={mlx.get('preprocess_audio', True)}")
    else:
        print(f"whisper_cli={trans.get('whisper_cli') or 'whisper-cli'}")
        print(f"local_model_path={trans.get('local_model_path') or DEFAULT_WHISPER_MODEL}")
    print(f"realtime.engine={realtime.get('engine') or engine}")
    if realtime.get("mlx_model"):
        print(f"realtime.mlx_model={realtime['mlx_model']}")


def usage():
    print(
        "Usage:\n"
        "  configure.py transcription status\n"
        "  configure.py transcription mode fast|full\n"
        "  configure.py transcription engine mlx [mlx-model]\n"
        "  configure.py transcription engine whisper [ggml-model-path]",
        file=sys.stderr,
    )
    raise SystemExit(2)


def main(argv):
    if len(argv) < 2 or argv[0] != "transcription":
        usage()
    cmd = argv[1]
    if cmd == "status" and len(argv) == 2:
        status()
    elif cmd == "mode" and len(argv) == 3:
        set_mode(argv[2])
    elif cmd == "engine" and len(argv) in {3, 4}:
        set_engine(argv[2], argv[3] if len(argv) == 4 else None)
    else:
        usage()


if __name__ == "__main__":
    main(sys.argv[1:])
