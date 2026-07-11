<div align="center">
  <img src="assets/logo.svg" width="120" alt="Yulu logo" />
  <h1>Yulu</h1>
  <p><b>Native recording. Durable Agent work.</b></p>
  <a href="https://github.com/Nowhitestar/Yulu/stargazers"><img src="https://img.shields.io/github/stars/Nowhitestar/Yulu?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/Nowhitestar/Yulu/releases"><img src="https://img.shields.io/github/v/tag/Nowhitestar/Yulu?label=version&style=flat-square" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License"></a>
  <a href="#"><img src="https://img.shields.io/badge/macOS-13%2B-black?style=flat-square&logo=apple" alt="macOS 13+"></a>
</div>

## What Yulu is

Yulu (语录, *yǔ lù*) is a macOS meeting recorder built around local Agents.
It captures system audio and microphone input natively, persists recording work
as durable local tasks, and delegates the intelligence to Agents the user already
has.

Yulu deliberately does not rebuild Agent capabilities:

| Owner | Responsibility |
|---|---|
| Yulu native app | ScreenCaptureKit system audio, AVFoundation microphone capture, and macOS privacy permissions |
| Yulu Host | Durable tasks, idempotency, leases, artifact commits, authorization, recovery, and audit |
| Hermes | Recording speech recognition, meeting summaries, and explicitly authorized Notion delivery |
| Selected general Agent | Agent Console conversation and its own connectors |
| Python capture edge | Start/stop capture and deliver or spool the completed-recording event; no AI runtime |

This boundary keeps Yulu focused on the parts an Agent cannot safely infer:
which local recording completed, who owns the current attempt, which files were
committed, and whether an external side effect was actually reported.

## How it works

```text
calendar / window / manual action
              |
              v
Yulu.app native capture -> local WAV
              |
              v
Python capture edge -> authenticated loopback Host
              |              |
              |              +-> host.sqlite task + lease + audit events
              v
Hermes transcription -> Hermes summary workflow
              |
              v
Host atomically commits transcript.txt + summary.md
              |
              +-> optional, explicitly authorized Hermes Notion delivery

Agent Console conversation -> selected general Agent -> that Agent's connectors
```

If the Host is unavailable when capture stops, the completion event is written
atomically under `~/.config/yulu/recording-events/` and replayed when the Host is
back. Automatic completion events are idempotent, so replay does not duplicate
the same recording task.

The recording pipeline is intentionally Hermes-specific even when Agent Console
uses Codex, Claude Code, OpenClaw, or a custom Agent for conversation. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`ADR-005`](yulu/spec/adr/005-agent-native-durable-recording-pipeline.md).

## Product surface

- Native system-audio and microphone capture without a virtual audio device.
- Agent Console at `http://127.0.0.1:7777/agent-console`.
- Durable task status for transcription, summarization, artifact commit, and
  optional Notion delivery.
- Recording library with transcripts, summaries, tags, speaker corrections,
  templates, glossary, and local search.
- Menu-bar controls and global shortcuts for recording, dictation, translation,
  and voice chat.
- Authenticated local MCP resources and tools for Agents.

<p align="center">
  <img src="assets/demos/agent-console-desktop.png" alt="Yulu Agent Console" />
</p>

## Requirements

- macOS 13 or later.
- Apple Silicon (arm64) for official release installs. The installer rejects
  Intel-only Macs before downloading the arm64 asset.
- Node.js 20, 22, or 24 for the local Host. The installer adds Homebrew
  `node@24` when no compatible runtime is present.
- Python 3.10 or newer for the capture edge, diagnostics, and installer.
- A working Hermes CLI on the PATH visible to the Yulu UI LaunchAgent. Hermes is
  required for automatic recording processing and voice transcription.
- Optionally, another supported Agent CLI for Agent Console conversation.

The installer provisions Yulu's native application, local Host, background
services, audio tools, and per-user configuration. It does not ask Yulu to store
Agent connector credentials.

## Install

Latest stable release:

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash
```

Specific release:

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --version <tag>
```

Development channel:

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --dev
```

The default installation lives at `~/.yulu`. The CLI is linked to
`~/.local/bin/yulu`; add that directory to your shell PATH if necessary:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
exec zsh
```

### Update and uninstall

```bash
yulu update                    # latest stable
yulu update --version <tag>    # one specific release
yulu update --dev              # current main branch
yulu uninstall
```

Updates preserve the active config and recordings. When upgrading from a retired
runtime, Yulu archives old inference/connector settings and pending legacy queue
entries, then unloads retired services rather than silently continuing two
execution paths. Preserved recordings can be reprocessed explicitly in the
current UI; migration never auto-replays historical Agent work.

Official releases publish a checksum-verified runtime zip containing signed,
notarized, stapled app bundles. `package-pkg` is a local diagnostic target only
until the project has a Developer ID Installer certificate.

If the installed version is v0.17.x, its bundled updater only understands the
retired pkg format. Run the one-line installer once to bridge to the zip updater:

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash
```

From v0.18 onward, the bundled helper understands the zip release contract.
Yulu does not execute mutable installer code from `main` during a pinned update;
any future asset-format migration will use another explicit bridge.

## Verify an installation

```bash
# Native capture and service snapshot
yulu status

