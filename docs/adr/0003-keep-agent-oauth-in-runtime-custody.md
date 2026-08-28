# Keep Agent OAuth in runtime custody

Yulu integrates with Codex, Claude Code, Hermes, and OpenClaw by invoking each
unmodified runtime through its supported local interface. The runtime creates,
stores, refreshes, and revokes its own OAuth authorization; Yulu may initiate a
native login action and read non-secret status, but never reads, copies, stores,
or brokers the OAuth token. A user may instead explicitly select a direct API
key, which is a separate credential source stored in the system keychain and is
never used as an automatic fallback.

External proxy projects may be studied to understand native OAuth protocols,
but they are neither a Yulu runtime dependency nor an Agent Connection type.
Yulu invokes only the supported local runtimes above and direct xAI. This keeps
subscription and credential ownership in the system that issued it while Yulu
proves each selected capability through non-secret runtime evidence.
