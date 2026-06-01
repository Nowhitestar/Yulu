# External Integrations

**Analysis Date:** 2026-05-29

## OS / Framework Integrations

### ScreenCaptureKit (System Audio Capture)
- **What:** Captures system audio (all apps, meetings, browser tabs) without a virtual audio device
- **Used by:** `yulu/scripts/audio_daemon.swift` — the Swift binary inside `Yulu.app`
- **Framework:** `import ScreenCaptureKit` (macOS 13+)
- **Auth:** TCC permission — "Screen Recording & System Audio" (`com.yulu.audiodaemon` bundle ID)
- **TCC reset command:** `tccutil reset ScreenCapture com.yulu.audiodaemon`
- **Daemon socket:** `~/.config/yulu/audio_daemon.sock` (Unix domain socket, JSON protocol)
- **Readiness check:** `echo '{"action":"status"}' | nc -w 2 -U ~/.config/yulu/audio_daemon.sock` → `"sysReady":true`

### AVFoundation (Microphone Capture)
- **What:** Captures microphone audio, combined with ScreenCaptureKit into stereo WAV (L=mic, R=system)
- **Used by:** `yulu/scripts/audio_daemon.swift`
- **Framework:** `import AVFoundation`
- **Auth:** TCC permission — "Microphone" (`NSMicrophoneUsageDescription` in `Yulu.app/Contents/Info.plist`)
- **TCC reset command:** `tccutil reset Microphone com.yulu.audiodaemon`
- **Output format:** 48kHz stereo WAV, source-separated (L channel = mic, R channel = system audio)

### Accessibility API (Window Scanning)
- **What:** Reads window titles to detect active meeting apps (Zoom, Tencent Meeting, Feishu, etc.)
- **Used by:** `yulu/scripts/window_scanner.swift` — compiled to `window_scanner` binary; called by `meeting_detector.py`
- **Framework:** `import Cocoa` (via Accessibility API)
- **Auth:** TCC permission — "Accessibility" (user must grant manually in System Settings)
- **Output:** JSON array of `{app, title, pid}` objects to stdout

### Cocoa / Carbon (Status Agent Menu Bar)
- **What:** Native menu-bar app with LSUIElement=true (no Dock icon); global hotkey for voicemail capture
- **Used by:** `yulu/scripts/status_agent.swift` — compiled into `StatusAgent.app`
- **Frameworks:** `import Cocoa`, `import Carbon` (global hotkey via `RegisterEventHotKey`)
- **IPC socket:** `~/.config/yulu/status_agent.sock`
- **Default hotkey:** Cmd+Shift+V (configurable via `config.json` `status_agent.hotkey`)
- **Built by:** `yulu/scripts/build_status_agent.sh`

## launchd (macOS Service Management)

All Yulu daemons run as launchd LaunchAgents. Plist templates live in `yulu/scripts/`; installed to `~/Library/LaunchAgents/` by `setup.sh`.

| Label | Plist | Process | Restart policy |
|-------|-------|---------|---------------|
| `com.yulu.audiodaemon` | `com.yulu.audiodaemon.plist` | `open -W Yulu.app/Contents/MacOS/audio_daemon` | `KeepAlive=true` |
| `com.yulu.statusagent` | `com.yulu.statusagent.plist` | `open -W StatusAgent.app/Contents/MacOS/status_agent` | `KeepAlive=true` |
| `com.yulu.sttdaemon` | `com.yulu.sttdaemon.plist` | `python3 -m stt_daemon` | `KeepAlive=true`, `ThrottleInterval=10` |
| `com.yulu.agentqueue` | `com.yulu.agentqueue.plist` | `python3 agent_queue_worker.py` | `StartInterval=30` (periodic) |
| `com.yulu.scheduler` | `com.yulu.scheduler.plist` | `python3 scheduler_daemon.py` | `KeepAlive=true` |
| `com.yulu.detector` | `com.yulu.detector.plist` | `python3 meeting_detector.py daemon` | `KeepAlive=true` |
| `com.yulu.calendar` | `com.yulu.calendar.plist` | `python3 run_calendar_services.py` | `KeepAlive=true` (optional) |
| `com.yulu.ui` | `com.yulu.ui.plist` | `node yulu_ui/dist/server.js` | `KeepAlive=true`, `ThrottleInterval=10` |

**Plist path substitution:** `setup.sh` `install_plist()` replaces `__PYTHON__`, `__NODE_BIN__`, `__HOME__`, `__SCRIPT_DIR__`, `__PATH__` tokens with real values at install time.

