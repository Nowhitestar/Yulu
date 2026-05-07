<!--
Thanks for sending a PR. Three sections, that's it.
If your change is trivial (typo, comment, single-line fix), feel free to delete sections that don't apply.
-->

## What

<!-- One paragraph: what does this PR change? -->

## Why

<!-- Why is the change worth making? Link an issue if there is one. -->

## How tested

<!--
At minimum, say what you ran. For audio/recording changes please include:
- macOS version
- whether you re-signed Yulu.app, or trusted the existing build
- a real meeting (Zoom / Tencent Meeting / Google Meet / Feishu) you tested with, OR an explicit "I only tested locally with `say` piped to system audio"
-->

## Checklist

- [ ] I read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] If I touched user-facing behavior, I updated `CHANGELOG.md` under `[Unreleased]`
- [ ] If I changed a CLI flag, env var, plist label, or bundle id, I called it out in the PR description and (if appropriate) added a `migrate_to_yulu.sh`-style migration note
- [ ] I did NOT commit any `client_secret*.json`, `token*.json`, real refresh tokens, API keys, or personal calendar IDs
