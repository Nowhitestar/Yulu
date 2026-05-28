import hashlib
import json
import zipfile
from pathlib import Path

import pytest

import release_installer
from release_installer import InstallError, install_release_from_urls


def build_fake_asset(tmp_path: Path, tag: str = "v0.5.0", setup_body: str | None = None) -> tuple[Path, Path]:
    root = tmp_path / "asset-root" / "yulu"
    (root / "yulu" / "scripts").mkdir(parents=True)
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
    assert "rollback failed" in message
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
