# Yulu — Brand & Visual Identity

This file is the contract for anything that puts the Yulu name on it: README header, GitHub social card, release artwork, slides, talks. Keep it short and follow it strictly.

## Name

- **English wordmark**: `Yulu` (capital Y, lowercase rest). Never `YULU`, `yulu`, `Yu Lu`, or `yu-lu`.
- **Chinese wordmark**: `语录`. Always traditional or simplified depending on the surrounding text — do not mix.
- **Current README descriptor (English)**: *Native meeting capture. Live captions. Agent-ready memory.*
- **Current README descriptor (中文)**: 「原生录制，实时字幕，让每场会议成为 Agent 可用的记忆。」
- **Pronunciation**: *yǔ lù* (Mandarin) — closest English approximation: "yoo-loo".
- **Etymology in copy** (use once per surface, not on every page):
  > Yulu (语录, *yǔ lù*) is the Chinese word for "recorded sayings" — the genre that produced *The Analects of Confucius*.

## Logo

The current mark is a blue liquid-glass lens containing two white quotation
marks. It represents captured speech without turning Yulu into a chat-bubble
brand.

| Element | Value |
|---|---|
| Lens gradient | `#60AAF3` to `#2C5DBD` |
| Quotation marks | White, `95%` to `72%` opacity |
| Surface highlight | White radial glow, up to `55%` opacity |
| Edge highlight | White, `50%` opacity |

- Preserve the organic lens silhouette and the two quotation marks as one mark.
- Keep clear space equal to at least 12% of the mark's width.
- Minimum size: 24×24 px on screen, 8 mm in print.
- A restrained blue glow is allowed in the digital UI. Do not add another hue.
- The old parchment `语` character with a cinnabar dot is a legacy mark. Do not
  use it in new UI, README art, release artwork, or previews.

### Logo files

- `yulu/scripts/yulu_ui/web/src/components/Logo.tsx` — UI source of truth.
- `yulu/scripts/yulu_ui/web/public/favicon.svg` — static app equivalent.
- `assets/logo.svg` — README and documentation equivalent.

Keep these three representations visually aligned. Generate any raster export
from the static SVG rather than recreating the legacy character mark.

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

- Do not replace the current mark with the legacy parchment `语` asset.
- Do not turn the lens into a generic circular chat bubble.
- Do not distort, recolor, rotate, or separate the quotation marks from the lens.
- Do not use stock "AI sparkle" icons.
- Do not translate the tagline word-for-word into a third language without a native speaker editing it.
