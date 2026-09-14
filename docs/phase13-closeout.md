# Phase 13 closeout — active scope, updated 2026-09-14

## Current checkpoint

- Public `v0.23.0-rc.20` is published and independently verified. Its exact
  source is `edb5a7a4b932db7ceccd1cfa12b8611aa11f41d8`, build **1636**.
  PRs #209 and #210 are merged; this is the consolidated release, not a new
  candidate per individual repair. Stable promotion has not happened.
- The physical Mac now runs that public RC20 after ordinary Finder whole-App
  replacement from the verified DMG. Installed and mounted CodeResources
  SHA-256 both equal
  `3e5b77a896b8472af6159b2f24292ec815799acb65d177a1aa6362cf1221ead6`;
  the installed deep/strict signature is valid. First launch automatically
  rendered the complete Agent Console without resizing or patching the App.
  Host PID 15765 and Capture PID 15766 report RC20/build 1636; the database
  quick-check and both native inputs pass, with no active recording.
- The original migration transaction and timestamp are unchanged. MCP readback
  confirms the same completed attempt-1 synthetic task, error null and
  `sendToNotion=false`. Its 227-character transcript and 1,110-character,
  non-stale summary are byte-for-byte equal to the pre-install MCP snapshot.
  The summary/snapshot hashes and both verified manual Share Actions are
  retained. No recording was regenerated or Notion page created for this update.
  One ordinary read-only access probe in the new Host passed and restored
  current Sharing Readiness. It reused the original September 12 Test Share
  receipt; recording Share counts remain total 2 / verified 2.
- Remaining: genuine fresh public installation, a real supported v0.22.2
  upgrade baseline, current public download guidance, then conditional
  same-source stable publication and its normal RC-to-stable update. This
  physical development-to-public replacement does not establish those separate
  journeys. The overall goal is **not complete**.
- The current goal API still reports its pre-existing blocked status and offers
  no resume operation. Work resumed under the user's explicit instruction;
  this limitation was not worked around by falsely completing/recreating the
  goal or editing application-internal state. The objective itself is unchanged.
- RC20 README/install guidance and issue-template corrections are prepared on
  `codex/phase13-release-closeout`; all 14 release-line tests passed. No product
  rebuild is required. The live landing page and its exact source
  `Nowhitestar/tingfengji:content/yulu/index.html` still advertise RC19. The
  necessary CTA/footer replacement is prepared locally; it has not been deployed.

### Retained internal-App validation before public RC20

The following evidence is version-specific history. It does not describe the
currently installed App or current-process connector readiness.

- Installed: complete CI-signed/notarized `0.23.0-dev.ci.34796306098`, build 1626,
  source `18b988e1c8ae4e5224309d3c19617b5ec48efb56`. Finder replaced the whole
  App; its installed CodeResources digest matches the verified CI artifact.
  Migration transaction `f65ccc2e04a04b11b3d5f308d1460858` remains committed,
  with its original `2026-09-11T03:39:13.906530+00:00` timestamp. Initial Host
  PID 32194 and Capture PID 32195 report the new version; both native audio
  inputs become ready, idle, and database quick-check is healthy.
- The native layout/paint repair passes installed verification. Build 1618's first
  entry after replacement and one normal quit/reopen automatically rendered the
  complete Agent Console without zoom, resizing, cache clearing, service resets
  or installed-App patches. Screenshots and the accessible HTML tree agree.
  Builds 1620, 1622 and 1626 also entered the complete UI automatically after whole-App
  replacement.
  Build 1614's white-window failure and temporary zoom workaround are historical
  evidence, not the current installed state. The exact synthetic QA task remains
  completed on attempt 1 with no error; its 227-character transcript and
  1,110-character, non-stale summary retain the original content/hash. One fresh,
  manually confirmed Share of that synthetic QA summary was submitted on
  2026-09-14 to the already approved private Notion parent. The connector returned
  a real page receipt, but initially omitted the snapshot's first H1; the Host
  correctly retained Unknown Outcome. The existing private QA page was repaired
  in place and its full content independently read back on September 14.
  Build 1626's new product reconciliation now verified that same action without
  another write. A fresh manually confirmed QA Share then passed the complete
  create-and-read-back path, including the first H1, at the same private parent.
