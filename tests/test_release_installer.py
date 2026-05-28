import json
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

import release_installer
from release_installer import (
    build_dev_metadata,
    download_to_path,
    ensure_dev_switch_allowed,
    extract_release_zip,
    InstallMetadata,
    InstallError,
    ReleaseAsset,
    ReleaseTarget,
    replace_runtime_with_backup,
    read_install_metadata,
    normalize_version_tag,
    parse_checksums,
    parse_target_args,
    read_url_text,
    restore_backup,
    select_release_asset,
    sha256_file,
    validate_runtime_layout,
    verify_checksum,
    write_install_metadata,
)


def test_parse_default_target_is_latest_release():
    target = parse_target_args([])
    assert target == ReleaseTarget(kind="latest", tag=None)


def test_parse_explicit_latest_target():
    target = parse_target_args(["--latest"])
    assert target == ReleaseTarget(kind="latest", tag=None)


def test_parse_version_target_normalizes_leading_v():
    target = parse_target_args(["--version", "0.5.0"])
    assert target == ReleaseTarget(kind="version", tag="v0.5.0")


def test_parse_dev_target():
    target = parse_target_args(["--dev"])
    assert target == ReleaseTarget(kind="dev", tag=None)


def test_parse_rejects_version_and_dev_together():
    with pytest.raises(SystemExit):
        parse_target_args(["--version", "v0.5.0", "--dev"])


def test_parse_rejects_latest_and_version_together():
    with pytest.raises(SystemExit):
        parse_target_args(["--latest", "--version", "v0.5.0"])


def test_parse_rejects_latest_and_dev_together():
    with pytest.raises(SystemExit):
        parse_target_args(["--latest", "--dev"])


def test_parse_rejects_empty_explicit_version():
    with pytest.raises(ValueError, match="valid SemVer"):
        parse_target_args(["--version", ""])


def test_normalize_version_tag_rejects_invalid_semver():
    with pytest.raises(ValueError, match="valid SemVer"):
        normalize_version_tag("banana")


@pytest.mark.parametrize(
    "version",
    [
        "01.2.3",
        "1.02.3",
        "1.2.03",
        "1.2.3-alpha..1",
        "1.2.3-01",
    ],
)
def test_normalize_version_tag_rejects_invalid_semver_boundaries(version):
    with pytest.raises(ValueError, match="valid SemVer"):
        normalize_version_tag(version)


def test_select_release_asset_finds_zip_and_checksums():
    release = {
        "tag_name": "v0.5.0",
        "assets": [
            {"name": "checksums.txt", "browser_download_url": "https://example/checksums.txt"},
            {
                "name": "yulu-macos-arm64-v0.5.0.zip",
                "browser_download_url": "https://example/yulu.zip",
            },
        ],
    }

    selected = select_release_asset(release)

    assert selected == ReleaseAsset(
        tag="v0.5.0",
        asset_name="yulu-macos-arm64-v0.5.0.zip",
        asset_url="https://example/yulu.zip",
        checksums_url="https://example/checksums.txt",
    )


def test_select_release_asset_errors_when_zip_missing():
    with pytest.raises(InstallError, match="does not provide"):
        select_release_asset({"tag_name": "v0.5.0", "assets": []})


@pytest.mark.parametrize("url", [None, ""])
def test_select_release_asset_errors_when_zip_url_missing_or_empty(url):
    release = {
        "tag_name": "v0.5.0",
        "assets": [
            {"name": "checksums.txt", "browser_download_url": "https://example/checksums.txt"},
            {"name": "yulu-macos-arm64-v0.5.0.zip", "browser_download_url": url},
        ],
    }

    with pytest.raises(InstallError, match="download URL"):
        select_release_asset(release)


@pytest.mark.parametrize("url", [None, ""])
def test_select_release_asset_errors_when_checksum_url_missing_or_empty(url):
    release = {
        "tag_name": "v0.5.0",
        "assets": [
            {"name": "checksums.txt", "browser_download_url": url},
            {
                "name": "yulu-macos-arm64-v0.5.0.zip",
                "browser_download_url": "https://example/yulu.zip",
            },
        ],
    }

    with pytest.raises(InstallError, match="checksums.txt download URL"):
        select_release_asset(release)


def test_parse_checksums_accepts_sha256_lines():
    zip_checksum = "a" * 64
    script_checksum = "1" * 64
    checksums = parse_checksums(f"{zip_checksum}  yulu.zip\n{script_checksum}  install.sh\n")
    assert checksums["yulu.zip"] == zip_checksum
    assert checksums["install.sh"] == script_checksum


def test_parse_checksums_ignores_comments_and_non_sha256_lines():
    valid_checksum = "f" * 64
    checksums = parse_checksums(
        "\n"
        "# checksums for release\n"
        "abc  short.txt\n"
        f"{valid_checksum}  yulu.zip\n"
        "not-a-checksum  junk.zip\n"
        f"{'0' * 63}  too-short.zip\n"
        f"{'g' * 64}  non-hex.zip\n"
    )

    assert checksums == {"yulu.zip": valid_checksum}


