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

# ── Diarization engine + ONNX models (v0.6) ──────────────────────────────────
#
# Two concerns, both GATED on diarization being enabled in config
# (transcription.diarization.enabled) so a non-diarization install pulls NOTHING extra:
#
#   1. The sherpa-onnx ENGINE (PORT-01). Installed into the SAME interpreter the
#      stt_daemon runs as ($PYTHON_BIN == the plist __PYTHON__ == system python3).
#      Empirically resolved on Yulu's Python 3.14 runtime: the cp314 wheel installs,
#      imports, and diarizes (see .planning/phases/15-.../15-SUMMARY.md) — so sherpa
#      CO-LOCATES in the daemon interpreter, no isolated venv (mirrors the mlx-whisper
#      "importable from the daemon interpreter" contract; there is deliberately no
#      Yulu-managed venv since v0.5 D-02). onnxruntime-only, torch-free, cross-platform
#      (cp37–cp314 macOS/Linux/Windows wheels) so this step has NO macOS coupling.
#
#   2. The two plain ONNX MODELS, cached under $MODEL_DIR/diarization/, loaded by the
#      resident SherpaDiarizeBackend by absolute path. Offline-by-default: once on disk
#      they load with ZERO network calls. URLs mirror backends/diarize.py
#      (SEG_MODEL_URL / EMB_MODEL_URL) — the single source of truth.
#
# Both halves are independently idempotent: an already-importable sherpa-onnx and an
# already-present .onnx file are each detected and skipped.
DIAR_DIR="${DIAR_DIR:-$MODEL_DIR/diarization}"
DIAR_SEG_FILE="$DIAR_DIR/segmentation.onnx"
DIAR_EMB_FILE="$DIAR_DIR/campplus.onnx"
DIAR_SEG_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
DIAR_EMB_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"

diarization_enabled() {
    # Read-only: true iff transcription.diarization.enabled is truthy in config.json.
    "$PYTHON_BIN" - <<PY 2>/dev/null
import json, sys
from pathlib import Path
cfg_path = Path("$CONFIG_DIR/config.json")
try:
    cfg = json.loads(cfg_path.read_text())
except Exception:
    sys.exit(1)
diar = cfg.get("transcription", {}).get("diarization", {})
sys.exit(0 if (isinstance(diar, dict) and diar.get("enabled")) else 1)
PY
}

diarization_engine_present() {
    # Read-only: true iff sherpa_onnx is importable from the daemon interpreter ($PYTHON_BIN).
    # Same honesty contract as verify_mlx_whisper — probe the interpreter the daemon ACTUALLY
    # uses (the plist __PYTHON__), so a "present" answer means the daemon can really diarize.
    "$PYTHON_BIN" -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('sherpa_onnx') else 1)" 2>/dev/null
}

install_diarization_engine() {
    # PORT-01: install the sherpa-onnx engine into the daemon interpreter. Idempotent:
    # skips when already importable. CO-LOCATES (no isolated venv) because the cp314 wheel
    # is verified working on Yulu's Python 3.14 runtime. Cross-platform wheel (onnxruntime-
    # only) → no macOS coupling. A failed install WARNS but does not abort: the models can
    # still download, the probe will report present-but-unverified, and the pipeline degrades
    # gracefully to plain transcripts until the engine is available (diarize_pipeline.py).
    if diarization_engine_present; then
        ok "sherpa-onnx 已可从守护进程解释器导入（${PYTHON_BIN}）"
        return 0
    fi
    info "安装 sherpa-onnx 说话人分离引擎到 ${PYTHON_BIN}（onnxruntime，无 torch，跨平台）..."
    if "$PYTHON_BIN" -m pip install --upgrade sherpa-onnx >/dev/null 2>&1; then
        if diarization_engine_present; then
            ok "sherpa-onnx 引擎已安装"
        else
            warn "sherpa-onnx 安装后仍无法导入（${PYTHON_BIN}）。说话人分离将不可用，普通转录不受影响。"
        fi
    else
        warn "sherpa-onnx 安装失败（${PYTHON_BIN}）。手动安装：${PYTHON_BIN} -m pip install sherpa-onnx"
        warn "说话人分离将不可用，直到引擎可导入；普通转录不受影响。"
    fi
}