- The installed direct-RPC adapter successfully reconciled the **original** Test
  Share action `f53297b2-f5d3-42b2-a9a2-a37a04faaec1` by fetching its exact receipt
  once. The Host no longer offers Unknown reconciliation, retains the same
  receipt and reports `duplicateWarningRequired=true`. No second Test Share was
  created. Builds 1620 and 1622 each passed one installed read-only access probe
  in their new Host process; current overall Sharing Readiness is ready.
  The earlier discovery timeout is resolved;
  no second Test Share or repeated receipt reconciliation was needed.
- A read-only timing diagnostic measured Codex `mcpServerStatus/list` at
  30,968 ms. The short access probe incorrectly used its 30,000 ms tool budget
  for runtime discovery too. The working source gives discovery a separate
  60,000 ms bound, retaining the actual tool timeout and overall deadline. Its
  real `AgentSharingConnectorAdapter.probe` passed in 38,460 ms, with one read,
  no model turn and no external write. The two affected suites pass all 45
  tests; typecheck and Host build pass. A pre-existing fixture audit race was
  repaired with a protocol round-trip barrier, not a production permission change.
  This small follow-up is now installed; preserve build 1618's passed native
  and receipt evidence rather than rebuilding unrelated code or issuing an RC.
  It is committed/pushed as `929789596f059b4c4bf251477e11418ca1b0206a`.
  Complete source CI `34676642675` and internal signed-App run `34676677582`
  both passed. Artifact `10292078809` was downloaded to
  `/private/tmp/yulu-phase13-discovery-ci.1ZfwGM`; archive checksum, deep/strict
  signature, notarization staple and normal Gatekeeper assessment all pass.
  Sandbox-only signing assessment errors were superseded by normal read-only
  verification, not by re-signing or a trust-policy change. Finder whole-App
  replacement completed on 2026-09-14; installed CodeResources SHA-256 is
  `f624657177f09f708c757e4654f321eabed73de94a7b8c01891896e4e896efc2`.
- The one actual recording Share is action
  `7a29bf02-2377-4fa3-bd76-138bc24788b0`, receipt
  `3db56559-55cc-8177-adaa-e570b0223dee`. The initial exact-page fetch confirmed
  the approved direct parent but found the missing first heading, so it did not
  establish the complete 1,110-character snapshot. The connector
  consumed the leading H1 instead of retaining it in the body; the fixed page
  title remains `Yulu Share`. Initial Share counts were total 1, verified 0;
  after build 1626's exact original-receipt reconciliation they are 1 and 1.
  The recording task is still completed on attempt 1, `sendToNotion=false`.
  The local follow-up protects a leading H1 with Notion's documented empty
  paragraph, retains complete-content comparison (missing headings still fail),
  and replaces the generic audit error with an explicit content-mismatch detail
  when the exact page/parent were read. Four targeted suites pass all 99 tests;
  typecheck, Host build and diff checks pass. The transport repair was still
  awaiting a live create check in build 1622; the later build 1626 manual Share
  acceptance below supersedes that limitation.
  On September 14 at 01:19 UTC, only the missing H1 plus the documented leading
  empty paragraph was inserted into this same QA page. Fresh read-back matched
  the full original summary and parent; the original action and receipt remain
  intact. This repair validates the insert transport, not a new create. The later
  product reconciliation establishes the original action's verified Host status.
  No action was abandoned and no extra page or public RC was created during the
  in-place repair/reconciliation; the later fresh manual Share is recorded below.
