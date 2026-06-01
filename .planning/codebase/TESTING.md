# Testing Patterns

**Analysis Date:** 2026-05-29

## Test Framework

### Python (pytest)

**Runner:** pytest (no pinned version; installed fresh in each CI run: `python -m pip install pytest`)

**Config:** No `pytest.ini` or `pyproject.toml`. Markers declared in `tests/conftest.py`:
```python
def pytest_configure(config):
    config.addinivalue_line("markers", "e2e: opt-in tests that require real mlx-whisper model")
    config.addinivalue_line("markers", "integration: tests that spawn the daemon process")
```

**Run Commands:**
```bash
python -m pytest -q              # Run all tests (CI default)
python -m pytest tests -q        # Explicit path (Makefile target)
pytest -m e2e tests/test_e2e_stt_daemon.py -v   # Real model tests (opt-in)
make pytest                      # Convenience wrapper
make test                        # Full suite: py-compile + pytest + swift-build
```

**Assertion library:** Plain `assert` statements only. No third-party assertion library.

### TypeScript / Node (vitest)

**Runner:** vitest (configured via `yulu/scripts/yulu_ui/vitest.workspace.ts` and `yulu/scripts/yulu_ui/vitest.config.ts`)

**Config:**
```typescript
// vitest.config.ts
export default defineConfig({ test: { testTimeout: 5_000 } });

// vitest.workspace.ts — two projects
defineWorkspace([
  {
    test: { name: "server", include: ["tests/**/*.test.ts"],
            exclude: ["tests/web/**"], environment: "node", pool: "forks" }
  },
  {
    plugins: [react()],
    test: { name: "web", include: ["tests/web/**/*.test.{ts,tsx}"],
            environment: "jsdom", setupFiles: ["tests/web/setup.ts"] }
  },
])
```

**Run Commands:**
```bash
cd yulu/scripts/yulu_ui
npm test               # vitest run (all tests, both workspaces)
npm run test:watch     # vitest (watch mode)
npm run typecheck      # tsc --noEmit (separate from test)
npm run e2e            # playwright (optional, not in CI gate currently)
```

---

## Test File Organization

### Python

**Location:** Flat `tests/` directory at repo root — all tests at top level, no subdirectory nesting.

**Naming:** `test_<module_name>.py` matches the Python source it tests:
- `tests/test_doctor.py` → `yulu/scripts/doctor.py`
- `tests/test_state_store.py` → `yulu/scripts/state_store.py`
- `tests/test_agent_queue_worker.py` → `yulu/scripts/agent_queue_worker.py`
- `tests/test_stt_live_session.py` → `yulu/scripts/stt_daemon/live_session.py`
- `tests/test_status_agent_plist_template.py` → plist file (no Python source)
- `tests/test_spec_acceptance.py` → cross-cutting spec acceptance

**Fixtures directory:** `tests/fixtures/audio/` (audio samples for e2e; `tiny_10s.wav` not committed, provider-supplied).

**conftest.py:** `tests/conftest.py` declares custom markers only; no shared fixtures.

### TypeScript

**Location:** `yulu/scripts/yulu_ui/tests/` with two subtrees:
```
tests/
├── *.test.ts           # Server-side / Node environment tests
├── routers/            # tRPC router tests (Node env)
│   └── *.test.ts
├── helpers/            # Shared test utilities
│   ├── fakeUnixSocket.ts
│   └── tmpDb.ts
├── fixtures/
│   └── config.json
└── web/                # React / jsdom tests
    ├── components/     # Component render tests
    │   └── *.test.tsx
    ├── routes/         # Route component tests
    │   └── *.test.tsx
    └── hooks/          # Custom hook tests
        └── *.test.tsx
```

---

## Python Test Structure

### Import Pattern

Every Python test file adds `yulu/scripts` to `sys.path` at the top so imports resolve without an installed package:
```python
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from state_store import load_state, set_recording_started
```

For scripts without a package structure (doctor.py, repair_permissions.py), `importlib.util` is used to load the module by file path:
```python
import importlib.util

def load_doctor():
    spec = importlib.util.spec_from_file_location("doctor", DOCTOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
```
This pattern avoids polluting `sys.modules` and keeps each test isolated.

### Function-Based Tests (standard)

