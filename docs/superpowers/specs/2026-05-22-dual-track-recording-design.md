# Spec: Dual-Track Recording (mic / sys 分轨) + Recording Lock

> **Status**: Draft — pending user review
> **Date**: 2026-05-22
> **Owner**: 不白 (yxliao.lewis@gmail.com)
> **Inspired by**: macparakeet `spec/05-audio-capture.md` (per-source channel preservation)
> **Builds on**: ADR-001 (resident `stt_daemon` two-slot scheduler), ADR-004 (Prompt Library with `{{transcript}}` templates)
> **Replaces**: `audio_daemon.swift::halfDuplexMix` (mic + sys merged into a single mono signal at write time, losing speaker identity); ad-hoc concurrent-start protection in `record_audio.py` (today only a state file + pid file, no cross-caller mutex)
> **Out of scope** (future specs): Voicemail Inbox (will build on top of dual-track as "sys-disabled" mode), speaker diarization within a single channel (different problem), realtime per-channel captions (`live_session` stays mic-tail for now)

---

## 1. Background and Motivation

Today every Yulu recording produces one **mono-equivalent stereo WAV** where L and R carry the same `halfDuplexMix(sys, mic)` signal. The original sources — my microphone and the remote system audio — are merged irreversibly when `mixAndWrite()` runs every ~10ms. Three concrete pains follow:

1. **No speaker attribution.** The summary prompt only sees one undifferentiated transcript. Action items, decisions, and "who committed to what" cannot be reliably labeled.
2. **Voicemail / dictation / single-speaker captures cannot be built cleanly.** Any future "voicemail inbox" or "voice note" feature needs mic-only recording. Today the recording pipeline always wires both sources together; mic-only mode would be a special-case fork.
3. **Cross-caller recording-start races.** `record_audio.py start` (manual) and `meeting_daemon._start_recording` (scheduled / detector-triggered) both call the audio daemon's `start` action. The daemon's `isRecording` flag is the only guard; concurrent callers can race past the state-file check (`.recording_pid` is written *after* the daemon socket call), and the daemon's response is "already recording" which the caller treats as success — leading to confusing state. There is no advisory file lock at the caller level.

This spec separates the two audio sources at the write boundary, propagates the separation through STT and prompts, and adds an `flock`-based recording mutex as a small companion change in the same code paths.

## 2. Goals

