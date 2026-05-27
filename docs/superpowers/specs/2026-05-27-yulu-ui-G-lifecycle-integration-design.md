# Phase G — Yulu UI Lifecycle Integration

**Date:** 2026-05-27
**Status:** Approved
**Scope:** Wire `yulu_ui` into the Yulu install / uninstall / diagnose / CI lifecycle so the 7777 web UI behaves like every other resident Yulu daemon.

---

## 1. Background

Phases A–F shipped a fully functional Node + React web UI at `yulu/scripts/yulu_ui/`, plus a LaunchAgent plist (`yulu/scripts/com.yulu.ui.plist`) that runs the server on port 7777. But the surrounding lifecycle scripts (`setup.sh`, `uninstall.sh`, `doctor.py`, `yulu` CLI) and CI workflow (`.github/workflows/ci.yml`) all predate `yulu_ui` and therefore do **not** install, diagnose, or test it.

Phase G closes that gap. After Phase G ships, `bash yulu/scripts/setup.sh` (and `--upgrade`) on a fresh machine produces a running UI at `http://127.0.0.1:7777/`; `yulu doctor` reports its health; `yulu logs ui` tails its stdout; `yulu uninstall` removes it cleanly; and CI catches breakages before merge.

## 2. Goals & Non-Goals

**Goals**

- `setup.sh` builds and installs `yulu_ui` as part of the standard install + upgrade flow, idempotently.
- `doctor.py` reports `yulu_ui` health (build artifacts, plist, port) in both human and `--json` modes.
- `yulu` CLI exposes `logs ui` and includes the UI in `status` output.
- `logTailer.ts` survives `logrotate`-style file rotation (rename + new inode) without losing the new file.
- CI runs `npm ci && npm run typecheck && npm test && npm run build` for `yulu_ui` on every PR.
- `uninstall.sh` kills the running server process and offers to remove its log file.
- Real-machine smoke confirms UI auto-starts on login after install.

**Non-goals**

- **No release tarball / packaging pipeline.** Installation continues to flow through `git clone` + `setup.sh`. A binary release is a future phase.
- **No Playwright E2E in CI.** Chromium download (~150 MB) + dev server boot + 8 serial tests adds ~3 min and noticeable flake potential. The vitest suite (278 tests) + typecheck + build already catches the regressions we care about for PR gating; E2E stays a local + pre-release tool.
- **No new plist features.** `com.yulu.ui.plist` already has the right shape (KeepAlive, ThrottleInterval, log paths). Phase G only wires its placeholders into `install_plist()`.

## 3. Architecture

Phase G reuses every existing mechanism — no new abstractions are introduced.

```
┌──────────────────────────────────────────────────────────────────┐
│ Phase G surfaces (changes only)                                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ setup.sh                                                         │
│  ├─ install_plist()      +__NODE_BIN__ sed substitution         │
│  └─ install_yulu_ui()    NEW: npm ci + build + install plist +  │
│                          launchctl load + curl /healthz verify   │
│                                                                  │
│ doctor.py                                                        │
│  └─ check_yulu_ui()      NEW: dist artifacts + launchctl state  │
│                          + curl 127.0.0.1:7777/healthz           │
│                                                                  │
│ yulu CLI                                                         │
│  ├─ cmd_logs             +"ui" → ~/.config/yulu/ui.log          │
│  └─ cmd_status           +UI block (curl healthz)               │
│                                                                  │
│ logTailer.ts                                                     │
│  └─ pollFile()           +inode-change detection → reopen fd    │
│                                                                  │
│ .github/workflows/ci.yml                                         │
│  └─ ui job               NEW: setup-node@v4 + npm ci/typecheck/ │
│                          test/build                              │
│                                                                  │
│ uninstall.sh                                                     │
│  └─ "leftover daemons"   +pkill yulu_ui/dist/server.js          │
│                                                                  │
│ docs/yulu_ui.md          NEW: 7777 + dev workflow + logs       │
│ README.md                +Web UI bullet                          │
└──────────────────────────────────────────────────────────────────┘
```

## 4. Components

