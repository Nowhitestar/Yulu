from pathlib import Path
import plistlib
import json
import os
import subprocess
import shutil

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


def test_shell_authenticates_host_and_capture_uses_stable_runtime_paths():
    shell = (SCRIPTS / "yulu_app.swift").read_text(encoding="utf-8")
    capture = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    host = (SCRIPTS / "yulu_ui" / "src" / "server.ts").read_text(encoding="utf-8")

    assert 'hostEnvironment["YULU_HOST_NONCE"]' in shell
    assert 'json["instanceNonce"] as? String == nonce' in shell
    assert "hostIsRunning" in shell
    assert "Int.random(in: 49152...65535)" in shell
    assert 'process.env.YULU_HOST_NONCE ?? null' in host

    assert 'HOME.appendingPathComponent("Movies/Yulu")' in capture
    assert 'ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]' in capture
    assert 'appendingPathComponent("Contents/Resources/runtime/yulu/scripts"' in capture


def test_development_smoke_probes_the_native_better_sqlite_binding():
    smoke = (SCRIPTS / "smoke_yulu_app.sh").read_text(encoding="utf-8")

    assert "const Database=require('better-sqlite3')" in smoke
    assert "const db=new Database(':memory:'); db.close()" in smoke


def development_shell_smoke_runtime_available() -> bool:
    if shutil.which("swiftc") is None:
        return False

    for candidate in (
        os.environ.get("YULU_DEV_NODE"),
        "/opt/homebrew/opt/node@24/bin/node",
        shutil.which("node"),
    ):
        if not candidate or not Path(candidate).is_file() or not os.access(candidate, os.X_OK):
            continue
        try:
            result = subprocess.run(
                [
                    candidate,
                    "-e",
                    "const Database=require('better-sqlite3'); "
                    "const db=new Database(':memory:'); db.close();",
                ],
                cwd=SCRIPTS / "yulu_ui",
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0:
            return True
    return False


@pytest.mark.skipif(
    not development_shell_smoke_runtime_available(),
    reason="development Yulu.app smoke requires Swift and Node with better-sqlite3",
)
def test_development_shell_reaches_a_healthy_bundled_host():
    result = subprocess.run(
        ["bash", str(SCRIPTS / "smoke_yulu_app.sh")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
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
