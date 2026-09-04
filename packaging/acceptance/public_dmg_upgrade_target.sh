#!/bin/bash

set -euo pipefail
umask 077
export LC_ALL=C

fail() {
    printf 'public_dmg_upgrade_target.sh: %s\n' "$1" >&2
    exit 1
}

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)"
LAUNCHER="$SCRIPT_DIR/launch_public_dmg_acceptance.sh"
[[ -f "$LAUNCHER" && ! -L "$LAUNCHER" ]] || fail "harness integrity launcher is missing"
/bin/bash "$LAUNCHER" --verify-only >/dev/null || fail "harness integrity verification failed"
MANIFEST_SHA256="$(/usr/bin/shasum -a 256 "$SCRIPT_DIR/manifest.sha256")"
MANIFEST_SHA256="${MANIFEST_SHA256%% *}"
[[ -n "${YULU_ACCEPTANCE_HARNESS_MANIFEST_SHA256:-}" &&
   "$YULU_ACCEPTANCE_HARNESS_MANIFEST_SHA256" == "$MANIFEST_SHA256" ]] ||
    fail "upgrade target must be dispatched by the verified harness launcher"

POLICY_TEST=0
JOURNEY=""
RUN_ID=""
RELEASE_TAG=""
MIGRATION_BEFORE=""
CURRENT_PREFLIGHT=""
BUNDLE_EVIDENCE=""
EVIDENCE_DIR=""
INSTALLED_NODE=""
JOURNAL=""
TARGET_HOME=""
APPLICATIONS_ROOT=""
SYSTEM_BIN=""
JOURNEY_BASE_URL=""
MOUNTED_APP=""
CODESIGN_TOOL=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --policy-test) POLICY_TEST=1; shift ;;
        --journey) JOURNEY="${2:-}"; shift 2 ;;
        --run-id) RUN_ID="${2:-}"; shift 2 ;;
        --release-tag) RELEASE_TAG="${2:-}"; shift 2 ;;
        --migration-before) MIGRATION_BEFORE="${2:-}"; shift 2 ;;
        --current-preflight) CURRENT_PREFLIGHT="${2:-}"; shift 2 ;;
        --bundle-evidence) BUNDLE_EVIDENCE="${2:-}"; shift 2 ;;
        --evidence-dir) EVIDENCE_DIR="${2:-}"; shift 2 ;;
        --installed-node) INSTALLED_NODE="${2:-}"; shift 2 ;;
        --journal) JOURNAL="${2:-}"; shift 2 ;;
        --home) TARGET_HOME="${2:-}"; shift 2 ;;
        --applications-root) APPLICATIONS_ROOT="${2:-}"; shift 2 ;;
        --system-bin) SYSTEM_BIN="${2:-}"; shift 2 ;;
        --journey-base-url) JOURNEY_BASE_URL="${2:-}"; shift 2 ;;
        --mounted-app) MOUNTED_APP="${2:-}"; shift 2 ;;
        --codesign) CODESIGN_TOOL="${2:-}"; shift 2 ;;
        *) fail "unknown argument: $1" ;;
    esac
done

HARNESS_BUILD_MODE=""
IFS= read -r HARNESS_BUILD_MODE < "$SCRIPT_DIR/build-mode.txt" || fail "harness build mode is unreadable"
if [[ "$POLICY_TEST" -eq 1 ]]; then EXPECTED_BUILD_MODE="policy-test"; else EXPECTED_BUILD_MODE="formal"; fi
[[ "$HARNESS_BUILD_MODE" == "$EXPECTED_BUILD_MODE" ]] || fail "harness build mode does not match the upgrade execution path"
if [[ -n "${YULU_ACCEPTANCE_HARNESS_BUILD_MODE:-}" && "$YULU_ACCEPTANCE_HARNESS_BUILD_MODE" != "$HARNESS_BUILD_MODE" ]]; then
    fail "launcher and upgrade target disagree on harness build mode"
fi

