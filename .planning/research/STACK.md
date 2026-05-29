# Stack Research

**Domain:** Agent-native, local-first, cross-platform meeting-recorder provisioning & configuration (Yulu — "Agent-Native Provisioning & Cross-Platform Foundation" milestone)
**Researched:** 2026-05-29
**Confidence:** HIGH for macOS-native tooling (signing, capture, paths, capability detection); MEDIUM for the cross-platform abstraction shape (deferred impls); HIGH for packaging/distribution.

> **Scope discipline.** Yulu already exists (mapped in `.planning/codebase/`). This file does NOT re-derive the running stack (Python 3 daemons, Swift `audio_daemon`, Hono+tRPC+React UI, SQLite, MLX/whisper.cpp, launchd, release-please). It prescribes ONLY what to ADD for this milestone, and marks each item **[BUILD NOW]** (macOS impl + portable interface) vs **[DEFER]** (Linux/Windows impl, future milestone) vs **[INTERFACE-ONLY NOW]** (define the seam, stub the non-macOS arm).
>
> **Guiding principle from PROJECT.md (locked):** build the abstraction layer now, macOS-only implementation; agent-orchestrated provisioning; reuse host capabilities; configurable data folder (Obsidian model); configurable transcription; keep release-please + GitHub Releases. Recommendations below are chosen to honor those locks, not relitigate them.

---

## Recommended Stack

### Core Technologies (the six dimensions in the question)

| Dimension | Recommendation | Build status | Why |
|-----------|----------------|--------------|-----|
| **1. Daemon supervision abstraction** | Hand-rolled `DaemonManager` Python interface (`install/load/unload/status/restart`); macOS arm = thin wrapper over `launchctl` + plist templating (keep current plists). Model the trait surface on **service-manager-rs v0.10** but do NOT add a Rust dependency. | [BUILD NOW] interface + macOS; [DEFER] systemd/Task Scheduler arms | No mature *Python* cross-platform user-level supervisor exists. `service-manager-rs` is the best-proven abstraction *shape* (install/start/stop/uninstall + `ServiceLevel::User`), but adopting Rust here is over-engineering for a Python daemon fleet. Borrow the API, not the crate. |
| **2. System-audio + mic capture** | Keep Swift capture as the macOS `CaptureBackend` impl. **Migrate the system-audio path from ScreenCaptureKit → Core Audio process taps (`AudioHardwareCreateProcessTap` / `CATapDescription`, macOS 14.4+)**; keep AVFoundation for mic. Define a `CaptureBackend` protocol (`start/stop/status/list-sources`) as the portable seam. | [BUILD NOW] macOS impl + protocol; [DEFER] PipeWire (Linux) / WASAPI-loopback (Windows) arms | **Decisive finding:** ScreenCaptureKit on Sequoia triggers a ~weekly screen-recording re-permission prompt and lives in the *Screen & System Audio Recording* TCC scope — hostile UX for an always-on recorder. Core Audio taps need only `NSAudioCaptureUsageDescription` (audio permission), no screen-recording TCC, no weekly nag. The right cross-platform boundary is **"PCM frames out of an OS audio backend"** — exactly what `cpal` proves (CoreAudio / WASAPI / ALSA-PipeWire under one trait). |
| **3. macOS signing / notarization** | `codesign --options runtime --timestamp --sign "Developer ID Application: …"` signed **bottom-up** (never `--deep`), then `xcrun notarytool submit --wait`, then `xcrun stapler staple` the `.app` bundles. Sign every nested Mach-O (Swift binaries, and any bundled Python `.so`/dylib). Add entitlements `com.apple.security.cs.disable-library-validation` (loads non-Apple-signed dylibs) and, if a bundled Python interpreter is shipped, `com.apple.security.cs.allow-unsigned-executable-memory`. | [BUILD NOW] CI signing+notarization of `Yulu.app`/`StatusAgent.app` | Fixes CONCERNS 2c (`--timestamp=none`, unsigned) and removes the `xattr -dr com.apple.quarantine` hack. Lets release installs ship **pre-built signed binaries** so `swiftc`/Xcode is no longer an install-time dep (PROJECT.md goal; CONCERNS 1d). Requires an **Apple Developer ID** (USD $99/yr) — flag as a hard prerequisite/cost. |
| **4. Host-capability detection** | Extend `doctor.py` with a `host_capabilities` probe layer: (a) binaries via a **login-shell-resolved PATH** lookup, not bare `shutil.which`; (b) Python importability via `subprocess` `-c "import mlx_whisper; print(...)"` against the *daemon's* interpreter; (c) models by walking HF cache + ggml dirs. | [BUILD NOW] | Directly unblocks CONCERNS 4 & 5 and the "reuse host capabilities" lock. The PATH subtlety is critical: launchd/GUI-spawned processes get a minimal PATH (`/usr/bin:/bin:…`), so `shutil.which("claude")` from a daemon returns `None` even when the user's shell has it. Must resolve via the user's login shell (see Pattern 2). |
| **5. Cloud-sync-root detection** | Probe known roots and present them as data-folder candidates (never auto-move): **iCloud** `~/Library/Mobile Documents/com~apple~CloudDocs`; **Google Drive / Dropbox / OneDrive** under `~/Library/CloudStorage/<Provider>-<account>` (File Provider era, macOS 12.3+). Confirm iCloud is *enabled* via `~/Library/Preferences/MobileMeAccounts.plist` (`MOBILE_DOCUMENTS` service `Enabled=true`). | [BUILD NOW] macOS; [INTERFACE-ONLY NOW] other OSes | Implements the Obsidian "point the folder at a synced dir" model with zero server burden (locked decision). Google Drive no longer lives at a fixed `~/Google Drive` path — it's `~/Library/CloudStorage/GoogleDrive-<email>` via File Provider; globbing `~/Library/CloudStorage/*` is the correct discovery method. |
| **6. Packaging / distribution** | Keep release-please + GitHub Releases + the signed zip (locked). **Add GitHub Artifact Attestations** (`actions/attest-build-provenance`) in `release-publish.yml`; verify on install with `gh attestation verify <zip> -o <org>` (falls back to the existing SHA-256 `checksums.txt` when `gh` is absent). Offer **two install entry points**: the existing `curl \| bash` (humans) and an **agent-orchestrated path** the host agent runs step-by-step (clone/download → verify → provision), exposed through the skill. | [BUILD NOW] | Provenance fixes CONCERNS 2b (curl-bash trust). Attestation is the native, agent-friendly integrity story: the agent (which already has `gh`) can cryptographically verify the release was built by Yulu's own CI before executing anything — strictly better than the syntax-only `py_compile` check today. |

