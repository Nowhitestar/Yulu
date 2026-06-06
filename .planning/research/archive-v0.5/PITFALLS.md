# Pitfalls Research

**Domain:** Agent-native, local-first, cross-platform meeting-recorder provisioning & configuration (Yulu — "Agent-Native Provisioning & Cross-Platform Foundation" milestone)
**Researched:** 2026-05-29
**Confidence:** HIGH (macOS signing/notarization, iCloud eviction, SQLite-on-sync, capture migration, launchd portability all verified against official/canonical sources); MEDIUM (the abstraction-shape and agent-provisioning failure modes are design risks, not yet-observed bugs)

> **Scope discipline.** This file does NOT repeat `.planning/codebase/CONCERNS.md` (which catalogues the *existing* fragilities: `--timestamp=none`, `pkill -9`, dead `mlx_python` field, `set -e` without `pipefail`, uncleaned backups, `open -W`, hardcoded paths, capability duplication). It catalogues the **new mistakes this milestone is at risk of introducing** while *fixing* those concerns — the second-order traps of building the abstraction layer, agent provisioning, host-capability reuse, cloud-sync data folder, and seamless migration. Each pitfall cites the CONCERNS item it extends.
>
> **Phase references** use deliverable-topic names (the roadmap may renumber): **P1** Setup decomposition + signing/packaging; **P2** Abstraction seams (`CaptureBackend`/`DaemonManager`/paths/permissions); **P3** Host-capability detection + `doctor.py`; **P4** Agent-orchestrated provisioning (spike → impl); **P5** Data-folder location + cloud-sync + transcription mode; **P6** Seamless auto-migration; **P7** Web-UI settings + onboarding.

## Critical Pitfalls

### Pitfall 1: Speculative cross-platform abstraction that ossifies around macOS concepts

