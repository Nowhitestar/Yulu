# Operations Guide

This guide covers the current native-capture and durable provider runtime.
Capture ends at the local Host boundary. Summary work keeps its creation-time
connection/provider/model identity and never switches or replays automatically.

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
plutil -p ~/Library/LaunchAgents/com.yulu.ui.plist
lsof -nP -iTCP:7777 -sTCP:LISTEN
```

`/healthz` proves only that the Host process is reachable. It does not prove that
Hermes is installed or that a recording task can finish. Do not use
`launchctl print` for diagnosis: a service document can include credential-bearing
environment fields. The plist, listening socket, logs, health endpoint, and doctor
provide the required secret-safe read-back.

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
| `agent_connections` | each configured adapter reports version/feature compatibility, capability matrix, current readiness, history, and repair path independently |
| `agent_pipeline.components.hermes_phase_mcp` | both `yulu_artifact` and `yulu_delivery` are enabled |
| `legacy_processes` | empty |

`agent_connections.compatibility.runtime_version` is the observed `actual`, not
the required target. Supported local Agent CLIs use `version_source=live-runtime`;
direct xAI reports `actual=null` with `version_source=not-applicable`. Unknown
Outcome and stale readiness history remain explanatory and cannot establish
compatibility. An unverified or
incompatible configured adapter makes `doctor` exit non-zero, while current
readiness and persisted readiness history remain separate fields.

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
uses native realtime streaming and final transcription. Before any recording
audio leaves the computer, the Host also requires the current versioned Cloud
Transcription Consent acknowledging xAI processing and possible provider charges.
Selecting xAI or saving its credential is not consent. Yulu never switches engines
automatically when the selected engine is unavailable.

Settings → Intelligent Services owns the authoritative Agent Connection Center,
including direct xAI and supported local Agent connections. Opening it does
not probe a model. Its three capability readiness results are independent: a
green Summary or Conversation result does not establish Transcription readiness
(or vice versa). An API key is used only after the user explicitly saves it,
never as an automatic response to OAuth/probe failure.

The Core Activation page shows the selected Summary Provider and model. An xAI
summary requires both the current successful summary probe and the current
versioned disclosure that transcript text goes to xAI. Authorization alone does
not satisfy that disclosure. Declining it is durable and leaves xAI selected but
blocked, with remediation at `/settings/llm`; there is no fallback. Activation
lists only Summary connections whose shared contract currently proves explicit
identity, readiness, and accepted disclosure: xAI, Codex, or Claude Code.
Hermes and OpenClaw remain Conversation-only.

`/activate` records through the production recording command and correlates the
returned Host task identity to a durable Activation Attempt. The page reads task
state from the Host, so transcription and summary processing continue after the
page is left and resume after UI or Host restart. Core Activation Evidence is
committed only after the Host verifies nonempty audio and transcript, a current
summary, artifact integrity, and provider provenance. Optional connector
delivery happens afterward and cannot gate activation. A guided completion opens
the saved note; manual, scheduled, and verified historical completions announce
the saved note without navigating or moving focus.

Before capture starts, the Activation Attempt durably snapshots the exact ready
Summary connection, provider, model, non-secret credential class, disclosure
version, and probe time. Changing Settings while that recording is active cannot
replace its Summary authority; a different provider requires a new explicit
attempt. The snapshot contains no OAuth token or API key. An unbound attempt
created before this snapshot existed must be recorded again; Yulu never fills
missing authority from the current Settings.

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
| `execution_unverified` | Host cannot prove whether the pinned Summary request executed or produced a result | Do not use ordinary retry. Wait, repair the exact connection, or explicitly create a new Summary attempt; the original remains closed and is never replayed automatically |
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
yulu doctor --json
yulu logs ui
```

Use Settings → Intelligent Services to inspect the exact pinned dependency.
Current Summary connections are xAI, Codex, or Claude Code; a
legacy already-pinned Hermes task may still require a stable Hermes executable
path. Reinstall or reload Yulu when a required runtime is visible only through a
shell-specific PATH and therefore unavailable to `com.yulu.ui`.

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
without issuing another request. A missing or declined current Data Path
Disclosure is also an `awaiting_provider` condition: accept the exact disclosure
at `/settings/llm`, then retry the same pinned task.

### Task is `failed`

Read the task `error`, then inspect:

```bash
yulu logs ui
yulu doctor --json
```

Common deterministic failures include an invalid recording path, incomplete WAV,
a Summary Provider returning empty or mismatched content, missing staged
artifacts, an expired lease, or a legacy Hermes workflow that exited without the
required Host commit calls.

### Task is `execution_unverified`

This state is deliberately not equivalent to `failed`. The pinned xAI, Codex,
or Claude Code Summary request may already have executed, so Yulu
does not offer ordinary same-execution retry and never replays it on restart.
The Activation and recording-reader surfaces preserve the exact connection,
provider, model, and failure reason. Choose one explicit action:

- **Keep waiting** leaves the original task unchanged while you inspect the
  provider or native session.
- **Open AI Provider Settings** repairs the exact pinned connection and Summary
  capability; it does not replay the task.
- **Create new Summary attempt** retires the unknown original and creates a new
  task from the same committed transcript with the same pinned identity. This is
  a new execution, not a retry of the unknown one.

If the pinned connection was deleted, the Settings deep link opens a focused
tombstone explaining that existing work remains pinned and is not reconnected,
switched, or replayed automatically.

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

Stable releases publish `yulu-macos-arm64-<tag>.dmg`, `appcast.xml`, and
`checksums.txt`. The local-caption Runtime Pack remains a separate optional ZIP;
it is not an installation path and is never inside the DMG. Release CI verifies
the Developer ID Application signature for Team ID `WMU9678ZQL`, App and DMG
notarization tickets, Gatekeeper acceptance, the exact two-item mounted layout,
and the self-contained Application Runtime before publishing.

Sparkle and manual recovery use the same DMG. Sparkle verifies both the signed
feed and the DMG enclosure signature before installation. For manual recovery,
quit Yulu, download the matching DMG from GitHub Releases, open it, drag
`Yulu.app` onto `/Applications`, and relaunch. Do not use a repository ZIP,
`install.sh`, or pkg as a release bridge. Replacing the immutable App leaves
configuration, credentials, and recordings outside the bundle unchanged.

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

## Codex and Claude Code native OAuth classes

Codex and Claude Code connections are OAuth-only. Yulu reads only the
runtime's non-secret authorization class: Codex must report ChatGPT OAuth and
Claude Code must report a Claude subscription login. API-key, Amazon Bedrock,
or unknown authorization is shown as disconnected and cannot reuse an earlier
ready result. The earlier result remains visible as history; current readiness
returns to untested until the required native OAuth login is restored and the
capability is tested explicitly. Use the exact native login remediation shown
by Agent Connection Center; Yulu never changes or copies runtime credentials.
The center launches only the detected runtime's fixed command: `codex login`,
`claude auth login`, `hermes model`, or `openclaw configure`. It does not accept
arbitrary arguments or inspect the interactive login output. Complete login in
the runtime-owned Terminal session, return to Yulu, refresh status, and then run
the desired capability test explicitly. Launching reauthorization clears only
current in-process readiness because the runtime account may change; non-secret
readiness history remains available for diagnosis. Candidate refresh performs a
read-only native status check and never creates a connection or selection.

On the 2026-08-28 Phase 12 acceptance machine, Claude Code is externally
blocked: its runtime reports API-key authorization rather than a Claude
subscription login, and the current CLI contract cannot prove that managed
hooks are empty or expose exact invocation-provider identity for a Summary
request. Keep Claude Summary fail-closed and marked as an external acceptance
blocker; this does not block Claude Conversation, direct xAI, Codex, Hermes, or
OpenClaw selection within each Agent's declared capabilities.

Hermes compatibility is feature-gated rather than inferred from a version
string. `yulu doctor --json` probes the required `serve`, `sessions export`,
`config set`, and toolset command surfaces. Treat a failed
`agent_pipeline.components.hermes_contract` check as an incompatible Hermes
installation and update Hermes before retrying a recording.

## Conversation-only Hermes and OpenClaw connections

Agent Connection Center does not spend model quota on open or refresh. A
Conversation capability test is enabled only after the current disclosure is
accepted. Readiness requires runtime-owned authorization plus exact runtime,
provider, model, fallback, and capability-probe evidence; an executable on PATH
or a configured model is never sufficient.

- OpenClaw 2026.5.12+ is probed through `openclaw infer model run --gateway`.
  The JSON result must identify `transport=gateway`, the exact provider/model,
  and an empty fallback-attempt list. Production turns use `openclaw agent` and
  must return the exact requested session ID; embedded fallback, latest/default
  session drift, transport loss, and unproven cancellation fail closed.
- Hermes 0.20.0 exposes `--safe-mode` and `--toolsets`, but neither documents a
  stable empty tool allowlist. Yulu therefore reports this native Conversation
  adapter unsupported instead of running a potentially tool-capable probe.
- A timeout or closed transport is an Unknown Outcome unless the remote runtime
  proves a terminal result. Do not replay automatically. With no proven native
  session, the same input remains unavailable for retry; start a new
  conversation only after inspecting the runtime outcome.
- Deleting either connection removes its Yulu record, readiness history,
  disclosure receipt, and future selection. A preserved pinned conversation
  pauses on its next attempt because the exact connection is gone; Yulu never
  deletes runtime OAuth, tokens, configuration, or native session history.

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
