# Configuration Reference

Yulu reads active configuration from `~/.config/yulu/config.json`. The installer
creates it with private per-user defaults. The file contains product preferences,
paths, and Agent selection only; it must not contain Agent or connector secrets.

The current schema separates the audio engine, Summary Provider, Conversation
Provider, and connectors. The explicitly selected audio engine handles realtime
captions, final transcription, and dictation; local is the default and no
capability silently falls back to another provider or model.

## Representative configuration

```json
{
  "audio": {
    "backend": "daemon",
    "output_dir": "~/Movies/Yulu",
    "mic_device": "",
    "silence_threshold": 0.01,
    "silence_duration_sec": 300,
    "half_duplex": true
  },
  "transcription": {
    "engine": "local",
    "language": "zh",
    "dictation": {
      "prompt_slug": "dictation-cleanup",
      "translate_prompt_slug": "dictation-translate",
      "target_language": "English",
      "context_limit": 240,
      "deadline_sec": 30,
      "timeout_sec": 30,
      "translate_deadline_sec": 30,
      "translate_timeout_sec": 30
    }
  },
  "intelligence": {
    "summary": { "provider": "agent", "model": "runtime-managed" },
    "conversation": { "provider": "agent", "model": "runtime-managed" }
  },
  "agent_pipeline": {
    "enabled": true,
    "auto_process_recordings": true,
    "auto_send_notion": false,
    "notion_destination": "Yulu Meeting"
  },
  "llm": {
    "enabled": true,
    "command": null,
    "agent": {
      "provider": "hermes"
    }
  },
  "agent_console": {
    "plugins": {
      "added": ["summary"]
    },
    "destinations": {
      "hermes": {
        "notion": {
          "target": "Yulu Meeting"
        }
      }
    }
  },
  "status_agent": {
    "enabled": true,
    "hotkeys": {
      "dictate": { "key": "Space", "modifiers": ["ctrl", "alt"] },
      "translate": {
        "key": "T",
        "modifiers": ["ctrl", "alt"],
        "target_language": "English"
      },
      "voice_chat": { "key": "A", "modifiers": ["ctrl", "alt"] }
    }
  },
  "calendars": [
    {
      "type": "macos",
      "enabled": true,
      "watch_calendars": []
    }
  ],
  "meeting_detection": {
    "enabled": true,
    "interval_sec": 10,
    "stable_sec": 15,
    "prompt_cooldown_sec": 1800
  },
  "ui": {
    "theme": {
      "family": "default",
      "mode": "auto",
      "custom": {
        "light": {},
        "dark": {}
      }
    }
  }
}
```

Unknown keys are generally preserved for forward compatibility, but retired
runtime keys are archived and removed on Host startup.

## `audio`

| Field | Installer value | Meaning |
|---|---:|---|
| `backend` | `"daemon"` | Native `Yulu.app` capture. This is the supported product path. |
| `output_dir` | `~/Movies/Yulu` | Recording content root. The Host accepts completed recordings only from this root. |
| `mic_device` | `""` | Optional native microphone selection. Empty uses the current default. |
| `silence_threshold` | `0.01` | System-audio silence threshold used by capture behavior. |
| `silence_duration_sec` | `300` | Auto-stop threshold for prolonged silence. |
| `half_duplex` | `true` | Prefer system audio while others speak and microphone during system silence. |

`mic_device`, `output_dir`, `silence_threshold`, and `silence_duration_sec` are
read when the next recording starts and do not require an audio-daemon restart.
The microphone selector is populated by the running native CoreAudio daemon;
an empty `mic_device` keeps the current macOS default input.

Native permission state is not configuration. `Yulu.app` must be allowed under
Microphone and Screen & System Audio Recording in macOS Settings.

## `agent_pipeline`

This section controls durable recording work, not an AI implementation.

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Master switch for automatic summary/delivery work. When false, durable Agent work pauses in `awaiting_policy`; the separately selected audio engine remains available for transcription and dictation. |
| `auto_process_recordings` | `true` | Accept completed recordings and dispatch automatic tasks. When false, recordings remain saved, automatic work pauses, and explicit manual processing stays available. |
| `auto_send_notion` | `false` | Add explicit Notion authorization to automatically created recording tasks. |
| `notion_destination` | `"Yulu Meeting"` | Human-readable destination hint passed to Hermes. It is not a credential or database secret. |

Setting `auto_send_notion=true` is a real side-effect opt-in. The Host will allow
Hermes to begin delivery only after the transcript has been durably committed and
the summary has been generated and committed.

