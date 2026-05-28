import os
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
    write_file(project / "install.sh", "#!/usr/bin/env bash\necho install\n")
    write_file(project / "README.md", "# Yulu\n")
    write_file(project / "README.zh-CN.md", "# Yulu\n")
    write_file(project / "CHANGELOG.md", "# Changelog\n")
    write_file(project / "docs" / "configuration.md", "config\n")
    write_file(project / "docs" / "superpowers" / "plan.md", "dev docs\n")
    write_file(project / "skills" / "yulu" / "SKILL.md", "skill\n")
    write_file(project / "yulu" / "SKILL.md", "runtime skill\n")
    write_file(project / "yulu" / "scripts" / "setup.sh", "#!/usr/bin/env bash\n")
    write_file(project / "yulu" / "scripts" / "yulu", "#!/usr/bin/env bash\n")
    write_file(project / "yulu" / "scripts" / "release_installer.py", "print('installer')\n")
    write_file(project / "yulu" / "scripts" / "Yulu.app" / "Contents" / "MacOS" / "audio_daemon", "binary\n")
    write_file(project / "tests" / "test_dev_only.py", "def test_dev_only(): pass\n")
    write_file(project / ".github" / "workflows" / "ci.yml", "name: ci\n")
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
    shutil.copy2(ROOT / "packaging" / "scripts" / "checksums.sh", scripts / "checksums.sh")
    return project


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    child_env = os.environ.copy()
    if env:
        child_env.update(env)
    return subprocess.run(cmd, cwd=cwd, env=child_env, capture_output=True, text=True, check=False)


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
    assert "yulu/.git" not in names
    assert not any(name.startswith("yulu/.git/") for name in names)
    assert not any(name.startswith("yulu/.github/") for name in names)
    assert not any(name.startswith("yulu/dist/") for name in names)
    assert not any(name.startswith("yulu/.ci-build/") for name in names)
    assert not any(name.startswith("yulu/tests/") for name in names)
    assert not any(name.startswith("yulu/docs/superpowers/") for name in names)
    excluded = {
        "yulu/.DS_Store",
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


def test_package_requires_matching_tag(tmp_path):
    project = make_project(tmp_path)

    result = run(
        ["bash", "packaging/scripts/package.sh", "v0.5.1", "--dist", str(tmp_path / "dist"), "--skip-build"],
        cwd=project,
    )

    assert result.returncode != 0
    assert "must match VERSION" in result.stderr


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


def test_checksums_fail_when_no_artifacts(tmp_path):
    project = make_project(tmp_path)
    dist = tmp_path / "empty-dist"
    dist.mkdir()

    result = run(["bash", "packaging/scripts/checksums.sh", str(dist)], cwd=project)

    assert result.returncode != 0
    assert "No release artifacts found" in result.stderr
    assert not (dist / "checksums.txt").exists()


def test_default_build_refuses_dirty_generated_outputs(tmp_path):
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

    assert result.returncode != 0
    assert "Build left the worktree dirty" in result.stderr
    assert "Yulu.app/Contents/MacOS/audio_daemon" in result.stderr


def test_release_installer_source_exists_for_release_assets():
    assert (ROOT / "yulu" / "scripts" / "release_installer.py").is_file()
