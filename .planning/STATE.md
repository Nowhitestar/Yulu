---
gsd_state_version: 1.0
milestone: v0.5
milestone_name: milestone
status: ready_to_plan
last_updated: 2026-05-30T06:53:03.604Z
last_activity: 2026-05-30
progress:
  total_phases: 8
  completed_phases: 2
  total_plans: 10
  completed_plans: 10
  percent: 25
stopped_at: Phase 2 complete (4/4) — ready to discuss Phase 3
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-29)

**Core value:** A meeting becomes a clean, searchable note entirely on the user's machine, through the agent they already trust — capture and transcription never depend on the cloud, and Yulu never makes the user reconfigure what their agent already provides.
**Current focus:** Phase 3 — host capability detection spine

## Current Position

Phase: 3
Plan: Not started
Status: Ready to plan
Last activity: 2026-05-30

Progress: [██████████] 100%

## Performance Metrics

**Velocity:**

- Total plans completed: 10
- Average duration: — min
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 6 | - | - |
| 2 | 4 | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 1 P01 | 4 | 2 tasks | 7 files |
| Phase 01 P02 | 5 | 2 tasks | 4 files |
| Phase 01 P03 | 8 | 2 tasks | 6 files |
| Phase 01 P04 | 7 | 2 tasks | 3 files |
| Phase 01 P05 | 19 | 2 tasks | 6 files |
| Phase 01 P06 | 7 | 2 tasks | 4 files |
| Phase 02 P01 | 6 | 3 tasks | 5 files |
| Phase 02 P03 | 6 | 2 tasks | 6 files |
| Phase 02 P02 | 7min | 2 tasks | 6 files |
| Phase 02 P04 | 11 | 2 tasks | 6 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Init]: Build the cross-platform abstraction layer now (macOS-only impl) — avoid deepening lock-in.
- [Init]: Install model = agent-orchestrated provisioning (spike to validate WHO calls it — Phase 6).
- [Init]: Cloud sync = configurable data folder (Obsidian model), not a custom backend.
- [Init]: Multi-agent from v1 (Claude Code + Codex + OpenClaw) via a capability-provider abstraction.
- [Roadmap]: All three DATA requirements assigned to Phase 5 (separation-first) so the folder picker is never wired to cloud roots before content/runtime separation lands.
- [Phase 1]: [01-01] Package named yulu_platform not platform — a platform/ package on yulu/scripts (stt_daemon plist PYTHONPATH) shadows stdlib platform that numpy imports; guarded permanently by test_yulu_platform_no_shadow.py
- [Phase 1]: [01-01] Platform-seam ABCs are interface signatures only this phase (D-15); macOS impls Phase 2 (D-17); linux/windows arms raise NotImplementedError until v2 (XPLAT-01)
- [Phase ?]: [Phase 1]: [01-02] install_plist hoisted to one canonical lib/common.sh copy (§8c, D-14); §6b launch_path globs nvm node dir but never bakes a node -v version literal into the plist __PATH__
- [Phase ?]: [Phase 1]: [01-03] Entitlements XML must be comment-free — the '--' in flag names (e.g. --options) is illegal inside XML comments and breaks strict expat/plistlib parsers even though plutil tolerates it
- [Phase ?]: [Phase 1]: [01-03] _CodeSignature/CodeResources is git-tracked AND rewritten by re-signing, so both bundles' CodeResources were added to package.sh ALLOWED_BUILD_OUTPUTS; *.entitlements stay OUT of the allowlist (committed source)
- [Phase ?]: [Phase 1]: [01-04] setup_audio.sh dev/release fork (D-13): swiftc (build_audio_daemon.sh + build_status_agent.sh) runs ONLY in the dev branch; release self-heals exec bits on pre-built signed+stapled binaries — zero swiftc/xattr executable lines in the release path (asserted by plan-05 test_release_no_swiftc.py)
- [Phase ?]: [Phase 1]: [01-04] D-07 anti-pattern removed: xattr -dr com.apple.quarantine gone from setup_audio.sh's release path (stapled notarized bundle passes Gatekeeper unaided), kept only behind the --dev/ad-hoc guard
- [Phase ?]: [Phase 1]: [01-04] setup_capabilities.sh = D-01/D-02/D-03/D-05: no venv (host python3 via plist __PYTHON__), dead transcription.mlx.python dropped + stale value normalized (mlx.pop('python')), mlx-whisper VERIFIED via find_spec (warn-not-fail), no pip install (install/reuse deferred to Phase 5); setup_daemons.sh uses the hoisted install_plist (§8c)
- [Phase ?]: [Phase 1]: [01-05] setup.sh is now a thin orchestrator (D-12): resolves MODE once via resolve_install_mode, owns ALL interactive prompts, exports decisions and sequences the six setup_*.sh concerns as subprocess calls passing $MODE — swiftc reached ONLY via setup_audio.sh's dev branch
- [Phase ?]: [Phase 1]: [01-05] install.sh Xcode pre-flight gated on --dev (BUILD-03): a SINGLE --dev block wraps both xcode-select AND the git check — a release install requires neither Xcode nor git
- [Phase ?]: [Phase 1]: [01-05] orchestrator configure_transcription_engine writes only the engine+model CHOICE (record_engine_choice); concerns do the work (setup_capabilities verifies mlx, setup_models downloads GGML) — no venv (D-02), no download in orchestrator, no dead mlx.python (D-03); create_config template dropped the stale mlx.python venv path too
- [Phase ?]: [Phase 1]: [01-06] CI sole producer of signed+notarized binaries: sign_and_notarize.sh = ephemeral keychain + build_*.sh bottom-up sign + ditto + notarytool submit --wait (App Store Connect API key) + staple .app dirs before packaging (Pitfall 4); package uses --skip-build so staple survives; attest-build-provenance@v4 on the zip (BUILD-02/BUILD-04); keychain torn down if:always() (D-08)
- [Phase ?]: [Phase 1]: [01-06] Makefile package target forwards $(PACKAGE_ARGS) (default empty) so CI passes --skip-build without changing plain make package TAG=...; CI shellcheck gate uses -P SCRIPTDIR to resolve the runtime $SCRIPT_DIR/lib/common.sh source (else SC1091 fails the gate)
- [Phase ?]: [Phase 1]: [01-06] A4 (reusable-workflow OIDC permission inheritance) NOT verified — declared id-token/attestations: write on the called release-publish.yml job only; release-please.yml untouched (D-09). If first signed release fails at Attest with an OIDC error, add those two scopes to the caller publish job
- [Phase ?]: [02-01] Signature-scoped D-09 gate (inspect.signature + dataclasses.fields, never module source): base.py DependencyManager docstring names Homebrew/apt as prose, so a whole-module scan would false-positive on brew — scoping to signatures honors D-09 intent AND stays GREEN against the frozen base
- [Phase ?]: [02-01] MacOSDaemonManager.install renders ServiceSpec → launchd plist via stdlib plistlib.dump; all launchd key names + launchctl verbs confined to the macOS arm methods (D-09); status returns neutral running/stopped/unknown, never raw launchctl codes
- [Phase ?]: [02-01] PathResolver runtime_dir() kept distinct from config_dir() (equal today) so Phase 5 DATA-02 runtime/content split diverges it without touching callers; this plan adds the seam only — read-side caller routing (plist direct-launch, status_agent path) lands in 02-03
- [Phase ?]: [02-03] CaptureBackend = protocol: AnyObject hiding SCStreamConfiguration/CATapDescription/TCC behind isReady/lastError/probePermission/startCapture/stopCapture/sources()+CaptureSource (D-09); SCK arm conforms in place as ScreenCaptureKitBackend (D-03), AppDelegate.audioCapture retyped to the protocol with a 02-04 tap-arm insertion point
- [Phase ?]: [02-03] ScreenCaptureKitBackend conforms to CaptureBackend ONLY (not NSObject/SCStreamOutput as RESEARCH's idealized snippet) — the real AudioCapture delegates frame output to a separate SysAudioOutput, so conformance added without collapsing that split (true wrap-don't-rewrite)
- [Phase ?]: [02-03] com.yulu.audiodaemon.plist launches __SCRIPT_DIR__/Yulu.app/Contents/MacOS/audio_daemon directly (open -W removed, D-05); LSUIElement+setActivationPolicy(.accessory) already present so no Dock icon returns; record_audio.py socket boundary untouched
- [Phase ?]: [02-03] status_agent loadRecordingDir() returns String (not URL) to match interpolated vmDir/mvDir + NSString.expandingTildeInPath idiom; reads audio.output_dir, ~/Movies/Yulu survives only as fallback (D-07)
- [Phase ?]: [02-02] PermissionModel reads capture-permission via the existing audio_daemon.sock {action:status} liveness probe (sysReady/micReady), not a private TCC API
- [Phase ?]: [02-02] DependencyManager wraps brew but never bootstraps Homebrew (fixed RuntimeError when absent); is_available falls back which() and returns bool, never raises (PLAT-05, D-08)
- [Phase ?]: [02-02] Read-side routing only: doctor.py/repair_permissions.py consume the seams; dev_install.py/setup.sh install pipeline left intact (coexist, not rip-out)