### 4.1 `setup.sh` — install_yulu_ui

A new function in `yulu/scripts/setup.sh`, called from `main` between `install_launchagents` and `install_yulu_cli`.

**Responsibilities** (in order, idempotent):

1. Verify `node --version` returns >= 20. If `node` is missing, print actionable warning and **skip** UI install (`yulu_ui` is optional — the rest of Yulu still works).
2. Run `npm ci` in `$SCRIPT_DIR/yulu_ui/` if `node_modules/.package-lock-built-marker` is missing OR if `package-lock.json` is newer than the marker.
3. Run `npm run build` in `$SCRIPT_DIR/yulu_ui/`. Bail with a clear error if it exits non-zero.
4. Install `com.yulu.ui.plist` via the existing `install_plist()`, passing the resolved `NODE_BIN`.
5. `launchctl load` the plist.
6. Poll `http://127.0.0.1:7777/healthz` for up to 10 seconds; emit `ok` if it returns 200, `warn` otherwise.

**Why a marker file?** `npm ci` is a 5–30 s operation that completely wipes `node_modules`. On `--upgrade` runs with no dep changes we want to skip it. Marker is `node_modules/.yulu-built-from-<sha256-of-package-lock>` — invalidate when lockfile changes.

**Upgrade-mode behavior:** Same flow. `npm run build` and `launchctl load` are idempotent. `install_plist` calls `launchctl unload` first if the plist already exists, which picks up the freshly-built bundle.

### 4.2 `install_plist()` — add __NODE_BIN__ substitution

The existing `install_plist` in `setup.sh` does sed substitution on `__PYTHON__`, `__HOME__`, `__SCRIPT_DIR__`, `__PATH__`. Add `__NODE_BIN__` to that list. Resolve `NODE_BIN="$(command -v node || echo /usr/local/bin/node)"` once at the top of `setup.sh` alongside `PYTHON_BIN`.

This is a one-line change to a shared helper — once in place, future Node-based daemons get the same treatment for free.

### 4.3 `doctor.py` — check_yulu_ui

New helper added to `yulu/scripts/doctor.py`, called from `collect_report` and rendered in `print_human`.

**Signature:**

```python
def check_yulu_ui(
    script_dir: Path,
    config_dir: Path,
    timeout: float = 2.0,
) -> dict[str, Any]: ...
```

**Returns** (all keys always present so JSON consumers can rely on shape):

```python
{
    "dist_server_present": bool,         # yulu_ui/dist/server.js exists
    "dist_web_present": bool,            # yulu_ui/dist/web/index.html exists
    "plist_installed": bool,             # ~/Library/LaunchAgents/com.yulu.ui.plist
    "launchctl_loaded": bool,            # `launchctl list | grep com.yulu.ui` matches
    "port": 7777,                        # from plist env (hard-coded for now)
    "healthz_ok": bool,                  # GET /healthz returned 200
    "healthz_response": str | None,      # raw JSON body, truncated to 200 chars
    "log_path": str,                     # ~/.config/yulu/ui.log
    "log_present": bool,
    "log_size_bytes": int | None,
    "error": str | None,
}
```

**Failure modes:**

- Node bundle missing → `dist_*_present = False`, `healthz_ok = False`, `error = "build artifacts missing — run setup.sh --upgrade"`.
- Plist exists but server not loaded → `launchctl_loaded = False`, `error = "plist installed but service not loaded — run yulu start"`.
- Loaded but `/healthz` fails → `healthz_ok = False`, `error = "<HTTPError>"`. Most useful for "the server crashed in a loop" diagnosis.

**Human render** adds one block after the existing `search_index` block:

```
✓ yulu_ui: port=7777 dist=true loaded=true healthz=ok
  log: ~/.config/yulu/ui.log (12.3 KB)
```

`_overall_ok()` does **not** count `yulu_ui` as required — if `node` is missing, doctor still passes (UI is optional).

### 4.4 `yulu` CLI

**`yulu logs ui`** — extend `cmd_logs` so `ui` resolves to `~/.config/yulu/ui.log` (same path the plist writes to). Already works mechanically thanks to the existing `$CONFIG_DIR/${name}.log` lookup — just document `ui` in the help text and the dispatcher comment block.

