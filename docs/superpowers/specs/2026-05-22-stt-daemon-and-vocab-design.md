# Spec: STT Daemon + Vocab SQLite

> **Status**: Draft — pending user review
> **Date**: 2026-05-22
> **Owner**: 不白 (yxliao.lewis@gmail.com)
> **Inspired by**: macparakeet `spec/06-stt-engine.md` (centralized STT runtime + scheduler) and `spec/07-text-processing.md` (deterministic vocab pipeline)
> **Replaces**: ad-hoc `mlx-whisper` subprocess invocations across `scripts/transcribe.py` and `scripts/realtime_transcribe.py`; hardcoded `DEFAULT_GLOSSARY` constant and `replacements` dict
> **Out of scope** (future specs): dual-track recording, Prompt Library + multi-summary, voicemail/inbox protocol, speaker diarization, native UI shell

---

## 1. Background and Motivation

Yulu currently runs `mlx-whisper` as a one-shot subprocess from `scripts/transcribe.py` every time a meeting finishes transcribing. Loading the `large-v3` MLX model takes 3–10 seconds on Apple Silicon; this cost is paid every transcribe. `scripts/realtime_transcribe.py` independently spawns its own `mlx-whisper` process during recording — a second model copy.

In parallel, all custom vocabulary is hardcoded across the codebase: `DEFAULT_GLOSSARY` constant in `transcribe.py:61-66`, an inline `replacements` dict in `transcribe.py:221-231`, and an undocumented `transcription.replacements` field in `config.json`. The hardcoded list is not user-editable without editing source, and the two paths (mlx initial_prompt vs post-transcription regex) are conceptually different but live in the same dict.

The macparakeet codebase solves the same two problems with a centralized `STTRuntime` + `STTScheduler` (two-slot model: interactive for dictation, background for meeting/file) plus a SQLite `custom_words` table with deterministic post-processing. Their architecture is portable to Yulu's process-oriented topology with one change: where macparakeet runs in-process, Yulu runs an out-of-process daemon (because the rest of Yulu is already daemon-oriented).

This spec defines that daemon and the vocab DB.

## 2. Goals

1. **Zero mlx-whisper cold start tax** for all transcribe paths after first model load.
2. **One `mlx-whisper` model instance**, shared across realtime live chunks and final transcribe.
3. **User-editable vocabulary** via `yulu vocab` CLI backed by `~/.config/yulu/vocab.sqlite`; affects both mlx `initial_prompt` and post-transcription regex replacement, with per-row scope control.
4. **Future-ready scheduler**: two slots (interactive + background), so adding dictation later is a producer-side change only.
5. **Crash-resilient live sessions**: stt_daemon restart resumes in-flight meetings from persisted tail offsets without losing partial transcripts.
6. **Single STT owner**: no shadow mlx-whisper invocations anywhere else in the codebase.

## 3. Non-Goals

- New transcription engine (Parakeet, NeMo). Stay on mlx-whisper + whisper-cli.
- Dual-track recording (mic.wav + sys.wav as separate files). Single recording WAV stays for now; daemon tails it.
- Speaker diarization.
- Prompt Library / multi-summary. `SUMMARY_PROMPT` in `transcribe.py` and `agent_queue_worker.py` remain hardcoded for this spec.
- UI app shell, menu bar, notarized DMG distribution.
- Vocabulary "learn" mode (auto-extract terms from past transcripts).

## 4. Process Topology (After Implementation)

