# Feature Research

**Domain:** Agent-native, local-first install & configuration experience (provisioning, onboarding, settings, optional folder-sync, configurable transcription, agent-orchestrated install, seamless migration)
**Researched:** 2026-05-29
**Confidence:** MEDIUM (most findings are WebSearch + official-docs verified; agent-orchestrated provisioning UX is an emerging space with thinner precedent — flagged LOW where noted)

> Scoped to the EXPERIENCE Yulu is adding, not its recording/transcription internals. Comparables analyzed: Obsidian (vault-as-folder, optional sync), Ollama (capability autodetection), Superwhisper / Wispr Flow / Sotto (local-vs-cloud transcription UX), Claude Desktop Desktop Extensions (`.mcpb` one-click MCP install), `npx skills` / vercel-labs/skills (agent skill install), `brew doctor` / `brew config` (resolved-path transparency), Hermes/OpenClaw (auto-detect `~/.openclaw` migration).
>
> Categorization respects PROJECT.md **Out of Scope**: no self-hosted cloud backend / sync service, no accounts/multi-user, no drag-to-`/Applications` `.app` install.

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist in a local-first dev/agent tool. Missing these = product feels broken or untrustworthy.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Skippable / deferrable first-run walkthrough** | Progressive-onboarding norm: let users skip or delay; never force >4 screens before value. Re-accessible later. | LOW | Browser onboarding at `:7777`. Max ~7 short steps; a persistent "Skip / I'll do this later" path. Surface a "re-run setup" entry in settings (re-accessible help is table stakes). |
| **Permission walkthrough with status feedback** | Superwhisper/Wispr show guided mic/screen-permission dialogs + a confirmation that "your setup works." Users expect to *see* permissions resolve, not guess. | MEDIUM (macOS TCC already exists; needs browser-visible status, not just CLI) | Yulu already does `tccutil` in `setup.sh`. Gap: the **web UI has no capability-surfacing endpoint** (CONCERNS 9c). Onboarding must show ScreenCapture/Mic state live and a "test it" confirmation. |
| **Autodetect host capabilities, don't blindly reinstall** | Ollama autodetects GPUs/VRAM on startup; `brew doctor` detects existing git and uses it. Tools are expected to find what's there before duplicating. | MEDIUM | Directly fixes CONCERNS 4a–4d/9b. `doctor.py` must probe `claude`, `whisper-cli`, `mlx-whisper` importability, `llm.command`, model paths, recording-dir writability. Detection is the prerequisite for *every* differentiator below. |
| **"Doctor"/health command that names resolved paths** | `brew config`/`brew doctor` print `Git: 2.50.1 => /Library/.../git`. Users expect to see exactly which binary/model is in use and where. | MEDIUM | Yulu has `doctor.py` but it checks the wrong things (codex/gh, not claude/whisper/llm.command — CONCERNS 4d/5a/5b). Extend the JSON report; the settings UI consumes it. |
| **Settings page that shows + edits the real config** | Any local-first app (Obsidian, Superwhisper) exposes data location, model, and engine in a settings UI that reflects the live config file. | MEDIUM | Needs a `host_capabilities` tRPC endpoint backed by `doctor.py` JSON. Today the page can't display backend/model/llm.command because the data doesn't exist. |
| **Model selection from a list** | Superwhisper exposes model sizes (Nano/Fast/Pro/Ultra); users expect to pick a model and see size/speed tradeoff. | MEDIUM | Selector should browse `~/.cache/huggingface/`, known whisper.cpp dirs, AND `~/.config/yulu/models/` so a host-cached model is reused, not re-downloaded (CONCERNS 4c). |
| **Configurable data-folder location** | Obsidian's defining UX: "open folder as vault," Browse to pick the location. Users expect to choose where their data lives. | MEDIUM | The enabler for folder-sync. Must rewrite all hardcoded `~/Movies/Yulu` reads — incl. the `status_agent.swift` bug that ignores `config.json` (CONCERNS 1e/6d). |
| **Seamless upgrade: no data loss, no reconfig** | Local-first norm — "access and edit your data for decades." Users expect upgrades to preserve config, data, and granted permissions silently. | HIGH | Existing v0.5.x `~/.yulu` installs must auto-migrate. Patent/industry pattern: prepare new schema, migrate, keep old recoverable. Must NOT re-prompt OAuth/TCC (upgrade idempotency already partly exists in `setup.sh --upgrade`). |
| **Don't truncate active work during upgrade** | Data-loss avoidance is assumed. Killing a live recording mid-upgrade is a trust-breaker. | LOW | Fixes CONCERNS 2d: check recording state via socket before `pkill -9`; refuse/drain if recording. |
| **Idempotent, re-runnable install steps** | `npx skills` and good installers are safe to run repeatedly; users expect re-running setup to heal, not break. | MEDIUM | Decompose the 1,342-line `setup.sh` (CONCERNS 2a), add `set -uo pipefail` (6c). Each step re-runnable. |
| **Clear "this stays local" privacy default** | Local-first transcription tools (Superwhisper, local-Whisper users) treat on-device-by-default as the contract; any cloud is opt-in and visible. | LOW | PROJECT.md constraint. Default = local Whisper; cloud strictly opt-in and labeled. Settings must make the active mode obvious. |

