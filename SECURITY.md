# Security Policy

## Reporting a vulnerability

If you find a security issue in Yulu, **please do not open a public GitHub issue.**

Email the maintainer directly. The address is the same one that signs the commits in this repository — find it via:

```bash
git log -1 --format='%ae'
```

Please include:

1. The component (native capture, local Host/MCP, Hermes task boundary, calendar adapter, or installer).
2. A minimal reproduction or proof of concept.
3. Whether the issue requires local user access, network access, or remote unauthenticated access.
4. Any disclosure timeline you would like.

I'll acknowledge within 7 days and aim to ship a fix within 30 days for high-severity issues.

## Scope

In scope:

- Code execution, privilege escalation, or sandbox escape from the bundled Swift, TypeScript, Python, or shell components.
- Mishandling of the Yulu MCP bearer token, Google calendar credentials, or Agent-owned connector credentials by Yulu code.
- Audio capture without the consent prompt firing first.
- Leakage of recordings, transcripts, or summaries to unintended sinks.

Out of scope (please do not report):

- Vulnerabilities in dependencies that are already tracked upstream (`whisper.cpp`, `gog`, `cloudflared`, `terminal-notifier`).
- Issues that require an attacker who already has full local access to your Mac.
- macOS TCC behavior — that is between you and Apple.

## Operational hygiene

These are not vulnerabilities in Yulu, but they are the failure modes I see most often:

- **Never paste `client_secret*.json` or refresh tokens into chat or commits.** If you have, revoke the OAuth client in Google Cloud Console and generate a new one. Removing the file from git history is not enough — assume it was scraped.
- **Keep `~/.config/yulu/` out of cloud-synced folders** (iCloud Drive, Dropbox, Google Drive, OneDrive). It contains the Host database, task workspaces, completion-event spool, and local MCP token.
- **Protect `~/.config/yulu/mcp-token.json`.** It must remain mode `0600`. Run `yulu mcp rotate-token` if it is exposed.
- **Review uncertain external deliveries explicitly.** A task in `delivery_unverified` must be reconciled in Yulu; do not blindly retry a Notion write whose outcome is unknown.

## Verifying releases

Official releases contain a checksum-verified runtime zip with signed, notarized,
and stapled app bundles. After downloading the zip and `checksums.txt`, verify the
actual release asset before installing:

```bash
(cd <download-directory> && shasum -a 256 -c checksums.txt)
gh attestation verify yulu-macos-arm64-vX.Y.Z.zip --repo Nowhitestar/Yulu
unzip yulu-macos-arm64-vX.Y.Z.zip -d /tmp/yulu-release-check
codesign --verify --deep --strict /tmp/yulu-release-check/yulu/yulu/scripts/Yulu.app
codesign -dv --verbose=4 /tmp/yulu-release-check/yulu/yulu/scripts/Yulu.app
xcrun stapler validate /tmp/yulu-release-check/yulu/yulu/scripts/Yulu.app
```

The signature must be a Developer ID Application identity with Team ID
`WMU9678ZQL`. Repeat the checks for `StatusAgent.app`. If verification fails, do
not run the asset; report it through the security channel above. The installer
also verifies the full non-bundle runtime against the manifest covered by
`Yulu.app`'s signature before it executes any packaged script.
