# Requirements: Yulu — v0.6 Speaker Diarization

**Defined:** 2026-05-29 (v0.5) · 2026-06-06 (v0.6)
**Core Value:** A meeting becomes a clean, searchable note entirely on the user's machine, through the agent they already trust — capture and transcription never depend on the cloud, and Yulu never makes the user reconfigure what their agent already provides.

## v0.6 Requirements — Speaker Diarization (current milestone)

Grounded in spikes 001/002 and `.planning/research/SUMMARY.md`. Each maps to exactly one roadmap phase (Traceability filled by the roadmapper). **Reframe:** Yulu already emits a 2-speaker transcript (mic=我 / system=对方 via `transcript_merge.py`); v0.6 generalizes that to N voice-clustered speakers, mainly by splitting the far-end/system stream.

### Diarization Engine & Provisioning (DIAR)

- [x] **DIAR-01**: A `DiarizeBackend` Protocol (audio → speaker turns w/ timestamps), config-selected, mirrors the STT backend lifecycle (`warm_up`/`is_ready`/`release`); NOT added to the ASR fallback dict and NOT a `CapabilityProvider` subclass (diarization is Yulu-managed, not agent-reused)
- [x] **DIAR-02**: Default backend is **sherpa-onnx** (ONNX Runtime, no torch): pyannote-3.0 segmentation + 3D-Speaker cam++ embedding
- [x] **DIAR-03**: Diarization models (seg ~5.7 MB + cam++ ~27 MB ONNX) provision via the existing idempotent `models` step and load **offline by default**
- [x] **DIAR-04**: `doctor.py` gains a tri-state `probe_diarization()` (provenance `yulu-managed`) in the `HostCapabilityReport`
- [x] **DIAR-05**: A `warm_up()` dummy pass amortizes first-run cold-start before the first real meeting

### Speaker–Transcript Merge (MERGE)

- [ ] **MERGE-01**: A pure, I/O-free `speaker_merge` module assigns each ASR segment a speaker by max timestamp-overlap, fixture-testable without sherpa/daemon/SQLite
- [ ] **MERGE-02**: A coverage-gap fallback handles the ~10 % of ASR segments with no overlapping diarization turn (nearest/previous speaker; never snap across a speaker boundary)
- [ ] **MERGE-03**: Merge VAD-gates + filters whisper hallucination/repeat so a fake line is never laundered into a confident wrong-owner attribution; uncertain segments carry a confidence flag downstream
- [ ] **MERGE-04**: Speaker data persists in a `<stem>.speakers.json` sidecar (turns + assignments + editable `speaker_id`→`display_name`), travelling with `data_dir`; runtime SQLite is never source-of-truth and never synced
- [ ] **MERGE-05**: Re-diarize is idempotent — it re-anchors volatile cluster indices to existing stable `speaker_id`s by overlap and never clobbers user renames

### Speaker Count (COUNT)

- [ ] **COUNT-01**: Speaker-count strategy uses the calendar-attendee count (via existing `gog`) as a prior when available, before threshold-based auto-clustering
- [ ] **COUNT-02**: A CN-calibrated clustering threshold mitigates sherpa's over-split on Chinese meetings (spike 002: 59→32→20, never reaching the true ~5)
- [ ] **COUNT-03**: When uncertain, clustering fails toward UNDER-merge (user-recoverable) rather than over-split

### Evaluation (EVAL)

