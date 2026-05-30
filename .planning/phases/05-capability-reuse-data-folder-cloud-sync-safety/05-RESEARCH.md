# Phase 5: Capability Reuse + Data-Folder / Cloud-Sync Safety - Research

**Researched:** 2026-05-30
**Domain:** macOS cloud-sync detection (File Provider / iCloud), runtime-vs-content path isolation, capability-reuse gating on a tri-state report, multi-daemon config propagation
**Confidence:** HIGH (cloud-detection + eviction validated against a real Mac with live iCloud Drive + 6 Google Drive File-Provider domains; runtime/content split traced against the actual codebase; reuse-gating reads an existing Phase-3 contract)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
All decisions in this phase are **Claude's discretion (autonomous)** per CONTEXT.md, but the following are LOCKED design constraints the planner must honor verbatim:

- **D-01 (HARD PREREQUISITE, lands first):** Physically separate two classes of state.
  - **Machine-local runtime/state — NEVER syncable, NOT user-configurable to a synced folder:** the SQLite DBs (`vocab.sqlite`, `prompts.sqlite`, `search.sqlite`), Unix sockets (`*.sock`), locks/PIDs (`.recording.lock`, `*.pid`), `.state.json`, `schedule.json`, logs, the MLX/model caches.
  - **Syncable content — the configurable data-folder:** recordings, transcripts, summaries, voicemails.
  - PathResolver exposes `runtime_dir()` (locked machine-local) vs `data_dir()` (configurable). The runtime lock is enforced — a config that points runtime at a synced path is rejected.
- **D-02:** A user can configure the data-folder location via the Phase 4 settings UI + PathResolver; the change takes effect across ALL daemons that read `output_dir` (SIGHUP or restart audio/transcribe/agentqueue/ui). The folder picker only ever moves CONTENT, never runtime/state.
- **D-03:** When the chosen data-folder is a detected cloud-sync root (iCloud Drive `~/Library/Mobile Documents/` + `com.apple.fileprovider` attrs; Google Drive; Dropbox; OneDrive — path patterns + fileprovider attrs), Yulu DETECTS it and WARNS about the risks (eviction of in-use recordings, DB corruption if runtime ever leaked there) BEFORE accepting it. **Detect-and-warn, NOT block** — the user may opt in knowing the risks. Surfaced in the Phase 4 folder picker.
- **D-04:** When the Phase 3 tri-state report marks a host `whisper-cli` / model / `claude` / `gog` as **`usable`**, Yulu REUSES it and SKIPS installing its own. The tri-state (not a boolean) gates the decision — `usable` → reuse; `present-but-unverified` / `absent` → install Yulu's own.
- **D-05:** No unconditional `brew install whisper-cpp` (gate `setup_deps.sh` on the report); no duplicate MLX venv. Never silently mutate the host's package manager.
- **D-06 (sequencing):** D-01 ships BEFORE D-02/D-03 wire the picker to cloud roots.
- **D-07:** Extend the Phase 2 `PathResolver` with `runtime_dir()` (locked) vs `data_dir()` (configurable + cloud-detect); a cloud-root detection helper (`yulu_platform/macos/` or `capabilities/`); reuse gating folded into `setup_deps.sh`/`setup_capabilities.sh`; folder-picker + cloud-warn in the Phase 4 settings UI pattern.
- **D-08 (scope guard):** Phase 5 is detect-and-warn + reuse-gating + the physical split. **NO pinning (v2 HARD-01), NO migration (Phase 7), NO CRDT/conflict engine.**

### Claude's Discretion
- Exact location of the locked runtime dir (stay `~/.config/yulu` vs move to `~/Library/Application Support/Yulu`) — **research recommends STAY `~/.config/yulu`; see Pitfall 1.**
- Detection helper module placement (`yulu_platform/macos/` vs `capabilities/`) — **research recommends `yulu_platform/macos/cloud_detect.py`; see Architecture.**
- Propagation mechanism per daemon (SIGHUP vs restart vs re-render plists) — **research maps each daemon; see Data-Folder Change Propagation.**

