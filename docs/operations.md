# Operations Guide

Manual commands, day-to-day operation, and troubleshooting for Yulu.

## Manual commands

```bash
# Yulu health check (queries the daemon over its Unix socket)
echo '{"action":"status"}' | nc -w 2 -U ~/.config/yulu/audio_daemon.sock

# Broader health check
yulu doctor

# Version and support metadata
yulu version
yulu version --json

# Start / stop a manual recording
python3 yulu/scripts/record_audio.py start "Test Meeting"
python3 yulu/scripts/record_audio.py stop

# Run the full prompt → record → transcribe flow
python3 yulu/scripts/meeting_daemon.py ask_record "Test Meeting" "manual-test"

# Transcribe an existing WAV
python3 yulu/scripts/transcribe.py /path/to/meeting-recordings/xxx.wav

# Show / switch transcription behavior
yulu transcription status
yulu transcription mode fast   # realtime transcript -> polish -> summary
yulu transcription mode full   # full final transcription -> polish -> summary
yulu transcription engine mlx mlx-community/whisper-large-v3-mlx
yulu transcription engine whisper ~/.config/yulu/models/ggml-large-v3.bin

# Calendar queries
python3 yulu/scripts/check_meetings.py today
python3 yulu/scripts/check_meetings.py upcoming
python3 yulu/scripts/check_meetings.py week --json

# Window detection
python3 yulu/scripts/meeting_detector.py once
python3 yulu/scripts/meeting_detector.py daemon
```

## Where things live

| Path | Purpose |
|---|---|
| `~/.config/yulu/config.json` | User configuration |
| `~/.config/yulu/audio_daemon.sock` | Unix socket exposed by `Yulu.app` |
| `~/.config/yulu/agent-queue.json` | Pending events waiting for an agent |
| `~/.config/yulu/schedule.json` | Scheduler state |
| `<repo>/meeting-recordings/*.wav` | Local recordings (git-ignored) |
| `~/Library/LaunchAgents/com.yulu.*.plist` | Background services |
| `~/Library/Logs/yulu/` | Per-daemon logs |

## Codesigning Yulu.app

```bash
yulu/scripts/build_audio_daemon.sh
```

The script compiles `audio_daemon.swift`, refreshes `Yulu.app`, writes TCC usage descriptions, and codesigns with an Apple Development / Developer ID identity if available; otherwise it falls back to ad-hoc signing.

To pin an identity:

```bash
YULU_CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  yulu/scripts/build_audio_daemon.sh
```

After signing, restart the daemon for macOS to re-evaluate TCC:

```bash
pkill -f audio_daemon
open yulu/scripts/Yulu.app
```

## Google Calendar setup

Yulu does not store OAuth secrets. Calendar access is delegated to [`gog`](https://github.com/eliasdaler/gog) which keeps refresh tokens in the macOS Keychain.

1. Google Cloud Console → APIs & Services → Credentials.
2. Enable the Google Calendar API.
3. Create an **OAuth Client ID**, application type *Desktop app*.
4. Download `client_secret_*.json` to a local path you control.
5. Authorize:
   ```bash
   gog auth credentials ~/Downloads/client_secret_xxx.json
   gog auth add your.email@example.com --services calendar
   gog auth list
   ```
6. After authorization succeeds, delete the downloaded `client_secret_*.json`. `gog` has copied the credentials it needs into its own config + Keychain entry.
7. Enable in `config.json`:
   ```json
   {
     "calendars": [
       {
         "type": "google",
         "enabled": true,
         "gog_account": "your.email@example.com",
         "watch_calendars": ["primary"]
       }
     ]
   }
   ```

If a `client_secret_*.json` or refresh token has ever been pasted into chat or committed to a public repo: **delete that OAuth client in Google Cloud, revoke the token, and start over with a fresh client.** Removing the file from git history is not enough.

## Troubleshooting

### `Yulu` reports `sysReady=false`

```bash
echo '{"action":"status"}' | nc -w 2 -U ~/.config/yulu/audio_daemon.sock
```

1. Open System Settings → Privacy & Security → **Screen & System Audio Recording**.
2. Enable `Yulu.app`.
3. Restart the daemon:
   ```bash
   pkill -f audio_daemon
   open yulu/scripts/Yulu.app
   ```

### WAV file is created but silent

This is almost always a TCC permission issue or the daemon was not ready. Recent versions refuse to start a recording when `sysReady` or `micReady` is false, specifically to avoid producing fake silent WAVs. Re-check the status output and the System Settings entries.

### Summary file says "draft"

Check the agent queue:

```bash
cat ~/.config/yulu/agent-queue.json
```

If there is a pending `summary_request`, your agent (Claude Code, Codex, OpenClaw…) has not yet processed it. Once the agent runs, it will read the transcript + `summary_template.md`, overwrite the placeholder summary, and notify you.

### Calendar events stop arriving

`gog`'s refresh token may have been invalidated (password change, prolonged inactivity). Re-run:

```bash
gog auth list
gog auth add your.email@example.com --services calendar
```

If the issue persists, revoke the OAuth client in Google Cloud and recreate it.
