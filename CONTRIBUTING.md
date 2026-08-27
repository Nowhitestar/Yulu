# Contributing to Yulu

Thanks for considering a contribution. Yulu is small enough that the process is intentionally light.

## Ground rules

- **Privacy boundaries must be explicit.** Native capture and durable task state stay local. Model execution belongs to the explicitly selected capability provider, while connectors belong to the selected local Agent; every Yulu-triggered external delivery must be separately authorized and auditable.
- **No virtual audio devices.** The whole point of the ScreenCaptureKit path is that users do not need to install BlackHole / Loopback / multi-output devices. PRs that introduce a virtual driver as a hard requirement will not be accepted.
- **Recording must always ask.** `notify.py` consent prompts are not optional, even for "convenience" auto-record paths.
- **Keep capability boundaries separate.** The explicitly selected Yulu audio engine owns realtime captions, final transcription, and dictation. The task's pinned Summary Provider—xAI, Codex, Claude Code, or CLIProxyAPI—owns summary generation. Hermes and OpenClaw are Conversation-only; Hermes separately owns authorized connector delivery. Yulu owns native capture, durable tasks, leases, task-scoped artifacts, policy, and audit. No capability may silently fall back to another provider or model.

## Before you open a PR

1. **Run the existing flow end-to-end** on your own machine: `make dev-install` → `yulu doctor --json` → trigger a manual recording → confirm its durable Host task completes and both `transcript.txt` and `summary.md` are committed. Exercise `meeting_daemon.py`, `audio_daemon.swift`, and the TypeScript recording pipeline when those boundaries change.
2. **Do not commit secrets or user data.** `.gitignore` blocks common config, token, recording, and transcript paths, but the responsibility is yours. Rotate the Yulu MCP token and revoke any affected Agent/calendar credential after exposure.
3. **Match the codebase style.**
   - Python: type hints where it helps, no new heavy dependencies, prefer the standard library.
   - TypeScript: preserve the Host state-machine invariants and add failure/restart/idempotency tests for every new transition.
   - Swift: keep `audio_daemon.swift` and `recorder_status.swift` runnable as standalone files; do not split into a Swift package without prior discussion.
   - Shell: `bash`, `set -e` style. The installer must remain idempotent.
4. **Update current docs.** README for user-visible changes and `docs/operations.md` for operational changes. Use a Conventional Commit/PR title; release-please owns `VERSION` and `CHANGELOG.md`.

## What is in scope

| Area | Welcome contributions |
|---|---|
| Audio | Stability fixes, sample rate negotiation, AirPods edge cases |
| Detection | More meeting apps (Webex, BlueJeans, Discord stages, etc.) |
| Agent pipeline | Hermes compatibility, capability isolation, recovery, idempotency, and audit |
| Summary prompts | Prompt-library improvements that preserve Agent ownership |
| Calendars | Outlook / iCloud calendar adapters that mirror the Google one |
| Connectors | Agent-owned connector workflows with explicit Yulu authorization and verified results |
| Packaging | Checksum-verified, signed, notarized, and stapled runtime releases |

## What is out of scope (for now)

- Cross-platform ports (Windows / Linux). The macOS-native path is the moat; a cross-platform version would be a fork, not a PR.
- Adding another transcription engine, automatic provider/model fallback, a second chat engine, or Yulu-owned connector execution. ADR-007 defines audio engines and ADR-009 defines the accepted Grok-compatible xAI credential/capability boundary.
- Unsigned production installer assets or updater paths that require administrator privileges.

## Reporting bugs

Open an issue with:

1. macOS version + Apple Silicon / Intel.
2. The relevant, redacted section of `yulu doctor --json`.
3. The Host task ID/state and the last ~50 relevant lines from `~/.config/yulu/*.log`; never include tokens, transcripts, or meeting content.
4. Hermes version/contract status and what you expected versus what happened.

## Security

Please do not open public issues for security problems. Email the maintainer directly (see commit history for the address). Disclosures involving credentials, calendar data, or audio capture get priority.

## License

By submitting a PR you agree your contribution is released under the MIT license in [LICENSE](LICENSE).
