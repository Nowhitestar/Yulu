#!/usr/bin/env bash
#
# setup_capabilities.sh — transcription-runtime capability concern
# (extracted from setup.sh::install_mlx_whisper 607-619 and
# write_mlx_to_config 710-733). This is where D-01/D-02/D-03/D-05 land.
#
# What changed vs the monolith:
#   D-02  No more Yulu-specific venv. The monolith created a dedicated mlx virtualenv
#         under ~/.config/yulu/ and pip-installed mlx-whisper into it. That whole body
#         is REMOVED. (We do NOT delete an existing user's virtualenv — orphaned-virtualenv
#         cleanup is a Phase 7 migration concern; we just stop creating a second runtime.)
#   D-01  The daemon interpreter is the host system python3 that the launchd plist
#         launches via the __PYTHON__ token (set by setup_daemons.sh / lib/common.sh). When
#         MLX is the configured engine, this script installs/repairs mlx-whisper in THAT
#         interpreter instead of a private venv, then verifies it.
#   D-03  write_mlx_to_config no longer writes a venv path into
#         transcription.mlx.python. The dead field is dropped. stt_daemon/config.py
#         reads mlx.python only `if mlx.get("python")`, so an absent field is
#         harmlessly ignored (mlx_python defaults to "").
#   D-05  Reuse first, repair second. A usable host mlx-whisper is reused unchanged; if MLX is
#         configured but the package is absent/present-unverified, install/upgrade
#         mlx-whisper + PyYAML in the daemon interpreter. Failures warn and leave the
#         whisper.cpp path available, but the setup step no longer silently declares success
#         while the selected MLX service is missing.
#
# Standalone-or-sourced (RESEARCH Pattern 5), non-interactive (Pitfall 5),
# idempotent (verify + config-transform are safe to re-run). $PYTHON_BIN /
# $CONFIG_DIR are taken via env with defaults, not monolith globals.
#
# shellcheck source=lib/common.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# State taken via env/arg, NOT monolith globals (Pitfall 5).
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || echo /usr/bin/python3)}"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/yulu}"

# Read-only: true iff config.json selects MLX for final, realtime, or the stt daemon default.
# Missing/corrupt config returns false so standalone hermetic tests do not try network installs.
mlx_required() {
    "$PYTHON_BIN" - <<PY 2>/dev/null
import json, sys
from pathlib import Path
cfg_path = Path("$CONFIG_DIR/config.json")
try:
    cfg = json.loads(cfg_path.read_text())
except Exception:
    sys.exit(1)
trans = cfg.get("transcription", {}) if isinstance(cfg, dict) else {}
realtime = trans.get("realtime", {}) if isinstance(trans.get("realtime"), dict) else {}
stt = cfg.get("stt_daemon", {}) if isinstance(cfg.get("stt_daemon"), dict) else {}
final_engine = str(trans.get("final_engine") or trans.get("engine") or "").strip().lower()
realtime_engine = str(realtime.get("engine") or "").strip().lower()
default_engine = str(stt.get("default_engine") or "").strip().lower()
sys.exit(0 if "mlx" in {final_engine, realtime_engine, default_engine} else 1)
PY
}

mlx_whisper_present() {
    "$PYTHON_BIN" -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('mlx_whisper') else 1)" 2>/dev/null
}

mlx_whisper_prereqs_present() {
    "$PYTHON_BIN" -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('mlx_whisper') and importlib.util.find_spec('yaml') else 1)" 2>/dev/null
}

# Verify that the MLX package prerequisites are discoverable from the daemon interpreter.
# Full MLX import can initialize Metal and should be verified by the actual daemon warm-up,
# not by the installer/settings process.
verify_mlx_whisper() {
    if mlx_whisper_prereqs_present; then
        ok "mlx-whisper 与 PyYAML 已可从系统 python3 发现（${PYTHON_BIN}）"
    else
        warn "系统 python3 ($PYTHON_BIN) 缺少 mlx-whisper 或 PyYAML。"
        warn "MLX 转录将不可用，直到这些依赖在该解释器中可用。"
        warn "whisper.cpp 路径不受影响。"
    fi
}

install_mlx_whisper() {
    if mlx_whisper_prereqs_present; then
        ok "mlx-whisper 与 PyYAML 已在守护进程解释器中可发现（${PYTHON_BIN}）"
        return 0
    fi
    if [[ "$(uname -m)" != "arm64" ]]; then
        warn "当前机器不是 Apple Silicon，跳过自动安装 mlx-whisper；可改用 whisper.cpp。"
        verify_mlx_whisper
        return 0
    fi

    info "安装/修复 mlx-whisper 到守护进程解释器 ${PYTHON_BIN}..."
    if "$PYTHON_BIN" -m pip install --upgrade mlx-whisper PyYAML >/dev/null 2>&1 \
        || "$PYTHON_BIN" -m pip install --user --upgrade mlx-whisper PyYAML >/dev/null 2>&1; then
        if mlx_whisper_prereqs_present; then
            ok "mlx-whisper 与 PyYAML 已安装"
            warn "请用 yulu stt warm-up --engine mlx 在实际守护进程环境中验证。"
        elif mlx_whisper_present; then
            warn "mlx-whisper 包已存在，但 PyYAML 或其他依赖仍缺失。"
        else
            warn "pip 返回成功，但仍未发现 mlx_whisper 模块。"
        fi
    else
        warn "mlx-whisper 安装失败（${PYTHON_BIN}）。手动安装：${PYTHON_BIN} -m pip install --user mlx-whisper PyYAML"
        warn "MLX 转录将不可用；可暂时切到 whisper.cpp。"
    fi
}

