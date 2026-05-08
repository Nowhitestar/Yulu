# Security Policy

## Reporting a vulnerability

If you find a security issue in Yulu, **please do not open a public GitHub issue.**

Email the maintainer directly. The address is the same one that signs the commits in this repository — find it via:

```bash
git log -1 --format='%ae'
```

Please include:

1. The component (audio daemon, transcription, calendar adapter, summary path, install script).
2. A minimal reproduction or proof of concept.
3. Whether the issue requires local user access, network access, or remote unauthenticated access.
4. Any disclosure timeline you would like.

I'll acknowledge within 7 days and aim to ship a fix within 30 days for high-severity issues.

## Scope

In scope:

- Code execution, privilege escalation, or sandbox escape from the bundled Swift / Python / shell components.
- Mishandling of credentials (Google OAuth tokens, Telegram tokens, Notion keys) by Yulu code.
- Audio capture without the consent prompt firing first.
- Leakage of recordings, transcripts, or summaries to unintended sinks.

Out of scope (please do not report):

- Vulnerabilities in dependencies that are already tracked upstream (`whisper.cpp`, `gog`, `cloudflared`, `terminal-notifier`).
- Issues that require an attacker who already has full local access to your Mac.
- macOS TCC behavior — that is between you and Apple.

## Operational hygiene

These are not vulnerabilities in Yulu, but they are the failure modes I see most often:

- **Never paste `client_secret*.json` or refresh tokens into chat or commits.** If you have, revoke the OAuth client in Google Cloud Console and generate a new one. Removing the file from git history is not enough — assume it was scraped.
- **Keep `~/.config/yulu/` out of cloud-synced folders** (iCloud Drive, Dropbox, Google Drive, OneDrive). Recordings, transcripts, and the agent queue are local-by-design.
- **Audit `agent-queue.json` periodically.** It is the only place where transcript paths are passed to an external agent. If you no longer trust that agent, clear the file.

## Verifying releases

When GitHub Releases ship a signed `Yulu.app`, verify the signature before installing:

```bash
codesign -dv --verbose=4 Yulu.app
spctl -a -t exec -vv Yulu.app
```

The expected Developer ID identity will be listed in the release notes. If `spctl` reports `rejected`, do not run the binary — open an issue instead.