**IPC between daemons:** audio_daemon communicates via its Unix socket; stt_daemon via `~/.config/yulu/stt_daemon.sock`; status_agent via `~/.config/yulu/status_agent.sock`; all others communicate via the JSON flat-file queue (`agent-queue.json`) and signal passing (`SIGHUP` for scheduler / agentqueue reload).

## Agent Queue Integration

### agent-queue.json
- **What:** The primary integration point between Yulu (recorder/transcriber) and an external Coding Agent (Claude Code, Codex, Cursor, etc.)
- **File:** `~/.config/yulu/agent-queue.json`
- **Format:** JSON array of event objects appended atomically (file-locked via `~/.config/yulu/.agent-queue.lock`)
- **Event types:** `recording_started`, `recording_stopped`, `recording_crashed`, `transcript`, `transcribing`, `realtime_transcribing`, `realtime_transcript_ready`, `realtime_transcript_error`, `summary_request`, `summary_ready`
- **Source:** `audio_daemon.swift` appends `recording_started` / `recording_stopped`; `transcribe.py` appends `summary_request`
- **Consumer (local):** `agent_queue_worker.py` (`com.yulu.agentqueue` daemon, runs every 30s) — claims `summary_request` events, dispatches to configured `llm.command`, writes `.summary.md` output, marks events `done`
- **Consumer (external):** Any coding agent watching the file — reads events and acts on `summary_request` if `llm.command=null` (queue mode)
- **Queue helpers:** `yulu/scripts/queue_store.py` — `locked_queue()`, `append_event()`, `claim_summary_request()`, `update_event()`

### agent_queue_worker.py
- **File:** `yulu/scripts/agent_queue_worker.py`
- **Behavior:** Single-run worker (launchd `StartInterval=30` triggers it); claims one `summary_request` at a time; renders the prompt template from `prompts.sqlite`; runs `llm.command` via subprocess with transcript as stdin; validates output; writes `.summary.md`; updates queue entry `status=done`
- **PID file:** `~/.config/yulu/agent_queue_worker.pid` — allows `yulu prompts` mutations to send `SIGHUP` for cache reload
- **LLM dispatch options** (configured in `llm.command`):
  - `null` — leave for external agent (no local processing)
  - `["claude", "--print"]` — Claude CLI
  - `["python3", "codex_llm.py"]` — Codex CLI shim (see below)
  - Any arbitrary list — custom command reading stdin / writing Markdown to stdout

### codex_llm.py Shim
- **File:** `yulu/scripts/codex_llm.py`
- **What:** Wraps `codex exec --skip-git-repo-check --sandbox read-only --ephemeral` for non-interactive LLM invocation
- **Env vars:** `YULU_CODEX_BIN` (override codex path), `YULU_CODEX_MODEL` (model flag), `YULU_CODEX_TIMEOUT` (default 1800s)
- **Binary discovery:** `PATH` → `~/.nvm/versions/node/*/bin/codex` (sorted descending)

## Google Calendar Integration

### gogcli (gog)
- **What:** CLI tool for Google Calendar access; handles OAuth 2.0 authorization and calendar event queries
- **Installed:** `brew install steipete/tap/gogcli`
- **Used by:** `yulu/scripts/check_meetings.py`, `yulu/scripts/run_calendar_services.py`
- **Config:** OAuth credentials stored in `~/.config/gcp/client_secret.json`; gog keychain stores refresh tokens per account
- **Auth flow:** `gog auth credentials <json>` → `gog auth add <email> --services calendar` (browser OAuth dance)
- **Queries:** `gog calendar events <email> --from ... --to ...` — returns structured event JSON

### Google Calendar Push Notifications
- **Service:** Google Calendar API v3 `events.watch` endpoint
- **What:** Google pushes HTTP POST to a local webhook when calendar events change
- **Implemented in:** `yulu/scripts/run_calendar_services.py` (`com.yulu.calendar` daemon)
- **Endpoint registered:** `POST /calendar-webhook` on the cloudflared tunnel URL
- **Auth:** OAuth 2.0 refresh token → access token via `https://oauth2.googleapis.com/token`
- **Watch registration:** `POST https://www.googleapis.com/calendar/v3/calendars/{calId}/events/watch`
- **Watch TTL:** 7 days; auto-renewed before expiry (1 hour before expiry)
- **State persistence:** `~/.config/yulu/.watch_state.json`
- **Fallback polling:** 5-minute interval (`POLL_INTERVAL_SEC=300`) as backup when push fails

