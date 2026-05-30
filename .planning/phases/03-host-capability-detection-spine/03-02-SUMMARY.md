---
phase: 03-host-capability-detection-spine
plan: 02
subsystem: infra
tags: [capabilities, detection, provider, abc, agent-config, claude-code, provenance, phase-8-readiness, stdlib, pytest, tdd]

# Dependency graph
requires:
  - phase: 03-host-capability-detection-spine
    provides: "Plan 01's probes.py (probe_command/probe_mlx_whisper, login-shell PATH resolution) + report.py Capability/Provenance/Status types — the provider DELEGATES to these, adding no new exec surface"
provides:
  - "CapabilityProvider ABC — the agent-neutral seam (agent_name + abstract capabilities() -> dict[str, Capability]) every host-agent arm implements"
  - "ClaudeCodeProvider — reference implementation working end-to-end: probes the host claude CLI + mlx-whisper via Plan 01, relabels host-path findings to agent-config provenance"
  - "default_providers() -> list[CapabilityProvider] — the single Phase-8 extension point (append a subclass + one entry; zero edits to report.py/probes.py/doctor.py)"
  - "Capability keys the provider contributes: claude_cli, agent_mlx_whisper (the shape Plan 03's doctor wiring folds into host_capabilities)"
affects: [03-03-doctor-integration, phase-04-settings-ui, phase-05-reuse, phase-08-multi-provider]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "CapabilityProvider ABC = abc.ABC + a SINGLE @abstractmethod (capabilities); agent_name a plain class attribute — the minimal seam (mirrors yulu_platform/base.py DaemonManager idiom)"
    - "Provider reframes provenance: probes return host-path ('found on the host'); a provider relabels present findings to agent-config ('the host coding agent provides this'). Absent stays absent — never a fake agent-config for a missing tool"
    - "Pure-addition seam — the ABC carries NO agent-specific vocabulary (grep-gated, D-06); a second provider is a drop-in subclass + one default_providers() entry"
    - "default_providers() is the ONE registration point Phase 8 appends Codex/OpenClaw to; Plan 03's doctor iterates it uniformly"
    - "Provider delegates ALL detection to Plan 01's probes — no new subprocess/resolution surface (T-03-05); it only relabels"

key-files:
  created:
    - yulu/scripts/capabilities/provider.py
    - tests/test_capability_provider.py
  modified:
    - yulu/scripts/capabilities/__init__.py

key-decisions:
  - "[03-02] _as_agent_config(cap) relabels provenance host-path->agent-config but ONLY for present/usable entries; an ABSENT probe finding is returned unchanged — a missing tool is never dressed up as agent-configured (the relabel is conditional, not blanket)"
  - "[03-02] The ABC's agent_name is a plain `agent_name: str = ''` CLASS ATTRIBUTE (not abstract) so a subclass sets it with one line and no boilerplate; the only @abstractmethod is capabilities() — the single minimal contract Phase 8 generalizes"
  - "[03-02] ClaudeCodeProvider keys are claude_cli + agent_mlx_whisper; claude_cli present => agent-config Capability w/ resolved path + --version detail, absent => report.absent('claude not on login PATH') (never a stray host-path leaks through a provider)"
  - "[03-02] D-06 grep gate honored structurally: agent names (claude/codex/openclaw) appear ONLY in the concrete subclass + default_providers + docstrings, never on the `class CapabilityProvider` / `@abstractmethod` / `def capabilities` contract lines (grep count == 0)"

patterns-established:
  - "Provider contract: capabilities() never raises — delegates to never-raising probes, returns {key: Capability}; a missing tool is an absent entry, not an exception (inherits the doctor/probe never-raise contract)"
  - "Phase-8 extension recipe: (1) add `class XProvider(CapabilityProvider)` with agent_name + capabilities(), (2) append `XProvider()` to default_providers(). Nothing in report.py/probes.py/doctor.py changes."

requirements-completed: [DETECT-05]

# Metrics
duration: 5min
completed: 2026-05-30
---

# Phase 3 Plan 02: CapabilityProvider Seam + ClaudeCodeProvider Summary

**A single-abstract-method `CapabilityProvider` ABC (agent-neutral by contract) plus the reference `ClaudeCodeProvider` that delegates to Plan 01's probes and relabels host findings to `agent-config` provenance — designed so Phase 8's Codex/OpenClaw arms are a drop-in subclass + one `default_providers()` entry.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-30T07:24:01Z
- **Completed:** 2026-05-30T07:29Z
- **Tasks:** 1 (TDD: RED → GREEN)
- **Files modified:** 3 (2 created — 1 source + 1 test; 1 modified — package exports)

## Accomplishments
- `CapabilityProvider(ABC)`: the seam every host-agent arm implements — `agent_name` (plain class attribute) + a single `@abstractmethod capabilities(self) -> dict[str, Capability]`. The contract names no specific agent, so a second provider is **pure addition** (D-06).
- `ClaudeCodeProvider`: implements the contract **end-to-end** — `agent_name = "claude-code"`; `capabilities()` delegates to Plan 01's `probe_command("claude", ("--version",))` and `probe_mlx_whisper()`, then relabels present host-path findings to `agent-config` provenance. Contributes `claude_cli` + `agent_mlx_whisper`. No new subprocess/resolution surface (T-03-05) — it only relabels.
- `default_providers() -> [ClaudeCodeProvider()]`: the single Phase-8 extension point; Plan 03's doctor wiring iterates this list to fold each provider's entries into `host_capabilities`.
- DETECT-05 satisfied: a provider interface with a working ClaudeCode implementation; the in-test stub provider proves a second arm is a drop-in.
- 10 new provider tests (fully monkeypatched → run on any OS, claude installed or not); full suite **650 passed, 1 skipped** (the 1 skip is pre-existing — no regressions).