### Deferred Ideas (OUT OF SCOPE)
- iCloud **pinning** robustness for in-use recordings (`com.apple.fileprovider.pinned` / File Provider API) → **v2 HARD-01**. Phase 5 only DETECTS-and-WARNS.
- **Migration** of existing `~/.yulu` / `~/Movies/Yulu` data layout → **Phase 7**.
- Backup-cleanup beyond migration → v2 HARD-03.
- Custom CRDT / sync-conflict engine → Out-of-Scope (folder sync is the OS's job).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **REUSE-01** | When a *usable* host whisper / model / `claude` / `gog` is detected, Yulu reuses it instead of installing its own | Reuse gate reads the Phase-3 `host_capabilities` tri-state (`doctor.py --json` → `capabilities.<name>.status == "usable"`). See "Reuse Gating on the Tri-State". **Caveat: `gog`/`gogcli` is NOT currently in the Phase-3 report — see Open Question 1.** |
| **REUSE-02** | Yulu no longer unconditionally `brew install`s whisper-cpp or creates a duplicate MLX venv | `setup_deps.sh` already brew-installs `whisper-cpp` unconditionally (line 43); `setup_capabilities.sh` already removed the venv (D-02 done in Phase 1) and only *verifies* mlx importability. Phase 5 adds the conditional skip. See "Reuse Gating". |
| **DATA-01** | User can configure the data folder (recordings/transcripts/summaries) location | `audio.output_dir` in config.json is the single content-root knob today; `PathResolver.data_dir()` already reads it. Phase 5 adds the picker + propagation. See "Data-Folder Change Propagation". |
| **DATA-02** | Runtime/state physically separated from syncable content, never in a synced folder | `runtime_dir()` seam already exists (== `config_dir()`); 38+ files hardcode `~/.config/yulu` directly. See "Content/Runtime Split" + Runtime State Inventory. |
| **DATA-03** | When the data folder points at a detected cloud-sync root, Yulu detects it and warns | Stdlib detection validated on a real Mac: path-prefix match + `SF_DATALESS` flag + `~/Library/CloudStorage/` enumeration. See "Cloud-Sync Root Detection". |
</phase_requirements>

## Summary

Phase 5 has two halves with very different risk profiles. **The reuse-gating half is low-risk plumbing**: the Phase-3 `host_capabilities` tri-state report already exists and is emitted by `doctor.py --json`; Phase 5 just makes `setup_deps.sh` / `setup_capabilities.sh` read `status == "usable"` and skip the corresponding install. **The cloud-sync-safety half is where data loss happens**, and it is the part this research validated hardest — against a real Mac with a live iCloud Drive and six Google Drive File-Provider domains.

The headline technical findings, all verified on-device (macOS "26.5" / Darwin, Python 3.14.3):

1. **Eviction detection is pure stdlib.** `os.stat(path).st_flags & stat.SF_DATALESS` (`SF_DATALESS = 0x40000000`) is `True` for an evicted ("dataless") iCloud file and `False` for a local one — confirmed against a real evicted `.pem` in iCloud Drive (`st_flags=0x40000060`). No subprocess, no third-party lib. This is the precise signal behind the eviction warning.
2. **`os.getxattr` / `os.listxattr` do NOT exist on macOS** (CPython gates them on `__linux__`). The CONTEXT.md note "xattr detection via `os.getxattr`" is **wrong for macOS** — xattr reads must shell out to `/usr/bin/xattr` or use `ctypes`. **But you don't need xattr at all for the core warning** — path-prefix + `SF_DATALESS` is sufficient and simpler.
3. **The two cloud-root families live in different places.** iCloud Drive is `~/Library/Mobile Documents/com~apple~CloudDocs/` (NOT under CloudStorage). Third-party File-Provider engines (Dropbox, OneDrive, Google Drive) live under `~/Library/CloudStorage/<Provider>-<account>/` since macOS 12.3+. Detection must cover both roots.
4. **The D-01 "a `.sock` can't exist in a File Provider folder" assumption is FALSE.** A Unix socket bind under iCloud Drive *succeeded* on-device. The safety argument is therefore corruption/eviction-and-meaninglessness, **not** physical impossibility. The warning copy and the runtime-lock rationale must be reframed accordingly (see Pitfall 3).
5. **SQLite-on-cloud-sync corruption is real and documented** (WAL checkpoint + hot-journal relocation). This is the strongest reason runtime DBs must stay machine-local.

**Primary recommendation:** Keep `runtime_dir()` locked to `~/.config/yulu` (do NOT move it). Add `yulu_platform/macos/cloud_detect.py` (stdlib: path-prefix + `SF_DATALESS`) returning a structured `(is_cloud, engine, reason)` result. Enforce the runtime lock by *rejecting* any config that would route runtime under a detected cloud root (D-01) — and since runtime is not user-configurable, "enforcement" mostly means: never read a content-folder config value into a runtime path, and assert at startup that `runtime_dir()` is not cloud-detected. Land D-01 (the split + lock) before wiring the D-02/D-03 picker. Gate reuse on `status == "usable"` from the existing report.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Cloud-root detection (DATA-03) | Python PathResolver / `cloud_detect.py` (daemon-side) | Phase-4 UI (surfaces the warning) | D-07 puts detection in `yulu_platform/macos/`; the UI only *renders* the result it gets from a tRPC call into Python. Detection must be testable headless (stdlib). |
| Runtime/content path resolution (DATA-02) | Python `PathResolver` (`runtime_dir` / `data_dir`) | Swift daemons + TS `paths.ts` (consumers) | PathResolver is the single source of truth (PLAT-04); Swift `audio_daemon` and TS `paths.ts` are *consumers* that today hardcode — they must read the resolved value, not re-derive it. |
| Data-folder change → daemon propagation (DATA-01/D-02) | Config write (`config.json` `audio.output_dir`) + daemon reload | `DaemonManager` (restart) / SIGHUP | The content root is a config value; daemons pick it up on restart or SIGHUP. No plist re-render needed (output_dir is NOT a plist env var — see Pitfall 5). |
| Reuse decision (REUSE-01/02) | `setup_deps.sh` / `setup_capabilities.sh` (install scripts) | `doctor.py --json` (the report producer) | The tri-state report is the authority; the bash install scripts are *consumers* that branch on `status == "usable"`. |
| Eviction/corruption *risk* (the thing we warn about) | macOS File Provider (OS-owned) | — | Phase 5 does NOT mitigate (no pinning); it only detects-and-warns. The OS owns eviction. |

## Standard Stack

This phase is **stdlib-only Python + bash + a thin tRPC/React surface** — consistent with the project's "stdlib-first" rule (CLAUDE.md). No new third-party packages.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Python `os` + `stat` (stdlib) | 3.8+ | `os.stat().st_flags & stat.SF_DATALESS` eviction detection; path checks | `SF_DATALESS` is exposed in the stdlib `stat` module and `st_flags` is populated on Darwin — verified on-device. No dependency needed. `[VERIFIED: on-device python3 3.14.3]` |
| Python `pathlib` (stdlib) | 3.8+ | Path-prefix matching for cloud-root detection; `expanduser` | Already the project's path idiom (`MacOSPathResolver`). `[VERIFIED: codebase]` |
| `subprocess` (stdlib) | 3.8+ | `brctl status` secondary signal ONLY if needed; list-form like Phase-3 probes | Project already uses list-form subprocess for probes (`capabilities/probes.py`). `[VERIFIED: codebase]` |
| `/usr/bin/brctl` (system) | macOS-bundled | Optional secondary iCloud sync-state signal | Present at `/usr/bin/brctl` (root:wheel, 543KB) — verified on-device. **Not required for the core warning.** `[VERIFIED: on-device]` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `/usr/bin/xattr` (system) | macOS-bundled | Read `com.apple.fileprovider.*` attrs IF you want a richer signal | Only if path-prefix + `SF_DATALESS` proves insufficient (it shouldn't). `os.getxattr` is absent on macOS, so this is the *only* stdlib-adjacent way to read xattrs without `ctypes`. `[VERIFIED: on-device /usr/bin/xattr]` |
| Swift `FileManager.isUbiquitousItem(at:)` | macOS SDK | Swift-side iCloud detection (audio daemon) | Only if the *Swift* audio daemon must independently detect iCloud (out of scope for Phase 5 detection, which is Python). `[CITED: developer.apple.com/documentation/foundation/filemanager/1410218-isubiquitousitem]` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `SF_DATALESS` via stdlib | `ctypes` → libSystem `getxattr(2)` for `com.apple.fileprovider` xattr | Heavier, FFI surface, no clear benefit; the dataless flag already answers "is this evicted right now". Reserve xattr for a future pinning feature (v2). |
| Path-prefix detection | FSEvents / `NSMetadataQuery` live monitoring | Massive overkill for a one-shot "is this path under a sync root" check at folder-pick time. Phase 5 is detect-at-selection, not continuous. |
| `brctl status` parsing | Path-prefix + dataless | `brctl` output is undocumented/opaque (`<c{1}m.a{3}e...>` redacted container IDs) and iCloud-only; path-prefix covers all four engines uniformly. Keep `brctl` as an optional confirmatory signal only. |

**Installation:**
```bash
# No new packages. All stdlib + macOS-bundled system binaries.
# Verify the system binaries exist at runtime (they ship with macOS):
command -v brctl   # /usr/bin/brctl
command -v xattr   # /usr/bin/xattr
```

**Version verification:** N/A — no external packages. The only "versions" that matter are macOS version gates (File Provider semantics changed in Sonoma 14 → Sequoia 15; `~/Library/CloudStorage` since 12.3). Yulu targets macOS 13+, so both the iCloud `Mobile Documents` path AND the `CloudStorage` path are present on all supported versions.

## Package Legitimacy Audit

> **Not applicable.** Phase 5 installs **no new external packages** — it is stdlib Python + bash + macOS-bundled system binaries (`brctl`, `xattr`). The REUSE half *reduces* installs (gates the existing `brew install whisper-cpp`). slopcheck was therefore not run; there is nothing to audit. The only "dependencies" are OS-provided binaries verified present on-device.

## Architecture Patterns

### System Architecture Diagram

```text
                    ┌─────────────────────────────────────────────────────────┐
                    │              Phase 4 Settings UI (React/tRPC)            │
                    │   folder picker  ──select dir──►  config.update          │
                    └───────────────┬─────────────────────────┬───────────────┘
                                    │ tRPC: cloud.detect(path) │ tRPC: config.update("audio.output_dir", path)
                                    ▼                          ▼
        ┌───────────────────────────────────────┐   ┌──────────────────────────────┐
        │   cloud_detect.is_cloud_root(path)     │   │  ConfigManager.update()      │
        │   (yulu_platform/macos/cloud_detect)   │   │  writes config.json          │
        │                                        │   └───────────────┬──────────────┘
        │  1. prefix? ~/Library/Mobile Documents │                   │ propagate
        │     /com~apple~CloudDocs   → iCloud     │                   ▼
        │  2. prefix? ~/Library/CloudStorage/    │   ┌──────────────────────────────────────────┐
        │     <Provider>-<acct>      → 3rd-party  │   │  daemons that read audio.output_dir:        │
        │  3. os.stat().st_flags & SF_DATALESS    │   │   • audio_daemon (Swift) loadRecordingDir() │
        │     → already-evicted signal            │   │   • record_audio.py  output_dir             │
        │                                        │   │   • status_agent (Swift) recordings menu    │
        │  returns (is_cloud, engine, reason)    │   │   • search/indexer CORPUS_ROOT              │
        └───────────────┬───────────────────────┘   │   • voicemail/repo VOICEMAIL_DIR            │
                        │ if is_cloud → WARN (not block)│ → restart / SIGHUP (NOT plist re-render)   │
                        ▼                              └──────────────────────────────────────────┘
        ┌────────────────────────────────────────┐
        │  WARNING copy (honest, OS-grounded):     │              ┌──────────────────────────────┐
        │   "iCloud may EVICT in-use recordings    │              │  LOCKED runtime_dir()         │
        │    (dataless) and corrupt them mid-write"│   never ───► │  = ~/.config/yulu (machine-   │
        │   user may OPT IN.                        │   crosses    │  local): *.sqlite, *.sock,    │
        └────────────────────────────────────────┘   into here   │  *.pid, .state.json, locks    │
                                                                   └──────────────────────────────┘

   ── REUSE half (independent) ──────────────────────────────────────────────────────────────────
        doctor.py --json ──► host_capabilities.{whisper_cli,mlx_whisper,claude,models}.status
                                    │
                                    ▼  read in bash
        setup_deps.sh / setup_capabilities.sh:  if status=="usable" → SKIP install ; else install Yulu's own
```

### Recommended Project Structure
```
yulu/scripts/
├── yulu_platform/
│   ├── base.py                        # PathResolver ABC (runtime_dir already declared)
│   └── macos/
│       ├── path_resolver.py           # EXTEND: diverge runtime_dir() from data_dir(); add cloud-reject guard
│       └── cloud_detect.py            # NEW (D-07): is_cloud_root(path) -> CloudRootResult (stdlib only)
├── capabilities/
│   ├── report.py                      # (unchanged) tri-state contract
│   └── probes.py                      # (unchanged) — reuse gate reads doctor's report, not probes directly
├── setup_deps.sh                      # GATE brew install whisper-cpp on report status (REUSE-02)
├── setup_capabilities.sh              # GATE mlx reuse-vs-(warn) on report status (REUSE-01/02)
└── yulu_ui/src/routers/
    ├── config.ts                      # (exists) config.update — already the write path
    └── system.ts | a new cloud route  # ADD: cloud.detect(path) tRPC → calls Python cloud_detect

tests/
├── test_cloud_detect.py               # NEW (Wave 0): path-prefix + dataless, fully mockable
├── test_yulu_platform_macos.py        # EXTEND: runtime_dir locked + cloud-reject guard
└── test_reuse_gating.py               # NEW (Wave 0): status=="usable" → skip; else install
```

### Pattern 1: Stdlib cloud-root detection (path-prefix + dataless)
**What:** A single pure function that classifies a candidate data-folder path against the two known cloud-root families and the live dataless flag.
**When to use:** At folder-pick time (D-03) and as the runtime-lock assertion (D-01).
**Example:**
```python
# Source: validated on-device (macOS Darwin 26.5, Python 3.14.3). stdlib only.
# yulu_platform/macos/cloud_detect.py
from __future__ import annotations
import os
import stat
from dataclasses import dataclass
from pathlib import Path

# iCloud Drive is NOT under CloudStorage — it has its own root. [VERIFIED: on-device]
_ICLOUD_ROOT = "Library/Mobile Documents/com~apple~CloudDocs"
# Third-party File Provider engines (Dropbox/OneDrive/Google Drive) since macOS 12.3+. [VERIFIED: on-device]
_CLOUDSTORAGE_ROOT = "Library/CloudStorage"


@dataclass(frozen=True)
class CloudRootResult:
    is_cloud: bool
    engine: str           # "icloud" | "google-drive" | "dropbox" | "onedrive" | "cloudstorage" | ""
    reason: str           # human-readable, for the warning copy
    dataless_sample: bool  # True if the path (or a child) is currently evicted


def _engine_from_cloudstorage_segment(segment: str) -> str:
    s = segment.lower()
    if s.startswith("googledrive"):
        return "google-drive"
    if s.startswith("dropbox"):
        return "dropbox"
    if s.startswith("onedrive"):
        return "onedrive"
    return "cloudstorage"  # unknown File Provider engine, still a sync root


def is_cloud_root(path: os.PathLike | str) -> CloudRootResult:
    """Classify whether *path* lives under a known macOS sync root. Never raises."""
    try:
        p = Path(path).expanduser().resolve()
    except Exception as exc:
        return CloudRootResult(False, "", f"unresolvable path: {exc}", False)

    home = Path.home()
    try:
        rel = p.relative_to(home)
    except ValueError:
        rel = None

    # 1. iCloud Drive
    if rel is not None and str(rel).startswith(_ICLOUD_ROOT):
        return CloudRootResult(True, "icloud",
                               "iCloud Drive (~/Library/Mobile Documents/com~apple~CloudDocs)",
                               _is_dataless(p))
    # 2. ~/Library/CloudStorage/<Provider>-<account>/...
    if rel is not None and str(rel).startswith(_CLOUDSTORAGE_ROOT):
        parts = rel.parts  # ('Library','CloudStorage','GoogleDrive-acct', ...)
        engine = _engine_from_cloudstorage_segment(parts[2]) if len(parts) >= 3 else "cloudstorage"
        return CloudRootResult(True, engine,
                               f"macOS File Provider sync folder (~/Library/CloudStorage/{parts[2] if len(parts) >= 3 else ''})",
                               _is_dataless(p))
    # 3. Not a known root by path, but flag if the OS already made it dataless (belt-and-suspenders)
    if _is_dataless(p):
        return CloudRootResult(True, "", "path contains evicted (dataless) files — under some sync engine", True)

    return CloudRootResult(False, "", "", False)


def _is_dataless(p: Path) -> bool:
    """True if p (or, for a dir, any immediate child) is an evicted/dataless File Provider item.
    SF_DATALESS = 0x40000000. [VERIFIED on-device: an evicted iCloud file reports st_flags=0x40000060]."""
    try:
        if bool(os.stat(p).st_flags & stat.SF_DATALESS):
            return True
        if p.is_dir():
            for child in list(p.iterdir())[:64]:  # bounded scan
                try:
                    if bool(os.stat(child, follow_symlinks=False).st_flags & stat.SF_DATALESS):
                        return True
                except OSError:
                    continue
    except (OSError, AttributeError):
        return False
    return False
```

### Pattern 2: Runtime-lock enforcement (D-01) — assert, don't configure
**What:** `runtime_dir()` is never sourced from user config; it is a fixed machine-local path. "Enforcement" = (a) never plumb a content-config value into a runtime path, and (b) a startup assertion that the resolved runtime dir is not cloud-detected.
**When to use:** In `MacOSPathResolver.runtime_dir()` and a daemon-startup guard.
**Example:**
```python
# Source: derived from existing MacOSPathResolver + cloud_detect (this research). stdlib only.
# In MacOSPathResolver:
def runtime_dir(self) -> Path:
    """LOCKED machine-local runtime root. NOT configurable; NEVER a synced path (D-01).
    Diverges from data_dir() here: data_dir() reads config; runtime_dir() never does."""
    env = os.environ.get("YULU_CONFIG_DIR")   # honored for tests/dev only; still machine-local
    base = Path(env).expanduser() if env else Path.home() / _DEFAULT_CONFIG_SUBDIR
    return base

def assert_runtime_not_synced(self) -> None:
    """D-01 hard guard: refuse to run if runtime ever resolves under a sync root."""
    from yulu_platform.macos.cloud_detect import is_cloud_root
    res = is_cloud_root(self.runtime_dir())
    if res.is_cloud:
        raise RuntimeError(
            f"Yulu runtime dir {self.runtime_dir()} is under a cloud-sync root "
            f"({res.reason}). Runtime/state (SQLite, sockets, locks) must be machine-local. Refusing to start."
        )
```

### Pattern 3: Reuse gate reads the tri-state report (REUSE-01/02)
**What:** The bash install scripts call `doctor.py --json`, parse `host_capabilities.<cap>.status`, and skip install when `== "usable"`.
**When to use:** In `setup_deps.sh` (whisper-cpp) and `setup_capabilities.sh` (mlx).
**Example:**
```bash
# Source: derived from existing doctor.py --json shape + report.py contract (this research).
# Helper in lib/common.sh — read one capability's tri-state status from the report.
capability_status() {
    local cap="$1"  # e.g. "whisper_cli", "mlx_whisper"
    "$PYTHON_BIN" "$SCRIPT_DIR/doctor.py" --json 2>/dev/null \
      | "$PYTHON_BIN" -c "import sys,json; r=json.load(sys.stdin); \
          print(r.get('host_capabilities',{}).get('capabilities',{}).get('$cap',{}).get('status','absent'))" \
      2>/dev/null || echo "absent"
}

# In setup_deps.sh — gate whisper-cpp (REUSE-02):
if [[ "$(capability_status whisper_cli)" == "usable" ]]; then
    ok "检测到可用的 whisper-cli（复用主机的），跳过 brew install whisper-cpp"
    brew install sox ffmpeg terminal-notifier 2>&1 | tail -1   # the rest, minus whisper-cpp
else
    brew install sox ffmpeg whisper-cpp terminal-notifier 2>&1 | tail -1
fi
```
> **Note:** the exact JSON path is `host_capabilities.capabilities.<cap>.status` because `doctor.py` nests the report under a `host_capabilities` key whose value is `HostCapabilityReport.to_dict()` (which itself has a `capabilities` sub-dict). Verify the precise nesting against `doctor.py:_host_capabilities` during planning — see Open Question 2.

### Anti-Patterns to Avoid
- **Using `os.getxattr` on macOS:** it does not exist (CPython compiles xattr funcs only on Linux). Verified absent on-device. Use `SF_DATALESS` (stdlib) or `/usr/bin/xattr` (subprocess).
- **Claiming a socket "cannot" live in a sync folder:** it can (bind succeeded on-device). Frame the lock as corruption/eviction safety, not impossibility.
- **Blocking the user from a cloud data-folder:** D-03 is explicitly detect-and-**warn**, not block. The user may opt in.
- **Re-rendering plists to change `output_dir`:** `output_dir` is NOT a plist env var (verified — plists carry only PATH/PYTHONPATH/YULU_UI_PORT/etc.). Changing the content folder is a config.json write + daemon reload, full stop.
- **Relying on Finder "Keep Downloaded" pinning to protect recordings:** Sequoia caps the pin/eviction contextual-menu action at **10 selected items** (an "unintended oversight") and the public File Provider API offers no robust macOS pinning — this is exactly why pinning is deferred to v2 HARD-01. Do not build on it in Phase 5.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| "Is this file evicted/dataless?" | A heuristic on file size==0 or `.icloud` suffix scanning | `os.stat().st_flags & stat.SF_DATALESS` | The dataless flag is the OS's own ground-truth bit; the `.icloud` placeholder suffix is the *old* (pre-Sonoma stub-file) mechanism and is unreliable post-File-Provider. Verified on-device. |
| Detecting third-party sync engines | Hardcoding per-vendor paths like `~/Dropbox`, `~/Google Drive` | Enumerate `~/Library/CloudStorage/<Provider>-<account>/` | Since macOS 12.3 all File Provider engines live under CloudStorage; the legacy home-dir folders are deprecated/gone. Verified: 6 real `GoogleDrive-*` domains on-device. |
| Atomic config writes | A bespoke write-then-rename | Existing `state_store._atomic_write_json` / `queue_store._write_queue_atomic` patterns | The project already has a verified tmpfile+`os.replace` idiom; reuse it for any config mutation. |
| Recording-start mutual exclusion across the move | A new lock | Existing `recording_lock.acquire()` + the daemon's status RPC | Already the canonical arbiter; a data-folder change while recording should consult it (don't move content mid-recording). |
| SQLite "safe on cloud" | Any attempt to make WAL safe under sync | Keep DBs in locked `runtime_dir()` | SQLite explicitly does not support cloud-synced live DBs; WAL checkpoint + hot-journal relocation corrupts. Documented by SQLite + field reports. |

**Key insight:** Every primitive Phase 5 needs already exists either in the stdlib (`SF_DATALESS`, `os.stat`) or in the codebase (atomic writes, the tri-state report, the recording lock, the `runtime_dir`/`data_dir` seam). Phase 5 is **composition and gating**, not new machinery.

## Runtime State Inventory

> This is a **refactor/split** phase (DATA-02 physically separates runtime from content). Below is the explicit inventory of what is runtime/state (must stay machine-local) vs content (configurable). Derived from grepping the actual codebase.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| **Stored data (machine-local SQLite)** | `vocab.sqlite`, `prompts.sqlite`, `search.sqlite` + their `-wal`/`-shm` sidecars — all opened in WAL mode (`vocab/db.py:75`, `search/indexer.py:148`, `prompts/db.py`). `search/indexer.py:31` hardcodes `SEARCH_DB_PATH = ~/.config/yulu/search.sqlite`. | Stay in `runtime_dir()`. **No move.** Route the hardcoded path through `runtime_dir()` for cross-platform correctness (cosmetic in Phase 5; same value today). |
| **Stored content (configurable)** | Recordings (WAV), transcripts (`*.transcript.txt`), summaries (`*.summary.md`/`.html`), voicemails — under `audio.output_dir` (default `~/Movies/Yulu`). `search/indexer.py:32` hardcodes `CORPUS_ROOT = ~/Movies/Yulu`; `voicemail/repo.py:26` hardcodes `VOICEMAIL_DIR_DEFAULT = ~/Movies/Yulu/voicemails`. | These are the **only** things the picker moves. `CORPUS_ROOT` and `VOICEMAIL_DIR_DEFAULT` must follow `data_dir()`, not a hardcoded literal. |
| **Live service config** | n8n/Datadog/etc.: **none** — Yulu has no external SaaS state. The closest is the cloudflared quick-tunnel URL + `webhook_token` in `~/.config/yulu/.state.json` (run_calendar_services). | None for the data-folder move. `.state.json` is runtime — stays machine-local. |
| **OS-registered state** | 8 launchd plists under `~/Library/LaunchAgents/com.yulu.*.plist`. They carry `__SCRIPT_DIR__`, `__PATH__`, `YULU_UI_PORT`, `PYTHONPATH` — **but NOT `YULU_OUTPUT_DIR`** (verified). | **No plist change needed for a data-folder move** — output_dir is read from config.json at daemon runtime, not injected via plist. (CONCERNS.md §1e's "already half-done via plist EnvironmentVariables" is inaccurate for output_dir.) |
| **Sockets / locks / PIDs** | `audio_daemon.sock`, `stt_daemon.sock`, `status_agent.sock`; `.recording.lock`; `*.pid` (agent_queue_worker, stt_daemon, status_agent). All under `~/.config/yulu`. | Stay in `runtime_dir()`. **Never** under the configurable data-folder. Sockets *can* be bound under a sync folder (verified) but must not be — corruption/eviction risk. |
| **Build artifacts / caches** | MLX model cache in `~/.cache/huggingface/hub/`; whisper.cpp models in `~/.config/yulu/models/`. The old `~/.config/yulu/venv-mlx-whisper/` is no longer created (Phase 1 D-02). | Model caches are machine-local; not part of the data-folder. No action beyond not duplicating (REUSE-01). |

**Nothing found in category "live SaaS service config":** None — verified by grep; Yulu's only externally-registered state is the ephemeral cloudflared tunnel + webhook token in `.state.json`, which is runtime and stays machine-local.

**The canonical question — "after the data-folder moves, what still points at the old content root?":** Three hardcoded literals: `search/indexer.py:32 CORPUS_ROOT`, `voicemail/repo.py:26 VOICEMAIL_DIR_DEFAULT`, and `record_audio.py:68`'s fallback. These read `~/Movies/Yulu` directly instead of `data_dir()`. Plan a task to route them through `PathResolver.data_dir()`. (Migration of *existing* files at the old root is Phase 7 — Phase 5 only fixes the live-config path so *new* content lands in the new folder.)

## Common Pitfalls

### Pitfall 1: Moving the runtime dir to `~/Library/Application Support/Yulu`
**What goes wrong:** Tempting "macOS-native" cleanup, but it breaks every one of the 38+ files that hardcode `~/.config/yulu`, plus the TS `paths.ts`, plus the Swift `CONFIG_DIR`, plus all 8 plists' implicit assumptions — and it collides with Phase 7's migration scope.
**Why it happens:** The phase touches paths, so "while we're here" creep.
**How to avoid:** **Keep `runtime_dir()` == `~/.config/yulu`.** D-01 only requires that runtime is *locked and non-syncable*, not relocated. The discretion to relocate exists, but research strongly recommends against it this phase — it's pure churn with no DATA-02 benefit and a large regression surface. Relocation, if ever wanted, belongs with Phase 7 migration.
**Warning signs:** A plan task titled "move config to Application Support" — reject it.

### Pitfall 2: `os.getxattr` in the detection code
**What goes wrong:** Code written from the CONTEXT.md hint "xattr detection via `os.getxattr`" will `AttributeError` at runtime on macOS — the function is not compiled into CPython on Darwin (verified: `hasattr(os,'getxattr') is False` on 3.14.3).
**Why it happens:** `os.getxattr` exists on Linux and in the docs; the platform guard is easy to miss.
**How to avoid:** Use `os.stat().st_flags & stat.SF_DATALESS` (stdlib, works on Darwin) for the eviction signal. If a true xattr read is ever needed, shell out to `/usr/bin/xattr -p com.apple.fileprovider <file>` (list-form subprocess) or use `ctypes`.
**Warning signs:** Any `import os; os.getxattr(...)` in a macOS path.

### Pitfall 3: Justifying the runtime lock with "sockets can't exist in sync folders"
**What goes wrong:** The D-01 specifics say a `.sock` can't exist in a File Provider folder. **On-device, binding a Unix socket under iCloud Drive SUCCEEDED.** A warning or comment built on the impossibility claim is factually wrong and will mislead future maintainers.
**Why it happens:** Reasonable intuition (special files + sync seems incompatible) that doesn't hold.
**How to avoid:** Frame the lock around *real* harms: (a) SQLite WAL corruption on sync (documented), (b) the sync engine attempting to upload/evict ephemeral sockets/locks is meaningless and racy, (c) eviction (dataless) of an in-use file mid-write. The warning copy and code comments should cite eviction + DB corruption, never "physically impossible".
**Warning signs:** Comment text like "a socket cannot be created here".

### Pitfall 4: Treating the tri-state as a boolean in the reuse gate
**What goes wrong:** `if present: skip` collapses `present-but-unverified` into "skip", so Yulu skips installing whisper-cpp when the host has a *broken/unimportable* one — the exact silent-failure the tri-state exists to prevent (report.py:35 docstring: "A boolean must never drive a skip-install decision").
**Why it happens:** Bash makes it easy to test truthiness.
**How to avoid:** Gate strictly on `status == "usable"`. `present-but-unverified` and `absent` both → install Yulu's own. This is D-04 verbatim.
**Warning signs:** A bash test like `[[ -n "$status" ]]` or `[[ "$status" != "absent" ]]`.

### Pitfall 5: Re-rendering plists or expecting `YULU_OUTPUT_DIR` to propagate the data-folder
**What goes wrong:** Plans that "update the output dir env var in the plists and reload" will do nothing — **no plist injects `YULU_OUTPUT_DIR`** (verified across all 8). The audio daemon reads `audio.output_dir` from `config.json` directly (`audio_daemon.swift:loadRecordingDir`).
**Why it happens:** CONCERNS.md §1e says env injection is "already half-done via plist EnvironmentVariables" — true for nothing output-related.
**How to avoid:** Propagation = write `config.json` `audio.output_dir`, then restart (or SIGHUP, where supported) the daemons that read it. No plist re-render. Note the audio daemon caches `RECORDING_DIR = loadRecordingDir()` at process start (`audio_daemon.swift:60`), so it needs a **restart** to pick up a new default; per-recording `output_dir` overrides flow via the socket `start` request (line 1117).
**Warning signs:** A task that edits `com.yulu.*.plist` for the data-folder change.

### Pitfall 6: Moving content while a recording is active
**What goes wrong:** Changing `output_dir` mid-recording orphans the in-flight WAV (daemon still writing to the old path) or races the move.
**Why it happens:** The picker doesn't consult recording state.
**How to avoid:** Before applying a data-folder change, check `recording_lock` / the daemon status RPC (the existing `is_recording_active()` in `state_store.py`); refuse or defer the change if recording. (Mirrors the upgrade-guard pattern PLAT-03 introduced.)
**Warning signs:** A folder-change handler with no recording-state check.

## Code Examples

### Detect a cloud root at folder-pick time (the D-03 surface)
```python
# Source: this research, validated on-device. stdlib only.
from yulu_platform.macos.cloud_detect import is_cloud_root

res = is_cloud_root(chosen_folder)
if res.is_cloud:
    warn = (
        f"The folder you chose is in {res.reason}.\n"
        "Risks if you keep recordings here:\n"
        "  • macOS may EVICT (make 'dataless') a recording that hasn't been used recently — "
        "if that happens mid-write or before transcription, the file can be lost or corrupted.\n"
        "  • Yulu's databases and live files are kept OUT of this folder for safety, so only "
        "your recordings/transcripts/summaries sync.\n"
        "You can use this folder anyway if you understand the trade-off."
    )
    # surface `warn` in the picker; allow opt-in (DO NOT block)
```

### Eviction probe (the precise signal — copy/pasteable)
```python
# Source: on-device verification (an evicted iCloud .pem reported st_flags=0x40000060).
import os, stat
def is_evicted(path) -> bool:
    """True if `path` is currently a dataless/evicted File Provider item. SF_DATALESS=0x40000000."""
    try:
        return bool(os.stat(path).st_flags & stat.SF_DATALESS)
    except (OSError, AttributeError):
        return False
```

### Reuse gate (bash, REUSE-02) — see Pattern 3 for the full `capability_status` helper.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| iCloud "stub" files with `.icloud` placeholder suffix | File Provider "dataless" files (no suffix; `SF_DATALESS` flag) | macOS 13 Sonoma (2023) | Detect eviction via `SF_DATALESS`, **not** `.icloud` suffix scanning. |
| Third-party sync in `~/Dropbox`, `~/Google Drive` (home dir) | All File Provider engines under `~/Library/CloudStorage/<Provider>-<account>/` | macOS 12.3 (2022) | Detection enumerates CloudStorage; legacy home-dir folders are deprecated. |
| (no robust user pinning) | Finder "Keep Downloaded" / `com.apple.fileprovider.pinned` — but **10-item contextual-menu cap** in Sequoia | macOS 15 Sequoia (2024) | Pinning is NOT a reliable Phase-5 mitigation → deferred to v2 HARD-01; detect-and-warn only. |

**Deprecated/outdated:**
- `.icloud` placeholder-suffix detection: superseded by `SF_DATALESS` post-Sonoma.
- Per-vendor home-dir sync folders: superseded by `~/Library/CloudStorage`.
- The CONTEXT.md/CONCERNS.md assumptions that (a) `os.getxattr` works on macOS and (b) sockets can't exist under File Provider — both falsified on-device this session.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `doctor.py --json` nests the report as `host_capabilities.capabilities.<cap>.status`. The exact nesting was inferred from `report.to_dict()` + `_host_capabilities`, not run end-to-end. | Pattern 3 / Open Q2 | Reuse gate reads the wrong JSON path → never skips (over-installs) or KeyErrors. **Low blast radius** (the gate degrades to "install", the safe default). Verify nesting in planning. |
| A2 | `gog`/`gogcli` is one of the capabilities REUSE-01 expects to gate, but it is NOT in the current Phase-3 report (the report covers claude/whisper_cli/mlx_whisper/llm_command/models/recording_dir). | Requirements / Open Q1 | If a `gog` reuse check is required, Phase 5 must first ADD a `gog` probe to the report — scope the planner didn't expect. See Open Q1. |
| A3 | SIGHUP is a viable propagation signal for *some* daemons reading output_dir. Most Yulu daemons re-read config on restart; only specific ones (stt_daemon vocab, scheduler) document SIGHUP reload. Restart is the safe universal mechanism. | Data-Folder Propagation | If a daemon doesn't handle SIGHUP, the change silently doesn't apply until next restart. Recommend restart as the default; SIGHUP only where explicitly supported. |
| A4 | `brctl status` output is stable enough to parse. It is undocumented and emits redacted container IDs. | Standard Stack | Don't parse it as a primary signal — kept as optional confirmation only. No risk if used as recommended (path-prefix + dataless is primary). |

**If this table looks short:** the load-bearing claims (eviction flag, cloud-root paths, socket bind, xattr absence, SQLite-on-sync corruption) were all **verified on-device or cited from authoritative sources** — they are not assumptions.

## Open Questions

1. **Is `gog`/`gogcli` in scope for REUSE-01's reuse gate, and if so who adds its probe?**
   - What we know: REUSE-01 lists "`whisper` / model / `claude` / `gog`". The Phase-3 report has `claude`, `whisper_cli`, `mlx_whisper`, `models` — but **no `gog`**. `setup_deps.sh` installs `steipete/tap/gogcli` unconditionally (line 46).
   - What's unclear: Whether Phase 5 must add a `gog` capability probe (a Phase-3-shaped addition) to gate the `gogcli` install, or whether `gog` reuse is deferred.
   - Recommendation: Plan a small task to add `probe_command("gog", ...)` to the report (mirrors `probe_command("claude", ...)`), then gate the `gogcli` install on it. It's a 1:1 copy of an existing probe — low cost, closes the REUSE-01 wording. Flag for discuss-phase if the user prefers to defer `gog`.

2. **Exact JSON nesting of the tri-state in `doctor.py --json`.**
   - What we know: `doctor.py:_host_capabilities` builds a `HostCapabilityReport`, calls `.to_dict()` (→ `{schema_version, capabilities:{...}}`), and the surrounding `collect_report` likely stores it under a `host_capabilities` key.
   - What's unclear: Whether the top-level key is `host_capabilities` and whether `--json` prints `collect_report()` wholesale.
   - Recommendation: During planning, run `python3 yulu/scripts/doctor.py --json | python3 -m json.tool` once and pin the exact path in the reuse-gate helper. (Could not run here without the daemon/config present.)

3. **SIGHUP vs restart per daemon for the data-folder change.**
   - What we know: audio_daemon caches `RECORDING_DIR` at start (needs restart); per-recording overrides come via the socket. Other content consumers (record_audio.py, voicemail) are short-lived and re-read config each invocation.
   - What's unclear: Whether stt_daemon/agentqueue need any output_dir at all (they mostly write next to the input WAV / use config_dir).
   - Recommendation: Default to **restart the audio daemon** on a data-folder change; leave short-lived tools alone (they pick it up next run). Confirm during planning by grepping each long-lived daemon for `output_dir`/`data_dir` reads.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `/usr/bin/brctl` | Optional secondary iCloud signal | ✓ | macOS-bundled | Path-prefix + `SF_DATALESS` (no brctl needed) |
| `/usr/bin/xattr` | Optional richer fileprovider xattr read | ✓ | macOS-bundled | `SF_DATALESS` via stdlib |
| Python `stat.SF_DATALESS` + `os.stat().st_flags` | Core eviction detection | ✓ | py 3.8+ on Darwin | none needed — it's stdlib |
| `~/Library/Mobile Documents/com~apple~CloudDocs` | iCloud detection target (exists if user uses iCloud) | ✓ (on-device) | — | Detection returns "not cloud" if absent — correct |
| `~/Library/CloudStorage/` | 3rd-party engine detection | ✓ (on-device, 6 GoogleDrive domains) | — | Detection returns "not cloud" if absent — correct |
| `doctor.py --json` | Reuse gate input | ✓ (script present) | — | If it errors, gate degrades to "install" (safe default) |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:** None blocking — all primary detection is stdlib.

## Validation Architecture

> `workflow.nyquist_validation` is not disabled in config → this section is included.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (Python) + Vitest (yulu_ui TS) |
| Config file | none for pytest (markers registered in `tests/conftest.py`); `vitest.config.ts` for UI |
| Quick run command | `python3 -m pytest tests/test_cloud_detect.py tests/test_yulu_platform_macos.py -x -q` |
| Full suite command | `make test` (= `py-compile` + `pytest tests -q` + `swift-build`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DATA-03 | `is_cloud_root` flags iCloud `Mobile Documents` path | unit | `pytest tests/test_cloud_detect.py::test_icloud_path_detected -x` | ❌ Wave 0 |
| DATA-03 | `is_cloud_root` flags `~/Library/CloudStorage/GoogleDrive-*` | unit | `pytest tests/test_cloud_detect.py::test_cloudstorage_google_detected -x` | ❌ Wave 0 |
| DATA-03 | `is_cloud_root` returns not-cloud for `~/.config/yulu` and `~/Movies/Yulu` | unit | `pytest tests/test_cloud_detect.py::test_local_paths_not_cloud -x` | ❌ Wave 0 |
| DATA-03 | `is_evicted` true on a mocked `st_flags` with `SF_DATALESS` set | unit (mock `os.stat`) | `pytest tests/test_cloud_detect.py::test_dataless_flag -x` | ❌ Wave 0 |
| DATA-02 | `runtime_dir()` is machine-local and does NOT read `audio.output_dir` | unit | `pytest tests/test_yulu_platform_macos.py::test_runtime_dir_locked -x` | ⚠️ extend existing |
| DATA-02 | `assert_runtime_not_synced()` raises when runtime resolves under a cloud root | unit (monkeypatch home) | `pytest tests/test_yulu_platform_macos.py::test_runtime_lock_rejects_synced -x` | ❌ Wave 0 |
| DATA-01 | `data_dir()` follows config `audio.output_dir` (already covered) | unit | `pytest tests/test_yulu_platform_macos.py::test_path_resolver_precedence -x` | ✅ exists |
| DATA-01 | content consumers (`CORPUS_ROOT`, voicemail dir) resolve via `data_dir()` not a literal | unit | `pytest tests/test_search_corpus_root.py -x` (new) | ❌ Wave 0 |
| REUSE-01/02 | `status=="usable"` → skip install; `present-but-unverified`/`absent` → install | unit (parametrized) | `pytest tests/test_reuse_gating.py -x` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `python3 -m pytest tests/test_cloud_detect.py tests/test_yulu_platform_macos.py tests/test_reuse_gating.py -x -q`
- **Per wave merge:** `make test` (full pytest + py-compile + swift-build)
- **Phase gate:** Full suite green before `/gsd-verify-work`.

### What needs REAL iCloud/Drive (human/VM validation — cannot be unit-tested)
These three are **integration checks the agent cannot fully automate** because they need a live sync engine and real eviction:
1. **End-to-end eviction warning** against a real `~/Library/Mobile Documents/com~apple~CloudDocs` subfolder (the unit test mocks `SF_DATALESS`; a real-iCloud smoke confirms the flag actually appears). *This research already performed this once on-device — document it as a manual acceptance step.*
2. **Actual eviction of an in-use recording** (to confirm the warned-about harm) — requires "Optimise Mac Storage" + disk pressure or `brctl evict`. **Manual/VM only**; out of scope to automate.
3. **Folder-picker → daemon restart → new recordings land in the new folder** while the old folder still has prior content (the live-config path) — needs the running daemon stack. Mark as a **manual smoke** in the phase acceptance, or an `@pytest.mark.integration` test that spawns the audio daemon (the project already has an `integration` marker).

### Wave 0 Gaps
- [ ] `tests/test_cloud_detect.py` — covers DATA-03 (path-prefix + dataless, fully mocked; runs on any OS)
- [ ] `tests/test_reuse_gating.py` — covers REUSE-01/02 (parametrized tri-state → skip/install)
- [ ] `tests/test_search_corpus_root.py` — covers DATA-01 content-root routing through `data_dir()`
- [ ] Extend `tests/test_yulu_platform_macos.py` — `runtime_dir` locked + `assert_runtime_not_synced`
- [ ] (manual) Document the on-device eviction-flag observation as a manual acceptance note; flag the live folder-move smoke for human/VM.

## Security Domain

> `security_enforcement` not disabled → included. Phase 5 is mostly path/config logic; the security surface is small but real (it touches where user audio/transcripts live and runs subprocesses).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No auth surface in this phase |
| V3 Session Management | no | — |
| V4 Access Control | partial | The data-folder is user-chosen; ensure Yulu only writes within the chosen dir + the locked runtime dir (no `..` traversal from a config value). Mirror the Phase-3 path-bounding discipline (`scan_models` globs only fixed roots). |
| V5 Input Validation | **yes** | The folder-picker path and `audio.output_dir` are user input. `tRPC config.update` already constrains the *key* with a regex (`config.ts:9`); the *value* (a path) must be validated: expand `~`, resolve, reject non-absolute/devious paths before writing. Reuse `MacOSPathResolver`'s expand-and-resolve idiom. |
| V6 Cryptography | no | No crypto in this phase |
| V12 File/Resource | **yes** | Cloud-detection `os.stat`/`iterdir` must be bounded (the `[:64]` child scan) and never follow into arbitrary symlinked roots; `cloud_detect` already `resolve()`s and bounds the scan. |

### Known Threat Patterns for {stdlib-Python path logic + bash reuse gate}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via a crafted `audio.output_dir` (`../../etc`) | Tampering / EoP | `Path(value).expanduser().resolve()` then assert it's absolute and (optionally) under `$HOME` before persisting; never `os.system`/shell-interpolate the path. |
| Command injection via the reuse-gate reading a path into bash | Tampering | The reuse gate runs `doctor.py --json` (fixed argv) and parses JSON in Python — it never interpolates a capability's `resolved_path` into a shell command. Keep it that way (list-form, JSON parse in Python, mirroring `probes.py` T-03-02). |
| Reading a synced/dataless file triggers an unwanted network download | DoS (bandwidth) / info-leak | `os.stat` does NOT materialize a dataless file (stat is metadata-only) — verified the flag is readable without download. Do not `open()`/read files during detection; stat only. |
| Following a symlink in CloudStorage to escape the bounded scan | Tampering | `os.stat(child, follow_symlinks=False)` in the child scan (shown in Pattern 1). |
| Warning fatigue → user disables warnings entirely | (usability→security) | One-time, specific, opt-in warning at pick time (not a nag); copy is honest and actionable. |

## Sources

### Primary (HIGH confidence — on-device verification, this session)
- On-device probe (macOS Darwin 26.5, Python 3.14.3): `stat.SF_DATALESS = 0x40000000` exposed; real evicted iCloud file `st_flags=0x40000060` → `dataless=True`; `~/.config/yulu` and `~/Library/CloudStorage` → `dataless=False`.
- On-device: `os.getxattr`/`setxattr`/`listxattr`/`removexattr` all `False` (absent on Darwin CPython).
- On-device: `~/Library/Mobile Documents/com~apple~CloudDocs` exists; `~/Library/CloudStorage/` contains 6 `GoogleDrive-<account>` File-Provider domains.
- On-device: Unix-socket `bind()` under iCloud Drive **succeeded** (D-01 "impossible" claim falsified).
- On-device: `/usr/bin/brctl` and `/usr/bin/xattr` present; `brctl status` returns iCloud container sync state.
- Codebase (read directly): `path_resolver.py` (runtime_dir seam), `capabilities/{report,probes,provider}.py` (tri-state), `setup_deps.sh`/`setup_capabilities.sh` (install scripts), `queue_store.py`/`state_store.py`/`recording_lock.py`/`vocab/db.py`/`search/indexer.py` (runtime/state), all 8 `com.yulu.*.plist` (no `YULU_OUTPUT_DIR`), `audio_daemon.swift:loadRecordingDir`, `yulu_ui/src/{paths.ts,routers/config.ts}`.

### Secondary (MEDIUM-HIGH — official/authoritative docs)
- Apple Developer: `FileManager.isUbiquitousItem(at:)` — https://developer.apple.com/documentation/foundation/filemanager/1410218-isubiquitousitem
- Apple Developer Forums / WWDC21 "Sync files to the cloud with FileProvider" — eviction is automatic on disk pressure; `SF_DATALESS`; syncable xattr flag. https://developer.apple.com/videos/play/wwdc2021/10182/
- SQLite: "How To Corrupt An SQLite Database File" + forum on WAL-checkpoint corruption — cloud sync / moved hot-journal corrupts. https://sqlite.org/howtocorrupt.html , https://sqlite.org/forum/info/47107ab818977549
- The Eclectic Light Company — "How iCloud has changed in Sequoia: pinning and more" (the 10-item pin/eviction contextual-menu cap; `com.apple.fileprovider.pinned`; FPPinOperation; public FileProvider macOS = replicated-only). https://eclecticlight.co/2024/09/30/how-icloud-has-changed-in-sequoia-pinning-and-more/
- The Eclectic Light Company — "macOS Sonoma has changed iCloud Drive radically" + Michael Tsai "iCloud Drive Switches to Dataless Files" (dataless replaces `.icloud` stubs in Sonoma). https://eclecticlight.co/2023/10/25/ , https://mjtsai.com/blog/2023/10/27/icloud-drive-switches-to-dataless-files/
- TidBITS — "Apple's File Provider Forces Mac Cloud Storage Changes" + MacRumors 12.3 change (third-party engines → `~/Library/CloudStorage` since macOS 12.3). https://tidbits.com/2023/03/10/ , https://www.macrumors.com/2022/01/25/macos-12-3-cloud-storage-changes/

### Tertiary (LOW — community, used only for orientation)
- OSXDaily / forum threads on `~/Library/Mobile Documents/com~apple~CloudDocs` path and `brctl evict` usage (cross-checked against on-device reality).

## Metadata

**Confidence breakdown:**
- Cloud-sync detection (paths + dataless): **HIGH** — verified on a real Mac with live iCloud + 6 Drive domains; flag value and behavior reproduced directly.
- Runtime/content split inventory: **HIGH** — grepped the actual tree; the hardcoded literals and plist env contents are facts, not inference.
- Reuse gating: **MEDIUM-HIGH** — the tri-state contract and `--json` producer are read directly; only the exact JSON nesting (A1/Open-Q2) and `gog` scope (A2/Open-Q1) are unconfirmed.
- Data-folder propagation: **MEDIUM-HIGH** — the "no plist env var, restart the audio daemon" mechanism is verified; per-daemon SIGHUP-vs-restart specifics (Open-Q3) need a planning-time grep.
- Pitfalls: **HIGH** — three of them (os.getxattr, socket impossibility, plist env) are falsifications of stated assumptions, verified on-device.

**Research date:** 2026-05-30
**Valid until:** ~2026-06-29 (30 days) for the codebase facts; the macOS File-Provider behavior is stable across 13–15 but **re-verify the 10-item cap and dataless semantics if targeting macOS 16+**, as Apple has changed File Provider behavior in each of the last three releases.

---

## RESEARCH COMPLETE

**Phase:** 5 - Capability Reuse + Data-Folder / Cloud-Sync Safety
**Confidence:** HIGH

### Key Findings
- **Eviction detection is pure stdlib and verified on-device:** `os.stat(path).st_flags & stat.SF_DATALESS` (0x40000000) — a real evicted iCloud file reported `0x40000060`. This is the precise signal for the D-03 warning; no subprocess/lib needed.
- **Two CONTEXT.md assumptions are FALSE (verified on-device):** (1) `os.getxattr` does NOT exist on macOS — use `SF_DATALESS` or `/usr/bin/xattr`; (2) a Unix socket CAN be bound under iCloud Drive — the runtime lock must be justified by corruption/eviction, not impossibility.
- **Two cloud-root families, different paths:** iCloud = `~/Library/Mobile Documents/com~apple~CloudDocs/`; third-party engines = `~/Library/CloudStorage/<Provider>-<account>/` (6 real GoogleDrive domains on-device). Detection = path-prefix + dataless.
- **Propagation is config.json + daemon restart, NOT plist env:** no plist injects `YULU_OUTPUT_DIR`; the audio daemon caches `RECORDING_DIR` at start and needs a restart. Three hardcoded `~/Movies/Yulu` literals (`search/indexer.py:32`, `voicemail/repo.py:26`, `record_audio.py:68`) must route through `data_dir()`.
- **Reuse gate is low-risk:** the Phase-3 tri-state already exists via `doctor.py --json`; gate strictly on `status == "usable"`. Open: `gog` is not yet in the report (Open-Q1), and the exact JSON nesting needs a one-line confirmation (Open-Q2).
- **Recommendation:** keep `runtime_dir()` == `~/.config/yulu` (do NOT relocate — pure churn, Pitfall 1); land the D-01 split+lock before the D-02/D-03 picker.

### File Created
`/Users/liaoyuxing/Documents/Codebase/Yulu/.claude/worktrees/affectionate-mahavira-769bc9/.planning/phases/05-capability-reuse-data-folder-cloud-sync-safety/05-RESEARCH.md`

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Cloud-sync detection | HIGH | Verified on a real Mac with live iCloud + Drive |
| Runtime/content split | HIGH | Grepped the actual tree; literals are facts |
| Reuse gating | MEDIUM-HIGH | Contract read directly; JSON nesting + `gog` scope unconfirmed |
| Data-folder propagation | MEDIUM-HIGH | Mechanism verified; per-daemon SIGHUP-vs-restart needs planning grep |

### Open Questions
1. Is `gog`/`gogcli` in scope for REUSE-01's reuse gate? It is NOT in the current Phase-3 report — may need a small probe addition.
2. Exact JSON nesting of the tri-state in `doctor.py --json` (`host_capabilities.capabilities.<cap>.status` assumed) — confirm with one command in planning.
3. SIGHUP vs restart per daemon for the data-folder change — recommend "restart the audio daemon"; grep each long-lived daemon in planning.

### Ready for Planning
Research complete. The planner can create PLAN.md files. Honor the hard sequencing (D-01 split+lock BEFORE the D-02/D-03 picker), keep `runtime_dir` at `~/.config/yulu`, and resolve Open-Q1/Q2 with quick planning-time checks.