### Supporting Libraries / Tools

| Library / Tool | Version | Purpose | When to Use |
|----------------|---------|---------|-------------|
| `psutil` | 6.x (latest 6.1+) | Cross-platform process liveness/inspection for `DaemonManager.status()` and `doctor.py` ("is the daemon actually running?" independent of launchctl) | [BUILD NOW] — the one safe cross-platform Python dep that removes launchctl-only status checks |
| `huggingface_hub` (`scan_cache_dir`) | already transitively present via mlx-whisper | Enumerate cached Whisper models (`models--mlx-community--whisper-*`) with sizes for the settings model-selector | [BUILD NOW] — model discovery in `doctor.py` (CONCERNS 4c/5a) |
| `notarytool` + `stapler` + `codesign` | Xcode 16 CLT (bundled `xcrun`) | macOS signing/notarization pipeline in CI | [BUILD NOW] — CI only, not a runtime dep |
| `gh` CLI (`gh attestation verify`) | 2.65+ | Verify build provenance at install; already the agent's tool | [BUILD NOW] — optional verify step; degrade to SHA-256 if absent |
| `uv` / `uvx` | 0.5.x+ (latest) | Agent-friendly Python tool runner — ephemeral or `uv tool install` to `~/.local/bin`, no preexisting Python needed | [EVALUATE in spike] — strong candidate for the agent-orchestrated provisioning path (Key Decision: validate riskiest path via spike) |
| `service-manager-rs` | 0.10 | **Reference only** — read its trait to design the `DaemonManager` API; do NOT depend on it | Design-time reference |
| `cpal` | 0.17.3 (loopback on macOS >14.6 via CoreAudio) | **Reference / contingency** — proves the "PCM frames under one trait, CoreAudio/WASAPI/ALSA backends" boundary; viable Rust capture core *if* a future milestone unifies capture | Design-time reference; [DEFER] as actual dependency |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `set -euo pipefail` | Bash hardening across the decomposed setup scripts | Fixes CONCERNS 2a/6c — the current `setup.sh` uses `set -e` alone, swallowing pipe failures |
| Per-concern setup scripts (`setup_audio.sh`, `setup_models.sh`, `setup_daemons.sh`, `setup_capabilities.sh`) | Decompose the 1,342-line `setup.sh` monolith | CONCERNS 2a — also makes each step independently agent-invokable, aligning with the provisioning lock |
| `yulu skill install [--agent]` | Standalone idempotent skill installer | CONCERNS 3a — extract from `setup.sh` step 7; the agent invokes it directly |
| CI zip `external_attr` assertion | Verify exec bits survive packaging | CONCERNS 8a — guards the fragile permission-bit restore in `release_installer.py` |

