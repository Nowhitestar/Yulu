# Codebase Structure

**Analysis Date:** 2026-05-29

## Directory Layout

```
Yulu/                              # Repo root
├── install.sh                     # One-line installer (curl | bash entry point)
├── VERSION                        # Semver string (e.g. "0.5.1")
├── Makefile                       # dev-install, doctor, test, sync-skill targets
├── yulu.skill                     # Top-level skill pointer (for vercel-labs/skills)
├── assets/                        # Icons and demo assets (not deployed)
│   └── Yulu.iconset/
├── docs/                          # Design docs and specs
│   └── superpowers/
│       ├── plans/                 # Implementation plans for each spec
│       └── specs/                 # Feature spec documents
├── packaging/                     # Release build tooling
│   └── scripts/
│       ├── package.sh             # Builds release zip (preserves exec bits)
│       └── checksums.sh           # Generates SHA-256 checksums file
├── skills/                        # Agent skill registration (vercel-labs/skills)
│   └── yulu/
│       └── SKILL.md               # Yulu skill for Hermes/Claude Code/Codex
├── tests/                         # All Python tests (co-located with repo root, not scripts/)
│   ├── conftest.py
│   ├── fixtures/
│   │   └── audio/                 # Test WAV files
│   └── test_*.py                  # ~60+ test modules
├── yulu/
│   ├── spec/
│   │   └── adr/                   # Architectural Decision Records
│   │       ├── README.md
│   │       ├── 001-resident-stt-daemon.md
│   │       ├── 002-vocab-sqlite-single-source.md
│   │       ├── 003-realtime-as-daemon-subscriber.md
│   │       └── 004-prompt-library.md
│   └── scripts/                   # ALL runtime code lives here
│       ├── yulu                   # Main CLI entry point (bash, symlinked to ~/.local/bin/yulu)
│       ├── setup.sh               # Interactive installer / idempotent upgrader
│       ├── uninstall.sh           # Full uninstall script
│       ├── release_installer.py   # GitHub Releases fetcher + zip extractor
│       ├── dev_install.py         # In-place dev migration (repo → ~/.yulu live)
│       ├── com.yulu.*.plist       # launchd plist templates (8 files, use __PLACEHOLDER__ tokens)
│       │
│       ├── Yulu.app/              # Compiled Swift app bundle (audio capture daemon)
│       │   └── Contents/MacOS/audio_daemon
│       ├── StatusAgent.app/       # Compiled Swift app bundle (menu-bar status agent)
│       │   └── Contents/MacOS/status_agent
│       │
│       ├── audio_daemon.swift     # ScreenCaptureKit + AVFoundation Swift source
│       ├── status_agent.swift     # Menu-bar LSUIElement Swift source
│       ├── recorder_status.swift  # (shared Swift helper)
│       ├── window_scanner.swift   # Accessibility API window title enumerator source
│       ├── build_audio_daemon.sh  # swiftc compile + codesign script
│       ├── build_status_agent.sh  # swiftc compile + codesign script
│       │
│       ├── record_audio.py        # Recording controller (start/stop/status; spawns realtime_transcribe.py)
│       ├── meeting_daemon.py      # Calendar scheduling, ask_record dialogs, recording CLI
│       ├── meeting_detector.py    # Window-title meeting detection daemon
│       ├── transcribe.py          # Post-recording enqueuer (pure orchestrator, no LLM)
│       ├── transcribe_client.py   # Sync RPC client for stt_daemon.sock
│       ├── realtime_transcribe.py # Daemon-subscriber: streams partial events → .realtime.transcript.txt
│       ├── agent_queue_worker.py  # Sole LLM dispatcher; processes agent-queue.json summary_request events
│       ├── queue_store.py         # Shared agent-queue.json helpers (fcntl-locked atomic writes)
│       ├── state_store.py         # Shared recording state .state.json helpers
│       ├── recording_lock.py      # Exclusive recording lock (.recording_pid)
│       ├── scheduler_daemon.py    # Heap-based event timer daemon
│       ├── run_calendar_services.py  # Cloudflared tunnel + Google Calendar webhook + schedule.json writer
│       ├── webhook_server.py      # HTTP webhook receiver (Google Calendar push notifications)
│       ├── check_meetings.py      # CLI: query today's calendar events
│       ├── configure.py           # Transcription engine/mode config CLI helper
│       ├── doctor.py              # Health check for all daemons, config, model, queue
│       ├── notify.py              # Cross-daemon notification helper
│       ├── agent_notify.py        # agent-queue recording event publisher
│       ├── send_summary.py        # Dispatch summary to configured output channel (file/Telegram/etc.)
│       ├── html_artifact.py       # Renders .summary.html from .summary.md + .transcript.txt
│       ├── codex_llm.py           # Codex CLI shim (wraps codex exec for use as llm.command)
│       ├── echo_cancel.py         # Echo cancellation helper
│       ├── version.py             # Version reporting
│       ├── repair_permissions.py  # TCC permission reset helper
│       ├── sync_skill.py          # Sync skills/yulu/SKILL.md to ~/.hermes and l-skills
│       ├── stt_cli.py             # CLI client for stt_daemon (health/warm-up/transcribe/cancel)
│       ├── summaries_cli.py       # CLI for querying SummariesRepo
│       ├── summary_template.md    # Fallback summary Markdown template
│       ├── config.example.json    # Documented example config
│       ├── status_agent_config.py # Status agent configuration logic
│       ├── status_agent_icons/    # Menu-bar icon assets
│       │
│       ├── stt_daemon/            # Resident STT daemon Python package (ADR-001)
│       │   ├── __init__.py
│       │   ├── __main__.py        # Entry point: asyncio.run(_run())
│       │   ├── app.py             # STTDaemonApp: wires all components
│       │   ├── config.py          # DaemonConfig dataclass (reads stt_daemon section of config.json)
│       │   ├── control_server.py  # Unix socket server + request dispatcher
│       │   ├── scheduler.py       # STTScheduler: two-slot priority queue
│       │   ├── runtime.py         # STTRuntime: dispatches to backends; channel split logic
│       │   ├── live_session.py    # LiveSession + LiveSessionManager: WAV tail loop
│       │   ├── protocol.py        # Request/Response dataclasses + JSON encode/decode
│       │   ├── vocab_cache.py     # VocabCache: reads vocab.sqlite; injects initial_prompt + replacements
│       │   ├── wav_inspect.py     # WAV layout classifier (MONO / DUAL_TRACK / LEGACY_STEREO)
│       │   ├── transcript_merge.py  # Merge mic + sys channel transcripts
│       │   ├── logging.py         # JsonLogger
│       │   └── backends/
│       │       ├── __init__.py
│       │       ├── mlx.py         # MlxWhisperBackend (Apple Silicon, mlx-whisper)
│       │       └── whisper_cli.py # WhisperCliBackend (whisper-cli subprocess)
│       │
│       ├── vocab/                 # Vocabulary management package (ADR-002)
│       │   ├── __init__.py
│       │   ├── db.py              # SQLite schema + CRUD (vocab.sqlite)
│       │   ├── seed.py            # SEED_GLOSSARY + SEED_REPLACEMENTS (frozen baseline)
│       │   └── cli.py             # `yulu vocab` CLI (add/list/edit/remove/import/export)
│       │
│       ├── prompts/               # Prompt library + summaries provenance (ADR-004)
│       │   ├── __init__.py
│       │   ├── db.py              # SQLite schema: prompts + summaries tables
│       │   ├── cache.py           # PromptsCache, render(), resolve_meeting_date()
│       │   ├── seed.py            # Default prompt content (summary, transcript-cleanup, voicemail-todos, action-items)
│       │   └── cli.py             # `yulu prompts` CLI
│       │
│       ├── search/                # Full-text search index
│       │   ├── __init__.py
│       │   ├── indexer.py         # search.sqlite schema + upsert_doc(); kind constants
│       │   ├── reader.py          # FTS query
│       │   ├── ipc_helper.py      # IPC bridge for yulu_ui search router
│       │   └── cli.py             # `yulu search` CLI
│       │
│       ├── voicemail/             # Voicemail-specific capture + pipeline
│       │   ├── __init__.py
│       │   ├── recorder.py        # Voicemail recorder (uses audio_daemon.sock)
│       │   ├── repo.py            # Voicemail file repo
│       │   └── cli.py             # `yulu voicemail` CLI
│       │
│       └── yulu_ui/               # Local web UI (Node.js / React)
│           ├── package.json
│           ├── package-lock.json
│           ├── src/               # Server-side TypeScript (Node.js, Hono, tRPC)
│           │   ├── server.ts      # HTTP server entry point (:7777)
│           │   ├── trpc.ts        # tRPC context + AppContext type
│           │   ├── config.ts      # ConfigManager (reads/writes config.json)
│           │   ├── db.ts          # better-sqlite3 wrapper
│           │   ├── paths.ts       # Well-known path constants (~/.config/yulu/*)
│           │   ├── ipc.ts         # ipcSend() Unix socket helper
│           │   ├── launchctl.ts   # LaunchctlClient
│           │   ├── pubsub.ts      # In-process event bus
│           │   ├── inboxWatcher.ts  # Watches agent-queue.json for new events
│           │   ├── logTailer.ts   # Tails log files for WebSocket streaming
│           │   ├── ws.ts          # WebSocket multiplexer
│           │   ├── jobRunner.ts   # Background job runner
│           │   ├── jobStatus.ts   # Job registry
│           │   └── routers/       # tRPC routers
│           │       ├── _app.ts    # Root router (merges all sub-routers)
│           │       ├── config.ts
│           │       ├── daemons.ts
│           │       ├── recordings.ts
│           │       ├── recording.ts
│           │       ├── prompts.ts
│           │       ├── glossary.ts
│           │       ├── search.ts
│           │       ├── logs.ts
│           │       ├── integrations.ts
│           │       ├── llm.ts
│           │       └── system.ts
│           ├── web/               # React SPA (Vite)
│           │   ├── src/
│           │   │   ├── App.tsx
│           │   │   ├── main.tsx
│           │   │   ├── trpc.ts    # tRPC React client
│           │   │   ├── ws.tsx     # WebSocket React context
│           │   │   ├── routes/    # Page-level components
│           │   │   │   ├── inbox/
│           │   │   │   └── knowledge/
│           │   │   ├── components/  # Shared UI components
│           │   │   │   ├── health/
│           │   │   │   └── settings/
│           │   │   └── hooks/     # React hooks
│           │   └── public/
│           ├── tests/             # Vitest tests for yulu_ui
│           └── dist/              # Built output (gitignored; generated by npm run build)
│               ├── server.js      # Bundled server (run by com.yulu.ui)
│               └── web/           # Static SPA assets served by Hono
└── .github/
    └── workflows/
        ├── ci.yml
        ├── release.yml
        ├── release-please.yml
        └── release-publish.yml
```