setup_diarization_models() {
    # Idempotent: install the sherpa engine (PORT-01) + download the seg + cam++ ONNX.
    # Skips the engine when already importable and any file that already exists.
    if ! diarization_enabled; then
        ok "未启用说话人分离，跳过 diarization 引擎与模型"
        return 0
    fi
    header "配置说话人分离 (diarization)：引擎 + ONNX 模型"

    # 1. The engine first (so a freshly-provisioned model dir is immediately usable).
    install_diarization_engine

    # 2. The two ONNX model files.
    mkdir -p "$DIAR_DIR"

    # cam++ embedding — a plain .onnx (~27 MB), direct download.
    if [[ -f "$DIAR_EMB_FILE" ]]; then
        ok "cam++ embedding 模型已存在: $DIAR_EMB_FILE"
    else
        info "下载 cam++ embedding (~27 MB)..."
        if curl -L --fail --progress-bar "$DIAR_EMB_URL" -o "$DIAR_EMB_FILE.partial"; then
            mv "$DIAR_EMB_FILE.partial" "$DIAR_EMB_FILE"
            ok "cam++ embedding 已保存: $DIAR_EMB_FILE"
        else
            rm -f "$DIAR_EMB_FILE.partial"
            warn "cam++ 模型下载失败。手动下载：curl -L $DIAR_EMB_URL -o $DIAR_EMB_FILE"
        fi
    fi

    # pyannote segmentation — shipped inside a .tar.bz2; extract model.onnx -> segmentation.onnx.
    if [[ -f "$DIAR_SEG_FILE" ]]; then
        ok "segmentation 模型已存在: $DIAR_SEG_FILE"
    else
        info "下载 pyannote segmentation (~5.7 MB)..."
        local tarball="$DIAR_DIR/seg.tar.bz2"
        if curl -L --fail --progress-bar "$DIAR_SEG_URL" -o "$tarball.partial"; then
            mv "$tarball.partial" "$tarball"
            # Extract the single model.onnx from the archive into DIAR_DIR.
            if tar -xjf "$tarball" -C "$DIAR_DIR" 2>/dev/null; then
                local extracted
                extracted="$(find "$DIAR_DIR" -name model.onnx -path '*pyannote*' 2>/dev/null | head -1)"
                if [[ -n "$extracted" && -f "$extracted" ]]; then
                    mv "$extracted" "$DIAR_SEG_FILE"
                    ok "segmentation 已保存: $DIAR_SEG_FILE"
                    # Clean the extracted tree + tarball (keep only the .onnx we need).
                    rm -rf "$DIAR_DIR"/sherpa-onnx-pyannote-segmentation-3-0 "$tarball"
                else
                    warn "未能在归档中找到 model.onnx；请手动解压 $tarball"
                fi
            else
                warn "解压 segmentation 归档失败：$tarball"
            fi
        else
            rm -f "$tarball.partial"
            warn "segmentation 模型下载失败。手动下载：curl -L $DIAR_SEG_URL -o $tarball && tar -xjf $tarball -C $DIAR_DIR"
        fi
    fi
}

setup_whisper_model() {
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

setup_models() {
    local mode="${1:-release}"   # release|dev — accepted for orchestrator parity
    : "$mode"                    # model download is mode-agnostic

    # The whisper model concern (unchanged) followed by the additive diarization
    # concern. Each is independently idempotent; diarization is gated on config so a
    # non-diarization install pulls nothing extra.
    setup_whisper_model
    setup_diarization_models
}

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && setup_models "$@"
