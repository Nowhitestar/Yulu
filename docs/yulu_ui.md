# Yulu Web UI

The required local Host and web UI at `http://127.0.0.1:7777/`. It owns durable
recording tasks, authenticated MCP endpoints, Agent artifact commits, recovery,
and the browser surface. `com.yulu.ui` starts it on login and restarts it on
crash.

## Pages

The window is two panes: recordings on the left, the open recording on the
right. The left pane becomes the settings list inside Settings and can be
hidden (toolbar toggle or `Ctrl-Cmd-S`). The toolbar holds only that toggle,
Settings, and the record control; `Cmd-K` opens a command palette that jumps to
any page and searches recordings, summaries, and settings.

- `/inbox` `/inbox/:stem` — recordings and the reader: playback, committed
  summary/transcript, Share, and a More menu (template, regenerate, re-transcribe,
  rename, delete)
- `/settings/{general,recording,meetings,voice,connections}` — preferences.
  `voice` includes shortcuts and recent dictation; `connections` registers
  Yulu's MCP endpoint with detected Agents, and selects AI services for
  transcription and summary
- `/knowledge/prompts` `/knowledge/prompts/:id` — summary and dictation templates
- `/knowledge/glossary` — terms transcription should spell your way
- `/health` — runtime status, with Doctor, the task queue, scheduler, installed
  services, and logs under advanced diagnostics
- `/onboarding` `/activate` — first-run setup and the first recording

There is no assistant page: other Agents read and control meetings through
MCP. `/agent-console`, `/voice-chat`, `/voice-input`, and older inbox, settings,
and health deep links redirect to their current pages. ADR-010 retired the
Host's conversation APIs with them.

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

The LaunchAgent writes stdout + stderr to `~/Library/Logs/Yulu/ui.log`. Tail it via:

```bash
yulu logs ui                              # tail -f
tail -f "$HOME/Library/Logs/Yulu/ui.log"
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
