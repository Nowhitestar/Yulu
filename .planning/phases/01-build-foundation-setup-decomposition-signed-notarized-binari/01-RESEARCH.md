# Phase 1: Build Foundation — Setup Decomposition + Signed/Notarized Binaries - Research

**Researched:** 2026-05-29
**Domain:** macOS code-signing + notarization, GitHub Actions release CI, bash script decomposition, Python ABC package design (brownfield re-architecture of a shipping macOS app)
**Confidence:** HIGH (signing/notarization/attestation toolchain verified against Apple docs + GitHub docs + the actual repo; decomposition/ABC grounded in the real source files)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Python Runtime Ownership**
- **D-01:** daemon interpreter = **host system `python3`**. Yulu bundles NO Python runtime.
- **D-02:** Remove the dedicated `~/.config/yulu/venv-mlx-whisper` creation; the `stt_daemon` runs under the system `python3` launched by its plist (`__PYTHON__`).
- **D-03:** Fix the dead `mlx_python` config field (read but never used — CONCERNS §4a/§6e): drop it or make the daemon interpreter explicit. Full resolution of the interpreter ambiguity is Phase 3 (DETECT-04); Phase 1 just stops creating the venv and points at system `python3`.
- **D-04:** Signing/notarization scope **excludes a Python runtime** — sidesteps the hardest notarization case.
- **D-05:** *How* `mlx-whisper` lands in the system `python3` (reuse-if-present vs install) is OUT of Phase 1 — belongs to the decomposed `capabilities` script's contract + Phase 5 reuse. Phase 1 only fixes the interpreter *target*.

**Signing & Notarization**
- **D-06:** Notarization credential mechanism = **notarytool + App Store Connect API key** (`.p8` + Key ID + Issuer ID). `altool` is deprecated.
- **D-07:** Signing = **Developer ID Application**, signed **bottom-up (NEVER `--deep`)**, then **notarized + stapled**. Replaces `--timestamp=none` + `xattr` quarantine-strip.
- **D-08 [Claude discretion]:** Identity/credential recording strategy = **everything via CI secret + env**. Mechanism only in docs: signing identity driven by `YULU_CODESIGN_IDENTITY` env var; the `.p12`, `.p8`, Key ID, Issuer ID live exclusively in GitHub Actions secrets. No sensitive value in any planning doc — Lewis injects them at execution time.
- **D-09:** Sign + notarize + staple happen in **CI** (`release-publish.yml` / `package.sh`); verified artifacts go into the release zip. The **release-please** mechanism stays unchanged (hard constraint).

**setup.sh Decomposition**
- **D-10:** Decompose **by concern** into independent scripts, each with `set -uo pipefail`, idempotent, re-runnable in isolation.
- **D-11:** Suggested concern boundaries (planner refines): `deps` (brew) · `audio` (TCC + binary placement) · `models` (whisper models) · `daemons` (launchd plist install + load) · `capabilities` (system-`python3`/`mlx-whisper` readiness + config generation) · `ui` (npm ci + build).
- **D-12:** Orchestration = keep a **thin top-level orchestrator** calling each concern script in order, while every script stays independently invocable. Sets up the **Phase 6 step-registry 1:1 mapping** (each `setup_*.sh` → a `provision` step with a clean check/apply shape).
- **D-13:** **dev vs release fork**: release installs use pre-built signed+notarized binaries and **remove** `compile_audio_daemon()`/`compile_scanner()` from the release path; `--dev` keeps `swiftc`. Branch off install source (`.yulu-install.json` `source` field) / a `--dev` flag.
- **D-14:** Fold in low-risk fixes in touched scripts: move `install_plist` to module scope (§8c); replace nvm-versioned node PATH in plists with a stable alias / homebrew node (§6b). The `pkill -9`/`open -W` graceful-stop fix (§2d/§8b) is primarily Phase 2/7 — Phase 1 must not regress it but does not own it.

**platform ABC Scope**
- **D-15:** Phase 1 defines the **full set of Python-side platform seam ABCs** as **interface signatures only** (abstract methods + types, no implementation), with `linux/`/`windows/` arms raising `NotImplementedError`.
- **D-16:** The 4 Python-side ABCs: **PathResolver** · **DaemonManager** (`ServiceSpec` + install/load/unload/status) · **PermissionModel** · **DependencyManager** — grounded in PLAT-03/04/05.
- **D-17:** The **Swift `CaptureBackend`** seam (PLAT-01/02) and **all macOS implementations** are **Phase 2**, not Phase 1. This package is Python-only.
- **D-18:** Interfaces carry **NO leaked macOS vocabulary** (no plist keys / `SCStreamConfiguration` / TCC scopes in signatures).

### Claude's Discretion
The planner has latitude on exact script names, ABC method signatures, and file layout. Decisions fix *intent and boundaries*, not the literal code.

### Deferred Ideas (OUT OF SCOPE)
None new. Adjacent fragilities already mapped to later phases: `curl|bash` signature verification (§2b) → Phase 6 attestation gate; backup cleanup (§2e) → Phase 7; `open -W` daemon-stop (§8b) → Phase 2; security items §7a/§7b/§7c → v2 HARD.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BUILD-01 | Decompose monolithic `setup.sh` into per-concern scripts with `set -uo pipefail`, individually testable | §"setup.sh Decomposition Pattern" maps all 18 current functions → 6 concern scripts + a thin orchestrator; `set -uo pipefail` migration notes; shellcheck-in-CI + bats testability |
| BUILD-02 | macOS binaries Developer ID signed (bottom-up, never `--deep`) + notarized + stapled, replacing `--timestamp=none` + `xattr` | §"Bottom-Up Codesign" + §"Entitlements" (verified: mic needs `com.apple.security.device.audio-input`; SCK is entitlement-free TCC-only) + §"notarytool in CI" |
| BUILD-03 | Release installs ship pre-built signed binaries; no `swiftc`/Xcode on user machine | §"Pre-Built Binary Distribution" — CI becomes sole signed-binary producer; `install.sh` drops Xcode pre-flight on release path; `setup.sh` release fork removes `compile_*` |
| BUILD-04 | CI publishes GitHub Artifact Attestations; verifiable via `gh attestation verify` | §"GitHub Artifact Attestations" — `actions/attest-build-provenance@v4`, `id-token`/`attestations` permissions, exact verify command |

ROADMAP success criterion 5 (platform ABCs) is covered by §"platform/base.py ABC Layout" — note the **verified stdlib shadowing hazard** (do NOT name the package `platform/`).
</phase_requirements>

## Summary

This is a brownfield re-architecture, not greenfield. Every recommendation here is grounded in the actual repo state, which I read in full. The current state is concretely wrong for distribution: the committed `Yulu.app` is signed with an **`Apple Development`** identity (verified via `codesign -dvvv`), `flags=0x0(none)` meaning **no hardened runtime**, `--timestamp=none` (no secure timestamp), and there are **no entitlements files anywhere** in the repo. Setup then strips Gatekeeper quarantine with `xattr -dr com.apple.quarantine` — a fragile path Apple is closing. The 1,342-line `setup.sh` uses `set -e` only (no `-uo pipefail`), so unbound vars and pipe failures are silently swallowed.

The signing happy-path is well-documented, but three areas are where this plan will actually fail if not handled precisely: **(1)** adding hardened runtime WITHOUT the right entitlements silently breaks TCC — I verified that microphone capture (AVFoundation) **requires** `com.apple.security.device.audio-input` under hardened runtime, while ScreenCaptureKit is **purely TCC-gated with NO entitlement** (a corrected, load-bearing distinction), and StatusAgent's "open Terminal" Apple Event needs `com.apple.security.automation.apple-events`; **(2)** the package-cleanliness coupling — `package.sh`'s `check_clean_worktree` has an `ALLOWED_BUILD_OUTPUTS` allowlist of exactly the 4 build-output files, so signing changes that touch other tracked files will fail the release; and **(3)** the `platform/` package name is a **verified stdlib-shadowing landmine** — `numpy` (used by first-party `echo_cancel.py`) imports stdlib `platform`, and the stt_daemon plist puts `yulu/scripts/` on `PYTHONPATH`, so a `platform/` package there WILL shadow stdlib `platform` and break numpy. I proved this empirically.

