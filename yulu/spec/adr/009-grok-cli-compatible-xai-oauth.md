# ADR-009: Grok CLI-compatible xAI OAuth across capabilities

Status: Accepted

Supersedes ADR-008's temporary-client release prerequisite and its summary
capability boundary. ADR-008's Yulu-managed device flow, Keychain custody,
trusted xAI origins, and no-silent-fallback rules remain in force.

## Context

Yulu already uses xAI's public Grok CLI OAuth client and the least-privilege
scope subset `openid profile email offline_access grok-cli:access api:access`.
That credential has been proven against xAI realtime transcription. Requiring a
separate Yulu OAuth registration would discard the intended CLI entitlement
reuse and block distribution without improving token custody.

## Decision

Yulu keeps the exact public client ID published by the official Grok Build
source: `b1a00492-073a-47ea-816f-4c329264a828`. Its six-scope string remains an
explicit least-privilege subset of Grok Build's broader default scope list
because Yulu does not use Grok conversation or workspace resources in this
milestone.

One Yulu-managed Keychain credential may serve xAI transcription, summary, and
local-meeting conversation. Authentication alone is not readiness: the
installed build runs separate real requests for each capability and reports
account/model entitlement failures without switching provider, model, or
credential source. A user-entered xAI API key is an explicit fallback only.

## Consequences

- A Yulu-specific xAI client registration is not a release prerequisite.
- The public client ID is an upstream compatibility dependency; source tests
  pin it exactly, while the six Yulu scopes are pinned as a reviewed subset.
- xAI summary and conversation use the same credential security boundary as
  realtime transcription, with their own privacy and artifact checks.
- Hermes and OpenClaw remain optional Agent/gateway paths and their credentials
  are neither imported nor removed.
