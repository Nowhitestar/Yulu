# Contributing to Yulu

Thanks for considering a contribution. Yulu is small enough that the process is intentionally light.

## Ground rules

- **Privacy is the product.** Anything that sends audio, transcripts, or calendar data off the device by default is a non-starter. Cloud features are opt-in, off by default, and isolated behind a single config flag.
- **No virtual audio devices.** The whole point of the ScreenCaptureKit path is that users do not need to install BlackHole / Loopback / multi-output devices. PRs that introduce a virtual driver as a hard requirement will not be accepted.
- **Recording must always ask.** `notify.py` consent prompts are not optional, even for "convenience" auto-record paths.
- **Bring-your-own-LLM.** Do not hard-code one vendor in the summary path. The agent queue (`agent-queue.json`) and the configurable `llm.command` are the two supported entry points.

## Before you open a PR

1. **Run the existing flow end-to-end** on your own machine: `setup.sh` → trigger a manual recording → confirm `transcript.txt` and `summary.md` get written. Smoke-test changes in `meeting_daemon.py`, `audio_daemon.swift`, and `transcribe.py` against a real meeting whenever you can.
2. **Do not commit secrets.** `.gitignore` blocks the obvious files (`client_secret*.json`, `config.json`, recordings) but the responsibility is yours. If you ever pasted real tokens during development, rotate them in Google Cloud and revoke the old client.
3. **Match the codebase style.**
   - Python: type hints where it helps, no new heavy dependencies, prefer the standard library.
   - Swift: keep `audio_daemon.swift` and `recorder_status.swift` runnable as standalone files; do not split into a Swift package without prior discussion.
   - Shell: `bash`, `set -e` style. The installer must remain idempotent.
4. **Update docs.** README for user-visible changes, `docs/operations.md` for new commands, `CHANGELOG.md` for everything that lands.

## What is in scope

| Area | Welcome contributions |
|---|---|
| Audio | Stability fixes, sample rate negotiation, AirPods edge cases |
| Detection | More meeting apps (Webex, BlueJeans, Discord stages, etc.) |
| Transcription | Speaker diarization, punctuation post-processing, language auto-detect |
| Summary templates | New template variants under `scripts/summary_template*.md` |
| Calendars | Outlook / iCloud calendar adapters that mirror the Google one |
| Output sinks | Notion / Telegram / Zulip / local Obsidian vault formatters |
| Packaging | Homebrew tap, signed `Yulu.app` releases on GitHub |

## What is out of scope (for now)

- Cross-platform ports (Windows / Linux). The macOS-native path is the moat; a cross-platform version would be a fork, not a PR.
- Realtime UI / Electron desktop app. The floating Swift status window is on purpose minimal.
- Vendor-specific cloud transcription as the default path. Adapters are fine; defaults are not.

## Reporting bugs

Open an issue with:

1. macOS version + Apple Silicon / Intel.
2. `echo '{"action":"status"}' | nc -w 2 -U ~/.config/yulu/audio_daemon.sock` output.
3. The last ~50 lines of `~/Library/Logs/yulu/*.log` (or wherever your LaunchAgent log path resolves to).
4. What you expected vs. what happened.

## Security

Please do not open public issues for security problems. Email the maintainer directly (see commit history for the address). Disclosures involving credentials, calendar data, or audio capture get priority.

## License

By submitting a PR you agree your contribution is released under the MIT license in [LICENSE](LICENSE).
