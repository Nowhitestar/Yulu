# Phase 1: Build Foundation — Setup Decomposition + Signed/Notarized Binaries - Pattern Map

**Mapped:** 2026-05-29
**Files analyzed:** 22 (15 new, 7 modified)
**Analogs found:** 20 / 22 (2 no-analog: `*.entitlements`, attestation step)

> Brownfield re-architecture. Every analog below is a **real file read this session**, not a hypothetical. The dominant move is **extract + refactor in place**, not greenfield authoring: the decomposed `setup_*.sh` scripts are carved out of existing `setup.sh` function bodies; the codesign refactor edits 3 lines in each `build_*.sh`; the workflow change adds a permissions block + 2 steps. The genuinely new code is small and isolated: `yulu_platform/` (stdlib ABCs), `lib/common.sh` (extracted helpers), the `*.entitlements` files, and the test stubs.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `yulu/scripts/setup.sh` (MODIFY → thin orchestrator) | config/installer | batch / sequence | self (lines 1288-1342 main sequence) | exact (refactor in place) |
| `yulu/scripts/setup_deps.sh` (NEW) | config/installer | batch | `setup.sh::install_deps` (112-141) | exact (extracted body) |
| `yulu/scripts/setup_audio.sh` (NEW) | config/installer | batch + IPC probe | `setup.sh::compile_audio_daemon` (402-494) + `setup_audio` (145-160) | exact (extracted body) |
| `yulu/scripts/setup_models.sh` (NEW) | config/installer | file-I/O (download) | `setup.sh::download_whisper_model` (621-708) | exact (extracted body) |
| `yulu/scripts/setup_capabilities.sh` (NEW) | config/installer | transform (config gen) | `setup.sh::install_mlx_whisper` (607-619) + `write_mlx_to_config` (710-733) | exact (extracted body) |
| `yulu/scripts/setup_daemons.sh` (NEW) | config/installer | batch (launchd) | `setup.sh::install_launchagents` (835-958) | exact (extracted body) |
| `yulu/scripts/setup_ui.sh` (NEW) | config/installer | batch (npm) | `setup.sh::install_yulu_ui` (1022-1111) | exact (extracted body) |
| `yulu/scripts/lib/common.sh` (NEW) | utility (bash lib) | n/a (sourced helpers) | `yulu` CLI colors+helpers (42-52) + `setup.sh::install_plist` (841-869) + `dev_install.py::_launch_path` (86-99) | role-match (no bash lib exists today) |
| `yulu/scripts/build_audio_daemon.sh` (MODIFY) | build/sign | n/a (codesign) | self (lines 57-85, the codesign block) | exact (3-line refactor) |
| `yulu/scripts/build_status_agent.sh` (MODIFY) | build/sign | n/a (codesign) | self (lines 51-67) + `build_audio_daemon.sh` | exact (3-line refactor) |
| `yulu/scripts/Yulu.app.entitlements` (NEW) | config (plist) | n/a (declarative) | `Yulu.app/Contents/Info.plist` (plist shape only) | partial (no entitlements exist) |
| `yulu/scripts/StatusAgent.app.entitlements` (NEW) | config (plist) | n/a (declarative) | `StatusAgent.app/Contents/Info.plist` (plist shape only) | partial (no entitlements exist) |
| `packaging/scripts/package.sh` (MODIFY) | build/package | batch (zip) | self (`ALLOWED_BUILD_OUTPUTS` 41-46, `check_clean_worktree` 74-103) | exact (allowlist edit) |
| `packaging/scripts/sign_and_notarize.sh` (NEW, optional) | build/sign | n/a (codesign+notary) | RESEARCH Patterns 1-3 (no analog in repo) | no-analog (CI-only) |
| `.github/workflows/release-publish.yml` (MODIFY) | CI workflow | n/a | self (`permissions:` 17-19, steps 76-84) | exact (add perms + steps) |
| `.github/workflows/ci.yml` (MODIFY) | CI workflow | n/a | self (Bash syntax check 23-36) | exact (extend file list + add shellcheck) |
| `yulu/scripts/yulu_platform/__init__.py` (NEW) | package init | n/a | `stt_daemon/__init__.py` (1-line docstring) | exact |
| `yulu/scripts/yulu_platform/base.py` (NEW) | model (ABCs) | n/a (interface) | `recording_lock.py` (frozen dataclass + typed class) + `stt_daemon/config.py` (dataclass) | role-match (no ABC exists; RESEARCH Pattern 6 is the spec) |
| `yulu/scripts/yulu_platform/macos/__init__.py` (NEW) | package init (stub) | n/a | `stt_daemon/__init__.py` | exact |
| `yulu/scripts/yulu_platform/linux/__init__.py` (NEW) | provider (stub) | n/a (NotImplementedError) | RESEARCH Pattern 6 linux arm | no-analog (new pattern) |
| `yulu/scripts/yulu_platform/windows/__init__.py` (NEW) | provider (stub) | n/a (NotImplementedError) | linux/__init__.py (sibling) | exact (mirror) |
| `tests/test_yulu_platform_stubs.py` (NEW) | test | n/a | `test_dev_install.py` (importlib loader) + RESEARCH validation block | role-match |
| `tests/test_yulu_platform_no_shadow.py` (NEW) | test | n/a | `test_status_agent_plist_template.py` (static assert) | role-match |
| `tests/test_setup_decomposition.py` (NEW) | test | n/a | `test_package_release.py` (subprocess shells-out to bash) | exact |
| `tests/test_release_no_swiftc.py` (NEW) | test | n/a | `test_package_release.py` + `test_status_agent_plist_template.py` | role-match |

