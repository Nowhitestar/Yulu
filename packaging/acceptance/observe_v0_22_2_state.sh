#!/bin/bash

set -euo pipefail
umask 077
export LC_ALL=C

fail() {
    printf 'observe_v0_22_2_state.sh: %s\n' "$1" >&2
    exit 1
}

TAG="v0.22.2"
SOURCE_COMMIT="2d01fa2989c1a9ae1a95266438bb278c72fac8c3"
CHECKSUMS_SHA256="95f3a7638208cbf54e2688dbd0c872f37a936a295efb650820f254095f25d35e"
INSTALLER_SHA256="53a278b8bae77bcc5f5ddfa7c38f497cfb3451a79ae2edf8d5096e242d89d843"
ARCHIVE_SHA256="f09722cbb312a9fecfe1688526b1b67f7424832694520a9138b1c9c1417ba558"
CONFIRMATION="I-PREPARED-V022-REPRESENTATIVE-STATE"

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)"
LAUNCHER="$SCRIPT_DIR/launch_public_dmg_acceptance.sh"
[[ -f "$LAUNCHER" && ! -L "$LAUNCHER" ]] || fail "harness integrity launcher is missing"
/bin/bash "$LAUNCHER" --verify-only >/dev/null || fail "harness integrity verification failed"
MANIFEST_SHA256="$(/usr/bin/shasum -a 256 "$SCRIPT_DIR/manifest.sha256")"
MANIFEST_SHA256="${MANIFEST_SHA256%% *}"
[[ -n "${YULU_ACCEPTANCE_HARNESS_MANIFEST_SHA256:-}" &&
   "$YULU_ACCEPTANCE_HARNESS_MANIFEST_SHA256" == "$MANIFEST_SHA256" ]] ||
    fail "observer must be dispatched by the verified harness launcher"

POLICY_TEST=0
RUN_ID=""
EVIDENCE_DIR_ARG=""
INSTALL_DIR_ARG=""
RECORDING=""
KEYCHAIN_ACCOUNT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --policy-test) POLICY_TEST=1; shift ;;
        --run-id) RUN_ID="${2:-}"; shift 2 ;;
        --evidence-dir) EVIDENCE_DIR_ARG="${2:-}"; shift 2 ;;
        --install-dir) INSTALL_DIR_ARG="${2:-}"; shift 2 ;;
        --recording) RECORDING="${2:-}"; shift 2 ;;
        --keychain-account) KEYCHAIN_ACCOUNT="${2:-}"; shift 2 ;;
        *) fail "unknown argument: $1" ;;
    esac
done

HARNESS_BUILD_MODE=""
IFS= read -r HARNESS_BUILD_MODE < "$SCRIPT_DIR/build-mode.txt" || fail "harness build mode is unreadable"
if [[ "$POLICY_TEST" -eq 1 ]]; then EXPECTED_BUILD_MODE="policy-test"; else EXPECTED_BUILD_MODE="formal"; fi
[[ "$HARNESS_BUILD_MODE" == "$EXPECTED_BUILD_MODE" ]] || fail "harness build mode does not match the state-observer execution path"
if [[ -n "${YULU_ACCEPTANCE_HARNESS_BUILD_MODE:-}" && "$YULU_ACCEPTANCE_HARNESS_BUILD_MODE" != "$HARNESS_BUILD_MODE" ]]; then
    fail "launcher and state observer disagree on harness build mode"
fi

