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

## RC4 public-DMG acceptance controller

The `v0.23.0-rc.4` public-DMG harness is a clean-target collector, not an
acceptance authority. Before transfer, the release controller runs
`make public-dmg-acceptance-policy` and builds the deterministic harness with
`packaging/acceptance/build_public_dmg_harness.sh`. Transfer that verified
harness, the browser-downloaded public DMG, and `checksums.txt` to a clean
macOS 14-or-newer arm64 target. macOS 13 is a deployment target, not a formal
acceptance target.

Every harness contains a manifest-bound `build-mode.txt` sentinel. A
`policy-test` harness cannot enter the formal launcher or target path, and a
formal harness cannot use policy-test tools or evidence. When the ledger is
returned, the controller rebuilds the harness from the current trusted source
in a clean temporary directory and requires the rebuilt manifest to match the
returned harness manifest exactly; a copied or locally modified collector is
therefore not accepted as release evidence.

Run the fresh or upgrade launcher on that clean target. The harness never opens,
clicks, quits, or relaunches the App and never performs logout/login. Those UI
and lifecycle steps remain explicit operator checkpoints. Its private ledger is
`0700`; every allowlisted evidence/state file is atomically written as `0600`.
The verified harness includes an arm64 `yulu-durable-sync` component, built on
the controller with a macOS 13 deployment target; it calls `fsync(2)` plus
`F_FULLFSYNC` on the temporary file before rename and on the ledger directory
after rename. The clean target does not need Node, Python, Xcode, or Command
Line Tools for this. For snapshot/rollback journeys,
preserve the ledger outside the rollback boundary (or on a second target) before
restoring. Logout does not invalidate it because it lives in the target user's
private Application Support directory. Return the whole ledger to the release
controller through a private channel without changing its modes or contents.

On the controller, use the exact returned ledger and public asset bytes:

```bash
python3 packaging/acceptance/validate_returned_public_dmg.py \
  --scenario fresh \
  --ledger /private/path/to/returned-ledger \
  --tag v0.23.0-rc.4 \
  --dmg /private/path/to/yulu-macos-arm64-v0.23.0-rc.4.dmg \
  --checksums /private/path/to/checksums.txt
```

For upgrade, add `--journey upgrade-success` or
`--journey upgrade-cancel-retry`. The controller requires the exact ledger
allowlist, `0700`/`0600` modes, completion and cross-file SHA bindings, the local
`refs/tags/v0.23.0-rc.4` commit, the public DMG/checksum bytes, bundle/signature
immutability, final restart/login and no-update observations, and committed
migration lineage. It also revalidates the bounded product semantics instead of
trusting completion labels: Core Activation artifacts and completed task,
manual test-share and production-share receipts, zero automatic sharing,
v0.22.2 database/WAL/media/config/MCP/Keychain preservation, rollback
stability with restored legacy labels/paths/socket ownership and new
post-quiesce owner generations, fresh Retry nonce/snapshot/attempt lineage, and
current Host/Capture owner generation changes across restart followed by
stability through the no-update observation. It then runs
`gh attestation verify` with that tag commit as
the required source digest and the pinned release-publish workflow as signer,
and runs the repository's
existing `verify_dmg.sh` against that same DMG SHA. The latter proves DMG and App
staples, codesign, Gatekeeper, mounted layout, and packaged runtime. The clean
target retains its own Gatekeeper evidence because it must reject dependence on
`gh`, Xcode, or Command Line Tools; the controller supplies the complementary
attestation/staple authority.

The validator returns `status: validated` and always
`formalAcceptance: false`. CI exercises only fake-tool policy contracts and
cannot claim real UI, quit/relaunch, logout/login, public-network, notarization,
or clean-machine completion. A human may make the release acceptance decision
only after private-ledger review in #170. RC-to-stable update behavior belongs to
#171; do not substitute an rc3-to-rc4 migration because rc3 has no qualifying
DMG/appcast. Keep #169's broader release guidance separate from this RC4
evidence procedure.
