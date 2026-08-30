from pathlib import Path
import plistlib
import json
import os
import subprocess
import shutil
import unicodedata

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
OUTER_INFO = SCRIPTS / "Yulu.app" / "Contents" / "Info.plist"
CAPTURE_INFO = (
    SCRIPTS
    / "Yulu.app"
    / "Contents"
    / "Helpers"
    / "YuluCapture.app"
    / "Contents"
    / "Info.plist"
)


def read_plist(path: Path) -> dict[str, object]:
    with path.open("rb") as handle:
        return plistlib.load(handle)


def test_one_visible_app_contains_the_established_capture_identity():
    outer = read_plist(OUTER_INFO)
    capture = read_plist(CAPTURE_INFO)

    assert outer["CFBundleExecutable"] == "yulu_app"
    assert outer["CFBundleIdentifier"] == "com.yulu.app"
    assert outer.get("LSUIElement") is not True
    assert capture["CFBundleExecutable"] == "audio_daemon"
    assert capture["CFBundleIdentifier"] == "com.yulu.audiodaemon"
    assert capture["LSUIElement"] is True

    build = (SCRIPTS / "build_audio_daemon.sh").read_text(encoding="utf-8")
    assert 'CAPTURE_APP="$APP/Contents/Helpers/YuluCapture.app"' in build
    assert '--entitlements "$CAPTURE_ENTITLEMENTS" --sign "$IDENTITY" "$CAPTURE_APP"' in build
    assert '--entitlements "$SHELL_ENTITLEMENTS" --sign "$IDENTITY" "$APP"' in build


