# Phase 1: Build Foundation — Setup Decomposition + Signed/Notarized Binaries - Context

**Gathered:** 2026-05-29
**Status:** Ready for planning

<domain>
## Phase Boundary

Decompose the 1,342-line monolithic `setup.sh` into per-concern, individually testable scripts (`set -uo pipefail`, idempotent, isolated re-run); ship Developer ID **signed + notarized** pre-built binaries so release installs need no `swiftc`/Xcode; publish CI Artifact Attestations (`gh attestation verify`); and stand up the `platform/base.py` abstraction skeleton. Covers **BUILD-01..04** + ROADMAP success criterion 5 (platform ABCs).

**Out of this phase:** actual macOS implementations of the platform seams (Phase 2), host-capability detection/report (Phase 3), the agent-orchestrated step-registry *caller* (Phase 6), skill-install decoupling (Phase 6 / PROV-05), migration (Phase 7). The decomposed scripts and the ABC skeleton are built here; their consumers come later.

</domain>

<decisions>
## Implementation Decisions

### Python Runtime Ownership — *discussed, user chose*
- **D-01:** daemon interpreter = **host system `python3`**. Yulu bundles NO Python runtime.
- **D-02:** Remove the dedicated `~/.config/yulu/venv-mlx-whisper` creation; the `stt_daemon` runs under the system `python3` launched by its plist (`__PYTHON__`).
- **D-03:** Fix the dead `mlx_python` config field (read but never used — CONCERNS §4a/§6e): drop it or make the daemon interpreter explicit. Full resolution of the interpreter ambiguity is Phase 3 (DETECT-04); Phase 1 just stops creating the venv and points at system `python3`.
- **D-04 [informational]:** Signing/notarization scope **excludes a Python runtime** — descriptive consequence of D-01 (host python), not a standalone task: the signing plans (01-03 / 01-06) sign only the Swift `.app` bundles, so "no Python in notarization scope" holds by construction.
- **D-05:** *How* `mlx-whisper` actually lands in the system `python3` (reuse-if-present vs install) is OUT of Phase 1's decision scope — it belongs to the decomposed `capabilities` script's contract + Phase 5 reuse. Phase 1 only fixes the interpreter *target*.

### Signing & Notarization — *mechanism user chose; recording strategy Claude decided*
- **D-06:** Notarization credential mechanism = **notarytool + App Store Connect API key** (`.p8` + Key ID + Issuer ID). `altool` is deprecated; API-key auth needs no Apple ID / 2FA and is independently revocable — best fit for CI.
- **D-07:** Signing = **Developer ID Application**, signed **bottom-up (NEVER `--deep`)**, then **notarized + stapled**. Replaces the current `--timestamp=none` + `xattr` quarantine-strip (CONCERNS §2c, BUILD-02).
- **D-08 [Claude discretion]:** Identity/credential recording strategy = **everything via CI secret + env**. Planning docs record only the *mechanism*: the signing identity is driven by the `YULU_CODESIGN_IDENTITY` env var; the certificate `.p12`, API key `.p8`, Key ID, and Issuer ID live exclusively in GitHub Actions secrets. No sensitive value is written into any planning doc — Lewis injects them at execution time. (Matches the intent of `YULU_CODESIGN_IDENTITY` and avoids secrets-in-docs.)
- **D-09:** Sign + notarize + staple happen in **CI** (`release-publish.yml` / `package.sh`); verified artifacts go into the release zip. The **release-please** mechanism stays unchanged (hard constraint).

### setup.sh Decomposition — *Claude decided (user delegated)*
- **D-10:** Decompose **by concern** into independent scripts, each with `set -uo pipefail`, idempotent, re-runnable in isolation (BUILD-01, success criterion 3).
- **D-11:** Suggested concern boundaries (planner refines exact split/names): `deps` (brew) · `audio` (TCC + binary placement) · `models` (whisper models) · `daemons` (launchd plist install + load) · `capabilities` (system-`python3` / `mlx-whisper` readiness + config generation) · `ui` (npm ci + build).
- **D-12:** Orchestration = keep a **thin top-level orchestrator** that calls each concern script in order, while every script stays independently invocable/re-runnable. Satisfies "isolated re-run" AND sets up the **Phase 6 step-registry 1:1 mapping** (each `setup_*.sh` → a `provision` step with a clean check/apply shape).
- **D-13:** **dev vs release fork**: release installs use pre-built signed+notarized binaries and **remove** `compile_audio_daemon()` / `compile_scanner()` from the release path; `--dev` keeps `swiftc` local compilation (CONCERNS §1d). Branch off install source (`.yulu-install.json` `source` field) / a `--dev` flag.
- **D-14:** Fold in low-risk fixes living in the touched scripts: move `install_plist` to module scope (CONCERNS §8c); replace the nvm-versioned node PATH baked into plists with a stable alias / homebrew node (CONCERNS §6b). The `pkill -9` / `open -W` graceful-stop fix (CONCERNS §2d/§8b) is primarily Phase 2/7 — Phase 1 must not regress it but does not own it.

### platform ABC Scope — *Claude decided (user delegated)*
- **D-15:** Phase 1 defines the **full set of Python-side platform seam ABCs** in `platform/base.py` as **interface signatures only** (abstract methods + types, no implementation), with `linux/` and `windows/` arms raising `NotImplementedError` (success criterion 5).
- **D-16:** The 4 Python-side ABCs: **PathResolver** · **DaemonManager** (`ServiceSpec` + install/load/unload/status) · **PermissionModel** · **DependencyManager** — signatures grounded in REQUIREMENTS PLAT-03/04/05.
- **D-17:** The **Swift `CaptureBackend`** seam (PLAT-01/02) and **all macOS implementations** are **Phase 2**, not Phase 1. `platform/base.py` is Python-only.
- **D-18:** Interfaces carry **NO leaked macOS vocabulary** (no plist keys / `SCStreamConfiguration` / TCC scopes in signatures) — a Phase 2 success criterion the Phase 1 interface design already honors. Phase 2 may refine signatures when implementing.