[[ "$JOURNEY" == "upgrade-success" || "$JOURNEY" == "upgrade-cancel-retry" ]] || fail "upgrade journey is invalid"
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail "run-id contains unsafe characters"
[[ "$RELEASE_TAG" == "v0.23.0-rc.9" ]] || fail "upgrade acceptance is pinned to v0.23.0-rc.9"
for input in "$MIGRATION_BEFORE" "$CURRENT_PREFLIGHT" "$BUNDLE_EVIDENCE"; do
    [[ "$input" == /* && -f "$input" && ! -L "$input" ]] || fail "bound input must be an absolute regular non-symlink file"
done

if [[ "$POLICY_TEST" -eq 1 ]]; then
    for input in "$EVIDENCE_DIR" "$INSTALLED_NODE" "$JOURNAL" "$TARGET_HOME" "$APPLICATIONS_ROOT" "$SYSTEM_BIN" "$MOUNTED_APP" "$CODESIGN_TOOL"; do
        [[ "$input" == /* ]] || fail "policy-test paths must be absolute"
    done
    [[ "$JOURNEY_BASE_URL" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || fail "policy-test journey origin must be explicit loopback"
    CLASSIFICATION="upgrade_acceptance_policy_test"
else
    [[ "$MOUNTED_APP" == /* && -d "$MOUNTED_APP" && ! -L "$MOUNTED_APP" ]] || fail "formal mounted App binding is invalid"
    [[ -z "$EVIDENCE_DIR$INSTALLED_NODE$JOURNAL$TARGET_HOME$APPLICATIONS_ROOT$SYSTEM_BIN$JOURNEY_BASE_URL$CODESIGN_TOOL" ]] ||
        fail "formal upgrade system paths cannot be overridden"
    TARGET_HOME="${HOME:?HOME is required}"
    APPLICATIONS_ROOT="/Applications"
    EVIDENCE_DIR="$TARGET_HOME/Library/Application Support/Yulu Acceptance"
    INSTALLED_NODE="/Applications/Yulu.app/Contents/Resources/runtime/bin/node"
    JOURNAL="$TARGET_HOME/Library/Application Support/Yulu/application-migration/journal.json"
    SYSTEM_BIN="/"
    CODESIGN_TOOL="/usr/bin/codesign"
    CLASSIFICATION="formal_upgrade_acceptance_state_machine"
fi
DURABLE_SYNC="$SCRIPT_DIR/yulu-durable-sync"
[[ -f "$DURABLE_SYNC" && ! -L "$DURABLE_SYNC" && -x "$DURABLE_SYNC" ]] || fail "verified durable-sync harness component is unavailable"
[[ -x "$INSTALLED_NODE" && ! -L "$INSTALLED_NODE" ]] || fail "installed Application Runtime Node is missing"

reject_symlink_components() {
    local remaining="${1#/}" current="" component
    while [[ -n "$remaining" ]]; do
        if [[ "$remaining" == */* ]]; then component="${remaining%%/*}"; remaining="${remaining#*/}"; else component="$remaining"; remaining=""; fi
        [[ -n "$component" ]] || continue
        current="$current/$component"
        [[ ! -L "$current" ]] || fail "evidence path contains a symlink component"
    done
}

for bound_path in "$MIGRATION_BEFORE" "$CURRENT_PREFLIGHT" "$BUNDLE_EVIDENCE" "$JOURNAL" "$INSTALLED_NODE"; do
    reject_symlink_components "$bound_path"
done
reject_symlink_components "$EVIDENCE_DIR"
if [[ ! -e "$EVIDENCE_DIR" ]]; then /bin/mkdir -p "$EVIDENCE_DIR"; fi
[[ -d "$EVIDENCE_DIR" && ! -L "$EVIDENCE_DIR" && -O "$EVIDENCE_DIR" ]] || fail "evidence root is unsafe"
/bin/chmod 700 "$EVIDENCE_DIR"
LEDGER="$EVIDENCE_DIR/$RUN_ID"
if [[ ! -e "$LEDGER" ]]; then /bin/mkdir -m 700 "$LEDGER"; fi
[[ -d "$LEDGER" && ! -L "$LEDGER" && -O "$LEDGER" && "$(/usr/bin/stat -f %Lp "$LEDGER")" == "700" ]] || fail "upgrade ledger is unsafe"

