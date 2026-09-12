# Register services only from Applications

Yulu registers background services and enables updates only when launched from
`/Applications/Yulu.app`. Launching from a mounted DMG or another location shows
drag-to-Applications guidance and performs no persistent service mutation, which
keeps helper paths, Gatekeeper validation, and updates deterministic.

The bundled jobs use `com.yulu.app.host` and `com.yulu.app.capture`. Their
launchd labels must be distinct from repository-install LaunchAgents: macOS can
retain a legacy Background Task Management record after the job is removed,
including an enabled status without a running bundled owner. Reusing that label
can make registration or rollback fail.

The bundled plist filenames remain `com.yulu.ui.plist` and
`com.yulu.audiodaemon.plist`, preserving existing migration/update transaction
bindings. Capture's code-signing, bundle and TCC identity remains
`com.yulu.audiodaemon`; changing the launchd label must not request a new identity's
recording permissions.

For an already migrated older App, two dormant compatibility descriptors
(`RetiredHost.plist`, `RetiredCapture.plist`) let SMAppService unregister the old
labels. They are never registered, cannot run an owner, and are used only after
observing an App-managed job at the exact bundled program and proving Capture
idle. This cleanup runs under the migration attempt lock, without replaying data
migration or touching repository-install jobs. A committed data migration still
needs current service registration and health verification after App replacement.