**Primary recommendation:** Make CI the sole producer of signed+notarized binaries (sign bottom-up with `-o runtime` + per-bundle entitlements → wrap with `ditto -c -k --keepParent` → `notarytool submit --wait` with `.p8`/Key ID/Issuer ID → `stapler staple` the .app → re-zip the runtime → `actions/attest-build-provenance@v4`). Decompose `setup.sh` into 6 `set -uo pipefail` concern scripts under a thin orchestrator that branches dev (swiftc) vs release (pre-built) on `.yulu-install.json` `source`. Name the Python package **`yulu_platform/`** (NOT `platform/`) to avoid the shadowing bug.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Code-signing identity selection | CI (GitHub Actions) | local `build_*.sh` via `YULU_CODESIGN_IDENTITY` | D-08/D-09: credentials only in CI secrets; build scripts read the env var so dev can sign locally with whatever identity they have |
| Notarization + stapling | CI (GitHub Actions) | — | D-09: needs App Store Connect API key in secrets; cannot run on a user's machine |
| Artifact attestation | CI (GitHub Actions OIDC) | — | BUILD-04: attestation is minted from the workflow's OIDC token; only CI can sign it |
| Pre-built binary placement | Release install path (`setup_audio.sh`) | dev path (`build_*.sh` via swiftc) | D-13: release copies/asserts +x on shipped binaries; dev compiles |
| Per-concern install orchestration | Thin top-level orchestrator (`setup.sh`) | each `setup_*.sh` | D-12: orchestrator sequences; each concern script is independently runnable (Phase 6 step registry binds 1:1) |
| Platform-seam abstraction | Python package `yulu_platform/base.py` (ABCs) | macOS impls = Phase 2 | D-15..D-18: Phase 1 is interfaces only; consumers (Phase 2/3/5/7) import this package |
| Daemon interpreter | Host system `python3` (plist `__PYTHON__`) | — | D-01/D-02: no bundled Python; remove venv |

## Standard Stack

This phase adds **no new runtime libraries** (the project is stdlib-first and CLAUDE.md mandates stdlib-only for daemon scripts). The "stack" here is the macOS/CI toolchain and the GitHub Actions used in the release workflow. All of these are first-party Apple tools or first-party GitHub Actions — there is **no third-party package to install**, which is why the Package Legitimacy Audit below is N/A.

### Core (toolchain — already present on macos-latest runner + dev machines)
| Tool | Version | Purpose | Why Standard |
|------|---------|---------|--------------|
| `xcrun notarytool` | Xcode 16.4 (default on macos-latest) `[VERIFIED: runner-images macos-15 readme]` | Submit + wait for notarization | The only supported notarization CLI; `altool` deprecated (D-06) |
| `xcrun stapler` | Xcode 16.4 `[VERIFIED: local xcrun stapler]` | Attach notarization ticket to the .app | Standard final step so Gatekeeper works offline |
| `codesign` | Xcode CLT `[VERIFIED: local]` | Bottom-up Developer ID signing with `-o runtime` + `--entitlements` | The canonical signing tool |
| `ditto` | macOS built-in `[CITED: Apple notarization docs]` | `ditto -c -k --keepParent App.app App.zip` to make the notarization upload | notarytool will not accept a bare `.app` — needs zip/dmg/pkg |
| `security` | macOS built-in `[CITED: federicoterzi.com]` | Create temp keychain + import `.p12` + set partition list in CI | Headless cert import without UI password prompt |

### Supporting (GitHub Actions — pin in the release workflow)
| Action | Version | Purpose | When to Use |
|--------|---------|---------|-------------|
| `actions/attest-build-provenance` | `@v4` (4.1.0 latest) `[VERIFIED: gh api repos/actions/attest-build-provenance/releases/latest]` | Mint SLSA build-provenance attestation for the zip | BUILD-04, in `release-publish.yml` after packaging |
| `actions/checkout` | `@v4` (repo current) — `v6` available `[VERIFIED: gh api]` | Checkout the tag | Already used; no change needed |
| `googleapis/release-please-action` | `@v5` (repo current) `[VERIFIED: repo release-please.yml]` | Maintain Release PR / cut release | UNCHANGED (D-09 hard constraint) |

### Testability tooling
| Tool | Version | Purpose | When to Use |
|------|---------|---------|-------------|
| `shellcheck` | 0.11.0 `[VERIFIED: local /opt/homebrew/bin/shellcheck]` | Static analysis of decomposed bash scripts | Add as a CI step; available on macos-latest |
| `bats-core` | latest `[ASSUMED]` (not installed locally; `brew install bats-core`) | Optional unit testing of bash concern scripts | Only if planner wants behavioral bash tests beyond `bash -n` + shellcheck |
| `pytest` | (CI installs into venv) `[VERIFIED: repo ci.yml]` | Unit-test the Python ABCs (import + NotImplementedError asserts) | Existing harness; add `tests/test_yulu_platform_*.py` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Inline `notarytool submit -k/-d/-i` | `notarytool store-credentials` profile then `submit -p` | Profile writes a keychain item; inline is simpler in ephemeral CI and avoids an extra keychain artifact. Either works — recommend inline for CI (no profile cleanup needed). `[CITED: keith.github.io notarytool.1]` |
| Per-bundle `.entitlements` files | A single shared entitlements file | The two bundles need *different* entitlements (audio daemon = audio-input; status agent = apple-events), so per-bundle is cleaner and least-privilege. `[VERIFIED: see Entitlements section]` |
| `actions/attest-build-provenance@v4` | `actions/attest@v4` (the underlying generic action) | `attest-build-provenance` is now a thin wrapper over `actions/attest`; the wrapper is the documented, stable name for provenance. Use the wrapper. `[VERIFIED: github.com/actions/attest-build-provenance README]` |
| `bats-core` for bash tests | `bash -n` + `shellcheck` + a pytest harness that shells out to the scripts | The repo already shells out to bash scripts from pytest (`test_package_release.py` runs `package.sh` via subprocess). Reuse that pattern instead of adding a bats dependency. **Recommend: extend the existing pytest-shells-out pattern.** |

