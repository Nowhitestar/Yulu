#!/bin/bash

set -euo pipefail
umask 077

fail() {
    printf 'prepare_v0_22_2_baseline.sh: %s\n' "$1" >&2
    exit 1
}

has_github_release_provenance() {
    local provenance="$1" canonical_url="$2"
    [[ "$provenance" == *"$canonical_url"* || \
       "$provenance" == *"https://release-assets.githubusercontent.com/"* ]]
}

TAG="v0.22.2"
VERSION="0.22.2"
SOURCE_COMMIT="2d01fa2989c1a9ae1a95266438bb278c72fac8c3"
ARCHIVE_NAME="yulu-macos-arm64-${TAG}.zip"
PUBLIC_BASE="https://github.com/Nowhitestar/Yulu/releases/download/${TAG}"
EXPECTED_CHECKSUMS_URL="$PUBLIC_BASE/checksums.txt"
EXPECTED_INSTALLER_URL="$PUBLIC_BASE/install.sh"
EXPECTED_ARCHIVE_URL="$PUBLIC_BASE/$ARCHIVE_NAME"
FORMAL_CHECKSUMS_SHA256="95f3a7638208cbf54e2688dbd0c872f37a936a295efb650820f254095f25d35e"
FORMAL_INSTALLER_SHA256="53a278b8bae77bcc5f5ddfa7c38f497cfb3451a79ae2edf8d5096e242d89d843"
FORMAL_ARCHIVE_SHA256="f09722cbb312a9fecfe1688526b1b67f7424832694520a9138b1c9c1417ba558"

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)"
LAUNCHER="$SCRIPT_DIR/launch_public_dmg_acceptance.sh"
[[ -f "$LAUNCHER" && ! -L "$LAUNCHER" ]] || fail "harness integrity launcher is missing"
/bin/bash "$LAUNCHER" --verify-only >/dev/null || fail "harness integrity verification failed"
MANIFEST_SHA256="$(/usr/bin/shasum -a 256 "$SCRIPT_DIR/manifest.sha256")"
MANIFEST_SHA256="${MANIFEST_SHA256%% *}"
[[ -n "${YULU_ACCEPTANCE_HARNESS_MANIFEST_SHA256:-}" && \
   "$YULU_ACCEPTANCE_HARNESS_MANIFEST_SHA256" == "$MANIFEST_SHA256" ]] || \
    fail "preparer must be dispatched by the verified harness launcher"

POLICY_TEST=0
CHECKSUMS=""
CHECKSUMS_URL=""
INSTALLER=""
INSTALLER_URL=""
ARCHIVE=""
ARCHIVE_URL=""
INSTALL_DIR_ARG=""
EVIDENCE_DIR_ARG=""
RUN_ID=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --policy-test) POLICY_TEST=1; shift ;;
        --checksums) CHECKSUMS="${2:-}"; shift 2 ;;
        --checksums-url) CHECKSUMS_URL="${2:-}"; shift 2 ;;
        --installer) INSTALLER="${2:-}"; shift 2 ;;
        --installer-url) INSTALLER_URL="${2:-}"; shift 2 ;;
        --archive) ARCHIVE="${2:-}"; shift 2 ;;
        --archive-url) ARCHIVE_URL="${2:-}"; shift 2 ;;
        --install-dir) INSTALL_DIR_ARG="${2:-}"; shift 2 ;;
        --evidence-dir) EVIDENCE_DIR_ARG="${2:-}"; shift 2 ;;
        --run-id) RUN_ID="${2:-}"; shift 2 ;;
        *) fail "unknown argument: $1" ;;
    esac
done

HARNESS_BUILD_MODE=""
IFS= read -r HARNESS_BUILD_MODE < "$SCRIPT_DIR/build-mode.txt" || fail "harness build mode is unreadable"
if [[ "$POLICY_TEST" -eq 1 ]]; then EXPECTED_BUILD_MODE="policy-test"; else EXPECTED_BUILD_MODE="formal"; fi
[[ "$HARNESS_BUILD_MODE" == "$EXPECTED_BUILD_MODE" ]] || fail "harness build mode does not match the baseline execution path"
if [[ -n "${YULU_ACCEPTANCE_HARNESS_BUILD_MODE:-}" && "$YULU_ACCEPTANCE_HARNESS_BUILD_MODE" != "$HARNESS_BUILD_MODE" ]]; then
    fail "launcher and baseline preparer disagree on harness build mode"
