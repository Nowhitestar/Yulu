# ADR-011: Explicit live-caption translation

**Status**: Accepted
**Date**: 2026-11-19
**Extends**: [ADR-010](010-retire-yulu-conversation.md), whose decision 2 makes
Hermes and OpenClaw MCP clients only. It supersedes no earlier decision; it
removes the last Hermes runtime dependency that decision missed.

## Context

The caption overlay offers `双语` (bilingual) and `仅翻译` (translation only).
The Host translated each caption by running `realtime_translate.py` with the
Python from `~/.hermes/hermes-agent/venv` (or `YULU_HERMES_HOME`/`HERMES_HOME`).
That script read Hermes's config and model routing to choose a provider and
model. This had three problems:

- Yulu treated Hermes as an inference runtime, not an MCP client.
- Without Hermes, translation failed on every caption and the overlay showed
  only a generic failure.
- Meeting caption text went to whatever provider Hermes was routed to, and
  Yulu disclosed none of it.

The obvious replacement is the dictation text selection from ADR-010
(`transcription.dictation.text_provider` and `text_model`). It does not fit
captions as it is:

- Its disclosure (`xai-dictation-text-v1`) says meeting recordings are not
  included. Captions are meeting content, and they include what other
  participants say.
- Turning that switch on also turns on per-utterance dictation cleanup. Turning
  on one data path must not turn on another.

## Decision

1. **Captions are translated in the Host through the stateless xAI text
   client.** The Host uses `xaiText.ts` with capability `captions` and the
   selected xAI credential source (ADR-009), with response storage disabled.
   No Hermes, Agent CLI or Python runtime is involved, and
   `realtime_translate.py` is removed.
2. **Caption translation has its own explicit selection.**
   `transcription.captions.translation_provider` is `none` or `xai`, default
   `none`. `transcription.captions.translation_model` is an exact xAI model,
   default `grok-4.20-0309-non-reasoning`, because captions need low latency.
   The dictation selection does not enable caption translation, and caption
   translation does not enable dictation.
3. **Caption translation has its own disclosure.** `xai-caption-text-v1` says
   that the caption text of the current recording, including other
   participants' speech, is sent to xAI while bilingual or translation-only
   captions are shown. The receipt is stored in an additive
   `caption_translation_disclosures` table and cleared when the xAI connection
   is removed. Neither the dictation receipt nor a Hermes setup counts as
   consent.
4. **It runs only with the `xai` audio engine.** With the `local` engine,
   captions do not leave the Mac, the same rule ADR-010 sets for dictation.
5. **The overlay mode is a request, not consent.** Choosing `双语` or `仅翻译`
   asks for translation in that recording only. If the selection, audio engine,
   disclosure or connection is missing, the Host sends nothing and publishes
   `translationStatus: "unavailable"` with a reason: `provider_off`,
   `needs_xai_audio`, `needs_disclosure` or `needs_connection`. The overlay
   shows that reason and keeps the source captions on screen. The Host checks
   again for each new caption, so enabling translation in Settings during a
   recording takes effect at the next caption.
6. **There is no fallback.** A failed or timed-out request marks that caption's
   translation `failed`. It is never retried with another model or provider.
   The next caption is a new request.

Each request contains only the current caption segment, up to two previous
segments as read-only context, the target language, and glossary entries that
match the segment. Requests have no tools or history and are not persisted.

## Privacy

This is a privacy change, and it narrows what is sent:

- **Before:** with Hermes installed, choosing `双语` or `仅翻译` sent caption
  text to Hermes's routed provider, with no Yulu disclosure, under either audio
  engine.
- **After:** nothing is sent unless the user turns on caption translation in
  Settings, accepts `xai-caption-text-v1`, selects the `xai` audio engine,
  connects xAI, and chooses a translated overlay mode. The text then goes
  directly to xAI.

With the `xai` engine, xAI already receives the recording audio under Cloud
Transcription Consent. That consent covers speech-to-text, not text sent to a
language model, so caption translation needs its own disclosure.

## Migration

- **Config.** No existing key changes. The new keys default to `none` and the
  fast model, so caption translation is off for everyone after upgrade,
  including former Hermes users. Nothing switches a user from Hermes to xAI.
  `transcription` is passthrough, so a rollback keeps the new keys.
- **Host SQLite.** One additive table, `caption_translation_disclosures`. No
  existing table changes, and a rollback ignores the table.
- **Hermes.** The Host no longer reads `~/.hermes`, `YULU_HERMES_HOME` or
  `HERMES_HOME` for captions. Hermes configuration is not read, changed or
  imported. `yulu mcp` still registers Yulu with Hermes as an MCP client.
- **Rollback.** An earlier version uses Hermes again where it is installed.

## Rejected alternatives

- **Reuse the dictation switch and disclosure.** The disclosure would be wrong
  about what is sent, and enabling captions would also enable dictation
  cleanup.
- **Reuse the dictation switch with a second disclosure.** Consent would then
  be separate, but enabling caption translation would still enable dictation
  cleanup.
- **Allow translation with the local audio engine.** That breaks the promise
  that local transcription keeps speech on the Mac. It could be added later
  under its own decision.
- **Keep Hermes as an optional translator.** It conflicts with ADR-010, and
  users would still not know which provider received meeting text.
- **Treat the overlay mode as consent.** A hover menu over a live meeting is not
  an informed disclosure, and one mis-click would start sending meeting text.

## Consequences

- Caption translation works without Hermes, through one disclosed provider and
  an exact model.
- Users who translated captions through Hermes, or who use the local engine,
  lose translation until they opt in with the xAI engine.
- `yulu doctor` reports a `caption_translation` privacy entry next to
  `dictation_text`.
- The xAI text client has three bounded, non-streaming capabilities: `summary`,
  `dictation` and `captions`.
