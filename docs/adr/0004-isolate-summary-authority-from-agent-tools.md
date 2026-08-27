# Isolate summary authority from Agent tools

Agent-backed summaries run in a new isolated session that receives only the
selected instructions and committed transcript. The adapter disables project
instructions, skills, hooks, MCP servers, connectors, delivery, shell access,
and other tools wherever the runtime supports that boundary. Yulu stages the
returned content, validates Runtime Evidence, and alone commits the durable
summary artifact. A Summary request therefore cannot create external side
effects or inherit an unrelated user conversation.

Conversation is a different Agent Capability. After its own Data Path
Disclosure, a user may explicitly use the selected Agent's connectors and tools
inside a pinned Conversation session. Connection and readiness probes remain
tool-free. This separation preserves the value of an Agent-owned conversational
workspace without granting that broader authority to background recording
processing.
