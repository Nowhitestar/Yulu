#!/bin/bash

set -euo pipefail

fail() {
    printf 'launch_public_dmg_acceptance.sh: %s\n' "$1" >&2
    exit 1
}

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)"
case "$SCRIPT_DIR/" in
    /Volumes/*) fail "formal harness delivery must not run from a mounted DMG tree" ;;
    *.app/*) fail "formal harness delivery must not run from an App bundle" ;;
esac

current="$SCRIPT_DIR"
while [[ -n "$current" ]]; do
    [[ ! -e "$current/.git" ]] || fail "formal harness delivery must not run inside a repository checkout"
    [[ "$current" == "/" ]] && break
    current="${current%/*}"
    [[ -n "$current" ]] || current="/"
done

MANIFEST="$SCRIPT_DIR/manifest.sha256"
REVISION_FILE="$SCRIPT_DIR/source-revision.txt"
BUILD_MODE_FILE="$SCRIPT_DIR/build-mode.txt"
[[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] || fail "manifest must be a regular non-symlink file"
[[ "$('/usr/bin/stat' -f %Lp "$MANIFEST")" == "644" ]] || fail "manifest permissions must be 0644"

EXPECTED_NAMES=(
    build-mode.txt
    launch_public_dmg_acceptance.sh
    observe_journey.mjs
    observe_post_commit.mjs
    observe_product.mjs
    observe_upgrade.mjs
    observe_v0_22_2_state.sh
    prepare_v0_22_2_baseline.sh
    public_dmg_target.sh
    public_dmg_upgrade_target.sh
    source-revision.txt
    yulu-durable-sync
)
for delivered in "$SCRIPT_DIR"/* "$SCRIPT_DIR"/.[!.]* "$SCRIPT_DIR"/..?*; do
    [[ -e "$delivered" || -L "$delivered" ]] || continue
    name="${delivered##*/}"
    case "$name" in
        build-mode.txt|launch_public_dmg_acceptance.sh|manifest.sha256|observe_journey.mjs|observe_post_commit.mjs|observe_product.mjs|observe_upgrade.mjs|observe_v0_22_2_state.sh|prepare_v0_22_2_baseline.sh|public_dmg_target.sh|public_dmg_upgrade_target.sh|source-revision.txt|yulu-durable-sync) ;;
        *) fail "harness file set contains an unexpected entry: $name" ;;
    esac
    [[ -f "$delivered" && ! -L "$delivered" ]] || fail "harness file set contains an unsafe entry: $name"
done

for name in "${EXPECTED_NAMES[@]}"; do
    candidate="$SCRIPT_DIR/$name"
    [[ -f "$candidate" && ! -L "$candidate" ]] || fail "harness file set is missing a safe $name"
    case "$name" in
        launch_public_dmg_acceptance.sh|observe_v0_22_2_state.sh|prepare_v0_22_2_baseline.sh|public_dmg_target.sh|public_dmg_upgrade_target.sh|yulu-durable-sync) expected_mode=755 ;;
        *) expected_mode=644 ;;
    esac
    [[ "$('/usr/bin/stat' -f %Lp "$candidate")" == "$expected_mode" ]] || \
        fail "harness file permissions are unsafe: $name"
done

row_index=0
while IFS=' ' read -r row_sha row_name row_extra || [[ -n "${row_sha:-}${row_name:-}${row_extra:-}" ]]; do
    [[ "$row_index" -lt "${#EXPECTED_NAMES[@]}" ]] || fail "manifest has extra rows"
    [[ "${row_sha:-}" =~ ^[0-9a-f]{64}$ && -z "${row_extra:-}" ]] || fail "manifest row is malformed"
    [[ "${row_name:-}" == "${EXPECTED_NAMES[$row_index]}" ]] || fail "manifest rows are missing, extra, or out of order"
    row_index=$((row_index + 1))
done < "$MANIFEST"
[[ "$row_index" -eq "${#EXPECTED_NAMES[@]}" ]] || fail "manifest is missing rows"

(cd "$SCRIPT_DIR" && /usr/bin/shasum -a 256 -c manifest.sha256 >/dev/null) || fail "harness manifest checksum verification failed"
SOURCE_REVISION=""
IFS= read -r SOURCE_REVISION < "$REVISION_FILE" || fail "source revision is empty"
[[ "$SOURCE_REVISION" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || fail "source revision is invalid"
REVISION_LINES=0
while IFS= read -r _line || [[ -n "${_line:-}" ]]; do REVISION_LINES=$((REVISION_LINES + 1)); done < "$REVISION_FILE"
[[ "$REVISION_LINES" -eq 1 ]] || fail "source revision must contain exactly one line"
BUILD_MODE=""
IFS= read -r BUILD_MODE < "$BUILD_MODE_FILE" || fail "build mode is empty"
[[ "$BUILD_MODE" == "formal" || "$BUILD_MODE" == "policy-test" ]] || fail "build mode is invalid"
BUILD_MODE_LINES=0
while IFS= read -r _line || [[ -n "${_line:-}" ]]; do BUILD_MODE_LINES=$((BUILD_MODE_LINES + 1)); done < "$BUILD_MODE_FILE"
[[ "$BUILD_MODE_LINES" -eq 1 ]] || fail "build mode must contain exactly one line"
MANIFEST_DIGEST="$(/usr/bin/shasum -a 256 "$MANIFEST")"
MANIFEST_DIGEST="${MANIFEST_DIGEST%% *}"

if [[ "${1:-}" == "--verify-only" ]]; then
    [[ "$#" -eq 1 ]] || fail "--verify-only accepts no additional arguments"
    printf '{"classification":"harness_integrity","buildMode":"%s","formalAcceptance":false,"bundleDigest":"%s","sourceRevision":"%s"}\n' \
        "$BUILD_MODE" "$MANIFEST_DIGEST" "$SOURCE_REVISION"
    exit 0
fi

POLICY_REQUESTED=0
for argument in "$@"; do [[ "$argument" == "--policy-test" ]] && POLICY_REQUESTED=1; done
if [[ "$BUILD_MODE" == "policy-test" && "$POLICY_REQUESTED" -ne 1 ]]; then
    fail "policy-test harness cannot enter a formal execution path"
fi
if [[ "$BUILD_MODE" == "formal" && "$POLICY_REQUESTED" -ne 0 ]]; then
    fail "formal harness cannot enter a policy-test execution path"
fi

export YULU_ACCEPTANCE_HARNESS_MANIFEST_SHA256="$MANIFEST_DIGEST"
export YULU_ACCEPTANCE_HARNESS_SOURCE_REVISION="$SOURCE_REVISION"
export YULU_ACCEPTANCE_HARNESS_BUILD_MODE="$BUILD_MODE"
if [[ "${1:-}" == "--prepare-v0.22.2-baseline" ]]; then
    shift
    exec "$SCRIPT_DIR/prepare_v0_22_2_baseline.sh" "$@"
fi
if [[ "${1:-}" == "--observe-v0.22.2-state" ]]; then
    shift
    exec "$SCRIPT_DIR/observe_v0_22_2_state.sh" "$@"
fi
if [[ "${1:-}" == "--run-upgrade" ]]; then
    shift
    exec "$SCRIPT_DIR/public_dmg_upgrade_target.sh" "$@"
fi
exec "$SCRIPT_DIR/public_dmg_target.sh" "$@"
