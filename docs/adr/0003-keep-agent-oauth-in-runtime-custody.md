# Keep Agent OAuth in runtime custody

Yulu integrates with Codex, Claude Code, Hermes, and OpenClaw by invoking each
unmodified runtime through its supported local interface. The runtime creates,
stores, refreshes, and revokes its own OAuth authorization; Yulu may initiate a
native login action and read non-secret status, but never reads, copies, stores,
or brokers the OAuth token. A user may instead explicitly select a direct API
key, which is a separate credential source stored in the system keychain and is
never used as an automatic fallback.

User-managed Gateways follow the same ownership boundary. Yulu stores only the
least-privilege client key required for inference and does not request a
management key, inspect upstream authorization files, or claim which upstream
account a model uses. This preserves subscription and credential ownership in
the system that issued it while allowing Yulu to prove each selected capability
through non-secret runtime evidence.