## Key File Locations

**Entry Points:**
- `yulu/scripts/yulu` — Main CLI; symlinked to `~/.local/bin/yulu` by setup
- `yulu/scripts/stt_daemon/__main__.py` — STT daemon entry (`python -m stt_daemon`)
- `yulu/scripts/agent_queue_worker.py` — Queue worker entry (run by launchd every 30s)
- `yulu/scripts/yulu_ui/src/server.ts` — Web UI server (compiled to `dist/server.js`)
- `yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon` — Swift audio capture binary
- `yulu/scripts/StatusAgent.app/Contents/MacOS/status_agent` — Swift menu-bar binary
- `install.sh` — Curl-pipe installer

**Configuration:**
- `yulu/scripts/config.example.json` — Documented config schema
- `yulu/scripts/com.yulu.*.plist` — launchd plist templates (placeholders replaced by setup.sh)
- `yulu/scripts/setup.sh` — Installer + upgrader

**Core Logic:**
- `yulu/scripts/record_audio.py` — Recording controller
- `yulu/scripts/transcribe.py` — Post-recording enqueuer
- `yulu/scripts/agent_queue_worker.py` — LLM dispatcher
- `yulu/scripts/stt_daemon/app.py` — STT daemon app wiring
- `yulu/scripts/queue_store.py` — Shared queue I/O
- `yulu/scripts/state_store.py` — Shared recording state I/O

