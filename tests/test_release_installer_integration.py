import hashlib
import json
import os
import tempfile
import time
import zipfile
from pathlib import Path

import pytest

import release_installer
from release_installer import InstallError, install_release_from_urls


@pytest.fixture(autouse=True)
def synthetic_assets_skip_macos_signature_verification(monkeypatch, tmp_path):
    """These transaction fixtures are not real Mach-O bundles.

    Signature enforcement has dedicated unit coverage; production installs do
    not set or honor a bypass flag.
    """
    monkeypatch.setattr(release_installer, "verify_release_bundle_security", lambda _runtime: None)
    monkeypatch.setattr(release_installer, "verify_runtime_manifest", lambda _runtime: None)
    monkeypatch.setattr(
        release_installer,
        "default_config_path",
        lambda: tmp_path / "config-home" / ".config" / "yulu" / "config.json",
    )


def build_fake_asset(tmp_path: Path, tag: str = "v0.5.0", setup_body: str | None = None) -> tuple[Path, Path]:
    root = tmp_path / "asset-root" / "yulu"
    (root / "yulu" / "scripts").mkdir(parents=True)
    keychain_helper = root / "yulu" / "scripts" / "Yulu.app" / "Contents" / "MacOS" / "xai_keychain"
    keychain_helper.parent.mkdir(parents=True)
    keychain_helper.write_text("binary\n", encoding="utf-8")
    (root / "VERSION").write_text(tag.removeprefix("v") + "\n", encoding="utf-8")
    setup_script = setup_body or '#!/usr/bin/env bash\necho setup "$@"\n'
    (root / "yulu" / "scripts" / "setup.sh").write_text(setup_script, encoding="utf-8")
    (root / "yulu" / "scripts" / "yulu").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    (root / "yulu" / "scripts" / "version.py").write_text("import sys\nsys.exit(0)\n", encoding="utf-8")
    zip_path = tmp_path / f"yulu-macos-arm64-{tag}.zip"
    with zipfile.ZipFile(zip_path, "w") as archive:
        for path in root.rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(root.parent))
    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    checksums = tmp_path / "checksums.txt"
    checksums.write_text(f"{digest}  {zip_path.name}\n", encoding="utf-8")
    return zip_path, checksums


def test_install_release_from_file_urls(tmp_path):
    zip_path, checksums = build_fake_asset(tmp_path)
    install_dir = tmp_path / "install"

    install_release_from_urls(
        tag="v0.5.0",
        asset_name=zip_path.name,
        asset_url=zip_path.as_uri(),
        checksums_url=checksums.as_uri(),
        install_dir=install_dir,
        run_setup=False,
    )

    assert (install_dir / "VERSION").read_text(encoding="utf-8").strip() == "0.5.0"
    metadata = json.loads((install_dir / ".yulu-install.json").read_text(encoding="utf-8"))
    assert metadata["source"] == "release"
    assert metadata["version"] == "v0.5.0"


def test_install_release_stages_under_install_parent(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path)
    install_dir = tmp_path / "nested" / "install"
    real_temporary_directory = tempfile.TemporaryDirectory
    seen_dirs = []

    def tracking_temporary_directory(*args, **kwargs):
        seen_dirs.append(Path(kwargs["dir"]))
        return real_temporary_directory(*args, **kwargs)

    monkeypatch.setattr(release_installer.tempfile, "TemporaryDirectory", tracking_temporary_directory)

    install_release_from_urls(
        tag="v0.5.0",
        asset_name=zip_path.name,
        asset_url=zip_path.as_uri(),
        checksums_url=checksums.as_uri(),
        install_dir=install_dir,
        run_setup=False,
    )

    assert seen_dirs == [install_dir.parent]


