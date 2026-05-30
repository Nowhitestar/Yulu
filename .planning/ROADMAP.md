# Roadmap: Yulu — Agent-Native Provisioning & Cross-Platform Foundation

## Overview

This is a brownfield re-architecture milestone. Yulu already ships (8 launchd daemons, Swift `audio_daemon`, Hono+tRPC+React UI, SQLite, MLX/whisper.cpp, release-please). The milestone adds three new horizontal layers above the unchanged runtime — a **platform-abstraction layer** (macOS impl now, Linux/Windows stubbed), an **agent-capability layer** (detect-and-reuse what the host agent already has), and an **agent-orchestration surface** (the host agent provisions Yulu via named, idempotent steps) — while fixing a catalogue of pre-existing fragilities. The journey runs detection-first along a strict one-way layer dependency (`provision/` → `capabilities/` → `platform/` → existing runtime): unblock signed pre-built binaries (Phase 1), lay the platform seams (Phase 2), build the `HostCapabilityReport` spine every consumer binds to (Phase 3), surface it in the UI (Phase 4), reuse host capabilities and safely separate syncable content from machine-local runtime (Phase 5), compose it all as an agent-orchestrated step registry (Phase 6), migrate existing installs without data loss (Phase 7), and generalize to all three agents (Phase 8).

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Build Foundation — Setup Decomposition + Signed/Notarized Binaries** - Decompose `setup.sh`, ship Developer ID signed + notarized pre-built binaries, CI attestations, introduce platform ABCs (completed 2026-05-30)
- [x] **Phase 2: Platform-Abstraction Seams** - `PathResolver`, `DaemonManager`, `PermissionModel`, `DependencyManager`, and the Swift `CaptureBackend` (SCK→Core-Audio-tap) behind neutral interfaces (completed 2026-05-30)
- [x] **Phase 3: Host-Capability Detection Spine** - `doctor.py` produces the versioned, tri-state, provenance-labeled `HostCapabilityReport`; `CapabilityProvider` interface + ClaudeCode end-to-end (completed 2026-05-30)
- [x] **Phase 4: Settings & Onboarding Surface** - tRPC capability endpoint, provenance-labeled settings, transcription-mode radios, model selector, skippable browser onboarding (completed 2026-05-30)
- [x] **Phase 5: Capability Reuse + Data-Folder / Cloud-Sync Safety** - Detect-first reuse of host whisper/models/`claude`/`gog`; physically separate syncable content from local-only runtime; cloud-root detect-and-warn folder picker (completed 2026-05-30)
- [x] **Phase 6: Agent-Orchestrated Provisioning + Decoupled Skill Install** - Named idempotent step registry, `yulu provision <step>`, attestation gate, resumable state, `yulu skill install --agent`; spike validates WHO calls provisioning (completed 2026-05-30)
- [ ] **Phase 7: Seamless Auto-Migration** - `yulu migrate` detect→plan→apply→verify with recording-guard, transactional rollback, and bounded backup lifecycle
- [ ] **Phase 8: Multi-Agent Providers (Codex + OpenClaw)** - Generalize the proven ClaudeCode provider to complete the multi-agent-from-v1 lock

## Phase Details

### Phase 1: Build Foundation — Setup Decomposition + Signed/Notarized Binaries

**Goal**: Release installs ship trustworthy, pre-built signed binaries with no `swiftc`/Xcode on the user's machine, and the install flow is decomposed into per-concern, individually testable scripts — the shared prerequisite that unblocks agent provisioning.
**Depends on**: Nothing (first phase)
**Requirements**: BUILD-01, BUILD-02, BUILD-03, BUILD-04
**Success Criteria** (what must be TRUE):

  1. A user installs a release without Xcode/`swiftc` present and capture, transcription, and daemons all run from pre-built binaries
  2. A notarized build passes `spctl -a -vvv` on a clean second machine (no Gatekeeper warning, no `xattr` quarantine-strip needed)
  3. Each former `setup.sh` concern (audio / models / daemons / capabilities) runs as its own script under `set -uo pipefail`, and any single failing step is visible and re-runnable in isolation
  4. A release asset's integrity verifies via `gh attestation verify` against Yulu's own CI
  5. `platform/base.py` exposes the platform ABCs with `linux/` and `windows/` arms raising `NotImplementedError`**Plans**: 6 plans (3 waves)

**Wave 1**

