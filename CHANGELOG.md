# Changelog

All notable changes to Yulu are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Yulu now ships as an [open agent skill](https://github.com/vercel-labs/skills). A new `skills/yulu/SKILL.md` documents the verbs Yulu exposes (start / stop / status / fulfill `summary_request` / look up past meetings) so any agent in the `vercel-labs/skills` ecosystem (Claude Code, OpenClaw, Codex, Cursor, and 50+ others) can drive Yulu from natural language.
- `npx skills add Nowhitestar/Yulu -g -a claude-code -a openclaw -y` installs the skill to all configured agents in one shot. The skill is a thin contract — `setup.sh` is still required for the macOS app, launchd services, and whisper.cpp install.
- `setup.sh` gained an optional Step 9 that runs the above command for you (defaults to Claude Code + OpenClaw, lets you override the target list, and skips silently if `npx` isn't available).
- Both READMEs now have a "Use Yulu from your coding agent" section walking through this.

## [0.2.0] - 2026-05-08

### Changed
- Renamed the audio daemon bundle path from `yulu/scripts/AudioDaemon.app` to `yulu/scripts/Yulu.app` so that System Settings, Activity Monitor, the Dock, and TCC prompts identify the app as **Yulu** end-to-end. The `audio_daemon` executable name, `com.yulu.audiodaemon` bundle id, `com.yulu.audiodaemon` LaunchAgent label, and `~/.config/yulu/audio_daemon.sock` socket path are unchanged — TCC permissions granted in 0.1.0 are preserved.
- User-facing log messages, setup prompts, and documentation now refer to "Yulu" instead of "AudioDaemon" wherever the user is the audience. Internal identifiers (`audio_daemon` binary, `com.yulu.audiodaemon` bundle id, socket name) are deliberately kept.

### Removed
- `yulu/scripts/migrate_to_yulu.sh` and the "Upgrading from `meeting-assistant`" section of both READMEs. The pre-rename `meeting-assistant` codename never had a public release, so there are no installs in the wild that need migrating off it. The `setup.sh` legacy-install detector that prompted users to run the migration script is also gone.
- `assets/demos/README.md` placeholder — the four demo screenshots it described were committed in 0.1.0, so the placeholder is no longer needed.

## [0.1.0] - 2026-05-07

### Added
- Initial public release as **Yulu** (语录).
- Native macOS recording via `ScreenCaptureKit` (system audio) + `AVFoundation` (microphone), no BlackHole required.
- Signed `Yulu.app` Unix-socket controller.
- Half-duplex mixing: prioritize system audio, fade to microphone during system silence.
- Floating recording status window with a manual stop button.
- Local transcription via `whisper.cpp` (`whisper-cli`).
- Agent-queue-based summarization: any agent (Claude Code, Codex, OpenClaw…) can consume `agent-queue.json` and write back `summary.md` from `summary_template.md`.
- Optional bring-your-own-LLM external command path in `transcribe.py`.
- Google Calendar integration via `gog` with refresh tokens stored in macOS Keychain.
- Window-based meeting detection for Zoom, Tencent Meeting, Google Meet, Feishu/Lark, WeChat calls, and browser meetings.
- LaunchAgent definitions for scheduler, detector, calendar, and audio daemons.

### Changed (breaking)
- Project renamed from `meeting-assistant` to **Yulu** for the public release.
  - Repository directory: `meeting-assistant/` → `yulu/`
  - User config dir: `~/.config/meeting-assistant/` → `~/.config/yulu/`
  - LaunchAgent labels: `com.meetingassistant.*` → `com.yulu.*`
  - AudioDaemon bundle id: `com.meetingassistant.audiodaemon` → `com.yulu.audiodaemon`
  - Skill package: `meeting-assistant.skill` → `yulu.skill`
  - Code-signing env var: `MEETING_ASSISTANT_CODESIGN_IDENTITY` → `YULU_CODESIGN_IDENTITY`
- Existing users: run `bash yulu/scripts/migrate_to_yulu.sh` once before re-running `setup.sh`. The bundle-id change means macOS will prompt for Microphone and Screen & System Audio Recording permissions again — that is expected.

### Removed
- Hardcoded personal Apple Developer email in `build_audio_daemon.sh`. Code-signing now defaults to "Developer ID Application" → "Apple Development" → ad-hoc, all auto-detected.

### Security
- Removed all hardcoded Google OAuth secrets from the repository history.
- `.gitignore` blocks `config.json`, `client_secret*.json`, `credentials*.json`, `token*.json`, and local recordings by default.

[Unreleased]: https://github.com/Nowhitestar/Yulu/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Nowhitestar/Yulu/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Nowhitestar/Yulu/releases/tag/v0.1.0
