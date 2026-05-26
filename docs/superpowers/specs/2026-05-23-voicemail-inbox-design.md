# Spec: Voicemail Inbox

> **Status**: Draft — pending user review
> **Date**: 2026-05-23
> **Owner**: 不白 (yxliao.lewis@gmail.com)
> **Inspired by**: macparakeet `spec/15-voicemail-inbox.md` (mic-only ad-hoc capture surface)
> **Builds on**: ADR-001 (resident `stt_daemon`), ADR-004 (Prompt Library), Phase 3 (`SYS_DISABLED` audio_daemon knob + dual-track WAV)
> **Replaces**: nothing — pure addition of a new ad-hoc-capture product surface
> **Out of scope** (future specs): global hotkey / menu-bar status item (requires new Swift status agent — Phase 5); direct integration with Things / Reminders / Notion (use `send_summary` channels); push-to-talk / hold-to-record; cross-device sync (filesystem only, iCloud naturally)

---

## 1. Background and Motivation

Yulu today is meeting-shaped: every recording assumes a multi-party conversation with system audio (Zoom / Meet / Phone). The pipeline is built around `meeting_daemon`'s detector / scheduler triggers, `~/Movies/Yulu/<title>_<ts>.wav` naming, and prompts that emit "Discussion Points" / "Action Items" / "Decisions" — all of which presuppose ≥2 speakers and a structured agenda.

There's no clean path to capture a 30-second voice memo: "remind me to follow up with the Anthropic team about pricing", "the right shape for the API is probably ...", "todo: file a bug about the dual-track stride". Today the workarounds are external (Voice Memos.app, then manually transcribe / paste into notes), losing all of Yulu's STT + prompt-library infrastructure.

Phase 3 shipped the `SYS_DISABLED` knob in `audio_daemon.swift`, which produces a stereo WAV with R=0 when ScreenCaptureKit capture is intentionally bypassed. That's the storage primitive Voicemail Inbox needs. Phase 4 builds the product layer on top: a new `yulu memo` CLI, a separate storage directory, a new prompt category, and a small inbox-management module.

## 2. Goals

1. **Quick ad-hoc capture** — `yulu memo` starts a mic-only recording in <1 s, stops on Ctrl-C or after 3 s of silence.
2. **Clean storage separation** — voicemails live in `~/Movies/Yulu/voicemails/` and never mix with meeting recordings.
3. **Reuse the full pipeline** — recording uses Phase 3's `audio_daemon` with `sys_disabled=true`; transcription uses Phase 3's `stt_daemon` MONO path; prompt rendering uses Phase 2's `PromptsCache`; LLM dispatch uses Phase 2's `agent_queue_worker`. Phase 4 adds zero new daemons or sockets.
4. **First-class prompt category** — `voicemail` joins `summary` and `cleanup` as a peer category in `prompts.sqlite`; ships 2 frozen seed prompts (`voicemail-todos` auto-run, `voicemail-clean` opt-in).
5. **Inbox management** — `yulu memo list / show / delete / send` operate against the voicemail directory; filesystem-as-database (no new SQLite).
6. **Completion notification** — after the LLM dispatch finishes, the user gets a desktop notification with the first line of the summary; clicking opens the `.summary.md`.

## 3. Non-Goals

- **Hotkey, menu-bar, or push-to-talk** — these require a new Swift status agent. Deferred to Phase 5.
- **Tagging, search, archive policies, retention** — the inbox is just a directory. Future spec if it becomes painful.
- **Voicemail-specific summary file layout** — voicemails use the same `<wav>.summary.md` / `<wav>.<slug>.summary.md` naming as meetings (Phase 2). No special infix like `voicemails-summary.md`.
- **Direct integration with external task managers** — use `send_summary` (Zulip / Telegram / Notion / file). A "voicemail → Things" bridge can be a thin wrapper around `yulu memo send <id>` later.
- **Concurrent voicemails / meetings** — `audio_daemon` is single-recording-at-a-time; the `recording_lock` from Phase 3 naturally rejects the second start. Documented, not bypassed.

## 4. Topology

