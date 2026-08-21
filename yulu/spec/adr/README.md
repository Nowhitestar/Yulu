# Architecture Decision Records

ADRs are **locked** — they record decisions already made. If you think one needs
to change, write a new ADR that supersedes it; don't edit the old text in place.

ADRs are deliberately short. They answer: *what was decided*, *what we ruled
out*, and *why*. Implementation details belong in the matching spec under
[`docs/superpowers/specs/`](../../../docs/superpowers/specs/).

## Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [001](001-resident-stt-daemon.md) | Resident `stt_daemon` with two-slot scheduler | Superseded by [ADR-005](005-agent-native-durable-recording-pipeline.md) | 2026-05-22 |
| [002](002-vocab-sqlite-single-source.md) | Single SQLite vocabulary, two application points | Accepted | 2026-05-22 |
| [003](003-realtime-as-daemon-subscriber.md) | `realtime_transcribe.py` rewritten as daemon subscriber (not deleted) | Superseded by [ADR-005](005-agent-native-durable-recording-pipeline.md) | 2026-05-22 |
| [004](004-prompt-library.md) | Prompt Library + multi-summary with single LLM dispatcher | Catalog accepted; runtime dispatch superseded by [ADR-005](005-agent-native-durable-recording-pipeline.md) | 2026-05-22 |
| [005](005-agent-native-durable-recording-pipeline.md) | Agent-native durable recording pipeline | Durable task/Agent boundary retained; audio ownership superseded by [ADR-007](007-explicit-audio-transcription-engines.md) | 2026-07-11 |
| [006](006-local-hybrid-realtime-captions.md) | Local hybrid realtime captions | Superseded by [ADR-007](007-explicit-audio-transcription-engines.md) | 2026-07-16 |
| [007](007-explicit-audio-transcription-engines.md) | Explicit Yulu audio transcription engines | Audio-engine decision retained; credential source superseded by [ADR-008](008-yulu-owned-xai-oauth.md) | 2026-07-17 |
| [008](008-yulu-owned-xai-oauth.md) | Yulu-owned xAI OAuth | Accepted | 2026-07-28 |
