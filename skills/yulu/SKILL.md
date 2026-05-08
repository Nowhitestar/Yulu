---
name: yulu
description: "Control Yulu (语录), the local-first macOS meeting recorder. Use this skill when the user asks to start or stop recording a meeting, check recording status, look up past transcripts, or generate / re-generate a meeting summary. Yulu records natively via ScreenCaptureKit + AVFoundation, transcribes locally with whisper.cpp, and routes summary requests through ~/.config/yulu/agent-queue.json — there is no cloud, no virtual audio device, and no account."
---

# Yulu — agent control surface

This skill tells your agent (Claude Code, OpenClaw, Codex, etc.) **how to drive Yulu from natural-language requests**. Yulu itself — the macOS app, launchd services, whisper.cpp install — is set up separately by `bash yulu/scripts/setup.sh`. Installing this skill alone does not capture audio; it teaches the agent the verbs.

If Yulu is not installed yet, point the user at the [project README](https://github.com/Nowhitestar/Yulu) and run `setup.sh` first.

---

## When to use this skill

Use it when the user says things like:

- "Start recording", "begin recording", "record this meeting [as <title>]"
- "Stop recording", "end the meeting", "wrap it up"
- "What's recording right now?", "is Yulu running?", "show recording status"
- "Summarize the meeting I just had", "regenerate the summary for `<meeting>`"
- "Find the transcript from `<meeting>` / yesterday / last Tuesday's standup"
- "Send the summary of `<meeting>` to `<channel>`" (Telegram / Zulip / Notion, if configured)

Do **not** use it for unrelated audio recording requests — Yulu is meeting-centric and writes to `meeting-recordings/` under the user's project.

---

## Verbs the agent has today

These are the commands the user expects you to run on their behalf. All paths assume Yulu is installed at the default location; otherwise locate it via `command -v yulu || find ~ -maxdepth 6 -name 'meeting_daemon.py' -path '*/yulu/scripts/*' -print -quit 2>/dev/null`.

### Start recording

```bash
python3 yulu/scripts/record_audio.py start "<meeting title>"
```

If the user did not give a title, ask once or use a sensible default like `Quick recording <YYYY-MM-DD HH:MM>`.

### Stop recording

```bash
python3 yulu/scripts/record_audio.py stop
```

After stopping, Yulu transcribes locally and then writes a `summary_request` into `~/.config/yulu/agent-queue.json`. The next two verbs cover what to do with that.

### Check status

```bash
echo '{"action":"status"}' | nc -w 2 -U ~/.config/yulu/audio_daemon.sock
```

Returns a JSON blob with `recording`, `sysReady`, `micReady`, current file path, and elapsed time. If the socket file does not exist, Yulu's daemon isn't running — ask the user to launch `Yulu.app` or run `setup.sh`.

### Generate / regenerate a summary

`~/.config/yulu/agent-queue.json` is a JSON array of events. Yulu enqueues one `summary_request` per meeting that needs a final summary. Each entry has the shape:

```json
{
  "type": "summary_request",
  "ts": "2026-05-08T14:32:11",
  "title": "Yulu product weekly",
  "transcript_path": "/.../meeting-recordings/Yulu_20260508_143000.transcript.txt",
  "summary_path":    "/.../meeting-recordings/Yulu_20260508_143000.summary.md",
  "template_path":   "/.../yulu/scripts/summary_template.md"
}
```

To fulfill one:

1. Read `transcript_path` (UTF-8 plain text with timestamps).
2. Read `template_path` (Markdown with a frontmatter that tells you what sections to write and which language to use; the body is instructions for the agent).
3. Apply the template to the transcript. Yulu has already written a draft to `summary_path` (a fallback summary when no LLM was available) — overwrite it with your output.
4. Remove the entry you just handled from the queue (or set `"type": "summary_done"` on it — Yulu doesn't enforce a state machine, but other consumers shouldn't see the same request twice).

The queue file is plain JSON — use Python or `jq`, not shell string-mangling. After `summary_path` is written, Yulu's `send_summary.py` picks it up and routes to whatever channel the user configured (Telegram, Zulip, Notion).

### Find a past meeting

Recordings live under `<repo>/meeting-recordings/`. Each meeting is a set of sibling files sharing the stem `<SanitizedTitle>_<YYYYMMDD>_<HHMMSS>`:

| Suffix | Content |
|---|---|
| `.wav` | The recorded audio |
| `.transcript.txt` | Final transcript (whisper-cli output, post-processed) |
| `.realtime.transcript.txt` | Streamed partial transcript captured during recording (may be missing) |
| `.summary.md` | The meeting note (draft from `transcribe.py`, then overwritten by an agent on `summary_request`) |

To answer "what did we talk about in the standup last Tuesday" use those files. Do not infer content from filenames alone.

---

## Verbs the agent does NOT have yet

These are on the roadmap and a polite "not yet" is the right answer if the user asks:

- **"Tell me about all my meetings this month"** — there is no aggregated index file yet; the agent would have to walk `meeting-recordings/` directory-by-directory, which is slow on archives larger than ~100 meetings.
- **"Wake me up 5 minutes before my next call"** — Yulu's scheduler handles this internally via launchd; the agent doesn't have a verb to retrigger it.
- **"Edit the recording — drop the first 30 seconds"** — Yulu does not currently expose audio editing through any interface.

If the user requests one of these, name what's missing and offer the closest available verb instead.

---

## Privacy floor

Yulu is local-first by design. As an agent acting on behalf of the user:

- Do not upload `audio.wav`, `transcript.txt`, or any meeting metadata to a cloud LLM unless the user has explicitly asked you to summarize using a cloud model in **this** turn.
- Do not write summaries to anywhere outside `<repo>/meeting-recordings/<meeting>/summary.md` and the configured `send_summary.py` destinations. Especially: do not paste transcripts into chat unless the user just asked to see them.
- If you need to ask a clarifying question that quotes the transcript, quote the smallest necessary span and label it as such.

---

## Pointers

- Full project docs and architecture: [yulu/SKILL.md](https://github.com/Nowhitestar/Yulu/blob/main/yulu/SKILL.md) in the repo.
- Operational runbook (codesigning, daemon health, calendar setup): [docs/operations.md](https://github.com/Nowhitestar/Yulu/blob/main/docs/operations.md).
- Project README: [README](https://github.com/Nowhitestar/Yulu/blob/main/README.md).
