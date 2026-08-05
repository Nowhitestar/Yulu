# xAI Keychain missing entitlement

## Symptom

The xAI device flow completes and returns tokens, but Yulu reports that it cannot save OAuth to macOS Keychain.

## Evidence

- No `com.yulu.xai-oauth` item exists after the failed authorization.
- The signed helper has no Keychain access-group entitlement.
- An isolated Security.framework probe using `kSecUseDataProtectionKeychain=true` returns `-34018`.
- The same isolated generic-password write without that flag returns `0`, and cleanup returns `0`.

## Root Cause

The helper selected the Data Protection Keychain API, which requires an application identifier and Keychain access-group entitlement that a standalone Developer ID helper does not have. Yulu only needs the standard macOS login Keychain generic-password API.

## Fix Contract

- Store the OAuth JSON as a generic password in the standard macOS login Keychain.
- Keep `AfterFirstUnlockThisDeviceOnly` accessibility and the fixed Yulu service/account identity.
- Do not persist or print tokens anywhere else.

## Resolution

- Removed `kSecUseDataProtectionKeychain` and retained generic-password storage with `AfterFirstUnlockThisDeviceOnly` accessibility.
- Rebuilt and Developer ID signed `Yulu.app`, then synchronized the installed runtime.
- Completed a live xAI device flow; Yulu reported `connected=true` and the xAI audio test returned `xai-oauth:yulu`.
- Restarted the Host and confirmed the credential was restored from Keychain.
- Verified 907 Python tests, 827 TypeScript tests, typecheck, production build, codesign, doctor, and `/healthz`.