### Differentiators (Competitive Advantage)

Features that express Yulu's agent-native, local-first edge. These align with Core Value ("through the agent they already trust... never makes the user reconfigure what their agent already provides").

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Agent-orchestrated provisioning** | Yulu is installed/provisioned *by the user's coding agent* rather than an OS installer. Most agent-native install model in the space; emerging frontier (Super CLI translates intent→command sequence). | HIGH | LOW confidence on a settled "best practice" — this is novel. De-risk via spike (PROJECT.md). UX expectation: the agent runs idempotent, named steps (`yulu skill install`, `yulu doctor`, `yulu migrate`) and reports status back, not a black-box script. |
| **Reuse host-agent capabilities instead of duplicating** | "We detected your existing whisper / `claude` / models / `gog` and are using them." Saves GBs of disk and avoids version drift. Ollama/`brew doctor` autodetect; almost nobody *reuses another agent's* configured stack — this is Yulu-specific. | HIGH | The headline differentiator. Needs the "agent capability provider" abstraction across Claude Code + Codex + OpenClaw. Depends entirely on host-capability detection (table stakes). |
| **Settings UI that explicitly shows "reusing X you already have"** | Per-capability provenance: each capability row shows source (host vs Yulu-managed), resolved path, and "in use." Mirrors `brew config`'s `=> /path` and Hermes's credential manager that *marks which providers already have a key*. | MEDIUM | Differentiator is the **provenance labeling**, not just showing values. E.g. "Whisper: `whisper-cli` 1.7 (from your PATH — reused)" vs "(downloaded by Yulu)". Drives the trust story. Depends on the doctor capability report. |
| **Decoupled, agent-invokable skill install** | `yulu skill install [--agent]` — standalone, idempotent, re-runnable by the agent independently of core install. Matches the `npx skills add -a <agent> -y` non-interactive pattern. | MEDIUM | Extract from `setup.sh` step 7 (CONCERNS 3a). Remove hardcoded personal paths in `sync_skill.py` (3b). The agent updates its own skill without a full reinstall. |
| **Multi-agent capability provider (Claude Code + Codex + OpenClaw)** | One abstraction targets three agents; Yulu is agent-native, not single-vendor. Extends the existing `llm.command` / `agent-queue.json` seam. | HIGH | The seam already exists (ARCHITECTURE: agent-queue is the integration boundary). Provider abstraction maps "detect capability" + "install skill" per agent. |
| **Configurable transcription mode: local / cloud-fallback / cloud-priority** | Sotto offers "local Whisper with optional cloud fallback"; Superwhisper offers local-core + optional cloud post-processing. Yulu's three-mode model (local-first default, opt-in fallback, opt-in priority) is a clean, explicit superset. | MEDIUM | Expose as 3 radio options with plain-language captions ("Local only — audio never leaves your Mac" / "Local first, cloud if local fails" / "Cloud first for accuracy"). Privacy implication shown inline per mode. Cloud requires user-supplied credential/command — no Yulu backend. |
| **Folder-sync via configurable data folder (Obsidian model)** | "Your data is a folder — point it at iCloud/Google Drive; sync is the OS's job." Zero server burden, zero accounts. Obsidian's signature local-first move. | MEDIUM | Differentiator vs cloud meeting recorders that lock data in a SaaS. UX: data-folder picker + a one-line explainer + a "now move it into your synced folder" guide. Yulu writes files; the OS syncs them. |
| **Pre-compiled signed binaries (no Xcode/`swiftc` at install)** | Install doesn't require an ~11GB Xcode toolchain; faster, friendlier, and an agent can provision without compiling. | HIGH (signing/notarization is the hard part) | CONCERNS 1d/2c. Ship notarized `Yulu.app`/`StatusAgent.app` in release zips; remove `compile_audio_daemon()` from release path (keep for `--dev`). Enables the agent-provisioning + cross-platform goals. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but conflict with Yulu's identity or PROJECT.md boundaries. **These are deliberately NOT built.**

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Yulu-hosted cloud sync / sync service** | "Just sync my notes for me like Obsidian Sync / Otter." | Violates PROJECT.md (no self-hosted backend, no accounts). Adds server cost, privacy liability, ongoing ops. | Folder-sync: point the data folder at iCloud/Google Drive; OS syncs. (Obsidian Sync is paid/optional precisely because the folder model is the default.) |
| **Accounts / login / multi-user / teams** | "Share meetings with my team," "sign in to sync." | PROJECT.md: local-first, single-user. Auth implies a backend, identity, and data-leaving-device. | Single-user local. Sharing = the user hands off the Markdown file or syncs the folder. |
| **Drag-to-`/Applications` `.app` as THE install model** | "Just give me a normal Mac app." | Over-fits macOS, fights the cross-platform abstraction, and contradicts agent-orchestrated provisioning (PROJECT.md Out of Scope). | Agent-orchestrated provisioning + pre-built binaries inside the runtime. (A `.app` bundle *exists* for the daemon, but it's not the install UX.) |
| **Built-in cloud transcription with Yulu-managed API keys** | "Make cloud transcription one-click — you hold the key." | Yulu would proxy/hold credentials = a backend + liability. Breaks "audio never leaves unless the user opts in *with their own* provider." | Cloud modes use the *user's own* command/credentials (same model as `llm.command`). Yulu stores no keys server-side. |
| **Forced, unskippable onboarding wizard** | "Make sure users configure everything correctly." | Progressive-onboarding research: forcing >4 screens / no skip causes drop-off and frustration; dev-tool users especially resent it. | Skippable walkthrough + sensible defaults (local Whisper, default data folder). `yulu doctor` catches gaps later. |
| **Auto-installing Homebrew / heavy deps without consent** | "Just make it work — install whatever's needed." | `setup.sh` already `curl|bash`-installs Homebrew unconditionally (CONCERNS 1f); silent heavy installs erode trust and duplicate host tooling. | Detect first (reuse host whisper/models). If a dep is truly missing, *ask* and name it before installing. |
| **Auto-uploading audio to a cloud model "for better accuracy" by default** | "Cloud Whisper is more accurate." | Silently defeats the local-first privacy contract; this is the exact thing Superwhisper users distrust about always-cloud tools (Wispr Flow critique). | Cloud is opt-in via the transcription-mode setting, never the default, always labeled. |
| **A second, Yulu-specific model/venv when the host already has one** | "Bundle everything so it always works." | Root cause of CONCERNS 4a–4c: duplicate `venv-mlx-whisper`, brew `whisper-cpp`, duplicated models — wasted GBs, version drift, the dead `mlx_python` field. | Detect + reuse host installs; only manage Yulu's own when nothing suitable is found, and *show* which path won. |
| **Custom GUI file-sync engine / conflict resolution (CRDTs)** | "Handle sync conflicts when two devices edit." | Massive complexity (CRDT/merge engines); duplicates what iCloud/Drive already do; out of scope. | Delegate to the OS sync provider. Document the single-writer expectation (Yulu is single-user, single-machine-at-a-time). |

## Feature Dependencies

```
Host-capability detection (doctor.py probes)         [TABLE STAKES — foundational]
    ├──requires──> Decompose setup.sh + pipefail (clean, testable steps)
    ├──enables──> Reuse host capabilities                 [DIFFERENTIATOR]
    ├──enables──> Settings UI capability surfacing         [TABLE STAKES → DIFFERENTIATOR via provenance]
    │                  └──requires──> host_capabilities tRPC endpoint
    ├──enables──> Model selection from list
    └──enables──> Configurable transcription mode (validates host whisper/cloud cmd)

Configurable data-folder location                    [TABLE STAKES]
    ├──requires──> Remove hardcoded ~/Movies/Yulu (fix status_agent.swift)
    └──enables──> Folder-sync (Obsidian model)            [DIFFERENTIATOR]

Pre-compiled signed/notarized binaries               [DIFFERENTIATOR]
    └──enables──> Agent-orchestrated provisioning (no swiftc at install) [DIFFERENTIATOR]
                       └──requires──> Decoupled skill install (yulu skill install)
                       └──requires──> Multi-agent capability provider abstraction

Seamless auto-migration                              [TABLE STAKES]
    ├──requires──> Idempotent steps + don't-truncate-recording guard
    └──requires──> Stable config schema (so old ~/.yulu maps to new model)

Capability-provider abstraction (CC + Codex + OpenClaw) [DIFFERENTIATOR]
    └──requires──> Host-capability detection (per-agent probes)
```

### Dependency Notes

- **Everything reuse-related requires detection first:** `doctor.py` host-capability probes are the single foundational dependency. Reuse, settings surfacing, model selection, and transcription-mode validation all consume the same capability report. Build detection before any "reuse" UX.
- **Folder-sync requires the configurable data folder, which requires de-hardcoding paths:** Can't point a folder at iCloud until the folder location is real config AND every reader (incl. `status_agent.swift`, CONCERNS 6d) honors it.
- **Agent-orchestrated provisioning requires pre-built binaries:** An agent can't be expected to drive an ~11GB Xcode `swiftc` compile. Notarized binaries in the release zip are the unlock (and also fix the fragile `xattr` quarantine strip).
- **Migration requires idempotency + schema stability:** Auto-migration is safe only if steps are re-runnable and the old `~/.yulu` config maps deterministically to the new model. Decomposing `setup.sh` is a shared prerequisite of both migration and idempotent install.
- **Settings provenance is the differentiator on top of a table-stakes settings page:** The page itself is table stakes; the "reused vs Yulu-managed, here's the resolved path" labeling is the agent-native edge.

## MVP Definition

> Framed as milestone priorities (this is a brownfield milestone, not a product v1). "Launch With" = ship this milestone; later tiers = sequence within/after.

### Launch With (this milestone)

- [ ] **`doctor.py` host-capability probes** — foundational; unblocks reuse + settings + transcription validation. (CONCERNS 4d/5a/5b/9b)
- [ ] **Settings UI capability surfacing (with provenance labels)** — `host_capabilities` endpoint + page showing backend/model/llm.command/recording-dir, marked reused-vs-managed. (CONCERNS 9c)
- [ ] **Reuse host capabilities instead of duplicating** — detect-then-reuse whisper/models/`claude`/`gog`; stop unconditional brew/venv installs. (CONCERNS 4a–4c)
- [ ] **Configurable data-folder location** — real config + de-hardcode `~/Movies/Yulu` (fix `status_agent.swift`). Enables folder-sync. (CONCERNS 1e/6d)
- [ ] **Configurable transcription mode (local / cloud-fallback / cloud-priority)** — local default, opt-in cloud via user's own command.
- [ ] **Seamless auto-migration of v0.5.x `~/.yulu`** — no data loss, no reconfig; don't truncate active recordings. (CONCERNS 2d)
- [ ] **Decoupled, idempotent `yulu skill install [--agent]`** — out of `setup.sh`; agent-invokable. (CONCERNS 3a/3b)
- [ ] **Decompose `setup.sh` + `set -uo pipefail`** — prerequisite for idempotency, migration, and cross-platform steps. (CONCERNS 2a/6c)
- [ ] **Pre-compiled (signed, ideally notarized) binaries in release** — remove `swiftc` from release install path. (CONCERNS 1d/2c)
- [ ] **Browser first-run walkthrough (skippable)** — short, permission status + "test it" confirmation, re-runnable.

### Add After Validation (next within milestone / fast-follow)

- [ ] **Multi-agent capability provider for all three (CC + Codex + OpenClaw)** — start with one agent end-to-end, then generalize the abstraction. Trigger: single-agent reuse proven.
- [ ] **Agent-orchestrated provisioning as the primary install UX** — gate behind the spike (PROJECT.md "validate the riskiest path"). Trigger: spike confirms the agent can drive idempotent named steps reliably.
- [ ] **Folder-sync guidance UX** — picker + "move it into iCloud/Drive" walkthrough + sync-conflict caveat. Trigger: configurable data folder shipped and stable.
- [ ] **Model browser across host caches** — browse `~/.cache/huggingface/` + whisper.cpp dirs in the selector. Trigger: basic model selection working.

### Future Consideration (later milestones)

- [ ] **Actual Windows/Linux runtime** — architecture is abstracted this milestone; implementation deferred (PROJECT.md Out of Scope). The `CaptureBackend`/`DaemonManager` stubs land now.
- [ ] **Backup cleanup policy / `yulu cleanup-backups`** — defer unless disk bloat reported. (CONCERNS 2e)
- [ ] **Signed-installer verification (`--verify` SHA/GPG)** — hardens `curl|bash`; more pressing once agent automates the same path. (CONCERNS 2b)

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| `doctor.py` host-capability probes | HIGH | MEDIUM | P1 |
| Settings capability surfacing (+provenance) | HIGH | MEDIUM | P1 |
| Reuse host capabilities (no duplication) | HIGH | HIGH | P1 |
| Configurable data-folder location | HIGH | MEDIUM | P1 |
| Configurable transcription mode | HIGH | MEDIUM | P1 |
| Seamless auto-migration (no data loss) | HIGH | HIGH | P1 |
| Decouple `setup.sh` + pipefail | MEDIUM | MEDIUM | P1 (prereq) |
| Decoupled `yulu skill install` | MEDIUM | MEDIUM | P1 |
| Pre-compiled signed binaries | HIGH | HIGH | P1 |
| Skippable browser onboarding | MEDIUM | LOW | P1 |
| Don't-truncate-recording upgrade guard | MEDIUM | LOW | P1 |
| Multi-agent capability provider (3 agents) | HIGH | HIGH | P2 |
| Agent-orchestrated provisioning (primary UX) | HIGH | HIGH | P2 (spike-gated) |
| Folder-sync guidance UX | MEDIUM | MEDIUM | P2 |
| Model browser across host caches | MEDIUM | MEDIUM | P2 |
| Notarization (Apple Developer ID) | MEDIUM | HIGH | P2 |
| Backup cleanup policy | LOW | LOW | P3 |
| Installer signature verification | MEDIUM | MEDIUM | P3 |
| Windows/Linux runtime implementation | HIGH (future) | HIGH | P3 |

**Priority key:** P1 = ship this milestone · P2 = should-have, within/just-after milestone · P3 = future milestone.

## Competitor Feature Analysis

| Feature area | Obsidian | Ollama | Superwhisper / Sotto | Claude Desktop / `npx skills` | Yulu's Approach |
|--------------|----------|--------|----------------------|-------------------------------|-----------------|
| **Data location / sync** | Vault = folder; "open folder as vault"; sync via iCloud/Drive (paid Sync is optional) | n/a | App-managed | n/a | Configurable data folder → user points at iCloud/Drive (Obsidian model, no Yulu backend) |
| **Capability detection** | n/a | Autodetects GPU/VRAM/LLM lib on startup | Detects mic/permissions in onboarding | n/a | `doctor.py` probes claude/whisper/mlx/models/gog; reuses host installs |
| **Showing what's in use** | n/a | `ollama ps` PROCESSOR column; `--verbose` "using CUDA" | Shows active model/mode | Credential manager marks which providers have keys | Settings rows with provenance: "reused (from PATH)" vs "Yulu-managed", resolved path (`brew config`-style) |
| **Local vs cloud** | n/a | Local only | Local-core + optional cloud (Sotto: local + cloud fallback) | n/a | 3 modes: local / cloud-fallback / cloud-priority, local default, user's own cloud cmd |
| **Install / provisioning** | Drag `.app` | `curl|sh` or installer | Drag `.app` | `.mcpb` double-click; `npx skills add -a <agent> -y` | Agent-orchestrated provisioning (novel) + decoupled `yulu skill install`, pre-built binaries |
| **Onboarding** | Minimal; open vault | Run a model | Guided permission + "test it" confirmation | Settings > Extensions, configure only secrets | Skippable browser walkthrough; permission status + test; defaults pre-set |
| **Migration** | Move folder | n/a | App handles | n/a | Auto-migrate `~/.yulu`; no reconfig, no data loss (cf. Hermes auto-detecting `~/.openclaw`) |

## Sources

- Obsidian vault-as-folder / sync location UX — https://obsidian.md/help/sync/switch , https://app.studyraid.com/en/read/46771/2196210/choosing-a-vault-location-cloud-sync , https://www.stephanmiller.com/sync-obsidian-vault-across-devices/ (MEDIUM — community + official help)
- Ollama capability autodetection / `ollama ps` / `--verbose` — https://docs.ollama.com/troubleshooting , https://knightli.com/en/2026/04/06/check-ollama-model-loaded-on-gpu/ (MEDIUM — official docs + corroborating guide)
- Local vs cloud transcription modes (Sotto fallback, Superwhisper local-core, Wispr privacy toggle) — https://sotto.to/blog/whisper-local-vs-cloud , https://openwhispr.com/blog/local-vs-cloud-transcription , https://docs.wisprflow.ai/articles/6274675613-privacy-mode-data-retention (MEDIUM)
- Superwhisper first-run / model selection / permission flow — https://superwhisper.com/docs/get-started/introduction , https://www.developersdigest.tech/tools/superwhisper (MEDIUM)
- Claude Desktop Desktop Extensions (`.mcpb`) one-click install; sensitive fields auto-encrypted, only secrets prompted — https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop (HIGH — official)
- `npx skills` / vercel-labs/skills install (`-a <agent>`, `-g`, `-y`, idempotent) — https://github.com/vercel-labs/skills , https://code.claude.com/docs/en/skills (HIGH — official + source repo)
- Progressive onboarding best practices (skippable, ≤7 steps, quick win, re-accessible) — https://userguiding.com/blog/progressive-onboarding , https://www.toptal.com/designers/product-design/guide-to-onboarding-ux (MEDIUM)
- `brew config` / `brew doctor` resolved-path transparency (`Git: => /path`) — https://github.com/Homebrew/brew/issues/21334 (MEDIUM — issue threads show output format)
- Hermes auto-detects `~/.openclaw`, offers migration of settings/keys/skills; credential manager marks configured providers — https://github.com/nousresearch/hermes-agent (LOW/MEDIUM — single source; strong analog for migration + "what's configured" UX)
- Local-first data migration / data-preserving upgrade patterns — https://rxdb.info/migration-schema.html , https://blog.devstract.site/technical-deep-dive/the-rise-of-local-first-software/ (MEDIUM)
- Yulu codebase context — `.planning/PROJECT.md`, `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md` (HIGH — primary)

---
*Feature research for: agent-native local-first install & configuration experience*
*Researched: 2026-05-29*