All Python tests are functions, not classes. No `unittest.TestCase`. Names are descriptive full sentences:
```python
def test_normalizes_legacy_nested_recording_state(tmp_path):
def test_collect_report_identifies_source_runtime_and_legacy_paths():
def test_check_yulu_ui_returns_required_keys_when_everything_missing(tmp_path, monkeypatch):
```

### Fixture Usage

Built-in pytest fixtures used: `tmp_path`, `capsys`, `monkeypatch`. No custom fixtures in conftest.py.

`tmp_path` is the standard for isolated filesystem state:
```python
def test_writes_flat_v2_recording_state(tmp_path):
    state_path = tmp_path / ".state.json"
    set_recording_started("New Meeting", "/tmp/new.wav", path=state_path)
    state = load_state(state_path)
    assert state["version"] == 2
```

`monkeypatch` is used for hermeticity when the function under test reaches out to real system resources:
```python
def test_check_yulu_ui_returns_required_keys_when_everything_missing(tmp_path, monkeypatch):
    import urllib.request as _urllib_request
    monkeypatch.setattr(
        _urllib_request, "urlopen",
        lambda *a, **k: (_ for _ in ()).throw(urllib.error.URLError("no server (hermetic test)")),
    )
```

### Inline Fake Processes

For tests requiring subprocess behavior, a fake Python script is written to `tmp_path` and passed as the command:
```python
def write_fake_llm(tmp_path, output):
    llm = tmp_path / "fake_llm.py"
    llm.write_text(
        "import sys\n"
        "prompt = sys.stdin.read()\n"
        "assert 'AgentKey' in prompt\n"
        f"print({output!r})\n",
        encoding="utf-8",
    )
    return llm
```
Pattern used in `test_agent_queue_worker.py`.

### Async Tests (stt_daemon)

`asyncio.run()` inside a synchronous test function — no `pytest-asyncio`:
```python
def test_manager_emits_partial_when_audio_grows(tmp_path):
    ...
    async def _run():
        async with LiveSessionManager(...) as manager:
            ...
    asyncio.run(_run())
```

### Subprocess-Based Tests (recording_lock, audio_daemon)

Tests that verify cross-process locking spawn a sidecar via `subprocess.Popen`, sleep briefly to let it acquire, then verify the contention:
```python
def test_acquire_busy_raises_when_held_in_another_process(tmp_path):
    sidecar = Path(__file__).parent / "_lock_sidecar.py"
    sidecar.write_text(f"""...""")
    proc = subprocess.Popen([sys.executable, str(sidecar)])
    try:
        time.sleep(0.3)
        with pytest.raises(RecordingBusy) as exc_info:
            ...
    finally:
        proc.terminate()
```

---

## TypeScript Test Patterns

### Server Tests (Node environment)

Router tests use a `createCaller` helper with a manually constructed context object containing `vi.fn()` mocks. Fake Unix socket helper (`fakeUnixSocket.ts`) simulates the audio daemon IPC:

```typescript
import { startFakeSocket } from "../helpers/fakeUnixSocket.js";

it("state() round-trips status from status_agent.sock", async () => {
    fake = await startFakeSocket((req) => {
        expect(req).toEqual({ action: "status" });
        return { ok: true, state: "idle", hotkey: "⌘⇧V" };
    });
    const ctx = { paths: { statusAgentSock: fake.path } } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    const r = await caller.state();
    expect(r.state).toBe("idle");
});
```

`fakeUnixSocket.ts` creates a one-shot AF_UNIX server at `/tmp/yulu_test_<uuid>/sock` (avoids macOS 104-byte path limit).

### Web / React Tests (jsdom environment)

`vi.mock()` stubs tRPC client modules so React components render with controlled data:
```typescript
vi.mock("../../../web/src/trpc.js", () => ({
    trpc: {
        daemons: {
            health: { useQuery: () => ({ data: HEALTH, isPending: false }) },
            restart: { useMutation: noopMutation },
        },
    },
}));
```

Components wrapped in `MemoryRouter` + `QueryClientProvider` for render tests:
```typescript
function wrap(initial = "/health") {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[initial]}>
                <Health />
            </MemoryRouter>
        </QueryClientProvider>
    );
}
```

Testing library: `@testing-library/react` + `@testing-library/jest-dom` (assertions like `toBeInTheDocument()`).

---

## Pytest Markers and Opt-In Tests

