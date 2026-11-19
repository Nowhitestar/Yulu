<div align="center">
  <img src="assets/logo.svg" width="88" alt="Yulu logo" />
  <h1>Yulu</h1>
  <p><b>Native meeting capture. Live captions. Agent-ready memory.</b></p>
  <p><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>
  <p><a href="https://github.com/Nowhitestar/Yulu/releases/latest">Download for macOS</a> · <a href="CHANGELOG.md">Changelog</a> · <a href="LICENSE">MIT License</a></p>
</div>

Yulu is a macOS workspace for meeting notes and voice input. Record system audio
and your microphone, find decisions in past meetings, or dictate into the app
you are using. No Yulu account or virtual audio device required.

![Yulu with the recordings list on the left and a meeting summary on the right](assets/demos/readme-main-en.png)

## Design choices

- **Useful files you can keep.** Audio, plain-text transcripts, and Markdown
  summaries live on your Mac, ready to back up, move, and use in other tools.
- **Build on your existing AI workflow.** Choose transcription and summary
  providers independently, including xAI, Codex, or Claude Code for summaries.
  Through [MCP](docs/operations.md#dmg-and-cli-entry-points), your own Agent can
  control recording, search meeting history, and answer questions about it.
- **Capture directly on your Mac.** System audio and microphone capture need
  no meeting bot or virtual audio device. Movable captions, bilingual
  translation, calendar reminders, and meeting detection support the workflow.
- **Voice input beyond meetings.** Dictate into your current app or translate
  with a global shortcut. Optional xAI cleanup has three editing levels and
  separate punctuation styles; the original text stays available.

The meeting library adds playback, search, tags, speaker corrections, templates,
and a glossary.

[What's new in v0.28.0](docs/release-notes/v0.28.0.md):
a simpler window with one recordings list, one reading sheet, and ⌘K for
everything else. Questions about meetings now go to your own Agent over MCP.

## The window

v0.28.0 redesigned the app around two principles.

**Simple, not simplistic: nothing taken away, only the daily things up front.**
You do three things with Yulu every day: record, read, and find. So the window
shows a Record button, the recordings list, and search. Everything else is one
step away, not gone:

- Re-transcribing, re-generating a summary with another template, renaming, and
  deleting live in the reading sheet's **⋯** menu.
- Templates, the glossary, and runtime diagnostics live in Settings.
- Asking about a meeting happens in the Agent you already use, through MCP.
- Each surface has one main action: the list opens, the reading sheet shares,
  and a settings row pairs one label with one control.
- Status shows up only when it needs you. A finished recording carries no
  badge, a spinner means it is still processing, and a warning mark means it
  failed (hover for the reason).

**Beautiful: proportion, whitespace, and type instead of decoration.** The
references were the Claude desktop app, Apple's own apps, and Bear.

- Two full-height panes with one hairline between them.
- The text is the subject: a 720px reading column, serif headings (Fraunces,
  with Songti for Chinese), and nothing loud in the toolbar.
- One rhythm everywhere: the same row height, hairline, and small radius, so
  settings, runtime status, templates, and the glossary read as one product.
- Color carries meaning only. Blue is clickable; green, amber, and red are
  status; everything else is gray.
- Glass only where something floats. The list pane is softly translucent, and
  menus, the share panel, and ⌘K frost what is under them. Shadows are
  reserved for those floating layers.

**Small details**

- **One search for everything.** ⌘K, or the search field above the list,
  searches recordings, summaries, and transcripts and jumps to any settings
  page. Empty, it lists every page.
- **Settings in place.** Opening Settings turns the left pane into the
  settings list; **Back to recordings** returns to the meeting you were reading.
- **A pane that steps aside.** Hide the list with the toolbar button or ⌃⌘S,
  the macOS sidebar shortcut. Yulu remembers the choice.
- **Times that read like speech.** Today's meetings show a time, then
  *Yesterday*, then a weekday, then a date.
- **Summary first.** A recording opens on its summary, the transcript is the
  second tab, and **Copy Markdown** sits beside them.
- **A toolbar that is also a title bar.** Its empty space drags the window,
  and a double-click zooms it.
- **Every theme kept.** Light, dark, follow-system, Ayu, Paper, and custom
  colors all draw from the same semantic tokens.

| | |
|---|---|
| ![The ⌘K palette searching summaries and transcripts](assets/demos/readme-search-en.png) | ![The reading sheet with the recordings list hidden](assets/demos/readme-focus-en.png) |
| **⌘K** searches recordings, summaries, and transcripts | **⌃⌘S** hides the list for reading |
| ![The same window in the dark theme](assets/demos/readme-dark-en.png) | ![Settings → Connections with Connect an Agent and AI services](assets/demos/readme-agents-en.png) |
| Dark theme | **Settings → Connections**: Agents and AI services |

*Screenshots use fictional demo data; no real meetings, accounts, or credentials.*

## Get started

Requires **macOS 13+ and Apple Silicon** for official releases.

1. Download the `.dmg` from [GitHub Releases](https://github.com/Nowhitestar/Yulu/releases/latest),
   drag **Yulu.app** into **Applications**, and open it.
   Starting with v0.27.2, releases are signed but not Apple-notarized. If macOS
   blocks the first launch, use **System Settings → Privacy & Security → Open Anyway**
   after checking that you downloaded Yulu from the official release page.
2. Follow setup to grant microphone and system-audio access. Allow input control
   for global shortcuts and automatic text insertion.
3. Install the local speech model, or explicitly connect xAI for cloud
   transcription. Choose a summary provider if you want AI meeting notes.
4. Start a recording from the App or menu bar. Use **Fn** for dictation and
   **Fn+Shift** for translation. [Using Yulu](#using-yulu) covers the rest.

Settings let you customize shortcuts and hide the Dock and menu bar icons
independently. The App includes its runtime and supports in-app updates;
the DMG does not install a global `yulu` shell command.

## Using Yulu

**Record.** Click **Record** in the top-right corner or use the menu bar.
Calendar reminders and meeting detection can prompt you, but recording starts
only when you choose; for a calendar meeting with a link, the button offers
**Record and join**. While recording, the button shows the elapsed time, a level
meter, and a stop control. When you stop, the selected audio engine writes the
transcript, then the selected summary provider writes the summary; the list
shows a spinner until both are saved.

**Read.** Select a recording. It opens on the summary; the **Transcript** tab
has the full text and speaker names you can correct. Play the audio from the
waveform, add tags under the title, and use **Copy Markdown** to take the
summary elsewhere. **⋯** holds the summary template, re-generate, re-transcribe,
rename, and delete; right-click a row in the list to rename or delete it.

**Find.** Press ⌘K and type. Results show the matching sentence from the
summary or transcript; Return opens it. Empty, the palette lists every page.

**Share.** **Share** sends the summary to a destination set up under
**Settings → Connections → Sharing destinations**. Each share asks for a fresh
confirmation; finishing a recording never sends anything.

**Ask your Agent.** In **Settings → Connections → Connect an Agent**, connect
Claude Code, Codex, or another detected Agent with one click, then **Test** it.
Ask that Agent about your meetings; it reaches Yulu through MCP and keeps its
own history.

**Voice input.** In any app, press **Fn** to dictate and **Fn+Shift** to
translate. Shortcuts, the translation language, and optional xAI cleanup are in
**Settings → Voice Input**, and recent dictation (with the original text) is
listed at the bottom of that page.

![Settings → Voice Input with shortcuts and dictation cleanup levels](assets/demos/readme-voice-en.png)

| Shortcut | Action |
|---|---|
| ⌘K | Search and go anywhere |
| ⌃⌘S | Show or hide the recordings list |
| j / k | Next or previous recording |
| Fn | Dictate into the current app |
| Fn+Shift | Translate into the current app |
| Esc | Close the palette or a menu |

## Privacy

- Recordings, transcripts, summaries, and history are stored locally. Recordings
  default to `~/Movies/Yulu`; local speech recognition stays on-device.
- Cloud features are opt-in: xAI transcription sends audio to xAI; AI summaries
  send transcripts, and dictation cleanup and translation send dictated text, to
  the selected provider.
  Providers are selected explicitly, with no silent fallback.
- Sharing a summary requires a separate manual confirmation. Yulu stores its xAI
  credentials in macOS Keychain; Agent connector credentials stay with the Agent.

## More

[Configuration](docs/configuration.md) · [Troubleshooting & CLI](docs/operations.md) ·
[Agent skill](skills/yulu/SKILL.md) · [Development](docs/DEVELOPMENT.md) ·
[Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md)
