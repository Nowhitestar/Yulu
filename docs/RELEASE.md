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

Feature and fix PRs use Conventional Commit titles. Do not edit `VERSION`,
`.release-please-manifest.json`, or the generated release section of
`CHANGELOG.md` in a feature PR. After changes land on `main`, release-please owns
those files and maintains the release PR:

- `feat:` produces the configured pre-1.0 minor bump;
- `fix:` produces a patch bump;
- `!` or `BREAKING CHANGE` produces a major bump.

## Package contents

The public DMG contains exactly `Yulu.app` and an `Applications` alias pointing
to `/Applications`. The App is the immutable, self-contained Application
Runtime. The DMG must not contain an installer script, repository checkout, or
writable runtime payload. Exclude from every release asset:

- `~/.config/yulu`
- `~/Movies/Yulu`
- logs, sockets, pid/state files
- transcripts, summaries, recordings
- local API keys or OAuth tokens
- `.agent/runs` outputs unless intentionally documented

## Normal release workflow

```bash
# 1. Before merging the feature/fix PR.
git status --short
make test
```

1. Merge the conventional feature/fix PR into `main`.
2. Wait for the `Release Please` workflow to create or update its release PR.
3. Review that PR's VERSION and CHANGELOG diff, wait for CI, then merge it.
4. release-please creates the tag and a **draft** GitHub Release.
5. The chained publish job checks out that tag, reruns Python/Node/Swift gates,
   signs, notarizes, staples, packages and attests the DMG, uploads all required
   assets, and verifies their remote bytes.
6. Only after all assets are present does the workflow make the Release public.

If publish fails, the Release stays draft and is not returned as latest stable.

Required assets, exactly:

- `yulu-macos-arm64-<tag>.dmg`
- `yulu-local-caption-runtime-macos-arm64-<tag>.zip` (Optional Runtime Pack;
  never an installer or DMG payload)
- `appcast.xml` (signed Sparkle feed pointing to the same DMG)
- `checksums.txt`

Tags with a prerelease suffix, such as `v0.5.0-beta.1` or `v0.5.0-dogfood`, are published as prereleases.

## Manual escape hatch

`.github/workflows/release.yml` still accepts a manually pushed `v*.*.*` tag for
an emergency. The tag must match `VERSION`; use this only when the normal
release-please path cannot operate, and never to bypass a failed release PR/CI.

## Local dry run

Build the package and checksums locally when you want a packaging dry run:

```bash
VERSION="$(cat VERSION)"
DRY_DIST="$(mktemp -d "${TMPDIR:-/tmp}/yulu-release-dry-run.XXXXXX")"
packaging/scripts/package.sh "v${VERSION}" --dist "$DRY_DIST" --skip-build
packaging/scripts/checksums.sh "$DRY_DIST" "v${VERSION}"
echo "$DRY_DIST"
```

This creates an unsigned packaging-only DMG. Developer ID signing, App and DMG
notarization/stapling, Gatekeeper checks, and Sparkle signature verification run
only in the credentialed release workflow.
