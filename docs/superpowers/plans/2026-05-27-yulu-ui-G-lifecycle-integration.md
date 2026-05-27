# Phase G — Yulu UI Lifecycle Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `yulu_ui` into the Yulu install / uninstall / doctor / yulu-CLI / CI lifecycle so the 7777 web UI behaves like every other resident Yulu daemon.

**Architecture:** Reuse existing mechanisms — `install_plist()` sed substitution for the new plist, `collect_report` dict-extension for doctor, `cmd_logs`/`cmd_status` dispatch for the CLI, and a parallel GitHub Actions job for Node-side CI. The only genuinely new code is an inode-change branch in `logTailer.ts` and the `check_yulu_ui()` helper in `doctor.py`.

**Tech Stack:** Bash (setup.sh / uninstall.sh / yulu CLI), Python 3 (doctor.py + pytest), TypeScript 5 / vitest (logTailer), GitHub Actions YAML (CI).

**Spec reference:** `docs/superpowers/specs/2026-05-27-yulu-ui-G-lifecycle-integration-design.md`

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `yulu/scripts/setup.sh` | Modify | Add `NODE_BIN` resolution; extend `install_plist()` with `__NODE_BIN__`; add `install_yulu_ui()` function; call it from `main` |
| `yulu/scripts/doctor.py` | Modify | Add `check_yulu_ui()`; wire into `collect_report` + `print_human` |
| `tests/test_doctor.py` | Modify | Add 4 tests for `check_yulu_ui` shape / failure modes |
| `yulu/scripts/yulu` | Modify | Document `ui` in `cmd_logs` help; add Web UI block to `cmd_status` |
| `yulu/scripts/yulu_ui/src/logTailer.ts` | Modify | Track inode per file; reopen fd on rotation |
| `yulu/scripts/yulu_ui/tests/logTailer.test.ts` | Modify | Add inode-rotation test |
| `.github/workflows/ci.yml` | Modify | Add `yulu_ui` job (setup-node 20, npm ci, typecheck, test, build) |
| `yulu/scripts/uninstall.sh` | Modify | `pkill -f yulu_ui/dist/server.js` |
| `docs/yulu_ui.md` | Create | One-page operator guide: ports, dev workflow, logs |
| `README.md` | Modify | One bullet pointing at the web UI |

---

## Task 1 (G.1): setup.sh — install_yulu_ui

**Files:**
- Modify: `yulu/scripts/setup.sh`

**Goal:** Bash function that builds `yulu_ui` and installs its LaunchAgent during `setup.sh` and `setup.sh --upgrade`.

### Background context for the implementer

`yulu/scripts/setup.sh` is a 1200-line interactive bash installer. Its `main` (lines 1212–1228) calls a sequence of section functions: `check_system`, `install_deps`, `setup_audio`, …, `install_launchagents`, `install_yulu_cli`, `install_agent_skill`, `run_tests`, `show_summary`. We need to insert one new function (`install_yulu_ui`) between `install_launchagents` and `install_yulu_cli`.

The existing `install_plist()` helper (defined inside `install_launchagents`, lines 828–856) takes a plist source path + destination filename, copies it into `~/Library/LaunchAgents/`, then does `sed -i ''` substitution on `__PYTHON__`, `__HOME__`, `__SCRIPT_DIR__`, `__PATH__`. The `com.yulu.ui.plist` file (already on disk at `yulu/scripts/com.yulu.ui.plist`) uses a fifth placeholder `__NODE_BIN__` that the current `install_plist` does NOT handle — that's the bug we fix here.

The plist is:
```xml
<key>ProgramArguments</key>
<array>
    <string>__NODE_BIN__</string>
    <string>__SCRIPT_DIR__/yulu_ui/dist/server.js</string>
</array>
```

`NODE_BIN` should be resolved once at the top of `setup.sh` alongside `PYTHON_BIN` (line 31). Fall back to `/usr/local/bin/node` only as a last resort so the placeholder isn't left literal.

- [ ] **Step 1: Add NODE_BIN resolution near PYTHON_BIN**

Edit `yulu/scripts/setup.sh`. Find:

```bash
PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"
```

Replace with:

```bash
PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
```

- [ ] **Step 2: Add __NODE_BIN__ to install_plist sed pipeline**

Find the `sed -i ''` block inside `install_plist` (around line 842–847):

```bash
sed -i '' \
    -e "s|__PYTHON__|$PYTHON_BIN|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" \
    -e "s|__PATH__|$launch_path|g" \
    "$dest" 2>/dev/null || true
```

Replace with:

```bash
sed -i '' \
    -e "s|__PYTHON__|$PYTHON_BIN|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" \
    -e "s|__PATH__|$launch_path|g" \
    "$dest" 2>/dev/null || true
```

- [ ] **Step 3: Add install_yulu_ui() function**

Insert this function in `yulu/scripts/setup.sh` immediately **before** the `install_yulu_cli()` function (the existing function starts at line 1009 with `install_yulu_cli() {`):