- [x] 01-01-PLAN.md — Python platform-seam ABCs (yulu_platform) + stub/shadow tests (SC-5)
- [x] 01-02-PLAN.md — lib/common.sh shared helpers + extract deps/models/ui concerns (BUILD-01)
- [x] 01-03-PLAN.md — entitlements + bottom-up hardened-runtime signing of both build_*.sh (BUILD-02 sign-side)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-04-PLAN.md — extract audio (dev/release fork)/capabilities (no venv)/daemons concerns (BUILD-01, BUILD-03)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-05-PLAN.md — thin orchestrator + install.sh Xcode gate + decomposition/no-swiftc tests (BUILD-03)
- [x] 01-06-PLAN.md — CI notarize+staple+attest + shellcheck/bash-n gates [checkpoint] (BUILD-02 notarize, BUILD-04)

**Research**: standard pattern (skip research-phase) — Apple's signing/notarization workflow and the anti-patterns (`--deep`, `--timestamp=none`) are well-documented; execution, not research.
**Prerequisite (external)**: ✓ Apple Developer ID available (confirmed 2026-05-29). Phase 1 planning should capture the exact "Developer ID Application" signing identity / Team ID and wire it via `YULU_CODESIGN_IDENTITY`.
**Decision to log**: bundled-vs-host Python must be decided and recorded here (recommend host-provided — sidesteps the hardest notarization case and is the stable interpreter target for Phase 3 detection).

### Phase 2: Platform-Abstraction Seams

**Goal**: Every macOS-coupled concern (paths, daemon supervision, permissions, dependencies, audio capture) sits behind a neutral interface with a clean macOS implementation, so daemon stop leaves zero orphan processes and a future Linux/Windows arm is pure addition.
**Depends on**: Phase 1
**Requirements**: PLAT-01, PLAT-02, PLAT-03, PLAT-04, PLAT-05
**Success Criteria** (what must be TRUE):

  1. No hardcoded `~/Movies/Yulu` / `~/.config/yulu` remains; `status_agent.swift` reads `config.json` and all daemons resolve locations through `PathResolver`
  2. Stopping the audio daemon via `DaemonManager` leaves zero lingering processes (the `open -W` orphan is gone; the binary launches directly)
  3. On macOS 14.4+, system audio is captured via Core Audio process taps with no weekly re-permission nag; on 13–14.3 the ScreenCaptureKit arm runs behind the same `if #available` seam (or the floor is explicitly raised — see PROJECT.md update)
  4. The platform interfaces carry no leaked macOS vocabulary (no plist keys / `SCStreamConfiguration` / TCC scopes in signatures) — a reviewer confirms a systemd arm could implement the same methods
  5. `PermissionModel` and `DependencyManager` expose macOS implementations with TCC calls gated behind a Darwin check

**Plans**: 4 plans (3 waves)

**Wave 1** *(parallel: Python seams ∥ Swift capture — no file overlap)*

- [x] 02-01-PLAN.md — MacOSPathResolver + MacOSDaemonManager + Wave-0 conformance/neutrality scaffold (PLAT-03, PLAT-04, D-04/D-06/D-09)
- [x] 02-03-PLAN.md — Swift CaptureBackend protocol + SCK-arm wrap + status_agent config.json fix + direct-launch plist (PLAT-01, PLAT-03, PLAT-04, D-02/D-03/D-05/D-07)

**Wave 2** *(blocked on 02-01: shares macos/__init__.py + the conformance test)*

- [x] 02-02-PLAN.md — MacOSPermissionModel + MacOSDependencyManager (Darwin-gated) + route doctor/repair_permissions through the seams (PLAT-05, D-08)

**Wave 3** *(blocked on 02-03: shares audio_daemon.swift; has the blocking human-verify)*

