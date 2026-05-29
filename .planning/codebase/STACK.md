# Technology Stack

**Analysis Date:** 2026-05-29

## Languages

**Primary:**
- Python 3 (≥3.8, `python3` on system PATH) — all daemon scripts, STT engine, agent queue, calendar, installer, CLI
- Swift 5 (Xcode CLI tools `swiftc`) — `audio_daemon.swift`, `window_scanner.swift`, `recorder_status.swift`, `status_agent.swift`

**Secondary:**
- TypeScript 5.6 — `yulu_ui` server (`src/`) and web front-end (`web/src/`)
- Bash — `install.sh`, `setup.sh`, `uninstall.sh`, `build_audio_daemon.sh`, `build_status_agent.sh`, `packaging/scripts/package.sh`, `packaging/scripts/checksums.sh`, `yulu/scripts/yulu` CLI shim

## Runtime

**Environment:**
- macOS only (enforced at install time via `uname -s == Darwin`)
- Production: macOS 13+ (ScreenCaptureKit requirement)
- Architecture: ARM64 (Apple Silicon) primary; whisper.cpp path supports Intel

**Package Manager:**
- Python: system `python3` (no pinned version file) + isolated venv at `~/.config/yulu/venv-mlx-whisper/`
- Node: npm (lockfile `yulu/scripts/yulu_ui/package-lock.json` present)
- Homebrew: brew for system-level deps (see below)

**Lockfile:**
- Node: `package-lock.json` present — `npm ci` used in CI and setup
- Python: no `requirements.txt` or lockfile; mlx-whisper installed via `pip install --upgrade mlx-whisper` into the isolated venv

## Frameworks

**Core Python:**
- stdlib only — `asyncio`, `sqlite3`, `socket`, `subprocess`, `json`, `pathlib`, `http.server`, `wave`, `fcntl`
- `numpy` — used in `echo_cancel.py` for audio processing (only external Python dep in main scripts)

**STT Engine:**
- `mlx-whisper` — installed into `~/.config/yulu/venv-mlx-whisper/`; imported in-process by `stt_daemon/backends/mlx.py`; model downloaded lazily from HuggingFace on first transcription

**Web UI (yulu_ui):**
- Hono 4.6 — HTTP server framework (`src/server.ts`)
- tRPC 11 — type-safe RPC between server and React front-end (`src/trpc.ts`, `src/routers/`)
- React 18.3 + React Router 7 — SPA (`web/src/`)
- TanStack Query 5.59 — data fetching (`@tanstack/react-query`)
- better-sqlite3 11.5 — SQLite access from Node (`src/db.ts`)
- wavesurfer.js 7.8 — audio waveform playback in browser
- Zod 3.23 — schema validation
- ws 8.18 — WebSocket server

**Testing:**
- Python: `pytest` (installed into `.venv-ci` in CI; `make pytest`)
- Node: Vitest 3, `@testing-library/react`, `jsdom`, `mock-socket`, Playwright (e2e)

**Build/Dev:**
- Node: Vite 6 (web front-end), esbuild 0.25 (server bundle via `esbuild.config.mjs`), tsx (dev server hot-reload), concurrently
- Swift: `swiftc` from Xcode CLI tools — no Xcode project file; direct invocation
- Bash: `packaging/scripts/package.sh` uses `rsync` + `zip` for release asset

## Key Dependencies

**Critical:**
- `mlx-whisper` (venv) — on-device transcription for Apple Silicon; `mlx-community/whisper-large-v3-mlx` or `whisper-large-v3-turbo` downloaded from HuggingFace
- `better-sqlite3` — powers prompts.sqlite, vocab.sqlite, search.sqlite from Node UI server
- `hono` + `@trpc/server` — define the entire local API surface consumed by the React SPA

**Infrastructure:**
- `@tanstack/react-query` — all server state in the SPA
- `react-router` v7 — SPA routing
- `zod` — shared schema validation between server and client
- `wavesurfer.js` — audio playback in meeting/voicemail views

## Configuration

