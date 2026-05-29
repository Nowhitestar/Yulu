# Architecture Research

**Domain:** Platform-abstraction + agent-capability + agent-orchestrated-provisioning layers for a brownfield local-first meeting recorder (Yulu — "Agent-Native Provisioning & Cross-Platform Foundation" milestone)
**Researched:** 2026-05-29
**Confidence:** HIGH for the seam *placement* (grounded in the existing codebase map + proven `service-manager-rs`/`cpal` API shapes from STACK.md); MEDIUM for the agent-orchestrated-provisioning structure (emerging space, spike-gated per PROJECT.md).

> **Scope discipline (brownfield).** Yulu's running architecture is already mapped in `.planning/codebase/ARCHITECTURE.md` (8 launchd daemons, Unix-socket IPC, the `agent-queue.json` integration boundary, the `llm.command` process boundary). This file does NOT re-derive that. It defines the **structure of the new layers** this milestone adds and **exactly where each abstraction seam sits** so the existing macOS code stays clean and a future Linux/Windows impl drops in behind the same interface.
>
> **Build-status legend** (carried from STACK.md): **[BUILD NOW]** = macOS impl + portable interface ships this milestone · **[INTERFACE-ONLY]** = define the seam, stub the non-macOS arm, no impl · **[DEFER]** = future milestone.
>
> **Locked constraints honored** (PROJECT.md): abstraction-now / macOS-only-impl; agent-orchestrated provisioning; reuse host capabilities; configurable data folder; configurable transcription; multi-agent (CC + Codex + OpenClaw); decoupled skill install; seamless `~/.yulu` auto-migration; keep release-please.

## Standard Architecture

### System Overview

