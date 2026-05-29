# Coding Conventions

**Analysis Date:** 2026-05-29

## Python Style

### File Header Pattern

Every substantive Python script begins with:
```python
#!/usr/bin/env python3
"""One-line module docstring.

Longer description. Critical invariants (e.g., "must never mutate runtime state")
go here so they are impossible to miss.
"""

from __future__ import annotations
```

`from __future__ import annotations` is used in all scripts that use `|`-union type hints or forward references. Examples: `doctor.py`, `agent_queue_worker.py`, `state_store.py`, `recording_lock.py`, `version.py`, `queue_store.py`, `transcribe.py`, `release_installer.py`. Scripts predating the pattern (e.g. `notify.py`, `meeting_daemon.py`) omit it.

### Naming Patterns

**Files:** `snake_case.py` for all Python modules. Sub-packages use `snake_case/` directories with `__init__.py`.

**Functions/Methods:** `snake_case`. Private helpers are prefixed `_` (e.g. `_run()`, `_log()`, `_now()`, `_atomic_write_json()`).

**Constants:** `UPPER_SNAKE_CASE` at module level (e.g. `CONFIG_DIR`, `STATE_PATH`, `QUEUE_PATH`, `VERSION_RE`, `SCRIPT_DIR`).

**Classes:** `PascalCase` (e.g. `RecordingLockHandle`, `RecordingBusy`, `JsonLogger`, `STTResult`).

**Type variables / Protocols:** `PascalCase` (e.g. `STTBackend` Protocol).

### Type Annotations

All public function signatures carry type annotations. Return types always annotated. `dict[str, Any]` is the standard container for JSON-shaped data; `list[str]` for argument lists. `Path | None` syntax used throughout (requires `from __future__ import annotations`).

Example from `doctor.py`:
```python
def _run(cmd: list[str], timeout: int = 5, cwd: Path | None = None) -> tuple[int, str, str]:
```

`dataclass` (and `dataclass(frozen=True)`) used for pure data containers:
- `recording_lock.py`: `RecordingLockHandle`
- `release_installer.py`: `ReleaseTarget(frozen=True)`, `ReleaseAsset(frozen=True)`, `InstallMetadata(frozen=True)`
- `stt_daemon/protocol.py`: all message types (`TranscribeRequest`, `STTResult`, etc.)
- `stt_daemon/runtime.py`: `STTResult`, `TranscribeDispatchResult`

### Module Entry Point Pattern

All scripts that are also CLI tools follow this idiom:
```python
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(...)
    args = parser.parse_args(argv)
    ...
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
```

`raise SystemExit(main())` (not `sys.exit(main())`) is the house style. `argv` parameter allows tests to call `main([...])` without `subprocess`.

## Error Handling

### Silent Fallback on I/O

JSON reads degrade gracefully rather than crashing:
```python
def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        _log(f"failed to read {path}: {exc}")
        return default
```
Pattern used consistently in `agent_queue_worker.py`, `queue_store.py`, `state_store.py`.

### Exception Catch Specificity

- Subprocess calls catch bare `Exception` (timeout + OSError variants) and return a sentinel `(999, "", str(exc))` tuple — see `_run()` in `doctor.py`.
- Lock contention raises a typed exception `RecordingBusy` with attached metadata (`recording_lock.py`).
- Doctor check functions (`check_stt_daemon`, `check_search_index`, `check_yulu_ui`) **never raise**; they always return a dict with an `"error"` key so JSON consumers can rely on shape.

### Atomic Writes

All persistent JSON state uses `tempfile.mkstemp` + `os.replace` to prevent partial writes:
```python
def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
```
Implemented in `state_store.py` and `queue_store.py`. All JSON output uses `ensure_ascii=False` for Unicode (Chinese characters appear verbatim).

## Logging / Notify Patterns

### Simple Script Logging (agent_queue_worker, queue_store)

Append-only log file via a `_log(message: str)` helper:
```python
LOG_PATH = Path.home() / ".config" / "yulu" / "agent_queue_worker.log"

def _log(message: str) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(f"{_now()} {message}\n")
    except OSError:
        pass
```
Uses ISO 8601 timestamp from `_now() -> str` (returns `datetime.now().isoformat(timespec="seconds")`).

### stt_daemon Structured JSON Logger

`stt_daemon/logging.py` exports `JsonLogger`, a structured JSON-lines logger:
```python
class JsonLogger:
    def _emit(self, level: str, event: str, **fields: Any) -> None:
        line = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "level": level,
            "event": event,
            **fields,
        }
        self.sink.write(json.dumps(line, ensure_ascii=False) + "\n")
        self.sink.flush()

    def info/warn/error(self, event: str, **fields: Any) -> None:
        ...
```
Sink defaults to `sys.stderr`; can be a file opened by `open_log_sink(path)`. All daemon log output goes through this logger.