```bash
# ─── Step 7.4: Install yulu_ui (web UI on :7777) ─────

install_yulu_ui() {
    header "构建 + 安装 yulu_ui (本地 Web UI)"

    local ui_dir="$SCRIPT_DIR/yulu_ui"
    if [[ ! -d "$ui_dir" ]]; then
        warn "yulu_ui/ 不存在于 $ui_dir，跳过"
        return
    fi

    if ! command -v node &>/dev/null; then
        warn "未检测到 node；yulu_ui 是可选组件，跳过安装。"
        warn "  以后想装：brew install node && bash $0 --upgrade"
        return
    fi

    local node_major
    node_major="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ -z "$node_major" || "$node_major" -lt 20 ]]; then
        warn "node 版本过低（$(node -v 2>/dev/null || echo 'unknown')），yulu_ui 需要 Node 20+。跳过。"
        return
    fi
    ok "Node $(node -v) 满足 yulu_ui 要求"

    # Idempotency marker: skip npm ci when package-lock.json hasn't changed.
    local lock="$ui_dir/package-lock.json"
    local marker="$ui_dir/node_modules/.yulu-built-from"
    local lock_sha=""
    if [[ -f "$lock" ]]; then
        lock_sha="$(shasum -a 256 "$lock" | cut -d' ' -f1)"
    fi
    if [[ -f "$marker" ]] && [[ "$(cat "$marker" 2>/dev/null)" == "$lock_sha" ]]; then
        info "npm ci 已是最新（lockfile sha 未变），跳过依赖安装"
    else
        info "运行 npm ci (这一步可能需要 30-60 秒)..."
        ( cd "$ui_dir" && npm ci ) || { err "npm ci 失败"; exit 1; }
        echo -n "$lock_sha" > "$marker"
        ok "依赖已安装"
    fi

    info "运行 npm run build..."
    ( cd "$ui_dir" && npm run build ) || { err "npm run build 失败"; exit 1; }
    ok "yulu_ui dist/ 已生成"

    if [[ ! -s "$ui_dir/dist/server.js" || ! -s "$ui_dir/dist/web/index.html" ]]; then
        err "build 产物不完整：dist/server.js 或 dist/web/index.html 缺失"
        exit 1
    fi

    # Install + load LaunchAgent. install_plist is defined inside install_launchagents;
    # we duplicate the minimal sed+copy here so we don't rely on shell-function scoping.
    local plist_src="$SCRIPT_DIR/com.yulu.ui.plist"
    local plist_dest="$LAUNCH_AGENTS_DIR/com.yulu.ui.plist"
    if [[ ! -f "$plist_src" ]]; then
        warn "com.yulu.ui.plist 不存在于 $plist_src，跳过 launchd 安装"
        return
    fi

    if [[ -f "$plist_dest" ]]; then
        launchctl unload "$plist_dest" 2>/dev/null || true
    fi
    cp "$plist_src" "$plist_dest"
    sed -i '' \
        -e "s|__NODE_BIN__|$NODE_BIN|g" \
        -e "s|__HOME__|$HOME|g" \
        -e "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" \
        "$plist_dest"
    launchctl load "$plist_dest" 2>/dev/null || warn "launchctl load com.yulu.ui 失败"
    ok "com.yulu.ui.plist 已安装并 load"

    # Verify /healthz within 10s
    info "等待 yulu_ui 启动 (最多 10 秒)..."
    local i=0
    local healthy=false
    while [[ $i -lt 20 ]]; do
        if curl -s --max-time 1 "http://127.0.0.1:7777/healthz" | grep -q '"status":"ok"'; then
            healthy=true
            break
        fi
        sleep 0.5
        i=$((i + 1))
    done
    if [[ "$healthy" == true ]]; then
        ok "yulu_ui 健康检查通过：http://127.0.0.1:7777/"
    else
        warn "yulu_ui 未在 10 秒内响应 /healthz；查看 ~/.config/yulu/ui.log"
    fi
}
```

- [ ] **Step 4: Wire install_yulu_ui into main**

Find the `main` block at the end of `setup.sh` (around line 1212-1228). Find:

```bash
install_launchagents
install_yulu_cli
install_agent_skill
```

Replace with:

```bash
install_launchagents
install_yulu_ui
install_yulu_cli
install_agent_skill
```

- [ ] **Step 5: Bash syntax check**

Run: `bash -n yulu/scripts/setup.sh`
Expected: exit 0, no output.

- [ ] **Step 6: Dry-run smoke (no real install — just verify the helper would run)**

Run:
```bash
bash -c '
set -e
source /dev/stdin <<<"$(sed -n "/^install_yulu_ui/,/^}$/p" yulu/scripts/setup.sh)
" || true
type install_yulu_ui
'
```
Expected: `install_yulu_ui is a function`.

- [ ] **Step 7: Commit**

```bash
git add yulu/scripts/setup.sh
git commit -m "feat(setup): build + install yulu_ui (Node 20+ guard, idempotent npm ci, healthz verify)

setup.sh now resolves NODE_BIN alongside PYTHON_BIN, extends install_plist
with __NODE_BIN__ substitution, and adds install_yulu_ui that runs npm ci
(skipped when lockfile sha matches stored marker), npm run build, installs
com.yulu.ui.plist, and polls /healthz for up to 10s. UI is optional —
missing/old node skips with a warning."
```

---

## Task 2 (G.2): doctor.py — check_yulu_ui

**Files:**
- Modify: `yulu/scripts/doctor.py`
- Modify: `tests/test_doctor.py`

**Goal:** `yulu doctor` reports yulu_ui health (build artifacts, plist, port :7777, log) in both human and `--json` output. UI failures do **not** flip `_overall_ok` to false — UI is optional.

### Background context for the implementer

`yulu/scripts/doctor.py` is a 330-line read-only health-check tool. The pattern is: top-level helpers like `_check_command()`, `_socket_status()`, `check_stt_daemon()`, `check_search_index()` each return a dict with a known shape. `collect_report()` assembles them into one big dict. `print_human()` renders. `main()` is the CLI.

Tests live in `tests/test_doctor.py`, loaded via `importlib.util.spec_from_file_location("doctor", DOCTOR)` because `doctor.py` is a script not a package. Each test reaches into `doctor.collect_report(...)` and inspects the dict shape.

For Phase G, follow exactly the `check_stt_daemon()` / `check_search_index()` template.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_doctor.py`:

```python
def test_check_yulu_ui_returns_required_keys_when_everything_missing(tmp_path):
    """check_yulu_ui must always return a dict with the contract keys, even
    when nothing is installed. This lets the JSON consumer rely on the shape."""
    doctor = load_doctor()
    script_dir = tmp_path / "scripts"   # contains no yulu_ui/
    config_dir = tmp_path / "config"    # contains no ui.log
    report = doctor.check_yulu_ui(script_dir, config_dir)
    for key in (
        "dist_server_present", "dist_web_present",
        "plist_installed", "launchctl_loaded",
        "port", "healthz_ok", "healthz_response",
        "log_path", "log_present", "log_size_bytes",
        "error",
    ):
        assert key in report, f"missing key {key} in {report.keys()}"
    assert report["dist_server_present"] is False
    assert report["dist_web_present"] is False
    assert report["healthz_ok"] is False
    assert report["log_present"] is False
    assert report["port"] == 7777


