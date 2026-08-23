# Phase 9: Release Safety - Research

**Researched:** 2026-08-23  
**Domain:** macOS release packaging, transactional install/update safety, optional-dependency boundaries  
**Confidence:** HIGH

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DIST-01 | A user can install the latest stable release from a version-paired installer that does not execute the repository's moving `main` setup code | The release workflow already publishes `install.sh`, and `package.sh` already embeds the exact same-release `release_installer.py`; the missing link is routing stable bootstrap traffic to that Release asset and pinning the selected tag. [VERIFIED: codebase — `install.sh:18-21,179-209`; `packaging/scripts/package.sh:196-199,226-247`; `.github/workflows/release-publish.yml:199-267`] |
| DIST-02 | A release artifact advertised for macOS 13+ is built with a macOS 13 deployment target and rejected by CI when its Mach-O minimum OS is higher | Both Swift build scripts omit `-target`; all five currently shipped Mach-O binaries report `minos 26.0`. Compiling the same sources with `-target arm64-apple-macosx13.0` succeeds and emits `minos 13.0`; a final-artifact `xcrun vtool -show-build` gate is therefore sufficient and necessary. [VERIFIED: codebase + local compile/vtool probe — `build_audio_daemon.sh:20-28`; `build_status_agent.sh:21-26`] |
| DIST-03 | An install or update refuses to stop daemons while a recording is active and leaves the recording intact | Phase 7 already provides the canonical status-socket predicate and proves zero unloads on refusal. `release_installer.py` currently reaches runtime replacement and setup without calling it. Reuse the predicate before runtime mutation and before setup can stop daemons. [VERIFIED: codebase — `migrate/guard.py:49-97,100-148`; `release_installer.py:1003-1039,1114-1161,1292-1313`; `tests/test_migrate_recording_guard.py:128-175`] |
| DIST-04 | A user can complete core installation without Hermes, OpenClaw, calendar tooling, or an automatic Homebrew installation | `setup.sh` currently auto-runs Homebrew's remote installer, `setup_deps.sh` unconditionally installs `gog`/`cloudflared`, `_deps_ready()` requires them, and setup aborts when Hermes registration fails. Each blocker has an existing optional/non-fatal seam to reuse. [VERIFIED: codebase — `setup.sh:125-169,269-383,659-669`; `setup_deps.sh:37-105`; `provision/registry.py:214-224`; `setup_daemons.sh:144-160`] |
</phase_requirements>

## Summary

Phase 9 is a wiring and release-gate phase, not an installer rewrite. The repository already produces the correct immutable unit: every GitHub Release contains a `dist/install.sh` whose embedded Python payload is byte-for-byte the `release_installer.py` from that release, and the workflow uploads and re-download-compares `install.sh`, the runtime zip, and `checksums.txt` before publication. The public bootstrap still bypasses that unit by downloading the helper from `raw/main`; stable install must instead enter through the Release-owned installer. [VERIFIED: codebase — `packaging/scripts/package.sh:226-247`; `tests/test_package_release.py:408-424`; `.github/workflows/release-publish.yml:199-267`]

The current macOS-compatibility failure has a direct root cause: local `swiftc` defaults to target `arm64-apple-macosx26.0`, while neither build script supplies a target triple. Consequently all five shipped executables currently encode `minos 26.0`. A local compile probe of those five sources with `-target arm64-apple-macosx13.0` succeeded and every resulting binary encoded `minos 13.0`; no Swift source redesign is required because newer audio APIs are already availability-gated. [VERIFIED: local probe 2026-08-23; codebase — `audio_daemon.swift:1249,1979`; `status_agent.swift:2374`]

Recording and onboarding safety likewise have existing seams. Phase 7's `migrate.guard.recording_active()` is the one authoritative status-socket predicate; installer code should import and reuse it rather than inspect a PID or the short-lived recording-start lock. Phase 1/6 already decomposed setup into idempotent concerns and made skill installation non-fatal; Phase 9 only needs to make Agent registration best-effort, remove calendar tools from the core dependency postcondition, and make Homebrew detection read-only. [VERIFIED: codebase + completed phase documents — `migrate/guard.py:70-97`; `06-04-SUMMARY.md:64-78`; `setup_daemons.sh:144-160`]

**Primary recommendation:** implement three narrow plans: (1) Release-owned installer entry plus the shared active-recording admission guard, (2) explicit macOS 13 Swift targets plus one reusable `vtool` gate over the exact shipped binaries, and (3) core-vs-optional setup separation. Add no new language package and do not pull Phase 10 provider behavior or Phase 13 onboarding/docs work into this phase.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Stable installer selection and version pairing | Bootstrap / GitHub Release | Packaging | The source bootstrap only selects an immutable Release `install.sh`; that asset owns the exact embedded helper and tag. GitHub documents direct latest-asset links at `/releases/latest/download/<asset>`. [CITED: https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases] |
| Runtime zip resolution, checksum, staging, rollback | Installer transaction | GitHub Release API | These responsibilities already live in `release_installer.py` and must remain there. [VERIFIED: codebase — `release_installer.py:143-255,724-747,1114-1203`] |
| macOS deployment target | Swift build scripts | CI artifact validation | Compiler flags create the load command; CI verifies the final packaged bytes rather than trusting source text. [VERIFIED: codebase — `.github/workflows/release-publish.yml:127-160`] |
| Active-recording refusal | Installer transaction | Native audio-daemon status socket | The installer decides whether it may mutate/stop; the daemon remains the authority on whether recording is active. [VERIFIED: codebase — `migrate/guard.py:70-97`; `record_audio.py:292-294`] |
| Core dependency readiness | Setup concern / provision registry | Setup orchestrator | `setup_deps.sh` owns installation and postconditions; `_deps_ready()` must describe the same core-only postcondition. [VERIFIED: codebase — `setup_deps.sh:23-105`; `provision/registry.py:214-224`] |
| Agent and calendar activation | Later activation surfaces | Setup best-effort hooks | Phase 9 removes these as blockers but does not select providers, perform calendar onboarding, or add UI. [VERIFIED: scope — `ROADMAP.md:251-281`; `REQUIREMENTS.md:23-49`] |

