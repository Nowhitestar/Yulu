# Phase 9: Release Safety - Pattern Map

**Mapped:** 2026-08-23
**Requirements:** DIST-01, DIST-02, DIST-03, DIST-04
**Likely files analyzed:** 13 new/modified files
**Strong analogs:** 5 pattern families

## Conclusion

Phase 9 does not need a new installer architecture. Three required controls already exist but are not connected to every path:

1. `packaging/scripts/package.sh` already emits a version-paired `install.sh` with the exact `release_installer.py` embedded; only raw-main stable bootstrap bypasses it.
2. `migrate.guard.recording_active` already defines the canonical active-recording predicate; install/update must call it once before the release/dev fork instead of adding another socket probe.
3. `setup_daemons.sh` already gates calendar work with an explicit environment decision; `setup_deps.sh` and `provision.registry._deps_ready` must use the same core-vs-optional boundary.

The only genuinely new mechanism is a Mach-O minimum-OS check. Keep it as one small native-tool script reused by both CI workflows.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `install.sh` | utility / bootstrap | request-response, network, file-I/O | `packaging/scripts/package.sh:226-247` | exact release-pair analog |
| `yulu/scripts/build_audio_daemon.sh` | build config | batch, file-I/O | `yulu/scripts/build_status_agent.sh:19-26` | exact role/data-flow |
| `yulu/scripts/build_status_agent.sh` | build config | batch, file-I/O | `yulu/scripts/build_audio_daemon.sh:18-28` | exact role/data-flow |
| `packaging/scripts/check_macos_deployment_target.sh` (new, if shared by both workflows) | validation utility | batch, transform | `packaging/scripts/checksums.sh:1-32` | role-match |
| `.github/workflows/ci.yml` | CI config | batch | `.github/workflows/release-publish.yml:127-160` | role-match |
| `.github/workflows/release-publish.yml` | release config | batch, file-I/O | existing package verification block in the same file, lines 127-160 | exact extension point |
| `yulu/scripts/release_installer.py` | installer service | request-response, network, file-I/O | `yulu/scripts/migrate/guard.py:49-97` + `release_installer.py:1292-1313` | exact guard + exact dispatch seam |
| `yulu/scripts/setup.sh` | setup controller | request-response, batch | its existing consent and optional-agent branches, lines 147-169 and 655-669 | exact local pattern |
| `yulu/scripts/setup_deps.sh` | dependency service | batch | `yulu/scripts/setup_daemons.sh:144-160` | exact optional-gate pattern |
| `yulu/scripts/provision/registry.py` | provider / registry | batch | `_deps_ready`, lines 214-224 | exact modification point |
| `tests/test_package_release.py` | test | batch, file-I/O | lines 317-355 and 408-424 | exact release-contract tests |
| `tests/test_release_installer.py` | test | request-response, file-I/O | lines 178-211 and 729-776 | exact release/dev call-order tests |
| `tests/test_setup_decomposition.py` | test | batch, file-I/O | lines 201-262 and 397-420 | exact hermetic setup tests |

`packaging/scripts/package.sh`, `yulu/scripts/migrate/guard.py`, `yulu/scripts/setup_daemons.sh`, and `tests/test_migrate_recording_guard.py` are analog/source files first; do not edit them unless implementation proves necessary.

## Pattern Assignments

### DIST-01 — Version-paired stable installer

#### `install.sh` (utility, request-response + network)

**Primary analog:** `packaging/scripts/package.sh`

**Existing immutable pairing pattern** (`packaging/scripts/package.sh:226-247`):

```bash
if [[ -f "$ROOT/install.sh" ]]; then
    cp "$ROOT/install.sh" "$INSTALL_ASSET"
    HELPER_PAYLOAD="$(base64 < "$ROOT/yulu/scripts/release_installer.py" | tr -d '\r\n')"
    INSTALL_TMP="$(mktemp "$DIST_ABS/install.sh.XXXXXX")"
    awk -v payload="$HELPER_PAYLOAD" '
        { sub(/__YULU_EMBEDDED_RELEASE_INSTALLER_BASE64__/, payload); print }
    ' "$INSTALL_ASSET" > "$INSTALL_TMP"
    if grep -q '__YULU_EMBEDDED_RELEASE_INSTALLER_BASE64__' "$INSTALL_TMP"; then
        echo "Failed to embed release_installer.py into release install.sh" >&2
        exit 1
    fi
    chmod +x "$INSTALL_TMP"
    mv "$INSTALL_TMP" "$INSTALL_ASSET"
fi
```

