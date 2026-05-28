# Spec: Yulu Frontend — Unified Localhost UI

> **Status**: Draft — pending user review
> **Date**: 2026-05-26
> **Owner**: 不白 (yxliao.lewis@gmail.com)
> **Builds on**: Phase 1 (vocab + stt_daemon), Phase 2 (Prompt Library + summaries), Phase 3 (dual-track recording), Phase 4 (Voicemail Inbox), Phase 5 (Status Agent IPC + global hotkey), Phase 6 (FTS5 search), PR #21 (audio_daemon hardening)
> **Replaces**: nothing — pure addition of a new UI surface. CLI (`yulu memo`, `yulu search`, `yulu prompts`, `yulu doctor`, ...) and the menu-bar StatusAgent remain canonical; the web UI is a peer.
> **Out of scope** (future specs): multi-user / remote access (this ships 127.0.0.1 only); mobile / responsive layouts; in-browser audio editing; LLM prompt versioning UI; calendar event browser; live transcript scrubbing on past recordings; export workflows beyond what `yulu memo show` already prints.

---

## 1. Background and Motivation

After Phases 1–6 + the chip hardening, Yulu's surface area is:

- **6 SQLite databases** worth of state (`prompts.sqlite`, `vocab.sqlite`, `search.sqlite`, plus `agent-queue.json`, `schedule.json`, `config.json`)
- **~25 configurable values** in `config.json` spread across `audio`, `transcription`, `llm`, `calendars`, `status_agent`, and `voicemail` blocks
- **7 launchd daemons** (`audiodaemon`, `sttdaemon`, `agentqueue`, `statusagent`, `scheduler`, `detector`, `calendar`) each with their own log + Unix socket
- **3 corpora** (`~/Movies/Yulu/*.{wav,transcript.txt,summary.md}`, `~/Movies/Yulu/voicemails/`, plus their FTS5 index)
- **~22 `yulu` CLI subcommands** + the menu-bar status item

The CLI is excellent for power-user single-shot operations (`yulu search "OKR"`, `yulu memo show <id>`). The status-bar item is excellent for one-keystroke voicemail capture. **Neither is good at "browse what I've recorded this month" or "what's currently configured and how do I change it?"** — these are inherently visual / multi-axis operations.

This spec describes the first iteration of a unified localhost web UI that surfaces every configuration item, every corpus, every daemon's health, and every recording in one place. The goal is not to replace CLI/status-bar but to give "everything in one screen, click to dig in."

## 2. Goals

1. **One URL surfaces all of Yulu**: open `http://127.0.0.1:7777`, see live daemon status, browse all voicemails + meetings + summaries, edit every config value, manage prompts + glossary.
2. **Liquid-glass aesthetic, Ayu palette**: chrome (sidebar, top bar, floating recording pill) is glass-blurred; content sits naked on the wallpaper. Follow system light/dark, with manual override persisted.
3. **Live recording state**: the floating pill in the bottom-right is the singular recording surface — click to start when idle, shows elapsed time + level + Stop when recording. State is pushed live via WebSocket from `status_agent.sock`.
4. **Settings safety**: inline auto-save with daemon-restart awareness — when a change requires a daemon restart to take effect (e.g. `audio.silence_threshold` → `audio_daemon`), a top banner appears with a `Restart now` button. No silent stale state.
5. **Zero new IPC contracts**: the UI is a *consumer* of existing Unix sockets (`audio_daemon.sock`, `stt_daemon.sock`, `status_agent.sock`) and SQLite files. It does not invent new daemon-side protocols.
6. **127.0.0.1 only, no auth**: local-only by default; SSH tunneling is the documented escape hatch for remote access (`ssh -L 7777:localhost:7777 macbook`).
7. **Doctor-checkable**: `yulu doctor` reports `yulu_ui` daemon health (pid file, port reachable, last request, build version).

## 3. Non-Goals

- Replacing `yulu` CLI — all UI actions have a CLI equivalent and vice versa.
- Authentication, multi-user, role-based access. v1 is single-user single-machine.
- Mobile / responsive design. v1 targets Mac/Linux desktop browsers.
- In-browser audio editing (trim, splice). The UI plays + downloads; editing is a Phase 8+ topic.
- Streaming / live transcript for *past* recordings. Live transcript view is only for the currently-active recording.
- Spotlight-style global command palette (⌘K). Considered for v1, deferred to v2 once basic IA is validated.