def test_check_yulu_ui_detects_built_artifacts(tmp_path):
    doctor = load_doctor()
    ui = tmp_path / "yulu_ui"
    (ui / "dist" / "web" / "assets").mkdir(parents=True)
    (ui / "dist" / "server.js").write_text("// built\n")
    (ui / "dist" / "web" / "index.html").write_text("<!doctype html>\n")
    report = doctor.check_yulu_ui(tmp_path, tmp_path / "config")
    assert report["dist_server_present"] is True
    assert report["dist_web_present"] is True


def test_check_yulu_ui_reads_log_size(tmp_path):
    doctor = load_doctor()
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    log = config_dir / "ui.log"
    log.write_text("line one\nline two\n")
    report = doctor.check_yulu_ui(tmp_path, config_dir)
    assert report["log_present"] is True
    assert report["log_size_bytes"] == len("line one\nline two\n")


def test_collect_report_includes_yulu_ui(tmp_path):
    """collect_report wires check_yulu_ui in. The key 'yulu_ui' must appear in the
    final report so doctor --json consumers (CI smoke) can branch on it."""
    doctor = load_doctor()
    report = doctor.collect_report(
        source_root=ROOT,
        runtime_root=ROOT,
        legacy_root=ROOT / "missing-legacy",
        config_dir=tmp_path,
    )
    assert "yulu_ui" in report
    assert "dist_server_present" in report["yulu_ui"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_doctor.py -v -k yulu_ui`
Expected: 4 FAIL (AttributeError: `module 'doctor' has no attribute 'check_yulu_ui'`, plus the `'yulu_ui'` key missing from collect_report).

- [ ] **Step 3: Add check_yulu_ui to doctor.py**

In `yulu/scripts/doctor.py`, insert this function immediately **after** `check_search_index` (which ends around line 186 with `return report`):

```python
def check_yulu_ui(
    script_dir: Path,
    config_dir: Path,
    timeout: float = 2.0,
) -> dict[str, Any]:
    """Phase G health check: verify yulu_ui dist artifacts, LaunchAgent, and
    /healthz. UI is optional — missing artifacts are not a doctor-level failure.
    Always returns a dict with the same keys so JSON consumers can rely on it."""
    script_dir = Path(script_dir).expanduser()
    config_dir = Path(config_dir).expanduser()

    ui_dir = script_dir / "yulu_ui"
    dist_server = ui_dir / "dist" / "server.js"
    dist_index = ui_dir / "dist" / "web" / "index.html"
    plist_path = Path.home() / "Library" / "LaunchAgents" / "com.yulu.ui.plist"
    log_path = config_dir / "ui.log"

    report: dict[str, Any] = {
        "dist_server_present": dist_server.is_file() and dist_server.stat().st_size > 0,
        "dist_web_present": dist_index.is_file() and dist_index.stat().st_size > 0,
        "plist_installed": plist_path.is_file(),
        "launchctl_loaded": False,
        "port": 7777,
        "healthz_ok": False,
        "healthz_response": None,
        "log_path": str(log_path),
        "log_present": log_path.is_file(),
        "log_size_bytes": log_path.stat().st_size if log_path.is_file() else None,
        "error": None,
    }

    # launchctl loaded?
    code, out, _ = _run(["launchctl", "list"], timeout=3)
    if code == 0 and any("com.yulu.ui" in line for line in out.splitlines()):
        report["launchctl_loaded"] = True

    # /healthz
    try:
        import urllib.request
        with urllib.request.urlopen(
            f"http://127.0.0.1:{report['port']}/healthz", timeout=timeout
        ) as resp:
            body = resp.read().decode("utf-8", errors="replace")[:200]
            report["healthz_response"] = body
            if resp.status == 200 and '"status":"ok"' in body:
                report["healthz_ok"] = True
    except Exception as exc:
        report["error"] = f"healthz fetch failed: {exc}"

    # Categorize the most actionable single error message
    if not report["dist_server_present"] or not report["dist_web_present"]:
        report["error"] = "build artifacts missing — run setup.sh --upgrade"
    elif report["plist_installed"] and not report["launchctl_loaded"]:
        report["error"] = "plist installed but service not loaded — run yulu start"

    return report
```

- [ ] **Step 4: Wire check_yulu_ui into collect_report**

Find the `return` block in `collect_report` (around lines 223–242 of `doctor.py`). Add a new entry between `search_index` and `processes`:

Existing:
```python
        "stt_daemon": check_stt_daemon(config_dir),
        "search_index": check_search_index(config_dir),
        "processes": processes,
```

Replace with:
```python
        "stt_daemon": check_stt_daemon(config_dir),
        "search_index": check_search_index(config_dir),
        "yulu_ui": check_yulu_ui(source_root / "yulu" / "scripts", config_dir),
        "processes": processes,
```

- [ ] **Step 5: Render yulu_ui in print_human**

In `print_human()`, find the `search_index` rendering block (around lines 293–303):

```python
    si = report.get("search_index", {})
    if si:
        print(f"{mark(si.get('ok', False))} search index: {si.get('db_path')} present={si.get('present')}")
        if si.get("ok"):
            per_kind = si.get("per_kind", {}) or {}
            kinds_str = " ".join(f"{k}={v}" for k, v in sorted(per_kind.items())) or "(empty)"
            print(f"  total_docs={si.get('total_docs')} schema=v{si.get('schema_version')} "
                  f"last_sweep={si.get('last_full_sweep_at') or 'never'}")
            print(f"  per_kind: {kinds_str}")
        elif si.get("error"):
            print(f"  error: {si['error']}")
```

Immediately after that block (before `for check in report["checks"]:`), add:

```python
    ui = report.get("yulu_ui", {})
    if ui:
        ok_state = ui.get("healthz_ok", False) and ui.get("dist_server_present", False)
        size_kb = (ui.get("log_size_bytes") or 0) / 1024
        print(f"{mark(ok_state)} yulu_ui: port={ui.get('port')} "
              f"dist={ui.get('dist_server_present')} loaded={ui.get('launchctl_loaded')} "
              f"healthz={'ok' if ui.get('healthz_ok') else 'fail'}")
        if ui.get("log_present"):
            print(f"  log: {ui['log_path']} ({size_kb:.1f} KB)")
        if ui.get("error"):
            print(f"  error: {ui['error']}")
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_doctor.py -v -k yulu_ui`
Expected: 4 PASS.

- [ ] **Step 7: Smoke-test the JSON output**

Run:
```bash
python3 yulu/scripts/doctor.py --json \
    --source-root "$PWD" \
    --runtime-root "$PWD" \
    --legacy-root "$PWD/.missing-legacy" \
    --config-dir "$PWD/.missing-config" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "yulu_ui" in d; assert "dist_server_present" in d["yulu_ui"]; print("ok")'
```
Expected: `ok`.

- [ ] **Step 8: Commit**

```bash
git add yulu/scripts/doctor.py tests/test_doctor.py
git commit -m "feat(doctor): check_yulu_ui — dist artifacts + plist + /healthz + log

New check_yulu_ui() returns a stable-shape dict reporting dist/server.js,
dist/web/index.html, com.yulu.ui.plist presence, launchctl-loaded state,
GET 127.0.0.1:7777/healthz, and ui.log size. Wired into collect_report and
print_human alongside search_index. UI is optional (does not flip _overall_ok)."
```

---

## Task 3 (G.3): yulu CLI — logs ui + status block

**Files:**
- Modify: `yulu/scripts/yulu`

**Goal:** `yulu logs ui` tails `~/.config/yulu/ui.log`; `yulu status` appends a Web UI section.

### Background context

`yulu` is a bash dispatcher (~325 lines). `cmd_logs` (line 217) already does generic name → `$CONFIG_DIR/${name}.log` lookup — `ui.log` already works mechanically. We just need to mention `ui` in the help text. `cmd_status` (line 172) prints LaunchAgents + audio socket + recent recordings; we append a Web UI block at the end.

- [ ] **Step 1: Update usage text to mention `ui` log**

Find the usage block (line 53-88). Inside the `Commands:` table, find the `logs` line:

```
  logs [daemon]    Tail logs. Daemon = audio_daemon (default), scheduler, detector, calendar, agentqueue, realtime_transcribe
```

Replace with:

```
  logs [daemon]    Tail logs. Daemon = audio_daemon (default), scheduler, detector, calendar, agentqueue, realtime_transcribe, ui
```

- [ ] **Step 2: Add Web UI block at the end of cmd_status**

Find the end of `cmd_status()` (around line 211 — the `fi` closing the recent-recordings block). Immediately before the closing `}`, add:

```bash
    echo
    info "Web UI:"
    local ui_resp
    ui_resp=$(curl -s --max-time 2 "http://127.0.0.1:7777/healthz" 2>/dev/null || true)
    if [[ -n "$ui_resp" ]] && echo "$ui_resp" | grep -q '"status":"ok"'; then
        ok "http://127.0.0.1:7777/  ($ui_resp)"
    else
        warn "yulu_ui not reachable at 127.0.0.1:7777 (try: yulu start)"
    fi
