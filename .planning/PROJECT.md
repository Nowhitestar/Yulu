# Yulu (语录)

## What This Is

Yulu is a local-first, **agent-first** native meeting recorder for macOS. It captures system audio (ScreenCaptureKit) and microphone locally, transcribes on-device (MLX Whisper / whisper.cpp), and hands the transcript to the user's own coding agent (Claude Code, Codex, OpenClaw…) — via a local `agent-queue.json` boundary — to produce the meeting note. No cloud transcription, no account, no virtual audio device; the audio never leaves the laptop unless the user opts in.

Its mental model is **Obsidian-like**: Yulu is the local data + capture layer, the coding agent is the intelligence layer, and both are local-first. Yulu is built *for an agent as its runtime*, not for an OS — so it reuses capabilities the host agent already has rather than reconfiguring its own.

## Core Value

A meeting said out loud becomes a clean, searchable note **entirely on the user's machine, through the agent they already trust** — capture and transcription never depend on the cloud, and Yulu never makes the user reconfigure what their agent already provides.

## Requirements

### Validated

<!-- Existing, relied-upon capabilities — inferred from the codebase map (.planning/codebase/). -->

- ✓ Native macOS system-audio capture (ScreenCaptureKit) + microphone (AVFoundation) via the Swift `audio_daemon` — existing
- ✓ Fully local transcription through a resident `stt_daemon` (MLX Whisper on Apple Silicon / `whisper-cli`), two-slot scheduler, vocab injection — existing (ADR-001/002)
- ✓ Agent-queue summary pipeline: `agent-queue.json` is the coding-agent integration boundary; `agent_queue_worker.py` or an external agent is the sole LLM dispatcher — existing (ADR-004)
- ✓ Local web UI at `http://127.0.0.1:7777` (Hono + tRPC + React): voicemails, meetings, search, settings, prompts, glossary, daemon health — existing
- ✓ Multi-daemon runtime under launchd — 8 `com.yulu.*` agents (audiodaemon, statusagent, sttdaemon, agentqueue, detector, scheduler, calendar, ui) — existing
- ✓ Meeting auto-detection + calendar-driven scheduling (Google Calendar via `gog` + `cloudflared` push) — existing
- ✓ SQLite-backed vocab, prompt library, and full-text transcript/summary search — existing (ADR-002/004)
- ✓ Voicemail capture reusing the agent-queue pipeline — existing
- ✓ `curl install.sh | bash` → `~/.yulu` installer + release-please / GitHub Releases pipeline (Conventional Commits) — existing

### Active

<!-- Current milestone scope. Hypotheses until shipped and validated. -->

**Current milestone: Agent-Native Provisioning & Cross-Platform Foundation**

- [ ] Cross-platform abstraction layer — `CaptureBackend`, `DaemonManager`, path resolution, permission model, and dependency-install behind platform-agnostic interfaces (macOS implementation only this milestone; Win/Linux stubbed)
- [ ] Agent-orchestrated provisioning — the host coding agent installs/provisions Yulu and reuses its own configured capabilities, rather than a macOS-specific installer (leading direction; validate the riskiest path via spike)
- [ ] Host-capability detection + reuse — detect already-configured whisper / `claude` CLI / models / `gog` and reuse them instead of duplicating, across Claude Code + Codex + OpenClaw via an "agent capability provider" abstraction
- [ ] Decouple skill install from core install — standalone, idempotent, agent-invokable (`yulu skill install [--agent]`); removed from the monolithic setup flow
- [ ] `doctor.py` host-capability probes — `claude`, `whisper-cli`, `mlx-whisper` importability, configured `llm.command` validity, model paths/sizes, recording-dir writability
- [ ] Web UI settings — surface + configure capabilities: data-folder location, transcription mode, model selection, and which host capabilities are reused (local vs cloud)
- [ ] Web UI onboarding guidance — first-run setup walkthrough in the browser
- [ ] Configurable data-folder location — enables folder-based cloud sync (point the folder at iCloud / Google Drive; sync is the OS's job, not Yulu's — the Obsidian model)
- [ ] Configurable transcription mode — local-Whisper-first by default, user-selectable **cloud fallback** or **cloud priority**
- [ ] Seamless auto-migration — existing `~/.yulu` (v0.5.x) installs auto-migrate config/data/reused-capabilities to the new model on upgrade
- [ ] Prerequisite refactors — decompose the 1,342-line `setup.sh`; ship pre-compiled, signed (ideally notarized) binaries so release installs no longer need `swiftc`/Xcode

### Out of Scope

<!-- Explicit boundaries with reasoning. -->

- Actual Windows/Linux runtime implementations — architecture must be platform-agnostic, but only macOS is implemented this milestone (deferred to a future milestone)
- A self-hosted cloud backend / Yulu-run sync service — cloud sync is delegated to the user's own folder sync (iCloud / Google Drive); Yulu runs no servers and holds no accounts
- Drag-to-`/Applications` `.app` as the install model — superseded by agent-orchestrated provisioning; a single OS-native bundle over-fits macOS and fights the cross-platform goal
- Accounts / multi-user / team features — Yulu is local-first and single-user

## Context

