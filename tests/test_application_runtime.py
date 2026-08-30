import hashlib
import io
import json
import os
import plistlib
import subprocess
import tarfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PREPARE = ROOT / "packaging" / "scripts" / "prepare_application_runtime.sh"
VERIFY = ROOT / "packaging" / "scripts" / "verify_application_runtime.sh"
SMOKE = ROOT / "yulu" / "scripts" / "smoke_yulu_app.sh"
SHELL_SOURCE = ROOT / "yulu" / "scripts" / "yulu_app.swift"
VALIDATE_ARCHIVE = ROOT / "packaging" / "scripts" / "validate_runtime_archive.py"
INSTALL_NODE_DEPENDENCIES = (
    ROOT / "packaging" / "scripts" / "install_application_node_dependencies.sh"
)


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
    write(
        contents / "Info.plist",
        plistlib.dumps(
            {
                "CFBundleShortVersionString": "0.23.0",
                "CFBundleVersion": "731",
                "YuluReleaseVersion": "0.23.0-rc.4",
                "SUVerifyUpdateBeforeExtraction": True,
                "SURequireSignedFeed": True,
                "SUSignedFeedFailureExpirationInterval": 0,
                "SUEnableAutomaticChecks": True,
                "SUAllowsAutomaticUpdates": False,
                "SUAutomaticallyUpdate": False,
            }
        ),
    )
    write(
        contents / "Helpers/YuluCapture.app/Contents/Info.plist",
        plistlib.dumps(
            {
                "CFBundleShortVersionString": "0.23.0",
                "CFBundleVersion": "731",
                "YuluReleaseVersion": "0.23.0-rc.4",
            }
        ),
    )
    sparkle = contents / "Frameworks/Sparkle.framework"
    sparkle_version = sparkle / "Versions/B"
    for relative in (
        "Sparkle",
        "Autoupdate",
        "Updater.app/Contents/MacOS/Updater",
        "XPCServices/Downloader.xpc/Contents/MacOS/Downloader",
        "XPCServices/Installer.xpc/Contents/MacOS/Installer",
    ):
        write(sparkle_version / relative, b"sparkle-arm64\n", executable=True)
    (sparkle / "Versions/Current").symlink_to("B")
    (sparkle / "Sparkle").symlink_to("Versions/Current/Sparkle")
    write(contents / "Resources/Sparkle-LICENSE.txt", b"sparkle license\n")
    launch_agents = contents / "Library/LaunchAgents"
    for label, bundle_program, arguments in (
        (
            "com.yulu.ui",
            "Contents/MacOS/yulu_app",
            ["yulu_app", "--run-host-service"],
        ),
        (
            "com.yulu.audiodaemon",
            "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
            ["audio_daemon"],
        ),
    ):
        payload = {
            "Label": label,
            "BundleProgram": bundle_program,
            "ProgramArguments": arguments,
            "RunAtLoad": True,
            "KeepAlive": True,
        }
        if label == "com.yulu.audiodaemon":
            payload["EnvironmentVariables"] = {
                "YULU_SERVICE_OWNER": "com.yulu.audiodaemon"
            }
        write(
            launch_agents / f"{label}.plist",
            plistlib.dumps(payload),
        )

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
    write(scripts / "application_migration.py", b"print('migrate')\n")
    write(scripts / "application_update.py", b"print('update')\n")
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
        "betterSqlite3": {
            "version": "test-addon",
            "nodeAbi": "test-abi",
            "binarySha256": sha256(
                ui / "node_modules/better-sqlite3/build/Release/better_sqlite3.node"
            ),
        },
        "python": {"version": "test-python", "sha256": sha256(python_archive)},
        "ffmpeg": {"version": "test-ffmpeg", "sha256": sha256(ffmpeg)},
        "ffmpegLicense": {"sha256": sha256(ffmpeg_license)},
        "sparkle": {"version": "test-sparkle"},
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
    assert (resources / "runtime/yulu/scripts/application_migration.py").is_file()
    assert (resources / "runtime/yulu/scripts/application_update.py").is_file()
    assert (resources / "runtime/yulu/scripts/search/cli.py").is_file()
    assert (resources / "runtime/yulu/scripts/local_caption_runtime_pack.json").is_file()
    assert not (resources / "runtime/yulu/scripts/local-caption-model.bin").exists()
    assert not any(path.name.endswith(".onnx") for path in resources.rglob("*"))