**Testing:**
- `tests/` — All pytest tests at repo root
- `tests/conftest.py` — Shared fixtures
- `tests/fixtures/audio/` — WAV test fixtures
- `yulu/scripts/yulu_ui/tests/` — Vitest tests for the web UI

**ADRs:**
- `yulu/spec/adr/` — All four architectural decision records

## Naming Conventions

**Python files (scripts/):**
- Daemon entry scripts: `<thing>_daemon.py` (e.g. `meeting_daemon.py`, `scheduler_daemon.py`)
- Client helpers: `<thing>_client.py` (e.g. `transcribe_client.py`)
- CLI helpers: `<thing>_cli.py` (e.g. `stt_cli.py`, `summaries_cli.py`)
- Shared utilities: descriptive noun (e.g. `queue_store.py`, `state_store.py`, `recording_lock.py`)
- Swift sources: `<thing>.swift` (e.g. `audio_daemon.swift`, `window_scanner.swift`)

**Python packages (inside scripts/):**
- `stt_daemon/` — STT daemon; imported as `python -m stt_daemon`
- `vocab/`, `prompts/`, `search/`, `voicemail/` — feature modules with `cli.py`, `db.py`, `seed.py` pattern

**Tests:**
- All test files: `test_<module_or_feature>.py` in `tests/`
- No co-location with source; all tests are in the repo-root `tests/` directory

