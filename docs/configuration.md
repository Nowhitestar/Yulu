# Configuration Reference

Yulu's configuration lives at `~/.config/yulu/config.json`. The file is created by `setup.sh` and is not part of the repository.

## Full schema

```json
{
  "audio": {
    "backend": "daemon",
    "output_dir": "/path/to/Yulu/meeting-recordings",
    "silence_threshold": 0.01,
    "silence_duration_sec": 300,
    "half_duplex": true,
    "mic_device": null,
    "system_audio_device": null
  },
  "transcription": {
    "mode": "local",
    "post_recording_mode": "fast_summary",
    "final_engine": "mlx",
    "mlx": {
      "python": "~/.config/yulu/venv-mlx-whisper/bin/python",
      "model": "mlx-community/whisper-large-v3-mlx"
    },
    "realtime": {
      "engine": "mlx",
      "mlx_model": "mlx-community/whisper-large-v3-mlx",
      "chunk_sec": 60
    },
    "whisper_cli": "whisper-cli",
    "local_model_path": "~/.config/yulu/models/ggml-large-v3.bin",
    "language": "zh",
    "command": null
  },
  "llm": {
    "enabled": true,
    "command": null
  },
  "output": {
    "channel": "file"
  },
  "meeting_detection": {
    "enabled": true,
    "interval_sec": 10,
    "stable_sec": 15,
    "prompt_cooldown_sec": 1800
  },
  "calendars": []
}
```

## Sections

### `audio`

| Field | Default | Notes |
|---|---|---|
| `backend` | `"daemon"` | `"daemon"` (recommended, ScreenCaptureKit) or `"sox"` (legacy fallback) |
| `output_dir` | repo path | Where WAVs are written. Git-ignored if it stays inside the repo |
| `silence_threshold` | `0.01` | RMS threshold below which system audio is considered silent |
| `silence_duration_sec` | `300` | Auto-stop recording after this many seconds of pure silence |
| `half_duplex` | `true` | Crossfade to microphone during system silence |
| `mic_device`, `system_audio_device` | `null` | Only used by the SoX fallback. Ignore for the daemon backend |

### `transcription`

| Field | Default | Notes |
|---|---|---|
| `mode` | `"local"` | Reserved for future cloud adapters |
| `post_recording_mode` | `"fast_summary"` | `"fast_summary"` uses the realtime transcript generated during the meeting, then polish + summary. `"full_transcribe"` reruns the final engine on the full WAV before summarizing |
| `final_engine` | `"mlx"` on Apple Silicon, `"whisper"` as non-MLX fallback | `"mlx"` uses `mlx-whisper`; `"whisper"` uses whisper.cpp |
| `mlx.python` | `~/.config/yulu/venv-mlx-whisper/bin/python` | Python executable with `mlx-whisper` installed |
| `mlx.model` | `mlx-community/whisper-large-v3-mlx` | Best-quality MLX model. Use `mlx-community/whisper-large-v3-turbo` when speed matters more |
| `realtime.engine` | same as `final_engine` | Engine for chunked realtime transcription. This transcript is used by `fast_summary` |
| `realtime.chunk_sec` | `60` | Chunk size for realtime-ish transcription |
| `whisper_cli` | `"whisper-cli"` | Path or name of the whisper.cpp binary |
| `local_model_path` | `~/.config/yulu/models/ggml-large-v3.bin` | whisper.cpp model file. `large-v3` is best quality; `large-v3-q5_0` is smaller/faster |
| `language` | `"zh"` | Whisper language code; use `"auto"` for detection |
| `command` | `null` | Optional override. A list of argv tokens with `{{input}}` and `{{output_stem}}` placeholders |

Switch at runtime:

```bash
yulu transcription mode fast
yulu transcription mode full
yulu transcription engine mlx mlx-community/whisper-large-v3-mlx
yulu transcription engine mlx mlx-community/whisper-large-v3-turbo
yulu transcription engine whisper ~/.config/yulu/models/ggml-large-v3.bin
```

### `llm`

| Field | Default | Notes |
|---|---|---|
| `enabled` | `true` | If `false`, the local fallback summary is final and no `summary_request` is queued |
| `command` | `null` | Optional CLI to call directly. Receives the prompt on stdin, writes Markdown to stdout. Example: `["claude", "--print", "--model", "claude-opus-4-7"]`. If `null`, summarization is queued for an external agent |

### `output`

| Field | Default | Notes |
|---|---|---|
| `channel` | `"file"` | One of `"file"`, `"telegram"`, `"zulip"`, `"notion"`. Non-file outputs are experimental and must be configured manually; setup does not install their optional dependencies. `telegram` requires `TELEGRAM_BOT_TOKEN`; `zulip` requires the `zulip` Python package and `~/.zuliprc`; `notion` requires `notion-client` and `NOTION_API_KEY` |

### `meeting_detection`

| Field | Default | Notes |
|---|---|---|
| `enabled` | `true` | Window-based detection daemon |
| `interval_sec` | `10` | Polling interval |
| `stable_sec` | `15` | Window must be present for this long before prompting |
| `prompt_cooldown_sec` | `1800` | Re-prompt cooldown per meeting signature |

### `calendars`

Array of calendar adapters. Currently only Google is supported.

```json
{
  "type": "google",
  "enabled": true,
  "gog_account": "your.email@example.com",
  "watch_calendars": ["primary"]
}
```

## Tips

- Keep `config.json` out of git. The default `.gitignore` already blocks it.
- If you change `local_model_path`, run a manual `transcribe.py` against an existing WAV to verify the new model works before relying on it during a meeting.
- `llm.command` is a generic hatch — anything that reads stdin and writes Markdown works (`claude`, `codex`, `gpt`, `ollama run …`, your own shim). Leave it empty if you want a coding agent to pick up `agent-queue.json`.