### cloudflared
- **What:** Creates a quick HTTPS tunnel exposing `localhost:8899` to a public URL for Google Calendar push webhooks
- **Installed:** `brew install cloudflared`
- **Used by:** `yulu/scripts/run_calendar_services.py` — spawned as a subprocess; output parsed for the tunnel URL (regex `trycloudflare.com`)
- **Port:** 8899 (local webhook HTTP server)

## STT Engine Integrations

### mlx-whisper (Apple Silicon)
- **What:** In-process Python library running Whisper models via Apple MLX framework on Neural Engine / GPU
- **Venv:** `~/.config/yulu/venv-mlx-whisper/` (isolated from system Python)
- **Used by:** `yulu/scripts/stt_daemon/backends/mlx.py` — lazy-loaded via `importlib.import_module("mlx_whisper")`; model stays resident after first load
- **Models (HuggingFace):**
  - `mlx-community/whisper-large-v3-mlx` (default, highest quality)
  - `mlx-community/whisper-large-v3-turbo` (faster)
  - Downloaded lazily by `mlx-whisper` on first `transcribe()` call; cached in `~/.cache/huggingface/`
- **Daemon entry point:** `yulu/scripts/stt_daemon/__main__.py` → `STTDaemonApp` → `MlxWhisperBackend`
- **Protocol:** Unix socket `~/.config/yulu/stt_daemon.sock`; JSON messages (see `yulu/scripts/stt_daemon/protocol.py`)

### whisper.cpp (via whisper-cli)
- **What:** Subprocess-based backend; spawns `whisper-cli` binary per transcription request
- **Installed:** `brew install whisper-cpp` → `whisper-cli` binary
- **Used by:** `yulu/scripts/stt_daemon/backends/whisper_cli.py`
- **Models (HuggingFace):** GGML format binaries downloaded from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/`
  - `ggml-large-v3.bin` (~3.0 GB)
  - `ggml-large-v3-q5_0.bin` (~1.1 GB)
  - `ggml-medium.bin` (~1.5 GB)
  - Stored at `~/.config/yulu/models/`
- **Download:** Performed by `setup.sh` `download_whisper_model()` at install time

### HuggingFace Model Downloads
- MLX models: downloaded by `mlx-whisper` library at first use → `~/.cache/huggingface/hub/`
- GGML models: downloaded by `setup.sh` via `curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<name>.bin`

## Summary Output Integrations

Configured via `output.channel` in `config.json`. Dispatch implemented in `yulu/scripts/send_summary.py`.

### File (default)
- Local file only — `.summary.md` written alongside the recording WAV
- No external calls

### Zulip (experimental)
- **SDK:** `pip install zulip` (not bundled; must be installed manually)
- **Config keys:** `output.zulip.stream`, `output.zulip.topic`, `output.zulip.zuliprc` (path to `~/.zuliprc`)
- **Auth:** `~/.zuliprc` API key file (not managed by Yulu)

### Notion (experimental)
- **SDK:** `pip install notion-client` (not bundled; must be installed manually)
- **Config keys:** `output.notion.api_key_env`, `output.notion.database_id`
- **Auth:** `NOTION_API_KEY` environment variable

### Telegram (experimental)
- **SDK:** stdlib `urllib.request` only — no external package
- **API:** `https://api.telegram.org/bot{token}/sendMessage` (Bot API)
- **Config keys:** `output.telegram.chat_id`, `output.telegram.bot_token_env`
- **Auth:** `TELEGRAM_BOT_TOKEN` environment variable

## Notifications

### terminal-notifier
- **Installed:** `brew install terminal-notifier`
- **Used by:** `yulu/scripts/notify.py`, `yulu/scripts/agent_queue_worker.py` (voicemail completion)
- **Sender ID:** `-sender com.yulu.audiodaemon` (links notification to Yulu.app icon in Notification Center)
- **Triggers:** recording started/stopped, transcription complete, summary ready, voicemail complete
- **File open action:** `-open file://<summary_path>` opens summary in default app on click

## Local Web UI (yulu_ui)

- **Server:** Hono + tRPC on `http://127.0.0.1:7777`
- **Entry point:** `yulu/scripts/yulu_ui/dist/server.js` (Node.js, built artifact)
- **Daemon:** `com.yulu.ui` LaunchAgent
- **SQLite databases accessed:**
  - `~/.config/yulu/prompts.sqlite` — prompt library and summaries history
  - `~/.config/yulu/vocab.sqlite` — per-user vocabulary for transcription hints
  - `~/.config/yulu/search.sqlite` — FTS5 full-text search index over all summaries and transcripts
