#!/usr/bin/env bash
#
# setup_audio.sh — audio-binary placement + TCC permission walkthrough concern
# (extracted from setup.sh::compile_audio_daemon 402-494 and setup_audio 145-160).
#
# This is the most-changed extraction because of the dev/release fork (D-13):
#
#   dev mode     → run build_audio_daemon.sh (swiftc) and build_status_agent.sh.
#                  This is the ONLY place swiftc may run (BUILD-03).
#   release mode → binaries are pre-built + signed + stapled in CI and shipped in
#                  the release zip. We only self-heal exec bits (release zips drop
#                  +x — load-bearing) and DO NOT run swiftc.
#
# Removed from the release path (RESEARCH anti-pattern, D-07): the
# `xattr -dr com.apple.quarantine` strip. A stapled, notarized bundle passes
# Gatekeeper on its own — the strip was a smell that masked un-notarized binaries.
# It is kept ONLY behind the explicit dev guard (ad-hoc-signed dev builds still
# benefit from it).
#
# Kept (Runtime State Inventory): the TCC reset + re-prompt walkthrough. The
# signing-identity change (Apple Development → Developer ID) + newly-enabled
# hardened runtime can invalidate existing Microphone/ScreenCapture grants; this
# reset path is what re-prompts. The whole walkthrough is Darwin-gated.
#
# Standalone invocation is non-interactive (Pitfall 5). State that the monolith
# carried as shared globals (UPGRADE_MODE / SCRIPT_DIR / LAUNCH_AGENTS_DIR) is
# taken via env with safe defaults so `set -u` standalone calls don't crash.
#
# shellcheck source=lib/common.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# State taken via env/arg, NOT monolith globals (Pitfall 5).
UPGRADE_MODE="${UPGRADE_MODE:-false}"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/yulu}"

