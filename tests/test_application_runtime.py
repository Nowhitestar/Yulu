import hashlib
import io
import json
import os
import subprocess
import tarfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PREPARE = ROOT / "packaging" / "scripts" / "prepare_application_runtime.sh"
VERIFY = ROOT / "packaging" / "scripts" / "verify_application_runtime.sh"
SMOKE = ROOT / "yulu" / "scripts" / "smoke_yulu_app.sh"
SHELL_SOURCE = ROOT / "yulu" / "scripts" / "yulu_app.swift"
VALIDATE_ARCHIVE = ROOT / "packaging" / "scripts" / "validate_runtime_archive.py"


def write(path: Path, content: bytes = b"fixture\n", *, executable: bool = False) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    if executable:
        path.chmod(0o755)
    return path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def archive(source: Path, destination: Path, root_name: str) -> Path:
    with tarfile.open(destination, "w:gz") as bundle:
        bundle.add(source, arcname=root_name)
    return destination


def runtime_fixture(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    app = tmp_path / "Yulu.app"
    contents = app / "Contents"
    for relative in (
        "MacOS/yulu_app",
        "MacOS/xai_keychain",
        "MacOS/calendar_probe",
        "Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
    ):
        write(contents / relative, executable=True)

    node_root = tmp_path / "node-vtest-darwin-arm64"
    write(node_root / "bin/node", b"node-arm64\n", executable=True)
    write(node_root / "LICENSE", b"node license\n")
    node_archive = archive(node_root, tmp_path / "node.tar.gz", node_root.name)

    python_root = tmp_path / "python"
    write(python_root / "bin/python3", b"python-arm64\n", executable=True)
    write(python_root / "lib/python3.13/os.py", b"# stdlib\n")
    python_archive = archive(python_root, tmp_path / "python.tar.gz", "python")

    ffmpeg = write(tmp_path / "ffmpeg", b"ffmpeg-arm64\n", executable=True)
    ffmpeg_license = write(tmp_path / "ffmpeg.LICENSE", b"ffmpeg license\n")

    scripts = tmp_path / "scripts"
    write(scripts / "record_audio.py", b"print('record')\n")
    write(scripts / "search/cli.py", b"print('search')\n")
    write(scripts / "config.example.json", b"{}\n")
    write(
        scripts / "local_caption_runtime_pack.json",
        json.dumps(
            {
                "schema": 1,
                "architecture": "arm64",
                "pythonAbi": "cp313",
                "assetUrlTemplate": "https://example.invalid/{tag}/pack.zip",
                "wheels": [{"sha256": "0" * 64}],
            }
        ).encode(),
    )
    write(scripts / "local-caption-model.bin", b"must not ship\n")

    ui = tmp_path / "ui"
    write(ui / "dist/server.js", b"server\n")
    write(ui / "dist/web/index.html", b"web\n")
    for dependency in ("better-sqlite3", "bindings", "file-uri-to-path"):
        write(ui / f"node_modules/{dependency}/package.json", b"{}\n")
    write(
        ui / "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
        b"native-arm64\n",
    )

    lock = {
        "schema": 1,
        "node": {"version": "test-node", "sha256": sha256(node_archive)},
        "python": {"version": "test-python", "sha256": sha256(python_archive)},
        "ffmpeg": {"version": "test-ffmpeg", "sha256": sha256(ffmpeg)},
        "ffmpegLicense": {"sha256": sha256(ffmpeg_license)},
    }
    lock_path = tmp_path / "runtime-lock.json"
    lock_path.write_text(json.dumps(lock), encoding="utf-8")
    return app, {
        "YULU_RUNTIME_LOCK": str(lock_path),
        "YULU_NODE_ARCHIVE": str(node_archive),
        "YULU_PYTHON_ARCHIVE": str(python_archive),
        "YULU_FFMPEG_BINARY": str(ffmpeg),
        "YULU_FFMPEG_LICENSE": str(ffmpeg_license),
        "YULU_RUNTIME_SCRIPT_SOURCE": str(scripts),
        "YULU_RUNTIME_UI_SOURCE": str(ui),
    }


def fake_verification_tools(tmp_path: Path) -> dict[str, str]:
    file_tool = write(
        tmp_path / "tools/file",
        b"#!/usr/bin/env bash\necho 'Mach-O 64-bit executable arm64'\n",
        executable=True,
    )
    lipo_tool = write(
        tmp_path / "tools/lipo",
        b"#!/usr/bin/env bash\n"
        b"target=${@: -1}\n"
        b"if grep -q x86_64 \"$target\"; then echo x86_64; else echo arm64; fi\n",
        executable=True,
    )
    codesign_tool = write(
        tmp_path / "tools/codesign",
        b"#!/usr/bin/env bash\n"
        b"if [[ $* == *'--entitlements'* ]]; then\n"
        b"  echo '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>'\n"
        b"  exit 0\n"
        b"elif [[ $* == *'--verbose=2'* ]]; then\n"
        b"  echo 'Signature=adhoc'\n"
        b"  echo 'TeamIdentifier=not set'\n"
        b"  exit 0\n"
        b"fi\n"
        b"target=${@: -1}\n"
        b"if grep -q unsigned \"$target\"; then exit 1; fi\n"
        b"exit 0\n",
        executable=True,
    )
    return {
        "YULU_VERIFY_FILE": str(file_tool),
        "YULU_VERIFY_LIPO": str(lipo_tool),
        "YULU_VERIFY_CODESIGN": str(codesign_tool),
        "YULU_SKIP_RUNTIME_EXECUTION": "1",
    }


def test_prepare_application_runtime_stages_only_core_runtime_and_production_host(tmp_path: Path):
    app, overrides = runtime_fixture(tmp_path)

    result = subprocess.run(
        ["bash", str(PREPARE), str(app)],
        env={**os.environ, **overrides},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    resources = app / "Contents/Resources"
    assert (resources / "runtime/bin/node").read_bytes() == b"node-arm64\n"
    assert (resources / "runtime/python/bin/python3").read_bytes() == b"python-arm64\n"
    assert (resources / "runtime/bin/ffmpeg").read_bytes() == b"ffmpeg-arm64\n"
    assert (resources / "runtime/licenses/node.txt").read_bytes() == b"node license\n"
    assert (resources / "runtime/licenses/ffmpeg.txt").read_bytes() == b"ffmpeg license\n"
    assert (resources / "Host/server.js").read_bytes() == b"server\n"
    assert (resources / "Host/web/index.html").read_bytes() == b"web\n"
    assert (resources / "Host/node_modules/better-sqlite3/package.json").is_file()
    assert (resources / "Host/node_modules/bindings/package.json").is_file()
    assert (resources / "Host/node_modules/file-uri-to-path/package.json").is_file()
    assert (resources / "runtime/yulu/scripts/record_audio.py").is_file()
    assert (resources / "runtime/yulu/scripts/search/cli.py").is_file()
    assert (resources / "runtime/yulu/scripts/local_caption_runtime_pack.json").is_file()
    assert not (resources / "runtime/yulu/scripts/local-caption-model.bin").exists()
    assert not any(path.name.endswith(".onnx") for path in resources.rglob("*"))


def test_application_runtime_inventory_fails_closed_for_missing_wrong_arch_unsigned_and_changed_files(
    tmp_path: Path,
):
    app, overrides = runtime_fixture(tmp_path)
    prepared = subprocess.run(
        ["bash", str(PREPARE), str(app)],
        env={**os.environ, **overrides},
        capture_output=True,
        text=True,
        check=False,
    )
    assert prepared.returncode == 0, prepared.stderr + prepared.stdout
    verify_env = {**os.environ, **fake_verification_tools(tmp_path)}

    inventoried = subprocess.run(
        ["bash", str(VERIFY), "--write-inventory", str(app)],
        env=verify_env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert inventoried.returncode == 0, inventoried.stderr + inventoried.stdout
    inventory = app / "Contents/Resources/application-runtime.json"
    assert inventory.is_file()
    inventory_payload = json.loads(inventory.read_text(encoding="utf-8"))
    shell_entry = next(
        entry
        for entry in inventory_payload["files"]
        if entry["path"] == "Contents/MacOS/yulu_app"
    )
    assert shell_entry == {
        "mode": 0o755,
        "path": "Contents/MacOS/yulu_app",
        "type": "outer-signed-main",
    }

    verified = subprocess.run(
        ["bash", str(VERIFY), str(app)],
        env=verify_env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert verified.returncode == 0, verified.stderr + verified.stdout

    node = app / "Contents/Resources/runtime/bin/node"
    original_node = node.read_bytes()
    node.unlink()
    missing = subprocess.run(
        ["bash", str(VERIFY), str(app)], env=verify_env, capture_output=True, text=True, check=False
    )
    assert missing.returncode != 0
    assert "required Application Runtime file missing" in missing.stderr

    node.write_bytes(b"x86_64\n")
    node.chmod(0o755)
    wrong_arch = subprocess.run(
        ["bash", str(VERIFY), str(app)], env=verify_env, capture_output=True, text=True, check=False
    )
    assert wrong_arch.returncode != 0
    assert "must be arm64 only" in wrong_arch.stderr

    node.write_bytes(b"unsigned arm64\n")
    unsigned = subprocess.run(
        ["bash", str(VERIFY), str(app)], env=verify_env, capture_output=True, text=True, check=False
    )
    assert unsigned.returncode != 0
    assert "signature invalid" in unsigned.stderr

    node.write_bytes(original_node)
    node.chmod(0o755)
    host = app / "Contents/Resources/Host/server.js"
    host.write_text("changed after inventory\n", encoding="utf-8")
    changed = subprocess.run(
        ["bash", str(VERIFY), str(app)], env=verify_env, capture_output=True, text=True, check=False
    )
    assert changed.returncode != 0
    assert "inventory hash mismatch" in changed.stderr


def test_host_runtime_denied_smoke_proves_host_capture_and_bundle_immutability():
    smoke = SMOKE.read_text(encoding="utf-8")
    shell = SHELL_SOURCE.read_text(encoding="utf-8")

    assert "YULU_BUNDLE_APPLICATION_RUNTIME=1" in smoke
    assert "denied-host-runtime" in smoke
    assert "YULU_FORBIDDEN_RUNTIME_LOG" in smoke
    assert "NODE_OPTIONS" in smoke
    assert "YULU_LOCAL_CAPTION_PYTHON" in smoke
    assert "hostile-runtime.log" in smoke
    for command in ("node", "python3", "ffmpeg", "npm", "pip", "brew", "swiftc"):
        assert command in smoke
    assert '[[ ! -s "$SMOKE_ROOT/forbidden-runtime.log" ]]' in smoke
    assert "YULU_DEV_NODE" not in smoke
    assert "application-runtime.before.sha256" in smoke
    assert "application-runtime.after.sha256" in smoke
    assert "diff -u" in smoke
    assert "runCaptureSelfTest" in shell
    assert "layout.hostNode" in shell
    assert "layout.bundledPythonBin.path" in shell
    assert "sanitizedRuntimeEnvironment()" in shell
    assert 'hostEnvironment = sanitizedRuntimeEnvironment()' in shell
    assert 'captureEnvironment = sanitizedRuntimeEnvironment()' in shell
    for dangerous in (
        'key == "NODE_OPTIONS"',
        'key == "NODE_PATH"',
        'key.hasPrefix("PYTHON")',
        'key.hasPrefix("DYLD_")',
        'key.hasPrefix("YULU_DEV_")',
        'key.hasPrefix("YULU_LOCAL_CAPTION_")',
    ):
        assert dangerous in shell
    assert "hostReady" in shell
    assert "captureReady" in shell


def test_release_builds_signs_and_uploads_versioned_optional_runtime_pack():
    workflow = (ROOT / ".github/workflows/release-publish.yml").read_text(encoding="utf-8")
    signer = (ROOT / "packaging/scripts/sign_and_notarize.sh").read_text(encoding="utf-8")
    pack_builder = ROOT / "packaging/scripts/build_local_caption_runtime_pack.py"
    definition = ROOT / "yulu/scripts/local_caption_runtime_pack.json"

    assert pack_builder.is_file()
    assert definition.is_file()
    assert "build_local_caption_runtime_pack.py" in signer
    assert "yulu-local-caption-runtime-macos-arm64-$TAG.zip" in workflow
    assert "yulu-local-caption-runtime-macos-arm64-$TAG.zip" in signer


def test_runtime_archive_validator_rejects_traversal_links_hardlinks_and_special_files(tmp_path):
    cases = (
        ("traversal", tarfile.REGTYPE, "../../escape", ""),
        ("escaping-symlink", tarfile.SYMTYPE, "runtime/link", "../../../escape"),
        ("hardlink", tarfile.LNKTYPE, "runtime/hard", "runtime/file"),
        ("fifo", tarfile.FIFOTYPE, "runtime/fifo", ""),
    )
    for name, entry_type, member_name, link_name in cases:
        archive_path = tmp_path / f"{name}.tar.gz"
        with tarfile.open(archive_path, "w:gz") as bundle:
            entry = tarfile.TarInfo(member_name)
            entry.type = entry_type
            entry.linkname = link_name
            entry.size = 0
            bundle.addfile(entry)
        result = subprocess.run(
            ["python3", str(VALIDATE_ARCHIVE), str(archive_path)],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode != 0, name


def test_runtime_archive_validator_accepts_regular_files_and_contained_symlinks(tmp_path):
    archive_path = tmp_path / "safe.tar.gz"
    with tarfile.open(archive_path, "w:gz") as bundle:
        directory = tarfile.TarInfo("runtime/bin")
        directory.type = tarfile.DIRTYPE
        bundle.addfile(directory)
        executable = tarfile.TarInfo("runtime/bin/python3.13")
        executable.size = len(b"python")
        bundle.addfile(executable, fileobj=io.BytesIO(b"python"))
        link = tarfile.TarInfo("runtime/bin/python3")
        link.type = tarfile.SYMTYPE
        link.linkname = "python3.13"
        bundle.addfile(link)

    result = subprocess.run(
        ["python3", str(VALIDATE_ARCHIVE), str(archive_path)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def test_runtime_archive_validator_rejects_members_beneath_symlinked_parents(tmp_path):
    archive_path = tmp_path / "composed-symlink-escape.tar.gz"
    with tarfile.open(archive_path, "w:gz") as bundle:
        first = tarfile.TarInfo("deep/a")
        first.type = tarfile.SYMTYPE
        first.linkname = ".."
        bundle.addfile(first)
        second = tarfile.TarInfo("deep/a/b")
        second.type = tarfile.SYMTYPE
        second.linkname = "../outside"
        bundle.addfile(second)
        payload = tarfile.TarInfo("deep/a/b/payload")
        payload.size = len(b"escape")
        bundle.addfile(payload, fileobj=io.BytesIO(b"escape"))

    result = subprocess.run(
        ["python3", str(VALIDATE_ARCHIVE), str(archive_path)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0


def test_prepare_validates_every_downloaded_archive_before_extraction():
    prepare = PREPARE.read_text(encoding="utf-8")

    for archive_name, extraction in (
        ("$FFMPEG_SOURCE", 'tar -xf "$FFMPEG_SOURCE"'),
        ("$NODE_ARCHIVE", 'tar -xzf "$NODE_ARCHIVE"'),
        ("$PYTHON_ARCHIVE", 'tar -xzf "$PYTHON_ARCHIVE"'),
    ):
        validation = f'validate_archive "{archive_name}"'
        assert validation in prepare
        assert prepare.index(validation) < prepare.index(extraction)


def test_optional_runtime_install_uses_only_bundled_python_and_never_pip_or_venv():
    manager = (ROOT / "yulu/scripts/yulu_ui/src/localCaptionManager.ts").read_text(encoding="utf-8")
    engine = (ROOT / "yulu/scripts/yulu_ui/src/localCaptionEngine.ts").read_text(encoding="utf-8")
    installer = (ROOT / "yulu/scripts/local_caption_runtime.py").read_text(encoding="utf-8")

    assert "/opt/homebrew/bin/python3" not in manager
    assert "/usr/local/bin/python3" not in manager
    assert 'return "python3"' not in manager
    assert '"local-caption", "venv"' not in engine
    assert '"-m", "venv"' not in installer
    assert '"install", "--disable-pip-version-check"' not in installer


def test_application_runtime_verifier_checks_required_macho_symlink_targets(tmp_path: Path):
    app, overrides = runtime_fixture(tmp_path)
    prepared = subprocess.run(
        ["bash", str(PREPARE), str(app)],
        env={**os.environ, **overrides},
        capture_output=True,
        text=True,
        check=False,
    )
    assert prepared.returncode == 0, prepared.stderr + prepared.stdout
    python3 = app / "Contents/Resources/runtime/python/bin/python3"
    python313 = python3.with_name("python3.13")
    python3.rename(python313)
    python3.symlink_to("python3.13")
    tools = fake_verification_tools(tmp_path)
    file_tool = Path(tools["YULU_VERIFY_FILE"])
    file_tool.write_text(
        "#!/usr/bin/env bash\n"
        "target=${@: -1}\n"
        "if [[ -L $target || $target == *python3.13 ]]; then echo data; else echo 'Mach-O 64-bit executable arm64'; fi\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        ["bash", str(VERIFY), "--write-inventory", str(app)],
        env={**os.environ, **tools},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "required Application Runtime code is not Mach-O" in result.stderr


def test_application_runtime_verifier_rejects_hardened_node_without_jit_entitlement(
    tmp_path: Path,
):
    app, overrides = runtime_fixture(tmp_path)
    prepared = subprocess.run(
        ["bash", str(PREPARE), str(app)],
        env={**os.environ, **overrides},
        capture_output=True,
        text=True,
        check=False,
    )
    assert prepared.returncode == 0, prepared.stderr + prepared.stdout
    tools = fake_verification_tools(tmp_path)
    codesign_tool = Path(tools["YULU_VERIFY_CODESIGN"])
    codesign_tool.write_text(
        "#!/usr/bin/env bash\n"
        "if [[ $* == *'--entitlements'* ]]; then\n"
        "  echo '<plist><dict></dict></plist>'\n"
        "elif [[ $* == *'--verbose=2'* ]]; then\n"
        "  echo 'Signature=adhoc'\n"
        "  echo 'TeamIdentifier=not set'\n"
        "fi\n"
        "exit 0\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        ["bash", str(VERIFY), "--write-inventory", str(app)],
        env={**os.environ, **tools},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "bundled Node is missing its required JIT entitlement" in result.stderr


def test_application_runtime_verifier_rejects_ad_hoc_node_that_cannot_load_native_addons(
    tmp_path: Path,
):
    app, overrides = runtime_fixture(tmp_path)
    prepared = subprocess.run(
        ["bash", str(PREPARE), str(app)],
        env={**os.environ, **overrides},
        capture_output=True,
        text=True,
        check=False,
    )
    assert prepared.returncode == 0, prepared.stderr + prepared.stdout
    tools = fake_verification_tools(tmp_path)
    codesign_tool = Path(tools["YULU_VERIFY_CODESIGN"])
    codesign_tool.write_text(
        "#!/usr/bin/env bash\n"
        "if [[ $* == *'--entitlements'* ]]; then\n"
        "  echo '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>'\n"
        "elif [[ $* == *'--verbose=2'* ]]; then\n"
        "  echo 'Signature=adhoc'\n"
        "  echo 'TeamIdentifier=not set'\n"
        "fi\n"
        "exit 0\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        ["bash", str(VERIFY), "--write-inventory", str(app)],
        env={**os.environ, **tools},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "bundled Node cannot load signed native addons" in result.stderr


def test_application_runtime_verifier_rejects_library_validation_bypass_for_team_signed_node(
    tmp_path: Path,
):
    app, overrides = runtime_fixture(tmp_path)
    prepared = subprocess.run(
        ["bash", str(PREPARE), str(app)],
        env={**os.environ, **overrides},
        capture_output=True,
        text=True,
        check=False,
    )
    assert prepared.returncode == 0, prepared.stderr + prepared.stdout
    tools = fake_verification_tools(tmp_path)
    codesign_tool = Path(tools["YULU_VERIFY_CODESIGN"])
    codesign_tool.write_text(
        "#!/usr/bin/env bash\n"
        "if [[ $* == *'--entitlements'* ]]; then\n"
        "  echo '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>'\n"
        "elif [[ $* == *'--verbose=2'* ]]; then\n"
        "  echo 'Signature=Developer ID'\n"
        "  echo 'TeamIdentifier=WMU9678ZQL'\n"
        "fi\n"
        "exit 0\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        ["bash", str(VERIFY), "--write-inventory", str(app)],
        env={**os.environ, **tools},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "team-signed Node must enforce library validation" in result.stderr


def test_release_pipeline_builds_and_rechecks_the_locked_application_runtime():
    signing = (ROOT / "packaging/scripts/sign_and_notarize.sh").read_text(encoding="utf-8")
    workflow = (ROOT / ".github/workflows/release-publish.yml").read_text(encoding="utf-8")
    package = (ROOT / "packaging/scripts/package.sh").read_text(encoding="utf-8")

    assert "YULU_BUNDLE_APPLICATION_RUNTIME=1" in signing
    manifest_resign = signing.split("# The build script signed Yulu.app", 1)[1]
    assert "verify_application_runtime.sh" in manifest_resign
    assert "prepare_application_runtime.sh" in workflow
    assert "verify_application_runtime.sh" in workflow
    assert "packaging/runtime-lock.json" in workflow
    assert '"yulu/scripts/yulu_ui/node_modules"' in package
    assert '\n    "node_modules"\n' not in package


def test_application_runtime_exec_probes_exact_versions_and_native_addon_abi(tmp_path: Path):
    app, overrides = runtime_fixture(tmp_path)
    prepared = subprocess.run(
        ["bash", str(PREPARE), str(app)],
        env={**os.environ, **overrides},
        capture_output=True,
        text=True,
        check=False,
    )
    assert prepared.returncode == 0, prepared.stderr + prepared.stdout
    runtime = app / "Contents/Resources/runtime"
    write(
        runtime / "bin/node",
        b"#!/usr/bin/env bash\n"
        b"if [[ ${1:-} == --version ]]; then echo vtest-node; exit 0; fi\n"
        b"if [[ ${YULU_FIXTURE_NODE_ABI_FAIL:-0} == 1 ]]; then exit 72; fi\n"
        b"exit 0\n",
        executable=True,
    )
    write(
        runtime / "python/bin/python3",
        b"#!/usr/bin/env bash\n"
        b"prefix=$(cd \"$(dirname \"$0\")/..\" && pwd)\n"
        b"echo \"arm64|test-python|$prefix\"\n",
        executable=True,
    )
    write(
        runtime / "bin/ffmpeg",
        b"#!/usr/bin/env bash\n"
        b"echo 'ffmpeg version test-ffmpeg'\n"
        b"yes 'configuration detail'\n",
        executable=True,
    )
    tools = fake_verification_tools(tmp_path)
    tools.pop("YULU_SKIP_RUNTIME_EXECUTION")

    inventoried = subprocess.run(
        ["bash", str(VERIFY), "--write-inventory", str(app)],
        env={**os.environ, **tools},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert inventoried.returncode == 0, inventoried.stderr + inventoried.stdout

    abi_failure = subprocess.run(
        ["bash", str(VERIFY), str(app)],
        env={**os.environ, **tools, "YULU_FIXTURE_NODE_ABI_FAIL": "1"},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert abi_failure.returncode != 0
    assert "cannot load the bundled better-sqlite3 native addon" in abi_failure.stderr