```
$ yulu memo
   │
   ▼
voicemail.cli.cmd_new(title=None)
   │
   ├─ acquire_recording_lock(timeout=0.5)
   ├─ socket_send({action:"start", title:"voicemail_<ts>",
   │              sys_disabled:true})            ──► audio_daemon
   │                                                  ├─ MicCapture only (no SCStream)
   │                                                  └─ Writes ~/Movies/Yulu/voicemails/
   │                                                      voicemail_YYYYMMDD_HHMMSS.wav
   │                                                      (stereo, L=mic, R=0, with
   │                                                       Yulu DualTrack v1 marker)
   ├─ wait for SIGINT or silence-stop (3s mic quiet)
   ├─ socket_send({action:"stop"})               ──► audio_daemon stops + flushes WAV
   └─ trigger transcribe_voicemail(path)
        │
        ▼
   stt_daemon dispatch_transcribe(channel_split=true)
        ├─ layout = DUAL_TRACK
        ├─ mic channel RMS > -50dBFS → run mlx-whisper
        ├─ sys channel RMS < -50dBFS → {skipped_silent:true}
        └─ returns {channels:{mic:{text,segments}, sys:{skipped_silent}}}
        │
        ▼
   voicemail.recorder._persist_voicemail_transcripts(wav, response)
        ├─ writes <wav>.transcript.txt  (= mic text, no speaker tags — single speaker)
        ├─ writes <wav>.raw.transcript.txt (mirror; reserved for cleanup overwrite)
        └─ no <wav>.mic.transcript.txt or <wav>.sys.transcript.txt (mono-equivalent)
        │
        ▼
   for each prompt in cache.auto_run("voicemail"):
        enqueue summary_request → ~/.config/yulu/agent-queue.json
        │
        ▼
   agent_queue_worker (existing, launchd-driven)
        ├─ renders prompt with {{transcript}}, {{meeting_title}}=voicemail title, {{date}}
        ├─ runs llm.command
        ├─ writes <wav>.summary.md (default slug) or <wav>.<slug>.summary.md
        ├─ inserts row in summaries table
        └─ NEW: if audio_path is under voicemails/ and prompt is auto-run default,
                fire terminal-notifier "voicemail summarized: <first line>"
                with click action = open <wav>.summary.md
```

## 5. Storage Layout

A new directory:

```
~/Movies/Yulu/voicemails/
├── voicemail_20260523_201500.wav
├── voicemail_20260523_201500.raw.transcript.txt
├── voicemail_20260523_201500.transcript.txt
├── voicemail_20260523_201500.title              (optional sidecar; user-supplied title)
├── voicemail_20260523_201500.summary.md         (voicemail-todos output, auto-run)
└── voicemail_20260523_201500.clean.summary.md   (voicemail-clean output, if opted-in)
```

**Naming**: `voicemail_<YYYYMMDD>_<HHMMSS>.<ext>`. The `voicemail_` prefix is mandatory and is how downstream code (e.g., notification routing) identifies voicemail audio paths.

**Title**: when a user passes `--title T`, write `T\n` to `<stem>.title` as a sidecar. Two reasons not to bake the title into the filename:
- Titles often contain spaces / Chinese / punctuation that look ugly on disk
- The title might come from the transcript ("first 8 words") after STT finishes; deferring it keeps the filename stable

The `<stem>.title` sidecar is consumed by `yulu memo list` for display and by the prompt renderer as `{{meeting_title}}` (overriding the generic "voicemail_..." stem if present). If absent, `{{meeting_title}}` falls back to the first 8 words of the transcript.

## 6. Recording Flow

### 6.1 `yulu memo new` (interactive)

```bash
$ yulu memo new
🎤 录音中 — Ctrl+C 停止 (3s 静音自动停)
^C
⏹ Stopped (12s)
📝 转录中...
✅ Transcript: 嗯，记得明天找 Anthropic 团队聊 pricing 的事。
📤 Enqueued 1 prompt: voicemail-todos
```

The CLI:
1. Acquires `recording_lock` (rejects with `RecordingBusy` if a meeting is in flight)
2. Sends start RPC with `sys_disabled=true` and `title="voicemail_<ts>"`
3. Installs a SIGINT handler that triggers stop
4. Blocks on either: SIGINT, or `audio_daemon`'s silence-stop notification (delivered via the existing `~/.config/yulu/audio_daemon.log` tail or via a status-poll loop)
5. Sends stop RPC
6. Triggers `transcribe_voicemail(wav_path)` which calls `stt_daemon` directly (no `agent_queue_worker` indirection at this stage — voicemails want low latency)
7. Enqueues `voicemail`-category auto-run prompts to the standard `agent-queue.json`
8. Prints the transcript inline and exits