[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail "run-id contains unsafe characters"
[[ "$KEYCHAIN_ACCOUNT" =~ ^token:default:[A-Za-z0-9@._+-]+$ ]] || fail "gogcli Keychain account is unsafe or malformed"

if [[ "$POLICY_TEST" -eq 1 ]]; then
    : "${YULU_V022_STATE_TEST_BIN:?policy-test requires isolated system command fixtures}"
    : "${YULU_V022_STATE_TEST_HOME:?policy-test requires an isolated target home}"
    : "${YULU_V022_STATE_TEST_APPLICATIONS:?policy-test requires an isolated Applications root}"
    [[ "$EVIDENCE_DIR_ARG" == /* && "$INSTALL_DIR_ARG" == /* ]] || fail "policy paths must be absolute"
    TARGET_HOME="$YULU_V022_STATE_TEST_HOME"
    APPLICATIONS_ROOT="$YULU_V022_STATE_TEST_APPLICATIONS"
    EVIDENCE_ROOT="$EVIDENCE_DIR_ARG"
    INSTALL_DIR="$INSTALL_DIR_ARG"
    LAUNCHCTL="$YULU_V022_STATE_TEST_BIN/launchctl"
    PS="$YULU_V022_STATE_TEST_BIN/ps"
    LSOF="$YULU_V022_STATE_TEST_BIN/lsof"
    SECURITY="$YULU_V022_STATE_TEST_BIN/security"
    CLASSIFICATION="v0.22.2_representative_state_policy_test"
    BOUND_CHECKSUMS_SHA256="${YULU_V022_BASELINE_TEST_CHECKSUMS_SHA256:?policy-test requires the prepared checksums fixture digest}"
    BOUND_INSTALLER_SHA256="${YULU_V022_BASELINE_TEST_INSTALLER_SHA256:?policy-test requires the prepared installer fixture digest}"
    BOUND_ARCHIVE_SHA256="${YULU_V022_BASELINE_TEST_ARCHIVE_SHA256:?policy-test requires the prepared archive fixture digest}"
    BASELINE_CLASSIFICATION="v0.22.2_baseline_policy_test"
    BASELINE_PUBLIC_ASSET_VERIFIED="false"
else
    [[ -z "$EVIDENCE_DIR_ARG" && -z "$INSTALL_DIR_ARG" ]] || fail "formal legacy and evidence paths are fixed"
    [[ -z "${YULU_V022_STATE_TEST_BIN:-}${YULU_V022_STATE_TEST_HOME:-}${YULU_V022_STATE_TEST_APPLICATIONS:-}" ]] ||
        fail "policy-test overrides are forbidden during formal observation"
    TARGET_HOME="${HOME:?HOME is required}"
    APPLICATIONS_ROOT="/Applications"
    EVIDENCE_ROOT="$TARGET_HOME/Library/Application Support/Yulu Acceptance"
    INSTALL_DIR="$TARGET_HOME/.yulu"
    LAUNCHCTL="/bin/launchctl"
    PS="/bin/ps"
    LSOF="/usr/sbin/lsof"
    SECURITY="/usr/bin/security"
    CLASSIFICATION="formal_v0.22.2_representative_state_observation"
    BOUND_CHECKSUMS_SHA256="$CHECKSUMS_SHA256"
    BOUND_INSTALLER_SHA256="$INSTALLER_SHA256"
    BOUND_ARCHIVE_SHA256="$ARCHIVE_SHA256"
    BASELINE_CLASSIFICATION="formal_v0.22.2_baseline_observation"
    BASELINE_PUBLIC_ASSET_VERIFIED="true"
fi

PLISTBUDDY="/usr/libexec/PlistBuddy"
PLUTIL="/usr/bin/plutil"
SQLITE="/usr/bin/sqlite3"
SHASUM="/usr/bin/shasum"
STAT="/usr/bin/stat"
MKTEMP="/usr/bin/mktemp"
UID_VALUE="$(/usr/bin/id -u)"
DURABLE_SYNC="$SCRIPT_DIR/yulu-durable-sync"
for command_path in "$LAUNCHCTL" "$PS" "$LSOF" "$SECURITY" "$DURABLE_SYNC" "$PLISTBUDDY" "$PLUTIL" "$SQLITE" "$SHASUM" "$STAT" "$MKTEMP"; do
    [[ -x "$command_path" ]] || fail "required read-only system command is unavailable: ${command_path##*/}"
done

safe_path() {
    [[ "$1" == /* && "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" != *$'\t'* && "$1" != *'"'* && "$1" != *"'"* && "$1" != *$'\\'* && "$1" != *'='* ]] ||
        fail "path contains unsafe characters"
}

reject_symlink_components() {
    local remaining="${1#/}" current="" component
    while [[ -n "$remaining" ]]; do
        if [[ "$remaining" == */* ]]; then component="${remaining%%/*}"; remaining="${remaining#*/}"; else component="$remaining"; remaining=""; fi
        [[ -n "$component" ]] || continue
        current="$current/$component"
        [[ ! -L "$current" ]] || fail "path contains a symlink component"
    done
}

owned_regular() {
    local path="$1" description="$2" mode
    [[ -f "$path" && ! -L "$path" && -O "$path" ]] || fail "$description must be an owned regular non-symlink file"
    mode="$($STAT -f %Lp "$path")"
    case "$mode" in 600|640|644) ;; *) fail "$description permissions are unsafe" ;; esac
}

hash_file() {
    local value
    value="$($SHASUM -a 256 "$1")"
    printf '%s' "${value%% *}"
}

hash_text() {
    local value
    value="$(printf '%s' "$1" | $SHASUM -a 256)"
    printf '%s' "${value%% *}"
}

canonical_file() {
    local path="$1" parent
    parent="${path%/*}"
    printf '%s/%s' "$(cd "$parent" && pwd -P)" "${path##*/}"
}

for path in "$TARGET_HOME" "$APPLICATIONS_ROOT" "$EVIDENCE_ROOT" "$INSTALL_DIR" "$RECORDING"; do safe_path "$path"; done
reject_symlink_components "$TARGET_HOME"
reject_symlink_components "$APPLICATIONS_ROOT"
reject_symlink_components "$EVIDENCE_ROOT"
reject_symlink_components "$INSTALL_DIR"
reject_symlink_components "$RECORDING"
[[ -d "$TARGET_HOME" && ! -L "$TARGET_HOME" && -O "$TARGET_HOME" ]] || fail "target home is unsafe"
[[ -d "$APPLICATIONS_ROOT" && ! -L "$APPLICATIONS_ROOT" ]] || fail "Applications root is unsafe"
[[ -d "$INSTALL_DIR" && ! -L "$INSTALL_DIR" && ! -e "$INSTALL_DIR/.git" ]] || fail "verified legacy install is missing or unsafe"
if [[ "$POLICY_TEST" -eq 0 ]]; then
    [[ "$INSTALL_DIR" == "$TARGET_HOME/.yulu" ]] || fail "formal legacy install must use ~/.yulu"
