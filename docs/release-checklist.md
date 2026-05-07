# Release Checklist (for the maintainer)

This file is a one-time pre-flight for taking Yulu public. Delete it after the first release if you do not want it in the repo, or keep it as a template for future major releases.

## 1. GitHub repository metadata

Set these on the repo Settings page:

- **Name**: `Yulu`
- **Description**:
  > 🦻 Listen quietly. Capture everything. — Native macOS meeting recorder & note-taker. ScreenCaptureKit + whisper.cpp, no BlackHole.
- **Website**: leave blank or point at a GitHub Pages site if you make one.
- **Topics** (comma-separated, GitHub will turn each into a tag):
  ```
  macos, yulu, meeting-assistant, meeting-recorder, meeting-notes,
  screencapturekit, whisper, transcription, swift, python, claude-code,
  agent, audio-recording, productivity, voice, local-first
  ```
  Keep `meeting-assistant` as a topic for discoverability — that is how most people will search.
- **Social preview image**: generate from `assets/logo.svg` at 1280×640. Black ink `语` on parchment, tagline below in Charter or Songti. Save as `assets/social-card.png` (git-ignored — upload directly to GitHub Settings → Social preview).

## 2. Pre-publish security sweep

Run all of these before the first push to a public remote:

```bash
# Look for accidentally committed secrets across all branches and history
git log --all -p -- '**/client_secret*.json' '**/credentials*.json' '**/token*.json' \
  | head -100

# Common token shapes
git rev-list --all | xargs -I{} git grep -E \
  -e 'sk-[a-zA-Z0-9]{20,}' \
  -e 'AIza[0-9A-Za-z_-]{35}' \
  -e 'xox[baprs]-[A-Za-z0-9-]{10,}' \
  -e 'ghp_[A-Za-z0-9]{36}' \
  {} -- '*.py' '*.swift' '*.sh' '*.md' '*.json' 2>/dev/null | head

# Personal calendar IDs (gmail addresses inside JSON)
git log --all -p | grep -E '@(gmail|outlook|icloud)\.com' | head
```

If anything matches:
1. Rotate the credential immediately (Google Cloud / Telegram / Notion / etc.).
2. Use [`git filter-repo`](https://github.com/newren/git-filter-repo) or BFG to scrub the file from history.
3. **Force-push only to a fresh remote.** Do not push the cleaned history over an existing public branch — assume the old refs are already cached by GitHub and clones.

The repo already had one OAuth secret incident (commit `1d15d41 chore: remove hardcoded Google OAuth secrets`). Confirm the corresponding OAuth client was deleted in Google Cloud Console and the refresh token revoked. Removing the commit is not enough.

## 3. Files that should exist before publishing

| File | Purpose | Status |
|---|---|---|
| `README.md` | Public landing (English) | ✅ written |
| `README.zh-CN.md` | 简体中文版本 README | ✅ written |
| `LICENSE` | MIT | ✅ written |
| `CONTRIBUTING.md` | Contribution rules | ✅ written |
| `CHANGELOG.md` | Versioned change log | ✅ written |
| `SECURITY.md` | Disclosure policy | ✅ written |
| `.gitignore` | Blocks secrets, recordings, agent state | ✅ updated |
| `assets/logo.svg` | Primary mark | ✅ written |
| `assets/logo.png` | Raster mirror | ⏳ generate before release |
| `assets/demos/demo-*.png` | README screenshots | ⏳ capture before release |
| `assets/social-card.png` | GitHub social preview | ⏳ generate before release |
| `docs/branding.md` | Brand & visual rules | ✅ written |
| `docs/configuration.md` | Full config reference | ✅ written |
| `docs/operations.md` | Manual commands & troubleshooting | ✅ written |
| `yulu/scripts/migrate_to_yulu.sh` | One-shot upgrade for old installs | ✅ written |
| `yulu.skill` | Repackaged skill ZIP for Claude Desktop | ✅ rebuilt |

## 4. Demo capture session

Before the first announcement, sit down for 30 minutes and capture:

1. `assets/demos/demo-status-window.png` — floating recorder window.
2. `assets/demos/demo-prompt.png` — consent prompt.
3. `assets/demos/demo-transcript.png` — `whisper-cli` running.
4. `assets/demos/demo-summary.png` — final summary in your editor.
5. (Optional) `assets/demos/demo.gif` — a 15-second VHS recording of the full flow.

Use a clean macOS user account or hide all personal context (calendar names, contact names, Slack DMs in the background). Compress with `pngquant` before committing.

## 5. Code-side rename — already done

The repository has been fully renamed from `meeting-assistant` to **Yulu**. The first public release is the breaking-change cut-over (no `v1.x` line will exist publicly). Reference for the historical migration:

| From | To | Affects |
|---|---|---|
| `meeting-assistant/` directory | `yulu/` | All script paths, `setup.sh`, README |
| `~/.config/meeting-assistant/` | `~/.config/yulu/` | Python config readers, LaunchAgent plists |
| `com.meetingassistant.audiodaemon` bundle id | `com.yulu.audiodaemon` | Code signature; macOS treats it as a new app, so users must re-grant Microphone + Screen Recording |
| `com.meetingassistant.*.plist` | `com.yulu.*.plist` | LaunchAgent labels |
| `MEETING_ASSISTANT_CODESIGN_IDENTITY` | `YULU_CODESIGN_IDENTITY` | Build env var |
| `meeting-assistant.skill` | `yulu.skill` | Claude Desktop skill ZIP |

A one-shot migration script ships at `yulu/scripts/migrate_to_yulu.sh` and is auto-invoked by `setup.sh` when an old installation is detected. It:

- Unloads and removes `com.meetingassistant.*` LaunchAgents.
- Moves `~/.config/meeting-assistant/` to `~/.config/yulu/`.
- Stops any running old `audio_daemon` process.
- Prints the manual TCC re-authorization steps the user has to do in System Settings.

## 6. Post-publish

- Pin the repo on your GitHub profile.
- Announce on Twitter / X with the parchment+ink card and a 15-second demo GIF.
- Submit to:
  - [Awesome macOS](https://github.com/jaywcjlove/awesome-mac)
  - [Hacker News](https://news.ycombinator.com/submit) (Show HN)
  - [Product Hunt](https://producthunt.com) (optional — niche audience)
- Watch the first 48 hours of issues for install problems on different macOS versions and Apple Silicon vs Intel.
