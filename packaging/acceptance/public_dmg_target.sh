#!/bin/bash

set -euo pipefail
umask 077

fail() {
    printf 'public_dmg_target.sh: %s\n' "$1" >&2
    exit 1
}

has_github_release_provenance() {
    local provenance="$1" canonical_url="$2" entry
    while IFS= read -r entry || [[ -n "$entry" ]]; do
        entry="${entry#"${entry%%[![:space:]]*}"}"
        entry="${entry%"${entry##*[![:space:]]}"}"
        [[ -n "$entry" && "$entry" != "(" && "$entry" != ")" ]] || continue
        [[ "$entry" != *, ]] || entry="${entry%,}"
        if [[ "$entry" == \"*\" ]]; then
            entry="${entry:1:${#entry}-2}"
        fi
        [[ "$entry" == "$canonical_url" || \
           "$entry" == "https://release-assets.githubusercontent.com/"* ]] && return 0
    done <<< "$provenance"
    return 1
}

VERIFIED_HARNESS_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)"
[[ "$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)/${BASH_SOURCE[0]##*/}" == "$VERIFIED_HARNESS_DIR/public_dmg_target.sh" ]] || \
    fail "target must execute from the delivered harness directory"
HARNESS_LAUNCHER="$VERIFIED_HARNESS_DIR/launch_public_dmg_acceptance.sh"
[[ -f "$HARNESS_LAUNCHER" && ! -L "$HARNESS_LAUNCHER" ]] || fail "harness integrity launcher is missing"
/bin/bash "$HARNESS_LAUNCHER" --verify-only >/dev/null || fail "harness integrity verification failed"
HARNESS_MANIFEST_SHA256="$(/usr/bin/shasum -a 256 "$VERIFIED_HARNESS_DIR/manifest.sha256")"
HARNESS_MANIFEST_SHA256="${HARNESS_MANIFEST_SHA256%% *}"
HARNESS_SOURCE_REVISION=""
IFS= read -r HARNESS_SOURCE_REVISION < "$VERIFIED_HARNESS_DIR/source-revision.txt" || \
    fail "harness source revision is unreadable"
[[ "$HARNESS_SOURCE_REVISION" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || fail "harness source revision is invalid"
HARNESS_BUILD_MODE=""
IFS= read -r HARNESS_BUILD_MODE < "$VERIFIED_HARNESS_DIR/build-mode.txt" || fail "harness build mode is unreadable"
[[ "$HARNESS_BUILD_MODE" == "formal" || "$HARNESS_BUILD_MODE" == "policy-test" ]] || fail "harness build mode is invalid"
if [[ -n "${YULU_ACCEPTANCE_HARNESS_MANIFEST_SHA256:-}" && \
      "$YULU_ACCEPTANCE_HARNESS_MANIFEST_SHA256" != "$HARNESS_MANIFEST_SHA256" ]]; then
    fail "launcher and target disagree on harness manifest digest"
fi
if [[ -n "${YULU_ACCEPTANCE_HARNESS_SOURCE_REVISION:-}" && \
      "$YULU_ACCEPTANCE_HARNESS_SOURCE_REVISION" != "$HARNESS_SOURCE_REVISION" ]]; then
    fail "launcher and target disagree on source revision"
fi

POLICY_TEST=0
SCENARIO=""
TAG=""
DMG=""
PUBLIC_URL=""
CHECKSUMS=""
CHECKSUMS_URL=""
RUN_ID=""
EVIDENCE_DIR=""
PREFLIGHT_ONLY=0
POLICY_INSTALLATION_ONLY=0
JOURNEY_BASE_URL=""
UPGRADE_JOURNEY=""
MIGRATION_BEFORE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --policy-test) POLICY_TEST=1; shift ;;
        --scenario) SCENARIO="${2:-}"; shift 2 ;;
        --tag) TAG="${2:-}"; shift 2 ;;
        --dmg) DMG="${2:-}"; shift 2 ;;
        --public-url) PUBLIC_URL="${2:-}"; shift 2 ;;
        --checksums) CHECKSUMS="${2:-}"; shift 2 ;;
        --checksums-url) CHECKSUMS_URL="${2:-}"; shift 2 ;;
        --run-id) RUN_ID="${2:-}"; shift 2 ;;
        --evidence-dir) EVIDENCE_DIR="${2:-}"; shift 2 ;;
        --preflight-only) PREFLIGHT_ONLY=1; shift ;;
        --policy-installation-only) POLICY_INSTALLATION_ONLY=1; shift ;;
        --journey-base-url) JOURNEY_BASE_URL="${2:-}"; shift 2 ;;
        --upgrade-journey) UPGRADE_JOURNEY="${2:-}"; shift 2 ;;
        --migration-before) MIGRATION_BEFORE="${2:-}"; shift 2 ;;
        *) fail "unknown argument: $1" ;;
    esac
done

if [[ "$POLICY_TEST" -eq 1 ]]; then EXPECTED_BUILD_MODE="policy-test"; else EXPECTED_BUILD_MODE="formal"; fi
[[ "$HARNESS_BUILD_MODE" == "$EXPECTED_BUILD_MODE" ]] || fail "harness build mode does not match the execution path"

