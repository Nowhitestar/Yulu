# Phase K — Voicemail Realtime Transcription + Global Settings Toggle (Design)

**Date:** 2026-05-28
**Status:** Approved (design)
**PR:** accumulates into PR #24 (`claude/yulu-frontend-spec`) — NOT a separate PR
**Predecessor:** Phase J (recordings unification) — see `2026-05-28-yulu-ui-J-recordings-unification-design.md` §10, which first scoped this work.

---

## 1. Problem

Today only **meetings** transcribe live. The voicemail path (`yulu memo` → `voicemail/recorder.py::cmd_new`) records, then does a single **whole-file** transcribe after stop (`_transcribe_and_enqueue`). It never starts a realtime transcriber.

We want voicemails to transcribe live too, and we want a **single global Settings toggle** that controls realtime transcription for *both* voicemails and meetings. When the toggle is **off**, recordings fall back to whole-file transcription after stop (today's behavior).

## 2. Decisions (locked)

1. **Final transcript when realtime is ON = promote the live transcript.** When a recording stops, we stop the realtime transcriber, then promote its `<wav>.realtime.transcript.txt` to the canonical `<wav>.transcript.txt`. We do **not** run a second whole-file pass. If the realtime transcript is missing or empty, we fall back to whole-file transcribe.
2. **The toggle is global.** A single config flag `transcription.realtime_enabled` (default `true`) governs both voicemail and meeting realtime transcription. `record_audio.realtime_enabled()` already reads this exact key — meetings already honor it. Phase K extends the voicemail path to honor it too.

## 3. Architecture

```
yulu memo  →  voicemail/recorder.py :: cmd_new(title, silence_seconds)
  1. acquire recording lock
  2. _socket_send({action:"start", title:"voicemail", sys_disabled:True, silence_seconds, output_dir})  → wav_path
  3. _record_lock_meta(...)
  4. _start_realtime(wav_path)                 # NEW — no-op when realtime disabled (self-guarded)
  5. poll daemon status until not recording    # SIGINT / silence-stop
  6. finally: _stop_realtime()                 # NEW — flush + reap detached transcriber (no-op if never started)
  7. if wav missing → return 1
  8. if _realtime_enabled():
        rc = _promote_realtime_transcript(wav_path, title)   # NEW
        if rc == 0: return 0
        # realtime empty/missing → fall through
  9. return _transcribe_and_enqueue(wav_path, title)         # whole-file (unchanged behavior)
```

**Key reuse:** Steps 4 & 6 call the existing `record_audio.start_realtime_transcriber` / `stop_realtime_transcriber` — the same functions meetings use via `daemon_start` / `daemon_stop`. The voicemail path bypasses `daemon_start/stop` (it talks to the socket directly), so it must start/stop the transcriber itself. No realtime logic is duplicated.

### 3.1 Realtime transcript format & the promote step

`realtime_transcribe.py` writes line-per-partial with a speaker tag:

```
[Me] 嗯 记得明天找 Anthropic 团队
[Me] 然后把会议纪要发出去
```

(`source=="mic"` → `Me`, else `Them`.) For voicemails `sys` is disabled, so only `[Me]` lines arrive.

But the canonical voicemail `<wav>.transcript.txt` is **plain single-speaker text with no tags** (see existing `_extract_mic_text` + `test_transcribe_writes_mic_text_only`). So promoting verbatim would pollute the transcript, the search index body, and LLM prompt input with `[Me]` prefixes.

**Therefore the promote step strips speaker tags** before writing: drop the `[Me] `/`[Them] ` prefix on each line, drop blank lines, join with `\n`. This yields plain text consistent with the whole-file path.

## 4. Components / Files

| # | File | Change |
|---|------|--------|
| K.1 | `yulu/scripts/voicemail/recorder.py` | Refactor shared finalize step; add realtime seams + promote + cmd_new branch |
| K.2 | `yulu/scripts/yulu_ui/src/config.ts` | `ConfigSchema.transcription` gains `realtime_enabled`; `RESTART_MAP` documents it as `"none"` |
| K.3 | `yulu/scripts/yulu_ui/web/src/components/settings/TranscriptionSection.tsx` | Add a toggle row for `transcription.realtime_enabled` (default on) |
| K.4 | `yulu/setup.sh` | Default `config.json` template's `transcription` block gains `"realtime_enabled": true` |
| K.5 | tests | pytest (recorder branches) + vitest (settings toggle + config classifier) |

`record_audio.py` needs **no change** — `realtime_enabled()` already reads `transcription.realtime_enabled` (falls back to `audio.realtime_transcribe`), and `start/stop_realtime_transcriber` already self-guard.

## 5. K.1 — `voicemail/recorder.py` (the core change)

### 5.1 New import

Add `import re` at the top (alongside `signal`, `sys`, `time`).

### 5.2 Extract a shared finalize helper (DRY)

Both the whole-file path and the promote path write raw+final transcript, persist the title sidecar, push to the search index (best-effort), and enqueue voicemail prompts. Extract that tail into one helper so both paths share it:

```python
def _finalize_transcript(wav_path: Path, text: str, *, title: Optional[str]) -> int:
    """Write raw+final transcript, persist title sidecar, push to the search
    index (best-effort), and enqueue voicemail prompts. Returns 0."""
    raw_path = wav_path.with_suffix(".raw.transcript.txt")
    transcript_path = wav_path.with_suffix(".transcript.txt")
    raw_path.write_text(text, encoding="utf-8")
    transcript_path.write_text(text, encoding="utf-8")
    _persist_title_sidecar(wav_path, title)

    # Best-effort search-index push. Failures here MUST NOT break the
    # recording pipeline — the reader-side sweep recovers any miss.
    try:
        from search import indexer as _search_indexer
        _search_indexer.upsert_doc(
            source_path=transcript_path,
            kind=_search_indexer.KIND_VOICEMAIL_TRANSCRIPT,
            body=text,
        )
    except Exception as exc:
        print(
            f"⚠️ search index upsert failed for {transcript_path}: {exc}",
            file=sys.stderr,
        )

    meeting_title = title or wav_path.stem
    queued = _enqueue_voicemail_prompts(
        audio_path=wav_path,
        transcript_path=transcript_path,
        title=meeting_title,
        prompts_db=PROMPTS_DB,
        queue_path=AGENT_QUEUE_PATH,
    )
    print(f"📤 enqueued {queued} voicemail prompt(s)", file=sys.stderr)
    return 0
```

`_transcribe_and_enqueue` then collapses to the whole-file head + shared tail:

```python
def _transcribe_and_enqueue(wav_path: Path, *, title: Optional[str]) -> int:
    """Whole-file post-stop pipeline. Returns 0 on success, non-zero on failure."""
    response = _request_transcribe(wav_path)
    if response.get("status") != "ok":
        print(
            f"⚠️ stt_daemon transcribe failed: {response.get('error')}",
            file=sys.stderr,
        )
        return 2
    text = _extract_mic_text(response)
    return _finalize_transcript(wav_path, text, title=title)
```

This preserves every existing test: on daemon error it returns `2` before any file is written; on success the same files/index/queue side effects fire.

### 5.3 Realtime seams (patchable for tests)

Mirror the existing `_socket_send` indirection pattern so tests can stub `record_audio` away:

```python
def _realtime_enabled() -> bool:
    """Indirection over record_audio.realtime_enabled (the global flag)."""
    from record_audio import realtime_enabled
    return bool(realtime_enabled())


def _start_realtime(wav_path: Path) -> None:
    """Start the live transcriber for this voicemail. No-op when realtime is
    disabled (start_realtime_transcriber self-guards on realtime_enabled())."""
    from record_audio import start_realtime_transcriber
    start_realtime_transcriber(str(wav_path), "voicemail")


def _stop_realtime() -> None:
    """Stop + reap the live transcriber. No-op if it was never started."""
    from record_audio import stop_realtime_transcriber
    stop_realtime_transcriber(wait=True)
```

### 5.4 Promote helper

```python
_SPEAKER_TAG_RE = re.compile(r"^\[(?:Me|Them)\]\s*")


def _strip_speaker_tags(raw: str) -> str:
    """Realtime transcripts are line-per-partial with a [Me]/[Them] prefix.
    Voicemails are single-speaker — strip the tag, drop blank lines, and
    rejoin so the result matches the plain-text whole-file transcript."""
    out: list[str] = []
    for line in raw.splitlines():
        cleaned = _SPEAKER_TAG_RE.sub("", line).strip()
        if cleaned:
            out.append(cleaned)
    return "\n".join(out)


def _promote_realtime_transcript(wav_path: Path, *, title: Optional[str]) -> int:
    """Promote the live realtime transcript to the final transcript.
    Returns 0 on success; 2 if the realtime transcript is missing or empty
    (caller falls back to whole-file transcribe)."""
    rt_path = wav_path.with_suffix(".realtime.transcript.txt")
    if not rt_path.exists():
        return 2
    text = _strip_speaker_tags(rt_path.read_text(encoding="utf-8"))
    if not text:
        return 2
    return _finalize_transcript(wav_path, text, title=title)
```

### 5.5 `cmd_new` wiring

Inside the `with _acquire_recording_lock(...)` block, after the `🎤 录音中` print, start the transcriber; reap it in the poll loop's `finally`:

```python
            print(f"🎤 录音中 — Ctrl+C 停止 ({silence_seconds}s 静音自动停)",
                  file=sys.stderr)
            _start_realtime(wav_path)   # NEW — no-op when realtime disabled

            stop_requested = {"v": False}

            def _on_sigint(_sig, _frame):
                stop_requested["v"] = True

            prev = signal.signal(signal.SIGINT, _on_sigint)
            try:
                while True:
                    if stop_requested["v"]:
                        _socket_send({"action": "stop"})
                        stop_requested["v"] = False  # one-shot
                    status = _socket_send({"action": "status"}) or {}
                    if not status.get("recording"):
                        break
                    time.sleep(_poll_interval)
            finally:
                signal.signal(signal.SIGINT, prev)
                _stop_realtime()        # NEW — flush + reap even on exception
            print("⏹ Stopped", file=sys.stderr)
```

Replace the final `return _transcribe_and_enqueue(...)` tail with the promote-first branch:

```python
    if wav_path is None or not wav_path.exists():
        print("⚠️ recording stopped but no .wav file present", file=sys.stderr)
        return 1

    if _realtime_enabled():
        rc = _promote_realtime_transcript(wav_path, title=title)
        if rc == 0:
            return 0
        print(
            "⚠️ realtime transcript empty/missing — falling back to whole-file transcribe",
            file=sys.stderr,
        )
    return _transcribe_and_enqueue(wav_path, title=title)
```

**Note:** `cmd_new` calls `_start_realtime` / `_stop_realtime` unconditionally — they self-guard, so they're harmless when realtime is off. Only the final promote-vs-whole-file branch checks `_realtime_enabled()`.

## 6. K.2 — config schema + restart classifier (`src/config.ts`)

Add `realtime_enabled` to the typed transcription object (the object is already `.passthrough()`, so this is for type-safety + discoverability, not validation):

```ts
  transcription: z.object({
    final_engine: z.enum(["mlx", "whisper-cli"]).optional(),
    language: z.string().optional(),
    glossary: z.array(z.string()).optional(),
    local_model_path: z.string().optional(),
    mlx: z.record(z.unknown()).optional(),
    command: z.array(z.string()).optional(),
    realtime_enabled: z.boolean().optional(),   // NEW
  }).passthrough(),
```

Document the flag in `RESTART_MAP` as explicitly no-impact. The realtime transcriber is spawned per-recording by `record_audio` at recording-start, reading config fresh each time — so toggling the flag needs **no daemon restart**; it takes effect on the next recording. Add:

```ts
  "transcription.realtime_enabled":  "none",
```

(`classify()` already returns empty arrays for `"none"` and for unmatched keys; the explicit entry documents intent and is locked by a test.)

## 7. K.3 — Settings UI toggle (`TranscriptionSection.tsx`)

Extend the `tr` type cast and add a toggle row as the **first** row of the section (it's the headline behavior). Default to `true` to match the config default.

Type cast:

```tsx
  const tr = cfg.transcription as {
    realtime_enabled?: boolean;
    final_engine?: "mlx" | "whisper-cli";
    language?: string;
    local_model_path?: string;
    mlx?: Record<string, unknown>;
  };
```

Row (inserted immediately after `<p className="settings-section-sub">…</p>`, before "Final engine"):

```tsx
      <InlineEditRow
        label="Realtime transcription"
        help="Transcribe live while recording. Off = transcribe after the recording stops."
        type="toggle"
        value={tr.realtime_enabled ?? true}
        onCommit={commit("transcription.realtime_enabled") as (v: boolean) => void}
        status={tracker.statusFor("transcription.realtime_enabled")}
      />
```

`InlineEditRow` toggle renders `<button role="switch" aria-checked={value}>`; no restart banner appears because the classifier returns no daemons for this key.

## 8. K.4 — `setup.sh` default config template

In the `cat > "$CONFIG_DIR/config.json"` heredoc (the `transcription` block), add the flag as the first key so fresh installs default to realtime ON:

```jsonc
  "transcription": {
    "realtime_enabled": true,
    "mode": "local",
    "post_recording_mode": "fast_summary",
    "final_engine": "whisper",
    ...
  },
```

Existing installs are unaffected: `realtime_enabled()` falls back to `audio.realtime_transcribe` (default `true`) when the key is absent, so behavior is unchanged until the user toggles it.

## 9. K.5 — Tests

### 9.1 pytest — `tests/test_voicemail_recorder.py` (extend)

Follow the existing harness (`isolated_paths` fixture; `monkeypatch.setattr(recorder, ...)`; patch `_request_transcribe` / `_socket_send` / `_poll_interval`). Add:

1. **`test_promote_strips_speaker_tags_and_finalizes`** — write `<wav>.realtime.transcript.txt` = `"[Me] line one\n[Me] line two\n"`; call `recorder._promote_realtime_transcript(wav, title=None)`; assert rc `0`, `<wav>.transcript.txt` == `"line one\nline two"`, raw mirrors it, queue has `voicemail-todos`.
2. **`test_promote_returns_2_when_realtime_missing`** — no rt file; assert rc `2` and no `.transcript.txt`.
3. **`test_promote_returns_2_when_realtime_empty`** — rt file = `"[Me]\n   \n"` (tag-only / blank); assert rc `2`, no `.transcript.txt`.
4. **`test_promote_pushes_to_search_index`** — monkeypatch `search.indexer.upsert_doc`; assert it's called once with `kind=KIND_VOICEMAIL_TRANSCRIPT` and the stripped body.
5. **`test_cmd_new_realtime_on_promotes_without_wholefile`** — `monkeypatch.setattr(recorder, "_realtime_enabled", lambda: True)`; make `_start_realtime` write the rt file (`lambda p: Path(p).with_suffix(".realtime.transcript.txt").write_text("[Me] live text\n")`); `_stop_realtime` → no-op; patch `_socket_send` (start→recording, status→recording then not); patch `_request_transcribe` to **raise** if called; assert rc `0`, `.transcript.txt` == `"live text"`, and `_request_transcribe` was never invoked.
6. **`test_cmd_new_realtime_off_uses_wholefile`** — `_realtime_enabled` → `False`; `_start_realtime`/`_stop_realtime` → no-ops; patch `_request_transcribe` to return mic text; assert `.transcript.txt` == the mic text (whole-file path).
7. **`test_cmd_new_realtime_on_empty_falls_back_to_wholefile`** — `_realtime_enabled` → `True`; `_start_realtime` writes nothing; patch `_request_transcribe` to return mic text; assert it falls back (transcript == mic text) and the fallback warning is printed to stderr.

Example for #5 (the integration-shaped test):

```python
def test_cmd_new_realtime_on_promotes_without_wholefile(
    isolated_paths, tmp_path, monkeypatch,
):
    monkeypatch.setattr(recorder, "VOICEMAIL_DIR", tmp_path)
    monkeypatch.setattr(recorder, "_realtime_enabled", lambda: True)
    monkeypatch.setattr(recorder, "_poll_interval", 0.01)

    wav_path = tmp_path / "voicemail_20260528_120000.wav"
    wav_path.touch()

    def fake_start_realtime(p):
        Path(p).with_suffix(".realtime.transcript.txt").write_text(
            "[Me] live text\n", encoding="utf-8")
    monkeypatch.setattr(recorder, "_start_realtime", fake_start_realtime)
    monkeypatch.setattr(recorder, "_stop_realtime", lambda: None)

    status_responses = iter([
        {"recording": True, "file": str(wav_path)},
        {"recording": False, "file": str(wav_path)},
    ])

    def fake_socket_send(cmd):
        if cmd.get("action") == "status":
            return next(status_responses)
        if cmd.get("action") == "start":
            return {"status": "recording", "file": str(wav_path)}
        if cmd.get("action") == "stop":
            return {"status": "stopped", "file": str(wav_path)}
        return None
    monkeypatch.setattr(recorder, "_socket_send", fake_socket_send)

    def boom(_wav):
        raise AssertionError("whole-file transcribe must not run when realtime promotes")
    monkeypatch.setattr(recorder, "_request_transcribe", boom)

    rc = recorder.cmd_new(title="MyMemo")
    assert rc == 0
    assert wav_path.with_suffix(".transcript.txt").read_text(encoding="utf-8") == "live text"
```

### 9.2 vitest — `tests/web/routes/settings.test.tsx` (extend)

Add `realtime_enabled: true` to the mock `cfg.transcription`, then add a test:

```tsx
  it("renders the realtime transcription toggle, default on", () => {
    const { getByText } = wrap();
    const labelEl = getByText("Realtime transcription");
    const row = labelEl.closest(".row");
    expect(row).not.toBeNull();
    const sw = row!.querySelector('[role="switch"]');
    expect(sw).not.toBeNull();
    expect(sw!.getAttribute("aria-checked")).toBe("true");
  });
```

### 9.3 vitest — `tests/routers/config.test.ts` (extend)

Lock the no-restart classification:

```ts
  it("update(transcription.realtime_enabled) needs no daemon restart", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const r = await caller.update({ key: "transcription.realtime_enabled", value: false });
      expect(r.daemonsNeedingRestart).toEqual([]);
      expect(r.daemonsNeedingSighup).toEqual([]);
    } finally { cleanup(); }
  });
```

## 10. Out of scope

- No change to `record_audio.py`, `realtime_transcribe.py`, `stt_daemon`, or the meeting path (they already honor the flag).
- No migration of existing `config.json` files (fallback covers absent key).
- The deferred dead-`sidebar`-router / redundant `recordings.audioUrl` cleanup (already flagged separately) is **not** part of Phase K.

## 11. Verification

- `pytest tests/test_voicemail_recorder.py -v` — all existing + 7 new pass.
- `cd yulu/scripts/yulu_ui && npm run typecheck && npm test` — settings + config router suites pass.
- Real-machine smoke: record a short voicemail with the toggle ON → confirm `.transcript.txt` (no `[Me]` tags) + summary enqueued; toggle OFF → confirm whole-file transcribe still works.
- CI green; commit accumulates into PR #24.
