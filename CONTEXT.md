# Yulu

Yulu turns recorded conversations into durable, searchable notes. This glossary
names the user journey from obtaining Yulu to receiving the first complete note.

## Language

**Onboarding**:
The state-aware guided journey shared by first-time users, upgrading users, and
developers. It includes Core Activation and optional capabilities, and ends at
Onboarding Completion.
_Avoid_: Installation wizard

**Activation Journey**:
The resumable part of Onboarding that guides a user who lacks verified Core
Activation to that milestone. It may be deferred and reopened without losing
completed progress.
_Avoid_: First-run wizard, setup checklist

**Core Activation**:
The milestone established by Core Activation Evidence from a real production
recording. Once established, later deletion of the recording or a change of
Summary Provider does not revoke it.
_Avoid_: Installation complete, setup complete

**Core Activation Evidence**:
A durable record that a Qualifying Recording established Core Activation. It
may be created from a recording made before or outside the Activation Journey.
_Avoid_: Activation flag, current health status

**Qualifying Recording**:
A recording made through any of Yulu's production recording paths that yields
non-empty saved audio, transcript, and a current summary from its explicitly
selected Summary Provider with enough provenance to verify that selection.
Optional delivery to external destinations is not part of qualification.
_Avoid_: Test recording, sample recording

**Activation Attempt**:
A user-initiated Qualifying Recording made from the Activation Journey to
establish Core Activation. Its processing continues and remains resumable when
the user leaves the journey.
_Avoid_: Test recording, sample recording

**Activation Deferral**:
The user's choice to leave an incomplete Activation Journey and use the rest of
Yulu. It suppresses forced re-entry in the same local user environment, including
after ordinary upgrades, while keeping a non-blocking path back.
_Avoid_: Onboarding Completion, dismissal

**Cloud Transcription Consent**:
Versioned consent to send recording audio to xAI for transcription after the
privacy and cost implications have been disclosed. It does not grant consent
for other cloud capabilities or providers.
_Avoid_: Cloud consent, provider authorization

**Data Path Disclosure**:
A versioned explanation of what recording data a selected capability sends,
where it sends it, and whether processing remains local. Provider authorization
does not replace this disclosure.
_Avoid_: AI consent, OAuth consent

**Summary Provider**:
The explicitly selected source of recording summaries: xAI or a supported Agent
installed on the user's computer. The selection is fixed for each recording and
never changes automatically.
_Avoid_: Summary Agent, fallback provider, automatic provider

**Supported Agent**:
A locally installed Agent that Yulu can invoke using the user's existing
authorization and whose current readiness Yulu can prove.
_Avoid_: Hermes, detected CLI, configured Agent

**Provider Readiness**:
Current evidence that the explicitly selected Summary Provider can be invoked
before an Activation Attempt. Saved configuration alone is not readiness.
_Avoid_: Provider configured, provider detected

**Activation Blocker**:
A named capability that currently prevents progress toward Core Activation. It
ends the waiting state and gives the user a retry or an exact remediation path.
_Avoid_: Setup failed, unknown error, loading

**Onboarding Completion**:
The point after Core Activation when every optional capability has either been
activated or explicitly deferred by the user.
_Avoid_: Every integration enabled