- This follow-up is committed/pushed as `6446a6a8e74deb8039823ffad717df222a2ec1a1`.
  Internal signing run `34794255762` passed and produced build 1622,
  `0.23.0-dev.ci.34794255762`. Artifact `10328937856` is downloaded to
  `/private/tmp/yulu-phase13-heading-ci.XaMLS8`; the inner archive checksum,
  exact source metadata, deep/strict signature, notarization staple and
  Gatekeeper assessment all pass. CodeResources SHA-256 is
  `3400fdc82e7a34edd8842f46af43b236e536d6a01982d565c930791402b43e0f`.
  Full source CI `34794099373` also passed both the UI/Host and native/Python
  jobs. Finder whole-App replacement is complete; the installed CodeResources
  digest matches, the native UI renders automatically, and Host/Capture report
  build 1622 with database quick-check and both audio inputs ready. The original
  committed migration timestamp is unchanged. MCP confirms the same completed
  attempt-1 QA task, byte-identical summary and exactly one Unknown Share Action
  with the original receipt. The fresh Host required its ordinary one-read
  access probe; it passed, restoring current Sharing Readiness while reusing
  the already verified original Test Share. No recording or external write was repeated.
  The pre-push scanner's
  three medium matches were reviewed: all are numerical CI/artifact IDs in
  this file, not phone numbers or credentials. No scan bypass was used.
- Recording receipt reconciliation was missing from both backend and dialog,
  despite the displayed instruction to reconcile. Source `18b988e` adds the
  authenticated, explicit read-only operation and receipt controls, pinned to
  the original action. All 114 affected service/router/reader/dialog tests,
  Node 24 typecheck and complete UI/Host build pass. Full CI `34796285053` and
  internal signed-App run `34796306098` both pass; no new public RC.
  Artifact `10329987042` was downloaded to
  `/private/tmp/yulu-phase13-reconcile-ci.jlHPfH`; inner checksum, exact source,
  deep/strict signature, staple and Gatekeeper all pass. Build 1626 was installed
  by whole-App Finder replacement; installed CodeResources SHA-256 matches:
  `e69e3b1bf4275fb47d7bedaa5e65d614c9f1a6f1ff2f9d79fce59596bf0168f5`.
  The complete UI rendered automatically and both bundled owners became healthy.
  The original migration transaction and timestamp are unchanged. In the new
  dialog, the original receipt ID and URL are read-only; one explicit read-only
  check changed action `7a29bf02-2377-4fa3-bd76-138bc24788b0` to verified with
  total 1 / verified 1. The original snapshot hash and summary hash are unchanged;
  duplicate confirmation is now required. The new-Host one-read access probe
  passed and retained the original September 12 Test Share verification.
- On build 1626, a fresh manual Share was explicitly confirmed after reviewing
  the same synthetic QA summary, Agent, private destination and duplicate
  warning. Action `0a729648-22d7-4e99-b3d8-0cbd91449ea3` completed verified, with
  receipt `3db56559-55cc-81ab-8f42-fff874d02810`. An independent exact-page fetch
  at `2026-09-14T02:00:28.183Z` confirmed the direct private parent and the full
  original summary, including its first H1 protected by the documented empty
  paragraph. Only ordinary paragraph separation differs. Recording Share counts
  are now total 2 / verified 2; no automatic retry or further write was performed.
  Summary SHA-256 remains
  `5d976cbe8756a3f3279c1b5dd1d3346ea1b1f678a5d8bf5f343ffb2749b7f3d4`.
  The original task remains completed on attempt 1, error null, `sendToNotion=false`;
  transcript and summary were not regenerated. The installed App's signature
  manifest digest is unchanged after both connector operations.
  This closes the installed manual-sharing repair acceptance, not public DMG,
  supported-upgrade or stable-release acceptance. Do not repeat either QA write.
- The latest normal xAI UI/API read now reports the original OAuth connected
  and readable. No password, credential helper, reauthorization or source/model
  change was performed. Real transcription and `grok-4.6` conversation capability
  probes pass. The first new summary probe ended Unknown; unauthenticated network
  checks and the same-source conversation succeeded afterward. One explicit new
  summary capability attempt then passed too. All three current capabilities
  are ready; the initial Unknown result remains in history. No existing recording
  was replayed, and no xAI source-code change was needed for this recovery.

