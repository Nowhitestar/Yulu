# ADR-003: `realtime_transcribe.py` rewritten as daemon subscriber (not deleted)

**Status**: Accepted
**Date**: 2026-05-22
**Spec**: [docs/superpowers/specs/2026-05-22-stt-daemon-and-vocab-design.md](../../../docs/superpowers/specs/2026-05-22-stt-daemon-and-vocab-design.md) §11

## Context

The original implementation plan (Task 7.2) called for **deleting**
`realtime_transcribe.py` after the daemon absorbed its mlx-whisper
invocation. The plan assumed `meeting_daemon.py` was the spawn point, where
adding a `subscribe_session_lifecycle` async helper + threading shim would
replace the subprocess.

Implementation surfaced a different reality: `realtime_transcribe.py` is
spawned by `record_audio.py` ([yulu/scripts/record_audio.py:112](../../scripts/record_audio.py#L112)),
not by `meeting_daemon.py`. The existing contract — PID file at
`~/.config/yulu/.realtime_transcribe.pid`, SIGTERM-to-stop, log file
sibling — is the integration boundary the rest of Yulu already depends on.

## Decision

**Rewrite `realtime_transcribe.py` in place as a thin daemon-subscriber
process**, instead of deleting it.

The new script:
1. Connects to `~/.config/yulu/stt_daemon.sock`.
2. Sends a `subscribe_session` message with the audio file path.
3. Receives `partial` events from the daemon and accumulates them into
   `<audio>.realtime.transcript.txt` as they arrive.
4. On SIGTERM, sends `unsubscribe_session{reason: "stopped"}` and exits.

The script contains zero `mlx_whisper` import — all STT happens in the daemon.

## Rejected alternatives

- **Delete `realtime_transcribe.py` and rewire `record_audio.py`** to talk to
  the daemon directly. `record_audio.py` is sync (called from
  `meeting_daemon`, which is also sync); adding asyncio + a background thread
  for the long-lived subscriber connection would inflate `record_audio.py`
  beyond its current focused scope. The thin subprocess is a cleaner
  separation.
- **Have the daemon write `<audio>.realtime.transcript.txt` directly** from
  `LiveSessionManager`. The daemon doesn't know the file-naming convention
  used by transcribe.py; coupling them through the file path would create
  hidden contract drift. Keeping the subscriber subprocess as the file-writer
  preserves the "daemon emits events, clients shape the output" boundary.
- **Inline socket connection inside `record_audio.py`** (sync). Awkward —
  sync clients hold the subscription open for the whole recording, blocking
  whichever thread they're on. Subprocess gives natural process isolation +
  signal-based teardown.

## Consequences

**Good**
- Acceptance criterion "no `mlx_whisper` import outside `stt_daemon/`" is
  met. `import mlx_whisper` only appears in `stt_daemon/backends/mlx.py`.
- `record_audio.py`'s spawn-and-kill contract is preserved — zero changes
  required there.
- The subscriber script is now 200 lines (down from 290) and contains no
  audio decoding logic. All the complexity lives in
  `LiveSessionManager.tail_loop`.

**Bad**
- One process per active recording (same as before). On a quad-core M1 with
  one active meeting, this is invisible. With many concurrent recordings the
  process count grows linearly — but Yulu's user model is one recording at a
  time.
- The script's name is now slightly misleading — it doesn't transcribe, it
  subscribes. A future rename (e.g. `realtime_subscriber.py`) is acceptable
  but breaks the `record_audio.py` reference; we accept the slight misnomer
  for now.

## Notes for future change

If Yulu grows multiple concurrent recordings (e.g. parallel meetings), the
subscriber processes coexist cleanly because each has its own `sid` and
daemon-side `LiveSession`. No code change needed.

If we want to drop the subscriber subprocess entirely, the cleanest path is
to have `record_audio.py` make a short-lived `subscribe_session` RPC at start
(daemon begins tailing autonomously) and `unsubscribe_session` at stop. The
daemon would then have to know the realtime transcript file path — passed
via the subscribe payload as a `realtime_transcript_path` field. That's an
additive protocol change; the current subscriber subprocess can stay until
then without blocking anything.
