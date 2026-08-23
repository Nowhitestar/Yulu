# Yulu (语录)

## What This Is

Yulu is a local-first, **agent-optional** native meeting recorder for macOS. It captures system audio and microphone locally, then lets the user choose local transcription, xAI, a supported local Agent Runtime, a Model Gateway, or a Direct Model API for transcription, summaries, and meeting conversation. Audio or transcript content leaves the laptop only after the user explicitly enables a cloud capability.

Its mental model remains **Obsidian-like**: Yulu owns local capture, retrieval, and durable artifacts; the user selects the intelligence provider. Agent Runtimes are supported, but Hermes or any other single agent is never a prerequisite.

## Core Value

A new user can install Yulu, record a real meeting, and obtain saved audio, transcript, and summary without having to understand Yulu's internal daemons or install a specific agent.

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

**Current milestone: v0.6 Reliable Distribution & Activation**

- [ ] A stable release installer works independently of the repository's moving `main` branch and supports the documented macOS 13+ floor
- [ ] Install and update never interrupt an active recording, and optional agent/calendar dependencies are not core-install blockers
- [ ] One state-driven activation flow serves new installs, upgrades, and developer installs, skipping capabilities that are already ready
- [ ] Core Activation proves a real saved recording, transcript, and summary; command detection alone is not treated as readiness
- [ ] Transcription, Summary Provider, and Conversation Provider are independent choices with explicit credential ownership, real probes, task pinning, and no silent fallback
- [ ] xAI is a first-class option for transcription, summary, and cited conversation over locally selected meeting excerpts
- [ ] Codex, Claude Code, Hermes, and OpenClaw are supported without making any one of them mandatory; CLIProxyAPI remains an advanced user-managed gateway
- [ ] Calendar, sharing, and conversation are reachable optional activation steps with configure-now or defer choices
- [ ] README, website, installer, About, and release metadata describe the same supported paths and limitations

### Out of Scope

<!-- Explicit boundaries with reasoning. -->

- Actual Windows/Linux runtime implementations — architecture must be platform-agnostic, but only macOS is implemented this milestone (deferred to a future milestone)
- A self-hosted cloud backend / Yulu-run sync service — cloud sync is delegated to the user's own folder sync (iCloud / Google Drive); Yulu runs no servers and holds no accounts
- Accounts / multi-user / team features — Yulu is local-first and single-user
- Full Grok Web/X search agent and write connectors — v0.6 conversation is bounded to local meeting retrieval
- Bundling or forking CLIProxyAPI — advanced users may point Yulu at their own compatible gateway
- Silent provider failover — a failed provider pauses the task and asks the user to choose

## Context

- **Codebase map:** `.planning/codebase/` (ARCHITECTURE, STRUCTURE, STACK, INTEGRATIONS, CONVENTIONS, TESTING, CONCERNS) — generated 2026-05-29, grounds this milestone.
- **The integration seams already exist.** `agent-queue.json`, provider-native Agent Console sessions, xAI OAuth/audio, local search, Settings, and Health should be extended rather than replaced.
- **Current release blockers are concrete.** The README `raw/main` installer is not paired with the latest release asset, current release Mach-O binaries target macOS 26 despite the macOS 13 claim, and updater safety does not guard active recordings.
- **Current activation is incomplete.** The earlier onboarding surface was removed, setup still assumes Hermes in important paths, and calendar/share configuration surfaces are not reachable from the user's failure states.
- **xAI release gate:** replace the public Grok CLI client ID with a Yulu-owned xAI client registration and verify language-model plus Responses access before broad distribution.

## Constraints

- **Platform**: macOS 13+ today — **floor STAYS 13+** (confirmed Phase 2): system audio is dual-arm behind one `if #available` seam — Core Audio process taps on 14.4+ (removes the weekly re-permission nag) / ScreenCaptureKit on 13–14.3 (preserves compatibility). We do NOT raise the floor to 14.4. Architecture must NOT hard-couple to macOS; a cross-platform abstraction layer is a first-class deliverable this milestone.
- **Privacy**: audio, transcripts, and conversation history stay local by default. Cloud upload requires capability-specific disclosure and consent; xAI conversation sends bounded selected excerpts with `store:false`.
- **Provider ownership**: Codex/Claude OAuth remains owned by their official runtimes; Hermes/OpenClaw use gateways; direct model and gateway credentials are stored in macOS Keychain.
- **Compatibility**: existing v0.5.x `~/.yulu` installs must auto-migrate seamlessly on upgrade.
- **Distribution**: keep release-please + GitHub Releases + Conventional Commits as the release mechanism.
- **Agents targeted (v0.6)**: Codex, Claude Code, Hermes, and OpenClaw. Summary and conversation providers are independent roles.

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
| Providers split into Agent Runtime, Model Gateway, and Direct Model API | Authentication, credential custody, execution, and readiness differ materially | Locked for v0.6 |
| Transcription, summary, and conversation are independent selections | A provider being ready for one capability does not prove another | Locked for v0.6 |
| xAI conversation uses local retrieval and `store:false` | Preserve local-first control while enabling useful meeting Q&A | Locked for v0.6 |

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
*Last updated: 2026-08-23 for milestone v0.6*
