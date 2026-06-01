# Phase 5: Capability Reuse + Data-Folder / Cloud-Sync Safety - Context

**Gathered:** 2026-05-30
**Status:** Ready for planning (research needed — see canonical_refs)
**Mode:** Autonomous (Claude decided from ROADMAP + CONCERNS §4/§1e + Phase 2/3 contracts; this is a needs-research phase — the researcher validates cloud-sync detection + the content/runtime split against real sync behavior)

<domain>
## Phase Boundary

Yulu stops duplicating what the host already provides (detect-first reuse via the Phase 3 tri-state report), AND the data folder can safely point at a cloud-sync root — with machine-local runtime/state PHYSICALLY isolated from syncable content so a sync engine can never corrupt a database or evict an in-use recording. Covers **REUSE-01/02, DATA-01/02/03**.

**Hard sequencing (in-phase):** DATA-02 (runtime-vs-content separation) MUST land BEFORE the DATA-01/03 folder picker is wired to cloud roots — users must never be able to put SQLite/sockets in a synced folder.

**Out of scope:** iCloud pinning robustness for in-use recordings (`com.apple.fileprovider.pinned` / File Provider API) = **v2 HARD-01** — Phase 5 only DETECTS-and-WARNS, does NOT pin. Migration of existing installs = Phase 7.

</domain>

<decisions>
## Implementation Decisions — all Claude's discretion (autonomous)

### Runtime-vs-Content Separation (DATA-02 — HARD PREREQUISITE, lands first)
- **D-01:** Physically separate two classes of state. **Machine-local runtime/state (NEVER syncable, NOT user-configurable to a synced folder):** the SQLite DBs (`vocab.sqlite`, `prompts.sqlite`, `search.sqlite`), Unix sockets (`*.sock`), locks/PIDs (`.recording_pid`, `*.pid`), `.state.json`, `schedule.json`, logs, the MLX/model caches. **Syncable content (the configurable data-folder):** recordings, transcripts, summaries, voicemails. PathResolver exposes `runtime_dir()` (locked machine-local) vs `data_dir()` (configurable). The runtime lock is enforced — a config that points runtime at a synced path is rejected.
- **D-06 [sequencing]:** D-01 ships before D-02/D-03 wire the picker to cloud roots.

### Configurable Data-Folder (DATA-01)
- **D-02:** A user can configure the data-folder (recordings/transcripts/summaries) location via the Phase 4 settings UI + PathResolver; the change takes effect across ALL daemons that read `output_dir` (SIGHUP or restart the relevant daemons — audio/transcribe/agentqueue/ui). The folder picker only ever moves CONTENT, never runtime/state.

### Cloud-Root Detect-and-Warn (DATA-03)
- **D-03:** When the chosen data-folder is a detected cloud-sync root (iCloud Drive `~/Library/Mobile Documents/` + `com.apple.fileprovider` xattr; Google Drive; Dropbox; OneDrive — path patterns + fileprovider attrs), Yulu DETECTS it and WARNS about the relevant risks (eviction of in-use recordings, DB corruption if runtime ever leaked there) BEFORE accepting it. Detect-and-warn, NOT block — the user may opt in knowing the risks. Surfaced in the Phase 4 folder picker.

### Detect-First Reuse (REUSE-01/02)
- **D-04:** When the Phase 3 tri-state report marks a host `whisper-cli` / model / `claude` / `gog` as **`usable`**, Yulu REUSES it and SKIPS installing its own. The tri-state (not a boolean) gates the decision — `usable` → reuse; `present-but-unverified` / `absent` → install Yulu's own.
- **D-05:** No unconditional `brew install whisper-cpp` (gate `setup_deps.sh` on the report); no duplicate MLX venv (Phase 1 already removed the venv — Phase 5 makes `setup_capabilities.sh` reuse-or-install conditional on the tri-state). Never silently mutate the host's package manager (Out-of-Scope anti-feature).