- [x] 02-04-PLAN.md — Core Audio process-tap arm (14.4+) behind if #available + NSAudioCaptureUsageDescription/entitlement/frameworks + VM/clean-machine validation checkpoint (PLAT-02, D-01/D-03/D-05) [checkpoint]
**Research**: needs deeper per-phase research (Core-Audio-taps migration) — the SCK→tap swap is HIGH-confidence on the API but must be tested on 14.2 and 13.x VMs to verify the version gate + fallback (the dev's machine never reproduces the failure).
**PROJECT.md update needed**: the SCK→Core-Audio-taps swap raises the effective macOS floor 13→14.4 for the audio path — keeping the 13–14.3 SCK arm vs raising the floor is a **constraint decision** to record in PROJECT.md, not an eng choice.
**Parallelization**: the Swift `CaptureBackend` seam (ARCH #10) is independent of the Python detection/provisioning stack and can proceed in parallel after Phase 1 — they meet only at the `record_audio.py ↔ CaptureBackend` boundary.

### Phase 3: Host-Capability Detection Spine

**Goal**: `doctor.py` produces a single versioned `HostCapabilityReport` that honestly reflects what the daemon can actually use, with per-capability provenance and tri-state status — the foundational dependency four downstream consumers bind to.
**Depends on**: Phase 2 (reads `PathResolver`)
**Requirements**: DETECT-01, DETECT-02, DETECT-03, DETECT-04, DETECT-05
**Success Criteria** (what must be TRUE):

  1. Running `yulu doctor` emits a versioned `HostCapabilityReport` JSON with per-capability provenance (host-path / yulu-managed / agent-config / absent) and tri-state status (usable / present-but-unverified / absent)
  2. A binary present only on the login-shell PATH (not launchd's minimal PATH) is correctly resolved, and a Python package is probed via the daemon's own interpreter — so "usable" means usable by the consumer, not by the dev's shell
  3. The report covers `claude` CLI, `whisper-cli`, `mlx-whisper` importability, configured `llm.command` validity, model paths/sizes, and recording-dir writability
  4. The `mlx_python` interpreter ambiguity is resolved so a green "usable" whisper actually transcribes (no silent first-recording failure)
  5. A `CapabilityProvider` interface exists with a ClaudeCode implementation working end-to-end into the report

**Plans**: 3 plans (3 waves)

**Wave 1**

- [x] 03-01-PLAN.md — capabilities/report.py versioned tri-state HostCapabilityReport schema + probes.py (login-shell PATH, daemon-interpreter import, llm.command validity, model scan, recording-dir writability) (DETECT-01/02/03/04, D-01..D-05/D-08)

**Wave 2** *(blocked on 03-01: imports report.py types + probes)*

- [x] 03-02-PLAN.md — capabilities/provider.py CapabilityProvider ABC + ClaudeCodeProvider end-to-end (agent-config provenance; designed so Phase 8 Codex/OpenClaw is pure addition) (DETECT-05, D-06)

**Wave 3** *(blocked on 03-01 + 03-02: assembles the report in doctor)*

- [x] 03-03-PLAN.md — doctor.py host_capabilities section (probes + default_providers aggregation) + §5d source-vs-runtime root fix (DETECT-01/03/05, D-05/D-07)
**Research**: standard pattern (skip research-phase) — the report schema, login-shell PATH, and tri-state are well-specified across STACK/ARCHITECTURE/PITFALLS; schema design, not research.
**Hard prerequisite (in-phase)**: resolve the `mlx_python` interpreter ambiguity (DETECT-04) before or within this phase — detection is meaningless without a defined "daemon interpreter" to probe. Tri-state must land here so a boolean never drives a "skip install" decision downstream.

### Phase 4: Settings & Onboarding Surface

**Goal**: The web UI becomes the first consumer of the capability report — surfacing each capability's provenance and letting the user configure transcription mode and model selection — and a skippable first-run walkthrough shows live permission status. This proves the report schema end-to-end.
**Depends on**: Phase 3 (consumes the `HostCapabilityReport`)
**Requirements**: SET-01, SET-02, SET-03, SET-04, TRANS-01, TRANS-02
**Success Criteria** (what must be TRUE):

  1. The settings page loads the doctor report via a `host_capabilities` tRPC endpoint and shows each capability's provenance ("reused from your PATH" vs "Yulu-managed") with its resolved path
  2. A user can set transcription mode to local (default), cloud-fallback, or cloud-priority, and the choice persists to config
  3. Cloud transcription uses the user's own configured command (same trust model as `llm.command`); Yulu holds and asks for no cloud keys
  4. A user can pick among the whisper models the report detected across host caches
  5. A first-time user sees a skippable browser onboarding walkthrough that reflects live permission status, and can dismiss it without completing it

**Plans**: 4 plans (2 waves)

**Wave 1**

- [x] 04-01-PLAN.md — capabilities tRPC router (shells doctor.py --json → host_capabilities) + additive list_models() Python helper for the model selector (SET-01, SET-04)

**Wave 2** *(blocked on 04-01: all three consume the capabilities router)*

- [x] 04-02-PLAN.md — CapabilitiesSection (provenance label + resolved path + tri-state badge) slotted into settings (SET-01 consumer, SET-02, D-02)
- [x] 04-03-PLAN.md — extend TranscriptionSection: mode radios local/cloud-fallback/cloud-priority + cloud COMMAND field (not a key) + detected-model selector (TRANS-01, TRANS-02, SET-04, D-03/D-04/D-05)
- [x] 04-04-PLAN.md — skippable first-run Onboarding overlay reflecting live permission status, dismissable without completing (SET-03, D-06)
**Research**: standard pattern (skip research-phase) — tRPC-over-`doctor.py --json` and the settings UI follow established codebase conventions.
**UI hint**: yes

### Phase 5: Capability Reuse + Data-Folder / Cloud-Sync Safety

**Goal**: Yulu stops duplicating what the host already provides, and the data folder can point at a cloud-sync root safely — with machine-local runtime state physically isolated from syncable content so a sync engine can never corrupt a database or evict an in-use recording.
**Depends on**: Phase 3 (consumes the report), Phase 2 (`DependencyManager`, `PathResolver`)
**Requirements**: REUSE-01, REUSE-02, DATA-01, DATA-02, DATA-03
**Success Criteria** (what must be TRUE):

  1. When a *usable* host whisper / model / `claude` / `gog` is detected, Yulu reuses it and skips installing its own (no unconditional `brew install whisper-cpp`, no duplicate MLX venv)
  2. Runtime/state (SQLite DBs, sockets, locks, PIDs) lives in a machine-local location that is never placeable in a synced folder, physically separated from syncable content
  3. A user can configure the data-folder (recordings/transcripts/summaries) location, and the change takes effect across daemons
  4. When the chosen data folder is a detected cloud-sync root (iCloud / Google Drive…), Yulu detects it and warns about the relevant risks before accepting it

**Plans**: 4 plans (2 waves)

**Wave 1** *(parallel — no file overlap)*

- [x] 05-01-PLAN.md — DATA-02 runtime/content split + runtime LOCK (assert_runtime_not_synced) + route the 3 hardcoded content literals through data_dir() (DATA-02, DATA-01) [hard-prereq, lands first]
- [x] 05-02-PLAN.md — reuse gating: add the gog probe + capability_status() helper, gate setup_deps.sh (whisper-cpp/gogcli) + setup_capabilities.sh (mlx) on the tri-state usable (REUSE-01, REUSE-02)
- [x] 05-03-PLAN.md — cloud_detect.py (stdlib path-prefix + SF_DATALESS, NOT os.getxattr) + read-only cloud.detect tRPC route (DATA-03 detection primitive)

**Wave 2** *(blocked on 05-01 + 05-03 — D-06 hard sequencing: the cloud picker ships only after the runtime split/lock)*

- [x] 05-04-PLAN.md — wire the cloud-capable folder picker: audio.output_dir -> restart:audiodaemon propagation + cloud-warn-before-accept in the picker + live-cloud/live-restart human-verify checkpoint (DATA-01, DATA-03)
**Research**: needs deeper per-phase research (cloud-sync data folder) — iCloud pinning robustness (`com.apple.fileprovider.pinned` vs File Provider API; Sequoia's 10-item Finder cap) and the content/runtime split for `vocab`/`prompts` SQLite need validation against real sync behavior.
**Hard sequencing (in-phase)**: the content-vs-runtime separation (DATA-02) MUST land before the folder picker is wired to cloud roots (DATA-01/DATA-03) — users must never be able to put SQLite/sockets in a synced folder. Tri-state detection (Phase 3) gates the reuse-vs-install decision here.

### Phase 6: Agent-Orchestrated Provisioning + Decoupled Skill Install

**Goal**: Provisioning becomes a registry of named, idempotent, status-reporting steps the host agent can drive and re-run safely — composing layers 1–5 — with asset integrity verified before execution and skill install decoupled from core install. A spike resolves who drives the steps.
**Depends on**: Phase 1 (signed binaries + attestation), Phase 2 (`DaemonManager`/`PathResolver`), Phase 3 (report), Phase 5 (reuse + deps)
**Requirements**: PROV-01, PROV-02, PROV-03, PROV-04, PROV-05
**Success Criteria** (what must be TRUE):

  1. Provisioning is a registry of named steps each exposing `check`/`apply` → `StepResult`, invocable via `yulu provision <step>`, and re-running a completed step reports `skipped`/`ok` rather than re-doing destructive work
  2. Provisioning verifies asset integrity (`gh attestation verify`) before execution; the verified signed-zip path remains a working non-negotiable fallback when `gh` is absent
  3. After a provisioning run is killed mid-way, re-running resumes from a per-step state file (`.yulu-install.json`) without redoing completed steps or duplicating daemons
  4. A tampered asset is rejected before any step executes
  5. `yulu skill install [--agent]` installs/updates the agent skill independently of core install (idempotent), no longer coupled into `setup.sh`

**Plans**: 4 plans (2 waves)

**Wave 1** *(parallel — provision/ module spine; file-disjoint)*

- [x] 06-01-PLAN.md — provision/registry.py: Step ABC + StepResult + ScriptStep wrapping the six setup_*.sh 1:1 (PROV-01, D-01/D-06/D-07)
- [x] 06-02-PLAN.md — provision/state.py: resumable .yulu-install.json ledger (atomic write, kill-at-step-N, preserve installer source) (PROV-04, D-04/D-08)
- [x] 06-03-PLAN.md — provision/attest.py: fail-closed gh-auth-ladder gate + checksum floor + tamper rejection [checkpoint] (PROV-03, D-03)

**Wave 2** *(blocked on 06-01/02/03 — composes all three)*

- [x] 06-04-PLAN.md — provision/cli.py resume-walk driver + skill.py + yulu dispatcher wiring + setup.sh skill decouple (PROV-01/PROV-05, D-02/D-05/D-08)
**Research**: needs deeper per-phase research (the spike IS the research) — `/gsd-plan-phase --research-phase 6`. FEATURES.md flags agent-as-primary-provisioning-UX as LOW confidence; STACK.md flags `uv`/`uvx` as "EVALUATE in spike." Exit criteria are explicit: partial-failure/resume (kill-at-step-N) and tampered-asset rejection, not just the happy path.
**Spike-gated open question**: WHO calls provisioning — host agent vs `curl|bash`. The step registry itself is BUILD NOW regardless (the decomposed `setup_*.sh` scripts from Phase 1 map 1:1 onto these steps); the spike decides only the *caller*. If the spike fails, the verified signed-zip path stays primary.

### Phase 7: Seamless Auto-Migration

**Goal**: An existing v0.5.x `~/.yulu` install upgrades to the new model with no data loss and no reconfiguration — guarding active recordings, staying transactional with rollback, and reclaiming backups only after verified success.
**Depends on**: Phase 2 (`open -W`→direct-launch fix, `PathResolver`, `DaemonManager`), Phase 3 (tri-state report for capability re-detection)
**Requirements**: MIG-01, MIG-02, MIG-03
**Success Criteria** (what must be TRUE):

  1. On upgrade, an existing v0.5.x `~/.yulu` install is detected and migrated through detect→plan→apply→verify with no data loss and no reconfiguration required from the user
  2. Migration refuses to stop any daemon while a recording is active — no `pkill -9` truncation of an in-flight capture
  3. Migration is transactional: `yulu rollback` restores the prior state, and the backup is pruned only after verification passes
  4. The dead `mlx_python` field and hardcoded `~/Movies/Yulu` path are corrected in transit, and the new install carries a `schema_version` stamp

**Plans**: TBD
**Research**: standard pattern (skip research-phase) — the detect→plan→apply→verify pattern is fully specified and its hard dependencies (the `open -W` fix, the recording-guard) are known and land in Phase 2.
**Hard dependencies**: the `open -W`→direct-launch fix (Phase 2) MUST precede migration — it removes the `pkill -9` truncation vector at its root.

### Phase 8: Multi-Agent Providers (Codex + OpenClaw)

**Goal**: The proven ClaudeCode capability-provider is generalized to Codex and OpenClaw, completing the multi-agent-from-v1 lock so Yulu is agent-native, not single-vendor.
**Depends on**: Phase 3 (the `CapabilityProvider` interface already exists)
**Requirements**: AGENT-01, AGENT-02
**Success Criteria** (what must be TRUE):

  1. A `CodexProvider` implements the capability-provider contract and contributes correctly-labeled `agent-config` capabilities to the report
  2. An `OpenClawProvider` implements the same contract end-to-end
  3. With all three agents present, `doctor.py` aggregates each agent's configured stack into one report without re-probing or schema breakage

**Plans**: TBD
**Research**: standard pattern (skip research-phase) — generalizes the reference implementation proven in Phase 3 against an already-locked interface.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Build Foundation | 6/6 | Complete    | 2026-05-30 |
| 2. Platform-Abstraction Seams | 4/4 | Complete    | 2026-05-30 |
| 3. Detection Spine | 3/3 | Complete    | 2026-05-30 |
| 4. Settings & Onboarding | 4/4 | Complete    | 2026-05-30 |
| 5. Reuse + Data-Folder Safety | 4/4 | Complete    | 2026-05-30 |
| 6. Agent-Orchestrated Provisioning | 4/4 | Complete   | 2026-05-30 |
| 7. Seamless Auto-Migration | 0/TBD | Not started | - |
| 8. Multi-Agent Providers | 0/TBD | Not started | - |