> Install source for `os` is irrelevant — there is **no OS distinction this phase** (macOS-only runtime). The "data flow" column captures whether the script downloads (file-I/O), generates config (transform), sequences subprocesses (batch), or probes a socket (IPC probe).

---

## Pattern Assignments

### `yulu/scripts/build_audio_daemon.sh` (MODIFY — codesign refactor) (build/sign)

**Analog:** itself — the change is surgical. Keep lines 1-77 (swiftc build, bundle assembly, `plist_set_or_add`, identity-selection cascade) **unchanged**; replace only the codesign+verify block at lines 79-80.

**Identity-selection cascade to KEEP verbatim** (lines 64-77) — `YULU_CODESIGN_IDENTITY` env override → Developer ID → Apple Development → ad-hoc. This already honors D-08 (env-driven identity):
```bash
IDENTITY="${YULU_CODESIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -F'"' '/Developer ID Application/ {print $2; exit}')"
fi
# ... Apple Development fallback ... ad-hoc "-" last resort ...
```

**Anti-pattern to REPLACE** (lines 79-80 — the BUILD-02 target):
```bash
codesign --force --deep --timestamp=none --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
```

**Replacement pattern** (from RESEARCH Pattern 1 — bottom-up, hardened runtime, entitlements, secure timestamp):
```bash
ENTITLEMENTS="$SCRIPT_DIR/Yulu.app.entitlements"
# 1. inner Mach-O FIRST (bottom-up, never --deep)
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" \
  "$APP/Contents/MacOS/audio_daemon"
# 2. then the bundle
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"
# 3. verify strictly (NO --deep on verify either, per RESEARCH state-of-art note)
codesign --verify --strict --verbose=2 "$APP"
codesign --display --entitlements :- "$APP"
```

**Reusable note:** `APP_BIN="$APP/Contents/MacOS/audio_daemon"` is already defined at line 8 — use it as the inner-binary target instead of re-deriving the path.

---

### `yulu/scripts/build_status_agent.sh` (MODIFY — codesign refactor) (build/sign)

**Analog:** `build_audio_daemon.sh` (same structure, simpler — no `RES_DIR` icon-copy ceremony, no `--verify` line today).

**Anti-pattern to REPLACE** (lines 64): `codesign --force --deep --timestamp=none --sign "$IDENTITY" "$APP"`

**Replacement:** identical to `build_audio_daemon.sh` above BUT with the StatusAgent entitlements file and the `status_agent` inner binary:
```bash
ENTITLEMENTS="$SCRIPT_DIR/StatusAgent.app.entitlements"
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" \
  "$APP/Contents/MacOS/status_agent"
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP"   # NEW — this script has no verify today
```

**Note:** `APP_BIN="$APP/Contents/MacOS/status_agent"` already defined at line 8. The `NSAppleEventsUsageDescription` is already written into Info.plist at line 49 — the entitlement complements it (Info.plist string ≠ entitlement; both are needed under hardened runtime per RESEARCH Pitfall 3).

---

### `yulu/scripts/Yulu.app.entitlements` (NEW) (config, declarative)

**Analog:** the `<plist><dict>...</dict></plist>` shape of `Yulu.app/Contents/Info.plist` (lines 1-4, 31-32). **No entitlements file exists anywhere in the repo** — match the plist XML skeleton only; the keys are new.

**Content** (RESEARCH Pitfall 3 — VERIFIED: mic needs the audio-input key; SCK is TCC-only with NO entitlement — do NOT add a screen-capture key):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.device.audio-input</key>
	<true/>
</dict>
</plist>
```

**Must be COMMITTED** (RESEARCH Pitfall 2): an uncommitted entitlements file is "dirty after build" and trips `package.sh::check_clean_worktree`. Commit it before any `make package`.

---

### `yulu/scripts/StatusAgent.app.entitlements` (NEW) (config, declarative)

**Analog:** `StatusAgent.app/Contents/Info.plist` (plist skeleton, lines 1-4).

**Content** (RESEARCH Pitfall 3 — StatusAgent shells `osascript`/Apple Events to open Terminal):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.automation.apple-events</key>
	<true/>
</dict>
</plist>
```

**Also COMMIT** (same `check_clean_worktree` reason).

---

### `yulu/scripts/lib/common.sh` (NEW — shared bash helpers) (utility)

**No bash library exists today.** Three real analogs feed it:

**1. Color + log helpers** — `yulu` CLI lines 42-52 is the cleanest existing version (printf-based, safer than `setup.sh`'s `echo -e`):
```bash
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
err()  { printf "${RED}✗${NC} %s\n" "$1"; }
info() { printf "${BLUE}ℹ${NC} %s\n" "$1"; }
```
(`setup.sh` lines 49-60 also has `header()` and `prompt()` — pull those in too so concern scripts keep the visual style.)

**2. `install_plist` — the §8c de-duplication target.** It currently lives **nested inside `install_launchagents`** (`setup.sh` 841-869) AND is **re-implemented inline** in `install_yulu_ui` (`setup.sh` 1079-1088). D-14 says hoist ONE copy to module/lib scope. The body to lift (note the bug to fix in it — line 852's nvm-versioned PATH):
```bash
install_plist() {
    local src="$1" name="$2"
    local dest="$LAUNCH_AGENTS_DIR/$name"
    [[ -f "$dest" ]] && launchctl unload "$dest" 2>/dev/null || true
    cp "$src" "$dest"
    # §6b BUG (line 852): nvm-versioned node path baked in — REPLACE with stable PATH (see helper 3)
    sed -i '' \
        -e "s|__PYTHON__|$PYTHON_BIN|g" -e "s|__NODE_BIN__|$NODE_BIN|g" \
        -e "s|__HOME__|$HOME|g" -e "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" \
        -e "s|__PATH__|$launch_path|g" \
        "$dest" 2>/dev/null || true
}
```
The token set (`__PYTHON__`, `__NODE_BIN__`, `__HOME__`, `__SCRIPT_DIR__`, `__PATH__`) is fixed by the plist templates — see Shared Patterns › Placeholder Substitution. Keep all five.

**3. `_launch_path` — the §6b stable-PATH fix.** The Python version in `dev_install.py` lines 86-99 is the **reference implementation** (it already prefers a stable order and only inserts nvm if present). Port its logic to bash for `common.sh`:
```python
# dev_install.py:86-99 — the model to translate to bash
def _launch_path() -> str:
    parts = [str(Path.home()/".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    nvm = Path.home()/".nvm/versions/node"
    if nvm.exists():
        for candidate in sorted(nvm.glob("*/bin"), reverse=True):
            parts.insert(1, str(candidate)); break
    return ":".join(dict.fromkeys(parts))
```
Bash equivalent should hardcode the stable parts (`~/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`) and optionally glob `~/.nvm/versions/node/*/bin` — but NOT bake `$(node -v)` into the literal as the current `setup.sh:852` does.

**4. source-detection helper** for the dev/release fork (D-13) — reads `.yulu-install.json` `source` field (written by `release_installer.py`). No existing bash reader; the JSON-via-python3 inline pattern from `yulu` CLI lines 176-184 / 274-282 is the idiom to copy:
```bash
source=$(python3 -c "import json,pathlib;print(json.loads(pathlib.Path('$REPO_DIR/.yulu-install.json').read_text()).get('source','dev'))" 2>/dev/null || echo dev)
```

**Header for the file** (RESEARCH Pattern 5): `set -uo pipefail` and the `shellcheck source=lib/common.sh` directive so concern scripts pass shellcheck.

---

### `yulu/scripts/setup_audio.sh` (NEW — extracted concern) (config/installer, batch + IPC probe)

**Analog:** `setup.sh::compile_audio_daemon` (402-494) + `setup_audio` (145-160). This is the most-changed extraction because of the **dev/release fork (D-13)**.

**Pattern skeleton** (RESEARCH Pattern 5 — standalone + sourceable, `set -uo pipefail`):
```bash
#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

setup_audio() {
  local mode="${1:-release}"   # release|dev — orchestrator resolves & passes
  if [[ "$mode" == "dev" ]]; then
    [[ -x "$SCRIPT_DIR/build_audio_daemon.sh" ]] && "$SCRIPT_DIR/build_audio_daemon.sh"
  else
    # RELEASE: binaries pre-built+signed+stapled in CI; just self-heal exec bits.
    for b in "$SCRIPT_DIR/Yulu.app/Contents/MacOS/audio_daemon" \
             "$SCRIPT_DIR/StatusAgent.app/Contents/MacOS/status_agent"; do
      [[ -f "$b" ]] && chmod +x "$b"
    done
    # NO `xattr -dr com.apple.quarantine` — stapled binaries pass Gatekeeper.
  fi
  # ... TCC walkthrough (Darwin-gated) ...
}
[[ "${BASH_SOURCE[0]}" == "${0}" ]] && setup_audio "$@"
```

**What to LIFT from `compile_audio_daemon` (402-494):**
- The exec-bit self-heal loop (409-413) → keep in the release branch (release zips drop +x — load-bearing).
- The TCC reset + re-prompt walkthrough (456-481): `launchctl unload` → `pkill` → `tccutil reset ScreenCapture/Microphone com.yulu.audiodaemon` → `open Yulu.app` → socket `{"action":"status"}` readiness probe via `nc -U`. **Keep this** — RESEARCH Runtime State Inventory says the identity change (Apple-Dev → Developer ID) can invalidate TCC grants, and this reset path is what re-prompts.

**What to DROP / change:**
- Line 426 `xattr -dr com.apple.quarantine` → **remove from release path** (anti-pattern; stapled bundle needs no strip). Keep ONLY in `--dev` if at all.
- The `pkill -9` graceful-stop fix (438) is Phase 2/7 territory (§8b) — **do not regress, do not own**.
- The interactive `prompt`/`read` calls must move to the orchestrator (Pitfall 5): standalone invocation must be non-interactive.

---

### `yulu/scripts/setup_deps.sh` (NEW — extracted concern) (config/installer, batch)

**Analog:** `setup.sh::install_deps` (112-141). Near-verbatim lift.

**Core to KEEP** (the idempotent brew block, 132-140):
```bash
brew install sox ffmpeg whisper-cpp terminal-notifier 2>&1 | tail -1
brew install steipete/tap/gogcli 2>&1 | tail -1
brew install cloudflared 2>&1 | tail -1
```
**Change:** the `prompt "继续安装？"` / `read -r ans` gate (124-130) → orchestrator-owned (Pitfall 5: standalone = non-interactive, default to proceed). Wrap with the `set -uo pipefail` + `common.sh` source + `if [[ "${BASH_SOURCE[0]}" == "${0}" ]]` skeleton.

---

### `yulu/scripts/setup_models.sh` (NEW — extracted concern) (config/installer, file-I/O)

**Analog:** `setup.sh::download_whisper_model` (621-708) + `write_model_to_config` (678-708).

**Core to KEEP:** the config-driven model-target resolution (627-640, inline python3 heredoc reading `transcription.final_engine`), the `curl -L --fail --progress-bar "$url" -o "$target.partial"` + atomic `mv` (665-667), and `write_model_to_config` (writes the `whisper-cli` command array into config.json). This is pure file-I/O + config-transform; no signing concern touches it. Keep the `$PYTHON_BIN` heredoc idiom — but note `$PYTHON_BIN` must be passed in (env/arg), not a global (Pitfall 5).

---

### `yulu/scripts/setup_capabilities.sh` (NEW — extracted concern) (config/installer, transform)

**Analog:** `setup.sh::install_mlx_whisper` (607-619) + `write_mlx_to_config` (710-733). **This is where D-01/D-02/D-03 land.**

**REMOVE the venv creation** (607-619 `install_mlx_whisper` — D-02 says stop creating `~/.config/yulu/venv-mlx-whisper`):
```bash
# DELETE this whole body — no more venv:
local venv="$CONFIG_DIR/venv-mlx-whisper"
"$PYTHON_BIN" -m venv "$venv"
"$venv/bin/python" -m pip install --upgrade pip mlx-whisper
```

**CHANGE `write_mlx_to_config`** (710-733 — D-03): stop writing the venv path into `transcription.mlx.python` (lines 724-727). Per RESEARCH Open Questions #3, Phase 1's contract is **point config at system python3 + VERIFY mlx-whisper importability** (warn if absent), NOT install. The dead-field handling: drop `mlx.python` or set it to the system interpreter. `stt_daemon/config.py` line 23 (`mlx_python: str = ""`) and 44-45 (reads `mlx.python`) confirm the field is harmlessly ignorable when empty.

**KEEP** the rest of `write_mlx_to_config`'s config-transform shape (the `cfg.setdefault(...)` ladder, 718-730) — just change the `mlx` dict to not reference a venv.

---

### `yulu/scripts/setup_daemons.sh` (NEW — extracted concern) (config/installer, batch)

**Analog:** `setup.sh::install_launchagents` (835-958).

**Core to KEEP:** the per-plist install+load loop (873-951 — one `install_plist` + `launchctl load` block per `com.yulu.*.plist`), and the seed steps (916-932: `vocab.cli seed`, `prompts.cli seed`, `search.indexer init` via `PYTHONPATH="$SCRIPT_DIR"`).

**CHANGE:** call the **hoisted** `install_plist` from `lib/common.sh` (D-14, §8c) instead of the nested definition (841-869). Fix the nvm-PATH (§6b) inside that hoisted helper, not here. The calendar-plist conditional (936-951) keeps its upgrade-inherit logic but the interactive `prompt` (942-944) moves to orchestrator scope.

---

### `yulu/scripts/setup_ui.sh` (NEW — extracted concern) (config/installer, batch)

**Analog:** `setup.sh::install_yulu_ui` (1022-1111).

**Core to KEEP:** the node-version guard (1037-1043), the lockfile-sha idempotency marker (1045-1059), `npm ci` + `npm run build` (1056, 1062), the dist-artifact assertion (1065-1068), and the `/healthz` poll (1095-1110).

**CHANGE:** lines 1070-1088 inline-duplicate `install_plist` (the §8c smell) — **replace with the hoisted `lib/common.sh::install_plist`** for `com.yulu.ui.plist`. The duplication's own comment (1070-1071) admits it exists only "so we don't rely on shell-function scoping" — the lib hoist removes that excuse.

---

### `yulu/scripts/setup.sh` (MODIFY → thin orchestrator) (config/installer, sequence)

**Analog:** itself — the main sequence at lines 1288-1342.

**Current flat sequence to REPLACE** (1318-1335):
```bash
check_repo_layout; check_system; install_deps; setup_audio; create_config
configure_post_recording_mode; configure_transcription_engine; configure_summary_mode
compile_scanner; compile_audio_daemon; download_whisper_model; setup_calendar
install_launchagents; install_yulu_ui; install_yulu_cli; install_agent_skill
run_tests; show_summary
```

**New shape** (RESEARCH Pattern 5 — D-12 thin orchestrator): resolve `mode` once (dev/release via `common.sh` source-detection + `--dev` flag override), own ALL interactive prompts, then call each concern script in order passing `mode` + resolved decisions via args/env:
```bash
mode="$(resolve_install_mode "$@")"   # from lib/common.sh: .yulu-install.json source + --dev
"$SCRIPT_DIR/setup_deps.sh"        "$mode"
"$SCRIPT_DIR/setup_audio.sh"       "$mode"
"$SCRIPT_DIR/setup_models.sh"      "$mode"
"$SCRIPT_DIR/setup_capabilities.sh" "$mode"
"$SCRIPT_DIR/setup_daemons.sh"     "$mode"
"$SCRIPT_DIR/setup_ui.sh"          "$mode"
```
**Keep:** `compile_scanner` handling folds into the dev branch of `setup_audio.sh` (D-13 removes it from release). `install_yulu_cli` (1115-1137), `install_agent_skill`, `run_tests`, `show_summary` either stay in the orchestrator or become their own small concern files — planner's call, but they are NOT in the D-11 six-concern list. `UPGRADE_MODE`/`CONFIG_PRESERVED` globals (11-12) become explicit `--upgrade` args passed down (Pitfall 5).

---

### `packaging/scripts/package.sh` (MODIFY) (build/package, batch)

**Analog:** itself. The clean-check contract is the load-bearing constraint (RESEARCH Pitfall 2).

**`ALLOWED_BUILD_OUTPUTS`** (lines 41-46) currently lists exactly the 4 build-dirty files:
```bash
ALLOWED_BUILD_OUTPUTS=(
    "yulu/scripts/StatusAgent.app/Contents/Info.plist"
    "yulu/scripts/StatusAgent.app/Contents/MacOS/status_agent"
    "yulu/scripts/Yulu.app/Contents/Info.plist"
    "yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon"
)
```
**Decision (RESEARCH Pitfall 2):** the new `*.entitlements` files are **committed** (clean, not build-dirty) → they do NOT go in this allowlist. The signed binaries' bytes change (signature) but those 2 paths are already allowlisted. **Only** add to `ALLOWED_BUILD_OUTPUTS` if the build starts writing some *new* tracked path. The `_CodeSignature/CodeResources` files exist in the bundles (verified) — if re-signing rewrites them and they are tracked, they must be added. **Run `tests/test_package_release.py` after any change here** (specifically `test_default_build_refuses_unexpected_dirty_outputs`).

**`check_clean_worktree`** (74-103) and the reproducible-timestamp + exec-bit-restore zip logic (200-209) are **untouched** (RESEARCH Don't-Hand-Roll: exec-bit restoration via `external_attr` is already solved — don't touch beyond verifying it holds).

---

### `.github/workflows/release-publish.yml` (MODIFY) (CI workflow)

**Analog:** itself. This reusable `workflow_call` job is where signing/notarization/attestation slot in (D-09).

**`permissions:` block** (lines 17-19) — extend per RESEARCH Pattern 4:
```yaml
permissions:
  contents: write       # existing
  id-token: write       # NEW — OIDC token to sign the attestation
  attestations: write   # NEW — persist attestation
```
(Caller `release-please.yml` lines 46-51 passes `permissions: contents: write` + `secrets: inherit` — RESEARCH A4 flags that OIDC inheritance for reusable workflows may need the perms declared on THIS job; declare them here.)

**Where steps go:** the existing "Package release assets" step (76-84) runs `make package` + `make checksums`. Insert per RESEARCH Architecture diagram:
1. **Before** package: keychain import (RESEARCH Pattern 3) + `build_*.sh` (already invoked by `make package` via `package.sh` 160-165) + notarize/staple (RESEARCH Pattern 2) — or extract all of that into `packaging/scripts/sign_and_notarize.sh` and call it.
2. **After** `make checksums`: the attestation step (RESEARCH Pattern 4):
```yaml
- name: Attest release zip provenance
  uses: actions/attest-build-provenance@v4
  with:
    subject-path: dist/yulu-macos-arm64-${{ inputs.tag }}.zip
```
3. **Cleanup** (always-run): `security delete-keychain` (RESEARCH Pattern 3, `if: always()`).

**Secrets consumed** (env, D-08 — names only, values injected by Lewis): `YULU_CODESIGN_P12_BASE64`, `P12_PWD`, `KEYCHAIN_PWD`, `ASC_KEY_P8_BASE64`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `YULU_CODESIGN_IDENTITY`.

---

### `.github/workflows/ci.yml` (MODIFY) (CI workflow)

**Analog:** itself — the "Bash syntax check" step (lines 23-36).

**Pattern to EXTEND** (the `for f in ... bash -n` loop, 24-36) — add the new concern scripts + lib:
```bash
for f in install.sh packaging/scripts/package.sh packaging/scripts/checksums.sh \
         yulu/scripts/setup.sh yulu/scripts/setup_deps.sh yulu/scripts/setup_audio.sh \
         yulu/scripts/setup_models.sh yulu/scripts/setup_capabilities.sh \
         yulu/scripts/setup_daemons.sh yulu/scripts/setup_ui.sh \
         yulu/scripts/lib/common.sh yulu/scripts/uninstall.sh yulu/scripts/yulu \
         yulu/scripts/build_audio_daemon.sh yulu/scripts/build_status_agent.sh; do
  bash -n "$f"
done
```
**Mirror the same list edit in `release-publish.yml` lines 46-56** (identical loop). **ADD a shellcheck step** (RESEARCH Validation: `shellcheck` is on macos-latest) covering `setup*.sh`, `lib/*.sh`, `build_*.sh`. The Python-unit-tests step (47-54) already runs `pytest -q` — the new `tests/test_*.py` get picked up automatically.

---

### `yulu/scripts/yulu_platform/base.py` (NEW — platform ABCs) (model/interface)

**No ABC exists in the codebase.** RESEARCH Pattern 6 is the authoritative spec. Two real stdlib analogs ground the *style*:

**1. frozen dataclass value object** — `recording_lock.py` lines 32-39 (`@dataclass class RecordingLockHandle`) and `stt_daemon/config.py` lines 14-28 (`@dataclass class DaemonConfig` with typed fields + defaults). Use `@dataclass(frozen=True)` for `ServiceSpec` (RESEARCH Pattern 6).

**2. typed-class + module docstring + `from __future__ import annotations`** — present in both `recording_lock.py` (1-27) and `queue_store.py` (1-18). Match the header convention:
```python
"""Platform-seam abstract interfaces — Phase 1 ships signatures only (D-15..D-18)."""
from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
```

**Interfaces to define** (RESEARCH Pattern 6, D-16 — the 4 ABCs + `ServiceSpec`): `ServiceSpec` (frozen dataclass: `name`, `program: list[str]`, `keep_alive`, `working_dir`, `environment`), `DaemonManager` (`install`/`load`/`unload`/`status`), `PathResolver` (`config_dir`/`data_dir`/`runtime_dir`), `PermissionModel` (`check`), `DependencyManager` (`is_available`/`install`). **D-18 constraint: NO macOS vocabulary** in signatures (no plist keys, no TCC scope strings, no `SCStreamConfiguration`). All bodies are `...` (abstract).

**Stdlib-only** (CLAUDE.md mandate, RESEARCH Standard Stack): `abc`, `typing`, `dataclasses`, `pathlib` — no new deps.

---

### `yulu/scripts/yulu_platform/__init__.py` + `macos/__init__.py` (NEW — package init / stub)

**Analog:** `stt_daemon/__init__.py` (a single-line module docstring — exact match):
```python
"""stt_daemon — resident STT service for Yulu."""
```
Mirror it: `yulu_platform/__init__.py` → `"""yulu_platform — cross-platform seam interfaces (macOS impls in Phase 2)."""`. `macos/__init__.py` → empty placeholder docstring (D-17: Phase 2 implements; Phase 1 ships an empty stub dir).

**CRITICAL (RESEARCH Pitfall 1, empirically verified):** the package MUST be named **`yulu_platform`**, never `platform` — a `platform/` package on `yulu/scripts/` (which the stt_daemon plist puts on `PYTHONPATH`, line 36) shadows stdlib `platform`, which `numpy` (used by `echo_cancel.py`) imports → break.

---

### `yulu/scripts/yulu_platform/linux/__init__.py` + `windows/__init__.py` (NEW — provider stubs)

**No analog** — RESEARCH Pattern 6 linux arm is the spec. Each concrete subclass overrides every abstract method to `raise NotImplementedError("... not implemented (v2 XPLAT-01)")`:
```python
"""Linux platform arm — Phase 1 ships signatures only; impls deferred to v2 (XPLAT-01)."""
from yulu_platform.base import DaemonManager, PathResolver, PermissionModel, DependencyManager

class LinuxDaemonManager(DaemonManager):
    def install(self, spec): raise NotImplementedError("Linux daemon management not implemented (v2 XPLAT-01)")
    def load(self, name):    raise NotImplementedError("Linux daemon management not implemented (v2 XPLAT-01)")
    def unload(self, name):  raise NotImplementedError("Linux daemon management not implemented (v2 XPLAT-01)")
    def status(self, name):  raise NotImplementedError("Linux daemon management not implemented (v2 XPLAT-01)")
# ... same shape for PathResolver / PermissionModel / DependencyManager
```
`windows/__init__.py` is a **mirror** of `linux/__init__.py` (swap "Linux"→"Windows"). Note: a subclass that overrides all abstract methods IS instantiable (only the bare ABC raises `TypeError`) — so the linux/windows classes instantiate fine but every method raises `NotImplementedError`. That asymmetry is exactly what the two tests below assert.

---

### `tests/test_setup_decomposition.py` (NEW — test) (test)

**Analog:** `test_package_release.py` (lines 60-80) — the **shells-out-to-bash via subprocess** pattern (RESEARCH Don't-Hand-Roll: reuse this, don't add bats):
```python
def run(cmd, cwd, env=None):
    child_env = os.environ.copy()
    if env: child_env.update(env)
    return subprocess.run(cmd, cwd=cwd, env=child_env, capture_output=True, text=True, check=False)
# ... assert result.returncode == 0, result.stderr + result.stdout
```
Use it to assert each `setup_*.sh` (a) contains `set -uo pipefail` (text grep), (b) runs in isolation `bash setup_X.sh` without "unbound variable", (c) is idempotent on re-run. `ROOT = Path(__file__).resolve().parents[1]` is the standard root anchor (every test file uses it).

---

### `tests/test_yulu_platform_stubs.py` + `test_yulu_platform_no_shadow.py` + `test_release_no_swiftc.py` (NEW — tests)

**`test_yulu_platform_stubs.py`** — RESEARCH validation block (lines 506-520) is the spec: assert `DaemonManager()` raises `TypeError` (bare ABC), and `LinuxDaemonManager().load(...)` raises `NotImplementedError`. Needs `yulu/scripts` on `sys.path` — the `importlib.util` loader in `test_dev_install.py` (1-12) is the closest analog, or simpler: `sys.path.insert(0, str(ROOT / "yulu" / "scripts"))` then `from yulu_platform.base import DaemonManager`.

**`test_yulu_platform_no_shadow.py`** — RESEARCH Pitfall 1 verification: with `yulu/scripts` on `sys.path`, assert `import platform; platform.__file__` resolves to the **stdlib** path (not under `yulu/scripts`). Static-style assert like `test_status_agent_plist_template.py`.

**`test_release_no_swiftc.py`** — assert the release fork of `setup_audio.sh` emits no `swiftc` (text grep the script, or run it in release mode and assert no swiftc invocation), and that `install.sh`'s Xcode pre-flight (lines 119-128) is `--dev`-gated (the `--dev`-gated `git` check at line 130 is the model to mirror). Combines the `test_package_release.py` subprocess style with `test_status_agent_plist_template.py` text-assert style.

---

## Shared Patterns

### Placeholder Substitution (launchd plists)
**Source:** all 8 `com.yulu.*.plist` templates + the sed block in `setup.sh::install_plist` (852-860) + the canonical Python version `dev_install.py::render_plist` (102-112).
**Apply to:** `setup_daemons.sh`, `setup_ui.sh`, `lib/common.sh`.
The fixed token set (verified across `com.yulu.sttdaemon.plist`, `com.yulu.audiodaemon.plist`, `com.yulu.ui.plist`):
```
__PYTHON__     → daemon interpreter (D-01/D-02: system python3, NOT a venv)
__NODE_BIN__   → node binary
__HOME__       → $HOME
__SCRIPT_DIR__ → yulu/scripts absolute path
__PATH__       → launch PATH (§6b: stable, not nvm-versioned)
```
`dev_install.py:102-112` is the reference replace-loop (dict of old→new, `text.replace`). The §6b fix touches `__PATH__` generation only (`_launch_path`, dev_install.py:86-99). Note: `com.yulu.audiodaemon.plist` has NO `__PATH__`/`__PYTHON__` (it's `/usr/bin/open -W ...Yulu.app`) — the `open -W` form is Phase 2's concern (§8b); Phase 1 substitutes `__SCRIPT_DIR__`/`__HOME__` only and must not regress it.

### Standalone-or-Sourced Bash Script Skeleton
**Source:** RESEARCH Pattern 5 (no existing concern script — `build_audio_daemon.sh` is the closest standalone, but it's not designed to be sourced).
**Apply to:** every new `setup_*.sh`.
```bash
#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
<concern>() { ... }
[[ "${BASH_SOURCE[0]}" == "${0}" ]] && <concern> "$@"
```
Note the `set -e` → `set -uo pipefail` upgrade (§6c): every existing `build_*.sh`/`package.sh`/`checksums.sh` uses `set -euo pipefail`; `setup.sh` and the `yulu` CLI use bare `set -e`. New scripts standardize on `set -uo pipefail`. **Pitfall 5 audit required:** the monolith shares globals (`$CONFIG_DIR`, `$SCRIPT_DIR`, `UPGRADE_MODE`, `CONFIG_PRESERVED`) across functions — independent scripts must take these via args/env or `set -u` will error on first unbound use.

### Code-signing Identity Selection (env-driven)
**Source:** `build_audio_daemon.sh` lines 64-77 (and the identical block in `build_status_agent.sh` 52-63).
**Apply to:** both `build_*.sh` (keep as-is), and CI sets `YULU_CODESIGN_IDENTITY` from a secret (D-08).
The cascade (`$YULU_CODESIGN_IDENTITY` → Developer ID → Apple Development → ad-hoc `-`) already implements the env-override contract; **do not rewrite it**, only swap the codesign invocation it feeds.

### Inline-python3-from-bash (config read/write)
**Source:** `yulu` CLI (176-184, 274-282), `setup.sh` (627-640 read, 678-706 / 712-731 write).
**Apply to:** `setup_models.sh`, `setup_capabilities.sh`, `lib/common.sh` source-detection.
Heredoc `"$PYTHON_BIN" - <<PY ... PY` is the established idiom for JSON config manipulation from bash — reuse rather than introducing `jq`. Pass `$PYTHON_BIN`/`$CONFIG_DIR` explicitly (Pitfall 5).

### Test Root Anchor + subprocess shell-out
**Source:** every `tests/test_*.py` uses `ROOT = Path(__file__).resolve().parents[1]`; `test_package_release.py:60-64` is the canonical `subprocess.run(..., capture_output=True, text=True, check=False)` helper.
**Apply to:** all 4 new test files. `tests/conftest.py` (3 lines) only registers `e2e`/`integration` markers — no fixtures to inherit; new tests are plain functions.

---

## No Analog Found

| File | Role | Data Flow | Reason | Use Instead |
|------|------|-----------|--------|-------------|
| `yulu/scripts/Yulu.app.entitlements` | config | declarative | **No entitlements file exists in the repo** (RESEARCH verified `flags=0x0`, no entitlements). Only the plist XML skeleton is an analog. | RESEARCH Pitfall 3 (exact keys) + Info.plist XML shape |
| `yulu/scripts/StatusAgent.app.entitlements` | config | declarative | same | RESEARCH Pitfall 3 + StatusAgent Info.plist shape |
| `packaging/scripts/sign_and_notarize.sh` (optional) | build/sign | codesign+notary | No notarization/keychain code anywhere in repo (current signing is the 1-line `--deep` anti-pattern). | RESEARCH Patterns 1-3 verbatim |
| Attestation step in `release-publish.yml` | CI | OIDC | No `actions/attest*` usage today. | RESEARCH Pattern 4 |
| `yulu_platform/linux/__init__.py` + `windows/__init__.py` | provider stubs | NotImplementedError | No multi-platform abstraction exists (launchd is the only daemon manager). | RESEARCH Pattern 6 linux arm |

> For the no-analog files the planner copies RESEARCH's verified command/code patterns directly; there is no in-repo precedent to mirror.

## Metadata

**Analog search scope:** `yulu/scripts/` (build scripts, CLI, setup.sh, plists, stt_daemon, queue_store, recording_lock, dev_install), `packaging/scripts/`, `.github/workflows/`, `tests/`, both `.app/Contents/Info.plist`.
**Files scanned:** 24 source/config files read in full or targeted ranges.
**Pattern extraction date:** 2026-05-29

---

## PATTERN MAPPING COMPLETE

**Phase:** 01 - Build Foundation — Setup Decomposition + Signed/Notarized Binaries
**Files classified:** 24 (15 new, 9 modified — counting both build scripts, both workflows, package.sh, setup.sh as modified)
**Analogs found:** 20 / 24 strong in-repo analogs; 4 use RESEARCH verified patterns (entitlements ×2, sign/notarize, attestation) + 1 mirror (windows stub).

### Coverage
- Files with exact analog (refactor-in-place or sibling-mirror): 16
- Files with role-match analog (style from a different-role file): 3
- Files with no in-repo analog (RESEARCH patterns are the spec): 5

### Key Patterns Identified
- **Decomposition is extraction, not authoring:** each `setup_*.sh` is a near-verbatim lift of a named `setup.sh` function body (`install_deps`→deps, `compile_audio_daemon`+`setup_audio`→audio, `download_whisper_model`→models, `install_mlx_whisper`+`write_mlx_to_config`→capabilities, `install_launchagents`→daemons, `install_yulu_ui`→ui), wrapped in the `set -uo pipefail` standalone-or-sourced skeleton (RESEARCH Pattern 5) with interactive prompts hoisted to the orchestrator (Pitfall 5).
- **Codesign refactor is a 3-line swap** in each `build_*.sh`: the env-driven identity cascade (lines 64-77 / 52-63) stays; only `codesign --force --deep --timestamp=none` → bottom-up `--options runtime --timestamp --entitlements` (inner binary then bundle) changes. `APP_BIN` is already defined as the inner-binary target.
- **`install_plist` de-duplication (§8c)** is the clearest shared-helper win: it lives nested in `install_launchagents` (841-869) AND inline-duplicated in `install_yulu_ui` (1079-1088); D-14 hoists one copy to `lib/common.sh`, and `dev_install.py::render_plist`/`_launch_path` (102-112 / 86-99) are the reference Python implementations to translate (including the §6b stable-PATH fix).
- **Python ABCs are stdlib-only** (`abc`/`dataclasses`/`typing`/`pathlib`); style comes from `recording_lock.py` (frozen dataclass + typed class + `from __future__ import annotations`) and `stt_daemon/config.py` (typed dataclass). Package MUST be `yulu_platform` not `platform` (verified shadowing break).
- **Two verified load-bearing traps the planner must respect:** (1) entitlements — mic needs `com.apple.security.device.audio-input`, StatusAgent needs `com.apple.security.automation.apple-events`, SCK needs NONE; (2) `package.sh::ALLOWED_BUILD_OUTPUTS` (41-46) — commit the `*.entitlements` (don't add to allowlist), run `test_package_release.py` after any change.
- **Tests reuse the shells-out-to-bash pattern** (`test_package_release.py` subprocess helper) — no bats; `ROOT = Path(__file__).resolve().parents[1]` anchor and plain functions (conftest only registers markers).

### File Created
`.planning/phases/01-build-foundation-setup-decomposition-signed-notarized-binari/01-PATTERNS.md`

### Ready for Planning
Pattern mapping complete. The planner has, per file: the exact analog with line numbers, what to KEEP vs CHANGE vs DROP, the load-bearing constraints (entitlement keys, `ALLOWED_BUILD_OUTPUTS`, `yulu_platform` naming, Pitfall 5 global-state audit), and which 5 files have no in-repo precedent and must copy RESEARCH's verified patterns directly.