# Read-only report: capture socket, Host tasks, UI, search, and Agent capabilities
yulu doctor --json

# Loopback Host process
curl -fsS http://127.0.0.1:7777/healthz

# Authenticated MCP registration and request path
yulu mcp status
yulu mcp test
```

A healthy `yulu doctor --json` report has a responsive `socket`, a reachable
`yulu_ui.healthz`, and a usable Hermes capability. `host_tasks.states` shows the
durable task distribution; it replaces process-local or file-only work status.

## CLI

| Command | Purpose |
|---|---|
| `yulu setup` | Run the installer for a fresh local setup |
| `yulu update [--version <tag> \| --dev]` | Update the installed runtime |
| `yulu start` / `stop` / `restart` | Control installed Yulu LaunchAgents |
| `yulu status` | Show service, capture-socket, recording, and UI health |
| `yulu doctor [--json]` | Read-only runtime, Host-task, and Agent-capability diagnosis |
| `yulu logs [audio_daemon\|ui\|scheduler\|detector\|calendar]` | Tail a runtime log |
| `yulu record start "<title>"` | Start a native meeting recording |
| `yulu record stop` | Stop capture and hand the recording to the durable Host pipeline |
| `yulu record status` | Read live capture state |
| `yulu dictate start\|stop\|once\|toggle\|ask` | Mic capture with Agent-owned transcription; `ask` continues in Agent Console |
| `yulu status-agent hotkeys` | Show global dictation, translation, and voice-chat shortcuts |
| `yulu search "<query>"` | Search local transcripts and summaries |
| `yulu prompts ...` / `yulu vocab ...` | Manage local Agent instruction and glossary context |
| `yulu mcp status\|install\|remove\|rotate-token\|test` | Manage authenticated local MCP registration |
| `yulu skill install` | Install or refresh the user-facing Yulu Agent skill |
| `yulu where` | Print code, config, recordings, app, and LaunchAgent locations |
| `yulu version [--json]` | Print release and source metadata |

## Agent integration

Yulu exposes local MCP tools and resources for recording control, recording
metadata, durable task status, artifact commit, Notion-delivery authorization,
search, prompts, glossary, and health. The endpoint is loopback-only and bearer
authenticated with the per-install token in
`~/.config/yulu/mcp-token.json`.

Install or refresh the user-facing skill with:

```bash
yulu skill install --agent codex
yulu skill install --agent claude-code
```

The selected general Agent may be changed independently from Hermes. That Agent
owns interactive conversation and connector behavior. For a recording task,
Hermes must use the Host commit tools; writing final files or claiming Notion
success without those commits does not complete the task.

## Data and privacy

Capture writes WAV files under `~/Movies/Yulu` by default. Yulu's control state
stays machine-local under `~/.config/yulu`.

Automatic processing passes audio to Hermes. Whether speech processing stays on
the machine or uses an external provider is determined by Hermes' configuration;
Yulu does not make a stronger claim on Hermes' behalf. Notion is contacted only
when the task explicitly has `sendToNotion=true`, and Hermes uses its own
connector. Recording sessions use a per-task Hermes tool allowlist, so local-only
tasks cannot call Notion or unrelated connectors. Yulu records the delivery
authorization and verifies the Agent session's search/write result and reported
page identity, but does not store Notion credentials.

The Host listens only on loopback, checks the Host header, validates recording
paths against Yulu-controlled roots, and requires a bearer token for completion,
transcription, and MCP requests.

## Files and state

| Path | Purpose |
|---|---|
| `~/Movies/Yulu/*.wav` | Native recording artifacts |
| `~/Movies/Yulu/*.transcript.txt` | Host-committed final transcripts |
| `~/Movies/Yulu/*.summary.md` | Host-committed final summaries |
| `~/.config/yulu/config.json` | Active non-secret configuration |
| `~/.config/yulu/host.sqlite` | Durable tasks, leases, artifacts, delivery state, and audit events |
| `~/.config/yulu/agent-tasks/<task-id>/` | Private task staging workspaces |
| `~/.config/yulu/recording-events/` | Capture-completion events waiting for Host replay |
| `~/.config/yulu/mcp-token.json` | Per-install local bearer token; keep private |
| `~/.config/yulu/audio_daemon.sock` | Native capture control socket |
| `~/.config/yulu/ui.log` | Host/UI log |
| `~/Library/LaunchAgents/com.yulu.*.plist` | Installed background services |

## Development

The shipped product is macOS-first. Native capture is Swift; the local Host and
web UI are TypeScript; Python remains at the capture, scheduling, and local
automation edge.

Useful development checks:

```bash
python3 -m pytest -q
cd yulu/scripts/yulu_ui
npm test
npm run typecheck
npm run build
```

For local dogfood, synchronize the checkout and then verify the installed
runtime:

```bash
make dev-install
python3 yulu/scripts/doctor.py --json
curl -fsS http://127.0.0.1:7777/healthz
```

See [`docs/configuration.md`](docs/configuration.md),
[`docs/operations.md`](docs/operations.md), and
[`yulu/spec/adr/README.md`](yulu/spec/adr/README.md).

## License

MIT. See [LICENSE](LICENSE). Third-party tools and macOS frameworks retain their
own licenses.
