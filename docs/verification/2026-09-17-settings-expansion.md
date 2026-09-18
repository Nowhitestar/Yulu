# Settings simplification — remaining categories

Date: 2026-09-17. Scope: the user's approved extension of the General and Meeting
reminders approach to every remaining settings category.

## Implemented

- Accounts & connections starts with the service selected for transcription,
  summary, and conversation. Configure reveals the relevant account and
  capability. Provider login details, model controls, past checks, candidate
  discovery, and installation guidance are progressively disclosed. Existing
  connection/capability, candidate, legacy, and settings links remain reachable.
- Model drafts cannot inherit a previous model's ready status. Direct xAI model
  changes must be saved before testing; supported runtimes require a successful
  check for the drafted model before selection. Existing explicit data-path
  consent, new-attempt rules for unknown outcomes, and deletion-impact dialogs
  remain in place. Opening settings does not send model requests.
- Sharing uses a draft account/service selection and one explicit connection
  check. Destination discovery is optional, and saved destinations remain
  distinct from suggestions and successful delivery. Every Test Share still
  needs a fresh confirmation; unknown outcomes still require reconciliation or
  abandonment. Checks and destination saves do not send a message.
- AI calendar access combines explicit selection, read-only checking, and
  enabling into one action. Failed checks and checks for another selection never
  enable the capability. This remains separate from meeting reminder scheduling.
- Recording & notes leads with microphone and save location, followed by the
  chosen transcription engine and then recording-completion behavior. Language
  options use normal names. Only the active engine's setup is presented; local
  model maintenance and silence detection are secondary. Active recording still
  blocks model removal. Removed the unsupported fixed latency estimate.
- Voice input leads with live availability, sounds, shortcuts, and translation
  language. Templates are secondary. Change uses a pencil and clear capture
  instructions; Escape cancels. A shortcut is saved as one complete value with
  one notification to the service, preserving optional fields and one-step undo.
- All pages inherit the five-category shell, theme, window adaptation, save/undo
  feedback, and applicable recording guards from the first settings update.

## Verified

- Node 24 TypeScript check and production Host/web build passed.
- Full frontend suite: 74 files, 566 tests passed.
- Configuration router suite: 26 tests passed, including a complete shortcut
  update that preserves translation language and signals the service once.
- Browser suite: 12 tests passed (8 settings, 4 existing window/toolbar tests).
  Includes 360–1440px settings layouts, all expanded remaining settings at
  360px, keyboard configuration, Escape cancellation, complete shortcut saving,
  legacy/remediation navigation, and recording guards.
- Fixture screenshots of wide/narrow Accounts, Recording, and Voice pages were
  inspected. Repeated shortcut hints were consolidated into one instruction.
- The candidate App passed Developer ID signing, runtime inventory verification,
  and deep signature validation. Signature validation ran in the system signing
  environment; the restricted sandbox reports invalid signatures for otherwise
  valid signed native binaries.
- Installed `/Applications/Yulu.app` was replaced as a whole after capture was
  confirmed idle and native controls had exited. The old App is retained at
  `/private/tmp/yulu-settings-expanded-20260917-svjnkqdl/Yulu-before-expansion.app`.
  Both existing Host and Capture services were refreshed.
- The installed Host serves `index-UmLkukN5.js` and `index-C1hfKI2H.css`; both
  responses match the installed files. Native executable identity resolves to
  `/Applications/Yulu.app/Contents/MacOS/yulu_app`.
- The three updated pages were inspected in the installed macOS WebKit window
  using the user's existing dark appearance. Accounts showed the existing
  selections, Voice showed running shortcut service, and Recording showed the
  selected xAI engine. Settings were reached through native Cmd-comma after
  startup; no first-launch behavior repair is claimed by this UI change.
- All six runtime services reported running, both capture inputs ready, capture
  idle, and the schedule recently updated. The user configuration SHA-256 was
  unchanged before and after installation and navigation.

## Delivery boundary

Local installed update of 0.23.0/build 1667. No public release, push, merge, or new
notarized distribution. Real model requests, recording, calendar authorization,
and external sharing were not initiated for UI acceptance. Reminder delivery at
a future meeting remains outside this verification. Pre-existing user edits in
`docs/phase13-closeout.md` were preserved.
