import base64
import json
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path


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
    shutil.copy2(ROOT / "packaging" / "scripts" / "package_pkg.sh", scripts / "package_pkg.sh")
    shutil.copy2(ROOT / "packaging" / "scripts" / "pkg_postinstall.sh", scripts / "pkg_postinstall.sh")
    shutil.copy2(ROOT / "packaging" / "scripts" / "checksums.sh", scripts / "checksums.sh")
    return project


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    child_env = os.environ.copy()
    if env:
        child_env.update(env)
    return subprocess.run(cmd, cwd=cwd, env=child_env, capture_output=True, text=True, check=False)


def write_fake_pkg_tools(bin_dir: Path) -> None:
    pkgbuild = bin_dir / "pkgbuild"
    write_file(
        pkgbuild,
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "root=''\n"
        "out=''\n"
        "while [[ $# -gt 0 ]]; do\n"
        "  case \"$1\" in\n"
        "    --root) root=\"$2\"; shift 2 ;;\n"
        "    --scripts|--identifier|--version|--install-location|--sign) shift 2 ;;\n"
        "    *) out=\"$1\"; shift ;;\n"
        "  esac\n"
        "done\n"
        "if [[ -z \"$root\" || -z \"$out\" ]]; then\n"
        "  echo 'bad pkgbuild args' >&2\n"
        "  exit 2\n"
        "fi\n"
        "find \"$root\" -print | LC_ALL=C sort > \"$out.manifest\"\n"
        "if [[ -n \"${YULU_FAKE_PKG_MANIFEST:-}\" ]]; then\n"
        "  cp \"$out.manifest\" \"$YULU_FAKE_PKG_MANIFEST\"\n"
        "fi\n"
        "printf 'pkg\\n' > \"$out\"\n",
    )
    pkgbuild.chmod(0o755)

    pkgutil = bin_dir / "pkgutil"
    write_file(
        pkgutil,
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "case \"$1\" in\n"
        "  --expand)\n"
        "    mkdir -p \"$3\"\n"
        "    printf '<pkg-info><payload numberOfFiles=\"0\" installKBytes=\"0\"/></pkg-info>\\n' > \"$3/PackageInfo\"\n"
        "    printf 'bom\\n' > \"$3/Bom\"\n"
        "    printf 'payload\\n' > \"$3/Payload\"\n"
        "    ;;\n"
        "  --flatten)\n"
        "    printf 'pkg\\n' > \"$3\"\n"
        "    ;;\n"
        "  *)\n"
        "    echo \"unsupported fake pkgutil args: $*\" >&2\n"
        "    exit 2\n"
        "    ;;\n"
        "esac\n",
    )
    pkgutil.chmod(0o755)

    mkbom = bin_dir / "mkbom"
    write_file(
        mkbom,
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "printf 'bom\\n' > \"$2\"\n",
    )
    mkbom.chmod(0o755)


