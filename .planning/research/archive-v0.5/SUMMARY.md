# Project Research Summary

**Project:** Yulu — "Agent-Native Provisioning & Cross-Platform Foundation" milestone
**Domain:** Agent-native, local-first, brownfield cross-platform provisioning & configuration (meeting recorder)
**Researched:** 2026-05-29
**Confidence:** MEDIUM-HIGH (HIGH on macOS tooling, signing, capture, paths, and the abstraction *shapes*; MEDIUM on agent-orchestrated-provisioning UX, which is an emerging space gated by an explicit spike)

## Executive Summary

This is a **brownfield re-architecture milestone**, not a greenfield product. Yulu already ships (8 launchd daemons, Swift `audio_daemon`, Hono+tRPC+React UI, SQLite, MLX/whisper.cpp, release-please). The milestone adds three new horizontal layers — a **platform-abstraction layer** (macOS impl now, Linux/Windows stubbed), an **agent-capability layer** (detect-and-reuse what the host agent already has), and an **agent-orchestration surface** (the host agent provisions Yulu via named, idempotent steps) — while fixing a catalogue of pre-existing fragilities (`--timestamp=none` signing, `pkill -9` upgrades, the dead `mlx_python` field, `set -e` without `pipefail`, hardcoded `~/Movies/Yulu`, uncleaned backups, the `open -W` orphan). The way experts build this is **abstraction modeled on proven cross-platform shapes** (`cpal` for capture = "PCM frames + source list"; `service-manager-rs` for supervision = "ServiceSpec + install/load/unload/status") rather than the current macOS code with method names rearranged — and **detection-before-reuse**, where "found" must mean "the daemon that will use this can actually use it," not "the name resolves on the dev's shell."

All four research dimensions converge on one **spine decision: detection first.** The `HostCapabilityReport` — a single versioned JSON document `doctor.py` produces, with per-capability *provenance* (host-path / yulu-managed / agent-config / absent) — is the foundational dependency that four downstream consumers bind to: the settings UI renders it (with "reused vs Yulu-managed" labels — the agent-native differentiator), provisioning consumes it to decide what to skip-vs-install, transcription-mode config validates against it, and the model selector reads its model list. Architecturally this means **the report schema is the first thing to lock**, and the detection layer must be built before any "reuse" UX. The recommended approach is a strict one-way dependency backbone (`provision/` -> `capabilities/` -> `platform/` -> existing runtime) that must never be reversed, with the `ARCHITECTURE.md` build-order table (#0-#10, tagged BUILD NOW / INTERFACE-ONLY / DEFER) carrying directly into roadmap phasing.

The key risks are **second-order traps introduced while fixing first-order bugs**, and they impose hard sequencing constraints the roadmap must respect: (1) a "portable" interface that ossifies around macOS nouns (plist keys, SCK windows, TCC scopes) — mitigated by modeling on cpal/service-manager-rs and a "two-consumers honesty test"; (2) **capability false positives** that silently suppress the install fallback — mitigated by tri-state detection (`usable`/`present-but-unverified`/`absent`) probed through the *daemon's* interpreter, which **requires resolving the `mlx_python` interpreter ambiguity first**; (3) **cloud-sync corrupting SQLite and evicting recordings** — mitigated by physically separating content (syncable) from runtime/state (local-only, never placeable in a synced folder) *before* exposing the folder picker; (4) **migration truncating active recordings** — which **requires fixing `open -W` -> direct-launch first** so `stop()` is clean and no `pkill -9` is needed; (5) **agent provisioning amplifying the `curl|bash` trust gap** — mitigated by `gh attestation verify` before any execution plus per-step idempotency. Two non-negotiable prerequisites cut across phases: **Apple Developer ID + notarization** (USD $99/yr, the unlock for shipping pre-built signed binaries so `swiftc` leaves the install path), and **raising the macOS floor 13->14.4** for the Core Audio process-taps audio path (which escapes Sequoia's weekly re-permission nag but must keep a ScreenCaptureKit fallback arm behind the seam, gated on `if #available(macOS 14.4, *)`, or explicitly abandon 13-14.3 users in PROJECT.md).