allowed_node() {
    case "$1" in
        state|preflight.json|mount.json|bundle-observation.json|bundle-restart-login.json|bundle-no-update.json|upgrade.state|upgrade-awaiting-approval.json|upgrade-committed.json|upgrade-committed-restart-login.json|upgrade-committed-no-update.json|upgrade-rolled-back.json|upgrade-rolled-back-stable.json|upgrade-retry-awaiting-approval.json|upgrade-journey.json|upgrade-journey-restart-login.json|upgrade-journey-no-update.json|post-commit-baseline.json|post-commit-restart-login.json|check-for-updates-no-update.json) return 0 ;;
    esac
    return 1
}
for node in "$LEDGER"/* "$LEDGER"/.[!.]* "$LEDGER"/..?*; do
    [[ -e "$node" || -L "$node" ]] || continue
    allowed_node "${node##*/}" || fail "upgrade ledger contains an unexpected node"
    [[ -f "$node" && ! -L "$node" && -O "$node" && "$(/usr/bin/stat -f %Lp "$node")" == "600" ]] ||
        fail "upgrade ledger file is unsafe"
done

hash_file() {
    local digest
    digest="$(/usr/bin/shasum -a 256 "$1")"
    printf '%s' "${digest%% *}"
}

hash_text() {
    local digest
    digest="$(printf '%s' "$1" | /usr/bin/shasum -a 256)"
    printf '%s' "${digest%% *}"
}

write_file() {
    local destination="$1" content="$2" temporary
    temporary="$(/usr/bin/mktemp "$LEDGER/.${destination##*/}.XXXXXX")" || fail "could not create private evidence temporary"
    [[ -f "$temporary" && ! -L "$temporary" && -O "$temporary" ]] || fail "evidence temporary is unsafe"
    printf '%s\n' "$content" > "$temporary"
    /bin/chmod 600 "$temporary"
    "$DURABLE_SYNC" "$temporary"
    /bin/mv -f "$temporary" "$destination"
    "$DURABLE_SYNC" "$LEDGER"
}

publish_evidence_file() {
    local temporary="$1" destination="$2"
    "$DURABLE_SYNC" "$temporary"
    /bin/mv -f "$temporary" "$destination"
    "$DURABLE_SYNC" "$LEDGER"
}

BEFORE_SHA256="$(hash_file "$MIGRATION_BEFORE")"
PREFLIGHT_SHA256="$(hash_file "$CURRENT_PREFLIGHT")"
BUNDLE_SHA256="$(hash_file "$BUNDLE_EVIDENCE")"
PREFLIGHT_MANIFEST_SHA256="$(/usr/bin/plutil -extract harnessManifestSha256 raw -o - "$CURRENT_PREFLIGHT" 2>/dev/null || true)"
PREFLIGHT_SOURCE_REVISION="$(/usr/bin/plutil -extract sourceRevision raw -o - "$CURRENT_PREFLIGHT" 2>/dev/null || true)"
SOURCE_REVISION=""
IFS= read -r SOURCE_REVISION < "$SCRIPT_DIR/source-revision.txt" || fail "harness source revision is unreadable"
[[ "$PREFLIGHT_MANIFEST_SHA256" == "$MANIFEST_SHA256" && "$PREFLIGHT_SOURCE_REVISION" == "$SOURCE_REVISION" ]] ||
    fail "current public-DMG preflight is not bound to this verified harness delivery"
STATE_FILE="$LEDGER/upgrade.state"
PHASE=""
SNAPSHOT_WITNESS_SHA256=""
if [[ -f "$STATE_FILE" ]]; then
    state_schema="" state_journey="" state_tag="" state_before="" state_preflight="" state_bundle="" state_snapshot="" state_phase="" state_lines=0
    while IFS='=' read -r key value || [[ -n "${key:-}${value:-}" ]]; do
        state_lines=$((state_lines + 1))
        case "$key" in
            schema) state_schema="$value" ;;
            journey) state_journey="$value" ;;
            release_tag) state_tag="$value" ;;
            migration_before_sha256) state_before="$value" ;;
            current_preflight_sha256) state_preflight="$value" ;;
            bundle_evidence_sha256) state_bundle="$value" ;;
            operator_snapshot_witness_sha256) state_snapshot="$value" ;;
            phase) state_phase="$value" ;;
            *) fail "upgrade resume state contains an unknown field" ;;
        esac
    done < "$STATE_FILE"
    [[ "$state_lines" -eq 8 && "$state_schema" == "1" && "$state_journey" == "$JOURNEY" &&
       "$state_tag" == "$RELEASE_TAG" && "$state_before" == "$BEFORE_SHA256" &&
       "$state_preflight" == "$PREFLIGHT_SHA256" && "$state_bundle" == "$BUNDLE_SHA256" &&
       "$state_snapshot" =~ ^[0-9a-f]{64}$ ]] || fail "upgrade resume binding drifted"
    case "$state_phase" in
        awaiting_launch|awaiting_approval|awaiting_cancel|awaiting_stability_witness|awaiting_retry|retry_awaiting_approval|awaiting_post_commit_baseline|awaiting_restart_login|awaiting_no_update|completed) ;;
        *) fail "upgrade resume phase is invalid" ;;
    esac
    SNAPSHOT_WITNESS_SHA256="$state_snapshot"
    PHASE="$state_phase"