**`yulu status`** — append a "Web UI" section after the recordings section:

```
ℹ Web UI:
  http://127.0.0.1:7777/healthz → {"status":"ok","uptime":1234.5}
```

If `curl` fails: `⚠ yulu_ui not reachable at 127.0.0.1:7777`.

### 4.5 `logTailer.ts` — inode-change rotation

**Current behavior** (`yulu/scripts/yulu_ui/src/logTailer.ts:36-71`): when `stat.size <= lastPos`, treats the file as truncated and resets position to `stat.size`. This handles `> file.log` truncation but **not** `logrotate`-style rotation where `mv file.log file.log.1 && touch file.log` swaps the inode under us — the open fd points to the renamed file, no events arrive on the new path.

**New behavior:**

1. Track `inodes: Map<string, number>` alongside `positions`.
2. On every `pollFile` call, `statSync(path).ino` and compare to stored ino.
3. If ino changed: `closeSync(oldFd)`, `openSync(path, "r")`, set new fd in `fds`, reset `positions.set(shortName, 0)`, and continue the read from offset 0 on the new file.
4. Same `pending` debounce keeps concurrent polls safe.

**Test plan:** new vitest case in `tests/logTailer.test.ts`:

```ts
it("survives file rotation (rename + recreate)", async () => {
  // write initial line, wait for publish
  // mv file.log file.log.1
  // touch file.log; append fresh line
  // assert fresh line published
});
```

### 4.6 CI — yulu_ui job

Add a second job to `.github/workflows/ci.yml` (after `build`):

```yaml
yulu_ui:
  name: yulu_ui (typecheck + vitest + build)
  runs-on: macos-latest
  timeout-minutes: 10
  defaults:
    run:
      working-directory: yulu/scripts/yulu_ui
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: 'npm'
        cache-dependency-path: yulu/scripts/yulu_ui/package-lock.json
    - run: npm ci
    - run: npm run typecheck
    - run: npm test
    - run: npm run build
    - name: Verify build artifacts
      run: |
        test -s dist/server.js
        test -s dist/web/index.html
        test -d dist/web/assets
```

**Why a separate job, not a step in `build`?** Node setup pollutes the matrix; isolating it keeps the existing Python/Swift job intact and lets the two run in parallel.

### 4.7 `uninstall.sh` — kill UI process

The existing `pkill -f` block at lines 161-163 only knows about audio_daemon, scheduler_daemon, meeting_detector. Add:

```bash
pkill -f "yulu_ui/dist/server.js" 2>/dev/null && ok "killed running yulu_ui server" || true
```

The plist itself is already removed by the generic `com.yulu.*.plist` glob at line 149. Only the running Node process needs explicit cleanup.

The `--purge-config` flag (already wired) covers `~/.config/yulu/`, which includes `ui.log` — no separate flag needed.

### 4.8 Documentation

**New file** `docs/yulu_ui.md`:

- One-paragraph intro: "Yulu UI is a local web UI at http://127.0.0.1:7777/ for browsing voicemails, meetings, settings, prompts, glossary, and daemon health."
- Pages list (link to Phase A–F)
- Dev workflow: `cd yulu/scripts/yulu_ui && npm install && npm run dev` (Vite :5173 + server :7777)
- Production: `npm run build` produces `dist/server.js` + `dist/web/`; LaunchAgent `com.yulu.ui` runs the server.
- Log location: `~/.config/yulu/ui.log` (also tail-able via `yulu logs ui`).
- Reset: `launchctl unload ~/Library/LaunchAgents/com.yulu.ui.plist && launchctl load ...`.

**README.md change:** add one line in the features list and one in the "What's running" section pointing at `docs/yulu_ui.md`.

## 5. Data Flow

