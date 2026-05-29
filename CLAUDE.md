<!-- GSD:project-start source:PROJECT.md -->
## Project

**Yulu (语录)**

Yulu is a local-first, **agent-first** native meeting recorder for macOS. It captures system audio (ScreenCaptureKit) and microphone locally, transcribes on-device (MLX Whisper / whisper.cpp), and hands the transcript to the user's own coding agent (Claude Code, Codex, OpenClaw…) — via a local `agent-queue.json` boundary — to produce the meeting note. No cloud transcription, no account, no virtual audio device; the audio never leaves the laptop unless the user opts in.

Its mental model is **Obsidian-like**: Yulu is the local data + capture layer, the coding agent is the intelligence layer, and both are local-first. Yulu is built *for an agent as its runtime*, not for an OS — so it reuses capabilities the host agent already has rather than reconfiguring its own.

**Core Value:** A meeting said out loud becomes a clean, searchable note **entirely on the user's machine, through the agent they already trust** — capture and transcription never depend on the cloud, and Yulu never makes the user reconfigure what their agent already provides.

### Constraints

- **Platform**: macOS 13+ today — but architecture must NOT hard-couple to macOS; a cross-platform abstraction layer is a first-class deliverable this milestone.
- **Privacy**: audio + transcripts stay local by default; any cloud (transcription or sync) is strictly opt-in and user-configured.
- **Agent-native**: reuse host coding-agent capabilities (`claude`/whisper/models/`gog`); do not duplicate runtimes/models the agent already has.
- **Compatibility**: existing v0.5.x `~/.yulu` installs must auto-migrate seamlessly on upgrade.
- **Distribution**: keep release-please + GitHub Releases + Conventional Commits as the release mechanism.
- **Agents targeted (v1)**: Claude Code, Codex, OpenClaw — behind one capability-provider abstraction.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- Python 3 (≥3.8, `python3` on system PATH) — all daemon scripts, STT engine, agent queue, calendar, installer, CLI
- Swift 5 (Xcode CLI tools `swiftc`) — `audio_daemon.swift`, `window_scanner.swift`, `recorder_status.swift`, `status_agent.swift`
- TypeScript 5.6 — `yulu_ui` server (`src/`) and web front-end (`web/src/`)
- Bash — `install.sh`, `setup.sh`, `uninstall.sh`, `build_audio_daemon.sh`, `build_status_agent.sh`, `packaging/scripts/package.sh`, `packaging/scripts/checksums.sh`, `yulu/scripts/yulu` CLI shim
## Runtime
- macOS only (enforced at install time via `uname -s == Darwin`)
- Production: macOS 13+ (ScreenCaptureKit requirement)
- Architecture: ARM64 (Apple Silicon) primary; whisper.cpp path supports Intel
- Python: system `python3` (no pinned version file) + isolated venv at `~/.config/yulu/venv-mlx-whisper/`
- Node: npm (lockfile `yulu/scripts/yulu_ui/package-lock.json` present)
- Homebrew: brew for system-level deps (see below)
- Node: `package-lock.json` present — `npm ci` used in CI and setup
- Python: no `requirements.txt` or lockfile; mlx-whisper installed via `pip install --upgrade mlx-whisper` into the isolated venv
## Frameworks
- stdlib only — `asyncio`, `sqlite3`, `socket`, `subprocess`, `json`, `pathlib`, `http.server`, `wave`, `fcntl`
- `numpy` — used in `echo_cancel.py` for audio processing (only external Python dep in main scripts)
- `mlx-whisper` — installed into `~/.config/yulu/venv-mlx-whisper/`; imported in-process by `stt_daemon/backends/mlx.py`; model downloaded lazily from HuggingFace on first transcription
- Hono 4.6 — HTTP server framework (`src/server.ts`)
- tRPC 11 — type-safe RPC between server and React front-end (`src/trpc.ts`, `src/routers/`)
- React 18.3 + React Router 7 — SPA (`web/src/`)
- TanStack Query 5.59 — data fetching (`@tanstack/react-query`)
- better-sqlite3 11.5 — SQLite access from Node (`src/db.ts`)
- wavesurfer.js 7.8 — audio waveform playback in browser
- Zod 3.23 — schema validation
- ws 8.18 — WebSocket server
- Python: `pytest` (installed into `.venv-ci` in CI; `make pytest`)
- Node: Vitest 3, `@testing-library/react`, `jsdom`, `mock-socket`, Playwright (e2e)
- Node: Vite 6 (web front-end), esbuild 0.25 (server bundle via `esbuild.config.mjs`), tsx (dev server hot-reload), concurrently
- Swift: `swiftc` from Xcode CLI tools — no Xcode project file; direct invocation
- Bash: `packaging/scripts/package.sh` uses `rsync` + `zip` for release asset
## Key Dependencies
- `mlx-whisper` (venv) — on-device transcription for Apple Silicon; `mlx-community/whisper-large-v3-mlx` or `whisper-large-v3-turbo` downloaded from HuggingFace
- `better-sqlite3` — powers prompts.sqlite, vocab.sqlite, search.sqlite from Node UI server
- `hono` + `@trpc/server` — define the entire local API surface consumed by the React SPA
- `@tanstack/react-query` — all server state in the SPA
- `react-router` v7 — SPA routing
- `zod` — shared schema validation between server and client
- `wavesurfer.js` — audio playback in meeting/voicemail views
## Configuration
- No `.env` files in the codebase; all runtime config via `~/.config/yulu/config.json`
- `config.example.json` (`yulu/scripts/config.example.json`) is the authoritative schema reference
- Key config sections: `audio`, `transcription`, `llm`, `output`, `calendars`, `meeting_detection`, `stt_daemon`, `status_agent`
- `llm.command` controls which LLM backend runs summaries (`null` = agent-queue mode; `["claude","--print"]` = Claude CLI; `["python3", "codex_llm.py"]` = Codex shim; any list = custom)
- `yulu/scripts/yulu_ui/tsconfig.json` — TypeScript compiler config (ES2022 target, strict)
- `yulu/scripts/yulu_ui/web/vite.config.ts` — Vite config for web front-end (proxy to `:7777`)
- `yulu/scripts/yulu_ui/esbuild.config.mjs` — server bundle config (platform=node, target=node20, externalize `better-sqlite3`)
- `yulu/scripts/yulu_ui/vitest.config.ts` + `vitest.workspace.ts` — test config
- `Makefile` — top-level dev tasks: `make test`, `make package TAG=vX.Y.Z`, `make checksums`, `make dev-install`, `make sync-skill`
## Homebrew System Dependencies
- `sox` — audio check / fallback processing
- `ffmpeg` — audio format fallback
- `whisper-cpp` (`whisper-cli` binary) — whisper.cpp transcription backend; GGML model files (~1.1–3.0 GB) downloaded from HuggingFace `ggerganov/whisper.cpp` at setup time
- `terminal-notifier` — macOS system notifications (`notify.py`, `agent_queue_worker.py`)
- `steipete/tap/gogcli` (`gog` binary) — Google Calendar CLI; handles OAuth and calendar event queries
- `cloudflared` — exposes local webhook server (`port 8899`) as a public HTTPS tunnel for Google Calendar push notifications
## Bundled vs Downloaded vs Brew-installed
| Asset | How provided |
|-------|-------------|
| `yulu/scripts/Yulu.app` | **Compiled at install** via `build_audio_daemon.sh` + `swiftc`; **pre-built binary included in release zip** |
| `yulu/scripts/StatusAgent.app` | Same as above via `build_status_agent.sh` |
| `yulu/scripts/window_scanner` | **Compiled at install** via `swiftc`; not in release zip |
| `~/.config/yulu/venv-mlx-whisper/` | **Created at install** by `setup.sh`; `mlx-whisper` pip-installed into it |
| `~/.config/yulu/models/ggml-*.bin` | **Downloaded at install** from `huggingface.co/ggerganov/whisper.cpp` |
| `mlx-community/whisper-*-mlx` model | **Downloaded lazily** by `mlx-whisper` from HuggingFace on first transcription call |
| `sox`, `ffmpeg`, `whisper-cli`, `terminal-notifier`, `gog`, `cloudflared` | **Brew-installed** by `setup.sh` |
| `yulu_ui/dist/` | **Built at install** via `npm ci && npm run build` |
| Python scripts (`yulu/scripts/*.py`) | **Included in release zip** |
| `install.sh` | **Fetched at install time** from `raw.githubusercontent.com` by `release_installer.py` |
## Release / Packaging Toolchain
- `VERSION` file at repo root (e.g. `0.5.1`); managed by `release-please`
- `yulu/scripts/version.py` — reads `VERSION`, exposes `--check` / `--json` / `--short`
- Compiles `Yulu.app` and `StatusAgent.app` via `build_audio_daemon.sh` / `build_status_agent.sh`
- Uses `rsync` (or `tar` fallback) to stage repo into `dist/yulu/`, excluding `.git`, `.github`, `tests`, `docs/superpowers`, `packaging`, build artifacts
- Reproducible timestamps (all files set to `202001010000`)
- Zips staged tree as `dist/yulu-macos-arm64-vX.Y.Z.zip`
- `packaging/scripts/checksums.sh` writes SHA-256 `checksums.txt`
- Runs on `macos-latest`
- Bash syntax check (`bash -n`) on all shell scripts
- Python syntax check (`py_compile`) on all `*.py`
- Python unit tests (pytest in venv)
- Doctor JSON smoke test
- Version sanity (`version.py --check`)
- Swift build of all four `.swift` files
- Skill manifest frontmatter check
- Separate `yulu_ui` job: `npm ci` → typecheck → Vitest → `npm run build` → artifact verification
## Platform Requirements
- macOS (arm64 recommended)
- Xcode Command Line Tools (`xcode-select --install`) — required for `swiftc`
- Homebrew
- Python 3 (system)
- Node.js 20+ (for `yulu_ui`)
- Installed to `~/.yulu/` (or custom `$INSTALL_DIR`)
- Runtime config and models in `~/.config/yulu/`
- Recordings default to `~/Movies/Yulu/`
- LaunchAgents in `~/Library/LaunchAgents/` (`com.yulu.*` plists)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## Python Style
### File Header Pattern
#!/usr/bin/env python3
### Naming Patterns
### Type Annotations
- `recording_lock.py`: `RecordingLockHandle`
- `release_installer.py`: `ReleaseTarget(frozen=True)`, `ReleaseAsset(frozen=True)`, `InstallMetadata(frozen=True)`
- `stt_daemon/protocol.py`: all message types (`TranscribeRequest`, `STTResult`, etc.)
- `stt_daemon/runtime.py`: `STTResult`, `TranscribeDispatchResult`
### Module Entry Point Pattern
## Error Handling
### Silent Fallback on I/O
### Exception Catch Specificity
- Subprocess calls catch bare `Exception` (timeout + OSError variants) and return a sentinel `(999, "", str(exc))` tuple — see `_run()` in `doctor.py`.
- Lock contention raises a typed exception `RecordingBusy` with attached metadata (`recording_lock.py`).
- Doctor check functions (`check_stt_daemon`, `check_search_index`, `check_yulu_ui`) **never raise**; they always return a dict with an `"error"` key so JSON consumers can rely on shape.
### Atomic Writes
## Logging / Notify Patterns
### Simple Script Logging (agent_queue_worker, queue_store)
### stt_daemon Structured JSON Logger
### Swift Logging (status_agent.swift)
### macOS Notifications (notify.py)
## Config Schema Conventions
- Credentials are **never in config.json**: OAuth and API keys are referenced by env var name (e.g. `"app_id_env": "FEISHU_APP_ID"`, `"api_key_env": "NOTION_API_KEY"`).
- Paths use `~` prefix, expanded at runtime via `expanduser()`.
- Nested `"note"` strings within JSON objects serve as inline documentation.
- `"enabled": false` disables optional integrations without removing config.
- `"command": null` in `llm` section means "use agent-queue mode" (not a real null command).
## Versioning Conventions
- `read_version(path) -> str` — reads VERSION, returns `"0.0.0+unknown"` on missing file.
- `validate_version(version) -> bool` — matches `^\d+\.\d+\.\d+(?:-...)(?:\+...)?$`.
- `version_info(repo_dir, version_path) -> dict` — assembles full metadata including git commit, dirty flag, tag, and `.yulu-install.json` install source.
- `format_version(info, short=False) -> str` — human string like `"Yulu 0.5.1 (abc1234, release v0.5.1)"`.
## launchd Plist Conventions
| Placeholder | Substituted Value |
|-------------|-------------------|
| `__SCRIPT_DIR__` | Absolute path to `yulu/scripts/` |
| `__HOME__` | `$HOME` |
| `__PYTHON__` | Path to `python3` |
| `__NODE_BIN__` | Path to `node` |
| `__PATH__` | `~/.local/bin:~/.nvm/.../bin:/opt/homebrew/bin:...` |
## doctor.py Health-Check Conventions
## Shell Script Conventions
## Swift Conventions
## Import Organization
## Comments
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## System Overview
```text
```
## Daemon Inventory
| launchd Label | Process | Language | Keep-Alive | IPC surface |
|---|---|---|---|---|
| `com.yulu.audiodaemon` | `Yulu.app/Contents/MacOS/audio_daemon` | Swift | Yes | `~/.config/yulu/audio_daemon.sock` (Unix socket, JSON) |
| `com.yulu.statusagent` | `StatusAgent.app/Contents/MacOS/status_agent` | Swift | Yes | none (menu-bar LSUIElement) |
| `com.yulu.sttdaemon` | `python -m stt_daemon` | Python asyncio | Yes | `~/.config/yulu/stt_daemon.sock` (Unix socket, JSON lines) |
| `com.yulu.agentqueue` | `agent_queue_worker.py` | Python | StartInterval=30s | `~/.config/yulu/agent-queue.json` (JSON file, fcntl-locked) |
| `com.yulu.detector` | `meeting_detector.py daemon` | Python | Yes | `audio_daemon.sock` (read-only window query) |
| `com.yulu.scheduler` | `scheduler_daemon.py` | Python | Yes | `~/.config/yulu/schedule.json` + SIGHUP |
| `com.yulu.calendar` | `run_calendar_services.py` | Python | Yes | writes `schedule.json`, SIGHUPs scheduler |
| `com.yulu.ui` | `node yulu_ui/dist/server.js` | Node.js | Yes | HTTP :7777 + tRPC + WebSocket |
## Component Responsibilities
| Component | Responsibility | File |
|---|---|---|
| `audio_daemon` (Swift) | ScreenCaptureKit system audio + AVFoundation mic capture; exposes start/stop/status/windows over Unix socket | `yulu/scripts/audio_daemon.swift`, `yulu/scripts/Yulu.app/` |
| `status_agent` (Swift) | Menu-bar icon, recording indicator, global hotkey for voicemail | `yulu/scripts/status_agent.swift`, `yulu/scripts/StatusAgent.app/` |
| `stt_daemon` | Resident MLX Whisper / whisper-cli; two-slot scheduler (interactive + background); vocab injection; live session streaming | `yulu/scripts/stt_daemon/` (ADR-001) |
| `agent_queue_worker` | **Sole LLM dispatcher**: claims `summary_request` events from `agent-queue.json`, renders prompt snapshot, runs `llm.command`, writes `.summary.md`, updates `SummariesRepo` | `yulu/scripts/agent_queue_worker.py` (ADR-004) |
| `meeting_detector` | Polls macOS window titles via `audio_daemon.sock` or `window_scanner`; detects meeting apps; prompts user to record | `yulu/scripts/meeting_detector.py` |
| `scheduler_daemon` | Heap-based event timer; fires `remind`/`ask_record`/`ask_stop` by forking `notify.py` or `meeting_daemon.py` | `yulu/scripts/scheduler_daemon.py` |
| `run_calendar_services` | Manages `cloudflared` tunnel, registers Google Calendar push webhooks, writes `schedule.json`, SIGHUPs scheduler | `yulu/scripts/run_calendar_services.py` |
| `yulu_ui` | Local web UI (Hono+tRPC+React); reads config, SQLite DBs, launchctl state; tails logs via WebSocket; proxies IPC calls to audio daemon | `yulu/scripts/yulu_ui/` |
| `transcribe.py` | Pure enqueuer: requests final transcription from `stt_daemon`, then appends one `summary_request` per `is_auto_run` prompt to `agent-queue.json` | `yulu/scripts/transcribe.py` |
| `realtime_transcribe.py` | Thin daemon-subscriber: connects to `stt_daemon.sock`, receives partial events, writes `<audio>.realtime.transcript.txt`; spawned by `record_audio.py` (ADR-003) | `yulu/scripts/realtime_transcribe.py` |
| `record_audio.py` | Recording controller: sends start/stop to `audio_daemon.sock`; manages `realtime_transcribe.py` subprocess lifecycle; calls `transcribe.py` on stop | `yulu/scripts/record_audio.py` |
| `meeting_daemon.py` | CLI interface for manual recording, schedule management, ask_record dialogs | `yulu/scripts/meeting_daemon.py` |
| `vocab` module | SQLite `vocab.sqlite` CRUD; seeded from `vocab/seed.py`; `VocabCache` injected into `stt_daemon` at transcription time (ADR-002) | `yulu/scripts/vocab/` |
| `prompts` module | SQLite `prompts.sqlite` prompt catalog; `SummariesRepo` provenance table; `PromptsCache` + `render()` helpers; seeded from `prompts/seed.py` (ADR-004) | `yulu/scripts/prompts/` |
| `search` module | SQLite `search.sqlite` full-text index of transcripts and summaries; `indexer.upsert_doc()` called as write hook in `agent_queue_worker.py` | `yulu/scripts/search/` |
| `voicemail` module | Voicemail-specific recorder, repo, CLI; reuses agent-queue pipeline for `voicemail-todos` prompt | `yulu/scripts/voicemail/` |
| `window_scanner` (Swift) | Standalone binary to enumerate macOS window titles (Accessibility API); fallback for `meeting_detector` when `audio_daemon.sock` not available | `yulu/scripts/window_scanner.swift`, compiled to `yulu/scripts/window_scanner` |
| `yulu` CLI | Bash dispatcher to all subcommands; symlinked to `~/.local/bin/yulu` | `yulu/scripts/yulu` |
## Data Flow
### Primary: Audio Capture → Transcript → Summary
### STT Daemon Internal Request Path
### Calendar → Schedule → Recording Prompt
### External Agent Integration (agent-queue boundary)
## IPC Communication Map
| From | To | Channel | Protocol |
|---|---|---|---|
| `record_audio.py` | `audio_daemon` | `audio_daemon.sock` (Unix socket) | JSON request / JSON response |
| `meeting_detector.py` | `audio_daemon` | `audio_daemon.sock` | `{"action":"windows"}` → `{"windows":[...]}` |
| `yulu_ui` (Node) | `audio_daemon` | `audio_daemon.sock` | `ipc.ts` → `ipcSend()` |
| `realtime_transcribe.py` | `stt_daemon` | `stt_daemon.sock` | JSON lines (subscribe/partial/unsubscribe) |
| `transcribe_client.py` | `stt_daemon` | `stt_daemon.sock` | JSON lines (TranscribeRequest/Response) |
| `stt_cli.py` | `stt_daemon` | `stt_daemon.sock` | JSON lines (health, warm-up, cancel) |
| `transcribe.py` | `agent_queue_worker` | `agent-queue.json` (file) | fcntl-locked JSON append |
| `run_calendar_services.py` / `check_meetings.py` | `scheduler_daemon` | `schedule.json` + SIGHUP | file write + signal |
| `yulu prompts ...` | `agent_queue_worker` | PID file + SIGHUP | signal (SIGHUP → PromptsCache reload) |
| `yulu vocab ...` | `stt_daemon` | SIGHUP | signal (→ VocabCache reload) |
## Install / Lifecycle Flow
```
```
## ADR to Component Mapping
| ADR | Decision | Primary Component |
|---|---|---|
| ADR-001 (`001-resident-stt-daemon.md`) | Single resident `stt_daemon` with two-slot scheduler; all STT via Unix socket | `yulu/scripts/stt_daemon/`, `com.yulu.sttdaemon` plist |
| ADR-002 (`002-vocab-sqlite-single-source.md`) | Single `vocab.sqlite` with `prompt`/`replace`/`both` scope; SIGHUP reload | `yulu/scripts/vocab/`, `stt_daemon/vocab_cache.py` |
| ADR-003 (`003-realtime-as-daemon-subscriber.md`) | `realtime_transcribe.py` rewritten as thin daemon subscriber, not deleted | `yulu/scripts/realtime_transcribe.py`, `stt_daemon/live_session.py` |
| ADR-004 (`004-prompt-library.md`) | `prompts.sqlite` catalog; `transcribe.py` pure enqueuer; `agent_queue_worker.py` sole LLM dispatcher | `yulu/scripts/prompts/`, `yulu/scripts/agent_queue_worker.py`, `yulu/scripts/transcribe.py` |
## Platform-Coupling Points
| Coupling | Where | Notes |
|---|---|---|
| **ScreenCaptureKit** | `audio_daemon.swift`, `Yulu.app` | macOS 12.3+ API for system audio capture; no Linux/Windows equivalent |
| **AVFoundation** (microphone) | `audio_daemon.swift` | macOS/iOS framework |
| **TCC (Transparency, Consent, Control)** | `setup.sh` (`tccutil reset ScreenCapture/Microphone`), `Yulu.app` bundle ID `com.yulu.audiodaemon` | macOS privacy permission gating; `tccutil` is macOS-only |
| **launchd** | All `com.yulu.*.plist` files, `setup.sh`, `yulu start/stop` CLI | macOS-specific process supervision; no Linux systemd equivalent exists in codebase |
| **Accessibility API / `window_scanner`** | `window_scanner.swift` (`-framework Cocoa`), `meeting_detector.py` | macOS Accessibility framework for reading window titles |
| **Homebrew** | `setup.sh` (`brew install`), `com.yulu.*.plist` PATH entries (`/opt/homebrew/bin`) | macOS package manager; hardcoded in plist PATH |
| **LaunchAgents directory** | `~/Library/LaunchAgents/` | macOS-specific location |
| **`osascript`** | `meeting_detector.py` (`_osascript`) | macOS AppleScript bridge |
| **`terminal-notifier`** | `agent_queue_worker.py` (`_maybe_voicemail_notify`) | macOS notification tool |
| **`codesign` / Gatekeeper** | `build_audio_daemon.sh`, `setup.sh` (`xattr -dr com.apple.quarantine`) | macOS binary signing requirement |
| **Apple Silicon (arm64)** | `setup.sh` (MLX default only for arm64), `mlx-whisper` | MLX Whisper requires Apple Silicon GPU |
## Architectural Constraints
- **Threading:** `stt_daemon` is a single asyncio event loop (async Python); `scheduler_daemon` is a single Python thread with a condition variable; `record_audio.py` and `meeting_daemon.py` are sync Python
- **Global state:** `stt_daemon` holds the model weights in memory (~2 GB for large-v3) as a process-level singleton; `VocabCache` and `PromptsCache` are in-process singletons reloaded via SIGHUP
- **agent-queue.json concurrency:** `queue_store.py` uses `fcntl.flock(LOCK_EX)` on a `.agent-queue.lock` sidecar; writes are atomic via `os.replace()` on a temp file; the `claim_summary_request()` function marks entries `processing` within the same lock acquisition to prevent double-processing
- **No cross-daemon discovery:** daemons communicate through fixed well-known paths only (`~/.config/yulu/`); no service registry
- **llm.command as process boundary:** the LLM integration is `subprocess.run(llm_command, input=prompt, capture_output=True)` — the agent skill drives Yulu by being that command, or by watching `agent-queue.json` directly
## Anti-Patterns
### Spawn-side STT (pre-ADR-001)
### Inline LLM in transcribe.py (pre-ADR-004)
## Error Handling
- `agent_queue_worker.py`: marks queue entry `status: "error"` with `error` field on any exception; re-raises for logging; next 30s tick will retry if `status` is reset
- `stt_daemon`: returns `ErrorEvent` JSON to the client socket on all exceptions; connection is closed; client raises `DaemonError`
- `record_audio.py`: `socket_send()` catches all exceptions and returns `None`; callers check for `None`
- Search index writes are wrapped `try/except` and logged as non-fatal (`_log(f"search index upsert failed ...")`); the pipeline continues
## Cross-Cutting Concerns
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
