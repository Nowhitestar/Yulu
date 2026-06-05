# Yulu Web UI

A local web UI at `http://127.0.0.1:7777/` for browsing meetings, settings,
prompts, glossary, and daemon health. Runs as the `com.yulu.ui` LaunchAgent — auto-starts
on login, restarts on crash.

## Pages

- `/inbox` `/inbox/:stem` — recordings (meetings) list + audio waveform + transcript/summary/raw/realtime tabs. (Legacy `/inbox/voicemails` and `/inbox/meetings` links redirect here.)
- `/inbox/search` — full-text search across recordings with cross-page navigation
- `/settings/{audio,transcription,llm,integrations,storage}` — inline-edit settings with restart banner
- `/knowledge/prompts` `/knowledge/prompts/:id` `/knowledge/prompts/new` — prompt master-detail
- `/knowledge/glossary` — vocabulary table with inline-edit + bulk delete
- `/health/daemons` — 8 daemon status cards (auto-poll 5 s)
- `/health/logs` — live log tail via WebSocket

## Layout

```
yulu/scripts/yulu_ui/
├── src/            # Node server (Hono + tRPC + WebSocket multiplexer)
├── web/            # React 18 + Vite 5 SPA
├── dist/           # Build output — produced by `npm run build`
├── tests/          # vitest (server + jsdom)
└── e2e/            # Playwright critical-flow tests (manual)
```

## Production install

`setup.sh` (and `setup.sh --upgrade`) handles this automatically:

1. `npm ci` (skipped when `package-lock.json` SHA matches the stored marker)
2. `npm run build` → `dist/server.js` + `dist/web/`
3. Install `com.yulu.ui.plist` to `~/Library/LaunchAgents/`
4. `launchctl load` → server listens on `127.0.0.1:7777`
5. Poll `/healthz` for up to 10 s

To restart manually:

```bash
launchctl unload ~/Library/LaunchAgents/com.yulu.ui.plist
launchctl load   ~/Library/LaunchAgents/com.yulu.ui.plist
```

## Development workflow

```bash
cd yulu/scripts/yulu_ui
npm install
npm run dev        # vite :5173 (web HMR) + tsx watch :7777 (server)
```

Tests:

```bash
npm run typecheck  # tsc --noEmit
npm test           # vitest (server + jsdom projects)
npm run e2e        # Playwright critical-flow sweep (chromium)
```

## Logs

The LaunchAgent writes stdout + stderr to `~/.config/yulu/ui.log`. Tail it via:

```bash
yulu logs ui                              # tail -f
tail -f ~/.config/yulu/ui.log
```

You can also tail any of the 8 daemon logs from inside the web UI at `/health/logs`.

## Doctor

```bash
yulu doctor                # human output (includes yulu_ui block)
yulu doctor --json         # full report shape; yulu_ui at key `yulu_ui`
```

`yulu_ui` checks: `dist/server.js`, `dist/web/index.html`, plist installed, launchctl
loaded, `/healthz` response, log size. UI is treated as optional — missing artifacts
do not flip the overall doctor exit code.
