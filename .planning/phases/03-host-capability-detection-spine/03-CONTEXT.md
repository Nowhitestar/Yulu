# Phase 3: Host-Capability Detection Spine - Context

**Gathered:** 2026-05-30
**Status:** Ready for planning
**Mode:** Autonomous (Claude decided from ROADMAP success criteria + CONCERNS §4/§5 + Phase 1/2 contracts; research skipped per ROADMAP "standard pattern — schema design, not research")

<domain>
## Phase Boundary

`doctor.py` produces a single **versioned `HostCapabilityReport`** that honestly reflects what the *daemon* can actually use — per-capability provenance + tri-state status — the foundational dependency four downstream consumers (Phase 4 settings UI, Phase 5 reuse, Phase 8 multi-agent) bind to. Covers **DETECT-01..05**. **Hard prerequisite resolved in-phase:** the `mlx_python` interpreter ambiguity (DETECT-04).

**Out of scope:** the settings-UI surface (Phase 4 consumes this report), reuse-vs-install decisions (Phase 5 gates on the tri-state), Codex/OpenClaw providers (Phase 8 generalizes the ClaudeCode provider). This phase BUILDS the report + the CapabilityProvider seam; consumers come later.

</domain>

<decisions>
## Implementation Decisions — all Claude's discretion (autonomous mandate)

### Report Schema (DETECT-01)
- **D-01:** `HostCapabilityReport` = a **versioned** JSON dataclass (`schema_version` field). Each capability entry = `{provenance, status, resolved_path, detail}`. **provenance** ∈ `host-path` | `yulu-managed` | `agent-config` | `absent`. **status** = TRI-STATE `usable` | `present-but-unverified` | `absent` — NEVER a boolean.
- **D-08:** Tri-state drives every downstream decision; a boolean must NEVER drive a "skip install". Phase 5 reuse gates on `usable` vs `present-but-unverified` vs `absent`. This is why tri-state must land here.