### Claude's Discretion
Per Lewis's instruction ("后面全部你决定吧… 跳过讨论… 直接进入 plan"), **D-08 and all of D-10..D-18** were decided by Claude using the locked project principles (host-first, reuse-not-duplicate, secrets-never-in-docs, build-the-abstraction-now, keep release-please) plus ROADMAP/CONCERNS guidance. The planner has latitude on exact script names, ABC method signatures, and file layout — the decisions above fix *intent and boundaries*, not the literal code.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/ROADMAP.md` §"Phase 1: Build Foundation" — goal + 5 success criteria + the bundled-vs-host Python "Decision to log" + the Developer ID prerequisite note (resolved 2026-05-29)
- `.planning/REQUIREMENTS.md` — **BUILD-01..04** (this phase) and **PLAT-01..05** (the seam descriptions the Phase 1 ABCs are grounded in)

### Fragilities this phase fixes / must respect (authoritative bug list with file:line + fix approaches)
- `.planning/codebase/CONCERNS.md` — §1d (swiftc-at-install), §2a (monolithic setup.sh), §2c (unsigned / `--timestamp=none`), §4a + §6e (dead `mlx_python` / venv), §6b (nvm node PATH), §6c (legacy path), §8c (`install_plist` duplication), §8a (`external_attr` exec bits), §8b (`open -W`)
- `.planning/codebase/STACK.md` — §"Release / Packaging Toolchain", §"Bundled vs Downloaded vs Brew-installed", §"CI (.github/workflows/ci.yml)" — the release pipeline Phase 1 modifies
- `.planning/codebase/STRUCTURE.md` — §"Directory Layout", §"Special Directories" (committed binaries, `packaging/`)

### Source files the planner will touch (read before editing)
- `yulu/scripts/setup.sh` — the monolith to decompose
- `install.sh` — curl|bash entry; drop the Xcode pre-flight for the release path
- `yulu/scripts/build_audio_daemon.sh`, `yulu/scripts/build_status_agent.sh` — codesign lines to fix (`--deep` / `--timestamp=none`)
- `packaging/scripts/package.sh`, `packaging/scripts/checksums.sh` — where sign+notarize+staple+attestation hook in
- `.github/workflows/release-publish.yml`, `release.yml`, `release-please.yml`, `ci.yml` — add notarytool + `gh attestation`
- `yulu/scripts/dev_install.py` — the `--dev` compile path that must stay
- `yulu/scripts/com.yulu.*.plist` — plist templates (node PATH, `__PYTHON__`)
- *(new)* `yulu/scripts/platform/base.py` + `platform/linux/`, `platform/windows/` — to create

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `build_audio_daemon.sh` / `build_status_agent.sh` already do `swiftc` + `codesign` — **refactor** the codesign invocation (drop `--deep`/`--timestamp=none`, add notarize+staple), don't rewrite.
- `packaging/scripts/package.sh` already stages + zips with reproducible timestamps and restores exec bits — **extend** with sign/notarize/attest steps.
- `packaging/scripts/checksums.sh` already emits SHA-256 — attestation is additive.
- `release-publish.yml` is a reusable workflow on `macos-latest` already running the full test suite + `make package` — the notarytool + `gh attestation` steps slot in here.
- `.yulu-install.json` `source` field already exists — reuse it to branch dev vs release in setup.

### Established Patterns
- Scripts use bash with placeholder substitution (`__SCRIPT_DIR__`, `__PYTHON__`, `__NODE_BIN__`) in plists — the decomposition keeps this token pattern.
- launchd plists are the only daemon manager today — `platform/base.py`'s `DaemonManager` ABC abstracts this; Phase 1 defines the interface only, Phase 2 wraps `launchctl`.
- Python is stdlib-first — `platform/base.py` should use `abc.ABC` + `typing` only, no new deps.

### Integration Points
- The decomposed `setup_*.sh` scripts are the seam Phase 6's `yulu provision <step>` registry binds to **1:1** — keep each concern script's check/apply shape clean.
- `platform/base.py` is the import target Phase 2 (macOS impls), Phase 3 (`PathResolver` consumer), and Phase 5/7 bind to — get the package layout right (`platform/{base,macos,linux,windows}`).
- `record_audio.py` ↔ Swift `CaptureBackend` boundary is where Phase 2's capture seam meets Python — out of Phase 1, but the ABC package should leave room for it.

</code_context>

<specifics>
## Specific Ideas
- **notarytool** (not `altool`), **App Store Connect API key** auth — explicit.
- Signing **bottom-up, never `--deep`** — explicit anti-pattern to avoid (CONCERNS §2c, BUILD-02).
- `YULU_CODESIGN_IDENTITY` is the env var name that drives the signing identity; the exact identity / Team ID + all credentials are injected via GitHub Actions secrets at execution time, never committed.

</specifics>

<deferred>
## Deferred Ideas
None new — discussion stayed within phase scope. Adjacent fragilities in CONCERNS.md are already mapped to later phases by ROADMAP/REQUIREMENTS: `curl|bash` signature verification (§2b) → Phase 6 attestation gate; backup cleanup (§2e) → Phase 7 migration backup lifecycle; `open -W` daemon-stop (§8b) → Phase 2; security items §7a/§7b/§7c → v2 HARD. No action needed here.

</deferred>

---

*Phase: 1-Build Foundation — Setup Decomposition + Signed/Notarized Binaries*
*Context gathered: 2026-05-29*