```
fresh-install                         upgrade
──────────────                        ───────
setup.sh                              setup.sh --upgrade
 ↓                                     ↓
check_system (node? ≥20)              check_system (node? ≥20)
 ↓                                     ↓
... existing 8 daemons ...            ... existing 8 daemons (skip if loaded) ...
 ↓                                     ↓
install_yulu_ui                       install_yulu_ui
 ├─ npm ci (cold)                      ├─ npm ci (skipped via marker)
 ├─ npm run build                      ├─ npm run build (rebuild)
 ├─ install_plist com.yulu.ui          ├─ install_plist (re-substitute paths)
 ├─ launchctl load                     ├─ launchctl unload+load (picks up new build)
 └─ curl /healthz                      └─ curl /healthz
 ↓                                     ↓
install_yulu_cli                      install_yulu_cli
 ↓                                     ↓
run_tests                             run_tests
```

```
yulu doctor
 ↓
collect_report
 ├─ ... existing checks ...
 └─ check_yulu_ui(SCRIPT_DIR, CONFIG_DIR)
     ├─ fs.exists(dist/server.js, dist/web/index.html)
     ├─ fs.exists(~/Library/LaunchAgents/com.yulu.ui.plist)
     ├─ launchctl list | grep com.yulu.ui
     ├─ urllib.request.urlopen("http://127.0.0.1:7777/healthz", timeout=2)
     └─ fs.stat(~/.config/yulu/ui.log)
 ↓
print_human / json.dumps
```

## 6. Error Handling

| Situation | Behavior |
|---|---|
| `node` missing or `node -v` < 20 | `install_yulu_ui` warns and returns; doctor reports `dist_*=false healthz=false error="node missing"`; rest of yulu unaffected. |
| `npm ci` fails (network, registry) | `install_yulu_ui` errors loudly with `err()` and exits 1 — user must resolve before retrying. |
| `npm run build` fails (TS error) | Same — exit 1. |
| `launchctl load` fails | Warn (`warn "could not load com.yulu.ui"`) but continue; doctor will catch it. |
| `/healthz` doesn't respond in 10 s | Warn; doctor catches it. Service may still be booting — not fatal. |
| Log file rotated mid-tail (Phase G.4) | Detect inode change, reopen, resume publishing. No lost lines beyond the rotation boundary. |
| CI `npm ci` fails | Job fails; PR blocked. |

## 7. Testing Strategy

| Layer | What runs | Where |
|---|---|---|
| Unit (vitest) | `logTailer rotation` test (new, G.4) | `tests/logTailer.test.ts` |
| Integration (Bash) | `setup.sh` rerun produces idempotent result | Manual smoke on G.8 |
| Doctor | `doctor.py --json` smoke (existing CI step) covers shape | `.github/workflows/ci.yml` |
| CI (Node) | typecheck + vitest + build (G.5) | `.github/workflows/ci.yml` |
| E2E (Playwright) | Existing `npm run e2e` — **not in CI**, run manually pre-release | `e2e/critical.spec.ts` |
| Real machine (G.8) | Fresh install + reboot + UI auto-start verification | manual |

## 8. Open Questions

None. All decisions resolved during brainstorming:

- ✅ No release tarball (deferred — current source-based install works).
- ✅ No Playwright in CI (deferred — local tool + pre-release manual run).
- ✅ Node version floor: 20 (matches existing yulu_ui `package.json` engines).
- ✅ UI is optional (doctor doesn't fail without it).

## 9. Task Breakdown (preview for plan)

8 tasks following the Phase A–F pattern (TDD where applicable, atomic commit per task):

| # | Subject |
|---|---|
| G.1 | `install_plist()` accepts `__NODE_BIN__`; `install_yulu_ui()` builds + installs + verifies |
| G.2 | `doctor.py check_yulu_ui()` + JSON shape + human render |
| G.3 | `yulu logs ui` + `yulu status` UI block |
| G.4 | `logTailer.ts` inode-rotation handling + test |
| G.5 | CI yulu_ui job (typecheck + vitest + build) |
| G.6 | `uninstall.sh` pkill yulu_ui server |
| G.7 | `docs/yulu_ui.md` + README.md update |
| G.8 | Real-machine smoke + push + PR #24 finalize as "Phase A+B+C+D+E+F+G" |