### Pending Todos

[From .planning/todos/pending/ — ideas captured during sessions]

None yet.

### Blockers/Concerns

[Issues that affect future work]

- **External prerequisite (Phase 1): ✓ RESOLVED 2026-05-29** — Apple Developer ID is available (confirmed by Lewis). Phase 1 can ship signed/notarized binaries; Phase 1 planning should capture the exact "Developer ID Application" signing identity / Team ID and wire it into the build scripts (`YULU_CODESIGN_IDENTITY`).
- **PROJECT.md constraint decision (Phase 2):** SCK→Core-Audio-taps raises the macOS floor 13→14.4 for the audio path — decide keep-13–14.3-SCK-arm vs raise-floor and record in PROJECT.md before the tap migration lands.
- **Decision to log (Phase 1):** bundled-vs-host Python — affects signing scope and is the stable interpreter target for Phase 3 detection.
- **Spike-gated (Phase 6):** WHO calls provisioning (host agent vs `curl|bash`); step registry is BUILD NOW regardless. Exit criteria: kill-at-step-N resume + tampered-asset rejection.
- **Migration (Phase 7) — from 01-04:** `setup_capabilities.sh` stops CREATING the mlx virtualenv (D-02) but intentionally does NOT delete an existing user's. Add an upgrade migration to remove the stale `~/.config/yulu/venv-mlx-whisper` (and normalize any lingering `transcription.mlx.python` config value) so old installs don't orphan a dead venv.

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-05-30T06:42:11.321Z
Stopped at: Completed 02-03-PLAN.md (plan 3 of 4); resume at plan 4
Resume file: None
