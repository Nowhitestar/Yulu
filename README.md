<div align="center">
  <img src="assets/logo.svg" width="104" alt="Yulu logo" />
  <h1>Yulu</h1>
  <p><b>Native meeting capture. Live captions. Agent-ready memory.</b></p>
  <a href="https://github.com/Nowhitestar/Yulu/stargazers"><img src="https://img.shields.io/github/stars/Nowhitestar/Yulu?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/Nowhitestar/Yulu/releases"><img src="https://img.shields.io/github/v/tag/Nowhitestar/Yulu?label=version&style=flat-square" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/macOS-13%2B-black?style=flat-square&logo=apple" alt="macOS 13+">
  <p><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>
</div>

Yulu (语录, *yǔ lù*) is a macOS meeting workspace built around local files and
the Agents you already use. It records system audio and microphone input without
a virtual audio device, shows movable realtime captions, turns meetings into
searchable transcripts and summaries, and lets Agents work across that history.

There is no Yulu account. Recordings and task state stay on your Mac. Yulu uses
the audio engine you explicitly select for realtime captions, final transcription,
and dictation: local by default, or xAI cloud through one Grok-compatible OAuth
or explicitly chosen API-key connection managed by Yulu. Yulu never silently
switches between them or between credential sources.

Transcription, Summary Provider, and Conversation Provider selections are
independent. Durable summary work and locally stored conversations retain their
creation-time provider/model identity; changing Settings affects only new work.
If the pinned Summary Provider is unavailable, the committed transcript and task
pause locally until an explicit same-provider retry instead of falling back.
For xAI summaries, Yulu sends only the task's selected instructions and committed
transcript, disables response storage, and saves validated Markdown through the
same durable artifact transaction used by Agent-backed summaries.

Core Activation names the exact selected Summary Provider and model. xAI is
ready only after its current model and credential source pass a real capability
probe and the current versioned Data Path Disclosure is accepted; OAuth or API
key presence is not acceptance to send transcript text. Activation lists only
connections that currently satisfy the shared Summary contract: direct xAI,
Codex, Claude Code, or CLIProxyAPI. Hermes and OpenClaw are Conversation-only
and never appear as Summary choices.

When activation readiness is green, `/activate` starts the same production
recorder used elsewhere in Yulu and suggests a natural 10–20 second recording.
Its durable Host task keeps processing after navigation or restart. Verified
audio, transcript, summary, integrity, and provider provenance establish the
milestone; guided completion opens the saved note, while other qualifying
recordings show a nonblocking link without changing the current page.

## What you can do

| Experience | What Yulu provides |
|---|---|
| Record a meeting | Native ScreenCaptureKit system audio plus AVFoundation microphone capture, started from the UI, menu bar, calendar/window detection, CLI, or MCP |
| Follow live captions | Movie-style captions on the active display, draggable from the bottom center, with source-only, bilingual, or translation-only display; an optional private sherpa-onnx Paraformer INT8 model provides low-latency source text |
| Review every meeting | Audio playback, transcript, summary, tags, speaker corrections, templates, glossary terms, and local search in one recording library |
| Run each action explicitly | Re-transcribe, regenerate the summary, and share the summary are independent actions that can be repeated separately |
| Ask across meeting history | Agent Console pins the selected Conversation Provider: xAI receives only bounded local excerpts/history, while Agent-backed conversations retain that Agent's own retrieval and connectors |
| Speak instead of type | Global shortcuts provide dictation, quick translation, and voice questions that continue in Agent Console |
| Inspect the system | Settings and Health expose permissions, capabilities, durable tasks, daemons, scheduler state, and logs |

## Current interface

<p align="center">
  <img src="assets/demos/agent-console-desktop.png" alt="Yulu Agent Console with the current blue quotation-mark logo and recording controls" />
</p>

Agent Console is the default workspace. Start or stop recording, see recent
meeting work, ask questions across local history, and inspect the selected
provider without leaving the page. xAI conversations search locally first,
send nothing when no excerpt matches, and keep source cards and history local.
The session also pins the xAI credential source and verifies the response model.
Failures preserve the provider/model/credential identity, evidence snapshot, and
history until one explicit same-snapshot retry or a new conversation.

Open **Settings → Intelligent Services** for the authoritative Agent Connection
Center. It connects, discloses, tests, selects, repairs, and deletes each
capability without sending a model request merely because the page opened.
Activation and Agent Console deep-link to that exact connection and capability.
New conversations require an explicit ready selection; existing pinned sessions
keep their creation-time provider, model, connection, and native session.

<p align="center">
  <img src="assets/demos/recordings-reader.png" alt="Yulu recording library with audio playback and transcript reader" />
