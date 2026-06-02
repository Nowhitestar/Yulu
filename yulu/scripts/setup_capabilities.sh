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
        ok "mlx-whisper 可从系统 python3 导入（${PYTHON_BIN}）"
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

setup_capabilities() {
    local mode="${1:-release}"   # release|dev — accepted for orchestrator parity
    : "$mode"                    # capabilities are mode-agnostic

    header "转录运行时能力检查"

    if [[ "$(uname -m)" != "arm64" ]]; then
        warn "MLX 主要支持 Apple Silicon；当前机器可能无法运行 mlx-whisper。"
    fi

    # REUSE-02 / D-04: gate on the Phase-3 tri-state. ONLY status == "usable" is a
    # reuse-and-skip (Pitfall 4 — present-but-unverified and absent BOTH fall through
    # to the advisory verify; never a boolean collapse). D-02/D-05: this gate changes
    # only the MESSAGE — there is NO venv creation and NO pip install on either branch
    # (the install/reuse decision for MLX is "reuse-or-advise", a second Yulu-specific
    # venv is Out-of-Scope). A doctor error degrades to `absent` → the advisory warn.
    if [[ "$(capability_status mlx_whisper)" == "usable" ]]; then
        ok "检测到可用的 mlx-whisper（复用主机的），无需 Yulu 自行提供"
    else
        # NO venv, NO pip install — just verify importability from the system
        # interpreter the daemon will actually use, and WARN (advisory) if absent.
        verify_mlx_whisper
    fi
}

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && setup_capabilities "$@"
