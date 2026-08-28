# Register services only from Applications

Yulu registers background services and enables updates only when launched from
`/Applications/Yulu.app`. Launching from a mounted DMG or another location shows
drag-to-Applications guidance and performs no persistent service mutation, which
keeps helper paths, Gatekeeper validation, and updates deterministic.