| Marker | File | Run condition |
|--------|------|---------------|
| `e2e` | `tests/test_e2e_stt_daemon.py` | `pytest -m e2e`; requires `mlx_whisper` + `tests/fixtures/audio/tiny_10s.wav` |
| `integration` | `tests/test_audio_daemon_ipc_starvation.py` | `pytest -m integration`; spawns real daemon process |

Both markers are declared in `tests/conftest.py`. Not used in CI (CI runs `pytest -q` without `-m` which skips opt-in markers? — actually the default run includes all non-skipif tests; `e2e` and `integration` are skipped via `@pytest.mark.skipif` guards, not marker filtering).

`@pytest.mark.skipif` is used for conditional skips based on runtime availability:
```python
@pytest.mark.skipif(not _mlx_available(), reason="mlx_whisper not installed")
@pytest.mark.skipif(not FIXTURE.exists(), reason="fixture audio missing")
def test_real_mlx_round_trip(tmp_path): ...
```

`@pytest.mark.parametrize` used in `test_release_installer.py` for URL validation edge cases:
```python
@pytest.mark.parametrize("url", [None, ""])
def test_something_with_missing_url(url): ...
```

---

## CI Test Gates

### `ci.yml` (every push + PR)

Runs on `macos-latest`. Steps in order:

1. **Bash syntax check** — `bash -n` on all named shell scripts:
   - `install.sh`, `packaging/scripts/package.sh`, `packaging/scripts/checksums.sh`
   - `yulu/scripts/setup.sh`, `yulu/scripts/uninstall.sh`, `yulu/scripts/yulu`
   - `yulu/scripts/build_audio_daemon.sh`, `yulu/scripts/build_status_agent.sh`

2. **Python syntax check** — `python3 -m py_compile` on all `yulu/scripts/*.py`

3. **Python unit tests** — fresh venv + `python -m pip install pytest` + `python -m pytest -q`

4. **Doctor JSON smoke test** — runs `doctor.py --json` with `--source-root $PWD`, asserts `data['source_git']['is_repo'] is True` and `data['legacy_root_exists'] is False`

5. **Version sanity** — `test -s VERSION` + `version.py --check` + `version.py --json`

6. **Swift build** — `swiftc` for `audio_daemon.swift`, `window_scanner.swift`, `recorder_status.swift`, and `status_agent.swift` (with `-framework Cocoa -framework Carbon`)

7. **Skill manifest sanity** — Python inline script checks `skills/yulu/SKILL.md` has `name:` and `description:` in YAML frontmatter

8. **install.sh shebang + +x guard** — `test -x install.sh` + `head -1 install.sh | grep -q '^#!/usr/bin/env bash'`

### `ci.yml` yulu_ui job (parallel)

Runs on `macos-latest` with `working-directory: yulu/scripts/yulu_ui`:
1. `npm ci` (cached by `package-lock.json`)
2. `npm run typecheck` (tsc --noEmit)
3. `npm test` (vitest)
4. `npm run build`
5. Artifact verification: `test -s dist/server.js`, `test -s dist/web/index.html`, `test -d dist/web/assets`

### `release-publish.yml` (reusable, called on Release PR merge)

Re-runs full test suite at the release tag:
- Same bash syntax check, python syntax check, and `python -m pytest -q` as CI
- Additional: tag must match `v$(cat VERSION)`
- Packages `dist/yulu-macos-arm64-$TAG.zip` + checksums + `install.sh`

---

## What Is Tested

### Well-Covered Areas (unit tests)

