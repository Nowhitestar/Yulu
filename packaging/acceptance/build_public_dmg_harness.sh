#!/bin/bash

set -euo pipefail
umask 077

fail() {
    printf 'build_public_dmg_harness.sh: %s\n' "$1" >&2
    exit 1
}

POLICY_TEST=0
OUTPUT=""
SOURCE_REVISION=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --policy-test) POLICY_TEST=1; shift ;;
        --output) OUTPUT="${2:-}"; shift 2 ;;
        --source-revision) SOURCE_REVISION="${2:-}"; shift 2 ;;
        *) fail "unknown argument: $1" ;;
    esac
done

[[ "$OUTPUT" == /* ]] || fail "output must be an absolute path"
[[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] || fail "output already exists"
OUTPUT_PARENT="${OUTPUT%/*}"
[[ -d "$OUTPUT_PARENT" && ! -L "$OUTPUT_PARENT" ]] || fail "output parent must be an existing real directory"
OUTPUT_PARENT="$(cd "$OUTPUT_PARENT" && pwd -P)"
OUTPUT="$OUTPUT_PARENT/${OUTPUT##*/}"
case "$OUTPUT/" in
    /Volumes/*) fail "delivery output must not be inside a mounted DMG tree" ;;
    *.app/*) fail "delivery output must not be inside an App bundle" ;;
esac
current="$OUTPUT_PARENT"
while [[ -n "$current" ]]; do
    [[ ! -e "$current/.git" ]] || fail "delivery output must not be inside a repository checkout"
    [[ "$current" == "/" ]] && break
    current="${current%/*}"
    [[ -n "$current" ]] || current="/"
done

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
if [[ "$POLICY_TEST" -eq 1 ]]; then
    [[ "$SOURCE_REVISION" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || \
        fail "policy-test requires an explicit resolvable source revision fixture"
else
    [[ -z "$SOURCE_REVISION" ]] || fail "formal build cannot override source revision"
    [[ -x /usr/bin/git ]] || fail "git is required to resolve formal source revision"
    SOURCE_REVISION="$(/usr/bin/git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)"
    [[ "$SOURCE_REVISION" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || fail "source revision is unresolvable"
    SOURCE_STATUS="$(/usr/bin/git -C "$REPO_ROOT" status --porcelain --untracked-files=all)"
    [[ -z "$SOURCE_STATUS" ]] || fail "source worktree is dirty; formal harness build requires a clean revision"
fi

for source_name in launch_public_dmg_acceptance.sh observe_journey.mjs observe_post_commit.mjs observe_product.mjs observe_upgrade.mjs observe_v0_22_2_state.sh prepare_v0_22_2_baseline.sh public_dmg_target.sh public_dmg_upgrade_target.sh yulu_durable_sync.c; do
    [[ -f "$SCRIPT_DIR/$source_name" && ! -L "$SCRIPT_DIR/$source_name" ]] || fail "required harness source is missing: $source_name"
done

STAGING="$(/usr/bin/mktemp -d "$OUTPUT_PARENT/.yulu-public-dmg-harness.XXXXXX")" || fail "could not create staging directory"
cleanup() {
    if [[ -n "${STAGING:-}" && -d "$STAGING" ]]; then /bin/rm -rf "$STAGING"; fi
}
trap cleanup EXIT

/bin/cp "$SCRIPT_DIR/launch_public_dmg_acceptance.sh" "$STAGING/launch_public_dmg_acceptance.sh"
/bin/cp "$SCRIPT_DIR/observe_journey.mjs" "$STAGING/observe_journey.mjs"
/bin/cp "$SCRIPT_DIR/observe_post_commit.mjs" "$STAGING/observe_post_commit.mjs"
/bin/cp "$SCRIPT_DIR/observe_product.mjs" "$STAGING/observe_product.mjs"
/bin/cp "$SCRIPT_DIR/observe_upgrade.mjs" "$STAGING/observe_upgrade.mjs"
/bin/cp "$SCRIPT_DIR/observe_v0_22_2_state.sh" "$STAGING/observe_v0_22_2_state.sh"
/bin/cp "$SCRIPT_DIR/prepare_v0_22_2_baseline.sh" "$STAGING/prepare_v0_22_2_baseline.sh"
/bin/cp "$SCRIPT_DIR/public_dmg_target.sh" "$STAGING/public_dmg_target.sh"
/bin/cp "$SCRIPT_DIR/public_dmg_upgrade_target.sh" "$STAGING/public_dmg_upgrade_target.sh"
if [[ "$POLICY_TEST" -eq 1 ]]; then BUILD_MODE="policy-test"; else BUILD_MODE="formal"; fi
printf '%s\n' "$BUILD_MODE" > "$STAGING/build-mode.txt"
SYNC_DEFINES=()
if [[ "$POLICY_TEST" -eq 1 ]]; then SYNC_DEFINES=(-DYULU_DURABLE_SYNC_POLICY_LOG=1); fi
/usr/bin/xcrun --sdk macosx clang \
    -arch arm64 -mmacosx-version-min=13.0 -Os -std=c11 -Wall -Wextra -Werror \
    "${SYNC_DEFINES[@]}" \
    -o "$STAGING/yulu-durable-sync" "$SCRIPT_DIR/yulu_durable_sync.c" || \
    fail "could not build the arm64 durable-sync harness component"
[[ "$(/usr/bin/lipo -archs "$STAGING/yulu-durable-sync")" == "arm64" ]] || \
    fail "durable-sync harness component is not arm64-only"
"$STAGING/yulu-durable-sync" "$STAGING/yulu-durable-sync" || \
    fail "durable-sync harness component could not sync an owned file"
"$STAGING/yulu-durable-sync" "$STAGING" || \
    fail "durable-sync harness component could not sync an owned directory"
printf '%s\n' "$SOURCE_REVISION" > "$STAGING/source-revision.txt"
/bin/chmod 755 \
    "$STAGING/launch_public_dmg_acceptance.sh" \
    "$STAGING/observe_v0_22_2_state.sh" \
    "$STAGING/prepare_v0_22_2_baseline.sh" \
    "$STAGING/public_dmg_target.sh" \
    "$STAGING/public_dmg_upgrade_target.sh" \
    "$STAGING/yulu-durable-sync"
/bin/chmod 644 "$STAGING/build-mode.txt" "$STAGING/observe_journey.mjs" "$STAGING/observe_post_commit.mjs" "$STAGING/observe_product.mjs" "$STAGING/observe_upgrade.mjs" "$STAGING/source-revision.txt"

MANIFEST="$STAGING/manifest.sha256"
: > "$MANIFEST"
for delivered_name in \
    build-mode.txt launch_public_dmg_acceptance.sh observe_journey.mjs observe_post_commit.mjs observe_product.mjs observe_upgrade.mjs \
    observe_v0_22_2_state.sh prepare_v0_22_2_baseline.sh public_dmg_target.sh \
    public_dmg_upgrade_target.sh source-revision.txt yulu-durable-sync; do
    digest="$(/usr/bin/shasum -a 256 "$STAGING/$delivered_name")"
    digest="${digest%% *}"
    printf '%s  %s\n' "$digest" "$delivered_name" >> "$MANIFEST"
done
/bin/chmod 644 "$MANIFEST"
BUNDLE_DIGEST="$(/usr/bin/shasum -a 256 "$MANIFEST")"
BUNDLE_DIGEST="${BUNDLE_DIGEST%% *}"

/bin/mv "$STAGING" "$OUTPUT"
STAGING=""
if [[ "$POLICY_TEST" -eq 1 ]]; then classification=harness_policy_test; else classification=controller_build; fi
printf '{"classification":"%s","buildMode":"%s","formalAcceptance":false,"bundleDigest":"%s","sourceRevision":"%s"}\n' \
    "$classification" "$BUILD_MODE" "$BUNDLE_DIGEST" "$SOURCE_REVISION"
