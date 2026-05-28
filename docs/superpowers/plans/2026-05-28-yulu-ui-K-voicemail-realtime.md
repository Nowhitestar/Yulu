# Phase K — Voicemail Realtime Transcription + Global Settings Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give voicemail recordings live transcription, gated by a single global `transcription.realtime_enabled` flag (default on); on stop, promote the realtime transcript to the final transcript (whole-file fallback when empty); off keeps today's whole-file behavior.

**Architecture:** The voicemail orchestrator (`voicemail/recorder.py::cmd_new`) talks to the audio daemon socket directly and bypasses `record_audio.daemon_start/stop`, so it never started a realtime transcriber. Phase K makes `cmd_new` start `record_audio.start_realtime_transcriber` after the daemon confirms recording and stop it when recording ends, then — when the global flag is on — promote `<wav>.realtime.transcript.txt` (speaker tags stripped to plain single-speaker text) to `<wav>.transcript.txt` via a shared `_finalize_transcript` helper, falling back to whole-file transcribe when the realtime transcript is empty. The flag is surfaced in the Settings → Transcription section and seeded by `setup.sh`. `record_audio.realtime_enabled()` already reads this key, so meetings need no change.

**Tech Stack:** Python 3.12 (pytest), Node 20 + TypeScript 5 + Zod + tRPC 11 (vitest), React 18, bash (setup.sh).

**Spec:** `docs/superpowers/specs/2026-05-28-yulu-ui-K-voicemail-realtime-design.md`

**Branch:** `claude/yulu-frontend-spec` — every commit accumulates into PR #24. Do NOT open a new PR.

**Test bootstrap notes:**
- pytest: `tests/test_voicemail_recorder.py` self-bootstraps `sys.path` to `yulu/scripts`. Run from the repo root: `python -m pytest tests/test_voicemail_recorder.py -v`.
- vitest/typecheck: run inside `yulu/scripts/yulu_ui` (`npm test`, `npm run typecheck`).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `yulu/scripts/voicemail/recorder.py` | Voicemail start/stop orchestration + post-stop transcript pipeline | Extract `_finalize_transcript`; add realtime seams, `_strip_speaker_tags`, `_promote_realtime_transcript`; wire `cmd_new` |
| `tests/test_voicemail_recorder.py` | pytest for the recorder | Add promote + cmd_new-branch tests |
| `yulu/scripts/yulu_ui/src/config.ts` | Config schema + dotted-key → daemon-restart classifier | Add `realtime_enabled` to schema; add `"none"` RESTART_MAP entry |
| `yulu/scripts/yulu_ui/tests/routers/config.test.ts` | vitest for config router | Add no-restart classification case |
| `yulu/scripts/yulu_ui/web/src/components/settings/TranscriptionSection.tsx` | Settings → Transcription UI | Add realtime toggle row + type cast field |
| `yulu/scripts/yulu_ui/tests/web/routes/settings.test.tsx` | vitest for Settings page | Add toggle-renders test + mock cfg field |
| `yulu/scripts/setup.sh` | Fresh-install default config template | Add `"realtime_enabled": true` to the `transcription` block |

---

## Task 1: Refactor `_finalize_transcript` (behavior-preserving)

Extract the shared transcript-finalize tail (write raw+final, persist title, search upsert, enqueue) so both the whole-file path and the upcoming promote path reuse it. Pure refactor — the existing pytest suite is the regression guard; no new test.

**Files:**
- Modify: `yulu/scripts/voicemail/recorder.py` (the `_transcribe_and_enqueue` function, lines ~93–135)

- [ ] **Step 1: Run the existing suite to confirm green baseline**

