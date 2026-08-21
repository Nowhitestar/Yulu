# Yulu Web UI

The required local Host and web UI at `http://127.0.0.1:7777/`. It owns durable
recording tasks, authenticated MCP endpoints, Agent artifact commits, recovery,
and the browser surface. `com.yulu.ui` starts it on login and restarts it on
crash.

## Pages

- `/agent-console` — selected general Agent, recording controls, and recent durable task state
- `/voice-input` — dictation and translation through the explicitly selected local/xAI audio engine
- `/inbox` `/inbox/:stem` — recordings, playback, committed transcript/summary, and task/delivery actions
- `/settings/{general,audio,transcription,voice,automation}` — current local preferences
- `/knowledge/prompts` `/knowledge/prompts/:id` — Agent instruction prompt master-detail
- `/knowledge/glossary` — vocabulary table with inline-edit + bulk delete
- `/health` — Doctor, durable task queue, scheduler, installed services, and logs

Legacy inbox/settings/health deep links redirect to their current consolidated
pages.

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

1. Release install: verify the CI-built `dist/`, then run `npm ci --omit=dev`
   only for native/runtime dependencies; never rewrite the signed release files.
2. Development install: run `npm ci`, then `npm run build` to produce
   `dist/server.js` + `dist/web/`.
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

You can also inspect current service logs from the Logs section on `/health`.

## Doctor

```bash
yulu doctor                # human output (includes yulu_ui block)
yulu doctor --json         # full report shape; yulu_ui at key `yulu_ui`
```

`yulu_ui` checks `dist/server.js`, `dist/web/index.html`, the installed plist,
launchctl state, `/healthz`, and the log. When `agent_pipeline.enabled=true`, a
missing or unreachable Host makes `yulu doctor` fail.
