import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def write_file(path: Path, text: str = "x\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def make_project(tmp_path: Path, version: str = "0.5.0-dev", git_marker: str | None = "file") -> Path:
    project = tmp_path / "project"
    project.mkdir()

    write_file(project / "VERSION", f"{version}\n")
    write_file(
        project / "install.sh",
        "#!/usr/bin/env bash\n"
        'EMBEDDED_HELPER_BASE64="__YULU_EMBEDDED_RELEASE_INSTALLER_BASE64__"\n'
        "echo install\n",
    )
    write_file(project / "README.md", "# Yulu\n")
    write_file(project / "README.zh-CN.md", "# Yulu\n")
    write_file(project / "AGENTS.md", "agent instructions\n")
    write_file(project / "CHANGELOG.md", "# Changelog\n")
    write_file(project / "docs" / "configuration.md", "config\n")
    write_file(project / "docs" / "superpowers" / "plan.md", "dev docs\n")
    write_file(project / "skills" / "yulu" / "SKILL.md", "skill\n")
    write_file(project / "yulu" / "SKILL.md", "runtime skill\n")
    write_file(project / "yulu" / "scripts" / "setup.sh", "#!/usr/bin/env bash\n")
    write_file(project / "yulu" / "scripts" / "yulu", "#!/usr/bin/env bash\n")
    write_file(project / "yulu" / "scripts" / "release_installer.py", "print('installer')\n")
    write_file(project / "yulu" / "scripts" / "Yulu.app" / "Contents" / "MacOS" / "audio_daemon", "binary\n")
    write_file(project / "yulu" / "scripts" / "Yulu.app" / "Contents" / "MacOS" / "xai_keychain", "binary\n")
    write_file(project / "yulu" / "scripts" / "Yulu.app" / "Contents" / "MacOS" / "calendar_probe", "signed-binary\n")
    write_file(
        project
        / "yulu"
        / "scripts"
        / "Yulu.app"
        / "Contents"
        / "Resources"
        / "Host"
        / "node_modules"
        / "better-sqlite3"
        / "package.json",
        "{}\n",
    )
    write_file(project / "yulu" / "scripts" / "calendar_probe", "linker-adhoc-build-artifact\n")
    write_file(project / "yulu" / "scripts" / "recorder_status", "binary\n")
    write_file(project / "tests" / "test_dev_only.py", "def test_dev_only(): pass\n")
    write_file(project / ".github" / "workflows" / "ci.yml", "name: ci\n")
    write_file(project / ".agents" / "local.md", "agent state\n")
    write_file(project / ".codex" / "local.md", "codex state\n")
    write_file(project / ".gstack" / "browse-audit.jsonl", "{}\n")
    write_file(project / ".mcp" / "zulipchat" / "zulipchat.duckdb", "state\n")
    write_file(project / ".planning" / "STATE.md", "planning\n")
    write_file(project / "yulu" / "scripts" / "yulu_ui" / "node_modules" / "left-pad" / "index.js", "module.exports = 1\n")
    write_file(project / "yulu" / "scripts" / "yulu_ui" / "dist" / "server.js", "server\n")
    write_file(project / "yulu" / "scripts" / "yulu_ui" / "dist" / "web" / "index.html", "web\n")
    write_file(project / "dist" / "old.zip", "old\n")
    write_file(project / ".ci-build" / "artifact", "build\n")
    write_file(project / ".DS_Store", "finder\n")
    write_file(project / ".venv" / "pyvenv.cfg", "venv\n")
    write_file(project / ".pytest_cache" / "README.md", "cache\n")
    write_file(project / "debug.log", "log\n")
    write_file(project / "run.pid", "123\n")
    write_file(project / "server.sock", "socket\n")
    write_file(project / "client_secret_desktop.json", "{}\n")
    write_file(project / "refresh_token.json", "{}\n")
    write_file(project / "secrets" / "prod.json", "{}\n")
    write_file(project / "tokens" / "oauth.json", "{}\n")
    write_file(project / ".env", "TOKEN=x\n")
    if git_marker == "file":
        write_file(project / ".git", "gitdir: /private/tmp/leaky-worktree/.git\n")
    elif git_marker == "dir":
        write_file(project / ".git" / "HEAD", "ref: refs/heads/main\n")

    scripts = project / "packaging" / "scripts"
    scripts.mkdir(parents=True)
    shutil.copy2(ROOT / "packaging" / "scripts" / "package.sh", scripts / "package.sh")
    shutil.copy2(
        ROOT / "packaging" / "scripts" / "release_identity.py",
        scripts / "release_identity.py",
    )
    shutil.copy2(ROOT / "packaging" / "scripts" / "package_pkg.sh", scripts / "package_pkg.sh")
    shutil.copy2(ROOT / "packaging" / "scripts" / "pkg_postinstall.sh", scripts / "pkg_postinstall.sh")
    shutil.copy2(ROOT / "packaging" / "scripts" / "checksums.sh", scripts / "checksums.sh")
    return project


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    child_env = os.environ.copy()
    if env:
        child_env.update(env)
    return subprocess.run(cmd, cwd=cwd, env=child_env, capture_output=True, text=True, check=False)


def write_fake_xcrun(bin_dir: Path) -> Path:
    args_log = bin_dir / "xcrun-args.log"
    xcrun = bin_dir / "xcrun"
    write_file(
        xcrun,
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "printf '%s\\n' \"$@\" > \"$YULU_XCRUN_ARGS\"\n"
        "if [[ \"${YULU_XCRUN_FAIL:-0}\" == \"1\" ]]; then\n"
        "  exit 7\n"
        "fi\n"
        "printf '%s\\n' \"${YULU_VTOOL_OUTPUT:-}\"\n",
    )
    xcrun.chmod(0o755)
    return args_log


def write_fake_hdiutil(bin_dir: Path) -> tuple[Path, Path]:
    args_log = bin_dir / "hdiutil-args.log"
    stage_manifest = bin_dir / "dmg-stage.txt"
    hdiutil = bin_dir / "hdiutil"
    write_file(
        hdiutil,
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "printf '%s\\n' \"$*\" >> \"$YULU_HDIUTIL_ARGS\"\n"
        "case \"$1\" in\n"
        "  create)\n"
        "    source=''\n"
        "    output=\"${@: -1}\"\n"
        "    while [[ $# -gt 0 ]]; do\n"
        "      case \"$1\" in\n"
        "        -srcfolder) source=\"$2\"; shift 2 ;;\n"
        "        *) shift ;;\n"
        "      esac\n"
        "    done\n"
        "    [[ -n \"$source\" ]]\n"
        "    for item in \"$source\"/*; do\n"
        "      name=\"$(basename \"$item\")\"\n"
        "      if [[ -L \"$item\" ]]; then\n"
        "        printf '%s -> %s\\n' \"$name\" \"$(readlink \"$item\")\"\n"
        "      else\n"
        "        printf '%s\\n' \"$name\"\n"
        "      fi\n"
        "    done | LC_ALL=C sort > \"$YULU_DMG_STAGE_MANIFEST\"\n"
        "    printf 'read-write image\\n' > \"$output\"\n"
        "    ;;\n"
        "  convert)\n"
        "    input=\"$2\"\n"
        "    output=''\n"
        "    shift 2\n"
        "    while [[ $# -gt 0 ]]; do\n"
        "      case \"$1\" in\n"
        "        -o) output=\"$2\"; shift 2 ;;\n"
        "        *) shift ;;\n"
        "      esac\n"
        "    done\n"
        "    cp \"$input\" \"$output\"\n"
        "    ;;\n"
        "  *) exit 2 ;;\n"
        "esac\n",
    )
    hdiutil.chmod(0o755)
    return args_log, stage_manifest


def test_package_writes_only_yulu_app_and_applications_alias_to_dmg(tmp_path):
    project = make_project(tmp_path)
    dist = tmp_path / "dist"
    tag = "v0.5.0-dev"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    args_log, stage_manifest = write_fake_hdiutil(bin_dir)

    result = run(
        ["bash", "packaging/scripts/package.sh", tag, "--dist", str(dist), "--skip-build"],
        cwd=project,
        env={
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "YULU_HDIUTIL_ARGS": str(args_log),
            "YULU_DMG_STAGE_MANIFEST": str(stage_manifest),
        },
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert (dist / f"yulu-macos-arm64-{tag}.dmg").is_file()
    assert not (dist / f"yulu-macos-arm64-{tag}.zip").exists()
    assert not (dist / "install.sh").exists()
    assert stage_manifest.read_text(encoding="utf-8").splitlines() == [
        "Applications -> /Applications",
        "Yulu.app",
    ]
    invocations = args_log.read_text(encoding="utf-8")
    assert "create" in invocations
    assert "-format UDRW" in invocations
    assert "-fs HFS+" in invocations
    assert "-volname Yulu" in invocations
    assert "convert" in invocations
    assert "-format UDZO" in invocations
    assert "-imagekey zlib-level=9" in invocations


def test_package_requires_hdiutil_instead_of_falling_back_to_repository_zip(tmp_path):
    project = make_project(tmp_path)
    dist = tmp_path / "dist"
    bin_dir = tmp_path / "tar-path"
    bin_dir.mkdir()
    for command in ("dirname", "mkdir", "tr"):
        resolved = shutil.which(command)
        assert resolved, command
        (bin_dir / command).symlink_to(resolved)

    result = run(
        ["/bin/bash", "packaging/scripts/package.sh", "v0.5.0-dev", "--dist", str(dist), "--skip-build"],
        cwd=project,
        env={"PATH": str(bin_dir)},
    )

    assert result.returncode != 0
    assert "hdiutil is required to build the macOS DMG" in result.stderr
    assert not (dist / "yulu-macos-arm64-v0.5.0-dev.dmg").exists()
    assert not (dist / "yulu-macos-arm64-v0.5.0-dev.zip").exists()


def test_package_requires_matching_tag(tmp_path):
    project = make_project(tmp_path)

    result = run(
        ["bash", "packaging/scripts/package.sh", "v0.5.1", "--dist", str(tmp_path / "dist"), "--skip-build"],
        cwd=project,
    )

    assert result.returncode != 0
    assert "must match VERSION" in result.stderr


def test_package_rejects_numeric_prerelease_leading_zero(tmp_path):
    project = make_project(tmp_path, version="0.5.0-01")

    result = run(
        ["bash", "packaging/scripts/package.sh", "v0.5.0-01", "--skip-build"],
        cwd=project,
    )

    assert result.returncode != 0
    assert "Invalid release tag" in result.stderr


@pytest.mark.parametrize("tag", ["v0.5.0-rc..1", "v0.5.0+build..1"])
def test_package_rejects_empty_semver_identifiers(tmp_path, tag):
    project = make_project(tmp_path, version=tag[1:])

    result = run(
        ["bash", "packaging/scripts/package.sh", tag, "--skip-build"],
        cwd=project,
    )

    assert result.returncode != 0
    assert "Invalid release tag" in result.stderr


def test_makefile_exposes_only_dmg_release_packaging_and_tag_scoped_checksums():
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")

    assert "package-pkg" not in makefile
    assert 'bash packaging/scripts/package.sh "$(TAG)"' in makefile
    assert 'bash packaging/scripts/checksums.sh dist "$(TAG)"' in makefile


def test_pkg_postinstall_restores_runtime_app_and_uses_installer_env():
    script = (ROOT / "packaging" / "scripts" / "pkg_postinstall.sh").read_text(encoding="utf-8")

    assert "ensure_runtime_audio_app" in script
    assert "restoring runtime Yulu.app from $VISIBLE_APP" in script
    assert 'PATH="$user_home/.local/bin:$user_home/.hermes/bin:$INSTALLER_PATH"' in script
    assert "YULU_PKG_POSTINSTALL=1" in script
    assert "YULU_USE_PROVISION=1" in script
    assert "YULU_SKIP_RUNTIME_REPAIRS=1" in script
    assert "setup/provision upgrade" in script


def test_setup_uses_provision_when_requested():
    script = (ROOT / "yulu" / "scripts" / "setup.sh").read_text(encoding="utf-8")

    assert 'YULU_USE_PROVISION:-}" == "1"' in script
    assert '"$PYTHON_BIN" -m provision.cli provision "$@"' in script
    assert '--ledger "$REPO_DIR/.yulu-install.json"' in script


def test_pkg_upgrade_forces_lifecycle_refresh_and_registers_mcp_before_host():
    script = (ROOT / "yulu" / "scripts" / "setup.sh").read_text(encoding="utf-8")

    for step in ("audio", "daemons", "ui"):
        assert f"run_provision {step} --force" in script
    assert script.count("-m provision.cli mcp install") == 1
    mcp_registration = script.index("-m provision.cli mcp install")
    host_start = script.index("\nrun_setup_concerns || exit 1")
    assert mcp_registration < host_start
    registration = " ".join(script[mcp_registration:host_start].replace("\\\n", " ").split())
    assert "--agent hermes --agent codex --agent claude --agent openclaw" in registration
    assert "--detected-only --non-fatal" in registration
    assert "Hermes CLI and its Yulu phase MCP registrations are required" not in script
    assert '"provider": "auto"' in script
    assert '"provider": "hermes"' not in script


def test_release_setup_preserves_ci_built_signed_ui_dist():
    script = (ROOT / "yulu" / "scripts" / "setup_ui.sh").read_text(encoding="utf-8")

    assert '"$npm_bin" ci --omit=dev' in script
    assert 'if [[ "$mode" == "dev" ]]; then' in script
    assert '"$npm_bin" run build' in script
    assert "signed runtime manifest" in script


def test_installers_require_the_python_syntax_level_used_by_runtime():
    for relative in ("install.sh", "yulu/scripts/setup.sh"):
        script = (ROOT / relative).read_text(encoding="utf-8")
        assert "sys.version_info >= (3, 10)" in script


def test_installers_enforce_documented_macos_minimum():
    for relative in ("install.sh", "yulu/scripts/setup.sh"):
        script = (ROOT / relative).read_text(encoding="utf-8")
        assert "macOS 13" in script
        assert '"$MACOS_MAJOR" -lt 13' in script or '"$macos_major" -lt 13' in script


def test_shipped_swift_builds_target_macos_13_arm64():
    expected_outputs = {
        "yulu/scripts/build_audio_daemon.sh": ("$BIN", "$KEYCHAIN_BIN"),
        "yulu/scripts/build_status_agent.sh": ("$BIN", "$RECORDER_BIN", "$MEETING_PROMPT_BIN"),
    }

    for relative, outputs in expected_outputs.items():
        script = (ROOT / relative).read_text(encoding="utf-8")
        assert "SWIFT_TARGET=(-target arm64-apple-macosx13.0)" in script
        for output in outputs:
            compile_pattern = rf'swiftc\s+"\$\{{SWIFT_TARGET\[@\]\}}"\s+-o\s+"{re.escape(output)}"'
            assert re.search(compile_pattern, script), f"{relative} does not target {output}"


def test_ci_swift_smoke_build_targets_complete_native_inventory():
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    build = workflow.split("Swift build", 1)[1].split("Skill manifest sanity", 1)[0]

    for source in (
        "audio_daemon.swift",
        "xai_keychain.swift",
        "window_scanner.swift",
        "recorder_status.swift",
        "meeting_prompt.swift",
        "status_agent.swift",
    ):
        assert source in build
    assert 'swiftc -target arm64-apple-macosx13.0 -o ".ci-build/$stem" "$f"' in build
    assert (
        'swiftc -target arm64-apple-macosx13.0 -o ".ci-build/xai_keychain" '
        "yulu/scripts/xai_keychain.swift -framework Security"
    ) in build
    assert (
        'swiftc -target arm64-apple-macosx13.0 -o ".ci-build/status_agent" '
        "yulu/scripts/status_agent.swift -framework Cocoa -framework Carbon"
    ) in build


def test_deployment_target_checker_fails_closed_on_missing_input(tmp_path):
    checker = ROOT / "packaging" / "scripts" / "check_macos_deployment_target.sh"

    no_args = run(["bash", str(checker)], cwd=ROOT)
    missing = run(["bash", str(checker), str(tmp_path / "missing binary")], cwd=ROOT)

    assert no_args.returncode != 0
    assert "binary path" in no_args.stderr
    assert missing.returncode != 0
    assert str(tmp_path / "missing binary") in missing.stderr


def test_deployment_target_checker_requires_macos_13_arm64_metadata(tmp_path):
    checker = ROOT / "packaging" / "scripts" / "check_macos_deployment_target.sh"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    args_log = write_fake_xcrun(bin_dir)
    binary = tmp_path / "native helper"
    write_file(binary, "mach-o\n")
    base_env = {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "YULU_XCRUN_ARGS": str(args_log),
    }

    valid = run(
        ["bash", str(checker), str(binary)],
        cwd=ROOT,
        env={**base_env, "YULU_VTOOL_OUTPUT": "platform MACOS\nminos 13.0\nsdk 26.0"},
    )
    assert valid.returncode == 0, valid.stderr + valid.stdout
    assert args_log.read_text(encoding="utf-8").splitlines() == [
        "vtool",
        "-arch",
        "arm64",
        "-show-build",
        str(binary),
    ]

    failures = (
        ("wrong minos", "platform MACOS\nminos 14.0"),
        ("wrong platform", "platform IOS\nminos 13.0"),
        ("missing platform", "minos 13.0"),
        ("missing minos", "platform MACOS"),
    )
    for name, output in failures:
        result = run(
            ["bash", str(checker), str(binary)],
            cwd=ROOT,
            env={**base_env, "YULU_VTOOL_OUTPUT": output},
        )
        assert result.returncode != 0, name
        assert str(binary) in result.stderr

    tool_failure = run(
        ["bash", str(checker), str(binary)],
        cwd=ROOT,
        env={**base_env, "YULU_XCRUN_FAIL": "1"},
    )
    assert tool_failure.returncode != 0
    assert str(binary) in tool_failure.stderr


def test_deployment_target_checker_preserves_metacharacter_path(tmp_path):
    checker = ROOT / "packaging" / "scripts" / "check_macos_deployment_target.sh"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    args_log = write_fake_xcrun(bin_dir)
    marker = tmp_path / "injected"
    binary = tmp_path / f"native helper; touch {marker.name}"
    write_file(binary, "mach-o\n")

    result = run(
        ["bash", str(checker), str(binary)],
        cwd=tmp_path,
        env={
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "YULU_XCRUN_ARGS": str(args_log),
            "YULU_VTOOL_OUTPUT": "platform MACOS\nminos 13.0",
        },
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert args_log.read_text(encoding="utf-8").splitlines()[-1] == str(binary)
    assert not marker.exists()


def test_deployment_target_workflow_gate_checks_exact_release_inventory():
    checker = "packaging/scripts/check_macos_deployment_target.sh"
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    release = (ROOT / ".github" / "workflows" / "release-publish.yml").read_text(encoding="utf-8")
    ci_build = ci.split("Swift build", 1)[1].split("Skill manifest sanity", 1)[0]
    release_validation = release.split("Verify packaged release assets", 1)[1].split(
        "Attest release asset provenance", 1
    )[0]
    shipped = (
        "audio_daemon",
        "xai_keychain",
        "status_agent",
        "recorder_status",
        "meeting_prompt",
    )

    assert checker in ci
    assert checker in release
    for binary in shipped:
        assert f".ci-build/{binary}" in ci_build
    for path in (
        "yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon",
        "yulu/scripts/Yulu.app/Contents/MacOS/xai_keychain",
    ):
        assert path in release_validation
    assert "verify_dmg.sh" in release_validation
    gate = release.index(checker, release.index("Verify packaged release assets"))
    assert release.index("verify_dmg.sh", release.index("Verify packaged release assets")) < gate
    assert gate < release.index("Attest release asset provenance")
    assert gate < release.index("gh release upload")
    assert gate < release.index("Publish completed GitHub Release")
    assert "shell=True" not in release_validation


def test_ci_and_release_workflows_use_least_privilege_and_immutable_handoff():
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    release = (ROOT / ".github" / "workflows" / "release-publish.yml").read_text(
        encoding="utf-8"
    )

    assert "\npermissions:\n  contents: read\n" in ci.split("jobs:\n", 1)[0]
    assert ci.count("uses: actions/checkout@v4") == ci.count(
        "persist-credentials: false"
    )

    release_header = release.split("jobs:\n", 1)[0]
    build = release.split("  build:\n", 1)[1].split("  publish:\n", 1)[0]
    publish = release.split("  publish:\n", 1)[1]
    assert "\npermissions:\n  contents: read\n" in release_header
    assert "    permissions:\n      contents: read\n" in build
    assert "persist-credentials: false" in build
    assert "contents: write" not in build
    assert "id-token: write" not in build
    assert "attestations: write" not in build
    assert "actions/attest-build-provenance" not in build
    assert "gh release" not in build
    assert "actions/upload-artifact@" in build
    assert "name: yulu-release-${{ inputs.tag }}" in build
    assert "dist/release-notes.md" in build

    assert "needs: build" in publish
    assert "contents: write" in publish
    assert "id-token: write" in publish
    assert "attestations: write" in publish
    assert "actions: read" in publish
    assert "actions/download-artifact@" in publish
    assert "name: yulu-release-${{ inputs.tag }}" in publish
    assert publish.index("actions/download-artifact@") < publish.index(
        "actions/attest-build-provenance@"
    )
    assert publish.index("actions/attest-build-provenance@") < publish.index(
        "gh release upload"
    )
    assert "npm " not in publish
    assert "sign_and_notarize.sh" not in publish

    pinned_release_actions = {
        "actions/upload-artifact": (
            "ea165f8d65b6e75b540449e92b4886f43607fa02",
            "v4.6.2",
        ),
        "actions/download-artifact": (
            "d3f86a106a0bac45b974a628896c90dbdf5c8093",
            "v4.3.0",
        ),
        "actions/attest-build-provenance": (
            "4d101475d8b20a2381f78447822ac1eab6504dd8",
            "v4.2.2",
        ),
    }
    for action, (commit, version) in pinned_release_actions.items():
        assert f"uses: {action}@{commit} # {version}" in release
        assert f"uses: {action}@v" not in release

    manual_caller = (ROOT / ".github" / "workflows" / "release.yml").read_text(
        encoding="utf-8"
    )
    automatic_caller = (
        ROOT / ".github" / "workflows" / "release-please.yml"
    ).read_text(encoding="utf-8")
    automatic_publish = automatic_caller.split("  publish:\n", 1)[1]
    assert "actions: read" in manual_caller.split("jobs:\n", 1)[0]
    assert "actions: read" in automatic_publish.split("uses:", 1)[0]


def test_release_validates_the_complete_locked_native_addon_contract():
    workflow = (ROOT / ".github" / "workflows" / "release-publish.yml").read_text(
        encoding="utf-8"
    )
    validation = workflow.split("Validate locked Application Runtime inputs", 1)[1].split(
        "Sign, package, and notarize release DMG", 1
    )[0]

    assert 'native = lock["betterSqlite3"]' in validation
    assert 'Path("yulu/scripts/yulu_ui/package-lock.json")' in validation
    assert 'package_lock["packages"]["node_modules/better-sqlite3"]["version"]' in validation
    assert 'native["version"] == locked_addon_version' in validation
    assert 'native["nodeAbi"] == "137"' in validation
    assert 'native["platform"] == "darwin"' in validation
    assert 'native["architecture"] == "arm64"' in validation
    assert "https://github.com/WiseLibs/better-sqlite3/releases/download/" in validation
    assert 're.fullmatch(r"[0-9a-f]{64}", native["sha256"])' in validation
    assert 're.fullmatch(r"[0-9a-f]{64}", native["binarySha256"])' in validation


def test_release_publish_uploads_exact_dmg_optional_pack_feed_and_checksums():
    workflow = (ROOT / ".github" / "workflows" / "release-publish.yml").read_text(encoding="utf-8")
    release_block = workflow.split("Upload verified assets to draft GitHub Release", 1)[1]
    assets_block = release_block.split(")", 1)[0]

    assert '"dist/yulu-macos-arm64-$TAG.dmg"' in assets_block
    assert '"dist/yulu-local-caption-runtime-macos-arm64-$TAG.zip"' in assets_block
    assert '"dist/appcast.xml"' in assets_block
    assert '"dist/checksums.txt"' in assets_block
    assert '"dist/install.sh"' not in assets_block
    assert '"dist/yulu-macos-arm64-$TAG.zip"' not in assets_block
    assert '"dist/yulu-macos-arm64-$TAG.pkg"' not in workflow
    assert "make package-pkg" not in workflow
    assert 'make checksums TAG="$TAG"' in workflow
    assert "dist/yulu-macos-arm64-${{ inputs.tag }}.dmg" in workflow
    assert "dist/yulu-local-caption-runtime-macos-arm64-${{ inputs.tag }}.zip" in workflow
    assert "dist/appcast.xml" in workflow
    assert "bash packaging/scripts/sign_and_notarize.sh --update-release" in workflow
    assert "YULU_SPARKLE_PRIVATE_ED_KEY: ${{ secrets.YULU_SPARKLE_PRIVATE_ED_KEY }}" not in workflow
    assert 'YULU_SPARKLE_PRIVATE_ED_KEY="${{ secrets.YULU_SPARKLE_PRIVATE_ED_KEY }}" \\' in workflow
    assert (
        "YULU_SPARKLE_PUBLIC_ED_KEY: "
        "lzut/+rQs8ZM9JEHaQFmsHgnEZPjr6gLWCdQZ0j1Anc="
    ) in workflow
    assert "secrets.YULU_SPARKLE_PUBLIC_ED_KEY" not in workflow
    assert (
        "YULU_SPARKLE_FEED_URL: "
        "https://raw.githubusercontent.com/Nowhitestar/Yulu/sparkle-feed/appcast.xml"
    ) in workflow
    assert "secrets.YULU_SPARKLE_FEED_URL" not in workflow
    assert "bash packaging/scripts/verify_dmg.sh" in workflow
    assert 'gh release download "$TAG" --pattern "$name"' in workflow
    assert 'cmp "$asset" "$REMOTE_DIR/$name"' in workflow
    assert 'expected-release-assets.txt' in workflow
    assert 'remote-release-assets.txt' in workflow
    assert 'Unexpected or missing draft release assets' in workflow
    exact_remote_gate = workflow.index('Unexpected or missing draft release assets')
    assert workflow.index('release-assets.tsv') < exact_remote_gate
    assert exact_remote_gate < workflow.index('--draft=false')
    assert 'pathlib.Path("docs/release-notes") / f"{tag}.md"' in workflow
    assert (ROOT / "docs" / "release-notes" / "v0.18.0.md").is_file()
    assert "timeout-minutes: 30" in workflow
    assert "group: yulu-release-publish" in workflow
    assert "cancel-in-progress: false" in workflow
    publish_job = workflow.split("  publish:\n", 1)[1]
    assert "GH_REPO: ${{ github.repository }}" in publish_job.split("    steps:\n", 1)[0]
    assert "node-version: ${{ steps.application-runtime-node.outputs.version }}" in workflow
    assert "Checkout release commit" in workflow
    assert "ref: ${{ github.sha }}" in workflow
    assert "ref: ${{ inputs.tag }}" not in workflow
    for command in (
        "install_application_node_dependencies.sh",
        "npm run typecheck",
        "npm test",
        "npm run build",
    ):
        assert command in workflow
    assert "(cd dist && shasum -a 256 -c checksums.txt)" in workflow
    assert "release_installer" not in workflow
    assert "--draft=false" in workflow
    assert workflow.index("gh release upload") < workflow.index("--draft=false")
    assert "Stage signed Sparkle channel feed" in workflow
    channel_feed = workflow.split("Stage signed Sparkle channel feed", 1)[1]
    assert 'FEED_BRANCH="sparkle-feed"' in channel_feed
    assert 'repos/$GITHUB_REPOSITORY/git/refs' in channel_feed
    assert 'repos/$GITHUB_REPOSITORY/contents/appcast.xml' in channel_feed
    assert 'cmp dist/appcast.xml "$REMOTE_FEED"' in channel_feed
    assert "?release=$TAG" not in channel_feed
    assert '"$TAG" != "v0.23.0-rc.4"' in channel_feed
    assert workflow.index("--draft=false") < workflow.index("Stage signed Sparkle channel feed")
    assert workflow.index("Verify public Release asset") < workflow.index(
        "Stage signed Sparkle channel feed"
    )
    assert "Verify public Sparkle feed" in workflow
    assert "Roll back failed Release transaction" in workflow
    rollback = workflow.split("Roll back failed Release transaction", 1)[1]
    assert "steps.release_tx.outputs.started == '1'" in rollback
    assert '"${{ steps.sparkle_feed.outputs.feed_verified }}" == "1"' in rollback
    channel_stage = workflow.split("Stage signed Sparkle channel feed", 1)[1].split(
        "Verify public Sparkle feed", 1
    )[0]
    assert "printf 'feed_verified=0\\n'" in channel_stage
    assert channel_stage.index("Public Sparkle channel feed did not match") < channel_stage.index(
        "printf 'feed_verified=1\\n'"
    )
    assert "always() && !success()" in rollback
    assert 'gh release edit "$TAG" --draft' in rollback
    assert rollback.index("--method PUT") < rollback.index('gh release edit "$TAG" --draft')
    assert "Public Sparkle feed remained present after rollback" in rollback
    assert 'cmp dist/appcast.xml "$REMOTE_FEED"' in rollback
    assert "--method DELETE" in rollback
    assert 'cmp -s "$PREVIOUS_FEED" "$REMOTE_FEED"' in rollback
    assert "dist/validate_sparkle_feed_promotion.py" in workflow
    assert '"dist/validate_sparkle_feed_promotion.py"' not in assets_block
    release_please = (ROOT / "release-please-config.json").read_text(encoding="utf-8")
    assert '"draft": true' in release_please


def test_user_and_operator_guidance_use_dmg_as_the_only_installable_release():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    readme_zh = (ROOT / "README.zh-CN.md").read_text(encoding="utf-8")
    security = (ROOT / "SECURITY.md").read_text(encoding="utf-8")
    release = (ROOT / "docs" / "RELEASE.md").read_text(encoding="utf-8")
    operations = (ROOT / "docs" / "operations.md").read_text(encoding="utf-8")
    skill = (ROOT / "skills" / "yulu" / "SKILL.md").read_text(encoding="utf-8")
    bundled_skill = (ROOT / "yulu" / "SKILL.md").read_text(encoding="utf-8")

    for guide in (readme, readme_zh, skill, bundled_skill):
        assert "yulu-macos-arm64-vX.Y.Z.dmg" in guide
        assert "/Applications" in guide
        assert "raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh" not in guide
    assert "gh attestation verify yulu-macos-arm64-vX.Y.Z.dmg" in security
    assert "grep '  yulu-macos-arm64-vX.Y.Z.dmg$' checksums.txt | shasum -a 256 -c -" in security
    assert "shasum -a 256 -c checksums.txt" not in security
    assert "hdiutil attach -readonly -nobrowse" in security
    assert "spctl -a -vv -t open --context context:primary-signature" in security
    for asset in (
        "yulu-macos-arm64-<tag>.dmg",
        "yulu-local-caption-runtime-macos-arm64-<tag>.zip",
        "appcast.xml",
        "checksums.txt",
    ):
        assert asset in release
    assert "install.sh" not in release
    assert "make package-pkg" not in operations
    assert "same DMG" in operations


def test_draft_release_forces_tag_creation_before_release_pr_reconciliation():
    config = json.loads((ROOT / "release-please-config.json").read_text(encoding="utf-8"))
    package = config["packages"]["."]

    assert package["draft"] is True
    assert package["force-tag-creation"] is True


def test_signing_notarizes_the_app_before_building_and_notarizing_the_dmg():
    script = (ROOT / "packaging" / "scripts" / "sign_and_notarize.sh").read_text(encoding="utf-8")

    build = script.index('build_audio_daemon.sh"')
    app_verify = script.index('codesign --verify --deep --strict --verbose=2 "$YULU_APP"')
    app_notarize = script.index('notarize_app "$YULU_APP"')
    package = script.index('package.sh" "$TAG"')
    dmg_sign = script.index('codesign --force --timestamp --sign "$YULU_CODESIGN_IDENTITY" "$DMG"')
    dmg_notarize = script.index('notarytool submit "$DMG"')
    dmg_staple = script.index('stapler staple "$DMG"')
    dmg_verify = script.index('verify_dmg.sh" "$DMG"')

    assert build < app_verify < app_notarize < package
    assert package < dmg_sign < dmg_notarize < dmg_staple < dmg_verify
    assert "runtime-manifest.json" not in script
    assert "StatusAgent.app" not in script


def test_dmg_verifier_checks_ticket_gatekeeper_and_exact_read_only_layout():
    script = (ROOT / "packaging" / "scripts" / "verify_dmg.sh").read_text(encoding="utf-8")

    assert 'codesign --verify --strict --verbose=2 "$DMG"' in script
    assert 'xcrun stapler validate "$DMG"' in script
    assert 'spctl -a -vv -t open --context context:primary-signature "$DMG"' in script
    assert 'hdiutil attach -readonly -nobrowse -noautoopen -plist "$DMG"' in script
    assert 'diskutil info -plist "$MOUNT_POINT"' in script
    assert 'payload.get("VolumeName") != "Yulu"' in script
    assert 'expected = {"Applications", "Yulu.app"}' in script
    assert 'os.readlink(applications) != "/Applications"' in script
    assert 'codesign --verify --deep --strict --verbose=2 "$APP"' in script
    assert 'xcrun stapler validate "$APP"' in script
    assert 'spctl -a -vv -t exec "$APP"' in script
    assert "YULU_REQUIRE_SPARKLE_CONFIGURATION=1" in script
    assert 'verify_application_runtime.sh" "$APP"' in script


def test_dmg_verifier_rejects_a_wrong_final_volume_label(tmp_path):
    scripts = tmp_path / "packaging" / "scripts"
    scripts.mkdir(parents=True)
    shutil.copy2(ROOT / "packaging" / "scripts" / "verify_dmg.sh", scripts / "verify_dmg.sh")
    runtime_verify = scripts / "verify_application_runtime.sh"
    write_file(runtime_verify, "#!/usr/bin/env bash\nexit 0\n")
    runtime_verify.chmod(0o755)

    mount = tmp_path / "mount"
    (mount / "Yulu.app").mkdir(parents=True)
    (mount / "Applications").symlink_to("/Applications")
    dmg = tmp_path / "yulu-macos-arm64-v0.5.0-dev.dmg"
    write_file(dmg, "dmg\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in {
        "codesign": (
            "if [[ \" $* \" == *\" --display \"* ]]; then\n"
            "  printf '%s\\n' 'Authority=Developer ID Application: Yulu' "
            "'TeamIdentifier=WMU9678ZQL' >&2\n"
            "fi\n"
        ),
        "xcrun": "exit 0\n",
        "spctl": "exit 0\n",
        "hdiutil": (
            "if [[ \"$1\" == \"attach\" ]]; then\n"
            "  printf '%s\\n' '<?xml version=\"1.0\" encoding=\"UTF-8\"?>' "
            "'<plist version=\"1.0\"><dict><key>system-entities</key><array><dict>' "
            "'<key>mount-point</key><string>'\"$YULU_TEST_MOUNT_POINT\"'</string>' "
            "'</dict></array></dict></plist>'\n"
            "fi\n"
        ),
        "diskutil": (
            "printf '%s\\n' '<?xml version=\"1.0\" encoding=\"UTF-8\"?>' "
            "'<plist version=\"1.0\"><dict><key>VolumeName</key>' "
            "'<string>NotYulu</string></dict></plist>'\n"
        ),
    }.items():
        command = bin_dir / name
        write_file(command, "#!/usr/bin/env bash\nset -euo pipefail\n" + body)
        command.chmod(0o755)

    result = run(
        ["bash", str(scripts / "verify_dmg.sh"), str(dmg)],
        cwd=tmp_path,
        env={
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "YULU_TEST_MOUNT_POINT": str(mount),
        },
    )

    assert result.returncode != 0
    assert "DMG volume label must be exactly Yulu" in result.stderr


def test_sparkle_feed_signs_the_exact_public_dmg_without_delta_payloads():
    signing = (ROOT / "packaging" / "scripts" / "sign_and_notarize.sh").read_text(
        encoding="utf-8"
    )
    sparkle = (ROOT / "packaging" / "scripts" / "prepare_sparkle_framework.sh").read_text(
        encoding="utf-8"
    )

    assert "YULU_SPARKLE_PRIVATE_ED_KEY" in signing
    assert 'SPARKLE_PRIVATE_ED_KEY="${YULU_SPARKLE_PRIVATE_ED_KEY:-}"' in signing
    assert "unset YULU_SPARKLE_PRIVATE_ED_KEY" in signing
    assert signing.index("unset YULU_SPARKLE_PRIVATE_ED_KEY") < signing.index('SCRIPT_DIR="$(')
    assert 'printf \'%s\\n\' "$SPARKLE_PRIVATE_ED_KEY"' in signing
    assert "verify_sparkle_key_pair" in signing
    assert "createPrivateKey" in signing
    assert "timingSafeEqual" in signing
    assert 'YULU_SPARKLE_TOOLS_DIR="$SPARKLE_TOOLS"' in signing
    assert 'cp "$DMG" "$APPCAST_WORK/$(basename "$DMG")"' in signing
    assert '"$SPARKLE_TOOLS/generate_appcast"' in signing
    assert "--ed-key-file -" in signing
    assert "--download-url-prefix" in signing
    assert "--maximum-deltas 0" in signing
    assert 'expected_name = f"yulu-macos-arm64-{tag}.dmg"' in signing
    assert 'expected_length = dmg.stat().st_size' in signing
    assert 'int(length) != expected_length' in signing
    assert "edSignature" in signing
    assert 'if list(root.iter(f"{sparkle}deltas")):' in signing
    assert 'SIGNATURE_FILE="$APPCAST_WORK/enclosure-signature.txt"' in signing
    assert 'signature_file.write_text(signature + "\\n", encoding="utf-8")' in signing
    assert '--ed-key-file - --verify "$DMG" "$ENCLOSURE_SIGNATURE"' in signing
    assert '--ed-key-file - --verify "$APPCAST_WORK/appcast.xml"' in signing
    assert 'cp "$APPCAST_WORK/appcast.xml" "$REPO_DIR/dist/appcast.xml"' in signing

    assert "YULU_SPARKLE_TOOLS_DIR" in sparkle
    assert "generate_appcast" in sparkle
    assert "sign_update" in sparkle


def test_ci_workflows_reference_only_existing_shell_scripts():
    for workflow_name in ("ci.yml", "release-publish.yml"):
        workflow = (ROOT / ".github" / "workflows" / workflow_name).read_text(encoding="utf-8")
        referenced = sorted(set(re.findall(r"yulu/scripts/[A-Za-z0-9_./-]+\.sh", workflow)))
        missing = [path for path in referenced if not (ROOT / path).is_file()]
        assert not missing, f"{workflow_name} references missing shell scripts: {missing}"


def test_checksums_include_only_current_dmg_optional_pack_and_appcast(tmp_path):
    project = make_project(tmp_path)
    dist = tmp_path / "dist"
    tag = "v0.5.0-dev"
    dist.mkdir()
    write_file(dist / f"yulu-macos-arm64-{tag}.dmg", "dmg\n")
    write_file(dist / f"yulu-local-caption-runtime-macos-arm64-{tag}.zip", "pack\n")
    write_file(dist / "appcast.xml", "<rss/>\n")
    write_file(dist / f"yulu-macos-arm64-{tag}.zip", "retired repository zip\n")
    write_file(dist / "install.sh", "retired installer\n")
    write_file(dist / f"yulu-macos-arm64-{tag}.pkg", "retired pkg\n")

    checksum_result = run(
        ["bash", "packaging/scripts/checksums.sh", str(dist), tag], cwd=project
    )

    assert checksum_result.returncode == 0, checksum_result.stderr + checksum_result.stdout
    rows = (dist / "checksums.txt").read_text(encoding="utf-8").splitlines()
    assert [row.split("  ", 1)[1] for row in rows] == [
        "appcast.xml",
        f"yulu-local-caption-runtime-macos-arm64-{tag}.zip",
        f"yulu-macos-arm64-{tag}.dmg",
    ]


def test_checksums_fail_when_no_artifacts(tmp_path):
    project = make_project(tmp_path)
    dist = tmp_path / "empty-dist"
    dist.mkdir()

    tag = "v0.5.0-dev"
    result = run(["bash", "packaging/scripts/checksums.sh", str(dist), tag], cwd=project)

    assert result.returncode != 0
    assert "No current DMG, Optional Runtime Pack, or appcast found" in result.stderr
    assert not (dist / "checksums.txt").exists()


def test_default_build_packages_self_contained_runtime_from_isolated_app_output(tmp_path):
    project = make_project(tmp_path, git_marker=None)
    build_mode = tmp_path / "build-mode.txt"
    build_script = project / "yulu" / "scripts" / "build_audio_daemon.sh"
    write_file(
        build_script,
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "printf '%s\\n%s\\n' \"${YULU_BUNDLE_APPLICATION_RUNTIME:-0}\" \"${YULU_APP_OUTPUT_PATH:-}\" > \"$YULU_BUILD_MODE_LOG\"\n"
        "app=\"${YULU_APP_OUTPUT_PATH:?}\"\n"
        "mkdir -p \"$app/Contents/MacOS\" \"$app/Contents/Resources/runtime/bin\" \\\n"
        "  \"$app/Contents/Resources/Host\" \"$app/Contents/Frameworks/Sparkle.framework\"\n"
        "printf 'app\\n' > \"$app/Contents/MacOS/yulu_app\"\n"
        "printf 'node\\n' > \"$app/Contents/Resources/runtime/bin/node\"\n"
        "printf 'host\\n' > \"$app/Contents/Resources/Host/server.js\"\n"
        "printf '{}\\n' > \"$app/Contents/Resources/application-runtime.json\"\n",
    )
    build_script.chmod(0o755)

    init = run(["git", "init"], cwd=project)
    assert init.returncode == 0, init.stderr + init.stdout
    add = run(["git", "add", "."], cwd=project)
    assert add.returncode == 0, add.stderr + add.stdout
    commit = run(
        [
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "fixture",
        ],
        cwd=project,
    )
    assert commit.returncode == 0, commit.stderr + commit.stdout

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    args_log, stage_manifest = write_fake_hdiutil(bin_dir)
    dist = tmp_path / "dist"

    result = run(
        ["bash", "packaging/scripts/package.sh", "v0.5.0-dev", "--dist", str(dist)],
        cwd=project,
        env={
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "YULU_HDIUTIL_ARGS": str(args_log),
            "YULU_DMG_STAGE_MANIFEST": str(stage_manifest),
            "YULU_BUILD_MODE_LOG": str(build_mode),
        },
    )

    assert result.returncode == 0, result.stderr + result.stdout
    mode, output_path = build_mode.read_text(encoding="utf-8").splitlines()
    assert mode == "1"
    assert Path(output_path).is_absolute()
    assert output_path.endswith("/Yulu.app")
    assert output_path != str(project / "yulu" / "scripts" / "Yulu.app")
    assert (dist / "yulu-macos-arm64-v0.5.0-dev.dmg").exists()


def test_default_build_allows_exact_untracked_nested_capture_outputs(tmp_path):
    project = make_project(tmp_path, git_marker=None)
    write_file(project / ".gitignore", "audio_daemon\nCodeResources\n")
    capture_contents = (
        project
        / "yulu"
        / "scripts"
        / "Yulu.app"
        / "Contents"
        / "Helpers"
        / "YuluCapture.app"
        / "Contents"
    )
    write_file(capture_contents / "Info.plist", "tracked plist\n")
    build_script = project / "yulu" / "scripts" / "build_audio_daemon.sh"
    write_file(
        build_script,
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "capture=\"${YULU_APP_OUTPUT_PATH:?}/Contents/Helpers/YuluCapture.app/Contents\"\n"
        "mkdir -p \"$capture/MacOS\" \"$capture/_CodeSignature\"\n"
        "printf 'binary\\n' > \"$capture/MacOS/audio_daemon\"\n"
        "printf 'signature\\n' > \"$capture/_CodeSignature/CodeResources\"\n",
    )
    build_script.chmod(0o755)

    init = run(["git", "init"], cwd=project)
    assert init.returncode == 0, init.stderr + init.stdout
    add = run(["git", "add", "."], cwd=project)
    assert add.returncode == 0, add.stderr + add.stdout
    commit = run(
        [
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "fixture",
        ],
        cwd=project,
    )
    assert commit.returncode == 0, commit.stderr + commit.stdout

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    args_log, stage_manifest = write_fake_hdiutil(bin_dir)
    result = run(
        ["bash", "packaging/scripts/package.sh", "v0.5.0-dev", "--dist", str(tmp_path / "dist")],
        cwd=project,
        env={
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "YULU_HDIUTIL_ARGS": str(args_log),
            "YULU_DMG_STAGE_MANIFEST": str(stage_manifest),
        },
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert (tmp_path / "dist" / "yulu-macos-arm64-v0.5.0-dev.dmg").exists()


@pytest.mark.parametrize("unexpected_name", ["unexpected-helper", "unexpected.key"])
def test_default_build_refuses_unexpected_file_inside_nested_capture_output_directory(
    tmp_path, unexpected_name
):
    project = make_project(tmp_path, git_marker=None)
    write_file(project / ".gitignore", "*.key\n")
    capture_contents = (
        project
        / "yulu"
        / "scripts"
        / "Yulu.app"
        / "Contents"
        / "Helpers"
        / "YuluCapture.app"
        / "Contents"
    )
    write_file(capture_contents / "Info.plist", "tracked plist\n")
    build_script = project / "yulu" / "scripts" / "build_audio_daemon.sh"
    write_file(
        build_script,
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "capture=\"$(dirname \"$0\")/Yulu.app/Contents/Helpers/YuluCapture.app/Contents\"\n"
        "mkdir -p \"$capture/MacOS\" \"$capture/_CodeSignature\"\n"
        "printf 'binary\\n' > \"$capture/MacOS/audio_daemon\"\n"
        f"printf 'unexpected\\n' > \"$capture/MacOS/{unexpected_name}\"\n"
        "printf 'signature\\n' > \"$capture/_CodeSignature/CodeResources\"\n",
    )
    build_script.chmod(0o755)

    init = run(["git", "init"], cwd=project)
    assert init.returncode == 0, init.stderr + init.stdout
    add = run(["git", "add", "."], cwd=project)
    assert add.returncode == 0, add.stderr + add.stdout
    commit = run(
        [
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "fixture",
        ],
        cwd=project,
    )
    assert commit.returncode == 0, commit.stderr + commit.stdout

    result = run(
        ["bash", "packaging/scripts/package.sh", "v0.5.0-dev", "--dist", str(tmp_path / "dist")],
        cwd=project,
    )

    assert result.returncode != 0
    assert "Worktree is dirty after build" in result.stderr
    assert f"YuluCapture.app/Contents/MacOS/{unexpected_name}" in result.stderr
    assert not (tmp_path / "dist" / "yulu-macos-arm64-v0.5.0-dev.dmg").exists()


def test_default_build_fails_closed_when_ignored_output_inventory_fails(tmp_path):
    project = make_project(tmp_path, git_marker=None)
    write_file(project / ".gitignore", "*.key\n")
    capture_contents = (
        project
        / "yulu"
        / "scripts"
        / "Yulu.app"
        / "Contents"
        / "Helpers"
        / "YuluCapture.app"
        / "Contents"
    )
    write_file(capture_contents / "Info.plist", "tracked plist\n")
    build_script = project / "yulu" / "scripts" / "build_audio_daemon.sh"
    write_file(
        build_script,
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "capture=\"$(dirname \"$0\")/Yulu.app/Contents/Helpers/YuluCapture.app/Contents\"\n"
        "mkdir -p \"$capture/MacOS\" \"$capture/_CodeSignature\"\n"
        "printf 'binary\\n' > \"$capture/MacOS/audio_daemon\"\n"
        "printf 'hidden\\n' > \"$capture/MacOS/unexpected.key\"\n"
        "printf 'signature\\n' > \"$capture/_CodeSignature/CodeResources\"\n",
    )
    build_script.chmod(0o755)

    init = run(["git", "init"], cwd=project)
    assert init.returncode == 0, init.stderr + init.stdout
    add = run(["git", "add", "."], cwd=project)
    assert add.returncode == 0, add.stderr + add.stdout
    commit = run(
        [
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "fixture",
        ],
        cwd=project,
    )
    assert commit.returncode == 0, commit.stderr + commit.stdout

    real_git = shutil.which("git")
    assert real_git is not None
    fake_bin = tmp_path / "bin"
    fake_git = fake_bin / "git"
    write_file(
        fake_git,
        "#!/usr/bin/env bash\n"
        "if [[ \"$*\" == *\"ls-files --others --ignored --exclude-standard\"* ]]; then\n"
        "  exit 71\n"
        "fi\n"
        f'exec "{real_git}" "$@"\n',
    )
    fake_git.chmod(0o755)
    dist = tmp_path / "dist"

    result = run(
        ["bash", "packaging/scripts/package.sh", "v0.5.0-dev", "--dist", str(dist)],
        cwd=project,
        env={"PATH": f"{fake_bin}:{os.environ['PATH']}"},
    )

    assert result.returncode != 0
    assert "Failed to inspect ignored Capture build outputs" in result.stderr
    assert not (dist / "yulu-macos-arm64-v0.5.0-dev.dmg").exists()


def test_default_build_refuses_unexpected_dirty_outputs(tmp_path):
    project = make_project(tmp_path, git_marker=None)
    build_script = project / "yulu" / "scripts" / "build_audio_daemon.sh"
    write_file(
        build_script,
        "#!/usr/bin/env bash\n"
        "printf 'changed\\n' > README.md\n",
    )
    build_script.chmod(0o755)

    init = run(["git", "init"], cwd=project)
    assert init.returncode == 0, init.stderr + init.stdout
    add = run(["git", "add", "."], cwd=project)
    assert add.returncode == 0, add.stderr + add.stdout
    commit = run(
        [
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "fixture",
        ],
        cwd=project,
    )
    assert commit.returncode == 0, commit.stderr + commit.stdout

    result = run(
        ["bash", "packaging/scripts/package.sh", "v0.5.0-dev", "--dist", str(tmp_path / "dist")],
        cwd=project,
    )

    assert result.returncode != 0
    assert "Worktree is dirty after build" in result.stderr
    assert "README.md" in result.stderr


def test_release_installer_source_exists_for_release_assets():
    assert (ROOT / "yulu" / "scripts" / "release_installer.py").is_file()


def test_setup_restricts_private_config_permissions():
    setup = (ROOT / "yulu" / "scripts" / "setup.sh").read_text(encoding="utf-8")
    assert 'chmod 700 "$CONFIG_DIR"' in setup
    assert 'chmod 600 "$CONFIG_DIR/config.json"' in setup
