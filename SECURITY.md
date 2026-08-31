# Security Policy

## Reporting a vulnerability

If you find a security issue in Yulu, **please do not open a public GitHub issue.**

Email the maintainer directly. The address is the same one that signs the commits in this repository — find it via:

```bash
git log -1 --format='%ae'
```

Please include:

1. The component (native capture, local Host/MCP, Agent task boundary, calendar adapter, or Application Runtime).
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
- **Keep `~/Library/Application Support/Yulu/` out of cloud-synced folders** (iCloud Drive, Dropbox, Google Drive, OneDrive). It contains the Host database, task workspaces, completion-event spool, and local MCP token. `~/.config/yulu/` is only a legacy read-only migration source.
- **Protect `~/Library/Application Support/Yulu/mcp-token.json`.** It must remain mode `0600`. Run `yulu mcp rotate-token` if it is exposed.
- **Review uncertain external deliveries explicitly.** A task in `delivery_unverified` must be reconciled in Yulu; do not blindly retry a Notion write whose outcome is unknown.

## Verifying releases

Official releases contain one checksum-verified DMG with a signed, notarized,
and stapled immutable `Yulu.app`. After downloading the DMG and `checksums.txt`,
verify the actual release asset before installing:

```bash
(cd <download-directory> && \
  grep '  yulu-macos-arm64-vX.Y.Z.dmg$' checksums.txt | shasum -a 256 -c -)
gh attestation verify yulu-macos-arm64-vX.Y.Z.dmg --repo Nowhitestar/Yulu
codesign --verify --strict yulu-macos-arm64-vX.Y.Z.dmg
xcrun stapler validate yulu-macos-arm64-vX.Y.Z.dmg
spctl -a -vv -t open --context context:primary-signature yulu-macos-arm64-vX.Y.Z.dmg
hdiutil attach -readonly -nobrowse yulu-macos-arm64-vX.Y.Z.dmg
codesign --verify --deep --strict /Volumes/Yulu/Yulu.app
codesign -dv --verbose=4 /Volumes/Yulu/Yulu.app
xcrun stapler validate /Volumes/Yulu/Yulu.app
spctl -a -vv -t exec /Volumes/Yulu/Yulu.app
hdiutil detach /Volumes/Yulu
```

The signature must be a Developer ID Application identity with Team ID
`WMU9678ZQL`. The mounted volume must contain only `Yulu.app` and an
`Applications` alias resolving to `/Applications`. If verification fails, do
not run the asset; report it through the security channel above.