fi

[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail "run-id contains unsafe characters"
[[ "$CHECKSUMS_URL" == "$EXPECTED_CHECKSUMS_URL" ]] || fail "checksums must use the exact public v0.22.2 URL"
[[ "$INSTALLER_URL" == "$EXPECTED_INSTALLER_URL" ]] || fail "installer must use the exact public v0.22.2 URL"
[[ "$ARCHIVE_URL" == "$EXPECTED_ARCHIVE_URL" ]] || fail "archive must use the exact public v0.22.2 URL"

if [[ "$POLICY_TEST" -eq 1 ]]; then
    : "${YULU_V022_BASELINE_TEST_BIN:?policy-test requires fake browser metadata commands}"
    : "${YULU_V022_BASELINE_TEST_HOME:?policy-test requires an isolated target home}"
    : "${YULU_V022_BASELINE_TEST_APPLICATIONS:?policy-test requires an isolated Applications root}"
    : "${YULU_V022_BASELINE_TEST_CHECKSUMS_SHA256:?policy-test requires a checksums digest fixture}"
    : "${YULU_V022_BASELINE_TEST_INSTALLER_SHA256:?policy-test requires an installer digest fixture}"
    : "${YULU_V022_BASELINE_TEST_ARCHIVE_SHA256:?policy-test requires an archive digest fixture}"
    [[ "$INSTALL_DIR_ARG" == /* ]] || fail "policy install directory must be absolute"
    [[ "$EVIDENCE_DIR_ARG" == /* ]] || fail "policy evidence directory must be absolute"
    TARGET_HOME="$YULU_V022_BASELINE_TEST_HOME"
    APPLICATIONS_ROOT="$YULU_V022_BASELINE_TEST_APPLICATIONS"
    INSTALL_DIR="$INSTALL_DIR_ARG"
    EVIDENCE_ROOT="$EVIDENCE_DIR_ARG"
    XATTR="$YULU_V022_BASELINE_TEST_BIN/xattr"
    MDLS="$YULU_V022_BASELINE_TEST_BIN/mdls"
    EXPECTED_CHECKSUMS_SHA256="$YULU_V022_BASELINE_TEST_CHECKSUMS_SHA256"
    EXPECTED_INSTALLER_SHA256="$YULU_V022_BASELINE_TEST_INSTALLER_SHA256"
    EXPECTED_ARCHIVE_SHA256="$YULU_V022_BASELINE_TEST_ARCHIVE_SHA256"
    CLASSIFICATION="v0.22.2_baseline_policy_test"
    PUBLIC_ASSET_VERIFIED=false
else
    [[ -z "$INSTALL_DIR_ARG" && -z "$EVIDENCE_DIR_ARG" ]] || \
        fail "formal install and evidence directories are fixed"
    [[ -z "${YULU_V022_BASELINE_TEST_BIN:-}${YULU_V022_BASELINE_TEST_HOME:-}${YULU_V022_BASELINE_TEST_APPLICATIONS:-}${YULU_V022_BASELINE_TEST_CHECKSUMS_SHA256:-}${YULU_V022_BASELINE_TEST_INSTALLER_SHA256:-}${YULU_V022_BASELINE_TEST_ARCHIVE_SHA256:-}" ]] || \
        fail "policy-test overrides are forbidden during formal baseline preparation"
    TARGET_HOME="${HOME:?HOME is required}"
    APPLICATIONS_ROOT="/Applications"
    INSTALL_DIR="$TARGET_HOME/.yulu"
    EVIDENCE_ROOT="$TARGET_HOME/Library/Application Support/Yulu Acceptance"
    XATTR="/usr/bin/xattr"
    MDLS="/usr/bin/mdls"
    EXPECTED_CHECKSUMS_SHA256="$FORMAL_CHECKSUMS_SHA256"
    EXPECTED_INSTALLER_SHA256="$FORMAL_INSTALLER_SHA256"
    EXPECTED_ARCHIVE_SHA256="$FORMAL_ARCHIVE_SHA256"
    CLASSIFICATION="formal_v0.22.2_baseline_observation"
    PUBLIC_ASSET_VERIFIED=true
fi

DURABLE_SYNC="$SCRIPT_DIR/yulu-durable-sync"
for command_path in "$XATTR" "$MDLS" "$DURABLE_SYNC" /usr/bin/shasum /usr/bin/stat /usr/bin/mktemp /usr/bin/grep; do
    [[ -x "$command_path" ]] || fail "required system command is unavailable: ${command_path##*/}"
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
        [[ ! -L "$current" ]] || fail "path contains a symlink component"
    done
}

verify_asset_path() {
    local path="$1" expected_name="$2" expected_url="$3" parent quarantine provenance
    [[ "$path" == /* ]] || fail "$expected_name path must be absolute"
    [[ -f "$path" && ! -L "$path" ]] || fail "$expected_name must be a regular non-symlink browser asset"
    [[ "${path##*/}" == "$expected_name" ]] || fail "$expected_name filename is not exact"
    parent="${path%/*}"
    [[ "$(cd "$parent" && pwd -P)/${path##*/}" == "$path" ]] || fail "$expected_name path is not canonical"
    in_checkout "$path" && fail "$expected_name must not come from a repository checkout"
    quarantine="$($XATTR -p com.apple.quarantine "$path" 2>/dev/null || true)"
    [[ "$quarantine" =~ ^[0-9A-Fa-f]{4}\;[0-9A-Fa-f]{8}\;[^\;]+\;.*$ ]] || \
        fail "$expected_name lacks valid browser quarantine metadata"
    provenance="$($MDLS -raw -name kMDItemWhereFroms "$path" 2>/dev/null || true)"
    has_github_release_provenance "$provenance" "$expected_url" || \
        fail "$expected_name browser provenance contains neither its exact public URL nor GitHub release-assets redirect"
}

verify_asset_path "$CHECKSUMS" "checksums.txt" "$EXPECTED_CHECKSUMS_URL"
verify_asset_path "$INSTALLER" "install.sh" "$EXPECTED_INSTALLER_URL"
verify_asset_path "$ARCHIVE" "$ARCHIVE_NAME" "$EXPECTED_ARCHIVE_URL"

CHECKSUMS_SHA256="$(/usr/bin/shasum -a 256 "$CHECKSUMS")"; CHECKSUMS_SHA256="${CHECKSUMS_SHA256%% *}"
INSTALLER_SHA256="$(/usr/bin/shasum -a 256 "$INSTALLER")"; INSTALLER_SHA256="${INSTALLER_SHA256%% *}"
ARCHIVE_SHA256="$(/usr/bin/shasum -a 256 "$ARCHIVE")"; ARCHIVE_SHA256="${ARCHIVE_SHA256%% *}"
[[ "$CHECKSUMS_SHA256" == "$EXPECTED_CHECKSUMS_SHA256" ]] || fail "checksums.txt digest mismatch"
[[ "$INSTALLER_SHA256" == "$EXPECTED_INSTALLER_SHA256" ]] || fail "install.sh digest mismatch"
[[ "$ARCHIVE_SHA256" == "$EXPECTED_ARCHIVE_SHA256" ]] || fail "v0.22.2 archive digest mismatch"

INSTALLER_ROWS=0
ARCHIVE_ROWS=0
SEEN_NAMES=$'\n'
while IFS= read -r row || [[ -n "$row" ]]; do
    [[ "$row" =~ ^([0-9a-f]{64})[[:space:]][[:space:]]([^[:space:]]+)$ ]] || \
        fail "checksums.txt contains a malformed row"
    row_sha="${BASH_REMATCH[1]}"
    row_name="${BASH_REMATCH[2]}"
    [[ "$SEEN_NAMES" != *$'\n'"$row_name"$'\n'* ]] || fail "checksums.txt contains a duplicate row"
    SEEN_NAMES+="$row_name"$'\n'
    case "$row_name" in
        install.sh)
            INSTALLER_ROWS=$((INSTALLER_ROWS + 1))
            [[ "$row_sha" == "$EXPECTED_INSTALLER_SHA256" ]] || fail "checksums.txt install.sh row has the wrong digest"
            ;;
        "$ARCHIVE_NAME")
            ARCHIVE_ROWS=$((ARCHIVE_ROWS + 1))
            [[ "$row_sha" == "$EXPECTED_ARCHIVE_SHA256" ]] || fail "checksums.txt archive row has the wrong digest"
            ;;
    esac