### Earlier diagnosis and retained implementation evidence

The following records describe prior candidates and the basis of the repairs;
the current installed results above supersede their live-state assertions.

- Sharing now uses the explicitly selected, already-installed ChatGPT desktop
  Codex CLI 0.153.4 and retains `gpt-5.6-sol`. Installed target discovery returned
  10 recent Notion pages on dev8; the CI App's separate read-only access probe
  passed too. The user then authorized a newly created private QA parent in the
  connected Notion workspace. Its exact destination was saved and read back.
  One manually confirmed meeting-free Test Share created the expected child;
  independent connector fetch confirmed its direct parent and complete fixed
  message. The repaired parser is now installed, but read-only reconciliation
  and an independent access probe exposed a separate runtime compatibility
  failure: current Codex wraps successful Notion calls inside code-mode `exec`,
  without the per-tool guard evidence required by Yulu. The two exact Yulu-owned
  CLI session traces show successful reads; unrelated stderr authentication and
  skill-scan warnings were not the cause. Build 1614's attempt to disable the
  wrapper was insufficient: the model still tried `exec` and received
  `code-mode host is disabled`. The Host correctly retained Unknown Outcome.
  No second write or recording Share was sent; do not abandon or resend.
- The installed source batch repairs Notion receipt parsing, UUID/link presentation
  and empty paragraph separator handling while checking the actual tool result,
  direct parent and full content. It rejects changed/omitted content, conflicting
  page identities, truncated/unknown blocks and mutation during verification.
  Notion's native `verification.state=unverified` and meeting text mentioning an
  error are no longer confused with transport failure. Destination setup now
  accepts page links/IDs, explains manual child-page creation, rejects titles
  before sending, and shows in-flight progress. The native shell adds standard
  Edit menu first-responder shortcuts after its absent paste/select-all bindings
  blocked target entry. Parser source tests and actual-response replay pass;
  positive installed receipt verification remains blocked by the code-mode path.
- The failed code-mode flag workaround is removed in the working source. Codex
  Notion operations now use the runtime's observed `mcpServer/tool/call` protocol,
  never `turn/start`: the Host constructs one exact request, and the selected
  Codex runtime still owns connector discovery, transport and credentials. Only
  the fixed recent-page read, exact receipt fetch, and single-page create are
  admitted. Tool namespace/schema, selected runtime/model, destination, fixed
  title and immutable content are checked before dispatch; an uncertain write
  is never retried. Unsolicited authority/token-refresh requests are rejected.
  Claude, Zulip and Calendar retain their existing guarded paths; there is no
  fallback to them. No global CLI config, credential source or model was changed.
- The real source adapter now successfully verifies the existing Test Share's
  complete content and exact parent through the selected desktop Codex. This is
  stronger than a parser-only replay, but it did not mutate the installed Host's
  Unknown action. No external write or model request was made. The first batch
  passed 113 tests across five affected files; the final incremental checks passed
  79 tests across three changed files (115 distinct related tests in total).
  Node 24 typecheck and the production build pass. This source is now installed;
  do not build another App merely to experiment with runtime flags.
- Source repair `c83f76d` is committed and pushed to the existing PR branch.
  Its real source read-back succeeded without modifying the installed Host.
  The same batch now gives WebKit a constraint-laid-out native container,
  displays loading status until navigation completes, starts its first paint
  with an explicit visibility/layout transition, and reports navigation/process
  failures. Reopening a route also reattaches a reused WebView. Two focused
  native contracts and the compiled WebView navigation smoke pass, including
  initial viewport, visible completion, reattachment and unchanged external-link
  behavior. A small synthetic probe showed that a zero final frame alone did not
  explain the old bug; do not claim that as its proven cause. Proceed with one
  combined internal signed-App validation of these two repaired boundaries.