The silence-stop threshold for voicemails is **3 seconds** vs meetings' 15 seconds. This is configured via a new `voicemail.silence_seconds` config key (default 3); the silence_seconds is passed to `audio_daemon` via the start request (a new field, additive to Phase 3).

### 6.2 `yulu memo new --title <T>` (with title)

Same as 6.1, but writes `T\n` to `<wav>.title` immediately after the start RPC succeeds. `T` is used as `{{meeting_title}}` in prompt rendering.

### 6.3 Detached recording (CLI exits while recording continues)

`yulu memo new --detach` returns immediately after the start RPC. The recording continues until explicit `yulu memo stop` or silence-stop. Useful for "start recording, then go do something". Without `--detach`, the CLI blocks until stop.

### 6.4 `yulu memo stop`

Sends stop RPC to `audio_daemon`. If no recording is in flight, prints "no active recording" and exits 0 (idempotent). On success, prints the WAV path and exits.

The post-stop pipeline (transcribe + enqueue + notify) runs as a fire-and-forget detached subprocess so `yulu memo stop` returns quickly. The detached worker is a one-shot Python invocation — no new daemon.

## 7. Prompt Category Extension

`prompts/db.py::Category` gains a third enum value:

```python
class Category(str, Enum):
    SUMMARY = "summary"
    CLEANUP = "cleanup"
    VOICEMAIL = "voicemail"   # NEW
```

The `CHECK` constraint in the table schema must be updated:

```sql
CHECK (category IN ('summary', 'cleanup', 'voicemail'))
```

For existing `prompts.sqlite` files in production, the table needs an in-place CHECK-constraint update. SQLite doesn't support `ALTER TABLE ... DROP CONSTRAINT`; the migration is:

1. Open the DB
2. If category check doesn't include `voicemail`: create `prompts_new` with the new constraint, copy rows, drop `prompts`, rename `prompts_new` → `prompts`
3. Idempotent — re-running is a no-op (the constraint check is a one-shot at migration time)

The migration runs lazily in `open_db()` — first connection on a fresh start triggers it.

### 7.1 Seed prompts

Two new entries appended to `SEED_PROMPTS`:

```python
{
    "slug": "voicemail-todos",
    "name": "Voicemail Action Items",
    "category": "voicemail",
    "is_auto_run": True,
    "sort_order": 100,
    "content": """请基于以下语音备忘录，提取我提到的待办事项、想法、决定。

备忘录主题：{{meeting_title}}
时间：{{date}}

转录：
---
{{transcript}}
---

要求：
1. 输出 Markdown，分两段：## 待办事项 / ## 想法记录。
2. 待办事项每条一行，列出具体动作；如果提到了截止日期或对象，标在行末。
3. 想法记录每条 1-2 句，保留原话风格。
4. 不要输出原始转录，不要解释。
""",
},
{
    "slug": "voicemail-clean",
    "name": "Voicemail Cleanup",
    "category": "voicemail",
    "is_auto_run": False,
    "sort_order": 110,
    "content": """请清理以下语音备忘录的转录稿，输出可读版本。

转录：
---
{{transcript}}
---

要求：
- 修正标点和段落；
- 去除"嗯/啊/那个"等口水词；
- 不要改写观点或事实；
- 不要总结，只输出清理后的文本。
""",
},
```

Both use only `{{transcript}}` / `{{meeting_title}}` / `{{date}}` (no `{{my_transcript}}` / `{{their_transcript}}` — voicemails are single-speaker mono-equivalent).

The seeder's idempotency (Phase 2) handles existing prompts.sqlite gracefully — only the 2 new slugs are inserted.

## 8. Inbox CLI

```bash
yulu memo                      # alias for `yulu memo new`
yulu memo new [--title T] [--detach]
yulu memo stop                 # stop any in-flight recording
yulu memo list [--limit N]     # newest first; default N=20
yulu memo show <id>            # print transcript + summary
yulu memo delete <id>          # remove .wav + all siblings; confirm prompt
yulu memo send <id> [--prompt SLUG]   # forward via send_summary
```

`<id>` matches a unique filename-stem prefix. `voicemail_20260523_2015` matches `voicemail_20260523_201500` if no ambiguity; on ambiguity print all candidates and exit 1.

### 8.1 `yulu memo list` output