done < "$CHECKSUMS"
[[ "$INSTALLER_ROWS" -eq 1 && "$ARCHIVE_ROWS" -eq 1 ]] || \
    fail "checksums.txt must contain one exact install.sh row and one exact archive row"

/usr/bin/grep -Fq 'EMBEDDED_HELPER_BASE64=' "$INSTALLER" || fail "public installer lacks an embedded helper"
if /usr/bin/grep -Fq '__YULU_EMBEDDED_RELEASE_INSTALLER_BASE64__' "$INSTALLER"; then
    fail "public installer embedded helper sentinel was not replaced"
fi

for safe_path in "$TARGET_HOME" "$APPLICATIONS_ROOT" "$INSTALL_DIR" "$EVIDENCE_ROOT"; do
    [[ "$safe_path" == /* && "$safe_path" != *$'\n'* && "$safe_path" != *'"'* && "$safe_path" != *'='* ]] || \
        fail "target path is unsafe"
done
[[ "$INSTALL_DIR" != "$TARGET_HOME/Library/Application Support/Yulu" && \
   "$INSTALL_DIR" != "$TARGET_HOME/Library/Application Support/Yulu/"* && \
   "$INSTALL_DIR" != "$APPLICATIONS_ROOT" && "$INSTALL_DIR" != "$APPLICATIONS_ROOT/"* && \
   "$INSTALL_DIR" != *.app && "$INSTALL_DIR" != *.app/* ]] || fail "legacy install directory overlaps the current runtime"
reject_symlink_components "$TARGET_HOME"
reject_symlink_components "$APPLICATIONS_ROOT"
reject_symlink_components "${INSTALL_DIR%/*}"
reject_symlink_components "$EVIDENCE_ROOT"
[[ -d "${INSTALL_DIR%/*}" && ! -L "${INSTALL_DIR%/*}" ]] || fail "legacy install parent must be an existing real directory"

CURRENT_STANDARD_ROOT="$TARGET_HOME/Library/Application Support/Yulu"
CURRENT_APP="$APPLICATIONS_ROOT/Yulu.app"
verify_no_current_runtime() {
    [[ ! -e "$CURRENT_STANDARD_ROOT" && ! -L "$CURRENT_STANDARD_ROOT" ]] || \
        fail "current standard data root or application-migration journal exists"
    [[ ! -e "$CURRENT_APP" && ! -L "$CURRENT_APP" ]] || fail "current Application bundle exists"
}
verify_no_current_runtime

if [[ -e "$EVIDENCE_ROOT" || -L "$EVIDENCE_ROOT" ]]; then
    [[ -d "$EVIDENCE_ROOT" && ! -L "$EVIDENCE_ROOT" && -O "$EVIDENCE_ROOT" ]] || \
        fail "evidence root is unsafe"
else
    /bin/mkdir -p "$EVIDENCE_ROOT"
fi
reject_symlink_components "$EVIDENCE_ROOT"
[[ -d "$EVIDENCE_ROOT" && ! -L "$EVIDENCE_ROOT" && -O "$EVIDENCE_ROOT" ]] || fail "evidence root is unsafe after creation"
/bin/chmod 700 "$EVIDENCE_ROOT"
[[ "$(/usr/bin/stat -f %Lp "$EVIDENCE_ROOT")" == "700" ]] || fail "evidence root mode is unsafe"
LEDGER="$EVIDENCE_ROOT/$RUN_ID"
if [[ -e "$LEDGER" || -L "$LEDGER" ]]; then
    [[ -d "$LEDGER" && ! -L "$LEDGER" && -O "$LEDGER" ]] || fail "evidence ledger is unsafe"
    [[ "$(/usr/bin/stat -f %Lp "$LEDGER")" == "700" ]] || fail "evidence ledger mode is unsafe"
else
    /bin/mkdir -m 700 "$LEDGER"
fi

STATE_FILE="$LEDGER/v0.22.2-baseline.state"
EVIDENCE_FILE="$LEDGER/v0.22.2-baseline.json"
for existing in "$STATE_FILE" "$EVIDENCE_FILE"; do
    if [[ -e "$existing" || -L "$existing" ]]; then
        [[ -f "$existing" && ! -L "$existing" && -O "$existing" && \
           "$(/usr/bin/stat -f %Lp "$existing")" == "600" ]] || fail "baseline evidence file is unsafe"
    fi
done

write_file() {
    local destination="$1" content="$2" temporary
    temporary="$(/usr/bin/mktemp "$LEDGER/.${destination##*/}.XXXXXX")" || fail "could not create evidence temporary"
    [[ -f "$temporary" && ! -L "$temporary" ]] || fail "evidence temporary is unsafe"
    printf '%s\n' "$content" > "$temporary"
    /bin/chmod 600 "$temporary"
    "$DURABLE_SYNC" "$temporary"
    /bin/mv -f "$temporary" "$destination"
    "$DURABLE_SYNC" "$LEDGER"
}

