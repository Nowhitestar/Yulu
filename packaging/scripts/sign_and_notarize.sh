#!/usr/bin/env bash
# Build and publish one Developer ID-signed Application Runtime inside one DMG.
# Nested code is signed bottom-up by build_audio_daemon.sh. This helper then
# notarizes/staples the immutable App, creates the drag-to-Applications DMG,
# signs/notarizes/staples that final DMG, and verifies the mounted public bytes.
set -euo pipefail

UPDATE_RELEASE_MODE=0
VALIDATION_ONLY=0
if [[ $# -gt 1 ]]; then
  echo "usage: sign_and_notarize.sh [--update-release|--validation]" >&2
  exit 64
fi
if [[ $# -eq 1 ]]; then
  [[ "$1" == "--update-release" || "$1" == "--validation" ]] || {
    echo "usage: sign_and_notarize.sh [--update-release|--validation]" >&2
    exit 64
  }
  if [[ "$1" == "--update-release" ]]; then
    UPDATE_RELEASE_MODE=1
  else
    VALIDATION_ONLY=1
    [[ "${GITHUB_ACTIONS:-}" == "true" && "${YULU_RELEASE_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+-dev\.ci\.[1-9][0-9]*$ ]] || {
      echo "Validation signing requires CI and an explicit dev.ci build identity" >&2
      exit 64
    }
    # Validation Apps cannot check for or publish updates.
    unset YULU_SPARKLE_FEED_URL YULU_SPARKLE_PUBLIC_ED_KEY YULU_SPARKLE_PRIVATE_ED_KEY
  fi
fi

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "::error::sign_and_notarize.sh: required secret \$$name is not set" >&2
    exit 1
  fi
}

require_update_env() {
  [[ "$UPDATE_RELEASE_MODE" == "1" ]] && require_env "$1"
  return 0
}

verify_sparkle_key_pair() {
  command -v node >/dev/null 2>&1 || {
    echo "::error::sign_and_notarize.sh: Node.js is required to verify the Sparkle key pair" >&2
    exit 1
  }
  # The JavaScript template expression is intentionally protected from Bash.
  # shellcheck disable=SC2016
  printf '%s\n' "$SPARKLE_PRIVATE_ED_KEY" | node -e '
    const { createPrivateKey, createPublicKey, timingSafeEqual } = require("node:crypto");
    let encoded = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { encoded += chunk; });
    process.stdin.on("end", () => {
      try {
        const secret = Buffer.from(encoded.trim(), "base64");
        let actualPublic;
        if (secret.length === 32) {
          const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
          const privateKey = createPrivateKey({
            key: Buffer.concat([pkcs8Prefix, secret]),
            format: "der",
            type: "pkcs8",
          });
          const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
          actualPublic = spki.subarray(-32);
        } else if (secret.length === 96) {
          actualPublic = secret.subarray(64);
        } else {
          throw new Error("private key must decode to Sparkle seed or legacy key-pair format");
        }
        const expectedPublic = Buffer.from(process.argv[1].trim(), "base64");
        if (expectedPublic.length !== 32 || !timingSafeEqual(actualPublic, expectedPublic)) {
          throw new Error("public and private Sparkle keys do not match");
        }
      } catch (error) {
        process.stderr.write(`sign_and_notarize.sh: ${error.message}\n`);
        process.exitCode = 1;
      }
    });
  ' "$YULU_SPARKLE_PUBLIC_ED_KEY"
}

require_env YULU_CODESIGN_IDENTITY
require_env YULU_CODESIGN_P12_BASE64
require_env P12_PWD
require_env KEYCHAIN_PWD
require_env ASC_KEY_P8_BASE64
require_env ASC_KEY_ID
require_env ASC_ISSUER_ID
require_update_env YULU_SPARKLE_FEED_URL
require_update_env YULU_SPARKLE_PUBLIC_ED_KEY
require_update_env YULU_SPARKLE_PRIVATE_ED_KEY
require_update_env YULU_RELEASE_VERSION
require_update_env YULU_BUNDLE_SHORT_VERSION
require_update_env YULU_BUILD_NUMBER
: "${RUNNER_TEMP:?RUNNER_TEMP must be set (GitHub Actions provides it)}"
: "${TAG:?TAG must be set to the release tag}"

# Keep the update-signing key out of the exported environment inherited by the
# build, codesign, notary, hdiutil, and verification subprocesses below.
SPARKLE_PRIVATE_ED_KEY="${YULU_SPARKLE_PRIVATE_ED_KEY:-}"
unset YULU_SPARKLE_PRIVATE_ED_KEY

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPTS_DIR="$REPO_DIR/yulu/scripts"
YULU_APP="$SCRIPTS_DIR/Yulu.app"

KEYCHAIN="$RUNNER_TEMP/yulu-signing.keychain-db"
CERT_P12="$RUNNER_TEMP/cert.p12"
ASC_KEY_P8="$RUNNER_TEMP/asc_key.p8"
SPARKLE_TOOLS="$RUNNER_TEMP/yulu-sparkle-tools"
LOCAL_CAPTION_PACK="$REPO_DIR/dist/yulu-local-caption-runtime-macos-arm64-$TAG.zip"
DMG="$REPO_DIR/dist/yulu-macos-arm64-$TAG.dmg"

if [[ "$UPDATE_RELEASE_MODE" == "1" ]]; then
  verify_sparkle_key_pair
fi

echo "Importing Developer ID certificate into ephemeral keychain"
printf '%s' "$YULU_CODESIGN_P12_BASE64" | base64 --decode > "$CERT_P12"
security create-keychain -p "$KEYCHAIN_PWD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PWD" "$KEYCHAIN"
security import "$CERT_P12" -k "$KEYCHAIN" -P "$P12_PWD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  -k "$KEYCHAIN_PWD" "$KEYCHAIN" >/dev/null
# shellcheck disable=SC2046
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')

# This remains a separate, integrity-checked Optional Runtime Pack. It is not an
# installation alternative and is deliberately absent from the DMG.
mkdir -p "$REPO_DIR/dist"
if [[ "$VALIDATION_ONLY" == "0" ]]; then
  python3 "$REPO_DIR/packaging/scripts/build_local_caption_runtime_pack.py" \
    --identity "$YULU_CODESIGN_IDENTITY" \
    --output "$LOCAL_CAPTION_PACK"
  [[ -s "$LOCAL_CAPTION_PACK" ]] || {
    echo "::error::sign_and_notarize.sh: local caption Runtime Pack was not built" >&2
    exit 1
  }
fi

# build_audio_daemon.sh owns bottom-up hardened-runtime signing for every nested
# executable, native addon, Sparkle component, Capture helper, and outer App.
echo "Building and signing the immutable Yulu.app"
YULU_BUNDLE_APPLICATION_RUNTIME=1 \
  YULU_SPARKLE_TOOLS_DIR="$SPARKLE_TOOLS" \
  bash "$SCRIPTS_DIR/build_audio_daemon.sh"
codesign --verify --deep --strict --verbose=2 "$YULU_APP"
if [[ "$UPDATE_RELEASE_MODE" == "1" ]]; then
  YULU_REQUIRE_SPARKLE_CONFIGURATION=1 \
    bash "$REPO_DIR/packaging/scripts/verify_application_runtime.sh" "$YULU_APP"
else
  bash "$REPO_DIR/packaging/scripts/verify_application_runtime.sh" "$YULU_APP"
fi

printf '%s' "$ASC_KEY_P8_BASE64" | base64 --decode > "$ASC_KEY_P8"

notarize_app() {
  local app="$1" archive
  archive="$RUNNER_TEMP/$(basename "$app" .app)-notarize.zip"
  ditto -c -k --keepParent "$app" "$archive"
  # ASC_KEY_ID is required indirectly by require_env above.
  # shellcheck disable=SC2153
  xcrun notarytool submit "$archive" \
    --key "$ASC_KEY_P8" \
    --key-id "$ASC_KEY_ID" \
    --issuer "$ASC_ISSUER_ID" \
    --wait
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
  rm -f "$archive"
}

notarize_app "$YULU_APP"

if [[ "$VALIDATION_ONLY" == "1" ]]; then
  # Only an immutable whole App is handed off. No DMG, Release or appcast is
  # created, and the local machine's login keychain is never involved.
  ditto -c -k --keepParent "$YULU_APP" "$REPO_DIR/dist/yulu-validation-app.zip"
  (
    cd "$REPO_DIR/dist"
    shasum -a 256 yulu-validation-app.zip > validation-checksums.txt
  )
  echo "Signed, notarized validation App ready; nothing was published."
  exit 0
fi

# Package only the already immutable/stapled App. No build or signing step may
# mutate Yulu.app after this point.
bash "$REPO_DIR/packaging/scripts/package.sh" "$TAG" \
  --dist "$REPO_DIR/dist" --skip-build >/dev/null
[[ -s "$DMG" ]] || {
  echo "::error::sign_and_notarize.sh: DMG was not built: $DMG" >&2
  exit 1
}

# A disk image is signed as a container; hardened-runtime options belong to the
# executable code already signed inside Yulu.app, not to the DMG itself.
codesign --force --timestamp --sign "$YULU_CODESIGN_IDENTITY" "$DMG"
codesign --verify --strict --verbose=2 "$DMG"
# ASC_KEY_ID is required indirectly by require_env above.
# shellcheck disable=SC2153
xcrun notarytool submit "$DMG" \
  --key "$ASC_KEY_P8" \
  --key-id "$ASC_KEY_ID" \
  --issuer "$ASC_ISSUER_ID" \
  --wait
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
bash "$REPO_DIR/packaging/scripts/verify_dmg.sh" "$DMG"

if [[ "$UPDATE_RELEASE_MODE" == "1" ]]; then
  [[ -x "$SPARKLE_TOOLS/generate_appcast" && -x "$SPARKLE_TOOLS/sign_update" ]] || {
    echo "::error::sign_and_notarize.sh: pinned Sparkle release tools are missing" >&2
    exit 1
  }
  APPCAST_WORK="$(mktemp -d "$RUNNER_TEMP/yulu-appcast.XXXXXX")"
  DOWNLOAD_URL_PREFIX="${YULU_SPARKLE_DOWNLOAD_URL_PREFIX:-https://github.com/Nowhitestar/Yulu/releases/download/$TAG/}"
  python3 - "$DOWNLOAD_URL_PREFIX" <<'PY'
import sys
from urllib.parse import urlsplit

url = urlsplit(sys.argv[1])
if (
    url.scheme.lower() != "https"
    or not url.hostname
    or url.username is not None
    or url.password is not None
    or url.query
    or url.fragment
    or not url.path.endswith("/")
):
    raise SystemExit("invalid Sparkle download URL prefix")
PY
  cp "$DMG" "$APPCAST_WORK/$(basename "$DMG")"
  printf '%s\n' "$SPARKLE_PRIVATE_ED_KEY" | \
    "$SPARKLE_TOOLS/generate_appcast" \
      --ed-key-file - \
      --download-url-prefix "$DOWNLOAD_URL_PREFIX" \
      --maximum-deltas 0 \
      "$APPCAST_WORK"
  [[ -s "$APPCAST_WORK/appcast.xml" ]] || {
    echo "::error::sign_and_notarize.sh: Sparkle appcast was not generated" >&2
    rm -rf "$APPCAST_WORK"
    exit 1
  }
  ENCLOSURE_SIGNATURE="$(
    python3 "$SCRIPT_DIR/validate_sparkle_appcast.py" \
      "$APPCAST_WORK/appcast.xml" "$TAG" "$DOWNLOAD_URL_PREFIX" "$DMG"
  )"
  printf '%s\n' "$SPARKLE_PRIVATE_ED_KEY" | \
    "$SPARKLE_TOOLS/sign_update" \
      --ed-key-file - --verify "$DMG" "$ENCLOSURE_SIGNATURE"
  printf '%s\n' "$SPARKLE_PRIVATE_ED_KEY" | \
    "$SPARKLE_TOOLS/sign_update" \
      --ed-key-file - --verify "$APPCAST_WORK/appcast.xml"
  cp "$APPCAST_WORK/appcast.xml" "$REPO_DIR/dist/appcast.xml"
  rm -rf "$APPCAST_WORK"
fi

echo "Signed, notarized, and stapled release DMG: $DMG"