[[ "$SCENARIO" == "fresh" || "$SCENARIO" == "upgrade" ]] || fail "scenario must be fresh or upgrade"
if [[ "$SCENARIO" == "upgrade" ]]; then
    [[ "$TAG" == "v0.23.0-rc.6" ]] || fail "upgrade acceptance is pinned to v0.23.0-rc.6"
    [[ "$UPGRADE_JOURNEY" == "upgrade-success" || "$UPGRADE_JOURNEY" == "upgrade-cancel-retry" ]] || fail "upgrade journey is invalid"
    [[ "$MIGRATION_BEFORE" == /* && -f "$MIGRATION_BEFORE" && ! -L "$MIGRATION_BEFORE" ]] ||
        fail "upgrade requires absolute regular migration-before evidence"
else
    [[ -z "$UPGRADE_JOURNEY$MIGRATION_BEFORE" ]] || fail "upgrade arguments are invalid for a fresh scenario"
fi
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || fail "invalid release tag"
EXPECTED_NAME="yulu-macos-arm64-${TAG}.dmg"
EXPECTED_URL="https://github.com/Nowhitestar/Yulu/releases/download/${TAG}/${EXPECTED_NAME}"
EXPECTED_CHECKSUMS_URL="https://github.com/Nowhitestar/Yulu/releases/download/${TAG}/checksums.txt"
[[ "$PUBLIC_URL" == "$EXPECTED_URL" ]] || fail "DMG must use the exact public release URL"
[[ "$CHECKSUMS_URL" == "$EXPECTED_CHECKSUMS_URL" ]] || fail "manifest must use the exact public checksums URL"
[[ "$DMG" == /* && -f "$DMG" && ! -L "$DMG" ]] || fail "DMG must be an existing absolute regular file"
[[ "${DMG##*/}" == "$EXPECTED_NAME" ]] || fail "DMG filename does not match the release tag"
[[ "$CHECKSUMS" == /* && -f "$CHECKSUMS" && ! -L "$CHECKSUMS" ]] || fail "checksums must be an existing absolute regular file"
[[ "${CHECKSUMS##*/}" == "checksums.txt" ]] || fail "checksums filename must be exactly checksums.txt"
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail "run-id contains unsafe characters"
if [[ "$POLICY_TEST" -eq 1 ]]; then
    [[ "$EVIDENCE_DIR" == /* ]] || fail "policy evidence directory must be absolute"
else
    [[ -z "$EVIDENCE_DIR" ]] || fail "formal evidence directory is fixed and cannot be overridden"
    EVIDENCE_DIR="${HOME:?HOME is required}/Library/Application Support/Yulu Acceptance"
fi

if [[ "$POLICY_TEST" -eq 1 ]]; then
    : "${YULU_ACCEPTANCE_TEST_BIN:?--policy-test requires an isolated command directory}"
    : "${YULU_ACCEPTANCE_TEST_SYSTEM_ROOT:?--policy-test requires a temporary system root}"
    : "${YULU_ACCEPTANCE_TEST_APPLICATIONS:?--policy-test requires a temporary Applications root}"
    : "${YULU_ACCEPTANCE_TEST_HOME:?--policy-test requires a temporary home}"
    : "${YULU_ACCEPTANCE_TEST_HARNESS:?--policy-test requires a delivered harness path}"
    TOOL_ROOT="$YULU_ACCEPTANCE_TEST_BIN"
    SYSTEM_ROOT="$YULU_ACCEPTANCE_TEST_SYSTEM_ROOT"
    APPLICATIONS_ROOT="$YULU_ACCEPTANCE_TEST_APPLICATIONS"
    ACCEPTANCE_HOME="$YULU_ACCEPTANCE_TEST_HOME"
    HARNESS_PATH="$YULU_ACCEPTANCE_TEST_HARNESS"
    UNAME="$TOOL_ROOT/uname"
    SW_VERS="$TOOL_ROOT/sw_vers"
    XATTR="$TOOL_ROOT/xattr"
    SHASUM="$TOOL_ROOT/shasum"
    MDLS="$TOOL_ROOT/mdls"
    XCODE_SELECT="$TOOL_ROOT/xcode-select"
    LAUNCHCTL="$TOOL_ROOT/launchctl"
    CODESIGN="$TOOL_ROOT/codesign"
    SPCTL="$TOOL_ROOT/spctl"
    HDIUTIL="$TOOL_ROOT/hdiutil"
    DISKUTIL="$TOOL_ROOT/diskutil"
    PLUTIL="$TOOL_ROOT/plutil"
    READLINK="$TOOL_ROOT/readlink"
    MKTEMP="$TOOL_ROOT/mktemp"
    STAT="$TOOL_ROOT/stat"
    if [[ "$PREFLIGHT_ONLY" -eq 0 && "$POLICY_INSTALLATION_ONLY" -eq 0 ]]; then
        [[ "$JOURNEY_BASE_URL" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || \
            fail "policy journey observer requires an explicit IPv4 loopback base URL"
    fi
else
    [[ "$POLICY_INSTALLATION_ONLY" -eq 0 ]] || fail "policy installation-only mode is forbidden during formal acceptance"
    [[ -z "$JOURNEY_BASE_URL" ]] || fail "formal journey observer base URL is fixed"
    [[ -z "${YULU_ACCEPTANCE_TEST_BIN:-}${YULU_ACCEPTANCE_TEST_SYSTEM_ROOT:-}${YULU_ACCEPTANCE_TEST_APPLICATIONS:-}${YULU_ACCEPTANCE_TEST_HOME:-}${YULU_ACCEPTANCE_TEST_HARNESS:-}" ]] || \
        fail "test overrides are forbidden during formal preflight"
    SYSTEM_ROOT=""
    APPLICATIONS_ROOT="/Applications"
    ACCEPTANCE_HOME="${HOME:?HOME is required}"
    HARNESS_PATH="$VERIFIED_HARNESS_DIR"
    UNAME="/usr/bin/uname"
    SW_VERS="/usr/bin/sw_vers"
    XATTR="/usr/bin/xattr"
    SHASUM="/usr/bin/shasum"
    MDLS="/usr/bin/mdls"
    XCODE_SELECT="/usr/bin/xcode-select"
    LAUNCHCTL="/bin/launchctl"
    CODESIGN="/usr/bin/codesign"
    SPCTL="/usr/sbin/spctl"
    HDIUTIL="/usr/bin/hdiutil"
    DISKUTIL="/usr/sbin/diskutil"
    PLUTIL="/usr/bin/plutil"
    READLINK="/usr/bin/readlink"
    MKTEMP="/usr/bin/mktemp"
    STAT="/usr/bin/stat"
fi

DURABLE_SYNC="$VERIFIED_HARNESS_DIR/yulu-durable-sync"

[[ "$(cd "$HARNESS_PATH" && pwd -P)" == "$VERIFIED_HARNESS_DIR" ]] || \
    fail "configured harness path does not match the verified delivery"

for required_tool in \
    "$UNAME" "$SW_VERS" "$XATTR" "$SHASUM" "$MDLS" "$XCODE_SELECT" "$LAUNCHCTL" \
    "$CODESIGN" "$SPCTL" "$HDIUTIL" "$DISKUTIL" "$PLUTIL" "$READLINK" "$MKTEMP" "$STAT" "$DURABLE_SYNC"; do
    [[ -x "$required_tool" ]] || fail "required system command is unavailable: ${required_tool##*/}"
done

in_checkout() {
    local current="$1"
    [[ -d "$current" ]] || current="${current%/*}"
    while [[ -n "$current" ]]; do
        [[ -e "$current/.git" ]] && return 0
        [[ "$current" == "/" ]] && break
        current="${current%/*}"
        [[ -n "$current" ]] || current="/"
    done
    return 1
}

CURRENT_DIRECTORY="$(pwd -P)"
in_checkout "$CURRENT_DIRECTORY" && fail "target working directory is inside a repository checkout"
in_checkout "$HARNESS_PATH" && fail "delivered harness is inside a repository checkout"

reject_symlink_components() {
    local remaining="${1#/}" current="" component
    while [[ -n "$remaining" ]]; do
        if [[ "$remaining" == */* ]]; then
            component="${remaining%%/*}"
            remaining="${remaining#*/}"
        else
            component="$remaining"
            remaining=""
        fi
        [[ -n "$component" ]] || continue
        current="$current/$component"
        [[ ! -L "$current" ]] || fail "evidence path contains a symlink component"
    done
}

reject_symlink_components "$EVIDENCE_DIR"
if [[ -e "$EVIDENCE_DIR" ]]; then
    [[ -d "$EVIDENCE_DIR" && ! -L "$EVIDENCE_DIR" && -O "$EVIDENCE_DIR" ]] || \
        fail "evidence directory is an unsafe existing node"
else
    /bin/mkdir -p "$EVIDENCE_DIR"
fi
reject_symlink_components "$EVIDENCE_DIR"
[[ -d "$EVIDENCE_DIR" && ! -L "$EVIDENCE_DIR" && -O "$EVIDENCE_DIR" ]] || fail "evidence directory is unsafe after creation"
/bin/chmod 700 "$EVIDENCE_DIR"
[[ "$($STAT -f %Lp "$EVIDENCE_DIR")" == "700" ]] || fail "evidence directory mode is unsafe"
[[ "$(cd "$EVIDENCE_DIR" && pwd -P)" == "$EVIDENCE_DIR" ]] || fail "evidence directory did not resolve to the required path"
LEDGER="$EVIDENCE_DIR/$RUN_ID"
if [[ -e "$LEDGER" || -L "$LEDGER" ]]; then
    [[ -d "$LEDGER" && ! -L "$LEDGER" && -O "$LEDGER" ]] || fail "evidence ledger is an unsafe existing node"
    [[ "$($STAT -f %Lp "$LEDGER")" == "700" ]] || fail "existing evidence ledger mode is unsafe"
else
    /bin/mkdir -m 700 "$LEDGER"
fi

for existing_node in "$LEDGER"/* "$LEDGER"/.[!.]* "$LEDGER"/..?*; do
    [[ -e "$existing_node" || -L "$existing_node" ]] || continue
    existing_name="${existing_node##*/}"
    case "$existing_name" in
        state|preflight.json|mount.json|service-baseline.txt|guidance-checkpoint.txt|bundle-observation.json|bundle-restart-login.json|bundle-no-update.json|journey-baseline.json|journey-core-activation.json|pre-test-share.json|test-share.json|pre-production-share.json|production-share-cancelled.json|production-share.json|journey-restart-login.json|journey-no-update.json|post-commit-baseline.json|post-commit-restart-login.json|check-for-updates-no-update.json|upgrade.state|upgrade-awaiting-approval.json|upgrade-committed.json|upgrade-committed-restart-login.json|upgrade-committed-no-update.json|upgrade-rolled-back.json|upgrade-rolled-back-stable.json|upgrade-retry-awaiting-approval.json|upgrade-journey.json|upgrade-journey-restart-login.json|upgrade-journey-no-update.json)
            if [[ "$existing_name" == "state" ]]; then
                [[ -f "$existing_node" && ! -L "$existing_node" ]] || fail "state must be a safe regular file"
            fi
            [[ -f "$existing_node" && ! -L "$existing_node" && -O "$existing_node" ]] || \
                fail "unsafe ledger node: $existing_name"
            [[ "$($STAT -f %Lp "$existing_node")" == "600" ]] || fail "unsafe ledger file mode: $existing_name"
            ;;
        *) fail "unsafe ledger node: $existing_name" ;;
    esac
done

write_evidence() {
    local name="$1" content="$2" temporary
    temporary="$($MKTEMP "$LEDGER/.${name}.XXXXXX")" || fail "could not create unique evidence file"
    [[ "$temporary" == "$LEDGER/.${name}."* && -f "$temporary" && ! -L "$temporary" ]] || \
        fail "system mktemp returned an unsafe evidence file"
    printf '%s\n' "$content" > "$temporary"
    /bin/chmod 600 "$temporary"
    "$DURABLE_SYNC" "$temporary"
    /bin/mv -f "$temporary" "$LEDGER/$name"
    "$DURABLE_SYNC" "$LEDGER"
}

publish_evidence_file() {
    local temporary="$1" destination="$2"
    "$DURABLE_SYNC" "$temporary"
    /bin/mv -f "$temporary" "$destination"
    "$DURABLE_SYNC" "$LEDGER"
}

ARCH="$($UNAME -m)"
[[ "$ARCH" == "arm64" ]] || fail "formal public-DMG acceptance requires Apple Silicon arm64"
MACOS_VERSION="$($SW_VERS -productVersion)"
MACOS_MAJOR="${MACOS_VERSION%%.*}"
[[ "$MACOS_MAJOR" =~ ^[0-9]+$ ]] || fail "could not determine macOS version"
[[ "$MACOS_MAJOR" -ne 13 ]] || fail "macOS 13 is a deployment target, not an acceptance target"
[[ "$MACOS_MAJOR" -ge 14 ]] || fail "formal public-DMG acceptance requires macOS 14 or newer"

QUARANTINE="$($XATTR -p com.apple.quarantine "$DMG" 2>/dev/null || true)"
[[ -n "$QUARANTINE" ]] || fail "DMG lacks a pre-existing com.apple.quarantine attribute"
[[ "$QUARANTINE" =~ ^[0-9A-Fa-f]{4}\;[0-9A-Fa-f]{8}\;[^\;]+\;.*$ ]] || fail "DMG quarantine format is invalid"
WHERE_FROMS="$($MDLS -raw -name kMDItemWhereFroms "$DMG" 2>/dev/null || true)"
has_github_release_provenance "$WHERE_FROMS" "$EXPECTED_URL" || \
    fail "DMG browser provenance contains neither the canonical public URL nor GitHub release-assets redirect"

MANIFEST_SHA=""
MANIFEST_MATCHES=0
while IFS=' ' read -r row_sha row_name row_extra || [[ -n "${row_sha:-}${row_name:-}${row_extra:-}" ]]; do
    if [[ "${row_name:-}" == "$EXPECTED_NAME" ]]; then
        [[ "${row_sha:-}" =~ ^[0-9a-f]{64}$ && -z "${row_extra:-}" ]] || \
            fail "checksum manifest contains a malformed DMG row"
        MANIFEST_MATCHES=$((MANIFEST_MATCHES + 1))
        MANIFEST_SHA="$row_sha"
    fi
done < "$CHECKSUMS"
[[ "$MANIFEST_MATCHES" -eq 1 ]] || fail "checksum manifest must contain one unique exact DMG row"
ACTUAL_SHA="$($SHASUM -a 256 "$DMG")"
ACTUAL_SHA="${ACTUAL_SHA%% *}"
[[ "$ACTUAL_SHA" == "$MANIFEST_SHA" ]] || fail "DMG checksum mismatch"
CHECKSUMS_SHA="$($SHASUM -a 256 "$CHECKSUMS")"
CHECKSUMS_SHA="${CHECKSUMS_SHA%% *}"
[[ "$CHECKSUMS_SHA" =~ ^[0-9a-f]{64}$ ]] || fail "could not hash checksums.txt"

STATE=""
if [[ -f "$LEDGER/state" ]]; then
    STATE_SCHEMA=""
    STATE_TAG=""
    STATE_DMG_SHA=""
    STATE_PHASE=""
    STATE_LINES=0
    while IFS='=' read -r state_key state_value || [[ -n "${state_key:-}${state_value:-}" ]]; do
        STATE_LINES=$((STATE_LINES + 1))
        case "$state_key" in
            schema) [[ -z "$STATE_SCHEMA" ]] || fail "state contains a duplicate schema"; STATE_SCHEMA="$state_value" ;;
            tag) [[ -z "$STATE_TAG" ]] || fail "state contains a duplicate tag"; STATE_TAG="$state_value" ;;
            dmg_sha256) [[ -z "$STATE_DMG_SHA" ]] || fail "state contains a duplicate digest"; STATE_DMG_SHA="$state_value" ;;
            phase) [[ -z "$STATE_PHASE" ]] || fail "state contains a duplicate phase"; STATE_PHASE="$state_value" ;;
            *) fail "state contains an unknown field" ;;
        esac
    done < "$LEDGER/state"
    [[ "$STATE_LINES" -eq 4 && "$STATE_SCHEMA" == "1" ]] || fail "state is malformed"
    [[ "$STATE_TAG" == "$TAG" && "$STATE_DMG_SHA" == "$ACTUAL_SHA" ]] || \
        fail "run-id is already bound to a different artifact"
    case "$STATE_PHASE" in
        preflight-passed|awaiting_guidance|awaiting_finder_drag|awaiting_app_baseline|awaiting_core_activation|awaiting_optional_outcomes|awaiting_test_share_configuration|awaiting_test_share|awaiting_production_share_cancel|awaiting_production_share|awaiting_post_commit_baseline|awaiting_restart_login|awaiting_no_update|completed) STATE="$STATE_PHASE" ;;
        *) fail "state phase is invalid" ;;
    esac
