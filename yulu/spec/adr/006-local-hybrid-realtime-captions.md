# ADR-006: Local hybrid realtime captions

**Status**: Accepted
**Date**: 2026-07-16
**Extends**: [ADR-005](005-agent-native-durable-recording-pipeline.md)

## Context

Agent-owned chunk transcription preserves one intelligence boundary but cannot
produce consistently sub-second live captions. The recording UI needs fast text
while the durable transcript still needs the higher quality, glossary-aware
Hermes/Whisper pass defined by ADR-005.

## Decision

Use two deliberately separate stages:

1. An optional Host-owned sherpa-onnx streaming Paraformer INT8 worker consumes
   source-separated 16 kHz microphone and system PCM. It keeps one resident CPU
   model and publishes mutable partials plus endpoint-stable segments.
2. Realtime segments may be corrected through the local glossary and deduplicated
   across channels, but remain ephemeral display/sidecar data.
3. Recording completion always runs the Hermes transcription workflow over the
   completed WAV. Realtime text is never promoted to the durable transcript.
4. Missing or failed local inference falls back within the active recording to
   the existing Agent-compatible chunk path.
5. The runtime is optional and user-managed from Settings. Installation is
   checksum-pinned, audio stays on the Mac, and uninstall is blocked during an
   active recording.

## Consequences

- Live captions target sub-second first text without a usage fee or network hop.
- The installed runtime and INT8 model consume roughly 320 MB on disk and about
  0.5 GB of memory while loaded.
- Paraformer live text is weaker on names and mixed-language jargon than the final
  Whisper pass, so the UI must communicate that live captions may revise.
- ADR-005 remains the durable artifact and Agent-ownership boundary.
