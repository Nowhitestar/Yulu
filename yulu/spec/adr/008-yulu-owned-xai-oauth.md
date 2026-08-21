# ADR-008: Yulu-owned xAI OAuth

Status: Accepted

Supersedes the xAI credential-source decision in ADR-007. ADR-007's explicit
audio-engine selection, no-fallback behavior, and direct xAI audio execution
remain in force.

## Context

The xAI audio engine depended on Hermes or OpenClaw as an OAuth credential
wallet. Yulu started an Agent CLI and scraped its console output for a device
authorization URL. Console buffering and CLI compatibility could prevent the
URL from reaching Settings, leaving authorization stuck before the user could
complete it. Audio availability therefore still depended on an unrelated Agent
installation even though Yulu executed the xAI audio protocol directly.

## Decision

Yulu owns the xAI OAuth device authorization flow used by its audio engine. The
loopback Host requests a device code directly from xAI, exposes only the
verification URL, user code, and non-secret state to Settings, polls the token
endpoint, and refreshes rotating credentials under a single-flight lock.

OAuth tokens are stored in macOS Keychain through a signed helper inside
`Yulu.app`. Tokens never enter `config.json`, Host SQLite, browser responses, or
logs. Yulu validates OAuth and inference endpoints as xAI HTTPS origins before
sending a credential.

The current implementation temporarily uses the public Grok CLI OAuth client
registration. It must be replaced by a Yulu-owned xAI client registration
before broad distribution. Hermes and OpenClaw credentials are neither imported
nor removed.

## Consequences

- xAI realtime captions, final transcripts, and dictation no longer require an
  installed Agent or an Agent-owned OAuth store.
- Selecting `xai` remains explicit and never falls back to `local`.
- Existing `transcription.xai_credential_source` settings are archived and
  removed; users authorize xAI once in Yulu after upgrading.
- Hermes remains the automatic recording-summary and authorized Notion delivery
  runtime. This decision does not move those responsibilities into Yulu.