### Swift Logging (status_agent.swift)

Simple timestamped append via FileHandle — no stdout dependency:
```swift
func log(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    let line = "[\(ts)] \(msg)\n"
    if !FileManager.default.fileExists(atPath: LOG_FILE) {
        FileManager.default.createFile(atPath: LOG_FILE, contents: nil)
    }
    if let fh = FileHandle(forWritingAtPath: LOG_FILE) {
        defer { try? fh.close() }
        _ = try? fh.seekToEnd()
        try? fh.write(contentsOf: Data(line.utf8))
    }
}
```

### macOS Notifications (notify.py)

`notify.py` provides `remind(title, message, subtitle)` and dialog prompts (`ask_record`, `ask_stop`). Prefers `terminal-notifier` (for `-sender` bundle-id icon); falls back to `osascript display notification`. Interactive dialogs always go through `osascript display dialog`.

## Config Schema Conventions

Config lives at `~/.config/yulu/config.json`. The canonical schema is `yulu/scripts/config.example.json`. Key conventions:
- Credentials are **never in config.json**: OAuth and API keys are referenced by env var name (e.g. `"app_id_env": "FEISHU_APP_ID"`, `"api_key_env": "NOTION_API_KEY"`).
- Paths use `~` prefix, expanded at runtime via `expanduser()`.
- Nested `"note"` strings within JSON objects serve as inline documentation.
- `"enabled": false` disables optional integrations without removing config.
- `"command": null` in `llm` section means "use agent-queue mode" (not a real null command).

Config is mutated in-place by setup/configure scripts using a read-modify-write pattern:
```python
cfg = json.loads(cfg_path.read_text())
cfg.setdefault("transcription", {})["post_recording_mode"] = mode
cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
```

## Versioning Conventions

`VERSION` file at repo root is the **single source of truth**. It contains a bare semver string (e.g. `0.5.1`).

`yulu/scripts/version.py` exposes:
- `read_version(path) -> str` — reads VERSION, returns `"0.0.0+unknown"` on missing file.
- `validate_version(version) -> bool` — matches `^\d+\.\d+\.\d+(?:-...)(?:\+...)?$`.
- `version_info(repo_dir, version_path) -> dict` — assembles full metadata including git commit, dirty flag, tag, and `.yulu-install.json` install source.
- `format_version(info, short=False) -> str` — human string like `"Yulu 0.5.1 (abc1234, release v0.5.1)"`.

Release lifecycle: Conventional Commits on main → `release-please.yml` opens a Release PR that updates `VERSION` and `CHANGELOG.md` → merging the PR triggers `release-publish.yml` → package zip + checksums posted to GitHub Release.

CI gate: `python3 yulu/scripts/version.py --check` fails if `VERSION` is not valid semver. Tag must equal `v$(cat VERSION)` before publishing (enforced in `release-publish.yml`).

`.yulu-install.json` written at install time with `{"schema":1,"source":"release","version":"vX.Y.Z",...}` or `{"source":"dev","branch":"..."}` — read back by `version_info()` for support diagnostics.

## launchd Plist Conventions

Source plists live in `yulu/scripts/com.yulu.*.plist`. They contain placeholder tokens substituted at install time by `setup.sh`:

| Placeholder | Substituted Value |
|-------------|-------------------|
| `__SCRIPT_DIR__` | Absolute path to `yulu/scripts/` |
| `__HOME__` | `$HOME` |
| `__PYTHON__` | Path to `python3` |
| `__NODE_BIN__` | Path to `node` |
| `__PATH__` | `~/.local/bin:~/.nvm/.../bin:/opt/homebrew/bin:...` |

Substitution done by `sed -i ''` in `setup.sh`'s `install_plist()` helper.

Required keys in every plist: `Label`, `ProgramArguments`, `RunAtLoad`, `KeepAlive`, `StandardOutPath`, `StandardErrorPath`. The label always matches the filename (e.g. `com.yulu.audiodaemon`).

App-based daemons (audio_daemon, status_agent) use `/usr/bin/open -W` pattern:
```xml
<key>ProgramArguments</key>
<array>
    <string>/usr/bin/open</string>
    <string>-W</string>
    <string>__SCRIPT_DIR__/Yulu.app</string>
</array>
```

Python daemons use `__PYTHON__` directly. Logs always go to `__HOME__/.config/yulu/<daemon-name>.log`.

Plist shape is validated in CI and tests (`tests/test_status_agent_plist_template.py`).