## 4. Architecture

```
                ┌──────────────────────────────────────────────────────┐
                │                Browser (Vite-built React app)        │
                │  - Renders Ayu UI                                    │
                │  - tRPC calls over HTTP for queries / mutations      │
                │  - WebSocket for live recording state + transcript   │
                └────────────────┬─────────────────────────────────────┘
                                 │ http://127.0.0.1:7777
                                 ↓
                ┌──────────────────────────────────────────────────────┐
                │   yulu_ui (Node.js LaunchAgent, NEW)                 │
                │   - Hono HTTP server (static + tRPC + WS)            │
                │   - tRPC routers: voicemails/meetings/search/        │
                │     config/prompts/glossary/daemons/logs/recording   │
                │   - WebSocket /ws/recording (push state changes)     │
                │   - Reads ~/.config/yulu/*.sqlite via better-sqlite3 │
                │   - Reads ~/.config/yulu/config.json + writes back   │
                │   - Connects to existing Unix sockets as a CLIENT    │
                └─┬─────────────────┬──────────────┬───────────────────┘
                  │                 │              │
            Unix sockets      SQLite files    config.json + JSON state
                  │                 │              │
   ┌──────────────┼──────────────┐  │              │
   ↓              ↓              ↓  ↓              ↓
audio_daemon  stt_daemon  status_agent  prompts.sqlite  config.json
.sock        .sock       .sock          vocab.sqlite    schedule.json
                                         search.sqlite   agent-queue.json
```

### 4.1 Two daemons, not one

`yulu_ui` is its own LaunchAgent (`com.yulu.ui`) separate from existing daemons. Rationale:

- **Lifecycle isolation**: a Node crash should not take down audio_daemon. A status_agent rebuild should not require restarting the web server.
- **Tech stack isolation**: Python daemons (stt, agent_queue, scheduler, detector, calendar) stay Python; Swift apps (audio_daemon, status_agent) stay Swift; `yulu_ui` is Node. Each in its lane.
- **Restart-without-loss**: editing the UI bundle and restarting the Node daemon does not disturb in-flight recordings.

### 4.2 The UI is a client, not a coordinator

`yulu_ui` never mutates daemon state through anything other than the existing Unix-socket APIs. Concrete examples:

| User action | UI does | Effect on daemons |
| --- | --- | --- |
| Click "Record" in pill | `POST /trpc/recording.toggle` → opens `status_agent.sock`, writes `{"action":"toggle"}` | status_agent runs `onMenuToggle()` (same code path as ⌘⇧V hotkey) |
| Change `silence_threshold` in Settings | `POST /trpc/config.update {key, value}` → updates `config.json` + tracks "dirty daemons" set | nothing automatic; user clicks `Restart now` in banner → `POST /trpc/daemons.restart { name: "audio_daemon" }` which shells `launchctl unload && launchctl load` |
| Search "OKR" | `GET /trpc/search { query }` → calls existing `search.reader.search()` via spawned `python3 -m search.cli --json` | none |
| Edit a prompt | `POST /trpc/prompts.update {id, content}` → `UPDATE prompts SET ...` + SIGHUP `agent_queue_worker` (existing convention) | worker reloads PromptsCache |

This invariant keeps the UI a pure presentation/orchestration layer and avoids race conditions with the CLI.

## 5. Visual Design System

### 5.1 Ayu palette (CSS custom properties)

Two themes activated by `data-theme="dark" | "light"` on the root element. The page reads `prefers-color-scheme` on first load and writes the preference to `localStorage.yulu_theme`. A theme toggle in the top-right of the sidebar overrides; clicking "Auto" clears the localStorage entry.