**launchd plists:**
- Template files: `com.yulu.<daemon>.plist` in `yulu/scripts/`
- Installed copies: `~/Library/LaunchAgents/com.yulu.<daemon>.plist`

**TypeScript (yulu_ui):**
- Server modules: lowercase camelCase (`inboxWatcher.ts`, `logTailer.ts`)
- tRPC routers: domain noun (`recordings.ts`, `daemons.ts`)
- React components: PascalCase (`App.tsx`, component directories)

## Where to Add New Code

**New daemon (Python):**
- Script: `yulu/scripts/<name>_daemon.py`
- plist template: `yulu/scripts/com.yulu.<name>.plist`
- Register in `setup.sh` `install_launchagents()` function
- Log path: `~/.config/yulu/<name>.log`
- Add to `yulu/scripts/yulu` CLI `logs` subcommand

**New Python feature module:**
- Create `yulu/scripts/<module>/` with `__init__.py`, `db.py`, `cli.py`, `seed.py` as applicable
- Tests: `tests/test_<module>_*.py`
- Wire CLI into `yulu/scripts/yulu` dispatch table

**New tRPC route (yulu_ui):**
- Router: `yulu/scripts/yulu_ui/src/routers/<name>.ts`
- Register in `yulu/scripts/yulu_ui/src/routers/_app.ts`
- React client calls via `trpc.<name>.<procedure>.useQuery()` in `yulu/scripts/yulu_ui/web/src/`

**New Swift helper:**
- Source: `yulu/scripts/<name>.swift`
- Build script: update `yulu/scripts/build_audio_daemon.sh` or add a new `build_<name>.sh`
- Call `setup.sh compile_*` to expose the build step