## Project Constraints

- Complex work must be planned and discussed before implementation; changes must be surgical, goal-driven, and verified. [VERIFIED: session-provided AGENTS instructions]
- No repository `AGENTS.md` exists. `CLAUDE.md` is the configured project-instruction file. [VERIFIED: filesystem + `.planning/config.json:11`]
- macOS 13+ remains the shipped floor; do not raise it to 14.4 because the capture implementation already keeps the ScreenCaptureKit arm for 13–14.3 and the process-tap arm for 14.4+. [VERIFIED: `PROJECT.md:64-70,86`; `CLAUDE.md:29-40`; `audio_daemon.swift:1166-1169,1249,1979`]
- Release users must not need `swiftc`/Xcode; compilation remains dev/CI-only. [VERIFIED: Phase 1 verification — `01-VERIFICATION.md`, SC-1 / BUILD-03; `tests/test_release_no_swiftc.py`]
- Preserve release-please, GitHub Releases, Conventional Commits, the existing checksum/attestation/signing pipeline, and the transactional installer. [VERIFIED: `PROJECT.md:64-71`; `release-publish.yml:116-170,199-280`]
- Keep credentials out of `config.json` and logs; this phase adds no credential storage or provider authentication. [VERIFIED: `CLAUDE.md:143-152`; `REQUIREMENTS.md:28-29,68-69`]
- Do not implement Phase 10 independent provider selection/xAI summary/conversation, Phase 11 activation UI, Phase 12 OAuth/gateway connections, or Phase 13 calendar/share/docs coherence here. [VERIFIED: `ROADMAP.md:26-30,251-329`; `REQUIREMENTS.md:23-54`]

## Standard Stack

No new third-party package is needed.

### Core