**Installation:** No package installs. The toolchain is present on macos-latest (Xcode 16.4) and dev machines (Xcode CLT). Optional: `brew install bats-core` only if behavioral bash tests are desired (planner's call).

**Version verification (performed this session):**
```
gh api repos/actions/attest-build-provenance/releases/latest --jq .tag_name → v4.1.0  [VERIFIED]
gh api repos/actions/checkout/releases/latest --jq .tag_name              → v6.0.2   [VERIFIED]
macos-latest = macOS 15, default Xcode 16.4 (notarytool/stapler/codesign present) [VERIFIED]
shellcheck 0.11.0 present locally; bats NOT present                        [VERIFIED]
gh 2.92.0 present (attestation verify supported, needs gh ≥ 2.49)          [VERIFIED]
```

## Package Legitimacy Audit

**N/A — this phase installs no external language packages.** All tools are first-party Apple binaries (`codesign`, `notarytool`, `stapler`, `ditto`, `security`) shipped with Xcode/macOS, or first-party GitHub Actions published by `actions/` and `googleapis/`. The Python ABC work uses **stdlib only** (`abc`, `typing`, `dataclasses`) per CLAUDE.md's stdlib-first rule. The only optional install is `bats-core` (a well-known Homebrew formula) and only if the planner chooses behavioral bash tests — tagged `[ASSUMED]` and gated behind the planner's discretion, not auto-installed.

| Package | Registry | Disposition |
|---------|----------|-------------|
| `bats-core` (optional, dev-only) | Homebrew | `[ASSUMED]` — verify `brew info bats-core` before use; not required |
| (all signing/CI tooling) | first-party Apple / GitHub | Approved (not from a package registry) |

## Architecture Patterns

### System Architecture Diagram

```text
                         ┌─────────────────────────── DEV MACHINE ───────────────────────────┐
                         │  developer runs: bash build_audio_daemon.sh                        │
                         │     swiftc → audio_daemon → Yulu.app/Contents/MacOS/                │
                         │     codesign -o runtime --entitlements (whatever identity dev has)  │
                         │  (no notarization on dev box; ad-hoc/Apple-Dev is fine locally)     │
                         └────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────── CI (macos-latest, release-publish.yml) ────────────────────────────────────┐
  │                                                                                                                  │
  │  secrets: YULU_CODESIGN_P12_BASE64, P12_PWD, KEYCHAIN_PWD, ASC_KEY_P8_BASE64, ASC_KEY_ID, ASC_ISSUER_ID,         │
  │           YULU_CODESIGN_IDENTITY                                                                                  │
  │                                                                                                                  │
  │  [1] import cert → temp keychain (security create-keychain / import / set-key-partition-list)                    │
  │  [2] build_audio_daemon.sh + build_status_agent.sh                                                               │
  │         swiftc → binary → bundle                                                                                 │
  │         codesign BOTTOM-UP:  inner Mach-O first, then .app, with -o runtime + --timestamp + --entitlements       │
  │  [3] for each .app:  ditto -c -k --keepParent App.app App.zip                                                    │
  │                      xcrun notarytool submit App.zip -k key.p8 -d $KEY_ID -i $ISSUER --wait   ──► Apple Notary   │
  │                      xcrun stapler staple App.app          (ticket now embedded in the bundle on disk)          │
  │  [4] make package TAG=vX.Y.Z   (rsync staged tree → zip; staples are inside the .app dirs being zipped)          │
  │  [5] make checksums            (SHA-256 of zip + install.sh)                                                     │
  │  [6] actions/attest-build-provenance@v4  subject-path=dist/yulu-macos-arm64-vX.Y.Z.zip   (OIDC-signed)           │
  │  [7] gh release create/upload  zip + checksums.txt + install.sh                                                  │
  │  [8] security delete-keychain (cleanup)                                                                          │
  │                                                                                                                  │
  └──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                  │ release assets
                                                  ▼
  ┌──────────────────────────────────────── USER MACHINE (no Xcode) ────────────────────────────────────────────────┐
  │  curl install.sh | bash  → release_installer.py                                                                   │
  │     download zip + checksums.txt → SHA-256 verify → extract (restore +x from external_attr) → ~/.yulu             │
  │     (Phase 6 will add: gh attestation verify before extract)                                                      │
  │  setup.sh  (RELEASE fork: source=="release")                                                                      │
  │     ├─ setup_deps.sh        brew install (NOT swiftc)                                                              │
  │     ├─ setup_audio.sh       place pre-built signed+stapled Yulu.app/StatusAgent.app; chmod +x; TCC prompt         │
  │     │                          (spctl -a -vvv passes; NO xattr strip needed)                                      │
  │     ├─ setup_models.sh      whisper.cpp model download                                                            │
  │     ├─ setup_capabilities.sh  point config at SYSTEM python3 (no venv); write config.json                         │
  │     ├─ setup_daemons.sh     install_plist (module-scope helper) + launchctl load                                 │
  │     └─ setup_ui.sh          npm ci && npm run build                                                               │
  │  thin orchestrator runs them in order; each is independently re-runnable                                          │
  └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure (new files this phase)
```
yulu/scripts/
├── setup.sh                      # BECOMES the thin orchestrator (sequences setup_*.sh; dev/release fork)
├── setup_deps.sh                 # brew installs (was install_deps); set -uo pipefail
├── setup_audio.sh                # binary placement + TCC walkthrough (was compile_audio_daemon, release fork)
├── setup_models.sh               # whisper.cpp model download (was download_whisper_model)
├── setup_capabilities.sh         # system-python3 readiness + config.json generation (was create_config + transcription config)
├── setup_daemons.sh              # launchd install/load (was install_launchagents); install_plist at module scope
├── setup_ui.sh                   # npm ci && build (was install_yulu_ui)
├── lib/                          # (optional) shared bash helpers — colors, install_plist, source-detection
│   └── common.sh
├── build_audio_daemon.sh         # MODIFIED: bottom-up sign, -o runtime, --entitlements, drop --deep/--timestamp=none
├── build_status_agent.sh         # MODIFIED: same, with apple-events entitlement
├── Yulu.app.entitlements         # NEW: com.apple.security.device.audio-input
├── StatusAgent.app.entitlements  # NEW: com.apple.security.automation.apple-events
└── yulu_platform/                # NEW package — NOT named `platform/` (stdlib shadow, see pitfall #1)
    ├── __init__.py
    ├── base.py                   # ABCs: PathResolver, DaemonManager (+ServiceSpec), PermissionModel, DependencyManager
    ├── macos/__init__.py         # empty placeholder (Phase 2 implements)
    ├── linux/__init__.py         # raises NotImplementedError
    └── windows/__init__.py       # raises NotImplementedError

packaging/scripts/
├── package.sh                    # MODIFIED: update ALLOWED_BUILD_OUTPUTS if entitlements/staples change tracked files
└── sign_and_notarize.sh          # NEW (optional): extract the CI signing logic here so package.sh stays focused
```

### Pattern 1: Bottom-Up Codesign with Hardened Runtime + Entitlements
**What:** Sign nested Mach-O binaries first, then the enclosing `.app`. Never `--deep`. Add `-o runtime` (hardened runtime, required for notarization) and `--entitlements` per bundle. Add a secure timestamp (drop `--timestamp=none`).
**When to use:** In `build_audio_daemon.sh` / `build_status_agent.sh`, replacing the current `codesign --force --deep --timestamp=none --sign "$IDENTITY" "$APP"`.
**Example:**
```bash
# Source: Apple "Signing a Daemon with a Restricted Entitlement" + gist.github.com/rsms (bottom-up rule)
# [CITED: developer.apple.com hardened-runtime; gist rsms macOS distribution]
ENTITLEMENTS="$SCRIPT_DIR/Yulu.app.entitlements"

# 1. Sign the inner executable FIRST (bottom-up), with hardened runtime + entitlements + secure timestamp.
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IDENTITY" \
  "$APP/Contents/MacOS/audio_daemon"

# 2. Then sign the bundle itself (NO --deep). Entitlements re-applied at the bundle level.
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IDENTITY" \
  "$APP"

# 3. Verify strictly.
codesign --verify --strict --verbose=2 "$APP"
codesign --display --entitlements :- "$APP"   # confirm the entitlement is present
```

### Pattern 2: notarytool Submit (App Store Connect API key) + Staple
**What:** Wrap the signed `.app` in a zip (notarytool won't accept a bare bundle), submit with API-key auth, wait, then staple the on-disk `.app`.
**When to use:** CI only (D-09); the `.p8`/Key ID/Issuer ID come from secrets.
**Example:**
```bash
# Source: [CITED: keith.github.io/notarytool.1] flags; [CITED: Apple] ditto + accepted formats
# Decode the App Store Connect API key from a secret.
printf '%s' "$ASC_KEY_P8_BASE64" | base64 --decode > "$RUNNER_TEMP/asc_key.p8"

# notarytool requires zip/dmg/pkg — NOT a bare .app.
ditto -c -k --keepParent "$APP" "$RUNNER_TEMP/Yulu.zip"

xcrun notarytool submit "$RUNNER_TEMP/Yulu.zip" \
  --key      "$RUNNER_TEMP/asc_key.p8" \
  --key-id   "$ASC_KEY_ID" \
  --issuer   "$ASC_ISSUER_ID" \
  --wait

# Staple the TICKET to the on-disk .app (so the bundle that gets re-zipped into the
# release asset carries the ticket and works offline / on a clean machine).
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
```
**Critical ordering note:** staple the **`.app` directory on disk**, not the notarization zip. The release zip is produced *after* stapling by `make package`, so the staple travels inside the release asset. Stapling the throwaway `Yulu.zip` would be useless.

### Pattern 3: CI Keychain Setup + Cleanup
**What:** Import the Developer ID `.p12` into an ephemeral keychain so headless `codesign` finds the identity without a UI prompt; tear it down at the end.
**When to use:** First and last steps of the CI signing job.
**Example:**
```bash
# Source: [CITED: federicoterzi.com] keychain setup; cleanup added (the blog omits it)
KEYCHAIN="$RUNNER_TEMP/yulu-signing.keychain-db"
printf '%s' "$YULU_CODESIGN_P12_BASE64" | base64 --decode > "$RUNNER_TEMP/cert.p12"

security create-keychain -p "$KEYCHAIN_PWD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"          # avoid auto-lock mid-build
security unlock-keychain -p "$KEYCHAIN_PWD" "$KEYCHAIN"
security import "$RUNNER_TEMP/cert.p12" -k "$KEYCHAIN" -P "$P12_PWD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PWD" "$KEYCHAIN"
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')

# ... build/sign/notarize ...

# Cleanup (always run, even on failure):
security delete-keychain "$KEYCHAIN"
rm -f "$RUNNER_TEMP/cert.p12" "$RUNNER_TEMP/asc_key.p8"
```
**Gotchas (verified):** without a fresh keychain, `codesign` triggers a UI password dialog that hangs headless CI; without `set-key-partition-list`, codesign gets "errSecInternalComponent"; `set-keychain-settings -lut` prevents the keychain auto-locking during a long notarization wait.

### Pattern 4: GitHub Artifact Attestation
**What:** Mint an OIDC-signed SLSA provenance attestation for the release zip.
**When to use:** `release-publish.yml`, after `make package`/`make checksums`, before/after the GitHub Release upload.
**Example:**
```yaml
# Source: [VERIFIED: github.com/actions/attest README + docs.github.com artifact-attestations]
permissions:
  contents: write       # existing — needed for gh release
  id-token: write       # NEW — mint the OIDC token used to sign the attestation
  attestations: write   # NEW — persist the attestation to the repo

steps:
  # ... after make package + make checksums ...
  - name: Attest release zip provenance
    uses: actions/attest-build-provenance@v4
    with:
      subject-path: dist/yulu-macos-arm64-${{ inputs.tag }}.zip
```
**Consumer verification (what BUILD-04's success criterion checks):**
```bash
# [VERIFIED: docs.github.com] — runs against Yulu's own CI provenance
gh attestation verify dist/yulu-macos-arm64-vX.Y.Z.zip -R Nowhitestar/Yulu
```
**Note for the reusable-workflow shape:** `release-publish.yml` is called via `workflow_call`. The `permissions:` block must be declared on the **called** workflow's job (or inherited). The caller (`release-please.yml`) already passes `permissions: contents: write` and `secrets: inherit`; add `id-token: write` + `attestations: write` to the publish job's `permissions:` in `release-publish.yml`.

### Pattern 5: setup.sh Concern Script + Thin Orchestrator
**What:** Each concern script is a standalone `set -uo pipefail` bash file with a single public entry, sourcing a shared `lib/common.sh` for colors + `install_plist` + source-detection. The orchestrator sources/sequences them and owns the dev/release fork.
**When to use:** The whole BUILD-01 decomposition.
**Example:**
```bash
# setup_audio.sh  — runnable in isolation: `bash setup_audio.sh [--dev]`
#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

setup_audio() {
  local mode="${1:-release}"   # release|dev
  if [[ "$mode" == "dev" ]]; then
    [[ -x "$SCRIPT_DIR/build_audio_daemon.sh" ]] && "$SCRIPT_DIR/build_audio_daemon.sh"
  else
    # RELEASE: binaries already built+signed+stapled in CI and shipped in the zip.
    for b in "$SCRIPT_DIR/Yulu.app/Contents/MacOS/audio_daemon" \
             "$SCRIPT_DIR/StatusAgent.app/Contents/MacOS/status_agent"; do
      [[ -f "$b" ]] && chmod +x "$b"
    done
    # NO xattr quarantine strip — stapled binaries pass Gatekeeper on their own.
  fi
  # ... TCC walkthrough (Darwin-gated) ...
}
# Allow direct invocation:
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then setup_audio "$@"; fi
```
**Source-detection for the fork (D-13):** read `.yulu-install.json`'s `source` field already written by `release_installer.py` (`"release"` vs `"dev"`), with a `--dev` flag override. The orchestrator computes the mode once and passes it to each concern script.

### Pattern 6: Python platform-seam ABCs (stdlib only)
**What:** `abc.ABC` interface classes with `@abstractmethod` signatures and typed `dataclass` value objects; `linux/`/`windows/` raise `NotImplementedError`.
**When to use:** `yulu_platform/base.py`.
**Example:**
```python
# Source: [CITED: docs.python.org abc] — idiomatic ABC; stdlib only per CLAUDE.md
from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ServiceSpec:
    """Platform-neutral daemon description (NO plist keys — D-18)."""
    name: str
    program: list[str]
    keep_alive: bool = True
    working_dir: Path | None = None
    environment: dict[str, str] | None = None


class DaemonManager(ABC):
    @abstractmethod
    def install(self, spec: ServiceSpec) -> None: ...
    @abstractmethod
    def load(self, name: str) -> None: ...
    @abstractmethod
    def unload(self, name: str) -> None: ...
    @abstractmethod
    def status(self, name: str) -> str: ...   # platform-neutral status enum/str


class PathResolver(ABC):
    @abstractmethod
    def config_dir(self) -> Path: ...
    @abstractmethod
    def data_dir(self) -> Path: ...          # replaces hardcoded ~/Movies/Yulu (PLAT-04)
    @abstractmethod
    def runtime_dir(self) -> Path: ...        # sockets/locks/PIDs (DATA-02 future)


class PermissionModel(ABC):
    @abstractmethod
    def check(self, capability: str) -> str: ...   # NO TCC vocabulary in the signature (D-18)


class DependencyManager(ABC):
    @abstractmethod
    def is_available(self, name: str) -> bool: ...
    @abstractmethod
    def install(self, name: str) -> None: ...
```
```python
# yulu_platform/linux/__init__.py
"""Linux platform arm — Phase 1 ships signatures only; impls deferred to v2 (XPLAT-01)."""
from yulu_platform.base import DaemonManager, PathResolver, PermissionModel, DependencyManager

class LinuxDaemonManager(DaemonManager):
    def install(self, spec): raise NotImplementedError("Linux daemon management not implemented (v2 XPLAT-01)")
    def load(self, name):    raise NotImplementedError("Linux daemon management not implemented (v2 XPLAT-01)")
    def unload(self, name):  raise NotImplementedError("Linux daemon management not implemented (v2 XPLAT-01)")
    def status(self, name):  raise NotImplementedError("Linux daemon management not implemented (v2 XPLAT-01)")
# ... same shape for PathResolver/PermissionModel/DependencyManager
```

### Anti-Patterns to Avoid
- **`codesign --deep`:** Apple explicitly says don't use it; it only signs Mach-O files (not other resources) and re-signs nested code with the *wrong* flags. Sign bottom-up. `[VERIFIED: gist rsms; Apple TN]`
- **`--timestamp=none`:** No secure timestamp → notarization rejects it. Use `--timestamp` (the default secure timestamp). `[CITED: Apple]`
- **`xattr -dr com.apple.quarantine` as the trust mechanism:** Replaced by stapling. A stapled, notarized bundle passes Gatekeeper with no quarantine strip. Keep the strip ONLY in the `--dev` (ad-hoc) path if at all. `[VERIFIED: CONCERNS §2c]`
- **Naming the Python package `platform/`:** Shadows stdlib `platform`, which numpy imports. See Pitfall #1 — this is a verified break, not a style nit.
- **Submitting a bare `.app` to notarytool:** Rejected; must be zip/dmg/pkg. `[VERIFIED: Apple forums]`
- **Stapling the notarization upload zip instead of the .app:** Useless — staple the bundle that ends up in the release asset.
- **Touching tracked files other than the 4 build outputs during `package.sh`:** Fails `check_clean_worktree`. See Pitfall #2.
- **`set -e` without `-uo pipefail`:** Current bug (§6c). Every new concern script gets `set -uo pipefail`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Recursive bundle signing | A loop that finds + signs every Mach-O | Explicit bottom-up `codesign` calls per known binary (1 per bundle here) | Yulu's bundles have exactly one inner Mach-O each; a generic recursive signer reinvents `--deep`'s problems. Sign the known inner binary, then the bundle. |
| Notarization polling | A custom loop hitting the notary API | `xcrun notarytool submit --wait` | `--wait` blocks until the Apple notary returns Accepted/Invalid; no polling logic needed. `[CITED: keith.github.io]` |
| Artifact provenance/signing | A custom GPG/cosign signing step | `actions/attest-build-provenance@v4` | First-party, OIDC-backed, verifiable with `gh attestation verify`; BUILD-04 names this exact tool. |
| SHA-256 checksums | New checksum logic | Existing `packaging/scripts/checksums.sh` | Already emits the right format consumed by `release_installer.py`; attestation is additive, not a replacement. `[VERIFIED: repo]` |
| Exec-bit restoration in zips | New zip permission code | Existing `package.sh` `external_attr` restore + `release_installer.py` re-chmod | Already solved (§8a); don't touch it beyond verifying it still holds after binary changes. |
| Plist token substitution | Re-implement `sed` per script | Move `install_plist` to a shared `lib/common.sh` (D-14, fixes §8c) | The duplication between `install_launchagents()` and `install_yulu_ui()` is the bug to fix, not to copy a third time. |
| Bash test framework | Hand-rolled assertions | Existing pytest-shells-out-to-bash pattern (`test_package_release.py`) + `shellcheck` | The repo already proves concern scripts via `subprocess.run(["bash", script, ...])`; reuse it. bats optional. |

**Key insight:** Almost everything risky here is a *first-party tool that already does the hard part* (notarytool waits, attest signs, ditto packages). The failure mode in this domain is not "missing a library" — it's **using the right tool with one wrong flag** (`--deep`, `--timestamp=none`, missing entitlement, bare `.app`). The plan's verification steps must check the *output* (`spctl`, `codesign --display --entitlements`, `stapler validate`, `gh attestation verify`), not just that the command ran.

## Runtime State Inventory

> This phase touches install/signing infrastructure and removes a venv (D-02), so a runtime-state audit applies.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| **Stored data** | `~/.config/yulu/venv-mlx-whisper/` (Python virtualenv created by current `install_mlx_whisper()`). D-02 says stop creating it. | Phase 1: **stop creating** the venv (remove `install_mlx_whisper` venv path from the decomposed `capabilities` script). Deleting an *existing* user's venv is a **migration concern (Phase 7)** — Phase 1 must not delete it on existing installs (could orphan a working setup before Phase 5 reuse lands). Document the orphaned-venv cleanup as a Phase 7 item. |
| **Stored data (config)** | `config.json` `transcription.mlx.python` points at `$CONFIG_DIR/venv-mlx-whisper/bin/python` (written by `write_mlx_to_config`). The daemon ignores it (dead field §4a/§6e) — plist uses `__PYTHON__`. | D-03: in the decomposed config-generation, **stop writing the venv path** / drop the `mlx.python` field (or set it to the system python). Existing configs with the stale value are harmless (field is dead) but should be normalized on upgrade — coordinate exact wording with Phase 3 DETECT-04. |
| **Live service config** | 8 launchd plists already installed at `~/Library/LaunchAgents/com.yulu.*.plist` with the **nvm-versioned node PATH baked in** (§6b) and `com.yulu.audiodaemon` using `open -W` (§8b). | D-14: regenerate plists with a **stable node PATH** (homebrew node / `~/.nvm/alias/default/bin`) when `setup_daemons.sh` runs. The `open -W` → direct-launch change is **Phase 2** (PLAT-03); Phase 1 must not regress it. Re-running `setup_daemons.sh` re-installs + reloads plists (idempotent). |
| **OS-registered state** | TCC grants for `com.yulu.audiodaemon` (Microphone + ScreenCapture). The bundle ID is unchanged, but **the signing identity changes** (Apple Development → Developer ID) and **hardened runtime is newly enabled**. | TCC is keyed on bundle ID + code-signing identity. Changing the signing identity / enabling hardened runtime **can invalidate existing TCC grants**, forcing a re-prompt. `setup_audio.sh` already does `tccutil reset` + re-prompt on fresh install; ensure the re-prompt path fires after the identity change (the existing reset logic covers this). Document: first run of a Developer-ID build on a machine that had an Apple-Dev build will re-prompt for permissions — expected, one extra click. |
| **Secrets/env vars** | `YULU_CODESIGN_IDENTITY` (env var, drives identity selection in `build_*.sh` — already exists). New CI secrets: `YULU_CODESIGN_P12_BASE64`, `*_PWD`, `ASC_KEY_P8_BASE64`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `KEYCHAIN_PWD`. | D-08: these live **only** in GitHub Actions secrets; Lewis injects them. Planning docs name the *mechanism* only — no values. The build scripts already read `YULU_CODESIGN_IDENTITY`; CI sets it from a secret. |
| **Build artifacts / committed binaries** | `yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon` and `StatusAgent.app/.../status_agent` are **committed to git** (100755), currently signed `Apple Development`, no hardened runtime (verified via `codesign -dvvv`). `package.sh` allows these 2 (+2 Info.plist) to be dirty after build via `ALLOWED_BUILD_OUTPUTS`. | **Open decision (see Open Questions #1):** keep committing binaries vs make CI the sole producer. Either way, the committed binaries' *signature* will differ from CI's Developer-ID+notarized signature, and **a committed binary can never be notarized** (notarization happens in CI post-build). Recommendation: keep committing for `--dev`/CI-input convenience, but treat the **CI-produced, signed, stapled** binaries as the only ones that ship — CI re-signs from source on every release. |

**Nothing found in category:** No Windows Task Scheduler / systemd / pm2 state (macOS-only, launchd is the sole manager — verified via STRUCTURE.md daemon inventory). No Datadog/Tailscale/Cloudflare-named state tied to the signing change (cloudflared tunnel exists but is unrelated to Phase 1).

## Common Pitfalls

### Pitfall 1: Naming the Python package `platform/` shadows stdlib `platform` and breaks numpy (VERIFIED)
**What goes wrong:** A package at `yulu/scripts/platform/` is shadowed in front of stdlib `platform` because the stt_daemon plist sets `PYTHONPATH=__SCRIPT_DIR__` (= `yulu/scripts/`), and `doctor.py` does `sys.path.insert(0, scripts_dir)`. First-party `echo_cancel.py` imports `numpy`, and **numpy imports stdlib `platform`** transitively.
**Why it happens:** Python resolves `import platform` to the first match on `sys.path`; a local `platform/` package wins over stdlib.
**How to avoid:** Name the package **`yulu_platform/`** (or `platforms/`, or nest under an existing package). I verified `yulu_platform` has no collision.
**Warning signs:** `numpy` import failures or `AttributeError: module 'platform' has no attribute 'system'` from the daemon, only in the installed/PYTHONPATH context (passes in a bare `python -c` from another dir).
**Evidence (this session):**
```
PYTHONPATH=/tmp/shadowtest python3 -c "import platform; print(platform.__file__)"
  → /tmp/shadowtest/platform/__init__.py     # stdlib shadowed
import numpy → 'platform' in sys.modules → True   # numpy pulls stdlib platform
grep -rn "import platform" yulu/scripts/ → NONE in first-party code (so it's purely the transitive numpy risk)
```

### Pitfall 2: `package.sh` `check_clean_worktree` rejects unexpected dirty files after build
**What goes wrong:** `package.sh` runs `check_clean_worktree "after build"`, which fails the release if the build produced any tracked-file change OTHER than the 4 in `ALLOWED_BUILD_OUTPUTS` (the 2 Mach-O binaries + 2 Info.plist). Adding entitlements files, changing what the build writes, or stapling into a tracked path can trip this.
**Why it happens:** The packaging guard assumes a build only mutates those exact 4 files (verified in `tests/test_package_release.py::test_default_build_refuses_unexpected_dirty_outputs`).
**How to avoid:** New `*.entitlements` files must be **committed** (so they're clean, not "dirty after build"). If signing/stapling mutates the committed binaries' bytes (it does — signature changes), they're already in the allowlist. If the build starts writing anything new under a tracked path, **add it to `ALLOWED_BUILD_OUTPUTS`**. Run `test_package_release.py` after the change.
**Warning signs:** CI `make package` fails with "Worktree is dirty after build; refusing to package release assets."

### Pitfall 3: Hardened runtime enabled without entitlements silently breaks TCC (VERIFIED)
**What goes wrong:** Adding `-o runtime` without `com.apple.security.device.audio-input` makes the audio daemon's microphone access **denied at runtime** even though TCC shows it as granted — capture silently fails. Same for StatusAgent's "open Terminal" Apple Event without `com.apple.security.automation.apple-events`.
**Why it happens:** Under hardened runtime, resource-access entitlements are **required** (not optional) for a non-sandboxed app; the Info.plist usage string alone is insufficient. `[VERIFIED: 2 corroborating sources + Apple hardened-runtime docs]`
**How to avoid:**
  - `Yulu.app.entitlements` → `com.apple.security.device.audio-input = true` (mic via AVFoundation). **No** screen-capture entitlement — ScreenCaptureKit is purely TCC-gated and has NO entitlement (verified; do not add a bogus `com.apple.security.device.screen-capture`).
  - `StatusAgent.app.entitlements` → `com.apple.security.automation.apple-events = true` (it shells `osascript`/Apple Events to open Terminal; `NSAppleEventsUsageDescription` already in its Info.plist).
**Warning signs:** `codesign --display --entitlements :- Yulu.app` shows no entitlements; daemon logs "audio input not authorized" despite a green TCC toggle; StatusAgent's open-in-Terminal action does nothing with no dialog.

### Pitfall 4: Stapling the wrong artifact / wrong order
**What goes wrong:** Stapling the throwaway notarization zip (or stapling before notarization completes) leaves the shipped `.app` without a ticket — clean machines show a Gatekeeper warning.
**Why it happens:** The notarization upload zip is discarded; the release zip is built later from the `.app` directories.
**How to avoid:** Order is: sign → `ditto` zip → `notarytool submit --wait` → `stapler staple "$APP"` (the directory) → THEN `make package` zips the stapled `.app`. Verify with `stapler validate "$APP"` and, on a clean machine, `spctl -a -vvv -t exec "$APP"` (success criterion 2).
**Warning signs:** `stapler validate` says "does not have a ticket"; `spctl -a -vvv` on a second machine warns.

### Pitfall 5: Decomposed scripts losing `set -e` semantics or shared state
**What goes wrong:** `setup.sh` currently relies on `set -e` and shared shell variables (`$CONFIG_DIR`, `$SCRIPT_DIR`, `UPGRADE_MODE`, `CONFIG_PRESERVED`) across functions. Splitting into separate processes loses that shared state and changes error propagation (`set -uo pipefail` is stricter — unbound vars now error).
**Why it happens:** The monolith passes state implicitly via globals; independent scripts can't.
**How to avoid:** Pass state explicitly via args/env (`--upgrade`, `--dev`, `YULU_CONFIG_DIR`). Audit each function for unbound-variable use before adding `set -u` (e.g., `read -r ans` then `[[ "$ans" =~ ... ]]` is fine, but `$choice` defaults must be set). The orchestrator owns the interactive prompts and passes resolved decisions down; concern scripts should be non-interactive when invoked standalone (read env/flags, sane defaults).
**Warning signs:** `bash setup_X.sh` fails with "unbound variable" that the monolith tolerated; idempotent re-run prompts again instead of skipping.

### Pitfall 6: Removing the Xcode pre-flight breaks `--dev` installs
**What goes wrong:** `install.sh` currently hard-requires Xcode CLT (lines 119–128). BUILD-03 removes this for the **release** path, but `--dev` still needs `swiftc`.
**Why it happens:** The pre-flight is unconditional today.
**How to avoid:** Gate the Xcode CLT check on the target: only require it when `--dev` is selected (the existing `--dev`-gated `git` check at line 130 is the model). Release installs (pre-built binaries) skip the Xcode requirement entirely.
**Warning signs:** A release user without Xcode is still blocked at install; or a `--dev` user without swiftc fails later during `build_audio_daemon.sh` with a cryptic error.

## Code Examples

(Verified patterns consolidated above in Patterns 1–6. Key sourced commands repeated here for the planner's task actions.)

### Verify a notarized bundle on a clean machine (success criterion 2)
```bash
# [CITED: Apple — Gatekeeper assessment]
spctl -a -vvv -t exec /path/to/Yulu.app
# Expect: "accepted ... source=Notarized Developer ID"
xcrun stapler validate /path/to/Yulu.app   # "The validate action worked!"
```

### Assert the platform ABCs raise NotImplementedError (Validation, success criterion 5)
```python
# tests/test_yulu_platform_stubs.py  — stdlib + pytest only
import pytest
from yulu_platform.linux import LinuxDaemonManager

def test_linux_daemon_manager_is_stub():
    mgr = LinuxDaemonManager()
    with pytest.raises(NotImplementedError):
        mgr.load("com.yulu.sttdaemon")

def test_base_is_abstract():
    from yulu_platform.base import DaemonManager
    with pytest.raises(TypeError):   # cannot instantiate an ABC with abstract methods
        DaemonManager()
```

## State of the Art

| Old Approach (current repo) | Current Approach (this phase) | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `codesign --force --deep --timestamp=none` with Apple Development identity | Bottom-up `codesign -o runtime --timestamp --entitlements` with Developer ID, then notarize + staple | Apple has tightened un-notarized binary execution on Sequoia+ | Binaries pass Gatekeeper on any Mac without quarantine tricks |
| `altool` for notarization | `notarytool` (altool's notarization support removed Nov 2023) | Apple retired altool notarization | D-06 mandates notarytool; API-key auth needs no Apple ID/2FA |
| `xattr -dr com.apple.quarantine` to bypass Gatekeeper | Stapled notarization ticket | — | Trustworthy distribution to non-developer machines |
| Monolithic `set -e` `setup.sh` | Per-concern `set -uo pipefail` scripts + thin orchestrator | — | Isolated re-run, testability, Phase 6 step-registry mapping |
| `swiftc` at install time (Xcode required) | Pre-built signed binaries; swiftc only on `--dev` | — | Release users need no 11 GB Xcode |
| `actions/attest@v3` / manual signing | `actions/attest-build-provenance@v4` (wrapper over `actions/attest`) | v4 released; provenance is the documented path | Standard SLSA provenance, `gh attestation verify` |

**Deprecated/outdated:**
- `altool` notarization: removed. Use `notarytool`. `[CITED: Apple]`
- `--timestamp=none`: incompatible with notarization. `[CITED: Apple]`
- `codesign --deep`: discouraged by Apple for signing (fine for *verify*). `[VERIFIED: Apple TN/gist]`

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `bats-core` is the bash test framework if behavioral bash tests are wanted | Standard Stack | Low — it's optional; the pytest-shells-out pattern is the primary recommendation, so bats being mis-specified costs nothing |
| A2 | The 2 `.app` bundles are the ONLY things needing notarization (no separate helper binaries ship signed) | Notarization scope | Medium — if `window_scanner`/`recorder_status` ship as standalone signed binaries they'd also need signing; but `window_scanner` is dev-compiled and not in the release zip (STACK.md), and `recorder_status` isn't in `ALLOWED_BUILD_OUTPUTS`. Planner should confirm the release zip's exact binary inventory. |
| A3 | Existing TCC grants survive or cleanly re-prompt after the identity change | Runtime State Inventory | Medium — worst case is users re-grant Microphone/ScreenCapture once; the existing `tccutil reset` + re-prompt path handles it, but verify on a real upgrade |
| A4 | `release-please` cutting a release and the reusable `release-publish.yml` will correctly inherit `id-token`/`attestations` permissions when added to the publish job | Attestation | Medium — reusable-workflow permission inheritance has edge cases; must test that the OIDC token is mintable in the called workflow context. If inheritance fails, declare permissions explicitly on the publish job. |
| A5 | Keeping committed binaries is acceptable even though CI re-signs them | Open Questions #1 | Low/Medium — see Open Questions; this is a design choice for the planner/user, not a correctness issue |
| A6 | Stapling the `.app` directory before `make package` zips it preserves the ticket inside the release asset | Notarization | Low — this is the documented mechanism; verified conceptually but should be smoke-tested end-to-end in CI before first real release |

## Open Questions

1. **Keep committing the `.app` binaries, or make CI the sole producer?**
   - What we know: Both binaries are committed (100755) and `package.sh`'s `check_clean_worktree` *depends* on exactly those being the only build-dirty files (allowlist). CI re-runs `build_*.sh` on every release, so the committed bytes are overwritten by freshly-signed+stapled bytes anyway. A committed binary can never carry a notarization staple (notarization is a CI-time post-build step).
   - What's unclear: Whether to stop committing them (cleaner: CI is the only source of truth; but then `--dev`/local `package.sh --skip-build` has no binary to fall back on, and the `ALLOWED_BUILD_OUTPUTS` clean-check logic needs rethinking) vs keep committing (status quo; the committed binary is just a dev convenience / CI input, and CI's signed+stapled version is what ships).
   - Recommendation: **Keep committing** for now (least disruption, preserves `--skip-build` packaging tests and the existing clean-check contract). Make explicit in the plan that the *shipping* binary is always the CI-signed+stapled one, regenerated from source each release. Revisit "stop committing" as a separate cleanup once CI signing is proven. This is a user/planner decision — flag for discuss-phase.

2. **Inline notarytool credentials vs `store-credentials` keychain profile?**
   - What we know: Both work. Inline (`-k/-d/-i`) needs no profile cleanup; profile (`-p`) is tidier for repeated calls (we have 2 .apps → 2 submits).
   - Recommendation: Inline for CI ephemerality (no extra keychain artifact to clean). Decode `.p8` once, pass to both submits. Low-risk either way.

3. **Should `setup_capabilities.sh` install `mlx-whisper` into system python3, or only verify it?**
   - What we know: D-05 explicitly defers the *how* (reuse vs install) to Phase 5. D-01/D-02 fix only the interpreter *target* (system python3, no venv).
   - Recommendation: Phase 1's `capabilities` script should **point config at system python3 and verify importability** (warn if absent), NOT install mlx-whisper. The install/reuse decision is Phase 5 (REUSE-02). Keep the Phase 1 contract minimal: "is mlx-whisper importable from the daemon's interpreter? report yes/no." Confirm this boundary with the planner.

4. **`com.yulu.audiodaemon.plist` `open -W` and entitlements interaction.**
   - What we know: The daemon runs as `Yulu.app/Contents/MacOS/audio_daemon` launched via `open -W Yulu.app`. Entitlements live on the bundle/binary regardless of launch method, so hardened-runtime + entitlements work under `open -W`. The `open -W` → direct-launch fix is Phase 2 (PLAT-03/§8b).
   - What's unclear: nothing blocking for Phase 1 — entitlements don't depend on the launch method. Just don't regress §8b.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `codesign` | bottom-up signing | ✓ (CI + dev) | Xcode CLT | none needed |
| `xcrun notarytool` | notarization | ✓ (CI macos-latest, dev) | Xcode 16.4 | none — CI-only step (D-09) |
| `xcrun stapler` | stapling | ✓ | Xcode 16.4 | none |
| `ditto` | zip for notary upload | ✓ | macOS built-in | `zip` (but ditto is canonical) |
| `security` | CI keychain import | ✓ | macOS built-in | none |
| `shellcheck` | bash static analysis (CI) | ✓ | 0.11.0 (local); on macos-latest | `bash -n` (already in CI) |
| `bats` | optional bash unit tests | ✗ | — | pytest-shells-out pattern (preferred) |
| `gh` | `gh release` + attestation verify | ✓ | 2.92.0 | none |
| `actions/attest-build-provenance` | attestation | ✓ | @v4 (4.1.0) | none — first-party action |
| Apple Developer ID + App Store Connect API key | signing + notarization | ✓ (RESOLVED 2026-05-29 per STATE.md; Lewis has it) | — | none — hard prerequisite, confirmed available |

**Missing dependencies with no fallback:** None. The Apple Developer ID prerequisite is resolved (STATE.md Blockers).
**Missing dependencies with fallback:** `bats` (use the existing pytest-shells-out-to-bash pattern instead).

## Validation Architecture

> nyquist_validation is enabled (no `workflow.nyquist_validation: false` in config). This phase has concrete, automatable verifiable properties.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (Python) `[VERIFIED: repo ci.yml + tests/]`; `bash -n` + `shellcheck` for scripts; Swift via `swiftc` build |
| Config file | `tests/conftest.py` (markers only; no pytest.ini — discovery via default `tests/`) |
| Quick run command | `python3 -m pytest tests/test_yulu_platform_stubs.py tests/test_package_release.py -q` |
| Full suite command | `make test` (= `py-compile` + `pytest tests -q` + `swift-build`) ; CI also runs `bash -n` on all scripts |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BUILD-01 | Each `setup_*.sh` runs in isolation, `set -uo pipefail`, idempotent | unit (shells out) | `python3 -m pytest tests/test_setup_decomposition.py -q` | ❌ Wave 0 |
| BUILD-01 | All scripts pass shellcheck | static | `shellcheck yulu/scripts/setup*.sh yulu/scripts/lib/*.sh` | ❌ Wave 0 (CI step) |
| BUILD-01 | All scripts pass `bash -n` | syntax | `bash -n yulu/scripts/setup_*.sh` | ✅ (pattern exists in ci.yml; extend file list) |
| BUILD-02 | Bundle has hardened runtime + correct entitlement; no `--deep`/`--timestamp=none` in build scripts | static + signed-output | `grep -L -- '--deep' build_*.sh` (must match) ; `codesign --display --entitlements :- Yulu.app` ; in CI: `codesign --verify --strict Yulu.app` | ❌ Wave 0 (entitlement-presence test) |
| BUILD-02 | Notarized bundle passes Gatekeeper on a clean machine | manual/CI smoke | `spctl -a -vvv -t exec Yulu.app` + `stapler validate Yulu.app` (CI post-notarize; clean-machine = manual) | manual-only (success criterion 2) |
| BUILD-03 | Release path never calls `swiftc`; `install.sh` Xcode pre-flight gated on `--dev` | unit (shells out) | `python3 -m pytest tests/test_release_no_swiftc.py -q` (assert release fork has no swiftc invocation) | ❌ Wave 0 |
| BUILD-04 | CI mints attestation; asset verifies | CI smoke + manual | `gh attestation verify dist/yulu-macos-arm64-vX.Y.Z.zip -R Nowhitestar/Yulu` | manual-only (post-release; needs real CI run) |
| SC-5 (ABCs) | `yulu_platform.base` ABCs uninstantiable; linux/windows raise NotImplementedError | unit | `python3 -m pytest tests/test_yulu_platform_stubs.py -q` | ❌ Wave 0 |
| §1 (shadow) | `yulu_platform` does NOT shadow stdlib `platform` | unit | `python3 -m pytest tests/test_yulu_platform_no_shadow.py -q` (assert `import platform` resolves to stdlib with scripts dir on path) | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `python3 -m pytest tests/test_yulu_platform_stubs.py tests/test_package_release.py -q` + `bash -n` + `shellcheck` on any touched script (< 15 s).
- **Per wave merge:** `make test` (full pytest + py-compile + swift-build).
- **Phase gate:** `make test` green + `shellcheck` clean + (CI) `spctl`/`stapler validate`/`gh attestation verify` proven on a real release-publish dry run before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `tests/test_yulu_platform_stubs.py` — ABC uninstantiable + NotImplementedError (SC-5)
- [ ] `tests/test_yulu_platform_no_shadow.py` — stdlib `platform` not shadowed with `yulu/scripts` on `sys.path` (§1 pitfall)
- [ ] `tests/test_setup_decomposition.py` — each concern script runnable in isolation, idempotent, `set -uo pipefail` present (BUILD-01)
- [ ] `tests/test_release_no_swiftc.py` — release fork emits no `swiftc`; `install.sh` Xcode check is `--dev`-gated (BUILD-03)
- [ ] Entitlement-presence assertion (a pytest that parses the new `*.entitlements` files for the required keys) (BUILD-02)
- [ ] CI step: add `shellcheck` job covering `setup*.sh` + `lib/*.sh` + `build_*.sh`
- [ ] CI step: add `bash -n` for the new `setup_*.sh` files (extend the existing loop list in ci.yml + release-publish.yml)
- [ ] Framework install: none — pytest + shellcheck already available; `bats` only if the planner opts in.

*(The notarization/Gatekeeper/attestation criteria (BUILD-02 clean-machine, BUILD-04) are inherently CI/manual — they require a real Apple notary round-trip and a clean second machine. Plan them as a CI-gated dry-run + a documented manual check, not as a unit test.)*

## Security Domain

> `security_enforcement` is not set to `false` in config → included. This phase is squarely a supply-chain / code-integrity phase.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V1 Architecture | yes | Bottom-up signing + hardened runtime + least-privilege entitlements (only the resource each bundle needs) |
| V2 Authentication | no | No user auth in this phase |
| V6 Cryptography | yes | Apple Developer ID code signing (Apple-managed PKI) + secure timestamp; SHA-256 checksums; SLSA provenance attestation — **never hand-roll** any of these |
| V10 Malicious Code / Supply Chain | yes | GitHub Artifact Attestations (`gh attestation verify`), notarization (Apple malware scan), reproducible-timestamp zip, secrets only in CI |
| V14 Configuration | yes | Credentials (`.p12`/`.p8`/Key ID/Issuer ID) **only** in GitHub Actions secrets (D-08); no secret in any committed file or planning doc; ephemeral CI keychain torn down after use |

### Known Threat Patterns for {macOS distribution + GitHub Actions release CI}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Tampered release asset served to users | Tampering | SHA-256 checksum (existing) + Artifact Attestation (`gh attestation verify`, BUILD-04) + notarization staple |
| Un-notarized/unsigned binary blocked or warned by Gatekeeper | (availability/trust) | Developer ID sign + notarize + staple; verify `spctl -a -vvv` (BUILD-02) |
| Secret leakage (signing cert / API key) into the repo | Information Disclosure | D-08: secrets only in GitHub Actions secrets; ephemeral keychain; `rm -f` decoded `.p12`/`.p8`; never echo secret values in logs |
| Over-broad entitlements (privilege escalation surface) | Elevation of Privilege | Least-privilege: audio daemon gets ONLY `audio-input`; status agent gets ONLY `apple-events`; no screen-capture entitlement (SCK is TCC-only) |
| Malicious `postinstall`-style code in install path | Tampering | No new external packages (stdlib + first-party tools only); `curl|bash` signature gate is Phase 6 (not regressed here) |
| Keychain left populated on a shared/ephemeral runner | Information Disclosure | `security delete-keychain` in a cleanup step that always runs (`if: always()`) |

## Sources

### Primary (HIGH confidence)
- **The actual repo** (read in full this session): `yulu/scripts/setup.sh`, `build_audio_daemon.sh`, `build_status_agent.sh`, `dev_install.py`, `release_installer.py`, `install.sh`, `packaging/scripts/{package,checksums}.sh`, `.github/workflows/{ci,release,release-please,release-publish}.yml`, `Makefile`, `com.yulu.{audiodaemon,sttdaemon}.plist`, `stt_daemon/config.py`, `tests/test_package_release.py`, `tests/conftest.py`, `Yulu.app/Contents/Info.plist`. Plus `.planning/{REQUIREMENTS,STATE,codebase/CONCERNS,codebase/STACK,codebase/STRUCTURE}.md`.
- **Empirical tests run this session:** `codesign -dvvv Yulu.app` (confirmed Apple Development, flags=0x0 no hardened runtime); PYTHONPATH shadowing test (confirmed `platform/` shadows stdlib + numpy pulls stdlib platform); `gh api` for action versions; `xcrun notarytool/stapler --help` (present locally); `shellcheck --version` (0.11.0).
- Apple — Hardened Runtime: https://developer.apple.com/documentation/security/hardened-runtime (entitlements required under hardened runtime)
- Apple — notarytool man page: https://keith.github.io/xcode-man-pages/notarytool.1.html (`-k/-d/-i` API-key flags, `--wait`)
- GitHub — Artifact Attestations: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds (permissions, `gh attestation verify`)
- github.com/actions/attest + actions/attest-build-provenance (v4.1.0 confirmed via `gh api`)
- GitHub runner-images macOS-15 readme (Xcode 16.4 default → notarytool/stapler present)

### Secondary (MEDIUM confidence — verified against a primary source)
- Federico Terzi — Automatic Code-signing and Notarization with GitHub Actions: https://federicoterzi.com/blog/automatic-code-signing-and-notarization-for-macos-apps-using-github-actions/ (keychain import + partition list; cross-checked against `security` man behavior)
- rsms gist — macOS distribution (code signing, notarization, quarantine): https://gist.github.com/rsms/929c9c2fec231f0cf843a1a746a416f5 (bottom-up rule, don't use `--deep`)
- Eclectic Light — Notarization: the hardened runtime / privacy controls: https://eclecticlight.co/2021/01/07/notarization-the-hardened-runtime/ and /2021/01/08/notarisation-privacy-controls/
- Apple Developer docs — `com.apple.security.automation.apple-events`: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events
- Apple Developer docs — NSMicrophoneUsageDescription: https://developer.apple.com/documentation/BundleResources/Information-Property-List/NSMicrophoneUsageDescription

### Tertiary (LOW confidence — corroboration / community)
- ScreenCaptureKit-is-TCC-only (no entitlement): community sources (doom-fish/screencapturekit-rs, electron #47490, pyobjc #647) — corroborated by the *absence* of any SCK entitlement in Apple's entitlement list. Treated as HIGH on the negative claim because multiple independent sources agree and Apple documents no such entitlement.

## Metadata

**Confidence breakdown:**
- Signing/notarization/entitlements: HIGH — Apple docs + 2+ corroborating sources + verified current repo signing state; the mic-entitlement-required and SCK-entitlement-free distinctions are both cross-verified.
- CI integration (keychain, notarytool, attestation): HIGH — canonical community guide + Apple man pages + GitHub docs + confirmed action versions and runner Xcode.
- setup.sh decomposition: HIGH — grounded in reading the actual 1,342-line file and mapping every function; the `check_clean_worktree` and PYTHONPATH constraints are empirically verified.
- platform ABC layout: HIGH — idiomatic abc.ABC; the package-naming hazard is empirically proven (not assumed).
- Committed-binary strategy: MEDIUM — a real design choice (Open Questions #1) the planner/user should confirm.
- Reusable-workflow permission inheritance for OIDC: MEDIUM — needs a real CI dry-run to confirm (Assumption A4).

**Research date:** 2026-05-29
**Valid until:** ~2026-06-28 for the toolchain facts (Apple may bump notarytool/Xcode; recheck action versions). The repo-grounded findings are valid until the code changes.

## RESEARCH COMPLETE

**Phase:** 01 - Build Foundation — Setup Decomposition + Signed/Notarized Binaries
**Confidence:** HIGH

### Key Findings
- The committed `Yulu.app` is currently signed `Apple Development` with **no hardened runtime** (verified `codesign -dvvv`) — confirming the exact gap BUILD-02 closes. No entitlements files exist in the repo.
- **Verified load-bearing distinction:** microphone (AVFoundation) under hardened runtime **requires** `com.apple.security.device.audio-input`; ScreenCaptureKit is **purely TCC-gated with NO entitlement** (do not add a screen-capture entitlement). StatusAgent's Apple Event needs `com.apple.security.automation.apple-events`. Getting this wrong silently breaks TCC.
- **Verified landmine:** naming the Python package `platform/` shadows stdlib `platform`, which numpy (used by first-party `echo_cancel.py`) imports — empirically proven. Use `yulu_platform/`.
- **Verified constraint:** `package.sh`'s `check_clean_worktree` only tolerates 4 dirty build-output files (`ALLOWED_BUILD_OUTPUTS`); new `*.entitlements` must be committed and any new build-written tracked file must be added to the allowlist (test exists: `test_package_release.py`).
- CI is the right (and only) place for notarize+staple+attest: macos-latest has Xcode 16.4; `actions/attest-build-provenance@v4`; the reusable `release-publish.yml` needs `id-token: write` + `attestations: write` added.

### File Created
`.planning/phases/01-build-foundation-setup-decomposition-signed-notarized-binari/01-RESEARCH.md`

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Standard Stack (toolchain) | HIGH | All first-party; versions verified via `gh api` + local `xcrun` |
| Architecture (signing/CI/decomposition) | HIGH | Apple docs + GitHub docs + canonical guide + full read of the actual scripts |
| Pitfalls | HIGH | The two highest-risk ones (entitlements, package shadowing) are empirically verified, not assumed |

### Open Questions (for discuss-phase / planner)
1. Keep committing the `.app` binaries vs make CI the sole producer (recommendation: keep committing; CI re-signs every release).
2. `setup_capabilities.sh` should verify (not install) mlx-whisper in Phase 1 — confirm the Phase 1/Phase 5 boundary.
3. Reusable-workflow OIDC permission inheritance (A4) needs a CI dry-run to confirm.

### Ready for Planning
Research complete. The planner has: a function-by-function decomposition map, verified codesign/notarytool/attestation command patterns, the two non-obvious traps (entitlements + package naming) with verification commands, the packaging clean-check constraint, and a requirement→test map with Wave 0 gaps.
