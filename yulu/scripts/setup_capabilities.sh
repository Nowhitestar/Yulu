#!/usr/bin/env bash
#
# setup_capabilities.sh — transcription-runtime capability concern
# (extracted from setup.sh::install_mlx_whisper 607-619 and
# write_mlx_to_config 710-733). This is where D-01/D-02/D-03/D-05 land.
#
# What changed vs the monolith:
#   D-02  No more venv. The monolith created a dedicated mlx virtualenv under
#         ~/.config/yulu/ and pip-installed mlx-whisper into it. That whole body
#         is REMOVED. (We do NOT delete an existing user's virtualenv —
#         orphaned-virtualenv cleanup is a Phase 7 migration concern; we just stop
#         creating a new one.)
#   D-01  The daemon interpreter is the host system python3 that the launchd plist
#         launches via the __PYTHON__ token (set by setup_daemons.sh / lib/common.sh).
#         This script points config at that interpreter; it does not bundle one.
#   D-03  write_mlx_to_config no longer writes a venv path into
#         transcription.mlx.python. The dead field is dropped. stt_daemon/config.py
#         reads mlx.python only `if mlx.get("python")`, so an absent field is
#         harmlessly ignored (mlx_python defaults to "").
#   D-05  Phase 1's contract is VERIFY mlx-whisper importability from the system
#         interpreter and WARN if absent — NOT install it. The install-vs-reuse
#         decision is Phase 5 (REUSE-02). The check is advisory: a missing
#         mlx-whisper does NOT fail the install.
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

# Verify (not install) that mlx-whisper is importable from the daemon interpreter.
# D-05: advisory only — warn if absent, never fail the install. The install/reuse
# decision is Phase 5 (REUSE-02). Uses the inline-python3-from-bash idiom; the
# module's import name is `mlx_whisper` (underscore), not the pip name `mlx-whisper`.
verify_mlx_whisper() {
    if "$PYTHON_BIN" -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('mlx_whisper') else 1)" 2>/dev/null; then
        ok "mlx-whisper 可从系统 python3 导入（$PYTHON_BIN）"
    else
        warn "系统 python3 ($PYTHON_BIN) 无法导入 mlx-whisper。"
        warn "MLX 转录将不可用，直到它在该解释器中可用（安装/复用的决策属于 Phase 5）。"
        warn "whisper.cpp 路径不受影响。"
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
realtime["mlx_model"] = "$model"
cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False))
PY
    ok "config.json 已设置 MLX 模型: $model"
}

setup_capabilities() {
    local mode="${1:-release}"   # release|dev — accepted for orchestrator parity
    : "$mode"                    # capabilities are mode-agnostic

    header "转录运行时能力检查"

    if [[ "$(uname -m)" != "arm64" ]]; then
        warn "MLX 主要支持 Apple Silicon；当前机器可能无法运行 mlx-whisper。"
    fi

    # D-02/D-05: NO venv creation, NO pip install. Just verify importability from
    # the system interpreter the daemon will actually use.
    verify_mlx_whisper
}

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && setup_capabilities "$@"
