# Phase 13 closeout — active scope, updated 2026-09-11

## Current checkpoint

- Installed: complete CI-signed/notarized `0.23.0-dev.ci.34577975321`, build 1604,
  source `5725490b8f363562dd7fcb46e7c0dc8ab0cfdc2e`. Finder replaced the whole
  App; its installed CodeResources digest matches the verified CI artifact.
  Migration attempt 7 remains committed without replay; Host PID 52911 and
  Capture PID 52912 report the new version. Both native audio inputs are ready,
  idle, and database quick-check is healthy.
- The new native shell automatically rendered the main page after replacement
  and after one ordinary quit/reopen, without Navigate > Open Yulu or a service
  retry. The already-current background PIDs were retained on reopen. Loading
  was observed between snapshots; this is a functional recovery check, not a
  measured launch-performance claim or public-DMG acceptance.
- Sharing now uses the explicitly selected, already-installed ChatGPT desktop
  Codex CLI 0.153.4 and retains `gpt-5.6-sol`. Installed target discovery returned
  10 recent Notion pages, and the separate read-only access probe passed.
  No destination has been selected and no external write has been performed;
  positive Test Share/manual Share readback awaits a designated test parent.
- xAI's original saved grant remains unreadable in the installed CI App. The
  normal Settings UI and one read-only connection recheck show the new accurate
  unavailable-credential explanation, not a missing-login claim. Grok OAuth and
  both `grok-4.6` selections remain unchanged. Real recording/transcription/summary
  previously passed on dev6; that does not establish current xAI readiness.
- Local signing is unavailable. The user explicitly declined password access:
  do not open Passwords/Keychain Access, read credential material, modify access
  controls, reset stores, or retry local signing. Continue with simulated
  credential tests and a complete signed CI validation artifact, using the
  existing CI signing setup. Normal Yulu functionality is the only live account
  verification path. No new OAuth authorization is implied.
- The credential-error UI repair distinguishes unreadable from absent, offers
  a read-only connection recheck, and retains the selected source/model. The
  CI validation run `34577975321` and full source CI `34577813845` passed.
  The internal App's archive checksum, signature, notarization staple and
  Gatekeeper assessment passed. This path creates no GitHub Release, DMG or
  update feed; the internal ref/artifact is not a new RC or formal acceptance.

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
- The original failure rejected the Host's normal database upgrade and then
  treated its normal writes as foreign rollback changes. The complete signed
  development App recovered attempt 6 normally and committed attempt 7 at
  `2026-09-11T03:39:13.906530+00:00`, preserving original data and credentials.
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
- The signing interruption was resolved after the Mac unlocked; no keychain,
  trust, TCC or system-wide background-service reset was used. Partial builds
  were not installed or published.
- Physical whole-App replacement exposed stale same-label background owners.
  The batch now compares the OS-reported loaded executable image with the
  installed file, then retires only an identified idle old pair under the
  existing transaction lock. It does not depend on the old Host's health or
  restart already-current images. This also detects same-version rebuilds.
- Complete signed local `0.23.0-dev.phase13.6` was installed. Normal launch
  replaced both old processes: Host PID 43977 and Capture PID 43978 report that
  version; microphone and system capture are ready. Attempt 7's committed
  journal is unchanged. This is local validation, not public RC acceptance.
- This batch also pins xAI summary to the durable selected credential source
  after Host restart, recognizes self-contained Apps in Doctor without a Git
  checkout or legacy Hermes dependency, and gives cold native recording startup
  its own bounded acknowledgement deadline.
- Cold-start QA recording `Phase13consolidatedcoreflowQA_20260911_124019` returned
  success and normal Stop enqueued task `58245ef5-b2fb-4f23-80ff-04bcaa163f34`.
  The task completed on attempt 1 with no error; Host returned committed
  transcript (227 characters) and summary (1,110 characters). `sendToNotion` is
  false, legacy delivery is absent, and Share Action count is zero. No historic
  recording was replayed. Sharing currently explains that its independent
  meeting-free Test Share must be verified before a meeting can be shared.
- The dev6 App's MCP `health_check` returned `ok=true`: bundled Host,
  database and native audio socket are healthy. The complete migration/update
  regression batch passed 298 tests. The related recording/Doctor batch passed
  63 tests; Agent Connection/pipeline/recording command tests passed 135 tests
  and Node typecheck passed. The shell and signed App inventory were built and
  verified together, not patched after installation.
- Commit `b6a3854` passed complete CI (run `34563789242`). Ordinary foreground
  quit/reopen rendered the main UI and retained Host PID 43977 / Capture PID
  43978; already-current background images were not restarted.
