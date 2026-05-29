# Codebase Concerns

**Analysis Date:** 2026-05-29

---

## 1. macOS/Platform Coupling — Blocks Cross-Platform Milestone

**Severity: Critical** — Every sub-item must be resolved or abstracted before cross-platform work can begin.

### 1a. Swift Binaries Use macOS-Exclusive Frameworks

**Issue:** `audio_daemon.swift` (843 lines) and `status_agent.swift` (865 lines) import `ScreenCaptureKit`, `AVFoundation`, `Cocoa`, `CoreMedia`, `CoreAudio`, and `Carbon` — all macOS-only. `window_scanner.swift` uses `Cocoa`. `recorder_status.swift` uses `Cocoa`.
- Files: `yulu/scripts/audio_daemon.swift`, `yulu/scripts/status_agent.swift`, `yulu/scripts/window_scanner.swift`, `yulu/scripts/recorder_status.swift`
- Impact: These four binaries are the entire audio capture and status-bar stack. There is no Linux/Windows equivalent for ScreenCaptureKit system audio. The entire capture layer must be re-architected for cross-platform.
- Fix approach: Introduce a `CaptureBackend` abstraction protocol; implement a macOS backend (Swift/ScreenCaptureKit) and stub a Linux backend (e.g. PipeWire). Keep Swift binaries as macOS-only, guarded by a platform capability flag.

### 1b. launchd + `~/Library/LaunchAgents` as the Only Daemon Manager

**Issue:** All 10 daemons are deployed exclusively as launchd plists under `~/Library/LaunchAgents/`. `dev_install.py`, `doctor.py`, `repair_permissions.py`, `setup.sh`, and `release_installer.py` all call `launchctl load/unload` directly.
- Files: `yulu/scripts/com.yulu.audiodaemon.plist`, `yulu/scripts/com.yulu.sttdaemon.plist`, `yulu/scripts/com.yulu.ui.plist`, `yulu/scripts/com.yulu.agentqueue.plist`, `yulu/scripts/com.yulu.scheduler.plist`, `yulu/scripts/com.yulu.detector.plist`, `yulu/scripts/com.yulu.statusagent.plist`, `yulu/scripts/com.yulu.calendar.plist`, `yulu/scripts/dev_install.py`, `yulu/scripts/doctor.py`
- Impact: All daemon lifecycle management is hardwired to macOS launchd. Linux (systemd/supervisor) and Windows (Task Scheduler/NSSM) require separate orchestration paths.
- Fix approach: Wrap launchd calls behind a `DaemonManager` abstraction with `install()`, `load()`, `unload()`, `status()` methods. macOS implementation uses launchctl; others can use systemd units or supervisor configs.

### 1c. TCC Permission Model (ScreenCapture, Microphone)

**Issue:** `setup.sh` calls `tccutil reset ScreenCapture com.yulu.audiodaemon` and `tccutil reset Microphone com.yulu.audiodaemon`. `repair_permissions.py` repeats this. The entire permission walkthrough is macOS-specific.
- Files: `yulu/scripts/setup.sh` (lines 456–469), `yulu/scripts/repair_permissions.py`
- Impact: The interactive setup flow, upgrade idempotency checks, and doctor repair instructions are all TCC-specific. Non-macOS platforms have entirely different permission models.
- Fix approach: Gate TCC calls behind `if [[ "$(uname)" == "Darwin" ]]`; add a `check_permissions()` abstraction that reports platform-appropriate status.

### 1d. `swiftc` Compiled at Install Time

