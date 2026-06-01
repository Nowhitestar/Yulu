#!/usr/bin/env bash
#
# setup_models.sh — whisper.cpp model download + config-pointer concern
# (extracted from setup.sh::download_whisper_model 621-708 and
# write_model_to_config 678-708).
#
# Standalone-or-sourced (RESEARCH Pattern 5). Pure file-I/O + config-transform;
# no signing concern touches it. Idempotent: an already-downloaded model is
# detected and skipped (only config is re-pointed).
#
# The monolith read $PYTHON_BIN / $CONFIG_DIR / $MODEL_DIR as shared globals;
# here they are explicit env vars with defaults so `set -u` standalone
# invocation cannot crash on an unbound global (Pitfall 5).
#
# shellcheck source=lib/common.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# State taken via env/arg, NOT monolith globals (Pitfall 5).
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || echo /usr/bin/python3)}"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/yulu}"
MODEL_DIR="${MODEL_DIR:-$CONFIG_DIR/models}"

# Update config.json so transcribe.py knows which model to use.
write_model_to_config() {
    local model_path="$1"
    "$PYTHON_BIN" - <<PY
import json
from pathlib import Path

cfg_path = Path("$CONFIG_DIR/config.json")
if not cfg_path.exists():
    raise SystemExit(0)
cfg = json.loads(cfg_path.read_text())
trans = cfg.setdefault("transcription", {})
realtime = trans.setdefault("realtime", {})
trans.setdefault("mode", "local")
trans.setdefault("language", "zh")
trans.setdefault("post_recording_mode", "fast_summary")
trans["final_engine"] = "whisper"
# Write the explicit whisper-cli command so transcribe.py uses our chosen model.
trans["command"] = [
    "whisper-cli",
    "-m", "$model_path",
    "-l", trans.get("language", "zh"),
    "-otxt",
    "-of", "{{output_stem}}",
    "{{input}}",
]
trans["local_model_path"] = "$model_path"
realtime["engine"] = "whisper"
cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False))
PY
    ok "config.json 已指向该模型"
}

setup_models() {
    local mode="${1:-release}"   # release|dev — accepted for orchestrator parity
    : "$mode"                    # model download is mode-agnostic

    header "下载 whisper.cpp 模型"

    mkdir -p "$MODEL_DIR"

    local target
    target="$("$PYTHON_BIN" - <<PY
import json
from pathlib import Path
cfg_path = Path("$CONFIG_DIR/config.json")
if not cfg_path.exists():
    raise SystemExit(0)
cfg = json.loads(cfg_path.read_text())
trans = cfg.get("transcription", {})
realtime = trans.get("realtime", {}) if isinstance(trans.get("realtime", {}), dict) else {}
needs = trans.get("final_engine", "whisper") == "whisper" or realtime.get("engine") == "whisper"
if needs:
    print(Path(trans.get("local_model_path") or "$MODEL_DIR/ggml-large-v3.bin").expanduser())
PY
)"

    if [[ -z "$target" ]]; then
        ok "当前选择 MLX 转录，跳过 GGML 模型下载"
        return
    fi

    if [[ -f "$target" ]]; then
        ok "模型已存在: $target"
        write_model_to_config "$target"
        return
    fi

    local filename model_name url
    filename="$(basename "$target")"
    model_name="${filename#ggml-}"
    model_name="${model_name%.bin}"
    if [[ "$filename" != ggml-*.bin || -z "$model_name" ]]; then
        warn "无法自动识别模型文件名: $target"
        warn "请手动下载模型后运行: yulu transcription engine whisper $target"
        return
    fi

    url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model_name}.bin"
    info "下载 ggml-${model_name}.bin（这一步可能要几分钟到十几分钟，取决于网络）..."
    if curl -L --fail --progress-bar "$url" -o "$target.partial"; then
        mv "$target.partial" "$target"
        ok "模型已保存: $target"
        write_model_to_config "$target"
    else
        rm -f "$target.partial"
        warn "模型下载失败。手动下载方法："
        warn "  curl -L $url -o $target"
        warn "下载完成后运行：yulu transcription engine whisper $target"
    fi
}

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && setup_models "$@"