fi
[[ ! -e "$TARGET_HOME/Library/Application Support/Yulu" && ! -L "$TARGET_HOME/Library/Application Support/Yulu" ]] ||
    fail "current standard data root already exists"
[[ ! -e "$APPLICATIONS_ROOT/Yulu.app" && ! -L "$APPLICATIONS_ROOT/Yulu.app" ]] || fail "current App already exists"

[[ -d "$EVIDENCE_ROOT" && ! -L "$EVIDENCE_ROOT" && -O "$EVIDENCE_ROOT" ]] || fail "baseline evidence root is missing or unsafe"
LEDGER="$EVIDENCE_ROOT/$RUN_ID"
[[ -d "$LEDGER" && ! -L "$LEDGER" && -O "$LEDGER" && "$($STAT -f %Lp "$LEDGER")" == "700" ]] || fail "baseline evidence ledger is missing or unsafe"
BASELINE_STATE="$LEDGER/v0.22.2-baseline.state"
BASELINE_EVIDENCE="$LEDGER/v0.22.2-baseline.json"
owned_regular "$BASELINE_STATE" "baseline state"
owned_regular "$BASELINE_EVIDENCE" "baseline evidence"
BASELINE_STATE_CONTENT="$(/bin/cat "$BASELINE_STATE")"
[[ "$BASELINE_STATE_CONTENT" == *$'tag=v0.22.2\n'* &&
   "$BASELINE_STATE_CONTENT" == *$'source_commit=2d01fa2989c1a9ae1a95266438bb278c72fac8c3\n'* &&
   "$BASELINE_STATE_CONTENT" == *"checksums_sha256=$BOUND_CHECKSUMS_SHA256"$'\n'* &&
   "$BASELINE_STATE_CONTENT" == *"installer_sha256=$BOUND_INSTALLER_SHA256"$'\n'* &&
   "$BASELINE_STATE_CONTENT" == *"archive_sha256=$BOUND_ARCHIVE_SHA256"$'\n'* &&
   "$BASELINE_STATE_CONTENT" == *$'phase=completed' ]] || fail "baseline state is not the completed public v0.22.2 baseline"
[[ "$($PLUTIL -extract tag raw -o - "$BASELINE_EVIDENCE")" == "$TAG" &&
   "$($PLUTIL -extract sourceCommit raw -o - "$BASELINE_EVIDENCE")" == "$SOURCE_COMMIT" &&
   "$($PLUTIL -extract digests.checksums raw -o - "$BASELINE_EVIDENCE")" == "$BOUND_CHECKSUMS_SHA256" &&
   "$($PLUTIL -extract digests.installer raw -o - "$BASELINE_EVIDENCE")" == "$BOUND_INSTALLER_SHA256" &&
   "$($PLUTIL -extract digests.archive raw -o - "$BASELINE_EVIDENCE")" == "$BOUND_ARCHIVE_SHA256" &&
   "$($PLUTIL -extract status raw -o - "$BASELINE_EVIDENCE")" == "installed" &&
   "$($PLUTIL -extract classification raw -o - "$BASELINE_EVIDENCE")" == "$BASELINE_CLASSIFICATION" &&
   "$($PLUTIL -extract publicAssetVerified raw -o - "$BASELINE_EVIDENCE")" == "$BASELINE_PUBLIC_ASSET_VERIFIED" ]] ||
    fail "baseline evidence is malformed, cross-mode, or bound to another release"
BASELINE_INSTALL_DIR="$($PLUTIL -extract installDir raw -o - "$BASELINE_EVIDENCE")"
[[ "$BASELINE_INSTALL_DIR" == "$INSTALL_DIR" ]] || fail "baseline install directory binding drifted"
INSTALL_EVIDENCE_SHA256="$(hash_file "$BASELINE_EVIDENCE")"

[[ "$RECORDING" == "$TARGET_HOME/Movies/Yulu/"* && "$RECORDING" == *.wav ]] || fail "recording must be a legacy Yulu WAV"
[[ "${RECORDING##*/}" =~ ^[A-Za-z0-9._-]+\.wav$ ]] || fail "recording filename is unsafe"
owned_regular "$RECORDING" "representative recording"
[[ "$(canonical_file "$RECORDING")" == "$RECORDING" ]] || fail "recording path is not canonical"
STEM="${RECORDING##*/}"
STEM="${STEM%.wav}"
TRANSCRIPT="${RECORDING%.wav}.transcript.txt"
SUMMARY="${RECORDING%.wav}.summary.md"
owned_regular "$TRANSCRIPT" "representative transcript"
owned_regular "$SUMMARY" "representative summary"
[[ "$($STAT -f %z "$RECORDING")" -gt 0 && "$($STAT -f %z "$TRANSCRIPT")" -gt 0 && "$($STAT -f %z "$SUMMARY")" -gt 0 ]] ||
    fail "representative recording artifacts must be non-empty"