fi

write_state() {
    local phase="$1" content
    printf -v content 'schema=1\ntag=%s\ndmg_sha256=%s\nphase=%s' "$TAG" "$ACTUAL_SHA" "$phase"
    write_evidence "state" "$content"
    STATE="$phase"
}

root_path() {
    if [[ -n "$SYSTEM_ROOT" ]]; then
        printf '%s/%s' "$SYSTEM_ROOT" "${1#/}"
    else
        printf '%s' "$1"
    fi
}

if [[ "$SCENARIO" == "fresh" ]]; then
    [[ ! -e "$(root_path /opt/homebrew)" && ! -e "$(root_path /usr/local/Homebrew)" ]] || \
        fail "Homebrew is present on the fresh target"

    is_apple_xcode_select_tool_shim() {
        local candidate="$1" expected details line
        local identifier_matches=0 platform_binary=0 apple_anchored=0
        expected="$(root_path /usr/bin/python3)"
        [[ "$candidate" == "$expected" && -f "$candidate" && ! -L "$candidate" ]] || return 1
        details="$("$CODESIGN" --display --verbose=4 --requirements - "$candidate" 2>&1)" || return 1
        while IFS= read -r line; do
            [[ "$line" == "Identifier=com.apple.dt.xcode_select.tool-shim-public" ]] && identifier_matches=1
            [[ "$line" =~ ^Platform\ identifier=[1-9][0-9]*$ ]] && platform_binary=1
            [[ "$line" == 'designated => identifier "com.apple.dt.xcode_select.tool-shim-public" and anchor apple' ]] && \
                apple_anchored=1
        done <<< "$details"
        [[ "$identifier_matches" -eq 1 && "$platform_binary" -eq 1 && "$apple_anchored" -eq 1 ]]
    }

    for host_tool in brew node npm python3 pip pip3; do
        host_tool_path="$(command -v "$host_tool" 2>/dev/null || true)"
        [[ -n "$host_tool_path" ]] || continue
        if [[ "$host_tool" == "python3" ]] && is_apple_xcode_select_tool_shim "$host_tool_path"; then
            continue
        fi
        fail "forbidden host tool is available: $host_tool"
    done
    for direct_install in \
        /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/python3 /usr/local/bin/pip /usr/local/bin/pip3 \
        /opt/local/bin/node /opt/local/bin/npm /opt/local/bin/python3 /opt/local/bin/pip /opt/local/bin/pip3 \
        /Library/Frameworks/Python.framework; do
        [[ ! -e "$(root_path "$direct_install")" ]] || fail "forbidden host dependency is installed outside PATH: $direct_install"
    done
    for manager_root in \
        "$ACCEPTANCE_HOME/.nvm" "$ACCEPTANCE_HOME/.pyenv" "$ACCEPTANCE_HOME/.asdf" "$ACCEPTANCE_HOME/.local/bin"; do
        [[ ! -e "$manager_root" ]] || fail "forbidden host dependency manager root is present"
    done
    if [[ -n "${NVM_DIR:-}${PYENV_ROOT:-}${ASDF_DIR:-}${ASDF_DATA_DIR:-}${VIRTUAL_ENV:-}${CONDA_PREFIX:-}${NODE_PATH:-}${PYTHONPATH:-}" ]]; then
        fail "forbidden host dependency activated environment is present"
    fi

    [[ ! -e "$APPLICATIONS_ROOT/Xcode.app" ]] || fail "Xcode is present on the fresh target"
    [[ ! -e "$(root_path /Library/Developer/CommandLineTools)" ]] || fail "Xcode Command Line Tools are present on the fresh target"
    if "$XCODE_SELECT" -p >/dev/null 2>&1; then
        fail "Xcode or Command Line Tools are selected on the fresh target"
    fi
