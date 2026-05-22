# Architecture Decision Records

ADRs are **locked** — they record decisions already made. If you think one needs
to change, write a new ADR that supersedes it; don't edit the old text in place.

ADRs are deliberately short. They answer: *what was decided*, *what we ruled
out*, and *why*. Implementation details belong in the matching spec under
[`docs/superpowers/specs/`](../../../docs/superpowers/specs/).

## Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [001](001-resident-stt-daemon.md) | Resident `stt_daemon` with two-slot scheduler | Accepted | 2026-05-22 |
| [002](002-vocab-sqlite-single-source.md) | Single SQLite vocabulary, two application points | Accepted | 2026-05-22 |
| [003](003-realtime-as-daemon-subscriber.md) | `realtime_transcribe.py` rewritten as daemon subscriber (not deleted) | Accepted | 2026-05-22 |
| [004](004-prompt-library.md) | Prompt Library + multi-summary with single LLM dispatcher | Accepted | 2026-05-22 |