| Tool / Module | Version / Contract | Purpose | Why Standard Here |
|---------------|--------------------|---------|-------------------|
| Bash | Existing repo scripts; `set -euo pipefail` or established concern-script `set -uo pipefail` | Bootstrap, build flags, setup, CI gates | Matches `install.sh`, `package.sh`, `checksums.sh`, and the decomposed setup concerns. [VERIFIED: codebase] |
| Python stdlib | Project floor Python 3.10+; local 3.14.6 | Existing release transaction and import of recording guard | `release_installer.py` already owns download, validation, backup, rollback, and errors; adding a second installer would duplicate its highest-risk behavior. [VERIFIED: `install.sh:136-144`; local `python3 --version`] |
| Apple `swiftc` | Local Apple Swift 6.3.3; explicit target `arm64-apple-macosx13.0` | Build all shipped native executables | The missing target flag is the root cause. Apple documents macOS deployment targets independently of the installed SDK. [VERIFIED: local `swiftc --version`; CITED: https://developer.apple.com/xcode/system-requirements] |
| Apple `xcrun vtool` | Xcode/CLT native tool; `-show-build` | Read Mach-O platform, `minos`, and SDK from final artifacts | Native inspection avoids hand-parsing Mach-O load commands. [VERIFIED: local `xcrun vtool -help` and artifact probes] |
| pytest | Existing suite; local 9.0.3 | Installer, packaging, setup, and guard regression tests | Existing tests already provide hermetic subprocess/PATH-shim patterns. [VERIFIED: `tests/test_package_release.py`; `tests/test_setup_decomposition.py`; local `pytest --version`] |

### Supporting

| Tool | Purpose | When to Use |
|------|---------|-------------|
| GitHub Actions macOS runner | Compile, sign/notarize, package, extract, and reject incompatible artifacts | Every PR for source compilation; every release for authoritative final-zip gating. [VERIFIED: `.github/workflows/ci.yml:109-123`; `.github/workflows/release-publish.yml:116-170`] |
| `shasum`, codesign, stapler, runtime manifest validation | Existing integrity and platform-trust gates | Preserve unchanged around the new `vtool` gate. [VERIFIED: `.github/workflows/release-publish.yml:127-170`] |
| `shellcheck` | Shell static validation | Every touched shell script; local version 0.11.0 is available. [VERIFIED: local environment + Phase 1 CI gate] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff / Decision |
|------------|-----------|---------------------|
| Release-owned `install.sh` | Continue downloading `release_installer.py` from `raw/main` | Rejected: executes moving bootstrap logic and breaks version pairing. [VERIFIED: `install.sh:18,185-209`] |
| `xcrun vtool -show-build` | Python Mach-O parser or `otool` text heuristics | Rejected: more code and more binary-format edge cases; `vtool` exposes `minos` directly. [VERIFIED: local `vtool -help`] |
| Reuse `migrate.guard.recording_active` | PID lookup, `.recording.lock`, or new socket JSON code | Rejected: Phase 7 proved the daemon socket is the sole arbiter; the lock only covers the start handshake. [VERIFIED: `migrate/guard.py:10-15,70-97`; `recording_lock.py:101-108`] |
| New optional-dependency registry | Reuse `YULU_INSTALL_CALENDAR` and current provision registry | Rejected for Phase 9: a second registry expands scope; Phase 13 owns the optional-capability UX. [VERIFIED: `setup_daemons.sh:144-160`; `ROADMAP.md:309-329`] |

**Installation:** none. Do not add npm, PyPI, Homebrew formula, Swift package, or GitHub Action dependencies for this phase.

## Package Legitimacy Audit

Not applicable. The recommended implementation installs no new external package. Existing Homebrew formula behavior is reduced, not expanded; the new artifact validator uses Apple tooling already present on the macOS build/signing runner.

## Architecture Patterns

### System Architecture Diagram

```text
Stable public bootstrap
        |
        | latest / explicit tag
        v
GitHub Release install.sh  <----- package.sh embeds same-release helper (+ pins tag)
        |
        v
embedded release_installer.py
        |
        +--> resolve tag-matched zip + checksums
        +--> verify checksum / signatures / runtime manifest
        +--> stage runtime
        |
        v
active-recording guard? ---- yes ----> REFUSE; no runtime swap; no daemon stop
        |
        no
        v
atomic runtime replacement -> setup core -> existing rollback on failure
                                      |
                                      +--> Agents: detected-only / non-fatal
                                      +--> Calendar: deferred unless explicitly opted in

Swift sources
   | swiftc -target arm64-apple-macosx13.0
   v
signed + notarized native binaries
   | package zip -> extract exact release runtime
   v
xcrun vtool gate (all shipped binaries minos == 13.0)
   | pass                              | fail
   v                                   v
attest/upload/publish                 release job stops while draft
```

### Recommended Project Structure

```text
install.sh                                      # raw bootstrap + packaged Release installer modes
packaging/scripts/
├── package.sh                                  # existing helper embedding; inject/verify tag if used
└── check_macos_deployment_target.sh            # one new native-tool validator
yulu/scripts/
├── build_audio_daemon.sh                       # explicit target on audio_daemon + xai_keychain
├── build_status_agent.sh                       # explicit target on status_agent + 2 helpers
├── release_installer.py                        # shared recording-safe transaction
├── migrate/guard.py                            # reuse; do not reimplement
├── setup.sh                                    # read-only Homebrew check; all Agents best-effort
├── setup_deps.sh                               # core dependencies only
└── provision/registry.py                       # core-only deps readiness
.github/workflows/
├── ci.yml                                      # macOS-13 compile target + validator smoke
└── release-publish.yml                         # authoritative extracted-artifact gate
tests/
├── test_package_release.py                     # installer pairing + target/workflow invariants
├── test_release_installer.py                   # release/dev recording-refusal call ordering
├── test_setup_decomposition.py                 # no optional tool/Homebrew dependency
└── test_provision_registry.py                  # core readiness excludes optional tools
```

### Pattern 1: Release-Owned, Tag-Pinned Stable Bootstrap

**What:** Keep root `install.sh` as a compatibility bootstrap, but for default/`--latest`/`--version` make it download and execute the matching GitHub Release's `install.sh`. Only explicit `--dev` may fetch moving `main` code. The Release asset decodes its embedded helper and installs the matching tagged zip. GitHub officially supports `/releases/latest/download/<asset-name>` for manually uploaded latest-release assets. [CITED: https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases]

**Why this is minimal:** `package.sh` already produces and CI already verifies the Release `install.sh`; no new downloader or install transaction is needed. [VERIFIED: `package.sh:226-247`; `release-publish.yml:199-267`]

**Pairing detail:** do not stop at “the helper is embedded.” Pin the runtime tag as well. The smallest race-free form is a second package-time tag sentinel: `package.sh` injects `$TAG`; a packaged installer maps its default/`--latest` target to `--version "$PACKAGED_RELEASE_TAG"` and rejects a different explicit tag. Without this, a newly published Release between downloading `install.sh` and the helper's `releases/latest` lookup could pair installer N with runtime N+1. This is a design inference from the two separate current network resolutions, not a claim that the race has occurred. [VERIFIED: code-path inference — `install.sh:179-223`; `release_installer.py:168-173,1206-1219`]

**When to use:** all stable fresh installs and stable upgrade/reinstall entry points. Keep the old raw URL functioning by forwarding it; publish the direct Release URL as the canonical command later in Phase 13.

**Example:**

```bash
# Source: GitHub release-link documentation + existing package sentinel pattern.
PACKAGED_RELEASE_TAG="__YULU_PACKAGED_RELEASE_TAG__"

# Packaged installer: its code and runtime selection stay on the same tag.
if [[ "$PACKAGED_RELEASE_TAG" != __YULU_PACKAGED_* ]]; then
    TARGET_ARGS=(--version "$PACKAGED_RELEASE_TAG")
fi

# Canonical stable asset URL (README/website alignment remains Phase 13).
https://github.com/Nowhitestar/Yulu/releases/latest/download/install.sh
```

### Pattern 2: Explicit Compile Target + Final-Artifact Gate

**What:** add `-target arm64-apple-macosx13.0` to every native compile in both build scripts and the CI source-compilation smoke. Add one small shell validator that runs `xcrun vtool -arch arm64 -show-build` and requires `platform MACOS` plus `minos 13.0` for every path passed to it.

**Authoritative placement:** run the validator inside `release-publish.yml` after the runtime zip is extracted and the existing layout/signature/manifest checks pass, but before attestation/upload/publication. This checks the bytes users will receive. [VERIFIED: extension seam — `release-publish.yml:127-170`]

**Required shipped inventory:**

1. `Yulu.app/Contents/MacOS/audio_daemon`
2. `Yulu.app/Contents/MacOS/xai_keychain`
3. `StatusAgent.app/Contents/MacOS/status_agent`
4. `recorder_status`
5. `meeting_prompt`

This inventory is derived from both build scripts and the current release tree. All five are arm64 Mach-O executables and currently report `minos 26.0`. [VERIFIED: codebase + local `file`/`vtool` probe 2026-08-23]

**Example:**

```bash
# Source: local swiftc/vtool probes and existing build scripts.
swiftc -target arm64-apple-macosx13.0 -o "$BIN" audio_daemon.swift \
  -framework Cocoa -framework ScreenCaptureKit -framework AVFoundation \
  -framework CoreMedia -framework CoreAudio -framework AudioToolbox

build_info="$(xcrun vtool -arch arm64 -show-build "$binary")"
platform="$(awk '$1 == "platform" { print $2; exit }' <<<"$build_info")"
minos="$(awk '$1 == "minos" { print $2; exit }' <<<"$build_info")"
[[ "$platform" == "MACOS" && "$minos" == "13.0" ]] || exit 1
```

### Pattern 3: Guard-First Installer Transaction

**What:** expose one installer helper such as `assert_recording_idle(scripts_dir, socket_send=None)` that loads `migrate.guard.recording_active` from a trusted runtime path and raises `InstallError` with a retry-after-stop message. Do not call `stop_daemons_guarded`; setup remains the lifecycle owner.

**Where:**

- Perform an early admission check under `acquire_install_lock` so an already-active recording prevents either release or dev dispatch.
- Reuse the same helper immediately before the first runtime mutation: before release `replace_runtime_with_backup`, and before dev `git checkout`/`git pull` or move-aside/clone.
- Recheck before invoking upgrade setup, because setup contains daemon unload/termination paths. If this second check refuses after a release swap, use the existing rollback branch; the recording process remains alive and its WAV intact. [VERIFIED: mutation/rollback boundaries — `release_installer.py:724-747,1003-1106,1114-1203`; setup stop paths `setup_audio.sh:123-180`; `lib/common.sh:226-228`]

**Trusted guard source:** for a release update, the checksum/signature/manifest-verified staged runtime contains the newest `migrate.guard` and can protect upgrades from v0.5.x, whose tags predate that file. For already-current installs, the installed runtime guard is reusable before staging. Git history shows `migrate/guard.py` first appears in the v0.6 foundation commit and is contained in tags v0.6.0 onward. [VERIFIED: local git history — add commit `b18164d`; `git tag --contains`]

**Failure policy:** if an existing runtime is present and no trusted guard can be loaded, fail closed with an actionable message; a missing daemon socket may still return idle according to the canonical Phase 7 contract. Do not silently treat “guard module missing” as “idle.” [VERIFIED: canonical degradation contract — `migrate/guard.py:70-97`; recommendation is risk control]

**Example:**

```python
# Source: yulu/scripts/migrate/guard.py and release_installer.py import conventions.
def assert_recording_idle(scripts_dir: Path, *, socket_send=None) -> None:
    with prepend_sys_path(scripts_dir):
        from migrate.guard import recording_active

        if recording_active(socket_send):
            raise InstallError(
                "A recording is in progress; stop it, then retry. "
                "Yulu did not replace the runtime or stop any daemon."
            )
```

The real implementation should inject the probe/path in tests and restore `sys.path` after the call; do not leave a staged or old runtime path globally active.

### Pattern 4: Core-Only Dependency Postcondition

**What:** setup succeeds when core commands are already usable even if `brew` is absent. Only when a core command is missing may setup offer the existing explicit dependency-consent path; it must never execute the Homebrew bootstrap automatically. `gog` and `cloudflared` are absent from the core install list and `_deps_ready()`.

**Agent registration:** use one detected-only, non-fatal registration call for Hermes, Codex, Claude, and OpenClaw, or skip registration entirely when none is detected. Do not select a provider or make Hermes special in Phase 9. [VERIFIED: existing optional contract — `setup.sh:667-669`; `provision/mcp.py:30,243-246`]

**Calendar:** preserve `YULU_INSTALL_CALENDAR=1` as the explicit opt-in seam, but default the fresh calendar-service prompt to defer/skip and do not install `gog`/`cloudflared` during core dependency setup. Full calendar setup is Phase 13. [VERIFIED: `setup.sh:269-383`; `setup_daemons.sh:144-160`; scope `ROADMAP.md:309-329`]

**Example:**

```python
# Source: provision/registry.py existing probe; Phase 9 removes optional blockers.
def _deps_ready() -> bool:
    required_commands = ("ffmpeg", "sox")
    return all(_have(command) for command in required_commands) and _compatible_node_present()
```

Keep the final core command set synchronized with what `setup_deps.sh` truly requires. `terminal-notifier` is already treated as skippable by `setup.sh:507-516`; therefore it should not be a core readiness blocker if implementation preserves that behavior. [VERIFIED: codebase]

### Recommended Plan Split

1. **09-01 — Version-paired and recording-safe installer (DIST-01, DIST-03).** Own `install.sh`, `package.sh` tag/helper embedding, `release_installer.py`, and installer tests. Verify stable raw bootstrap never fetches the raw-main helper, packaged default pins its tag, and active release/dev updates call zero mutation/setup functions.
2. **09-02 — macOS 13 artifact contract (DIST-02).** Own both Swift build scripts, the one new `check_macos_deployment_target.sh`, CI/release workflows, and deployment-target release tests. Verify exact final zip contents, not only `.ci-build` outputs.
3. **09-03 — core install boundary (DIST-04).** Own `setup.sh`, `setup_deps.sh`, `provision/registry.py`, and hermetic setup/provision tests. Verify missing Hermes/OpenClaw/gog/cloudflared/brew is not a blocker when core tools are available.

Plans 09-01 and 09-02 both naturally touch `tests/test_package_release.py`; serialize them or assign that file to 09-02 and keep 09-01 behavioral bootstrap tests in `tests/test_release_installer.py`. Plan 09-03 is file-disjoint and can run in parallel. [VERIFIED: file-overlap analysis — `09-PATTERNS.md`]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Release/tag/asset selection | Another curl+jq installer transaction | Existing `release_installer.github_release_api_url`, `select_release_asset`, `install_release_from_urls` | Already validates exact zip/checksum naming, VERSION/tag equality, signatures, manifest, backup, rollback. [VERIFIED: `release_installer.py:143-255,1114-1203`] |
| Recording-active detection | PID checks, the recording-start flock, or duplicate socket JSON | `migrate.guard.recording_active` | The status socket is the proven authority; lock metadata is enrichment only. [VERIFIED: `migrate/guard.py:10-15,70-97`] |
| Daemon lifecycle from installer | A second stop loop or `stop_daemons_guarded` call | Installer refuses; existing setup/daemon manager owns lifecycle | Prevents double-unload and keeps rollback semantics in one transaction. [VERIFIED: `setup_daemons.sh`; `yulu_platform/macos/daemon_manager.py`] |
| Mach-O parsing | Custom binary parser | `xcrun vtool -show-build` | Native tool exposes platform/minimum OS directly. [VERIFIED: local tool help] |
| Node compatibility parsing | New shell/Python version rules | `lib/common.sh::compatible_node_bin` and `registry._compatible_node_present` | Existing accepted majors/minors are already tested. [VERIFIED: `test_setup_decomposition.py:137-199`; `test_provision_registry.py:120-127`] |
| Optional Agent provider selection | Setup-time provider wizard/default redesign | Detected-only/non-fatal MCP registration; Phase 10 provider model later | Keeps Phase 9 to blocker removal and avoids locking future auth semantics. [VERIFIED: phase scope] |
| Homebrew bootstrap | `curl ... Homebrew/install ... | bash` | Read-only detection + explicit user action/consent | Avoids unrequested system package-manager mutation. [VERIFIED: current anti-pattern `setup.sh:125-128`] |

**Key insight:** every high-risk behavior except Mach-O minimum-version inspection already exists in one canonical implementation. Phase 9 should connect those implementations and add gates, not create parallel paths.

## Common Pitfalls

### Pitfall 1: Publishing `install.sh` but leaving stable users on `raw/main`

**What goes wrong:** release packaging is immutable, but the documented/default command still downloads the moving helper.  
**Why:** asset production and public bootstrap are separate code paths. [VERIFIED: `install.sh:11-21`; `package.sh:226-247`]  
**Avoid:** make stable raw bootstrap forward to a Release `install.sh`; allow raw main only for `--dev`.  
**Warning sign:** a stable bootstrap network trace contains `/main/yulu/scripts/release_installer.py`.

### Pitfall 2: Embedding the helper but not pinning the tag

**What goes wrong:** a latest-release change between two requests can pair an older installer with a newer runtime.  
**Why:** current shell and helper perform separate selections. [VERIFIED: code-path inference]  
**Avoid:** inject the package tag and convert packaged default/latest to that exact version.  
**Warning sign:** packaged `install.sh` invokes helper with no `--version`.

### Pitfall 3: Testing source flags but not the final Release bytes

**What goes wrong:** a later rebuild or wrong copied binary reintroduces `minos 26.0` after a source test passes.  
**Why:** release signing/package steps rebuild and copy tracked native outputs. [VERIFIED: `sign_and_notarize.sh`; `package.sh:185-259`]  
**Avoid:** run `vtool` on every executable in the extracted final zip before publish.  
**Warning sign:** CI only greps for `-target` or checks `.ci-build`.

### Pitfall 4: Checking only app executables

**What goes wrong:** `xai_keychain`, `recorder_status`, or `meeting_prompt` remains incompatible while the two app entry binaries pass.  
**Avoid:** keep the explicit five-path inventory in the validator invocation and tests.  
**Warning sign:** gate count is less than five. [VERIFIED: current release inventory]

### Pitfall 5: Checking recording only before a long download

**What goes wrong:** recording begins after admission but before runtime replacement/setup.  
**Why:** the install lock serializes installers, not recording starts. [VERIFIED: `release_installer.py:666-721`; `recording_lock.py:70-112`]  
**Avoid:** reuse the same guard at the mutation boundary and before upgrade setup, not only at CLI entry.  
**Warning sign:** the only guard call is above `fetch_json`/download.

### Pitfall 6: Importing the guard only from the old installed runtime

**What goes wrong:** v0.5.x upgrades cannot load a module first shipped in v0.6.0.  
**Avoid:** release updates may load it from the already-verified staged runtime; fail closed if no trusted guard exists.  
**Warning sign:** tests cover a current fixture only, not an existing runtime without `migrate/guard.py`. [VERIFIED: local git tag history]

### Pitfall 7: Removing optional installs but leaving readiness probes coupled

**What goes wrong:** setup looks successful, yet `yulu provision --all` repeatedly reruns/fails `deps` because `_deps_ready()` still demands `brew`, `gog`, or `cloudflared`.  
**Avoid:** change install body, prompt copy, and probe in the same task.  
**Warning sign:** `test_deps_probe_requires_every_setup_postcondition` still lists optional commands. [VERIFIED: `test_provision_registry.py:130-137`]

### Pitfall 8: No Homebrew installed even though all core commands are usable

**What goes wrong:** `setup_deps.sh` fails at its early `brew` check without testing actual postconditions.  
**Avoid:** check commands first; require a package manager only when a consented install is actually needed.  
**Warning sign:** `command -v brew` precedes all core command probes. [VERIFIED: `setup_deps.sh:52-84`]

### Pitfall 9: Declaring Hermes optional while setup still mutates/fails on it

**What goes wrong:** missing Hermes aborts setup, or a present Hermes config is modified without being an explicit core requirement.  
**Avoid:** detected-only + non-fatal for all Agents, with provider connection UX deferred.  
**Warning sign:** setup contains a Hermes-only `if ! ...; then exit 1`. [VERIFIED: `setup.sh:659-669`]

### Pitfall 10: Expanding into later phases

**What goes wrong:** release safety becomes a provider/onboarding/docs redesign and loses a verifiable boundary.  
**Avoid:** Phase 9 removes blockers only. Provider selectors/xAI summary/conversation are Phase 10; activation UI Phase 11; runtime OAuth/gateways Phase 12; full calendar/share/README alignment Phase 13. [VERIFIED: `ROADMAP.md:251-329`]

## Code Examples

Verified patterns are included in the Architecture Patterns section. Planner task actions should reference these exact existing seams:

- Release asset embedding: `packaging/scripts/package.sh:226-247`.
- Immutable remote asset verification: `.github/workflows/release-publish.yml:239-267`.
- Transaction replacement/rollback: `release_installer.py:724-747,1142-1203`.
- Recording predicate/refusal: `migrate/guard.py:49-97`.
- Optional calendar daemon: `setup_daemons.sh:144-160`.
- Hermetic shell testing: `tests/test_setup_decomposition.py:45-135,201-262`.

## State of the Art

| Old / Current Approach | Phase 9 Approach | When / Evidence | Impact |
|------------------------|------------------|-----------------|--------|
| Raw-main helper for stable install | Release-owned `install.sh` with embedded helper and pinned tag | GitHub supports latest asset links; repo already uploads the asset. [CITED: GitHub linking-to-releases docs; VERIFIED: workflow] | Stable setup code is immutable and paired with the runtime. |
| Compiler-host default deployment target | Explicit `arm64-apple-macosx13.0` plus final-artifact `vtool` gate | Current local toolchain defaults to macOS 26; all shipped binaries encode 26.0. [VERIFIED: local probe] | Advertised macOS 13 floor becomes a build and release invariant. |
| Recording guard used only by migration | Same predicate at install/update mutation and setup boundaries | Phase 7 guard/tests complete. [VERIFIED: Phase 7 verification] | Update cannot knowingly truncate an active WAV. |
| Core setup installs calendar tools and requires Hermes/Homebrew | Core-only postconditions; optional integrations deferred/best-effort | Existing optional calendar and Agent branches. [VERIFIED: codebase] | A user can install recording core without understanding a specific Agent/calendar stack. |

**Deprecated/outdated in Phase 9:**

- Stable `raw/main/release_installer.py` fallback: retain only for explicit `--dev` compatibility.
- Unqualified `swiftc` for shipped binaries: every release/CI compile must carry the target.
- Automatic Homebrew bootstrap in `check_system()`: remove; preflight must be read-only.
- Required Hermes registration in setup: convert to optional/non-fatal.
- `gog`/`cloudflared` in `_deps_ready()`: remove from core readiness.

## Assumptions Log

All factual claims above were verified against the current codebase, local toolchain/artifacts, git history, or official GitHub/Apple documentation. No `[ASSUMED]` claim is used as an implementation decision.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| — | None | — | — |

## Open Questions

1. **Real macOS 13 hardware/VM acceptance remains unavailable locally.**
   - What we know: all five sources compile with the explicit 13.0 target and the output load commands report `minos 13.0`. Apple's current Xcode matrix supports deployment targets that include macOS 13. [VERIFIED: local compile; CITED: https://developer.apple.com/xcode/system-requirements]
   - What's unclear: whether the complete signed/notarized runtime starts, records, transcribes, and displays status on a clean macOS 13 host.
   - Recommendation: make this an end-of-phase human gate, not a code-planning blocker.

2. **First protected update from a pre-v0.6 runtime needs the new Release installer path.**
   - What we know: `migrate/guard.py` is present in tags v0.6.0+ but not v0.5.x; old `yulu update` executes its locally installed old helper. [VERIFIED: git history; `yulu:121-129`]
   - What's unclear: which historical public cohort must be upgraded directly from v0.5.x in the Phase 9 release runbook.
   - Recommendation: acceptance should exercise the new Release `install.sh` over a legacy fixture and load the guard from the verified staged runtime. Do not claim that old already-installed code retroactively gains the guard.

3. **The exact core formula list should be confirmed by postcondition, not by historical grouping.**
   - What we know: compatible Node is required by `setup_ui.sh`; `terminal-notifier` is explicitly skippable; `gog`/`cloudflared` are calendar-only; `ffmpeg`/`sox` remain in current core dependency setup. [VERIFIED: `setup_ui.sh`; `setup.sh:507-516`; `CLAUDE.md:53-65`]
   - What's unclear: whether `sox` is required for the minimum Phase 9 recording path or only fallback processing.
   - Recommendation: do not broaden Phase 9 into audio dependency redesign. Remove only proven optional blockers (`gog`, `cloudflared`, Agent CLIs, package-manager presence, skippable notifier); retain the existing audio/Node postconditions unless a targeted production-path test proves one optional.

## Environment Availability

| Dependency | Required By | Available | Version / Evidence | Fallback |
|------------|-------------|-----------|--------------------|----------|
| `python3` | Installer/tests | ✓ | 3.14.6 local; product floor 3.10+ | None; already required |
| `pytest` | Validation | ✓ | 9.0.3 | None |
| `swiftc` | Local compile probe / CI | ✓ | Apple Swift 6.3.3, default target arm64-macos26.0 | CI macOS runner |
| `xcrun vtool` | Deployment-target gate | ✓ | `/usr/bin/xcrun`; `vtool -show-build` available | No custom parser; release CI blocks if unavailable |
| `shellcheck` | Shell validation | ✓ | 0.11.0 | CI gate already provides it |
| GitHub Release signing/notarization credentials | Real release | Not available in local research | CI secrets only | End-of-phase credentialed CI run |
| Clean macOS 13 arm64 host | Compatibility acceptance | ✗ | Local host is macOS 26.5.2 | Human/VM gate |

**Missing dependencies with no fallback:** clean macOS 13 acceptance host and real release credentials are required only for final human/release verification, not implementation.

**Missing dependencies with fallback:** none for implementation; local Xcode/Swift/vtool are available.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | pytest 9.0.3 + Bash `bash -n` + ShellCheck 0.11.0 + macOS CI `vtool` |
| Config file | Existing pytest discovery and GitHub workflow configuration |
| Quick run command | `python3 -m pytest -q tests/test_package_release.py tests/test_release_installer.py tests/test_migrate_recording_guard.py tests/test_setup_decomposition.py tests/test_provision_registry.py` |
| Full suite command | `python3 -m pytest -q` |

**Current relevant baseline:** the quick research suite completed with **170 passed in 54.66s**. [VERIFIED: local execution 2026-08-23]

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| DIST-01 | Raw stable bootstrap selects Release `install.sh`; packaged asset embeds exact helper, pins exact tag, and stable path never fetches raw-main helper | Hermetic shell/package unit | `python3 -m pytest -q tests/test_package_release.py -k 'install or release'` | Existing file; new cases Wave 0 |
| DIST-02 | Every compile uses macOS 13 target; exact extracted Release runtime has five `minos 13.0` binaries | Static unit + macOS CI artifact integration | `python3 -m pytest -q tests/test_package_release.py -k 'macos or target'`; `bash packaging/scripts/check_macos_deployment_target.sh <five paths>` | Validator absent — Wave 0 |
| DIST-03 | Active release and dev update refuse before mutation/setup; runtime bytes, daemon PIDs, and WAV remain intact | Unit + live manual | `python3 -m pytest -q tests/test_release_installer.py -k recording tests/test_migrate_recording_guard.py` | Installer cases absent — Wave 0 |
| DIST-04 | Core setup/provision succeeds with Hermes/OpenClaw/gog/cloudflared/brew absent when core tools are usable; no optional install command runs | Hermetic shell + unit | `python3 -m pytest -q tests/test_setup_decomposition.py tests/test_provision_registry.py` | Existing files; inverse cases Wave 0 |

### Verification Commands

```bash
# Shell syntax/static checks
bash -n install.sh yulu/scripts/setup.sh yulu/scripts/setup_deps.sh \
  yulu/scripts/build_audio_daemon.sh yulu/scripts/build_status_agent.sh \
  packaging/scripts/check_macos_deployment_target.sh
shellcheck -x -P SCRIPTDIR install.sh yulu/scripts/setup.sh \
  yulu/scripts/setup_deps.sh yulu/scripts/build_audio_daemon.sh \
  yulu/scripts/build_status_agent.sh packaging/scripts/check_macos_deployment_target.sh

# Targeted regression
python3 -m pytest -q \
  tests/test_package_release.py \
  tests/test_release_installer.py \
  tests/test_migrate_recording_guard.py \
  tests/test_setup_decomposition.py \
  tests/test_provision_registry.py

# Final local artifact gate (paths shown relative to extracted runtime root)
bash packaging/scripts/check_macos_deployment_target.sh \
  yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon \
  yulu/scripts/Yulu.app/Contents/MacOS/xai_keychain \
  yulu/scripts/StatusAgent.app/Contents/MacOS/status_agent \
  yulu/scripts/recorder_status \
  yulu/scripts/meeting_prompt
```

### Sampling Rate

- **Per task commit:** task-specific pytest file(s), `bash -n`, and ShellCheck on touched shell.
- **Per wave merge:** the 170-test relevant suite above.
- **Phase gate:** full pytest green, real release workflow passes extracted-runtime `vtool`, stable installer asset bytes match uploaded bytes, live recording refusal passes, and clean macOS 13 acceptance is recorded.

### Wave 0 Gaps

- [ ] `packaging/scripts/check_macos_deployment_target.sh` — validates path existence, arm64 macOS platform, and exact `minos 13.0` for supplied binaries.
- [ ] `tests/test_package_release.py` additions — stable Release bootstrap/tag pairing, target flags, five-binary gate invocation, gate before publish.
- [ ] `tests/test_release_installer.py` additions — active guard blocks release and dev mutations; missing old guard uses trusted staged guard or fails closed; idle path proceeds.
- [ ] `tests/test_setup_decomposition.py` additions — core tools ready + no brew/Agents/calendar tools succeeds; brew log contains no `gogcli`/`cloudflared`.
- [ ] `tests/test_provision_registry.py` update — core readiness excludes `brew`, `gog`, `cloudflared`, and any already-skippable notifier.
- [ ] Real macOS 13 + live recording human checks — cannot be fixture-only.

### Manual Acceptance

1. Publish a draft/pre-release through the real workflow; ensure the `vtool` step passes before upload/publication and re-download the exact assets.
2. On a clean macOS 13 arm64 host, run the Release-owned `install.sh`, then complete a real recording and confirm native helpers start without `bad CPU type`/minimum-OS loader errors.
3. Start a real recording, note the WAV path/size and launchd PIDs, then run both stable update and dev update paths. Expected: non-zero refusal, unchanged runtime VERSION/metadata, unchanged daemon PIDs, WAV remains open/growing and completes normally after user stop.
4. In a hermetic or clean user account with no Hermes/OpenClaw/gog/cloudflared and no Homebrew, but with the declared core commands available, complete core setup. Expected: no remote Homebrew bootstrap and no required-Agent/calendar error.

## Security Domain

Security enforcement is enabled at ASVS Level 1. [VERIFIED: `.planning/config.json:49-51`]

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No new auth | Phase 9 neither acquires nor stores Agent/provider credentials; preserve existing ownership boundaries. [VERIFIED: scope] |
| V3 Session Management | No | No web session change. |
| V4 Access Control | No new control | Installer remains user-scoped under `~/.yulu`; no privilege escalation or sudo path is added. [VERIFIED: `release_installer.py:724-737`] |
| V5 Input Validation | Yes | Existing SemVer normalization, fixed asset names, quoted shell arrays, explicit file inventory, and fail-closed missing-path checks. [VERIFIED: `release_installer.py:114-173`; shell conventions] |
| V6 Cryptography | Yes | Preserve SHA-256 checksums, signed runtime manifest, Developer ID signing/notarization, and CI attestation; do not implement crypto. [VERIFIED: `release_installer.py:209-236`; release workflow] |

### Known Threat Patterns for macOS Distribution

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Moving-main code executed during stable install | Tampering | Release-owned installer with same-release embedded helper/tag; raw main only selects asset or serves explicit dev. |
| Release asset replaced or mismatched | Tampering | Existing checksum, VERSION/tag, signatures, runtime manifest, remote byte comparison, attestation. [VERIFIED: release pipeline] |
| Incompatible native helper slips into advertised macOS 13 release | Denial of Service | Exact five-binary `vtool` gate on extracted final zip before publish. |
| Active WAV truncated by daemon stop | Denial of Service / data loss | Canonical status-socket refusal before runtime mutation and setup; no forced-stop override. [VERIFIED: Phase 7 guard] |
| Automatic remote Homebrew installer changes the machine | Elevation of Privilege / supply chain | Remove auto-bootstrap; read-only detection and explicit user action only. |
| Shell/tag injection | Tampering | Existing SemVer regex, quoted variables/arrays, fixed GitHub repo and asset names; no `eval` for release targets. [VERIFIED: `release_installer.py:114-173`] |
| Optional Agent/calendar config mutated during core install | Tampering | detected-only/non-fatal Agent path; calendar explicit opt-in; no provider/auth design in Phase 9. |

## Sources

### Primary (HIGH confidence)

- Current codebase: `install.sh`, `packaging/scripts/package.sh`, `packaging/scripts/checksums.sh`, `yulu/scripts/release_installer.py`, both Swift build scripts, `migrate/guard.py`, `recording_lock.py`, `setup.sh`, `setup_deps.sh`, `setup_daemons.sh`, `provision/registry.py`, CI/release workflows, and the five relevant test files.
- Planning/phase evidence: `.planning/{PROJECT,REQUIREMENTS,ROADMAP}.md`; completed Phase 1, 6, and 7 research/verification/summaries; `09-PATTERNS.md`.
- Local probes dated 2026-08-23: `file`, `xcrun vtool -show-build`, `swiftc --version`, explicit macOS-13 compiles, git tag containment, and 170-test baseline.
- [GitHub Docs — Linking to releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases) — official latest-release asset URL format.
- [Apple — SDK and system requirements](https://developer.apple.com/xcode/system-requirements) — current deployment-target support matrix.

### Secondary (MEDIUM confidence)

- None required.

### Tertiary (LOW confidence)

- None.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — no new packages; every recommended tool/path is already present and locally probed.
- Architecture: HIGH — recommendations extend exact current transaction, packaging, guard, and optional-integration seams.
- Pitfalls: HIGH for current-code failures and artifact inventory; MEDIUM for concurrency/publish-race scenarios because they are code-path risks rather than reproduced incidents.
- Validation: HIGH for unit/hermetic/CI design; real macOS 13 and live-release acceptance remain explicit human gates.

**Research date:** 2026-08-23  
**Valid until:** 2026-09-22 for codebase-local conclusions; re-check GitHub/Apple runner/tool behavior before a later release.