## Installation

```bash
# Runtime deps to ADD (Python side) — into the daemon's interpreter, not a throwaway venv
python3 -m pip install psutil        # cross-platform daemon status / process inspection
# huggingface_hub arrives with mlx-whisper; use its scan_cache_dir() for model discovery

# CI / release machine only (macOS runner) — already present via Xcode CLT + gh
xcrun notarytool --help              # signing/notarization pipeline
gh attestation verify --help         # provenance verification

# Agent-orchestrated provisioning spike (candidate runner)
curl -LsSf https://astral.sh/uv/install.sh | sh   # uv brings its own Python; no system Python prereq
```

> **Note on the MLX venv (CONCERNS 4a, the `mlx_python` dead field):** do NOT keep building `~/.config/yulu/venv-mlx-whisper/` while the daemon runs under system `python3`. Either (a) launch the daemon with the venv interpreter, or (b) drop the venv and require `mlx-whisper` in the daemon's interpreter — and have `doctor.py` detect a host-provided `mlx-whisper` first. Pick one in this milestone; the current split is a latent silent-failure bug.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| **Core Audio process taps** (system audio, macOS 14.4+) | **ScreenCaptureKit** (current, macOS 12.3+) | Only if you must support macOS 13.0–14.3. SCK stays the floor for those OSes — but accept the Sequoia weekly re-permission prompt and screen-recording TCC scope. Recommendation: raise the floor to macOS 14.4 for the audio path and adopt taps; keep SCK behind the same `CaptureBackend` protocol as a legacy arm if 13.x support is required. |
| **Hand-rolled `DaemonManager` (Python) over launchctl** | **service-manager-rs** (Rust, abstracts launchd/systemd/sc.exe/WinSW) | If a future milestone rewrites the capture/daemon core in Rust (same milestone that might adopt `cpal`). Then the crate gives you Windows/Linux supervision essentially for free. Not now — adding a Rust toolchain to a Python+Swift+TS project is unjustified for ~8 launchd labels. |
| **GitHub Artifact Attestations** (`gh attestation verify`) | **Sigstore cosign / SLSA generator** | If you ever distribute outside GitHub Releases or need policy-as-code (Rego/CUE) verification. GitHub attestations are keyless Sigstore under the hood and require zero extra infra given the repo is already on GitHub Actions. Note: free-tier attestations are public-repo only (Yulu is public — fine). |
| **`uv`/`uvx` agent provisioning** | **Keep `release_installer.py` + signed zip only** | If the spike shows agent-driven `uv` provisioning is flakier than the proven zip path. The zip path stays the fallback regardless; `uv` is the *agent-native* convenience, not a replacement for verified release assets. |
| **`~/Library/CloudStorage/*` glob for cloud roots** | **File Provider domain enumeration (NSFileProviderManager)** | If you need provider metadata (account, sync status) beyond the folder path. For "let the user pick a synced folder," globbing the well-known root is simpler and sufficient. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `codesign --deep` | Apple-documented anti-pattern: signs nested code with the *wrong* identity/options and breaks notarization for bundled dylibs/`.so` | Sign **bottom-up** — inner Mach-O first, bundle last, each with `--options runtime --timestamp` |
| `--timestamp=none` (current `build_*.sh`) | No secure timestamp ⇒ Apple won't trust the signature ⇒ cannot notarize | `--timestamp` (secure, default) |
| `xattr -dr com.apple.quarantine` as the Gatekeeper workaround | Fragile; Apple is closing un-notarized paths on Sequoia+. Breaks for any non-developer user | Proper notarization + `stapler staple` so Gatekeeper passes natively |
| `shutil.which()` alone for host-capability detection from daemons | launchd/GUI processes inherit a minimal PATH; `claude`/`whisper-cli`/`gog` in the user's shell are invisible ⇒ false negatives | Resolve the user's **login-shell PATH** (`$SHELL -lic 'echo $PATH'`), search it + known install dirs (`~/.local/bin`, `/opt/homebrew/bin`, Cargo/npm bins), then `which` |
| A hardcoded `~/Google Drive` / fixed cloud paths | File Provider (macOS 12.3+) moved providers to `~/Library/CloudStorage/<Provider>-<account>`; the path embeds the account and isn't fixed | Glob `~/Library/CloudStorage/*` + check iCloud via `MobileMeAccounts.plist` |
| ScreenCaptureKit for *audio-only* on macOS 14.4+ | Pulls in screen-recording TCC + Sequoia's weekly re-permission nag for a recorder that never needs the screen | Core Audio process taps (`NSAudioCaptureUsageDescription` only) |
| A new throwaway `venv-mlx-whisper` the daemon never uses | CONCERNS 4a — the `mlx_python` field is read but never applied; duplicates host models/runtime | Detect host `mlx-whisper`; if absent, install into the daemon's actual interpreter |
| Adopting a Rust crate (`cpal`/`service-manager-rs`) as a dependency *this* milestone | Adds a third toolchain for a macOS-only deliverable; over-fits the abstraction before Win/Linux are even scoped | Use them as **API references**; keep the impl in Swift (capture) + Python (supervision) |
| Pinning the cross-platform interface to ScreenCaptureKit/launchd concepts | Leaks macOS specifics (window pickers, plist keys, TCC) into the "portable" API, defeating the abstraction | Model `CaptureBackend` on **PCM frames + source list**; model `DaemonManager` on **install/load/unload/status** with a neutral service spec |

