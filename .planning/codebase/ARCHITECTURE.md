<!-- refreshed: 2026-05-29 -->
# Architecture

**Analysis Date:** 2026-05-29

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                          User Interface Layer                             │
│  yulu CLI (`yulu/scripts/yulu`)   Web UI (http://127.0.0.1:7777)         │
│  `~/.local/bin/yulu` → scripts    `yulu_ui/src/server.ts` (Hono+tRPC)   │
└──────────┬──────────────────────────────────────────────────┬────────────┘
           │ commands                                          │ tRPC / WS
           ▼                                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       Orchestration & Control Layer                       │
│  meeting_daemon.py    record_audio.py    meeting_detector.py              │
│  scheduler_daemon.py  run_calendar_services.py / webhook_server.py        │
└──────┬───────────┬────────────────────┬──────────────────────────────────┘
       │           │                    │
       │ Unix      │ file writes /      │ SIGHUP /
       │ socket    │ spawn subprocess   │ subprocess fork
       ▼           ▼                    ▼
┌──────────────┐  ┌──────────────┐  ┌────────────────────────────────────┐
│ com.yulu     │  │ com.yulu     │  │ com.yulu.scheduler                  │
│ .audiodaemon │  │ .sttdaemon   │  │ scheduler_daemon.py                  │
│ Yulu.app     │  │ stt_daemon/  │  │ heap-based event timer               │
│ (Swift)      │  │ (Python      │  │ reads schedule.json on SIGHUP        │
│ ScreenCapture│  │  asyncio)    │  └──────────────────┬─────────────────┘
│ Kit + mic    │  │ MLX Whisper  │                     │ fork
│ audio_daemon │  │ whisper-cli  │                     ▼
│ .sock        │  │ stt_daemon   │          notify.py / meeting_daemon.py
└──────┬───────┘  │ .sock        │
       │ WAV      └──────┬───────┘
       │ files           │ transcript text
       ▼                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     Post-Recording Pipeline                               │
│  transcribe.py (enqueuer)  → agent-queue.json → agent_queue_worker.py   │
│                                                  (sole LLM dispatcher)   │
└──────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      Artifact Store (all local files)                    │
│  ~/.config/yulu/ — config, queues, SQLite DBs, sockets, PIDs             │
│  ~/Movies/Yulu/  — WAV recordings, transcripts, summary .md/.html        │
└──────────────────────────────────────────────────────────────────────────┘
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

Plist source templates: `yulu/scripts/com.yulu.*.plist`
Installed copies: `~/Library/LaunchAgents/com.yulu.*.plist`

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

1. **Recording starts** — `record_audio.py start "Title"` sends `{"action":"start","title":"..."}` to `~/.config/yulu/audio_daemon.sock`
2. **audio_daemon** begins ScreenCaptureKit capture; writes WAV to `~/Movies/Yulu/<date>/<title>.wav`
3. **realtime_transcribe.py** is spawned by `record_audio.py`; connects to `stt_daemon.sock`, sends `subscribe_session`; daemon's `LiveSessionManager` tails the growing WAV and streams `partial` events back; subscriber writes `<title>.realtime.transcript.txt`
4. **Recording stops** — `record_audio.py stop` sends `{"action":"stop"}` to `audio_daemon.sock`; daemon finalizes WAV; `record_audio.py` sends `unsubscribe_session` to `stt_daemon.sock`; spawns `transcribe.py`
5. **transcribe.py** (`yulu/scripts/transcribe.py`) in `fast_summary` mode uses the realtime transcript as-is (or calls `stt_daemon` for a full pass in `full_transcribe` mode via `transcribe_client.py`); then appends one `summary_request` event per `is_auto_run` prompt to `~/.config/yulu/agent-queue.json`
6. **agent_queue_worker.py** (`com.yulu.agentqueue`, fires every 30s) claims the event, renders the prompt snapshot with `{{transcript}}`/`{{meeting_title}}`/`{{date}}` substitutions, pipes it to `llm.command` subprocess (e.g. `claude --print`), validates output, writes `<title>.summary.md` and `<title>.summary.html`, updates `SummariesRepo` in `prompts.sqlite`, upserts to `search.sqlite`

### STT Daemon Internal Request Path

1. Client (e.g. `transcribe_client.py`) opens Unix connection to `stt_daemon.sock`, sends `TranscribeRequest` JSON line
2. `ControlServer` dispatches to `STTDaemonApp._on_transcribe()`
3. `STTDaemonApp` classifies WAV layout (MONO / DUAL_TRACK / LEGACY_STEREO) via `wav_inspect.classify()`
4. Submits `Job` to `STTScheduler` background slot; scheduler queues behind priority order `final_transcribe > live_chunk > file_transcribe`
5. `STTRuntime` calls `MlxWhisperBackend.transcribe()` or `WhisperCliBackend.transcribe()` with `VocabCache`-injected `initial_prompt`
6. Returns `TranscribeResponse` JSON line to client; applies `vocab_cache.apply_replacements()` post-pass

### Calendar → Schedule → Recording Prompt

1. `run_calendar_services.py` fetches Google Calendar events via `gog`; writes `~/.config/yulu/schedule.json`; SIGHUPs `scheduler_daemon`
2. `scheduler_daemon.py` wakes at the event's epoch; forks `meeting_daemon.py ask_record <title>` which shows a macOS dialog
3. User clicks Record → `meeting_daemon.py` calls `record_audio.py start`

### External Agent Integration (agent-queue boundary)

`~/.config/yulu/agent-queue.json` is the **coding agent integration boundary**. External agents (e.g. the Yulu skill loaded in Hermes/Claude Code) watch this file for `summary_request` events where `status` is `null` or `pending` and `llm.command` is not configured. The agent reads the event, calls its own LLM with the `prompt_content_snapshot`, and writes back `status: "done"` + `summary_path`. The `queue_store.py` `locked_queue()` context manager (fcntl-based) prevents concurrent write conflicts between the local worker and an external agent.

**How the host agent/skill drives Yulu via agent-queue:**
1. Agent polls `~/.config/yulu/agent-queue.json` for `{"type":"summary_request","status":null}` entries
2. Reads `transcript_path` and `prompt_content_snapshot` from the event
3. Renders the snapshot, calls its LLM, produces Markdown
4. Writes summary to `summary_path`, updates the queue entry `status→"done"` via `queue_store.update_event()`
5. The `skills/yulu/SKILL.md` (installed via `npx skills add`) gives the agent the exact shell commands and queue schema

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
install.sh
  └─ python3 release_installer.py install --install-dir ~/.yulu
       ├── fetch release zip from GitHub Releases (or git clone --dev)
       ├── extract to ~/.yulu  (preserves exec bits via packaging/scripts/package.sh)
       └─ python3 setup.sh [--upgrade]
            ├── check_system(): macOS, Homebrew, Python
            ├── install_deps(): brew install sox ffmpeg whisper-cpp terminal-notifier gogcli cloudflared
            ├── compile_audio_daemon(): build_audio_daemon.sh → swiftc → ad-hoc codesign → xattr quarantine strip
            ├── compile_scanner(): swiftc window_scanner.swift -framework Cocoa → window_scanner
            ├── create_config(): ~/.config/yulu/config.json
            ├── configure_transcription_engine(): MLX venv or whisper.cpp model download
            ├── configure_summary_mode(): sets llm.command in config.json
            ├── setup_calendar(): gog auth add <email> --services calendar
            ├── install_launchagents():
            │    └── for each plist: cp → sed replace __PYTHON__/__NODE_BIN__/__HOME__/__SCRIPT_DIR__ → launchctl load
            ├── install_yulu_ui(): npm ci + npm run build → dist/server.js + dist/web/
            ├── install_yulu_cli(): ln -sf yulu/scripts/yulu ~/.local/bin/yulu
            └── install_agent_skill(): npx skills add <repo> -g -a <agent>
```

**Upgrade path:** `yulu update` → `release_installer.py update` → extracts new zip → `setup.sh --upgrade` (idempotent, skips OAuth and already-configured steps)

**Uninstall:** `yulu uninstall` → `uninstall.sh` → `launchctl unload` all plists, `rm -rf ~/.yulu`, optionally `rm -rf ~/.config/yulu`

## ADR to Component Mapping

| ADR | Decision | Primary Component |
|---|---|---|
| ADR-001 (`001-resident-stt-daemon.md`) | Single resident `stt_daemon` with two-slot scheduler; all STT via Unix socket | `yulu/scripts/stt_daemon/`, `com.yulu.sttdaemon` plist |
| ADR-002 (`002-vocab-sqlite-single-source.md`) | Single `vocab.sqlite` with `prompt`/`replace`/`both` scope; SIGHUP reload | `yulu/scripts/vocab/`, `stt_daemon/vocab_cache.py` |
| ADR-003 (`003-realtime-as-daemon-subscriber.md`) | `realtime_transcribe.py` rewritten as thin daemon subscriber, not deleted | `yulu/scripts/realtime_transcribe.py`, `stt_daemon/live_session.py` |
| ADR-004 (`004-prompt-library.md`) | `prompts.sqlite` catalog; `transcribe.py` pure enqueuer; `agent_queue_worker.py` sole LLM dispatcher | `yulu/scripts/prompts/`, `yulu/scripts/agent_queue_worker.py`, `yulu/scripts/transcribe.py` |

## Platform-Coupling Points

These are macOS-specific dependencies that block a future cross-platform abstraction:

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

**What happens:** Older code paths (pre-v0.x) would call `mlx_whisper` directly in `transcribe.py` or `realtime_transcribe.py` as a subprocess, paying 3–10s model load per call.
**Why it's wrong:** Doubles RAM, pays cold-start cost every recording, can't share vocab/scheduling across concurrent consumers.
**Do this instead:** All STT goes through `TranscribeRequest` JSON to `stt_daemon.sock` via `transcribe_client.py`. `import mlx_whisper` must only appear in `yulu/scripts/stt_daemon/backends/mlx.py`.

### Inline LLM in transcribe.py (pre-ADR-004)

**What happens:** Old `transcribe.py` had `SUMMARY_PROMPT` constant and called `llm_command` directly with `subprocess.run()`.
**Why it's wrong:** Creates two divergent LLM call sites with drifting prompts; bypasses `SummariesRepo` provenance tracking.
**Do this instead:** `transcribe.py` only appends to `agent-queue.json`; `agent_queue_worker.py` is the only file that calls `_run_llm()`.

## Error Handling

**Strategy:** Best-effort with logged failures; the pipeline never crashes silently.

**Patterns:**
- `agent_queue_worker.py`: marks queue entry `status: "error"` with `error` field on any exception; re-raises for logging; next 30s tick will retry if `status` is reset
- `stt_daemon`: returns `ErrorEvent` JSON to the client socket on all exceptions; connection is closed; client raises `DaemonError`
- `record_audio.py`: `socket_send()` catches all exceptions and returns `None`; callers check for `None`
- Search index writes are wrapped `try/except` and logged as non-fatal (`_log(f"search index upsert failed ...")`); the pipeline continues

## Cross-Cutting Concerns

**Logging:** Each daemon writes plaintext timestamped logs to `~/.config/yulu/<daemon>.log`; `stt_daemon` uses `JsonLogger` writing structured JSON to `~/.config/yulu/logs/stt_daemon.log`
**Validation:** `agent_queue_worker._is_valid_summary()` guards against LLM returning agent-queue JSON or empty strings; `_looks_like_agent_event_json()` rejects all known event types
**Authentication:** No remote auth; all data is local-only; Google Calendar OAuth tokens stored by `gog` in macOS Keychain
**Atomic writes:** Both `queue_store.py` and `state_store.py` use `tempfile.mkstemp` + `os.replace()` for all JSON writes

---

*Architecture analysis: 2026-05-29*
