# Operations Guide

This guide covers the current native-capture and durable provider runtime.
Capture ends at the local Host boundary. Summary work keeps its creation-time
provider/model identity; Agent-backed summaries currently execute through Hermes.

## Daily commands

```bash
# Service and native capture state
yulu status
yulu doctor
yulu doctor --json

# Manual meeting recording
yulu record start "Test Meeting"
yulu record status
yulu record stop

# Service lifecycle and logs
yulu restart
yulu logs audio_daemon
yulu logs ui

# Agent integration
yulu mcp status
yulu mcp test

# Local library
yulu search "decision" --since 7d
yulu where
yulu version --json
```

`yulu record stop` stops native capture and submits the completed WAV to the
Host. It does not synchronously run speech or summary code in Python.

## Verify the runtime

### 1. Native capture

```bash
echo '{"action":"status"}' | nc -w 2 -U ~/.config/yulu/audio_daemon.sock
```

The response should be JSON and should report usable microphone and system-audio
permission state. `recording` may be true or false.

### 2. Loopback Host

```bash
curl -fsS http://127.0.0.1:7777/healthz
launchctl print "gui/$(id -u)/com.yulu.ui" | head -40
```

`/healthz` proves only that the Host process is reachable. It does not prove that
Hermes is installed or that a recording task can finish.

### 3. Authenticated MCP

```bash
yulu mcp status
yulu mcp test
```

The MCP endpoint and mutating Host endpoints require the per-install token in
`~/.config/yulu/mcp-token.json`. Do not paste or log that token. Rotate it with
`yulu mcp rotate-token` if it is exposed.

Hermes must list three enabled registrations: interactive `yulu`, artifact-only
`yulu_artifact`, and delivery-only `yulu_delivery`. Re-run `yulu mcp install
--agent hermes` if doctor reports `hermes_phase_mcp` missing. The two recording
phase registrations intentionally point at different endpoints and tool schemas.

### 4. Host and Agent health

```bash
yulu doctor --json
```

Inspect these report sections:

| JSON field | Healthy signal |
|---|---|
| `socket` | `ok=true`; permission readiness fields are not false |
| `yulu_ui` | built server present and `healthz_ok=true` |
| `host_tasks` | database readable; state counts match expected work |
| `host_capabilities` | Hermes is usable and the recording directory is usable |
| `agent_pipeline.components.hermes_phase_mcp` | both `yulu_artifact` and `yulu_delivery` are enabled |
| `legacy_processes` | empty |

The doctor is read-only. A successful process check does not mutate or retry a
task.

## End-to-end recording check

Use a short synthetic meeting that contains no private information:

```bash
yulu record start "Yulu Smoke Test"
# Speak a short sentence and allow a few seconds of system audio.
yulu record stop
```

Then open `http://127.0.0.1:7777/agent-console` or inspect recent Host task state:

```bash
python3 - <<'PY'
import sqlite3
from pathlib import Path

path = Path.home() / ".config/yulu/host.sqlite"
con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
for row in con.execute(
    "SELECT id, recording_stem, state, phase, attempt, error "
    "FROM agent_tasks ORDER BY created_at DESC LIMIT 5"
):
    print(row)
con.close()
PY
```

A successful task reaches `completed` and creates both:

```text
~/Movies/Yulu/<stem>.transcript.txt
~/Movies/Yulu/<stem>.summary.md
```

The Host durably commits the transcript first, then dispatches only to the task's
pinned Summary Provider. A transcript can therefore remain valid when summary
generation is unavailable; inspect the Host task state for progress.

Manual summary regeneration creates the same durable summary-only task shape and
adopts the already committed transcript; it does not re-run audio transcription.
Successful xAI artifacts record the exact provider/model and storage-disabled
contract without persisting instructions, transcript content, or credentials in
provenance.

## Realtime captions

Starting a recording opens a movable subtitle overlay near the bottom center of
the active display. It shows source text by default. Hover over the capsule to
choose a target language or switch to `双语` or `仅翻译`.

