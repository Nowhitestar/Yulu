# ADR-007: Explicit Yulu audio transcription engines

Status: Accepted

Supersedes the audio-ownership and fallback decisions in ADR-005 and ADR-006;
their durable task, Agent summary, and local-caption UX decisions remain in force.

## Context

Realtime captions, final meeting transcripts, and dictation were coupled to
different execution paths, including a hidden fallback to Hermes. That made the
selected behavior unpredictable and made audio features fail when the summary
Agent was unavailable.

## Decision

Yulu owns one explicit audio-engine selection for all three audio features:

- `local` (default): the Yulu-managed sherpa-onnx Paraformer runtime;
- `xai`: xAI Streaming STT for realtime captions and xAI REST STT for final
  transcripts and dictation.

Yulu never switches engines automatically. A session is locked to the engine
selected when it starts, and an unavailable selected engine produces a visible
failure.

The xAI option reuses an existing xAI OAuth session from Hermes or OpenClaw.
Those Agents are credential wallets only: Yulu resolves the short-lived bearer
in memory and connects directly to xAI. Yulu does not install an Agent, store the
OAuth token, or route audio through Hermes/OpenClaw. If neither installed Agent
supports and holds xAI OAuth, the xAI option is unavailable.

Final transcripts are committed independently before summary generation. The
summary and connector workflow may wait for its Agent without losing the
transcript.

## Consequences

- Realtime captions, final transcripts, and dictation have one predictable
  privacy/provider choice.
- Summary Agent availability no longer controls audio transcription health.
- The local engine never silently uploads audio, and xAI never silently falls
  back to local.
- Existing Hermes/OpenClaw OAuth storage remains the credential source without
  becoming an audio execution dependency.