**Issue:** `setup.sh:compile_scanner()` and `setup.sh:compile_audio_daemon()` run `swiftc` during installation against `window_scanner.swift` and the full `audio_daemon.swift`/`status_agent.swift` stack. `dev_install.py:_compile_helpers()` also invokes `swiftc`. The `install.sh` pre-flight requires Xcode CLI tools.
- Files: `yulu/scripts/setup.sh` (lines 349–493), `yulu/scripts/dev_install.py` (lines 175–188), `yulu/scripts/build_audio_daemon.sh`, `yulu/scripts/build_status_agent.sh`
- Impact: Compiling Swift at install time means `swiftc` (Xcode ~11 GB) is a hard runtime dependency on user machines. Cross-platform installs cannot use this path.
- Fix approach: Pre-compile and ship binaries in release archives (already partially done via `Yulu.app` / `StatusAgent.app` in the zip). The upcoming milestone should remove `compile_audio_daemon()` from `setup.sh` for release installs, keeping it only for `--dev` builds.

### 1e. `~/Library/`, `~/.config/yulu`, `~/Movies/Yulu` Hard-Coded Paths

**Issue:** macOS-specific paths appear throughout:
- `~/Library/LaunchAgents/` — 6+ files
- `~/Movies/Yulu` — hardcoded as recording default in `setup.sh:34`, `yulu/scripts/status_agent.swift:98–99`, `yulu/scripts/uninstall.sh:106`; status_agent.swift reads this path at runtime without consulting `config.json`'s `audio.output_dir`
- `~/.config/yulu` — used in all Python scripts, Swift files, and all plists
- Files: `yulu/scripts/status_agent.swift:98`, `yulu/scripts/setup.sh:34`, `yulu/scripts/doctor.py:21`, `yulu/scripts/dev_install.py:24`
- Impact: `status_agent.swift` hardcodes `~/Movies/Yulu` for the recordings menu instead of reading `config.json`. If users change `audio.output_dir`, the menu bar shows an empty list. Cross-platform paths (`XDG_DATA_HOME`, etc.) are not considered.
- Fix approach: Pass `YULU_CONFIG_DIR` and `YULU_OUTPUT_DIR` environment variables to all processes (already half-done via plist `EnvironmentVariables`). Fix `status_agent.swift` to read `config.json` for `output_dir`.

### 1f. Homebrew as Hard Install Dependency

