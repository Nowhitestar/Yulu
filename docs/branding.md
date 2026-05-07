# Yulu — Brand & Visual Identity

This file is the contract for anything that puts the Yulu name on it: README header, GitHub social card, release artwork, slides, talks. Keep it short and follow it strictly.

## Name

- **English wordmark**: `Yulu` (capital Y, lowercase rest). Never `YULU`, `yulu`, `Yu Lu`, or `yu-lu`.
- **Chinese wordmark**: `语录`. Always traditional or simplified depending on the surrounding text — do not mix.
- **Tagline (English)**: *Listen quietly. Capture everything.*
- **Tagline (中文)**: 「让每场会议，都成为一本语录。」
- **Pronunciation**: *yǔ lù* (Mandarin) — closest English approximation: "yoo-loo".
- **Etymology in copy** (use once per surface, not on every page):
  > Yulu (语录, *yǔ lù*) is the Chinese word for "recorded sayings" — the genre that produced *The Analects of Confucius*.

## Logo

The mark is a serif `语` in ink on warm parchment, with a small cinnabar dot.

| Element | Token | Hex |
|---|---|---|
| Parchment background | `paper` | `#F5F1E8` |
| Ink | `ink` | `#1B1B1B` |
| Cinnabar accent | `cinnabar` | `#A23B2B` |

- The cinnabar dot is the **only** chromatic accent. Do not add a second hue.
- The character must be set in a CJK serif (宋体 / Mincho), not sans-serif.
- Minimum clear space around the rounded square: 12% of its side length.
- Minimum size: 24×24 px on screen, 8 mm in print.

If a one-color version is needed (favicon, monochrome print), drop the cinnabar dot. Do not invert the parchment to white.

### Logo files

- `assets/logo.svg` — primary, color, 120×120, system-font `语`.
- `assets/logo.png` — to be generated (suggest 512×512 export of the SVG with the character converted to a path so it renders the same on all platforms). Run once before each release: see `docs/branding.md` § "Generating raster logos".

### Generating raster logos

The SVG uses a font-family fallback chain. To make sure the rendered `语` looks the same everywhere, convert it to a path before exporting raster images. Two acceptable workflows:

1. Open `assets/logo.svg` in [Figma](https://figma.com) or Affinity Designer → select the text → Convert to Outlines/Paths → re-export as `assets/logo.svg` and `assets/logo.png`.
2. Use the [Inkscape](https://inkscape.org) CLI:
   ```bash
   inkscape assets/logo.svg --export-text-to-path \
     --export-filename=assets/logo-flat.svg
   inkscape assets/logo-flat.svg --export-type=png \
     --export-width=512 --export-filename=assets/logo.png
   ```

## Typography

Pick one serif and one mono. Do not introduce a sans-serif unless explicitly needed for OS chrome.

| Use | Family | License |
|---|---|---|
| English body / headings | Charter (system on macOS, Webfont mirror via [practicaltypography.com](https://practicaltypography.com/charter.html)) | Bitstream — free, redistributable |
| Chinese body / headings | Source Han Serif SC / 思源宋体 | SIL OFL |
| Mono (code, terminal) | JetBrains Mono | Apache 2.0 |

In code blocks and config samples, always use mono. In flowing prose, never mix CJK sans with English serif.

## Voice

Yulu's voice is **quiet, technical, never cute**.

- ✅ "Yulu listens to your meetings, transcribes them locally, and hands the transcript to any agent."
- ❌ "Hey there! 👋 Yulu is your AI bestie for meetings!"

Three rules:

1. **No anthropomorphizing the AI.** Yulu does not "understand", "love", or "care". It records, transcribes, and queues.
2. **Privacy claims must be exact.** Do not say "fully offline" if Google Calendar is enabled. Use "local by default; cloud features are opt-in".
3. **Avoid emoji except in the README header table** where they act as functional bullets.

## Don'ts

- Do not put Yulu in a circle or a chat bubble. It is a page, not a conversation app.
- Do not animate the logo. Do not add gradients, drop shadows, or 3-D effects.
- Do not use stock "AI sparkle" icons.
- Do not translate the tagline word-for-word into a third language without a native speaker editing it.