- `state_store.py` — legacy normalization, v2 flat schema, recording started/stopped lifecycle (`test_state_store.py`)
- `queue_store.py` — append, claim, update, fcntl locking (`test_queue_store.py`)
- `agent_queue_worker.py` — summary processing, LLM shim, invalid JSON guard, missing transcript error path, HTML refresh (`test_agent_queue_worker.py`, `test_agent_queue_worker_prompts.py`, `test_agent_queue_worker_search_hook.py`)
- `doctor.py` — all check functions (`check_stt_daemon`, `check_search_index`, `check_yulu_ui`), `collect_report`, `main --json`, key contract enforcement (`test_doctor.py`)
- `recording_lock.py` — acquire/release, cross-process contention via sidecar subprocess (`test_recording_lock.py`)
- `version.py` — semver validation, format, install metadata, git info (`test_version.py`)
- `release_installer.py` — parse args, download/verify/extract, install flow (`test_release_installer.py`, `test_release_installer_integration.py`)
- `stt_daemon/protocol.py` — encode/decode round-trips for all message types (`test_stt_protocol.py`)
- `stt_daemon/runtime.py` — dispatch_transcribe, dual-track channel split, LEGACY_STEREO handling (`test_stt_daemon_channel_split_dispatch.py`)
- `stt_daemon/live_session.py` — TailState roundtrip, partial emission, stride resumption (`test_stt_live_session.py`, `test_live_session_stride.py`, `test_stt_dual_track_live_session.py`)
- `stt_daemon/wav_inspect.py` — WAV layout classification (`test_wav_inspect.py`, `test_wav_inspect_roundtrip.py`)
- `stt_daemon/vocab_cache.py` — cache load, custom words (`test_stt_vocab_cache.py`)
- `stt_daemon/control_server.py` — health/transcribe/cancel/subscribe via Unix socket (`test_stt_control_server.py`)
- `repair_permissions.py` — plan() output shape, screen capture URL (`test_repair_permissions.py`)
- `status_agent_config.py` — hotkey parsing, plist shape (`test_status_agent_config.py`, `test_status_agent_plist_template.py`)
- Voicemail subsystem — cli, recorder, repo, notify, prompts migration (`test_voicemail_*.py`)
- Search subsystem — indexer, reader, cli, upsert, sweep, IPC (`test_search_*.py`)
- Prompts subsystem — db, cli, cache, seed, voicemail migration (`test_prompts_*.py`)
- Vocab subsystem — db, cli, seed (`test_vocab_*.py`)
- Package release — zip structure, checksums, VERSION integrity (`test_package_release.py`)
- Spec acceptance — no shadow mlx-whisper imports outside stt_daemon, transcribe.py as thin client, daemon package structure (`test_spec_acceptance.py`)
- yulu_ui server — all tRPC routers via createCaller + vi.fn mocks
- yulu_ui web — component rendering via @testing-library/react + jsdom

### Integration / E2E (opt-in, not in default CI run)

- `test_e2e_stt_daemon.py` — real mlx-whisper round-trip; `pytestmark = pytest.mark.e2e`; skipped if `mlx_whisper` not importable or `tests/fixtures/audio/tiny_10s.wav` absent
- `test_audio_daemon_ipc_starvation.py` — spawns real audio daemon; `pytestmark = pytest.mark.integration`

### Not Tested / Coverage Gaps

- `audio_daemon.swift` — no unit tests; tested only by `swiftc` compilation in CI and manual TCC permission flows
- `status_agent.swift` — no unit tests; tested only by `swiftc` compilation
- `window_scanner.swift` — no unit tests; `swiftc` compilation only
- `meeting_daemon.py` — no dedicated test file; integration not exercised in CI
- `meeting_detector.py` — no dedicated test file
- `scheduler_daemon.py` — no dedicated test file (STT scheduler is tested separately)
- `check_meetings.py` — only tested when Google Calendar is configured; not in CI
- `notify.py` — no automated tests (requires macOS notification permissions)
- `webhook_server.py` — no test file
- `send_summary.py` — no dedicated test file
- `record_audio.py` — `test_record_audio_realtime.py` exists but tests only realtime-path logic
- `transcribe.py` — tested via `test_transcribe_*.py` but full pipeline requires LLM
- Full yulu_ui e2e (Playwright) — not wired into CI gate; `npm run e2e` exists but `e2e/` dir is present without CI enforcement

---

## Test Data / Fixtures

### Python

- `tests/fixtures/audio/` — audio fixture directory. `tiny_10s.wav` must be provided manually; not committed.
- No shared Python fixture factory (no `conftest.py` fixtures). Each test builds its own data via `tmp_path`.
- Fake SQLite DBs built inline using module-under-test's own `init_db` / `upsert_doc` helpers (see `test_search_index_section_reports_health` in `test_doctor.py`).

### TypeScript

- `yulu/scripts/yulu_ui/tests/fixtures/config.json` — committed config fixture for Node tests
- `tests/helpers/fakeUnixSocket.ts` — AF_UNIX server helper for simulating daemon IPC
- `tests/helpers/tmpDb.ts` — temp SQLite DB helper

---

*Testing analysis: 2026-05-29*