The milestone adds **three new horizontal layers** to the existing daemon system, plus one new data flow (the capability report) that threads through all of them. The existing daemons and the `agent-queue.json` seam are unchanged — they sit *below* the new platform layer and *consume* it.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  AGENT-ORCHESTRATION SURFACE  (new — how the host agent drives Yulu)       │
│  ┌────────────────────┐   ┌────────────────────┐   ┌───────────────────┐  │
│  │ yulu provision     │   │ yulu skill install │   │ yulu migrate      │  │
│  │ <step> (idempotent)│   │ [--agent]          │   │ (v0.5.x → new)    │  │
│  └─────────┬──────────┘   └─────────┬──────────┘   └────────┬──────────┘  │
│            │  named, status-reporting, re-runnable steps     │             │
├────────────┼────────────────────────┼────────────────────────┼────────────┤
│  CAPABILITY LAYER  (new — "what does the host already have?")              │
│  ┌──────────────────────────┐   ┌──────────────────────────────────────┐  │
│  │ CapabilityProvider iface │   │ doctor.py host_capabilities probe    │  │
│  │  - ClaudeCodeProvider    │◄──┤  resolve-PATH · import-probe ·       │  │
│  │  - CodexProvider         │   │  model-scan · llm.command validate   │  │
│  │  - OpenClawProvider      │   │  → emits HostCapabilityReport (JSON) │  │
│  └────────────┬─────────────┘   └───────────────────┬──────────────────┘  │
├───────────────┼──────────────────────────────────────┼─────────────────────┤
│  PLATFORM-ABSTRACTION LAYER  (new — macOS impl now, Win/Linux stubbed)     │
│  ┌───────────────┐ ┌──────────────┐ ┌───────────┐ ┌────────┐ ┌─────────┐  │
│  │ CaptureBackend│ │ DaemonManager│ │ PathResolv│ │ Perms  │ │ DepsMgr │  │
│  │ (PCM+sources) │ │ (install/load│ │ (data/cfg │ │ (TCC / │ │ (detect-│  │
│  │  macOS=SCK→   │ │  /unload/    │ │  /cache   │ │ check/ │ │ first   │  │
│  │  CoreAudio tap│ │  status)     │ │  dirs)    │ │ request│ │ install)│  │
│  └───────┬───────┘ └──────┬───────┘ └─────┬─────┘ └───┬────┘ └────┬────┘  │
├──────────┼────────────────┼────────────────┼───────────┼──────────┼────────┤
│  EXISTING RUNTIME  (unchanged — consumes the layer above)                  │
│  audio_daemon (Swift) · stt_daemon · agent_queue_worker · scheduler ·      │
│  detector · calendar · yulu_ui · agent-queue.json · llm.command            │
└────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼  (UI reads the same HostCapabilityReport)
┌──────────────────────────────────────────────────────────────────────────┐
│  yulu_ui SETTINGS  (new tRPC endpoint surfacing capabilities + config)     │
│  hostCapabilities → settings page (provenance: "reused" vs "Yulu-managed") │
│  + transcription-mode + model selector + data-folder picker                │
└────────────────────────────────────────────────────────────────────────────┘
```

**Key structural insight:** the `HostCapabilityReport` (a single JSON document produced by `doctor.py`) is the **spine** of this milestone. Detection produces it once; provisioning consumes it to decide what to reuse-vs-install; the settings UI renders it; transcription-mode config validates against it. FEATURES.md identifies detection as the single foundational dependency — architecturally that means **the report schema is the first thing to lock**, because four downstream consumers bind to it.

### Component Responsibilities

| Component | Responsibility (what it OWNS) | Build status | Talks to |
|-----------|-------------------------------|--------------|----------|
| **`CaptureBackend`** (protocol) | The seam between "give me system+mic audio" and "ScreenCaptureKit/CoreAudio". Owns the contract: `start/stop/status/list_sources`, emits **PCM frames + a source list** (cpal-shaped, NOT SCK-shaped). | [BUILD NOW] protocol + macOS impl | `record_audio.py` (start/stop), `audio_daemon` internals |
| **`DaemonManager`** (interface) | The seam between "supervise this daemon" and "launchctl/plist". Owns `install/load/unload/status/restart` over a **neutral ServiceSpec** (service-manager-rs-shaped). | [BUILD NOW] interface + macOS impl | `yulu start/stop`, setup scripts, `doctor.py`, `yulu_ui` (status reads) |
| **`PathResolver`** | The single source of truth for *where things live*: data dir, config dir, cache dir, launch-agent dir, recordings dir. Replaces every hardcoded `~/.config/yulu` / `~/Movies/Yulu` / `~/Library/LaunchAgents`. | [BUILD NOW] | Every daemon, `status_agent.swift`, setup scripts |
| **`PermissionModel`** | The seam over TCC: `check(permission) → status`, `request(permission)`, `instructions(permission)`. macOS = TCC/`tccutil`; others report "n/a" or platform-native. | [BUILD NOW] interface + macOS impl | onboarding, `doctor.py`, `repair_permissions.py` |
| **`DependencyManager`** | "Ensure dependency X is available" with a **detect-first** contract: resolve host copy → only install if absent → never silently duplicate. macOS = Homebrew arm. | [BUILD NOW] interface + macOS impl | provisioning steps, `doctor.py` |
| **`CapabilityProvider`** (interface) | Per-agent uniform view: "what LLM command / whisper / models / `gog` has THIS agent configured, and where?" One impl per agent (CC / Codex / OpenClaw). | [BUILD NOW] interface + ≥1 impl; others fast-follow | `doctor.py` (aggregates), provisioning, skill install |
| **`doctor.py` host_capabilities probe** | Produces the `HostCapabilityReport` JSON: binaries (login-shell-resolved PATH), Python importability, model paths+sizes, `llm.command` validity, recording-dir writability. | [BUILD NOW] | Emits report; consumed by UI + provisioning |
| **`yulu provision <step>`** | The agent-facing orchestration surface: named, idempotent, status-reporting steps (not a black-box script). | [BUILD NOW] CLI surface; primary-UX spike-gated | Invokes the layers below; reads report |
| **`yulu migrate`** | Detects a v0.5.x `~/.yulu` install and migrates config/data/launch-agents to the new model, no data loss. | [BUILD NOW] | `PathResolver`, `DaemonManager`, config schema |
| **`yulu_ui` hostCapabilities endpoint** | tRPC procedure that shells `doctor.py --json`, returns the report to the settings page with provenance labels. | [BUILD NOW] | Reads report; writes config back |

## Recommended Project Structure

The existing tree is `yulu/scripts/` (flat Python + Swift + `yulu_ui/`). Introduce a **`platform/`** package and a **`capabilities/`** package as siblings — this keeps the new seams discoverable and isolates the macOS impls behind interface modules.

```
yulu/scripts/
├── platform/                      # NEW — the platform-abstraction layer
│   ├── __init__.py                # exports the interfaces + a get_platform() factory
│   ├── base.py                    # ABCs: CaptureBackend, DaemonManager, PathResolver,
│   │                              #        PermissionModel, DependencyManager + ServiceSpec
│   ├── macos/                     # [BUILD NOW] the only real impl this milestone
│   │   ├── daemon_manager.py      # launchctl + plist templating (wraps current logic)
│   │   ├── paths.py               # ~/.config/yulu, ~/Movies/Yulu, ~/Library/LaunchAgents
│   │   ├── permissions.py         # TCC: tccutil reset, check via socket round-trip
│   │   └── deps.py                # Homebrew arm of DependencyManager
│   ├── linux/                     # [INTERFACE-ONLY] stubs that raise NotImplementedError
│   │   └── __init__.py            #   (systemd / PipeWire / XDG path shapes, no impl)
│   └── windows/                   # [INTERFACE-ONLY] stubs
│       └── __init__.py
│
│   # NOTE: CaptureBackend's macOS *implementation* stays in Swift (audio_daemon.swift).
│   # platform/macos/ holds only the Python-side launcher/contract; the protocol is
│   # mirrored in Swift as a `protocol CaptureBackend` so the SCK→CoreAudio swap is
│   # behind one Swift seam too.
│
├── capabilities/                  # NEW — the agent-capability layer
│   ├── __init__.py
│   ├── provider.py                # CapabilityProvider ABC + the detection contract
│   ├── report.py                  # HostCapabilityReport dataclass + JSON (de)serialize
│   ├── resolve_path.py            # login-shell PATH resolver (shared by all probes)
│   ├── claude_code.py             # [BUILD NOW] first end-to-end provider
│   ├── codex.py                   # [fast-follow] second provider
│   └── openclaw.py                # [fast-follow] third provider
│
├── provision/                     # NEW — agent-orchestrated provisioning steps
│   ├── __init__.py
│   ├── steps.py                   # the named step registry (idempotent, status-reporting)
│   └── migrate.py                 # v0.5.x ~/.yulu detection + migration plan/apply
│
├── doctor.py                      # EXTENDED — adds host_capabilities section to JSON
├── audio_daemon.swift             # macOS CaptureBackend impl (SCK → CoreAudio tap migration)
├── stt_daemon/                    # unchanged; mlx/whisper backends already abstracted
├── agent_queue_worker.py          # unchanged — the llm.command boundary stays as-is
├── setup_*.sh                     # decomposed setup.sh (setup_audio/models/daemons/caps)
└── yulu_ui/src/
    └── server/routers/
        └── capabilities.ts        # NEW tRPC router → shells doctor.py --json
```

### Structure Rationale

- **`platform/base.py` holds ALL interfaces in one file:** the five seams are small (4–6 methods each) and co-locating them makes the abstraction contract reviewable as a single unit. A future Linux contributor reads one file to know what to implement.
- **`platform/macos/` is the ONLY directory with real logic this milestone:** `linux/` and `windows/` are `NotImplementedError` stubs. This makes the "macOS-only impl, abstraction-now" lock physically visible in the tree.
- **`capabilities/` is separate from `platform/`** because capability detection is **OS-independent in shape** (an agent's LLM command resolves the same way conceptually on any OS) — only the PATH-resolution detail is platform-specific, and that's a shared helper. Mixing it into `platform/` would wrongly couple "which agent" to "which OS".
- **`provision/` depends on both** `platform/` and `capabilities/` but nothing depends on it — it's the top of the stack. This one-directional dependency (provision → capabilities → platform → existing runtime) is the architecture's backbone and must not be violated.
- **The Swift seam mirrors the Python protocol:** `CaptureBackend` exists *twice* — as a Python ABC (the `record_audio.py`-facing contract) and as a Swift `protocol` inside `audio_daemon.swift` (the SCK-vs-CoreAudio-tap swap point). This is the one place the abstraction crosses the language boundary; keeping both named identically makes the seam obvious.

## Architectural Patterns

### Pattern 1: Interface-in-base, impl-in-platform-subpackage (the "drop-in" seam)

**What:** Every platform seam is an ABC in `platform/base.py`; concrete behavior lives in `platform/{macos,linux,windows}/`. A `get_platform()` factory dispatches on `sys.platform` and returns the bundle of impls. Callers import the ABC type, never a concrete class.

**When to use:** All five platform seams (`CaptureBackend`, `DaemonManager`, `PathResolver`, `PermissionModel`, `DependencyManager`).

**Where the boundary sits (the crux of the question):**
- **`CaptureBackend` boundary = "PCM frames + source list out", NOT "SCK content filter in".** The interface exposes `start(spec) / stop() / status() / list_sources() -> [AudioSource]`. It must NOT leak `SCStreamConfiguration`, window-picker IDs, or TCC scopes — those are macOS-impl details. This is the cpal-proven boundary (`Host.devices()` + a PCM data callback); STACK.md's SCK→CoreAudio-tap migration happens *entirely inside* the macOS impl, invisible to callers, because both produce the same PCM-frames output. A future PipeWire/WASAPI arm slots in by producing the same frames.
- **`DaemonManager` boundary = a neutral `ServiceSpec` + `install/load/unload/status/restart`.** Model it on `service-manager-rs`'s `ServiceManager` trait: `install(ServiceSpec)`, `start/stop/uninstall(label)`, with a `ServiceSpec` carrying `{label, program, args, env, working_dir, autostart, restart_policy}` and a `ServiceLevel.USER` default (Yulu daemons are all user-level launchd agents, never `/Library/LaunchDaemons`). The interface must NOT expose plist keys, `KeepAlive`, or `RunAtLoad` — those are how the macOS arm *renders* the neutral spec into a plist. A systemd arm renders the same spec into a `.service` unit.

**Trade-offs:** One indirection layer for a single-platform milestone. Justified by the locked "abstraction-now" decision and because it's the only way to fix the coupling without a rewrite later. Cost is real but bounded (5 small ABCs).

**Example:**
```python
# platform/base.py
class ServiceLevel(Enum): USER = "user"; SYSTEM = "system"

@dataclass
class ServiceSpec:                       # neutral — no plist/systemd vocabulary
    label: str; program: Path; args: list[str]
    env: dict[str, str]; working_dir: Path | None
    autostart: bool = True
    restart_policy: RestartPolicy = RestartPolicy.ON_FAILURE
    level: ServiceLevel = ServiceLevel.USER

class DaemonManager(ABC):
    @abstractmethod
    def install(self, spec: ServiceSpec) -> None: ...   # macOS: render plist + bootstrap
    @abstractmethod
    def load(self, label: str) -> None: ...             # macOS: launchctl bootstrap/enable
    @abstractmethod
    def unload(self, label: str) -> None: ...           # macOS: launchctl bootout
    @abstractmethod
    def status(self, label: str) -> ServiceStatus: ...  # backed by launchctl + psutil liveness
    @abstractmethod
    def restart(self, label: str) -> None: ...

class CaptureBackend(ABC):
    @abstractmethod
    def list_sources(self) -> list[AudioSource]: ...    # cpal Host.devices() shape
    @abstractmethod
    def start(self, spec: CaptureSpec) -> None: ...     # PCM frames begin flowing to WAV
    @abstractmethod
    def stop(self) -> CaptureResult: ...
    @abstractmethod
    def status(self) -> CaptureStatus: ...
```

### Pattern 2: The HostCapabilityReport as a single typed contract (detection spine)

**What:** `doctor.py` produces ONE versioned JSON document — `HostCapabilityReport` — describing every host capability with **provenance**. Every downstream consumer (settings UI, provisioning, transcription-mode validation) reads this *same* document. No consumer re-probes; detection happens once.

**When to use:** This is the foundational pattern of the milestone (FEATURES.md: "detection is the single foundational dependency... build detection before any reuse UX").

**The capability record shape (each row carries source + path + status):**
```python
@dataclass
class CapabilityRecord:
    name: str            # "whisper-cli" | "claude" | "mlx-whisper" | "gog" | "model:large-v3"
    available: bool
    source: Literal["host-path", "yulu-managed", "agent-config", "absent"]  # PROVENANCE
    resolved_path: str | None        # the brew config "=> /path" transparency
    version: str | None
    detail: dict                     # size for models, importable-from for python pkgs, etc.

@dataclass
class HostCapabilityReport:
    schema_version: int              # bump when consumers must adapt
    generated_at: str
    capabilities: list[CapabilityRecord]
    recording_dir: CapabilityRecord  # writability + free space folded in as a record
    llm_command: CapabilityRecord    # configured llm.command resolvability
```

**Trade-offs:** Binding four consumers to one schema means the schema is load-bearing — hence `schema_version`. But this is *cheaper* than the alternative (each consumer probing independently, drifting). The `source` field is what turns a plain settings page (table stakes) into the provenance-labeled differentiator FEATURES.md calls "the agent-native edge."

**Detection ordering inside the probe (must reuse-before-duplicate):**
```
for each capability:
  1. ask each CapabilityProvider: does YOUR agent have this configured?   → source="agent-config"
  2. else resolve via login-shell PATH (not bare shutil.which)             → source="host-path"
  3. else check Yulu's own managed location (~/.config/yulu/...)           → source="yulu-managed"
  4. else                                                                  → source="absent"
```
This ordering is the architectural expression of the "reuse host capabilities, don't duplicate" lock — the *first* match wins and Yulu only installs when the result is `absent`.

### Pattern 3: Per-agent CapabilityProvider with a uniform detection contract

**What:** One `CapabilityProvider` interface, one impl per agent (Claude Code / Codex / OpenClaw). Each provider answers the same questions about *its* agent's configuration. The per-agent detection contract is the shape the question asks for.

**The per-agent detection contract:**
```python
class CapabilityProvider(ABC):
    name: str                                   # "claude-code" | "codex" | "openclaw"
    @abstractmethod
    def is_present(self) -> bool: ...           # is this agent installed at all?
    @abstractmethod
    def llm_command(self) -> ResolvedCommand | None: ...   # the agent's own LLM invocation
    @abstractmethod
    def whisper_backend(self) -> ResolvedTool | None: ...  # whisper-cli / mlx-whisper it knows
    @abstractmethod
    def models(self) -> list[ResolvedModel]: ...           # whisper models in its caches
    @abstractmethod
    def gog(self) -> ResolvedTool | None: ...              # configured gog (calendar) binary
    @abstractmethod
    def skill_install_cmd(self, repo: Path) -> list[str]: ...  # how to install Yulu's skill FOR this agent
```

**When to use:** Always — this is the abstraction that makes Yulu "agent-native, not single-vendor" (locked: multi-agent from v1). `doctor.py` instantiates all present providers, asks each the same questions, and merges into the `HostCapabilityReport` with `source="agent-config"`.

**Build-now vs fast-follow:** Build **ClaudeCodeProvider end-to-end first** (it's the reference agent and `claude --print` is the existing `llm.command`), prove the report→UI→provisioning loop, *then* generalize to Codex/OpenClaw. FEATURES.md explicitly sequences this: "start with one agent end-to-end, then generalize." The interface is [BUILD NOW]; the 2nd/3rd impls are fast-follow within the milestone.

**Trade-offs:** Three agents means three detection code paths to maintain. Mitigated by the uniform contract — each provider is ~one file of "where does THIS agent keep its config." `skill_install_cmd()` lives here (not in setup.sh) so skill install is decoupled per the lock, and the agent can invoke `yulu skill install --agent <name>` which dispatches to the right provider.

### Pattern 4: Provisioning as a named idempotent step registry (not a script)

**What:** Replace the monolithic linear `setup.sh` with a **registry of named steps**, each idempotent and status-reporting. `yulu provision <step>` runs one; `yulu provision all` runs them in dependency order. The agent calls steps individually and reads each step's status.

**The step contract:**
```python
@dataclass
class StepResult:
    step: str
    status: Literal["ok", "skipped", "changed", "failed"]   # status-reporting, not silent
    detail: str
    remediation: str | None         # what the agent/user should do if "failed"

class ProvisionStep(ABC):
    name: str                       # "detect-capabilities" | "install-deps" | "install-binaries"
                                    # | "install-launch-agents" | "configure-transcription"
                                    # | "install-skill" | "migrate"
    requires: list[str]             # step dependency edges (detection runs first)
    @abstractmethod
    def check(self) -> StepResult: ...    # is this already done? (idempotency probe)
    @abstractmethod
    def apply(self) -> StepResult: ...     # do it; safe to re-run
```

**When to use:** This is how the locked "agent-orchestrated provisioning" decision becomes concrete. The agent runs `check()` to see what's needed, `apply()` to do it, reads `StepResult.status`. Because every step is `check`-then-`apply`, the whole flow is idempotent and re-runnable — satisfying the FEATURES.md "idempotent, re-runnable install steps" table stake AND making migration safe.

**Dependency order (the build/run order this enforces):**
```
detect-capabilities  (no deps — runs FIRST, produces HostCapabilityReport)
   ├─> install-deps         (reads report; skips what's reused)
   ├─> install-binaries     (pre-built signed binaries; no swiftc)
   ├─> resolve-paths        (data/config dirs exist & writable)
   ├─> install-launch-agents (DaemonManager.install per daemon)
   ├─> configure-transcription (validates against report's whisper capability)
   ├─> install-skill        (per-agent; decoupled)
   └─> migrate              (only if v0.5.x ~/.yulu detected)
```

**Trade-offs:** More structure than a bash script. But it's the only way to deliver "named, idempotent, status-reporting steps rather than a black-box script" (the question's explicit requirement) and it's what lets the agent provision reliably. STACK.md flags the *primary-UX* version as spike-gated — but the **step registry itself is [BUILD NOW]** because the decomposed `setup_*.sh` scripts (a P1 prerequisite) map 1:1 onto these steps regardless of whether the agent or `curl|bash` drives them. The spike decides who *calls* the steps, not whether they exist.

### Pattern 5: Migration as a detect → plan → apply → verify pipeline (no data loss)

**What:** `yulu migrate` is a four-phase pipeline, not an in-place mutation: **detect** a v0.5.x layout → build a **migration plan** (a list of moves/transforms) → **apply** with the old install kept recoverable → **verify** the new layout, then optionally retire the backup.

**When to use:** On every upgrade where `migrate.check()` detects the old `~/.yulu` v0.5.x shape (e.g. config without the new `data_folder` field, plists without `YULU_OUTPUT_DIR`, the dead `venv-mlx-whisper`).

**The phases:**
1. **Detect** — inspect `~/.yulu` + `~/.config/yulu/config.json` + installed plists; classify as `v0.5.x` vs `already-migrated` vs `fresh`. (Replaces the vestigial `DEFAULT_LEGACY_ROOT` scanning in CONCERNS 3c with a real `.yulu-install.json` `source`/`schema_version` check.)
2. **Plan** — produce an explicit list: config-field remaps (e.g. add `data_folder` defaulting to current `audio.output_dir`), launch-agent regeneration via `DaemonManager.install(ServiceSpec)`, capability re-detection to fold host installs into the report, backup retention. Plan is inspectable (the agent can show it).
3. **Apply** — **before touching anything, refuse if a recording is active** (socket `{"action":"status"}` check — fixes CONCERNS 2d's `pkill -9` data-loss). Migrate config (atomic `os.replace`), reinstall launch agents through `DaemonManager`, keep the old dir as `~/.yulu.backup-<ts>`.
4. **Verify + retire** — run `doctor.py`; if healthy, prune backups older than the last 1–2 (fixes CONCERNS 2e). If verify fails, the backup is the rollback.

**Trade-offs:** Four phases is more than a `cp -r`, but "seamless, no data loss, no reconfig" (locked) demands the plan/verify guardrails. The pattern reuses `DaemonManager` (don't hand-roll plist edits) and the `HostCapabilityReport` (re-detect rather than trust stale config), so migration isn't a special-case code path — it composes the same layers.

## Data Flow

### Primary new flow: Detection → Surfacing → Configuration

This is the milestone's central data flow — the "doctor host-capability report → web-UI settings → transcription-mode/model config" pipeline the question asks to structure.

```
[agent/user runs `yulu doctor` OR settings page loads]
        ↓
doctor.py  →  instantiates present CapabilityProviders (CC/Codex/OpenClaw)
        ↓        + login-shell PATH resolve + model cache scan + llm.command validate
        ↓
HostCapabilityReport (JSON)   ◄── the single source of truth, source-labeled
        ├──────────────────────────────┬────────────────────────────┐
        ▼                               ▼                            ▼
yulu_ui capabilities.ts           provision/steps.py          configure-transcription
(tRPC) renders settings           (install-deps skips         (validates chosen mode's
rows w/ provenance labels         what report says is         whisper/cloud cmd exists
"reused (from PATH)" vs           already present)            in the report)
"Yulu-managed"                          
        ▼                                                            
user edits in browser:                                              
  - data-folder location  ──writes──> config.json (PathResolver reads it everywhere)
  - transcription mode     ──writes──> config.json (local / cloud-fallback / cloud-priority)
  - model selection        ──writes──> config.json (from report's model list)
        ↓
SIGHUP / daemon reload (existing mechanism) picks up new config
```

**Direction is one-way for detection** (doctor → report → consumers) and **one-way for config writes** (UI → config.json → daemons via existing SIGHUP). The report is read-only to consumers; only `doctor.py` writes it. Config is written only by the UI/CLI; daemons only read it. This avoids the bidirectional-coupling trap.

### Capture data flow (unchanged externally, swapped internally)

```
record_audio.py → CaptureBackend.start(spec)   [the seam — Python ABC]
                        ↓ (macOS impl, behind the seam)
                  audio_daemon.swift: CaptureBackend protocol
                        ↓ (impl swap, invisible to caller)
                  SCK content filter   →MIGRATE→   CoreAudio process tap
                        ↓                                ↓
                  PCM frames (48kHz) ──────────────> WAV file  (same output either way)
```
The SCK→CoreAudio migration (STACK.md, macOS 14.4+) changes only what's *below* the Swift `CaptureBackend` protocol. `record_audio.py` and the WAV consumers see identical PCM output — that's the proof the boundary is correct.

### Agent-orchestrated provisioning flow

```
host agent (Claude Code / Codex / OpenClaw)
   ↓ reads skills/yulu/SKILL.md (the command catalog — already the integration pattern)
   ↓
yulu provision detect-capabilities   → StepResult{ok, report written}
   ↓ agent reads status, proceeds
yulu provision install-deps          → StepResult{skipped: "whisper-cli reused from PATH"}
yulu provision install-binaries      → StepResult{changed: "Yulu.app staged"}
yulu provision install-launch-agents → StepResult{ok}        (via DaemonManager)
yulu skill install --agent <self>    → StepResult{ok}        (per-agent, decoupled)
   ↓
each step is check-then-apply (idempotent); agent re-runs any failed step
```
The agent drives this exactly the way it already drives summaries via `agent-queue.json` — Yulu exposes named commands + a status contract, the agent orchestrates. This **extends the existing seam** (the agent as a capable external driver) rather than inventing a new integration model.

### State Management

No new long-lived state stores. The `HostCapabilityReport` is **ephemeral/regenerable** (cached at `~/.config/yulu/capabilities.json` for the UI, but always re-derivable by `doctor.py` — never authoritative). The authoritative state remains `config.json` (existing). This is deliberate: capability detection reflects the *current* host, so caching it as truth would re-introduce the staleness bugs (CONCERNS 6b's stale Node path, 4a's dead `mlx_python` field).

## Scaling Considerations

Yulu is single-user, single-machine, local-first (PROJECT.md) — "scale" here means **cross-platform breadth** and **agent/capability count**, not user load.

| Dimension | macOS-only (now) | + 2nd OS (future) | + N agents / N caps |
|-----------|------------------|-------------------|---------------------|
| Platform impls | `platform/macos/` only; others stub | Add `platform/linux/` behind same ABCs — zero caller changes | n/a |
| Capability providers | ClaudeCode end-to-end, 2 fast-follow | Providers are OS-agnostic; only PATH-resolve helper is per-OS | Add a provider file; report schema unchanged |
| Provisioning steps | macOS step impls | Steps gain platform branches *inside* `apply()`, registry unchanged | New step → register with `requires` edges |

### Scaling Priorities

1. **First thing that "breaks" adding Linux:** any leaked macOS vocabulary in the ABCs (plist keys, SCK config, TCC scopes). **Fix preemptively:** keep `platform/base.py` interfaces neutral *now* (ServiceSpec not plist; PCM-frames not SCStream) so the Linux arm is pure addition. This is why getting the boundary right this milestone matters even though only macOS ships.
2. **Second:** the `HostCapabilityReport` schema. **Fix:** `schema_version` field + consumers tolerate unknown capability rows, so adding a capability (or an OS-specific one) never breaks the UI.

## Anti-Patterns

### Anti-Pattern 1: Leaking macOS vocabulary into the "portable" interface

**What people do:** Put `SCContentFilter`, plist keys (`KeepAlive`, `RunAtLoad`), or TCC scope strings in the abstract interface signatures.
**Why it's wrong:** The interface stops being portable — a Linux impl would have to fake macOS concepts. Defeats the entire abstraction (STACK.md's "What NOT to Use": *pinning the interface to ScreenCaptureKit/launchd concepts leaks macOS specifics, defeating the abstraction*).
**Do this instead:** Model `CaptureBackend` on **PCM frames + source list** (cpal), `DaemonManager` on **ServiceSpec + install/load/unload/status** (service-manager-rs). macOS specifics live only inside `platform/macos/`.

### Anti-Pattern 2: Re-probing capabilities in each consumer

**What people do:** The settings UI calls `which claude`, provisioning *also* calls `which claude`, transcription config *also* checks the whisper binary — each independently.
**Why it's wrong:** Drifting results, the `shutil.which`-from-daemon false-negative bug (STACK.md: launchd PATH is minimal), and four code paths to maintain.
**Do this instead:** `doctor.py` produces the `HostCapabilityReport` once; everyone reads it. One probe, one PATH-resolution strategy (login-shell), one schema.

### Anti-Pattern 3: Provisioning as one big idempotent-by-hope bash function

**What people do:** Keep `setup.sh`'s linear flow, add `if already-done` checks inline, call it "idempotent."
**Why it's wrong:** It's the current 1,342-line monolith (CONCERNS 2a) — untestable, no per-step status, `set -e` without `pipefail` swallows failures (CONCERNS 6c), and an agent can't drive sub-steps or read status.
**Do this instead:** The named step registry (Pattern 4) — each step is a `check`/`apply` unit with a `StepResult`. The agent runs and inspects steps individually.

### Anti-Pattern 4: In-place migration that mutates before verifying

**What people do:** `yulu update` overwrites config, regenerates plists, kills daemons (`pkill -9`) in one pass.
**Why it's wrong:** A failure mid-migration leaves an indeterminate state; `pkill -9` truncates an active recording (CONCERNS 2d); no rollback.
**Do this instead:** detect → plan → apply (recording-guard first, backup kept) → verify → retire (Pattern 5). The backup is the rollback until verify passes.

### Anti-Pattern 5: Caching the capability report as authoritative truth

**What people do:** Write `capabilities.json` once at install, read it forever (mirrors the `mlx_python` dead-field and stale-Node-path bugs, CONCERNS 4a/6b).
**Why it's wrong:** The host changes (user installs/removes claude, upgrades Node); cached truth goes stale silently.
**Do this instead:** Treat the report as a *cache* of a pure function of the host — always regenerable by `doctor.py`, never the source of truth. Config (`config.json`) is authoritative; capabilities are observed.

## Integration Points

### External Services / Tools

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Host coding agent (CC/Codex/OpenClaw) | `CapabilityProvider` impl per agent + `agent-queue.json` (existing) + `SKILL.md` command catalog | The agent is both the *summary dispatcher* (existing) AND the *provisioner* (new) — same "agent drives Yulu via named commands" model |
| launchd | Behind `DaemonManager` (macOS arm); plist templating stays but is *rendered from* `ServiceSpec` | Fix CONCERNS 8b (`open -W`) inside the arm — launch the binary directly so `unload` kills cleanly |
| Homebrew | Behind `DependencyManager` (macOS arm); detect-first per the report | Never unconditional `brew install` (CONCERNS 1f/4b) — only if report says `absent` |
| HF cache / whisper.cpp dirs | Read-only scan in `doctor.py` via `huggingface_hub.scan_cache_dir()` | Feeds the model-selector; reuse cached models (CONCERNS 4c) |
| iCloud / Google Drive (folder sync) | `PathResolver` exposes candidate sync roots; UI offers them; **OS does the sync** | No Yulu sync engine (locked); glob `~/Library/CloudStorage/*` (STACK.md) |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `record_audio.py` ↔ `CaptureBackend` | Python ABC call → (macOS) Unix socket to `audio_daemon` | The SCK→CoreAudio swap is below the Swift `CaptureBackend` protocol, invisible here |
| everything ↔ `DaemonManager` | Python ABC; macOS arm shells `launchctl` + renders plists | Replaces scattered direct `launchctl` calls (CONCERNS 1b) |
| every daemon ↔ `PathResolver` | Import + call; no more hardcoded paths | Fixes `status_agent.swift` hardcode (CONCERNS 1e/6d) — Swift reads `YULU_OUTPUT_DIR` set by the resolver-driven plist |
| consumers ↔ `HostCapabilityReport` | Read-only JSON (one-way) | `doctor.py` is the sole writer; UI/provision/transcription are readers |
| `yulu_ui` ↔ `doctor.py` | tRPC procedure shells `doctor.py --json`, parses report | New `capabilities.ts` router (CONCERNS 9c) |
| `provision/` → `capabilities/` → `platform/` | one-way import dependency | The backbone; never reversed |

## Suggested Build Order (honoring dependencies)

Derived from FEATURES.md's dependency graph (detection-first) + the one-way layer dependency. **Distinguishes [BUILD NOW] impls from [INTERFACE-ONLY] stubs.**

| # | Build | Status | Why this order |
|---|-------|--------|----------------|
| 0 | **Decompose `setup.sh` → `setup_*.sh` + `set -uo pipefail`; introduce `platform/base.py` ABCs** | [BUILD NOW] | Shared prerequisite for everything; the ABCs are the contract the rest binds to. Stub `linux/`/`windows/`. |
| 1 | **`PathResolver` (macOS) + de-hardcode paths** (incl. fix `status_agent.swift`) | [BUILD NOW] | Lowest-level seam; many things read paths. Unblocks configurable data folder + folder-sync. |
| 2 | **`DaemonManager` (macOS) over `ServiceSpec`** + fix `open -W` plist | [BUILD NOW] | Needed by provisioning, migration, and UI status. Replaces scattered `launchctl`. |
| 3 | **`CapabilityProvider` interface + ClaudeCodeProvider + `doctor.py` host_capabilities → `HostCapabilityReport`** | [BUILD NOW] | **The detection spine — FEATURES.md's foundational dependency. Everything reuse-related waits on this.** |
| 4 | **`yulu_ui` `capabilities.ts` tRPC + settings page (provenance labels)** | [BUILD NOW] | First consumer of the report; proves the schema. Surfaces transcription-mode + model selector + data-folder picker. |
| 5 | **`DependencyManager` (macOS, detect-first) + reuse host whisper/models** | [BUILD NOW] | Consumes the report (skip-if-present). Resolves CONCERNS 4. Kills the `venv-mlx-whisper` dead field. |
| 6 | **Pre-compiled signed binaries in release (remove `swiftc` from release path)** | [BUILD NOW] | Unblocks agent provisioning (agent can't drive an 11GB Xcode compile). Notarization is the hard part (Apple Dev ID). |
| 7 | **`provision/steps.py` registry + `yulu provision <step>` + `yulu skill install --agent`** | [BUILD NOW] (registry); spike-gated (agent-as-primary-UX) | Composes layers 1–6 as named idempotent steps. Decoupled skill install lands here. |
| 8 | **`migrate.py` detect→plan→apply→verify** | [BUILD NOW] | Composes `PathResolver` + `DaemonManager` + report. Recording-guard fixes the `pkill -9` risk. |
| 9 | **CodexProvider + OpenClawProvider** | [fast-follow within milestone] | Generalize the proven CC provider; interface already exists from #3. |
| 10 | **CaptureBackend Swift protocol + SCK→CoreAudio-tap migration** | [BUILD NOW] protocol; tap migration [BUILD NOW if floor→14.4] | Behind the seam; can proceed in parallel after #0 since it's isolated in `audio_daemon.swift`. Raises floor to macOS 14.4 for the audio path. |
| — | `linux/` + `windows/` impls | [DEFER] | Future milestone. Stubs only this milestone. |

**Parallelization note:** #10 (Swift capture seam) is independent of #3–#9 (the Python detection/provisioning stack) and can run in parallel after #0 — they meet only at the `record_audio.py ↔ CaptureBackend` boundary. #1–#2 (PathResolver, DaemonManager) gate #7–#8 (provisioning/migration compose them) but not #3–#5 (detection reads paths but doesn't manage daemons).

## Sources

- `.planning/codebase/ARCHITECTURE.md` — existing daemon inventory, IPC map, agent-queue boundary, platform-coupling table, `llm.command` process boundary — HIGH (primary, codebase-grounded)
- `.planning/codebase/CONCERNS.md` — the coupling fix-approaches (CaptureBackend/DaemonManager/path/permission/deps abstractions), the real bugs to fold in — HIGH (primary)
- `.planning/research/STACK.md` — the tooling decisions these boundaries fit (PCM-frames seam à la cpal, ServiceSpec à la service-manager-rs, SCK→CoreAudio migration, login-shell PATH, report schema inputs) — HIGH (sibling)
- `.planning/research/FEATURES.md` — the dependency graph (detection-first), MVP sequencing, provenance-labeling as the differentiator — HIGH (sibling)
- `.planning/PROJECT.md` — locked decisions (abstraction-now/macOS-only, agent-orchestrated provisioning, reuse capabilities, configurable folder/transcription, multi-agent, decoupled skill, seamless migration) — HIGH (authoritative locks)
- github.com/chipsenkbeil/service-manager-rs — `ServiceManager` trait shape: `install/start/stop/uninstall` + `ServiceInstallCtx` (label/program/args/env/working_dir/autostart/restart_policy) + `ServiceLevel::User` default + platform auto-detect — HIGH (verified; API reference for `DaemonManager`)
- docs.rs/cpal — `Host.devices()` (source list) + `Device.supported_input_configs()`/`default_input_config()` + `build_input_stream(&StreamConfig, callback,…)` PCM-frames-out boundary — HIGH (verified; API reference for `CaptureBackend`)

---
*Architecture research for: agent-native cross-platform provisioning & capability foundation (Yulu)*
*Researched: 2026-05-29*