```css
[data-theme="dark"] {  /* Ayu Mirage */
    --wp-1: #161A23;  --wp-2: #1F2430;  --wp-3: #2B3343;
    --glass:   rgba(255, 255, 255, 0.045);
    --glass-2: rgba(255, 255, 255, 0.08);
    --glass-3: rgba(255, 255, 255, 0.12);
    --edge:    rgba(255, 255, 255, 0.08);
    --edge-top:rgba(255, 255, 255, 0.14);
    --fg: #E4E4DE;  --fg-2: #8B92A0;  --fg-3: #5A6172;
    --accent: #FFCC66;  --accent-soft: rgba(255, 204, 102, 0.18);
    --blue:   #5CCFE6;  --green: #BAE67E;
    --red:    #FF7B72;  --purple: #DFBFFF;
    --shadow: 0 12px 32px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.20);
    --row-hover: rgba(255, 255, 255, 0.04);
}
[data-theme="light"] {  /* Ayu Light */
    --wp-1: #F0F2F5;  --wp-2: #F8FAFC;  --wp-3: #E5EAF1;
    --glass:   rgba(255, 255, 255, 0.55);
    --glass-2: rgba(255, 255, 255, 0.72);
    --glass-3: rgba(255, 255, 255, 0.88);
    --edge:    rgba(255, 255, 255, 0.80);
    --edge-top:rgba(255, 255, 255, 1);
    --fg: #3B4252;  --fg-2: #7A8290;  --fg-3: #A8AEB8;
    --accent: #F2AE49;  --accent-soft: rgba(242, 174, 73, 0.18);
    --blue:   #399EE6;  --green: #6CBF00;
    --red:    #E55050;  --purple: #8E5BD8;
    --shadow: 0 10px 28px rgba(60, 80, 110, 0.10), 0 1px 4px rgba(60, 80, 110, 0.05);
    --row-hover: rgba(0, 0, 0, 0.025);
}
```

### 5.2 Liquid Glass — restraint rules

Only **three surface types** carry the glass treatment:

1. **Sidebar** (left rail)
2. **Top bar** (breadcrumb + filters fused into one strip)
3. **Floating recording pill** (bottom-right)

Everything else — list rows, reader pane, settings rows, player chrome, tabs — sits directly on the wallpaper or uses subtle `--row-hover` for interactive feedback. Active rows use `--accent-soft` as a half-transparent fill. No hairline borders between content panels.

Glass tokens:
- `backdrop-filter: blur(28px) saturate(180%)` on Sidebar/TopBar
- `backdrop-filter: blur(32px) saturate(200%)` on Pill (stronger separation when over content)
- `border-radius: 12px` for panels, `22px` for the pill, `7-10px` for inner elements (active rows, tabs, filter pills)
- Edge highlight: `0 1px 0 var(--edge-top) inset` + `0 0 0 1px var(--edge)`

### 5.3 Typography

- System stack: `-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif`
- Monospace (timestamps, paths, code): `"SF Mono", ui-monospace, "JetBrains Mono", monospace`
- Sizes: `h2` 18px / `h3` 15px / body 13px / meta 11px / micro-label 9px uppercase tracking 0.10em
- No font weight above 600

### 5.4 Wallpaper

The frame background is a soft 3-stop gradient using `--wp-{1,2,3}`:

```css
background:
  radial-gradient(at 20% 0%,   var(--wp-3) 0%, transparent 50%),
  radial-gradient(at 100% 100%, var(--wp-3) 0%, transparent 60%),
  linear-gradient(135deg, var(--wp-1) 0%, var(--wp-2) 100%);
```

The radial highlights give the glass something to refract; without them the blur reads as flat.

## 6. Information Architecture

Sidebar (vertical, fixed 168 px, glass):

```
语 yulu

INBOX
  Voicemails        N
  Meetings          N
  Search

KNOWLEDGE
  Prompts           N
  Glossary          N

SETTINGS
  Audio
  Transcription
  LLM
  Hotkey & UI
  Integrations          (calendars + future telegram/slack)
  Storage               (output dirs, db paths)

HEALTH
  Daemons               7
  Logs
```

The "Recording" section is **deliberately not in the sidebar** — the bottom-right pill is the single locus for recording status and start/stop. Sidebar reflects browse / configure / inspect, not realtime state.

Counts on each item come from a single `GET /trpc/sidebar.counts` query that runs at mount and resubscribes via WebSocket when relevant tables/files change.

## 7. Page Designs