**What goes wrong:**
The "platform-agnostic" `CaptureBackend` / `DaemonManager` / path / permission interfaces get designed *while only the macOS arm is built and exercised*, so they silently leak macOS specifics and freeze the wrong shape. Concretely: `CaptureBackend` grows a `windows: [Window]` source list (a ScreenCaptureKit/AppKit concept — Linux PipeWire and Windows WASAPI-loopback don't enumerate windows for *audio*); `DaemonManager` exposes plist-shaped fields (`KeepAlive` dict, `ThrottleInterval`, `StartInterval`, label strings) that don't translate to systemd `Restart=`/`[Timer]` or Windows Task Scheduler triggers; `check_permissions()` returns a TCC-shaped enum that has no Linux/Windows analog. When Win/Linux is finally scoped (next milestone), the interface needs breaking changes anyway — so the abstraction cost was paid for zero benefit, and worse, it added an indirection layer that obscures the macOS code that actually runs.

**Why it happens:**
You cannot validate an abstraction with one implementation — there's nothing to vary against, so the "interface" is just the macOS implementation with the method names rearranged. The locked decision ("build the abstraction now, macOS-only impl") is correct strategically but creates exactly this trap: the team optimizes for "looks cross-platform" rather than "is honest about what's macOS-specific."

**How to avoid:**
- Model the seams on **proven cross-platform shapes**, not on the current code. STACK.md already did the homework: `CaptureBackend` = "**PCM frames out + flat source list**" (the `cpal` boundary — CoreAudio/WASAPI/ALSA all produce this), NOT "windows." `DaemonManager` = `install/load/unload/status/restart` over a **neutral service spec** (the `service-manager-rs` shape: program path, args, env, run-at-load, keep-alive-bool), NOT plist keys.
- Keep macOS specifics on the **macOS side of the seam**, not in the interface: window enumeration stays an internal detail of the macOS capture impl (it's used by `meeting_detector`, which is itself macOS-coupled via Accessibility — keep that coupling explicit, don't launder it through `CaptureBackend`); plist templating stays inside `MacOSDaemonManager`.
- **Write the stub arm as a thrown `NotImplementedError`, not a "TODO impl."** A stub that raises forces the interface to be expressible without the real backend; a half-written PipeWire stub invites copying macOS assumptions into it.
- Apply the **"two consumers" test** to every interface method: would a *systemd* implementation and a *launchd* implementation both implement this method the same way? If only launchd can, it doesn't belong in the interface.
- Prefer a **capability-flag + thin dispatch** over a deep class hierarchy: `if platform.system() == "Darwin"` at the top of the install path is honest and greppable; a 4-level abstract base class for one concrete subclass is the over-engineering.

**Warning signs:**
- The interface vocabulary contains `window`, `plist`, `launchctl`, `tccutil`, `LaunchAgents`, `KeepAlive`, `Movies` — macOS nouns in a "portable" type.
- The non-macOS stub is more than `raise NotImplementedError(...)` (i.e., someone started "implementing" against assumptions).
- A method on the interface is only ever called from macOS-guarded code.
- The abstraction has exactly one concrete implementation and a > 50-line abstract base.
- PR review can't answer "how would the systemd version implement `status()`?" without inventing semantics.

**Phase to address:** P2 (define seams). Add an explicit "abstraction honesty review" gate to P2's exit criteria: for each interface, document the hypothetical systemd/WASAPI implementation in 2-3 sentences; if you can't, the interface is wrong.

---

### Pitfall 2: macOS notarization fails on nested Python `.so`/dylibs and `--deep` re-breaks it

**What goes wrong:**
The milestone replaces `--timestamp=none` ad-hoc signing (CONCERNS 2c) with real Developer ID signing + notarization — but the first attempt signs the `.app` bundle top-level (or with `--deep`) and `notarytool` rejects it, OR notarization "succeeds" but the app still won't launch on a clean machine because a nested Mach-O (a bundled Python interpreter, or a `.so`/`.dylib` from `mlx` / `numpy` / `sox` if Python is bundled into `Yulu.app`) is unsigned or signed without the hardened runtime. `codesign --deep` (currently in `build_audio_daemon.sh`/`build_status_agent.sh`) is the specific trap: Apple explicitly documents it as wrong — it re-signs nested code with the *outer* identity and *drops per-binary options*, so a previously-correctly-signed dylib gets clobbered and notarization breaks.

**Why it happens:**
Signing is order-sensitive and counterintuitive: you must sign **inner-out (bottom-up)** — every nested Mach-O first, each with `--options runtime --timestamp`, then the bundle last — but `--deep` *looks* like the convenient "sign everything" button and is what the current build scripts already use. The Swift binaries today have *no* embedded third-party dylibs, so signing has been trivial; the moment Python or a model runtime gets bundled (or even if `mlx`'s `.so` files end up inside the app), the bottom-up requirement bites and the failure mode is opaque ("app is damaged" / silent crash on other machines, never on the dev's own notarized-by-default machine).

**How to avoid:**
- **Never `--deep`.** Replace it in both `build_*.sh`. Enumerate nested Mach-O (`find Yulu.app -type f -perm +111` + `file | grep Mach-O`) and sign each with `codesign --options runtime --timestamp --sign "Developer ID Application: …"`, innermost first, bundle last.
- Decide *now* whether Python is **bundled** or **host-provided**. This milestone's whole thesis is "reuse the host's capabilities" — so the daemon's Python interpreter and `mlx-whisper` should be **host/system-resolved, NOT bundled into the signed `.app`**. That sidesteps the hardest notarization case entirely (you only sign the Swift binaries). If anything Python *is* bundled, you need `com.apple.security.cs.disable-library-validation` (load non-Apple-signed dylibs) and possibly `com.apple.security.cs.allow-unsigned-executable-memory` (interpreters JIT) — flag this as a scope expansion.
- **Staple the `.app`/installer, not bare binaries** — `notarytool` tickets can't staple to a lone Mach-O; staple the bundle, and verify with `spctl -a -vvv Yulu.app` + `stapler validate`.
- Test on a **second machine** (or a fresh user account with quarantine intact) before every release — the dev's own machine never reproduces Gatekeeper because locally-built code is implicitly trusted.

**Warning signs:**
- `--deep` still present anywhere in build scripts.
- `notarytool submit` returns `Invalid` with a log mentioning "not signed with a valid Developer ID" or "does not include a secure timestamp" on a *nested* path.
- App launches on dev machine, "is damaged and can't be opened" on a clean machine.
- The build bundles a Python `.so` but the entitlements plist has no `disable-library-validation`.
- `codesign -dvvv` on a nested dylib shows a different TeamIdentifier than the bundle.

**Phase to address:** P1 (signing/packaging is a prerequisite refactor). Make "notarized build verified on a clean machine via `spctl`" a hard P1 exit gate — this also unblocks shipping pre-compiled binaries so `swiftc`/Xcode stops being an install dep (CONCERNS 1d).

---

### Pitfall 3: Raising the macOS floor 13 → 14.4 for Core Audio taps, assuming "Sonoma users are fine"

**What goes wrong:**
The plan migrates system-audio capture from ScreenCaptureKit (12.3+) to Core Audio process taps to escape Sequoia's weekly screen-recording re-permission nag (STACK.md) — but `AudioHardwareCreateProcessTap`/`CATapDescription` require macOS **14.4 specifically**, not "Sonoma." A user on 14.0–14.3 (Sonoma, but pre-14.4) gets a daemon that imports a symbol that doesn't exist → silent capture failure or crash on launch, *after* they've upgraded Yulu. The team reasons "we require Sonoma, Sonoma users are covered" and ships, breaking the slice of users on 14.0–14.3 and **all** users still on macOS 13 (Ventura) — who were perfectly happy on the SCK path.

**Why it happens:**
"macOS 14" and "macOS 14.4" get conflated. Hardware compatibility is a red herring that masks the real cut: dropping to a 14.4 *floor* removes **no additional Macs** beyond what Sonoma already dropped (Sonoma already requires 2018+ Intel / iMac Pro 2017 / Apple Silicon — verified), so "who breaks" is invisible in a hardware-compat table. The breakage is purely by **minor OS version** and by **users who haven't taken the 14.4 point update** — a population that's real and silent.

**How to avoid:**
- **Keep both capture backends behind the `CaptureBackend` seam** (Pitfall 1's seam earns its keep here): Core Audio taps on 14.4+, ScreenCaptureKit on 13.0–14.3. Gate at runtime on `ProcessInfo.processInfo.operatingSystemVersion` (check `>= 14.4`), not at compile time only.
- **Weak-link the tap symbols** and check availability with `@available(macOS 14.4, *)` / `if #available`; never hard-link a symbol that may be absent at the floor.
- Make `doctor.py` and onboarding **report which audio backend is active and why** ("taps unavailable: macOS 14.2 < 14.4, using ScreenCaptureKit") so a user on 14.2 isn't mystified.
- If the team *wants* to drop SCK entirely to simplify, that's a **product decision to abandon macOS 13–14.3 users** — surface it explicitly in PROJECT.md constraints (current floor is "macOS 13+"), don't let it sneak in as an implementation detail.
- Migration (P6) must **detect the running OS and not switch a 14.2 user to taps**; the upgrade must be safe on the *user's* OS, not the dev's.

**Warning signs:**
- Code references `AudioHardwareCreateProcessTap` without an `if #available(macOS 14.4, *)` guard.
- `Package.swift` / build sets deployment target to `14.0` (not `14.4`) but uses tap APIs.
- The plan says "require Sonoma" anywhere (Sonoma ≠ 14.4).
- No SCK fallback arm exists, yet PROJECT.md still says "macOS 13+."
- QA only tests on the dev's machine (latest macOS), never on a 14.2 or 13.x VM.

**Phase to address:** P2 (the `CaptureBackend` seam must accommodate the dual-arm + version gate before the tap migration lands). The actual tap migration can be a sub-task of P2 or a fast-follow; the *seam and version gate* are the P2 deliverable. Decision on whether to keep the 13.x SCK arm is a PROJECT.md constraint update, not an eng choice.

---

### Pitfall 4: launchd semantics baked into the `DaemonManager` interface (the `open -W` quirk, `KeepAlive`, login-shell PATH)

**What goes wrong:**
The `DaemonManager` abstraction faithfully reproduces launchd's quirks as if they were universal, hard-coding three macOS-isms into the "portable" surface:
1. **The `open -W` parent/child split** (CONCERNS 8b): the audiodaemon plist runs `/usr/bin/open -W Yulu.app`, so `launchctl unload` kills `open` but not the `Yulu.app` child, forcing the `pkill -f audio_daemon` workaround. If `DaemonManager.unload()` is defined as "unload the unit," the abstraction inherits the lie that unload stops the process — systemd's `stop` *does* kill the cgroup, so a `DaemonManager` whose contract is "unload ≠ stop" mis-models every other platform and perpetuates the `pkill` hack.
2. **`KeepAlive` semantics**: launchd `KeepAlive` is a *dict* (restart on crash, on path-existence, on network) with throttle; systemd is `Restart=on-failure` + `RestartSec=`; Task Scheduler has no real equivalent. Exposing `keep_alive` as a launchd-shaped dict leaks.
3. **Login-shell PATH**: the `nvm`-rooted Node path baked into plists at install time (CONCERNS 6b) and the minimal GUI/launchd PATH (STACK.md, CONCERNS) get encoded as "set these env vars in the unit," which is a macOS-launchd remedy for a macOS-launchd problem.

**Why it happens:**
launchd is the only supervisor the codebase has ever known, so its peculiarities feel like "how daemons work." The `open -W` design (chosen so `Yulu.app` gets a real GUI session for ScreenCaptureKit/TCC) is itself a macOS-specific workaround that the abstraction would canonize.

**How to avoid:**
- Define `DaemonManager` contracts in **outcome terms, not launchd terms**: `stop()` means "the process is no longer running" (the macOS impl is responsible for the `pkill` cleanup *internally* until the `open -W` design is fixed). Don't expose `load`/`unload` as the public verbs if their macOS meaning ("registered but maybe still running") doesn't generalize — prefer `start`/`stop`/`restart`/`status` and let macOS map them onto launchctl + pkill.
- **Fix the `open -W` design as part of this milestone** (CONCERNS 8b): launch `Yulu.app/Contents/MacOS/audio_daemon` directly with `LSUIElement=true`, so `launchctl bootout` cleanly kills it and `stop()` needs no `pkill`. This removes a data-loss vector (two daemons writing one WAV) *and* makes the macOS impl's `stop()` honest, which keeps the interface honest.
- Model keep-alive as a **boolean + restart policy enum** (`never` / `on-failure` / `always`), translated per-platform; never surface a plist dict.
- Resolve PATH via the **login-shell** at *runtime in the daemon* (`$SHELL -lic 'echo $PATH'`, STACK.md Pattern), not by baking a versioned `nvm` path into the unit at install time (CONCERNS 6b). The neutral service spec carries "inherit login PATH," not a frozen string. This is also what makes host-capability reuse (Pitfall 5) work from inside a daemon.
- Use **`launchctl bootstrap`/`bootout`** (the modern API) rather than deprecated `load`/`unload`; the abstraction should not enshrine the deprecated verbs.

**Warning signs:**
- `DaemonManager` interface has a method named `unload` whose doc says "may not stop the process."
- `keep_alive` parameter type is a dict/JSON rather than an enum/bool.
- The macOS impl still shells `pkill -f` *after* `bootout` (means `open -W` not yet fixed).
- A versioned `nvm` path string appears in any generated unit/plist.
- `launchctl load`/`unload` (deprecated) used instead of `bootstrap`/`bootout`.

**Phase to address:** P2 (DaemonManager seam) — and fold the `open -W` → direct-launch fix (CONCERNS 8b) into P2 so the macOS `stop()` is genuinely clean. The login-shell PATH resolution overlaps P3 (capability detection needs the same mechanism).

---

### Pitfall 5: Host-capability detection false positives — finding a binary/model that exists but the daemon can't actually use

**What goes wrong:**
`doctor.py` is extended to "detect already-configured whisper/claude/models" (the milestone's core thesis) and reports `claude: ✓`, `whisper-cli: ✓`, `mlx-whisper: ✓`, `model: found` — but each is a **false positive**:
- `claude` resolves on the *user's login shell* PATH but not on the *daemon's* PATH (CONCERNS 6b / STACK.md), so `agent_queue_worker` (running under launchd's minimal PATH) can't invoke it — green doctor, broken summaries.
- `mlx-whisper` is importable from the *system python3* the dev tested with, but the **daemon runs under a different interpreter** — this is *exactly the live `mlx_python` dead-field bug* (CONCERNS 4a/6e): the field is read but the daemon imports against `__PYTHON__`. If detection probes the wrong interpreter, it confidently reports a capability the daemon will fail to import.
- A `whisper-cli` is found but it's a **different/incompatible build** (a `whisper.cpp` fork, wrong arch, or a `whisper` PyPI package that is OpenAI-whisper, not whisper.cpp) — version string present, behavior incompatible.
- A model file *exists* at a path but is a **different quantization/format** than the chosen backend expects (a GGML `.bin` found while the MLX backend needs an HF-cached `mlx-community/whisper-*`), or is **truncated/corrupt** (partial HF download), or is **dataless** (evicted by iCloud — see Pitfall 7).

The result: the "reuse host capability" decision fires on a phantom, Yulu *skips* installing/duplicating the thing it actually needed, and the failure surfaces only at the first real recording — silently (the pipeline is best-effort, CONCERNS / ARCHITECTURE error handling).

**Why it happens:**
"Detection" is treated as "does the name resolve?" (`shutil.which`, `command -v`, a glob hit) rather than "can the *specific runtime that will use this* actually use it?" The live `mlx_python` bug proves the team already conflates "installed somewhere" with "usable by the daemon." Reuse-vs-duplicate is a higher-stakes decision than mere reporting, so a false positive is worse than no detection — it suppresses the fallback.

**How to avoid:**
- **Probe through the consumer, not the shell.** For Python importability, run the probe **with the daemon's actual interpreter** (`<daemon_python> -c "import mlx_whisper, sys; print(mlx_whisper.__version__)"`), resolved the *same way the plist resolves `__PYTHON__`*. First fix the `mlx_python` ambiguity (STACK.md: pick (a) venv-as-daemon-interpreter or (b) require it in the daemon's interpreter) so there's a single, known "daemon Python" to probe.
- For binaries the daemon invokes (`claude`, `whisper-cli`, `llm.command`), resolve via the **login-shell PATH + known install dirs**, then verify **the daemon can reach it** by checking against the daemon's actual PATH/env — and **prove it runs**, not just `--version`: a tiny smoke invocation (`whisper-cli --help`, `claude --version`, `echo hi | <llm.command>` dry-run) catches wrong-build/incompatible cases.
- **Validate semantics, not just presence**: for models, check format matches the selected backend (MLX wants HF-cache `models--mlx-community--whisper-*`; whisper.cpp wants a GGML `.bin`), check size against expected (a 3GB large-v3 that's 40MB is a partial download), and check the file is **materialized** (not a 0-byte iCloud placeholder — `st_size` vs `NSURLUbiquitousItemDownloadingStatus`).
- **Distinguish "found and verified" from "found, unverified" in the report** (three states: `usable` / `present-but-unverified` / `absent`), and **only `usable` may trigger reuse-instead-of-install.** A `present-but-unverified` must fall back to install/duplicate, not skip.
- Make the **settings UI show provenance** (what's being reused, from where, and verified-status) so a user can see "Yulu is reusing your `~/.local/bin/claude`" and catch a wrong choice.

**Warning signs:**
- Detection code uses `shutil.which(...)` / `command -v` with no interpreter- or env-scoped re-check.
- The import probe runs under whatever Python `doctor.py` happens to use, not the daemon's.
- Detection records a boolean (`found: true`) rather than a tri-state with a verification method.
- `doctor` is green but the first recording's summary/transcription fails.
- Reuse decision has no fallback path when verification is skipped.
- The `mlx_python` field is still read-but-unused (means the "which interpreter" question is unresolved — detection has no stable target).

**Phase to address:** P3 (host-capability detection + `doctor.py`). **Hard prerequisite:** resolve the `mlx_python` interpreter ambiguity (CONCERNS 4a/6e) *before or within* P3 — detection is meaningless without a defined "daemon interpreter" to probe. Reuse-vs-install decision logic belongs in P3/P4 boundary and must consume the tri-state, not a boolean.

---

### Pitfall 6: Agent-orchestrated provisioning amplifies the `curl|bash` trust problem and skips integrity verification

**What goes wrong:**
The milestone moves install from `curl|bash` to "the host coding agent provisions Yulu step-by-step." This is sold as more agent-native — but it **amplifies** the existing trust gap (CONCERNS 2b): now an *autonomous agent* is fetching and executing install steps, and the human-in-the-loop "do I trust this curl pipe?" moment is gone. Specific failure modes:
- The agent fetches `install.sh`/`release_installer.py` over the same unauthenticated `raw.githubusercontent.com` path (CONCERNS 2b), with only `py_compile` (syntax, not integrity) as a check — so a compromised release or MITM now executes *without* a human even glancing at it.
- Provisioning is **non-idempotent / not partial-failure-safe**: the agent runs step 3 of 7, hits a permission prompt or a network blip, and re-runs from scratch — re-downloading models, re-creating the venv, re-registering launchd units, possibly stacking duplicate daemons or corrupting half-written config. The current `setup.sh` is one linear `set -e` (no `pipefail`) flow (CONCERNS 2a/6c) — splitting it into agent-invoked steps without making each **idempotent and individually retryable** turns one fragile script into seven.
- The agent **assumes its own environment** (its PATH, its Python, its `claude`) is what the *daemons* will have — re-introducing Pitfall 5's PATH/interpreter mismatch at install time.

**Why it happens:**
"Let the agent do it" feels like it removes risk (the agent is careful!) when it actually removes the *human verification checkpoint* and adds an actor that will confidently retry destructive steps. Idempotency is the hardest property to retrofit and the easiest to skip in a spike.

**How to avoid:**
- **Verify provenance before executing anything** (STACK.md): the agent already has `gh`; require `gh attestation verify <asset> -o <org>` (GitHub Artifact Attestations / keyless Sigstore) on the release zip before any step runs, degrading to a published SHA-256 `checksums.txt` when `gh` is absent. This is strictly better than today's `py_compile` and is the *native* agent integrity story — the agent cryptographically confirms Yulu's own CI built the asset.
- **Design every provisioning step to be idempotent and resumable**: each `yulu provision <step>` checks "is this already done correctly?" and is safe to re-run. Record progress in a state file (`.yulu-install.json` with per-step status) so a retry resumes, not restarts. Model on `setup.sh --upgrade`'s existing idempotency intent but make it per-step and machine-readable.
- **Partial-failure recovery is a first-class requirement, not a nice-to-have**: a failed step must leave the system either rolled-back or safely resumable, never half-applied. Daemon registration especially must be "register-or-replace," never "register-again" (guard against duplicate launchd labels → the WAV-write conflict).
- **Keep the verified signed-zip + decomposed `setup_*.sh` as the non-negotiable fallback** (STACK.md, PROJECT.md treats provisioning as "validate via spike"). The spike's job is to *prove* the agent path is at least as safe as the zip path; if it isn't, the zip path stays primary and the agent only invokes the top-level orchestrator + `yulu skill install`.
- **The agent must provision the daemon's environment, not assume its own.** Resolve and record the daemon's interpreter/PATH explicitly (ties to Pitfall 5); don't let "the agent could import mlx_whisper" imply "the daemon can."

**Warning signs:**
- Provisioning fetches over `http`/`raw.githubusercontent.com` with no signature/attestation check.
- A provisioning step has no "already done?" guard (re-running re-downloads or re-registers).
- No per-step state file; failure recovery = "run the whole thing again."
- Daemon registration uses `load` without first `bootout`-ing an existing label (duplicate-daemon risk).
- The spike demonstrates the happy path only; no test kills a step midway and resumes.
- Trust model relies on "the agent is trustworthy" rather than "the artifact is verified."

**Phase to address:** P4 (agent-orchestrated provisioning). The **spike must explicitly test partial-failure/resume and provenance verification**, not just the happy path — make "kill at step N, resume cleanly" and "reject a tampered asset" spike exit criteria. Idempotent step decomposition depends on P1 (setup decomposition); attestation depends on P1's CI changes.

---

### Pitfall 7: Pointing the data folder at iCloud/Google Drive corrupts SQLite and evicts recordings

**What goes wrong:**
The "configurable data folder → point it at iCloud/Google Drive" feature (Obsidian model, locked decision) ships, and users put `~/.config/yulu` *and/or* the recordings dir inside a synced folder. Several distinct data-loss/corruption modes fire:
- **SQLite corruption.** `vocab.sqlite`, `prompts.sqlite`, `search.sqlite` (and their `-wal`/`-shm` sidecars) live inside the synced folder. SQLite's own docs name "**syncing the file via Dropbox/iCloud**" as a corruption cause: the sync client copies the `.sqlite` without its `-wal` (or copies them at different instants), and a DB separated from its WAL loses committed transactions or corrupts. Worse, two machines syncing the same DB = two writers on one file = the classic multi-process WAL corruption (and SQLite had a WAL-reset corruption bug through 3.51.2, fixed 3.51.3 — a synced multi-writer setup is precisely its trigger).
- **iCloud eviction of recordings.** With "Optimize Mac Storage" on, iCloud **evicts** infrequently-accessed files to dataless **placeholders**. A daemon doing a `pread` on an evicted WAV/transcript **blocks in the kernel** until iCloud re-downloads — so transcription/summary stalls or times out, and on a metered/offline connection, *fails*. Recordings are large and infrequently re-read → prime eviction candidates.
- **Lock/socket/PID files in a synced dir.** `audio_daemon.sock`, `stt_daemon.sock`, `.agent-queue.lock`, PID files (all in `~/.config/yulu`, ARCHITECTURE) are **machine-local runtime artifacts** — syncing a Unix socket or an `fcntl` lock across machines is meaningless and actively harmful (a stale PID/lock from machine A appears on machine B; sync churn on the lock file).
- **Partial sync / streaming.** Google Drive "streaming" mode (File Provider, `~/Library/CloudStorage/GoogleDrive-<acct>`) presents files that aren't materialized; a mid-sync `agent-queue.json` may be read half-written despite Yulu's atomic `os.replace` (the replace is atomic *locally*; the sync layer re-uploads/downloads on its own schedule and can present an intermediate state on another machine).

**Why it happens:**
"Sync is the OS's job" (the Obsidian framing) is true for **plain content files** but catastrophically false for **databases, locks, sockets, and large infrequently-read media**. Obsidian itself warns against syncing its workspace/cache via cloud and stores notes as individual Markdown files for exactly this reason. The team adopts the *slogan* without adopting the *constraint* that makes it safe.

**How to avoid:**
- **Separate "syncable" from "machine-local" data physically.** Only **portable content** (the `.md`/`.html` summaries, maybe the WAV/transcript artifacts if the user accepts the tradeoff) goes in the user-chosen (possibly synced) folder. **SQLite DBs, sockets, locks, PID files, logs, caches stay in a fixed local dir** (`~/.config/yulu` or an XDG state dir) that is **never** the synced folder. Make `audio.output_dir` (content) independently configurable from the runtime/state dir (local-only) — and **forbid** the runtime dir from being set to a known cloud root.
- **Detect-and-warn at folder selection** (P5/P7 UI + `doctor.py`): if the chosen data folder resolves under `~/Library/Mobile Documents/com~apple~CloudDocs`, `~/Library/CloudStorage/*`, Dropbox, etc. (STACK.md's cloud-root detection), warn explicitly — and **refuse** to place SQLite/sockets there.
- If SQLite *must* live in a synced dir (it shouldn't): set **`PRAGMA journal_mode=DELETE`** (not WAL) to avoid the separated-WAL failure, accept the concurrency cost, and document single-machine-at-a-time only. Better: keep DBs local and treat them as **rebuildable caches** — `search.sqlite` is already a derived FTS index (re-indexable from summaries); `vocab`/`prompts` are seedable. Design them as local + reconstructable rather than synced + authoritative.
- **Prevent eviction of in-use media**: if recordings live in iCloud, **pin** the active/recent recordings (`com.apple.fileprovider.pinned` xattr — but note Sequoia's Finder pin caps at 10 items; programmatic pinning via the File Provider API is the robust route) so a `pread` during transcription doesn't block on a re-download. Or keep recordings local and only sync the *summaries*.
- **Never sync the runtime dir.** Document and enforce that sockets/locks/PIDs are local. This is a non-negotiable invariant.

**Warning signs:**
- `vocab.sqlite`/`prompts.sqlite`/`search.sqlite` or `*.sock`/`*.lock`/`*.pid` resolve to a path under a cloud-storage root.
- "database disk image is malformed" / "database is locked" errors after the user enabled sync or used two Macs.
- Transcription/summary intermittently hangs for tens of seconds then succeeds (iCloud re-download) — or fails offline.
- A `-wal`/`-shm` file exists in a synced folder without its base DB recently synced.
- Two machines both running Yulu against the same synced data dir.
- WAV present as a 0-byte/dataless placeholder when the daemon tries to read it.

**Phase to address:** P5 (data-folder location + cloud-sync). The **physical separation of content vs. runtime/state dir** is the core P5 design decision and must precede letting users pick a synced folder. Cloud-root detection + warning lands in P5 (`doctor.py`) and surfaces in P7 (settings UI). Treating `search.sqlite` as a rebuildable local cache may need a small P5 refactor.

---

### Pitfall 8: Seamless migration truncates active recordings and never reclaims backup disk

**What goes wrong:**
The "seamless auto-migration of existing v0.5.x `~/.yulu` installs" deliverable runs on `yulu update` and:
- Inherits the **`pkill -9` during upgrade** (CONCERNS 2d): the migration stops daemons with `pkill -9 -f audio_daemon` (needed today because of the `open -W` child-orphan, CONCERNS 8b) **while a recording is active**, truncating the WAV at an OS buffer boundary; the relaunched daemon may then pick up a half-written file that fails transcription. Migration is *more* likely to hit this than a normal update because it touches more state and runs longer.
- Inherits **uncleaned backups** (CONCERNS 2e): each migration creates a `~/.yulu.backup-XXXXXX` full copy (hundreds of MB) that is never deleted — so the *migration* (a one-time, larger operation) leaves the largest orphaned backup yet, and repeated update-migrations stack them.
- **Migrates the wrong assumptions**: copies the old `config.json` forward including the **dead `mlx_python` field** and old hardcoded paths (`~/Movies/Yulu` baked into `status_agent.swift`, CONCERNS 1e/6d), so the "migrated" install carries the same latent bugs — or, worse, the migration "helpfully" moves the data folder and breaks the menu-bar recordings list (which reads `~/Movies/Yulu` directly, ignoring config).
- **No rollback on partial migration failure**: migration is multi-step (config transform + capability re-detection + daemon re-registration + possible data-folder move); a failure midway leaves a half-migrated install with no clean revert, and the never-deleted backup is the *only* recovery — but there's no `yulu rollback` to use it.

**Why it happens:**
"Seamless" is interpreted as "automatic and invisible," which pressures the team to *not* prompt, *not* check recording state, and *not* pause — the opposite of what data safety needs. The existing `pkill -9` and uncleaned-backup behaviors are pre-existing (CONCERNS) and get inherited by default unless the milestone explicitly fixes them.

**How to avoid:**
- **Guard on recording state before stopping anything** (CONCERNS 2d fix): query `audio_daemon.sock` `{"action":"status"}`; if recording is active, **refuse or defer** migration (or drain + graceful-stop first) — analogous to `dev_install.py`'s existing `recording` guard. Never `pkill -9` an active recorder.
- **Fix `open -W` → direct-launch first** (Pitfall 4 / CONCERNS 8b) so migration can `bootout` cleanly and never needs `pkill -9` at all — removing the truncation vector at its root.
- **Implement backup lifecycle as part of migration** (CONCERNS 2e): after a *verified* successful migration, delete backups older than the last 1–2; add `yulu cleanup-backups`. A migration that creates a backup is incomplete until it also defines when that backup dies.
- **Make migration transactional with explicit rollback**: snapshot → migrate steps with per-step state (reuse Pitfall 6's resumable state file) → verify (`doctor` green, daemons up, a smoke transcription) → only then commit and prune backup. On failure, `yulu rollback` restores from the backup automatically. "Seamless" = *reliable and reversible*, not *silent and irreversible*.
- **Migrate data, fix bugs**: the migration is the moment to **drop the dead `mlx_python` field**, **rewrite hardcoded `~/Movies/Yulu`** to honor `audio.output_dir`, and **stamp the new config schema version** — don't copy known-bad config forward verbatim. If the data folder moves, update `status_agent.swift`'s source-of-truth (read config, not hardcoded path) in the same change.
- **Idempotent + version-stamped**: record a `schema_version` / `migrated_at`; re-running migration on an already-migrated install is a no-op, not a re-transform.

**Warning signs:**
- Migration path contains `pkill -9` with no preceding recording-state check.
- No `schema_version` in config; migration can't tell migrated from un-migrated (re-runs re-transform).
- `~/.yulu.backup-*` dirs accumulate after updates (no cleanup ran).
- Migrated `config.json` still contains `mlx_python`; `status_agent.swift` still reads `~/Movies/Yulu` literally.
- No `yulu rollback`; the only recovery from a bad migration is manual.
- "Seamless" implemented as "no prompts, no checks."

**Phase to address:** P6 (seamless auto-migration). **Hard dependencies:** the `pkill -9` recording-state guard and the `open -W` → direct-launch fix (CONCERNS 2d, 8b) must land in P2/P6 *before* migration ships; backup lifecycle (CONCERNS 2e) is part of P6. The resumable-state-file mechanism is shared with P4 (Pitfall 6).

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Build the abstraction interface as "current macOS code, renamed" | Ships fast; "looks cross-platform" | Interface ossifies wrong; needs breaking changes when Win/Linux arrives; indirection hides the only real impl | **Never** — model on `cpal`/`service-manager-rs` shapes instead (Pitfall 1) |
| Capability detection = `shutil.which` / `command -v` boolean | One-liner, "works on my machine" | False positives suppress the install fallback; daemon fails silently at first recording (Pitfall 5) | Only for a *report-only* field that **never** drives reuse-vs-install |
| Keep `--deep` signing, just add a Developer ID | Minimal change to build scripts | Notarization breaks on any nested dylib; opaque "app is damaged" for end users (Pitfall 2) | **Never** — Apple-documented anti-pattern |
| Agent provisioning happy-path only in the spike | Spike "succeeds" quickly | Partial-failure/duplicate-daemon/MITM modes ship to users; one fragile script becomes seven (Pitfall 6) | Only if spike is explicitly labeled "happy-path feasibility" and resume/verify is a *named follow-up* before GA |
| Put everything (DBs, sockets, content) in one user-configurable folder | Simple single setting; matches "Obsidian" slogan | SQLite corruption + socket-sync nonsense + recording eviction (Pitfall 7) | **Never** for DBs/sockets/locks; content-only is the acceptable form |
| Inherit `pkill -9` + uncleaned backups into migration | No new code; reuses existing flow | Active-recording truncation; unbounded disk growth; no rollback (Pitfall 8) | **Never** — migration is the moment to fix these (CONCERNS 2d/2e) |
| Bundle Python + mlx into the signed `.app` | "Self-contained," no host Python dep | Hardest notarization case (sign every `.so`, library-validation entitlements); fights the "reuse host capabilities" thesis | Only if host-provided Python is proven infeasible — contradicts the milestone goal |
| Hard-code `14.0` deployment target with tap APIs | Compiles on the dev's latest macOS | 14.0–14.3 users crash on a missing symbol; silent (Pitfall 3) | **Never** — gate `if #available(macOS 14.4, *)` + keep SCK arm |

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| **iCloud Drive (data folder)** | Assume files are always materialized; let "Optimize Storage" evict in-use recordings → `pread` blocks/fails | Pin active recordings (`com.apple.fileprovider.pinned` / File Provider API; note 10-item Finder cap); keep DBs/sockets out; or sync summaries only (Pitfall 7) |
| **Google Drive (File Provider)** | Hard-code `~/Google Drive`; assume streamed files are local | Glob `~/Library/CloudStorage/GoogleDrive-<acct>` (STACK.md); never put SQLite/sockets there; expect non-materialized files |
| **SQLite × any folder sync** | Sync `.sqlite` (WAL mode) across machines / sync without `-wal` sidecar | Keep DBs local + rebuildable; if unavoidable, `journal_mode=DELETE`, single-machine; require SQLite ≥ 3.51.3 (WAL-reset corruption fix) |
| **launchd (`DaemonManager`)** | Treat `unload` as "process stopped"; bake `nvm` versioned PATH into plists; use deprecated `load`/`unload` | `stop()` = process gone (macOS impl owns cleanup); resolve login-shell PATH at runtime; use `bootstrap`/`bootout`; fix `open -W` → direct launch (Pitfall 4) |
| **Apple notarization (`notarytool`)** | `--deep` sign; staple a bare binary; test only on dev machine | Sign bottom-up `--options runtime --timestamp`; staple the `.app`/installer; verify `spctl` on a clean machine (Pitfall 2) |
| **GitHub Releases (agent provisioning)** | Agent fetches over `raw.githubusercontent.com`, `py_compile` as the only check | `gh attestation verify -o <org>` (Sigstore) before executing; SHA-256 `checksums.txt` fallback (Pitfall 6) |
| **Host `claude`/`whisper-cli`/`llm.command`** | `--version` succeeds → assume usable by the daemon | Probe with the *daemon's* PATH/interpreter; smoke-run, not just version; tri-state (usable/unverified/absent) (Pitfall 5) |
| **`gog` (Google Calendar CLI)** | Assume Homebrew/`steipete tap` distribution exists everywhere (CONCERNS 1f) | Detect+reuse host `gog`; treat its macOS-only Homebrew distribution as a platform-coupling fact behind the dependency-install seam |

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Recordings in iCloud get evicted → transcription blocks on re-download | Summary pipeline stalls 10–60s or times out; worse offline/metered | Pin active media; keep recordings local, sync summaries only | After a few weeks of accumulated recordings (eviction targets infrequently-read files) |
| `search.sqlite` synced + re-indexed on two machines | FTS index corruption; "database disk image is malformed" | Treat as local rebuildable cache; never sync | First time a user opens Yulu on a second synced Mac |
| `agent-queue.json` never pruned (CONCERNS 7c) — and now possibly in a synced dir | File grows unbounded; sync re-uploads the whole file on every append | Prune `done` entries; keep queue local (it's runtime state, not content) | Hundreds of meetings; or immediately under sync (every append = full re-sync) |
| Backup dirs accumulate (CONCERNS 2e), amplified by per-update migration | `~/` fills with `~/.yulu.backup-*` copies | Backup lifecycle in migration; `yulu cleanup-backups` | Every `yulu update`; faster with migrations |
| Capability re-detection on every daemon start (login-shell PATH probe is a subprocess) | Slow daemon startup; `$SHELL -lic` spawned repeatedly | Cache resolved PATH/capabilities in state file; re-probe on `doctor`/explicit refresh, not every boot | Many daemons (8) each probing on every launchd respawn |

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Agent auto-executes unverified install assets (amplified `curl|bash`, CONCERNS 2b) | MITM / compromised release runs code with no human checkpoint, autonomously | `gh attestation verify` (Sigstore provenance) before any execution; SHA-256 fallback (Pitfall 6) |
| Transcripts/summaries land in a cloud-synced folder by default | Private meeting content silently leaves the machine — violates the "audio + transcripts stay local by default" constraint | Local-by-default; cloud sync strictly opt-in + explicit per PROJECT.md; warn loudly at folder selection |
| `agent-queue.json` (transcript snapshots) world-readable + unpruned (CONCERNS 7c), now possibly synced | Meeting content accumulates indefinitely and may sync off-machine | Keep queue local; prune `done` entries; 0600 perms; never place in synced dir |
| Disabling library validation broadly to make a bundled Python load | Weakens the hardened runtime; any injected dylib loads | Prefer host-provided Python (no bundling); if bundling, scope entitlements minimally and document (Pitfall 2) |
| Migration copies OAuth creds / tokens into a new (possibly synced) data dir | Google Calendar credentials leave the machine | Keep credentials in Keychain (CONCERNS 7a); migration must not relocate secrets into the content folder |

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| "Seamless" migration = silent + irreversible | User can't tell it ran, can't undo a bad one, loses an active recording | Reliable + reversible: recording-state guard, progress, `yulu rollback` (Pitfall 8) |
| Green `doctor` while recording silently fails (capability false positive) | User trusts the health check, loses meeting summaries with no error | Tri-state detection + smoke-runs + surfaced provenance in settings (Pitfall 5) |
| User on macOS 14.2 silently gets no audio after upgrade (tap floor) | Recorder appears dead, no explanation | Report active backend + reason ("14.2 < 14.4 → using SCK"); keep SCK arm (Pitfall 3) |
| User points data folder at iCloud, recordings vanish/stall | Looks like data loss; transcription hangs | Detect cloud root, warn, separate DBs/sockets out, pin media (Pitfall 7) |
| Onboarding asks the user to configure what the agent already has | Friction; duplicates models/runtimes the host already provides (the milestone's whole anti-thesis) | First-run reuses detected host capabilities by default; settings show what's reused vs. installed |
| Settings UI shows "whisper: configured" with no path/source | User can't tell which whisper/model is in use or fix a wrong choice | Show provenance: which binary, which model dir, verified status |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Cross-platform abstraction:** Often missing the *honesty test* — verify each interface method by writing the 2-3-sentence systemd/WASAPI implementation; if you can't, it's leaking macOS (Pitfall 1).
- [ ] **Signed/notarized build:** Often missing clean-machine verification — verify `spctl -a -vvv` and launch on a *second* Mac with quarantine intact, not the dev's machine (Pitfall 2).
- [ ] **Tap migration:** Often missing the version gate + SCK fallback — verify `if #available(macOS 14.4, *)` and test on a 14.2 and a 13.x VM (Pitfall 3).
- [ ] **DaemonManager.stop():** Often missing the actual process kill — verify `stop()` leaves *zero* `audio_daemon` processes (no orphaned `open -W` child) (Pitfall 4).
- [ ] **Capability detection:** Often missing consumer-scoped verification — verify the probe runs under the *daemon's* interpreter/PATH and includes a smoke-run, not just `--version` (Pitfall 5).
- [ ] **Agent provisioning:** Often missing resume + provenance — verify a killed-at-step-N run resumes cleanly and a tampered asset is rejected (Pitfall 6).
- [ ] **Data folder:** Often missing the content/runtime split — verify SQLite/sockets/locks are *never* placeable in the synced folder, and a cloud-root selection warns (Pitfall 7).
- [ ] **Seamless migration:** Often missing the recording guard, backup cleanup, and rollback — verify migration refuses during an active recording, prunes old backups, and `yulu rollback` works (Pitfall 8).
- [ ] **`mlx_python` resolution:** Often still read-but-unused — verify the daemon's interpreter is defined and detection probes *it* (CONCERNS 4a/6e; blocks Pitfall 5).
- [ ] **Skill decoupling:** Often still inside `setup.sh` — verify `yulu skill install [--agent]` runs standalone and idempotently, removed from the core flow (CONCERNS 3a).

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Abstraction ossified wrong (Pitfall 1) | MEDIUM | Caught early (one impl) it's a cheap rename; caught after Win/Linux work it's a breaking interface change — re-model on `cpal`/`service-manager-rs`, migrate the macOS impl behind the corrected seam |
| Notarization broken by nested dylib / `--deep` (Pitfall 2) | LOW–MEDIUM | Strip `--deep`, re-sign bottom-up, re-submit `notarytool`; if Python was bundled, switch to host-provided Python (also fixes the thesis) |
| Shipped tap build that crashes 14.2 users (Pitfall 3) | HIGH (already in users' hands) | Hotfix release adding the `#available` gate + SCK fallback; the silent-failure population must be reached via update — costly, hence prevent in P2 |
| Duplicate daemons writing one WAV (Pitfall 4/6) | MEDIUM | `bootout` all labels, `pkill` stragglers, fix `open -W` → direct launch, re-register once; audit for corrupted WAVs from the conflict window |
| Capability false positive in production (Pitfall 5) | LOW | Add smoke-run verification, re-run `doctor`, flip the reuse decision to install-fallback; corrupt/partial models: delete + re-fetch |
| Tampered/failed agent provisioning (Pitfall 6) | MEDIUM | Resume from per-step state file or roll back via backup; add attestation gate; re-run from last good step |
| SQLite corruption from sync (Pitfall 7) | HIGH for authoritative DBs, LOW for caches | `search.sqlite`: delete + re-index from summaries (it's derived). `vocab`/`prompts`: restore from backup or re-seed. Then move DBs out of the synced dir permanently |
| Migration truncated an active recording (Pitfall 8) | HIGH (data lost) | The truncated WAV may be partially salvageable via `ffmpeg` re-mux; the un-truncated audio is gone — hence the recording-state guard is mandatory, not best-effort |
| Backups filled the disk (Pitfall 8 / CONCERNS 2e) | LOW | `yulu cleanup-backups`; keep last 1–2; add the lifecycle so it doesn't recur |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls. (Phase topics; roadmap may renumber.)

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1. Speculative abstraction ossifies | **P2** (seams) | "Honesty review": each interface method has a credible systemd/WASAPI impl sketch; stub arms only `raise NotImplementedError`; no macOS nouns in interface types |
| 2. Notarization / `--deep` / nested dylibs | **P1** (signing/packaging) | `spctl -a -vvv` passes + app launches on a clean second machine; no `--deep` in build scripts; decision logged on bundled-vs-host Python |
| 3. macOS 14.4 tap floor breakage | **P2** (CaptureBackend dual-arm + version gate); PROJECT.md constraint update | Runs on 14.2 and 13.x VMs (SCK fallback); `#available(macOS 14.4, *)` guards all tap symbols; backend+reason reported |
| 4. launchd semantics in DaemonManager | **P2** (DaemonManager) + fold in CONCERNS 8b fix | `stop()` leaves zero processes; `bootstrap`/`bootout` (not `load`/`unload`); no versioned `nvm` path in units; `keep_alive` is enum/bool |
| 5. Capability false positives | **P3** (detection/doctor); reuse-decision at P3/P4 | Probe uses daemon's interpreter/PATH; smoke-run present; tri-state report; only `usable` triggers reuse; `mlx_python` ambiguity resolved first |
| 6. Agent provisioning trust + idempotency | **P4** (provisioning spike → impl); depends on P1 | Spike proves: kill-at-step-N resumes; tampered asset rejected (`gh attestation verify`); duplicate-daemon guard; zip path remains fallback |
| 7. Cloud-sync corruption/eviction | **P5** (data folder) + P7 (settings UI surfacing) | SQLite/sockets/locks never placeable in synced folder; cloud-root selection warns; recordings pinned or summaries-only; DBs rebuildable-local |
| 8. Migration data loss + backups | **P6** (migration); depends on P2/P6 fixes for 2d/8b/2e | Migration refuses during active recording; prunes old backups; `yulu rollback` restores; config schema-versioned; dead `mlx_python`/hardcoded paths fixed in transit |

**Cross-phase dependencies (ordering implications):**
- **P1 before P4** — agent provisioning's idempotent steps + attestation depend on setup decomposition (CONCERNS 2a) and CI signing (CONCERNS 2c).
- **`open -W` → direct-launch fix (CONCERNS 8b) before P6** — clean `stop()` removes the `pkill -9` truncation vector that migration would otherwise inherit (Pitfalls 4 & 8).
- **`mlx_python` interpreter resolution (CONCERNS 4a/6e) before/within P3** — detection is meaningless without a defined "daemon interpreter" to probe (Pitfall 5).
- **P5 content/runtime separation before exposing folder picker** — must not let users select a synced folder for DBs/sockets (Pitfall 7).
- **P3 tri-state detection before P4 reuse-vs-install decision** — a boolean can't safely drive "skip install" (Pitfalls 5 & 6).

## Sources

- sqlite.org/howtocorrupt.html + sqlite.org/wal.html — "syncing the file via Dropbox/iCloud" named as a corruption cause; WAL must travel with the DB; multi-process WAL checkpoint corruption; WAL-reset bug fixed in 3.51.3 (2026-03-13) — HIGH
- eclecticlight.co (Sonoma/Sequoia iCloud series: 2023-10-25, 2023-11-21, 2024-03-11, 2024-09-30) — "Optimize Mac Storage" eviction → dataless placeholders; `pread` on a dataless file blocks in the kernel; Sequoia pinning via `com.apple.fileprovider.pinned` xattr (10-item Finder cap) — HIGH
- support.apple.com/en-us/105113 + everymac.com macOS 14 compat — Sonoma requires 2018+ Intel / iMac Pro 2017 / Apple Silicon; raising floor 13→14.4 drops no *additional* hardware — the cut is by minor version (taps need 14.4) — HIGH
- developer.apple.com/documentation/security/notarizing-macos-software + Apple Developer forums + pyinstaller#4629 — never `--deep`; sign nested Mach-O bottom-up with `--options runtime --timestamp`; staple the bundle not bare binaries; `disable-library-validation`/`allow-unsigned-executable-memory` for bundled Python — HIGH (via STACK.md verification)
- github.com/insidegui/AudioCap + developer.apple.com Core Audio taps docs — `AudioHardwareCreateProcessTap`/`CATapDescription` require macOS 14.4+, `NSAudioCaptureUsageDescription`, no screen-recording TCC — HIGH (via STACK.md)
- github.com/chipsenkbeil/service-manager-rs (v0.10) + github.com/RustAudio/cpal (0.17.3) — proven cross-platform abstraction shapes (install/start/stop/status; PCM-frames + source list) — HIGH (as design reference)
- docs.github.com artifact attestations + `gh attestation verify` — keyless Sigstore provenance for release assets; agent-friendly integrity — HIGH (via STACK.md)
- .planning/codebase/CONCERNS.md (2026-05-29) — existing fragilities this file extends: 2a/2b/2c/2d/2e, 1d/1e/1f, 3a, 4a, 6b/6c/6d/6e, 7a/7c, 8b — AUTHORITATIVE (project map)
- .planning/codebase/ARCHITECTURE.md (2026-05-29) — daemon inventory, IPC paths, `~/.config/yulu` runtime artifacts, atomic-write patterns — AUTHORITATIVE
- .planning/research/STACK.md (2026-05-29) — chosen tooling and its documented traps (signing, taps, login-shell PATH, cloud roots, attestation) — AUTHORITATIVE (sibling research)

---
*Pitfalls research for: agent-native cross-platform meeting-recorder provisioning & configuration foundation (Yulu)*
*Researched: 2026-05-29*
