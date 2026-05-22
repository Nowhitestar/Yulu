# ADR-001: Resident `stt_daemon` with two-slot scheduler

**Status**: Accepted
**Date**: 2026-05-22
**Spec**: [docs/superpowers/specs/2026-05-22-stt-daemon-and-vocab-design.md](../../../docs/superpowers/specs/2026-05-22-stt-daemon-and-vocab-design.md)
**Plan**: [docs/superpowers/plans/2026-05-22-stt-daemon-and-vocab.md](../../../docs/superpowers/plans/2026-05-22-stt-daemon-and-vocab.md)

## Context

Until v0.x, every transcription path (`transcribe.py`, `realtime_transcribe.py`)
spawned its own `mlx-whisper` subprocess. Loading `mlx-whisper` large-v3 takes
3–10 seconds on Apple Silicon; this cost was paid on every final transcribe and
every realtime restart. A 5-minute meeting could spend 8–20 seconds of CPU just
on repeated model loads.

Two STT consumers also coexisted (final + realtime) — each kept its own model
copy in RAM, doubling memory pressure.

## Decision

Run a **single resident Python daemon** (`stt_daemon`) under launchd that owns
one `mlx-whisper` model instance plus an optional `whisper-cli` adapter. All
STT requests funnel through a Unix-socket RPC at
`~/.config/yulu/stt_daemon.sock`.

The daemon's internal scheduler has **two slots**, mirroring macparakeet's
ADR-016 architecture:

- **Interactive slot** — reserved for `dictation` (currently idle in Yulu,
  but the slot exists so adding dictation later is a producer-side change
  only).
- **Background slot** — shared by `final_transcribe`, `live_chunk`, and
  `file_transcribe`, with static priority in that order.

Cancellation is cooperative: each in-flight job holds a `CancelToken` checked
before each model call. `live_chunk` jobs have a per-session queue depth limit
(default 4); excess admissions drop the oldest.

## Rejected alternatives

- **Per-process model load** — status quo; 3–10s tax per call, unbounded RAM
  with concurrent consumers. The whole reason we did this work.
- **Two parallel daemons** (one for live, one for final) — doubles RAM; the
  scheduling problem we'd otherwise face inside one daemon doesn't disappear,
  it just moves to the OS scheduler. macparakeet considered + rejected this in
  ADR-016 for the same reason.
- **Subprocess pool with shared model** — `mlx-whisper` is Python only and
  doesn't support cross-process model sharing cleanly. A pool would need
  shared-memory tensors (CoreML doesn't expose this) or IPC marshaling
  (defeats the purpose).

## Consequences

**Good**
- Cold-start tax paid once per launchd lifecycle, not per call.
- Single RAM footprint (~2 GB) regardless of how many consumers.
- Cancellation, backpressure, and priority are centrally enforced.
- Adding dictation later only requires a new producer that submits to the
  interactive slot.

**Bad**
- IPC adds ~1–5 ms latency vs in-process. Acceptable for STT scale.
- launchd lifecycle and daemon-down failure modes are new operational concerns.
  Mitigated by `KeepAlive=true`, `ThrottleInterval=10s`, `yulu doctor`
  health checks, and `yulu stt restart`.
- Tests that span the socket need either real-process spawn or in-process
  `app.start()/stop()`; we chose the latter for unit tests (faster) and gated
  real-process tests behind `pytest -m e2e`.

## Notes for future change

If we ever want a true `dictation` interactive path, the slot is reserved but
not implemented. ADR-016 in macparakeet describes the producer-side wiring; we
can copy that pattern when Yulu grows a system-wide hotkey.

If memory pressure becomes a problem on machines with concurrent live + final
work, we have one knob: pin live preview to a smaller model (e.g. whisper-tiny
on whisper-cli) while keeping final on mlx large-v3. The scheduler already
supports per-job engine selection.