- [ ] **EVAL-01**: A reference corpus of 2–3 real CN+EN meetings is labelled (RTTM) without anchoring bias (labels not derived from a tool's own output)
- [ ] **EVAL-02**: A DER/WDER harness (torch-free `pyannote.metrics`, dev/eval venv only) reports DER with explicit collar + overlap-scoring policy plus a short-utterance-sensitive metric
- [ ] **EVAL-03**: The eval result is the GATE that picks the default provider (sherpa-onnx vs optional FunASR) on evidence
- [ ] **EVAL-04**: UI accuracy copy is set from the measured DER (labels presented as a correctable hint, not ground truth)

### Speaker UI & Summary (SPKUI)

- [ ] **SPKUI-01**: Transcript renders per-speaker blocks with color-coding + click-to-seek, on one canonical line format reconciled with the existing `TranscriptView` parser
- [ ] **SPKUI-02**: The local user ("You"/我) is auto-known from the mic channel without manual labelling
- [ ] **SPKUI-03**: User can rename a speaker once, apply everywhere, and persist (sidecar `display_name`), surviving re-diarize
- [ ] **SPKUI-04**: User can merge two speaker labels and correct a single segment's speaker
- [x] **SPKUI-05**: Speaker-attributed transcript flows into the agent-queue summary (one additive prompt-var pair) so the agent attributes action items to owners; speaker-aware export
- [x] **SPKUI-06**: Speaker labels never auto-rewrite the `.transcript.txt` cleanup output (sidecar is source of truth)

### Portability & Footprint (PORT)

- [ ] **PORT-01**: sherpa-onnx wheels + ONNX models verified behind the platform abstraction with no macOS coupling (macOS impl now; non-macOS verified/stubbed per v0.5 pattern; Python 3.14 wheel resolution confirmed or isolated venv used)
- [ ] **PORT-02**: Added per-meeting wall-clock + peak RAM measured (20-min / 1h / long) against a regression budget so diarization doesn't degrade the existing pipeline
- [ ] **PORT-03**: Existing installs gain diarization on upgrade via the existing `yulu migrate` path with no data loss

## Shipped — v0.5 (Agent-Native Provisioning & Cross-Platform Foundation)

Shipped 2026-05-30 (8 phases, all complete). Kept for traceability; see git history + PROJECT.md.

### Build & Signing (BUILD)

- [x] **BUILD-01**: The monolithic `setup.sh` is decomposed into per-concern scripts with `set -uo pipefail`, so any failing step is visible and individually testable
- [x] **BUILD-02**: macOS binaries are Developer ID signed (bottom-up, never `--deep`) and notarized + stapled, replacing the `--timestamp=none` + `xattr` quarantine-strip
- [x] **BUILD-03**: Release installs ship pre-built signed binaries and no longer require `swiftc`/Xcode on the user's machine
- [x] **BUILD-04**: CI publishes GitHub Artifact Attestations for release assets so integrity is verifiable via `gh attestation verify`

### Platform Abstraction (PLAT)

- [x] **PLAT-01**: A `CaptureBackend` interface ("PCM frames + source list") exists with a macOS implementation; Linux/Windows are `NotImplementedError` stubs
- [x] **PLAT-02**: macOS system-audio capture uses Core Audio process taps on 14.4+, with a ScreenCaptureKit fallback arm behind the same seam (`if #available`)
- [x] **PLAT-03**: A `DaemonManager` interface (`ServiceSpec` + install/load/unload/status) wraps launchd; the audio daemon launches directly (no `open -W` orphan) so `stop()` leaves zero processes
- [x] **PLAT-04**: A `PathResolver` removes hardcoded `~/Movies/Yulu` / `~/.config/yulu` (including fixing `status_agent.swift` to read `config.json`)
- [x] **PLAT-05**: `PermissionModel` and `DependencyManager` interfaces exist with macOS implementations; TCC calls are gated behind a Darwin check

### Capability Detection (DETECT)

- [x] **DETECT-01**: `doctor.py` produces a versioned `HostCapabilityReport` JSON with per-capability provenance (host-path / yulu-managed / agent-config / absent) and tri-state status (usable / present-but-unverified / absent)
- [x] **DETECT-02**: Capability probes resolve binaries via the login-shell PATH (not bare `shutil.which`) and Python importability via the daemon's own interpreter
- [x] **DETECT-03**: `doctor` probes `claude` CLI, `whisper-cli`, `mlx-whisper` importability, configured `llm.command` validity, model paths/sizes, and recording-dir writability
- [x] **DETECT-04**: The `mlx_python` interpreter ambiguity is resolved so "usable" reflects what the daemon can actually import
- [x] **DETECT-05**: A `CapabilityProvider` interface exists with a ClaudeCode implementation working end-to-end

### Settings & Onboarding (SET)

- [x] **SET-01**: A `host_capabilities` tRPC endpoint serves the doctor report to the web UI
- [x] **SET-02**: The settings page shows each capability's provenance ("reused from your PATH" vs "Yulu-managed") with the resolved path
- [x] **SET-03**: A skippable browser first-run onboarding walkthrough shows live permission status
- [x] **SET-04**: A model selector lets the user choose among detected models across host caches

### Transcription Modes (TRANS)

- [x] **TRANS-01**: User can set transcription mode to local (default), cloud-fallback, or cloud-priority
- [x] **TRANS-02**: Cloud transcription uses the user's own configured command (same trust model as `llm.command`); Yulu holds no cloud keys

### Data Folder & Cloud Sync (DATA)

- [x] **DATA-01**: User can configure the data folder (recordings/transcripts/summaries) location
- [x] **DATA-02**: Runtime/state (SQLite DBs, sockets, locks, PIDs) is physically separated from syncable content and never placed in a synced folder
- [x] **DATA-03**: When the data folder points at a detected cloud-sync root (iCloud / Google Drive…), Yulu detects it and warns about the relevant risks

### Capability Reuse (REUSE)

- [x] **REUSE-01**: When a *usable* host whisper / model / `claude` / `gog` is detected, Yulu reuses it instead of installing its own
- [x] **REUSE-02**: Yulu no longer unconditionally `brew install`s whisper-cpp or creates a duplicate MLX venv when the host already provides them

### Agent-Orchestrated Provisioning (PROV)

- [x] **PROV-01**: Provisioning is a registry of named, idempotent steps (`check`/`apply` → `StepResult`), invocable via `yulu provision <step>`
- [x] **PROV-02**: A spike validates agent-orchestrated provisioning (who calls the steps), with partial-failure/resume and tampered-asset rejection as explicit exit criteria
- [x] **PROV-03**: Provisioning verifies asset integrity (`gh attestation verify`) before execution; the signed-zip path remains a non-negotiable fallback
- [x] **PROV-04**: Provisioning is resumable via a per-step state file (`.yulu-install.json`)
- [x] **PROV-05**: `yulu skill install [--agent]` installs/updates the agent skill independently of core install (idempotent), decoupled from `setup.sh`

### Seamless Migration (MIG)

- [x] **MIG-01**: On upgrade, an existing v0.5.x `~/.yulu` install is detected and migrated (detect→plan→apply→verify) with no data loss and no reconfiguration
- [x] **MIG-02**: Migration guards against active recordings before stopping any daemon (no `pkill -9` truncation)
- [x] **MIG-03**: Migration is transactional with `yulu rollback`; backups are pruned only after verified success

### Multi-Agent Providers (AGENT)

- [x] **AGENT-01**: A `CodexProvider` implements the capability-provider contract
- [x] **AGENT-02**: An `OpenClawProvider` implements the capability-provider contract

## v2 Requirements

Deferred to a future milestone. Tracked but not in this roadmap.

### Cross-Platform Runtime (XPLAT)

- **XPLAT-01**: Linux runtime implementation of the platform seams (PipeWire capture, systemd daemons)
- **XPLAT-02**: Windows runtime implementation of the platform seams (WASAPI loopback, Task Scheduler/service)

### Hardening (HARD)

- **HARD-01**: iCloud pinning robustness for in-use recordings (`com.apple.fileprovider.pinned` / File Provider API)
- **HARD-02**: Installer signature `--verify` hardening beyond attestation
- **HARD-03**: Backup-cleanup policy beyond migration's own lifecycle (`yulu cleanup-backups`)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep. Anti-features from research.

| Feature | Reason |
|---------|--------|
| Yulu-hosted cloud sync / backup service | Violates local-first; cloud sync is delegated to the user's own folder sync (iCloud/Drive) |
| Accounts / multi-user / teams | Yulu is local-first and single-user |
| Drag-to-`/Applications` `.app` as THE install model | Over-fits macOS; superseded by agent-orchestrated provisioning |
| Yulu-held cloud API keys | User brings their own cloud command; no keys held by Yulu |
| Forced, unskippable onboarding | Onboarding must be skippable |
| Auto-installing Homebrew without consent | Reuse-first; never silently mutate the host's package manager |
| A second Yulu-specific venv when the host already has one | Directly contradicts the reuse goal |
| Custom CRDT / sync-conflict engine | Folder sync is the OS's job; no conflict engine |
| Actual Windows/Linux implementations (this milestone) | Architecture is abstracted now; implementations deferred to a future milestone |
| **Cross-meeting speaker persistence / voiceprint enrollment** (v0.6) | That is speaker *identification*, not diarization — heavier + biometric-privacy-laden; v0.6 stays anonymous per-meeting + manual labels |
| **Cloud voiceprint / speaker-ID services** (v0.6) | Speaker embeddings are biometric; must stay on-device, never leak via cloud-sync or the agent→cloud-LLM boundary |
| **Live / streaming diarization** (v0.6) | Post-process only this milestone; real-time is a later concern |
| **Word-level speaker boundaries** (v0.6) | Segment-level is sufficient; word-level adds cost without product value now |
| **Per-speaker isolated audio export / team speaker directory** (v0.6) | Out of scope for a local-first single-user app this milestone |

## Traceability

Each v1 requirement maps to exactly one phase. See `.planning/ROADMAP.md` for phase goals and success criteria.

### v0.5 (Phases 1–8 — shipped)

| Requirement | Phase | Status |
|-------------|-------|--------|
| BUILD-01 | Phase 1 | Complete |
| BUILD-02 | Phase 1 | Complete |
| BUILD-03 | Phase 1 | Complete |
| BUILD-04 | Phase 1 | Complete |
| PLAT-01 | Phase 2 | Complete |
| PLAT-02 | Phase 2 | Complete |
| PLAT-03 | Phase 2 | Complete |
| PLAT-04 | Phase 2 | Complete |
| PLAT-05 | Phase 2 | Complete |
| DETECT-01 | Phase 3 | Complete |
| DETECT-02 | Phase 3 | Complete |
| DETECT-03 | Phase 3 | Complete |
| DETECT-04 | Phase 3 | Complete |
| DETECT-05 | Phase 3 | Complete |
| SET-01 | Phase 4 | Complete |
| SET-02 | Phase 4 | Complete |
| SET-03 | Phase 4 | Complete |
| SET-04 | Phase 4 | Complete |
| TRANS-01 | Phase 4 | Complete |
| TRANS-02 | Phase 4 | Complete |
| REUSE-01 | Phase 5 | Complete |
| REUSE-02 | Phase 5 | Complete |
| DATA-01 | Phase 5 | Complete |
| DATA-02 | Phase 5 | Complete |
| DATA-03 | Phase 5 | Complete |
| PROV-01 | Phase 6 | Complete |
| PROV-02 | Phase 6 | Complete |
| PROV-03 | Phase 6 | Complete |
| PROV-04 | Phase 6 | Complete |
| PROV-05 | Phase 6 | Complete |
| MIG-01 | Phase 7 | Complete |
| MIG-02 | Phase 7 | Complete |
| MIG-03 | Phase 7 | Complete |
| AGENT-01 | Phase 8 | Complete |
| AGENT-02 | Phase 8 | Complete |

### v0.6 (Phases 9–15 — current milestone)

| Requirement | Phase | Status |
|-------------|-------|--------|
| MERGE-01 | Phase 9 | Pending |
| MERGE-02 | Phase 9 | Pending |
| MERGE-03 | Phase 9 | Pending |
| MERGE-04 | Phase 9 | Pending |
| MERGE-05 | Phase 9 | Pending |
| DIAR-01 | Phase 10 | Complete |
| DIAR-02 | Phase 10 | Complete |
| DIAR-03 | Phase 10 | Complete |
| DIAR-04 | Phase 10 | Complete |
| DIAR-05 | Phase 10 | Complete |
| EVAL-01 | Phase 11 | Pending |
| EVAL-02 | Phase 11 | Pending |
| EVAL-03 | Phase 11 | Pending |
| EVAL-04 | Phase 11 | Pending |
| COUNT-01 | Phase 12 | Pending |
| COUNT-02 | Phase 12 | Pending |
| COUNT-03 | Phase 12 | Pending |
| SPKUI-05 | Phase 13 | Complete |
| SPKUI-06 | Phase 13 | Complete |
| SPKUI-01 | Phase 14 | Pending |
| SPKUI-02 | Phase 14 | Pending |
| SPKUI-03 | Phase 14 | Pending |
| SPKUI-04 | Phase 14 | Pending |
| PORT-01 | Phase 15 | Pending |
| PORT-02 | Phase 15 | Pending |
| PORT-03 | Phase 15 | Pending |

**Coverage:**

*v0.5 (shipped):*
- v1 requirements: 35 total (the enumerated checkbox list sums to 35; the original "33 total" prose was a miscount — all 10 categories are fully mapped)
- Mapped to phases: 35 (BUILD 4 → P1 · PLAT 5 → P2 · DETECT 5 → P3 · SET 4 + TRANS 2 → P4 · REUSE 2 + DATA 3 → P5 · PROV 5 → P6 · MIG 3 → P7 · AGENT 2 → P8)
- Unmapped: 0 ✓

*v0.6 (current):*
- v0.6 requirements: 26 total (DIAR 5 · MERGE 5 · COUNT 3 · EVAL 4 · SPKUI 6 · PORT 3)
- Mapped to phases: 26 (MERGE 5 → P9 · DIAR 5 → P10 · EVAL 4 → P11 · COUNT 3 → P12 · SPKUI-05/06 2 → P13 · SPKUI-01/02/03/04 4 → P14 · PORT 3 → P15)
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-29 (v0.5)*
*Last updated: 2026-06-06 — v0.6 roadmap created; traceability filled (26 reqs → Phases 9–15, 100% coverage)*