PHASE=""
if [[ -f "$STATE_FILE" ]]; then
    STATE_LINES=0
    STATE_SCHEMA=""; STATE_TAG=""; STATE_COMMIT=""; STATE_CHECKSUMS=""; STATE_INSTALLER=""
    STATE_ARCHIVE=""; STATE_INSTALL_DIR=""; STATE_PHASE=""
    while IFS='=' read -r key value || [[ -n "${key:-}${value:-}" ]]; do
        STATE_LINES=$((STATE_LINES + 1))
        case "$key" in
            schema) [[ -z "$STATE_SCHEMA" ]] || fail "state contains duplicate fields"; STATE_SCHEMA="$value" ;;
            tag) [[ -z "$STATE_TAG" ]] || fail "state contains duplicate fields"; STATE_TAG="$value" ;;
            source_commit) [[ -z "$STATE_COMMIT" ]] || fail "state contains duplicate fields"; STATE_COMMIT="$value" ;;
            checksums_sha256) [[ -z "$STATE_CHECKSUMS" ]] || fail "state contains duplicate fields"; STATE_CHECKSUMS="$value" ;;
            installer_sha256) [[ -z "$STATE_INSTALLER" ]] || fail "state contains duplicate fields"; STATE_INSTALLER="$value" ;;
            archive_sha256) [[ -z "$STATE_ARCHIVE" ]] || fail "state contains duplicate fields"; STATE_ARCHIVE="$value" ;;
            install_dir) [[ -z "$STATE_INSTALL_DIR" ]] || fail "state contains duplicate fields"; STATE_INSTALL_DIR="$value" ;;
            phase) [[ -z "$STATE_PHASE" ]] || fail "state contains duplicate fields"; STATE_PHASE="$value" ;;
            *) fail "state contains an unknown field" ;;
        esac
    done < "$STATE_FILE"
    [[ "$STATE_LINES" -eq 8 && "$STATE_SCHEMA" == "1" && "$STATE_TAG" == "$TAG" && \
       "$STATE_COMMIT" == "$SOURCE_COMMIT" && "$STATE_CHECKSUMS" == "$CHECKSUMS_SHA256" && \
       "$STATE_INSTALLER" == "$INSTALLER_SHA256" && "$STATE_ARCHIVE" == "$ARCHIVE_SHA256" && \
       "$STATE_INSTALL_DIR" == "$INSTALL_DIR" ]] || fail "baseline state is malformed or bound to different inputs"
    case "$STATE_PHASE" in installing|completed) PHASE="$STATE_PHASE" ;; *) fail "baseline state phase is invalid" ;; esac