**Environment:**
- No `.env` files in the codebase; all runtime config via `~/.config/yulu/config.json`
- `config.example.json` (`yulu/scripts/config.example.json`) is the authoritative schema reference
- Key config sections: `audio`, `transcription`, `llm`, `output`, `calendars`, `meeting_detection`, `stt_daemon`, `status_agent`
- `llm.command` controls which LLM backend runs summaries (`null` = agent-queue mode; `["claude","--print"]` = Claude CLI; `["python3", "codex_llm.py"]` = Codex shim; any list = custom)

**Build:**
- `yulu/scripts/yulu_ui/tsconfig.json` — TypeScript compiler config (ES2022 target, strict)
- `yulu/scripts/yulu_ui/web/vite.config.ts` — Vite config for web front-end (proxy to `:7777`)
- `yulu/scripts/yulu_ui/esbuild.config.mjs` — server bundle config (platform=node, target=node20, externalize `better-sqlite3`)
- `yulu/scripts/yulu_ui/vitest.config.ts` + `vitest.workspace.ts` — test config
- `Makefile` — top-level dev tasks: `make test`, `make package TAG=vX.Y.Z`, `make checksums`, `make dev-install`, `make sync-skill`

## Homebrew System Dependencies

**Installed by `setup.sh` via `brew install`:**
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

**Version tracking:**
- `VERSION` file at repo root (e.g. `0.5.1`); managed by `release-please`
- `yulu/scripts/version.py` — reads `VERSION`, exposes `--check` / `--json` / `--short`

**Release pipeline:**
1. `release-please-action@v5` (`.github/workflows/release-please.yml`) — watches `main` for Conventional Commits, maintains rolling Release PR, bumps `VERSION` + `CHANGELOG.md`
2. On Release PR merge → `release-please.yml` calls `release-publish.yml` (reusable workflow)
3. `release-publish.yml` on `macos-latest`: runs full test suite, calls `make package TAG=vX.Y.Z`, calls `make checksums`, uploads `dist/yulu-macos-arm64-vX.Y.Z.zip` + `dist/checksums.txt` + `dist/install.sh` to GitHub Releases
4. Manual escape hatch: push a `v*.*.*` tag → `.github/workflows/release.yml` calls the same reusable workflow

**Packaging (`packaging/scripts/package.sh`):**
- Compiles `Yulu.app` and `StatusAgent.app` via `build_audio_daemon.sh` / `build_status_agent.sh`
- Uses `rsync` (or `tar` fallback) to stage repo into `dist/yulu/`, excluding `.git`, `.github`, `tests`, `docs/superpowers`, `packaging`, build artifacts
- Reproducible timestamps (all files set to `202001010000`)
- Zips staged tree as `dist/yulu-macos-arm64-vX.Y.Z.zip`
- `packaging/scripts/checksums.sh` writes SHA-256 `checksums.txt`

**User install flow:**
1. `curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash`
2. `install.sh` downloads `release_installer.py` from raw GitHub and runs it
3. `release_installer.py`: fetches GitHub Releases API → downloads zip + `checksums.txt` → SHA-256 verifies → extracts to `~/.yulu/` (restoring Unix exec bits from `external_attr`) → runs `setup.sh`
4. `setup.sh`: installs Homebrew deps, creates config, configures transcription engine, compiles Swift binaries, installs LaunchAgents, builds `yulu_ui`, installs `yulu` CLI symlink at `~/.local/bin/yulu`

**CI (`.github/workflows/ci.yml`):**
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

**Development:**
- macOS (arm64 recommended)
- Xcode Command Line Tools (`xcode-select --install`) — required for `swiftc`
- Homebrew
- Python 3 (system)
- Node.js 20+ (for `yulu_ui`)

**Production:**
- Installed to `~/.yulu/` (or custom `$INSTALL_DIR`)
- Runtime config and models in `~/.config/yulu/`
- Recordings default to `~/Movies/Yulu/`
- LaunchAgents in `~/Library/LaunchAgents/` (`com.yulu.*` plists)

---

*Stack analysis: 2026-05-29*