Run: `python -m pytest tests/test_voicemail_recorder.py -v`
Expected: PASS (all existing tests green — this is the refactor's safety net).

- [ ] **Step 2: Replace `_transcribe_and_enqueue` with head + extracted `_finalize_transcript`**

Find the current `_transcribe_and_enqueue` (it begins `def _transcribe_and_enqueue(wav_path: Path, *, title: Optional[str]) -> int:` and ends with `return 0`). Replace the **entire** function with these two functions:

```python
def _finalize_transcript(wav_path: Path, text: str, *, title: Optional[str]) -> int:
    """Write raw+final transcript, persist title sidecar, push to the search
    index (best-effort), and enqueue voicemail prompts. Returns 0.

    Shared by the whole-file path (_transcribe_and_enqueue) and the realtime
    promote path (_promote_realtime_transcript)."""
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

- [ ] **Step 3: Run the suite to confirm still green**

Run: `python -m pytest tests/test_voicemail_recorder.py -v`
Expected: PASS (identical results — `test_transcribe_writes_mic_text_only`, `test_transcribe_handles_daemon_error_gracefully`, `test_transcribe_pushes_to_search_index`, `test_transcribe_swallows_search_index_failure`, etc. all still pass).

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/voicemail/recorder.py
git commit -m "refactor(voicemail): extract _finalize_transcript shared tail

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Realtime transcript promote (`_strip_speaker_tags` + `_promote_realtime_transcript`)

Add the promote path: read `<wav>.realtime.transcript.txt`, strip `[Me]`/`[Them]` speaker tags to plain text, and finalize via `_finalize_transcript`. Returns `2` (caller falls back to whole-file) when the realtime transcript is missing or empty.

**Files:**
- Modify: `yulu/scripts/voicemail/recorder.py` (add `import re`; add two functions)
- Test: `tests/test_voicemail_recorder.py` (append 4 tests)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_voicemail_recorder.py`:

```python
def test_promote_strips_speaker_tags_and_finalizes(isolated_paths, tmp_path):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260528_120000.wav"
    wav.touch()
    wav.with_suffix(".realtime.transcript.txt").write_text(
        "[Me] line one\n[Me] line two\n", encoding="utf-8")

    rc = recorder._promote_realtime_transcript(wav, title=None)

    assert rc == 0
    assert wav.with_suffix(".transcript.txt").read_text(encoding="utf-8") == "line one\nline two"
    # raw mirrors the final transcript
    assert wav.with_suffix(".raw.transcript.txt").read_text(encoding="utf-8") == "line one\nline two"
    # voicemail-todos got enqueued
    events = json.loads(queue.read_text(encoding="utf-8"))
    assert [e["prompt_slug"] for e in events] == ["voicemail-todos"]


def test_promote_returns_2_when_realtime_missing(isolated_paths, tmp_path):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260528_120000.wav"
    wav.touch()  # no .realtime.transcript.txt sibling

    rc = recorder._promote_realtime_transcript(wav, title=None)

    assert rc == 2
    assert not wav.with_suffix(".transcript.txt").exists()
    assert json.loads(queue.read_text(encoding="utf-8")) == []


def test_promote_returns_2_when_realtime_empty(isolated_paths, tmp_path):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260528_120000.wav"
    wav.touch()
    # Tag-only / whitespace lines collapse to empty after stripping
    wav.with_suffix(".realtime.transcript.txt").write_text("[Me]\n   \n", encoding="utf-8")

    rc = recorder._promote_realtime_transcript(wav, title=None)

    assert rc == 2
    assert not wav.with_suffix(".transcript.txt").exists()


def test_promote_pushes_stripped_body_to_search_index(isolated_paths, tmp_path, monkeypatch):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260528_120000.wav"
    wav.touch()
    wav.with_suffix(".realtime.transcript.txt").write_text("[Me] hello world\n", encoding="utf-8")

    calls: list[dict] = []
    from search import indexer as search_indexer
    monkeypatch.setattr(search_indexer, "upsert_doc", lambda **kw: calls.append(kw) or True)

    rc = recorder._promote_realtime_transcript(wav, title=None)

    assert rc == 0
    assert len(calls) == 1
    assert calls[0]["kind"] == search_indexer.KIND_VOICEMAIL_TRANSCRIPT
    assert calls[0]["body"] == "hello world"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_voicemail_recorder.py -k promote -v`
Expected: FAIL with `AttributeError: module 'voicemail.recorder' has no attribute '_promote_realtime_transcript'`.

- [ ] **Step 3: Add `import re` and the two functions**

In `yulu/scripts/voicemail/recorder.py`, add `import re` to the stdlib import block (it currently imports `signal`, `sys`, `time`). Add `re` alphabetically, e.g. after `import re`-less block:

```python
import re
import signal
import sys
import time
```

Then add these two functions immediately after `_finalize_transcript` (defined in Task 1):

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_voicemail_recorder.py -k promote -v`
Expected: PASS (4 promote tests green).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/voicemail/recorder.py tests/test_voicemail_recorder.py
git commit -m "feat(voicemail): promote realtime transcript with speaker-tag stripping

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire `cmd_new` (start/stop realtime + promote-first branch)

Add the testable seams over `record_audio` and wire `cmd_new` to start the realtime transcriber after the daemon confirms recording, reap it in the poll loop's `finally`, and (when the global flag is on) promote the realtime transcript before falling back to whole-file.

**Files:**
- Modify: `yulu/scripts/voicemail/recorder.py` (add 3 seam functions; edit `cmd_new`)
- Test: `tests/test_voicemail_recorder.py` (append 3 tests)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_voicemail_recorder.py`:

```python
def _make_cmd_new_socket(wav_path):
    """status: recording once, then stopped; start→recording; stop→stopped."""
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
    return fake_socket_send


def test_cmd_new_realtime_on_promotes_without_wholefile(isolated_paths, tmp_path, monkeypatch):
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
    monkeypatch.setattr(recorder, "_socket_send", _make_cmd_new_socket(wav_path))

    def boom(_wav):
        raise AssertionError("whole-file transcribe must not run when realtime promotes")
    monkeypatch.setattr(recorder, "_request_transcribe", boom)

    rc = recorder.cmd_new(title="MyMemo")
    assert rc == 0
    assert wav_path.with_suffix(".transcript.txt").read_text(encoding="utf-8") == "live text"


def test_cmd_new_realtime_off_uses_wholefile(isolated_paths, tmp_path, monkeypatch):
    monkeypatch.setattr(recorder, "VOICEMAIL_DIR", tmp_path)
    monkeypatch.setattr(recorder, "_realtime_enabled", lambda: False)
    monkeypatch.setattr(recorder, "_poll_interval", 0.01)
    monkeypatch.setattr(recorder, "_start_realtime", lambda p: None)
    monkeypatch.setattr(recorder, "_stop_realtime", lambda: None)

    wav_path = tmp_path / "voicemail_20260528_120000.wav"
    wav_path.touch()
    monkeypatch.setattr(recorder, "_socket_send", _make_cmd_new_socket(wav_path))

    fake_response = {
        "status": "ok",
        "channels": {
            "mic": {"text": "whole file text", "segments": [{"start": 0.0, "end": 1.0, "text": "whole file text"}]},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        rc = recorder.cmd_new(title="MyMemo")

    assert rc == 0
    assert wav_path.with_suffix(".transcript.txt").read_text(encoding="utf-8") == "whole file text"


def test_cmd_new_realtime_on_empty_falls_back_to_wholefile(isolated_paths, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(recorder, "VOICEMAIL_DIR", tmp_path)
    monkeypatch.setattr(recorder, "_realtime_enabled", lambda: True)
    monkeypatch.setattr(recorder, "_poll_interval", 0.01)
    monkeypatch.setattr(recorder, "_start_realtime", lambda p: None)  # writes no rt file
    monkeypatch.setattr(recorder, "_stop_realtime", lambda: None)

    wav_path = tmp_path / "voicemail_20260528_120000.wav"
    wav_path.touch()
    monkeypatch.setattr(recorder, "_socket_send", _make_cmd_new_socket(wav_path))

    fake_response = {
        "status": "ok",
        "channels": {
            "mic": {"text": "fallback text", "segments": [{"start": 0.0, "end": 1.0, "text": "fallback text"}]},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        rc = recorder.cmd_new(title="MyMemo")

    assert rc == 0
    assert wav_path.with_suffix(".transcript.txt").read_text(encoding="utf-8") == "fallback text"
    assert "falling back to whole-file transcribe" in capsys.readouterr().err
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_voicemail_recorder.py -k cmd_new_realtime -v`
Expected: FAIL with `AttributeError: ... has no attribute '_realtime_enabled'` (monkeypatch.setattr on a missing attribute raises).

- [ ] **Step 3: Add the realtime seams**

In `yulu/scripts/voicemail/recorder.py`, add these three functions next to the existing `_socket_send` seam (after `_socket_send`):

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

- [ ] **Step 4: Wire `cmd_new` — start realtime + reap in finally**

In `cmd_new`, locate the block (inside `with _acquire_recording_lock(...)`):

```python
            print(f"🎤 录音中 — Ctrl+C 停止 ({silence_seconds}s 静音自动停)",
                  file=sys.stderr)

            stop_requested = {"v": False}
```

Insert the `_start_realtime` call between the print and `stop_requested`:

```python
            print(f"🎤 录音中 — Ctrl+C 停止 ({silence_seconds}s 静音自动停)",
                  file=sys.stderr)
            _start_realtime(wav_path)   # no-op when realtime disabled

            stop_requested = {"v": False}
```

Then locate the poll loop's `finally`:

```python
            finally:
                signal.signal(signal.SIGINT, prev)
            print("⏹ Stopped", file=sys.stderr)
```

Add `_stop_realtime()` inside the `finally` (so it reaps even on exception):

```python
            finally:
                signal.signal(signal.SIGINT, prev)
                _stop_realtime()        # flush + reap even on exception
            print("⏹ Stopped", file=sys.stderr)
```

- [ ] **Step 5: Wire `cmd_new` — promote-first branch**

At the end of `cmd_new`, replace:

```python
    if wav_path is None or not wav_path.exists():
        print("⚠️ recording stopped but no .wav file present", file=sys.stderr)
        return 1
    return _transcribe_and_enqueue(wav_path, title=title)
```

with:

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

- [ ] **Step 6: Run the full pytest suite to verify all pass**

Run: `python -m pytest tests/test_voicemail_recorder.py -v`
Expected: PASS (all existing + 3 new cmd_new tests green). The pre-existing `test_cmd_new_sends_start_with_sys_disabled_and_silence_seconds` still passes — it does not monkeypatch `_realtime_enabled`, so the real `_realtime_enabled()` runs; with no config file in the temp env it falls back to default `True`, then `_promote_realtime_transcript` finds no `.realtime.transcript.txt` (returns 2) and falls back to `_transcribe_and_enqueue` (its patched `_request_transcribe`), so the title sidecar still lands and rc is 0. If that test instead patches the socket such that `_start_realtime`/`_stop_realtime` reach `record_audio`, note they import lazily and self-guard; with no PID file `_stop_realtime` is a no-op and `_start_realtime` self-guards. Confirm green; if the pre-existing test regresses, monkeypatch `_start_realtime`/`_stop_realtime` to no-ops within it.

- [ ] **Step 7: Commit**

```bash
git add yulu/scripts/voicemail/recorder.py tests/test_voicemail_recorder.py
git commit -m "feat(voicemail): cmd_new starts realtime transcriber + promotes on stop

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Config schema + restart classifier (`src/config.ts`)

Add `transcription.realtime_enabled` to the typed schema and document it in the restart map as no-impact (toggling needs no daemon restart — `record_audio` reads it fresh at each recording start).

**Files:**
- Modify: `yulu/scripts/yulu_ui/src/config.ts` (ConfigSchema transcription object; RESTART_MAP)
- Test: `yulu/scripts/yulu_ui/tests/routers/config.test.ts` (append 1 test)

- [ ] **Step 1: Write the failing test**

Append inside the `describe("configRouter", ...)` block in `yulu/scripts/yulu_ui/tests/routers/config.test.ts`:

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

- [ ] **Step 2: Run the test to verify it passes-or-fails as expected**

Run: `cd yulu/scripts/yulu_ui && npm test -- tests/routers/config.test.ts`
Expected: PASS already (an unmatched key classifies to empty arrays). This test **locks** the behavior so the explicit RESTART_MAP entry in Step 3 cannot silently regress it. If it does NOT pass, the schema rejects the write — proceed to Step 3 to add the schema field, then re-run.

- [ ] **Step 3: Add the schema field + explicit RESTART_MAP entry**

In `yulu/scripts/yulu_ui/src/config.ts`, add `realtime_enabled` to the `transcription` object (the object is `.passthrough()`, so this is for type-safety + discoverability):

```ts
  transcription: z.object({
    final_engine: z.enum(["mlx", "whisper-cli"]).optional(),
    language: z.string().optional(),
    glossary: z.array(z.string()).optional(),
    local_model_path: z.string().optional(),
    mlx: z.record(z.unknown()).optional(),
    command: z.array(z.string()).optional(),
    realtime_enabled: z.boolean().optional(),
  }).passthrough(),
```

In `RESTART_MAP`, add the explicit no-impact entry after `"transcription.mlx": ...`:

```ts
  "transcription.mlx":               "restart:sttdaemon",
  "transcription.realtime_enabled":  "none",
```

- [ ] **Step 4: Run typecheck + the config test**

Run: `cd yulu/scripts/yulu_ui && npm run typecheck && npm test -- tests/routers/config.test.ts`
Expected: typecheck clean; config router tests PASS (including the new case).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/config.ts yulu/scripts/yulu_ui/tests/routers/config.test.ts
git commit -m "feat(config): add transcription.realtime_enabled (no daemon restart)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Settings UI toggle (`TranscriptionSection.tsx`)

Add a "Realtime transcription" toggle as the first row of the Transcription section, defaulting on.

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/components/settings/TranscriptionSection.tsx`
- Test: `yulu/scripts/yulu_ui/tests/web/routes/settings.test.tsx` (add mock field + 1 test)

- [ ] **Step 1: Write the failing test**

In `yulu/scripts/yulu_ui/tests/web/routes/settings.test.tsx`, add `realtime_enabled: true` to the mock `cfg.transcription` object (it currently starts `transcription: { final_engine: "mlx", ... }`):

```ts
    transcription: {
      realtime_enabled: true,
      final_engine: "mlx",
      language: "auto",
      local_model_path: "",
      mlx: { model: "", final_model: "", preprocess_audio: false, passthrough_max_sec: 0, passthrough_max_bytes: 0 },
    },
```

Then append a test inside `describe("Settings (consolidated)", ...)`:

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

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd yulu/scripts/yulu_ui && npm test -- tests/web/routes/settings.test.tsx`
Expected: FAIL — `getByText("Realtime transcription")` throws (no such row yet).

- [ ] **Step 3: Add the toggle row + type field**

In `yulu/scripts/yulu_ui/web/src/components/settings/TranscriptionSection.tsx`, extend the `tr` type cast (add `realtime_enabled` as the first member):

```tsx
  const tr = cfg.transcription as {
    realtime_enabled?: boolean;
    final_engine?: "mlx" | "whisper-cli";
    language?: string;
    local_model_path?: string;
    mlx?: Record<string, unknown>;
  };
```

Insert the toggle row immediately after `<p className="settings-section-sub">Whisper / MLX engine and post-recording mode</p>` and before the `Final engine` `<InlineEditRow>`:

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

- [ ] **Step 4: Run typecheck + the settings test**

Run: `cd yulu/scripts/yulu_ui && npm run typecheck && npm test -- tests/web/routes/settings.test.tsx`
Expected: typecheck clean; settings tests PASS (all 4, including the new toggle test).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/settings/TranscriptionSection.tsx yulu/scripts/yulu_ui/tests/web/routes/settings.test.tsx
git commit -m "feat(settings): realtime transcription toggle in Transcription section

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: setup.sh default config template

Seed `"realtime_enabled": true` in the fresh-install `transcription` block so new installs default to realtime on. (Existing installs are unaffected — `realtime_enabled()` falls back to `audio.realtime_transcribe`, default true, when the key is absent.)

**Files:**
- Modify: `yulu/scripts/setup.sh` (the `cat > "$CONFIG_DIR/config.json"` heredoc, `transcription` block ~line 208)

- [ ] **Step 1: Add the flag as the first key of the transcription block**

In `yulu/scripts/setup.sh`, find:

```bash
  "transcription": {
    "mode": "local",
    "post_recording_mode": "fast_summary",
```

Change to:

```bash
  "transcription": {
    "realtime_enabled": true,
    "mode": "local",
    "post_recording_mode": "fast_summary",
```

- [ ] **Step 2: Verify the template contains the flag**

Run: `grep -n '"realtime_enabled": true' yulu/scripts/setup.sh`
Expected: exactly one match, inside the `transcription` block (around line 209).

- [ ] **Step 3: Verify the heredoc is still valid bash (no syntax break)**

Run: `bash -n yulu/scripts/setup.sh`
Expected: no output (exit 0 — script parses cleanly).

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/setup.sh
git commit -m "feat(setup): seed transcription.realtime_enabled=true in default config

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full verification + push

Run every suite touched, then push.

**Files:** none (verification only)

- [ ] **Step 1: Run the Python recorder suite**

Run: `python -m pytest tests/test_voicemail_recorder.py -v`
Expected: PASS (all tests, incl. 7 new).

- [ ] **Step 2: Run the yulu_ui typecheck + full test suite**

Run: `cd yulu/scripts/yulu_ui && npm run typecheck && npm test`
Expected: typecheck clean; all vitest projects PASS (config router + settings + everything else).

- [ ] **Step 3: Push the branch**

```bash
git push origin claude/yulu-frontend-spec
```

Expected: push succeeds; CI (the `yulu_ui` job + Python tests) runs against PR #24.

- [ ] **Step 4: Real-machine smoke (manual, document outcome)**

Manual checklist (run on the dev machine with daemons up):
1. Settings → Transcription: confirm "Realtime transcription" toggle is present and ON; no restart banner appears when toggled.
2. With toggle ON: `yulu memo`, speak a few seconds, stop. Confirm `<wav>.transcript.txt` has plain text (no `[Me]` tags) and a summary was enqueued.
3. With toggle OFF: `yulu memo`, speak, stop. Confirm whole-file transcribe still produces `<wav>.transcript.txt`.

Document the outcome in the PR thread. (Step 4 is manual; the subagent should report it as a manual checklist for the operator, not block on it.)

---

## Self-Review

**1. Spec coverage:**
- Spec §2 decision 1 (promote realtime, fallback) → Task 2 (`_promote_realtime_transcript`) + Task 3 (cmd_new branch + fallback). ✓
- Spec §2 decision 2 (global flag) → reuse of `record_audio.realtime_enabled()` via `_realtime_enabled` seam (Task 3); config key (Task 4); setup.sh (Task 6). ✓
- Spec §3.1 (strip speaker tags) → Task 2 `_strip_speaker_tags`. ✓
- Spec §5.2 (`_finalize_transcript` refactor) → Task 1. ✓
- Spec §5.3 (seams) → Task 3 Step 3. ✓
- Spec §5.5 (cmd_new wiring) → Task 3 Steps 4–5. ✓
- Spec §6 (config schema + RESTART_MAP) → Task 4. ✓
- Spec §7 (Settings toggle) → Task 5. ✓
- Spec §8 (setup.sh) → Task 6 (path corrected to `yulu/scripts/setup.sh`; spec table said `yulu/setup.sh`). ✓
- Spec §9.1 pytest (7 tests) → Task 2 (4) + Task 3 (3). ✓
- Spec §9.2 vitest settings → Task 5. ✓
- Spec §9.3 vitest config → Task 4. ✓
- Spec §11 verification → Task 7. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step shows complete code. ✓

**3. Type/name consistency:** `_finalize_transcript(wav_path, text, *, title)` defined in Task 1, called in Task 2 (`_promote_realtime_transcript`) and Task 1 (`_transcribe_and_enqueue`). `_realtime_enabled`/`_start_realtime(wav_path)`/`_stop_realtime()` defined in Task 3 Step 3, called in Task 3 Steps 4–5 and patched in Task 3 Step 1 tests. `_strip_speaker_tags`/`_SPEAKER_TAG_RE`/`_promote_realtime_transcript` consistent between Task 2 def and Task 3 usage. Config key `transcription.realtime_enabled` identical across Tasks 4/5/6. ✓