fi

write_state() {
    local phase="$1" content
    printf -v content 'schema=1\ntag=%s\nsource_commit=%s\nchecksums_sha256=%s\ninstaller_sha256=%s\narchive_sha256=%s\ninstall_dir=%s\nphase=%s' \
        "$TAG" "$SOURCE_COMMIT" "$CHECKSUMS_SHA256" "$INSTALLER_SHA256" "$ARCHIVE_SHA256" "$INSTALL_DIR" "$phase"
    write_file "$STATE_FILE" "$content"
    PHASE="$phase"
}

verify_legacy_install() {
    local version_value metadata
    [[ -d "$INSTALL_DIR" && ! -L "$INSTALL_DIR" && ! -e "$INSTALL_DIR/.git" ]] || \
        fail "legacy v0.22.2 install directory is missing, unsafe, or a checkout"
    [[ -f "$INSTALL_DIR/VERSION" && ! -L "$INSTALL_DIR/VERSION" ]] || fail "legacy VERSION is missing"
    IFS= read -r version_value < "$INSTALL_DIR/VERSION" || fail "legacy VERSION is unreadable"
    [[ "$version_value" == "$VERSION" && "$(/usr/bin/wc -l < "$INSTALL_DIR/VERSION" | /usr/bin/tr -d ' ')" == "1" ]] || \
        fail "legacy VERSION does not equal 0.22.2"
    for runtime_script in "$INSTALL_DIR/yulu/scripts/setup.sh" "$INSTALL_DIR/yulu/scripts/yulu"; do
        [[ -f "$runtime_script" && ! -L "$runtime_script" ]] || fail "legacy runtime scripts are incomplete"
    done
    [[ -f "$INSTALL_DIR/.yulu-install.json" && ! -L "$INSTALL_DIR/.yulu-install.json" ]] || \
        fail "legacy release metadata is missing"
    metadata="$(/bin/cat "$INSTALL_DIR/.yulu-install.json")"
    [[ "$metadata" == *'"source": "release"'* && "$metadata" == *'"version": "v0.22.2"'* && \
       "$metadata" == *'"asset": "yulu-macos-arm64-v0.22.2.zip"'* && \
       "$metadata" == *"\"sha256\": \"$EXPECTED_ARCHIVE_SHA256\""* && \
       "$metadata" != *'"branch"'* && "$metadata" != *'"commit"'* ]] || \
        fail "legacy release metadata does not match the verified public archive"
    verify_no_current_runtime
}