- The combined candidate is built and installed: `d269574`,
  `0.23.0-dev.ci.34674597952`, build 1618. Complete source CI `34674599889`
  and signed-App run `34674597952` both passed. Artifact `10291669409` is
  downloaded and extracted at `/private/tmp/yulu-phase13-combined-ci.pyAfKM`;
  its inner archive checksum, deep/strict signature, notarization staple and
  Gatekeeper assessment pass. CodeResources SHA-256 is
  `85ae98484aef2d9f0f44a198434b33dff90530affa2ed880cde59821f87fe8a3`.
  The replacement desktop-control skill (`node_repl` + Sky) restored supported
  UI access. Finder whole-App replacement completed without any password or
  permission-store access. Do not regenerate this already verified candidate.
- The installed General About query now correctly returns the App version and
  `Yulu.app` install source. Guard errors precede incidental stderr; genuine
  failed-turn and timeout errors retain their priority. Those repairs remain.
- On 2026-09-12 the user explicitly approved
  pushing to the existing `https://github.com/Nowhitestar/Yulu.git` repository
  and running its current CI signing workflow, resolving the earlier platform
  authorization rejection. Continue with one internal complete-App validation
  build for the now-combined connector/native-window batch; do not access the
  local password store or publish another public RC.
  No alternative channel was used to bypass the earlier rejection.
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

## Earlier repair and acceptance evidence

- Before the consolidated release, RC19 / build 1592 was the public candidate. It was installed and
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
  At that checkpoint, a dedicated user-approved Notion test parent was needed for write/readback
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
- The subsequent user-approved private-parent Test Share reproduced the actual
  Notion compatibility failure. The write completed once, but the old verifier
  compared a model's JSON re-serialization and expected structured `parent` /
  `content` fields instead of the connector's enhanced-Markdown page envelope.
  The immutable action and provisional receipt remain in the Host for read-only
  reconciliation. No real meeting content was uploaded. The current source
  repair passed 117 targeted sharing/guard/onboarding tests, Node 24 typecheck,
  the production Host/frontend build, and two native-shell checks including
  compilation. The large frontend chunk warning remains non-blocking and is not
  a reason for an unrelated refactor or another public RC.
- A fresh connector fetch of that exact Test Share child was replayed offline
  through the current adapter and passed. The captured response SHA-256 is
  `1147e222c259a48f8d04a14bed488e1c9413145c71557e3f14f694784a134b88`.
  This used no CLI execution, new external write or Host mutation; it is actual-
  format parser evidence, not an installed Share receipt. Fresh public MCP
  readback still shows the synthetic QA summary at 1,110 characters, not stale,
  with zero recording Share Actions. The existing Test Share remains fenced in
  the installed Host until the repair can be installed and reconciled normally.
- On 2026-09-12, complete source CI `34669655925` and internal signed-App CI
  `34669706049` passed for `c967199`. Downloaded artifact `10289794387` passed
  its inner archive checksum, deep/strict signature verification, notarization
  staple validation and Gatekeeper assessment. Finder installed the complete
  App; installed CodeResources SHA-256 matches the artifact:
  `7d0fca7b121e353b1f1dfea339b40598272f714a53da46905688bbde8bc2f28c`.
  Host PID 5785 and Capture PID 5786 report build 1612; database quick-check and
  both audio inputs pass. The original committed migration and 1,110-character
  non-stale synthetic summary remain unchanged. Native Select All / Paste now
  work. One read-only receipt reconciliation and one access probe completed
  their Notion reads but failed Yulu's guard audit because `code_mode_host`
  wrapped tools inside `exec`. No test or meeting write was repeated. A separate
  exact-page fetch still confirms the original parent and test message.
  Normal xAI UI recheck still reports the saved grant unreadable without
  changing credentials, Grok OAuth, or either `grok-4.6` selection.