fi

POST_INSTALL_RESUME=0
if [[ ("$STATE" == "awaiting_finder_drag" || "$STATE" == "awaiting_app_baseline" || \
      "$STATE" == "awaiting_core_activation" || "$STATE" == "awaiting_optional_outcomes" || \
      "$STATE" == "awaiting_test_share_configuration" || \
      "$STATE" == "awaiting_test_share" || "$STATE" == "awaiting_production_share_cancel" || \
      "$STATE" == "awaiting_production_share" || "$STATE" == "awaiting_post_commit_baseline" || \
      "$STATE" == "awaiting_restart_login" || "$STATE" == "awaiting_no_update" || "$STATE" == "completed") && \
      -d "$APPLICATIONS_ROOT/Yulu.app" && ! -L "$APPLICATIONS_ROOT/Yulu.app" ]]; then
    POST_INSTALL_RESUME=1
fi
if [[ "$SCENARIO" == "fresh" && "$POST_INSTALL_RESUME" -eq 0 ]]; then
    [[ ! -e "$APPLICATIONS_ROOT/Yulu.app" ]] || fail "existing Yulu installation found in Applications"
    for marker in \
        "$ACCEPTANCE_HOME/.config/yulu" \
        "$ACCEPTANCE_HOME/Library/Application Support/Yulu" \
        "$ACCEPTANCE_HOME/Movies/Yulu"; do
        [[ ! -e "$marker" ]] || fail "existing Yulu data or service state found on fresh target"
    done
    for marker in "$ACCEPTANCE_HOME/Library/LaunchAgents"/com.yulu.*.plist; do
        [[ ! -e "$marker" ]] || fail "existing Yulu data or service state found on fresh target"
    done
    for label in \
        com.yulu.ui com.yulu.audiodaemon com.yulu.agentqueue com.yulu.calendar \
        com.yulu.detector com.yulu.scheduler com.yulu.statusagent com.yulu.sttdaemon; do
        if "$LAUNCHCTL" print "gui/${UID:-0}/$label" >/dev/null 2>&1; then
            fail "existing Yulu data or service state found on fresh target"
        fi
    done
fi

