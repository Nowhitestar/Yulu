# Meeting assistant and runtime status simplification

Approved scope: simplify Agent Console into a conversation workspace, move
connection management to Settings, and replace the daemon-only health headline
with capability status and actionable remediation. Keep existing deep links,
pinned conversation recovery, task reconciliation, and recording guards.

Design: reuse Yulu's current theme tokens and typography. One quiet conversation
header, collapsible history, meeting references beside the composer; one compact
feature list for status, with detailed controls behind Advanced diagnostics.
Compact windows must keep the composer reachable and avoid horizontal overflow.

Acceptance work:
- Implement both pages and move connector management without losing its actions.
- Cover truthful unknown/disabled/error status and existing safe recovery paths.
- Check type safety, production build, focused frontend/router tests, and
  responsive browser layouts with isolated data.
- Verify the local installed App after confirming capture is idle. Do not change
  user configuration, trigger model requests, or send recording content.

## Implementation and verification

- Meeting assistant now has one compact conversation header, collapsible history,
  a reachable composer, optional meeting references, and collapsed citations.
  Pinned session recovery and unknown-outcome safeguards remain intact. Connection
  management is in Settings and loads only when expanded; connector credentials
  still belong to the selected Agent.
- Runtime status presents five capabilities with actionable settings links.
  Disabled, unconfigured, unchecked, and failed checks are distinct. Cached green
  results do not survive a failed refresh. Technical task/service/log controls
  remain available under Advanced diagnostics, including existing deep links.
- Full frontend run: 76 files / 564 tests passed. Final focused frontend run:
  4 files / 36 tests passed. Related router run: 2 files / 33 tests passed.
  Typecheck and production Host/web build passed.
- Three isolated browser tests passed across widths 360–1440, covering history
  keyboard focus, the composer, meeting references without a model request,
  diagnostics deep links and keyboard tabs, and failed-refresh state handling.
- Whole-App Developer ID signing and runtime inventory verification passed. The
  App was updated locally after capture and native controls were confirmed idle.
  No configuration, credentials, recording content, or model requests were used
  to exercise the UI.

## Installed-window acceptance

The first installation exposed an intermittent native startup blank page. That
blocked native-window acceptance even though the Host and web resources were
healthy. The follow-up [native startup fix](2026-09-18-native-startup.md) now keeps
WebKit visible during loading and waits for the actual React shell before
uncovering it.

After that complete App update, two native cold starts rendered the meeting
assistant without a resize or route switch. The Settings keyboard shortcut and
the runtime status page were also checked in the actual native window. Advanced
diagnostics was collapsed by default. Native inspection used the default
960×680 window; responsive widths are covered by the browser tests above.

All six runtime services were running after the update. Capture remained idle
with microphone and system audio ready; calendar polling refreshed the schedule.
The user configuration hash was unchanged. This is a local repair of
0.23.0/build 1667, not a new public release or newly notarized distribution.
