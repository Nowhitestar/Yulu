# Yulu

Yulu turns recorded conversations into durable, searchable notes. This glossary
names the user journey from obtaining Yulu to receiving the first complete note.

## Language

**Onboarding**:
The state-aware guided journey shared by first-time users, upgrading users, and
developers. It includes Core Activation and optional capabilities, and ends at
Onboarding Completion.
_Avoid_: Installation wizard

**Onboarding Home**:
The shared progress surface that presents Core Activation and each optional
capability without owning their configuration. It returns users to the same
journey state after an authoritative capability surface completes or defers work.
_Avoid_: Setup wizard, duplicate settings, first-run overlay

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

**Optional Capability Outcome**:
A durable Onboarding record that an optional capability was successfully adopted
or explicitly deferred. It completes that onboarding step but does not claim the
capability remains currently ready.
_Avoid_: Readiness flag, required setup, permanent dismissal

**Optional Capability Evidence**:
Versioned durable evidence that an adopted optional capability satisfied its
exact Onboarding contract. Current readiness is reported separately, and weak
legacy configuration or activity does not qualify automatically.
_Avoid_: Existing config, historical success, current health

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

**Agent Connection**:
The user's explicit choice to let Yulu invoke one Supported Agent for named
capabilities. An Agent Connection records the
connection type and its non-secret settings; it does not by itself select a
Summary Provider or Conversation Provider and does not prove readiness.
_Avoid_: detected Agent, connected CLI, active provider

**Agent Connection Center**:
The shared configuration surface where a user installs or locates a runtime,
authorizes it through its native flow, tests individual capabilities, and fixes
connection failures. Activation, Settings, and Agent Console link to this same
surface rather than owning separate connection state.
_Avoid_: Agent picker, connector drawer, activation step

**Connection Candidate**:
A detected runtime or migrated explicit selection that Yulu can offer for an
Agent Connection but has not yet been authorized and proven ready. Discovery
may create a candidate but never selects it for the user.
_Avoid_: connected Agent, automatic provider, ready Agent

**Runtime-owned Authorization**:
Authorization created, stored, refreshed, and revoked only by the selected
Agent runtime through its native login flow. Yulu may ask that runtime for
non-secret status and invoke its supported interface, but never reads, copies,
or stores the runtime's OAuth tokens.
_Avoid_: shared OAuth, imported login, Yulu OAuth

**Yulu-managed API Key**:
An explicitly selected alternative Credential Source stored by Yulu in the
system keychain and supplied only to the selected capability invocation. It is
never an automatic fallback from Runtime-owned Authorization.
_Avoid_: backup credential, automatic fallback key

**Agent Capability**:
A named operation an Agent Connection may provide. Phase 12 capabilities are
Summary and Conversation; connectors, delivery, transcription, and runtime
provisioning are separate capabilities and are not implied by the connection.
_Avoid_: Agent support, connected features

**Agent Connector**:
An external-service capability managed and authorized by a Supported Agent for
interactive reads or explicit writes. It is separate from a Yulu Calendar Source
and does not authorize a Share Action by being configured.
_Avoid_: Yulu integration, Calendar Source, Share Destination

**Connector Readiness**:
Current evidence from a bounded Agent Connector operation that its selected
external service can be reached with runtime-owned authorization. Installation,
configuration, or destination discovery alone is not readiness.
_Avoid_: Connector configured, OAuth detected, destination saved

**Capability Readiness**:
Current, capability-specific evidence from a real invocation that an explicit
Agent Connection and model can perform the named Agent Capability. Installation,
authorization status, model listing, or a saved setting alone is not readiness.
_Avoid_: connected, authenticated, detected, configured

**Capability Probe**:
A bounded, tool-free invocation that tests one Agent Capability through the
same adapter and Credential Source used by production work. A probe may be
triggered by the user, by selecting the capability, or immediately before first
use; merely opening the Agent Connection Center never spends provider quota.
_Avoid_: health check, binary detection, background monitoring

**Readiness History**:
Persisted non-secret Runtime Evidence from an earlier capability test. It may
explain what previously worked but never claims that the capability is ready in
the current Host process.
_Avoid_: saved readiness, connected state, permanent health

**Runtime Evidence**:
The non-secret identity returned by an Agent invocation, including the adapter,
transport, runtime version, requested and actual provider or model, request or
session identity, terminal status, and whether a fallback occurred.
_Avoid_: OAuth proof, configuration snapshot

**Unknown Outcome**:
The terminal local state of an Agent invocation whose timeout or transport
failure leaves Yulu unable to prove whether remote work stopped or completed.
It is neither success nor ordinary failure and requires an explicit user choice
before another attempt can be created.
_Avoid_: timeout failure, retryable error

**Native Session Reference**:
The exact opaque thread or session identifier returned by a Supported Agent and
pinned to one Yulu Conversation. Yulu never substitutes a runtime's most recent
or default session when the reference is missing.
_Avoid_: current Agent chat, last session, resumable conversation

**Legacy Custom Connection**:
A preserved command-based configuration from an older Yulu version that does
not satisfy the Supported Agent contract. It remains visible for migration or
manual use but cannot establish Capability Readiness or be selected silently.
_Avoid_: Supported Agent, verified adapter

**Provider Readiness**:
Current evidence that the explicitly selected Summary Provider can be invoked
before an Activation Attempt. Saved configuration alone is not readiness.
_Avoid_: Provider configured, provider detected

**Calendar Source**:
A calendar already available to Yulu for finding scheduled meetings and offering
native capture. It is distinct from an Agent Connector used for interactive
calendar reasoning or actions.
_Avoid_: Calendar connector, Agent calendar

**Calendar Source Readiness**:
Current evidence that Yulu can access and enumerate the selected Calendar Source.
An empty event window remains ready when access and enumeration succeed.
_Avoid_: Upcoming meeting found, calendar configured

**Share Destination**:
An explicit external target for a saved summary, reached through a selected
Agent Connector. Saving the target does not authorize an external write.
_Avoid_: Connector, automatic delivery authorization

**Share Action**:
A user-confirmed attempt to send one saved summary to one Share Destination. It
ends only with a verified receipt, a proven failure, or an Unknown Outcome.
_Avoid_: Sync, configured sharing, background delivery

**Test Share**:
A Share Action containing no meeting content that the user explicitly sends to
prove a selected Agent Connector and Share Destination can accept writes. A
verified receipt adopts sharing for Onboarding; an unverified result does not.
_Avoid_: Dry run, implicit write probe, sample meeting share

**Release Candidate Acceptance**:
Versioned evidence that a public signed and notarized release candidate passed
the required fresh-install, stable-upgrade, Onboarding, and production-runtime
checks. A development install, packaging check, or green unit suite is not this.
_Avoid_: Build passed, local dev acceptance, release created

**Activation Blocker**:
A named capability that currently prevents progress toward Core Activation. It
ends the waiting state and gives the user a retry or an exact remediation path.
_Avoid_: Setup failed, unknown error, loading

**Onboarding Completion**:
The point after Core Activation when every optional capability in that Onboarding
version has an Optional Capability Outcome. Later capabilities or readiness
changes do not revoke it; they surface separately as new or needing attention.
_Avoid_: Every integration enabled
