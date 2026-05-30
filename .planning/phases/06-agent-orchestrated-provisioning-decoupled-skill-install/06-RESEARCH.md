# Phase 6: Agent-Orchestrated Provisioning + Decoupled Skill Install - Research

**Researched:** 2026-05-30
**Domain:** Idempotent provisioning registry (Python wrapping bash) + supply-chain attestation gate + resumable state + skill decoupling
**Confidence:** HIGH (grounded in the actual repo; all six step bodies, the installer, the CLI, the CI attestation, and the atomic-write pattern read directly; `gh attestation verify` behavior verified live on this machine)

This is a spike. The research IS the spike. The pass bar is the two **failure** paths — kill-at-step-N resume and tampered-asset rejection — both proven simulatable in pytest below.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** A registry of named steps, each `check()` / `apply()` → `StepResult{status: ok|skipped|error, detail}`, invocable via `yulu provision <step>`. The Phase 1 `setup_*.sh` (deps / audio / models / daemons / capabilities / ui) map **1:1** onto steps (the registry wraps them). Idempotent: `check()` already-done → `apply()` returns `skipped`, never re-does destructive work.
- **D-02 [spike resolution]:** **DUAL caller.** Step registry is BUILD NOW; the host agent CAN drive `yulu provision <step>`. BUT the verified signed-zip + `curl|bash` path stays the **PRIMARY, non-negotiable fallback**. We do NOT make agent-orchestration the primary install. The spike VALIDATES the agent path against its exit criteria; it does not bet the install on it.
- **D-02b [spike exit criteria, PROV-02]:** pass bar is the FAILURE paths: (1) **kill-at-step-N resume** (PROV-04) and (2) **tampered-asset rejection** (PROV-03). Both testable WITHOUT a real agent. `uv`/`uvx`: evaluate, recommend DEFER.
- **D-03:** Provisioning verifies asset integrity via `gh attestation verify` BEFORE executing any step. The verified signed-zip + `checksums.txt` SHA-256 path remains a working non-negotiable fallback when `gh` is absent. Tampered asset REJECTED before any step (fail-closed).
- **D-04:** Per-step state file `.yulu-install.json` (per-step `{status, ts}` + `schema_version`). Killed mid-way → resume from last incomplete step, redoing NO completed steps, duplicating NO daemons. Builds on the existing `.yulu-install.json` `source` field.
- **D-05:** `yulu skill install [--agent <name>]` installs/updates the agent skill independently of core install (idempotent). EXTRACT `setup.sh:install_agent_skill()` (line 620) into this standalone subcommand; REMOVE from the main `setup.sh` flow.
- **D-06:** New `provision/` module (mirrors vocab/prompts/search): `registry.py` (Step ABC + StepResult + named-step table), `state.py` (`.yulu-install.json` read/write + resume), `attest.py` (`gh attestation verify` + signed-zip/checksum fallback + tamper rejection). `yulu provision <step>` + `yulu skill install` CLI subcommands. Steps wrap the Phase 1 `setup_*.sh` (do not duplicate logic).
- **D-07 [uv/uvx]:** Do NOT adopt `uv`/`uvx` this phase — host python3 locked (Phase 1 D-01); adding uv is a new dependency + scope creep. Spike evaluates + records recommendation; no adoption.
- **D-08 [scope guard]:** build registry + attestation + resumable state + skill decouple. Agent-as-caller VALIDATED but signed-zip stays PRIMARY. NO uv adoption. Migration is Phase 7.

### Claude's Discretion
All implementation decisions in this phase are Claude's discretion (autonomous mode). The structural skeleton is locked (D-06); the internal shapes (exact StepResult fields beyond the required three, exit-code mapping, where the atomic write lives) are mine to design, recorded below.

### Deferred Ideas (OUT OF SCOPE)
- Making agent-orchestration the PRIMARY install → future, contingent on agent-UX confidence.
- `uv`/`uvx` adoption → evaluated, deferred (new dep).
- Auto-migration of existing installs → **Phase 7** (do not build migration here; just keep `StepResult` stable so Phase 7 can drive the same steps).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PROV-01 | Provisioning is a registry of named, idempotent steps (`check`/`apply` → `StepResult`), via `yulu provision <step>` | §"Step Registry Shape" — the six `setup_*.sh` already accept `(mode)` and are idempotent (proven by `test_setup_decomposition.py`); the registry is a thin Python wrapper invoking `subprocess.run(["bash", script, mode])`. `check()` probes filesystem/launchctl state; `apply()` runs the script and returns `skipped` if `check()` already passed. |
| PROV-02 | A spike validates agent-orchestrated provisioning, with partial-failure/resume and tampered-asset rejection as explicit exit criteria | §"Validation Architecture" — both failure paths are pytest-simulatable: kill-at-step-N via a step that raises mid-`apply()`, tamper via byte-corrupting a fixture zip. No real agent needed; the "agent" is just a caller invoking `yulu provision`. |
| PROV-03 | Verify asset integrity (`gh attestation verify`) before execution; signed-zip path remains non-negotiable fallback | §"Attestation Gate" — exact invocation + the decisive finding that `gh attestation verify` REQUIRES auth (exit 4) even for public repos, so the fallback ladder is: gh-pass → proceed; gh-exit-4 (unauth) OR gh-absent → checksum verify; gh-other-nonzero on a present+authed gh → REJECT (fail-closed). Reuses `release_installer.verify_checksum` / `sha256_file`. |
| PROV-04 | Resumable via per-step state file (`.yulu-install.json`) | §"Resume State Schema" — extend the existing `.yulu-install.json` (currently `{schema:1, source, installed_at, ...}`) with a `steps: {name: {status, ts}}` map + `schema_version`. Atomic write via the proven `queue_store.py` `tempfile.mkstemp`+`os.replace` (optionally `fcntl` lock) pattern. Resume = skip steps already `ok`; a step left `running`/partial is re-run (its `check()` decides if work remains). |
| PROV-05 | `yulu skill install [--agent]` installs/updates the agent skill independently of core install (idempotent), decoupled from `setup.sh` | §"Skill Install Extraction" — lift `setup.sh:620-676` verbatim-minus-prompts into `provision/skill.py` (or a `yulu` CLI shim calling `npx skills add ... -y`); delete the `install_agent_skill` call at `setup.sh:925`. Idempotency is at the Yulu wrapper level (re-run overwrites symlink, tolerates `npx` failure non-fatally) because `npx skills add` is NOT guaranteed idempotent upstream. |
</phase_requirements>

## Summary

Phase 6 is **plumbing over already-solid foundations**, not greenfield invention. The six `setup_*.sh` concern scripts (Phase 1) are already idempotent, isolated, non-interactive, mode-parameterized (`setup_X.sh release|dev`), and have a green test harness (`test_setup_decomposition.py`, 39 passing) that runs each one hermetically behind a no-op PATH shim. The registry's job is to wrap them with a Python `check()`/`apply()`/`StepResult` veneer and a resume ledger — it must NOT reimplement their logic.

Two parts are genuinely failure-prone and ARE the spike:

1. **Tamper rejection (PROV-03).** The decisive, non-obvious finding: `gh attestation verify` **requires authentication** (GH_TOKEN / `gh auth login`) to fetch attestations from the GitHub API, returning **exit code 4** when unauthenticated — even for the public `Nowhitestar/Yulu` repo (verified live; this is a tracked CLI limitation, cli/cli #11803). Therefore "gh is installed" is NOT sufficient to gate on attestation; "gh is installed AND authenticated" is. The fallback ladder must treat unauthenticated-gh identically to absent-gh: both degrade to the SHA-256 `checksums.txt` path (which `release_installer.py` already implements). A tampered asset is rejected when EITHER attestation verify fails on an authed gh, OR the checksum mismatches — and that rejection must happen **before any step's `apply()` runs** (fail-closed).

2. **Resume after kill-at-step-N (PROV-04).** The existing `queue_store.py` already demonstrates the exact durability primitive needed: `fcntl.flock` + `tempfile.mkstemp` + `os.replace` atomic write, plus a "mark `processing` inside the lock" claim pattern that is the template for "mark step `running` before `apply()`, `ok` after". The subtlety: a step interrupted mid-`apply()` is left in a non-`ok` state, so on resume it is **re-run**, and its `check()` is what makes re-running safe (the bash scripts are already idempotent, so re-running a partially-applied step duplicates no daemons). The ledger never re-runs a step recorded `ok`.

The remaining three parts (registry shape, skill extraction, uv-defer) are low-risk and well-precedented in the repo.

**Primary recommendation:** Create `provision/` mirroring `vocab/` (`__init__.py` + `cli.py` + the new `registry.py`/`state.py`/`attest.py`). Make `attest.py` import-and-extend `release_installer`'s checksum helpers rather than re-implement them. Gate strictly on `gh-authed AND verify==0`; fall back to checksums on exit-4-or-absent; fail-closed on tamper before any `apply()`. Mirror `queue_store.py`'s atomic-write for the ledger. Lift the skill body verbatim-minus-prompts and delete its call site in `setup.sh`. Record uv as DEFER.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Named step orchestration (`check`/`apply`) | Python (`provision/registry.py`) | Bash (`setup_*.sh` bodies) | Python owns the contract + dispatch + idempotency ledger; bash owns the actual mutation (already written, tested, idempotent). Do NOT port bash logic to Python. |
| Per-step durable state | Python (`provision/state.py`) | Filesystem (`.yulu-install.json` under `~/.yulu` or repo root) | The ledger is a small JSON doc; atomic write is a Python concern (mirrors `queue_store.py`). |
| Asset integrity verification | Python (`provision/attest.py`) | `gh` CLI subprocess + `release_installer.verify_checksum` | `gh attestation verify` is a subprocess; checksum fallback reuses existing Python. The decision logic (which path, fail-closed) is Python. |
| Skill registration | Python or bash shim (`yulu skill install`) | `npx skills` subprocess | The wrapper enforces Yulu-level idempotency + non-fatal failure; `npx skills` does the actual symlink. |
| CLI dispatch (`yulu provision`, `yulu skill`) | Bash (`yulu` dispatcher) | Python modules | Follows the established `vocab`/`prompts`/`search` pattern: bash `exec python3 -m provision.cli`. |
| Primary install (untouched) | Bash `install.sh` + `release_installer.py` | — | D-02: signed-zip + `curl\|bash` stays PRIMARY. The registry is additive, not a replacement. |

## Standard Stack

This phase introduces **zero new third-party dependencies** (CLAUDE.md: stdlib-first Python; D-07: no uv). Everything is host tooling already present and already used by the repo.

### Core (all already in repo / on host)
| Tool/Module | Version (verified on host) | Purpose | Why Standard |
|-------------|---------------------------|---------|--------------|
| Python `subprocess` (stdlib) | 3.14.3 | Invoke `bash setup_*.sh`, `gh`, `shasum`, `npx` | Already the repo's process-boundary idiom (`release_installer.run`, `doctor._run`, `agent_queue_worker`). |
| Python `json`, `pathlib`, `tempfile`, `os`, `fcntl` (stdlib) | 3.14.3 | Ledger read/write + atomic replace + lock | Exactly what `queue_store.py` uses today. |
| Python `dataclasses` (stdlib) | 3.14.3 | `StepResult`, step descriptors | `release_installer.py` already uses `@dataclass(frozen=True)` for `ReleaseAsset`/`InstallMetadata`. |
| `abc.ABC` (stdlib) | 3.14.3 | `Step` ABC with `check()`/`apply()` | D-06 names a "Step ABC". |
| `gh` CLI | 2.92.0 (2026-04-28) `[VERIFIED: command -v gh]` | `gh attestation verify` | BUILD-04 mints the attestation; this is its verifier. Already a doctor-probed capability. |
| `shasum -a 256` / Python `hashlib.sha256` | `/usr/bin/shasum` present `[VERIFIED]` | Checksum fallback | `release_installer.sha256_file` / `verify_checksum` already implement it — REUSE, don't duplicate. |
| `npx skills` (vercel-labs/skills) | npx 11.12.1 (node@24) `[VERIFIED: command -v npx]` | Skill registration | The existing `install_agent_skill` already shells `npx -y skills add`. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Wrapping `setup_*.sh` via subprocess | Porting each step to native Python | Rejected — D-01/D-06 say the registry WRAPS the scripts; porting duplicates tested, idempotent bash and doubles the maintenance + platform surface. The scripts are the step bodies. |
| `gh attestation verify` (online) | Offline `--bundle` + `--custom-trusted-root` | Rejected for this phase — offline verify requires a pre-downloaded `*.jsonl` attestation bundle (`gh attestation download`) shipped alongside the zip; the release currently ships only zip + checksums + install.sh (`release-publish.yml`), not the bundle. Online verify + checksum fallback is the documented and shipped path. (Offline bundle is a possible HARD-02 hardening, out of scope.) |
| `fcntl` lock on the ledger | Lockless `os.replace` only | `os.replace` alone is atomic enough for single-writer provisioning (one `yulu provision` run at a time); `fcntl` is cheap insurance against a concurrent invocation and matches `queue_store.py`. Recommend including it for parity (low cost), but it is not load-bearing for correctness if writes are serialized. |
| New `uv`/`uvx` runtime | host `python3` | D-07: DEFER. See §"State of the Art". |

**Installation:** None. No `pip install`, no `brew install`, no `npm install` added by this phase.

## Package Legitimacy Audit

**No external packages are installed by this phase.** The registry is pure stdlib Python wrapping host CLIs that the repo already depends on (`gh`, `shasum`, `npx`, `bash`). Therefore the slopcheck/registry-verification gate is **N/A** — there is nothing to slopcheck.

For completeness, the host tools this phase *invokes* (not installs) were verified present and are long-established, first-party tools:

| Tool | Source | Disposition |
|------|--------|-------------|
| `gh` 2.92.0 | Official GitHub CLI (github.com/cli/cli) | Pre-existing host dep (doctor already probes it). Not installed by Yulu. |
| `shasum` | macOS base / Perl coreutils | Pre-existing. Not installed. |
| `npx skills` | vercel-labs/skills (already invoked by setup.sh today) | Pre-existing invocation; unchanged trust posture. Not newly added. |

## Architecture Patterns

### System Architecture Diagram

```text
                       TWO CALLERS, ONE REGISTRY (D-02)
                       ════════════════════════════════

  PRIMARY (untouched, non-negotiable)            VALIDATED (this phase, secondary)
  ───────────────────────────────────            ─────────────────────────────────
  curl|bash install.sh                           host coding agent (Claude Code…)
        │                                                │
        ▼                                                │  "provision deps", "provision ui"
  release_installer.py                                   ▼
   ├─ download zip + checksums.txt              yulu provision <step>   ◄── yulu skill install
   ├─ verify_checksum (SHA-256)  ───────┐               │                        │
   ├─ extract_release_zip               │               │                        ▼
   ├─ replace_runtime_with_backup       │               │              provision/skill.py
   └─ run setup.sh ──┐                  │               │              (npx skills add -y;
                     │                  │               │               idempotent wrapper;
                     ▼                  │               ▼               non-fatal on failure)
            setup.sh (orchestrator)     │      provision/cli.py  (python3 -m provision.cli)
             sequences the six:         │               │
                     │                  │               ▼
                     │                  └──────►  provision/attest.py   ◄═══ ASSET INTEGRITY GATE
                     │                            ┌─────────────────────────────────────────┐
                     │                            │ gh present AND authed?                   │
                     │                            │   ├─ verify==0 ───────────► PASS         │
                     │                            │   ├─ exit 4 (unauth) ──┐                 │
                     │                            │   └─ other nonzero ────┼─► REJECT (close) │
                     │                            │ gh absent OR exit 4 ───┘                 │
                     │                            │   └─► verify_checksum (release_installer)│
                     │                            │         ├─ match  ───────► PASS          │
                     │                            │         └─ mismatch ─────► REJECT (close)│
                     │                            └──────────────┬──────────────────────────┘
                     │                                           │ PASS (and ONLY then)
                     ▼                                           ▼
         ┌───────────────────────────┐            provision/registry.py
         │ setup_deps.sh    (step 1) │◄───────────  for step in ORDER:
         │ setup_audio.sh   (step 2) │                state.mark(step,"running")  ── atomic write
         │ setup_models.sh  (step 3) │                if step.check(): result=SKIPPED
         │ setup_capabilities (4)    │                else: result = step.apply()   # bash subprocess
         │ setup_daemons.sh (step 5) │                state.mark(step, result.status, ts)  ── atomic
         │ setup_ui.sh      (step 6) │
         └───────────────────────────┘            provision/state.py  → .yulu-install.json
              (the SAME bodies                      { schema_version, source, steps:{name:{status,ts}} }
               both callers run)                    resume: skip steps already "ok"; re-run non-ok
```

Reading the primary use case: an agent calls `yulu provision ui` → `cli` → `attest.gate()` runs FIRST (fail-closed) → on PASS, `registry` looks up the `ui` step → `state.mark("ui","running")` → `check()` probes (e.g. `dist/server.js` present + plist loaded) → if not done, `apply()` runs `bash setup_ui.sh release` → `state.mark("ui", result.status)`. A full `yulu provision` (no step arg) walks all six in order, skipping any already `ok` in the ledger.

### Recommended Project Structure
```text
yulu/scripts/provision/          # NEW — mirrors vocab/ prompts/ search/
├── __init__.py                  # exports Step, StepResult, REGISTRY (like vocab/__init__.py)
├── registry.py                  # Step ABC + StepResult dataclass + the ordered named-step table
│                                #   (each step descriptor: name, the setup_*.sh it wraps, a check() probe)
├── state.py                     # .yulu-install.json read/write + resume + atomic write (mirrors queue_store)
├── attest.py                    # gh attestation verify + checksum fallback + tamper rejection (imports release_installer)
├── skill.py                     # yulu skill install body (lifted from setup.sh:620, prompts stripped)
└── cli.py                       # argparse: `provision [<step>]`, `provision --all`, `skill install [--agent]`
```
CLI wiring in `yulu` dispatcher (mirrors lines 303-308):
```bash
provision) shift; PYTHONPATH="$SCRIPT_DIR:${PYTHONPATH:-}" exec "${PYTHON:-python3}" -m provision.cli "$@" ;;
skill)     shift; PYTHONPATH="$SCRIPT_DIR:${PYTHONPATH:-}" exec "${PYTHON:-python3}" -m provision.cli skill "$@" ;;
```

### Pattern 1: Step ABC wrapping an idempotent bash script
**What:** A `Step` exposes `check() -> bool` (probe, no mutation) and `apply() -> StepResult`. `apply()` short-circuits to `skipped` if `check()` is already true, else invokes the wrapped `setup_*.sh` via subprocess.
**When to use:** Every one of the six steps.
**Example:**
```python
# provision/registry.py  (pattern; ground-truth shapes from release_installer.py + setup_*.sh)
from __future__ import annotations
import subprocess, sys
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent   # yulu/scripts/

@dataclass(frozen=True)
class StepResult:
    name: str
    status: str          # "ok" | "skipped" | "error"   (D-01)
    detail: str = ""

class Step(ABC):
    name: str
    @abstractmethod
    def check(self) -> bool: ...        # True == already done (no mutation)
    @abstractmethod
    def apply(self, mode: str) -> StepResult: ...

class ScriptStep(Step):
    """Wraps one setup_*.sh 1:1 (D-01). check() is a filesystem/launchctl probe;
    apply() runs the script (already idempotent + non-interactive, proven by
    test_setup_decomposition.py) and reports skipped when check() already passed."""
    def __init__(self, name: str, script: str, probe):
        self.name, self.script, self._probe = name, script, probe
    def check(self) -> bool:
        return bool(self._probe())
    def apply(self, mode: str) -> StepResult:
        if self.check():
            return StepResult(self.name, "skipped", "check() satisfied")
        proc = subprocess.run(
            ["bash", str(SCRIPTS_DIR / self.script), mode],
            cwd=str(SCRIPTS_DIR), capture_output=True, text=True,
        )                                       # same idiom as release_installer._run_setup_script
        if proc.returncode != 0:
            return StepResult(self.name, "error", (proc.stderr or proc.stdout).strip()[-500:])
        return StepResult(self.name, "ok", "")

# Ordered table — wraps the six, in setup.sh's sequence (deps→audio→models→capabilities→daemons→ui)
REGISTRY: list[Step] = [
    ScriptStep("deps",         "setup_deps.sh",         probe=lambda: _have("brew") and _have("cloudflared")),
    ScriptStep("audio",        "setup_audio.sh",        probe=_audio_ready),     # Yulu.app bin +x & socket sysReady
    ScriptStep("models",       "setup_models.sh",       probe=_model_present),   # configured ggml-*.bin exists OR mlx mode
    ScriptStep("capabilities", "setup_capabilities.sh", probe=_mlx_importable),  # advisory; check() may be lenient
    ScriptStep("daemons",      "setup_daemons.sh",      probe=_launchagents_loaded),
    ScriptStep("ui",           "setup_ui.sh",           probe=_ui_healthz_ok),   # dist/server.js + /healthz
]
```
> Source: shapes lifted from `release_installer.py:43-58` (`run`), `:392-403` (`_run_setup_script`), `:61-83` (`@dataclass(frozen=True)`); step ordering from `setup.sh:894-919`.

**Probe (`check()`) design note (HIGH importance for idempotency + resume):** `check()` must be a *read-only probe of the resulting state*, never a re-derivation of "did I run the script". Good probes already exist as one-liners in the scripts themselves and in `yulu status`/`doctor.py`:
- deps: `command -v brew && command -v cloudflared` (and optionally `whisper-cli` unless reused)
- audio: the `{"action":"status"}` socket probe returning `sysReady:true && micReady:true` (setup_audio.sh:114-115, yulu:163-169)
- models: configured `transcription.local_model_path` file exists (setup_models.sh:89) OR `final_engine==mlx`
- daemons: `launchctl list | grep com.yulu` shows the expected labels (setup_daemons.sh:144)
- ui: `curl 127.0.0.1:7777/healthz` returns `"status":"ok"` (setup_ui.sh:106)

### Pattern 2: Atomic ledger write + claim (mirror queue_store.py exactly)
**What:** Persist `{step: {status, ts}}` with `tempfile.mkstemp` → write → `os.replace`, optionally under `fcntl.flock`. Mark a step `running` *before* `apply()`, then `ok`/`error` *after* — the same "claim inside the lock" shape as `claim_summary_request`.
**When to use:** `state.mark()` on every transition.
**Example:**
```python
# provision/state.py  (mirrors queue_store.py:42-71)
import json, os, tempfile
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 2          # bump from the installer's schema:1 (release_installer.py:248)

def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def _atomic_write(path: Path, doc: dict) -> None:           # == queue_store._write_queue_atomic
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False); f.write("\n")
        os.replace(tmp, path)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass

def load(path: Path) -> dict:
    if not path.exists(): return {}
    try: return json.loads(path.read_text(encoding="utf-8"))
    except Exception: return {}        # corrupt ledger → treat as fresh (safe), like read_install_metadata

def mark(path: Path, step: str, status: str, detail: str = "") -> None:
    doc = load(path)
    doc.setdefault("schema_version", SCHEMA_VERSION)
    doc.setdefault("source", doc.get("source", "release"))   # PRESERVE the Phase-1 source field
    steps = doc.setdefault("steps", {})
    steps[step] = {"status": status, "ts": _now(), **({"detail": detail} if detail else {})}
    _atomic_write(path, doc)

def is_done(path: Path, step: str) -> bool:
    return load(path).get("steps", {}).get(step, {}).get("status") == "ok"
```
> Source: byte-for-byte the durability primitive from `queue_store.py:26-55, 99-117`. `_now()` ISO-Z form from `release_installer.write_install_metadata:250`.

**Resume algorithm (PROV-04 / kill-at-step-N):**
```python
for step in REGISTRY:
    if state.is_done(ledger, step.name):     # recorded "ok" → SKIP, redo nothing
        continue
    state.mark(ledger, step.name, "running") # durable BEFORE mutation
    result = step.apply(mode)                # if killed here, step stays "running" (non-ok)
    state.mark(ledger, step.name, result.status, result.detail)
    if result.status == "error":
        break                                # stop the run; resume picks up here next time
```
The kill-at-step-N guarantee falls out: a `SIGKILL` during `apply()` leaves that step at `running` (or absent if killed before the first mark). On the next run it is NOT `ok`, so it is re-run — and because the wrapped bash is idempotent (`check()` inside `apply()` + the scripts' own idempotency), re-running a half-applied step duplicates no daemons (e.g. `install_plist` unloads before reload; `brew install` no-ops; `npm ci` is lockfile-sha-gated). Steps already `ok` are never touched.

### Pattern 3: Fail-closed attestation gate with checksum fallback
**What:** Verify the asset BEFORE any `apply()`. Gate decision is a 3-way on `gh` availability+auth, with checksum as the universal floor.
**When to use:** Once, at the top of a provisioning run that targets a downloaded release asset. (When provisioning an already-extracted dev/release tree with no asset to verify, the gate is N/A — see Open Questions Q1.)
**Example:**
```python
# provision/attest.py
import shutil, subprocess
from pathlib import Path
import release_installer          # REUSE its verified checksum helpers (do not re-implement)

REPO = "Nowhitestar/Yulu"

class TamperError(RuntimeError): ...

def _gh_present() -> bool:
    return shutil.which("gh") is not None

def verify_asset(zip_path: Path, checksums_path: Path, asset_name: str) -> str:
    """Return the verification method used ('attestation' | 'checksum'); raise
    TamperError (fail-closed) on any integrity failure, BEFORE any step runs."""
    # 1) Prefer gh attestation IF gh is present AND authenticated.
    if _gh_present():
        proc = subprocess.run(
            ["gh", "attestation", "verify", str(zip_path), "--repo", REPO],
            capture_output=True, text=True,
        )
        if proc.returncode == 0:
            return "attestation"                         # PASS
        if proc.returncode == 4:
            pass                                          # unauthenticated → fall through to checksum
        else:
            # gh present + (authed or network) but verify FAILED → tamper / missing attestation.
            # Do NOT silently downgrade a hard verify failure to checksum-only on an authed gh:
            # corroborate with checksum; if that ALSO can't confirm, reject.
            _verify_checksum_or_raise(zip_path, checksums_path, asset_name,
                                      cause=f"gh attestation verify exited {proc.returncode}: {proc.stderr.strip()[-300:]}")
            return "checksum"   # checksum confirmed integrity even though attestation was unavailable
    # 2) gh absent OR exit-4 unauthenticated → checksum is the non-negotiable floor (D-03).
    _verify_checksum_or_raise(zip_path, checksums_path, asset_name)
    return "checksum"

def _verify_checksum_or_raise(zip_path, checksums_path, asset_name, cause: str = "") -> None:
    checksums = release_installer.parse_checksums(checksums_path.read_text(encoding="utf-8"))
    expected = checksums.get(asset_name)
    if expected is None:
        raise TamperError(f"checksums.txt does not list {asset_name}" + (f" ({cause})" if cause else ""))
    try:
        release_installer.verify_checksum(zip_path, expected)      # raises InstallError on mismatch
    except release_installer.InstallError as exc:
        raise TamperError(str(exc) + (f" ({cause})" if cause else "")) from exc
```
> Source: `gh` exit codes verified via `gh help exit-codes` (0 ok / 1 fail / 2 cancel / **4 auth required**) and live `gh attestation verify` on this machine (HTTP 404 for an unknown digest = clean failure path). Checksum helpers are `release_installer.parse_checksums:182`, `verify_checksum:206`, `sha256_file:198`.

### Anti-Patterns to Avoid
- **Re-implementing the step bodies in Python.** D-01/D-06 are explicit: wrap, don't rewrite. The bash is tested + idempotent.
- **Gating on `command -v gh` alone.** That passes for an unauthenticated gh, which then exit-4s on every verify — silently breaking the gate or (worse) being misread as a verify failure. Gate on present-AND-(verify==0). Treat exit-4 as "use checksum".
- **Silently downgrading a hard attestation failure to checksum-pass on an authed gh.** If gh is authed and `verify` returns a non-4 nonzero, that is a tamper/missing-attestation signal; require the checksum to independently confirm before proceeding, and reject if it can't.
- **Letting any step run before the gate.** The gate is fail-closed and FIRST. `apply()` of step 1 must be unreachable until `verify_asset` returns.
- **Re-running a step recorded `ok`.** The ledger's whole point. Only non-`ok` steps re-run.
- **A `check()` that mutates.** Probes are read-only. A `check()` with side effects breaks idempotency reasoning and resume.
- **Trusting `npx skills add` to be idempotent.** It is not guaranteed (see Pitfall 4). Wrap it: re-run overwrites the symlink, and failure is non-fatal.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SHA-256 asset verification | A fresh `hashlib` loop + checksums parser | `release_installer.sha256_file` / `verify_checksum` / `parse_checksums` | Already written, tested (`test_release_installer_integration.py::test_install_release_checksum_mismatch_*`), handles the `*name` BSD-format and hex-validation edge cases. `import release_installer`. |
| Atomic JSON write + lock | `open(path,'w')` then write | `tempfile.mkstemp`+`os.replace` (+`fcntl.flock`) as in `queue_store.py` | A naive write truncates-then-writes; a kill mid-write corrupts the ledger. `os.replace` is atomic on POSIX. `queue_store.py` is the proven local pattern. |
| Step idempotency | Re-deriving "did I run this" | The scripts' own idempotency + a read-only `check()` probe | The six scripts are ALREADY idempotent (brew no-ops, lockfile-sha gate, `install_plist` unload-before-reload, model-exists skip). Lean on it. |
| Attestation verification | Parsing Sigstore bundles by hand | `gh attestation verify` | It validates the cert chain, Rekor transparency-log inclusion, and predicate — none of which is sane to re-implement. |
| Skill symlinking | `ln -s` into agent dirs by hand | `npx skills add ... -y` (the existing call) | Agent-dir layout + copy-vs-symlink fallback is vercel-labs/skills' job; reproducing it re-creates its known bugs. |
| `.yulu-install.json` parsing | Bespoke reader | `release_installer.read_install_metadata` semantics (tolerant: corrupt → `{}`) | Matches the "degrade safely" posture already established; a corrupt ledger should mean "start fresh", not crash. |

**Key insight:** Almost every primitive this phase needs already exists in `release_installer.py` (checksums, install-json, bash-subprocess) or `queue_store.py` (atomic write + claim). The phase is *composition*, and the single highest-leverage rule is **import and reuse those two modules** rather than re-deriving their hard-won edge-case handling.

## Runtime State Inventory

This phase is brownfield (adds a registry over existing installs) and touches install/resume state, so the inventory applies. The question: after the registry + ledger land, what runtime state already on a user's machine carries the old shape?

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | **`.yulu-install.json`** exists today with `{schema:1, source, installed_at, version, asset, sha256, ...}` (release_installer.py:246-259). This phase ADDS a `steps:{}` map + bumps to `schema_version`. **An existing v0.5.x install has NO `steps` key.** | `state.load()` must treat a missing `steps` as "no steps recorded yet" (all steps non-`ok` → a first `yulu provision` walks them, each `check()` skipping the already-satisfied ones). **PRESERVE the existing `source`/`version`/`sha256` fields on write** (the `mark()` example does this via `setdefault`). Do NOT clobber the installer-written keys. |
| Live service config | The six steps install/load **launchd agents** (`com.yulu.*.plist`) whose names are unchanged by this phase. No service-side config carries a renamed string. | None — verified: this phase renames nothing; it wraps the same scripts that write the same plists. |
| OS-registered state | **launchctl-loaded agents** are the OS-registered state the daemons step manages. The registry does not change labels. `check()` reads `launchctl list`; `apply()` reuses `install_plist` (unload-before-reload). | None for renaming. The resume logic must tolerate "daemon already loaded" — handled by the daemons `check()` probe and `install_plist`'s unload-first idempotency. |
| Secrets/env vars | No new secret keys. CI signing secrets (`YULU_CODESIGN_*`, `ASC_*`) live in GitHub Actions and are read only by `sign_and_notarize.sh` — untouched. `gh` reads its own token from keyring/`GH_TOKEN`. | None — verified: this phase adds no secret and reads `gh`'s existing auth, not a Yulu-held credential. |
| Build artifacts | `node_modules/.yulu-built-from` (lockfile-sha marker, setup_ui.sh:60) and `Yulu.app`/`StatusAgent.app` exec bits are existing artifacts the steps already self-heal. The ledger `.yulu-install.json` is itself a new state file but is created, not migrated. | None — verified: the registry reuses the scripts that already manage these; no stale artifact is introduced. The ONLY new on-disk artifact is the `steps` extension to a JSON file that already exists. |

**The canonical question — after every file in the repo is updated, what runtime systems still have the old shape?** Only one: an existing `~/.yulu/.yulu-install.json` written by Phase-1 `release_installer` with `schema:1` and no `steps`. The mitigation is non-destructive forward-compat reading (missing `steps` ⇒ fresh ledger, preserve sibling keys), NOT a migration (migration is Phase 7). This is a **code-edit** concern (how `state.load`/`mark` handle the old doc), not a data-migration task.

## Common Pitfalls

### Pitfall 1: Gating on `gh` presence instead of `gh` presence-AND-auth
**What goes wrong:** `command -v gh` succeeds, the gate "uses attestation", `gh attestation verify` exit-4s (unauthenticated public-repo limitation), and the run either crashes or — if exit-4 is misclassified as a verify failure — falsely rejects a perfectly good asset.
**Why it happens:** `gh attestation verify` requires a token to fetch attestations from the API even for PUBLIC repos (cli/cli #11803, #12030 — open feature requests, not yet fixed). Verified live: this machine is gh-authed, so it worked; a fresh CI box or a user who never ran `gh auth login` is NOT.
**How to avoid:** Three-way the gate: exit 0 ⇒ pass; exit 4 ⇒ unauthenticated ⇒ fall through to checksum (NOT a rejection); other nonzero on an authed gh ⇒ corroborate-with-checksum-or-reject. Checksum is the universal floor.
**Warning signs:** `Error: failed to fetch attestations ... HTTP 401/404`; gate green on a dev's authed laptop but red in CI.

### Pitfall 2: A step interrupted mid-`apply()` left in an ambiguous state
**What goes wrong:** SIGKILL during `setup_daemons.sh` after it loaded 3 of 6 plists. If the ledger marked the step `ok` *before* `apply()` returned, resume skips it and the other 3 daemons never load. If resume blindly re-ran from step 1, it would redo deps/audio/models needlessly.
**Why it happens:** Marking `ok` optimistically, or having no `running` intermediate state.
**How to avoid:** Mark `running` durably BEFORE `apply()`, `ok` only AFTER a 0-exit. A killed step is therefore never `ok`, so resume re-runs exactly it (and only steps after it), and the daemons `check()` + `install_plist` unload-first make the re-run safe (no double daemons). This is the `claim_summary_request` "mark processing inside the lock" pattern (queue_store.py:99-117).
**Warning signs:** After a killed run, `yulu status` shows a partial daemon set; a second `yulu provision` redoes already-finished steps.

### Pitfall 3: Clobbering the installer-written `.yulu-install.json` fields
**What goes wrong:** `state.mark()` writes `{schema_version, steps}` and drops `source`/`version`/`sha256`. Then `lib/common.sh:detect_source` (which reads `.source`) returns `dev` for a release install, flipping `setup_audio.sh` into the swiftc branch on the next `yulu update`.
**Why it happens:** Treating the ledger as a greenfield file instead of an extension of the existing one.
**How to avoid:** `load()` the existing doc, `setdefault`/preserve `source` (and the other installer keys), only ADD `steps`/`schema_version`. The `mark()` example does this.
**Warning signs:** `lib/common.sh:detect_source` returns wrong mode; `yulu update` recompiles on a release box.

### Pitfall 4: Assuming `npx skills add` is idempotent
**What goes wrong:** Re-running `yulu skill install` errors or double-installs, or (known bug) installs to `~/.agents/skills/` without symlinking into `~/.claude/skills/` so the agent can't see it.
**Why it happens:** vercel-labs/skills has no guaranteed-idempotent `add`; `-y` only skips prompts; the idempotent path is the still-evolving `npx skills update`/`install` (issues #549, #337, #744, #423). Symlink creation has open bugs.
**How to avoid:** Make idempotency a *Yulu-wrapper* property: re-running `yulu skill install` re-invokes `npx skills add <repo> -g -a <agent> -y` (overwrites the symlink), treats a non-zero `npx` exit as a non-fatal warning (exactly what setup.sh:673 already does), and never fails the caller. Document that the source of truth is the canonical `skills/yulu/` in the repo and the agent dir is a symlink to it.
**Warning signs:** "skill already exists" errors on re-run; agent doesn't see the skill despite a "success" message.

### Pitfall 5: Running the gate against the wrong thing (no asset present)
**What goes wrong:** An agent runs `yulu provision deps` on an already-extracted `~/.yulu` tree (no zip in hand). If the gate demands a zip+checksums, it errors though nothing is being downloaded.
**Why it happens:** Conflating "verify the downloaded asset" (PROV-03, applies to the download path) with "run a provisioning step on an installed tree".
**How to avoid:** Scope the attestation gate to the *asset-download* entry (the path that has a zip + checksums to verify), as `release_installer` does. When `yulu provision` operates on an already-installed tree, there is no fresh asset to attest; the integrity guarantee came from whatever installed the tree. See Open Questions Q1 for where exactly to place the gate.
**Warning signs:** `yulu provision <step>` on a working install fails with "no checksums.txt".

## Code Examples

### Simulating tamper rejection in pytest (no real release asset, no gh auth)
```python
# tests/test_provision_attest.py  (pattern; reuses test_release_installer_integration.build_fake_asset)
import shutil, subprocess
import pytest
import provision.attest as attest

def test_tamper_rejected_via_checksum(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path)          # from the existing integration test
    zip_path.write_bytes(zip_path.read_bytes() + b"TAMPER")   # corrupt AFTER checksum was computed
    monkeypatch.setattr(attest.shutil, "which", lambda _: None)  # simulate gh ABSENT → checksum floor
    with pytest.raises(attest.TamperError, match="Checksum mismatch"):
        attest.verify_asset(zip_path, checksums, zip_path.name)

def test_unauthenticated_gh_falls_back_to_checksum(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path)          # untampered
    monkeypatch.setattr(attest.shutil, "which", lambda _: "/usr/bin/gh")
    monkeypatch.setattr(attest.subprocess, "run",
        lambda *a, **k: subprocess.CompletedProcess(a, 4, "", "auth required"))  # gh exit 4
    assert attest.verify_asset(zip_path, checksums, zip_path.name) == "checksum"  # PASS via floor
```
> Source: `build_fake_asset` + corrupt-checksum technique from `test_release_installer_integration.py:13-29, 145-162`; subprocess monkeypatch is the repo's standard (`test_dev_install.py`, `test_doctor.py`).

### Simulating kill-at-step-N resume in pytest
```python
# tests/test_provision_resume.py  (pattern)
import provision.state as state
from provision.registry import StepResult

def test_resume_skips_done_reruns_killed(tmp_path):
    ledger = tmp_path / ".yulu-install.json"
    # Simulate a run killed during step "models": deps+audio "ok", models stuck "running".
    state.mark(ledger, "deps", "ok")
    state.mark(ledger, "audio", "ok")
    state.mark(ledger, "models", "running")          # killed here — never reached "ok"
    doc = state.load(ledger)
    assert state.is_done(ledger, "deps") and state.is_done(ledger, "audio")
    assert not state.is_done(ledger, "models")        # NOT ok → will be re-run
    # Resume walk: deps/audio skipped, models (+later steps) re-applied.
    to_run = [s for s in ["deps","audio","models","capabilities","daemons","ui"]
              if not state.is_done(ledger, s)]
    assert to_run == ["models", "capabilities", "daemons", "ui"]
    # Preserves the installer's source field across marks (Pitfall 3):
    state.mark(ledger, "models", "ok")
    assert state.load(ledger).get("source") == "release"

def test_corrupt_ledger_starts_fresh(tmp_path):
    ledger = tmp_path / ".yulu-install.json"
    ledger.write_text("{ not json")
    assert state.load(ledger) == {}                   # safe degrade (== read_install_metadata)
```
> Source: the resume algorithm in Pattern 2; corrupt-tolerance from `release_installer.read_install_metadata:262-270`.

### Driving a real step hermetically (registry → bash) in pytest
```python
# Reuse test_setup_decomposition.py's no-op PATH shim + hermetic HOME/CONFIG_DIR.
# A ScriptStep.apply("release") behind the shim must return StepResult(status in {"ok","skipped"})
# and mutate nothing on the host — proving the registry drives the bash bodies safely and
# that a second apply() returns "skipped" (idempotency at the registry layer).
```
> Source: the hermetic shim harness already exists and passes — `test_setup_decomposition.py:74-108`.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `curl\|bash` with only `py_compile` syntax check (CONCERNS §2b) | Signed-zip + SHA-256 `checksums.txt` + GitHub Artifact Attestation (`gh attestation verify`) | Phase 1 (BUILD-02/03/04, already shipped) | Phase 6 consumes this — the gate is a *verifier* of an attestation that already exists in CI (`release-publish.yml` `actions/attest-build-provenance@v4`). |
| Monolithic `setup.sh` (CONCERNS §2a) | Six idempotent `setup_*.sh` + thin orchestrator | Phase 1 (BUILD-01, shipped) | Phase 6's registry wraps exactly these six — the 1:1 map is real and tested. |
| `install_agent_skill` inside core install (CONCERNS §3a) | Standalone `yulu skill install` (THIS phase) | Phase 6 | Decouples skill from core; removes the Node-required step from the critical install path. |

**`uv`/`uvx` evaluation → DEFER (D-07).** `uv`/`uvx` ARE present on this dev machine (`/opt/anaconda3/bin/uv`, `uvx`) but that is incidental to a conda install, NOT a Yulu dependency. Adopting `uv` would (a) introduce a brand-new hard dependency the installer must bootstrap on every user machine, contradicting Phase-1 D-01's "host python3 is the locked interpreter", (b) not solve any problem this phase has — the registry needs `subprocess` + `json`, both stdlib — and (c) expand scope into runtime-management territory that nothing here requires. **Recommendation: do not adopt. Record evaluated-and-deferred.** Revisit only if a future phase needs reproducible, isolated tool envs (none in this milestone).

**Deprecated/outdated:**
- The `xattr -dr com.apple.quarantine` strip is gone from the release path (setup_audio.sh kept it only behind the dev guard) — the attestation/notarization chain replaces it. The Phase-6 gate verifies the notarized chain's provenance, not the quarantine bit.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `gh attestation verify <zip> --repo Nowhitestar/Yulu` (no `--signer-workflow`) is sufficient to validate the attestation minted by `actions/attest-build-provenance@v4` in the reusable `release-publish.yml`. | Attestation Gate | If the reusable-workflow signer identity must be pinned, verify needs `--signer-workflow Nowhitestar/Yulu/.github/workflows/release-publish.yml` (or `--signer-repo`). Without it, verify still *passes* (less strict), so this is a hardening nuance, not a correctness break — but the planner should add a task to confirm the exact signer flags against a REAL published release (needs CI + a tagged release). `[ASSUMED]` — could not run against a real Yulu attestation (none in this sandbox; the live test hit HTTP 404 for a fake digest). |
| A2 | An existing v0.5.x `.yulu-install.json` has NO `steps` key and forward-compat reading (missing `steps` ⇒ fresh ledger) is the right behavior (vs. a migration). | Runtime State Inventory | Low — migration is explicitly Phase 7 (D-08). If a steps-map shape needs to differ, only `state.py` changes. `[VERIFIED: release_installer.py:246-259 writes schema:1 with no steps]` for the *absence*; the *handling choice* is `[ASSUMED]` (autonomous design). |
| A3 | `npx skills add ... -y` overwrites/refreshes an existing symlink on re-run rather than hard-erroring, so a Yulu-level "re-invoke + tolerate failure" wrapper achieves idempotency. | Skill Install Extraction, Pitfall 4 | Medium — if `add` hard-errors on an existing install in some agent, the wrapper must call `npx skills update` instead (or `--force` if it exists). Mitigated by non-fatal handling (failure ⇒ warn, like setup.sh:673). `[ASSUMED]` from vercel-labs/skills docs + issue tracker; not run against every target agent. |
| A4 | The attestation gate belongs on the *asset-download* path; `yulu provision <step>` on an already-extracted tree has no fresh asset to verify and runs without the gate. | Pitfall 5, Open Questions Q1 | Medium — if the planner wants EVERY `yulu provision` to re-verify the installed tree's provenance, that needs a different design (verify the extracted tree against a stored digest). Recorded as Q1 for the planner to decide. `[ASSUMED]` design call. |
| A5 | `fcntl.flock` on the ledger is optional insurance (single-writer provisioning) and `os.replace` alone suffices for correctness. | Standard Stack / Pattern 2 | Low — if concurrent `yulu provision` invocations are expected, include the lock (cheap). Recommendation already leans "include it for queue_store parity". `[ASSUMED]`. |

## Open Questions

1. **Where exactly does the attestation gate attach — download-time only, or every `yulu provision`?**
   - What we know: PROV-03 says "verify asset integrity before execution"; `release_installer` already verifies at download. An agent driving `yulu provision <step>` on an installed tree has no zip in hand.
   - What's unclear: whether the agent path is expected to (a) download+verify+provision as one flow, or (b) provision an already-verified-at-install tree.
   - Recommendation: Implement the gate as a function (`attest.verify_asset`) callable by BOTH the download flow AND a new `yulu provision --asset <zip> --checksums <txt>` entry; when `yulu provision <step>` runs with no `--asset`, skip the gate (the tree's integrity was established at install). This satisfies fail-closed-on-the-download-path without breaking step-on-installed-tree. Planner: confirm the agent UX expectation.

2. **Exact `--signer-workflow`/`--signer-repo` flags for the reusable-workflow attestation (A1).**
   - What we know: the attestation is minted by `actions/attest-build-provenance@v4` inside the reusable `release-publish.yml`; `gh` docs say reusable-workflow attestations need `--signer-workflow`/`--signer-repo` for strict identity pinning.
   - What's unclear: whether `--repo` alone is the team's accepted strictness, or the signer must be pinned.
   - Recommendation: Ship with `--repo Nowhitestar/Yulu` (works, verified-shape) and add a `checkpoint:human-verify` task to run `gh attestation verify` against the FIRST real Phase-6-era release and capture the exact passing invocation (incl. signer flags) — this is the one thing that genuinely needs a real release asset + gh auth (CI/human), not pytest.

3. **`gh attestation verify` requires network for the online path — what about a fully-offline user?**
   - What we know: online verify needs API access + auth; offline needs a pre-downloaded `--bundle` + `--custom-trusted-root` (not shipped today).
   - What's unclear: whether offline provisioning must still attest.
   - Recommendation: Offline ⇒ checksum floor (already non-negotiable). Shipping the attestation `*.jsonl` bundle in the release for true offline attestation is a HARD-02 hardening, out of scope here.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `gh` CLI | Attestation gate (PROV-03) | ✓ | 2.92.0 (2026-04-28) | **SHA-256 `checksums.txt`** (non-negotiable floor; `release_installer.verify_checksum`) |
| `gh` authentication | `gh attestation verify` online | ✓ (this machine: account Nowhitestar via keyring) | — | Unauth ⇒ exit 4 ⇒ checksum fallback (NOT a failure) |
| `shasum` / `hashlib` | Checksum fallback | ✓ | `/usr/bin/shasum`; hashlib stdlib | none needed |
| `python3` | Entire registry | ✓ | 3.14.3 | none (host python locked, D-07) |
| `pytest` | Validation | ✓ | 9.0.3 | none |
| `bash` | Step bodies | ✓ | system bash | none |
| `npx` (node) | `yulu skill install` (PROV-05) | ✓ | npx 11.12.1 (node@24) | Skill install is OPTIONAL + non-fatal — absent node ⇒ skip with a warning (setup.sh:623-627 already does this) |
| `uv`/`uvx` | (evaluated) | ✓ (incidental, conda) | present | **N/A — DEFER, do not use (D-07)** |

**Missing dependencies with no fallback:** None. Every hard dependency is present; the only "optional" one (node/npx for skill install) already degrades to a non-fatal skip.

**Missing dependencies with fallback:** `gh`/`gh-auth` → checksum floor. This is the entire point of D-03's "non-negotiable fallback".

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest 9.0.3 |
| Config file | `tests/conftest.py` (markers only: `e2e`, `integration`); no `pytest.ini` — discovery is default |
| Quick run command | `cd yulu/scripts && python3 -m pytest ../../tests/test_provision_*.py -q` |
| Full suite command | `make pytest` (= `python3 -m pytest tests -q` from repo root) |
| Test invocation note | Tests import repo modules by name (`import release_installer`, `import provision.attest`) with CWD `yulu/scripts/` (sys.path) — match the existing `test_release_installer_integration.py` style. |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROV-01 | Registry wraps each `setup_*.sh`; `check()`/`apply()`→`StepResult{ok\|skipped\|error}`; second `apply()` ⇒ `skipped` | unit + hermetic-subprocess | `pytest tests/test_provision_registry.py -x` | ❌ Wave 0 |
| PROV-01 | `yulu provision <step>` dispatches to the named step | unit | `pytest tests/test_provision_cli.py -x` | ❌ Wave 0 |
| PROV-02 | **Tampered-asset rejected BEFORE any step runs (fail-closed)** | unit (monkeypatch gh + corrupt zip) | `pytest tests/test_provision_attest.py::test_tamper_rejected_via_checksum -x` | ❌ Wave 0 |
| PROV-02 | **kill-at-step-N: resume skips `ok`, re-runs the killed step, redoes nothing prior, duplicates no daemons** | unit (ledger sim) + hermetic | `pytest tests/test_provision_resume.py -x` | ❌ Wave 0 |
| PROV-03 | gh-authed + verify==0 ⇒ pass; gh exit-4 ⇒ checksum fallback; gh absent ⇒ checksum; checksum mismatch ⇒ `TamperError` | unit (monkeypatch subprocess) | `pytest tests/test_provision_attest.py -x` | ❌ Wave 0 |
| PROV-03 | Real `gh attestation verify` against a published release passes with the documented flags | **manual/CI** (needs real release asset + gh auth) | `gh attestation verify dist/yulu-macos-arm64-vX.Y.Z.zip --repo Nowhitestar/Yulu` | ❌ checkpoint:human-verify |
| PROV-04 | Ledger atomic write; missing `steps` ⇒ fresh; corrupt ⇒ fresh; **preserves installer `source`/`version`/`sha256`** | unit | `pytest tests/test_provision_state.py -x` | ❌ Wave 0 |
| PROV-05 | `yulu skill install [--agent]` idempotent (re-run = refresh, non-fatal on npx failure); removed from `setup.sh` main flow | unit (monkeypatch npx) + grep-guard | `pytest tests/test_provision_skill.py -x` | ❌ Wave 0 |
| PROV-05 | `setup.sh` no longer calls `install_agent_skill` in the main sequence | static guard | `pytest tests/test_provision_skill.py::test_setup_no_longer_calls_install_agent_skill -x` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cd yulu/scripts && python3 -m pytest ../../tests/test_provision_*.py -q` (the new suite; seconds).
- **Per wave merge:** `make pytest` (full suite; the existing 39 install/decomposition tests + new provision tests must stay green — confirmed baseline 39 passed in ~85s).
- **Phase gate:** full suite green + the two real-asset checkpoints (PROV-03 real verify, A1/A2 signer flags) executed by human/CI before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `tests/test_provision_registry.py` — `ScriptStep.check/apply`, `StepResult`, skip-on-second-apply (REQ PROV-01). Reuse `test_setup_decomposition.py`'s shim+hermetic-HOME harness for the real-bash drive.
- [ ] `tests/test_provision_state.py` — atomic write, missing/corrupt `steps` ⇒ fresh, preserve installer keys (REQ PROV-04).
- [ ] `tests/test_provision_resume.py` — kill-at-step-N walk (REQ PROV-02/PROV-04).
- [ ] `tests/test_provision_attest.py` — 3-way gh gate + checksum floor + `TamperError` (REQ PROV-02/PROV-03). Reuse `build_fake_asset` from `test_release_installer_integration.py`.
- [ ] `tests/test_provision_skill.py` — idempotent skill wrapper + `setup.sh` call-site removal guard (REQ PROV-05).
- [ ] `tests/test_provision_cli.py` — `provision <step>` / `provision --all` / `skill install` dispatch (REQ PROV-01/PROV-05).
- [ ] No framework install needed — pytest 9.0.3 present; markers already declared in `tests/conftest.py`.
- [ ] **Two items are NOT pytest-automatable** (need a real release asset + gh auth) → planner inserts `checkpoint:human-verify` tasks: (1) real `gh attestation verify` of a published zip, (2) confirm exact `--signer-workflow`/`--signer-repo` strictness (A1).

## Security Domain

`security_enforcement` not found disabled in config → included. This phase is squarely a supply-chain-integrity feature.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V1 Architecture | yes | Fail-closed integrity gate executes BEFORE any mutation; primary install path (signed-zip) unchanged. |
| V5 Input Validation | yes | Asset name/zip-member validation reused from `release_installer._assert_safe_zip_member` (zip-slip guard) + `parse_checksums` hex validation + `SHA256_RE`. The ledger reader tolerates malformed JSON (degrade to fresh, no crash). |
| V6 Cryptography | yes | **Never hand-roll** — SHA-256 via `hashlib`/`shasum` (existing `verify_checksum`); attestation cert-chain/Rekor verification via `gh attestation verify` (Sigstore). No bespoke crypto. |
| V10 Malicious Code / Supply Chain | **yes (core)** | GitHub Artifact Attestation (SLSA provenance) verify + SHA-256 floor. Tamper ⇒ reject before execution. This is the requirement. |
| V12 Files & Resources | yes | Atomic ledger write (`os.replace`) prevents partial/corrupt state; zip-slip guard on extract (reused). |
| V2 AuthN / V3 Session / V4 Access Control | no | No user auth/session in scope; `gh`'s own token auth is delegated to `gh`, not handled by Yulu. |

### Known Threat Patterns for {Python-wraps-bash provisioning + release-asset download}
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Tampered release zip (MITM / compromised release) | Tampering | `gh attestation verify` (provenance) + SHA-256 `checksums.txt`; reject before any step (fail-closed). |
| Unauthenticated-gh misread as verify-failure → DoS on install | Denial of Service | Treat `gh` exit 4 as "use checksum", not "reject". Checksum is the non-negotiable floor. |
| Attestation predicate forged by a compromised caller workflow | Spoofing | Provenance minted in a *reusable* workflow (trusted builder); verify with `--signer-workflow`/`--signer-repo` (A1 / Q2) to pin signer identity. |
| Zip-slip during extract | Tampering | Reuse `release_installer._assert_safe_zip_member` (already rejects absolute/escape paths). |
| Corrupt/partial ledger after kill → re-run skips needed step or redoes destructive work | Tampering/DoS | Atomic `os.replace` write; `running`-before-`apply`/`ok`-after; idempotent steps; corrupt ⇒ fresh. |
| Skill install pulling/over-writing into wrong agent dir | Tampering | Delegate to `npx skills` (known dir layout); non-fatal; canonical source is repo `skills/yulu/`. |
| `gh`/`npx`/`bash` invoked with interpolated untrusted input | Injection | All subprocess calls use **argv lists** (no `shell=True`), matching the repo's existing `subprocess.run([...])` idiom — no shell metachar exposure. |

## Sources

### Primary (HIGH confidence — read directly this session)
- Repo files (ground truth): `yulu/scripts/setup_deps.sh`, `setup_audio.sh`, `setup_models.sh`, `setup_daemons.sh`, `setup_capabilities.sh`, `setup_ui.sh`, `lib/common.sh`, `setup.sh` (orchestrator + `install_agent_skill` 620-676, main 853-935), `release_installer.py` (full), `queue_store.py` (full), `yulu` (CLI dispatcher, full), `packaging/scripts/sign_and_notarize.sh`, `.github/workflows/release-publish.yml`, `tests/conftest.py`, `tests/test_release_installer_integration.py`, `tests/test_setup_decomposition.py`, `.planning/codebase/CONCERNS.md` (§2a/§2b/§3a/§8c), `.planning/REQUIREMENTS.md` (PROV-01..05).
- Live host probes: `gh 2.92.0`, `gh help exit-codes` (0/1/2/4), `gh attestation verify` against a fake digest (HTTP 404 clean-fail), `gh auth status` (authed), `python3 3.14.3`, `pytest 9.0.3`, `npx 11.12.1`, `shasum` present, baseline `pytest` 39 passed.
- GitHub Docs — Verifying attestations offline (`--bundle`, `gh attestation download`, `--custom-trusted-root`).

### Secondary (MEDIUM confidence — verified against official source / corroborated)
- `gh attestation verify` manual (cli.github.com) — flags, `--repo`/`--owner`, `--signer-workflow`/`--signer-repo` for reusable-workflow signers, `--predicate-type` default `slsa.dev/provenance/v1`.
- cli/cli #11803, #12030, #9338 — `gh attestation verify` requires auth for public repos; exit-4-vs-1 inconsistency on 401.

### Tertiary (LOW confidence — flagged, drives Assumptions A1/A3)
- vercel-labs/skills README + issues #549/#337/#744/#423/#519 — `npx skills add/update` idempotency + symlink behavior (informs Pitfall 4, A3).

## Metadata

**Confidence breakdown:**
- Standard stack (zero new deps; stdlib + host CLIs): HIGH — all verified present; reuse targets read line-by-line.
- Registry shape (wrap the six idempotent scripts): HIGH — the scripts, their idempotency, and the hermetic test harness all exist and pass today.
- Resume/state (atomic ledger + kill-at-N): HIGH — `queue_store.py` is the exact proven primitive; resume algorithm is simple and pytest-simulatable.
- Attestation gate: HIGH on the *fallback logic + exit codes* (verified live + docs); MEDIUM on the *exact strict signer flags* for the reusable workflow (A1/Q2 — needs a real release asset to finalize, the one CI/human checkpoint).
- Skill extraction: HIGH on the lift+remove mechanics; MEDIUM on `npx` re-run idempotency (A3 — wrapped + non-fatal mitigates).

**Research date:** 2026-05-30
**Valid until:** ~2026-06-29 (stable; the one volatile external is `gh attestation verify`'s public-repo-auth behavior — re-check cli/cli #11803 before relying on auth-free verify).

## RESEARCH COMPLETE