**New prompt (for LLM summaries):**
- Add to `yulu/scripts/prompts/seed.py` `SEED_PROMPTS` list with appropriate `category`, `slug`, `is_auto_run`
- Run `yulu prompts seed --from-current` to apply; the worker picks it up without restart
- Tests: `tests/test_prompts_seed.py`

**New vocab term:**
- Add to `yulu/scripts/vocab/seed.py` `SEED_GLOSSARY` or `SEED_REPLACEMENTS` for shipped defaults
- Runtime: `yulu vocab add <term> <canonical> --scope both`

## Installed Artifact Locations

| Artifact | Path | Contents |
|---|---|---|
| Runtime tree | `~/.yulu/` | Full repo contents at installed version |
| Config | `~/.config/yulu/config.json` | User config (calendars, audio, transcription, llm, output) |
| SQLite databases | `~/.config/yulu/vocab.sqlite`, `prompts.sqlite`, `search.sqlite` | Vocabulary, prompt library + summaries provenance, full-text search index |
| Agent queue | `~/.config/yulu/agent-queue.json` | JSON event log; read by external agents and `agent_queue_worker` |
| Recording state | `~/.config/yulu/.state.json` | Current recording active/inactive + metadata |
| Sockets | `~/.config/yulu/audio_daemon.sock`, `stt_daemon.sock` | Unix domain sockets (ephemeral, created by daemons) |
| Schedules | `~/.config/yulu/schedule.json` | Calendar events for `scheduler_daemon` |
| Models | `~/.config/yulu/models/ggml-*.bin` | whisper.cpp model files |
| MLX venv | `~/.config/yulu/venv-mlx-whisper/` | Isolated Python env with `mlx-whisper` |
| Logs | `~/.config/yulu/*.log`, `~/.config/yulu/logs/` | Per-daemon log files |
| PID files | `~/.config/yulu/*.pid`, `~/.config/yulu/.[name].pid` | Daemon process IDs |
| LaunchAgents | `~/Library/LaunchAgents/com.yulu.*.plist` | Installed launchd plists (path-substituted) |
| CLI shim | `~/.local/bin/yulu` | Symlink → `~/.yulu/yulu/scripts/yulu` |
| Sessions | `~/.config/yulu/sessions/<sid>/` | Live session artifacts (final.transcript.txt) |
| Recordings | `~/Movies/Yulu/` (default; configurable in `audio.output_dir`) | WAV files, transcripts, summaries |
| Google creds | `~/.config/gcp/client_secret.json` | OAuth client credentials (never committed) |
| Agent skill | `~/.claude/skills/yulu/`, `~/.hermes/skills/yulu/`, etc. | Skill symlink managed by `npx skills add` |

## Special Directories

**`yulu/scripts/Yulu.app/` and `yulu/scripts/StatusAgent.app/`:**
- Purpose: Pre-compiled (or freshly compiled by `build_audio_daemon.sh`) macOS app bundles
- Generated: Yes, by `build_audio_daemon.sh` / `build_status_agent.sh`
- Committed: Yes (the compiled binaries are committed so releases work without a Swift toolchain on the target machine)
- Note: exec bits can be lost by Python `zipfile.extractall()` in the release process; `setup.sh compile_audio_daemon()` re-asserts `chmod +x` before launchd load

**`yulu/scripts/yulu_ui/dist/`:**
- Purpose: Built Node.js server + React SPA served by `com.yulu.ui`
- Generated: Yes, by `npm run build` in `install_yulu_ui()`
- Committed: No (gitignored)

**`tests/fixtures/audio/`:**
- Purpose: WAV test fixtures for `stt_daemon` unit tests and `wav_inspect` tests
- Generated: No
- Committed: Yes

**`packaging/scripts/`:**
- Purpose: CI/CD scripts for building and checksumming release zips
- Generated: No
- Committed: Yes

---

*Structure analysis: 2026-05-29*