def test_install_release_rolls_back_when_setup_fails(tmp_path):
    zip_path, checksums = build_fake_asset(tmp_path, setup_body="#!/usr/bin/env bash\nexit 9\n")
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "VERSION").write_text("0.4.0\n", encoding="utf-8")
    (install_dir / "old.txt").write_text("old", encoding="utf-8")

    with pytest.raises(InstallError, match="setup.sh failed"):
        install_release_from_urls(
            tag="v0.5.0",
            asset_name=zip_path.name,
            asset_url=zip_path.as_uri(),
            checksums_url=checksums.as_uri(),
            install_dir=install_dir,
            run_setup=True,
        )

    assert (install_dir / "VERSION").read_text(encoding="utf-8").strip() == "0.4.0"
    assert (install_dir / "old.txt").read_text(encoding="utf-8") == "old"


def test_failed_fresh_install_cleans_external_state_before_removing_runtime(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path, setup_body="#!/usr/bin/env bash\nexit 9\n")
    install_dir = tmp_path / "install"
    cleanup_calls = []

    def fake_cleanup(path):
        cleanup_calls.append(path)
        assert path.exists()

    monkeypatch.setattr(release_installer, "cleanup_fresh_install_side_effects", fake_cleanup)

    with pytest.raises(InstallError, match="setup.sh failed"):
        install_release_from_urls(
            tag="v0.5.0",
            asset_name=zip_path.name,
            asset_url=zip_path.as_uri(),
            checksums_url=checksums.as_uri(),
            install_dir=install_dir,
            run_setup=True,
        )

    assert cleanup_calls == [install_dir]
    assert not install_dir.exists()


def test_failed_upgrade_restores_runtime_and_repairs_old_services(tmp_path):
    zip_path, checksums = build_fake_asset(tmp_path, setup_body="#!/usr/bin/env bash\nexit 9\n")
    install_dir = tmp_path / "install"
    old_scripts = install_dir / "yulu" / "scripts"
    old_scripts.mkdir(parents=True)
    (install_dir / "VERSION").write_text("0.4.0\n", encoding="utf-8")
    old_setup = old_scripts / "setup.sh"
    old_setup.write_text(
        "#!/usr/bin/env bash\n"
        "printf '%s\\n' \"$*\" > \"$(cd \"$(dirname \"$0\")/../..\" && pwd)/service-repair.log\"\n",
        encoding="utf-8",
    )

    with pytest.raises(InstallError, match="setup.sh failed"):
        install_release_from_urls(
            tag="v0.5.0",
            asset_name=zip_path.name,
            asset_url=zip_path.as_uri(),
            checksums_url=checksums.as_uri(),
            install_dir=install_dir,
            run_setup=True,
        )

    assert (install_dir / "VERSION").read_text(encoding="utf-8").strip() == "0.4.0"
    assert (install_dir / "service-repair.log").read_text(encoding="utf-8").strip() == "--upgrade"


def test_failed_upgrade_restores_runtime_and_atomically_snapshotted_config(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path)
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "VERSION").write_text("0.4.0\n", encoding="utf-8")
    (install_dir / "old.txt").write_text("old\n", encoding="utf-8")
    config_path = tmp_path / "config" / "config.json"
    config_path.parent.mkdir()
    config_path.write_text('{"schema":"old"}\n', encoding="utf-8")
    config_path.chmod(0o644)
    snapshots_seen = []

    def fail_after_migration(_path, upgrade, timeout):
        assert upgrade is True
        snapshots = list(config_path.parent.glob(".config.json.yulu-install-snapshot-*"))
        assert len(snapshots) == 1
        snapshot = snapshots[0]
        snapshots_seen.append(snapshot)
        assert snapshot.parent == config_path.parent
        assert snapshot.stat().st_mode & 0o777 == 0o600
        assert snapshot.read_text(encoding="utf-8") == '{"schema":"old"}\n'
        config_path.write_text('{"schema":"migrated"}\n', encoding="utf-8")
        raise InstallError("post-migration health failed")

    monkeypatch.setattr(release_installer, "_run_setup_script", fail_after_migration)

    with pytest.raises(InstallError, match="post-migration health failed"):
        install_release_from_urls(
            tag="v0.5.0",
            asset_name=zip_path.name,
            asset_url=zip_path.as_uri(),
            checksums_url=checksums.as_uri(),
            install_dir=install_dir,
            run_setup=True,
            config_path=config_path,
        )

    assert snapshots_seen
    assert (install_dir / "VERSION").read_text(encoding="utf-8").strip() == "0.4.0"
    assert (install_dir / "old.txt").read_text(encoding="utf-8") == "old\n"
    assert config_path.read_text(encoding="utf-8") == '{"schema":"old"}\n'
    assert config_path.stat().st_mode & 0o777 == 0o600
    assert not list(config_path.parent.glob(".config.json.yulu-install-snapshot-*"))