```

- [ ] **Step 3: Bash syntax check**

Run: `bash -n yulu/scripts/yulu`
Expected: exit 0.

- [ ] **Step 4: Smoke-test `logs ui` lookup**

Create a fake log file and assert `cmd_logs` would resolve it:

```bash
# Ensure ui.log dispatch lands on the expected path. We don't actually tail;
# just verify the path the dispatcher would compute by running with HOME=/tmp.
HOME=/tmp/yulu_test_$$ mkdir -p "/tmp/yulu_test_$$/.config/yulu"
echo "hello" > "/tmp/yulu_test_$$/.config/yulu/ui.log"
HOME=/tmp/yulu_test_$$ timeout 1 bash yulu/scripts/yulu logs ui 2>&1 | grep -q "tail -f /tmp/yulu_test_$$/.config/yulu/ui.log" \
    && echo "ok" || echo "FAIL"
rm -rf "/tmp/yulu_test_$$"
```
Expected: `ok`.

- [ ] **Step 5: Smoke-test `yulu status` doesn't crash when UI is down**

Run: `bash yulu/scripts/yulu status 2>&1 | grep -E "(Web UI|reachable)" >/dev/null && echo ok || echo FAIL`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu
git commit -m "feat(yulu cli): logs ui (tail ui.log) + status block (curl healthz)

cmd_logs help now lists 'ui' as a known daemon; cmd_status appends a Web UI
block that curls 127.0.0.1:7777/healthz and renders ok / warn. Mechanism for
ui.log dispatch was already correct via generic \$CONFIG_DIR/\${name}.log
lookup — this just documents it."
```

---

## Task 4 (G.4): logTailer.ts — inode rotation

**Files:**
- Modify: `yulu/scripts/yulu_ui/src/logTailer.ts`
- Modify: `yulu/scripts/yulu_ui/tests/logTailer.test.ts`

**Goal:** `logTailer` survives `mv old.log old.log.1 && touch old.log` (logrotate-style rotation) by detecting inode change and reopening the file descriptor.

### Background context

Current `pollFile` (lines 36–71) handles **truncation** (`> file.log`) — when `stat.size <= lastPos`, position resets to `stat.size` and we skip. But if the file is **rotated** (renamed and recreated), the old fd still points to the renamed inode; the new file at the same path has a new inode and our fd never sees it. Add an `inodes: Map<string, number>` and a re-open branch.

The existing test file follows vitest 1.x conventions with `mkdtempSync`/`rmSync`/`appendFileSync` and `vi.waitFor(() => …)`. There are already 6 passing tests — we add a 7th.

- [ ] **Step 1: Write the failing test**

Append to `yulu/scripts/yulu_ui/tests/logTailer.test.ts` (immediately before the final `});` that closes `describe`):

