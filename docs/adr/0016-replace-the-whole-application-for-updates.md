# Replace the whole application for updates

Yulu uses Sparkle 2 to verify and replace the complete signed Application Runtime,
with a notarized DMG retained as the manual recovery channel. It never patches a
running App in place; background-service reconciliation and post-update health
checks belong to the versioned update transaction.

Updates are deferred during recording, checkpoint operational data before the
new Host starts, and require App, helper, database, and IPC health after relaunch.
A failed health gate offers return to the previous whole App, while migrations
remain backward-readable throughout the rollback window.