The switches have deliberately different scope. `enabled=false` pauses summary and
delivery work at `awaiting_policy`; it does not disable the independently selected
audio engine. `auto_process_recordings=false` pauses only automatic intake and
automatic dispatch. Explicit transcription and dictation remain available, and
choosing a manual summary action for an automatic `awaiting_policy` task promotes
the recording into a new explicit manual summary task after retiring the paused
automatic work.

## `intelligence`

`summary` and `conversation` are independent provider/model selections. `agent`
uses an explicit Agent Connection Center selection in the form
`{ "provider": "agent", "connectionId": "…", "model": "exact-model" }`.
Codex, Claude Code, and CLIProxyAPI therefore keep both the exact connection ID
and exact tested model; `runtime-managed` is only a legacy compatibility value,
not proof that a current connection is ready. `xai` stores the exact configured
model name and resolves to the direct xAI connection. Summary tasks and
conversation sessions snapshot the connection/provider/model identity at
creation, so later settings changes affect only new work. No credential belongs
in either object; persisted tasks and xAI conversation sessions store only
non-secret credential class/source identities such as `runtime-oauth`, `oauth`,
or `api-key`.

When a pinned Summary Provider is unavailable after transcript commit, the task
enters `awaiting_provider` and stays there until an explicit same-provider retry.
Yulu never rewrites the existing snapshot from current settings.

Both automatic and manual xAI summaries use only the snapshotted instructions
and the committed transcript. Requests use the exact pinned model with response
storage disabled; the returned Markdown must pass Host staging validation before
the transcript/summary pair and artifact provenance are committed.

xAI conversations search only local meeting summaries and transcripts before a
request. Yulu sends at most 8 normalized sources, 1,200 characters per excerpt,
6,000 characters total across source titles, dates, kinds, and excerpts, and a
local-history tail of at most 12 messages and 12,000 characters. No matching
excerpt sends no request. Requests use the pinned model and credential source
with `store:false` and no tools, files, collections, Web/X search, connectors,
or response chaining, and reject a different response model. Source cards come
from those local search hits, not model output. A retrieval or request failure
pauses the local session without changing its identity or deleting messages and
sources. Explicit retry is one Host mutation and reuses the persisted evidence
snapshot; current settings and a fresh search cannot replace it.

## `transcription`

One explicit Yulu audio engine handles realtime captions, final transcription,
and dictation. The default is local and there is no automatic fallback.

| Field | Installer value | Meaning |
|---|---:|---|
| `engine` | `"local"` | `local` or `xai`; the selected value is used exactly for all audio transcription paths. |
| `language` | `"zh"` | `zh`, `en`, `ja`, or `auto`. Japanese requires the `xai` engine; Settings rejects the unsupported `local` + `ja` combination. |
| `dictation.prompt_slug` | `"dictation-cleanup"` | Local prompt selected for normal dictation cleanup. |
| `dictation.translate_prompt_slug` | `"dictation-translate"` | Local prompt selected for quick translation. |
| `dictation.target_language` | `"English"` | Default target for dictation translation and the realtime-caption language selector. |
| `dictation.context_limit` | `240` | Maximum local prompt/glossary context characters. |
| `dictation.deadline_sec` | `30` | End-to-end post-capture budget used by installed shortcuts. |
| `dictation.timeout_sec` | `30` | Host/Agent request budget used by installed shortcuts. |
| `dictation.translate_deadline_sec` | `30` | Translation-specific deadline override. |
| `dictation.translate_timeout_sec` | `30` | Translation-specific request override. |

The Host accepts on-demand audio only from the configured recordings directory
or `~/.config/yulu/dictation`, and only as a valid absolute WAV path.

Settings → Intelligent Services is the authoritative Agent Connection Center.
xAI is connected there using Grok CLI-compatible OAuth or an API key the user
explicitly chooses. OAuth tokens and API keys stay
in separate macOS Keychain items; neither is a configuration field or browser
read-back value. OAuth remains primary while present, and an OAuth or entitlement
failure never causes an automatic switch to the saved API key. The page records
separate real-request readiness for transcription, summary, and conversation.
Opening or deep-linking it performs status inspection only; it does not
implicitly run a capability probe or model request.
Upgrades archive and remove the retired `transcription.xai_credential_source`
field; Hermes/OpenClaw credentials are not imported or deleted.