```ts
  it("survives logrotate-style rotation (mv + new inode at same path)", async () => {
    const renameSync = (await import("node:fs")).renameSync;
    const logPath = join(root, "audiodaemon.log");
    writeFileSync(logPath, "");
    tailer = startLogTailer({ configDir: root, pubsub });
    await waitMs(50);

    // First write — verify the tailer is alive.
    appendFileSync(logPath, "before rotation\n");
    await vi.waitFor(() => expect(events.some((e) => e.line === "before rotation")).toBe(true), { timeout: 1000 });

    // Rotate: rename, recreate fresh file at the same path with new inode.
    renameSync(logPath, join(root, "audiodaemon.log.1"));
    writeFileSync(logPath, "");           // new inode at the original path
    await waitMs(100);
    appendFileSync(logPath, "after rotation\n");

    // The tailer should publish the post-rotation line — meaning it noticed
    // the inode change, closed the old fd, and reopened the new file.
    await vi.waitFor(
      () => expect(events.some((e) => e.line === "after rotation")).toBe(true),
      { timeout: 2000 },
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd yulu/scripts/yulu_ui && npm test -- logTailer`
Expected: 6 pass, 1 FAIL on `survives logrotate-style rotation` (timeout — the post-rotation line never arrives).

- [ ] **Step 3: Add inode tracking + re-open branch**

Replace `yulu/scripts/yulu_ui/src/logTailer.ts` with:

```typescript
import { watch, type FSWatcher, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { PubSub, AppChannels } from "./pubsub.js";

const DAEMON_SHORT_NAMES = [
  "audiodaemon", "sttdaemon", "agentqueue", "statusagent",
  "scheduler", "detector", "calendar", "ui",
] as const;

const READ_CHUNK_SIZE = 64 * 1024;

export interface LogTailerOptions {
  configDir: string;
  pubsub: PubSub<AppChannels>;
}

export interface LogTailer {
  stop(): void;
}

/**
 * Tails all known yulu daemon log files in `configDir`. On change, reads the
 * bytes appended since last poll, splits on newline, and publishes one event
 * per line via the `logs` channel.
 *
 * Rotation safety:
 *   - Truncation (`> file.log`): detected via `stat.size <= lastPos`; position
 *     is reset to `stat.size` and we wait for the next append.
 *   - logrotate (mv + recreate at same path): detected via inode change. We
 *     closeSync the old fd, openSync the new path, and reset position to 0.
 */
export function startLogTailer(opts: LogTailerOptions): LogTailer {
  const watchers = new Map<string, FSWatcher>();
  const fds = new Map<string, number>();
  const positions = new Map<string, number>();
  const inodes = new Map<string, number>();
  const pending = new Set<string>();

  function reopenIfRotated(shortName: string, path: string): boolean {
    /** Returns true if a re-open happened (caller should restart its read loop). */
    try {
      const stat = statSync(path);
      const stored = inodes.get(shortName);
      if (stored !== undefined && stat.ino !== stored) {
        // Inode changed → file was rotated. Close old fd, open new file.
        const oldFd = fds.get(shortName);
        if (oldFd !== undefined) {
          try { closeSync(oldFd); } catch { /* ignore */ }
        }
        const newFd = openSync(path, "r");
        fds.set(shortName, newFd);
        inodes.set(shortName, stat.ino);
        positions.set(shortName, 0);
        return true;
      }
    } catch {
      // Path may have been removed between rotation steps; skip this poll.
    }
    return false;
  }

  function pollFile(shortName: string, path: string) {
    if (pending.has(shortName)) return;
    pending.add(shortName);
    queueMicrotask(() => {
      try {
        reopenIfRotated(shortName, path);
        const fd = fds.get(shortName);
        if (fd === undefined) return;
        const stat = statSync(path);
        const lastPos = positions.get(shortName) ?? stat.size;
        if (stat.size <= lastPos) {
          // Truncated in place — reset and bail this cycle.
          positions.set(shortName, stat.size);
          return;
        }
        let pos = lastPos;
        const buf = Buffer.alloc(READ_CHUNK_SIZE);
        let leftover = "";
        while (pos < stat.size) {
          const toRead = Math.min(READ_CHUNK_SIZE, stat.size - pos);
          const n = readSync(fd, buf, 0, toRead, pos);
          if (n <= 0) break;
          const text = leftover + buf.subarray(0, n).toString("utf8");
          const lines = text.split("\n");
          leftover = lines.pop() ?? "";
          for (const line of lines) {
            if (line.length === 0) continue;
            opts.pubsub.publish("logs", { name: shortName, line, ts: Date.now() });
          }
          pos += n;
        }
        positions.set(shortName, pos);
      } catch {
        // best-effort; on error, skip this poll cycle
      } finally {
        pending.delete(shortName);
      }
    });
  }

  for (const shortName of DAEMON_SHORT_NAMES) {
    const path = join(opts.configDir, `${shortName}.log`);
    if (!existsSync(path)) continue;
    try {
      const fd = openSync(path, "r");
      const stat = statSync(path);
      positions.set(shortName, stat.size);   // start tailing from end
      inodes.set(shortName, stat.ino);
      fds.set(shortName, fd);
      const w = watch(path, { persistent: false }, () => pollFile(shortName, path));
      w.on("error", () => { /* swallow */ });
      watchers.set(shortName, w);
    } catch {
      // Skip files we can't open
    }
  }

  return {
    stop() {
      for (const w of watchers.values()) w.close();
      for (const fd of fds.values()) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    },
  };
}
```

- [ ] **Step 4: Run all logTailer tests**

Run: `cd yulu/scripts/yulu_ui && npm test -- logTailer`
Expected: 7 pass (the 6 existing + the new rotation test).

- [ ] **Step 5: Run full vitest + typecheck to confirm no regression**

Run: `cd yulu/scripts/yulu_ui && npm run typecheck && npm test 2>&1 | tail -5`
Expected: no TS errors; vitest reports 279 passing (was 278; +1 from this task).

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/src/logTailer.ts yulu/scripts/yulu_ui/tests/logTailer.test.ts
git commit -m "fix(yulu_ui/logTailer): survive logrotate rotation (reopen on inode change)

