# Migrate data and service ownership transactionally

Application Migration is forbidden during recording and uses one migration lock,
a durable journal, and a database checkpoint before stopping legacy jobs. It
migrates data, installs the new `SMAppService` jobs, and proves exactly one Host,
one Capture helper, and one IPC owner before committing; any failure removes the
partial new ownership and restores the legacy jobs and paths. Database changes
remain additive and backward-readable until the one-release rollback window ends.