```
              Calendar / Window Detector
                         │
                  scheduler_daemon
                         │
                  meeting_daemon
                         │
                  audio_daemon (Swift) ──── unchanged, only new control msgs
                    │      │
                  mic.wav / sys.wav (or combined recording.wav for now)
                    │
                    ▼
              ┌─────────────────────────┐
              │   stt_daemon (Python)   │  ← NEW
              │ ┌─ STTScheduler ──────┐ │
              │ │ interactive slot    │ │
              │ │ background slot     │ │
              │ └─────────────────────┘ │
              │ ┌─ STTRuntime ────────┐ │
              │ │ mlx-whisper (resident)
              │ │ whisper-cli (subproc) │
              │ └─────────────────────┘ │
              │ ┌─ VocabCache ────────┐ │
              │ └─────────────────────┘ │
              │   stt_daemon.sock        │
              └──────────┬──────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   transcribe.py   meeting_daemon    yulu vocab CLI
   (thin client)   (subscribe         (CRUD vocab,
                    live sessions)     SIGHUP daemon)
                         │
                  agent_queue_worker ─── unchanged
```

### Single-Responsibility Boundaries

| Process | Owns | Does Not Own |
|---|---|---|
| `audio_daemon` (Swift) | Audio capture, WAV file writing, control socket | Chunking, STT, vocab |
| **`stt_daemon` (Python, NEW)** | STT scheduling, mlx-whisper lifecycle, whisper-cli dispatch, vocab cache, live session tailing | Audio capture, calendar, agent queue, summary generation |
| `transcribe.py` | Thin RPC client; preserves `refine_transcript` / `summarize` / `fallback_summary` / `request_agent_summary` business logic | mlx-whisper subprocess invocation |
| `meeting_daemon` | Recording lifecycle; opens long-lived session subscription to stt_daemon | Direct STT |
| `yulu vocab` CLI | `custom_words` SQLite CRUD; SIGHUP daemon after writes | STT |

## 5. stt_daemon Internal Architecture

### 5.1 Layers

```
ControlServer (asyncio Unix socket, line-delimited JSON)
        │
STTScheduler
        ├── interactive slot worker (1 fiber)
        └── background slot worker (1 fiber)
                priority queue: final_transcribe > live_chunk > file_transcribe
        │
STTRuntime
        ├── mlx-whisper holder (lazy load, kept resident)
        └── whisper-cli dispatcher (subprocess)
        │
VocabCache
        ├── reads vocab.sqlite at startup
        ├── reloads on SIGHUP or mtime change
        └── exposes prompt_terms list + replace_rules list

LiveSessionManager
        ├── tracks active session tail offsets
        └── persists per-session JSON for crash recovery
```

### 5.2 STTScheduler

- **Slots = 2, fixed.** Interactive slot is currently idle; reserved for future dictation. Both slots have a worker fiber at startup.
- **Job kinds**: `dictation`, `final_transcribe`, `live_chunk`, `file_transcribe`.
- **Routing**: `dictation` → interactive slot. All others → background slot.
- **Priority within background slot** (static): `final_transcribe(1) > live_chunk(2) > file_transcribe(3)`. Lower number = higher priority.
- **No preemption.** When `final_transcribe` arrives mid-`live_chunk`, the running chunk finishes (≤2s typical), then `final_transcribe` runs next.
- **Cancellation**: each job carries a `CancelToken`. Workers check token before each mlx call. Stopping a live session cancels all queued chunks for that `sid`.
- **Backpressure**: `live_chunk` queue depth ≤ 4 per session. Excess → drop oldest, log `live_chunk_dropped`.

### 5.3 STTRuntime

- `warm_up(engine=mlx|whisper)` loads the requested engine. Idempotent.
- `transcribe(audio_path, language, initial_prompt, cancel_token, engine, options)` → `STTResult { text, raw_text, segments, language }`.
- mlx-whisper model loaded lazily on first transcribe (or explicit `warm_up`); kept resident until daemon shutdown.
- whisper-cli runs as subprocess each call (cheap relative to model load); same vocab `initial_prompt` injection.
- Health: `is_ready()`, `model_info()`.
- Self-heal: 3 consecutive `mlx-whisper` internal errors trigger model release + re-lazy-load on next call.

### 5.4 VocabCache

- Reads `~/.config/yulu/vocab.sqlite` on startup. Indexes:
  - `prompt_terms: list[str]` — terms with `scope IN ('prompt', 'both')` AND `enabled=1`
  - `replace_rules: list[(compiled_regex, canonical)]` — terms with `scope IN ('replace', 'both')` AND `enabled=1`, sorted by `len(term) DESC` (longest-first to avoid prefix shadowing)