def test_failed_upgrade_removes_config_created_when_none_existed_before(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path)
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "VERSION").write_text("0.4.0\n", encoding="utf-8")
    (install_dir / "old.txt").write_text("old\n", encoding="utf-8")
    config_path = tmp_path / "config" / "config.json"

    def fail_after_creating_config(_path, upgrade, timeout):
        assert upgrade is True
        config_path.parent.mkdir(parents=True)
        config_path.write_text('{"schema":"new"}\n', encoding="utf-8")
        raise InstallError("health failed")

    monkeypatch.setattr(release_installer, "_run_setup_script", fail_after_creating_config)

    with pytest.raises(InstallError, match="health failed"):
        install_release_from_urls(
            tag="v0.5.0",
            asset_name=zip_path.name,
            asset_url=zip_path.as_uri(),
            checksums_url=checksums.as_uri(),
            install_dir=install_dir,
            run_setup=True,
            config_path=config_path,
        )

    assert (install_dir / "VERSION").read_text(encoding="utf-8").strip() == "0.4.0"
    assert not config_path.exists()


def test_successful_upgrade_discards_config_snapshot_but_keeps_migrated_config(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path)
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "VERSION").write_text("0.4.0\n", encoding="utf-8")
    config_path = tmp_path / "config" / "config.json"
    config_path.parent.mkdir()
    config_path.write_text('{"schema":"old"}\n', encoding="utf-8")

    def successful_migration(_path, upgrade, timeout):
        assert upgrade is True
        config_path.write_text('{"schema":"migrated"}\n', encoding="utf-8")

    monkeypatch.setattr(release_installer, "_run_setup_script", successful_migration)

    install_release_from_urls(
        tag="v0.5.0",
        asset_name=zip_path.name,
        asset_url=zip_path.as_uri(),
        checksums_url=checksums.as_uri(),
        install_dir=install_dir,
        run_setup=True,
        config_path=config_path,
    )

    assert config_path.read_text(encoding="utf-8") == '{"schema":"migrated"}\n'
    assert not list(config_path.parent.glob(".config.json.yulu-install-snapshot-*"))