def test_verify_checksum_passes_and_fails(tmp_path):
    artifact = tmp_path / "artifact.zip"
    artifact.write_bytes(b"hello")
    expected = sha256_file(artifact)

    verify_checksum(artifact, expected)

    with pytest.raises(InstallError, match="Checksum mismatch"):
        verify_checksum(artifact, "0" * 64)


def make_runtime(root: Path, version: str = "0.5.0") -> Path:
    runtime = root / "yulu"
    (runtime / "yulu" / "scripts").mkdir(parents=True)
    (runtime / "VERSION").write_text(version + "\n", encoding="utf-8")
    (runtime / "yulu" / "scripts" / "setup.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    (runtime / "yulu" / "scripts" / "yulu").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    (runtime / "yulu" / "scripts" / "version.py").write_text(
        "import sys\nsys.exit(0)\n",
        encoding="utf-8",
    )
    return runtime


def test_validate_runtime_layout_accepts_matching_version(tmp_path):
    runtime = make_runtime(tmp_path, "0.5.0")
    validate_runtime_layout(runtime, "v0.5.0")


def test_validate_runtime_layout_accepts_relative_runtime_path(tmp_path, monkeypatch):
    make_runtime(tmp_path, "0.5.0")
    monkeypatch.chdir(tmp_path)

    validate_runtime_layout(Path("yulu"), "v0.5.0")


def test_validate_runtime_layout_rejects_version_drift(tmp_path):
    runtime = make_runtime(tmp_path, "0.5.1")
    with pytest.raises(InstallError, match="VERSION"):
        validate_runtime_layout(runtime, "v0.5.0")


def test_validate_runtime_layout_rejects_required_directory(tmp_path):
    runtime = make_runtime(tmp_path, "0.5.0")
    setup_script = runtime / "yulu" / "scripts" / "setup.sh"
    setup_script.unlink()
    setup_script.mkdir()

    with pytest.raises(InstallError, match="setup.sh"):
        validate_runtime_layout(runtime, "v0.5.0")


def test_validate_runtime_layout_rejects_failed_version_check(tmp_path):
    runtime = make_runtime(tmp_path, "0.5.0")
    (runtime / "yulu" / "scripts" / "version.py").write_text(
        "import sys\nsys.stderr.write('bad version\\n')\nsys.exit(2)\n",
        encoding="utf-8",
    )

    with pytest.raises(InstallError, match="version.py --check failed"):
        validate_runtime_layout(runtime, "v0.5.0")


def test_validate_runtime_layout_wraps_version_check_timeout(tmp_path, monkeypatch):
    runtime = make_runtime(tmp_path, "0.5.0")

    def raise_timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd=args[0], timeout=kwargs.get("timeout"))

    monkeypatch.setattr("release_installer.subprocess.run", raise_timeout)

    with pytest.raises(InstallError, match="timed out"):
        validate_runtime_layout(runtime, "v0.5.0")


def test_install_metadata_roundtrip(tmp_path):
    metadata = InstallMetadata(
        source="release",
        version="v0.5.0",
        asset="yulu-macos-arm64-v0.5.0.zip",
        sha256="abc",
    )
    write_install_metadata(tmp_path, metadata)

    data = read_install_metadata(tmp_path)

    assert data["schema"] == 1
    assert data["source"] == "release"
    assert data["version"] == "v0.5.0"
    assert data["asset"] == "yulu-macos-arm64-v0.5.0.zip"
    assert data["sha256"] == "abc"
    assert "installed_at" in data
    assert json.loads((tmp_path / ".yulu-install.json").read_text(encoding="utf-8")) == data


def test_build_dev_metadata():
    metadata = build_dev_metadata(branch="main", commit="abc1234")
    assert metadata.source == "dev"
    assert metadata.branch == "main"
    assert metadata.commit == "abc1234"


def test_release_runtime_cannot_switch_to_dev_in_place(tmp_path):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / ".yulu-install.json").write_text('{"source":"release"}\n', encoding="utf-8")

    with pytest.raises(InstallError, match="Cannot switch release runtime to dev in-place"):
        ensure_dev_switch_allowed(install_dir)


def test_replace_runtime_with_backup_moves_existing_runtime(tmp_path):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "old.txt").write_text("old", encoding="utf-8")
    staged = tmp_path / "staged"
    staged.mkdir()
    (staged / "new.txt").write_text("new", encoding="utf-8")

    backup = replace_runtime_with_backup(staged, install_dir)

    assert (install_dir / "new.txt").read_text(encoding="utf-8") == "new"
    assert backup is not None
    assert (backup / "old.txt").read_text(encoding="utf-8") == "old"


def test_replace_runtime_with_backup_avoids_existing_backup_collision(tmp_path):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "old.txt").write_text("old", encoding="utf-8")
    staged = tmp_path / "staged"
    staged.mkdir()
    (staged / "new.txt").write_text("new", encoding="utf-8")
    existing_backup = tmp_path / "install.backup-existing"
    existing_backup.mkdir()
    (existing_backup / "sentinel.txt").write_text("sentinel", encoding="utf-8")

    backup = replace_runtime_with_backup(staged, install_dir)

    assert backup is not None
    assert backup != existing_backup
    assert (backup / "old.txt").read_text(encoding="utf-8") == "old"
    assert not (backup / "install").exists()
    assert (existing_backup / "sentinel.txt").read_text(encoding="utf-8") == "sentinel"