**Existing installer consumption pattern** (`install.sh:178-209`):

```bash
HELPER="$TMP_DIR/release_installer.py"
if [[ "$EMBEDDED_HELPER_BASE64" != __YULU_EMBEDDED_* ]]; then
    printf '%s' "$EMBEDDED_HELPER_BASE64" | base64 --decode > "$HELPER"
    ok "Using installer helper embedded in this release asset"
else
    curl -fsSL "$HELPER_URL" -o "$HELPER"
fi
```

The embedded branch is correct. The `else` branch is the defect for stable installs because `HELPER_URL` points to `main` (`install.sh:18`). Preserve that fallback only for explicit `--dev`. For `--latest` and `--version`, fetch and execute the corresponding GitHub Release `install.sh` asset, which then takes the embedded branch above. Do not copy the helper into another release asset.

**Release selection/validation to preserve** (`yulu/scripts/release_installer.py:143-173`):

```python
expected_zip = f"yulu-macos-arm64-{tag}.zip"
expected_checksums = "checksums.txt"
...
if target.kind == "latest":
    return f"{GITHUB_API}/repos/{REPO}/releases/latest"
if target.kind == "version" and target.tag:
    return f"{GITHUB_API}/repos/{REPO}/releases/tags/{target.tag}"
```

**Test pattern** (`tests/test_package_release.py:408-424`):

```python
packaged = (dist / "install.sh").read_text(encoding="utf-8")
match = re.search(r'^EMBEDDED_HELPER_BASE64="([A-Za-z0-9+/=]+)"$', packaged, re.M)
assert match
decoded = base64.b64decode(match.group(1)).decode("utf-8")
assert decoded == (project / "yulu" / "scripts" / "release_installer.py").read_text(encoding="utf-8")
assert "__YULU_EMBEDDED_RELEASE_INSTALLER_BASE64__" not in packaged
```

Extend this file with one hermetic assertion for the raw bootstrap contract: stable targets resolve a release `install.sh`; only `--dev` may use raw `main`. Do not add a network test.

**Required call chain:**

```text
raw-main bootstrap (compatibility URL)
  -> latest/tagged GitHub Release install.sh
  -> embedded release_installer.py from the same build
  -> tag-matched yulu-macos-arm64-<tag>.zip + checksums.txt
  -> setup.sh inside that verified zip

--dev
  -> raw-main release_installer.py
  -> git main checkout
```

**Minimum boundary:** leave asset naming, checksum verification, runtime validation, signatures, and rollback untouched. The bug is one bootstrap fallback, not the release installer transaction.

---

### DIST-02 — macOS 13 deployment target and Mach-O gate

#### `build_audio_daemon.sh` and `build_status_agent.sh` (build config, batch)

**Existing compile pattern** (`yulu/scripts/build_audio_daemon.sh:18-28`):

```bash
cd "$SCRIPT_DIR"

swiftc -o "$BIN" audio_daemon.swift \
  -framework Cocoa \
  -framework ScreenCaptureKit \
  -framework AVFoundation
swiftc -o "$KEYCHAIN_BIN" xai_keychain.swift \
  -framework Security
```

**Sibling pattern** (`yulu/scripts/build_status_agent.sh:19-26`):

```bash
cd "$SCRIPT_DIR"

swiftc -o "$BIN" status_agent.swift \
  -framework Cocoa -framework Carbon -framework WebKit
swiftc -o "$RECORDER_BIN" recorder_status.swift -framework Cocoa
swiftc -o "$MEETING_PROMPT_BIN" meeting_prompt.swift -framework Cocoa
```

Add the same native Swift target argument to every shipped compile in both scripts: `-target arm64-apple-macosx13.0`. A single local bash array per script is enough; do not create a Swift package or Xcode project.

CI's direct compiles (`.github/workflows/ci.yml:109-123`) must use the same target. This includes `window_scanner.swift`, even though it is not currently a checked-in release binary, so pre-merge compilation catches unguarded newer APIs.