fi

write_state() {
    local phase="$1" content
    printf -v content 'schema=1\njourney=%s\nrelease_tag=%s\nmigration_before_sha256=%s\ncurrent_preflight_sha256=%s\nbundle_evidence_sha256=%s\noperator_snapshot_witness_sha256=%s\nphase=%s' \
        "$JOURNEY" "$RELEASE_TAG" "$BEFORE_SHA256" "$PREFLIGHT_SHA256" "$BUNDLE_SHA256" "$SNAPSHOT_WITNESS_SHA256" "$phase"
    write_file "$STATE_FILE" "$content"
    PHASE="$phase"
}

if [[ -z "$PHASE" ]]; then
    printf 'ACTION_REQUIRED snapshot-witness token=I-BOUND-V022-SNAPSHOT\n'
    printf '%s\n' 'Enter a non-secret machine/VM/APFS snapshot witness identifier for the verified v0.22.2 baseline, then the exact token. The harness does not create or restore snapshots. Preserve/export this ledger outside a rollback boundary, or use a second target restored from the same baseline.'
    SNAPSHOT_WITNESS=""
    CONFIRMATION=""
    IFS= read -r SNAPSHOT_WITNESS || fail "operator snapshot witness is required"
    IFS= read -r CONFIRMATION || fail "operator snapshot confirmation is required"
    [[ -n "$SNAPSHOT_WITNESS" && "${#SNAPSHOT_WITNESS}" -le 256 && "$SNAPSHOT_WITNESS" != *$'\n'* ]] || fail "operator snapshot witness is invalid"
    [[ "$CONFIRMATION" == "I-BOUND-V022-SNAPSHOT" ]] || fail "operator snapshot confirmation token did not match"
    SNAPSHOT_WITNESS_SHA256="$(hash_text "$SNAPSHOT_WITNESS")"
    unset SNAPSHOT_WITNESS
    write_state "awaiting_launch"
fi

OBSERVER="$SCRIPT_DIR/observe_upgrade.mjs"
JOURNEY_OBSERVER="$SCRIPT_DIR/observe_journey.mjs"
[[ -f "$OBSERVER" && ! -L "$OBSERVER" && -f "$JOURNEY_OBSERVER" && ! -L "$JOURNEY_OBSERVER" ]] || fail "read-only upgrade observer is missing"

