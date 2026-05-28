import os
import shutil
import subprocess
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def write_file(path: Path, text: str = "x\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def make_project(tmp_path: Path, version: str = "0.5.0-dev") -> Path:
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
    write_file(project / "tests" / "test_dev_only.py", "def test_dev_only(): pass\n")
    write_file(project / ".git" / "HEAD", "ref: refs/heads/main\n")
    write_file(project / ".github" / "workflows" / "ci.yml", "name: ci\n")
    write_file(project / "dist" / "old.zip", "old\n")
    write_file(project / ".ci-build" / "artifact", "build\n")

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
    assert not any(name.startswith("yulu/.git/") for name in names)
    assert not any(name.startswith("yulu/.github/") for name in names)
    assert not any(name.startswith("yulu/dist/") for name in names)
    assert not any(name.startswith("yulu/.ci-build/") for name in names)
    assert not any(name.startswith("yulu/tests/") for name in names)
    assert not any(name.startswith("yulu/docs/superpowers/") for name in names)


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