#### `packaging/scripts/check_macos_deployment_target.sh` (new validation utility, batch)

**Closest shell-gate analog:** `packaging/scripts/checksums.sh:1-32`

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ ! -d "$DIST" ]]; then
    echo "No dist directory: $DIST" >&2
    exit 1
fi
...
if [[ ! -s "$ARTIFACTS" ]]; then
    echo "No release artifacts found ..." >&2
    exit 1
fi
```

Follow that shape: `set -euo pipefail`, explicit missing-file errors, native `xcrun vtool -show-build`, and non-zero exit on any shipped Mach-O whose `minos` is not `13.0`. Keep the expected floor hard-coded; it is a product constraint, not a user option.

Apply it to these five shipped binaries:

```text
yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon
yulu/scripts/Yulu.app/Contents/MacOS/xai_keychain
yulu/scripts/StatusAgent.app/Contents/MacOS/status_agent
yulu/scripts/recorder_status
yulu/scripts/meeting_prompt
```

Call the same script after `.ci-build` compilation in `ci.yml` and against the extracted, verified release runtime in `release-publish.yml:141-160`. The latter is the authoritative artifact gate; a source-text assertion alone does not satisfy DIST-02.

**Test placement:** extend `tests/test_package_release.py:317-355`, where installer floors and release workflow invariants already live. Static tests should assert the build target and that both workflows invoke the gate; the real `vtool` execution remains in macOS CI.

**Minimum boundary:** do not alter `audio_daemon.swift`; its 14.4+ APIs are already behind `if #available(macOS 14.4, *)`. This phase fixes linker deployment metadata and verifies the artifact.

---

### DIST-03 — One active-recording guard for release and dev update

#### `yulu/scripts/release_installer.py` (installer service, file-I/O)

**Canonical analog:** `yulu/scripts/migrate/guard.py`

**Typed refusal** (`yulu/scripts/migrate/guard.py:49-67`):

```python
class RecordingActive(RuntimeError):
    def __init__(self, info: dict):
        ...
        super().__init__(
            "refusing to stop daemons: a recording is in progress"
            f"{detail}; stopping the audio daemon now would truncate the "
            "in-flight capture. Stop the recording, then retry migration."
        )
        self.info = info if isinstance(info, dict) else {}
```

**Canonical arbiter** (`yulu/scripts/migrate/guard.py:70-97`):

```python
def recording_active(socket_send=None) -> bool:
    if socket_send is None:
        try:
            from record_audio import socket_send as _send
        except Exception:
            return False
        socket_send = _send
    try:
        status = socket_send({"action": "status"})
    except Exception:
        return False
    return bool(status and status.get("recording") is True)
```

The audio-daemon status socket is the authority. Never use `recording_lock` as the active sentinel; that lock covers only the start handshake. Its metadata may enrich the refusal message.

**Single release/dev dispatch seam** (`yulu/scripts/release_installer.py:1308-1313`):

```python
install_dir = install_dir.resolve(strict=False)
with acquire_install_lock(install_dir):
    if target.kind == "dev":
        install_dev_channel(install_dir, run_setup_flag=not args.no_setup)
    else:
        install_release_target(target, install_dir, run_setup_flag=not args.no_setup)
```

Insert one shared update-safety call under the install lock and before this branch. It should reuse the installed runtime's `migrate.guard.recording_active` (temporarily add `<install_dir>/yulu/scripts` to the import path when the embedded helper is running from a temp directory). For a fresh install with no existing runtime, there cannot be an in-runtime recording and the check is a no-op. For an existing runtime whose guard cannot be loaded, refuse the update rather than inventing a second socket client or guessing from a PID.

Keep the safety check before `install_dev_channel`'s first `git fetch` (`release_installer.py:1021-1025`) and before the release transaction swaps the runtime (`release_installer.py:1142-1145`). The guard must raise before any daemon-stop/setup work.

**Test pattern** (`tests/test_migrate_recording_guard.py:128-175`):

```python
manager = _RecordingManager()
with pytest.raises(guard_mod.RecordingActive):
    guard_mod.stop_daemons_guarded(
        labels=["com.yulu.audiodaemon", "com.yulu.sttdaemon"],
        manager=manager,
        socket_send=_send_returning({"recording": True}),
    )
assert manager.unloaded == []
```

