# Migrate operational data to standard user locations

The self-contained App transactionally migrates configuration, durable databases,
onboarding state, and the file-backed MCP token into
`~/Library/Application Support/Yulu`, models into its `Models` child, caches and
IPC into `~/Library/Caches/Yulu`, and logs into `~/Library/Logs/Yulu`. Keychain
items remain in Keychain, recordings remain in the configured Media Library,
legacy dictation media moves to `~/Movies/Yulu/Dictation`, and the old data roots
remain as a read-only rollback backup for one release cycle.