## Key Findings

### Recommended Stack

The milestone adds *almost no new runtime dependencies* (the discipline is "reuse the host," not "bundle more"). The single safe new Python dep is `psutil` (cross-platform daemon liveness, removes launchctl-only status checks). Everything else is either a CI-only tool (Apple `notarytool`/`stapler`/`codesign`, `gh attestation verify`), a design-time *reference only* (`service-manager-rs`, `cpal` — borrow the API shape, do NOT add a Rust toolchain to a Python+Swift+TS project), or already transitively present (`huggingface_hub.scan_cache_dir()` for model discovery). `uv`/`uvx` is a spike candidate for the agent-provisioning runtime (self-bootstrapping, no system Python prereq). See `.planning/research/STACK.md`.

**Core technologies:**
- **Core Audio process taps (macOS 14.4+)**: system-audio capture — escapes ScreenCaptureKit's weekly Sequoia re-permission nag and screen-recording TCC scope; needs only `NSAudioCaptureUsageDescription`. Raises the effective floor 13->14.4 for the audio path (keep SCK as a fallback arm behind the same seam).
- **Developer ID signing + `notarytool` + `stapler` (sign bottom-up, NEVER `--deep`)**: lets release installs ship pre-built signed binaries — removes `swiftc`/Xcode from the install path. Hard prerequisite: an Apple Developer ID ($99/yr).
- **`doctor.py` host_capabilities probe (login-shell PATH resolution)**: the detection spine — resolves binaries via the *login-shell* PATH (not bare `shutil.which`, which fails under launchd's minimal PATH), Python importability via the *daemon's* interpreter, models via HF/ggml cache scan.
- **GitHub Artifact Attestations (`gh attestation verify -o <org>`)**: native, agent-friendly integrity — the agent cryptographically verifies Yulu's own CI built the asset before executing. SHA-256 `checksums.txt` fallback when `gh` is absent.
- **`~/Library/CloudStorage/*` glob + `MobileMeAccounts.plist`**: detect cloud-sync roots (iCloud, Google Drive/Dropbox/OneDrive under File Provider) as data-folder candidates — never auto-move. Implements the Obsidian model with zero server burden.
- **`psutil` 6.1+**: the one safe cross-platform runtime dep to add.

### Expected Features

The experience being added (not the recording internals): provisioning, onboarding, settings, optional folder-sync, configurable transcription, agent-orchestrated install, seamless migration. The headline insight from `.planning/research/FEATURES.md`: **detection is the single foundational dependency** — reuse, settings provenance, model selection, and transcription-mode validation all consume the same capability report, so detection must be built before any reuse UX. The differentiators are agent-native: provisioned *by the user's coding agent*, reusing *another agent's* configured stack (almost nobody does this), with per-capability provenance labeling ("Whisper: `whisper-cli` 1.7 from your PATH — reused" vs "downloaded by Yulu").

**Must have (table stakes):**
- `doctor.py` host-capability probes — foundational; unblocks everything reuse-related
- Settings UI capability surfacing — `host_capabilities` tRPC endpoint backed by the doctor JSON
- Reuse host capabilities instead of duplicating — detect-then-reuse whisper/models/`claude`/`gog`; stop unconditional brew/venv installs
- Configurable data-folder location — real config + de-hardcode `~/Movies/Yulu` (fix `status_agent.swift`)
- Configurable transcription mode — local default / cloud-fallback / cloud-priority (user's own cloud command)
- Seamless auto-migration of v0.5.x `~/.yulu` — no data loss, no reconfig, don't truncate active recordings
- Decompose `setup.sh` + `set -uo pipefail`; decoupled idempotent `yulu skill install [--agent]`
- Skippable browser first-run walkthrough with live permission status

**Should have (competitive differentiators):**
- Settings provenance labeling ("reused from PATH" vs "Yulu-managed", resolved path) — the agent-native edge on top of a table-stakes settings page
- Pre-compiled signed/notarized binaries (no Xcode at install) — the unlock for agent provisioning
- Multi-agent capability provider (Claude Code + Codex + OpenClaw) — start one agent end-to-end, then generalize
- Agent-orchestrated provisioning as primary UX — spike-gated (the novel, emerging-frontier part)
- Folder-sync guidance (Obsidian model)

**Defer (future milestone):**
- Actual Windows/Linux runtime (architecture abstracted now, impl deferred — PROJECT.md Out of Scope)
- Backup cleanup policy beyond migration's own lifecycle; installer signature `--verify` hardening

**Anti-features (deliberately NOT built):** Yulu-hosted cloud sync/accounts (violates local-first locks), drag-to-`/Applications` as THE install model, Yulu-held cloud API keys, forced unskippable onboarding, auto-installing Homebrew without consent, a second Yulu-specific venv when the host has one, custom CRDT sync-conflict engine.

### Architecture Approach

The milestone adds three new horizontal layers above the unchanged existing runtime, threaded by one new data flow (the capability report). The structure introduces a `platform/` package (interfaces in `base.py`, the ONLY real impl in `macos/`, `linux/`+`windows/` as `NotImplementedError` stubs), a `capabilities/` package (per-agent providers + the `HostCapabilityReport`), and a `provision/` package (named step registry + migration). The Swift `CaptureBackend` protocol mirrors the Python ABC — the one place the abstraction crosses the language boundary. The backbone is a strict one-way import dependency: `provision/` -> `capabilities/` -> `platform/` -> existing runtime, never reversed. See `.planning/research/ARCHITECTURE.md`.

**Major components:**
1. **`HostCapabilityReport`** (the spine) — one versioned JSON doc, per-capability provenance + tri-state status; `doctor.py` is the sole writer, four consumers read it. Lock this schema first.
2. **Platform seams** (`CaptureBackend`, `DaemonManager`, `PathResolver`, `PermissionModel`, `DependencyManager`) — neutral interfaces modeled on cpal/service-manager-rs; macOS impl behind each.
3. **`CapabilityProvider`** (per-agent: Claude Code / Codex / OpenClaw) — uniform detection contract; build ClaudeCode end-to-end first, generalize after.
4. **`provision/steps.py`** — named idempotent `check`/`apply` step registry with `StepResult` status (replaces the linear `setup.sh`); the decomposed `setup_*.sh` scripts map 1:1 onto these steps.
5. **`yulu migrate`** — detect->plan->apply->verify pipeline (recording-guard first, backup kept until verify passes, then prune).
6. **`yulu_ui` `capabilities.ts`** — tRPC procedure shelling `doctor.py --json`, rendering provenance-labeled settings.

The ARCHITECTURE build-order table (#0-#10) is the authoritative phasing input — it distinguishes BUILD NOW impls from INTERFACE-ONLY stubs and notes that #10 (the Swift capture seam / SCK->tap migration) is **independent** of #3-#9 and can run in parallel after #0.

### Critical Pitfalls

The top traps are second-order — mistakes made *while fixing* the known concerns. See `.planning/research/PITFALLS.md`.

1. **Speculative abstraction ossifies around macOS concepts** — you can't validate an interface with one impl, so it becomes "macOS code, renamed" (leaks `window`/`plist`/`KeepAlive`/TCC). Avoid: model on cpal (PCM frames) / service-manager-rs (ServiceSpec); apply the "two-consumers honesty test" (could systemd AND launchd implement this method?); stubs `raise NotImplementedError` only.
2. **Capability false positives suppress the install fallback** — `doctor` reports green, the daemon fails silently at first recording (the live `mlx_python` bug proves the team conflates "installed somewhere" with "usable by the daemon"). Avoid: probe through the *consumer* (daemon's interpreter/PATH) + smoke-run, not `--version`; tri-state report where only `usable` triggers reuse. **Hard prerequisite: resolve the `mlx_python` interpreter ambiguity first.**
3. **Cloud-sync corrupts SQLite + evicts recordings** — "sync is the OS's job" is true for content, catastrophic for DBs/sockets/locks/large media (`-wal` separation corruption; iCloud eviction blocks `pread`). Avoid: physically separate content (syncable) from runtime/state (local-only); **forbid** DBs/sockets in a synced dir; detect-and-warn on cloud-root selection. This separation must precede the folder picker.
4. **Migration truncates active recordings + never reclaims backups** — inherits `pkill -9` (CONCERNS 2d) and uncleaned backups (2e). Avoid: recording-state guard before stopping anything; **fix `open -W` -> direct-launch first** so `stop()` is clean; transactional with `yulu rollback`; fix dead `mlx_python`/hardcoded paths *in transit*.
5. **Agent provisioning amplifies the `curl|bash` trust gap** — an autonomous agent fetches + executes with no human checkpoint, and confidently re-runs destructive non-idempotent steps. Avoid: `gh attestation verify` before any execution; per-step idempotency + resumable state file; the verified signed-zip stays the non-negotiable fallback. The spike must test partial-failure/resume and tampered-asset rejection, not just the happy path.

## Implications for Roadmap

Based on combined research, the suggested phase structure follows the ARCHITECTURE build-order table (#0-#10) and the PITFALLS phase mapping (P1-P7). The driving principle: **detection-first**, on a strict one-way layer dependency. Phase numbering below matches the PITFALLS topic labels for cross-referencing.

### Phase 1: Prerequisite refactors — setup decomposition + signing/notarization
**Rationale:** Shared prerequisite for everything (ARCHITECTURE #0). Signing/notarization is a hard gate that unblocks pre-built binaries (and thus agent provisioning); CI attestation here unblocks the agent trust story. The decomposed `setup_*.sh` scripts map 1:1 onto the later step registry.
**Delivers:** `setup.sh` -> `setup_audio/models/daemons/capabilities.sh` with `set -uo pipefail`; Developer ID signing (bottom-up, NO `--deep`) + `notarytool` + `stapler`; GitHub Artifact Attestations in CI; `platform/base.py` ABCs introduced (linux/windows stubs `raise NotImplementedError`).
**Addresses:** Decompose `setup.sh`, pre-compiled signed binaries (table stakes).
**Avoids:** Pitfall 2 (notarization/`--deep`/nested dylibs). **Hard exit gate:** notarized build verified via `spctl -a -vvv` on a *clean second machine*; decision logged on bundled-vs-host Python (recommend host-provided, sidesteps the hardest notarization case).
**Prerequisite flagged:** Apple Developer ID ($99/yr) must be acquired before this phase.

### Phase 2: Platform-abstraction seams (PathResolver, DaemonManager, CaptureBackend, Permissions, Deps)
**Rationale:** The lowest-level seams (ARCHITECTURE #1-#2, #10). `PathResolver` unblocks the configurable data folder; `DaemonManager` is needed by provisioning, migration, and UI status. Modeling the boundary right *now* is what makes the future Linux arm pure addition.
**Delivers:** `PathResolver` (macOS) + de-hardcode all paths incl. fixing `status_agent.swift`; `DaemonManager` over neutral `ServiceSpec` (`bootstrap`/`bootout`, not deprecated `load`/`unload`); **fix `open -W` -> direct-launch** so `stop()` leaves zero processes; `PermissionModel` + `DependencyManager` interfaces; Swift `CaptureBackend` protocol + SCK->Core-Audio-tap migration with `if #available(macOS 14.4, *)` gate + SCK fallback arm.
**Uses:** Core Audio taps, `psutil`, ServiceSpec shape (STACK.md).
**Implements:** All five platform seams + the Swift capture seam.
**Avoids:** Pitfalls 1 (abstraction ossification — "honesty review" exit gate), 3 (14.4 floor — runtime version gate + report active backend), 4 (launchd semantics in the interface — outcome-based `stop()`, enum keep-alive, login-shell PATH at runtime).
**PROJECT.md update needed:** decision on keeping the 13-14.3 SCK arm vs raising the floor is a constraint change, not an eng choice.

### Phase 3: Host-capability detection + `doctor.py` -> HostCapabilityReport
**Rationale:** **The detection spine — FEATURES.md's single foundational dependency (ARCHITECTURE #3). Everything reuse-related waits on this.** Lock the report schema here; four consumers bind to it.
**Delivers:** `CapabilityProvider` interface + **ClaudeCodeProvider end-to-end first**; `doctor.py` host_capabilities probe (login-shell PATH, daemon-interpreter import probe, model-cache scan, `llm.command` validate); the versioned `HostCapabilityReport` with provenance + **tri-state status** (`usable`/`present-but-unverified`/`absent`).
**Avoids:** Pitfall 5 (false positives — probe through the daemon's interpreter, smoke-run, tri-state where only `usable` triggers reuse). **Hard prerequisite: resolve the `mlx_python` interpreter ambiguity (CONCERNS 4a/6e) before or within this phase** — detection is meaningless without a defined "daemon interpreter" to probe.

### Phase 4: Settings UI capability surfacing + configurable transcription/model/folder
**Rationale:** First consumer of the report (ARCHITECTURE #4) — proves the schema. Surfaces the provenance differentiator.
**Delivers:** `capabilities.ts` tRPC router shelling `doctor.py --json`; settings page with "reused vs Yulu-managed" provenance labels + resolved paths; transcription-mode radios (local/cloud-fallback/cloud-priority); model selector across host caches; data-folder picker; skippable browser onboarding with live permission status.
**Addresses:** Settings surfacing, transcription mode, model selection, onboarding (table stakes); provenance labeling (differentiator).

### Phase 5: Reuse host capabilities + data-folder/cloud-sync (content/runtime separation)
**Rationale:** Consumes the report to skip-if-present (ARCHITECTURE #5); kills the duplicate-venv/model waste. The data-folder design's core decision — separating syncable content from machine-local runtime — must land here, *before* the picker is wired to cloud roots.
**Delivers:** `DependencyManager` detect-first reuse of host whisper/models/`claude`/`gog`; **physical separation of content (syncable) from runtime/state (`~/.config/yulu` DBs/sockets/locks/PIDs — local-only, never placeable in a synced folder)**; cloud-root detection + warn at folder selection; treat `search.sqlite` as a rebuildable local cache.
**Avoids:** Pitfall 7 (SQLite corruption / iCloud eviction — separation + cloud-root warning + pin-or-summaries-only).

### Phase 6: Agent-orchestrated provisioning (step registry + spike) + decoupled skill install
**Rationale:** Composes layers 1-5 as named idempotent steps (ARCHITECTURE #7). The **step registry is BUILD NOW regardless of the spike** — the decomposed scripts map onto it whether the agent or `curl|bash` drives them. The spike decides only *who calls* the steps.
**Delivers:** `provision/steps.py` registry (`check`/`apply` + `StepResult`) + `yulu provision <step>`; `yulu skill install --agent` (decoupled, per-provider); `gh attestation verify` gate; per-step resumable state file (`.yulu-install.json`).
**Avoids:** Pitfall 6 (provisioning trust + idempotency — attestation before execution, kill-at-step-N resume, duplicate-daemon guard, zip path stays fallback).
**Spike-gated open question:** WHO calls provisioning — host agent vs `curl|bash`. The spike must test partial-failure/resume + tampered-asset rejection as explicit exit criteria.

### Phase 7: Seamless auto-migration (detect->plan->apply->verify)
**Rationale:** Composes `PathResolver` + `DaemonManager` + report (ARCHITECTURE #8). Sequenced after the `open -W` fix (P2) and tri-state detection (P3).
**Delivers:** `migrate.py` four-phase pipeline; **recording-state guard before stopping anything**; transactional with `yulu rollback`; backup lifecycle (prune after verified success); fix dead `mlx_python` + hardcoded `~/Movies/Yulu` *in transit*; `schema_version` stamping.
**Avoids:** Pitfall 8 (truncated recordings + unbounded backups). **Hard dependencies:** `open -W`->direct-launch fix and `pkill -9` recording-guard (P2) must precede this.

### Phase 8 (fast-follow within milestone): CodexProvider + OpenClawProvider
**Rationale:** Generalize the proven ClaudeCode provider (ARCHITECTURE #9); interface already exists from P3.
**Delivers:** The remaining two capability providers, completing the multi-agent-from-v1 lock.

### Phase Ordering Rationale

- **Detection-first is non-negotiable:** the `HostCapabilityReport` is the spine four consumers bind to (FEATURES.md + ARCHITECTURE.md agree). P3 gates P4/P5/P6.
- **One-way layer dependency:** `provision/` (P6) -> `capabilities/` (P3) -> `platform/` (P2) -> existing runtime. P1-P2 gate P6-P7; P2's PathResolver/DaemonManager are composed by provisioning and migration.
- **Hard sequencing constraints from PITFALLS (must carry into the roadmap):**
  - Fix `open -W` -> direct-launch (P2) **before** migration (P7) — removes the `pkill -9` truncation vector at its root.
  - Resolve `mlx_python` interpreter ambiguity **before/within** detection (P3) — no stable target to probe otherwise.
  - Separate content-vs-runtime dirs (P5) **before** the folder picker is wired to cloud roots — must not let users put SQLite/sockets in a synced folder.
  - Apple Developer ID + notarization (P1) is a **prerequisite for shipping pre-built binaries**, which is the prerequisite for agent provisioning (no agent drives an 11GB Xcode compile).
  - SCK->Core-Audio-taps raises the floor 13->14.4 (P2) — keep the SCK fallback arm or explicitly abandon 13-14.3 in PROJECT.md.
  - Tri-state detection (P3) **before** the reuse-vs-install decision — a boolean can't safely drive "skip install."
- **Parallelization:** the Swift capture seam (ARCHITECTURE #10) is independent of the Python detection/provisioning stack and can run in parallel after P1 — they meet only at the `record_audio.py <-> CaptureBackend` boundary.

### Research Flags

Phases likely needing deeper research during planning (`/gsd-plan-phase --research-phase <N>`):
- **Phase 6 (agent-orchestrated provisioning):** the spike-gated open question (WHO calls provisioning) and the emerging-frontier UX — FEATURES.md flags this LOW confidence; STACK.md flags `uv`/`uvx` as "EVALUATE in spike." The spike IS the research; partial-failure/resume + provenance verification are explicit exit criteria.
- **Phase 5 (cloud-sync data folder):** iCloud pinning robustness (`com.apple.fileprovider.pinned` vs File Provider API; Sequoia's 10-item Finder cap) and the content/runtime split for `vocab`/`prompts` SQLite need validation against real sync behavior.
- **Phase 2 (Core Audio taps migration):** the SCK->tap swap is HIGH-confidence on the API but needs testing on 14.2 and 13.x VMs to verify the version gate + fallback (the dev's machine never reproduces the failure).

Phases with standard patterns (skip research-phase):
- **Phase 1 (signing/notarization, setup decomposition):** HIGH confidence — Apple's workflow is well-documented, the anti-patterns (`--deep`, `--timestamp=none`) are known. Execution, not research.
- **Phase 3 (detection/doctor):** the report schema + login-shell PATH + tri-state are well-specified across STACK/ARCHITECTURE/PITFALLS. Schema design, not research.
- **Phase 7 (migration):** the detect->plan->apply->verify pattern is fully specified; the dependencies (open -W fix, recording guard) are known.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | macOS tooling (signing, capture, paths, attestation) verified against Apple/canonical sources; cross-platform shapes (cpal/service-manager-rs) verified as references. MEDIUM only on the deferred non-macOS arms (no impl this milestone). |
| Features | MEDIUM | Most findings WebSearch + official-docs verified; agent-orchestrated provisioning UX is an emerging space with thinner precedent (flagged LOW where noted). Table-stakes and differentiators well-grounded in named comparables (Obsidian, Ollama, Superwhisper, npx skills). |
| Architecture | HIGH | Seam *placement* grounded in the codebase map + proven API shapes; MEDIUM on the agent-orchestration *structure* (spike-gated). The detection-spine and one-way dependency backbone are high-confidence. |
| Pitfalls | HIGH | Signing, iCloud eviction, SQLite-on-sync, capture migration, launchd portability all verified against official/canonical sources. MEDIUM on the abstraction-shape and agent-provisioning failure modes (design risks, not yet-observed bugs). |

**Overall confidence:** MEDIUM-HIGH — high on the macOS-now deliverables and the spine architecture; the one genuinely uncertain area (agent-as-primary-provisioning-UX) is correctly isolated behind a spike with the proven signed-zip path as the non-negotiable fallback.

### Gaps to Address

- **WHO calls provisioning (host agent vs `curl|bash`):** the spike-gated open question. Handle in Phase 6 — the step registry is BUILD NOW regardless; the spike decides only the caller, with explicit exit criteria (kill-at-step-N resume, tampered-asset rejection). If the spike fails, the zip path stays primary.
- **Bundled vs host-provided Python:** the milestone thesis ("reuse the host") points to host-provided (also sidesteps the hardest notarization case), but this must be *decided and logged* in Phase 1, because it changes the signing scope (entitlements for bundled `.so`) and is the stable target for detection's interpreter probe (Phase 3).
- **Keeping the macOS 13-14.3 SCK arm vs raising the floor to 14.4:** a PROJECT.md constraint update (current floor is "macOS 13+"), not an eng decision. Resolve before Phase 2's tap migration lands.
- **iCloud pinning robustness for in-use recordings:** validate `com.apple.fileprovider.pinned` / File Provider API behavior (Sequoia 10-item Finder cap) in Phase 5, or default to "sync summaries only, keep recordings local."

## Sources

### Primary (HIGH confidence)
- `.planning/PROJECT.md` — locked decisions (abstraction-now/macOS-only, agent-orchestrated provisioning, reuse capabilities, configurable folder/transcription, multi-agent, decoupled skill, seamless migration); the synthesis honors these locks.
- `.planning/codebase/` (ARCHITECTURE, CONCERNS, STACK) — existing daemon inventory, IPC map, agent-queue boundary, and the catalogue of pre-existing fragilities this milestone fixes.
- developer.apple.com — notarization workflow, Developer ID, Core Audio process taps (`AudioHardwareCreateProcessTap`/`CATapDescription`, 14.4+), ScreenCaptureKit; never `--deep`, sign bottom-up.
- github.com/insidegui/AudioCap — Core Audio taps require macOS 14.4+ + `NSAudioCaptureUsageDescription`, no screen-recording TCC (canonical Apple sample author).
- sqlite.org/howtocorrupt.html + wal.html — "syncing the file via Dropbox/iCloud" named as corruption cause; WAL-reset bug fixed 3.51.3.
- github.com/chipsenkbeil/service-manager-rs (v0.10) + github.com/RustAudio/cpal (0.17.3) — proven cross-platform abstraction shapes (install/start/stop/status; PCM frames + source list) — API references only.
- docs.github.com (artifact attestations) + `gh attestation verify` — keyless Sigstore provenance for release assets.
- Apple Support + tidbits.com + learn.microsoft.com — File Provider cloud roots (`~/Library/CloudStorage/<Provider>-<account>`, 12.3+); iCloud root + `MobileMeAccounts.plist`.

### Secondary (MEDIUM confidence)
- mjtsai.com + Apple Developer forums — ScreenCaptureKit's ~weekly Sequoia re-permission prompt (multiple corroborating sources).
- eclecticlight.co (Sonoma/Sequoia iCloud series) — "Optimize Mac Storage" eviction -> dataless placeholders; `pread` blocks; pinning xattr.
- Obsidian/Ollama/Superwhisper/Sotto docs — vault-as-folder, capability autodetection, local-vs-cloud transcription UX (feature comparables).
- vercel-labs/skills + Claude Desktop `.mcpb` docs — agent skill install / one-click MCP install patterns.
- pyinstaller#4629 + Apple forums — bundled Python `.so`/dylib signing, library-validation entitlements.

### Tertiary (LOW confidence)
- github.com/nousresearch/hermes-agent — auto-detect `~/.openclaw` migration + "what's configured" credential UX (single source; strong analog for migration UX, needs validation).
- Agent-orchestrated-provisioning UX as a settled best practice — emerging space, thin precedent; validated via the Phase 6 spike rather than relied upon.

---
*Research completed: 2026-05-29*
*Ready for roadmap: yes*