Extend `tests/test_release_installer.py`, not the migration test, with two branch assertions: active status blocks `--latest` and `--dev`, neither install function is called, and existing runtime bytes remain unchanged. Reuse the existing `monkeypatch` + call-list style at `tests/test_release_installer.py:178-211` and `729-776`.

**Minimum boundary:** do not add guard logic separately to `install_release_target` and `install_dev_channel`, and do not call `stop_daemons_guarded` from the installer. The installer refuses; setup remains the sole lifecycle owner.

---

### DIST-04 — Core install without mandatory Agent/calendar/Homebrew setup

#### `setup.sh` (controller, request-response + batch)

**Consent pattern to preserve** (`yulu/scripts/setup.sh:147-169`):

```bash
confirm_deps_install() {
    ...
    prompt "继续安装？[Y/n]"
    read -r ans
    if [[ "$ans" =~ ^[nN] ]]; then
        warn "跳过依赖安装"
        return 1
    fi
    return 0
}
```

All Homebrew mutation must remain behind this user decision. `check_system()` must be read-only; remove its automatic Homebrew installer at `setup.sh:125-128`. Detection may warn and explain the manual/consented path, but must not execute remote Homebrew bootstrap code.

**Current mandatory Agent block to replace** (`yulu/scripts/setup.sh:659-669`):

```bash
if ! ... -m provision.cli mcp install --agent hermes; then
    err "Hermes CLI and its Yulu phase MCP registrations are required. ..."
    exit 1
fi
... mcp install --agent codex --agent claude --agent openclaw \
    --detected-only --non-fatal || warn "Optional Agent MCP registration returned a warning"
```

Use the already-existing optional branch for all four Agents, including Hermes. Core install must not choose or provision a summary provider; that belongs to Phase 10 activation/provider work. Do not add OpenClaw-specific setup here.

#### `setup_deps.sh` and `provision/registry.py` (dependency service + readiness provider)

**Existing calendar opt-in analog** (`yulu/scripts/setup_daemons.sh:144-160`):

```bash
local install_calendar=false
if [[ "${YULU_INSTALL_CALENDAR:-}" == "1" ]]; then
    install_calendar=true
elif [[ "$UPGRADE_MODE" == true && -f "$LAUNCH_AGENTS_DIR/com.yulu.calendar.plist" ]]; then
    install_calendar=true
fi
if [[ "$install_calendar" == true ]]; then
    install_plist ...
    launchctl load ...
fi
```

Mirror this explicit decision boundary for `gog` and `cloudflared`. They are currently installed unconditionally in `setup_deps.sh:86-105`; move them behind the calendar opt-in (or leave them entirely for Phase 13 configuration). Keep `ffmpeg`, `sox`, compatible Node, and their current postcondition checks in the core dependency path.

Update the core readiness probe at `yulu/scripts/provision/registry.py:214-224`:

```python
required_commands = (
    "brew",
    "cloudflared",
    "ffmpeg",
    "gog",
    "sox",
    "terminal-notifier",
)
return all(_have(command) for command in required_commands) and _compatible_node_present()
```

`_deps_ready()` must not require `gog` or `cloudflared`, otherwise `yulu provision --all` will continue treating an intentionally deferred calendar as incomplete. Do not create a second provision registry for optional integrations in Phase 9.

The fresh calendar service prompt at `setup.sh:371-383` currently defaults to install (`[Y/n]`) even when Google Calendar was skipped. Make the default defer/skip or remove it from core setup; the existing `YULU_INSTALL_CALENDAR=1` route remains available for explicit opt-in.

**Test pattern** (`tests/test_setup_decomposition.py:201-262`):

```python
shim = _make_shim_dir(tmp_path)
(shim / "ffmpeg").unlink()
(shim / "brew").write_text("#!/usr/bin/env bash\nexit 42\n")
...
result = run(["bash", str(SCRIPTS / "setup_deps.sh"), "release"], cwd=SCRIPTS, env=env)
assert result.returncode != 0
```

Use the same hermetic PATH shims to prove the inverse Phase 9 contract: core setup succeeds when `hermes`, `openclaw`, `gog`, and `cloudflared` are absent; no fake `brew install` call mentions the optional tools; running the concern twice still succeeds. Update `tests/test_package_release.py:296-305`, which currently asserts that Hermes is mandatory.