def test_replace_runtime_with_backup_restores_old_runtime_when_staged_move_fails(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "old.txt").write_text("old", encoding="utf-8")
    staged = tmp_path / "staged"
    staged.mkdir()
    (staged / "new.txt").write_text("new", encoding="utf-8")
    real_move = shutil.move
    move_calls = []

    def fail_second_move(src, dst, *args, **kwargs):
        move_calls.append((src, dst))
        if len(move_calls) == 2:
            raise OSError("staged move failed")
        return real_move(src, dst, *args, **kwargs)

    monkeypatch.setattr(release_installer.shutil, "move", fail_second_move)

    with pytest.raises(InstallError, match="staged move failed"):
        replace_runtime_with_backup(staged, install_dir)

    assert (install_dir / "old.txt").read_text(encoding="utf-8") == "old"
    assert not (install_dir / "install").exists()


def test_restore_backup_replaces_failed_runtime(tmp_path):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "bad.txt").write_text("bad", encoding="utf-8")
    backup = tmp_path / "backup"
    backup.mkdir()
    (backup / "old.txt").write_text("old", encoding="utf-8")

    restore_backup(backup, install_dir)

    assert (install_dir / "old.txt").read_text(encoding="utf-8") == "old"
    assert not (install_dir / "bad.txt").exists()


def test_restore_backup_replaces_failed_file_runtime(tmp_path):
    install_dir = tmp_path / "install"
    install_dir.write_text("bad", encoding="utf-8")
    backup = tmp_path / "backup"
    backup.mkdir()
    (backup / "old.txt").write_text("old", encoding="utf-8")

    restore_backup(backup, install_dir)

    assert install_dir.is_dir()
    assert (install_dir / "old.txt").read_text(encoding="utf-8") == "old"


def test_restore_backup_replaces_failed_symlink_runtime(tmp_path):
    target = tmp_path / "failed-target"
    target.mkdir()
    install_dir = tmp_path / "install"
    try:
        install_dir.symlink_to(target, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks are not supported on this filesystem")
    backup = tmp_path / "backup"
    backup.mkdir()
    (backup / "old.txt").write_text("old", encoding="utf-8")

    restore_backup(backup, install_dir)

    assert install_dir.is_dir()
    assert not install_dir.is_symlink()
    assert (install_dir / "old.txt").read_text(encoding="utf-8") == "old"


def test_restore_backup_replaces_dangling_symlink_runtime(tmp_path):
    install_dir = tmp_path / "install"
    missing_target = tmp_path / "missing-target"
    try:
        install_dir.symlink_to(missing_target, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks are not supported on this filesystem")
    backup = tmp_path / "backup"
    backup.mkdir()
    (backup / "old.txt").write_text("old", encoding="utf-8")

    restore_backup(backup, install_dir)

    assert install_dir.is_dir()
    assert not install_dir.is_symlink()
    assert (install_dir / "old.txt").read_text(encoding="utf-8") == "old"


def test_replace_runtime_with_backup_treats_dangling_symlink_as_existing(tmp_path):
    install_dir = tmp_path / "install"
    missing_target = tmp_path / "missing-target"
    try:
        install_dir.symlink_to(missing_target, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks are not supported on this filesystem")
    staged = tmp_path / "staged"
    staged.mkdir()
    (staged / "new.txt").write_text("new", encoding="utf-8")

    backup = replace_runtime_with_backup(staged, install_dir)

    assert backup is not None
    assert backup.is_symlink()
    assert not install_dir.is_symlink()
    assert (install_dir / "new.txt").read_text(encoding="utf-8") == "new"


def test_file_url_helpers_accept_localhost_and_reject_remote_hosts(tmp_path):
    source = tmp_path / "source.txt"
    source.write_text("hello", encoding="utf-8")
    localhost_url = f"file://localhost{source.as_posix()}"
    dest = tmp_path / "dest.txt"

    assert read_url_text(localhost_url) == "hello"
    download_to_path(localhost_url, dest)
    assert dest.read_text(encoding="utf-8") == "hello"

    with pytest.raises(InstallError, match="non-local file URL"):
        read_url_text("file://example.com/tmp/source.txt")
    with pytest.raises(InstallError, match="non-local file URL"):
        download_to_path("file://example.com/tmp/source.txt", tmp_path / "bad.txt")


def test_extract_release_zip_rejects_path_traversal(tmp_path):
    zip_path = tmp_path / "bad.zip"
    dest = tmp_path / "extract"
    outside = tmp_path / "evil.txt"
    with zipfile.ZipFile(zip_path, "w") as archive:
        archive.writestr("../evil.txt", "evil")
        archive.writestr("yulu/VERSION", "0.5.0\n")

    with pytest.raises(InstallError, match="Unsafe zip member"):
        extract_release_zip(zip_path, dest)

    assert not outside.exists()