setup_audio() {
    local mode="${1:-release}"   # release|dev — orchestrator resolves & passes

    header "音频配置与签名"

    echo "  Yulu 默认使用原生 macOS ScreenCaptureKit + AVFoundation。"
    echo "  不需要 BlackHole、多输出设备或虚拟声卡。"
    echo

    # Release zips lose Unix exec bits (Python zipfile.extractall drops them), so
    # the prebuilt .app binaries can land as 0644 and launchd then fails to spawn
    # them ("Launchd job spawn failed"). Re-assert +x up front so release installs
    # and `yulu update` self-heal regardless of which release_installer extracted.
    local _bin
    for _bin in "$SCRIPT_DIR/Yulu.app/Contents/MacOS/audio_daemon" \
                "$SCRIPT_DIR/StatusAgent.app/Contents/MacOS/status_agent"; do
        [[ -f "$_bin" ]] && chmod +x "$_bin"
    done

    if [[ "$mode" == "dev" ]]; then
        # DEV: compile from source. This is the ONLY branch that may invoke swiftc
        # (via build_audio_daemon.sh / build_status_agent.sh) — D-13 / BUILD-03.
        local build_script="$SCRIPT_DIR/build_audio_daemon.sh"
        if [[ -x "$build_script" ]]; then
            # Gate the success message on the build's ACTUAL exit code (set -uo
            # pipefail here does NOT abort on a failed command). A swallowed failure
            # leaves Yulu.app linker-ad-hoc WITHOUT entitlements → mic/system capture
            # fail at runtime while setup falsely reports "signed".
            if "$build_script"; then
                ok "Yulu.app 已编译并签名（dev）"
            else
                warn "Yulu.app 编译/签名失败 — 麦克风/系统音频捕获将不可用。"
                warn "  常见原因：codesign 身份歧义。看上面的 codesign 报错。"
            fi
        else
            warn "Yulu.app 的 build script 不存在或不可执行，跳过"
        fi

        # Dev builds are ad-hoc-signed, so strip Gatekeeper quarantine to avoid the
        # "cannot verify developer" dialog that LSUIElement apps swallow silently.
        # Release builds are notarized + stapled and need NO strip (anti-pattern).
        xattr -dr com.apple.quarantine "$SCRIPT_DIR/Yulu.app" 2>/dev/null || true

        # Build the status agent bundle (dev only — swiftc). Skip silently if the
        # build script hasn't shipped, keeping the rest of setup usable.
        local sa_build="$SCRIPT_DIR/build_status_agent.sh"
        if [[ -x "$sa_build" ]]; then
            info "Building StatusAgent.app..."
            if bash "$sa_build" >/dev/null 2>&1; then
                ok "StatusAgent.app built"
            else
                warn "StatusAgent.app build failed (continuing — status agent will be unavailable)"
            fi
        fi
    else
        # RELEASE: binaries are pre-built + signed + stapled in CI and shipped in
        # the zip. NO swiftc, NO xattr quarantine strip — the stapled notarized
        # bundle passes Gatekeeper unaided. The exec-bit self-heal loop above is
        # all the release path needs.
        if [[ -f "$SCRIPT_DIR/Yulu.app/Contents/MacOS/audio_daemon" ]]; then
            ok "Yulu.app: 使用发布包内已签名+公证的二进制（不编译）"
        else
            warn "Yulu.app 二进制缺失；请确认发布包完整或使用 --dev 从源码编译"
        fi
    fi

    # ─── TCC reset + re-prompt walkthrough (Darwin-gated) ────────────────
    # macOS-only: TCC, tccutil, open Yulu.app, and the audio_daemon socket probe
    # do not exist off-Darwin. Skip the whole walkthrough elsewhere.
    if [[ "$(uname -s)" != "Darwin" ]]; then
        info "非 macOS 平台，跳过 TCC 权限引导"
        return 0
    fi

    # On upgrade, if TCC is already granted and the daemon answers status, skip the
    # interactive permission walkthrough — but ALWAYS restart the daemon so it
    # actually picks up the freshly built binary. (`launchctl unload` of an
    # `open -W Yulu.app` job doesn't kill the LSUIElement child process, so the
    # old binary keeps running unless we pkill it explicitly.)
    if [[ "$UPGRADE_MODE" == true ]]; then
        local existing
        existing=$(echo '{"action":"status"}' | nc -w 2 -U "$CONFIG_DIR/audio_daemon.sock" 2>/dev/null || true)
        if echo "$existing" | grep -q '"sysReady":true' && echo "$existing" | grep -q '"micReady":true'; then
            info "重载 daemon 让它跑新 binary（TCC 状态保留）..."
            pkill -f "Yulu.app/Contents/MacOS/audio_daemon" 2>/dev/null || true
            sleep 2
            # launchd KeepAlive=true 会自动重启 daemon。如果 plist 已 unload（极端情况），
            # 我们手动 open。
            if ! pgrep -f "Yulu.app/Contents/MacOS/audio_daemon" >/dev/null 2>&1; then
                open "$SCRIPT_DIR/Yulu.app"
                sleep 3
            fi
            ok "麦克风 + 屏幕录制权限已就绪；daemon 已重载"
            return 0
        fi
    fi

    echo
    echo "  Yulu.app 负责捕获系统音频和麦克风。"
    echo "  首次使用需要授权：系统设置 → 隐私与安全性 → 屏幕与系统音频录制 / 麦克风。"
    echo "  如果系统弹出权限对话框，请点击「允许」。"

    # Reset TCC for the audio daemon's bundle id so macOS will (re)prompt the user
    # for Microphone + Screen Recording instead of silently honoring a previously-
    # denied state. This matters in three cases:
    #   - User accidentally clicked "Don't Allow" the first time.
    #   - Bundle id changed across versions (carry-over from old TCC entries).
    #   - The signing identity changed (Apple Development → Developer ID) and/or
    #     hardened runtime was newly enabled — TCC is keyed on bundle id + signing
    #     identity, so the change can invalidate an existing grant (this phase).
    # If the user already granted, macOS just re-prompts and they accept again —
    # one extra click vs. being silently broken.
    # The daemon must be stopped before reset, otherwise the new request goes
    # against the already-running process and the prompt is suppressed.
    launchctl unload "$LAUNCH_AGENTS_DIR/com.yulu.audiodaemon.plist" 2>/dev/null || true
    pkill -f "Yulu.app/Contents/MacOS/audio_daemon" 2>/dev/null || true
    sleep 1
    tccutil reset ScreenCapture com.yulu.audiodaemon 2>/dev/null || true
    tccutil reset Microphone com.yulu.audiodaemon 2>/dev/null || true

    open "$SCRIPT_DIR/Yulu.app"
    sleep 4
    local status
    status=$(echo '{"action":"status"}' | nc -w 2 -U "$CONFIG_DIR/audio_daemon.sock" 2>/dev/null || true)
    if echo "$status" | grep -q '"sysReady":true' && echo "$status" | grep -q '"micReady":true'; then
        ok "Yulu 捕获权限正常"
    else
        warn "Yulu 尚未 ready: $status"
        warn "如果系统弹出了权限对话框但你来不及点，跑下面这行重新弹一次："
        warn "  tccutil reset ScreenCapture com.yulu.audiodaemon && open '$SCRIPT_DIR/Yulu.app'"
    fi
}

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && setup_audio "$@"