Each page sits inside the same Sidebar + Top bar shell. The Top bar always contains: breadcrumb (e.g. `Inbox / Voicemails`) + count pill + page-specific filters. Page body sits below the top bar with `gap: 10px`, no border between.

### 7.1 Inbox / Voicemails

Master-detail. Left: 220-px list. Right: reader.

**List item** (per row): title (first words of transcript), `<seconds>s · MM-DD HH:MM`, optional `✓` if summary exists. Hover: `--row-hover`. Active: `--accent-soft` fill + title in `--accent`.

**Reader** (right pane): title (filename stem), meta (date · duration · model), inline glass-soft audio player (play button + waveform from `wavesurfer.js` + time read-out), inline tab group `Transcript | Summary | Raw`, body in 13 px line-height 1.7. Speaker/vocab terms highlight in `--purple`.

Top-bar filters for Voicemails: `All | Summarized | Last 7d`. Multi-select OR semantics within "kind" group, AND across groups.

### 7.2 Inbox / Meetings

Same master-detail as Voicemails. Differences:

- List rows show meeting title (not transcript prefix), duration in `HH:MM:SS`, recorded date, and an attendee-count chip if extractable from filename.
- Reader has an extra tab `Realtime` (shows `<stem>.realtime.transcript.txt` if it exists — rough on-the-fly transcript).
- Filters: `All | Summarized | Last 30d | Has realtime`.

### 7.3 Inbox / Search

Top bar replaces filters with a search input + `--type` and `--in` dropdowns + `--since` chip group.

Body is a single column of result rows (no left list / right reader split). Each row: stem + meeting_title + recorded_at + score + snippet with `[hit]…[/hit]` rendered as `--accent`-colored. Click a row → opens its source kind (voicemail or meeting) in its own page with the matching tab pre-selected and the snippet auto-scrolled into view.

Telemetry footer: `<N> hits (<sweep_ms> ms sweep, <query_ms> ms query, FTS5|LIKE)`.

### 7.4 Knowledge / Prompts

Master-detail. Left list: prompt name + category chip (`summary`/`cleanup`/`voicemail`) + autorun ★ if `is_auto_run`. Reader: name, slug, category dropdown, autorun toggle, content textarea (monospace, 15-line min, auto-grow). Below: `Save` + `Delete` buttons. Save → `UPDATE prompts SET ...` + auto-SIGHUP agent_queue_worker.

Top-bar filters: `All | Summary | Cleanup | Voicemail`. New-prompt button on the right of filters opens an empty reader in "create" mode.

### 7.5 Knowledge / Glossary

Single-pane table (no reader). Columns: `term`, `pinyin (optional)`, `notes`, last-used date. Click cell to inline-edit. Top-bar action: `+ Add term`. Bulk delete via row checkboxes.

Changes auto-save row-by-row + send SIGHUP to stt_daemon (existing convention reloads VocabCache).

### 7.6 Settings / Audio

Single-pane "inline edit" rows. Each row:

```
[Label]               [Help text]            [editable value]  [status icon]
```

Editable value: clicking it converts to an `<input>` (text, number, or `<select>` for enum). Blur or `Enter` commits via `POST /trpc/config.update`. Status icon:
- `✓` green — saved, no daemon impact
- `⟳` accent — saved, but the affected daemon needs a restart for the new value to take effect
- typing indicator (subtle grey) — focused / unsaved

Above the rows, a sticky banner appears whenever any row's status is `⟳`:

```
● Changes saved. audio_daemon needs restart to apply: silence_threshold, silence_duration_sec    [Restart now]
```

`Restart now` calls `POST /trpc/daemons.restart { name: "audio_daemon" }`. The banner stays until either daemon restart completes (statuses flip back to `✓`) or the user un-changes the dirty values (revert to original; banner self-dismisses).

Row inventory (mirrors `config.json`):

- `Mic device` — `<select>` of `system_profiler SPAudioDataType` entries (cached, refreshable)
- `System audio device` — same as above (optional, `null` allowed = SYS_DISABLED)
- `Output dir` — text + folder-picker shortcut (`Reveal in Finder`)
- `Silence threshold` — number, 0-1, with help text "RMS below this counts as silence"
- `Silence duration sec` — number, seconds
- `Backend` — `<select>{ daemon }` (read-only single-option for v1)

