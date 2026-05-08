# Changelog

All notable changes to Yulu are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- `install.sh`: `[[ -e /dev/tty ]]` could be true while the device wasn't actually openable (CI runners, sandboxed agents, certain SSH sessions), causing the install to bail with `/dev/tty: Device not configured` before `setup.sh` ever ran. Now we cascade through `[[ -t 0 ]]` (stdin already a tty) → `(exec 3</dev/tty) 2>/dev/null` (try to open it for real) → `< /dev/null` (truly non-interactive, fall back to defaults). Shipped as a hotfix to `v0.3.0`.

## [0.3.0] - 2026-05-08

### Added
- **One-line installer**: `curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash`. The installer pre-flights macOS / Xcode CLI / git, clones to `~/.yulu/` (a stable path), then hands off to `setup.sh`. If a previous installation is detected (any `com.yulu.*` LaunchAgent in `~/Library/LaunchAgents/`), it runs in `--upgrade` mode automatically.
- **`yulu` CLI** (`yulu/scripts/yulu`, symlinked to `~/.local/bin/yulu` by setup): single command surface for `setup`, `update`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs`, `record start/stop`, `where`. Symlink-resolved so the CLI keeps working even if the repo path changes.
- **`setup.sh --upgrade` mode**: idempotent re-run. Skips already-granted TCC, already-authed Google OAuth, already-downloaded whisper model, already-existing config. Used by `yulu update` and the installer's auto-detect.
- **`yulu/scripts/uninstall.sh`** (`yulu uninstall`): stops services, removes LaunchAgents and the CLI; prompts before deleting recordings, config, or registered agent skills; prints the manual-cleanup pointers for TCC and Homebrew packages.
- **whisper.cpp model download in setup**: a new step lets the user pick `base` / `small` / `medium` / `large-v3-q5_0` / `large-v3` (default `large-v3-q5_0`, ~1.1 GB), downloads to `~/.config/yulu/models/`, and writes the explicit `whisper-cli -m …` command into `config.json` so transcription works on first use. Previously users hit a missing-model failure on their first meeting.
- **Yulu now ships as an [open agent skill](https://github.com/vercel-labs/skills)**. `skills/yulu/SKILL.md` documents the verbs Yulu exposes (start / stop / status / fulfill `summary_request` / find a past meeting) so any agent in the `vercel-labs/skills` ecosystem (Claude Code, OpenClaw, Codex, Cursor, and 50+ others) can drive Yulu from natural language. Install with `npx skills add Nowhitestar/Yulu -g -a claude-code -a openclaw -y`; `setup.sh` offers to do it for you. The skill is a thin contract — `setup.sh` is still required for the macOS app, launchd services, and whisper.cpp install.

### Changed
- **Default recording directory is now `~/Movies/Yulu/`** instead of `<repo>/meeting-recordings/`. New installs get `~/Movies/Yulu`; existing installs honor whatever `audio.output_dir` was already set to in `config.json`. This decouples the recordings from the repo clone — moving or deleting `~/.yulu/` no longer takes your meeting history with it.
- **`setup.sh` no longer clears the terminal** on launch — the user's `cd` history and pre-install context are preserved for debugging.
- **`Yulu.app` quarantine attribute is stripped after build** (`xattr -dr com.apple.quarantine`) so the ad-hoc-signed bundle launches without the silent Gatekeeper block that LSUIElement apps swallow.
- Test step labels in `run_tests` are now consistent (`1/4` … `4/4`).
- The "Python 3.14" suggestion in `check_system` is now just `brew install python` (3.14 was a moving target).

### Removed
- The legacy `git clone … && cd Yulu && bash yulu/scripts/setup.sh` instruction in both READMEs is replaced by the one-line installer. Manual setup is still documented for hackers, but the headline path is now `curl … | bash`.

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

[Unreleased]: https://github.com/Nowhitestar/Yulu/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Nowhitestar/Yulu/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Nowhitestar/Yulu/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Nowhitestar/Yulu/releases/tag/v0.1.0