Hermes and OpenClaw are Conversation-only entries in Agent Connection Center;
they are never selectable as Summary providers. OpenClaw readiness uses the
runtime-owned Gateway and the stable, raw `infer model run --gateway` surface so
the probe has no agent tools, prior session, bootstrap context, or bundled MCP.
The subsequent Conversation stays pinned to the exact provider, model, and
native session returned by `openclaw agent`. Hermes 0.20.0 has no documented
empty tool allowlist or equivalent raw probe, so its production adapter remains
fail-closed even when native OAuth status is healthy.

## `llm` and Agent Console

`llm` configures legacy general-Agent behavior. It does not select transcription,
summaries, or conversation identity: those use `transcription.engine` and the two
`intelligence` selections. Future Agent Console sessions require an explicit
ready `intelligence.conversation` connection; an existing session keeps its
pinned connection, provider, model, and native session identity.

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Enable the general Agent used by interactive conversations. This does not disable the selected Yulu audio engine. |
| `command` | `null` | Optional explicit general-Agent argv. No shell interpolation is performed. |
| `agent.provider` | `"auto"` in schema; installer chooses `"hermes"` | `auto`, `codex`, `claude`, `claude-code`, `hermes`, `openclaw`, `gemini`, `grok`, or `custom`. Gemini, Grok, and custom providers currently require an explicit `command`. |

When `provider=auto`, the general runtime detects supported CLIs in its current
priority order. This does not change any existing audio/task/session snapshot.
If the pinned Summary Provider is unavailable, a recording transcript remains
committed while its summary task waits in `awaiting_provider`.

To pause automatic summary and delivery work, set `agent_pipeline.enabled=false`.
Realtime captions, transcription, and dictation remain controlled by the selected
audio engine. `llm.enabled=false` only disables general conversation work.

`agent_console.plugins.added` is a presentation filter for capabilities shown in
Agent Console. `agent_console.destinations` stores human-readable destination
hints. Credentials, OAuth state, connector tools, and actual connection settings
belong to the Agent. For a durable recording delivery,
`agent_pipeline.notion_destination` is the authoritative destination hint;
`agent_console.destinations` must not independently trigger delivery.

## `status_agent`

The menu-bar Agent exposes recording state and global shortcuts. Hotkey modifiers
are `cmd`, `shift`, `alt`, and `ctrl`. The default shortcuts are:

- `ctrl+alt+Space`: dictation;
- `ctrl+alt+T`: translation;
- `ctrl+alt+A`: voice question into Agent Console.

Use `yulu status-agent hotkeys` to inspect the effective values.

## Calendars and meeting detection

Calendar/window detection exists only to decide when to offer native capture. It
is not the connector surface used by Agent Console.

The recommended calendar source is `type: "macos"`, which reuses calendars
already visible in macOS Calendar. `watch_calendars` may be empty for all visible
calendars or contain explicit names. `meeting_detection` controls window polling,
stability, and cooldown for recording prompts.

Interactive calendar reasoning and other connector actions belong to the selected
general Agent.

## Themes

`ui.theme.family` is `default`, `ayu`, `paper`, or `custom`.
`ui.theme.mode` is `auto`, `light`, or `dark`. Custom light/dark token maps are
optional and may override wallpaper, surfaces, edges, text, muted text, accent,
and semantic colors.

## Automatic migration of retired settings

When the Host opens the config, it performs one-way, auditable retirement:

- old inference settings are copied to
  `config.legacy-transcription.<timestamp>.json` and removed from the active
  `transcription` object; the retired `realtime_captions` block and Hermes audio
  service fields are archived in the same file and removed as well;
- old Yulu-owned external-delivery settings are copied to
  `config.legacy-connectors.<timestamp>.json`; destination hints and explicit
  Notion opt-in are projected into the Agent-native fields before the active
  blocks are removed;
- archives are written with mode `0600` and are not active runtime inputs.

The settings API rejects attempts to write a retired inference field. Do not copy
archived keys back into `config.json`.

## Validation and safety

Validate syntax without exposing the file contents:

```bash
python3 -m json.tool ~/.config/yulu/config.json >/dev/null
yulu doctor --json
```

Operational guidance:

- Keep `config.json`, `mcp-token.json`, `host.sqlite`, and task workspaces out of
  Git and cloud-sync folders.
- Store Agent and connector credentials in the Agent's own credential store.
- Prefer the Settings UI or Yulu commands for updates; the Host performs atomic
  writes and rejects stale concurrent edits.
- After changing Agent availability or pipeline settings, restart the Host with
  `yulu restart` and verify `yulu doctor --json`.
