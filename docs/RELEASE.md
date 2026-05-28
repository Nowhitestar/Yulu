# Yulu Release Workflow

Yulu releases should be boring: tested, packaged, checksummed, and uploaded to GitHub.

## Preconditions

```bash
git status --short
make doctor
make test
```

Expected:

- no unreviewed dirty files
- no legacy OpenClaw Yulu processes unless the release explicitly targets migration
- Python tests pass
- Swift binaries compile
- skill manifest sanity passes

## Versioning

Use tags like:

- `v0.1.0-dogfood` for early dogfood releases
- `v0.1.0` for public installable releases
- `v0.1.1` for patch fixes

Update `CHANGELOG.md` before tagging.

## Package contents

A public package must include runtime code and setup files only. Exclude:

- `~/.config/yulu`
- `~/Movies/Yulu`
- logs, sockets, pid/state files
- transcripts, summaries, recordings
- local API keys or OAuth tokens
- `.agent/runs` outputs unless intentionally documented

## Release workflow

```bash
# 1. Update VERSION and CHANGELOG.md.
$EDITOR VERSION CHANGELOG.md

# 2. Ensure the tree is clean and tests pass.
git status --short
make test

# 3. Tag v$(VERSION) and push the tag.
VERSION="$(cat VERSION)"
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

GitHub Actions publishes the release assets after the tag is pushed.

Required assets, exactly:

- `yulu-macos-arm64-<tag>.zip`
- `install.sh`
- `checksums.txt`

Tags with a prerelease suffix, such as `v0.5.0-beta.1` or `v0.5.0-dogfood`, are published as prereleases.

## Local dry run

Build the package and checksums locally before tagging when you want a dry run:

```bash
VERSION="$(cat VERSION)"
rm -rf dist
mkdir -p dist
packaging/scripts/package.sh "v${VERSION}"
shasum -a 256 "dist/yulu-macos-arm64-v${VERSION}.zip" dist/install.sh > dist/checksums.txt
```