def test_release_runtime_to_dev_failure_restores_runtime_config_and_services(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    old_scripts = install_dir / "yulu" / "scripts"
    old_scripts.mkdir(parents=True)
    (install_dir / "VERSION").write_text("0.4.0\n", encoding="utf-8")
    (install_dir / ".yulu-install.json").write_text('{"source":"release"}\n', encoding="utf-8")
    old_setup = old_scripts / "setup.sh"
    old_setup.write_text(
        "#!/usr/bin/env bash\n"
        "printf '%s\\n' \"$*\" > \"$(cd \"$(dirname \"$0\")/../..\" && pwd)/service-repair.log\"\n",
        encoding="utf-8",
    )
    config_path = tmp_path / "config" / "config.json"
    config_path.parent.mkdir()
    config_path.write_text('{"schema":"old"}\n', encoding="utf-8")

    def fake_run(cmd, cwd=None):
        if cmd[:3] == ["git", "clone", "--branch"]:
            assert not install_dir.exists()
            install_dir.mkdir()
            (install_dir / ".git").mkdir()
            return ""
        if cmd == ["git", "rev-parse", "--short", "HEAD"]:
            return "def5678"
        return ""

    def fail_dev_setup(path, upgrade):
        assert path == install_dir
        assert upgrade is True
        config_path.write_text('{"schema":"migrated"}\n', encoding="utf-8")
        raise InstallError("dev setup health failed")

    monkeypatch.setattr(release_installer, "run", fake_run)
    monkeypatch.setattr(release_installer, "run_setup", fail_dev_setup)

    with pytest.raises(InstallError, match="dev setup health failed"):
        release_installer.install_dev_channel(install_dir, config_path=config_path)

    assert (install_dir / "VERSION").read_text(encoding="utf-8").strip() == "0.4.0"
    assert not (install_dir / ".git").exists()
    assert config_path.read_text(encoding="utf-8") == '{"schema":"old"}\n'
    assert config_path.stat().st_mode & 0o777 == 0o600
    assert (install_dir / "service-repair.log").read_text(encoding="utf-8").strip() == "--upgrade"
    assert not list(config_path.parent.glob(".config.json.yulu-install-snapshot-*"))


def test_install_release_reports_original_error_when_rollback_fails(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path, setup_body="#!/usr/bin/env bash\nexit 9\n")
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "VERSION").write_text("0.4.0\n", encoding="utf-8")

    def fail_restore(*args, **kwargs):
        raise RuntimeError("restore exploded")

    monkeypatch.setattr(release_installer, "restore_backup", fail_restore)

    with pytest.raises(InstallError) as excinfo:
        install_release_from_urls(
            tag="v0.5.0",
            asset_name=zip_path.name,
            asset_url=zip_path.as_uri(),
            checksums_url=checksums.as_uri(),
            install_dir=install_dir,
            run_setup=True,
        )

    message = str(excinfo.value)
    assert "setup.sh failed with exit code 9" in message
    assert "rollback or service repair failed" in message
    assert "restore exploded" in message


def test_install_release_rolls_back_when_setup_times_out(tmp_path):
    zip_path, checksums = build_fake_asset(tmp_path, setup_body="#!/usr/bin/env bash\nsleep 5\n")
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "VERSION").write_text("0.4.0\n", encoding="utf-8")
    (install_dir / "old.txt").write_text("old", encoding="utf-8")

    with pytest.raises(InstallError, match="setup.sh timed out"):
        install_release_from_urls(
            tag="v0.5.0",
            asset_name=zip_path.name,
            asset_url=zip_path.as_uri(),
            checksums_url=checksums.as_uri(),
            install_dir=install_dir,
            run_setup=True,
            setup_timeout=0.01,
        )

    assert (install_dir / "VERSION").read_text(encoding="utf-8").strip() == "0.4.0"
    assert (install_dir / "old.txt").read_text(encoding="utf-8") == "old"


def test_setup_timeout_terminates_background_child_process_group(tmp_path):
    child_pid_file = tmp_path / "child.pid"
    zip_path, checksums = build_fake_asset(
        tmp_path,
        setup_body=(
            "#!/usr/bin/env bash\n"
            "sleep 30 &\n"
            f"printf '%s\\n' \"$!\" > {child_pid_file!s}\n"
            "wait\n"
        ),
    )
    install_dir = tmp_path / "install"

    with pytest.raises(InstallError, match="terminated its process group"):
        install_release_from_urls(
            tag="v0.5.0",
            asset_name=zip_path.name,
            asset_url=zip_path.as_uri(),
            checksums_url=checksums.as_uri(),
            install_dir=install_dir,
            run_setup=True,
            setup_timeout=0.2,
        )

    child_pid = int(child_pid_file.read_text(encoding="utf-8").strip())
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        pytest.fail(f"setup child process {child_pid} survived process-group timeout")


def test_install_release_checksum_mismatch_preserves_existing_runtime(tmp_path):
    zip_path, checksums = build_fake_asset(tmp_path)
    checksums.write_text(f"{'0' * 64}  {zip_path.name}\n", encoding="utf-8")
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "old.txt").write_text("old", encoding="utf-8")

    with pytest.raises(InstallError, match="Checksum mismatch"):
        install_release_from_urls(
            tag="v0.5.0",
            asset_name=zip_path.name,
            asset_url=zip_path.as_uri(),
            checksums_url=checksums.as_uri(),
            install_dir=install_dir,
            run_setup=False,
        )

    assert (install_dir / "old.txt").read_text(encoding="utf-8") == "old"
