# ADR-012: Live notes replace live captions

**Status**: Accepted; amended 2026-11-20 ([on by default](#amendment-2026-11-20-on-by-default))
**Date**: 2026-11-19
**Supersedes**: [ADR-011](011-explicit-live-caption-translation.md) in full.
**Refines**: [ADR-007](007-explicit-audio-transcription-engines.md), whose
final transcript may now be the selected engine's own live transcript.
**Keeps**: [ADR-010](010-retire-yulu-conversation.md). Live notes are a bounded,
stateless rewrite of one meeting's notes, not a conversation.

## Context

During a recording, the floating overlay showed one or two lines of live
captions, with optional translation (ADR-011). People rarely read captions of a
meeting they are attending. What they want during the meeting is the gist so
far: decisions, owners, open questions, sometimes a table or a diagram. They
also want to jot their own notes without leaving the meeting app.

After the recording, Yulu transcribed the whole file again, even when the live
transcript already covered all of it with the same engine. That doubled the
transcription time and, with the `xai` engine, uploaded the audio twice.

## Decision

1. **The overlay becomes a live notes panel.** `recorder_status` shows the
   Host's `/live` page in a WebView inside a tall glass panel on the right edge
   of the screen. It collapses to Yulu's app icon, stops the recording,
   and takes typing without activating Yulu, so the meeting app stays in front.
   The page asks the panel for exactly five things: `collapse`, `drag`,
   `stop`, `open` (only `/settings…` and `/inbox…` routes, through the
   menu-bar companion's `open_route`) and `appearance`. The panel accepts
   them only from the main frame of `http://127.0.0.1:<port>`, never navigates
   away from `/live`, and opens a link in the notes in the browser only when it
   is clicked and is `https`.
2. **Live notes are written by the Host through the stateless xAI text
   client.** The capability is `live_notes`. It runs only when
   `transcription.live_notes.provider` is `xai` (originally default `none`;
   `xai` since the [2026-11-20 amendment](#amendment-2026-11-20-on-by-default)),
   the `xai-live-notes-v1` disclosure was accepted, and an xAI credential source
   is connected. The model is exact: `transcription.live_notes.model`, default
   `grok-4.20-0309-non-reasoning`, because notes must keep up with the meeting.
   There is no fallback to another model or provider.
3. **The disclosure is its own.** `xai-live-notes-v1` says that new transcript
   text from the meeting, including what other participants say, the notes the
   attendee types and matching glossary entries are sent to xAI while a
   meeting is recorded, and that audio is not. The receipt is stored in
   `live_notes_disclosures` and cleared when the xAI connection is removed.
   Neither the dictation nor the summary receipt counts as consent.
4. **Live notes work with either audio engine.** Unlike ADR-011, live notes do
   not require the `xai` audio engine: they send text, not audio, and only after
   the explicit switch and disclosure above. With the `local` engine and live
   notes off, nothing from the meeting leaves the Mac.
5. **Each update is bounded.** A request carries the previous notes, the
   transcript text added since the last update (at most 12,000 characters), a
   short recent window for context, the attendee's notes, the chosen language
   and the glossary entries that match. It has no tools and no history, and
   response storage is off. Updates run about every 45 to 90 seconds when
   enough new speech arrived, sooner after the attendee adds a note, and once
   more when the recording stops. A failed update keeps the earlier notes; the
   next update is a new request.
6. **The attendee's own notes are plain text and stay on the Mac.** Each note
   is at most 500 characters, at most 200 per recording, stored with its time
   in `<stem>.mynotes.json` (mode `0600`) whether or not live notes are on.
   They feed live notes when those are on, and the post-meeting summary for
   every Summary Provider, always marked as data, never as instructions.
7. **The attendee chooses the notes' language.** `zh` or `en` per recording,
   defaulting to `transcription.live_notes.language` or the interface
   language. Switching rewrites the notes in the other language.
8. **Live notes are saved with the recording.** The Host writes
   `<stem>.notes.md` atomically with mode `0600`. The reading page shows them
   under 笔记, next to 摘要 and 转写, and MCP `recording_get` returns them. They
   are deleted with the recording. They are a Host-written sidecar, not a task
   artifact: task completion never waits for them.
9. **A complete live transcript is the final transcript.** When the live
   transcript finished, was trusted, used the same language and the same
   engine family, and covers at least 98% of the audio, the Host commits it
   instead of transcribing again and records `transcriptSource: "realtime"`.
   Otherwise the selected engine transcribes the file once, as before. The
   engine never changes. For `xai`, the final transcript may therefore come
   from Streaming STT rather than REST STT.
10. **Live-caption translation is retired.** The caption strip, `双语` and
    `仅翻译`, the caption translation service and its settings are removed.

## Privacy

- **Before:** caption text went to xAI only with the `xai` audio engine,
  caption translation turned on and `xai-caption-text-v1` accepted. With the
  `xai` engine the audio was uploaded twice: live, then for the final
  transcript.
- **After:** no caption text is sent. Meeting text goes to xAI for live notes
  only after the attendee turns them on and accepts `xai-live-notes-v1`, with
  either audio engine. (Since the [2026-11-20
  amendment](#amendment-2026-11-20-on-by-default) the switch is on by default;
  accepting the disclosure is the explicit step.) With the `local` engine that
  is a new, opt-in text path, and the disclosure names it. With the `xai` engine, a complete live
  transcript means the audio is uploaded once.

## Migration

- **Config.** `transcription.captions` is archived with mode `0600` to
  `config.legacy-transcription.<stamp>.json`, removed from the active config,
  and rejected on write. `transcription.live_notes` defaults to `none`, so
  nobody starts sending meeting text after an upgrade, including people who
  had caption translation on. (The [2026-11-20
  amendment](#amendment-2026-11-20-on-by-default) changes this default to
  `xai`; the disclosure is what keeps an upgrade from sending meeting text.)
- **Host SQLite.** `caption_translation_disclosures` is dropped, so a retired
  consent can never authorize anything. `live_notes_disclosures` is additive.
- **Endpoints.** `POST /api/recordings/realtime/options` is removed. An older
  overlay that still posts to it gets `404` and keeps recording.
- **Doctor.** The privacy report replaces `caption_translation` with
  `live_notes`.
- **Rollback.** An earlier version finds no caption settings, so caption
  translation stays off, and it ignores `live_notes` and the new sidecar files.

## Rejected alternatives

- **Keep captions next to the notes.** Two live surfaces compete for the same
  corner of attention; the person asked for notes instead of captions.
- **Require the `xai` audio engine.** It would tie a text feature to an audio
  choice. Live notes send text only, under their own disclosure.
- **Reuse the summary selection for live notes.** A pinned Summary Provider
  runs once per recording and may be a slow Agent; live notes need a fast,
  exact model every minute.
- **A local model for live notes.** Yulu ships no local language model, and
  rewriting structured notes every minute needs one that is fast and good.
- **Replace the post-meeting summary with live notes now.** The summary stays
  until the notes have proved themselves in real meetings.

## Consequences

- During a meeting, the panel shows structured notes (lists, tables and Mermaid
  diagrams drawn on the Mac) and takes the attendee's own notes.
- Each recording can have three readable results: notes, summary and
  transcript.
- Recordings whose live transcript is complete finish sooner and, with `xai`,
  upload audio once.
- People who used caption translation lose it.
- The xAI text client has three bounded, non-streaming capabilities:
  `summary`, `dictation` and `live_notes`.

## Amendment (2026-11-20): on by default

**Status**: Accepted
**Changes**: the default in Decision 2 and the config note under Migration.
Everything else in this ADR stands.

Live notes are now on by default. A missing `transcription.live_notes.provider`
means `xai`, for new installs and after an upgrade. An explicit `"none"` keeps
them off, and no migration rewrites an existing config.

The switch is no longer the consent; the disclosure is. The gates that decide
whether anything is sent are unchanged:

- Nothing is sent before the attendee accepts `xai-live-notes-v1` once. While
  the switch is on and the disclosure is not accepted, Settings shows it right
  away with two choices: accept, which records the receipt and writes
  `provider: "xai"` so the choice is explicit, or turn off, which writes
  `"none"`. Removing the xAI connection still clears the receipt, so the
  disclosure is shown again.
- An xAI credential source must be connected.
- There is no fallback to another provider or model, and audio is never sent.

Until both gates are met the Host sends nothing, and the panel says that live
notes have not started and names the missing step (`needs_disclosure` or
`needs_connection`); `provider_off` now means the attendee turned them off. The
attendee's own notes are saved as before. `yulu doctor --json` reports
`privacy_opt_in.live_notes.provider` as `xai` when the key is missing: it reads
the switch, not the receipt.

**Why.** Live notes are what the panel exists to show. Off by default, the panel
opened on an "off" notice until the attendee found the setting. One explicit
decision, made with the disclosure in front of the attendee, is enough before
meeting text leaves the Mac.

**Privacy.** An upgrade still sends no meeting text by itself: sending needs an
accepted `xai-live-notes-v1` receipt, which only the attendee creates, and a
connected xAI credential. With the `local` engine and either live notes turned
off or the disclosure not accepted, nothing from the meeting leaves the Mac
while it is recorded.