The default audio engine is the local sherpa-onnx Paraformer INT8 model, which
handles both mutable realtime captions and the durable final transcript. Open
Settings → Transcription to install, test, or remove it. The first install
downloads about 1 GB and keeps about 320 MB; it has no usage fee and does not
upload audio. Users may instead explicitly select xAI cloud speech-to-text, which
uses native realtime streaming and final transcription. Yulu never switches
engines automatically when the selected engine is unavailable.

Settings → AI Providers owns the single xAI connection and its three independent
real-request probes. A green summary or conversation result does not establish
transcription readiness (or vice versa). An API key is used only after the user
explicitly saves it, and never as an automatic response to OAuth/probe failure.

Drag the six-dot handle to reposition the overlay. Use the down arrow to collapse
it to the breathing Yulu logo, then click the logo to restore captions. Click the
`录制中` control to stop; the overlay disappears after capture stops.
The model cannot be removed while a recording is active.

## Dictation and voice input

Dictation uses mic-only native capture and the authenticated Host transcription
endpoint backed by the explicitly selected Yulu audio engine.

```bash
# Verify the selected audio engine can become ready
yulu dictate warm --json

# Record once without changing the clipboard or focused app
yulu dictate once --no-paste --no-copy --json

# Normal global-shortcut flow
yulu status-agent hotkeys
yulu dictate toggle
```

On-demand audio paths are restricted to `~/Movies/Yulu` and
`~/.config/yulu/dictation`. The Host rejects relative paths, non-WAV input,
missing/incomplete files, and paths outside those roots.

## Durable task states

| State | Meaning | Operator action |
|---|---|---|
| `queued` | Persisted and waiting to be claimed | Usually none; confirm Host is running |
| `awaiting_agent` | The selected audio/runtime dependency is unavailable before transcript commit | Restore the selected dependency; Yulu retries this pre-summary stage with bounded backoff |
| `awaiting_provider` | The pinned Summary Provider/model is unavailable after transcript commit | Keep paused, or explicitly retry the same snapshot; Settings changes affect new tasks only |
| `awaiting_policy` | Recording processing is paused by configuration | Re-enable the applicable policy, or explicitly take over an automatic task as manual work when only `auto_process_recordings` is false |
| `running` | A leased attempt is transcribing or summarizing | Watch `phase` and UI log |
| `artifacts_committed` | Transcript and summary are safely committed | Normally transitions immediately; inspect if stuck |
| `sending` | Hermes has authorization to contact Notion | Do not manually replay while outcome is unknown |
| `delivery_reported` | Hermes reported a page URL or ID | Normally transitions immediately; inspect audit if stuck |
| `completed` | Required artifacts and optional delivery audit passed | No action |
| `failed` | Deterministic processing or validation failure | Read `error`, fix the cause, then use the UI/task retry surface where offered |
| `delivery_unverified` | Host cannot prove whether Notion already changed | Reconcile the destination manually before any new delivery attempt |
| `cancelled` | Task was intentionally ended | No action |

Leases are per attempt. A stale Agent session cannot commit with an old lease.
Do not edit task state directly in SQLite.

## Failure recovery

### Host was down when recording stopped

The Python capture edge writes an atomic completion event under:

```text
~/.config/yulu/recording-events/
```

Restart the Host:

```bash
yulu restart
curl -fsS http://127.0.0.1:7777/healthz
yulu logs ui
```

The Host registers its watcher before the startup scan and rescans every 15
seconds to recover from dropped filesystem events and transient Host failures.
Valid events are removed only after they have been accepted into the durable task store.
Rejected event files remain available with a `.rejected` suffix for diagnosis.
If automatic processing is disabled, the Host permanently acknowledges the
policy result and archives an already-spooled event with `.policy-disabled`;
such a file is diagnostic history, not a backlog that will run after re-enable.

