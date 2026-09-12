# Phase 13 closeout — active scope, updated 2026-09-12

## Current checkpoint

- Installed: complete CI-signed/notarized `0.23.0-dev.ci.34671438759`, build 1614,
  source `a1dcdc79475799a09b261e6b1684b9f69031e28e`. Finder replaced the whole
  App; its installed CodeResources digest matches the verified CI artifact.
  Migration attempt 7 remains committed without replay; Host PID 47531 and
  Capture PID 47533 report the new version. Both native audio inputs are ready,
  idle, and database quick-check is healthy.
- The latest native shell transitioned from Starting Yulu to a white window;
  one normal Navigate > Open Yulu did not restore it. The same Host's browser
  Sharing page renders and functions. The previous build 1612 passed automatic
  entry and native Select All / Paste, but that is not a pass for build 1614.
  The two artifacts' HTML and JavaScript are byte-identical; there is no evidence
  yet that a new frontend bundle caused this white window. No speculative cache
  clearing, service reset or installed-App patch was made. Native control later
  became available: one ordinary quit/reopen reproduced the white window, while
  one normal window zoom restored the DOM and paint. Restoring the original size
  kept the page usable. This localizes the failure to initial native layout/paint,
  but does not establish that ordinary launch is fixed in the installed build.
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
  Node 24 typecheck and the production build pass. This source is not installed;
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
| Current physical migration and App takeover | CI validation App `a1dcdc7`, build 1614: committed attempt 7 retained, new Host/Capture own the runtime, native inputs ready. Automatic native UI entry passed on build 1612, not 1614; the latest browser UI works but native window is white. | Native UI acceptance is unresolved. This physical installation originated from development/legacy state; it is not a clean machine or a demonstrated real v0.22.2 baseline. |
| Committed artifacts survive whole-App replacement | Current MCP readback still returns QA task `58245ef5-b2fb-4f23-80ff-04bcaa163f34` completed on attempt 1, error null; its transcript is 227 characters, summary 1,110 characters and not stale. `sendToNotion=false`, no legacy delivery, and zero Share Actions. | This verifies preservation of dev6's successful synthetic result, not a new xAI request while the credential is unreadable. |
| Sharing setup and external write | Discovery and independent access probes passed with desktop Codex 0.153.4 / `gpt-5.6-sol`. The approved private parent and one Test Share child exist. The new source adapter verifies its exact parent/content through direct runtime RPC without a model turn. | The installed code-mode invocation is still broken. Keep the original action Unknown Outcome until the new source is installed and the same receipt is verified. No positive recording Share exists yet; do not resend or choose an unrelated business page. |
| Public distribution | RC19's retained receipt binds anonymous asset sizes/hashes to `fb2be51` and explicitly has `installedAcceptance=false`; signature/notary/site checks are retained for those bytes. | It cannot accept the later internal App or establish stable promotion. |
| Supported v0.22.2 upgrade and public update/rollback | Relevant source regressions are retained; the reviewed checkpoints continue to identify complete installed journeys as unearned. | Source tests, prepared harnesses and temporary fixture directories are not completed real-install receipts. |

RC14 retained collector digests are: preflight
`9d99629e15f1eaa95cdfeca9087aac77c6c292e21bf227bf421615f0e4ed4d7d`,
bundle observation `9d3c3f582f6444fba90e24d5379fdb8318fffab69d32a1a03ff14579a60a1962`,
and baseline journey `33680b4b39d7f9c0ef3467d6d01d13f7688d7b5e9a73bb12dff25cd4c1e36f75`.
Do not alter these old receipts or relabel them as evidence for the final source.
The current user restriction also means that a historical collector's credential-
store inspection is not permission to inspect the user's password store now.

### Required outcomes

1. Verify the native layout/paint repair in the complete internal App: ordinary
   automatic entry must work without the window-zoom workaround. The one
   pre-repair quit/reopen already reproduced the bug; do not repeat it unchanged.
   Do not reset services or clear user data speculatively.
   Current xAI account availability separately remains an unresolved live-access
   blocker. Do not repeat signing, installation or credential probes without new evidence.
   Keep the original grant/source/models and the no-password-access boundary.
   Preserve dev6's successful pipeline evidence separately from current readiness.
2. Install the complete CI-signed connector/native-window batch
   containing the proven direct-RPC repair, then reconcile the existing
   Test Share receipt read-only. Only after Host verification succeeds, manually
   share the existing synthetic QA summary once to the same private test parent
   and verify its durable receipt. Native paste/select-all already passed;
   do not patch the installed signed App or repeat the external Test Share.
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
