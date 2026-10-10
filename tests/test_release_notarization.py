"""Signed-only releases must retain every check except Apple's notary ticket."""

import os
import plistlib
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def executable(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + body)
    path.chmod(0o755)


@pytest.fixture
def verifier(tmp_path):
    scripts = tmp_path / "packaging/scripts"
    scripts.mkdir(parents=True)
    shutil.copy2(ROOT / "packaging/scripts/verify_dmg.sh", scripts)
    executable(scripts / "verify_application_runtime.sh", 'echo runtime >> "$TEST_LOG"\n')
    mount = tmp_path / "mounted"
    (mount / "Yulu.app").mkdir(parents=True)
    (mount / "Applications").symlink_to("/Applications")
    attach = tmp_path / "attach.plist"
    attach.write_bytes(plistlib.dumps({"system-entities": [{"mount-point": str(mount)}]}))
    volume = tmp_path / "volume.plist"
    volume.write_bytes(plistlib.dumps({"VolumeName": "Yulu"}))
    dmg = tmp_path / "release.dmg"
    dmg.write_bytes(b"fixture")
    bin_dir = tmp_path / "bin"
    executable(bin_dir / "codesign", '''
echo "codesign $*" >> "$TEST_LOG"
if [[ "$1" == "--verify" ]]; then exit "${TEST_SEAL_STATUS:-0}"; fi
printf 'Authority=%s\nTeamIdentifier=%s\n' \
  "${TEST_AUTHORITY:-Developer ID Application: Yulu}" "${TEST_TEAM:-WMU9678ZQL}" >&2
''')
    executable(bin_dir / "spctl", '''
echo "spctl $*" >> "$TEST_LOG"
printf 'fixture: rejected\nsource=%s\n' "${TEST_GATEKEEPER_SOURCE:-Unnotarized Developer ID}" >&2
exit "${TEST_GATEKEEPER_STATUS:-3}"
''')
    executable(bin_dir / "xcrun", 'echo notary >> "$TEST_LOG"\nexit 65\n')
    executable(bin_dir / "hdiutil", '''
echo "hdiutil $1" >> "$TEST_LOG"
if [[ "$1" == "attach" ]]; then cat "$TEST_ATTACH"; fi
''')
    executable(bin_dir / "diskutil", 'cat "$TEST_VOLUME"\n')
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}",
               TEST_LOG=str(tmp_path / "calls.log"), TEST_ATTACH=str(attach),
               TEST_VOLUME=str(volume))
    env.pop("YULU_RELEASE_NOTARIZATION", None)
    env.pop("YULU_EXPECTED_TEAM_ID", None)

    def invoke(**overrides):
        result = subprocess.run(["bash", str(scripts / "verify_dmg.sh"), str(dmg)],
                                env=env | overrides, capture_output=True, text=True)
        log = Path(env["TEST_LOG"])
        return result, log.read_text() if log.exists() else ""

    return invoke


def test_signed_only_verifies_app_dmg_and_runtime_without_tickets(verifier):
    result, calls = verifier(YULU_RELEASE_NOTARIZATION="skip")
    assert result.returncode == 0, result.stderr
    assert "Open Anyway" in result.stdout
    assert calls.count("codesign --verify") == 2
    assert calls.count("spctl ") == 2
    assert "runtime\n" in calls
    assert "hdiutil detach" in calls
    assert "notary\n" not in calls


@pytest.mark.parametrize("overrides", [
    {"TEST_TEAM": "FOREIGN000"},
    {"TEST_AUTHORITY": "Apple Development: Yulu"},
    {"TEST_SEAL_STATUS": "1"},
    {"TEST_GATEKEEPER_SOURCE": "revoked Developer ID"},
    {"TEST_GATEKEEPER_SOURCE": "no usable signature"},
    {"TEST_GATEKEEPER_SOURCE": "Unnotarized Developer ID (revoked)"},
    {"TEST_GATEKEEPER_STATUS": "77"},
])
def test_signed_only_rejects_failures_other_than_missing_notarization(verifier, overrides):
    result, calls = verifier(YULU_RELEASE_NOTARIZATION="skip", **overrides)
    assert result.returncode != 0
    assert "runtime\n" not in calls


def test_default_verification_still_requires_a_notary_ticket(verifier):
    result, calls = verifier()
    assert result.returncode != 0
    assert "notary\n" in calls
    assert "hdiutil attach" not in calls


def test_unknown_notarization_mode_is_rejected_before_verification(verifier):
    result, calls = verifier(YULU_RELEASE_NOTARIZATION="optional")
    assert result.returncode != 0
    assert "required or skip" in result.stderr
    assert calls == ""