- Real read-only Sharing discovery exposed two additional diagnostics defects:
  Codex's cold initialization consumed the old probe deadline, and its terminal
  JSON error was lost behind stderr/guard diagnostics. A bounded startup-hook
  experiment proved the unchanged overlay executes; no guard weakening or
  persistent Codex config change was needed. The same-batch repair adds a
  60-second initialization allowance and preserves terminal failure reasons.
- The next real discovery reached the upstream API and reported that Codex CLI
  0.144.4 cannot use the CLI-global `gpt-6-astra`. UI readback then established
  that Yulu's Connection actually specifies `gpt-5.6-sol`: Sharing and Calendar
  were omitting the explicit model argument. Both adapters now pass the saved
  Connection model and reject a missing selection rather than using a global
  default. No CLI installation, selected model or credential was changed.
- The desktop application also contains Codex CLI 0.153.4. Its initial read-only
  diagnostic passed the model-version check but was denied by the tool guard;
  it was not yet selected at that checkpoint. Diagnostic failures and timeouts are not
  successful connector acceptance. No Test Share or meeting Share was sent.
- The resulting evidence identified the missing exact Notion Apps namespace
  and the difference between hook names and CLI audit names. The batch now
  recognizes that selected app without authorizing other apps, recognizes its
  recent-pages read, and limits discovery prompts to one read. A proposed wider
  shared/private/favorite-page allowlist was rejected by safety review and was
  not applied. The supported read allowlist was not widened to those scopes.
- Actual CLI events also contain started/completed updates for a single MCP
  call. The audit now deduplicates only the same call ID, preserving separate
  write attempts. This prevents a single real manual write from being falsely
  counted twice. The original one-write guard and Unknown Outcome fences remain.
- Runtime scanning offers the already-installed desktop Codex as an explicit
  alternate candidate, avoiding an unnecessary global CLI upgrade. Existing
  provider/model selections do not change during scanning. The latest bounded
  read reached Notion but its optional title filter was unsupported; the
  discovery prompt now prefers a single recent-page read and excludes optional
  plan-specific filters. A subsequent bounded diagnostic using the selected
  `gpt-5.6-sol` successfully read recent pages in 62 seconds. This exposed a
  separate parser bug: valid structured parent objects were silently discarded.
  They now normalize to the same identity as JSON strings, and write-response
  examples are properly JSON-escaped. Notion's required fixed `Yulu Share` title
  is allowed without allowing arbitrary properties or meeting metadata.
- The complete connector/runtime-discovery batch passed 162 targeted tests and
  typecheck; the final format/guard adjustment passed its 44 affected tests and
  typecheck. No shared/private/favorite-page allowlist expansion, credential
  access, global CLI upgrade, Test Share, or meeting Share was performed.
  A dedicated user-approved Notion test parent is still needed for write/readback
  acceptance. Discovery and source tests do not prove that positive write path.
- Complete signed `0.23.0-dev.phase13.8` was installed through Finder with matching
  payload hashes. Host PID 36778 and Capture PID 36779 are running; Host health
  and database checks pass and attempt 7's committed journal is unchanged.
  The shell nevertheless remained on its 30-second startup failure screen after
  the Host became ready. The same batch now accepts late, identity-verified
  owner readiness and continues read-only startup polling at two-second intervals;
  it does not automatically retry services or migration. Its focused wiring
  check passes; the final native rebuild/installed UI check is pending.
- A complete signed `0.23.0-dev.phase13.7` was built but never installed; dev8
  included the subsequent connector repairs. Local dev9 compiled the late
  startup fix but signing failed, so it was not installed. Public RC19 remains
  unchanged; these intermediate artifacts are not public candidates.
- The no-local-password alternative has now completed: the existing CI signer
  built and notarized the complete consolidated App in run `34577975321`.
  Artifact `10190616251` matched GitHub's SHA-256
  `4fca71aceb4c42026a4b0161ee62bf5684e6cf2b5ebdae632ce78b370dc5c527`;
  its inner archive checksum also passed. Signature verification, staple
  validation and Gatekeeper assessment passed with Team `WMU9678ZQL`.
  Installed CodeResources SHA-256 is
  `24e3030f840b518d1b6d2406a0090581ec6e59e204a860786db1427bafcf1d38`.
  Normal launch and quit/reopen automatically rendered the main page. Host,
  Capture and the committed journal remained healthy; no recording was replayed,
  external Share was sent, or password store was inspected. The xAI UI recheck
  did not restore current account availability and did not change any selection.

## Remaining work in order

1. Current xAI account availability remains an unresolved live-access blocker. The
   consolidated CI App is installed and startup/error UI verification is done;
   do not repeat signing, installation or credential probes without new evidence.
   Keep the original grant/source/models and the no-password-access boundary.
   Preserve dev6's successful pipeline evidence separately from current readiness.
2. Finish the user-designated Test Share/manual Share write/readback. Discovery
   and access tests have passed; they do not prove an external write succeeded.
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
