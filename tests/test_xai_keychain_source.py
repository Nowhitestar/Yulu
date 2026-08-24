from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "yulu" / "scripts" / "xai_keychain.swift"
MANAGER_SOURCE = ROOT / "yulu" / "scripts" / "yulu_ui" / "src" / "xaiCredentials.ts"


def test_xai_oauth_uses_standard_macos_login_keychain():
    source = SOURCE.read_text(encoding="utf-8")

    assert "kSecClassGenericPassword" in source
    assert "kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly" in source
    assert "kSecUseDataProtectionKeychain" not in source


def test_xai_oauth_pins_official_grok_cli_identity_and_reviewed_scopes():
    source = MANAGER_SOURCE.read_text(encoding="utf-8")

    assert 'const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"' in source
    assert (
        'const XAI_OAUTH_SCOPE = "openid profile email offline_access '
        'grok-cli:access api:access"'
    ) in source


def test_provider_secret_slots_keep_values_off_argv_and_validate_slot_names():
    source = SOURCE.read_text(encoding="utf-8")

    assert "FileHandle.standardInput.readDataToEndOfFile()" in source
    assert 'slot == "direct.xai"' in source
    assert "gateway." not in source
    assert "provider-secret" in source
