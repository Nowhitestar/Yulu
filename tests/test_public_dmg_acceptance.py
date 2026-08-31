from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "packaging" / "acceptance" / "public_dmg_target.sh"
TAG = "v0.23.0-rc.5"
NAME = f"yulu-macos-arm64-{TAG}.dmg"
PUBLIC_URL = f"https://github.com/Nowhitestar/Yulu/releases/download/{TAG}/{NAME}"
CHECKSUMS_URL = f"https://github.com/Nowhitestar/Yulu/releases/download/{TAG}/checksums.txt"


def _command(path: Path, body: str) -> None:
    path.write_text(f"#!/bin/bash\n{body}\n")
    path.chmod(0o755)


def _run(
    tmp_path: Path,
    *,
    url: str = PUBLIC_URL,
    checksums_url: str = CHECKSUMS_URL,
    quarantine: str = "0083;66d2a800;Safari;",
    origin: str = PUBLIC_URL,
    checksum_rows: list[str] | None = None,
    dmg_name: str = NAME,
    checksums_name: str = "checksums.txt",
    dmg_symlink: bool = False,
    checksums_symlink: bool = False,
    arch: str = "arm64",
    version: str = "14.7.1",
    host_tool: str | None = None,
    xcode_selected: bool = False,
    homebrew_directory: bool = False,
    xcode_app: bool = False,
    command_line_tools: bool = False,
    service_loaded: bool = False,
    cwd_in_repo: bool = False,
    harness_in_repo: bool = False,
    system_file: str | None = None,
    home_marker: str | None = None,
    activated_environment: tuple[str, str] | None = None,
    run_id: str = "slice1-policy",
    dmg_content: bytes = b"public dmg bytes",
    evidence_dir: Path | None = None,
    scenario: str = "fresh",
    upgrade_journey: str = "",
) -> subprocess.CompletedProcess[str]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    dmg = tmp_path / dmg_name
    if dmg_symlink:
        real_dmg = tmp_path / "actual-download.dmg"
        real_dmg.write_bytes(dmg_content)
        dmg.symlink_to(real_dmg)
    else:
        dmg.write_bytes(dmg_content)
    actual_sha = hashlib.sha256(dmg.read_bytes()).hexdigest()
    checksums = tmp_path / checksums_name
    rows = checksum_rows if checksum_rows is not None else [f"{actual_sha}  {NAME}"]
    if checksums_symlink:
        real_checksums = tmp_path / "actual-checksums"
        real_checksums.write_text("\n".join(rows) + "\n")
        checksums.symlink_to(real_checksums)
    else:
        checksums.write_text("\n".join(rows) + "\n")
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir(exist_ok=True)
    _command(fake_bin / "uname", f"echo {arch}")
    _command(fake_bin / "sw_vers", f"echo {version}")
    _command(fake_bin / "xattr", f"printf '%s' {json.dumps(quarantine)}")
    _command(fake_bin / "mdls", f"printf '%b' {json.dumps(origin)}")
    checksums_sha = hashlib.sha256(checksums.read_bytes()).hexdigest()
    _command(fake_bin / "shasum", f"""
if [[ "$3" == *.txt ]]; then echo '{checksums_sha}  $3'; else echo '{actual_sha}  $3'; fi
""")
    _command(fake_bin / "xcode-select", "echo /tmp/Xcode; exit 0" if xcode_selected else "exit 1")
    _command(fake_bin / "launchctl", "exit 0" if service_loaded else "exit 1")
    _command(fake_bin / "codesign", "exit 0")
    _command(fake_bin / "spctl", "exit 0")
    _command(fake_bin / "hdiutil", "exit 1")
    _command(fake_bin / "diskutil", "exit 1")
    _command(fake_bin / "plutil", "exit 1")
    _command(fake_bin / "readlink", "exec /usr/bin/readlink \"$@\"")
    _command(fake_bin / "mktemp", "exec /usr/bin/mktemp \"$@\"")
    _command(fake_bin / "stat", "exec /usr/bin/stat \"$@\"")
    if host_tool:
        _command(fake_bin / host_tool, "exit 0")

    system_root = tmp_path / "system-root"
    applications = system_root / "Applications"
    home = system_root / "Users" / "acceptance"
    applications.mkdir(parents=True, exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    if homebrew_directory:
        (system_root / "opt" / "homebrew").mkdir(parents=True, exist_ok=True)
    if xcode_app:
        (applications / "Xcode.app").mkdir(parents=True, exist_ok=True)
    if command_line_tools:
        (system_root / "Library" / "Developer" / "CommandLineTools").mkdir(parents=True, exist_ok=True)
    if system_file:
        direct_install = system_root / system_file.lstrip("/")
        direct_install.parent.mkdir(parents=True, exist_ok=True)
        direct_install.write_text("host executable")
        direct_install.chmod(0o755)
    if home_marker:
        (home / home_marker).mkdir(parents=True, exist_ok=True)
    harness_parent = tmp_path / "harness-delivery"
    harness_parent.mkdir(exist_ok=True)
    built_harness = harness_parent / "delivered-harness"
    if not built_harness.exists():
        built = subprocess.run(
            [
                "/bin/bash",
                str(ROOT / "packaging" / "acceptance" / "build_public_dmg_harness.sh"),
                "--policy-test",
                "--source-revision",
                "b" * 40,
                "--output",
                str(built_harness),
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        assert built.returncode == 0, built.stderr
    if harness_in_repo:
        checkout_parent = tmp_path / "harness-checkout"
        checkout_parent.mkdir(exist_ok=True)
        (checkout_parent / ".git").mkdir(exist_ok=True)
        harness = checkout_parent / "delivered-harness"
        if not harness.exists():
            shutil.copytree(built_harness, harness)
    else:
        harness = built_harness
    cwd = tmp_path / "target-cwd"
    cwd.mkdir(exist_ok=True)
    if cwd_in_repo:
        (cwd / ".git").mkdir(exist_ok=True)

    env = dict(os.environ)
    for variable in ("NVM_DIR", "PYENV_ROOT", "ASDF_DIR", "ASDF_DATA_DIR", "VIRTUAL_ENV", "CONDA_PREFIX", "NODE_PATH", "PYTHONPATH"):
        env.pop(variable, None)
    env.update({
        "PATH": str(fake_bin),
        "YULU_ACCEPTANCE_TEST_BIN": str(fake_bin),
        "YULU_ACCEPTANCE_TEST_SYSTEM_ROOT": str(system_root),
        "YULU_ACCEPTANCE_TEST_APPLICATIONS": str(applications),
        "YULU_ACCEPTANCE_TEST_HOME": str(home),
        "YULU_ACCEPTANCE_TEST_HARNESS": str(harness),
        "YULU_DURABLE_SYNC_POLICY_LOG": str(tmp_path / "sync.log"),
    })
    if activated_environment:
        env[activated_environment[0]] = activated_environment[1]
    arguments = [
            "/bin/bash",
            str(harness / "public_dmg_target.sh"),
            "--policy-test",
            "--scenario",
            scenario,
            "--tag",
            TAG,
            "--dmg",
            str(dmg),
            "--public-url",
            url,
            "--checksums",
            str(checksums),
            "--checksums-url",
            checksums_url,
            "--run-id",
            run_id,
            "--evidence-dir",
            str(evidence_dir or (tmp_path / "evidence")),
            "--preflight-only",
        ]
    if scenario == "upgrade":
        migration_before = tmp_path / "migration-before.json"
        migration_before.write_text('{"formalAcceptance":false}\n')
        migration_before.chmod(0o600)
        arguments.extend([
            "--upgrade-journey", upgrade_journey or "upgrade-success",
            "--migration-before", str(migration_before),
        ])
    return subprocess.run(
        arguments,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def _assert_failed(result: subprocess.CompletedProcess[str], message: str) -> None:
    assert result.returncode != 0, result.stdout
    assert message.lower() in result.stderr.lower(), result.stderr


def test_clean_public_preflight_is_green_but_never_formal_evidence(tmp_path: Path) -> None:
    result = _run(tmp_path)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "classification": "harness_policy_test",
        "formalAcceptance": False,
        "status": "passed",
    }
    _assert_failed(_run(tmp_path / "unsafe-run-id", run_id="../escape"), "run-id")
    evidence = json.loads((tmp_path / "evidence" / "slice1-policy" / "preflight.json").read_text())
    assert evidence == {
        "schema": 1,
        "formalAcceptance": False,
        "status": "passed",
        "scenario": "fresh",
        "releaseTag": TAG,
        "dmgSha256": hashlib.sha256(b"public dmg bytes").hexdigest(),
        "checksumsSha256": hashlib.sha256((f"{hashlib.sha256(b'public dmg bytes').hexdigest()}  {NAME}\n").encode()).hexdigest(),
        "dmgUrl": PUBLIC_URL,
        "checksumsUrl": CHECKSUMS_URL,
        "architecture": "arm64",
        "macOSVersion": "14.7.1",
        "browserProvenanceVerified": True,
        "hostDependenciesAbsent": True,
        "harnessBuildMode": "policy-test",
        "harnessManifestSha256": _file_sha(
            tmp_path / "harness-delivery" / "delivered-harness" / "manifest.sha256"
        ),
        "sourceRevision": "b" * 40,
    }
    sync_calls = (tmp_path / "sync.log").read_text().splitlines()
    ledger = tmp_path / "evidence" / "slice1-policy"
    assert len(sync_calls) == 4
    assert sync_calls[0].startswith(str(ledger / ".preflight.json."))
    assert sync_calls[1] == str(ledger)
    assert sync_calls[2].startswith(str(ledger / ".state."))
    assert sync_calls[3] == str(ledger)


def test_upgrade_preflight_allows_historical_host_dependencies_but_stays_non_formal(tmp_path: Path) -> None:
    result = _run(
        tmp_path,
        scenario="upgrade",
        upgrade_journey="upgrade-cancel-retry",
        host_tool="node",
        homebrew_directory=True,
        xcode_selected=True,
        xcode_app=True,
        command_line_tools=True,
    )
    assert result.returncode == 0, result.stderr
    evidence = json.loads((tmp_path / "evidence" / "slice1-policy" / "preflight.json").read_text())
    assert evidence["scenario"] == "upgrade"
    assert evidence["hostDependenciesAbsent"] is False
    assert evidence["formalAcceptance"] is False


def test_evidence_root_ledger_and_state_reject_unsafe_existing_nodes(tmp_path: Path) -> None:
    leaf = tmp_path / "leaf"
    leaf.mkdir()
    (leaf / "real-evidence").mkdir()
    (leaf / "evidence").symlink_to(leaf / "real-evidence")
    _assert_failed(_run(leaf, evidence_dir=leaf / "evidence"), "symlink")

    ancestor = tmp_path / "ancestor"
    ancestor.mkdir()
    (ancestor / "real-parent").mkdir()
    (ancestor / "linked-parent").symlink_to(ancestor / "real-parent")
    _assert_failed(_run(ancestor, evidence_dir=ancestor / "linked-parent" / "evidence"), "symlink")

    ledger_case = tmp_path / "ledger"
    (ledger_case / "evidence").mkdir(parents=True)
    (ledger_case / "evidence").chmod(0o700)
    (ledger_case / "elsewhere").mkdir()
    (ledger_case / "evidence" / "slice1-policy").symlink_to(ledger_case / "elsewhere")
    _assert_failed(_run(ledger_case), "ledger")

    ledger_file_case = tmp_path / "ledger-file"
    (ledger_file_case / "evidence").mkdir(parents=True)
    (ledger_file_case / "evidence").chmod(0o700)
    (ledger_file_case / "evidence" / "slice1-policy").write_text("not a ledger directory")
    _assert_failed(_run(ledger_file_case), "ledger")

    state_case = tmp_path / "state"
    assert _run(state_case).returncode == 0
    state = state_case / "evidence" / "slice1-policy" / "state"
    state.unlink()
    state.mkdir()
    _assert_failed(_run(state_case), "state")

    state_link_case = tmp_path / "state-link"
    assert _run(state_link_case).returncode == 0
    linked_state = state_link_case / "evidence" / "slice1-policy" / "state"
    linked_state.unlink()
    (state_link_case / "fake-state").write_text("untrusted")
    linked_state.symlink_to(state_link_case / "fake-state")
    _assert_failed(_run(state_link_case), "state")

    fixed_case = tmp_path / "fixed-temp"
    assert _run(fixed_case).returncode == 0
    victim = fixed_case / "victim"
    victim.write_text("do-not-overwrite")
    (fixed_case / "evidence" / "slice1-policy" / ".preflight.json.tmp").symlink_to(victim)
    _assert_failed(_run(fixed_case), "unsafe ledger")
    assert victim.read_text() == "do-not-overwrite"


def test_run_id_is_bound_to_exact_release_artifact(tmp_path: Path) -> None:
    assert _run(tmp_path).returncode == 0
    _assert_failed(_run(tmp_path, dmg_content=b"different public dmg"), "different artifact")


def test_formal_evidence_root_is_fixed_and_policy_bundle_cannot_enter_formal_mode(tmp_path: Path) -> None:
    prepared = _run(tmp_path)
    args = list(prepared.args)
    args.remove("--policy-test")
    result = subprocess.run(args, cwd=tmp_path / "target-cwd", text=True, capture_output=True, check=False)
    _assert_failed(result, "harness build mode")
    source = TARGET.read_text()
    assert '[[ -z "$EVIDENCE_DIR" ]] || fail "formal evidence directory is fixed and cannot be overridden"' in source
    assert 'Library/Application Support/Yulu Acceptance' in source


def test_public_preflight_accepts_github_release_asset_redirect_provenance(tmp_path: Path) -> None:
    origin = (
        '(\n    "https://release-assets.githubusercontent.com/github-production-release-asset/'
        '1223740140/rc5-fixture?download=1",\n'
        '    "https://github.com/Nowhitestar/Yulu/releases"\n)'
    )
    result = _run(tmp_path, origin=origin)
    assert result.returncode == 0, result.stderr


def test_public_input_fails_closed_for_local_url_quarantine_and_checksum(tmp_path: Path) -> None:
    _assert_failed(_run(tmp_path / "http", url="http://127.0.0.1/yulu.dmg"), "public release URL")
    _assert_failed(_run(tmp_path / "file", url="file:///tmp/yulu.dmg"), "public release URL")
    _assert_failed(
        _run(tmp_path / "checksums-file-url", checksums_url="file:///tmp/checksums.txt"),
        "public checksums URL",
    )
    _assert_failed(_run(tmp_path / "quarantine", quarantine=""), "quarantine")
    _assert_failed(_run(tmp_path / "quarantine-format", quarantine="present"), "quarantine format")
    _assert_failed(_run(tmp_path / "origin", origin="file:///tmp/yulu.dmg"), "browser provenance")
    _assert_failed(
        _run(
            tmp_path / "origin-lookalike",
            origin="https://release-assets.githubusercontent.com.evil.example/yulu.dmg",
        ),
        "browser provenance",
    )
    _assert_failed(
        _run(
            tmp_path / "origin-embedded",
            origin=(
                "https://evil.example/?next="
                "https://release-assets.githubusercontent.com/github-production-release-asset/fake"
            ),
        ),
        "browser provenance",
    )
    _assert_failed(_run(tmp_path / "checksum", checksum_rows=[f"{'0' * 64}  {NAME}"]), "checksum")


def test_checksum_manifest_and_download_are_exact_non_symlink_inputs(tmp_path: Path) -> None:
    _assert_failed(_run(tmp_path / "dmg-name", dmg_name="renamed.dmg"), "DMG filename")
    _assert_failed(_run(tmp_path / "checksums-name", checksums_name="renamed.txt"), "checksums filename")
    _assert_failed(_run(tmp_path / "dmg-link", dmg_symlink=True), "regular file")
    _assert_failed(_run(tmp_path / "checksums-link", checksums_symlink=True), "regular file")
    sha = hashlib.sha256(b"public dmg bytes").hexdigest()
    _assert_failed(
        _run(tmp_path / "duplicate-row", checksum_rows=[f"{sha}  {NAME}", f"{sha}  {NAME}"]),
        "unique",
    )
    _assert_failed(_run(tmp_path / "missing-row", checksum_rows=[f"{sha}  unrelated.zip"]), "unique")


def test_clean_target_fails_closed_for_checkout_platform_and_host_dependencies(tmp_path: Path) -> None:
    _assert_failed(_run(tmp_path / "checkout", cwd_in_repo=True), "checkout")
    _assert_failed(_run(tmp_path / "harness-checkout", harness_in_repo=True), "checkout")
    _assert_failed(_run(tmp_path / "intel", arch="x86_64"), "arm64")
    _assert_failed(_run(tmp_path / "macos13", version="13.6.9"), "macOS 13")
    for tool in ("brew", "node", "npm", "python3", "pip", "pip3"):
        _assert_failed(_run(tmp_path / tool, host_tool=tool), "host tool")
    _assert_failed(_run(tmp_path / "homebrew-dir", homebrew_directory=True), "Homebrew")
    _assert_failed(_run(tmp_path / "xcode", xcode_selected=True), "Xcode")
    _assert_failed(_run(tmp_path / "xcode-app", xcode_app=True), "Xcode")
    _assert_failed(_run(tmp_path / "clt", command_line_tools=True), "Command Line Tools")


def test_clean_target_detects_dependencies_hidden_from_path(tmp_path: Path) -> None:
    for path in (
        "/usr/local/bin/node",
        "/usr/local/bin/npm",
        "/usr/local/bin/python3",
        "/usr/local/bin/pip",
        "/usr/local/bin/pip3",
        "/opt/local/bin/node",
        "/opt/local/bin/python3",
        "/Library/Frameworks/Python.framework",
    ):
        _assert_failed(_run(tmp_path / path.strip("/").replace("/", "-"), system_file=path), "host dependency")
    for marker in (".nvm", ".pyenv", ".asdf", ".local/bin"):
        _assert_failed(_run(tmp_path / marker.replace("/", "-"), home_marker=marker), "host dependency")
    for variable in ("NVM_DIR", "PYENV_ROOT", "ASDF_DIR", "VIRTUAL_ENV", "CONDA_PREFIX", "NODE_PATH", "PYTHONPATH"):
        _assert_failed(
            _run(tmp_path / variable.lower(), activated_environment=(variable, "/hidden/runtime")),
            "activated environment",
        )


def test_clean_target_fails_closed_for_installed_files_data_and_services(tmp_path: Path) -> None:
    app_case = tmp_path / "app"
    clean = _run(app_case)
    assert clean.returncode == 0
    (app_case / "system-root" / "Applications" / "Yulu.app").mkdir()
    _assert_failed(_run(app_case), "existing Yulu installation")

    for relative in (
        ".config/yulu",
        "Library/Application Support/Yulu",
        "Movies/Yulu",
        "Library/LaunchAgents/com.yulu.ui.plist",
        "Library/LaunchAgents/com.yulu.audiodaemon.plist",
    ):
        case = tmp_path / relative.replace("/", "-").replace(" ", "-")
        clean = _run(case)
        assert clean.returncode == 0
        marker = case / "system-root" / "Users" / "acceptance" / relative
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.mkdir() if marker.suffix == "" else marker.write_text("installed")
        _assert_failed(_run(case), "existing Yulu data or service")

    _assert_failed(_run(tmp_path / "loaded-service", service_loaded=True), "existing Yulu data or service")


def test_target_source_cannot_manufacture_inputs_or_install_the_app() -> None:
    source = TARGET.read_text()
    for forbidden in ("xattr -w", "curl", "wget", "ditto", "cp -R", "osascript", '"formalAcceptance":true'):
        assert forbidden not in source


def _file_sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _make_fixture_app(app: Path, *, large_file_bytes: int = 0) -> None:
    node = app / "Contents" / "Resources" / "runtime" / "bin" / "node"
    node.parent.mkdir(parents=True)
    _command(node, f'exec {shutil.which("node")} "$@"')
    payload = app / "Contents" / "Resources" / "Host" / "payload.txt"
    payload.parent.mkdir(parents=True)
    payload.write_text("sealed runtime payload")
    fixed = (
        "Contents/MacOS/yulu_app",
        "Contents/Library/LaunchAgents/com.yulu.ui.plist",
        "Contents/Library/LaunchAgents/com.yulu.audiodaemon.plist",
        "Contents/MacOS/xai_keychain",
        "Contents/MacOS/calendar_probe",
        "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
        "Contents/Resources/Sparkle-LICENSE.txt",
    )
    for relative in fixed:
        candidate = app / relative
        candidate.parent.mkdir(parents=True, exist_ok=True)
        candidate.write_text(f"sealed {relative}")
        candidate.chmod(0o755 if "/MacOS/" in relative else 0o644)
    if large_file_bytes:
        large = app / "Contents" / "Resources" / "Host" / "large-runtime.bin"
        with large.open("wb") as target:
            target.seek(large_file_bytes - 1)
            target.write(b"\0")
    info = app / "Contents" / "Info.plist"
    info.write_text("""<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.yulu.app</string>
<key>CFBundleShortVersionString</key><string>0.23.0</string>
<key>YuluReleaseVersion</key><string>0.23.0-rc.5</string>
<key>CFBundleVersion</key><string>2304</string>
</dict></plist>
""")
    declared = []
    for root in (
        app / "Contents" / "Resources" / "runtime",
        app / "Contents" / "Resources" / "Host",
        app / "Contents" / "Frameworks",
    ):
        if root.exists():
            declared.extend(path for path in root.rglob("*") if path.is_file() or path.is_symlink())
    declared.extend(app / relative for relative in fixed)
    entries = []
    for candidate in sorted(set(declared), key=lambda path: path.relative_to(app).as_posix().encode()):
        relative = candidate.relative_to(app).as_posix()
        if candidate.is_symlink():
            entries.append({"path": relative, "type": "symlink", "mode": candidate.lstat().st_mode & 0o7777, "target": os.readlink(candidate)})
        elif relative == "Contents/MacOS/yulu_app":
            entries.append({"path": relative, "type": "outer-signed-main", "mode": candidate.stat().st_mode & 0o7777})
        else:
            entries.append({"path": relative, "type": "file", "mode": candidate.stat().st_mode & 0o7777, "sha256": _file_sha(candidate)})
    inventory = app / "Contents" / "Resources" / "application-runtime.json"
    inventory.write_text(json.dumps({
        "schema": 1,
        "architecture": "arm64",
        "versions": {"node": "test", "python": "test", "ffmpeg": "test", "sparkle": "test"},
        "files": entries,
    }))


def _run_flow(
    tmp_path: Path,
    *,
    team: str = "WMU9678ZQL",
    notarized: bool = True,
    volume: str = "Yulu",
    extra_layout: bool = False,
    alias_target: str = "/Applications",
    first_token: str = "I-SAW-DRAG-GUIDANCE",
    mutate_service: bool = False,
    copy_mismatch: bool = False,
    extra_runtime_file: bool = False,
    interrupt_and_resume: bool = False,
    completed_resume: bool = False,
    journey_base_url: str | None = None,
    interrupt_core_and_resume: bool = False,
    interrupt_production_and_resume: bool = False,
) -> tuple[subprocess.CompletedProcess[str], Path]:
    prepared = _run(tmp_path)
    assert prepared.returncode == 0, prepared.stderr
    fake_bin = tmp_path / "fake-bin"
    mount_source = tmp_path / "mount-source"
    mount_source.mkdir()
    _make_fixture_app(mount_source / "Yulu.app")
    if extra_runtime_file:
        (mount_source / "Yulu.app" / "Contents" / "Resources" / "runtime" / "unexpected.bin").write_text("not declared")
    (mount_source / "Applications").symlink_to(alias_target)
    if extra_layout:
        (mount_source / "unexpected.txt").write_text("unexpected")
    service_flag = tmp_path / "service-loaded"
    post_commit_flag = tmp_path / "post-commit-loaded"
    owner_generation = tmp_path / "owner-generation"
    owner_generation.write_text("4101 4102\n")
    current_capture_socket_path = (
        tmp_path / "system-root" / "Users" / "acceptance" / "Library" / "Caches" / "Yulu" / "audio_daemon.sock"
    )
    current_capture_socket_path.parent.mkdir(parents=True, exist_ok=True)
    short_socket_root = Path(tempfile.mkdtemp(prefix="ypc-", dir="/private/tmp"))
    (short_socket_root / "c").symlink_to(current_capture_socket_path.parent)
    current_capture_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    current_capture_socket.bind(str(short_socket_root / "c" / "audio_daemon.sock"))
    detach_log = tmp_path / "detach.log"
    _command(fake_bin / "codesign", """
if [[ "$*" == *"--display"* ]]; then
  echo "Authority=Developer ID Application: Yulu Test (${FAKE_TEAM})" >&2
  echo "TeamIdentifier=${FAKE_TEAM}" >&2
  echo "Identifier=com.yulu.fixture" >&2
  echo "CDHash=1111111111111111111111111111111111111111" >&2
fi
exit 0
""")
    _command(fake_bin / "spctl", """
if [[ "${FAKE_NOTARIZED}" == "1" ]]; then
  echo "accepted" >&2
  echo "source=Notarized Developer ID" >&2
  exit 0
fi
echo "rejected" >&2
echo "source=Unnotarized Developer ID" >&2
exit 1
""")
    _command(fake_bin / "hdiutil", """
if [[ "$1" == "attach" ]]; then
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "-mountpoint" ]]; then mountpoint="$2"; break; fi
    shift
  done
  /bin/cp -pR "${FAKE_MOUNT_SOURCE}/." "$mountpoint/"
  echo '<plist><dict><key>system-entities</key><array/></dict></plist>'
  exit 0
fi
mountpoint="${!#}"
/bin/rm -rf "$mountpoint"
echo detach >> "${FAKE_DETACH_LOG}"
exit 0
""")
    _command(fake_bin / "diskutil", "echo '<plist><dict><key>VolumeName</key><string>ignored</string></dict></plist>'")
    _command(fake_bin / "plutil", "printf '%s' \"${FAKE_VOLUME}\"")
    _command(fake_bin / "sync", "exit 0")
    installed_root = tmp_path / "system-root" / "Applications" / "Yulu.app"
    _command(fake_bin / "launchctl", f'''
if [[ -e {post_commit_flag} ]]; then
  read -r host_pid capture_pid < {owner_generation}
  case "$2" in
    */com.yulu.ui) printf 'pid = %s\n' "$host_pid"; exit 0 ;;
    */com.yulu.audiodaemon) printf 'pid = %s\n' "$capture_pid"; exit 0 ;;
    *) exit 113 ;;
  esac
fi
[[ -e "${{FAKE_SERVICE_FLAG}}" ]] && exit 0
exit 113
''')
    _command(fake_bin / "ps", f'''
read -r host_pid capture_pid < {owner_generation}
if [[ "$2" == "$host_pid" ]]; then
  printf '%s %s\n' {installed_root / "Contents/Resources/runtime/bin/node"} {installed_root / "Contents/Resources/Host/server.js"}
  exit 0
fi
if [[ "$2" == "$capture_pid" ]]; then
  printf '%s\n' {installed_root / "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon"}
  exit 0
fi
exit 1
''')
    _command(fake_bin / "lsof", f'''
read -r host_pid capture_pid < {owner_generation}
if [[ "$*" == *"-iTCP@127.0.0.1:7777"* ]]; then printf '%s\n' "$host_pid"; exit 0; fi
if [[ "$*" == *"{current_capture_socket_path}"* ]]; then printf '%s\n' "$capture_pid"; exit 0; fi
exit 1
''')

    harness = tmp_path / "harness-delivery" / "delivered-harness"
    env = dict(os.environ)
    for variable in ("NVM_DIR", "PYENV_ROOT", "ASDF_DIR", "ASDF_DATA_DIR", "VIRTUAL_ENV", "CONDA_PREFIX", "NODE_PATH", "PYTHONPATH"):
        env.pop(variable, None)
    env.update({
        "PATH": str(fake_bin),
        "YULU_ACCEPTANCE_TEST_BIN": str(fake_bin),
        "YULU_ACCEPTANCE_TEST_SYSTEM_ROOT": str(tmp_path / "system-root"),
        "YULU_ACCEPTANCE_TEST_APPLICATIONS": str(tmp_path / "system-root" / "Applications"),
        "YULU_ACCEPTANCE_TEST_HOME": str(tmp_path / "system-root" / "Users" / "acceptance"),
        "YULU_ACCEPTANCE_TEST_HARNESS": str(harness),
        "FAKE_TEAM": team,
        "FAKE_NOTARIZED": "1" if notarized else "0",
        "FAKE_VOLUME": volume,
        "FAKE_MOUNT_SOURCE": str(mount_source),
        "FAKE_DETACH_LOG": str(detach_log),
        "FAKE_SERVICE_FLAG": str(service_flag),
    })
    args = [
        "/bin/bash", str(harness / "public_dmg_target.sh"), "--policy-test", "--scenario", "fresh", "--tag", TAG,
        "--dmg", str(tmp_path / NAME), "--public-url", PUBLIC_URL,
        "--checksums", str(tmp_path / "checksums.txt"), "--checksums-url", CHECKSUMS_URL,
        "--run-id", "slice2-policy", "--evidence-dir", str(tmp_path / "evidence"),
    ]
    if journey_base_url is None:
        args.append("--policy-installation-only")
    else:
        args.extend(["--journey-base-url", journey_base_url])
    stdout: list[str] = []
    restarted = False
    restarted_core = False
    restarted_production = False
    while True:
        process = subprocess.Popen(
            args, cwd=tmp_path / "target-cwd", env=env, text=True,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        assert process.stdin is not None and process.stdout is not None
        restart_now = False
        while process.poll() is None:
            line = process.stdout.readline()
            if not line:
                break
            stdout.append(line)
            if line.startswith("ACTION_REQUIRED guidance "):
                if mutate_service:
                    service_flag.write_text("loaded")
                process.stdin.write(first_token + "\n")
                process.stdin.flush()
            elif line.startswith("ACTION_REQUIRED finder-drag "):
                if interrupt_and_resume and not restarted:
                    process.terminate()
                    restart_now = True
                    restarted = True
                    break
                installed = tmp_path / "system-root" / "Applications" / "Yulu.app"
                if not installed.exists():
                    shutil.copytree(mount_source / "Yulu.app", installed)
                    if copy_mismatch:
                        (installed / "Contents" / "Resources" / "Host" / "payload.txt").write_text("changed")
                process.stdin.write("I-DRAGGED-YULU-IN-FINDER\n")
                process.stdin.flush()
            elif line.startswith("ACTION_REQUIRED app-baseline "):
                process.stdin.write("I-STARTED-YULU\n")
                process.stdin.flush()
            elif line.startswith("ACTION_REQUIRED core-activation "):
                if interrupt_core_and_resume and not restarted_core:
                    process.terminate()
                    restart_now = True
                    restarted_core = True
                    break
                process.stdin.write("I-COMPLETED-CORE-ACTIVATION\n")
                process.stdin.flush()
            elif line.startswith("ACTION_REQUIRED optional-outcomes "):
                process.stdin.write("I-ADOPTED-OR-DEFERRED-FRESH-OPTIONAL-CAPABILITIES\n")
                process.stdin.flush()
            elif line.startswith("ACTION_REQUIRED test-share-configuration "):
                process.stdin.write("I-CONFIGURED-CLEAN-ACCEPTANCE-DESTINATION\n")
                process.stdin.flush()
            elif line.startswith("ACTION_REQUIRED test-share "):
                process.stdin.write("I-COMPLETED-TEST-SHARE\n")
                process.stdin.flush()
            elif line.startswith("ACTION_REQUIRED production-share-cancel "):
                process.stdin.write("I-CANCELLED-PRODUCTION-SHARE\n")
                process.stdin.flush()
            elif line.startswith("ACTION_REQUIRED production-share "):
                if interrupt_production_and_resume and not restarted_production:
                    process.terminate()
                    restart_now = True
                    restarted_production = True
                    break
                acceptance_home = tmp_path / "system-root" / "Users" / "acceptance"
                (acceptance_home / "Library" / "Application Support" / "Yulu").mkdir(parents=True, exist_ok=True)
                post_commit_flag.write_text("loaded\n")
                process.stdin.write("I-COMPLETED-ONE-PRODUCTION-SHARE\n")
                process.stdin.flush()
            elif line.startswith("ACTION_REQUIRED post-commit-restart-login "):
                owner_generation.write_text("4201 4202\n")
                process.stdin.write("I-QUIT-LOGGED-IN-AND-RELAUNCHED-YULU\n")
                process.stdin.flush()
            elif line.startswith("ACTION_REQUIRED check-for-updates-no-update "):
                process.stdin.write("I-SAW-NO-UPDATE-AVAILABLE-IN-YULU\n")
                process.stdin.flush()
        tail, stderr = process.communicate(timeout=10)
        stdout.append(tail)
        if restart_now:
            continue
        completed = subprocess.CompletedProcess(args, process.returncode, "".join(stdout), stderr)
        break
    if completed_resume and completed.returncode == 0:
        acceptance_home = tmp_path / "system-root" / "Users" / "acceptance"
        (acceptance_home / ".config" / "yulu").mkdir(parents=True, exist_ok=True)
        launch_agent = acceptance_home / "Library" / "LaunchAgents" / "com.yulu.ui.plist"
        launch_agent.parent.mkdir(parents=True, exist_ok=True)
        launch_agent.write_text("registered after successful installation")
        service_flag.write_text("loaded after successful installation")
        resumed = subprocess.run(
            args, cwd=tmp_path / "target-cwd", env=env, text=True,
            input="", capture_output=True, check=False,
        )
        completed = subprocess.CompletedProcess(args, resumed.returncode, completed.stdout + resumed.stdout, resumed.stderr)
    current_capture_socket.close()
    shutil.rmtree(short_socket_root)
    return completed, tmp_path / "evidence" / "slice2-policy"


def test_mount_and_operator_flow_records_private_resumable_evidence(tmp_path: Path) -> None:
    result, ledger = _run_flow(tmp_path)
    assert result.returncode == 0, result.stderr
    assert "formalAcceptance" not in result.stdout or '"formalAcceptance":false' in result.stdout
    assert (ledger.stat().st_mode & 0o777) == 0o700
    files = [path for path in ledger.iterdir() if path.is_file()]
    assert files
    assert all((path.stat().st_mode & 0o777) == 0o600 for path in files)
    observation = json.loads((ledger / "bundle-observation.json").read_text())
    assert observation["status"] == "matched"
    assert observation["formalAcceptance"] is False
    assert (tmp_path / "detach.log").read_text().strip() == "detach"


def test_mount_verification_fails_closed(tmp_path: Path) -> None:
    for name, kwargs, message in (
        ("team", {"team": "WRONGTEAM01"}, "Team ID"),
        ("notary", {"notarized": False}, "notarized"),
        ("volume", {"volume": "Wrong"}, "VolumeName"),
        ("layout", {"extra_layout": True}, "top-level layout"),
        ("alias", {"alias_target": "/tmp/Applications"}, "Applications alias"),
        ("token", {"first_token": "yes"}, "confirmation token"),
        ("service", {"mutate_service": True}, "service mutation"),
        ("copy", {"copy_mismatch": True}, "bundle digest"),
        ("extra-runtime", {"extra_runtime_file": True}, "inventory file set"),
    ):
        result, _ledger = _run_flow(tmp_path / name, **kwargs)
        _assert_failed(result, message)


def test_interrupted_and_completed_runs_resume_same_bound_artifact(tmp_path: Path) -> None:
    interrupted, ledger = _run_flow(tmp_path / "interrupted", interrupt_and_resume=True)
    assert interrupted.returncode == 0, interrupted.stderr
    assert "awaiting_finder_drag" not in (ledger / "state").read_text()
    resumed, _ = _run_flow(tmp_path / "completed", completed_resume=True)
    assert resumed.returncode == 0, resumed.stderr


def test_observer_uses_bounded_hashing_and_rejects_extra_inventory_files(tmp_path: Path) -> None:
    mounted = tmp_path / "mounted" / "Yulu.app"
    installed = tmp_path / "installed" / "Yulu.app"
    _make_fixture_app(mounted, large_file_bytes=12 * 1024 * 1024)
    shutil.copytree(mounted, installed)
    observer = ROOT / "packaging" / "acceptance" / "observe_product.mjs"
    result = subprocess.run(
        [str(installed / "Contents" / "Resources" / "runtime" / "bin" / "node"), str(observer),
         "--policy-test", "--mounted", str(mounted), "--installed", str(installed)],
        text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    evidence = json.loads(result.stdout)
    assert evidence["contents"]["bytes"] >= 12 * 1024 * 1024
    assert evidence["node"]["architecture"] == "arm64" or evidence["formalAcceptance"] is False
    source = observer.read_text()
    assert "readFileSync(candidate)" not in source
    assert "Buffer.compare" in source


def test_product_observer_binds_team_and_cdhash_across_checkpoints(tmp_path: Path) -> None:
    mounted = tmp_path / "mounted" / "Yulu.app"
    installed = tmp_path / "installed" / "Yulu.app"
    _make_fixture_app(mounted)
    shutil.copytree(mounted, installed)
    codesign = tmp_path / "codesign"
    _command(codesign, '''
if [[ "$*" == *"--display"* ]]; then
  printf 'Identifier=com.yulu.fixture\nTeamIdentifier=%s\nCDHash=%s\n' "${SIGN_TEAM}" "${SIGN_CDHASH}" >&2
fi
''')
    observer = ROOT / "packaging" / "acceptance" / "observe_product.mjs"

    def observe(cdhash: str, *, baseline: Path | None = None) -> subprocess.CompletedProcess[str]:
        args = [
            str(installed / "Contents" / "Resources" / "runtime" / "bin" / "node"), str(observer),
            "--policy-test", "--mounted", str(mounted), "--installed", str(installed),
            "--codesign", str(codesign),
        ]
        if baseline is not None:
            args.extend(["--baseline-evidence", str(baseline)])
        return subprocess.run(
            args, env={**os.environ, "SIGN_TEAM": "WMU9678ZQL", "SIGN_CDHASH": cdhash},
            text=True, capture_output=True, check=False,
        )

    first = observe("1" * 40)
    assert first.returncode == 0, first.stderr
    baseline = tmp_path / "bundle-baseline.json"
    baseline.write_text(first.stdout)
    baseline.chmod(0o600)
    unchanged = observe("1" * 40, baseline=baseline)
    assert unchanged.returncode == 0, unchanged.stderr
    _assert_failed(observe("2" * 40, baseline=baseline), "signatures changed")


def test_observer_has_no_network_or_mutation_surface() -> None:
    source = (ROOT / "packaging" / "acceptance" / "observe_product.mjs").read_text()
    for forbidden in ("fetch(", "/api/ui-token", "sharing.testShare", "recordings.shareRecording"):
        assert forbidden not in source


def test_post_commit_restart_and_no_update_contract_is_manual_resumable_and_read_only() -> None:
    driver = TARGET.read_text()
    observer = (ROOT / "packaging" / "acceptance" / "observe_post_commit.mjs").read_text()
    builder = (ROOT / "packaging" / "acceptance" / "build_public_dmg_harness.sh").read_text()
    launcher = (ROOT / "packaging" / "acceptance" / "launch_public_dmg_acceptance.sh").read_text()

    for checkpoint in (
        "post-commit-baseline",
        "post-commit-restart-login",
        "check-for-updates-no-update",
    ):
        assert checkpoint in driver
    for token in (
        "I-QUIT-LOGGED-IN-AND-RELAUNCHED-YULU",
        "I-SAW-NO-UPDATE-AVAILABLE-IN-YULU",
    ):
        assert token in driver
    for state in ("awaiting_restart_login", "awaiting_no_update", "completed"):
        assert state in driver
    for name in ("observe_post_commit.mjs",):
        assert name in builder
        assert name in launcher

    combined = driver + observer
    for forbidden in (
        "osascript",
        "open -a",
        "launchctl bootstrap",
        "launchctl bootout",
        "curl",
        "fetch(",
        "testShare",
        "shareRecording",
    ):
        assert forbidden not in combined
    assert 'formalAcceptance: false' in observer
    assert 'formalAcceptance: true' not in observer
    assert '"formalAcceptance":true' not in driver


def test_post_commit_observers_bind_bundle_signature_health_ipc_database_and_update_state() -> None:
    product = (ROOT / "packaging" / "acceptance" / "observe_product.mjs").read_text()
    journey = (ROOT / "packaging" / "acceptance" / "observe_journey.mjs").read_text()
    post_commit = (ROOT / "packaging" / "acceptance" / "observe_post_commit.mjs").read_text()

    for required in ("TeamIdentifier", "CDHash", "baseline-evidence", "signatures"):
        assert required in product
    for required in ("schemaVersion", "minimumReadableVersion", "ipc"):
        assert required in journey
    for required in (
        "application-update/journal.json",
        ".Yulu.rollback.",
        ".Yulu.failed.",
        "bundleContentsSha256",
        "runtimeInventorySha256",
        "hostPidSha256",
        "capturePidSha256",
        "journalSha256",
        "standardRootsOnly",
    ):
        assert required in post_commit


def test_post_commit_owner_evidence_binds_tcp_and_current_capture_socket_to_launchd_pids() -> None:
    source = (ROOT / "packaging" / "acceptance" / "observe_post_commit.mjs").read_text()
    for required in (
        "127.0.0.1:7777",
        "Library/Caches/Yulu/audio_daemon.sock",
        ".config/yulu/audio_daemon.sock",
        '"/usr/sbin/lsof"',
        "hostListenerOwnerPidSha256",
        "captureSocketOwnerPidSha256",
    ):
        assert required in source
    for forbidden in ("launchctl bootstrap", "launchctl bootout", "security -g", "security -w"):
        assert forbidden not in source


def test_post_commit_observer_proves_new_restart_generation_and_stable_no_update_state(tmp_path: Path, request: object) -> None:
    applications = tmp_path / "Applications"
    installed = applications / "Yulu.app"
    _make_fixture_app(installed)
    # Darwin limits AF_UNIX addresses to 104 bytes. Pytest's per-test path can
    # exceed that before the canonical Yulu socket suffix is appended.
    short_root = Path(tempfile.mkdtemp(prefix="ypc.", dir="/private/tmp"))
    request.addfinalizer(lambda: shutil.rmtree(short_root, ignore_errors=True))
    home = short_root / "home"
    standard_root = home / "Library" / "Application Support" / "Yulu"
    standard_root.mkdir(parents=True)
    capture_socket_path = home / "Library" / "Caches" / "Yulu" / "audio_daemon.sock"
    capture_socket_path.parent.mkdir(parents=True)
    capture_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    request.addfinalizer(capture_socket.close)
    capture_socket.bind(str(capture_socket_path))
    system_bin = tmp_path / "system-bin"
    system_bin.mkdir()
    generation = tmp_path / "generation"
    generation.write_text("4101 4102\n")
    host = installed / "Contents" / "Resources" / "runtime" / "bin" / "node"
    server = installed / "Contents" / "Resources" / "Host" / "server.js"
    server.write_text("fixture server")
    capture = installed / "Contents" / "Helpers" / "YuluCapture.app" / "Contents" / "MacOS" / "audio_daemon"
    _command(system_bin / "launchctl", f'''
read -r host_pid capture_pid < {generation}
case "$2" in
  */com.yulu.ui) printf 'pid = %s\n' "$host_pid" ;;
  */com.yulu.audiodaemon) printf 'pid = %s\n' "$capture_pid" ;;
  *) exit 113 ;;
esac
''')
    _command(system_bin / "ps", f'''
read -r host_pid capture_pid < {generation}
if [[ "$2" == "$host_pid" ]]; then printf '%s %s\n' {host} {server}; exit 0; fi
if [[ "$2" == "$capture_pid" ]]; then printf '%s\n' {capture}; exit 0; fi
exit 1
''')
    _command(system_bin / "lsof", f'''
read -r host_pid capture_pid < {generation}
if [[ "$*" == *"-iTCP@127.0.0.1:7777"* ]]; then printf '%s\n' "$host_pid"; exit 0; fi
if [[ "$*" == *"{capture_socket_path}"* ]]; then printf '%s\n' "$capture_pid"; exit 0; fi
exit 1
''')

    preflight = tmp_path / "preflight.json"
    bundle = tmp_path / "bundle.json"
    journey = tmp_path / "journey.json"
    for path, value in (
        (preflight, {
            "schema": 1, "formalAcceptance": False, "status": "passed", "scenario": "fresh",
            "releaseTag": TAG, "harnessManifestSha256": "1" * 64, "sourceRevision": "2" * 40,
        }),
        (bundle, {
            "schema": 1, "formalAcceptance": False, "status": "matched",
            "release": {"releaseVersion": TAG.removeprefix("v")},
            "contents": {"sha256": "3" * 64}, "runtimeInventory": {"sha256": "4" * 64},
            "signatures": {
                "application": {"teamIdentifier": "WMU9678ZQL", "cdHash": "5" * 40, "identifier": "com.yulu.app"},
                "host": {"teamIdentifier": "WMU9678ZQL", "cdHash": "6" * 40, "identifier": "com.yulu.host"},
                "capture": {"teamIdentifier": "WMU9678ZQL", "cdHash": "7" * 40, "identifier": "com.yulu.capture"},
            },
        }),
        (journey, {
            "schema": 1, "formalAcceptance": False, "checkpoint": "production-share", "releaseTag": TAG,
            "health": {
                "status": "ok", "serviceOwner": "com.yulu.ui", "databaseStatus": "ok",
                "database": {"schemaVersion": 1, "minimumReadableVersion": 1},
            },
            "version": {"product": TAG.removeprefix("v"), "bundle": "2304"},
            "ipc": {"transport": "ipv4-loopback-http", "readOnly": True},
            "productionShare": {"actionCounts": {"total": 1, "verified": 1}},
        }),
    ):
        path.write_text(json.dumps(value, separators=(",", ":")) + "\n")
        path.chmod(0o600)

    observer = ROOT / "packaging" / "acceptance" / "observe_post_commit.mjs"

    def run(checkpoint: str, *, prior: Path | None = None) -> subprocess.CompletedProcess[str]:
        args = [
            "node", str(observer), "--policy-test", "--checkpoint", checkpoint,
            "--scenario", "fresh", "--release-tag", TAG, "--preflight", str(preflight),
            "--bundle", str(bundle), "--journey", str(journey), "--installed-app", str(installed),
            "--home", str(home), "--applications-root", str(applications), "--system-bin", str(system_bin),
        ]
        if prior is not None:
            args.extend(["--prior-evidence", str(prior)])
        if checkpoint == "post-commit-restart-login":
            args.append("--operator-restart-login-confirmed")
        if checkpoint == "check-for-updates-no-update":
            args.append("--operator-no-update-confirmed")
        return subprocess.run(args, text=True, capture_output=True, check=False)

    baseline_result = run("post-commit-baseline")
    assert baseline_result.returncode == 0, baseline_result.stderr
    baseline = tmp_path / "post-commit-baseline.json"
    baseline.write_text(baseline_result.stdout)
    baseline.chmod(0o600)

    generation.write_text("4201 4202\n")
    restart_result = run("post-commit-restart-login", prior=baseline)
    assert restart_result.returncode == 0, restart_result.stderr
    restart = tmp_path / "post-commit-restart-login.json"
    restart.write_text(restart_result.stdout)
    restart.chmod(0o600)
    assert json.loads(restart_result.stdout)["operatorAttestation"]["restartLogin"] is True

    no_update = run("check-for-updates-no-update", prior=restart)
    assert no_update.returncode == 0, no_update.stderr
    evidence = json.loads(no_update.stdout)
    assert evidence["applicationUpdate"] == {
        "journalPresent": False, "journalSha256": None, "applicationResidues": 0,
    }
    assert evidence["limitation"].startswith("The App exposes no reliable read-only API")

    update_dir = standard_root / "application-update"
    update_dir.mkdir()
    update_journal = update_dir / "journal.json"
    update_journal.write_text('{"phase":"staging"}\n')
    update_journal.chmod(0o600)
    drifted = run("check-for-updates-no-update", prior=restart)
    _assert_failed(drifted, "update binding drifted")
    update_journal.unlink()
    (applications / ".Yulu.rollback.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.app").mkdir()
    residue = run("check-for-updates-no-update", prior=restart)
    _assert_failed(residue, "residue")
    capture_socket.close()
