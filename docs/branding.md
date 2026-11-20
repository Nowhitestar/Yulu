# Yulu — Brand & Visual Identity

This file is the contract for anything that puts the Yulu name on it: README header, GitHub social card, release artwork, slides, talks. Keep it short and follow it strictly.

## Name

- **English wordmark**: `Yulu` (capital Y, lowercase rest). Never `YULU`, `yulu`, `Yu Lu`, or `yu-lu`.
- **Chinese wordmark**: `语录`. Always traditional or simplified depending on the surrounding text — do not mix.
- **Current README descriptor (English)**: *Native meeting capture. Live notes. Agent-ready memory.*
- **Current README descriptor (中文)**: 「原生录制，实时笔记，让每场会议成为 Agent 可用的记忆。」
- **Pronunciation**: *yǔ lù* (Mandarin) — closest English approximation: "yoo-loo".
- **Etymology in copy** (use once per surface, not on every page):
  > Yulu (语录, *yǔ lù*) is the Chinese word for "recorded sayings" — the genre that produced *The Analects of Confucius*.

## Logo

The mark is one stroke. Three swells, each lower than the last, are speech; the
stroke settles into a straight line, which is the written record; a short blue
segment after a gap is the line being written now. It reads as "what was said,
written down" without becoming a chat bubble or a waveform icon.

The complete kit — every file, size, the colors and the motion rules — is in
[`assets/brand/`](../assets/brand/README.md). Start with
`assets/brand/preview.png`.

| Element | Value |
|---|---|
| Stroke | Ink, round caps and joins, one width (10 on the 144 × 64 master) |
| Cursor | Blue, the same width, after a gap of 0.6 stroke widths |
| Light ink / blue | `#0D1114` / `#0F74C5` |
| Dark ink / blue | `#ECEFF2` / `#3A93E6` |

- Keep clear space of at least 1.5 stroke widths around the mark.
- The full mark is never narrower than 64 px. Below that, use the 32 px and
  16 px masters, the app icon, or the menu bar icon; never shrink the large art.
- Ink and one short blue segment only. Blue in Yulu means "clickable" or "in
  progress", nothing else.
- On photos or busy backgrounds use the single-color black or white mark.

### Where it is used

| Surface | Source |
|---|---|
| App icon (Yulu.app, prompts) | `assets/Yulu.icns`, `assets/Yulu.iconset` |
| Menu bar: idle, recording, processing | Drawn in `yulu/scripts/status_agent.swift` from the kit's menu bar geometry |
| Live notes panel, tucked away | Drawn in `yulu/scripts/recorder_status.swift`: the app icon with the recording motion |
| Web UI tab | `yulu/scripts/yulu_ui/web/public/favicon.svg` (follows light / dark) |
| README header | `assets/logo.svg`, `assets/logo-dark.svg` |
| GitHub social preview | `assets/social-card.png` (upload in the repository settings) |

`assets/brand/tools/build.sh` regenerates the kit and copies every file in this
table. The menu bar and panel icons are code, so a change to the mark's geometry
must be repeated in those two Swift files.

### Motion

- Menu bar idle is still. Recording swaps the cursor for a steady red dot and
  the swells follow the sound level. Processing swaps it for three dots lit in
  turn every 0.4 s.
- The tucked-away live notes panel keeps writing: the swells follow the sound
  level and the cursor writes (1.2 s), holds (1.4 s), erases (0.6 s) and rests
  (0.4 s).
- Swell height is the standard shape times the smoothed level, 0.25–1.2, and
  changes no more than 12% per frame. With Reduce Motion everything is still.

## Typography

| Use | Family | License |
|---|---|---|
| Product headings | Fraunces, then a CJK serif fallback | SIL OFL |
| Product body | Inter, then the macOS system sans-serif | SIL OFL |
| Chinese display text | Songti SC / Noto Serif CJK SC where a serif is intended | System / SIL OFL |
| Mono (code, terminal, timers) | Geist Mono, then SF Mono | SIL OFL / system |

In code blocks and config samples, always use mono. Product controls and dense
status surfaces use the sans-serif body stack; editorial headings use the serif
stack.

## Voice

Yulu's voice is **quiet, technical, never cute**.

- ✅ "Yulu listens to your meetings, transcribes them locally, and hands the transcript to any agent."
- ❌ "Hey there! 👋 Yulu is your AI bestie for meetings!"

Three rules:

1. **No anthropomorphizing the AI.** Yulu does not "understand", "love", or "care". It records, transcribes, and queues.
2. **Privacy claims must be exact.** Do not say "fully offline" if Google Calendar is enabled. Use "local by default; cloud features are opt-in".
3. **Avoid emoji except in the README header table** where they act as functional bullets.

## Don'ts

- Do not bring back the blue liquid-glass lens or the parchment `语` character;
  both are retired marks.
- Do not add gradients, glow or shadows to the mark, or make the whole stroke blue.
- Do not sharpen the swells into spikes (it becomes a heart monitor), thin the
  stroke, stretch, rotate or split the mark, or put it in a speech bubble.
- Do not use stock "AI sparkle" icons.
- Do not translate the tagline word-for-word into a third language without a native speaker editing it.
