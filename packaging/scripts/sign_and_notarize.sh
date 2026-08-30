#!/usr/bin/env bash
# Build and publish one Developer ID-signed Application Runtime inside one DMG.
# Nested code is signed bottom-up by build_audio_daemon.sh. This helper then
# notarizes/staples the immutable App, creates the drag-to-Applications DMG,
# signs/notarizes/staples that final DMG, and verifies the mounted public bytes.
set -euo pipefail

UPDATE_RELEASE_MODE=0
if [[ $# -gt 1 ]]; then
  echo "usage: sign_and_notarize.sh [--update-release]" >&2
  exit 64
fi
if [[ $# -eq 1 ]]; then
  [[ "$1" == "--update-release" ]] || {
    echo "usage: sign_and_notarize.sh [--update-release]" >&2
    exit 64
  }
  UPDATE_RELEASE_MODE=1
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
python3 "$REPO_DIR/packaging/scripts/build_local_caption_runtime_pack.py" \
  --identity "$YULU_CODESIGN_IDENTITY" \
  --output "$LOCAL_CAPTION_PACK"
[[ -s "$LOCAL_CAPTION_PACK" ]] || {
  echo "::error::sign_and_notarize.sh: local caption Runtime Pack was not built" >&2
  exit 1
}

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
  SIGNATURE_FILE="$APPCAST_WORK/enclosure-signature.txt"
  python3 - "$APPCAST_WORK/appcast.xml" "$TAG" "$DOWNLOAD_URL_PREFIX" \
    "$SIGNATURE_FILE" "$DMG" <<'PY'
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

appcast = Path(sys.argv[1])
tag = sys.argv[2]
download_prefix = sys.argv[3]
signature_file = Path(sys.argv[4])
dmg = Path(sys.argv[5])
sparkle = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"
root = ET.parse(appcast).getroot()
enclosures = list(root.iter("enclosure"))
expected_name = f"yulu-macos-arm64-{tag}.dmg"
if len(enclosures) != 1:
    raise SystemExit("Sparkle feed must contain exactly one full DMG enclosure")
enclosure = enclosures[0]
if enclosure.get("url") != download_prefix + expected_name:
    raise SystemExit("Sparkle feed does not reference the public release DMG")
length = enclosure.get("length")
expected_length = dmg.stat().st_size
if length is None or not length.isdecimal() or int(length) != expected_length:
    raise SystemExit("Sparkle feed enclosure length does not match the public release DMG")
signature = enclosure.get(f"{sparkle}edSignature")
if not signature:
    raise SystemExit("Sparkle feed DMG enclosure is not EdDSA-signed")
if list(root.iter(f"{sparkle}deltas")):
    raise SystemExit("Yulu does not publish Sparkle delta payloads")
if any(path.suffix == ".delta" for path in appcast.parent.iterdir()):
    raise SystemExit("Yulu does not publish Sparkle delta artifacts")
signature_file.write_text(signature + "\n", encoding="utf-8")
PY
  ENCLOSURE_SIGNATURE="$(tr -d '[:space:]' < "$SIGNATURE_FILE")"
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