- **WebSocket:** `ws://127.0.0.1:7777/ws` — live push of recording state, transcript updates, log tailing
- **IPC to daemons:** `yulu/scripts/yulu_ui/src/ipc.ts` communicates with `audio_daemon.sock` via the launchctl client and direct socket writes
- **Health check:** `GET /healthz` → `{"status":"ok"}`
- **Host guard:** Rejects non-localhost `Host` headers to prevent DNS rebinding

## Skills / Agent Integration

### vercel-labs/skills
- **What:** Registers `skills/yulu/SKILL.md` as a skill for coding agents (Claude Code, Codex, Cursor, etc.)
- **Install:** `npx skills add <repo-path> -g -a <agent-name>` (done by `setup.sh` `install_agent_skill()`)
- **Skill file:** `skills/yulu/SKILL.md` (YAML frontmatter with `name:` and `description:`)
- **Sync:** `make sync-skill` → `yulu/scripts/sync_skill.py`
- **CI check:** Frontmatter validated in `.github/workflows/ci.yml`

### Feishu Calendar (stub)
- **Config key:** `calendars[].type = "feishu"`, `app_id_env`, `app_secret_env`
- **Status:** Stub implementation in `yulu/scripts/check_meetings.py` `_fetch_feishu()` — TODO comment, no API calls implemented

## Data Storage

**Databases (SQLite, Python stdlib `sqlite3` + Node `better-sqlite3`):**
- `~/.config/yulu/prompts.sqlite` — prompt library, summaries table (status, timing, word count, html_path)
- `~/.config/yulu/vocab.sqlite` — user vocabulary terms seeded from `yulu/scripts/vocab/` frozen snapshots
- `~/.config/yulu/search.sqlite` — FTS5 full-text search index (meeting summaries + transcripts + voicemail)

**JSON flat files:**
- `~/.config/yulu/config.json` — user config (audio, transcription, LLM, calendar, output)
- `~/.config/yulu/agent-queue.json` — agent event queue (append-only, atomic writes)
- `~/.config/yulu/.state.json` — current recording state (title, audio_path, start_time, is_active)
- `~/.config/yulu/schedule.json` — upcoming meeting schedule for scheduler daemon
- `~/.config/yulu/.watch_state.json` — Google Calendar push channel state

**File outputs:**
- `~/Movies/Yulu/<title>_YYYYMMDD_HHMMSS.wav` — stereo WAV recording
- `~/Movies/Yulu/<stem>.transcript.txt` — final transcript
- `~/Movies/Yulu/<stem>.realtime.transcript.txt` — live realtime transcript
- `~/Movies/Yulu/<stem>.mic.transcript.txt` + `.sys.transcript.txt` — per-channel transcripts (dual-track)
- `~/Movies/Yulu/<stem>.summary.md` — LLM-generated meeting summary
- `~/Movies/Yulu/<stem>.html` — HTML artifact wrapping summary + transcript
- `~/Movies/Yulu/voicemails/<stem>.*` — voicemail recordings (same pattern)

## GitHub Releases API

- **Used by:** `yulu/scripts/release_installer.py`
- **Endpoint:** `https://api.github.com/repos/Nowhitestar/Yulu/releases/latest` or `/releases/tags/{tag}`
- **Asset naming:** `yulu-macos-arm64-{tag}.zip` + `checksums.txt`
- **Auth:** No auth (public repo, anonymous API calls)
- **Checksum verification:** SHA-256 via `checksums.txt` before extraction

## Environment Variables (Runtime)

| Variable | Used by | Purpose |
|----------|---------|---------|
| `YULU_CODEX_BIN` | `codex_llm.py` | Override Codex binary path |
| `YULU_CODEX_MODEL` | `codex_llm.py` | Pass `-m <model>` to codex |
| `YULU_CODEX_TIMEOUT` | `codex_llm.py` | Timeout in seconds (default 1800) |
| `YULU_UI_PORT` | `yulu_ui` server | HTTP port (default 7777) |
| `YULU_CODESIGN_IDENTITY` | `build_audio_daemon.sh` | Code signing identity override |
| `NOTION_API_KEY` | `send_summary.py` | Notion integration auth |
| `TELEGRAM_BOT_TOKEN` | `send_summary.py` | Telegram Bot API token |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOG_REFRESH_TOKEN` | `webhook_server.py` (deprecated) | Google OAuth (legacy webhook server) |
| `INSTALL_DIR` | `install.sh` | Override install directory (default `~/.yulu`) |
| `PYTHONPATH` | launchd plist | Set to `__SCRIPT_DIR__` so daemons can import local modules |

---

*Integration audit: 2026-05-29*
