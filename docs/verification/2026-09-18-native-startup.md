# Native startup blank-page follow-up

Scope: finish installed-window acceptance after the approved assistant and status
UI changes. Preserve the user's data, configuration, and service ownership.

## Findings

- The blank native window was reproducible while Host and Capture were healthy.
  Main-thread and WebKit process samples showed idle run loops, not a persistent
  main-thread deadlock. The page could eventually become visible without any
  data reset.
- The shell hid the WebView during navigation, then immediately removed its
  loading message in `didFinishNavigation`. This left a gap between document
  loading and React's asynchronous first commit. The old native smoke checked
  only navigation and view dimensions, so it did not cover an empty React root.
- Apple defines [didFinish navigation](https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:didfinish:))
  as navigation completion. It does not establish application readiness.
  WebKit also documents that [inactive pages can suspend rendering work](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/).

## Change

- Keep the sized WebView attached and visible while a native loading surface
  covers it. Do not toggle WebView visibility to trigger the initial paint.
- The React root layout marks its committed shell. Native code checks that the
  marked shell has nonzero rendered bounds before uncovering it. It does not
  wait on an AI request or require provider credentials to be available.
- Loading has a 20-second bound. Navigation failure, initialization failure,
  timeout, or a terminated WebKit content process presents a native Retry button.
  The button reloads the requested local page. Generation and navigation checks
  discard obsolete callbacks; failure cancels pending readiness checks.
- No cache clearing, preference reset, extra permissions, service migration, or
  changes to external-link origin restrictions are part of this repair.

## Verification

- Native shell contracts: 4 passed. Release build inspection confirms
  `developmentSmoke=false`, `nativeRecordingControls=true`.
- Compiled WebKit smoke passed: a loaded document with an empty application root
  stays in loading state, a later application commit becomes ready without a
  resize, and a simulated content-process termination is followed by successful
  navigation recovery. Reattaching the view and the existing trusted/untrusted
  external-link checks also passed. This is an isolated regression test, not an
  assertion that the installed content process was deliberately terminated.
- Frontend typecheck, production web build, and the isolated initial-route
  browser test passed. The test checks the ready marker, visible toolbar, default
  route, and absence of page errors. Existing broader UI tests are recorded in
  [assistant and status verification](2026-09-18-assistant-and-status.md).
- Complete candidate App signing, runtime inventory, and deep strict signature
  validation passed using the installed Command Line Tools. The installed App
  serves `index-BwwTzINk.js` and `index-BMGi9pe2.css`; fetched JavaScript and index
  bytes match its bundle.
- Two installed native cold starts rendered the meeting assistant without a
  route change or resize. Cmd-comma loaded Settings successfully, and the runtime
  status page displayed its capability list with diagnostics initially folded.
  These checks completed without the previous automation timeout.
- All six runtime services were running; capture was idle with both inputs ready.
  Calendar polling refreshed the schedule. Configuration hashes matched the
  pre-install baseline. No real recording, model request, or sharing was started.

## Local delivery

Installed at `/Applications/Yulu.app`, version 0.23.0/build 1667. Previous App:
`/private/tmp/yulu-startup-fix-20260918-an8dyun8/Yulu-before-startup-fix.app`.
No push, merge, public release, or notarization was performed. Acceptance applies
to this physical Mac and the tested startup paths; it is not a cross-OS release
qualification. Pre-existing `docs/phase13-closeout.md` edits were untouched.