# Update config.json for MLX transcription. D-03: do NOT write a venv path into
# transcription.mlx.python — the field is dropped entirely (the daemon interpreter
# is the plist's __PYTHON__, i.e. system python3). Keeps the cfg.setdefault ladder.
write_mlx_to_config() {
    local model="$1"
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
trans["final_engine"] = "mlx"
# D-03: no "python" key — the daemon uses the plist __PYTHON__ (system python3),
# not a venv. stt_daemon/config.py ignores a missing mlx.python (defaults to "").
mlx = trans.setdefault("mlx", {})
mlx.pop("python", None)   # normalize any stale venv path written by an older setup
mlx["model"] = "$model"
realtime["engine"] = "mlx"
# Realtime/live captions stay on a FAST model so the live tail keeps up with
# wall-clock audio (large-v3 is too slow per-chunk; the final pass still uses
# mlx["model"]). Migration: older setups copied the large-v3 final model into
# realtime.mlx_model, which made the live tail fall behind and truncate long
# recordings. Rewrite that stale value to turbo. Respect a turbo-or-smaller
# explicit override.
TURBO = "mlx-community/whisper-large-v3-turbo"
rt_model = realtime.get("mlx_model")
# Rewrite when unset, when it mirrors the (slow) final model, or when it is a
# non-turbo large-v3 model. A user who explicitly picked a smaller/turbo
# realtime model keeps it.
def _is_slow_large_v3(m):
    return bool(m) and "large-v3" in m and "turbo" not in m
if not rt_model or rt_model == mlx["model"] or _is_slow_large_v3(rt_model):
    realtime["mlx_model"] = TURBO
realtime.setdefault("chunk_sec", 15)
realtime.setdefault("chunk_max_sec", 30)
cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False))
PY
    ok "config.json 已设置 MLX 模型: $model"
}

# B1/B2 migration: bring an EXISTING config's realtime block onto a FAST model with
# bounded chunks. The logic used to live only in write_mlx_to_config, which was never
# called (dead code), so upgraders kept a stale large-v3 realtime model (the live tail
# falls behind wall-clock audio → long recordings get truncated) and a chunk_sec that
# could exceed chunk_max_sec (silently disabling the backlog cap). Safe for every
# engine: only rewrites a realtime block that already exists, never touches the final
# model / final_engine, idempotent.
migrate_realtime_config() {
    [[ -f "$CONFIG_DIR/config.json" ]] || return 0
    "$PYTHON_BIN" - <<PY
import json
from pathlib import Path

cfg_path = Path("$CONFIG_DIR/config.json")
try:
    cfg = json.loads(cfg_path.read_text())
except Exception:
    raise SystemExit(0)
trans = cfg.get("transcription")
if not isinstance(trans, dict):
    raise SystemExit(0)
realtime = trans.get("realtime")
if not isinstance(realtime, dict):
    raise SystemExit(0)

TURBO = "mlx-community/whisper-large-v3-turbo"
mlx = trans.get("mlx")
final_model = mlx.get("model", "") if isinstance(mlx, dict) else ""
changed = False

def is_slow_large_v3(m):
    return bool(m) and "large-v3" in m and "turbo" not in m

rt_model = realtime.get("mlx_model")
# Rewrite a stale realtime model (unset, mirrors the slow final model, or a non-turbo
# large-v3) to turbo. A user who explicitly picked a turbo/smaller model keeps it.
if realtime.get("engine") == "mlx" or rt_model is not None:
    if (not rt_model or rt_model == final_model or is_slow_large_v3(rt_model)) and realtime.get("mlx_model") != TURBO:
        realtime["mlx_model"] = TURBO
        changed = True

# Bound chunk size: chunk_max_sec must exist, and chunk_sec must never exceed it
# (otherwise the live tail reads an unbounded mega-chunk and falls behind).
cmax = realtime.get("chunk_max_sec")
if isinstance(cmax, bool) or not isinstance(cmax, (int, float)) or cmax <= 0:
    cmax = 30
    realtime["chunk_max_sec"] = cmax
    changed = True
csec = realtime.get("chunk_sec")
if isinstance(csec, bool) or not isinstance(csec, (int, float)) or csec <= 0 or csec > cmax:
    realtime["chunk_sec"] = 15 if cmax >= 15 else cmax
    changed = True

if changed:
    cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False))
PY
    ok "实时转写配置已校正（快速模型 + chunk 上限）"
}

setup_capabilities() {
    local mode="${1:-release}"   # release|dev — accepted for orchestrator parity
    : "$mode"                    # capabilities are mode-agnostic

    header "转录运行时能力检查"

    if [[ "$(uname -m)" != "arm64" ]]; then
        warn "MLX 主要支持 Apple Silicon；当前机器可能无法运行 mlx-whisper。"
    fi

    # REUSE-02 / D-04: gate on the Phase-3 tri-state. ONLY status == "usable" is a
    # reuse-and-skip (Pitfall 4 — present-but-unverified and absent BOTH fall through).
    # D-02/D-05: still no Yulu-specific venv; repairs install into the same interpreter
    # the daemon runs.
    if [[ "$(capability_status mlx_whisper)" == "usable" ]]; then
        ok "检测到可用的 mlx-whisper（复用主机的），无需 Yulu 自行提供"
    elif mlx_required; then
        install_mlx_whisper
    else
        verify_mlx_whisper
    fi

    # B1: actually run the realtime-config migration (it used to be dead code inside
    # write_mlx_to_config, which nothing called). Fixes existing upgraders whose
    # realtime block still points at the slow large-v3 model or has chunk_sec > cap.
    migrate_realtime_config
}

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && setup_capabilities "$@"