**Minimum boundary:** do not redesign provider selection, calendar OAuth, or onboarding here. Phase 9 only removes these as install blockers and preserves explicit opt-in hooks for later phases.

## Shared Patterns

### Fail before mutation

**Sources:** `release_installer.acquire_install_lock` (`release_installer.py:666-721`), `migrate.guard` (`migrate/guard.py:70-97`)

Apply the active-recording decision under the per-install lock and before either update channel mutates checkout/runtime state. Return the existing `InstallError`-style concise message through `main()` (`release_installer.py:1314-1326`); do not print a traceback.

### Postcondition over command exit

**Source:** `setup_deps.sh:23-35`

```bash
if ! brew install "$formula"; then
    warn "brew install $formula 返回失败，正在核对实际安装结果"
fi
command -v "$command_name" >/dev/null 2>&1
```

Keep this for core formula installation after consent. Optional gating changes *whether* the command runs, not how success is determined.

### Hermetic shell tests

**Source:** `tests/test_setup_decomposition.py:45-75,397-420`

Use `tmp_path`, a fake `HOME`, and PATH shims; invoke scripts with argv-list `subprocess.run(..., check=False)`. Do not exercise real Homebrew, launchctl, GitHub, or network access in pytest.

### Release artifact, not source-only, is acceptance

**Source:** `.github/workflows/release-publish.yml:127-160`

The workflow already packages, verifies checksums, extracts the exact zip, validates layout/signatures, and validates the signed runtime manifest. Add the Mach-O deployment check to this same extracted-runtime block so it verifies what users download.

## Existing Helpers That Must Not Be Reimplemented

| Helper | Source | Reuse rule |
|---|---|---|
| Embedded release helper sentinel | `install.sh:18-21`, `package.sh:226-247` | Stable bootstrap must reach this asset; do not publish a second helper asset |
| Release/tag asset resolution | `release_installer.py:143-173` | Keep exact zip/checksum naming and GitHub API semantics |
| Checksum and runtime validation | `release_installer.py:209-255,1114-1203` | Do not create a parallel downloader/install transaction |
| Install serialization | `release_installer.py:666-721` | Active guard runs inside this lock |
| Active recording predicate | `migrate/guard.py:70-97` | Import/reuse; do not probe PID/flock or rewrite socket JSON |
| Optional calendar decision | `setup_daemons.sh:144-160` | Reuse `YULU_INSTALL_CALENDAR`; do not invent another config flag |
| Brew postcondition helper | `setup_deps.sh:23-35` | Keep for consented core dependency installation |
| Compatible Node policy | `lib/common.sh` via `compatible_node_bin`, used by `setup_deps.sh:68-84` | Do not duplicate Node version parsing |

## No Close Analog Found

| New Mechanism | Role | Data Flow | Reason / fallback |
|---|---|---|---|
| Mach-O `LC_BUILD_VERSION.minos` validation | validation utility | batch, transform | No `vtool`, `otool`, `LC_BUILD_VERSION`, or deployment-target check exists. Use native `xcrun vtool`; follow `checksums.sh` fail-fast shell shape. |

## Suggested Plan Split

1. **Installer safety:** `install.sh`, `release_installer.py`, `tests/test_package_release.py`, `tests/test_release_installer.py` — DIST-01 + DIST-03 share the install entry path.
2. **macOS artifact floor:** both Swift build scripts, one Mach-O check helper, both workflows, `tests/test_package_release.py` — DIST-02.
3. **Optional install boundary:** `setup.sh`, `setup_deps.sh`, `provision/registry.py`, setup/package tests — DIST-04.

These three plans are file-disjoint except `tests/test_package_release.py`; serialize the first two or assign that test file to one plan to avoid merge conflict.

## Metadata

**Analog search scope:** root installer, `packaging/scripts/`, `.github/workflows/`, `yulu/scripts/{migrate,provision}`, decomposed setup scripts, release/setup tests, `.planning/codebase/`
**Current artifact observation:** all five checked-in shipped Mach-O binaries report `minos 26.0`; this is current-worktree evidence, not a memory-derived assumption
**Pattern extraction date:** 2026-08-23