### Task is `awaiting_agent`

The recording is safe; no Agent owns a lease. Check the same environment the UI
LaunchAgent receives:

```bash
command -v hermes
yulu doctor --json
yulu logs ui
```

If Hermes is installed only through a shell-specific PATH, reinstall/reload Yulu
so the stable executable path is available to `com.yulu.ui`.

### Task is `awaiting_policy`

The recording is safe and no Agent owns a lease. Check both
`agent_pipeline.enabled` and `agent_pipeline.auto_process_recordings`. When the
global `enabled` switch is false, all recording intelligence—including manual
processing and dictation—remains stopped until it is re-enabled. When only
`auto_process_recordings` is false, explicit manual reprocessing stays available
and replaces paused automatic work with a new explicit manual summary task. The
generic retry action never bypasses either policy.

### Task is `awaiting_provider`

The transcript is safely committed and automatic dispatch is stopped. Repair the
pinned provider/model and use the explicit retry action to resume that same
snapshot. Changing provider settings does not rebind this task; create new work
if a different provider or model is intended. The recording surface also links
to AI Providers for future work and allows the current task to remain paused
without issuing another request.

### Task is `failed`

Read the task `error`, then inspect:

```bash
yulu logs ui
yulu doctor --json
```

Common deterministic failures include an invalid recording path, incomplete WAV,
Hermes returning empty content, missing staged artifacts, an expired lease, or a
Hermes workflow that exited without the required Host commit calls.

### Task is `delivery_unverified`

This state is deliberately not equivalent to `failed`. Hermes may already have
created or updated a page. Search the configured Notion destination for the
stable marker `yulu-<task-id>` and reconcile the page before authorizing another
delivery. The task UI provides two explicit exits:

- **Confirm existing page** records a trusted Notion page URL/ID and completes
  the task without another connector write.
- **Abandon delivery** cancels this uncertain delivery while preserving the
  recording and local artifacts.

Ordinary retry and reprocess operations reject `delivery_unverified`. Never
repeatedly trigger delivery just to see whether it succeeds. Once a delivery was
reported, its identity remains tied to the recording and destination even if a
later reprocessing attempt fails; the next explicit send reuses that task and
stable delivery key.

### WAV exists but capture is silent

Check native readiness:

```bash
echo '{"action":"status"}' | nc -w 2 -U ~/.config/yulu/audio_daemon.sock
yulu repair-permissions
```

In System Settings → Privacy & Security, enable `Yulu.app` for:

- Microphone;
- Screen & System Audio Recording.

Then restart Yulu. Recent capture code refuses to begin when required native
inputs are not ready instead of producing a fake-success silent file.

## Logs and local state

| Path | Purpose |
|---|---|
| `~/.config/yulu/ui.log` | Host, Agent gateway, migration, and web-service log |
| `~/.config/yulu/audio_daemon.log` | Native capture log |
| `~/.config/yulu/{scheduler,detector,status_agent,calendar_services}.log` | Per-service scheduling, detection, status, and calendar logs |
| `~/.config/yulu/host.sqlite` | Durable task, event, artifact, and delivery audit store |
| `~/.config/yulu/agent-tasks/` | Private task staging directories |
| `~/.config/yulu/recording-events/` | Capture-completion recovery inbox |
| `~/.config/yulu/config.json` | Active non-secret preferences |
| `~/.config/yulu/mcp-token.json` | Local bearer token; do not print or copy |
| macOS Keychain service `com.yulu.xai-oauth` | Yulu-owned Grok-compatible xAI OAuth grant; never print or export |
| macOS Keychain service `com.yulu.provider-secret`, account `direct.xai` | Explicitly saved xAI API key; never print, export, or place in config/SQLite/logs/argv |
| `~/Movies/Yulu/` | Recording content and committed sidecars |

Use `yulu where` to confirm the effective installation and recording paths.

## Upgrade and migration checks