STATE_FILE="$LEDGER/v0.22.2-representative-state.state"
EVIDENCE_FILE="$LEDGER/v0.22.2-representative-state.json"
for existing in "$STATE_FILE" "$EVIDENCE_FILE"; do
    if [[ -e "$existing" || -L "$existing" ]]; then
        owned_regular "$existing" "representative-state ledger file"
        [[ "$($STAT -f %Lp "$existing")" == "600" ]] || fail "representative-state ledger file mode is unsafe"
    fi
done

write_file() {
    local destination="$1" content="$2" temporary
    temporary="$($MKTEMP "$LEDGER/.${destination##*/}.XXXXXX")" || fail "could not create evidence temporary"
    [[ -f "$temporary" && ! -L "$temporary" && -O "$temporary" ]] || fail "evidence temporary is unsafe"
    printf '%s\n' "$content" > "$temporary"
    /bin/chmod 600 "$temporary"
    "$DURABLE_SYNC" "$temporary"
    /bin/mv -f "$temporary" "$destination"
    "$DURABLE_SYNC" "$LEDGER"
}

ACCOUNT_SHA256="$(hash_text "$KEYCHAIN_ACCOUNT")"
INITIAL_BINDING="$(printf 'schema=1\ntag=%s\nsource_commit=%s\nchecksums_sha256=%s\ninstaller_sha256=%s\narchive_sha256=%s\ninstall_evidence_sha256=%s\ninstall_dir=%s\nrecording=%s\nkeychain_account_sha256=%s' \
    "$TAG" "$SOURCE_COMMIT" "$BOUND_CHECKSUMS_SHA256" "$BOUND_INSTALLER_SHA256" "$BOUND_ARCHIVE_SHA256" "$INSTALL_EVIDENCE_SHA256" "$INSTALL_DIR" "$RECORDING" "$ACCOUNT_SHA256")"
PHASE=""
STATE_CONTENT=""
if [[ -f "$STATE_FILE" ]]; then
    STATE_CONTENT="$(/bin/cat "$STATE_FILE")"
    case "$STATE_CONTENT" in
        "$INITIAL_BINDING"$'\nphase=awaiting_operator') PHASE="awaiting_operator" ;;
        "$INITIAL_BINDING"$'\nphase=observing') PHASE="observing" ;;
        "$INITIAL_BINDING"$'\nphase=completed\nevidence_sha256='[0-9a-f]*) PHASE="completed" ;;
        *) fail "representative-state resume binding is malformed or drifted" ;;
    esac
fi

write_phase() {
    local phase="$1" evidence_sha="${2:-}" content
    content="$INITIAL_BINDING"$'\nphase='"$phase"
    [[ "$phase" != "completed" ]] || content+=$'\nevidence_sha256='"$evidence_sha"
    write_file "$STATE_FILE" "$content"
    PHASE="$phase"
}

if [[ -z "$PHASE" ]]; then write_phase "awaiting_operator"; fi
if [[ "$PHASE" == "awaiting_operator" ]]; then
    printf '%s\n' 'ACTION_REQUIRED: In the verified public v0.22.2 UI/CLI, keep Host and Capture running; create one real recording and wait for transcript + summary; set auto-send to Notion on; keep Google Calendar disabled despite its gogcli credential; do not install the current App or run any migration.' >&2
    printf 'Type %s to attest the representative legacy state is ready: ' "$CONFIRMATION" >&2
    IFS= read -r operator_confirmation || fail "operator confirmation is required"
    [[ "$operator_confirmation" == "$CONFIRMATION" ]] || fail "operator confirmation token did not match"
    write_phase "observing"
fi

CONFIG_DIR="$TARGET_HOME/.config/yulu"
CONFIG="$CONFIG_DIR/config.json"
MCP_TOKEN="$CONFIG_DIR/mcp-token.json"
SOCKET="$CONFIG_DIR/audio_daemon.sock"
for node in "$CONFIG" "$MCP_TOKEN"; do owned_regular "$node" "legacy configuration input"; done
[[ -S "$SOCKET" && ! -L "$SOCKET" && -O "$SOCKET" ]] || fail "legacy Capture socket is missing or unsafe"
[[ "$($STAT -f %u "$SOCKET")" == "$UID_VALUE" ]] || fail "legacy Capture socket owner is wrong"

