# Phase 13 closeout — active scope, updated 2026-09-11

## Goal and order

Finish the existing guided-onboarding, manual-sharing and self-contained Mac App
scope (#145). The user's current installed Yulu must work; publishing another
candidate is not progress toward that outcome by itself.

1. Restore the physical Mac's migration and usable Application Runtime. Preserve
   recordings, selected providers, credentials, permission identity and rollback.
2. Use a clearly identified local development App to repair and exercise the
   affected journeys together: launch/migration, real capture, durable transcript
   and pinned-provider summary, and manual-only sharing. Fix other observed
   Phase 13 defects in the same batch.
3. Reconcile applicable existing fresh-install, supported-upgrade, lifecycle,
   onboarding and optional-capability evidence. Unchecked historical plans are
   not new work; explicit deferral and accepted external blockers remain valid.
4. Only after the development batch is coherent, prepare one consolidated
   candidate and perform the necessary final public-artifact checks. Complete
   same-source stable promotion and live distribution readback under #170/#171.

## Current evidence

- Public RC19 / build 1592 remains the published candidate. It was installed and
  verified, but migration failed. A same-Team local development App
  `0.23.0-dev.phase13.1` then replaced it as a whole App for diagnosis; this is not
  a new RC or public-artifact acceptance.
- #209 contains registration, focus-resume and safe failure-reporting repairs.
  They are part of the closeout batch, not a reason to publish an RC separately.
- Existing publication/signing/site checks remain evidence for their exact
  artifacts. Preserve them; do not label them proof of installed behavior.
- The remaining registration failure was reproduced with a small independent
  macOS helper: legacy status can report enabled without a job, and unregistering
  that legacy record leaves a state that blocks later same-label registration.
- Repeated load/unregister, delays and moving a plist back did not establish a
  supported recovery. Do not repeat these or reset the system-wide background
  database. Separate legacy and bundled launchd registration identities, while
  retaining the existing signed Capture identity and transaction/data boundaries.
- The development App successfully started both new owners. Final migration
  validation then rejected the Host's normal database upgrade; rollback treated
  its normal config/database writes as foreign changes. The physical journal is
  attempt 6 / `rollback_blocked`, with old services restored and original data
  preserved. The current App is **not yet usable/accepted**.
- The unreleased batch now initializes schema/config offline after exact-copy
  verification, checks that prepared schema at commit, and retains an initialized
  attempt's new data instead of deleting legitimate writes. It also handles old
  whole-App service retirement without replaying a committed data migration,
  retains failure classifications, and diagnoses bundled rather than legacy
  runtime paths.
- A bounded temporary-App experiment reproduced duplicate old/new owners after
  manual replacement and verified unregister-only compatibility descriptors.
  It used no VM and touched no real Yulu service or recording permission.
- Completed source checks: 157 migration tests; 113 update tests; 63 runtime
  packaging tests; 40 Doctor tests; targeted native-shell checks; offline Node
  initialization tests and typecheck. Collector tests passed, including the
  prepared-schema contract and rejection of mismatched evidence. These are not
  installed acceptance claims.
- The next complete development App build stopped at Developer ID signing after
  the Mac locked (`errSecInternalComponent`); native automation confirmed that
  automatic unlock failed. Unlock was requested once while code work continued.
  Do not install the partially signed artifact or publish from it.

## Remaining work in order

1. Assemble/sign the complete current development batch, replace the App as a
   whole, and let the product recover attempt 6 and retry normally. Do not edit
   the journal, databases or original service files by hand.
2. Verify actual current owners and a real recording with committed transcript,
   pinned xAI summary, and no Share Action until a fresh manual command. Check
   relaunch and the affected migration/update paths; reuse unrelated evidence.
3. Reconcile #170's existing applicable acceptance evidence, then make the one
   consolidated public candidate and complete distribution/stable closure. Keep
   #145/#170/#171 open until their actual remaining outcomes are verified.

## Verification budget

- Small fixes: targeted behavior tests and a relevant live check when needed.
- Service migration: one isolated ownership/rollback experiment, related
  migration/update regressions, then actual local App takeover and recording.
- Reuse passing checks unless changed code, environment or new evidence affects
  them. Do not rerun whole suites per small defect.
- No public RC per fix. No VM per candidate. Use an existing isolated environment
  only for a final requirement that actually needs clean state or another OS.
- macOS 13 is a deployment target, not a formal acceptance environment.

## Completion boundaries

Implementation, local validation, public publication, installed acceptance and
stable promotion are separate facts. Do not close #145/#170/#171 until their
still-valid requirements have evidence. Recording completion requires Host task
completion plus committed transcript and summary. Sharing requires a fresh
manual action; no automatic upload, replay or provider fallback is allowed.

This file records the current task, not a new framework, mandatory interview or
authorization gate. Existing action-specific authorization remains effective.