def test_sparkle_runtime_is_exactly_pinned_embedded_arm64_and_release_configured(
    tmp_path: Path,
):
    lock = json.loads((ROOT / "packaging/runtime-lock.json").read_text(encoding="utf-8"))
    assert lock["sparkle"] == {
        "version": "2.9.6",
        "url": "https://github.com/sparkle-project/Sparkle/releases/download/2.9.6/Sparkle-for-Swift-Package-Manager.zip",
        "sha256": "8d5fb41d960b43f4a68aa14126bf62b098544ec8d191cdcc73eb14e63a8e7606",
    }
    build = (ROOT / "yulu/scripts/build_audio_daemon.sh").read_text(encoding="utf-8")
    assert "prepare_sparkle_framework.sh" in build
    assert '-framework Sparkle' in build
    assert '@executable_path/../Frameworks' in build
    assert '/usr/bin/lipo -thin arm64' in (
        ROOT / "packaging/scripts/prepare_sparkle_framework.sh"
    ).read_text(encoding="utf-8")
    nested = [
        "Downloader.xpc",
        "Installer.xpc",
        "Updater.app",
        "Versions/Current/Autoupdate",
        'sign "$IDENTITY" "$SPARKLE_FRAMEWORK"',
    ]
    positions = [build.index(marker) for marker in nested]
    assert positions == sorted(positions)
    assert build.index('sign "$IDENTITY" "$SPARKLE_FRAMEWORK"') < build.index(
        'sign "$IDENTITY" "$APP"'
    )

    info = plistlib.loads(
        (ROOT / "yulu/scripts/Yulu.app/Contents/Info.plist").read_bytes()
    )
    assert info["SUVerifyUpdateBeforeExtraction"] is True
    assert info["SURequireSignedFeed"] is True
    assert info["SUEnableAutomaticChecks"] is True
    assert info["SUAllowsAutomaticUpdates"] is False
    assert info["SUAutomaticallyUpdate"] is False
    assert info["SUSignedFeedFailureExpirationInterval"] == 0
    assert "SUFeedURL" not in info
    assert "SUPublicEDKey" not in info

    app, overrides = runtime_fixture(tmp_path)
    prepared = subprocess.run(
        ["bash", str(PREPARE), str(app)],
        env={**os.environ, **overrides},
        capture_output=True,
        text=True,
        check=False,
    )
    assert prepared.returncode == 0, prepared.stderr + prepared.stdout
    verify_env = {
        **os.environ,
        **fake_verification_tools(tmp_path),
        "YULU_REQUIRE_SPARKLE_CONFIGURATION": "1",
    }
    rejected = subprocess.run(
        ["bash", str(VERIFY), "--write-inventory", str(app)],
        env=verify_env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert rejected.returncode != 0
    assert "Sparkle release configuration is missing or invalid" in rejected.stderr

    info_path = app / "Contents/Info.plist"
    configured = plistlib.loads(info_path.read_bytes())
    configured["SUFeedURL"] = "https://updates.yulu.app/appcast.xml"
    configured["SUPublicEDKey"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    info_path.write_bytes(plistlib.dumps(configured))
    accepted = subprocess.run(
        ["bash", str(VERIFY), "--write-inventory", str(app)],
        env=verify_env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert accepted.returncode == 0, accepted.stderr + accepted.stdout


def test_update_release_mode_accepts_explicit_release_identity_and_build_metadata():
    # #166 consumes generic release/build metadata. Proving that RC and stable
    # artifacts originate from the same source commit belongs to #171's
    # publication metadata and artifact readback acceptance.
    build = (ROOT / "yulu/scripts/build_audio_daemon.sh").read_text(encoding="utf-8")
    signing = (ROOT / "packaging/scripts/sign_and_notarize.sh").read_text(
        encoding="utf-8"
    )

    assert 'YULU_BUNDLE_SHORT_VERSION="${YULU_BUNDLE_SHORT_VERSION:-' in build
    assert '${YULU_VERSION_RAW%%[-+]*}' in build
    assert 'YULU_RELEASE_VERSION="${YULU_RELEASE_VERSION:-$YULU_VERSION_RAW}"' in build
    assert 'YULU_BUILD_NUMBER="${YULU_BUILD_NUMBER:-' in build
    assert 'CFBundleShortVersionString string "$YULU_BUNDLE_SHORT_VERSION"' in build
    assert 'YuluReleaseVersion string "$YULU_RELEASE_VERSION"' in build
    assert 'CFBundleVersion string "$YULU_BUILD_NUMBER"' in build
    assert (
        'SUSignedFeedFailureExpirationInterval integer 0' in build
    )
    assert '[[ "$1" == "--update-release" ]]' in signing
    for name in (
        "YULU_RELEASE_VERSION",
        "YULU_BUNDLE_SHORT_VERSION",
        "YULU_BUILD_NUMBER",
    ):
        assert f"require_update_env {name}" in signing


def test_runtime_verifier_requires_nonexpiring_signed_feed_failures_as_integer_zero(
    tmp_path: Path,
) -> None:
    app, overrides = runtime_fixture(tmp_path)
    prepared = subprocess.run(
        ["bash", str(PREPARE), str(app)],
        env={**os.environ, **overrides},
        capture_output=True,
        text=True,
        check=False,
    )
    assert prepared.returncode == 0, prepared.stderr + prepared.stdout
    info_path = app / "Contents/Info.plist"
    baseline = plistlib.loads(info_path.read_bytes())
    verify_env = {**os.environ, **fake_verification_tools(tmp_path)}

    for mutation in (None, False, 0.0, "0", 1):
        changed = dict(baseline)
        if mutation is None:
            changed.pop("SUSignedFeedFailureExpirationInterval")
        else:
            changed["SUSignedFeedFailureExpirationInterval"] = mutation
        info_path.write_bytes(plistlib.dumps(changed))
        rejected = subprocess.run(
            ["bash", str(VERIFY), "--write-inventory", str(app)],
            env=verify_env,
            capture_output=True,
            text=True,
            check=False,
        )
        assert rejected.returncode != 0
        assert "unsafe signed-feed expiration policy" in rejected.stderr

    info_path.write_bytes(plistlib.dumps(baseline))
    accepted = subprocess.run(
        ["bash", str(VERIFY), "--write-inventory", str(app)],
        env=verify_env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert accepted.returncode == 0, accepted.stderr + accepted.stdout


def test_signing_current_zip_workflow_and_explicit_update_mode_have_separate_contracts(
    tmp_path: Path,
):
    signer = ROOT / "packaging/scripts/sign_and_notarize.sh"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    security = fake_bin / "security"
    security.write_text("#!/bin/sh\nexit 91\n", encoding="utf-8")
    security.chmod(0o755)
    base64 = fake_bin / "base64"
    base64.write_text("#!/bin/sh\ncat >/dev/null\n", encoding="utf-8")
    base64.chmod(0o755)
    core = {
        **os.environ,
        "PATH": f"{fake_bin}:/usr/bin:/bin:/usr/sbin:/sbin",
        "YULU_CODESIGN_IDENTITY": "test identity",
        "YULU_CODESIGN_P12_BASE64": "test",
        "P12_PWD": "test",
        "KEYCHAIN_PWD": "test",
        "ASC_KEY_P8_BASE64": "test",
        "ASC_KEY_ID": "test",
        "ASC_ISSUER_ID": "test",
        "RUNNER_TEMP": str(tmp_path),
        "TAG": "v0.23.0-rc.4",
    }

    current = subprocess.run(
        ["bash", str(signer)],
        env=core,
        capture_output=True,
        text=True,
        check=False,
    )
    assert current.returncode == 91
    assert "YULU_SPARKLE_FEED_URL" not in current.stderr

    missing = subprocess.run(
        ["bash", str(signer), "--update-release"],
        env=core,
        capture_output=True,
        text=True,
        check=False,
    )
    assert missing.returncode == 1
    assert "YULU_SPARKLE_FEED_URL" in missing.stderr

    explicit = subprocess.run(
        ["bash", str(signer), "--update-release"],
        env={
            **core,
            "YULU_SPARKLE_FEED_URL": "https://updates.yulu.app/appcast.xml",
            "YULU_SPARKLE_PUBLIC_ED_KEY": (
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
            ),
            "YULU_RELEASE_VERSION": "0.23.0-rc.4",
            "YULU_BUNDLE_SHORT_VERSION": "0.23.0",
            "YULU_BUILD_NUMBER": "749",
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert explicit.returncode == 91


def test_prepare_application_runtime_rejects_an_unpinned_native_addon(tmp_path: Path):
    app, overrides = runtime_fixture(tmp_path)
    addon = (
        Path(overrides["YULU_RUNTIME_UI_SOURCE"])
        / "node_modules/better-sqlite3/build/Release/better_sqlite3.node"
    )
    addon.write_bytes(b"locally-compiled-native-addon\n")

    result = subprocess.run(
        ["bash", str(PREPARE), str(app)],
        env={**os.environ, **overrides},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "betterSqlite3 binary checksum mismatch" in result.stderr


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

    migration_authority = (
        app / "Contents/Resources/runtime/yulu/scripts/application_migration.py"
    )
    original_migration_authority = migration_authority.read_bytes()
    migration_authority.unlink()
    missing_authority = subprocess.run(
        ["bash", str(VERIFY), str(app)],
        env=verify_env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert missing_authority.returncode != 0
    assert (
        "required Application Runtime file missing: "
        "Contents/Resources/runtime/yulu/scripts/application_migration.py"
    ) in missing_authority.stderr
    migration_authority.write_bytes(original_migration_authority)

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


def test_application_runtime_inventory_seals_bundle_relative_smappservice_agents(tmp_path: Path):
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
    inventory = json.loads(
        (app / "Contents/Resources/application-runtime.json").read_text(encoding="utf-8")
    )
    declared = {entry["path"] for entry in inventory["files"]}
    assert {
        "Contents/Library/LaunchAgents/com.yulu.ui.plist",
        "Contents/Library/LaunchAgents/com.yulu.audiodaemon.plist",
    } <= declared

    host_plist = app / "Contents/Library/LaunchAgents/com.yulu.ui.plist"
    unsafe = plistlib.loads(host_plist.read_bytes())
    unsafe["Program"] = "/tmp/unbundled-host"
    host_plist.write_bytes(plistlib.dumps(unsafe))
    rejected = subprocess.run(
        ["bash", str(VERIFY), "--write-inventory", str(app)],
        env=verify_env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert rejected.returncode != 0
    assert "bundle-relative SMAppService agent" in rejected.stderr

    host_plist.write_bytes(plistlib.dumps({key: value for key, value in unsafe.items() if key != "Program"}))
    capture_plist = app / "Contents/Library/LaunchAgents/com.yulu.audiodaemon.plist"
    missing_owner = plistlib.loads(capture_plist.read_bytes())
    missing_owner.pop("EnvironmentVariables")
    capture_plist.write_bytes(plistlib.dumps(missing_owner))
    rejected_owner = subprocess.run(
        ["bash", str(VERIFY), "--write-inventory", str(app)],
        env=verify_env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert rejected_owner.returncode != 0
    assert "service owner marker" in rejected_owner.stderr


def test_host_runtime_denied_smoke_proves_host_capture_and_bundle_immutability():
    smoke = SMOKE.read_text(encoding="utf-8")
    shell = SHELL_SOURCE.read_text(encoding="utf-8")

    assert "YULU_BUNDLE_APPLICATION_RUNTIME=1" in smoke
    assert "denied-host-runtime" in smoke
    assert "YULU_FORBIDDEN_RUNTIME_LOG" in smoke
    assert "NODE_OPTIONS" in smoke
    assert "YULU_LOCAL_CAPTION_PYTHON" in smoke
    assert "hostile-runtime.log" in smoke
    assert '"$APP/Contents/MacOS/xai_keychain" self-test' in smoke
    assert '"$APP/Contents/MacOS/calendar_probe" --self-test' in smoke
    assert "retired Gateway Keychain cleanup will retry next start" in smoke
    assert "smoke-error.txt" in smoke
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
        'key == "YULU_NATIVE_HELPER_DIR"',
    ):
        assert dangerous in shell
    assert 'hostEnvironment["YULU_NATIVE_HELPER_DIR"] = layout.executableDir.path' in shell
    assert 'hostEnvironment["YULU_DEV_SMOKE"] = "1"' in shell
    assert 'developmentSmoke: true' in shell
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


def test_runtime_archive_validator_requires_selected_addon_to_be_a_regular_member(tmp_path):
    expected = "build/Release/better_sqlite3.node"
    safe_archive = tmp_path / "safe-prebuild.tar.gz"
    with tarfile.open(safe_archive, "w:gz") as bundle:
        payload = tarfile.TarInfo(expected)
        payload.size = len(b"addon")
        bundle.addfile(payload, fileobj=io.BytesIO(b"addon"))

    safe = subprocess.run(
        ["python3", str(VALIDATE_ARCHIVE), str(safe_archive), expected],
        capture_output=True,
        text=True,
        check=False,
    )
    assert safe.returncode == 0, safe.stderr

    symlinked_archive = tmp_path / "symlinked-prebuild.tar.gz"
    with tarfile.open(symlinked_archive, "w:gz") as bundle:
        symlink = tarfile.TarInfo("build/Release")
        symlink.type = tarfile.SYMTYPE
        symlink.linkname = "../outside"
        bundle.addfile(symlink)
        payload = tarfile.TarInfo(expected)
        payload.size = len(b"addon")
        bundle.addfile(payload, fileobj=io.BytesIO(b"addon"))

    rejected = subprocess.run(
        ["python3", str(VALIDATE_ARCHIVE), str(symlinked_archive), expected],
        capture_output=True,
        text=True,
        check=False,
    )
    assert rejected.returncode != 0
    assert "symlinked parent" in rejected.stderr


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


def test_runtime_inspection_finishes_with_a_deep_bundle_signature_gate():
    build = (ROOT / "yulu/scripts/build_audio_daemon.sh").read_text(encoding="utf-8")
    verifier = VERIFY.read_text(encoding="utf-8")

    build_verify = build.rindex(
        'bash "$REPO_DIR/packaging/scripts/verify_application_runtime.sh" "$APP"'
    )
    build_final_signature = build.rindex(
        'codesign --verify --deep --strict --verbose=2 "$APP"'
    )
    build_last_inspector = build.rindex('codesign -dvvv "$APP"')
    assert build_verify < build_last_inspector < build_final_signature

    inventory_verify = verifier.rindex("inventory hash mismatch")
    verifier_final_signature = verifier.rindex(
        '"$CODESIGN_TOOL" --verify --deep --strict "$APP"'
    )
    assert inventory_verify < verifier_final_signature


def test_runtime_build_handles_empty_optional_swift_flags_under_nounset():
    build = (ROOT / "yulu/scripts/build_audio_daemon.sh").read_text(encoding="utf-8")
    for variable in ("SHELL_SWIFT_FLAGS", "SPARKLE_LINK_FLAGS"):
        safe_expansion = f'${{{variable}[@]+"${{{variable}[@]}}"}}'
        assert safe_expansion in build

        result = subprocess.run(
            [
                "/bin/bash",
                "-u",
                "-c",
                f'{variable}=(); set -- ${{{variable}[@]+"${{{variable}[@]}}"}}; test "$#" -eq 0',
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr



def test_application_runtime_workflows_build_native_addons_with_exact_locked_node():
    workflows = (
        (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8").split("  yulu_ui:\n", 1)[1],
        (ROOT / ".github/workflows/release-publish.yml").read_text(encoding="utf-8"),
    )

    for workflow in workflows:
        assert "npm ci" not in workflow
        lock = workflow.index("      - name: Read locked Application Runtime Node version\n")
        setup = workflow.index("        uses: actions/setup-node@v4\n", lock)
        verify = workflow.index("      - name: Verify Application Runtime Node toolchain\n", setup)
        install = workflow.index("install_application_node_dependencies.sh", verify)

        assert lock < setup < verify < install
        contract = workflow[lock:install]
        assert "packaging/runtime-lock.json" in contract
        assert "id: application-runtime-node" in contract
        assert "working-directory: ${{ github.workspace }}" in contract
        assert "python3 packaging/scripts/runtime_node_version.py packaging/runtime-lock.json" in contract
        assert "node-version: ${{ steps.application-runtime-node.outputs.version }}" in contract
        assert "EXPECTED_NODE_VERSION: ${{ steps.application-runtime-node.outputs.version }}" in contract
        assert 'test "$(node --version)" = "v$EXPECTED_NODE_VERSION"' in contract
        assert '"v${{ steps.application-runtime-node.outputs.version }}"' not in contract


def test_application_node_dependency_install_is_prebuilt_only_and_fail_closed(tmp_path: Path):
    ui = tmp_path / "ui"
    ui.mkdir()
    write(ui / "package.json", b'{"dependencies":{"better-sqlite3":"^12.11.1"}}\n')
    write(ui / "package-lock.json", b"{}\n")

    prebuild_root = tmp_path / "prebuild"
    write(prebuild_root / "build/Release/better_sqlite3.node", b"verified-prebuild\n")
    prebuild = archive(
        prebuild_root / "build",
        tmp_path / "better-sqlite3-prebuild.tar.gz",
        "build",
    )
    lock = tmp_path / "runtime-lock.json"
    lock.write_text(
        json.dumps(
            {
                "schema": 1,
                "node": {"version": "24.20.0"},
                "betterSqlite3": {
                    "version": "12.11.1",
                    "nodeAbi": "137",
                    "platform": "darwin",
                    "architecture": "arm64",
                    "url": "https://example.invalid/better-sqlite3-prebuild.tar.gz",
                    "sha256": sha256(prebuild),
                    "binarySha256": sha256(
                        prebuild_root / "build/Release/better_sqlite3.node"
                    ),
                },
            }
        ),
        encoding="utf-8",
    )

    tools = tmp_path / "tools"
    npm_log = tmp_path / "npm.log"
    write(
        tools / "npm",
        b"#!/usr/bin/env bash\n"
        b"printf '%s\\n' \"$*\" > \"$YULU_TEST_NPM_LOG\"\n"
        b"mkdir -p node_modules/better-sqlite3\n"
        b"printf '%s\\n' '{\"version\":\"12.11.1\"}' > node_modules/better-sqlite3/package.json\n",
        executable=True,
    )
    write(
        tools / "node",
        b"#!/usr/bin/env bash\nprintf '%s\\n' '24.20.0|137|darwin|arm64|12.11.1|1'\n",
        executable=True,
    )
    env = {
        **os.environ,
        "PATH": f"{tools}:/usr/bin:/bin",
        "YULU_RUNTIME_LOCK": str(lock),
        "YULU_BETTER_SQLITE3_ARCHIVE": str(prebuild),
        "YULU_TEST_NPM_LOG": str(npm_log),
    }

    installed = subprocess.run(
        ["bash", str(INSTALL_NODE_DEPENDENCIES), str(ui)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert installed.returncode == 0, installed.stderr + installed.stdout
    assert npm_log.read_text(encoding="utf-8").strip() == "ci --ignore-scripts"
    assert (ui / "node_modules/better-sqlite3/build/Release/better_sqlite3.node").read_bytes() == (
        b"verified-prebuild\n"
    )

    prebuild.write_bytes(prebuild.read_bytes() + b"tampered")
    rejected = subprocess.run(
        ["bash", str(INSTALL_NODE_DEPENDENCIES), str(ui)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert rejected.returncode != 0
    assert "betterSqlite3 checksum mismatch" in rejected.stderr


def test_node24_native_addon_uses_a_release_with_environment_cleanup_support():
    ui = ROOT / "yulu/scripts/yulu_ui"
    package = json.loads((ui / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((ui / "package-lock.json").read_text(encoding="utf-8"))

    declared = package["dependencies"]["better-sqlite3"]
    assert declared.startswith("^")
    assert tuple(map(int, declared[1:].split("."))) >= (12, 1, 0)

    locked = lock["packages"]["node_modules/better-sqlite3"]["version"]
    assert tuple(map(int, locked.split("."))) >= (12, 1, 0)

    runtime_lock = json.loads(
        (ROOT / "packaging/runtime-lock.json").read_text(encoding="utf-8")
    )
    native = runtime_lock["betterSqlite3"]
    assert native["version"] == locked
    assert native["nodeAbi"] == "137"
    assert native["platform"] == "darwin"
    assert native["architecture"] == "arm64"
    assert native["url"].endswith(
        f"better-sqlite3-v{locked}-node-v137-darwin-arm64.tar.gz"
    )
    assert len(native["sha256"]) == 64
    assert len(native["binarySha256"]) == 64


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
