# Spec: Release Asset Versioning and Installer

> **Status**: Draft - pending user review
> **Date**: 2026-05-28
> **Owner**: 不白 (yxliao.lewis@gmail.com)
> **Builds on**: root `VERSION`, `yulu/scripts/version.py`, one-line `install.sh`, `yulu update`, `setup.sh --upgrade`, and `docs/RELEASE.md`
> **Replaces**: the current main-branch install/update path as the default user path. The main branch remains available only through the explicit dev channel.
> **Out of scope**: notarized `.pkg` or `.dmg`; Sparkle-style in-app updater; delta updates; auto-update background daemon; permanent version pinning; package-manager distribution through Homebrew.

---

## 1. Background

Yulu currently has a central version source (`VERSION`) and a useful `yulu version` command, but releases are still operationally loose:

- `install.sh` clones or fast-forwards `~/.yulu` from `main`.
- `yulu update` always pulls `origin main`.
- `docs/RELEASE.md` still marks packaging, checksums, and release automation as future work.
- Users cannot install a stable version by tag without manually understanding git.

This makes public installs behave like dogfood installs. A user running the headline install command can receive arbitrary main-branch code, while the project has release tags that are not actually the default install contract.

The new contract is: **regular users install GitHub Release assets; developers explicitly opt into the dev channel.**

## 2. Product Goals

1. **Stable by default**: the one-line installer installs the latest stable GitHub Release asset, not `main`.
2. **Version-selectable installs**: users can install a specific release with `--version vX.Y.Z`.
3. **Simple updates**: `yulu update` upgrades to the latest stable release by default.
4. **Explicit rollback and switching**: `yulu update --version vX.Y.Z` installs that release; `yulu update --latest` returns to latest stable.
5. **Explicit dev channel**: `--dev` is the only path that follows `main`.
6. **No hidden permanent pinning**: installing or updating to a specific version affects only that operation. The next plain `yulu update` returns to latest stable.
7. **Recoverable updates**: failed installs keep the previous working runtime and report the failed step clearly.
8. **Low duplication**: first install and CLI update share the same release resolution, download, checksum, backup, replace, setup, and rollback logic.

## 3. Non-Goals

- Permanent version locks such as `yulu pin v0.5.0`.
- Maintaining both git-tag checkout and release-asset install as equal user paths.
- Supporting release-asset installs for historical tags that have no assets. Those releases may be backfilled manually, but the installer must not silently reconstruct them from git.
- Signed or notarized installer packages. The release asset can contain ad-hoc-signed app bundles, matching today's setup flow.
- Moving user data. `~/.config/yulu`, recordings, OAuth, Keychain, TCC, and models stay outside the runtime swap.

## 4. User Commands

Default stable install:

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash
```

Install a specific stable release:

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --version v0.5.0
```

Install the dev channel:

```bash
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --dev
```

Update commands:

```bash
yulu update
yulu update --latest
yulu update --version v0.5.0
yulu update --dev
```

Semantics:

| Command | Behavior |
|---|---|
| install with no flags | download latest stable release asset |
| install `--version vX.Y.Z` | download that release asset |
| install `--dev` | clone or update `main` as a git checkout |
| `yulu update` | download latest stable release asset |
| `yulu update --latest` | same as `yulu update`, explicit for clarity |
| `yulu update --version vX.Y.Z` | install that release asset once |
| `yulu update --dev` | switch runtime to dev channel on `main` |

`--version` and `--dev` are mutually exclusive.

## 5. Release Asset Contract

Each public release tag, starting with the first release that ships this system, must attach:

```text
yulu-macos-arm64-vX.Y.Z.zip
checksums.txt
install.sh
```

`checksums.txt` contains SHA-256 lines for release assets:

```text
<sha256>  yulu-macos-arm64-vX.Y.Z.zip
<sha256>  install.sh
```

The zip expands to a single top-level `yulu/` directory containing the runtime tree:

```text
yulu/
  VERSION
  README.md
  README.zh-CN.md
  CHANGELOG.md
  LICENSE
  install.sh
  skills/yulu/SKILL.md
  yulu/SKILL.md
  yulu/scripts/...
  assets/...
```

The asset must exclude:

- `.git/`
- `.github/`
- `tests/`
- `docs/superpowers/`
- `.venv*`
- `.pytest_cache/`
- `.ci-build/`
- `dist/`
- local configs, logs, recordings, transcripts, summaries, OAuth files, API keys, and tokens

Release assets are immutable after publishing. If an asset is wrong, publish a new patch release.

## 6. Architecture

Use a shared Python helper for the real install/update logic. Shell stays thin.

```text
install.sh
  -> bootstrap macOS / git-or-python basics
  -> download release_installer.py from main into a temp dir
  -> invoke release_installer.py install --latest|--version|--dev

yulu update
  -> invoke release_installer.py update --latest|--version|--dev

yulu/scripts/release_installer.py
  -> resolve target
  -> download release asset and checksums
  -> verify SHA-256
  -> stage runtime in temp dir
  -> backup current ~/.yulu
  -> atomic replace
  -> run setup.sh fresh or --upgrade
  -> rollback on failure

packaging/scripts/package.sh
  -> produce dist/yulu-macos-arm64-vX.Y.Z.zip

packaging/scripts/checksums.sh
  -> produce dist/checksums.txt

.github/workflows/release.yml
  -> test, package, checksum, upload release assets
```

### 6.1 Why Python owns the installer logic

The risky parts are path handling, GitHub API parsing, checksum validation, temp directories, backups, atomic replacement, and rollback. Keeping them in Python avoids duplicated shell branches between `install.sh` and `yulu update`, and makes the behavior unit-testable.

Shell entrypoints remain useful because they are the public bootstrap surface, but they should not grow release-management state machines.

For fresh installs, there is no runtime yet, so `install.sh` downloads the current bootstrap helper from:

```text
https://raw.githubusercontent.com/Nowhitestar/Yulu/main/yulu/scripts/release_installer.py
```

That helper is also packaged into every release and used by `yulu update`. This keeps one implementation of release resolution, download, checksum, backup, replace, and rollback. The helper's command-line contract must stay backward-compatible once published.

## 7. Runtime State

Add a small install metadata file inside the runtime:

```text
~/.yulu/.yulu-install.json
```

Example:

```json
{
  "schema": 1,
  "source": "release",
  "version": "v0.5.0",
  "asset": "yulu-macos-arm64-v0.5.0.zip",
  "sha256": "abc123...",
  "installed_at": "2026-05-28T12:34:56Z"
}
```

Dev channel example:

```json
{
  "schema": 1,
  "source": "dev",
  "branch": "main",
  "commit": "abc1234",
  "installed_at": "2026-05-28T12:34:56Z"
}
```

`yulu version --json` should include these fields when present. The human output can remain compact, for example:

```text
Yulu 0.5.0 (release v0.5.0, abc1234)
Yulu 0.5.0-dev (dev main abc1234, dirty)
```

## 8. Install and Update Flow

### 8.1 Release install/update

1. Resolve target:
   - latest stable: `GET /repos/Nowhitestar/Yulu/releases/latest`
   - specific version: `GET /repos/Nowhitestar/Yulu/releases/tags/vX.Y.Z`
2. Select asset named `yulu-macos-arm64-<tag>.zip`.
3. Download `checksums.txt`.
4. Verify the asset checksum before extracting.
5. Extract into a temp staging directory.
6. Validate staged layout:
   - `VERSION` exists and matches release tag without the leading `v`.
   - `yulu/scripts/setup.sh` exists.
   - `yulu/scripts/yulu` exists.
   - `yulu/scripts/version.py --check` passes.
7. Move current `~/.yulu` to a timestamped backup.
8. Move staged runtime into `~/.yulu`.
9. Write `.yulu-install.json`.
10. Run setup:
    - fresh install: `bash ~/.yulu/yulu/scripts/setup.sh`
    - existing install/update: `bash ~/.yulu/yulu/scripts/setup.sh --upgrade`
11. If any step after backup fails, restore the backup and report the failed step.

### 8.2 Dev install/update

The dev channel is intentionally separate:

1. Clone or update `https://github.com/Nowhitestar/Yulu.git`.
2. Checkout `main`.
3. Pull fast-forward only.
4. Write `.yulu-install.json` with `source=dev`.
5. Run setup fresh or `--upgrade`.