observe_upgrade() {
    local mode="$1" destination="$2" prior="${3:-}" temporary
    local arguments=(
        --mode "$mode" --release-tag "$RELEASE_TAG"
        --before "$MIGRATION_BEFORE" --current-preflight "$CURRENT_PREFLIGHT"
        --bundle-evidence "$BUNDLE_EVIDENCE" --journal "$JOURNAL"
        --snapshot-witness-sha256 "$SNAPSHOT_WITNESS_SHA256"
    )
    [[ -z "$prior" ]] || arguments+=(--prior-evidence "$prior")
    case "$mode" in
        committed) arguments+=(--external-destination-no-run-marker-confirmed) ;;
        rolled_back|rolled_back_stable) arguments+=(--smappservice-not-registered-confirmed) ;;
    esac
    if [[ "$POLICY_TEST" -eq 1 ]]; then
        arguments=(--policy-test --home "$TARGET_HOME" --applications-root "$APPLICATIONS_ROOT" --system-bin "$SYSTEM_BIN" "${arguments[@]}")
    fi
    temporary="$(/usr/bin/mktemp "$LEDGER/.${destination}.XXXXXX")" || fail "could not create upgrade observation temporary"
    "$INSTALLED_NODE" "$OBSERVER" "${arguments[@]}" > "$temporary" || fail "$mode read-only upgrade observation failed"
    /bin/chmod 600 "$temporary"
    publish_evidence_file "$temporary" "$LEDGER/$destination"
}

observe_bundle_checkpoint() {
    local destination="$1" temporary arguments
    arguments=(
        --mounted "$MOUNTED_APP" --installed "$APPLICATIONS_ROOT/Yulu.app"
        --codesign "$CODESIGN_TOOL" --baseline-evidence "$BUNDLE_EVIDENCE"
    )
    if [[ "$POLICY_TEST" -eq 1 ]]; then arguments=(--policy-test "${arguments[@]}"); fi
    temporary="$(/usr/bin/mktemp "$LEDGER/.${destination}.XXXXXX")" || fail "could not create bundle checkpoint temporary"
    "$INSTALLED_NODE" "$SCRIPT_DIR/observe_product.mjs" "${arguments[@]}" > "$temporary" || \
        fail "post-commit bundle checkpoint failed"
    /bin/chmod 600 "$temporary"
    publish_evidence_file "$temporary" "$LEDGER/$destination"
}

observe_upgrade_journey() {
    local destination="$1" temporary arguments=(--mode upgrade-post --release-tag "$RELEASE_TAG" --binding-evidence "$MIGRATION_BEFORE")
    if [[ "$POLICY_TEST" -eq 1 ]]; then arguments=(--policy-test --base-url "$JOURNEY_BASE_URL" "${arguments[@]}"); fi
    temporary="$(/usr/bin/mktemp "$LEDGER/.${destination}.XXXXXX")" || fail "could not create journey evidence temporary"
    "$INSTALLED_NODE" "$JOURNEY_OBSERVER" "${arguments[@]}" > "$temporary" || \
        fail "returning-user onboarding/share observation failed"
    /bin/chmod 600 "$temporary"
    publish_evidence_file "$temporary" "$LEDGER/$destination"
}

observe_post_commit() {
    local checkpoint="$1" destination="$2" bundle="$3" journey="$4" upgrade="$5" prior="${6:-}" temporary
    local arguments=(
        --checkpoint "$checkpoint" --scenario upgrade --release-tag "$RELEASE_TAG"
        --preflight "$CURRENT_PREFLIGHT" --bundle "$LEDGER/$bundle" --journey "$LEDGER/$journey"
        --upgrade-evidence "$LEDGER/$upgrade"
    )
    [[ -z "$prior" ]] || arguments+=(--prior-evidence "$LEDGER/$prior")
    case "$checkpoint" in
        post-commit-restart-login) arguments+=(--operator-restart-login-confirmed) ;;
        check-for-updates-no-update) arguments+=(--operator-no-update-confirmed) ;;
    esac
    if [[ "$POLICY_TEST" -eq 1 ]]; then
        arguments=(
            --policy-test --installed-app "$APPLICATIONS_ROOT/Yulu.app" --home "$TARGET_HOME"
            --applications-root "$APPLICATIONS_ROOT" --system-bin "$SYSTEM_BIN" "${arguments[@]}"
        )
    fi
    temporary="$(/usr/bin/mktemp "$LEDGER/.${destination}.XXXXXX")" || fail "could not create post-commit temporary"
    "$INSTALLED_NODE" "$SCRIPT_DIR/observe_post_commit.mjs" "${arguments[@]}" > "$temporary" || \
        fail "$checkpoint machine observation failed"
    /bin/chmod 600 "$temporary"
    publish_evidence_file "$temporary" "$LEDGER/$destination"
}