def test_package_writes_expected_zip_with_runtime_layout(tmp_path):
    project = make_project(tmp_path)
    dist = tmp_path / "dist"
    tag = "v0.5.0-dev"

    result = run(
        ["bash", "packaging/scripts/package.sh", tag, "--dist", str(dist), "--skip-build"],
        cwd=project,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    zip_path = dist / f"yulu-macos-arm64-{tag}.zip"
    assert zip_path.exists()
    assert (dist / "install.sh").exists()

    with zipfile.ZipFile(zip_path) as archive:
        names = archive.namelist()

    assert "yulu/VERSION" in names
    assert "yulu/install.sh" in names
    assert "yulu/README.md" in names
    assert "yulu/README.zh-CN.md" in names
    assert "yulu/CHANGELOG.md" in names
    assert "yulu/skills/yulu/SKILL.md" in names
    assert "yulu/yulu/scripts/setup.sh" in names
    assert "yulu/yulu/scripts/yulu" in names
    assert "yulu/yulu/scripts/release_installer.py" in names
    assert "yulu/yulu/scripts/recorder_status" in names
    assert "yulu/yulu/scripts/yulu_ui/dist/server.js" in names
    assert "yulu/yulu/scripts/yulu_ui/dist/web/index.html" in names
    assert "yulu/.git" not in names
    assert not any(name.startswith("yulu/.git/") for name in names)
    assert not any(name.startswith("yulu/.github/") for name in names)
    assert not any(name.startswith("yulu/dist/") for name in names)
    assert not any(name.startswith("yulu/.ci-build/") for name in names)
    assert not any(name.startswith("yulu/tests/") for name in names)
    assert not any(name.startswith("yulu/docs/superpowers/") for name in names)
    excluded = {
        "yulu/.DS_Store",
        "yulu/._README.md",
        "yulu/AGENTS.md",
        "yulu/.agents/local.md",
        "yulu/.codex/local.md",
        "yulu/.gstack/browse-audit.jsonl",
        "yulu/.mcp/zulipchat/zulipchat.duckdb",
        "yulu/.planning/STATE.md",
        "yulu/yulu/scripts/yulu_ui/node_modules/left-pad/index.js",
        "yulu/.venv/pyvenv.cfg",
        "yulu/.pytest_cache/README.md",
        "yulu/debug.log",
        "yulu/run.pid",
        "yulu/server.sock",
        "yulu/client_secret_desktop.json",
        "yulu/refresh_token.json",
        "yulu/secrets/prod.json",
        "yulu/tokens/oauth.json",
        "yulu/.env",
    }
    assert excluded.isdisjoint(names)


def test_package_tar_fallback_keeps_nested_runtime_dist(tmp_path):
    project = make_project(tmp_path)
    dist = tmp_path / "dist"
    bin_dir = tmp_path / "tar-path"
    bin_dir.mkdir()
    for command in (
        "awk", "base64", "chmod", "cp", "dirname", "find", "git", "grep",
        "mkdir", "mktemp", "mv", "rm", "sort", "tar", "touch", "tr", "zip",
    ):
        resolved = shutil.which(command)
        assert resolved, command
        (bin_dir / command).symlink_to(resolved)

    result = run(
        ["/bin/bash", "packaging/scripts/package.sh", "v0.5.0-dev", "--dist", str(dist), "--skip-build"],
        cwd=project,
        env={"PATH": str(bin_dir)},
    )

    assert result.returncode == 0, result.stderr + result.stdout
    with zipfile.ZipFile(dist / "yulu-macos-arm64-v0.5.0-dev.zip") as archive:
        names = archive.namelist()
    assert "yulu/yulu/scripts/yulu_ui/dist/server.js" in names
    assert "yulu/yulu/scripts/yulu_ui/dist/web/index.html" in names
    assert not any(name.startswith("yulu/dist/") for name in names)


def test_package_requires_matching_tag(tmp_path):
    project = make_project(tmp_path)

    result = run(
        ["bash", "packaging/scripts/package.sh", "v0.5.1", "--dist", str(tmp_path / "dist"), "--skip-build"],
        cwd=project,
    )

    assert result.returncode != 0
    assert "must match VERSION" in result.stderr


def test_package_pkg_builds_installer_payload_from_runtime_zip(tmp_path):
    project = make_project(tmp_path)
    dist = tmp_path / "dist"
    tag = "v0.5.0-dev"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    write_fake_pkg_tools(bin_dir)
    manifest_path = dist / f"yulu-macos-arm64-{tag}.pkg.manifest"

    result = run(
        ["bash", "packaging/scripts/package_pkg.sh", tag, "--dist", str(dist), "--skip-build"],
        cwd=project,
        env={"PATH": f"{bin_dir}:{os.environ['PATH']}", "YULU_FAKE_PKG_MANIFEST": str(manifest_path)},
    )

    assert result.returncode == 0, result.stderr + result.stdout
    pkg_path = dist / f"yulu-macos-arm64-{tag}.pkg"
    assert pkg_path.exists()
    manifest = manifest_path.read_text(encoding="utf-8").splitlines()
    assert any(row.endswith("/Applications/Yulu.app/Contents/MacOS/audio_daemon") for row in manifest)
    assert any(row.endswith("/Library/Application Support/Yulu/runtime/VERSION") for row in manifest)
    assert any(row.endswith("/Library/Application Support/Yulu/runtime/yulu/scripts/setup.sh") for row in manifest)
    assert not any(
        row.endswith("/Library/Application Support/Yulu/runtime/yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon")
        for row in manifest
    )


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
    mcp_registration = script.index("-m provision.cli mcp install --agent hermes")
    host_start = script.index("\nrun_setup_concerns || exit 1")
    assert mcp_registration < host_start
    assert "Hermes CLI and its Yulu phase MCP registrations are required" in script
    assert "--agent codex --agent claude --agent openclaw --detected-only --non-fatal" in script


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


def test_release_publish_uploads_zip_installer_and_checksums_without_pkg():
    workflow = (ROOT / ".github" / "workflows" / "release-publish.yml").read_text(encoding="utf-8")
    release_block = workflow.split("Upload verified assets to draft GitHub Release", 1)[1]
    assets_block = release_block.split(")", 1)[0]

    assert '"dist/yulu-macos-arm64-$TAG.zip"' in assets_block
    assert '"dist/install.sh"' in assets_block
    assert '"dist/checksums.txt"' in assets_block
    assert '"dist/yulu-macos-arm64-$TAG.pkg"' not in workflow
    assert "make package-pkg" not in workflow
    assert "make checksums" in workflow
    assert "subject-path: dist/yulu-macos-arm64-${{ inputs.tag }}.zip" in workflow
    assert 'gh release download "$TAG" --pattern "$name"' in workflow
    assert 'cmp "$asset" "$REMOTE_DIR/$name"' in workflow
    assert 'pathlib.Path("docs/release-notes") / f"{tag}.md"' in workflow
    assert (ROOT / "docs" / "release-notes" / "v0.18.0.md").is_file()
    assert "timeout-minutes: 30" in workflow
    assert 'node-version: "24"' in workflow
    assert "Checkout release commit" in workflow
    assert "ref: ${{ github.sha }}" in workflow
    assert "ref: ${{ inputs.tag }}" not in workflow
    for command in ("npm ci", "npm run typecheck", "npm test", "npm run build"):
        assert command in workflow
    assert "(cd dist && shasum -a 256 -c checksums.txt)" in workflow
    assert "verify_release_bundle_security(runtime, require_staple=True)" in workflow
    assert "verify_runtime_manifest(runtime)" in workflow
    assert "--draft=false" in workflow
    assert workflow.index("gh release upload") < workflow.index("--draft=false")
    release_please = (ROOT / "release-please-config.json").read_text(encoding="utf-8")
    assert '"draft": true' in release_please


def test_draft_release_forces_tag_creation_before_release_pr_reconciliation():
    config = json.loads((ROOT / "release-please-config.json").read_text(encoding="utf-8"))
    package = config["packages"]["."]

    assert package["draft"] is True
    assert package["force-tag-creation"] is True


def test_signing_builds_manifest_then_resigns_before_notarization():
    script = (ROOT / "packaging" / "scripts" / "sign_and_notarize.sh").read_text(encoding="utf-8")

    preliminary = script.index('package.sh" "$TAG"')
    manifest = script.index("write_runtime_manifest")
    resign = script.index('codesign --force --options runtime --timestamp', manifest)
    notarize = script.index('notarize_and_staple "$YULU_APP"')
    assert preliminary < manifest < resign < notarize


def test_ci_workflows_reference_only_existing_shell_scripts():
    for workflow_name in ("ci.yml", "release-publish.yml"):
        workflow = (ROOT / ".github" / "workflows" / workflow_name).read_text(encoding="utf-8")
        referenced = sorted(set(re.findall(r"yulu/scripts/[A-Za-z0-9_./-]+\.sh", workflow)))
        missing = [path for path in referenced if not (ROOT / path).is_file()]
        assert not missing, f"{workflow_name} references missing shell scripts: {missing}"


def test_checksums_include_zip_and_install_asset(tmp_path):
    project = make_project(tmp_path)
    dist = tmp_path / "dist"
    tag = "v0.5.0-dev"

    package_result = run(
        ["bash", "packaging/scripts/package.sh", "--dist", str(dist), "--skip-build"],
        cwd=project,
        env={"TAG": tag},
    )
    assert package_result.returncode == 0, package_result.stderr + package_result.stdout
    checksum_result = run(["bash", "packaging/scripts/checksums.sh", str(dist)], cwd=project)

    assert checksum_result.returncode == 0, checksum_result.stderr + checksum_result.stdout
    rows = (dist / "checksums.txt").read_text(encoding="utf-8").splitlines()
    assert any(row.endswith(f"  yulu-macos-arm64-{tag}.zip") for row in rows)
    assert any(row.endswith("  install.sh") for row in rows)
    assert len(rows) == 2


def test_packaged_install_script_embeds_exact_release_helper(tmp_path):
    project = make_project(tmp_path)
    dist = tmp_path / "dist"
    tag = "v0.5.0-dev"

    result = run(
        ["bash", "packaging/scripts/package.sh", tag, "--dist", str(dist), "--skip-build"],
        cwd=project,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    packaged = (dist / "install.sh").read_text(encoding="utf-8")
    match = re.search(r'^EMBEDDED_HELPER_BASE64="([A-Za-z0-9+/=]+)"$', packaged, re.M)
    assert match
    decoded = base64.b64decode(match.group(1)).decode("utf-8")
    assert decoded == (project / "yulu" / "scripts" / "release_installer.py").read_text(encoding="utf-8")
    assert "__YULU_EMBEDDED_RELEASE_INSTALLER_BASE64__" not in packaged


def test_pkg_target_is_explicitly_non_release_without_installer_certificate():
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    script = (ROOT / "packaging" / "scripts" / "package_pkg.sh").read_text(encoding="utf-8")

    assert "local diagnostic artifact only" in makefile
    assert "Developer ID Installer certificate" in makefile
    assert "Local diagnostics only" in script
    assert "Do not upload this pkg as an official release" in script


def test_checksums_fail_when_no_artifacts(tmp_path):
    project = make_project(tmp_path)
    dist = tmp_path / "empty-dist"
    dist.mkdir()

    result = run(["bash", "packaging/scripts/checksums.sh", str(dist)], cwd=project)

    assert result.returncode != 0
    assert "expected dist/*.zip, dist/*.pkg, and/or dist/install.sh" in result.stderr
    assert not (dist / "checksums.txt").exists()


def test_default_build_allows_expected_app_bundle_outputs(tmp_path):
    project = make_project(tmp_path, git_marker=None)
    build_script = project / "yulu" / "scripts" / "build_audio_daemon.sh"
    write_file(
        build_script,
        "#!/usr/bin/env bash\n"
        "printf 'changed\\n' > \"$(dirname \"$0\")/Yulu.app/Contents/MacOS/audio_daemon\"\n",
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

    assert result.returncode == 0, result.stderr + result.stdout
    assert (tmp_path / "dist" / "yulu-macos-arm64-v0.5.0-dev.zip").exists()


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