if [[ "$SCENARIO" == "fresh" ]]; then HOST_DEPENDENCIES_ABSENT=true; else HOST_DEPENDENCIES_ABSENT=false; fi
write_evidence "preflight.json" "{\"schema\":1,\"formalAcceptance\":false,\"status\":\"passed\",\"scenario\":\"$SCENARIO\",\"releaseTag\":\"$TAG\",\"dmgSha256\":\"$ACTUAL_SHA\",\"checksumsSha256\":\"$CHECKSUMS_SHA\",\"dmgUrl\":\"$EXPECTED_URL\",\"checksumsUrl\":\"$EXPECTED_CHECKSUMS_URL\",\"architecture\":\"$ARCH\",\"macOSVersion\":\"$MACOS_VERSION\",\"browserProvenanceVerified\":true,\"hostDependenciesAbsent\":$HOST_DEPENDENCIES_ABSENT,\"harnessBuildMode\":\"$HARNESS_BUILD_MODE\",\"harnessManifestSha256\":\"$HARNESS_MANIFEST_SHA256\",\"sourceRevision\":\"$HARNESS_SOURCE_REVISION\"}"
if [[ "$PREFLIGHT_ONLY" -eq 1 ]]; then
    write_state "preflight-passed"
    if [[ "$POLICY_TEST" -eq 1 ]]; then
        printf '{"classification":"harness_policy_test","formalAcceptance":false,"status":"passed"}\n'
    else
        printf '{"classification":"formal_preflight","formalAcceptance":false,"status":"passed"}\n'
    fi
    exit 0
fi

verify_developer_id() {
    local candidate="$1" details
    if [[ -d "$candidate" ]]; then
        "$CODESIGN" --verify --deep --strict --verbose=2 "$candidate" >/dev/null 2>&1 || \
            fail "code signature verification failed: ${candidate##*/}"
    else
        "$CODESIGN" --verify --strict --verbose=2 "$candidate" >/dev/null 2>&1 || \
            fail "code signature verification failed: ${candidate##*/}"
    fi
    details="$($CODESIGN --display --verbose=4 "$candidate" 2>&1)" || \
        fail "could not read Developer ID signature: ${candidate##*/}"
    [[ "$details" == *"Authority=Developer ID Application:"* ]] || \
        fail "signature is not Developer ID Application: ${candidate##*/}"
    [[ "$details" == *"TeamIdentifier=WMU9678ZQL"* ]] || \
        fail "signature has the wrong Team ID: ${candidate##*/}"
}

verify_gatekeeper() {
    local kind="$1" candidate="$2" output
    if [[ "$kind" == "dmg" ]]; then
        output="$($SPCTL -a -vv -t open --context context:primary-signature "$candidate" 2>&1)" || \
            fail "DMG was not accepted as notarized by Gatekeeper"
    else
        output="$($SPCTL -a -vv -t exec "$candidate" 2>&1)" || \
            fail "App was not accepted as notarized by Gatekeeper"
    fi
    [[ "$output" == *"accepted"* && "$output" == *"source=Notarized Developer ID"* ]] || \
        fail "Gatekeeper evidence is not accepted source=Notarized Developer ID"
}

assert_no_service_mutation() {
    local marker label
    for marker in "$ACCEPTANCE_HOME/Library/LaunchAgents"/com.yulu.*.plist; do
        [[ ! -e "$marker" ]] || fail "mounted launch caused persistent LaunchAgent service mutation"
    done
    for label in \
        com.yulu.ui com.yulu.audiodaemon com.yulu.agentqueue com.yulu.calendar \
        com.yulu.detector com.yulu.scheduler com.yulu.statusagent com.yulu.sttdaemon; do
        if "$LAUNCHCTL" print "gui/${UID:-0}/$label" >/dev/null 2>&1; then
            fail "mounted launch caused persistent service mutation: $label"
        fi
    done
}

verify_developer_id "$DMG"
verify_gatekeeper dmg "$DMG"

MOUNT_POINT="$LEDGER/mount-$$"
/bin/mkdir -m 700 "$MOUNT_POINT"
MOUNTED=0
ATTACH_PLIST="$($MKTEMP "$LEDGER/.attach.plist.XXXXXX")" || fail "could not create attach evidence temporary"
VOLUME_PLIST="$($MKTEMP "$LEDGER/.volume.plist.XXXXXX")" || fail "could not create volume evidence temporary"
OBSERVATION_TMP=""
cleanup_mount() {
    if [[ "$MOUNTED" -eq 1 ]]; then
        "$HDIUTIL" detach -quiet "$MOUNT_POINT" >/dev/null 2>&1 || true
        MOUNTED=0
    fi
    /bin/rm -f "$ATTACH_PLIST" "$VOLUME_PLIST"
    if [[ -n "$OBSERVATION_TMP" ]]; then /bin/rm -f "$OBSERVATION_TMP"; fi
    /bin/rmdir "$MOUNT_POINT" >/dev/null 2>&1 || true
}
trap cleanup_mount EXIT
trap 'exit 130' HUP INT TERM

"$HDIUTIL" attach -readonly -nobrowse -noautoopen -plist -mountpoint "$MOUNT_POINT" "$DMG" > "$ATTACH_PLIST" || \
    fail "could not attach DMG read-only"
/bin/chmod 600 "$ATTACH_PLIST"
MOUNTED=1

"$DISKUTIL" info -plist "$MOUNT_POINT" > "$VOLUME_PLIST" || fail "could not read mounted volume metadata"
/bin/chmod 600 "$VOLUME_PLIST"
VOLUME_NAME="$($PLUTIL -extract VolumeName raw -o - "$VOLUME_PLIST" 2>/dev/null || true)"
[[ "$VOLUME_NAME" == "Yulu" ]] || fail "mounted DMG VolumeName must be exactly Yulu"
/bin/rm -f "$ATTACH_PLIST" "$VOLUME_PLIST"
write_evidence "mount.json" '{"schema":1,"readOnly":true,"noBrowse":true,"noAutoOpen":true,"volumeName":"Yulu"}'