## doctor.py Health-Check Conventions

`doctor.py` is the central health-check tool. All checks follow these contracts:

**1. Check functions always return a dict, never raise.**
```python
def check_stt_daemon(config_dir: Path) -> dict[str, Any]:
    report: dict[str, Any] = {
        "socket_path": str(socket_path),
        "socket_present": socket_path.exists(),
        ...
        "error": None,
    }
    # ... checks ...
    return report  # error key set on failure, never raised
```

**2. Every check function declares its full key contract in the initializer.** Keys are always present in the returned dict so JSON consumers can rely on shape without defensive `get()`. Tests like `test_check_yulu_ui_returns_required_keys_when_everything_missing` enforce this explicitly.

**3. The `collect_report()` function assembles all checks** and returns a single top-level dict: `source_git`, `runtime_exists`, `legacy_root_exists`, `config_exists`, `socket`, `stt_daemon`, `search_index`, `yulu_ui`, `checks`, `processes`.

**4. `_overall_ok(report) -> bool`** defines the machine-readable pass/fail: requires python3 present, no legacy processes, source is a git repo.

**5. Dual output modes:** `--json` for machine consumers (CI, agent); default human-readable with `✓`/`!` prefix characters via `print_human()`.

**6. `main()` accepts `argv: list[str] | None`** so it is test-callable without subprocess:
```python
code = doctor.main(["--json", "--source-root", str(ROOT), ...])
data = json.loads(capsys.readouterr().out)
```

**7. New checks added by implementing a `check_<name>(config_dir: Path) -> dict[str, Any]` function and wiring into `collect_report()`'s return dict and `print_human()`.**

## Shell Script Conventions

All bash scripts begin with `#!/usr/bin/env bash` shebang. Lint gate: `bash -n <file>` run in CI for every named script.

`set -e` is used in `setup.sh` (not `set -euo pipefail`). CI workflow steps use the stricter `set -euo pipefail`.

Color/output helpers in `setup.sh`:
```bash
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}ℹ️${NC} $1"; }
ok()    { echo -e "${GREEN}✅${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠️${NC} $1"; }
err()   { echo -e "${RED}❌${NC} $1"; }
header(){ ... }
```

Python inline scripts inside bash use heredoc `<<'PY' ... PY` (single-quoted to prevent variable expansion) or `<<PY ... PY` (double-quoted to allow shell variable interpolation). Example of inline python for config mutation:
```bash
"$PYTHON_BIN" - <<PY
import json
from pathlib import Path
cfg_path = Path("$CONFIG_DIR/config.json")
...
PY
```

Idempotency: `setup.sh --upgrade` skips steps already done. Upgrade detection checks file existence, service state via `launchctl list | grep`, and binary responses from sockets.

`install.sh` must be executable (`chmod +x`) and starts with `#!/usr/bin/env bash`. CI enforces this with `test -x install.sh && head -1 install.sh | grep -q '^#!/usr/bin/env bash'`.

## Swift Conventions

Swift files are single-file compilable with `swiftc`. No Xcode project / Package.swift.

Compilation patterns:
```bash
swiftc -o audio_daemon audio_daemon.swift \
    -framework Cocoa -framework ScreenCaptureKit \
    -framework AVFoundation -framework CoreMedia -framework CoreAudio
```

Global `let` constants for paths:
```swift
let HOME = FileManager.default.homeDirectoryForCurrentUser
let CONFIG_DIR = HOME.appendingPathComponent(".config/yulu")
let SOCKET_PATH = CONFIG_DIR.appendingPathComponent("audio_daemon.sock")
```

JSON IPC uses `JSONSerialization` not `Codable`. Error-path uses `guard let ... else { return }` pattern.

Logging appends to a file via `FileHandle.seekToEnd` (never `FileManager.createFile` on every log call — that truncates). See `status_agent.swift`'s `log()` function which guards with `fileExists` before `createFile`.

## Import Organization

Python imports follow PEP 8: stdlib first, then intra-project:
```python
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from queue_store import claim_summary_request, update_event
```

No third-party packages imported at module level in `yulu/scripts/*.py` — all heavy imports (`mlx_whisper`, `sqlite3`) are lazy (inside functions) so scripts remain importable in minimal CI environments.

## Comments

Inline comments explain **why**, not what. Non-obvious macOS behavior is always explained:
```python
# Set by SIGHUP; checked between events in process_queue_once.
_RELOAD_PROMPTS = False
```

Chinese comments appear in setup.sh and audio_daemon.swift for user-facing messages (the project targets Chinese-speaking users). English is used for code-level comments.

---

*Convention analysis: 2026-05-29*