if [[ -z "$PHASE" ]]; then
    [[ ! -e "$INSTALL_DIR" && ! -L "$INSTALL_DIR" ]] || fail "legacy install directory already exists without resumable state"
    write_state "installing"
fi
if [[ "$PHASE" == "installing" ]]; then
    if [[ ! -e "$INSTALL_DIR" && ! -L "$INSTALL_DIR" ]]; then
        if ! INSTALL_DIR="$INSTALL_DIR" /bin/bash "$INSTALLER" --version "$TAG" >/dev/null 2>&1; then
            fail "verified public v0.22.2 installer failed"
        fi
    fi
    verify_legacy_install
    EVIDENCE_JSON="{\"schema\":1,\"classification\":\"$CLASSIFICATION\",\"formalAcceptance\":false,\"status\":\"installed\",\"tag\":\"$TAG\",\"sourceCommit\":\"$SOURCE_COMMIT\",\"digests\":{\"checksums\":\"$CHECKSUMS_SHA256\",\"installer\":\"$INSTALLER_SHA256\",\"archive\":\"$ARCHIVE_SHA256\"},\"urls\":{\"checksums\":\"$EXPECTED_CHECKSUMS_URL\",\"installer\":\"$EXPECTED_INSTALLER_URL\",\"archive\":\"$EXPECTED_ARCHIVE_URL\"},\"installDir\":\"$INSTALL_DIR\",\"version\":\"$VERSION\",\"publicAssetVerified\":$PUBLIC_ASSET_VERIFIED}"
    write_file "$EVIDENCE_FILE" "$EVIDENCE_JSON"
    write_state "completed"
fi

[[ -f "$EVIDENCE_FILE" ]] || fail "completed baseline state lacks evidence"
verify_legacy_install
/bin/cat "$EVIDENCE_FILE"