@pytest.fixture
def signer(tmp_path):
    scripts = tmp_path / "packaging/scripts"
    scripts.mkdir(parents=True)
    shutil.copy2(ROOT / "packaging/scripts/sign_and_notarize.sh", scripts)
    (scripts / "build_local_caption_runtime_pack.py").write_text(
        "import pathlib, sys\n"
        "pathlib.Path(sys.argv[sys.argv.index('--output') + 1]).write_bytes(b'fixture')\n"
    )
    executable(tmp_path / "yulu/scripts/build_audio_daemon.sh",
               'mkdir -p "$TEST_ROOT/yulu/scripts/Yulu.app"\n')
    executable(scripts / "verify_application_runtime.sh", 'echo runtime >> "$TEST_LOG"\n')
    executable(scripts / "package.sh", '''
echo package >> "$TEST_LOG"
printf fixture > "$TEST_ROOT/dist/yulu-macos-arm64-$1.dmg"
''')
    executable(scripts / "verify_dmg.sh",
               'echo "verify-dmg:${YULU_RELEASE_NOTARIZATION:-required}" >> "$TEST_LOG"\n')
    bin_dir = tmp_path / "bin"
    executable(bin_dir / "security", "exit 0\n")
    executable(bin_dir / "codesign", 'echo codesign >> "$TEST_LOG"\n')
    executable(bin_dir / "ditto", 'printf fixture > "${@: -1}"\n')
    executable(bin_dir / "xcrun", 'echo notary >> "$TEST_LOG"\nexit 98\n')
    runner = tmp_path / "runner"
    runner.mkdir()
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("ASC_", "YULU_")) and key not in {"P12_PWD", "KEYCHAIN_PWD"}}
    env.update(PATH=f"{bin_dir}:{os.environ['PATH']}", TEST_ROOT=str(tmp_path),
               TEST_LOG=str(tmp_path / "calls.log"), RUNNER_TEMP=str(runner),
               TAG="v0.27.2", YULU_CODESIGN_IDENTITY="test-identity",
               YULU_CODESIGN_P12_BASE64="Zml4dHVyZQ==", P12_PWD="fixture", KEYCHAIN_PWD="fixture")

    def invoke(arguments=(), **overrides):
        result = subprocess.run(["bash", str(scripts / "sign_and_notarize.sh"), *arguments],
                                env=env | overrides, capture_output=True, text=True)
        log = Path(env["TEST_LOG"])
        return result, log.read_text() if log.exists() else ""

    return invoke


def test_explicit_signed_only_build_does_not_require_notary_credentials(signer):
    result, calls = signer(YULU_RELEASE_NOTARIZATION="skip")
    assert result.returncode == 0, result.stderr
    assert "codesign\n" in calls
    assert "runtime\n" in calls
    assert "package\n" in calls
    assert "verify-dmg:skip\n" in calls
    assert "notary\n" not in calls


def test_default_signing_still_requires_notary_credentials(signer):
    result, calls = signer()
    assert result.returncode != 0
    assert "ASC_KEY_P8_BASE64" in result.stderr
    assert calls == ""


def test_notary_failure_never_falls_back_to_signed_only(signer):
    result, calls = signer(ASC_KEY_P8_BASE64="Zml4dHVyZQ==", ASC_KEY_ID="fixture", ASC_ISSUER_ID="fixture")
    assert result.returncode == 98
    assert "notary\n" in calls
    assert "package\n" not in calls
    assert "verify-dmg:" not in calls


def test_internal_validation_cannot_silently_drop_notarization(signer):
    result, calls = signer(arguments=("--validation",), YULU_RELEASE_NOTARIZATION="skip",
                           GITHUB_ACTIONS="true", YULU_RELEASE_VERSION="0.27.2-dev.ci.1")
    assert result.returncode == 64
    assert "require notarization" in result.stderr
    assert calls == ""


def test_release_selects_signed_only_without_changing_internal_validation():
    release = (ROOT / ".github/workflows/release-publish.yml").read_text()
    assert "YULU_RELEASE_NOTARIZATION: skip" in release
    assert "secrets.ASC_KEY" not in release
    assert "secrets.ASC_ISSUER_ID" not in release
    assert "YULU_CODESIGN_P12_BASE64" in release
    assert "YULU_SPARKLE_PRIVATE_ED_KEY" in release
    internal = (ROOT / ".github/workflows/application-validation.yml").read_text()
    assert "YULU_RELEASE_NOTARIZATION" not in internal
