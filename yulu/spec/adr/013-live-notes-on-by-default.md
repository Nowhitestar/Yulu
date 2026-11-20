# ADR-013: Live notes on by default

**Status**: Accepted
**Date**: 2026-11-20
**Supersedes**: the `none` default in [ADR-012](012-live-notes.md) decision 2
and the config note under its Migration. Everything else in ADR-012 stands.

## Context

ADR-012 made the live notes switch (`transcription.live_notes.provider`)
default to `none`, so the switch and the `xai-live-notes-v1` disclosure were
two explicit steps. Live notes are what the panel exists to show: off by
default, every recording opened the panel on an "off" notice until the attendee
found the setting.

## Decision

1. **The switch is on by default.** A missing
   `transcription.live_notes.provider` means `xai`, for new installs and after
   an upgrade. An explicit `"none"` keeps live notes off. No migration rewrites
   an existing config.
2. **The disclosure is the consent.** The gates that decide whether anything is
   sent are unchanged: the attendee must accept `xai-live-notes-v1` once, and
   an xAI credential source must be connected. There is no fallback to another
   provider or model, and audio is never sent. Removing the xAI connection
   still clears the receipt, so the disclosure is shown again.
3. **The disclosure is shown where the attendee meets it.** While the switch is
   on and the disclosure is not accepted, Settings shows it right away with two
   choices: accept, which records the receipt and writes `provider: "xai"` so
   the choice is explicit, or turn off, which writes `"none"`. The panel says
   that live notes have not started and names the missing step
   (`needs_disclosure` or `needs_connection`); `provider_off` means the attendee
   turned them off.

## Ruled out

- **Sending before the disclosure is accepted.** Meeting text, including what
  other people say, never leaves the Mac on a default alone.
- **Rewriting configs that say `none`.** A fresh install of v0.30.0 wrote
  `none` with the full default config, which cannot be told apart from a choice;
  an explicit value is respected.

## Consequences

- An upgrade sends no meeting text by itself: sending needs an accepted
  `xai-live-notes-v1` receipt, which only the attendee creates, and a connected
  xAI credential. With the `local` engine and either live notes off or the
  disclosure not accepted, nothing from the meeting leaves the Mac while it is
  recorded.
- `yulu doctor --json` reports `privacy_opt_in.live_notes.provider` as `xai`
  when the key is missing: it reads the switch, not the receipt.
- The attendee's own notes are saved locally as before, whatever the switch.
