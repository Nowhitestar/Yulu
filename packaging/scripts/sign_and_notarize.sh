#!/usr/bin/env bash
# Yulu CI signing + notarization helper (D-06 / D-08 / D-09).
#
# Runs ONLY in GitHub Actions (release-publish.yml). It:
#   1. Imports the "Developer ID Application" cert from a secret into an
#      ephemeral keychain so headless `codesign` finds the identity without a
#      UI password prompt (Pattern 3).
#   2. Builds + bottom-up hardened-runtime signs both .app bundles by running
#      the existing build_*.sh (they read $YULU_CODESIGN_IDENTITY).
#   3. For each bundle: `ditto -c -k --keepParent` to a throwaway zip (notarytool
#      rejects a bare .app), `xcrun notarytool submit --wait` with App Store
#      Connect API-key auth, then `xcrun stapler staple` + `stapler validate`
#      the .app DIRECTORY (Pattern 2 / Pitfall 4).
#
# CRITICAL ORDERING (Pitfall 4): the .app DIRECTORY is stapled here, BEFORE the
# caller runs `make package --skip-build` to zip it. The staple therefore travels
# inside the release asset. Stapling the throwaway notarization zip would be
# useless. This script does NOT zip the release asset and does NOT re-run the
# build after stapling.
#
# SECURITY (D-08): every credential arrives via an environment variable sourced
# from a GitHub Actions secret — NO secret value is ever a literal in this file.
# Secrets are decoded to files under RUNNER_TEMP and NEVER echoed; `set -x` is
# deliberately NOT used so the decode/sign lines cannot leak into the run log.
# Keychain teardown + decoded-file removal is the caller's if:always() step
# (Pattern 3) so cleanup runs even if this script fails mid-way.
#
# Required environment (names only — values come from GitHub Actions secrets):
#   YULU_CODESIGN_IDENTITY   "Developer ID Application: <name> (<TeamID>)"
#   YULU_CODESIGN_P12_BASE64 base64 of the Developer ID Application .p12
#   P12_PWD                  password the .p12 was exported with
#   KEYCHAIN_PWD             password for the ephemeral CI keychain (caller's choice)
#   ASC_KEY_P8_BASE64        base64 of the App Store Connect API key .p8
#   ASC_KEY_ID               App Store Connect API Key ID
#   ASC_ISSUER_ID            App Store Connect Issuer ID
#   RUNNER_TEMP              provided by GitHub Actions
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPTS_DIR="$REPO_DIR/yulu/scripts"

# The two bundles ship signed + notarized + stapled in the release zip.
# build_status_agent.sh also signs the standalone recorder_status helper that
# meeting_daemon.py launches for the floating recording window.
YULU_APP="$SCRIPTS_DIR/Yulu.app"
STATUS_APP="$SCRIPTS_DIR/StatusAgent.app"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    # Print only the VARIABLE NAME, never the value.
    echo "::error::sign_and_notarize.sh: required secret \$$name is not set" >&2
    exit 1
  fi
}

require_env YULU_CODESIGN_IDENTITY
require_env YULU_CODESIGN_P12_BASE64
require_env P12_PWD
require_env KEYCHAIN_PWD
require_env ASC_KEY_P8_BASE64
require_env ASC_KEY_ID
require_env ASC_ISSUER_ID
: "${RUNNER_TEMP:?RUNNER_TEMP must be set (GitHub Actions provides it)}"

KEYCHAIN="$RUNNER_TEMP/yulu-signing.keychain-db"
CERT_P12="$RUNNER_TEMP/cert.p12"
ASC_KEY_P8="$RUNNER_TEMP/asc_key.p8"

# --- Keychain import (Pattern 3) -------------------------------------------
# Decode the cert from the secret to a file (never echoed) and import it into a
# fresh keychain. set-keychain-settings -lut keeps the keychain from auto-locking
# during the long notarization wait; set-key-partition-list avoids codesign's
# errSecInternalComponent. The caller's if:always() step deletes the keychain.
echo "Importing Developer ID certificate into ephemeral keychain"
printf '%s' "$YULU_CODESIGN_P12_BASE64" | base64 --decode > "$CERT_P12"

security create-keychain -p "$KEYCHAIN_PWD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PWD" "$KEYCHAIN"
security import "$CERT_P12" -k "$KEYCHAIN" -P "$P12_PWD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PWD" "$KEYCHAIN" >/dev/null
# Prepend our keychain to the user search list so codesign finds the identity.
# shellcheck disable=SC2046
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')

# --- Build + bottom-up hardened-runtime sign (Pattern 1, via build_*.sh) ----
# The build scripts read $YULU_CODESIGN_IDENTITY and sign inner-Mach-O-then-bundle
# with -o runtime + --entitlements + --timestamp. They are the single source of
# signing truth; we only orchestrate keychain + notarization around them.
echo "Building + signing Yulu.app and StatusAgent.app (bottom-up, hardened runtime)"
bash "$SCRIPTS_DIR/build_audio_daemon.sh"
bash "$SCRIPTS_DIR/build_status_agent.sh"

# --- Notarize + staple (Pattern 2 / Pitfall 4) -----------------------------
# Decode the App Store Connect API key once (never echoed).
printf '%s' "$ASC_KEY_P8_BASE64" | base64 --decode > "$ASC_KEY_P8"

notarize_and_staple() {
  local app="$1"
  local name
  name="$(basename "$app" .app)"
  local zip="$RUNNER_TEMP/$name-notarize.zip"

  if [[ ! -d "$app" ]]; then
    echo "::error::sign_and_notarize.sh: expected bundle missing: $app" >&2
    exit 1
  fi

  echo "Notarizing $name.app"
  # notarytool will not accept a bare .app — it needs a zip/dmg/pkg.
  ditto -c -k --keepParent "$app" "$zip"

  # --wait blocks until Apple returns Accepted/Invalid; no custom polling.
  # ASC_KEY_ID / ASC_ISSUER_ID are env vars sourced from GitHub Actions secrets
  # (shellcheck can't see the env assignment, hence SC2153).
  # shellcheck disable=SC2153
  xcrun notarytool submit "$zip" \
    --key "$ASC_KEY_P8" \
    --key-id "$ASC_KEY_ID" \
    --issuer "$ASC_ISSUER_ID" \
    --wait

  # Staple the TICKET to the on-disk .app DIRECTORY (NOT the throwaway zip) so
  # the bundle that `make package` zips next carries the ticket and passes
  # Gatekeeper offline / on a clean machine (Pitfall 4).
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  rm -f "$zip"
  echo "Stapled + validated $name.app"
}

notarize_and_staple "$YULU_APP"
notarize_and_staple "$STATUS_APP"

echo "Sign + notarize + staple complete for Yulu.app and StatusAgent.app"