Stable releases contain a user-level runtime zip plus `install.sh` and
`checksums.txt`. The app bundles inside the zip are signed, notarized, and
stapled before packaging, and the zip has GitHub build-provenance attestation.
Before replacing the active runtime, the installer requires both `Yulu.app` and
`StatusAgent.app` to pass strict Developer ID verification for Apple Team ID
`WMU9678ZQL`; when `xcrun stapler` is available it also validates each embedded
notarization ticket on a best-effort basis because Apple's validation service
can be unavailable offline. Release CI performs the same check as a mandatory
post-package gate on the extracted zip. A manifest stored inside signed
`Yulu.app` hashes every file outside the two signed app bundles; installation
rejects missing, modified, or additional runtime files before executing setup.
Checksums detect transfer corruption but are not treated as publisher
authentication.
The optional `make package-pkg` target is not a production artifact until a
Developer ID Installer certificate is configured.

The v0.17.x updater only recognizes the retired pkg asset. Bridge it once with:

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash
```

From v0.18 onward the bundled helper understands the zip contract. A pinned
`yulu update --version ...` never downloads mutable installer code from `main`;
future asset-format migrations require an explicit, documented bridge.

Before an upgrade runs setup, the release installer snapshots
`~/.config/yulu/config.json` beside the source file with mode `0600`. If setup or
post-setup health fails, runtime rollback restores that exact config atomically;
if no config existed before the attempt, a newly created config is removed.
Successful upgrades delete this transaction snapshot. Timestamped migration
archives created by ConfigManager are separate audit artifacts and are preserved.
The same config transaction covers `--dev`: replacing a release runtime with a
new clone restores the prior runtime and config, then repairs its services if
dev setup fails. Before updating an existing Git checkout, the installer requires
an exact clean worktree and records its HEAD plus branch/detached state. Failure
restores that exact ref and SHA, restores config, repairs the old services, then
reasserts a clean tracked worktree.

After an upgrade:

```bash
yulu restart
yulu doctor --json
launchctl list | rg 'com\.yulu\.'
curl -fsS http://127.0.0.1:7777/healthz
```

Expected behavior:

- retired services are unloaded and their plist files removed;
- retired active config keys are copied to private timestamped archives before
  removal;
- unfinished historical queue entries are archived without execution; use the
  current recording UI to reprocess a preserved recording explicitly;
- source archives and migration audit files are preserved for inspection;
- only the Host coordinates Agent processing.

Do not delete migration archives until the upgraded runtime and all expected
artifacts have been verified.

`yulu update` allows at least 30 minutes for setup because Homebrew and Node can
be slow on a fresh machine. A timeout terminates the entire setup process group,
restores the prior runtime, and reruns that runtime's upgrade setup to repair its
LaunchAgents before returning failure.

Hermes compatibility is feature-gated rather than inferred from a version
string. `yulu doctor --json` probes the required `serve`, `sessions export`,
`config set`, and toolset command surfaces. Treat a failed
`agent_pipeline.components.hermes_contract` check as an incompatible Hermes
installation and update Hermes before retrying a recording.

## Build and codesign native capture

For a development checkout:

```bash
yulu/scripts/build_audio_daemon.sh
```

To pin a signing identity:

```bash
YULU_CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  yulu/scripts/build_audio_daemon.sh
```

After rebuilding the bundle, reload the installed runtime through the normal
development install path rather than launching multiple capture copies:

```bash
make dev-install
python3 yulu/scripts/doctor.py --json
```

## Operational rules

- Never store live Host SQLite files, task workspaces, tokens, sockets, or event
  inboxes in a cloud-sync directory.
- Never claim a recording task succeeded from Agent prose alone; use Host state.
- Never retry an uncertain external side effect without reconciliation.
- Never add Agent credentials or Yulu's xAI OAuth grant to config or logs.
- Separate capture health, Host durability, Hermes availability, artifact commit,
  and Notion delivery when diagnosing a user-visible failure.