- `reload()` re-reads SQLite, swaps caches atomically.
- Reload triggers: SIGHUP signal OR mtime change detected before a transcribe job runs.
- `inject_prompt(base_prompt)` builds the initial_prompt string for mlx-whisper (consolidates current `_glossary_prompt()` logic).
- `apply_replacements(raw_text)` performs the regex pass; reports replacement count for observability.

### 5.5 LiveSessionManager

- Each active session has an entry: `{sid, mic_path, sys_path?, engine, language, mic_offset_bytes, sys_offset_bytes, next_seq, started_at, last_partial_at}`.
- Persisted to `~/.config/yulu/sessions/<sid>.tail.json` after each successful chunk; daemon crash + restart re-loads on boot.
- Tail loop per session: every `chunk_sec` seconds of *recorded audio* (default 10s, configurable per session via `subscribe_session`), seek to `*_offset_bytes`, read new PCM, dispatch a `live_chunk` job, push `partial` event back to subscriber, advance offset, persist. The 10s default is chosen because the daemon model is resident — smaller chunks give finer live preview without paying per-chunk cold-start tax (the reason the legacy `realtime_transcribe.py` defaulted to 60s).
- Session ends via `unsubscribe_session { sid, reason }` → cancels queued live chunks, optionally auto-emits a `final_transcribe` job depending on `reason`.

## 6. Unix Socket Protocol

**Path**: `~/.config/yulu/stt_daemon.sock` (matches `audio_daemon.sock` convention).

**Encoding**: Line-delimited JSON. Each line is one complete object terminated by `\n`.

**Two connection modes**: short-lived RPC (transcribe.py, vocab CLI) and long-lived subscribe (meeting_daemon).

### 6.1 Message Table

| Message | Direction | Payload | Notes |
|---|---|---|---|
| `health` | C→D | `{}` | Returns runtime stats |
| `warm_up` | C→D | `{engine?}` | Explicit lazy-trigger |
| `vocab_reload` | C→D | `{}` | Force reread; returns counts |
| `transcribe` | C→D | see 6.2 | Synchronous response in same connection |
| `cancel` | C→D | `{job_id}` | Cooperative cancel |
| `subscribe_session` | C→D | see 6.3 | Long-lived; daemon pushes `partial` events |
| `unsubscribe_session` | C→D | `{sid, reason: "stopped"\|"orphaned"\|"crashed"}` | Auto-triggers final based on reason |
| `partial` | D→C (push) | `{sid, seq, source, started_ms, ended_ms, text}` | Per chunk |
| `final_ready` | D→C (push) | `{sid, transcript_path, raw_path, engine, duration_ms}` | After session_stop + final_transcribe |
| `error` | D→C | `{job_id?, code, message, details?}` | Anytime |

### 6.2 `transcribe` Request Schema

```json
{
  "type": "transcribe",
  "job_id": "uuid-v4",
  "kind": "final_transcribe | live_chunk | file_transcribe | dictation",
  "engine": "mlx | whisper",
  "language": "zh",
  "audio": {
    "path": "/abs/path.wav",
    "offset_bytes": 0,
    "length_bytes": null,
    "format": "wav-pcm-s16le-16k-mono | wav-pcm-s16le-48k-stereo | m4a"
  },
  "context": {
    "meeting_title": "optional, joined into initial_prompt",
    "session_id": "optional, tags partial events",
    "vocab_override": null
  },
  "options": {
    "word_timestamps": false,
    "condition_on_previous": true,
    "hallucination_silence_threshold": 2.0,
    "timeout_sec": 7200
  }
}
```

Response:

```json
{
  "type": "transcribe_result",
  "job_id": "...",
  "status": "ok | error | cancelled",
  "engine_used": "mlx",
  "language_used": "zh",
  "text": "vocab-replaced transcript",
  "raw_text": "unmodified mlx output",
  "segments": [{ "start_ms": 0, "end_ms": 4200, "text": "..." }],
  "vocab_applied": { "prompt_terms_count": 47, "replacements_count": 12 },
  "duration_ms": 23150,
  "error": null
}
```