Track inode per file alongside read position. On each poll, if statSync(path).ino
differs from stored, close the stale fd, openSync the fresh path, and reset
position to 0. Truncation handling (size <= lastPos) is unchanged. New test:
mv old → write fresh → assert post-rotation line publishes."
```

---

## Task 5 (G.5): CI — yulu_ui job

**Files:**
- Modify: `.github/workflows/ci.yml`

**Goal:** Every PR runs `npm ci && npm run typecheck && npm test && npm run build` for `yulu_ui`. Failures block merge.

### Background context

The existing CI workflow has a single job `build` (macos-latest, 10 min timeout) with bash/python syntax + python tests + doctor smoke + version + swift build. We add a parallel `yulu_ui` job so Node setup doesn't pollute the existing job.

- [ ] **Step 1: Append yulu_ui job to .github/workflows/ci.yml**

Edit `.github/workflows/ci.yml`. The file currently ends at line 116 with an empty line after `echo "install.sh shebang + +x OK"`. Append (note this is a sibling of `build:`, at indent level 2):

```yaml

  yulu_ui:
    name: yulu_ui (typecheck + vitest + build)
    runs-on: macos-latest
    timeout-minutes: 10
    defaults:
      run:
        working-directory: yulu/scripts/yulu_ui
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: yulu/scripts/yulu_ui/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: TypeScript typecheck
        run: npm run typecheck

      - name: Vitest
        run: npm test

      - name: Build
        run: npm run build

      - name: Verify build artifacts
        run: |
          set -euo pipefail
          test -s dist/server.js
          test -s dist/web/index.html
          test -d dist/web/assets
          ls -la dist/web/assets | head -10
          echo "yulu_ui build artifacts OK"
```

- [ ] **Step 2: Validate YAML**

Run:
```bash
python3 -c "
import yaml, sys
with open('.github/workflows/ci.yml') as f:
    data = yaml.safe_load(f)
assert 'build' in data['jobs'], 'build job missing'
assert 'yulu_ui' in data['jobs'], 'yulu_ui job missing'
print('yaml OK; jobs:', list(data['jobs'].keys()))
"
```
Expected: `yaml OK; jobs: ['build', 'yulu_ui']`.

- [ ] **Step 3: Dry-run the steps locally**

Run:
```bash
cd yulu/scripts/yulu_ui
npm ci 2>&1 | tail -3
npm run typecheck 2>&1 | tail -3
npm test 2>&1 | tail -3
npm run build 2>&1 | tail -3
test -s dist/server.js && test -s dist/web/index.html && echo "ALL OK"
```
Expected: every step exits 0; final line is `ALL OK`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: yulu_ui job (setup-node 20 + npm ci/typecheck/test/build)

New parallel job runs typecheck + vitest + build on every PR with npm
cache keyed on yulu/scripts/yulu_ui/package-lock.json. Build artifacts
(dist/server.js + dist/web/index.html + dist/web/assets/) are verified
to exist and be non-empty. Playwright E2E is deliberately not in CI."
```

---

## Task 6 (G.6): uninstall.sh — kill UI server

**Files:**
- Modify: `yulu/scripts/uninstall.sh`

**Goal:** `yulu uninstall` kills any running `yulu_ui/dist/server.js` Node process before removing the plist.

### Background context

`yulu/scripts/uninstall.sh` already removes all `com.yulu.*.plist` files via the glob at lines 149–156 (which catches `com.yulu.ui.plist` for free) and explicitly `pkill -f`s 3 known daemons at lines 161–163. We extend the pkill block to cover the Node server.

- [ ] **Step 1: Add pkill line for the UI server**

Find the existing pkill block at lines 161-163:

```bash
pkill -f "Yulu.app/Contents/MacOS/audio_daemon" 2>/dev/null && ok "killed running audio_daemon" || true
pkill -f "yulu/scripts/scheduler_daemon.py" 2>/dev/null || true
pkill -f "yulu/scripts/meeting_detector.py" 2>/dev/null || true
```

Replace with:

```bash
pkill -f "Yulu.app/Contents/MacOS/audio_daemon" 2>/dev/null && ok "killed running audio_daemon" || true
pkill -f "yulu/scripts/scheduler_daemon.py" 2>/dev/null || true
pkill -f "yulu/scripts/meeting_detector.py" 2>/dev/null || true
pkill -f "yulu_ui/dist/server.js" 2>/dev/null && ok "killed running yulu_ui server" || true
```

- [ ] **Step 2: Bash syntax check**

Run: `bash -n yulu/scripts/uninstall.sh`
Expected: exit 0.

- [ ] **Step 3: Smoke-test the help still works**

Run: `bash yulu/scripts/uninstall.sh --help | grep -q "Usage: yulu uninstall" && echo ok`
Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/uninstall.sh
git commit -m "feat(uninstall): pkill yulu_ui/dist/server.js leftover Node process

Plist itself is already caught by the com.yulu.*.plist glob, but the
running Node process needs explicit cleanup — launchctl unload of an
already-loaded plist leaves the child running until the next throttle
interval. ui.log is covered by --purge-config (existing flag)."
```

---

## Task 7 (G.7): Documentation

**Files:**
- Create: `docs/yulu_ui.md`
- Modify: `README.md`

**Goal:** One-page operator guide for `yulu_ui` + a single bullet in README pointing at it.

- [ ] **Step 1: Create docs/yulu_ui.md**

Write `docs/yulu_ui.md`:

```markdown
# Yulu Web UI

A local web UI at `http://127.0.0.1:7777/` for browsing voicemails, meetings, settings,
prompts, glossary, and daemon health. Runs as the `com.yulu.ui` LaunchAgent — auto-starts
on login, restarts on crash.

## Pages

- `/inbox/voicemails` `/inbox/voicemails/:stem` — voicemail list + audio waveform + transcript/summary/raw tabs
- `/inbox/meetings` `/inbox/meetings/:stem` — meeting list + realtime tab
- `/inbox/search` — full-text search across both with cross-page navigation
- `/settings/{audio,transcription,llm,hotkey,integrations,storage}` — inline-edit settings with restart banner
- `/knowledge/prompts` `/knowledge/prompts/:id` `/knowledge/prompts/new` — prompt master-detail
- `/knowledge/glossary` — vocabulary table with inline-edit + bulk delete
- `/health/daemons` — 8 daemon status cards (auto-poll 5 s)
- `/health/logs` — live log tail via WebSocket