1. **WAV file preserves source identity**: every recording is a 16-bit PCM stereo file with `L = mic mono`, `R = sys downmixed to mono`. Default sample rate 48 kHz (same as today's `SAMPLE_RATE` constant).
2. **STT pipeline is channel-aware**: stt_daemon transcribes L and R as two jobs and emits per-channel transcripts plus a merged speaker-tagged transcript.
3. **Prompt templates can address speakers**: new template variables `{{my_transcript}}` (mic), `{{their_transcript}}` (sys), and `{{transcript}}` (merged, default — backward compatible).
4. **Single recording-start mutex**: `~/.config/yulu/.recording.lock` acquired via `flock` before any caller (manual, scheduled, detector) sends the daemon's `start` action. Conflicting starts return a clear "busy" status with the live recording's path/title, not a silent success.
5. **Zero migration burden for existing meetings**: legacy mono / "fake stereo" WAVs continue to work in transcribe / summarize / send_summary unchanged.
6. **Voicemail-ready storage primitive**: a future Voicemail Inbox spec only needs to enable a "sys disabled" mode in the daemon — the WAV format, STT pipeline, prompt vars, and lock are reusable as-is.

## 3. Non-Goals

- **Per-speaker diarization within a single channel.** If three people share my mic, they collapse to "me". Solving that needs neural diarization (pyannote / NeMo) — separate spec, separate runtime cost.
- **Live realtime captions per channel.** `live_session.py` (Phase 1) keeps tailing the mic side for live overlays. Per-channel live captions are a future spec; the dual-track WAV makes it possible, this spec doesn't ship it.
- **Migrating historical recordings to dual-track.** Old `.wav` files stay where they are; STT detects channel layout and falls back gracefully.
- **A separate "stems" export feature** (e.g., exporting mic.wav / sys.wav sidecars for editing). YAGNI; the stereo WAV itself is the export.
- **Half-duplex ducking.** Today's `halfDuplexMix` ducks sys when mic is loud, to make a listenable single-channel mix. With separation, both channels are raw — listeners using QuickTime will hear both at native volumes (mic L, sys R, which is what they actually want).

## 4. Topology

```
┌─────────────────────────────────────────────────────────┐
│  audio_daemon.swift                                     │
│                                                         │
│  AVAudioEngine ───► MicCapture.onMicAudio (Float mono)  │
│                              ▼                          │
│                       micBuf (Int16 mono)               │
│                              │                          │
│  ScreenCaptureKit ─► SysAudioOutput (Float stereo)      │
│                              ▼                          │
│                       sysBuf (Int16 stereo)             │
│                              │                          │
│            ┌─────────────────┴───────────────┐          │
│            ▼                                 ▼          │
│  channelInterleave(L=mic_mono,     [old: halfDuplexMix] │
│                   R=avg(sysL,sysR))                     │
│            │                                            │
│            ▼                                            │
│      WavWriter (stereo Int16 PCM, 48 kHz)               │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
              <title>_<ts>.wav  (stereo, L=mic R=sys)
                          │
            ┌─────────────┴──────────────┐
            ▼                            ▼
   stt_daemon transcribe        QuickTime / Finder
            │  (request: {wav, channel_split: true})
            ▼
   for each of {L, R}:
     - silence-skip if RMS < threshold
     - run backend (mlx / whisper-cli) on mono PCM extracted from that channel
     - return {text, segments_with_timestamps, channel}
            │
            ▼
   transcribe.py merges by timestamp →
     <wav>.mic.transcript.txt     (mic only)
     <wav>.sys.transcript.txt     (sys only, may be empty)
     <wav>.transcript.txt          ("[我 00:00:05] ..." style merged, for {{transcript}})
            │
            ▼
   enqueue summary_request × N (per Phase 2; now extras include all 3 transcript vars)
            ▼
   agent_queue_worker renders prompt with {{my_transcript}} / {{their_transcript}} / {{transcript}}
```

```
┌─── Recording Lock ──────────────────────────────────────┐
│  CallerA ──┐                                            │
│  CallerB ──┼─► flock(~/.config/yulu/.recording.lock)    │
│  CallerC ──┘     │                                      │
│                  ▼                                      │
│      acquired? ──yes──► socket_send({action:"start"})   │
│                              │                          │
│                          daemon starts; lock held       │
│                          until daemon emits "stopped"   │
│                              │                          │
│                  no ─────────┴──► returns busy payload  │
│                                   {path, title, since}  │
└─────────────────────────────────────────────────────────┘
```

## 5. Recording Layer (Swift) — Stereo Source-Separated WAV

`AudioRecorder` keeps its existing two buffers (`micBuf: [Int16]` mono, `sysBuf: [Int16]` stereo interleaved). `halfDuplexMix` is removed. A new method `channelInterleave(sys: [Int16], mic: [Int16]) -> [Int16]` produces the output:

```
output[2*i + 0] = mic[i]                     // L = my voice
output[2*i + 1] = (sys[2*i] + sys[2*i+1]) / 2  // R = system audio downmixed
```

Rate matching keeps the existing pattern:
- `outLen = sysBuf.count` (drives output rate; sys is always stereo)
- `micNeeded = outLen / 2` (mic is mono; matches frame count)
- If `micBuf` is short, zero-pad on the right (current behavior; mic silence is true silence)
- If sys is short (e.g., no system audio playing — quiet meeting where I'm just listening for a moment), wait until 10 ms accumulated, then continue. Mic-only frames during sys gaps emit `output[R] = 0` for those samples.

Edge case — **no system-audio permission / sys stream disabled**: `sysBuf` stays empty forever. We must not block writes. New behavior: a "mic-only" path triggers when `SYS_READY == false` at recording start — in that mode, write frames driven by mic rate alone, with `R` zero-filled. This is exactly the storage primitive a future Voicemail spec needs.

WAV header bytes: channels=2, sample-rate=48000, bits-per-sample=16, byte-rate=192000, block-align=4. `WavWriter` already accepts a `channels` parameter; we set it to 2 explicitly (today it is 2 because the mix output is stereo — same number, different semantics).

**RIFF INFO marker (mandatory)**: post-spec `WavWriter` writes a `LIST` chunk containing an `INFO` form with one `ICMT` (comment) subchunk holding the byte string `Yulu DualTrack v1` immediately after the `fmt ` chunk and before `data`. This is the only reliable signal that downstream STT uses to distinguish a true dual-track WAV from a legacy mixed stereo (their PCM content is otherwise indistinguishable). The INFO chunk is part of the RIFF spec and is silently ignored by QuickTime / ffmpeg / Whisper.

**Silence detection** (`SILENCE_THRESHOLD` / `lastAudioTime`): now computes RMS per channel separately and resets `lastAudioTime` when **either** channel is active. Today's combined-RMS approach would mis-trigger silence-stop when sys is loud but mic is silent (or vice versa) — by checking per channel we keep the existing behavior (any source active = recording continues).

## 6. STT Pipeline — Channel-Aware

The stt_daemon control-socket request schema gains one field:

```python
TranscribeRequest = {
    "action": "transcribe",
    "wav": "/abs/path/to/file.wav",
    "title": "...",
    "channel_split": True,  # NEW — default False for back-compat
    "priority": "interactive" | "final",
}
```

A new WAV identification helper (`yulu/scripts/stt_daemon/wav_inspect.py`) classifies any input file:

```python
WavLayout = Enum("WavLayout", ["MONO", "DUAL_TRACK", "LEGACY_STEREO"])

def classify(path: Path) -> WavLayout:
    """Read WAV header + LIST/INFO chunk:
       - channels == 1                                              → MONO
       - channels == 2 AND INFO chunk contains "Yulu DualTrack v1"  → DUAL_TRACK
       - channels == 2 otherwise                                    → LEGACY_STEREO
    """
```

Post-spec `WavWriter` always emits a WAV LIST/INFO chunk with `ICMT=Yulu DualTrack v1` immediately after the `fmt ` chunk. This is a stable, RIFF-standard subchunk; QuickTime/ffmpeg/Whisper all ignore unknown INFO subchunks gracefully. It is the only reliable way to distinguish a post-spec dual-track WAV from a pre-spec mixed-stereo WAV (their byte-level content alone is indistinguishable — pre-spec WAVs also have channels=2 but with mixed signal in both).

When `channel_split=True`:

1. Daemon runs `classify(wav)`.
2. `MONO` → behave as `channel_split=False` (single transcript, no split).
3. `LEGACY_STEREO` → downmix L+R to mono in-memory, then single-transcript path. Log a one-line WARN (`"legacy stereo wav, no source separation: <path>"`) so users notice when reprocessing old meetings.
4. `DUAL_TRACK` → split L and R into in-memory mono streams (alternate Int16 samples; no on-disk sidecars). Each becomes a scheduler job sharing a `group_id` (UUID per request). Jobs run **sequentially** within the group (mic first, then sys) using the existing single backend slot — within-group parallelism is YAGNI for v1 given whisper-large-v3-mlx warm-path latency.
5. Per-channel RMS pre-check: if a channel's whole-file RMS is below `EMPTY_CHANNEL_THRESHOLD` (-50 dBFS), short-circuit to `{"text": "", "segments": [], "skipped_silent": true}` without running STT.
6. Response shape:

```python
TranscribeResponse = {
    "status": "ok",
    "channels": {
        "mic": {"text": "...", "segments": [{"start": 0.5, "end": 3.2, "text": "..."}, ...]},
        "sys": {"text": "...", "segments": [...]} | {"skipped_silent": True}
    }
}
```

Channels keys are literal `"mic"` and `"sys"`. The daemon does not localize these — that's a UI concern at the transcript-merge step.

**STTScheduler change**: jobs in the same `group_id` are kept together in the priority queue — a higher-priority new request cannot preempt one of the two channels of an in-flight group. The existing scheduler already has a `priority` field; adding a `group_id` is a small extension and only affects the preemption logic.

## 7. Transcript Storage and Merge

Three transcript files written per recording, all next to the `.wav`:

| File | Content | Consumers |
|---|---|---|
| `<wav>.mic.transcript.txt` | Plain text, mic channel only, no speaker tags | `{{my_transcript}}` template var |
| `<wav>.sys.transcript.txt` | Plain text, sys channel only, no speaker tags. May be empty (silent channel). | `{{their_transcript}}` template var |
| `<wav>.transcript.txt` | Speaker-tagged merged transcript, ordered by start time | `{{transcript}}` template var (default) — backward compatible with all existing prompts; what Obsidian users see |

Merged format:

```
[00:00:05 我]  今天讨论一下下一步规划。
[00:00:08 对方] OK，我先讲一下我的看法。
[00:00:12 我]  好的，请讲。
[00:00:14 对方] 我觉得 Phase 3 应该聚焦……
```

The `[<MM:SS> <speaker>]` prefix is one line. Speaker labels are localized strings: `我` for mic, `对方` for sys (hardcoded in v1; configurable in a future settings spec if asked). Merge sort by `segments[i].start`; ties broken by channel (mic first).

`<wav>.raw.transcript.txt` (from Phase 2 — pre-cleanup snapshot of `<wav>.transcript.txt`) continues to exist and now stores the **merged** raw transcript, preserving the dual-track speaker tags pre-cleanup. The transcript-cleanup prompt runs on the merged form (operates on the same speaker-tagged text the user reads) — per-channel raw transcripts are not cleanup-rewritten in v1.

## 8. Prompt Template Variables

`PromptsCache.render()` (Phase 2) is extended with two new variables. After this spec all four are always substituted (empty string if not applicable):

| Variable | Source | Notes |
|---|---|---|
| `{{transcript}}` | `<wav>.transcript.txt` (merged speaker-tagged) | Default; existing seed prompts use this. **No change in behavior** for old prompts. |
| `{{my_transcript}}` | `<wav>.mic.transcript.txt` | New. Empty string if mic channel was silent or recording was sys-only (impossible currently but reserved). |
| `{{their_transcript}}` | `<wav>.sys.transcript.txt` | New. Empty string if sys channel silent (common for mic-only recordings / future voicemails). |
| `{{meeting_title}}` / `{{date}}` | (Phase 2) | Unchanged. |

A fourth seed prompt is added in this spec: `action-items-by-speaker` (off by default, opt-in via `yulu prompts edit action-items-by-speaker --auto-run`):

```
请基于以下双轨会议转录，按发言人输出 Action Items。

会议主题：{{meeting_title}}
会议日期：{{date}}

我说过的话（mic 通道）：
---
{{my_transcript}}
---

对方说过的话（sys 通道）：
---
{{their_transcript}}
---

要求：
- 输出两个 Markdown 段落：## 我承诺的事 / ## 对方承诺的事
- 每条 Action Item 一行，标注截止日期（如果提到）。
- 不要输出未明确承诺的"可能要做"的事。
```

(Seed prompt content is captured verbatim in the implementation plan; this is the content schema.)

## 9. Recording Lock

A new module `yulu/scripts/recording_lock.py` exposes:

```python
@contextmanager
def acquire(timeout: float = 0.5) -> Iterator[RecordingLockHandle]:
    """
    Acquire ~/.config/yulu/.recording.lock via fcntl.flock (LOCK_EX | LOCK_NB).
    On success, yield a handle exposing the live recording's metadata
    (if any prior caller wrote it via record(); see below).
    On contention, retry briefly within `timeout`, then raise RecordingBusy(info).

    The lock file remains open for the lifetime of the caller's process.
    """

def record(handle: RecordingLockHandle, *, title: str, path: str, started_at: str) -> None:
    """Write metadata into the locked file so subsequent contenders see who holds it."""
```

Callers:

- `record_audio.py start` — acquires before sending `socket_send({"action": "start"})`. On `RecordingBusy(info)`, prints the existing recording's path/title/duration and exits non-zero.
- `meeting_daemon._start_recording` — same. Logs the conflict to `meeting_daemon.log`. The detector-triggered path uses the same helper.
- `record_audio.py stop` — does **not** acquire (stopping a recording must always succeed regardless of who started it).
- The audio_daemon itself remains the canonical "is recording" authority. The lock is advisory at the **caller** level; if the daemon's own state says "recording", a stale lock is harmless (it falls back to the existing "already recording" branch).

**Stale lock recovery**: `flock` is automatically released when the holding process exits or crashes. The lock file's metadata (path/title/started_at) is rewritten on each successful acquire — it's a best-effort hint, not a source of truth.

This is a small addition (~50 lines + tests) that fits naturally with the dual-track refactor because both touch the recording-start codepath.

## 10. Backward Compatibility

| Existing artifact | Behavior under this spec |
|---|---|
| Pre-spec mono / mixed-stereo `.wav` files | STT runs `WavLayout.classify`: `MONO` or `LEGACY_STEREO` → downmix to mono and produce only `<wav>.transcript.txt` (no `.mic./.sys.` siblings); `{{my_transcript}}` and `{{their_transcript}}` resolve to empty string in prompt rendering. A one-line WARN is logged so reprocessed old meetings are visibly attributed to the legacy pipeline. |
| Existing `{{transcript}}` prompts (seed + user-edited) | Unchanged. The merged transcript is what they get. Speaker tags `[我]`/`[对方]` are visible in the prompt input. |
| `send_summary.py`, html_artifact | Unchanged. They read `<wav>.<slug>.summary.md`; nothing about file layout changes for them. |
| Obsidian / iCloud sync | Sees the `.wav` (one file, unchanged) plus three transcript siblings (one new) and the summary files (unchanged). The two new `.mic.transcript.txt` / `.sys.transcript.txt` siblings sync along but are small. |
| Phase 1 stt_daemon clients without `channel_split` field | Default `channel_split=False` → mono path → single transcript, no change. |
| `live_session.py` (Phase 1 tail loop) | Already structurally split — `_tail_iteration` reads `mic_offset_bytes` and `sys_offset_bytes` independently and dispatches each side with `source="mic"` / `source="system"`. Phase 1 never had a `sys_path` populated; this spec wires it. `LiveSessionSpec.mic_path` / `sys_path` are both populated with the **same** stereo WAV path, plus a `mic_stride` / `sys_stride` byte offset (0 / 2) and `stride_step` (4) so `_read_pending` extracts alternating Int16 samples per channel. The downstream `_dispatch_chunk` flow (already chunks per source) is unchanged. |

## 11. Migration

No data migration. New recordings get dual tracks; old recordings keep working as mono/legacy.

The four-prompt seed catalog (`summary`, `transcript-cleanup`, `action-items`, `action-items-by-speaker`) is added idempotently by `prompts.seed.seed_from_current` — the existing 3-prompt seed already in production gets the 4th added on next `yulu prompts seed --from-current` run, no other change.

## 12. Failure Modes and Error Handling

| Failure | Behavior |
|---|---|
| Mic permission revoked mid-recording | mic samples stop arriving → R-channel keeps writing sys → STT later sees mic channel as mostly silent → `{{my_transcript}}` is empty / short; existing summary still useful. |
| Sys (ScreenCaptureKit) permission revoked / app quits | Same, mirrored. R goes silent. |
| Channel-split STT job fails on one channel only | Whichever channel succeeded writes its transcript; the failed channel's transcript file is created empty with a comment header `# stt failed: <error>` for inspection; merged transcript contains the successful side only. Worker still produces a summary. |
| `flock` cannot be acquired (e.g., NFS / sandboxed env) | `acquire()` retries up to `timeout`, then falls back to a process-list check (`pgrep audio_daemon` + state file freshness) for advisory busy detection. Recording proceeds with a warning logged. |
| Disk full during stereo write | Existing WavWriter error path (logs and finalizes); same as today. |

## 13. Acceptance Criteria

1. **Stereo source-separation**: a 60s test recording with overlapping mic + sys produces a 16-bit PCM stereo WAV where `mean_abs(L) ≈ mic-only signal` and `mean_abs(R) ≈ sys-only signal`. Verified with a unit test feeding known sine waves into `onMicAudio` and `onSysAudio` and asserting L/R isolation in the output (cross-channel leakage < -40 dB).
2. **STT channel split**: against the dual-track test WAV, `stt_daemon transcribe` with `channel_split=True` returns `channels: {mic: {...}, sys: {...}}` with non-empty text for both, and the recovered text matches the synthetic input within Whisper's normal accuracy.
3. **Transcript merge**: `<wav>.transcript.txt` has interleaved `[MM:SS 我] / [MM:SS 对方]` lines sorted by start time, monotonic timestamps, and round-trips through the existing transcript-cleanup prompt without breaking on the speaker tags.
4. **Prompt template parity**: a default `summary` prompt (using only `{{transcript}}`) renders identically to today's behavior given a dual-track input — confirms no regression.
5. **New `{{my_transcript}}` / `{{their_transcript}}`**: an opt-in seed prompt `action-items-by-speaker` renders with both variables populated; missing or empty channel resolves to empty string, no template error.
6. **Recording lock — busy path**: concurrent `record_audio.py start` invocations return: the first succeeds; the second exits non-zero with a structured `RecordingBusy` message including the existing recording's path / title / started_at.
7. **Recording lock — cleanup**: when the recording stops normally or the holding process dies, the next acquire succeeds within 1s.
8. **Legacy WAV compatibility**: both a pre-spec mono and a pre-spec mixed-stereo WAV (no `Yulu DualTrack v1` INFO chunk) flow through the post-spec STT pipeline and produce `<wav>.transcript.txt` only; no `.mic./.sys.` siblings; summaries render correctly with `{{my_transcript}}` / `{{their_transcript}}` as empty strings. A `legacy stereo wav` WARN line appears in the daemon log.
9. **Voicemail-readiness smoke**: starting the audio_daemon with `SYS_READY=false` (sys explicitly disabled) produces a stereo WAV with R near-silent throughout, `<wav>.sys.transcript.txt` is empty, `{{their_transcript}}` resolves to empty string, and the `summary` prompt still produces a coherent summary purely from `{{my_transcript}}`.
10. **No regression in Phase 1 / Phase 2 acceptance tests**: all 145 existing tests still pass.

## 14. Open Questions

None pending — all key decisions resolved at brainstorm time per the user's "completeness + composability + one-shot" principle.

## 15. References

- macparakeet `spec/05-audio-capture.md` — per-source channel handling
- macparakeet `spec/08-stt-runtime.md` — channel-aware STT request shape (similar idea)
- Apple ScreenCaptureKit `SCStream` audio output: planar Float32 stereo (already handled in `SysAudioOutput`)
- AVAudioEngine input tap: device-dependent format, currently coerced to Float mono in `MicCapture` (already correct for L-channel mic-only)
- `fcntl.flock` semantics on macOS — advisory, per-fd, released on process exit (suitable for recording-start mutex)
