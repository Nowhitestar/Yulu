# xAI OAuth poll fetch failure

## Symptom

The browser completes xAI device authorization, but Yulu remains disconnected and shows `fetch failed`.

## Evidence

- Host status reports `authorization.status=failed` and `message=fetch failed`.
- The running Host can fetch xAI discovery successfully.
- The xAI token endpoint responds normally and recognizes the configured temporary client ID.
- No credential was committed to Keychain.

## Root Cause

`XaiCredentialManager.pollAuthorization` treats the first transport-level polling failure as terminal. Browser completion cannot recover the stopped Host poll, so the authorized device code is never exchanged or persisted.

## Fix Contract

- Retry bounded consecutive transport failures while the device code remains valid.
- Keep the UI in `running` state with an actionable reconnecting message.
- Preserve terminal handling for OAuth protocol errors such as `access_denied` and `expired_token`.
- Never include device codes or tokens in errors or logs.

## Resolution

- Added bounded retries for consecutive transport failures during device-token polling.
- Kept authorization in `running` state while reconnecting and restored the normal waiting message after recovery.
- Added a regression test covering transport failure, recovery, `authorization_pending`, and successful Keychain persistence.
- Verified 827 TypeScript tests, typecheck, production build, installed Host health, and idle OAuth state.
