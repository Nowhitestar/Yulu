---
gsd_state_version: 1.0
milestone: v0.5
milestone_name: milestone
status: executing
last_updated: "2026-05-30T12:38:57.230Z"
last_activity: 2026-05-30
progress:
  total_phases: 8
  completed_phases: 5
  total_plans: 25
  completed_plans: 24
  percent: 63
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-29)

**Core value:** A meeting becomes a clean, searchable note entirely on the user's machine, through the agent they already trust — capture and transcription never depend on the cloud, and Yulu never makes the user reconfigure what their agent already provides.
**Current focus:** Phase 6 — Agent-Orchestrated Provisioning + Decoupled Skill Install

## Current Position

Phase: 6 (Agent-Orchestrated Provisioning + Decoupled Skill Install) — EXECUTING
Plan: 4 of 4
Status: Ready to execute
Last activity: 2026-05-30

Progress: [██████████] 96%

## Performance Metrics

**Velocity:**

- Total plans completed: 21
- Average duration: — min
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 6 | - | - |
| 2 | 4 | - | - |
| 3 | 3 | - | - |
| 4 | 4 | - | - |
| 5 | 4 | - | - |

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
| Phase 03 P01 | 9 | 2 tasks | 5 files |
| Phase 03 P02 | 5 | 1 tasks | 3 files |
| Phase 03 P03 | 12 | 1 tasks | 2 files |
| Phase 04 P01 | 13 | 2 tasks | 5 files |
| Phase 04 P02 | 5 | 2 tasks | 4 files |
| Phase 04 P03 | 4min | 2 tasks | 4 files |
| Phase 04 P04 | 3 | 2 tasks | 4 files |
| Phase 05 P01 | 17 | 2 tasks | 6 files |
| Phase 05 P02 | 13 | 3 tasks | 5 files |
| Phase 05 P03 | 11 | 2 tasks | 3 files |
| Phase 05 P04 | 13min | 3 tasks | 7 files |
| Phase 06 P01 | 11 | 2 tasks tasks | 3 files files |
| Phase 06 P02 | 16 | 2 tasks | 4 files |
| Phase 06 P03 | 8min | 2 tasks | 3 files |

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
- [Phase ?]: [03-01] daemon_python() mirrors lib/common.sh:124 (PYTHON_BIN -> which python3 -> /usr/bin/python3) — the ONE canonical interpreter resolves DETECT-04; mlx-whisper importability is probed against IT via subprocess
- [Phase ?]: [03-01] HostCapabilityReport.to_dict() coerces Provenance/Status enums to .value strings — JSON carries human strings, structurally never a bool for status (D-01/D-08)
- [Phase ?]: [03-01] probe_llm_command RESOLVES+STATS the configured command head only, never executes it (T-03-01); scan_models globs 3 fixed roots + dedupes by resolved path (T-03-03); every probe degrades to absent() not raise
- [Phase 03]: [03-02] CapabilityProvider ABC = agent_name (plain class attribute) + a SINGLE @abstractmethod capabilities() -> dict[str, Capability]; agent-neutral by contract so a second provider (Phase 8 Codex/OpenClaw) is pure addition — a subclass + one default_providers() entry, zero edits to report.py/probes.py/doctor.py (D-06)
- [Phase 03]: [03-02] _as_agent_config relabels host-path->agent-config provenance ONLY for present/usable entries; an ABSENT probe finding passes through unchanged — a provider reframes a tool as 'the host coding agent provides this' only when it actually exists, never disguises a missing tool. ClaudeCodeProvider delegates to Plan 01 probes (no new exec surface, T-03-05); keys: claude_cli + agent_mlx_whisper
- [Phase ?]: [03-03] doctor host_capabilities = lazy-import + never-raise helper (mirrors check_search_index): assembles HostCapabilityReport from Plan 01's six probes + merges default_providers() agent-config entries; degrades to {error, schema_version, capabilities} so it never raises/hangs doctor (T-03-07)
- [Phase ?]: [03-03] §5d fixed: check_yulu_ui now receives runtime_root not source_root so a production install reports the running UI dist honestly (D-07); host_capabilities is purely additive (existing report shape intact, _overall_ok untouched)
- [Phase ?]: [04-01] capabilities tRPC router shells ONLY doctor.py --json (T-04-EX): never executes config.llm.command/cloud_command; 10s timeout+SIGKILL (T-04-DOS); degrades to typed {error,schema_version,capabilities:{}} so a doctor failure never blanks the settings page
- [Phase ?]: [04-01] list_models() is an ADDITIVE sibling to scan_models (Phase 3 frozen contract preserved byte-for-byte): per-model {name,path,size} over the same fixed _model_roots() allowlist + resolve-dedupe; detection stays in Python (one-way layer dep), router never re-globs in TS
- [Phase ?]: [04-01] Python tests live at repo-root tests/ (make pytest = 'pytest tests'), NOT yulu/scripts/tests/ — a test under the latter would never run in CI (deviation Rule 3)
- [Phase ?]: [Phase 04]: [04-02] CapabilitiesSection is the first UI consumer of the Phase 3 host_capabilities report — renders provenance label (D-02 copy) + resolved_path + a tri-state .cap-badge[data-status] pill; report strings are JSX text children only (T-04-XSS, no dangerouslySetInnerHTML)
- [Phase ?]: [Phase 04]: [04-02] Read-only settings sections take NO tracker prop (CapabilitiesSection omits SettingsRestartTracker); only config-writing sections carry it. statusLabel('absent')='absent' kept distinct from the 'not found' provenance label
- [Phase ?]: [Phase 04]: [04-02] Slotting a new section into settings.tsx requires extending tests/web/routes/settings.test.tsx (consolidated render): add the section's trpc mock path + its heading/anchor, else the whole Settings render crashes (deviation Rule 1/3)
- [Phase 04]: [04-03] TranscriptionSection extended (D-03/D-04/D-05, D-07 extend-not-replace): mode radios (local default/cloud-fallback/cloud-priority -> transcription.mode) + cloud COMMAND via CommandEditor (-> transcription.cloud_command, llm.command trust model, NO key) + detected-model selector (trpc.capabilities.detected_models -> transcription.local_model_path); both new keys map to restart:sttdaemon in RESTART_MAP
- [Phase 04]: [04-03] Keyless-cloud guardrail (T-04-KEY, HIGH) enforced by TWO tests: source-grep over config.ts (no api_key/token/secret/password identifier) AND a rendered no-key invariant in TranscriptionSection.test.tsx (no type=password, no api-key/token/secret label/placeholder/text). cloud_command is a SEPARATE key from pre-existing transcription.command (classify longest-prefix match, no collision)
- [Phase 04]: [04-03] Model-selector persists to one deterministic key transcription.local_model_path (list_models returns whisper model FILES .bin/.gguf/.safetensors, matching existing Local-model-path filter=bin row); empty detected_models -> disabled 'no models detected' select. Recurring trap re-hit: adding a new trpc query (detected_models) to a section crashes tests/web/routes/settings.test.tsx until its mock path is added (deviation Rule 1/3)
- [Phase 04]: [04-04] Onboarding first-run gating uses BOTH localStorage (synchronous short-circuit, no-flash) + config.onboarding_dismissed (durable): dismissed = localFlag || cfg.onboarding_dismissed === true -> renders null (never forced, SET-03)
- [Phase 04]: [04-04] Onboarding Skip hides immediately via local state then awaits config.update (skip-without-complete); a config-write failure can't re-show it because localStorage already gates it. Mounted self-gating in RootLayout (sibling of Pill), not a route
- [Phase ?]: [05-01] runtime_dir() LOCKED machine-local (never reads audio.output_dir), stays ~/.config/yulu — NOT relocated (Pitfall 1: churn vs 38+ callers); data_dir() is the only configurable content root
- [Phase ?]: [05-01] Runtime lock framed as SQLite-WAL corruption + file eviction, never 'sockets can't exist in a synced folder' (Pitfall 3: a socket CAN bind under iCloud, verified on-device)
- [Phase ?]: [05-01] 3 content literals (search CORPUS_ROOT, voicemail VOICEMAIL_DIR_DEFAULT, record_audio output_dir fallback) route via _resolve_data_dir(); SEARCH_DB_PATH stays on runtime_dir(); helpers degrade to historical literal off-Darwin; assert_runtime_not_synced lazily imports cloud_detect (Plan 03 same-wave) and no-ops until it lands
- [Phase ?]: [05-02] gog added as a host CLI (host-path) in doctor.py _host_capabilities, NOT a CapabilityProvider entry — D-06 provider neutrality preserved; closes RESEARCH Open-Q1 (gog was absent from the Phase-3 report)
- [Phase ?]: [05-02] Reuse gate is STRICT string-equality on status == usable (capability_status whisper_cli/gog/mlx_whisper); present-but-unverified AND absent both install — no boolean collapse, no -n/!=absent (Pitfall 4, report.py:35)
- [Phase ?]: [05-02] capability_status() reads host_capabilities.capabilities.<cap>.status from doctor.py --json with FIXED argv + Python JSON parse; echoes only status, never interpolates resolved_path into a shell (T-05-04 resolve-not-execute); any failure -> absent -> install (safe default)
- [Phase ?]: [05-02] setup_capabilities.sh mlx gate changes only the MESSAGE (reuse vs advise) — NO venv, NO pip install on either branch (D-02/D-05; a second Yulu-specific venv is Out-of-Scope)
- [Phase ?]: [05-03] cloud_detect eviction uses stat.SF_DATALESS (0x40000000), NEVER os.getxattr (absent on macOS CPython, Pitfall 2); detection is metadata-only (os.stat, no open) — never materializes a dataless file
- [Phase ?]: [05-03] cloud.detect tRPC route passes the user path as a SEPARATE spawn argv element (sys.argv[1]), never shell-interpolated (T-05-07, verified an adversarial $(touch) path did not execute); degrades to a typed not-cloud default so detection never blocks the folder picker
- [Phase ?]: [05-03] cloud_detect.py is pure stdlib with NO Darwin gate at import (imports on any OS); CloudRootResult(is_cloud,engine,reason,dataless_sample) is the shared contract for the runtime-lock guard AND the UI route; landing it unskipped 05-01's assert_runtime_not_synced guard tests
- [Phase 05]: [05-04] audio.output_dir -> restart:audiodaemon: the audio daemon caches RECORDING_DIR at start and no plist injects YULU_OUTPUT_DIR, so a data-folder change needs a daemon restart, not SIGHUP/plist re-render (RESEARCH Pitfall 5)
- [Phase 05]: [05-04] folder picker calls cloud.detect imperatively via trpc.useUtils().system.cloud.detect.fetch(), gated on mode=folder; a detected cloud root shows an inline eviction/corruption warning and commits only on opt-in; detection failure degrades to immediate commit (detect-and-warn, NOT block - D-03)
- [Phase 05]: [05-04] trpc.useUtils() is now part of InlineEditRow.PathValue render: every test rendering a path-type InlineEditRow must mock useUtils().system.cloud.detect.fetch (extends the 04-02/04-03 consolidated-render mock trap)
- [Phase ?]: [06-01] provision/ registry WRAPS the six setup_*.sh 1:1 via argv-list subprocess (no shell); StepResult frozen dataclass {name,status in ok|skipped|error,detail}; apply() short-circuits to skipped when read-only check() satisfied (idempotency contract for 06-02 resume); zero bash logic ported (D-01/D-06)
- [Phase ?]: [06-01] uv/uvx DEFERRED (D-07) recorded in module docstring (host python3 locked, stdlib-only); six check() probes degrade to False never raise; models probe treats engine==mlx as done; step_by_name fixed-table dispatch raises on unknown name (T-06-02)
- [Phase ?]: [06-02] provision/state.py = atomic .yulu-install.json ledger (mkstemp+os.replace mirror of queue_store); mark(running) BEFORE apply / mark(ok) AFTER so a SIGKILL re-runs exactly the killed step and only steps after it; state.py provides primitives only (mark/is_done/resume_order), the walk loop is the Plan-04 driver — no REGISTRY import
- [Phase ?]: [06-02] mark() preserves _INSTALLER_KEYS (source/version/sha256/installed_at) via setdefault (Pitfall 3 / T-06-07): a dropped source flips lib/common.sh:detect_source into the swiftc dev branch; schema_version:2 ADDED alongside installer schema:1; missing steps OR corrupt ledger => fresh (NOT a migration; D-08)
- [Phase ?]: [06-03] attest.py gate fail-closed: gh-present-AND-(verify==0)->attestation (NOT command -v gh — unauthed gh exit-4s, cli/cli #11803); gh exit-4 OR absent->SHA-256 checksums.txt floor (fallback, NOT a rejection); non-4 nonzero on authed gh->corroborate-with-checksum-or-REJECT (never silent downgrade, T-06-12); TamperError raised BEFORE any step.apply() (D-03). Reuses release_installer.verify_checksum/parse_checksums (no hand-rolled crypto). CLI skips gate when no --asset (installed-tree integrity established at install)

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

Last session: 2026-05-30T12:37:04.394Z
Stopped at: Completed 05-02-PLAN.md (plan 2 of 4); resume at plan 3
Resume file: None