### 6.3 `subscribe_session` Schema

```json
{
  "type": "subscribe_session",
  "sid": "uuid",
  "mic_path": "/abs/.../recording.wav",
  "sys_path": null,
  "engine": "mlx",
  "language": "zh",
  "chunk_sec": 10
}
```

Subscriber receives `partial` events as chunks complete and `final_ready` after `unsubscribe_session { reason: "stopped" }`. `reason: "orphaned"` or `"crashed"` also triggers final but with different metadata.

### 6.4 Error Codes (fixed enum)

| Code | Meaning | Client Action |
|---|---|---|
| `MODEL_NOT_LOADED` | Engine not warm yet | Retry once + `warm_up` |
| `ENGINE_UNAVAILABLE` | mlx load failed or whisper-cli missing | Surface to user |
| `AUDIO_NOT_FOUND` | Path missing / unreadable | Surface to user |
| `AUDIO_TOO_SHORT` | < 0.3s | Skip with warning |
| `JOB_CANCELLED` | Cancel triggered | Silent |
| `ENGINE_BUSY` | Live chunk dropped (queue full) | Log warning, no retry |
| `VOCAB_LOCKED` | SQLite write conflict | Retry 100ms ≤ 3 times |
| `WATCHDOG_TIMEOUT` | Daemon unresponsive | Surface to user; suggest `yulu stt restart` |
| `INTERNAL` | Unexpected exception in daemon | Log + surface |

## 7. Vocab SQLite Schema

**Path**: `~/.config/yulu/vocab.sqlite`. WAL mode for concurrent reader/writer.

```sql
CREATE TABLE custom_words (
    id          TEXT PRIMARY KEY,
    term        TEXT NOT NULL,
    canonical   TEXT NOT NULL,
    scope       TEXT NOT NULL CHECK(scope IN ('prompt', 'replace', 'both')),
    source      TEXT NOT NULL DEFAULT 'manual'
                CHECK(source IN ('seed', 'manual', 'learned')),
    enabled     INTEGER NOT NULL DEFAULT 1,
    note        TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX idx_custom_words_enabled_scope ON custom_words(enabled, scope);
CREATE INDEX idx_custom_words_canonical ON custom_words(canonical);

CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Initial meta rows: schema_version=1, seeded_at=<ISO 8601 timestamp>
```

### Semantics

- `(term, scope)` not unique by constraint — same term may appear with different scopes for advanced users. Default CLI prevents duplicates within a scope.
- `canonical == term` AND `scope IN ('prompt', 'both')` ⇒ **vocabulary anchor** (model recognition hint).
- `canonical != term` AND `scope IN ('replace', 'both')` ⇒ **correction** (post-transcription replacement).
- `enabled=0` rows are skipped at runtime but preserved (toggle without delete).
- Matching:
  - Replace pattern: `\b{re.escape(term)}\b` with `re.IGNORECASE`. Longest-first to avoid prefix shadowing.
  - For CJK terms (Unicode word characters not delimited by ASCII `\b`), use **plain substring match** with `re.IGNORECASE`. This accepts a small false-positive risk (e.g., `开会` would also match inside `公开会议`), but the current seed has no CJK conflict-prone terms. If this becomes a problem, add per-row `match_mode: word | substring` later.

### Seed (initial migration)

The seeder bundles **frozen snapshots** of the current in-code constants (this avoids depending on `scripts/transcribe.py` still containing them — the same PR that adds the seeder also deletes the constants from `transcribe.py`).