## Stack Patterns by Variant

**If targeting macOS 14.4+ (recommended floor for the audio path):**
- Use Core Audio process taps for system audio; `NSAudioCaptureUsageDescription` only.
- Drop the ScreenCaptureKit screen-recording permission walkthrough from setup for the audio path.
- Because: no weekly Sequoia re-permission prompt; cleaner permission model for an always-on recorder.

**If macOS 13.0–14.3 support is still required:**
- Keep ScreenCaptureKit as a second `CaptureBackend` arm behind the same protocol; gate by `ProcessInfo.operatingSystemVersion`.
- Because: taps don't exist before 14.4; the protocol lets both coexist without leaking into callers.

**If the agent-orchestrated provisioning spike succeeds:**
- Expose provisioning as discrete `yulu provision <step>` subcommands the agent calls in sequence; use `uv tool install` for the Python runtime so no preexisting Python is assumed.
- Because: matches the "agent installs Yulu step-by-step, reusing its own capabilities" lock; each step is idempotent and independently retryable.

**If the spike shows agent provisioning is unreliable:**
- Fall back to the verified signed-zip + decomposed `setup_*.sh` scripts, with the agent only invoking the top-level orchestrator + `yulu skill install`.
- Because: the proven release path must remain the safety net (PROJECT.md treats provisioning as "leading direction, validate via spike").

## Version Compatibility