```
ID                              TITLE                            DURATION   SUMMARIZED
voicemail_20260523_201500       Anthropic pricing follow-up      12s        ✓
voicemail_20260523_180322       (no title)                       1m08s      ✓
voicemail_20260522_143015       Phase 4 spec brainstorm idea     2m41s      ✓ (todos + clean)
```

- TITLE column: from `.title` sidecar if present, else first 8 words of transcript, else `(no title)`
- DURATION: derived from WAV header (frames / sample_rate)
- SUMMARIZED: `✓` if `.summary.md` exists; lists slug names if multiple summaries exist

### 8.2 `yulu memo show <id>`

Plain-text dump of `<id>.transcript.txt` followed by `<id>.summary.md` (each preceded by a header). If user passes `--md`, opens in `$EDITOR` or `open` to default Markdown viewer.

### 8.3 `yulu memo send <id>`

Wraps `send_summary.py` with the voicemail's audio path and the requested prompt slug (default: `voicemail-todos`). Reuses Phase 2's `send_summary.py --prompt <slug>` flow — no new code beyond argument plumbing.

## 9. Module Structure

```
yulu/scripts/voicemail/
├── __init__.py
├── cli.py          # `yulu memo {new,stop,list,show,delete,send}` argparse + handlers
├── repo.py         # VoicemailRecord dataclass + list_voicemails / get / delete
└── recorder.py     # cmd_new / cmd_stop high-level orchestration
```

`recorder.py` is the bridge: it calls `record_audio.socket_send(...)` (existing helper) with `sys_disabled=true`, threads through `recording_lock`, handles SIGINT, and triggers the post-stop transcribe.

`repo.py` exposes:

```python
@dataclass
class VoicemailRecord:
    stem: str            # "voicemail_YYYYMMDD_HHMMSS"
    wav_path: Path
    title: str           # from .title sidecar OR first 8 words of transcript
    duration_sec: int    # from WAV header
    has_summary: bool    # any .summary.md sibling exists
    summary_slugs: list[str]  # e.g. ["voicemail-todos"]
    created_at: datetime # from filename ts

def list_voicemails(directory: Path = VOICEMAIL_DIR, *, limit: int = 20) -> list[VoicemailRecord]
def get_voicemail(id_prefix: str, directory: Path = VOICEMAIL_DIR) -> VoicemailRecord
def delete_voicemail(record: VoicemailRecord) -> int  # returns count of files removed
```

No new SQLite. The directory listing IS the source of truth.

## 10. Wrapper Integration

`yulu/scripts/yulu` (shell wrapper) dispatches `memo` to `voicemail.cli.main()`:

```bash
case "$1" in
    memo)
        shift
        exec python3 -m voicemail.cli "$@"
        ;;
    # ... existing cases (vocab / stt / prompts / summaries) ...
esac
```

## 11. Completion Notification

After the LLM dispatch completes for the default `voicemail-todos` prompt on a voicemail audio path, `agent_queue_worker` fires `terminal-notifier`:

```python
def _maybe_voicemail_notify(audio_path: Path, summary_path: Path, prompt_slug: str) -> None:
    """Voicemail-only completion notification. Quiet for meetings."""
    if "voicemails" not in audio_path.parts:
        return
    if prompt_slug != "voicemail-todos":
        return
    first_line = ""
    try:
        for line in summary_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                first_line = line[:80]
                break
    except OSError:
        return
    if not first_line:
        first_line = "summary ready"
    subprocess.Popen([
        "terminal-notifier",
        "-title", "Yulu Voicemail",
        "-message", first_line,
        "-open", f"file://{summary_path}",
        "-sender", "com.yulu.audiodaemon",
    ])
```

This adds ~6 lines to `agent_queue_worker._handle_summary_request`'s post-dispatch block. Quiet for any non-voicemail-todos dispatch — no spam for meetings.

## 12. Recording-Lock Interaction

Voicemails acquire the same `~/.config/yulu/.recording.lock` as meetings (Phase 3). The Phase 3 chip fix that defers to daemon `status` for recording-lifetime exclusion means:

- Start a voicemail while a meeting is in flight → `RecordingBusy` with the meeting's title / path / started_at. User sees "录音正在进行中: <meeting title>"
- Start a meeting while a voicemail is in flight → same, mirrored

