# Phase 2: Platform-Abstraction Seams - Context

**Gathered:** 2026-05-30
**Status:** Ready for planning
**Mode:** Autonomous (decisions made by Claude under Lewis's full-milestone mandate, grounded in ROADMAP/REQUIREMENTS/CONCERNS + locked PROJECT principles; no re-litigation of project-level decisions)

<domain>
## Phase Boundary

Put every macOS-coupled concern (paths, daemon supervision, permissions, dependencies, audio capture) behind a neutral interface with a clean macOS implementation, so daemon stop leaves zero orphans and a future Linux/Windows arm is pure addition. Covers **PLAT-01..05**.

Phase 1 already defined the Python-side ABC *signatures* in `yulu_platform/base.py` (PathResolver, DaemonManager+ServiceSpec, PermissionModel, DependencyManager). **Phase 2 fills the macOS implementations** (`yulu_platform/macos/`) and adds the **Swift `CaptureBackend`** seam. Linux/Windows arms stay `NotImplementedError` (v2 XPLAT).

**Out of scope:** Linux/Windows runtime impls (v2); host-capability detection (Phase 3, consumes PathResolver); migration (Phase 7, consumes the `open -W` fix). The Swift CaptureBackend can proceed in parallel with the Python seams — they meet only at the `record_audio.py ↔ CaptureBackend` boundary.

</domain>

<decisions>
## Implementation Decisions

### macOS Floor — *constraint decision (ROADMAP-flagged), Claude decided*
- **D-01 [constraint, → PROJECT.md]:** macOS floor STAYS at **13+**. System audio capture is **dual-arm behind one seam**: Core Audio process taps on **14.4+**, ScreenCaptureKit on **13–14.3**, selected via `if #available`. We do NOT raise the floor to 14.4. Rationale: PROJECT.md commits to "macOS 13+ today"; raising the floor would strand existing 13–14.3 users for a milestone whose goal is *abstraction*, not platform-dropping. The taps arm removes the weekly re-permission nag on 14.4+ (success criterion 3) while the SCK arm preserves compatibility. Recorded in PROJECT.md Key Decisions + Constraints.

### Audio Capture Seam (PLAT-01/02) — Claude decided
- **D-02:** `CaptureBackend` = a **Swift protocol** ("PCM frames + source list"): emits PCM frames + exposes a capturable-source list, hiding `SCStreamConfiguration`/tap vocabulary. macOS impl is dual-arm (D-01). The Python side meets it only at `record_audio.py ↔ CaptureBackend`; keep that boundary thin (start/stop/status + frame sink).
- **D-03:** The two arms live behind `if #available(macOS 14.4, *)`; the 13–14.3 SCK arm is the existing capture code refactored behind the protocol (not rewritten). Tap arm is the new path — **research must validate the version gate + fallback on 14.2 and 13.x** (the dev's own machine never reproduces the SCK nag, so VM/dual-machine validation is required before trusting the gate).

### Daemon Supervision (PLAT-03) — Claude decided
- **D-04:** `DaemonManager` macOS impl wraps `launchctl` and implements the Phase 1 `yulu_platform.base.DaemonManager` ABC (`ServiceSpec` + install/load/unload/status). No launchd vocabulary leaks into the interface.
- **D-05 [load-bearing for Phase 7]:** Fix the `open -W` orphan (CONCERNS §8b): the audiodaemon plist launches `Yulu.app/Contents/MacOS/audio_daemon` **directly** (set `LSUIElement=true` in Info.plist to suppress the Dock icon) so `launchctl unload` kills the process cleanly — **zero lingering processes** (success criterion 2). This removes the `pkill -9` truncation vector at its root, which Phase 7 migration depends on. Verify the direct-launch binary still acquires ScreenCapture/Microphone TCC under its bundle identity.

### Paths (PLAT-04) — Claude decided
- **D-06:** `PathResolver` macOS impl removes hardcoded `~/Movies/Yulu` and `~/.config/yulu`; all daemons resolve locations through it. Honor existing `YULU_CONFIG_DIR`/`YULU_OUTPUT_DIR` env (already half-wired via plist `EnvironmentVariables`).
- **D-07:** Fix `status_agent.swift` to read `audio.output_dir` from `config.json` instead of the hardcoded `~/Movies/Yulu` (CONCERNS §6d/§1e) — the menu-bar "Recent Recordings" list must follow the configured dir. This is the Swift consumer of the path-resolution decision.

### Permissions & Dependencies (PLAT-05) — Claude decided
- **D-08:** `PermissionModel` + `DependencyManager` macOS impls; all TCC calls (`tccutil`) and Homebrew calls gated behind a Darwin check (`platform.system() == "Darwin"` / `#if os(macOS)`). The interface reports platform-appropriate status without TCC scopes in the signature.

### Interface Neutrality (success criterion 4) — Claude decided
- **D-09:** No leaked macOS vocabulary in any seam signature (no plist keys, `SCStreamConfiguration`, TCC scope names). Phase 1's `base.py` already honors this (grep-clean); Phase 2 keeps macOS specifics inside `yulu_platform/macos/` and the Swift impl. A reviewer must be able to confirm a systemd arm could implement the same methods.

### Claude's Discretion
Per Lewis's milestone-wide autonomous mandate, ALL decisions above (D-01..D-09) were made by Claude from ROADMAP success criteria + REQUIREMENTS PLAT-01..05 + CONCERNS fix approaches + the Phase 1 `yulu_platform` ABC contract. The researcher/planner may refine method signatures and the exact macos/ package layout; the decisions fix intent, boundaries, and the floor constraint.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/ROADMAP.md` §"Phase 2: Platform-Abstraction Seams" — goal + 5 success criteria + the floor constraint flag + parallelization note
- `.planning/REQUIREMENTS.md` — PLAT-01..05

### The contract Phase 2 implements
- `yulu/scripts/yulu_platform/base.py` — the 4 ABC signatures from Phase 1 (PathResolver, DaemonManager+ServiceSpec, PermissionModel, DependencyManager) — Phase 2 fills `yulu_platform/macos/` against these
- `.planning/phases/01-build-foundation-setup-decomposition-signed-notarized-binari/01-SUMMARY.md` / `01-01-SUMMARY.md` — what the ABC layer provides

### Fragilities this phase fixes
- `.planning/codebase/CONCERNS.md` — §1a (Swift macOS frameworks), §1b (launchd-only), §1c (TCC), §1e + §6d (hardcoded paths / status_agent.swift), §8b (`open -W` orphan)
- `.planning/codebase/ARCHITECTURE.md` — platform-coupling points + ARCH #10 (CaptureBackend seam)

### Source files the planner will touch (read before editing)
- `yulu/scripts/audio_daemon.swift` (ScreenCaptureKit capture — refactor behind CaptureBackend + add tap arm)
- `yulu/scripts/status_agent.swift` (hardcoded `~/Movies/Yulu` → read config.json)
- `yulu/scripts/com.yulu.audiodaemon.plist` (`open -W` → direct launch + `LSUIElement`)
- `yulu/scripts/record_audio.py` (the Python ↔ CaptureBackend boundary)
- `yulu/scripts/doctor.py`, `dev_install.py`, `repair_permissions.py` (launchctl/TCC/path callers → route through DaemonManager/PathResolver/PermissionModel)
- *(new)* `yulu/scripts/yulu_platform/macos/` — the macOS implementations

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 1 `yulu_platform/base.py` ABCs are the interface target — Phase 2 is pure implementation against a frozen contract.
- The existing SCK capture in `audio_daemon.swift` (843 lines) is refactored behind `CaptureBackend`, not rewritten — the 13–14.3 arm IS today's code.
- `EnvironmentVariables` in the plists already pass `YULU_CONFIG_DIR`/`YULU_OUTPUT_DIR` partway — PathResolver formalizes this.

### Established Patterns
- Swift binaries are macOS-only by design (guarded by capability flag) — keep them macOS-only; the abstraction is the Python/Swift boundary, not cross-platform Swift.
- stdlib-first Python (Phase 1 precedent): `yulu_platform/macos/` uses stdlib + subprocess(launchctl/tccutil) only.

### Integration Points
- `record_audio.py ↔ CaptureBackend` is the one cross-language seam — keep it thin.
- PathResolver is consumed by Phase 3 (`doctor.py` capability report) and Phase 5/7 — get the resolution contract right here.
- The `open -W` → direct-launch fix (D-05) is a hard prerequisite for Phase 7 migration's recording-guard.

</code_context>

<specifics>
## Specific Ideas
- Dual-arm capture behind `if #available(macOS 14.4, *)`; do NOT raise the floor.
- Direct-launch audio daemon with `LSUIElement=true`; kill the `open -W` + `pkill -9` pattern.
- `status_agent.swift` must read `config.json` `audio.output_dir`.
- Research MUST validate the Core-Audio-tap version gate + SCK fallback on 14.2 and 13.x (dev machine can't reproduce the nag).

</specifics>

<deferred>
## Deferred Ideas
None new. Linux/Windows runtime impls remain v2 (XPLAT-01/02). The Swift CaptureBackend's non-macOS arms stay stubs this milestone.

</deferred>

---

*Phase: 2-Platform-Abstraction Seams*
*Context gathered: 2026-05-30 (autonomous)*
