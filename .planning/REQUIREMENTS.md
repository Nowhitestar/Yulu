# Requirements: Yulu — Agent-Native Provisioning & Cross-Platform Foundation

**Defined:** 2026-05-29
**Core Value:** A meeting becomes a clean, searchable note entirely on the user's machine, through the agent they already trust — capture and transcription never depend on the cloud, and Yulu never makes the user reconfigure what their agent already provides.

## v1 Requirements

Requirements for this milestone. Each maps to exactly one roadmap phase.

### Build & Signing (BUILD)

- [x] **BUILD-01**: The monolithic `setup.sh` is decomposed into per-concern scripts with `set -uo pipefail`, so any failing step is visible and individually testable
- [x] **BUILD-02**: macOS binaries are Developer ID signed (bottom-up, never `--deep`) and notarized + stapled, replacing the `--timestamp=none` + `xattr` quarantine-strip
- [x] **BUILD-03**: Release installs ship pre-built signed binaries and no longer require `swiftc`/Xcode on the user's machine
- [x] **BUILD-04**: CI publishes GitHub Artifact Attestations for release assets so integrity is verifiable via `gh attestation verify`

### Platform Abstraction (PLAT)

- [x] **PLAT-01**: A `CaptureBackend` interface ("PCM frames + source list") exists with a macOS implementation; Linux/Windows are `NotImplementedError` stubs
- [x] **PLAT-02**: macOS system-audio capture uses Core Audio process taps on 14.4+, with a ScreenCaptureKit fallback arm behind the same seam (`if #available`)
- [x] **PLAT-03**: A `DaemonManager` interface (`ServiceSpec` + install/load/unload/status) wraps launchd; the audio daemon launches directly (no `open -W` orphan) so `stop()` leaves zero processes
- [x] **PLAT-04**: A `PathResolver` removes hardcoded `~/Movies/Yulu` / `~/.config/yulu` (including fixing `status_agent.swift` to read `config.json`)
- [x] **PLAT-05**: `PermissionModel` and `DependencyManager` interfaces exist with macOS implementations; TCC calls are gated behind a Darwin check

### Capability Detection (DETECT)

- [x] **DETECT-01**: `doctor.py` produces a versioned `HostCapabilityReport` JSON with per-capability provenance (host-path / yulu-managed / agent-config / absent) and tri-state status (usable / present-but-unverified / absent)
- [x] **DETECT-02**: Capability probes resolve binaries via the login-shell PATH (not bare `shutil.which`) and Python importability via the daemon's own interpreter
- [x] **DETECT-03**: `doctor` probes `claude` CLI, `whisper-cli`, `mlx-whisper` importability, configured `llm.command` validity, model paths/sizes, and recording-dir writability
- [x] **DETECT-04**: The `mlx_python` interpreter ambiguity is resolved so "usable" reflects what the daemon can actually import
- [x] **DETECT-05**: A `CapabilityProvider` interface exists with a ClaudeCode implementation working end-to-end

### Settings & Onboarding (SET)

- [x] **SET-01**: A `host_capabilities` tRPC endpoint serves the doctor report to the web UI
- [x] **SET-02**: The settings page shows each capability's provenance ("reused from your PATH" vs "Yulu-managed") with the resolved path
- [x] **SET-03**: A skippable browser first-run onboarding walkthrough shows live permission status
- [x] **SET-04**: A model selector lets the user choose among detected models across host caches

### Transcription Modes (TRANS)

- [x] **TRANS-01**: User can set transcription mode to local (default), cloud-fallback, or cloud-priority
- [x] **TRANS-02**: Cloud transcription uses the user's own configured command (same trust model as `llm.command`); Yulu holds no cloud keys

### Data Folder & Cloud Sync (DATA)

- [x] **DATA-01**: User can configure the data folder (recordings/transcripts/summaries) location
- [x] **DATA-02**: Runtime/state (SQLite DBs, sockets, locks, PIDs) is physically separated from syncable content and never placed in a synced folder
- [x] **DATA-03**: When the data folder points at a detected cloud-sync root (iCloud / Google Drive…), Yulu detects it and warns about the relevant risks

### Capability Reuse (REUSE)

- [x] **REUSE-01**: When a *usable* host whisper / model / `claude` / `gog` is detected, Yulu reuses it instead of installing its own
- [x] **REUSE-02**: Yulu no longer unconditionally `brew install`s whisper-cpp or creates a duplicate MLX venv when the host already provides them

### Agent-Orchestrated Provisioning (PROV)

- [x] **PROV-01**: Provisioning is a registry of named, idempotent steps (`check`/`apply` → `StepResult`), invocable via `yulu provision <step>`
- [x] **PROV-02**: A spike validates agent-orchestrated provisioning (who calls the steps), with partial-failure/resume and tampered-asset rejection as explicit exit criteria
- [ ] **PROV-03**: Provisioning verifies asset integrity (`gh attestation verify`) before execution; the signed-zip path remains a non-negotiable fallback
- [x] **PROV-04**: Provisioning is resumable via a per-step state file (`.yulu-install.json`)
- [ ] **PROV-05**: `yulu skill install [--agent]` installs/updates the agent skill independently of core install (idempotent), decoupled from `setup.sh`

