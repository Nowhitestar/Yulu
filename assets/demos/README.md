# Demo assets

Replace these placeholders before publishing.

The README references four images in this folder:

| File | What to capture | Suggested size |
|---|---|---|
| `demo-status-window.png` | The floating recording status window with the manual stop button visible | 1280×800, retina |
| `demo-summary.png` | A real `summary.md` rendered in your editor of choice (VS Code, Obsidian, Bear). Redact private content first | 1280×900 |
| `demo-prompt.png` | The "Start recording?" macOS prompt as shown by `notify.py` | 600×220 |
| `demo-transcript.png` | A terminal showing `whisper-cli` mid-transcription, with a few lines of output | 1100×600 |

Tips:

- Use a clean macOS screenshot (Cmd+Shift+4 then Space to capture a window with shadow). Crop to the window only — do not include desktop wallpaper.
- For dark/light symmetry, decide on one mode and stick with it across all four images.
- Compress with [`pngquant`](https://pngquant.org/) before committing: `pngquant --quality=70-85 --skip-if-larger demo-*.png`.
- A short looping `demo.gif` (10–20 s) at the top of the README can replace any of these — see [Charm GIFs](https://github.com/charmbracelet/vhs) for a reproducible recording flow.