def test_shell_allows_product_startup_only_from_applications(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    def inspect(path: str) -> dict[str, object]:
        result = subprocess.run(
            [str(binary), "--inspect-launch", path],
            env={**os.environ, "HOME": str(tmp_path / "home")},
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    installed = inspect("/Applications/Yulu.app")
    assert installed == {
        "installed": True,
        "persistentRegistrationAllowed": True,
        "componentsStarted": True,
        "guidance": None,
    }

    for path in ("/Volumes/Yulu/Yulu.app", "/Users/me/Downloads/Yulu.app"):
        outside = inspect(path)
        assert outside == {
            "installed": False,
            "persistentRegistrationAllowed": False,
            "componentsStarted": False,
            "guidance": "Drag Yulu to Applications before opening it.",
        }


def test_shell_owns_onboarding_window_menu_and_component_restart_contract(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    result = subprocess.run(
        [str(binary), "--inspect-bundle", "/Applications/Yulu.app"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    contract = json.loads(result.stdout)
    assert contract == {
        "windowURL": "http://127.0.0.1:7777/",
        "menuRoutes": ["/", "/onboarding", "/inbox", "/settings"],
        "host": {
            "executable": "/Applications/Yulu.app/Contents/Resources/runtime/bin/node",
            "arguments": [
                "/Applications/Yulu.app/Contents/Resources/Host/server.js",
            ],
            "restartable": True,
        },
        "capture": {
            "executable": (
                "/Applications/Yulu.app/Contents/Helpers/"
                "YuluCapture.app/Contents/MacOS/audio_daemon"
            ),
            "bundleIdentifier": "com.yulu.audiodaemon",
            "restartable": True,
        },
    }


def test_release_shell_excludes_the_development_smoke_entrypoint(tmp_path: Path):
    release_binary = tmp_path / "yulu_app-release"
    development_binary = tmp_path / "yulu_app-development"

    for binary, extra_flags in (
        (release_binary, []),
        (development_binary, ["-D", "YULU_DEVELOPMENT_SMOKE"]),
    ):
        result = subprocess.run(
            [
                "swiftc",
                "-module-cache-path",
                str(tmp_path / "swift-cache"),
                *extra_flags,
                "-o",
                str(binary),
                str(SCRIPTS / "yulu_app.swift"),
                "-framework",
                "Cocoa",
                "-framework",
                "WebKit",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr

    release = subprocess.run(
        [str(release_binary), "--inspect-build"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    development = subprocess.run(
        [str(development_binary), "--inspect-build"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )

    assert json.loads(release.stdout) == {"developmentSmoke": False}
    assert json.loads(development.stdout) == {"developmentSmoke": True}


def test_development_smoke_resolves_component_paths_from_its_fake_home(tmp_path: Path):
    binary = tmp_path / "yulu_app-development"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-D",
            "YULU_DEVELOPMENT_SMOKE",
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    fake_home = tmp_path / "smoke-home"
    (fake_home / ".config/yulu").mkdir(parents=True)
    inspected = subprocess.run(
        [str(binary), "--inspect-development-smoke-paths"],
        env={**os.environ, "HOME": str(fake_home)},
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )

    assert inspected.returncode == 0, inspected.stderr
    paths = json.loads(inspected.stdout)
    assert paths["durableDataDir"] == str(fake_home / "Library/Application Support/Yulu")
    assert paths["legacyReadOnlyDataDir"] == str(fake_home / ".config/yulu")


def test_development_smoke_prints_captured_host_failure_diagnostics():
    smoke = (SCRIPTS / "smoke_yulu_app.sh").read_text(encoding="utf-8")

    assert 'if ! HOME="$SMOKE_ROOT/home" \\' in smoke
    assert 'echo "Development Yulu.app smoke failed:" >&2' in smoke
    assert 'sed \'s/^/  /\' "$SMOKE_ROOT/smoke-error.txt" >&2' in smoke


def test_development_smoke_uses_a_real_fake_home_custom_media_library():
    smoke = (SCRIPTS / "smoke_yulu_app.sh").read_text(encoding="utf-8")

    assert 'SMOKE_MEDIA_LIBRARY="$SMOKE_ROOT/home/Custom Media/Yulu"' in smoke
    assert 'config.audio.output_dir = mediaLibrary' in smoke
    assert 'cp "$SCRIPT_DIR/config.example.json"' not in smoke
    assert '[[ -d "$SMOKE_MEDIA_LIBRARY" ]]' in smoke


def test_shell_authenticates_host_and_capture_uses_stable_runtime_paths():
    shell = (SCRIPTS / "yulu_app.swift").read_text(encoding="utf-8")
    capture = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    host = (SCRIPTS / "yulu_ui" / "src" / "server.ts").read_text(encoding="utf-8")

    assert 'hostEnvironment["YULU_HOST_NONCE"]' in shell
    assert 'json["instanceNonce"] as? String == nonce' in shell
    assert "hostIsRunning" in shell
    assert "Int.random(in: 49152...65535)" in shell
    assert 'process.env.YULU_HOST_NONCE ?? null' in host

    for name in (
        "YULU_MEDIA_LIBRARY_DIR",
        "YULU_APPLICATION_SUPPORT_DIR",
        "YULU_IPC_DIR",
        "YULU_LOG_DIR",
    ):
        assert name in capture
    assert 'SOCKET_PATH = IPC_DIR.appendingPathComponent("audio_daemon.sock")' in capture
    assert 'LOG_PATH = LOGS_DIR.appendingPathComponent("audio_daemon.log")' in capture
    assert "for configPath in CONFIG_READ_PATHS" in capture
    assert "func configuredRecordingDirectory(_ raw: String) -> URL?" in capture
    assert 'ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]' in capture
    assert 'appendingPathComponent("Contents/Resources/runtime/yulu/scripts"' in capture


def test_shell_propagates_the_standard_path_contract_to_both_runtimes():
    shell = (SCRIPTS / "yulu_app.swift").read_text(encoding="utf-8")

    for name in (
        "YULU_APPLICATION_SUPPORT_DIR",
        "YULU_MODELS_DIR",
        "YULU_CACHE_DIR",
        "YULU_IPC_DIR",
        "YULU_LOG_DIR",
        "YULU_MEDIA_LIBRARY_DIR",
        "YULU_LEGACY_READ_ONLY_DATA_DIR",
    ):
        assert name in shell
    assert "applicationPaths.environment" in shell
    assert "hostEnvironment.merge" in shell
    assert "captureEnvironment.merge" in shell


def test_native_capture_companions_use_standard_paths_with_legacy_config_reads():
    status_agent = (SCRIPTS / "status_agent.swift").read_text(encoding="utf-8")
    recorder_status = (SCRIPTS / "recorder_status.swift").read_text(encoding="utf-8")
    meeting_prompt = (SCRIPTS / "meeting_prompt.swift").read_text(encoding="utf-8")

    for source in (status_agent, recorder_status, meeting_prompt):
        assert "YULU_APPLICATION_SUPPORT_DIR" in source
        assert "YULU_LEGACY_READ_ONLY_DATA_DIR" in source
        assert "CONFIG_READ_PATHS" in source

    for name in ("YULU_IPC_DIR", "YULU_LOG_DIR", "YULU_MEDIA_LIBRARY_DIR"):
        assert name in status_agent
    assert 'PID_FILE = "\\(IPC_DIR)/status_agent.pid"' in status_agent
    assert 'LOG_FILE = "\\(LOGS_DIR)/status_agent.log"' in status_agent
    assert 'IPC_SOCKET_PATH = "\\(IPC_DIR)/status_agent.sock"' in status_agent
    assert 'static let socketPath = "\\(IPC_DIR)/audio_daemon.sock"' in status_agent
    assert 'let socketPath = "\\(IPC_DIR)/audio_daemon.sock"' in recorder_status
    assert "func configuredRecordingDirectory(_ raw: String) -> String?" in status_agent


def test_native_capture_rejects_unsafe_media_aliases_and_request_overrides():
    capture = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    status_agent = (SCRIPTS / "status_agent.swift").read_text(encoding="utf-8")

    for source in (capture, status_agent):
        assert "func canonicalDirectory(" in source
        assert "func pathsOverlap(" in source
        assert "func safeMediaDirectory(" in source
        assert "resolvingSymlinksInPath()" in source
    assert "func safeRecordingSubdirectory(" in capture
    assert 'resp = ["error":"unsafe_output_dir"]' in capture
    assert 'outputDir = URL(fileURLWithPath: dir)' not in capture


def test_native_capture_anchors_media_directory_at_recording_start():
    capture = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")

    assert "class AnchoredRecordingDirectory" in capture
    assert "Darwin.openat(" in capture
    assert "O_DIRECTORY | O_NOFOLLOW" in capture
    assert "Darwin.unlinkat(" in capture
    assert 'CommandLine.arguments.contains("--path-contract-self-test")' in capture
    assert "root swap unexpectedly created external audio" in capture


def test_shell_path_contract_reads_legacy_media_without_using_developer_home(tmp_path: Path):
    binary = tmp_path / "yulu_app"
    compile_result = subprocess.run(
        [
            "swiftc",
            "-module-cache-path",
            str(tmp_path / "swift-cache"),
            "-o",
            str(binary),
            str(SCRIPTS / "yulu_app.swift"),
            "-framework",
            "Cocoa",
            "-framework",
            "WebKit",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert compile_result.returncode == 0, compile_result.stderr

    fake_home = tmp_path / "isolated-home"
    legacy = fake_home / ".config/yulu"
    legacy.mkdir(parents=True)
    custom_media = tmp_path / "external-media" / "Yulu"
    (legacy / "config.json").write_text(
        json.dumps({"audio": {"output_dir": str(custom_media)}}),
        encoding="utf-8",
    )

    inspected = subprocess.run(
        [str(binary), "--inspect-paths", str(fake_home)],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )

    assert inspected.returncode == 0, inspected.stderr
    assert json.loads(inspected.stdout) == {
        "cacheDir": str(fake_home / "Library/Caches/Yulu"),
        "configFile": str(fake_home / "Library/Application Support/Yulu/config.json"),
        "configReadFiles": [
            str(fake_home / "Library/Application Support/Yulu/config.json"),
            str(legacy / "config.json"),
        ],
        "durableDataDir": str(fake_home / "Library/Application Support/Yulu"),
        "ipcDir": str(fake_home / "Library/Caches/Yulu"),
        "legacyReadOnlyDataDir": str(legacy),
        "logsDir": str(fake_home / "Library/Logs/Yulu"),
        "mediaLibraryDir": str(custom_media),
        "modelsDir": str(fake_home / "Library/Application Support/Yulu/Models"),
    }

    standard = fake_home / "Library/Application Support/Yulu/config.json"
    standard.parent.mkdir(parents=True)
    standard_media = tmp_path / "standard-media" / "Yulu"
    standard.write_text(
        json.dumps({"audio": {"output_dir": str(standard_media)}}),
        encoding="utf-8",
    )
    propagated = subprocess.run(
        [str(binary), "--inspect-component-paths", str(fake_home)],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert propagated.returncode == 0, propagated.stderr
    expected_environment = {
        "YULU_APPLICATION_SUPPORT_DIR": str(fake_home / "Library/Application Support/Yulu"),
        "YULU_CACHE_DIR": str(fake_home / "Library/Caches/Yulu"),
        "YULU_IPC_DIR": str(fake_home / "Library/Caches/Yulu"),
        "YULU_LEGACY_READ_ONLY_DATA_DIR": str(legacy),
        "YULU_LOG_DIR": str(fake_home / "Library/Logs/Yulu"),
        "YULU_MEDIA_LIBRARY_DIR": str(standard_media),
        "YULU_MODELS_DIR": str(fake_home / "Library/Application Support/Yulu/Models"),
    }
    assert json.loads(propagated.stdout) == {
        "capture": expected_environment,
        "host": expected_environment,
    }

    cache = fake_home / "Library/Caches/Yulu"
    cache.mkdir(parents=True)
    media_alias = fake_home / "media-alias"
    media_alias.symlink_to(cache, target_is_directory=True)
    standard.write_text(
        json.dumps({"audio": {"output_dir": str(media_alias)}}),
        encoding="utf-8",
    )
    (legacy / "config.json").write_text(
        json.dumps({"audio": {"output_dir": "../relative-media"}}),
        encoding="utf-8",
    )
    rejected = subprocess.run(
        [str(binary), "--inspect-paths", str(fake_home)],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert rejected.returncode == 0, rejected.stderr
    assert json.loads(rejected.stdout)["mediaLibraryDir"] == str(fake_home / "Movies/Yulu")

    durable = fake_home / "Library/Application Support/Yulu"
    legacy_alias = fake_home / "legacy-alias"
    legacy_alias.symlink_to(durable, target_is_directory=True)
    unsafe = subprocess.run(
        [str(binary), "--inspect-paths-environment", str(fake_home)],
        env={
            **os.environ,
            "YULU_APPLICATION_SUPPORT_DIR": "../relative-data",
            "YULU_MODELS_DIR": str(legacy),
            "YULU_CACHE_DIR": str(cache / "../../Application Support/Yulu"),
            "YULU_IPC_DIR": str(fake_home / "outside-ipc"),
            "YULU_LOG_DIR": str(durable),
            "YULU_MEDIA_LIBRARY_DIR": str(media_alias),
            "YULU_LEGACY_READ_ONLY_DATA_DIR": str(legacy_alias),
        },
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert unsafe.returncode == 0, unsafe.stderr
    unsafe_paths = json.loads(unsafe.stdout)
    assert unsafe_paths["durableDataDir"] == str(durable)
    assert unsafe_paths["modelsDir"] == str(durable / "Models")
    assert unsafe_paths["cacheDir"] == str(cache)
    assert unsafe_paths["ipcDir"] == str(cache)
    assert unsafe_paths["logsDir"] == str(fake_home / "Library/Logs/Yulu")
    assert unsafe_paths["mediaLibraryDir"] == str(fake_home / "Movies/Yulu")
    assert unsafe_paths["legacyReadOnlyDataDir"] == str(legacy)

    legacy_media_collision = subprocess.run(
        [str(binary), "--inspect-paths-environment", str(fake_home)],
        env={
            **os.environ,
            "YULU_LEGACY_READ_ONLY_DATA_DIR": str(fake_home / "Movies/Yulu"),
        },
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert legacy_media_collision.returncode == 0, legacy_media_collision.stderr
    collision_paths = json.loads(legacy_media_collision.stdout)
    assert collision_paths["legacyReadOnlyDataDir"] == str(legacy)
    assert collision_paths["mediaLibraryDir"] == str(fake_home / "Movies/Yulu")

    loop = fake_home / "media-loop"
    dangling = fake_home / "media-dangling"
    blocked = fake_home / "not-a-directory"
    loop.symlink_to(loop, target_is_directory=True)
    dangling.symlink_to(fake_home / "missing-target", target_is_directory=True)
    blocked.write_text("file")
    standard.write_text(
        json.dumps({"audio": {"output_dir": f"{fake_home}/bad\0path"}}),
        encoding="utf-8",
    )
    (legacy / "config.json").write_text(
        json.dumps({"audio": {"output_dir": str(dangling)}}),
        encoding="utf-8",
    )
    malformed = subprocess.run(
        [str(binary), "--inspect-paths-environment", str(fake_home)],
        env={**os.environ, "YULU_MEDIA_LIBRARY_DIR": str(loop)},
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert malformed.returncode == 0, malformed.stderr
    assert json.loads(malformed.stdout)["mediaLibraryDir"] == str(
        fake_home / "Movies/Yulu"
    )

    standard.write_text(
        json.dumps({"audio": {"output_dir": str(blocked / "child")}}),
        encoding="utf-8",
    )
    unusable = subprocess.run(
        [str(binary), "--inspect-paths-environment", str(fake_home)],
        env={**os.environ, "YULU_MEDIA_LIBRARY_DIR": str(dangling)},
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert unusable.returncode == 0, unusable.stderr
    assert json.loads(unusable.stdout)["mediaLibraryDir"] == str(
        fake_home / "Movies/Yulu"
    )

    durable_target = fake_home / "targets/durable"
    media_target = fake_home / "targets/media"
    durable_target.mkdir(parents=True)
    media_target.mkdir(parents=True)
    durable_alias = fake_home / "durable-stable-alias"
    media_stable_alias = fake_home / "media-stable-alias"
    durable_alias.symlink_to(durable_target, target_is_directory=True)
    media_stable_alias.symlink_to(media_target, target_is_directory=True)
    stable = subprocess.run(
        [str(binary), "--inspect-component-paths-environment", str(fake_home)],
        env={
            **os.environ,
            "YULU_APPLICATION_SUPPORT_DIR": str(durable_alias),
            "YULU_MEDIA_LIBRARY_DIR": str(media_stable_alias),
        },
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert stable.returncode == 0, stable.stderr
    stable_paths = json.loads(stable.stdout)
    for component in ("host", "capture"):
        assert stable_paths[component]["YULU_APPLICATION_SUPPORT_DIR"] == str(
            durable_target.resolve(strict=True)
        )
        assert stable_paths[component]["YULU_MODELS_DIR"] == str(
            durable_target.resolve(strict=True) / "Models"
        )
        assert stable_paths[component]["YULU_MEDIA_LIBRARY_DIR"] == str(
            media_target.resolve(strict=True)
        )

    durable_alias.unlink()
    media_stable_alias.unlink()
    durable_alias.symlink_to(legacy, target_is_directory=True)
    media_stable_alias.symlink_to(legacy, target_is_directory=True)
    for component in ("host", "capture"):
        assert stable_paths[component]["YULU_APPLICATION_SUPPORT_DIR"] == str(
            durable_target.resolve(strict=True)
        )
        assert stable_paths[component]["YULU_MEDIA_LIBRARY_DIR"] == str(
            media_target.resolve(strict=True)
        )

    case_alias = subprocess.run(
        [str(binary), "--inspect-component-paths-environment", str(fake_home)],
        env={
            **os.environ,
            "YULU_APPLICATION_SUPPORT_DIR": str(fake_home / "CaseRoot/Yulu"),
            "YULU_MODELS_DIR": str(fake_home / "caseroot/yulu"),
            "YULU_MEDIA_LIBRARY_DIR": str(fake_home / "caseroot/yulu/Recordings"),
        },
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert case_alias.returncode == 0, case_alias.stderr
    for component in ("host", "capture"):
        case_child_paths = json.loads(case_alias.stdout)[component]
        assert case_child_paths["YULU_MODELS_DIR"] == str(
            fake_home / "CaseRoot/Yulu/Models"
        )
        assert case_child_paths["YULU_MEDIA_LIBRARY_DIR"] == str(
            fake_home / "Movies/Yulu"
        )

    composed_durable = fake_home / "Operational/M\u00e9dia"
    decomposed_nested_media = fake_home / "operational/ME\u0301DIA/Recordings"
    unicode_alias = subprocess.run(
        [str(binary), "--inspect-component-paths-environment", str(fake_home)],
        env={
            **os.environ,
            "YULU_APPLICATION_SUPPORT_DIR": str(composed_durable),
            "YULU_MODELS_DIR": str(fake_home / "operational/ME\u0301DIA"),
            "YULU_MEDIA_LIBRARY_DIR": str(decomposed_nested_media),
        },
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert unicode_alias.returncode == 0, unicode_alias.stderr
    unicode_child_paths = json.loads(unicode_alias.stdout)
    for component in ("host", "capture"):
        assert unicodedata.normalize(
            "NFC",
            unicode_child_paths[component]["YULU_APPLICATION_SUPPORT_DIR"],
        ) == str(composed_durable)
        assert unicodedata.normalize(
            "NFC",
            unicode_child_paths[component]["YULU_MODELS_DIR"],
        ) == str(composed_durable / "Models")
        assert unicode_child_paths[component]["YULU_MEDIA_LIBRARY_DIR"] == str(
            fake_home / "Movies/Yulu"
        )


def test_development_smoke_probes_the_native_better_sqlite_binding():
    verifier = (
        ROOT / "packaging" / "scripts" / "verify_application_runtime.sh"
    ).read_text(encoding="utf-8")

    assert "const Database=require('better-sqlite3')" in verifier
    assert "const db=new Database(':memory:'); db.close()" in verifier


def development_shell_smoke_runtime_available() -> bool:
    if shutil.which("swiftc") is None:
        return False
    return all(
        (value := os.environ.get(name)) is not None and Path(value).is_file()
        for name in (
            "YULU_NODE_ARCHIVE",
            "YULU_PYTHON_ARCHIVE",
            "YULU_FFMPEG_SOURCE_ARCHIVE",
        )
    )


@pytest.mark.skipif(
    not development_shell_smoke_runtime_available(),
    reason="development Yulu.app smoke requires Swift and the three pinned runtime archives",
)
def test_development_shell_reaches_a_healthy_bundled_host():
    result = subprocess.run(
        ["bash", str(SCRIPTS / "smoke_yulu_app.sh")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    report = json.loads(result.stdout.splitlines()[-1])
    assert report["status"] == "ok"
    assert report["hostEntry"].endswith("Yulu.app/Contents/Resources/Host/server.js")
    assert report["captureStarted"] is False


def test_ci_runs_development_shell_smoke_after_node_dependencies_and_build():
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    node_job = workflow.split("  yulu_ui:\n", 1)[1]

    install = node_job.index("      - name: Install dependencies\n")
    build = node_job.index("      - name: Build\n")
    smoke = node_job.index("      - name: Development Yulu.app bundled Host smoke\n")

    assert install < build < smoke
    assert "        run: bash ../smoke_yulu_app.sh\n" in node_job[smoke:]


def test_release_gates_cover_the_shell_and_nested_capture():
    package = (ROOT / "packaging" / "scripts" / "package.sh").read_text(encoding="utf-8")
    signing = (ROOT / "packaging" / "scripts" / "sign_and_notarize.sh").read_text(encoding="utf-8")
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    release = (ROOT / ".github" / "workflows" / "release-publish.yml").read_text(encoding="utf-8")

    for output in (
        "yulu/scripts/Yulu.app/Contents/MacOS/yulu_app",
        "yulu/scripts/Yulu.app/Contents/Helpers/YuluCapture.app/Contents/Info.plist",
        "yulu/scripts/Yulu.app/Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
        "yulu/scripts/Yulu.app/Contents/Helpers/YuluCapture.app/Contents/_CodeSignature/CodeResources",
    ):
        assert output in package

    manifest_resign = signing.split("# The build script signed Yulu.app", 1)[1]
    assert '--entitlements "$SCRIPTS_DIR/YuluShell.app.entitlements"' in manifest_resign
    assert '--entitlements "$SCRIPTS_DIR/Yulu.app.entitlements"' not in manifest_resign

    assert ".ci-build/yulu_app" in ci
    for binary in (
        "yulu/scripts/Yulu.app/Contents/MacOS/yulu_app",
        "yulu/scripts/Yulu.app/Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
    ):
        assert binary in release