AUTO_SEND="$($PLUTIL -extract agent_pipeline.auto_send_notion raw -o - "$CONFIG" 2>/dev/null || true)"
GOOGLE_TYPE="$($PLUTIL -extract calendars.1.type raw -o - "$CONFIG" 2>/dev/null || true)"
GOOGLE_ENABLED="$($PLUTIL -extract calendars.1.enabled raw -o - "$CONFIG" 2>/dev/null || true)"
GOOGLE_ACCOUNT="$($PLUTIL -extract calendars.1.gog_account raw -o - "$CONFIG" 2>/dev/null || true)"
OUTPUT_DIR="$($PLUTIL -extract audio.output_dir raw -o - "$CONFIG" 2>/dev/null || true)"
NOTION_DESTINATION="$($PLUTIL -extract agent_pipeline.notion_destination raw -o - "$CONFIG" 2>/dev/null || true)"
[[ "$AUTO_SEND" == "true" || "$AUTO_SEND" == "1" ]] || fail "representative legacy config must set auto_send_notion=true"
[[ "$GOOGLE_TYPE" == "google" && ( "$GOOGLE_ENABLED" == "false" || "$GOOGLE_ENABLED" == "0" ) ]] ||
    fail "representative optional state must keep Google Calendar disabled"
[[ -n "$GOOGLE_ACCOUNT" && "$KEYCHAIN_ACCOUNT" == "token:default:$GOOGLE_ACCOUNT" ]] || fail "gogcli Keychain account does not bind to the weak optional state"
[[ "$OUTPUT_DIR" == "$TARGET_HOME/Movies/Yulu" ]] || fail "legacy audio output directory is not canonical"
[[ -n "$NOTION_DESTINATION" ]] || fail "representative legacy Notion destination is missing"
CONFIG_SHA256="$(hash_file "$CONFIG")"
MCP_TOKEN_SHA256="$(hash_file "$MCP_TOKEN")"
GOOGLE_ACCOUNT_SHA256="$(hash_text "$GOOGLE_ACCOUNT")"
NOTION_DESTINATION_SHA256="$(hash_text "$NOTION_DESTINATION")"

LAUNCH_AGENTS="$TARGET_HOME/Library/LaunchAgents"
[[ -d "$LAUNCH_AGENTS" && ! -L "$LAUNCH_AGENTS" ]] || fail "legacy LaunchAgents directory is missing or unsafe"
LAUNCH_LABELS=(
    com.yulu.agentqueue
    com.yulu.audiodaemon
    com.yulu.calendar
    com.yulu.detector
    com.yulu.scheduler
    com.yulu.statusagent
    com.yulu.sttdaemon
    com.yulu.ui
)
ACTUAL_PLISTS=("$LAUNCH_AGENTS"/com.yulu.*.plist)
if [[ -e "${ACTUAL_PLISTS[0]}" || -L "${ACTUAL_PLISTS[0]}" ]]; then
    for actual_plist in "${ACTUAL_PLISTS[@]}"; do
        actual_label="${actual_plist##*/}"
        actual_label="${actual_label%.plist}"
        case "$actual_label" in
            com.yulu.agentqueue|com.yulu.audiodaemon|com.yulu.calendar|com.yulu.detector|com.yulu.scheduler|com.yulu.statusagent|com.yulu.sttdaemon|com.yulu.ui) ;;
            *) fail "legacy LaunchAgent plist is outside the migration allowlist" ;;
        esac
    done