On `yulu vocab seed --from-current`:
1. Apply bundled `SEED_GLOSSARY` snapshot (frozen copy of `DEFAULT_GLOSSARY` at spec-writing time).
2. Apply bundled `SEED_REPLACEMENTS` snapshot (frozen copy of `replacements` dict).
3. Additionally read `config.json` `transcription.replacements` if user has overrides, merge non-duplicates.
4. Insert each as a row with `source='seed'`:
   - Glossary terms → `term=canonical=X, scope='prompt'`
   - Replacements `X→Y` → `term=X, canonical=Y, scope='both'` (both prompt-time and replace-time)
5. Write `meta.seeded_at`.

`yulu vocab seed --restore-defaults` re-applies snapshots, overwriting any `source='seed'` rows but preserving `source='manual'` rows.

After the initial migration PR ships, the source-code constants and config field are removed; the seeder's bundled snapshots are the canonical history.

## 8. CLI Surface

All under `yulu` shell wrapper. Vocab writes auto-SIGHUP daemon (read pid from `~/.config/yulu/stt_daemon.pid`).

```
yulu vocab list [--scope prompt|replace|both] [--disabled] [--json]
yulu vocab add <term> [<canonical>] [--scope both] [--note "..."]
yulu vocab edit <id> [--term ...] [--canonical ...] [--scope ...] [--enable|--disable]
yulu vocab remove <id>
yulu vocab import <file.json|file.csv>
yulu vocab export [--format json|csv] [-o path]
yulu vocab seed --from-current
yulu vocab seed --restore-defaults
yulu vocab reload

yulu transcribe <audio_path> [--engine mlx|whisper] [--language zh|en|...] [--mode raw|clean]
yulu stt status
yulu stt warm-up
yulu stt logs [--tail N]
yulu stt restart

yulu doctor    # already exists, extended with stt_daemon checks
```

Not in this spec:
- `yulu vocab learn` (auto-extract terms from past transcripts)
- `yulu stt benchmark`

## 9. Daemon Lifecycle and Resiliency

### 9.1 launchd

New plist `scripts/com.yulu.sttdaemon.plist`:
- `RunAtLoad=true`, `KeepAlive=true`
- `ThrottleInterval=10` (crashloop guard)
- `StandardOutPath` / `StandardErrorPath` → `~/.config/yulu/logs/stt_daemon.log`
- `EnvironmentVariables`: `YULU_HOME`, `PATH` ensuring `mlx-whisper` venv visible

### 9.2 Startup

```
launchd → stt_daemon main
  1. parse config (~/.config/yulu/config.json)
  2. open vocab.sqlite, load VocabCache
  3. start ControlServer (bind + listen)
  4. start STTScheduler (both worker fibers)
  5. scan ~/.config/yulu/sessions/*.tail.json; for sessions whose audio path
     still exists, restart tail loop from persisted offset
  6. do NOT preload mlx model (lazy on first transcribe or explicit warm_up)
  7. accept connections
```

### 9.3 Shutdown

`SIGTERM` / `SIGINT`:
```
  1. stop accepting new connections
  2. scheduler.drain() — in-flight jobs complete, queued jobs cancelled
  3. persist LiveSessionManager tail offsets (already periodic; final sync)
  4. release mlx model
  5. close socket, remove sock file
```

### 9.4 SIGHUP

Triggers `VocabCache.reload()` only. Does not restart process. PID written to `~/.config/yulu/stt_daemon.pid` at startup.

### 9.5 Failure Matrix