- **Codebase map:** `.planning/codebase/` (ARCHITECTURE, STRUCTURE, STACK, INTEGRATIONS, CONVENTIONS, TESTING, CONCERNS) — generated 2026-05-29, grounds this milestone.
- **The agent-integration seam already exists.** `agent-queue.json` + `llm.command` already treat the coding agent as a pluggable LLM dispatcher. Agent-native provisioning *extends an existing seam*, it is not a greenfield rewrite.
- **The hard blockers are mapped.** `CONCERNS.md` enumerates: macOS coupling (ScreenCaptureKit, launchd, TCC, `swiftc`-at-install, hardcoded `~/Library`/`~/.config/yulu`/`~/Movies/Yulu` paths, Homebrew) → needs `CaptureBackend` + `DaemonManager` + path/permission/dependency abstractions; `setup.sh` is a 1,342-line monolith without `pipefail`; skill install is coupled into setup; capability duplication (`venv-mlx-whisper`, brew `whisper-cpp`, `~/.config/yulu/models` all duplicate what a host agent may already have); `doctor.py` does not probe host capabilities; the web-UI settings page has no capability-surfacing endpoint.
- **Real bugs found to fold in or fix:** `status_agent.swift` hardcodes `~/Movies/Yulu` and ignores `config.json`; the `mlx_python` config field is read but never used (daemon runs under system `python3`, not the venv); `setup.sh` uses `set -e` without `pipefail`; unsigned/un-notarized binaries (`--timestamp=none`) + `xattr` quarantine strip; `~/.yulu.backup-*` dirs never cleaned.
- **Distribution today:** `curl install.sh | bash` → `release_installer.py` → extract to `~/.yulu` → `setup.sh` (brew deps, `swiftc` compile, launchd load, model download, skill install). Release is automated via release-please on Conventional Commits.

## Constraints

- **Platform**: macOS 13+ today — **floor STAYS 13+** (confirmed Phase 2): system audio is dual-arm behind one `if #available` seam — Core Audio process taps on 14.4+ (removes the weekly re-permission nag) / ScreenCaptureKit on 13–14.3 (preserves compatibility). We do NOT raise the floor to 14.4. Architecture must NOT hard-couple to macOS; a cross-platform abstraction layer is a first-class deliverable this milestone.
- **Privacy**: audio + transcripts stay local by default; any cloud (transcription or sync) is strictly opt-in and user-configured.
- **Agent-native**: reuse host coding-agent capabilities (`claude`/whisper/models/`gog`); do not duplicate runtimes/models the agent already has.
- **Compatibility**: existing v0.5.x `~/.yulu` installs must auto-migrate seamlessly on upgrade.
- **Distribution**: keep release-please + GitHub Releases + Conventional Commits as the release mechanism.
- **Agents targeted (v1)**: Claude Code, Codex, OpenClaw — behind one capability-provider abstraction.

## Key Decisions

<!-- Locked during project initialization (2026-05-29). -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Build the cross-platform abstraction layer **now** (macOS-only implementation) | Avoid deepening macOS lock-in; future Win/Linux; do the abstraction right while re-architecting | ✓ Done — Phase 2 (`yulu_platform/` ABCs + macOS impls; Linux/Windows = NotImplementedError stubs) |
| Install model = **agent-orchestrated provisioning** (not drag-to-`/Applications`) | Most agent-native and cross-platform-friendly; an OS bundle over-fits macOS | ✓ Done — Phase 6 (`provision/` named idempotent step registry, agent-drivable via `yulu provision`; spike resolved WHO-calls = dual, signed-zip `curl\|bash` stays PRIMARY fallback) |
| Existing installs get **seamless auto-migration** | Protect current v0.5.x users | ✓ Done — Phase 7 (`yulu migrate` detect→plan→apply→verify, recording-guard, transactional `yulu rollback`, prune-on-success) |
| Cloud sync = **configurable data folder** (iCloud / Google Drive), not a custom backend | Local-first; Obsidian model; zero server burden | ✓ Done — Phase 5 (configurable `data_dir`, runtime/content split + LOCK, cloud-root detect-and-warn) |
| Transcription is **configurable**: local / cloud-fallback / cloud-priority | Local-first default, but user choice | ✓ Done — Phase 4 (mode radios + cloud-command field, Yulu holds NO cloud keys) |
| **Multi-agent from v1** (Claude Code + Codex + OpenClaw) via a capability-provider abstraction | Yulu is agent-native, not single-vendor | ✓ Done — Phase 8 (Codex + OpenClaw providers, 3-agent doctor aggregation) |
| **Decouple skill install** from core install | The agent must be able to install/update the skill independently | ✓ Done — Phase 6 (`yulu skill install [--agent]`, removed from `setup.sh` flow) |
| **macOS floor stays 13+** — dual-arm audio capture (Core Audio taps on 14.4+ / ScreenCaptureKit on 13–14.3 behind one `if #available` seam) | Milestone goal is abstraction, not platform-dropping; raising the floor to 14.4 would strand existing 13–14.3 users. Taps arm kills the 14.4+ re-permission nag; SCK arm keeps compatibility | ✓ Decided 2026-05-30 (Phase 2) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-29 after initialization*
