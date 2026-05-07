# Changelog

All notable changes to Yulu are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Initial public release as **Yulu** (语录).
- Native macOS recording via `ScreenCaptureKit` (system audio) + `AVFoundation` (microphone), no BlackHole required.
- Signed `AudioDaemon.app` Unix-socket controller.
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
