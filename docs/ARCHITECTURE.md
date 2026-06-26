# Yulu Architecture Notes

Yulu is a local-first macOS meeting recorder and agent workbench.

## Layers

1. Capture/control
   - `record_audio.py`
   - Swift `audio_daemon.swift`
   - Swift `recorder_status.swift`
   - launchd plists

2. Transcription
   - realtime transcript path for fast feedback
   - final transcript path for quality recovery
   - raw transcript and cleaned transcript are separate files

3. Summary worker
   - `agent-queue.json` is the transparent event log
   - `queue_store.py` performs locked, atomic writes
   - `agent_queue_worker.py` claims `summary_request` events and writes final summaries
   - summary guardrails reject agent-event JSON and too-short/invalid outputs

4. Artifact workbench
   - `.summary.md` remains the portable text artifact
   - `.summary.html` is the editable workbench with embedded `artifact-data`
   - `html_artifact.py` adapts Yulu summary/transcript data to the artifact renderer

5. Agent interface
   - `skills/yulu/SKILL.md` documents the control surface for Hermes/雷子
   - `sync_skill.py` publishes the skill into local Hermes and l-skills backup

## Local-first boundaries

Yulu should not upload recordings, transcripts, or meeting metadata unless the user explicitly opts into a cloud workflow for a specific task.

## Current migration note

Lewis's machine still has an old OpenClaw runtime path. `doctor.py` reports any process using that path so migration can be done deliberately.

## Cross-platform foundation

Yulu remains macOS-first in the shipped product. The cross-platform work is a
boundary project: keep today's macOS behavior intact while moving OS-specific
decisions behind explicit seams.

Current source-of-truth seams:

| Concern | Neutral contract | macOS arm today | Linux/Windows today |
|---|---|---|---|
| Audio capture control | `yulu_platform.base.AudioCaptureController` | `MacOSAudioCaptureController` translates start/stop/status/windows to `audio_daemon.sock` | Instantiable stubs that raise `NotImplementedError` |
| Service supervision | `yulu_platform.base.DaemonManager` + `ServiceSpec` | `MacOSDaemonManager` renders launchd plists and wraps `launchctl` | Instantiable stubs that raise `NotImplementedError` |
| Base paths | `PathResolver.config_dir/data_dir/runtime_dir` | `MacOSPathResolver` keeps runtime machine-local and makes data configurable | Instantiable stubs |
| Permissions | `PermissionModel.check(capability)` | `MacOSPermissionModel` reports microphone and system-audio capture from daemon status, with reset-only TCC support | Instantiable stubs |
| Dependencies | `DependencyManager.is_available/install` | `MacOSDependencyManager` wraps Homebrew without bootstrapping Homebrew itself | Instantiable stubs |
| Host agent capabilities | `capabilities.provider.CapabilityProvider` | Claude Code, Codex, and OpenClaw providers relabel host findings as `agent-config` | Agent contract is OS-neutral |
| External connectors | `connectors.provider.ConnectorProvider` | Google Calendar, Feishu, Notion, and Zulip discovery | Connector contract is OS-neutral |

The native capture implementation is still intentionally platform-specific:
`audio_daemon.swift` owns ScreenCaptureKit, AVFoundation, TCC-gated capture, and
the `audio_daemon.sock` control protocol. Future platform arms should implement
the same user-level capture contract:

| Contract | Required behavior | Current implementation |
|---|---|---|
| Capture control | start, stop, status, and window/capture-source discovery over a stable local IPC boundary | `record_audio.py` / `meeting_daemon.py` -> `MacOSAudioCaptureController` -> `audio_daemon.sock` -> `audio_daemon.swift` |
| Capture output | write local WAV artifacts plus the sidecars needed by transcription, playback, and cleanup | `~/Movies/Yulu` by default via `audio.output_dir` |
| Permission reporting | report whether required capture capabilities are usable; never silently grant permissions | `MacOSPermissionModel` + daemon status |
| Service lifecycle | install, load, unload, and report long-running service state | `DaemonManager` seam |

Non-goals for this milestone:

- Do not rewrite capture in Python or replace ScreenCaptureKit on macOS.
- Do not make Linux or Windows capture usable before their service, path, and
  permission arms exist.
- Do not expose launchd, TCC, Homebrew, or ScreenCaptureKit names in neutral
  method signatures.

## macOS coupling inventory

The inventory below is the migration checklist for reducing hard-coded macOS
coupling. "Keep" means it is an intentional macOS arm detail; "move" means new
callers should route through a neutral seam before more product code depends on
it.