### Structure
- **D-07:** Extend the Phase 2 `PathResolver` with `runtime_dir()` (locked) vs `data_dir()` (configurable + cloud-detect); a cloud-root detection helper (`yulu_platform/macos/` or `capabilities/`); reuse gating folded into the Phase 1 `setup_deps.sh`/`setup_capabilities.sh`; folder-picker + cloud-warn in the Phase 4 settings UI pattern.
- **D-08 [scope guard]:** Phase 5 is detect-and-warn + reuse-gating + the physical split. NO pinning (v2), NO migration (Phase 7), NO CRDT/conflict engine (Out-of-Scope — folder sync is the OS's job).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/ROADMAP.md` §"Phase 5" — goal + 4 success criteria + the hard-sequencing note + the cloud-sync research flag
- `.planning/REQUIREMENTS.md` — REUSE-01/02, DATA-01/02/03

### Research targets (this is a needs-research phase)
- iCloud pinning vs File Provider API + **Sequoia's 10-item Finder pin cap** (research validates the eviction risk we warn about)
- Cloud-sync root detection: iCloud (`~/Library/Mobile Documents/`, `com.apple.fileprovider` xattr), Google Drive, Dropbox, OneDrive — reliable detection patterns
- The content/runtime split validated against real sync behavior (which `vocab`/`prompts`/`search` SQLite + WAL files must never sync)

### The contracts this phase consumes
- `yulu/scripts/yulu_platform/macos/path_resolver.py` — Phase 2; extend with runtime_dir/data_dir (currently `_DEFAULT_CONFIG_SUBDIR=.config/yulu`, `_DEFAULT_DATA_SUBDIR=Movies/Yulu`)
- `yulu/scripts/doctor.py` + `yulu/scripts/capabilities/` — Phase 3 tri-state report (reuse gating)
- `yulu/scripts/setup_deps.sh`, `yulu/scripts/setup_capabilities.sh` — Phase 1 decomposed scripts (gate brew/mlx on the report)

### Runtime/state inventory (must stay machine-local — read these to confirm)
- `.planning/codebase/STRUCTURE.md` §"Installed Artifact Locations" — the SQLite/socket/PID/state map
- `yulu/scripts/queue_store.py`, `state_store.py`, `recording_lock.py` (the runtime files); `vocab/db.py`, `prompts/db.py`, `search/indexer.py` (the SQLite DBs)
- `yulu/scripts/config.example.json` — `output` / data-folder config shape

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- PathResolver (Phase 2) ALREADY separates `config_dir` (~/.config/yulu — runtime) from `data_dir` (~/Movies/Yulu — content) — Phase 5 formalizes + LOCKS the runtime side and makes data side configurable + cloud-aware.
- The Phase 3 tri-state report is the reuse gate — `usable` vs not. DependencyManager (Phase 2) is the install seam to make conditional.
- The Phase 4 settings folder picker is where the cloud-warn surfaces.

### Established Patterns
- Daemons read paths via env (`YULU_CONFIG_DIR`/`YULU_OUTPUT_DIR`) — the data-folder change propagates by re-rendering plists / SIGHUP.
- stdlib-first; xattr detection via `subprocess(xattr)` or `os.getxattr`.

### Integration Points
- Runtime lock (D-01) is the safety foundation Phase 7 migration relies on (it moves data without ever moving runtime into a synced folder).
- Reuse gating touches the Phase 1 setup_*.sh — keep them idempotent + isolated.

</code_context>

<specifics>
## Specific Ideas
- Runtime/state (SQLite/sockets/locks/PIDs/logs) = machine-local, LOCKED, never configurable to a synced folder.
- Content (recordings/transcripts/summaries) = configurable data-folder, can be a cloud root.
- Cloud-root = DETECT-and-WARN (not block); user opts in knowing risks. No pinning (v2).
- Reuse gates on Phase 3 TRI-STATE `usable` — not a boolean.
- DATA-02 separation lands BEFORE the cloud-capable folder picker.

</specifics>

<deferred>
## Deferred Ideas
- iCloud pinning robustness for in-use recordings → v2 HARD-01.
- Migration of existing `~/.yulu` data layout → Phase 7.
- Backup-cleanup beyond migration → v2 HARD-03.

</deferred>

---

*Phase: 5-Capability Reuse + Data-Folder / Cloud-Sync Safety*
*Context gathered: 2026-05-30 (autonomous)*
