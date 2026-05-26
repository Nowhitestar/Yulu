# Releasing Yulu

A release is **explicit**. CI never publishes on merge to `main` — it publishes
only when you push a `v*` git tag. The `.github/workflows/release.yml` workflow
builds the apps, runs the test gate, packages a tarball, syncs `VERSION` back
to `main`, and creates a GitHub Release.

## TL;DR

```bash
# from the repo root, on main, with a clean working tree
git pull
git tag v0.6.0
git push origin v0.6.0
# go watch https://github.com/Nowhitestar/Yulu/actions
```

That's it. ~5 minutes later a release shows up at
<https://github.com/Nowhitestar/Yulu/releases> with a tarball attached and
`VERSION` bumped on `main`.

## One-time setup (CI secrets)

The workflow signs the `.app` bundles with your Apple Developer ID so end
users don't have to right-click → Open. Set these in
**Settings → Secrets and variables → Actions → New repository secret**:

| Secret name                | What to put in it                                                    |
| -------------------------- | -------------------------------------------------------------------- |
| `MACOS_CERT_P12_BASE64`    | `base64 -i Developer_ID.p12` of your exported cert                  |
| `MACOS_CERT_PASSWORD`      | The password you set when exporting the `.p12`                       |
| `MACOS_KEYCHAIN_PASSWORD`  | Any string — used to unlock an ephemeral keychain inside the runner |
| `YULU_CODESIGN_IDENTITY`   | Your cert's Common Name, e.g. `Developer ID Application: 不白 (WMU9678ZQL)` |

To export your cert:

1. Open **Keychain Access**, find your `Developer ID Application` cert.
2. Right-click → **Export...** → format **Personal Information Exchange (.p12)**.
3. Save to `~/Developer_ID.p12`, set a password.
4. `base64 -i ~/Developer_ID.p12 | pbcopy` → paste into the secret.

If you skip these secrets the workflow still publishes a release, but the
binaries are ad-hoc signed (`codesign -s -`). End users will hit Gatekeeper
warnings on first run and have to right-click → Open the apps. Not ideal,
but the daemons still work after that one-time approval.

## Tag-naming rules

The workflow accepts:

- `v0.6.0`
- `v0.6.0-rc1`
- `v0.6.0-beta.2`

It rejects anything that doesn't match `^v\d+\.\d+\.\d+(-.+)?$`. The
release artifact is named `yulu-<version>-mac-arm64.tar.gz` (the leading `v`
is stripped — i.e. `yulu-0.6.0-mac-arm64.tar.gz`).

## What lands in the release tarball

```
yulu-0.6.0-mac-arm64/
├── README.md
├── VERSION
├── CHANGELOG.md
├── install.sh
└── yulu/
    ├── scripts/
    │   ├── Yulu.app/            (pre-built, signed)
    │   ├── StatusAgent.app/     (pre-built, signed)
    │   ├── *.py + packages      (voicemail/, prompts/, stt_daemon/, search/, ...)
    │   ├── *.plist              (launchd templates)
    │   ├── setup.sh             (the installer end users actually run)
    │   ├── yulu                 (CLI shell wrapper)
    │   └── ...
    └── spec/                    (ADRs)
```

Excluded for size + privacy: `.git`, `.github`, `.claude`, `.planning`,
`tests`, `docs/superpowers`, `__pycache__`.

## Common end-user install paths

- **Fresh machine**: `curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash`
  (still uses the git-clone path — same install script, latest main)
- **Offline / corporate**: download the release tarball, extract, run `bash yulu/scripts/setup.sh`
- **Existing install**: `yulu update`

## What CI does on tag push, step by step

1. **Parse tag** → `version` (e.g. `v0.6.0` → `0.6.0`). Reject bad shapes.
2. **Import signing identity** from secrets into a temporary keychain. If no
   secret, skip and warn — fall back to ad-hoc signing.
3. **Set up Python 3.11** + install pytest.
4. **Run full pytest gate.** Fail = no release, no commits, no tag changes.
5. **Build `Yulu.app`** (`build_audio_daemon.sh`) with the signing identity.
6. **Build `StatusAgent.app`** (`build_status_agent.sh`) similarly.
7. **Sync `VERSION` file** to the tag's version. If it differs, rebuild apps
   (their `Info.plist` reads `VERSION`), commit the bump on a side branch,
   push to `main` as `yulu-release-bot`.
8. **Package tarball** with rsync excludes.
9. **`gh release create`** — uploads the tarball, generates release notes
   from PRs/commits since the previous tag, prepends our install
   instructions block.

## Re-running a failed release

Releases are immutable once created. If a workflow run fails mid-flight:

- **Before `gh release create` ran** (build/test/sign failure): fix the
  underlying issue on main, delete the tag locally and remotely, re-tag.

  ```bash
  git tag -d v0.6.0
  git push origin :refs/tags/v0.6.0
  # fix → push → re-tag → re-push
  ```

- **After `gh release create` ran**: edit the release on GitHub UI, or
  publish v0.6.1 with the fix. Don't retroactively rewrite v0.6.0 — it may
  already be installed.

## Future: notarization

Self-signing avoids Gatekeeper's "unidentified developer" path but not its
"unable to verify" notarization prompt for downloaded binaries. To fully
notarize:

1. Add secrets `AC_USERNAME`, `AC_APP_SPECIFIC_PASSWORD`, `AC_TEAM_ID`.
2. After each `codesign` step in `release.yml`, run:
   ```bash
   xcrun notarytool submit "Yulu.app.zip" \
     --apple-id "$AC_USERNAME" --password "$AC_APP_SPECIFIC_PASSWORD" --team-id "$AC_TEAM_ID" \
     --wait
   xcrun stapler staple Yulu.app
   ```
3. Same for StatusAgent.app.

Deferred for v1 — most users running `install.sh` get the apps via `git clone`
(no quarantine bit), so notarization only matters for tarball downloads.