| Component | Version / Floor | Notes |
|-----------|-----------------|-------|
| Core Audio process taps | macOS **14.4+** | `AudioHardwareCreateProcessTap` + `CATapDescription`; requires `NSAudioCaptureUsageDescription`. Raises Yulu's effective floor from 13 → 14.4 for the recommended audio path. |
| ScreenCaptureKit (legacy arm) | macOS 12.3+ (system audio); Sequoia 15+ adds weekly re-prompt | Keep only if 13.x–14.3 support is needed. |
| `mlx-whisper` | 0.4.3 (2025-08-29), Python ≥3.8, Apple Silicon | Already in stack; detect host copy before installing. |
| `cpal` (reference) | 0.17.3 (2024-02); CoreAudio loopback on macOS >14.6 | Reference only; note loopback floor is 14.6, *higher* than the tap floor of 14.4 — taps are the better native choice. |
| `service-manager-rs` (reference) | 0.10, Rust ≥1.58 | Reference only. |
| `actions/attest-build-provenance` | v4+ (now wraps `actions/attest`); Feb 2025 added checksum-file input | New impls may target `actions/attest` directly; `attest-build-provenance` still supported. Public-repo only on free tiers. |
| `gh` CLI | 2.65+ | `gh attestation verify` GA. |
| `uv` | 0.5.x+ | Self-bootstrapping (no system Python needed); `uv tool install` → `~/.local/bin`. |
| `psutil` | 6.1+ | Cross-platform; safe single runtime dep to add. |

## Sources

- developer.apple.com/documentation/screencapturekit/ — SCK system audio (48kHz stereo), app-level filtering — HIGH
- github.com/insidegui/AudioCap — Core Audio process taps require **macOS 14.4+** + `NSAudioCaptureUsageDescription`, audio-only, no screen-recording TCC — HIGH (canonical Apple sample author)
- developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps — `CATapDescription` + `AudioHardwareCreateProcessTap` + aggregate device flow — HIGH
- mjtsai.com/blog/2024/08/08 + developer.apple.com/forums (Sequoia) — SCK triggers ~weekly screen-recording re-permission prompt; purely TCC-gated, no entitlement bypass — MEDIUM/HIGH (multiple corroborating sources)
- developer.apple.com/documentation/security/notarizing-macos-software-before-distribution + developer.apple.com/developer-id/ — Developer ID Application cert, hardened runtime mandatory, notarytool/stapler workflow — HIGH
- scriptingosx.com (notarytool CLI tool) — standalone binaries: notarize via zip, `--wait`; tickets can't staple to bare binaries (staple the `.app`/installer) — HIGH
- github.com/pyinstaller/pyinstaller#4629 + developer.apple.com/forums/thread/133633 — bundled Python `.so`/dylib must be signed; `disable-library-validation` / `allow-unsigned-executable-memory` entitlements; never `--deep`, sign bottom-up — MEDIUM/HIGH
- github.com/chipsenkbeil/service-manager-rs (v0.10) — proven launchd/systemd/sc.exe/WinSW abstraction shape (install/start/stop/uninstall, `ServiceLevel::User`) — HIGH (as API reference)
- github.com/RustAudio/cpal (0.17.3) + issue #876 / PR #894 — CoreAudio loopback (macOS >14.6) under one cross-platform PCM trait; SCK loopback still a PR — HIGH
- brunerd.com (2022) + Apple Support — iCloud root `~/Library/Mobile Documents/com~apple~CloudDocs`; enable-state in `MobileMeAccounts.plist` (`MOBILE_DOCUMENTS`) — HIGH
- tidbits.com (2023) + learn.microsoft.com + Dropbox/Google forums — File Provider era: providers at `~/Library/CloudStorage/<Provider>-<account>` (macOS 12.3+) — HIGH
- huggingface.co/docs/huggingface_hub (cache) — `~/.cache/huggingface/hub`, `models--org--name` layout, `HF_HOME`/`HF_HUB_CACHE`, `scan_cache_dir()` — HIGH
- github.com/anthropics/claude-code#42639 + Apple Developer forums (PATH) — GUI/launchd processes get minimal PATH; must resolve login-shell PATH for capability detection — HIGH
- docs.github.com (artifact attestations) + github.blog/changelog 2025-02-18 — `actions/attest-build-provenance` v4 wraps `actions/attest`; `gh attestation verify`; checksum-file input; public-repo-only on free tiers — HIGH
- docs.astral.sh/uv (tools) — `uvx` ephemeral vs `uv tool install`; self-bootstrapping, no system Python prereq — HIGH
- pypi.org/project/mlx-whisper (0.4.3, 2025-08-29) — HIGH

---
*Stack research for: agent-native cross-platform meeting-recorder provisioning & configuration foundation (Yulu)*
*Researched: 2026-05-29*