fi
DISABLED_OUTPUT="$($LAUNCHCTL print-disabled "gui/$UID_VALUE" 2>/dev/null)" || fail "could not read launchd disabled state"
JOBS_JSON=""
HOST_PID=""
CAPTURE_PID=""
PRESENT_PLIST_COUNT=0
for label in "${LAUNCH_LABELS[@]}"; do
    plist="$LAUNCH_AGENTS/$label.plist"
    present=false
    loaded=false
    disabled=false
    service_output=""
    pid=""
    if service_output="$($LAUNCHCTL print "gui/$UID_VALUE/$label" 2>/dev/null)"; then loaded=true; fi
    if printf '%s\n' "$DISABLED_OUTPUT" | /usr/bin/grep -Fq "\"$label\" => true"; then disabled=true; fi
    pid="$(printf '%s\n' "$service_output" | /usr/bin/awk '/pid = [0-9]+/{print $3; exit}')"
    plist_sha=null
    plist_bytes=null
    plist_mode=null
    args_sha=null
    path_sha=null
    if [[ -e "$plist" || -L "$plist" ]]; then
        present=true
        PRESENT_PLIST_COUNT=$((PRESENT_PLIST_COUNT + 1))
        owned_regular "$plist" "legacy LaunchAgent plist"
        plist_label="$($PLISTBUDDY -c 'Print :Label' "$plist" 2>/dev/null || true)"
        [[ "$plist_label" == "$label" ]] || fail "legacy LaunchAgent label is malformed"
        arg0="$($PLISTBUDDY -c 'Print :ProgramArguments:0' "$plist" 2>/dev/null || true)"
        arg1="$($PLISTBUDDY -c 'Print :ProgramArguments:1' "$plist" 2>/dev/null || true)"
        arg2="$($PLISTBUDDY -c 'Print :ProgramArguments:2' "$plist" 2>/dev/null || true)"
        arg3="$($PLISTBUDDY -c 'Print :ProgramArguments:3' "$plist" 2>/dev/null || true)"
        path_value="$($PLISTBUDDY -c 'Print :EnvironmentVariables:PATH' "$plist" 2>/dev/null || true)"
        case "$label" in
            com.yulu.audiodaemon)
                [[ "$arg0" == "$INSTALL_DIR/yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon" && -z "$arg1$arg2$arg3" ]] ||
                    fail "legacy Capture plist does not match public v0.22.2"
                ;;
            com.yulu.statusagent)
                [[ "$arg0" == "/usr/bin/open" && "$arg1" == "-W" && "$arg2" == "$INSTALL_DIR/yulu/scripts/StatusAgent.app" && -z "$arg3" ]] ||
                    fail "legacy StatusAgent plist does not match public v0.22.2"
                ;;
            com.yulu.ui)
                [[ "$arg0" == /* && "$arg1" == "$INSTALL_DIR/yulu/scripts/yulu_ui/dist/server.js" && -z "$arg2$arg3" && -n "$path_value" ]] ||
                    fail "legacy Host plist does not match public v0.22.2"
                ;;
            com.yulu.scheduler)
                [[ "$arg0" == /* && "$arg1" == "$INSTALL_DIR/yulu/scripts/scheduler_daemon.py" && -z "$arg2$arg3" && -n "$path_value" ]] ||
                    fail "legacy scheduler plist does not match public v0.22.2"
                ;;
            com.yulu.detector)
                [[ "$arg0" == /* && "$arg1" == "$INSTALL_DIR/yulu/scripts/meeting_detector.py" && "$arg2" == "daemon" && -z "$arg3" && -n "$path_value" ]] ||
                    fail "legacy detector plist does not match public v0.22.2"
                ;;
            com.yulu.calendar)
                [[ "$arg0" == /* && "$arg1" == "$INSTALL_DIR/yulu/scripts/run_calendar_services.py" && -z "$arg2$arg3" && -n "$path_value" ]] ||
                    fail "legacy calendar plist does not match public v0.22.2"
                ;;
            com.yulu.agentqueue|com.yulu.sttdaemon)
                fail "obsolete public v0.22.2 LaunchAgent plist must be absent"
                ;;
        esac
        program_arguments="$($PLUTIL -extract ProgramArguments json -o - "$plist" 2>/dev/null || true)"
        [[ -n "$program_arguments" && "${#program_arguments}" -le 65536 ]] || fail "legacy LaunchAgent arguments are empty or exceeded the read limit"
        plist_sha="\"$(hash_file "$plist")\""
        plist_bytes="$($STAT -f %z "$plist")"
        plist_mode="\"$($STAT -f %Lp "$plist")\""
        args_sha="\"$(hash_text "$program_arguments")\""
        if [[ -n "$path_value" ]]; then path_sha="\"$(hash_text "$path_value")\""; fi
    fi
    case "$label" in
        com.yulu.audiodaemon|com.yulu.detector|com.yulu.scheduler|com.yulu.statusagent|com.yulu.ui)
            [[ "$present" == true ]] || fail "required public v0.22.2 LaunchAgent plist is absent"
            ;;
        com.yulu.agentqueue|com.yulu.sttdaemon)
            [[ "$present" == false && "$loaded" == false ]] || fail "obsolete public v0.22.2 job is still present or loaded"
            ;;
    esac
    [[ "$present" == true || "$loaded" == false ]] || fail "launchd job is loaded without its allowlisted plist"
    [[ -z "$JOBS_JSON" ]] || JOBS_JSON+=","
    JOBS_JSON+="{\"label\":\"$label\",\"present\":$present,\"plistSha256\":$plist_sha,\"plistBytes\":$plist_bytes,\"plistMode\":$plist_mode,\"loaded\":$loaded,\"disabled\":$disabled,\"pid\":${pid:-null},\"programArgumentsSha256\":$args_sha,\"pathSha256\":$path_sha}"
    case "$label" in
        com.yulu.ui) [[ "$loaded" == true && "$pid" =~ ^[1-9][0-9]*$ ]] || fail "legacy Host is not running"; HOST_PID="$pid" ;;
        com.yulu.audiodaemon) [[ "$loaded" == true && "$pid" =~ ^[1-9][0-9]*$ ]] || fail "legacy Capture is not running"; CAPTURE_PID="$pid" ;;
    esac
done

HOST_COMMAND="$($PS -p "$HOST_PID" -o command= 2>/dev/null || true)"
CAPTURE_COMMAND="$($PS -p "$CAPTURE_PID" -o command= 2>/dev/null || true)"
HOST_TARGET="$INSTALL_DIR/yulu/scripts/yulu_ui/dist/server.js"
CAPTURE_TARGET="$INSTALL_DIR/yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon"
[[ "$HOST_COMMAND" == *"$HOST_TARGET"* && "$CAPTURE_COMMAND" == "$CAPTURE_TARGET"* ]] || fail "legacy Host or Capture process target is not rooted in the verified install"
HOST_EXECUTABLE="${HOST_COMMAND%% *}"
CAPTURE_EXECUTABLE="${CAPTURE_COMMAND%% *}"
safe_path "$HOST_EXECUTABLE"
safe_path "$CAPTURE_EXECUTABLE"
[[ "$HOST_EXECUTABLE" == /* && "$CAPTURE_EXECUTABLE" == "$CAPTURE_TARGET" ]] || fail "legacy Host or Capture executable path is invalid"
SOCKET_PIDS="$($LSOF -t "$SOCKET" 2>/dev/null || true)"
[[ " ${SOCKET_PIDS//$'\n'/ } " == *" $CAPTURE_PID "* ]] || fail "legacy Capture does not own its socket"

# security without -g/-w prints item metadata only. Bound its output before parsing.
KEYCHAIN_ATTRIBUTES="$($SECURITY find-generic-password -s gogcli -a "$KEYCHAIN_ACCOUNT" 2>/dev/null | /usr/bin/head -c 65537)" || fail "gogcli Keychain item is missing"
[[ "${#KEYCHAIN_ATTRIBUTES}" -le 65536 ]] || fail "gogcli Keychain attributes exceeded the read limit"
[[ "$KEYCHAIN_ATTRIBUTES" != *$'password:'* && "$KEYCHAIN_ATTRIBUTES" == *'"acct"'* && "$KEYCHAIN_ATTRIBUTES" == *'"svce"'* &&
   "$KEYCHAIN_ATTRIBUTES" == *"$KEYCHAIN_ACCOUNT"* && "$KEYCHAIN_ATTRIBUTES" == *'gogcli'* ]] ||
    fail "gogcli Keychain attributes output is unsafe or incomplete"
ATTRIBUTES_SHA256="$(hash_text "$KEYCHAIN_ATTRIBUTES")"
PERSISTENT_IDENTITY_SHA256="$(hash_text "gogcli"$'\n'"$KEYCHAIN_ACCOUNT")"
ATTRIBUTE_COUNT="$(printf '%s\n' "$KEYCHAIN_ATTRIBUTES" | /usr/bin/grep -c '<blob>=' || true)"
[[ "$ATTRIBUTE_COUNT" -ge 2 ]] || fail "gogcli Keychain attributes are incomplete"

DBS_JSON=""
WAL_JSON=""
WAL_FOUND=0
for wal_db_name in prompts vocab search host; do
    wal="$CONFIG_DIR/$wal_db_name.sqlite-wal"
    if [[ -e "$wal" || -L "$wal" ]]; then
        owned_regular "$wal" "$wal_db_name SQLite WAL"
        [[ "$($STAT -f %z "$wal")" -gt 0 ]] || fail "$wal_db_name SQLite WAL is empty"
        if [[ "$WAL_FOUND" -eq 0 ]]; then
            WAL_JSON="{\"database\":\"$wal_db_name\",\"sha256\":\"$(hash_file "$wal")\",\"bytes\":$($STAT -f %z "$wal"),\"preExisting\":true}"
        fi
        WAL_FOUND=$((WAL_FOUND + 1))
    fi
done
[[ "$WAL_FOUND" -ge 1 ]] || fail "a pre-existing WAL sidecar produced by the running legacy Host is required"
for db_name in prompts vocab search host; do
    db="$CONFIG_DIR/$db_name.sqlite"
    owned_regular "$db" "$db_name SQLite database"
    quick="$($SQLITE -readonly -cmd 'PRAGMA query_only=ON;' "$db" 'PRAGMA quick_check;' 2>/dev/null | /usr/bin/head -c 1025 || true)"
    [[ "$quick" == "ok" ]] || fail "$db_name SQLite quick_check failed"
    schema="$($SQLITE -readonly -cmd 'PRAGMA query_only=ON;' "$db" "SELECT type || '|' || name || '|' || IFNULL(sql,'') FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name;" 2>/dev/null | /usr/bin/head -c 1048577 || true)"
    [[ -n "$schema" && "${#schema}" -le 1048576 ]] || fail "$db_name SQLite schema is empty or exceeded the read limit"
    case "$db_name" in
        prompts) query="SELECT slug || '|' || category || '|' || is_auto_run FROM prompts ORDER BY slug LIMIT 1;" ;;
        vocab) query="SELECT term || '|' || canonical || '|' || enabled FROM custom_words ORDER BY term LIMIT 1;" ;;
        search) query="SELECT source_path || '|' || sha256 FROM docs_meta WHERE source_path='$TRANSCRIPT' LIMIT 1;" ;;
        host) query="SELECT id || '|' || recording_stem || '|' || state || '|' || send_to_notion FROM agent_tasks WHERE recording_stem='$STEM' ORDER BY created_at DESC LIMIT 1;" ;;
    esac
    sentinel="$($SQLITE -readonly -cmd 'PRAGMA query_only=ON;' "$db" "$query" 2>/dev/null | /usr/bin/head -c 65537 || true)"
    [[ -n "$sentinel" && "${#sentinel}" -le 65536 ]] || fail "$db_name SQLite representative sentinel is missing or exceeded the read limit"
    [[ -z "$DBS_JSON" ]] || DBS_JSON+=","
    DBS_JSON+="\"$db_name\":{\"quickCheck\":\"ok\",\"sha256\":\"$(hash_file "$db")\",\"bytes\":$($STAT -f %z "$db"),\"mode\":\"$($STAT -f %Lp "$db")\",\"schemaSha256\":\"$(hash_text "$schema")\",\"sentinelSha256\":\"$(hash_text "$sentinel")\"}"
done

media_json() {
    local path="$1"
    printf '{"path":"%s","device":%s,"inode":%s,"bytes":%s,"mode":"%s","sha256":"%s"}' \
        "$path" "$($STAT -f %d "$path")" "$($STAT -f %i "$path")" "$($STAT -f %z "$path")" "$($STAT -f %Lp "$path")" "$(hash_file "$path")"
}

EVIDENCE_JSON="{\"schema\":1,\"classification\":\"$CLASSIFICATION\",\"formalAcceptance\":false,\"status\":\"migration_before_captured\",\"tag\":\"$TAG\",\"sourceCommit\":\"$SOURCE_COMMIT\",\"binding\":{\"checksumsSha256\":\"$BOUND_CHECKSUMS_SHA256\",\"installerSha256\":\"$BOUND_INSTALLER_SHA256\",\"archiveSha256\":\"$BOUND_ARCHIVE_SHA256\",\"installEvidenceSha256\":\"$INSTALL_EVIDENCE_SHA256\"},\"legacyRuntime\":{\"installDir\":\"$INSTALL_DIR\",\"hostRunning\":true,\"hostPid\":$HOST_PID,\"hostExecutablePath\":\"$HOST_EXECUTABLE\",\"hostTargetPath\":\"$HOST_TARGET\",\"captureRunning\":true,\"capturePid\":$CAPTURE_PID,\"captureExecutablePath\":\"$CAPTURE_EXECUTABLE\",\"socketPath\":\"$SOCKET\",\"socketOwnedByCapture\":true,\"launchAgentOwnerCount\":${#LAUNCH_LABELS[@]},\"presentLaunchAgentCount\":$PRESENT_PLIST_COUNT,\"launchAgents\":[$JOBS_JSON]},\"media\":{\"audio\":$(media_json "$RECORDING"),\"transcript\":$(media_json "$TRANSCRIPT"),\"summary\":$(media_json "$SUMMARY")},\"databases\":{\"allQuickCheckOk\":true,\"walPreExisting\":true,\"wal\":$WAL_JSON,\"items\":{$DBS_JSON}},\"config\":{\"configSha256\":\"$CONFIG_SHA256\",\"autoSendNotion\":true,\"notionDestinationSha256\":\"$NOTION_DESTINATION_SHA256\",\"googleCalendarEnabled\":false,\"googleCalendarAccountSha256\":\"$GOOGLE_ACCOUNT_SHA256\",\"keychainAccountMatchesGoogleCalendar\":true,\"mcpTokenSha256\":\"$MCP_TOKEN_SHA256\"},\"keychain\":{\"service\":\"gogcli\",\"account\":\"$KEYCHAIN_ACCOUNT\",\"attributeCount\":$ATTRIBUTE_COUNT,\"attributesSha256\":\"$ATTRIBUTES_SHA256\",\"persistentIdentitySha256\":\"$PERSISTENT_IDENTITY_SHA256\"}}"

if [[ "$PHASE" == "completed" ]]; then
    [[ -f "$EVIDENCE_FILE" ]] || fail "completed representative-state lacks evidence"
    EXPECTED_EVIDENCE_SHA="${STATE_CONTENT##*$'\nevidence_sha256='}"
    [[ "$EXPECTED_EVIDENCE_SHA" =~ ^[0-9a-f]{64}$ && "$(hash_file "$EVIDENCE_FILE")" == "$EXPECTED_EVIDENCE_SHA" && "$(/bin/cat "$EVIDENCE_FILE")" == "$EVIDENCE_JSON" ]] ||
        fail "completed representative-state evidence drifted"
else
    write_file "$EVIDENCE_FILE" "$EVIDENCE_JSON"
    EVIDENCE_SHA256="$(hash_file "$EVIDENCE_FILE")"
    write_phase "completed" "$EVIDENCE_SHA256"
fi

/bin/cat "$EVIDENCE_FILE"