</p>

The recording reader keeps the original audio, transcript, summary, and manual
actions together. Demo titles and transcript text in these screenshots are
synthetic.

## Realtime captions and translation

When recording starts, Yulu places pure movie-style subtitles near the bottom
center of the currently active display.

- Source text is the default. Install the optional local model from Settings → Transcription for private captions and transcription, or explicitly select xAI for cloud speech-to-text. The selected engine handles the whole audio path without automatic switching.
- Choose a target language and switch between source-only, bilingual, and
  translation-only views while the meeting is live.
- Drag the six-dot handle to move the caption overlay anywhere on the display.
- The recording toolbar stays visible while you interact with it, then reduces
  to a centered red dot and “Recording” state after three seconds of inactivity.
- Hover the recording state to reveal “Click to stop”.
- Collapse the captions into the breathing Yulu quotation-mark logo; click the
  logo to restore them.
- When recording stops, the overlay disappears completely.

## Quick start

### Requirements

- macOS 13 or later.
- Apple Silicon (arm64) for official release installs.
- Python 3.10 or newer.
- A ready Summary Provider connection in Settings (xAI, Codex, Claude Code, or
  CLIProxyAPI) when you want automatic summaries. Hermes is required only for
  authorized connector delivery; Hermes and OpenClaw remain Conversation-only.
- The local transcription model (default), or xAI OAuth authorized directly in
  Settings plus the current Cloud Transcription Consent when you explicitly
  select xAI.
- Optionally, Codex CLI, Claude Code, OpenClaw, Hermes, or a custom command for
  Agent Console conversation.

The installer provisions a compatible Node.js runtime and Yulu's audio tools
when they are missing.

### Install

Latest stable release:

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash
```

Then make sure the CLI is on your shell path:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
exec zsh
```

Yulu installs under `~/.yulu`, opens the setup flow, and guides you through the
three macOS permissions it needs:

| Component | Permission | Why |
|---|---|---|
| `Yulu.app` | Microphone | Capture your microphone |
| `Yulu.app` | Screen & System Audio Recording | Capture meeting playback with ScreenCaptureKit |
| `window_scanner` | Accessibility | Detect supported meeting windows and titles |