### Honest Detection — "usable by the consumer, not the dev's shell" (DETECT-02/04)
- **D-02:** Binaries resolve via the **login-shell PATH** (`$SHELL -lc 'command -v X'` / parse the login PATH), NOT launchd's minimal PATH and NOT bare `shutil.which`. A binary on the login PATH but absent from launchd's PATH must be reported correctly relative to the consumer.
- **D-03:** Python importability is probed via the **daemon's own interpreter** (the host system `python3` the plist launches via `__PYTHON__`) — `subprocess([daemon_python, '-c', 'import mlx_whisper'])`. A green `usable` mlx-whisper therefore means the *daemon* can import it → no silent first-recording failure (success criterion 4).
- **D-04 [resolves DETECT-04]:** Define ONE canonical "daemon interpreter" resolution (the plist's `python3`) used by both the daemon and the probe. Phase 1 already removed the venv + fixed the dead `mlx_python` field (D-01/D-03); Phase 3 makes detection probe THAT interpreter so "usable" reflects reality.

### Coverage (DETECT-03)
- **D-05:** The report covers: `claude` CLI, `whisper-cli`, `mlx-whisper` importability, configured `llm.command` validity (resolve the command from config.json, check the binary exists), model paths/sizes (Yulu `~/.config/yulu/models/` + host whisper.cpp dirs + HuggingFace `~/.cache/huggingface/`), and recording-dir writability (**via the Phase 2 `PathResolver`** + `shutil.disk_usage`). Fills CONCERNS §4d/§5a/§5b/§5c.

### CapabilityProvider Seam (DETECT-05)
- **D-06:** A `CapabilityProvider` ABC + a `ClaudeCodeProvider` implementation working end-to-end into the report. The provider contributes `agent-config`-provenance capabilities (what the host coding agent has configured — e.g. its `claude` CLI / whisper). The ABC is the seam **Phase 8 generalizes** to Codex/OpenClaw — design it so a second provider is pure addition.

### Structure
- **D-07:** New `capabilities/` module (mirrors the `vocab`/`prompts`/`search` module pattern): `report.py` (schema + `schema_version`), `probes.py` (login-shell PATH resolution, interpreter importability, model scan, dir writability), `provider.py` (CapabilityProvider ABC + ClaudeCodeProvider). `doctor.py` integrates a `host_capabilities` section into its `--json` output without breaking the existing report shape (CONCERNS §5d: pass runtime_root, not source_root).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.** (Research was skipped — these codebase maps + source files ARE the spec.)

### Phase scope & requirements
- `.planning/ROADMAP.md` §"Phase 3" — goal + 5 success criteria + the DETECT-04 hard prerequisite + tri-state mandate
- `.planning/REQUIREMENTS.md` — DETECT-01..05

### The spec (schema design grounded here)
- `.planning/codebase/CONCERNS.md` — §4a (venv/mlx_python — resolved Phase 1, Phase 3 detects), §4b (whisper-cpp dup), §4c (model dirs), §4d (doctor no host capabilities), §5a (no whisper-cli/MLX check), §5b (no llm.command check), §5c (no recording-dir check), §5d (doctor source-vs-runtime root)
- `.planning/codebase/ARCHITECTURE.md` — daemon/IPC architecture + the detection-spine consumers
- `.planning/codebase/STACK.md` — interpreter/model/PATH realities

### Source files the planner will touch (read before editing)
- `yulu/scripts/doctor.py` — `collect_report()` to extend with a `host_capabilities` section; fix the source-vs-runtime root (§5d)
- `yulu/scripts/stt_daemon/config.py`, `yulu/scripts/com.yulu.sttdaemon.plist` — the `__PYTHON__` daemon interpreter (D-04)
- `yulu/scripts/config.example.json` — `llm.command` shape (D-05 validity check)
- `yulu/scripts/agent_queue_worker.py` — how `llm.command` is resolved/run (validity reference)
- `yulu/scripts/yulu_platform/macos/path_resolver.py` — Phase 2 PathResolver (recording-dir writability)
- *(new)* `yulu/scripts/capabilities/` — report.py / probes.py / provider.py

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `doctor.py:collect_report()` already checks `python3`/`ffmpeg`/`swiftc`/`codex`/`gh` — extend its pattern (`_check_command`) for `claude`/`whisper-cli`; add the `host_capabilities` section alongside the existing report.
- Phase 2 `MacOSPathResolver` resolves the recording dir — reuse for writability (D-05), don't re-derive paths.
- The `vocab`/`prompts`/`search` modules are the package-shape analog for `capabilities/` (db/cli/seed → here report/probes/provider).

### Established Patterns
- Doctor check functions never raise — return a dict with an `error` key (keep this contract for the new probes).
- stdlib-first (subprocess for PATH/import probes); no new deps.

### Integration Points
- `host_capabilities` JSON is consumed by Phase 4 (tRPC `host_capabilities` endpoint), Phase 5 (reuse decisions), Phase 8 (multi-provider aggregation) — get the schema + `schema_version` right here, it's a four-consumer contract.
- The daemon-interpreter resolution (D-04) is shared by the running daemon and the probe — single source of truth.

</code_context>

<specifics>
## Specific Ideas
- Tri-state (`usable`/`present-but-unverified`/`absent`), never boolean.
- Provenance (`host-path`/`yulu-managed`/`agent-config`/`absent`).
- Probe importability with the DAEMON's python3, resolve binaries with the LOGIN-shell PATH.
- `schema_version` on the report (four downstream consumers + Phase 7 stamps it).
- CapabilityProvider ABC designed so Phase 8's Codex/OpenClaw providers are pure addition.

</specifics>

<deferred>
## Deferred Ideas
None new. Reuse-vs-install (Phase 5), settings UI (Phase 4), multi-agent providers (Phase 8) consume this report — not built here.

</deferred>

---

*Phase: 3-Host-Capability Detection Spine*
*Context gathered: 2026-05-30 (autonomous, research skipped per ROADMAP)*