- Complete source CI `34671398589` and internal signed-App CI `34671438759`
  passed for `a1dcdc7`. Artifact `10291310382` passed archive checksum,
  deep/strict signature, notarization staple and Gatekeeper checks. Finder
  installed the whole App; CodeResources SHA-256 is
  `e723ae37b5ab27cfdcf47efd264ccdfd183b5d25cb3d62515a0b75bbbd52b0b9`.
  The migration journal, healthy Host/Capture and synthetic QA summary hash
  `5d976cbe8756a3f3279c1b5dd1d3346ea1b1f678a5d8bf5f343ffb2749b7f3d4`
  remained unchanged. No new recording Share exists. The native-window and
  code-mode failures above prevent treating this build as accepted.
- The supported direct-RPC read was proven first with an isolated read-only
  protocol probe, then through the actual source Sharing adapter. The diagnostic
  initially inherited the supervising Codex app's tool pipe and failed connector
  initialization; omitting only that pipe reproduced the normal launched-Host
  environment and succeeded. Sandbox/network restrictions were not altered.
  Current tool names are `codex_apps` / `notion.fetch`,
  `notion.notion-list-recent-pages`, and `notion.notion-create-pages`. The recent
  list response uses `results` / `nextCursor`; its actual shape was verified
  without printing page titles or bodies. The create contract was inspected but
  no new live create was attempted.

## Remaining work in order

### Evidence reuse decisions

The 2026-09-11 reconciliation inspected retained collector output and the current
Host's public MCP readback, not just old checkboxes. Reuse only the stated scope:

| Requirement | Retained evidence | What it does not establish |
|---|---|---|
| Self-contained drag-to-Applications baseline | RC14 `b2c554c`, build 1568, macOS 26.5 arm64: fresh preflight passed with host dependencies absent, browser provenance verified, bundle observation matched, and first-launch Host/database healthy. | The baseline explicitly has `coreCompleted=false` and no Share receipt. Its old `com.yulu.ui` owner cannot prove the newly separated service registration path. |
| Current physical migration and App takeover | Public RC20 `edb5a7a`, build 1636: Finder whole-App replacement retains the original committed migration transaction, new Host/Capture own the runtime, native inputs are ready and first entry renders automatically. Reuse build 1618's ordinary quit/reopen evidence for the unchanged native repair. | This physical installation originated from development/legacy state; it is not a clean machine or a demonstrated real v0.22.2 baseline. |
| Committed artifacts survive whole-App replacement | RC20 MCP readback still returns QA task `58245ef5-b2fb-4f23-80ff-04bcaa163f34` completed on attempt 1, error null; its transcript is 227 characters, summary 1,110 characters and not stale. Both contents match the pre-install MCP snapshot exactly. `sendToNotion=false`, no legacy delivery. The two separate manual Share actions are verified. | This preserves dev6's successful full pipeline. Build 1618's separate xAI capability probes also pass; neither claim is a new recording on RC20. |
| Sharing setup and external write | The original Test Share verification is retained. Build 1626 verified the repaired original recording receipt read-only, then a fresh explicitly confirmed manual QA Share passed create-and-read-back with the full first heading. Independent fetch confirmed the exact private parent and full summary. | This is installed build 1626 evidence. No more QA writes are needed for these unchanged paths. Do not silently resend or choose a business page. |
| Public distribution | RC20 anonymous downloads match the four-asset inventory, sizes and hashes. The DMG/App signature, notarization, Gatekeeper, layout and runtime checks pass; all three payloads have exact-source SLSA attestations. The physical Mac has installed the same whole App. The stable feed is unchanged. | This does not establish a clean installation, supported v0.22.2 upgrade or stable promotion. The public landing page still points to RC19. |
| Supported v0.22.2 upgrade and public update/rollback | Relevant source regressions are retained; the reviewed checkpoints continue to identify complete installed journeys as unearned. | Source tests, prepared harnesses and temporary fixture directories are not completed real-install receipts. |