## Layout

```
yulu/scripts/yulu_ui/
├── src/            # Node server (Hono + tRPC + WebSocket multiplexer)
├── web/            # React 18 + Vite 5 SPA
├── dist/           # Build output — produced by `npm run build`
├── tests/          # vitest (server + jsdom)
└── e2e/            # Playwright critical-flow tests (manual)
```

## Production install

`setup.sh` (and `setup.sh --upgrade`) handles this automatically:

1. `npm ci` (skipped when `package-lock.json` SHA matches the stored marker)
2. `npm run build` → `dist/server.js` + `dist/web/`
3. Install `com.yulu.ui.plist` to `~/Library/LaunchAgents/`
4. `launchctl load` → server listens on `127.0.0.1:7777`
5. Poll `/healthz` for up to 10 s

To restart manually:

```bash
launchctl unload ~/Library/LaunchAgents/com.yulu.ui.plist
launchctl load   ~/Library/LaunchAgents/com.yulu.ui.plist
```

## Development workflow

```bash
cd yulu/scripts/yulu_ui
npm install
npm run dev        # vite :5173 (web HMR) + tsx watch :7777 (server)
```

Tests:

```bash
npm run typecheck  # tsc --noEmit
npm test           # vitest (server + jsdom projects)
npm run e2e        # Playwright critical-flow sweep (chromium)
```

## Logs

The LaunchAgent writes stdout + stderr to `~/.config/yulu/ui.log`. Tail it via:

```bash
yulu logs ui                              # tail -f
tail -f ~/.config/yulu/ui.log
```

You can also tail any of the 8 daemon logs from inside the web UI at `/health/logs`.

## Doctor

```bash
yulu doctor                # human output (includes yulu_ui block)
yulu doctor --json         # full report shape; yulu_ui at key `yulu_ui`
```

`yulu_ui` checks: `dist/server.js`, `dist/web/index.html`, plist installed, launchctl
loaded, `/healthz` response, log size. UI is treated as optional — missing artifacts
do not flip the overall doctor exit code.
```

- [ ] **Step 2: Update README.md**

Open `README.md`. Find the "Features" section (or equivalent — the file has both `README.md` and `README.zh-CN.md`; only the English one is touched here unless the user maintains both in parallel). Add this bullet to the features list:

```markdown
- **Local web UI at `http://127.0.0.1:7777/`** — voicemails, meetings, search, settings, prompts, glossary, daemon health. See [docs/yulu_ui.md](docs/yulu_ui.md).
```

If `README.md`'s features list uses a different style (e.g. headers instead of bullets), match its style — the exact wording is "Local web UI at http://127.0.0.1:7777/, with a link to docs/yulu_ui.md".

To find the right insertion point:

```bash
grep -n "^##\|^- " README.md | head -30
```

Pick the bullet that best fits semantically — typically right after the "transcription" / "calendar" / "agent queue" features.

- [ ] **Step 3: Smoke-check the docs render**

Run:
```bash
test -s docs/yulu_ui.md
grep -q "yulu_ui.md" README.md && echo "README links to docs/yulu_ui.md"
```
Expected: `README links to docs/yulu_ui.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/yulu_ui.md README.md
git commit -m "docs(yulu_ui): one-page operator guide + README pointer

docs/yulu_ui.md covers: pages, layout, production install flow (handled
by setup.sh), dev workflow (npm run dev/test/typecheck/e2e), log paths,
and yulu doctor integration. README.md gains one bullet pointing here."
```

---

## Task 8 (G.8): Real-machine smoke + push

**Files:** none (verification + PR finalize)

**Goal:** Verify everything works on a real macOS box via `setup.sh --upgrade`, then push and finalize PR #24 as "Phase A+B+C+D+E+F+G".

This task is **manual smoke** — no code changes, no commits expected unless smoke uncovers a bug (in which case fix and commit per the failing area's pattern).

- [ ] **Step 1: Confirm clean tree**

Run: `git status`
Expected: `nothing to commit, working tree clean`.

- [ ] **Step 2: Reload the existing LaunchAgent to pick up the new sed pipeline**

This is upgrade-mode behavior. Run:

```bash
bash yulu/scripts/setup.sh --upgrade 2>&1 | tee /tmp/yulu-g-smoke.log | tail -40
```

Expected last lines include:
```
✅ yulu_ui dist/ 已生成
✅ com.yulu.ui.plist 已安装并 load
✅ yulu_ui 健康检查通过：http://127.0.0.1:7777/
```

If `--upgrade` is too disruptive on the dev box, run just the new function in isolation:
```bash
NODE_BIN="$(command -v node)" SCRIPT_DIR="$PWD/yulu/scripts" LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents" \
  bash -c 'source yulu/scripts/setup.sh; install_yulu_ui'
```

- [ ] **Step 3: Verify doctor reports yulu_ui**

Run:
```bash
yulu doctor 2>&1 | grep -E "yulu_ui|ui.log"
```
Expected: a line like `✓ yulu_ui: port=7777 dist=True loaded=True healthz=ok` and a `log:` line.

- [ ] **Step 4: Verify `yulu logs ui` works**

Run:
```bash
echo "smoke probe $(date)" >> ~/.config/yulu/ui.log
timeout 1 yulu logs ui 2>&1 | grep -q "smoke probe" && echo "ok"
```
Expected: `ok`.

- [ ] **Step 5: Verify `yulu status` shows the UI block**

Run: `yulu status 2>&1 | grep -E "Web UI|7777"`
Expected: the Web UI block prints with a successful `/healthz` line.

- [ ] **Step 6: Verify reboot survives**

Optional but recommended on dev box. Reboot, log back in, then:
```bash
sleep 30   # give LaunchAgents time to start
curl -s http://127.0.0.1:7777/healthz | grep -q '"status":"ok"' && echo "auto-start ok"
```
Expected: `auto-start ok`.

- [ ] **Step 7: Run final test sweep**

```bash
cd yulu/scripts/yulu_ui && npm run typecheck && npm test 2>&1 | tail -5
cd ../../../ && python3 -m pytest tests/test_doctor.py -v 2>&1 | tail -10
```
Expected: TS clean; vitest reports 279 pass; pytest reports the 4 new tests + existing doctor tests all pass.

- [ ] **Step 8: Push the branch**

Run: `git push 2>&1 | tail -5`
Expected: `claude/yulu-frontend-spec -> claude/yulu-frontend-spec` with the 8 new G-task commits.

- [ ] **Step 9: Update PR #24 title and body**

Run:
```bash
gh pr edit 24 --title "feat(yulu_ui): Phase A+B+C+D+E+F+G — backend + frontend + lifecycle (110 commits, TDD)" --body "$(cat <<'EOF'
## Summary

