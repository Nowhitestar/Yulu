# Requirements: Yulu — Reliable Distribution & Activation

**Defined:** 2026-08-23
**Milestone:** v0.6
**Core Value:** A new user can install Yulu, record a real meeting, and obtain saved audio, transcript, and summary without installing or understanding a specific agent runtime.

## v0.6 Requirements

### Reliable Distribution (DIST)

- [x] **DIST-01**: A release candidate contains a version-paired installer whose stable entry path never executes the repository's moving `main` setup code
- [x] **DIST-02**: A release artifact advertised for macOS 13+ is built with a macOS 13 deployment target and rejected by CI when its Mach-O minimum OS is higher
- [x] **DIST-03**: An install or update refuses to stop daemons while a recording is active and leaves the recording intact
- [ ] **DIST-04**: A user can complete core installation without Hermes, OpenClaw, calendar tooling, or an automatic Homebrew installation

### Core Activation (ACT)

- [ ] **ACT-01**: New, upgrading, and developer-install users see one state-driven activation flow that skips steps already proven ready
- [ ] **ACT-02**: A user can choose local transcription or explicitly consent to xAI cloud transcription after seeing privacy and cost implications
- [ ] **ACT-03**: Core Activation completes only after a real recording produces saved audio, transcript, and summary through the production save path
- [ ] **ACT-04**: A failed activation step explains the blocking capability and links directly to the relevant configuration surface

### Provider Model (PRVD)

- [ ] **PRVD-01**: A user can select Transcription, Summary Provider, and Conversation Provider independently
- [ ] **PRVD-02**: A summary or conversation task remains pinned to the provider selected when the task is created
- [ ] **PRVD-03**: When a provider fails, Yulu pauses and asks the user what to do instead of silently switching providers
- [ ] **PRVD-04**: Direct Model API and Model Gateway credentials are stored in macOS Keychain and never written to Yulu config or logs
- [ ] **PRVD-05**: Provider readiness is established by a capability-specific real request and production artifact validation, not command presence alone

### xAI (XAI)

- [ ] **XAI-01**: One Yulu-owned xAI OAuth connection can be reused for transcription, summary, and conversation while each capability keeps an independent selector and readiness probe
- [ ] **XAI-02**: A user can generate a saved Markdown summary with xAI from transcript content only
- [ ] **XAI-03**: A user can ask questions across local meetings; Yulu retrieves bounded excerpts locally, sends only those excerpts to xAI with `store:false`, and displays source meetings
- [ ] **XAI-04**: Yulu keeps xAI conversation history locally and does not enable xAI Web/X search or write connectors in v0.6

### Agent Runtimes and Gateways (AGRT)

- [ ] **AGRT-01**: A user can connect Codex through the official App Server managed OAuth path without Yulu holding the OAuth token
- [ ] **AGRT-02**: A user can connect an unmodified Claude Code runtime through its native OAuth path, with a direct API key path available when runtime OAuth is unavailable
- [ ] **AGRT-03**: A user can connect Hermes or OpenClaw through a configured gateway without making either runtime a core dependency
- [ ] **AGRT-04**: An advanced user can connect a separately managed CLIProxyAPI-compatible endpoint using only its base URL and local proxy key; Yulu does not manage its OAuth files or management key

### Optional Capabilities (OPT)

- [ ] **OPT-01**: After Core Activation, a user can configure or defer calendar integration without blocking recording and summaries
- [ ] **OPT-02**: After Core Activation, a user can configure or defer sharing destinations, and disabled share actions link to setup
- [ ] **OPT-03**: After Core Activation, a user can configure or defer a Conversation Provider independently of the Summary Provider

### Documentation (DOCS)

- [ ] **DOCS-01**: README and website explain the same stable install path, supported provider types, cloud disclosures, optional capabilities, and first-success journey
- [ ] **DOCS-02**: Release assets, installer, version metadata, About surface, and social preview identify the same shipped version and support boundary
- [ ] **DOCS-03**: After publication, a user can install the actual latest stable release through its release-owned installer and pass the post-release smoke check

## Future Requirements

### Extended xAI Agent

- **XAI-F01**: A user can opt into Grok Web/X search with explicit source and privacy controls
- **XAI-F02**: A user can authorize write connectors through a separately reviewed permission flow

### Cross-Platform Runtime

- **XPLAT-01**: Linux runtime implementation of existing platform seams
- **XPLAT-02**: Windows runtime implementation of existing platform seams

## Out of Scope

| Feature | Reason |
|---------|--------|
| Yulu accounts, teams, or hosted cloud sync | Yulu remains local-first and single-user |
| Bundling or forking CLIProxyAPI | It is an advanced user-managed gateway, not a Yulu runtime |
| Automatic provider fallback | It hides cost, privacy, and output changes |
| Agent CLI auto-detection as the onboarding choice | The user chooses a connection type; readiness comes from a real probe |
| Full Grok Web/X agent and write connectors | Requires separate privacy, authorization, and retrieval design |
| Windows/Linux runtime in v0.6 | This milestone closes macOS distribution and activation first |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DIST-01 | Phase 9 | Complete |
| DIST-02 | Phase 9 | Complete |
| DIST-03 | Phase 9 | Complete |
| DIST-04 | Phase 9 | Pending |
| PRVD-01 | Phase 10 | Pending |
| PRVD-02 | Phase 10 | Pending |
| PRVD-03 | Phase 10 | Pending |
| PRVD-04 | Phase 10 | Pending |
| PRVD-05 | Phase 10 | Pending |
| XAI-01 | Phase 10 | Pending |
| XAI-02 | Phase 10 | Pending |
| XAI-03 | Phase 10 | Pending |
| XAI-04 | Phase 10 | Pending |
| ACT-01 | Phase 11 | Pending |
| ACT-02 | Phase 11 | Pending |
| ACT-03 | Phase 11 | Pending |
| ACT-04 | Phase 11 | Pending |
| AGRT-01 | Phase 12 | Pending |
| AGRT-02 | Phase 12 | Pending |
| AGRT-03 | Phase 12 | Pending |
| AGRT-04 | Phase 12 | Pending |
| OPT-01 | Phase 13 | Pending |
| OPT-02 | Phase 13 | Pending |
| OPT-03 | Phase 13 | Pending |
| DOCS-01 | Phase 13 | Pending |
| DOCS-02 | Phase 13 | Pending |
| DOCS-03 | Phase 13 | Pending |

**Coverage:** 27/27 v0.6 requirements mapped exactly once.

---
*Requirements defined: 2026-08-23*
