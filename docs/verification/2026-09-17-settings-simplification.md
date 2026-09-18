# Settings simplification — local acceptance

Date: 2026-09-17. Scope: the approved five-category settings structure, with
General and Meeting reminders as the first simplified pages.

## Changes

- Settings uses a dedicated category/content workspace. The main application
  sidebar is hidden while Settings is open; Back to Yulu restores the previous
  application route. Narrow windows use a category list and a detail page with
  a back link, rather than horizontal category tabs.
- Five presentation categories: General, Recording & notes, Meeting reminders,
  Voice input, Accounts & connections. Existing registry categories and config
  keys are unchanged. Old URLs, query parameters and connection-remediation
  hashes still reach the correct sections; settings search uses the new groups.
- General has one appearance control, language, onboarding re-entry and version.
  The large theme preview and duplicate mode selector are removed from this
  page. Install details and component diagnostics are collapsed.
- Calendar settings shows the configured source, verified connection state and
  the schedule file's update time separately. Stopped services and stale
  schedules remain visible. Connecting performs selection, probing and adoption
  sequentially through existing validated APIs. Failed service activation,
  permission failures and changed selections do not trigger adoption. Opening
  the page does not connect or authorize a provider. Google account discovery
  runs only on demand, with a refresh after the existing gog OAuth flow.
- Meeting detection's normal control is a recording prompt toggle. Numeric
  tuning and matching rules are under Advanced. Recording processing controls
  moved to Recording & notes, and storage maintenance is collapsed. AI calendar
  context and sharing remain separate from reminder scheduling.
- Editable text, number and select values can be opened with the keyboard and
  have accessible labels. Existing save/undo feedback and recording guards are
  retained. Theme save failures are surfaced and revert to the saved theme.
  Loading saved appearance/language no longer writes browser defaults back.

## Verification

- Node 24 typecheck and production server/web build passed.
- Complete frontend suite: 74 files, 556 tests passed. An additional language
  hydration regression was then added; all 3 LanguageConfigSync tests passed.
- Five isolated settings browser tests passed: five-category navigation and
  collapsed diagnostics; 360–1440px layouts; preserved legacy links; save feedback
  and recording guards; every category at 420, 760 and 960px.
- Existing four window/toolbar browser tests also passed during this change.
- Screenshots of General and Meeting reminders were inspected. Narrow padding
  and secondary-text contrast were adjusted and rechecked in the browser suite.
- The complete local App passed Developer ID signing, deep signature and runtime
  inventory verification before installation. `/Applications/Yulu.app` was
  replaced as a whole only after capture was idle and native/reminder controls
  had exited. Both existing Host and Capture jobs were refreshed.
- Installed Host serves the new JS/CSS bundle. All six runtime services report
  running; the schedule has a recent update. The user config hash is unchanged.
- Native Cmd-comma opened the new General page. Navigating to Meeting reminders
  showed the existing Google source, recent schedule update and enabled meeting
  detection; advanced details remained collapsed. The actual dark appearance
  and unified native toolbar were inspected in the installed WebKit window.

## Delivery and limits

- This is a local update of 0.23.0/build 1667, not a new public release or a newly
  notarized distribution. No push, merge or publication was performed.
- Current settings changes do not alter credentials, provider choice or calendar
  permissions. Real recording/model execution and a future meeting's notification
  delivery are outside these UI acceptance checks.
- The pre-existing automatic/background first-launch blank-window behavior is
  not claimed fixed; native Settings navigation is checked separately.
- The application before this settings update is retained at
  `/private/tmp/yulu-settings-20260917-xbrrxosl/Yulu-before-settings.app`.
  The original pre-repair backup remains documented in
  `2026-09-17-reminders-and-window.md`.
- Existing user edits to `docs/phase13-closeout.md` were preserved.
