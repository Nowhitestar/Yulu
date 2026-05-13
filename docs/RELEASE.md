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

## Manual release skeleton

```bash
make test
mkdir -p dist
# package script to be implemented in a later sprint
# ./packaging/scripts/package.sh v0.1.0-dogfood
shasum -a 256 dist/* > dist/checksums.txt

git tag v0.1.0-dogfood
git push origin v0.1.0-dogfood

gh release create v0.1.0-dogfood dist/* \
  --title "v0.1.0-dogfood" \
  --notes-file CHANGELOG.md
```

## Automation target

Later sprint should add:

- `make package`
- `make release`
- GitHub Actions tag workflow
- release assets: `yulu-macos-arm64-<version>.zip`, `install.sh`, `checksums.txt`
