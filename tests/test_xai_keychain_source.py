from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "yulu" / "scripts" / "xai_keychain.swift"


def test_xai_oauth_uses_standard_macos_login_keychain():
    source = SOURCE.read_text(encoding="utf-8")

    assert "kSecClassGenericPassword" in source
    assert "kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly" in source
    assert "kSecUseDataProtectionKeychain" not in source