**Phases A through G** in one branch — the complete Yulu Web UI feature, from backend daemon and frontend pages through to install/uninstall/doctor/CI integration.

- **Phase A** (23 commits): Node 20 backend — 11 tRPC routers + WebSocket multiplexer + esbuild bundle + LaunchAgent plist
- **Phase B** (16 commits): React 18 + Vite 5 shell — Liquid Glass + Ayu palette, sidebar/topbar/pill, theme, 13 placeholder routes
- **Phase C** (22 commits): Inbox pages — Voicemails/Meetings master-detail + wavesurfer + filters + Search with cross-nav + j/k keyboard + fs.watch live refresh
- **Phase D** (22 commits): Settings pages — 6 pages sharing InlineEditRow (6 variants) + RestartBanner + native macOS file picker + audio devices + DB stats + integration probes
- **Phase E** (9 commits): Knowledge pages — Prompts master-detail with Save/Delete + create mode + filters; Glossary table with EditableTable (click-to-edit cells + bulk delete)
- **Phase F** (8 commits): Health pages — logTailer.ts fs.watch on 8 daemon logs → `logs` WS channel; DaemonCard + LogTail; `/health/daemons` + `/health/logs`; Playwright E2E sweep (8 chromium tests)
- **Phase G** (8 commits): Lifecycle integration — setup.sh `install_yulu_ui` (Node 20 guard, idempotent npm ci, healthz poll); `yulu doctor` reports UI health; `yulu logs ui` + `yulu status` UI block; logTailer survives logrotate inode rotation; CI runs `npm ci/typecheck/test/build` on every PR; uninstall.sh kills the UI server; `docs/yulu_ui.md` operator guide

After this PR merges and `setup.sh` runs: open `http://127.0.0.1:7777/` and you have a fully functional Liquid Glass UI for the entire Yulu workflow — including daemon health, log tail, and graceful degradation if `node` isn't installed.

## Stats

- **110 task commits** + 14 spec/plan commits ≈ 124 total
- **279 vitest tests** passing (server + jsdom projects)
- **8 Playwright E2E tests** passing serial in chromium (manual, not in CI)
- **pytest** doctor suite passes with 4 new `check_yulu_ui` tests
- `npm run typecheck` clean
- Server bundle 440 KB, web bundle 425 KB JS (129 KB gz) + 25 KB CSS
- New CI job: `yulu_ui (typecheck + vitest + build)` runs in parallel with the existing Python/Swift job

## Test plan

- [ ] `cd yulu/scripts/yulu_ui && npm ci && npm test && npm run typecheck && npm run build`
- [ ] `python3 -m pytest tests/test_doctor.py -v` — expect doctor tests including the 4 new yulu_ui ones to pass
- [ ] `bash yulu/scripts/setup.sh --upgrade` — observe the yulu_ui block runs and `/healthz` polls green
- [ ] `yulu doctor` — observe yulu_ui block with dist=True / loaded=True / healthz=ok
- [ ] `yulu logs ui` — should tail `~/.config/yulu/ui.log`
- [ ] `yulu status` — should include a `Web UI:` block
- [ ] Optional: reboot and verify the UI auto-starts via LaunchAgent

## Post-merge

- `yulu update` on any installed machine will pull this PR, rebuild yulu_ui, and load the new plist.
- The Phase G manual smoke (Task G.8) covers the auto-start-on-reboot verification.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 10: Confirm PR is healthy**

Run:
```bash
gh pr view 24 --json title,state,mergeable,statusCheckRollup 2>&1 | head -40
```
Expected: `state: OPEN`, `mergeable: MERGEABLE` (or `UNKNOWN` if CI hasn't reported yet), CI checks running.

- [ ] **Step 11: No final commit** — this task is verification only. If the smoke uncovered a bug, fix it via a new commit in the relevant task's pattern (e.g., a follow-up `fix(setup): …` commit).

---

## Self-Review Notes

After writing this plan, I checked it against the spec:

1. **Spec § 4.1 (install_yulu_ui)** → Task 1, all 7 sub-steps cover the responsibilities listed (Node version guard, marker, npm ci+build, install_plist with __NODE_BIN__, launchctl load, healthz poll).
2. **Spec § 4.2 (__NODE_BIN__)** → Task 1 Step 2.
3. **Spec § 4.3 (check_yulu_ui)** → Task 2; the dict shape and human-render block match the spec verbatim.
4. **Spec § 4.4 (yulu CLI)** → Task 3.
5. **Spec § 4.5 (logTailer rotation)** → Task 4; test case design matches spec exactly (write, rotate, append, assert).
6. **Spec § 4.6 (CI yulu_ui job)** → Task 5.
7. **Spec § 4.7 (uninstall kill)** → Task 6.
8. **Spec § 4.8 (docs)** → Task 7.
9. **Spec § 7 (real-machine smoke)** → Task 8.

Coverage complete. No placeholders, no "TBD", every code block is concrete. Function names are consistent: `install_yulu_ui`, `check_yulu_ui`, `pollFile`, `reopenIfRotated`. The marker file path `node_modules/.yulu-built-from` is used uniformly in Task 1.
