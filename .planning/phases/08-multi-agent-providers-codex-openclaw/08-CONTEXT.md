# Phase 8: Multi-Agent Providers (Codex + OpenClaw) - Context

**Gathered:** 2026-05-30
**Status:** Ready for planning
**Mode:** Autonomous (Claude decided; research skipped per ROADMAP "generalizes the reference impl proven in Phase 3 against an already-locked interface"). This is the FINAL milestone phase — pure addition.

<domain>
## Phase Boundary

The proven `ClaudeCodeProvider` capability-provider is generalized to **Codex** and **OpenClaw**, completing the multi-agent-from-v1 lock so Yulu is agent-native, not single-vendor. Covers **AGENT-01, AGENT-02**.

Phase 3 designed this as **pure addition**: `capabilities/provider.py` has a `CapabilityProvider` ABC carrying NO agent-specific vocabulary, and `default_providers()` is the single Phase-8 extension point. Adding an agent = a new subclass + one `default_providers()` entry, with ZERO edits to `report.py`, `probes.py`, or `doctor.py`.

**Out of scope:** any change to the report schema, the probes, or the doctor wiring (all locked by Phase 3); no new resolution/execution surface (providers only relabel host findings to `agent-config`).

</domain>

<decisions>
## Implementation Decisions — all Claude's discretion (autonomous)

### CodexProvider (AGENT-01)
- **D-01:** `CodexProvider(CapabilityProvider)` — `agent_name = "codex"`. `capabilities()` MIRRORS `ClaudeCodeProvider` exactly: delegate to `probes.probe_command("codex", ("--version",))` → `codex_cli` (absent → `report.absent(...)`, present → `_as_agent_config(...)`), and `probe_mlx_whisper()` → `agent_mlx_whisper` reframed agent-config. Issues NO new subprocess of its own (delegates to Plan-01 probes). Codex is a real host agent (`yulu/scripts/codex_llm.py` shim + the existing `doctor.py` `codex` check confirm it).

### OpenClawProvider (AGENT-02)
- **D-02:** `OpenClawProvider(CapabilityProvider)` — `agent_name = "openclaw"`. Same contract end-to-end: `probe_command("openclaw", ("--version",))` → `openclaw_cli` + `probe_mlx_whisper()` → `agent_mlx_whisper`, reframed agent-config. (If the OpenClaw CLI binary name differs, the probe degrades to `absent` safely — confirm/adjust the command name during execution; the contract is what matters.)

### Aggregation (AGENT-01/02, success criterion 3)
- **D-03:** Append `CodexProvider()` + `OpenClawProvider()` to `default_providers()` — pure addition. `doctor.py` (Phase 3 / plan 03-03) ALREADY iterates `default_providers()` to fold each provider's `agent-config` entries into the `host_capabilities` section. With all three agents present, doctor aggregates each agent's configured stack into ONE report with NO re-probing (each provider contributes its own delegated probes) and NO schema breakage (`schema_version` unchanged). Namespace the provider entries so three agents don't collide (e.g. prefix by `agent_name` if doctor's fold would otherwise clobber `agent_mlx_whisper` — confirm doctor's current keying and keep it non-colliding).

### Structure & Scope
- **D-04:** Extend `capabilities/provider.py` ONLY (2 new subclasses + 2 `default_providers()` entries + `__all__` updates). `report.py` / `probes.py` / `doctor.py` UNTOUCHED (the Phase-3 pure-addition guarantee). Tests mirror `test_capability_provider.py`.
- **D-05:** Each provider only RELABELS host findings to `agent-config` (no new exec/resolution surface — preserves Phase 3 T-03-05). The interface is locked; this phase proves a second + third agent are drop-ins, completing the multi-agent lock.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.** (Research skipped — the Phase 3 contract IS the spec.)

### Phase scope & requirements
- `.planning/ROADMAP.md` §"Phase 8" — goal + 3 success criteria
- `.planning/REQUIREMENTS.md` — AGENT-01, AGENT-02

### The contract this generalizes (the reference impl)
- `yulu/scripts/capabilities/provider.py` — `CapabilityProvider` ABC, `_as_agent_config`, `ClaudeCodeProvider` (the exact pattern to mirror), `default_providers()` (the extension point)
- `yulu/scripts/capabilities/probes.py` — `probe_command` / `probe_mlx_whisper` (delegate to these; do not add a new probe surface)
- `.planning/phases/03-host-capability-detection-spine/03-02-SUMMARY.md` — the provider seam's Phase-8-readiness design
- `yulu/scripts/doctor.py` — the `host_capabilities` fold over `default_providers()` (confirm the keying is non-colliding for 3 agents; do NOT edit unless a collision is real)

### Confirming the agents are real
- `yulu/scripts/codex_llm.py` (codex shim), `yulu/scripts/doctor.py` (existing `codex` check) — Codex is a configured agent
- OpenClaw — the third v1 agent (PROJECT.md multi-agent decision); confirm its CLI name at execution

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ClaudeCodeProvider` is the COPY-AND-ADAPT template — CodexProvider/OpenClawProvider differ only in `agent_name` + the probed command name.
- `_as_agent_config` + `probe_command`/`probe_mlx_whisper` are reused verbatim — no new detection code.
- `default_providers()` is the one-line-per-agent extension point.

### Established Patterns
- Providers never raise (absent entry, not exception); stdlib-only.
- `test_capability_provider.py` already proves "a second (stub) provider satisfies the ABC" — Phase 8 makes the stub real.

### Integration Points
- doctor's `host_capabilities` fold iterates `default_providers()` — confirm the three providers' entries are namespaced so `agent_mlx_whisper` from three agents doesn't collide in the report (keep schema stable).

</code_context>

<specifics>
## Specific Ideas
- CodexProvider (agent_name "codex") + OpenClawProvider (agent_name "openclaw"), mirroring ClaudeCodeProvider.
- Append both to default_providers() — pure addition; doctor/report/probes untouched.
- Each relabels host findings to agent-config; no new probe surface.
- Three agents aggregate into one report, no re-probe, no schema break; keep provider entries non-colliding.

</specifics>

<deferred>
## Deferred Ideas
None — this completes the milestone. Further agents are future drop-ins via the same seam.

</deferred>

---

*Phase: 8-Multi-Agent Providers (Codex + OpenClaw)*
*Context gathered: 2026-05-30 (autonomous, research skipped — Phase 3 contract is the spec)*