shopt -s nullglob dotglob
TOP_LEVEL=("$MOUNT_POINT"/*)
shopt -u nullglob dotglob
[[ "${#TOP_LEVEL[@]}" -eq 2 ]] || fail "DMG top-level layout must contain only Yulu.app and Applications"
MOUNTED_APP="$MOUNT_POINT/Yulu.app"
APPLICATIONS_ALIAS="$MOUNT_POINT/Applications"
[[ -d "$MOUNTED_APP" && ! -L "$MOUNTED_APP" ]] || fail "mounted Yulu.app must be a real directory"
[[ -L "$APPLICATIONS_ALIAS" && "$($READLINK "$APPLICATIONS_ALIAS")" == "/Applications" ]] || \
    fail "DMG Applications alias must point exactly to /Applications"
verify_developer_id "$MOUNTED_APP"
verify_gatekeeper app "$MOUNTED_APP"

if [[ "$SCENARIO" == "fresh" && "$POST_INSTALL_RESUME" -eq 0 ]]; then
    assert_no_service_mutation
    if [[ "$STATE" == "awaiting_finder_drag" ]]; then
        [[ -f "$LEDGER/service-baseline.txt" && -f "$LEDGER/guidance-checkpoint.txt" ]] || \
            fail "resumable state lacks prior zero-service-mutation evidence"
    else
        write_evidence "service-baseline.txt" "all-known-yulu-launchagents=absent"
    fi
elif [[ "$SCENARIO" == "fresh" ]]; then
    [[ -f "$LEDGER/service-baseline.txt" && -f "$LEDGER/guidance-checkpoint.txt" ]] || \
        fail "resumable state lacks prior zero-service-mutation evidence"
fi

if [[ "$SCENARIO" == "fresh" && "$STATE" != "awaiting_finder_drag" && "$STATE" != "awaiting_app_baseline" && \
      "$STATE" != "awaiting_core_activation" && "$STATE" != "awaiting_optional_outcomes" && \
      "$STATE" != "awaiting_test_share_configuration" && \
      "$STATE" != "awaiting_test_share" && "$STATE" != "awaiting_production_share_cancel" && \
      "$STATE" != "awaiting_production_share" && "$STATE" != "awaiting_post_commit_baseline" && \
      "$STATE" != "awaiting_restart_login" && "$STATE" != "awaiting_no_update" && "$STATE" != "completed" ]]; then
    write_state "awaiting_guidance"
    printf 'ACTION_REQUIRED guidance token=I-SAW-DRAG-GUIDANCE\n'
    printf 'From the mounted DMG, launch Yulu.app, verify the drag-to-Applications guidance, quit Yulu, then enter the exact token.\n'
    CONFIRMATION=""
    IFS= read -r CONFIRMATION || fail "operator guidance confirmation was not received"
    [[ "$CONFIRMATION" == "I-SAW-DRAG-GUIDANCE" ]] || fail "operator guidance confirmation token is incorrect"
    assert_no_service_mutation
    write_evidence "guidance-checkpoint.txt" "confirmed-with-zero-service-mutation"
    write_state "awaiting_finder_drag"
fi
if [[ "$SCENARIO" == "upgrade" && "$STATE" != "awaiting_finder_drag" && "$STATE" != "awaiting_app_baseline" && "$STATE" != "completed" ]]; then
    write_state "awaiting_finder_drag"
fi

INSTALLED_APP="$APPLICATIONS_ROOT/Yulu.app"
if [[ "$STATE" != "awaiting_app_baseline" && "$STATE" != "awaiting_core_activation" && \
      "$STATE" != "awaiting_optional_outcomes" && "$STATE" != "awaiting_test_share_configuration" && \
      "$STATE" != "awaiting_test_share" && \
      "$STATE" != "awaiting_production_share_cancel" && "$STATE" != "awaiting_production_share" && \
      "$STATE" != "awaiting_post_commit_baseline" && "$STATE" != "awaiting_restart_login" && \
      "$STATE" != "awaiting_no_update" && "$STATE" != "completed" ]]; then
    printf 'ACTION_REQUIRED finder-drag token=I-DRAGGED-YULU-IN-FINDER\n'
    printf 'Use Finder to drag Yulu.app into Applications, then enter the exact token.\n'
    CONFIRMATION=""
    IFS= read -r CONFIRMATION || fail "operator Finder drag confirmation was not received"
    [[ "$CONFIRMATION" == "I-DRAGGED-YULU-IN-FINDER" ]] || fail "operator Finder drag confirmation token is incorrect"
fi
[[ -d "$INSTALLED_APP" && ! -L "$INSTALLED_APP" ]] || fail "Finder did not create the exact non-symlink /Applications/Yulu.app"
verify_developer_id "$INSTALLED_APP"
verify_gatekeeper app "$INSTALLED_APP"

OBSERVER="$HARNESS_PATH/observe_product.mjs"
[[ -f "$OBSERVER" && ! -L "$OBSERVER" ]] || fail "external read-only observer is missing"
INSTALLED_NODE="$INSTALLED_APP/Contents/Resources/runtime/bin/node"
[[ -x "$INSTALLED_NODE" && ! -L "$INSTALLED_NODE" ]] || fail "installed Application Runtime Node is missing"
OBSERVATION_TMP="$($MKTEMP "$LEDGER/.bundle-observation.json.XXXXXX")" || \
    fail "could not create bundle observation temporary"
OBSERVER_ARGS=(--mounted "$MOUNTED_APP" --installed "$INSTALLED_APP" --codesign "$CODESIGN")
if [[ "$POLICY_TEST" -eq 1 ]]; then
    OBSERVER_ARGS=(--policy-test "${OBSERVER_ARGS[@]}")
fi
if [[ -f "$LEDGER/bundle-observation.json" ]]; then
    OBSERVER_ARGS+=(--baseline-evidence "$LEDGER/bundle-observation.json")
fi
"$INSTALLED_NODE" "$OBSERVER" "${OBSERVER_ARGS[@]}" > "$OBSERVATION_TMP" || \
    fail "mounted and installed App bundle digest comparison failed"
/bin/chmod 600 "$OBSERVATION_TMP"
if [[ -f "$LEDGER/bundle-observation.json" ]]; then
    /bin/rm -f "$OBSERVATION_TMP"
else
    publish_evidence_file "$OBSERVATION_TMP" "$LEDGER/bundle-observation.json"
fi
OBSERVATION_TMP=""

if [[ "$SCENARIO" == "upgrade" ]]; then
    export YULU_ACCEPTANCE_HARNESS_MANIFEST_SHA256="$HARNESS_MANIFEST_SHA256"
    export YULU_ACCEPTANCE_HARNESS_SOURCE_REVISION="$HARNESS_SOURCE_REVISION"
    UPGRADE_ARGS=(
        --journey "$UPGRADE_JOURNEY" --run-id "$RUN_ID" --release-tag "$TAG"
        --migration-before "$MIGRATION_BEFORE" --current-preflight "$LEDGER/preflight.json"
        --bundle-evidence "$LEDGER/bundle-observation.json" --mounted-app "$MOUNTED_APP"
    )
    if [[ "$POLICY_TEST" -eq 1 ]]; then
        : "${YULU_ACCEPTANCE_TEST_JOURNAL:?upgrade policy-test requires a migration journal fixture}"
        UPGRADE_ARGS=(
            --policy-test --evidence-dir "$EVIDENCE_DIR" --installed-node "$INSTALLED_NODE"
            --journal "$YULU_ACCEPTANCE_TEST_JOURNAL" --home "$ACCEPTANCE_HOME"
            --applications-root "$APPLICATIONS_ROOT" --system-bin "$TOOL_ROOT"
            --journey-base-url "$JOURNEY_BASE_URL" --codesign "$CODESIGN" "${UPGRADE_ARGS[@]}"
        )
    fi
    /bin/bash "$HARNESS_PATH/public_dmg_upgrade_target.sh" "${UPGRADE_ARGS[@]}"
    exit 0
fi

if [[ "$STATE" == "awaiting_finder_drag" || "$STATE" == "awaiting_guidance" || \
      "$STATE" == "preflight-passed" || -z "$STATE" ]]; then
    write_state "awaiting_app_baseline"
fi

if [[ "$POLICY_INSTALLATION_ONLY" -eq 1 ]]; then
    printf '{"classification":"harness_policy_test","formalAcceptance":false,"status":"installation-observed"}\n'
    exit 0
fi

JOURNEY_OBSERVER="$HARNESS_PATH/observe_journey.mjs"
[[ -f "$JOURNEY_OBSERVER" && ! -L "$JOURNEY_OBSERVER" ]] || fail "external read-only journey observer is missing"

observe_journey() {
    local checkpoint="$1" evidence_name="$2"
    shift 2
    local args=(--mode "$checkpoint" --release-tag "$TAG" "$@")
    if [[ "$POLICY_TEST" -eq 1 ]]; then
        args=(--policy-test --base-url "$JOURNEY_BASE_URL" "${args[@]}")
    fi
    OBSERVATION_TMP="$($MKTEMP "$LEDGER/.${evidence_name}.XXXXXX")" || \
        fail "could not create journey observation temporary"
    "$INSTALLED_NODE" "$JOURNEY_OBSERVER" "${args[@]}" > "$OBSERVATION_TMP" || \
        fail "$checkpoint read-only journey observation failed"
    /bin/chmod 600 "$OBSERVATION_TMP"
    publish_evidence_file "$OBSERVATION_TMP" "$LEDGER/$evidence_name"
    OBSERVATION_TMP=""
}

observe_bundle_checkpoint() {
    local evidence_name="$1"
    OBSERVATION_TMP="$($MKTEMP "$LEDGER/.${evidence_name}.XXXXXX")" || \
        fail "could not create bundle checkpoint temporary"
    local args=(--mounted "$MOUNTED_APP" --installed "$INSTALLED_APP" --codesign "$CODESIGN" --baseline-evidence "$LEDGER/bundle-observation.json")
    if [[ "$POLICY_TEST" -eq 1 ]]; then args=(--policy-test "${args[@]}"); fi
    "$INSTALLED_NODE" "$OBSERVER" "${args[@]}" > "$OBSERVATION_TMP" || \
        fail "post-commit bundle checkpoint failed"
    /bin/chmod 600 "$OBSERVATION_TMP"
    publish_evidence_file "$OBSERVATION_TMP" "$LEDGER/$evidence_name"
    OBSERVATION_TMP=""
}

observe_post_commit() {
    local checkpoint="$1" evidence_name="$2" bundle_name="$3" journey_name="$4" prior_name="${5:-}"
    local observer="$HARNESS_PATH/observe_post_commit.mjs"
    [[ -f "$observer" && ! -L "$observer" ]] || fail "post-commit observer is missing"
    local args=(
        --checkpoint "$checkpoint" --scenario fresh --release-tag "$TAG"
        --preflight "$LEDGER/preflight.json" --bundle "$LEDGER/$bundle_name"
        --journey "$LEDGER/$journey_name"
    )
    [[ -z "$prior_name" ]] || args+=(--prior-evidence "$LEDGER/$prior_name")
    case "$checkpoint" in
        post-commit-restart-login) args+=(--operator-restart-login-confirmed) ;;
        check-for-updates-no-update) args+=(--operator-no-update-confirmed) ;;
    esac
    if [[ "$POLICY_TEST" -eq 1 ]]; then
        args=(
            --policy-test --installed-app "$INSTALLED_APP" --home "$ACCEPTANCE_HOME"
            --applications-root "$APPLICATIONS_ROOT" --system-bin "$TOOL_ROOT" "${args[@]}"
        )
    fi
    OBSERVATION_TMP="$($MKTEMP "$LEDGER/.${evidence_name}.XXXXXX")" || \
        fail "could not create post-commit evidence temporary"
    "$INSTALLED_NODE" "$observer" "${args[@]}" > "$OBSERVATION_TMP" || \
        fail "$checkpoint machine observation failed"
    /bin/chmod 600 "$OBSERVATION_TMP"
    publish_evidence_file "$OBSERVATION_TMP" "$LEDGER/$evidence_name"
    OBSERVATION_TMP=""
}

if [[ "$STATE" == "awaiting_app_baseline" ]]; then
    printf 'ACTION_REQUIRED app-baseline token=I-STARTED-YULU\n'
    printf 'Start /Applications/Yulu.app yourself, wait for the fresh onboarding screen, then enter the exact token. The harness will not open or click the App.\n'
    CONFIRMATION=""
    IFS= read -r CONFIRMATION || fail "operator App baseline confirmation was not received"
    [[ "$CONFIRMATION" == "I-STARTED-YULU" ]] || fail "operator App baseline confirmation token is incorrect"
    observe_journey "baseline" "journey-baseline.json"
    write_state "awaiting_core_activation"
fi

if [[ "$STATE" == "awaiting_core_activation" ]]; then
    [[ -f "$LEDGER/journey-baseline.json" ]] || fail "resumable Core Activation state lacks baseline evidence"
    printf 'ACTION_REQUIRED core-activation token=I-COMPLETED-CORE-ACTIVATION\n'
    printf 'In Yulu, configure the required provider, complete exactly one real recording, and wait for transcript and summary. Do not use Test Share or Share. Then enter the exact token.\n'
    CONFIRMATION=""
    IFS= read -r CONFIRMATION || fail "operator Core Activation confirmation was not received"
    [[ "$CONFIRMATION" == "I-COMPLETED-CORE-ACTIVATION" ]] || fail "operator Core Activation confirmation token is incorrect"
    observe_journey "core-activation" "journey-core-activation.json"
    write_state "awaiting_optional_outcomes"
fi

if [[ "$STATE" == "awaiting_optional_outcomes" ]]; then
    [[ -f "$LEDGER/journey-core-activation.json" ]] || \
        fail "resumable optional-outcomes state lacks Core Activation evidence"
    printf 'ACTION_REQUIRED optional-outcomes token=I-ADOPTED-OR-DEFERRED-FRESH-OPTIONAL-CAPABILITIES\n'
    printf '%s\n' 'In fresh onboarding, explicitly adopt or defer Conversation, Calendar Source, and Agent Calendar Connector under their current contracts. Leave Sharing undecided until the verified Test Share. Then enter the exact token.'
    CONFIRMATION=""
    IFS= read -r CONFIRMATION || fail "operator optional capability outcome confirmation was not received"
    [[ "$CONFIRMATION" == "I-ADOPTED-OR-DEFERRED-FRESH-OPTIONAL-CAPABILITIES" ]] || \
        fail "operator optional capability outcome token is incorrect"
    write_state "awaiting_test_share_configuration"
fi

if [[ "$STATE" == "awaiting_test_share_configuration" ]]; then
    [[ -f "$LEDGER/journey-core-activation.json" ]] || \
        fail "resumable Test Share configuration state lacks Core Activation evidence"
    printf 'ACTION_REQUIRED test-share-configuration token=I-CONFIGURED-CLEAN-ACCEPTANCE-DESTINATION\n'
    printf 'In Yulu, select a Supported Agent Connection, probe it, and save a dedicated acceptance destination. Confirm externally that this destination has no marker from an earlier acceptance run. Do not run Test Share or production Share yet. Then enter the exact token.\n'
    CONFIRMATION=""
    IFS= read -r CONFIRMATION || fail "operator dedicated acceptance destination confirmation was not received"
    [[ "$CONFIRMATION" == "I-CONFIGURED-CLEAN-ACCEPTANCE-DESTINATION" ]] || \
        fail "operator dedicated acceptance destination confirmation token is incorrect"
    observe_journey \
        "pre-test-share" \
        "pre-test-share.json" \
        --external-destination-no-run-marker-confirmed
    write_state "awaiting_test_share"
fi

if [[ "$STATE" == "awaiting_test_share" ]]; then
    [[ -f "$LEDGER/pre-test-share.json" ]] || fail "resumable Test Share state lacks destination baseline evidence"
    printf 'ACTION_REQUIRED test-share token=I-COMPLETED-TEST-SHARE\n'
    printf 'In Yulu, manually perform exactly one Test Share to the configured acceptance destination, wait for its verified receipt, and complete the Sharing optional onboarding adoption. Do not run production Share. Then enter the exact token.\n'
    CONFIRMATION=""
    IFS= read -r CONFIRMATION || fail "operator Test Share confirmation was not received"
    [[ "$CONFIRMATION" == "I-COMPLETED-TEST-SHARE" ]] || fail "operator Test Share confirmation token is incorrect"
    observe_journey "test-share" "test-share.json" --binding-evidence "$LEDGER/pre-test-share.json"
    observe_journey "pre-production-share" "pre-production-share.json"
    write_state "awaiting_production_share_cancel"
fi

if [[ "$STATE" == "awaiting_production_share_cancel" ]]; then
    [[ -f "$LEDGER/pre-production-share.json" ]] || \
        fail "resumable production Share cancel state lacks pre-write binding evidence"
    printf 'ACTION_REQUIRED production-share-cancel token=I-CANCELLED-PRODUCTION-SHARE\n'
    printf 'In Yulu, open the production Share confirmation for the same recording, then cancel it without sharing. The harness will not open, click, or submit the UI. Then enter the exact token.\n'
    CONFIRMATION=""
    IFS= read -r CONFIRMATION || fail "operator production Share cancellation confirmation was not received"
    [[ "$CONFIRMATION" == "I-CANCELLED-PRODUCTION-SHARE" ]] || \
        fail "operator production Share cancellation confirmation token is incorrect"
    observe_journey \
        "production-share-cancelled" \
        "production-share-cancelled.json" \
        --binding-evidence "$LEDGER/pre-production-share.json"
    write_state "awaiting_production_share"
fi

if [[ "$STATE" == "awaiting_production_share" ]]; then
    [[ -f "$LEDGER/production-share-cancelled.json" ]] || \
        fail "resumable production Share state lacks cancellation evidence"
    printf 'ACTION_REQUIRED production-share token=I-COMPLETED-ONE-PRODUCTION-SHARE\n'
    printf 'In Yulu, manually complete exactly one production Share for the same recording and destination, then wait for the verified receipt. Do not retry. Then enter the exact token.\n'
    CONFIRMATION=""
    IFS= read -r CONFIRMATION || fail "operator production Share confirmation was not received"
    [[ "$CONFIRMATION" == "I-COMPLETED-ONE-PRODUCTION-SHARE" ]] || \
        fail "operator production Share confirmation token is incorrect"
    observe_journey \
        "production-share" \
        "production-share.json" \
        --binding-evidence "$LEDGER/pre-production-share.json"
    write_state "awaiting_post_commit_baseline"
fi

if [[ "$STATE" == "awaiting_post_commit_baseline" ]]; then
    [[ -f "$LEDGER/production-share.json" && -f "$LEDGER/bundle-observation.json" ]] || \
        fail "post-commit baseline lacks bound bundle and Share evidence"
    observe_post_commit \
        "post-commit-baseline" \
        "post-commit-baseline.json" \
        "bundle-observation.json" \
        "production-share.json"
    write_state "awaiting_restart_login"
fi

if [[ "$STATE" == "awaiting_restart_login" ]]; then
    [[ -f "$LEDGER/post-commit-baseline.json" ]] || fail "restart/login checkpoint lacks its durable baseline"
    printf 'ACTION_REQUIRED post-commit-restart-login token=I-QUIT-LOGGED-IN-AND-RELAUNCHED-YULU\n'
    printf '%s\n' 'Quit Yulu normally. On the dedicated formal target, log out and log back in, rerun this same verified harness command from the preserved 0700 ledger, relaunch /Applications/Yulu.app yourself, and wait for Host and Capture health. The harness does not open, click, stop, or start the App or services. Then enter the exact token.'
    CONFIRMATION=""
    IFS= read -r CONFIRMATION || fail "operator restart/login confirmation was not received"
    [[ "$CONFIRMATION" == "I-QUIT-LOGGED-IN-AND-RELAUNCHED-YULU" ]] || \
        fail "operator restart/login confirmation token is incorrect"
    observe_bundle_checkpoint "bundle-restart-login.json"
    observe_journey "production-share" "journey-restart-login.json" --binding-evidence "$LEDGER/pre-production-share.json"
    observe_post_commit \
        "post-commit-restart-login" \
        "post-commit-restart-login.json" \
        "bundle-restart-login.json" \
        "journey-restart-login.json" \
        "post-commit-baseline.json"
    write_state "awaiting_no_update"
fi

if [[ "$STATE" == "awaiting_no_update" ]]; then
    [[ -f "$LEDGER/post-commit-restart-login.json" ]] || fail "no-update checkpoint lacks restart/login evidence"
    printf 'ACTION_REQUIRED check-for-updates-no-update token=I-SAW-NO-UPDATE-AVAILABLE-IN-YULU\n'
    printf '%s\n' 'In the running Yulu App, choose Check for Updates… and witness the product UI report that no update is available. Do not substitute a command-line network request or forged response. Yulu exposes no reliable read-only API for this UI outcome, so the token is bound to immediate before/after bundle, update-journal, service, health, IPC, database-schema, and Share evidence. Then enter the exact token.'
    CONFIRMATION=""
    IFS= read -r CONFIRMATION || fail "operator no-update confirmation was not received"
    [[ "$CONFIRMATION" == "I-SAW-NO-UPDATE-AVAILABLE-IN-YULU" ]] || \
        fail "operator no-update confirmation token is incorrect"
    observe_bundle_checkpoint "bundle-no-update.json"
    observe_journey "production-share" "journey-no-update.json" --binding-evidence "$LEDGER/pre-production-share.json"
    observe_post_commit \
        "check-for-updates-no-update" \
        "check-for-updates-no-update.json" \
        "bundle-no-update.json" \
        "journey-no-update.json" \
        "post-commit-restart-login.json"
    write_state "completed"
fi

if [[ "$STATE" == "completed" ]]; then
    [[ -f "$LEDGER/journey-baseline.json" && -f "$LEDGER/journey-core-activation.json" && \
       -f "$LEDGER/pre-test-share.json" && -f "$LEDGER/test-share.json" && \
       -f "$LEDGER/pre-production-share.json" && -f "$LEDGER/production-share-cancelled.json" && \
       -f "$LEDGER/production-share.json" && -f "$LEDGER/post-commit-baseline.json" && \
       -f "$LEDGER/post-commit-restart-login.json" && -f "$LEDGER/check-for-updates-no-update.json" ]] || \
        fail "completed journey state lacks read-only journey evidence"
fi

if [[ "$POLICY_TEST" -eq 1 ]]; then
    printf '{"classification":"harness_policy_test","formalAcceptance":false,"status":"passed"}\n'
else
    printf '{"classification":"formal_public_dmg_journey_observation","formalAcceptance":false,"status":"passed"}\n'
fi