## Task Commits

The single task was committed atomically (TDD RED → GREEN):

1. **Task 1 (RED): failing CapabilityProvider contract** — `b27c1e0` (test)
2. **Task 1 (GREEN): CapabilityProvider ABC + ClaudeCodeProvider** — `5035447` (feat)

_No REFACTOR commit — the implementation was clean on first GREEN (no behavior changes to make)._

## Files Created/Modified
- `yulu/scripts/capabilities/provider.py` — `CapabilityProvider(ABC)` (agent_name + abstract `capabilities()`), `ClaudeCodeProvider`, the private `_as_agent_config()` relabel helper, and `default_providers()`.
- `yulu/scripts/capabilities/__init__.py` — added `CapabilityProvider`, `ClaudeCodeProvider`, `default_providers` to the package exports alongside the Plan-01 report exports.
- `tests/test_capability_provider.py` — ABC-conformance, agent-config relabel (present + absent), real-probe never-raise, in-test stub-provider pure-addition, and `default_providers()` Wave-0 assertions (10 tests).

## The Provider Contract (for Plan 03 + Phase 8)

```python
class CapabilityProvider(ABC):
    agent_name: str = ""                                    # plain class attribute — subclass sets it
    @abstractmethod
    def capabilities(self) -> dict[str, Capability]: ...    # the ONE minimal contract

def default_providers() -> list[CapabilityProvider]:        # the single registration point
    return [ClaudeCodeProvider()]
```

- **ClaudeCodeProvider keys:** `claude_cli` (present → `agent-config` Capability w/ resolved path + `--version` detail; absent → `report.absent("claude not on login PATH")`), `agent_mlx_whisper` (mlx-whisper importability reframed agent-config when present, else absent).
- **Relabel rule:** `_as_agent_config(cap)` swaps `host-path → agent-config` for present/usable entries only; an `ABSENT` finding passes through unchanged.
- **Phase-8 extension recipe:** add `class XProvider(CapabilityProvider)` (agent_name + capabilities()) and append `XProvider()` to `default_providers()` — zero edits to `report.py`, `probes.py`, or `doctor.py`.

## Decisions Made
- **`agent_name` is a non-abstract class attribute, not an abstract property** — a subclass sets it with one line; the only abstractmethod is `capabilities()`. Minimal seam, minimal boilerplate for Phase 8.
- **Relabel is conditional, not blanket.** `_as_agent_config()` only reframes present/usable findings; an absent probe result stays `ABSENT`. A provider answers "the host agent provides this" only when the tool is actually there — a missing tool is never disguised as agent-configured.
- **D-06 enforced structurally via the grep gate.** Agent names (`claude`/`codex`/`openclaw`) appear only in the concrete subclass, `default_providers()`, and docstrings — never on the `class CapabilityProvider` / `@abstractmethod` / `def capabilities` contract lines (acceptance grep == 0). A reviewer can imagine a Codex arm implementing the exact same ABC.
- **Provider delegates, never resolves.** `capabilities()` calls Plan 01's `probe_command`/`probe_mlx_whisper`; it issues no subprocess of its own (T-03-05), inheriting the probes' login-shell-PATH + never-raise guarantees.

## Deviations from Plan

None - plan executed exactly as written. The single TDD task went RED → GREEN cleanly; all six acceptance-criteria gates passed on first GREEN (ABC conformance, agent-config provenance, the grep gate for no agent-vocab on the ABC contract, `default_providers()` membership, py_compile, and the import smoke test that passes whether or not `claude` is installed). No bugs, no missing critical functionality, no blocking issues, no architectural changes.

## Issues Encountered
None. No architectural questions, no auth gates, no package installs (stdlib-only — `abc` + the Plan-01 report/probes imports; T-03-SC accepted, no Package Legitimacy checkpoint required).

## TDD Gate Compliance
Task is `tdd="true"`. The gate sequence is verified in git log:
- Task 1: `test(03-02)` `b27c1e0` → `feat(03-02)` `5035447` ✓

The RED commit's test failed before GREEN for the right reason (`ImportError: cannot import name 'provider' from 'capabilities'` — the module did not exist yet, not a test typo). No test passed unexpectedly during RED.

## User Setup Required
None — no external service configuration required.

## Next Phase Readiness
- **03-03 (doctor integration)** can now iterate `default_providers()` and merge each provider's `capabilities()` dict into a `host_capabilities` section of `doctor.py --json`, alongside the Plan-01 direct probes. The provider entries arrive pre-labeled `agent-config`, so the Phase 4 settings UI can render "reused from your agent" vs "Yulu-managed" without further classification.
- **Phase 8 (multi-provider)** is a drop-in: a `CodexProvider` / `OpenClawProvider` subclasses `CapabilityProvider`, sets `agent_name` + `capabilities()`, and is appended to `default_providers()`. The grep-gated agent-neutral ABC guarantees no edits to `report.py`/`probes.py`/`doctor.py`.
- No blockers.

## Self-Check: PASSED

(see appended Self-Check section below)

---
*Phase: 03-host-capability-detection-spine*
*Completed: 2026-05-30*
