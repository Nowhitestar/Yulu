# Meeting reminders and window chrome — local acceptance

Date: 2026-09-17. Scope: approved reminder repair and responsive window UI.

## Findings and changes

- The installed App owned Host, Capture and native controls, but never started
  the packaged calendar poller, scheduler or meeting detector. Calendar and
  detection remained enabled in configuration while their processes were absent.
- Native controls now own a bundled-Python reminder supervisor. It starts only
  after migration, respects configuration, retries exited children, and stops
  services and prompt descendants during quiescence or App shutdown. The Host
  health/control API targets these App-owned processes instead of retired agents.
- Google Calendar resolves an existing `gog` executable when the bundled PATH
  omits Homebrew. No provider credentials or permissions were changed.
- The native titlebar is transparent, has no separator and shares the content
  area with sidebar, history, search and recording controls. Sidebar collapse,
  narrow-window search and container-based single-column recording reading are
  implemented. Window dragging and double-click zoom use a local-origin bridge.

## Verification

- UI suite: 1,688 tests passed in the full run. Four tests in the existing local
  caption worker suite were blocked by the selected Xcode license state; all six
  tests in that file passed with the installed Command Line Tools selected.
  Node 24 typecheck and production build passed.
- Native recording controls and initial supervisor tests: 31 passed. Runtime
  packaging and the final supervisor tests: 70 passed, including real timer/HUP
  delivery to harmless test presenters and cleanup of prompt descendants.
- Five relevant shell contracts passed; the two window contracts also passed
  after the final window change. The compiled WebKit navigation smoke passed.
- Browser layout tests passed at 420, 540, 768, 960, 1100 and 1440 pixels, with
  sidebar/history/search interaction coverage. A separate initial-route test
  passed without a resize or route switch (four browser tests total).
- The complete local App passed Developer ID signing and runtime inventory
  verification. It is installed at `/Applications/Yulu.app`. Both App-owned
  launchd services were refreshed so loaded executable identities match the
  replacement bundle. Capture was confirmed idle before replacements.
- Installed health reports all six components running. Microphone and system
  capture are ready. Calendar polling refreshed the formerly stale schedule to
  five meetings and six scheduled events; meeting contents were not used as
  test fixtures. No live recording or model request was initiated by this task.
- Ordinary Finder launch rendered the full Agent Console. Native toolbar
  double-click zoom expanded and restored the window, with responsive controls.

## Limits and delivery

- Automated background launches can still show the pre-existing blank window.
  Nonzero initial WebKit dimensions did not eliminate that path. An isolated
  WebKit probe loaded the real default page with no script errors and a visible,
  correctly sized toolbar. Ordinary Finder launch passed. Do not claim the
  automated background-launch issue is fixed.
- Reminder timing and prompt dispatch are tested with isolated presenters;
  delivery at the next real meeting remains a future live event.
- This is a local repair of version 0.23.0/build 1667, not a new public release
  or a newly notarized distribution. No push, merge or publication was performed.
- The original installed App is retained at
  `/private/tmp/yulu-reminder-ui-atyyfho2/Yulu-before.app` for local rollback.
- Pre-existing edits in `docs/phase13-closeout.md` were preserved.

## Follow-up on 2026-09-18

The background-launch blank-window limitation above was addressed by the
[native startup readiness fix](2026-09-18-native-startup.md). Two installed cold
starts and native Settings/status navigation passed with the new loading flow.
The earlier evidence remains scoped to its original candidate.