### 7.7 Settings / Transcription

Same inline-edit pattern as 7.6. Rows:

- `Final engine` — `<select>{ mlx, whisper-cli }`
- `Language` — `<select>{ zh, en, ja, auto }`
- `Local model path` — text + file-picker (filtered to `~/.config/yulu/models/*.bin`)
- `MLX model` — `<select>` of installed mlx-community models (lazy-listed from `~/.cache/huggingface`)
- `MLX final model` — same
- `MLX preprocess audio` — toggle
- `MLX passthrough max sec` — number
- `MLX passthrough max bytes` — number

Glossary is rendered as a separate page (7.5) and intentionally NOT duplicated here — but a "Manage glossary →" link routes to /knowledge/glossary.

### 7.8 Settings / LLM

- `Enabled` — toggle
- `Command` — text array (one arg per row, drag to reorder, `+ Add` button). Default: `["claude", "--print", "--model", "claude-opus-4-7"]`
- `Test command` — button that runs the command with stdin `"hello, world"` and shows stdout in a glass popover

### 7.9 Settings / Hotkey & UI

- `Enabled (status agent)` — toggle (mirrors `status_agent.enabled`)
- `Hotkey` — special editor: click → "press your hotkey now" capture state; on capture, show preview (e.g. `⌘⇧V`) + `Save` (calls `yulu status-agent set-hotkey` which SIGHUPs the agent)
- `UI theme` — `Auto | Light | Dark` segmented control (same as the right-corner toggle, exposed here too)
- `Port` (this UI's HTTP server) — number, read-only with help "edit `com.yulu.ui.plist` and `yulu restart yulu_ui`"

### 7.10 Settings / Integrations

Calendars block from `config.json`. Each provider (feishu, google) gets a card-like row:

- Provider name + `Enabled` toggle
- Credentials path (text + file-picker)
- Account (text, e.g. `gog_account`)
- `Test connection` button → calls a tRPC mutation that runs the existing detector probe + shows pass/fail in a glass popover

### 7.11 Settings / Storage

- `Output dir` (mirrors `audio.output_dir`, kept here too)
- Database paths (read-only):
  - `~/.config/yulu/search.sqlite` — `<size>` / `<rows>` / "Reindex" button → `POST /trpc/search.reindex`
  - `~/.config/yulu/prompts.sqlite` — `<size>` / `<rows>`
  - `~/.config/yulu/vocab.sqlite` — `<size>` / `<rows>`
- Log paths (read-only with "Open in Finder" buttons)

### 7.12 Health / Daemons

Single-pane grid of cards, one per daemon (7 total). Each card:

- Daemon name (e.g. `com.yulu.audiodaemon`)
- Status pill: `● running` (green) | `⏸ stopped` (grey) | `⚠ crashed` (red)
- PID + uptime + last log line
- Three icon buttons: `Restart` (yellow) | `Stop` (red) | `View logs →`

Health data comes from a single `GET /trpc/daemons.health` polled every 5 s + invalidated immediately after any Restart/Stop action.

### 7.13 Health / Logs

Top-bar dropdown: select which daemon's log. Body: tail of the chosen log file, monospace, auto-scroll-to-bottom on new lines via WebSocket subscription to `/ws/logs/<name>`. Top-bar action: `Pause auto-scroll` + `Clear scrollback`.

## 8. Floating Recording Pill

Persistently rendered in the bottom-right of every page (`position: fixed`). Two states driven by WebSocket `/ws/recording`:

### 8.1 Idle state

```
[ 🎤 ]  Record   ⌘⇧V
```

- Click → `POST /trpc/recording.toggle` → status_agent picks up the toggle action via its IPC socket → starts a voicemail.
- The `⌘⇧V` glyph is a hint; the actual hotkey value is read from `config.status_agent.hotkey` on mount and live-updated on WebSocket message.

### 8.2 Recording state

```
[●pulse]  0:08   [▰▰▰▱▱▱]   [■]
```

- Pulsing red dot, elapsed time from `recording.started_at`, level meter from a derived 10-FPS RMS stream (status_agent computes; pushed via WS).
- `■` button → `POST /trpc/recording.toggle` → status_agent stops.

### 8.3 Special states

- `meetingBusy` (a meeting is recording, not a voicemail) — pill renders in grey with title `"Meeting in progress: <stem>"`, no Stop button (meetings stop via their own daemon).
- `processing` (just-stopped voicemail, transcribing) — pill shows a spinning ring + `Transcribing... <elapsed>s`, no controls.
- `daemonDown` (audio_daemon unreachable) — pill turns red-outlined with text `Audio daemon down`. Click → routes to `/health/daemons`.

## 9. Live State Model

Single WebSocket connection at `ws://127.0.0.1:7777/ws`. Server multiplexes channels by subscription:

- `recording` — payload `{ state, file, elapsed_sec, level }` on every change + at 10 Hz during recording
- `daemons` — payload `{ name, status, pid, last_log }` on launchd state-change + every 5 s
- `logs/<name>` — payload `{ line, ts }` per new log line (client-tailed)
- `sidebar-counts` — payload `{ voicemails, meetings, prompts, glossary }` after any mutation that affects these

`recording` and `daemons` are always subscribed (chrome shows them). `logs/<name>` and `sidebar-counts` subscribe on-demand from the relevant page.

When the WebSocket disconnects (server restart, network blip), the UI shows a grey banner `Reconnecting…` at the top of the main pane and auto-retries with exponential backoff up to 30 s.

## 10. Data Layer (tRPC routers)

```
trpc/
├── voicemails.{list, get, delete, audioUrl, transcript, summary}
├── meetings.{list, get, delete, audioUrl, transcript, summary, realtime}
├── search.{run, reindex, doctor}
├── config.{get, update}
├── prompts.{list, get, create, update, delete, reorder}
├── glossary.{list, add, update, delete}
├── daemons.{health, restart, stop, start}
├── logs.{tail (returns last N), subscribe (WS)}
├── recording.{state, toggle, openInbox}
├── sidebar.{counts}
└── system.{version, doctor (mirrors `yulu doctor`)}
```

Implementation notes:

- All reads of `prompts.sqlite` / `vocab.sqlite` / `search.sqlite` use `better-sqlite3` opened read-write with WAL.
- All reads of `config.json` go through a small `ConfigManager` that diffs old vs new and emits a "needs restart" set per daemon (the diff rules table is documented in §11).
- `daemons.restart` shells out to `launchctl unload && load` for the named plist + waits for socket reappearance (with 10 s timeout).
- `recording.toggle` opens `~/.config/yulu/status_agent.sock` and writes `{"action":"toggle"}\n` + `shutdown(SHUT_WR)` + reads response (canonical SHUT_WR framing).
- `search.run` directly imports the same logic that `yulu search` uses by spawning `python3 -m search.cli --json` (this keeps logic in Python; we don't re-implement FTS5 in Node).

## 11. Config Diff → Restart Map

When the user mutates `config.json`, ConfigManager looks up the changed key in this table and adds the named daemon(s) to the "needs restart" set surfaced in the Settings banner:

| Config key                                | Daemon to restart        |
| ----------------------------------------- | ------------------------ |
| `audio.mic_device`                        | `audiodaemon`            |
| `audio.system_audio_device`               | `audiodaemon`            |
| `audio.silence_threshold`                 | `audiodaemon`            |
| `audio.silence_duration_sec`              | `audiodaemon`            |
| `audio.output_dir`                        | none (per-request)       |
| `audio.backend`                           | `audiodaemon`            |
| `transcription.final_engine`              | `sttdaemon`              |
| `transcription.language`                  | `sttdaemon` (SIGHUP OK)  |
| `transcription.mlx.*`                     | `sttdaemon`              |
| `transcription.glossary`                  | `sttdaemon` (SIGHUP)     |
| `transcription.command`                   | `sttdaemon`              |
| `llm.enabled`                             | `agentqueue` (SIGHUP)    |
| `llm.command`                             | `agentqueue` (SIGHUP)    |
| `calendars.*`                             | `calendar`, `scheduler`  |
| `status_agent.enabled`                    | `statusagent`            |
| `status_agent.hotkey`                     | `statusagent` (SIGHUP)   |

"SIGHUP" entries don't show a `Restart` banner — they hot-reload silently (and the status icon flashes to `✓` immediately). "Restart" entries surface the banner.

## 12. Install / Deploy

### 12.1 New LaunchAgent

`yulu/scripts/com.yulu.ui.plist` (templated, similar to existing plists):

```xml
<key>Label</key><string>com.yulu.ui</string>
<key>ProgramArguments</key>
<array>
    <string>__YULU_UI_NODE__</string>          <!-- /opt/homebrew/bin/node or similar -->
    <string>__SCRIPT_DIR__/yulu_ui/dist/server.js</string>
</array>
<key>EnvironmentVariables</key>
<dict>
    <key>YULU_UI_PORT</key><string>7777</string>
    <key>NODE_ENV</key><string>production</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>__HOME__/.config/yulu/ui.log</string>
<key>StandardErrorPath</key><string>__HOME__/.config/yulu/ui.log</string>
```

### 12.2 setup.sh changes

After existing daemon installs:

1. Check `node --version` ≥ 20; if missing, prompt to `brew install node`.
2. `cd yulu/scripts/yulu_ui && npm ci && npm run build` (produces `dist/server.js` + bundled static assets).
3. Render plist template, copy to `~/Library/LaunchAgents/`, `launchctl load`.
4. After a 2 s wait, `curl http://127.0.0.1:7777/healthz` → expect 200.
5. Print `yulu ui open` instruction (opens default browser).

### 12.3 yulu CLI additions

- `yulu ui open` — `open http://127.0.0.1:7777`
- `yulu ui status` — pings `/healthz`, prints port + uptime + last 5 log lines
- `yulu ui restart` — `launchctl unload && load` shortcut

### 12.4 Doctor integration

`yulu doctor` gains a `yulu_ui` block:

```
✓ yulu_ui: port=7777 reachable=True pid=12345 uptime=4h22m build=0.7.0+sha.abc1234
  http://127.0.0.1:7777
```

### 12.5 Release packaging

The release workflow (`.github/workflows/release.yml`) gains a build step:

- `npm ci && npm run build` inside `yulu/scripts/yulu_ui/`
- Tarball includes the built `dist/` directory (no Node modules; install.sh runs `npm ci --production` on the user's machine)

## 13. Acceptance Criteria

Each criterion maps to either a runnable test (in `yulu_ui/tests/`) or a documented manual smoke step.

1. **Server starts** — `launchctl load com.yulu.ui.plist` + `curl /healthz` returns 200 within 5 s.
2. **Theme persists** — switch to Light, refresh, theme is still Light. Switch to Auto, refresh, theme follows `prefers-color-scheme`.
3. **Sidebar counts live-update** — adding a voicemail via `yulu memo new` increments the `Voicemails` count without page reload (within 2 s of WS push).
4. **Voicemails master-detail** — clicking a row populates the reader with title, audio player, and transcript; switching to Summary tab shows summary.md content.
5. **Audio playback** — `▶` plays the wav, `0:00 / 0:13` updates each second.
6. **Search round-trip** — typing "OKR" in /inbox/search and hitting Enter returns the same hits as `yulu search "OKR" --json`.
7. **Config inline edit + restart banner** — changing `silence_threshold` from 0.01 → 0.015 saves immediately; banner appears with `Restart now`; clicking it issues `launchctl unload && load` on audiodaemon, and within 10 s the status flips back to `✓`.
8. **Hotkey capture** — clicking the hotkey field, pressing `⌥F19`, clicking Save → `config.json.status_agent.hotkey = {key: "F19", modifiers: ["alt"]}` and the status agent re-registers (SIGHUP).
9. **Prompt edit triggers SIGHUP** — editing a prompt's content + save → next summary generation uses the new text.
10. **Glossary add triggers stt SIGHUP** — adding "AgentKey" to glossary → next transcription has it in the bias prompt.
11. **Daemons page reflects launchctl reality** — `launchctl stop com.yulu.audiodaemon` outside the UI; within 5 s the audio_daemon card flips to `⏸ stopped`.
12. **Logs tail live** — opening Logs / audio_daemon, then writing a line via `echo test >> ~/.config/yulu/audio_daemon.log`, shows the line within 2 s.
13. **Recording pill idle → recording → idle** — click pill, status flips to recording within 1 s, level meter animates; click again, returns to idle within 1 s + processing intermediate.
14. **Meeting busy state** — start a meeting recording via meeting_daemon, pill shows greyed `Meeting in progress: <stem>` and Stop button is hidden.
15. **Doctor reports yulu_ui** — `yulu doctor` includes a `yulu_ui` block with port, pid, uptime, build.
16. **WebSocket reconnect** — `launchctl unload com.yulu.ui` → reload after 5 s → UI's "Reconnecting…" banner appears then dismisses; live updates resume.
17. **127.0.0.1 only** — `curl --interface en0 http://<lan-ip>:7777` is rejected (connection refused).
18. **Restart-while-recording safety** — restarting yulu_ui mid-recording does not interrupt audio_daemon's capture; reopening the UI shows the still-active recording in the pill.

## 14. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Node.js becomes a new dependency to maintain | setup.sh prompts for `brew install node`; CI release builds + ships pre-built `dist/`; the runtime requirement is documented in README. |
| `better-sqlite3` native binary mismatches Node version on user's machine | Build script runs `npm rebuild better-sqlite3` against the user's local Node; doctor surface flags ABI mismatch with clear error. |
| Browser local CSS `backdrop-filter` performance hits on Intel Macs | Glass is restricted to 3 surfaces. We monitor frame rate in dev; if measurable jank, drop saturation amount before dropping blur. |
| Settings inline-edit races with manual `config.json` edits | UI reads `mtime` before write; if mismatched (someone else wrote to the file), refuse the save with a clear `Config file changed externally — reload?` banner. |
| WebSocket connection from many UI tabs at once | Cap concurrent WS connections at 10 per `yulu_ui` process; first-in-wins. Reasonable for single-user. |
| Daemon restart during pending IPC operation | tRPC mutations wrap `launchctl` calls; we wait for socket file recreation (5 s budget) before returning success. UI shows progress spinner during the wait. |
| Audio file streaming (large WAVs) over HTTP | Use `Accept-Ranges: bytes` + `Range` requests served by `serveStatic`; browser handles partial loading. No re-encoding. |
| Liquid Glass on Light theme washes out content | Light glass tokens use `rgba(255,255,255,0.55-0.88)` — opaque enough that text contrast passes WCAG AA. Verified in mockups. |

## 15. Architecture Decisions (will become ADR-007 after implementation)

1. **Separate Node LaunchAgent (`yulu_ui`) instead of extending an existing daemon** — lifecycle isolation, tech-stack isolation, restart-without-loss.
2. **127.0.0.1 only, no auth in v1** — local-only product, no network exposure; SSH tunnel is the documented escape hatch.
3. **UI is a pure client** — never invents new daemon-side protocols; always speaks via existing Unix sockets / SQLite. Keeps the CLI and UI from drifting.
4. **Liquid Glass restraint** — only chrome (3 surfaces) is glass; content is naked on wallpaper. Avoids the "everything blurry" anti-pattern.
5. **Ayu Mirage (not Ayu Dark proper) for the dark theme** — softer base, less pure black; matches macOS Tahoe surface tone better.
6. **WebSocket multiplexed by channel** — single connection, server-side dispatch, instead of multiple SSE / multiple WS connections. Simpler reconnect, fewer open sockets.

## 16. Open Questions (to resolve during planning)

1. **Audio waveform library** — `wavesurfer.js` is mature but ~80 KB. Alternative: render a static gradient pseudo-waveform (no actual waveform) and rely on the play timer + scrub-bar. v1 default: static pseudo-waveform; upgrade to wavesurfer.js in Phase 2 of the implementation plan if the user wants real waveform.
2. **Per-recording soft-delete vs hard-delete** — Delete button currently moves files to `~/.Trash` (soft) or `rm -f` (hard)? Recommend soft for safety; deferred to planning.
3. **Glossary CSV import / export** — out of scope for v1; CLI `yulu vocab` already supports this. Listed as v2 candidate.
4. **Light/dark theme switch animation** — instant flip or 200 ms cross-fade? Default to instant; revisit if it feels jarring.