### Seamless Migration (MIG)

- [ ] **MIG-01**: On upgrade, an existing v0.5.x `~/.yulu` install is detected and migrated (detect→plan→apply→verify) with no data loss and no reconfiguration
- [ ] **MIG-02**: Migration guards against active recordings before stopping any daemon (no `pkill -9` truncation)
- [ ] **MIG-03**: Migration is transactional with `yulu rollback`; backups are pruned only after verified success

### Multi-Agent Providers (AGENT)

- [ ] **AGENT-01**: A `CodexProvider` implements the capability-provider contract
- [ ] **AGENT-02**: An `OpenClawProvider` implements the capability-provider contract

## v2 Requirements

Deferred to a future milestone. Tracked but not in this roadmap.

### Cross-Platform Runtime (XPLAT)

- **XPLAT-01**: Linux runtime implementation of the platform seams (PipeWire capture, systemd daemons)
- **XPLAT-02**: Windows runtime implementation of the platform seams (WASAPI loopback, Task Scheduler/service)

### Hardening (HARD)

- **HARD-01**: iCloud pinning robustness for in-use recordings (`com.apple.fileprovider.pinned` / File Provider API)
- **HARD-02**: Installer signature `--verify` hardening beyond attestation
- **HARD-03**: Backup-cleanup policy beyond migration's own lifecycle (`yulu cleanup-backups`)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep. Anti-features from research.

| Feature | Reason |
|---------|--------|
| Yulu-hosted cloud sync / backup service | Violates local-first; cloud sync is delegated to the user's own folder sync (iCloud/Drive) |
| Accounts / multi-user / teams | Yulu is local-first and single-user |
| Drag-to-`/Applications` `.app` as THE install model | Over-fits macOS; superseded by agent-orchestrated provisioning |
| Yulu-held cloud API keys | User brings their own cloud command; no keys held by Yulu |
| Forced, unskippable onboarding | Onboarding must be skippable |
| Auto-installing Homebrew without consent | Reuse-first; never silently mutate the host's package manager |
| A second Yulu-specific venv when the host already has one | Directly contradicts the reuse goal |
| Custom CRDT / sync-conflict engine | Folder sync is the OS's job; no conflict engine |
| Actual Windows/Linux implementations (this milestone) | Architecture is abstracted now; implementations deferred to a future milestone |

## Traceability

Each v1 requirement maps to exactly one phase. See `.planning/ROADMAP.md` for phase goals and success criteria.

| Requirement | Phase | Status |
|-------------|-------|--------|
| BUILD-01 | Phase 1 | Complete |
| BUILD-02 | Phase 1 | Complete |
| BUILD-03 | Phase 1 | Complete |
| BUILD-04 | Phase 1 | Complete |
| PLAT-01 | Phase 2 | Complete |
| PLAT-02 | Phase 2 | Complete |
| PLAT-03 | Phase 2 | Complete |
| PLAT-04 | Phase 2 | Complete |
| PLAT-05 | Phase 2 | Complete |
| DETECT-01 | Phase 3 | Complete |
| DETECT-02 | Phase 3 | Complete |
| DETECT-03 | Phase 3 | Complete |
| DETECT-04 | Phase 3 | Complete |
| DETECT-05 | Phase 3 | Complete |
| SET-01 | Phase 4 | Complete |
| SET-02 | Phase 4 | Complete |
| SET-03 | Phase 4 | Complete |
| SET-04 | Phase 4 | Complete |
| TRANS-01 | Phase 4 | Complete |
| TRANS-02 | Phase 4 | Complete |
| REUSE-01 | Phase 5 | Complete |
| REUSE-02 | Phase 5 | Complete |
| DATA-01 | Phase 5 | Complete |
| DATA-02 | Phase 5 | Complete |
| DATA-03 | Phase 5 | Complete |
| PROV-01 | Phase 6 | Complete |
| PROV-02 | Phase 6 | Complete |
| PROV-03 | Phase 6 | Pending |
| PROV-04 | Phase 6 | Complete |
| PROV-05 | Phase 6 | Pending |
| MIG-01 | Phase 7 | Pending |
| MIG-02 | Phase 7 | Pending |
| MIG-03 | Phase 7 | Pending |
| AGENT-01 | Phase 8 | Pending |
| AGENT-02 | Phase 8 | Pending |

**Coverage:**
- v1 requirements: 35 total (the enumerated checkbox list sums to 35; the original "33 total" prose was a miscount — all 10 categories are fully mapped)
- Mapped to phases: 35 (BUILD 4 → P1 · PLAT 5 → P2 · DETECT 5 → P3 · SET 4 + TRANS 2 → P4 · REUSE 2 + DATA 3 → P5 · PROV 5 → P6 · MIG 3 → P7 · AGENT 2 → P8)
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-29*
*Last updated: 2026-05-29 after roadmap traceability mapping*