| Scenario | Detection | Recovery |
|---|---|---|
| mlx model load fails (OOM / corrupt) | `STTRuntime.warm_up()` exception | Daemon stays up, `model_loaded=false`; client gets `ENGINE_UNAVAILABLE`; user runs `yulu doctor` |
| mlx mid-transcribe crash | Python exception in worker fiber | Job returns `INTERNAL`; worker survives; 3-strike auto model reset |
| whisper-cli subprocess fails | returncode != 0 | Job returns `ENGINE_UNAVAILABLE` with stderr digest |
| Daemon process crash | launchd detects exit | KeepAlive restart; RPC clients see EOF; subscribers reconnect |
| Daemon hang (unresponsive socket) | Client connect/read timeout | `WATCHDOG_TIMEOUT`; user `launchctl kickstart` via `yulu stt restart` |
| vocab.sqlite locked | `OperationalError: database is locked` | Daemon retries 100ms × 3, then `VOCAB_LOCKED`; CLI uses WAL + `busy_timeout=2000ms` |
| audio_daemon dies mid-session | Tail loop reads 0 bytes, file mtime stale > 30s | Emit `partial { error: "audio source stalled" }`; do not close session (audio_daemon may restart) |
| WAV header race (audio_daemon mid-patch) | N/A | Daemon ignores header, uses `fstat.st_size` for length |
| Session tail target deleted | open() fails | Remove tail.json; emit `error` to subscriber if any |
| Disk full / SQLite write fail | `OSError` on write | Daemon enters degraded mode (reads still work); writes return `INTERNAL` |
| Client connection flood | Listener accepts max 100 concurrent | Reject + log warning |

### 9.6 Live Session Crash Recovery Scenarios

**A. meeting_daemon crashes mid-recording**
- audio_daemon keeps recording (independent daemon).
- meeting_daemon restarts via launchd; scans audio_daemon `.state.json` and finds `recording=true` but no owned session.
- meeting_daemon sends `unsubscribe_session { reason: "orphaned" }` to stt_daemon, which auto-emits `final_transcribe` against the audio file.

**B. stt_daemon crashes + restarts mid-recording**
- launchd restarts daemon.
- Daemon scans `sessions/*.tail.json`; for each, restarts tail loop from persisted offset.
- Subscriber (meeting_daemon) detects connection drop, reconnects, re-issues `subscribe_session` with the same `sid`. Daemon detects existing `LiveSession`, reuses it, resumes pushing `partial` with `seq` continuing.

**C. Final transcribe in flight when stt_daemon crashes**
- Scheduler state is in-memory; job lost on crash.
- transcribe.py client sees connection drop, reconnects, retries the request once. Idempotent because audio file unchanged.

## 10. Observability

`yulu doctor` extended:
```
[stt_daemon] socket reachable        ✓
[stt_daemon] launchd loaded          ✓ (pid 12345)
[stt_daemon] vocab.sqlite readable   ✓ (476 terms, schema v1)
[stt_daemon] model loaded            ✓ (mlx-whisper large-v3, warm 162ms ago)
[stt_daemon] in-flight jobs          0
[stt_daemon] active sessions         0
[stt_daemon] recent errors (24h)     2 (AUDIO_TOO_SHORT × 2)
```

Logs: `~/.config/yulu/logs/stt_daemon.log`, line-delimited JSON:

```json
{"ts":"2026-05-22T10:00:00Z","level":"info","event":"job_accepted","job_id":"...","kind":"final_transcribe","queue_depth":0}
{"ts":"...","level":"info","event":"job_completed","job_id":"...","duration_ms":23150,"vocab_replacements":12}
{"ts":"...","level":"warn","event":"live_chunk_dropped","sid":"...","reason":"queue_full"}
{"ts":"...","level":"error","event":"engine_failed","code":"INTERNAL","traceback":"..."}
```

## 11. Migration Path

Per the project's "completeness over minimal-change" principle:

| Old | New | Action |
|---|---|---|
| `DEFAULT_GLOSSARY` constant in `scripts/transcribe.py` | vocab.sqlite seed rows | Migrated by `yulu vocab seed --from-current`, then constant deleted |
| `replacements` dict in `scripts/transcribe.py` `normalize_transcript_text` | vocab.sqlite rows with `scope='both'` | Same; dict deleted |
| `config.json` `transcription.replacements` | vocab.sqlite | Seeder reads; setup.sh prints deprecation; field removed in same PR |
| `scripts/realtime_transcribe.py` | deleted | meeting_daemon switches to `subscribe_session` |
| `scripts/transcribe.py` mlx subprocess logic (`transcribe_mlx`, `transcribe`) | daemon | transcribe.py reduced to thin client; business logic (`refine_transcript`, `summarize`, `fallback_summary`, `request_agent_summary`) preserved |
| `config.json` `transcription.command` / `mlx.python` / `whisper_cli` / `local_model_path` / `language` / `initial_prompt` | partly daemon config (`engine_defaults`, `model_paths`), partly per-request override | One-time migration via setup.sh |
| `agent_queue_worker.py` `SUMMARY_PROMPT` | unchanged in this spec | Future Prompt Library spec |