| Coupling | Current owner | Migration policy | First safe task |
|---|---|---|---|
| ScreenCaptureKit system audio | `audio_daemon.swift` | Keep inside a native capture arm | Document the capture IPC contract before adding another arm |
| AVFoundation microphone capture | `audio_daemon.swift` | Keep inside a native capture arm | Keep Python callers behind `audio_daemon.sock` |
| TCC scopes and reset commands | `MacOSPermissionModel`, `setup.sh` | Move new permission checks through `PermissionModel` | Route repair/doctor permission reads through the seam where practical |
| launchd plist keys and `launchctl` verbs | plists, `setup.sh`, `dev_install.py`, `doctor.py`, `MacOSDaemonManager` | Move new service-management logic through `DaemonManager`; keep static plists until installer migration | Use `ServiceSpec` for any new daemon install path |
| `~/Library/LaunchAgents` | plists/setup/dev tools | Move new computed paths through the macOS daemon arm | Avoid adding new direct LaunchAgents path literals |
| `~/.config/yulu` runtime state | many scripts | Keep as machine-local runtime via `PathResolver.runtime_dir()` | New runtime state must use the resolver or an existing config helper |
| `~/Movies/Yulu` content root | audio daemon, record/search/UI paths | Move new content-root reads through `PathResolver.data_dir()` | Do not point runtime DBs, sockets, locks, or caches at this root |
| Homebrew and formula names | `setup.sh`, doctor/dependency checks | Move new dependency checks through `DependencyManager` | Do not add new package-manager calls outside the macOS arm |
| `terminal-notifier`, `osascript`, Accessibility window scanner | notification and meeting detection paths | Keep as macOS integration details behind user-visible workflows | Do not make product logic depend on their raw output shape |
| `cloudflared`/`gog` calendar integration | calendar services and connector provider | Treat as opt-in connector capability | Keep credentials outside `config.json`; store env var names only |

## Privacy and cloud opt-in boundary

Default behavior is local-only:

| Data or action | Default | Opt-in path |
|---|---|---|
| Raw audio, clean mixes, transcripts, summaries | Stored on local disk only | User chooses a different `audio.output_dir`; cloud folders show an explicit warning before commit |
| Runtime DBs, sockets, locks, queue, schedule, and caches | Machine-local runtime dir only | No cloud/sync opt-in; runtime under a sync root is refused when detected |
| Local transcription | MLX Whisper or whisper.cpp on the user's machine | `transcription.mode = cloud-fallback` or `cloud-priority` plus a user-owned `transcription.cloud_command` |
| Summary generation | Agent queue or local fallback | User-owned `llm.command` can invoke any external agent or API wrapper |
| Summary distribution | No external send | Connector-specific explicit actions such as Notion or Zulip send |
| Calendar ingest | Disabled until configured | Google Calendar via `gog`/OAuth, or another connector provider |
| Search index and history | Local SQLite only | No cloud search backend; future sync must be a separate explicit feature |

Rules for new code:

- Never put audio, transcript, summary, prompt, search, or schedule content on a
  network/cloud service unless the user explicitly selected that workflow.
- `config.json` must not store secrets. It may store env var names, command
  arrays, paths, and booleans.
- Warnings for cloud content folders are opt-in confirmations, not hard blocks.
  Runtime/state folders are different: they must stay machine-local because live
  SQLite WAL files, locks, sockets, and process state are not sync-safe.
- Connector providers report capability and provenance; they do not make hidden
  network calls on discovery.

## Library and search root boundary

The v1 library is one content root: the Yulu data dir (`~/Movies/Yulu` by
default). Search vNext may introduce a root registry, but the safe boundary is:

1. The default registry contains only the Yulu data dir.
2. External roots are explicit opt-in and read-only from Yulu's perspective.
3. Runtime locations are never valid content roots: no `search.sqlite`,
   `prompts.sqlite`, `vocab.sqlite`, WAL files, sockets, locks, pid files,
   caches, or `agent-queue.json`.
4. `.realtime.transcript.txt` stays excluded from durable search because it is
   noisy and superseded by final transcripts.
5. Cross-device sync is not implied by multiple roots. Sync needs its own product
   design, conflict model, and privacy prompt.

The current Search vNext plan lives in
`docs/superpowers/specs/2026-06-24-search-vnext-roadmap.md` and keeps semantic
search gated behind a local-runtime spike.