RC14 retained collector digests are: preflight
`9d99629e15f1eaa95cdfeca9087aac77c6c292e21bf227bf421615f0e4ed4d7d`,
bundle observation `9d3c3f582f6444fba90e24d5379fdb8318fffab69d32a1a03ff14579a60a1962`,
and baseline journey `33680b4b39d7f9c0ef3467d6d01d13f7688d7b5e9a73bb12dff25cd4c1e36f75`.
Do not alter these old receipts or relabel them as evidence for the final source.
The current user restriction also means that a historical collector's credential-
store inspection is not permission to inspect the user's password store now.

### Required outcomes

1. Retain build 1618's passed ordinary launch/reopen and migration evidence.
   Current OAuth access, realtime transcription, summary and conversation probes
   have recovered without changing the original grant/source/models; the initial
   summary Unknown result remains recorded. Preserve dev6's successful pipeline evidence
   separately from current readiness. No password-store access is authorized.
2. The discovery-budget correction is retained in complete CI-signed build
   1622, and its connector access probe passes. The original Test Share was
   already reconciled successfully; do not resend or reconcile it again.
   The existing synthetic QA summary has been manually shared once to the
   approved private parent after Sharing Readiness became ready. Its exact-page
   readback found a missing first H1, not a false positive in content comparison.
   Build 1626 now includes the transport and reconciliation fixes. On September 14 the original
   QA child `3db56559-55cc-8177-adaa-e570b0223dee` was repaired in place by inserting
   only `<empty-block/>` and its missing first H1; fresh exact-page fetch proved
   the complete original summary at the same private parent. No recording was
   reprocessed or new Share Action created during repair/reconciliation. Original
   action `7a29bf02-2377-4fa3-bd76-138bc24788b0` is now verified by build 1626's
   explicit product read-back, retaining its original receipt and snapshot.
   The recording Share dialog lacked the reconciliation entry its own remediation
   promised. A scoped backend/UI correction now verifies only the original
   action's summary, unchanged Agent/destination and pinned receipt, without a
   write; timeout, mismatch, connection changes and concurrent abandonment cannot
   claim success. All 114 tests in the four affected service/router/reader/dialog
   suites, Node 24 typecheck, and Host/frontend build pass; the installed original
   receipt reconciliation also passes.
   The one fresh manually confirmed synthetic QA Share also passed the corrected
   create path after duplicate acknowledgment. Both original and new recording
   receipts are now verified, with no further writes required. Preserve this
   acceptance for unchanged code. An uncertain result must never trigger another
   automatic write.
   Authorization correction: the original September 11 user permission explicitly
   allows an independent private Notion QA page for fixed Test Share and synthetic
   summary acceptance. A later assistant-created single-write restriction and
   repeat permission request were not user constraints and are withdrawn. This
   does not authorize edits to other business pages or use of real meeting data.
   Native paste/select-all already passed; do not patch the installed signed
   App. Existing authorization remains effective; these QA results do not
   authorize password access or a new OAuth flow. The later public-release
   authorization is recorded separately below.
3. Reconcile #170's existing applicable acceptance evidence, then make the one
   consolidated public candidate and complete distribution/stable closure. Keep
   #145/#170/#171 open until their actual remaining outcomes are verified.

### Consolidated RC20 published and independently verified

The user explicitly authorized merging #209, publishing `v0.23.0-rc.20`, and
publishing `v0.23.0` from the identical accepted source only after final
acceptance. This supersedes the earlier internal-CI-only publication boundary;
it does not permit password access, credential copying or new virtual machines.
The complete installed repair batch has passed. Exact-head CI `34799026924`
passed, and #209 merged as `518d8d1e8c2f74b9e9ab027f9d8a47280d988b8b`.

Release Please generated #210 with only VERSION, its manifest and CHANGELOG
changes. Its CI `34800559197` and title check passed. The reviewed release PR
merged as `edb5a7a4b932db7ceccd1cfa12b8611aa11f41d8`; the RC20 tag resolves
to that exact commit. The existing identity guard derives build **1636**, with
**1637** reserved for an eventual same-source stable promotion. Publisher
`34801526648` passed; RC20 became public at `2026-09-14T03:29:30Z` as a
prerelease, not a draft or stable release. Exact-source CI `34801526499` passed.