prompt_token() {
    local checkpoint="$1" token="$2" guidance="$3" confirmation=""
    printf 'ACTION_REQUIRED %s token=%s\n' "$checkpoint" "$token"
    printf '%s\n' "$guidance"
    IFS= read -r confirmation || fail "operator checkpoint confirmation is required"
    [[ "$confirmation" == "$token" ]] || fail "operator checkpoint token did not match"
}

if [[ "$PHASE" == "awaiting_launch" ]]; then
    prompt_token \
        "upgrade-awaiting-approval" \
        "I-SAW-MIGRATION-AWAITING-APPROVAL" \
        "Launch /Applications/Yulu.app yourself. Do not approve its background items yet. Wait until Yulu shows Background approval is required and App Components shows the current services awaiting approval. Do not invoke any CLI migration helper."
    observe_upgrade "awaiting_approval" "upgrade-awaiting-approval.json"
    if [[ "$JOURNEY" == "upgrade-success" ]]; then write_state "awaiting_approval"; else write_state "awaiting_cancel"; fi
fi

if [[ "$JOURNEY" == "upgrade-cancel-retry" && "$PHASE" == "awaiting_cancel" ]]; then
    prompt_token \
        "upgrade-cancel" \
        "I-CANCELLED-MIGRATION-IN-APP" \
        "In Yulu choose Components > Cancel Service Migration, wait for Migration was cancelled, and verify App Components reports both current SMAppService owners not registered. The harness will not click the UI or invoke the migration implementation."
    observe_upgrade "rolled_back" "upgrade-rolled-back.json"
    write_state "awaiting_stability_witness"
fi

if [[ "$JOURNEY" == "upgrade-cancel-retry" && "$PHASE" == "awaiting_stability_witness" ]]; then
    prompt_token \
        "upgrade-no-auto-retry" \
        "I-RELAUNCHED-WITHOUT-AUTO-RETRY" \
        "Quit and relaunch Yulu normally, and on the dedicated target complete the operator login-cycle witness if this run requires it. Confirm Yulu remains rolled back with Retry visible and does not begin another migration automatically."
    observe_upgrade "rolled_back_stable" "upgrade-rolled-back-stable.json" "$LEDGER/upgrade-rolled-back.json"
    write_state "awaiting_retry"
fi

if [[ "$JOURNEY" == "upgrade-cancel-retry" && "$PHASE" == "awaiting_retry" ]]; then
    prompt_token \
        "upgrade-explicit-retry" \
        "I-USED-VISIBLE-RETRY" \
        "Use the visible Retry Service Migration button in Yulu. Do not pass a CLI retry flag. Wait for the new transaction to reach Background approval is required, without approving it yet."
    observe_upgrade "retry_awaiting_approval" "upgrade-retry-awaiting-approval.json" "$LEDGER/upgrade-rolled-back-stable.json"
    write_state "retry_awaiting_approval"
fi

if [[ "$PHASE" == "awaiting_approval" || "$PHASE" == "retry_awaiting_approval" ]]; then
    if [[ "$PHASE" == "awaiting_approval" ]]; then prior="$LEDGER/upgrade-awaiting-approval.json"; else prior="$LEDGER/upgrade-retry-awaiting-approval.json"; fi
    prompt_token \
        "upgrade-approve-and-commit" \
        "I-APPROVED-AND-SAW-MIGRATION-COMMIT" \
        "Approve the two Yulu background items through macOS and return to Yulu. Wait until the installed App completes migration and its bundled Host and Capture are healthy. Do not Test Share or Share. Confirm externally that the dedicated destination has no new run marker."
    observe_upgrade "committed" "upgrade-committed.json" "$prior"
    observe_upgrade_journey "upgrade-journey.json"
    write_state "awaiting_post_commit_baseline"