The dev path may use git; the release path must not.

## 9. Error Handling

Errors should be specific and actionable:

| Failure | User-facing behavior |
|---|---|
| No network | "Could not reach GitHub releases. Existing install left unchanged." |
| Version missing | "Release vX.Y.Z was not found." |
| Asset missing | "Release vX.Y.Z does not provide yulu-macos-arm64-vX.Y.Z.zip. It may predate asset-based installs." |
| Checksum mismatch | abort before touching current runtime |
| Invalid staged layout | abort before touching current runtime |
| Existing runtime has user changes | release installs ignore git state because runtime is not user source; dev installs require clean git checkout |
| Setup fails after replacement | restore previous runtime and print backup/restore details |
| Rollback fails | leave backup path visible and print manual restore command |

The installer must never delete user data directories:

- `~/.config/yulu`
- recording directory from config, usually `~/Movies/Yulu`
- `~/.config/gcp`
- Keychain entries
- macOS TCC records

## 10. Release Automation

Add `.github/workflows/release.yml`.

Trigger:

```yaml
on:
  push:
    tags:
      - "v*"
```

Job outline:

1. Checkout tag.
2. Run existing checks:
   - bash syntax
   - Python compile
   - pytest
   - version sanity
   - Swift build
   - skill manifest sanity
3. Verify `VERSION` matches the pushed tag without leading `v`.
4. Run `packaging/scripts/package.sh "$GITHUB_REF_NAME"`.
5. Run `packaging/scripts/checksums.sh`.
6. Upload assets to the GitHub Release for that tag.

The workflow creates the GitHub Release if it does not already exist, then uploads or replaces assets for that tag. A tag cannot produce assets if tests or version sync fail.

## 11. Packaging Rules

`packaging/scripts/package.sh vX.Y.Z` should:

1. Refuse invalid semver tags.
2. Refuse if `VERSION` does not equal `X.Y.Z`.
3. Build native helpers needed by the runtime when appropriate:
   - `Yulu.app`
   - `StatusAgent.app`
   - Swift helper binaries
4. Stage files through an allowlist or explicit exclude list.
5. Zip the staged `yulu/` directory.
6. Print the asset path.

Prefer explicit includes for high-risk areas. In particular, never package user data or local machine state.

## 12. Documentation Changes

Update:

- `README.md`
- `README.zh-CN.md`
- `docs/RELEASE.md`
- `CHANGELOG.md`
- CLI help in `yulu/scripts/yulu`

The docs should say:

- default install is latest stable release asset
- `--version` installs a specific release once
- `yulu update` returns to latest stable
- `--dev` follows main and is not the recommended user path
- releases before the asset system may not be installable by `--version` unless assets are backfilled

## 13. Testing Plan

Unit tests:

- release target parsing: latest, version, dev, invalid combinations
- GitHub release JSON asset selection
- checksum parsing and verification
- staged layout validation
- install metadata read/write
- rollback behavior with injected failures
- `VERSION` and tag sync validation

Script tests:

- `bash -n install.sh`
- `bash -n packaging/scripts/package.sh`
- `bash -n packaging/scripts/checksums.sh`
- package excludes `.git`, tests, local configs, recordings, logs, tokens

Integration smoke tests:

- package current checkout into `dist/`
- install from a local fake release directory into a temp `YULU_INSTALL_DIR`
- update from one fake release to another
- force setup failure and verify rollback
- run `yulu version --json` from staged runtime and assert install metadata is visible

CI:

- existing CI continues to run for pushes and PRs
- release workflow runs only on tags
- release workflow must fail if `VERSION` and tag drift

## 14. Decisions

Resolved:

- Default path is latest stable release asset.
- `--version` affects only the current install/update operation.
- `yulu update` defaults to latest stable.
- `yulu update --version` supports rollback or explicit switching.
- `--dev` keeps the main-branch workflow for developers.
- Shared Python helper owns release install/update logic.
- Fresh `install.sh` downloads the shared helper from `main` into a temp dir before invoking it.
- Release workflow automatically creates the GitHub Release for a pushed tag if it does not already exist.
