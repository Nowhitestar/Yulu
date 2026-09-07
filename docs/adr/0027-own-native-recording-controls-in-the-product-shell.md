# Own native recording controls in the product shell

The Application Runtime links the existing native recording implementation into
the product shell. The shell activates it only after Application Migration has
committed. During Application Update health verification it first prepares an
exclusively owned, listening IPC endpoint with command admission closed; missing
native readiness fails the update health gate before commit. Recording controls,
configured dictation and translation hotkeys,
voice-chat presentation, and focused-application insertion remain behind the
existing private IPC interface; they require no separately installed StatusAgent
or additional SMAppService owner.

The shell supplies the same sealed Python, script, helper, and standard data paths
used by its bundled Host. Native commands cannot resolve a host Python or inherit
an ambient Python import path. The legacy standalone entry point remains a
development/compatibility build of the same implementation, not a production
dependency. Recording presenters are bundled, signed, and inventoried with the
App. Capture keeps its existing identity.

Native controls acquire exclusive IPC ownership before publishing their PID and
remove only their own socket on exit. Configuration loading cannot block shell
startup. Application Update must account for owned native work as well as Capture:
it defers while that work is running and closes native command admission before
unregistering services or checkpointing. Ordinary App termination also waits for
owned native commands to finish. Closing the main window keeps controls available;
quitting the App removes its hotkeys and IPC endpoint.

Admitted IPC commands remain owned while queued on the main thread, not just
while a Python subprocess is running. The recording presenter sends a stop-only
request to this owner, so its processing command uses the sealed runtime and
participates in the same drain. It never launches a separate host Python.

Moving control authority into Host would require a new bidirectional native
bridge and migration of all callers. Adding another helper owner would instead
expand service takeover, attestation, update, and rollback contracts. In-process
composition keeps the existing behavior and control interface local to the shell;
the trade-off is that native interaction shares the shell's crash fate and
Accessibility permission identity. Installed-App acceptance must verify that
permission path; historical StatusAgent approval cannot be assumed to transfer.

Recording Processing still ends with transcript and the selected summary. Native
controls never authorize a Share Action. This is a Phase 13 acceptance-defect
repair under #145/#170, not completion of Release Candidate Acceptance.