**Issue:** `setup.sh:install_deps()` unconditionally runs `brew install sox ffmpeg whisper-cpp terminal-notifier` and `brew install steipete/tap/gogcli cloudflared`. If Homebrew is absent it is installed via `curl | bash` (Homebrew's own installer).
- Files: `yulu/scripts/setup.sh` (lines 94–140)
- Impact: Homebrew does not exist on Linux or Windows. `gogcli` (Google Calendar CLI) only ships via Homebrew's steipete tap. The entire dependency install step needs a platform-conditional implementation.
- Fix approach: Abstract into `install_deps_macos()` / `install_deps_linux()`. Linux alternatives: `apt`/`dnf` for ffmpeg; whisper-cpp from source or Docker image; gogcli needs an alternative distribution channel.

---

## 2. Install/Setup Fragility

**Severity: High** — Complicates every install/upgrade path in the milestone.

### 2a. `setup.sh` is 1,342 Lines / 48 KB — Monolithic and Fragile

**Issue:** `yulu/scripts/setup.sh` is a 48,724-byte interactive bash script that mixes system checks, package installs, Swift compilation, config generation, TCC resets, launchd management, model downloads, and skill registration in one sequential flow. It uses `set -e` but NOT `set -uo pipefail`, meaning unbound variables and pipe failures are silently ignored.
- Files: `yulu/scripts/setup.sh`
- Impact: Any step failing mid-run leaves the system in an indeterminate state. Testing individual steps is difficult. Adding cross-platform logic will make this worse. The missing `pipefail` means `brew install ... | tail -1` failures are swallowed.
- Fix approach: Decompose into per-concern scripts (`setup_audio.sh`, `setup_models.sh`, `setup_launchd.sh`, etc.) that can be called independently. Add `set -uo pipefail`. The upcoming milestone should treat setup.sh decomposition as a prerequisite.

### 2b. `curl | bash` Trust Model — No Signature Verification

**Issue:** The primary install method (`install.sh:11`) is `curl -fsSL https://...install.sh | bash`. The helper is then fetched via another unauthenticated HTTP request from `raw.githubusercontent.com` (line 147). The only integrity check is `python3 -m py_compile` (syntax only, not content).
- Files: `install.sh` (lines 11–13, 147–175)
- Impact: A MITM or a compromised GitHub account could serve malicious code. This is the standard curl-install risk, but it is especially relevant when the upcoming milestone adds agent-orchestrated provisioning (the agent would be automating the same insecure path).
- Fix approach: Provide a `--verify` mode that checks a published SHA-256 or GPG signature of `install.sh` before execution. Alternatively, serve the installer via a signed GitHub release asset.

### 2c. Unsigned / Un-notarized Binaries — `--timestamp=none`

**Issue:** `build_audio_daemon.sh:79` and `build_status_agent.sh:64` use `codesign --force --deep --timestamp=none`. The `--timestamp=none` flag means no secure timestamp is embedded; binaries are not notarized. Gatekeeper quarantine is stripped via `xattr -dr com.apple.quarantine` in `setup.sh:426`.
- Files: `yulu/scripts/build_audio_daemon.sh` (line 79), `yulu/scripts/build_status_agent.sh` (line 64), `yulu/scripts/setup.sh` (line 426)
- Impact: macOS Sequoia and future versions increasingly restrict un-notarized binaries. The xattr strip works today but is fragile — Apple may close this path. Distribution to other users (not just the developer) is blocked by Gatekeeper without notarization.
- Fix approach: Obtain an Apple Developer ID, add notarization to `package.sh`. For now, document this limitation explicitly. The upcoming milestone's CI packaging should target notarized release builds.

### 2d. `pkill -9` in Setup — Data-Loss Risk

**Issue:** `setup.sh:438` runs `pkill -9 -f "Yulu.app/Contents/MacOS/audio_daemon"` unconditionally during upgrade, immediately killing the daemon without a graceful shutdown. Active recordings are truncated.
- Files: `yulu/scripts/setup.sh` (line 438)
- Impact: If `yulu update` is run during a recording, the WAV file is truncated at the OS buffer boundary. The subsequent launchd restart may pick up a half-written file that fails transcription.
- Fix approach: Check recording state via the Unix socket (`{"action":"status"}`) before killing; refuse upgrade if recording is active, or drain and stop gracefully first (analogous to `dev_install.py:238`'s `recording` guard).

### 2e. Backup Directories Are Never Cleaned Up

**Issue:** `release_installer.py:replace_runtime_with_backup()` comment explicitly states "Keep successful-install backups for manual recovery **until a later cleanup policy exists**." Every `yulu update` creates a `~/.yulu.backup-XXXXXX` sibling directory that is never deleted.
- Files: `yulu/scripts/release_installer.py` (lines 363–365)
- Impact: Repeated updates accumulate full copies of `~/.yulu` (~hundreds of MB each) in `~/.` indefinitely.
- Fix approach: After a confirmed successful setup, delete backups older than the last 1–2 upgrades. Add a `yulu cleanup-backups` subcommand or integrate into `yulu update`.

---

## 3. Skill-Install Coupling

**Severity: High** — The milestone explicitly requires decoupling.

### 3a. `setup.sh` Runs Skill Registration as Part of Core Install

**Issue:** `install_agent_skill()` is step 7 of `setup.sh`'s linear install sequence (line 1333). It calls `npx -y skills add $REPO_DIR -g "${agent_args[@]}" -y` against the source checkout path, coupling the skill install to the core install.
- Files: `yulu/scripts/setup.sh` (lines 962–1018, 1333)
- Impact: Installing the skill for a specific agent (e.g., hermes/leizi) is mixed into the core Yulu setup. Users without Node.js silently skip it. When the milestone introduces agent-orchestrated provisioning, the skill install must be an independent, idempotent step the agent itself can invoke.
- Fix approach: Extract `install_agent_skill` into a standalone `yulu skill install [--agent <name>]` subcommand. Remove from the main `setup.sh` flow. The agent can call this directly after core install.

### 3b. `sync_skill.py` Has Hardcoded Personal Paths

**Issue:** `sync_skill.py:12–13` hardcodes `DEFAULT_HERMES = Path.home() / ".hermes/skills/leizi/yulu/SKILL.md"` and `DEFAULT_L_SKILLS = Path.home() / "Documents/Codebase/l-skills/skills/yulu/SKILL.md"` — paths specific to Lewis's machine.
- Files: `yulu/scripts/sync_skill.py` (lines 12–13)
- Impact: `sync_skill.py` is checked into the public repo with user-specific defaults. Any other user running it gets silent "unchanged" output since those paths don't exist for them, masking the real agent-skill locations. This also conflicts with the vercel-labs/skills path convention.
- Fix approach: Remove `DEFAULT_HERMES` and `DEFAULT_L_SKILLS`. Read agent skill locations from config or environment. Or deprecate `sync_skill.py` entirely in favour of the vercel-labs/skills toolchain.

### 3c. `doctor.py` has no Legacy Path Reference Cleanup

**Issue:** `doctor.py:22` defines `DEFAULT_LEGACY_ROOT = Path.home() / ".openclaw/workspace/meeting-assistant/yulu"` — a leftover from a previous install location. `dev_install.py:23` repeats it.
- Files: `yulu/scripts/doctor.py` (line 22), `yulu/scripts/dev_install.py` (line 23)
- Impact: The legacy path check is vestigial. Any new developer's machine will never have `.openclaw/...` but doctor still scans and reports on it. More importantly, it sets a precedent for stale path coupling that the milestone must not repeat.
- Fix approach: Remove the legacy root concept from doctor and dev_install. If migration detection is needed, implement it via `.yulu-install.json` `source` field inspection.

---

## 4. Config/Capability Duplication Risk

**Severity: High** — Directly addressed by the upcoming milestone.

### 4a. Yulu Builds its Own `venv-mlx-whisper` Despite Host May Already Have mlx-whisper

**Issue:** `setup.sh:install_mlx_whisper()` creates `~/.config/yulu/venv-mlx-whisper/` and installs `mlx-whisper` into it. The path is hardcoded into `config.json` as `transcription.mlx.python`. However, `stt_daemon/config.py` reads `mlx_python` but the field is **never used** to select the Python interpreter for the daemon — the daemon is launched by the plist using `__PYTHON__` (the system Python3), not the venv Python. The `mlx-whisper` package must therefore be importable from the system Python3 (not the venv) for the stt_daemon's `MlxWhisperBackend` to work.
- Files: `yulu/scripts/setup.sh` (lines 607–619), `yulu/scripts/stt_daemon/config.py` (line 23), `yulu/scripts/stt_daemon/__main__.py`, `yulu/scripts/com.yulu.sttdaemon.plist`
- Impact: `mlx_python` in `DaemonConfig` is a dead config field — it is loaded but never passed to the MLX backend, which does `importlib.import_module("mlx_whisper")` against whatever Python is running the daemon (the system Python3 from `__PYTHON__`). Users may have mlx-whisper installed globally or in another venv; Yulu duplicates it anyway.
- Fix approach: Either (a) use the venv Python as the daemon interpreter in the plist, or (b) remove the venv creation and document that `mlx-whisper` must be in the system Python3. The milestone should discover the host's existing mlx-whisper installation via `doctor.py` and avoid duplicating it.

### 4b. Yulu Brew-Installs `whisper-cpp` — May Duplicate Host Agent's Whisper

**Issue:** `setup.sh:133` runs `brew install whisper-cpp` unconditionally regardless of whether `whisper-cli` is already on PATH. The host coding agent (e.g., claude-code with codex) may already have whisper-cpp or a different whisper binary configured.
- Files: `yulu/scripts/setup.sh` (line 133)
- Impact: Duplicate binaries, potential version conflicts. The upcoming milestone's "reuse already-configured host-agent capabilities" goal is directly blocked — Yulu will silently install its own version instead of detecting the host's.
- Fix approach: Check `command -v whisper-cli` and version before `brew install`. Expose the discovered path in `doctor.py`'s capability report so the settings UI can show what's in use.

### 4c. Yulu Manages Its Own Model Directory — Duplicates Host Models

**Issue:** `~/.config/yulu/models/` stores GGML model files (ggml-large-v3.bin at ~3 GB). The MLX models are cached in Hugging Face's `~/.cache/huggingface/hub/` (not Yulu-specific). A host with a coding agent that already uses mlx-whisper or whisper.cpp will have these models twice.
- Files: `yulu/scripts/setup.sh` (lines 621–675), `yulu/scripts/configure.py` (line 11)
- Impact: Wasteful disk usage. No detection of pre-existing models at standard paths.
- Fix approach: The milestone's settings UI should include a model selector that browses `~/.cache/huggingface/` and known whisper.cpp model directories in addition to `~/.config/yulu/models/`. Doctor should report model paths and sizes.

### 4d. `doctor.py` Does Not Check Host Agent Capabilities

**Issue:** `doctor.py:collect_report()` checks `python3`, `ffmpeg`, `ffprobe`, `swiftc`, `codex`, `gh` — but does NOT check: `claude` CLI, `whisper-cli` binary, MLX availability, `mlx-whisper` importability from the daemon's Python, or the configured LLM command validity.
- Files: `yulu/scripts/doctor.py` (lines 262–269)
- Impact: The upcoming milestone requires doctor to surface host agent capabilities (whisper/claude/models/gog). Currently it cannot tell the settings UI whether a host whisper or claude is available, or whether the configured `llm.command` is resolvable.
- Fix approach: Add capability checks: `_check_command("claude", ["--version"])`, `_check_command("whisper-cli", ["--version"])`, mlx-whisper importability, configured llm.command validity. Add a `host_capabilities` section to the JSON report.

---

## 5. Doctor Health-Check Gaps

**Severity: Medium** — Directly required by the milestone (surface capabilities in settings UI).

### 5a. No Check for `whisper-cli` or MLX Availability

**Issue:** Despite being the two transcription backends, neither `whisper-cli` nor `mlx_whisper` importability are checked by `doctor.py`.
- Files: `yulu/scripts/doctor.py` (lines 262–269)
- Impact: `yulu doctor` can pass while the stt_daemon silently fails to transcribe because `mlx_whisper` is not installed in the interpreter running the daemon.
- Fix approach: Add `_check_command("whisper-cli", ["--version"])` and a Python import probe for `mlx_whisper` using `python3 -c "import mlx_whisper; print(mlx_whisper.__version__)"`.

### 5b. No Check for Configured LLM Command

**Issue:** `doctor.py` checks `codex --version` globally, but does NOT validate the per-config `llm.command` (which may point to `claude`, a custom binary, or `codex_llm.py`).
- Files: `yulu/scripts/doctor.py`, `yulu/scripts/agent_queue_worker.py` (lines 63–73)
- Impact: Misconfigured `llm.command` is invisible until the first meeting recording completes and the queue worker fails silently.
- Fix approach: Add an `llm_command` check to `collect_report()` that loads `config.json`, resolves the command, and verifies the binary exists.

### 5c. No Recording Directory Check

**Issue:** `doctor.py` does not verify that `audio.output_dir` (from `config.json`) exists, is writable, or has sufficient disk space. `status_agent.swift` reads `~/Movies/Yulu` directly without checking `config.json`.
- Files: `yulu/scripts/doctor.py`, `yulu/scripts/status_agent.swift` (lines 98–99)
- Impact: Silent failures when the recording directory is missing or full. The settings UI cannot warn users.
- Fix approach: Add an `audio_output_dir` check: read `config.json`, stat the directory, check `shutil.disk_usage`.

### 5d. `check_yulu_ui` Uses Source Root Rather Than Runtime Root

**Issue:** `doctor.py:check_yulu_ui()` calls `script_dir / "yulu_ui"` where `script_dir` defaults to `DEFAULT_SOURCE_ROOT / "yulu/scripts"`. For production installs where `source_root != runtime_root` (e.g. `~/.yulu`), the UI dist check looks in the source checkout, not the installed runtime.
- Files: `yulu/scripts/doctor.py` (lines 189–244), specifically `collect_report()` line 296: `"yulu_ui": check_yulu_ui(source_root / "yulu" / "scripts", config_dir)`
- Impact: `doctor.py --json` may report `dist_server_present: false` for runtime installs even when the UI is working, and vice versa.
- Fix approach: Pass `runtime_root / "yulu/scripts"` (not `source_root`) to `check_yulu_ui`.

---

## 6. Known Bugs and TODOs

**Severity: Medium**

### 6a. Feishu Calendar Integration Unimplemented (TODO)

**Issue:** `check_meetings.py:_fetch_feishu()` (line 56) contains `# TODO: 实现具体 API 调用` and returns `[]`. The Feishu calendar type is exposed in `config.json` but never does anything.
- Files: `yulu/scripts/check_meetings.py` (lines 49–69)
- Impact: Users who configure `"type": "feishu"` in their calendar config get no data silently. Doctor does not surface this gap.
- Fix approach: Either implement the Feishu API or remove the Feishu calendar type from the config schema and documentation.

### 6b. `nvm`-Rooted Node Path Baked into Plists at Install Time

**Issue:** `setup.sh:852` computes `launch_path` by calling `node -v` at install time and baking the NVM path into every plist's `PATH` env var: `$HOME/.nvm/versions/node/$(node -v 2>/dev/null)/bin`. If Node is upgraded or NVM version changes after install, all Python-based launchd services lose the correct Node path and must be reinstalled.
- Files: `yulu/scripts/setup.sh` (line 852), `yulu/scripts/dev_install.py` (lines 86–99)
- Impact: `com.yulu.agentqueue.plist` PATH becomes stale after any Node version upgrade, causing the worker to fail to find `codex` or `claude`. The plist must be regenerated via `yulu update`.
- Fix approach: Use `$HOME/.nvm/alias/default/bin` (symlink to current default) rather than the versioned path. Or prefer `/opt/homebrew/bin/node` / system node when possible.

### 6c. `set -e` Without `pipefail` in `setup.sh`

**Issue:** `setup.sh:9` uses `set -e` alone without `set -o pipefail` or `set -u`. Pipe failures (e.g., `brew install ... | tail -1` failing) are silently ignored. Unbound variable accesses in bash functions produce empty strings rather than errors.
- Files: `yulu/scripts/setup.sh` (line 9)
- Impact: Silent failures during install are misreported as success. Hard to diagnose.
- Fix approach: Change to `set -euo pipefail`. Review each pipe in the script for side effects.

### 6d. `status_agent.swift` Hardcodes `~/Movies/Yulu` — Ignores `config.json`

**Issue:** The recent recordings menu in the status bar uses hardcoded paths `~/Movies/Yulu/voicemails` and `~/Movies/Yulu` (lines 98–99) regardless of what `audio.output_dir` is set to in `config.json`.
- Files: `yulu/scripts/status_agent.swift` (lines 96–118)
- Impact: If a user configures a different recording directory, the status bar menu shows an empty "Recent Recordings" list. No error is reported.
- Fix approach: Shell out to `python3 -c "import json; print(json.load(open('~/.config/yulu/config.json'))['audio']['output_dir'])"` or pass `YULU_OUTPUT_DIR` via `EnvironmentVariables` in the plist.

### 6e. `mlx_python` Config Field Is Read But Never Used

**Issue:** `stt_daemon/config.py` reads `mlx_python` from `config.json` (line 45) but `stt_daemon/__main__.py` and `MlxWhisperBackend` never use it. The daemon is launched with `__PYTHON__` from the plist, meaning `mlx-whisper` must be importable from that interpreter, not the venv.
- Files: `yulu/scripts/stt_daemon/config.py` (line 23, 45), `yulu/scripts/stt_daemon/__main__.py`
- Impact: Users who install mlx-whisper in the venv (`~/.config/yulu/venv-mlx-whisper/`) but not in the system Python3 will see the stt_daemon fail to import mlx_whisper with no informative error.
- Fix approach: Either use `mlx_python` as the daemon interpreter in the plist, or document the requirement clearly and add a doctor check.

---

## 7. Security Considerations

**Severity: Medium**

### 7a. Google Calendar OAuth Credentials Stored Unencrypted

**Issue:** `setup.sh:787` copies `client_secret.json` to `~/.config/gcp/client_secret.json` as a plain file. The OAuth token cache from `gog auth add` is also stored on disk.
- Files: `yulu/scripts/setup.sh` (line 787)
- Impact: Any process with user-level file access can read the OAuth credentials. On macOS, using the system Keychain would be more appropriate.
- Current mitigation: File permissions default to user-only (0600 if created by gog).
- Recommendations: Store credentials in macOS Keychain or at minimum verify 0600 permissions are enforced.

### 7b. Cloudflared Quick Tunnel Exposes Webhook Publicly

**Issue:** `run_calendar_services.py` starts a `cloudflared quick tunnel` to a random public URL and registers it with Google Calendar for push notifications. The public URL changes each restart.
- Files: `yulu/scripts/run_calendar_services.py`
- Impact: The public URL is protected only by a `webhook_token` query parameter stored in `~/.config/yulu/.state.json`. The token is a random UUID but is not rotated on restart.
- Current mitigation: Token present in URL; cloudflared encrypts the tunnel.
- Recommendations: Rotate the webhook token on each cloudflared restart. Consider persistent cloudflared tunnels with fixed URLs.

### 7c. Agent Queue JSON is Append-Only and World-Readable

**Issue:** `~/.config/yulu/agent-queue.json` accumulates all meeting transcripts (as `transcript_path` / `prompt_content_snapshot` fields) and is never pruned.
- Files: `yulu/scripts/agent_queue_worker.py` (line 25)
- Impact: Meeting content accumulates indefinitely. Any process that can read `~/.config/yulu/` has access to all meeting transcripts.
- Current mitigation: Directory is under `~/.config/` with default macOS user-only permissions.
- Recommendations: Add a rotation/prune policy (e.g., delete `done` entries older than 30 days). Consider encrypting queue entries containing transcript content.

---

## 8. Fragile Areas

### 8a. `release_installer.py:extract_release_zip` Relies on `external_attr` Permission Bits

**Issue:** `release_installer.py:334–348` re-applies Unix permission bits from zip `external_attr` after Python's `zipfile.extractall()` drops them. This was added to fix "Launchd job spawn failed" for exec bits on `Yulu.app` / `StatusAgent.app`. If `package.sh` ever produces a zip without correct `external_attr` values, exec bits are silently lost.
- Files: `yulu/scripts/release_installer.py` (lines 334–348), `packaging/scripts/package.sh`
- Impact: Silent breakage — launchd attempts to spawn a non-executable binary and fails with no obvious log message.
- Safe modification: Any change to `package.sh`'s zip creation must verify that `external_attr` contains mode bits. Add a CI check that inspects the produced zip.

### 8b. `com.yulu.audiodaemon.plist` Uses `open -W` — launchctl Cannot Kill Child

**Issue:** The audiodaemon plist uses `ProgramArguments: ["/usr/bin/open", "-W", "Yulu.app"]`. launchd manages the `open` process but Yulu.app is a child of it. `launchctl unload` kills `open` but not the Yulu.app child — requiring `pkill -f audio_daemon` as a workaround in `setup.sh:438` and `repair_permissions.py:80–87`.
- Files: `yulu/scripts/com.yulu.audiodaemon.plist`, `yulu/scripts/setup.sh` (lines 437–438), `yulu/scripts/repair_permissions.py` (lines 79–87)
- Impact: Upgrade and repair flows are more complex than necessary. If `pkill` misses the process, two audio daemon instances can run simultaneously, causing WAV write conflicts.
- Fix approach: Change the plist to launch `Yulu.app/Contents/MacOS/audio_daemon` directly (set `LSUIElement=true` in Info.plist to suppress Dock icon). Then `launchctl unload` kills the process cleanly.

### 8c. `install_plist()` in `setup.sh` is Duplicated in `install_yulu_ui()`

**Issue:** `setup.sh:841–869` defines `install_plist()` as a local function inside `install_launchagents()`. `install_yulu_ui()` (lines 1071–1089) duplicates the same `cp` + `sed` logic because `install_plist` is not in scope.
- Files: `yulu/scripts/setup.sh` (lines 841–869, 1071–1089)
- Impact: If the sed replacement tokens change, both copies must be updated. This is the kind of drift that causes subtle plist misconfiguration.
- Fix approach: Move `install_plist` to module scope at the top of `setup.sh`.

---

## 9. Missing Critical Features (Milestone Blockers)

### 9a. No Cross-Platform Daemon Manager Abstraction

**Issue:** There is no abstraction layer between "manage a daemon" and "call launchctl". Every daemon lifecycle operation is a direct launchctl call.
- Blocks: cross-platform abstraction layer milestone phase.

### 9b. No Host Capability Detection/Discovery

**Issue:** Neither `doctor.py` nor any other script probes the host for pre-existing whisper, claude, mlx-whisper, or model installations. The setup always overwrites/duplicates.
- Blocks: "reuse already-configured host-agent capabilities" milestone goal.

### 9c. Settings UI Has No Capability Surfacing Endpoint

**Issue:** The `yulu_ui` settings page designs reference displaying active whisper backend, model, and LLM command. The `doctor.py` JSON output does not include `whisper-cli`, `claude`, or `mlx_whisper` checks, so the settings page has no data to show.
- Blocks: settings UI health/capability display milestone phase.
- Files: `yulu/scripts/yulu_ui/src/`, `yulu/scripts/doctor.py`

---

## 10. Test Coverage Gaps

### 10a. No Tests for `setup.sh` Logic

**Issue:** The 1,342-line `setup.sh` has zero automated tests. Interactive steps (TCC prompts, model downloads) are untestable as-is.
- Files: `yulu/scripts/setup.sh`
- Risk: Regressions in install/upgrade paths are only caught by manual testing.
- Priority: High

### 10b. `doctor.py` Tests Don't Cover New Check Functions

**Issue:** `tests/test_doctor.py` exists but is narrow. `check_yulu_ui`, `check_stt_daemon`, and `check_search_index` are tested but the `_overall_ok` logic and the missing capability checks (whisper-cli, mlx, llm.command) have no test coverage.
- Files: `tests/test_doctor.py`, `yulu/scripts/doctor.py`
- Risk: Capability check regressions go undetected until runtime.
- Priority: Medium

### 10c. No Integration Tests for install/update Round-Trip

**Issue:** `tests/test_dev_install.py` tests `dev_install.py` but there are no tests that simulate a full release install (`release_installer.py` → `setup.sh`) in a sandboxed environment.
- Files: `tests/test_dev_install.py`
- Risk: Release packaging bugs (missing exec bits, wrong zip layout) only surface at release time.
- Priority: Medium

---

*Concerns audit: 2026-05-29*