fi

if [[ "$PHASE" == "awaiting_post_commit_baseline" ]]; then
    [[ -f "$LEDGER/upgrade-committed.json" && -f "$LEDGER/upgrade-journey.json" ]] || \
        fail "post-commit baseline lacks committed upgrade evidence"
    observe_post_commit \
        "post-commit-baseline" "post-commit-baseline.json" \
        "bundle-observation.json" "upgrade-journey.json" "upgrade-committed.json"
    write_state "awaiting_restart_login"
fi

if [[ "$PHASE" == "awaiting_restart_login" ]]; then
    prompt_token \
        "post-commit-restart-login" \
        "I-QUIT-LOGGED-IN-AND-RELAUNCHED-YULU" \
        "Quit Yulu normally. On the dedicated formal target, log out and log back in, rerun this same verified harness command from the preserved 0700 ledger, relaunch /Applications/Yulu.app yourself, and wait for Host and Capture health. The harness does not open, click, stop, or start the App or services."
    observe_bundle_checkpoint "bundle-restart-login.json"
    observe_upgrade "committed_stable" "upgrade-committed-restart-login.json" "$LEDGER/upgrade-committed.json"
    observe_upgrade_journey "upgrade-journey-restart-login.json"
    observe_post_commit \
        "post-commit-restart-login" "post-commit-restart-login.json" \
        "bundle-restart-login.json" "upgrade-journey-restart-login.json" \
        "upgrade-committed-restart-login.json" "post-commit-baseline.json"
    write_state "awaiting_no_update"
fi

if [[ "$PHASE" == "awaiting_no_update" ]]; then
    prompt_token \
        "check-for-updates-no-update" \
        "I-SAW-NO-UPDATE-AVAILABLE-IN-YULU" \
        "In the running Yulu App, choose Check for Updates… and witness the product UI report that no update is available. Do not substitute a command-line network request or forged response. Yulu exposes no reliable read-only API for this UI outcome, so the token is bound to immediate before/after bundle, update-journal, service, health, IPC, database-schema, migration-journal, and zero-Share evidence."
    observe_bundle_checkpoint "bundle-no-update.json"
    observe_upgrade "committed_stable" "upgrade-committed-no-update.json" "$LEDGER/upgrade-committed-restart-login.json"
    observe_upgrade_journey "upgrade-journey-no-update.json"
    observe_post_commit \
        "check-for-updates-no-update" "check-for-updates-no-update.json" \
        "bundle-no-update.json" "upgrade-journey-no-update.json" \
        "upgrade-committed-no-update.json" "post-commit-restart-login.json"
    write_state "completed"
fi

if [[ "$PHASE" == "completed" ]]; then
    [[ -f "$LEDGER/upgrade-committed.json" && -f "$LEDGER/upgrade-journey.json" && \
       -f "$LEDGER/post-commit-baseline.json" && -f "$LEDGER/post-commit-restart-login.json" && \
       -f "$LEDGER/check-for-updates-no-update.json" ]] || fail "completed upgrade lacks final evidence"
    if [[ "$JOURNEY" == "upgrade-cancel-retry" ]]; then
        for required in upgrade-rolled-back.json upgrade-rolled-back-stable.json upgrade-retry-awaiting-approval.json; do
            [[ -f "$LEDGER/$required" ]] || fail "completed cancel/retry journey lacks checkpoint evidence"
        done
    fi
fi

printf '{"schema":1,"classification":"%s","formalAcceptance":false,"status":"completed","journey":"%s","operatorSnapshotWitnessSha256":"%s"}\n' \
    "$CLASSIFICATION" "$JOURNEY" "$SNAPSHOT_WITNESS_SHA256"