Open the local workspace at
[`http://127.0.0.1:7777/agent-console`](http://127.0.0.1:7777/agent-console),
or start your first recording from the menu bar or CLI:

```bash
yulu record start "Product weekly"
yulu record status
yulu record stop
```

### Install another channel

```bash
# One specific release
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --version v0.21.0

# Current main branch for development dogfood
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --dev
```

### Update or uninstall

```bash
yulu update                    # latest stable
yulu update --version v0.21.0  # one specific release
yulu update --dev              # current main branch
yulu uninstall
```

Updates preserve configuration, recordings, and macOS permissions. Stable
updates verify the published checksum before replacing the installed runtime.

## How Yulu works

```text
UI / menu bar / calendar / window detection / CLI / MCP
                         |
                         v
        Yulu.app native system + microphone capture
                         |
             +-----------+-----------+
             |                       |
             v                       v
      live captions          local WAV recording
      + translation                   |
                                      v
                            authenticated local Host
                         |                         |
                         v                         v
             selected Yulu audio engine    durable task + lease
             local (default) or xAI               |
                         |                         v
                         +----> transcript commit -> pinned Summary Provider
                                      |
                         optional authorized sharing

Agent Console -> selected general Agent -> that Agent's connectors
```

The split is intentional:

- **Yulu** owns native capture, permissions, local files, durable task state,
  artifact commits, recovery, and authorization boundaries.
- **The selected Yulu audio engine** owns realtime captions, final transcripts,
  and dictation. Selection is explicit and never falls back automatically.
- **The pinned Summary Provider** owns summary generation through the exact
  eligible xAI, Codex, Claude Code, or CLIProxyAPI connection selected when the
  task was created. Hermes may still own explicitly authorized Notion delivery.
- **The selected general Agent** owns Agent Console conversation and its own
  connectors.

If the Host is unavailable when capture ends, Yulu atomically spools the
completion event and replays it after recovery without duplicating the automatic
task. See [Architecture](docs/ARCHITECTURE.md) for the full contract.

## CLI reference

| Command | Purpose |
|---|---|
| `yulu status` | Show service, capture-socket, recording, and UI health |
| `yulu doctor [--json]` | Diagnose permissions, Host tasks, search, and Agent capabilities |
| `yulu record start "<title>"` | Start a native meeting recording |
| `yulu record stop` / `status` | Stop capture or inspect the live recording state |
| `yulu dictate start\|stop\|once\|toggle\|ask` | Dictate, translate, or send a voice question to Agent Console |
| `yulu status-agent hotkeys` | Print global dictation, translation, and voice-chat shortcuts |
| `yulu search "<query>"` | Search local transcripts and summaries |
| `yulu prompts ...` / `yulu vocab ...` | Manage reusable instructions and glossary context |
| `yulu mcp status\|install\|remove\|rotate-token\|test` | Manage authenticated local MCP registration |
| `yulu skill install --agent <name>` | Install or refresh the Yulu Agent skill |
| `yulu logs [audio_daemon\|ui\|scheduler\|detector\|calendar]` | Tail a runtime log |
| `yulu start` / `stop` / `restart` | Control installed background services |
| `yulu where` / `version` | Print installed paths or version metadata |

Run `yulu help` for the complete command list.

## Agent integration

Yulu exposes loopback-only, bearer-authenticated MCP tools and resources for
recording control, meeting metadata, durable task status, local search, prompts,
glossary, health, and artifact workflows.

```bash
yulu skill install --agent codex
yulu skill install --agent claude-code
yulu mcp test
```

After installation, an Agent can handle requests such as:

- “Start recording and call it Product weekly.”
- “What decisions did we make in meetings last week?”
- “Regenerate the summary for this meeting, then share it.”

Installing the skill alone does not install the native app or transcription
pipeline. Install Yulu first, then add the skill to each Agent you want to use.

## Agent Connection capability matrix

| Connection | Conversation | Summary | Authorization and readiness boundary |
|---|---|---|---|
| Codex / Claude Code | Supported when the exact production adapter proves its current runtime contract | Shown only where the runtime proves the stricter tool-free Summary contract | OAuth remains in the native runtime |
| OpenClaw 2026.5.12+ | Supported after disclosure and a bounded, tool-free `infer model run --gateway` probe | Not supported | The probe and conversation must prove the same Gateway/provider/model with no fallback |
| Hermes 0.20.0 | Unavailable until Hermes exposes a stable, tool-free capability-probe surface | Not supported | PATH, config, and OAuth status alone never count as ready |
| CLIProxyAPI | Supported for an explicitly saved endpoint, exact model, and Yulu-managed inference key | Supported with an independent exact-model readiness proof | Credentials are write-only and never returned to the browser |

Settings → Intelligent Services is the authoritative Agent Connection Center.
Opening it performs status inspection only and never probes a model or spends
model quota. A capability test requires its current Data Path Disclosure first.
Deleting a runtime-owned connection removes only Yulu's connection/readiness
history and future selection; it does not log out of or reconfigure the runtime.

## Data and privacy

- WAV recordings are stored under `~/Movies/Yulu` by default.
- Transcript and summary sidecars live beside their recording.
- Runtime databases, task state, tokens, sockets, and logs stay under
  `~/.config/yulu`.
- The Host binds to loopback and protects completion, transcription, and MCP
  requests with a per-install bearer token.
- Yulu does not store Agent connector credentials.
- Selecting xAI does not by itself authorize cloud processing. Before sending
  recording audio directly to xAI for speech-to-text, Yulu requires the current
  Cloud Transcription Consent after disclosing that audio leaves the computer and
  provider charges may apply. Settings → Intelligent Services keeps OAuth tokens and
  explicitly submitted API keys in macOS Keychain and tests transcription,
  summary, and conversation separately; Hermes and OpenClaw do not receive the
  credential or run Yulu's audio pipeline. Selecting local keeps speech
  recognition local.
- External delivery requires explicit authorization; uncertain side effects are
  not blindly replayed.

See [Configuration](docs/configuration.md), [Operations](docs/operations.md),
and [Security](SECURITY.md) for exact controls and troubleshooting.

## Development

Yulu is macOS-first. Native capture and the system overlay are Swift, the local
Host and web UI are TypeScript, and Python handles capture orchestration,
scheduling, and macOS workflow glue.

```bash
python3 -m pytest -q

cd yulu/scripts/yulu_ui
npm test
npm run typecheck
npm run build
```

Install a checkout for local dogfood:

```bash
make dev-install
python3 yulu/scripts/doctor.py --json
curl -fsS http://127.0.0.1:7777/healthz
```

Contributor guides: [Development](docs/DEVELOPMENT.md),
[Web UI](docs/yulu_ui.md), [Branding](docs/branding.md), [Release](docs/RELEASE.md), and
[ADRs](yulu/spec/adr/README.md).

## License

MIT. See [LICENSE](LICENSE). Third-party tools and macOS frameworks retain their
own licenses.