`yulu memo new` surfaces `RecordingBusy` with a clearer message: "已有录音进行中（会议: <title>）；先 `yulu meet stop` 再录 memo"

## 13. Backward Compatibility

- Pre-existing `.recording.lock` semantics unchanged (Phase 3)
- Pre-existing `prompts.sqlite` migrated lazily to extend the CHECK constraint
- Pre-existing meeting workflow untouched (`yulu meet …` / `meeting_daemon` / scheduler / detector all unchanged)
- Pre-existing `summaries` table records voicemail dispatches without schema change (the `audio_path` discriminates)
- `send_summary.py` already takes `--prompt` (Phase 2); voicemail send reuses unchanged

## 14. Failure Modes

| Failure | Behavior |
|---|---|
| Mic permission revoked | `audio_daemon` start fails → `yulu memo new` exits 1 with `mic capture not available` |
| User Ctrl-C while transcribing (after stop) | Transcription is a child subprocess; SIGINT propagates; partial transcript file may be empty. Recovery: re-run `yulu memo show <id>` after the daemon finishes (visible via `yulu summaries list`) |
| Recording in flight when `yulu memo delete <id>` | If `<id>` is the in-flight recording: refuse, print "still recording — stop first". |
| Disk full | `audio_daemon` write error → recording aborts; partial WAV remains. `yulu memo list` shows it with `(corrupt)` flag if WAV header is unreadable. |
| `audio_daemon` socket dead | `record_audio.socket_send` already retries / errors cleanly; voicemail surfaces the same `daemon failed to start` message as meetings |
| Concurrent two `yulu memo new` invocations | `recording_lock` rejects the second (Phase 3 lock-lifetime fix) |
| Notification command missing | `terminal-notifier` invocation is best-effort; missing binary is logged, voicemail completion still succeeds |

## 15. Acceptance Criteria

1. **CLI invocation**: `yulu memo new` starts a recording, blocks until Ctrl-C, then transcribes and enqueues. Exit code 0 on success.
2. **Storage isolation**: a recorded voicemail lands in `~/Movies/Yulu/voicemails/`, NOT in `~/Movies/Yulu/`. Meeting recordings continue to land in `~/Movies/Yulu/`.
3. **Single-channel transcript**: voicemail WAV is DUAL_TRACK by layout but R is silent; STT returns `mic.text` populated and `sys.skipped_silent`. `<wav>.transcript.txt` is the mic text only; no `.mic./.sys.` sibling files.
4. **No speaker tags**: the merged transcript for a voicemail does NOT contain `[00:00 我]` prefixes (single-speaker; merge_segments must skip the speaker prefix when sys is empty).
5. **Prompt category**: `prompts.sqlite` after seed contains 4 + 2 = 6 prompts, including `voicemail-todos` (category=voicemail, auto-run) and `voicemail-clean` (category=voicemail, opt-in).
6. **Lazy CHECK migration**: opening a pre-Phase-4 `prompts.sqlite` triggers a one-time migration to extend the category constraint; no errors on subsequent opens.
7. **List output**: `yulu memo list` returns the newest 20 voicemails with ID / TITLE / DURATION / SUMMARIZED columns. Empty inbox returns "no voicemails".
8. **Show output**: `yulu memo show <id-prefix>` resolves the unique prefix, prints transcript followed by summary; ambiguous prefix prints all candidates and exits 1.
9. **Delete**: `yulu memo delete <id>` removes `<wav>.{wav,transcript.txt,raw.transcript.txt,summary.md,title,*.summary.md}` (all siblings); idempotent on missing files.
10. **Notification fires only for voicemails**: a meeting summary completion does NOT trigger the new notify; a voicemail-todos completion DOES.
11. **Recording-lock interop**: starting `yulu memo new` while a meeting is in flight prints `录音正在进行中: <meeting title>` and exits 2.
12. **No regression**: Phase 1+2+3 acceptance tests (all 200) still pass.

## 16. References

- macparakeet `spec/15-voicemail-inbox.md` — mic-only ad-hoc capture; small inbox CLI
- Phase 3 spec `docs/superpowers/specs/2026-05-22-dual-track-recording-design.md` — SYS_DISABLED + DUAL_TRACK marker
- Phase 2 ADR `yulu/spec/adr/004-prompt-library.md` — single LLM dispatcher pattern
- macOS `terminal-notifier` — completion notifications (already used by Yulu for crash recovery)