All four assets were independently downloaded anonymously to
`/private/tmp/yulu-rc20-public.7UJ3gn`. Their exact inventory, sizes, API digests
and published checksum rows match. The DMG SHA-256 is
`a1ef47e756523db202da1eff9d667a0f7dba642b29cfb8db3949b2fe45c282b5`.
The released body matches its generated changelog plus versioned release notes.
The DMG and containing App pass deep/strict signatures, Developer ID Team,
notarization staples and normal Gatekeeper assessment. Read-only mounted layout
and complete self-contained runtime verification pass. The release appcast
matches the exact DMG URL/size, macOS `13.0.0`, signature presence and no-delta
policy. Each of the three payloads has a verified SLSA attestation, pinned to
the exact RC20 source and official reusable publisher; self-hosted runners are
rejected. The signed stable channel remains byte-identical to its pre-publication
snapshot, SHA-256
`ee1553ba6af63e62ee826015346d53af331b075a0950319ded778c161a3973b7`.
These are public-artifact checks. The separate physical replacement result is
recorded in the current checkpoint; no clean-target installation is implied.

Release notes for the consolidated batch are prepared, and the same-source
stable promotion allowlist/guidance is aligned to RC20 rather than the failed
RC19 source. This alignment is not acceptance. Release Please has advanced
VERSION, its manifest and generated changelog to RC20; the stable public feed
must remain unchanged for this prerelease.
The internal App does not need rebuilding for publication-only files.
The release-line identity, Sparkle feed promotion and appcast suites pass all
28 tests, including refusal of RC19 promotion, mismatched tags/source and
non-increasing build identities. These isolated fixtures do not publish tags
or prove the future public artifacts.

Do not rebuild or republish the verified RC20 bytes. Update only the live public
surfaces that changed. Final fresh public install,
supported-upgrade and update acceptance remain unearned; the goal is unchanged
and must not be marked complete from successful source CI or tag creation alone.

Use the following proof boundaries for final installed acceptance:

- Fresh public install: one existing isolated target without developer runtime
  dependencies; ordinary DMG drag/install, native permissions, Host/Capture
  readiness, one synthetic recording through committed artifacts and lifecycle.
- Supported upgrade: an actual public v0.22.2 baseline with representative local
  data, observed through normal product/status surfaces before and after the
  update. Do not relabel the physical development migration as that baseline.
  Preserve a recoverable baseline for the necessary rollback/retry check; never
  roll back the user's working physical installation to manufacture a fixture.
- Credentials: no password-store or Keychain metadata collectors, credential
  copying, or new permissions. Compare non-secret product connection status and
  permitted functional outcomes. Do not claim byte-for-byte credential custody
  from availability probes; document any remaining narrower evidence gap.
- Reuse unchanged manual-sharing evidence, optional capability decisions and
  accepted external provider limitations. No further QA Notion writes are
  required by the publication label alone.
- Promote only the exact accepted RC20 source. Validate the stable public DMG,
  feed and changed guidance, and the normal whole-App RC-to-stable update before
  closing #170/#171. The historical RC19 collector is not a required workflow for
  this candidate, and its receipts remain immutable historical evidence.

### Isolated-target limitation on September 14

Only the existing Clean Host Validation VM was started; no VM was created.
Read-only preflight found macOS 26.5 and an existing build-1548 App/data, not a
demonstrated v0.22.2 baseline. A later guest Finder inspection was rejected by
the platform as outside the currently accepted VM scope. That rejection was
not bypassed through a guest shell, another VM or a different control surface.
The target is suspended, and the unrelated Windows VM was left untouched.
No guest data, credential store or permissions were changed. Fresh-install and
supported-upgrade acceptance remain unearned until an appropriate isolated
target is available within the allowed scope; do not downgrade the working
physical Mac or manufacture baseline receipts to remove this gap.

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