### setup.sh additions

```
N. Copy com.yulu.sttdaemon.plist → ~/Library/LaunchAgents/
N+1. launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yulu.sttdaemon.plist
N+2. yulu vocab seed --from-current
N+3. yulu stt warm-up
N+4. yulu doctor
```

### dev_install.py additions

- Register stt_daemon in dev launchd target.
- Support `--restart-stt` flag.

## 12. Testing Strategy

Following macparakeet's "Mostly integration" philosophy:

| Tier | Scope | Tooling | CI |
|---|---|---|---|
| Unit | VocabCache parsing, scope indexing, regex boundary, priority queue ordering, cancel token | pytest, no I/O | yes |
| DB | sqlite CRUD, migration, SIGHUP reload, concurrent writes | pytest, temp sqlite | yes |
| Protocol | socket message parse/serialize, connection lifecycle, error codes | pytest + asyncio mock socket | yes |
| Integration (mock STT) | scheduler + runtime + vocab full chain via `MockSTTBackend` | pytest, spawn real daemon | yes |
| E2E (real model, opt-in) | real mlx-whisper on fixture audios, validate transcript content + vocab effects | `pytest -m e2e` | local only |

### MockSTTBackend Protocol

```python
class STTBackend(Protocol):
    async def warm_up(self) -> None: ...
    async def transcribe(
        self,
        audio_path: str,
        language: str,
        initial_prompt: str,
        cancel_token: CancelToken,
    ) -> STTResult: ...

class MockSTTBackend:
    """Returns canned results based on audio_path fixture path.
    Records `initial_prompt` for assertion."""
```

Integration tests assert:
- vocab `prompt_terms` reach mlx `initial_prompt`
- vocab `replace_rules` applied to raw text
- priority ordering (submit file_transcribe → submit final_transcribe → final returns first)
- session cancellation drops queued live chunks
- SIGHUP makes a newly added replace rule visible on next transcribe

E2E fixture suite: three audio files (10s / 60s / 600s) in `yulu/tests/fixtures/audio/`. Tests verify:
- 60s audio < 1s end-to-end after warm
- Transcripts saved to expected paths
- vocab replacements visible in transcript

## 13. Acceptance Criteria

1. After first model load, **no further mlx-whisper cold start** is observable. Second meeting → transcribe → ≤2s before decode starts (parity with macparakeet warm).
2. `scripts/realtime_transcribe.py` deleted; repo `grep -r mlx_whisper` shows hits only inside `scripts/stt_daemon/`.
3. `scripts/transcribe.py` reduced to < 200 lines (currently 581); contains only business orchestration (daemon RPC, refine, summary, agent_queue).
4. `DEFAULT_GLOSSARY` constant removed from source code; `yulu vocab list | wc -l ≥ 23` (current seed count).
5. `kill -9` on stt_daemon → launchd restarts within 10s; an in-flight `final_transcribe` retried once by client succeeds.
6. `yulu vocab add "AgentKit" --scope both` → within 30s, the next transcribe shows:
   - mlx `initial_prompt` contains "AgentKit"
   - "agent kit" (and other configured aliases) replaced with "AgentKit"
7. `swift test` unchanged result (audio_daemon Swift side only adds new socket message types; existing paths untouched).
8. `pytest yulu/tests/` all green including daemon integration suite.

## 14. Open Questions

None at spec-writing time. Future specs to file:
- Dual-track recording (mic.wav + sys.wav with alignment metadata)
- Prompt Library + multi-summary
- Voicemail/Inbox protocol
- Dictation hotkey + interactive slot activation

---

**End of spec.**
