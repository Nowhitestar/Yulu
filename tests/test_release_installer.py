import json
import shutil
import subprocess
import urllib.error
import zipfile
from pathlib import Path

import pytest

import release_installer
from release_installer import (
    build_dev_metadata,
    fetch_json,
    download_to_path,
    extract_release_zip,
    github_release_api_url,
    install_dev_channel,
    install_release_target,
    InstallMetadata,
    InstallError,
    main,
    ReleaseAsset,
    ReleaseTarget,
    replace_runtime_with_backup,
    read_install_metadata,
    normalize_version_tag,
    parse_checksums,
    parse_target_args,
    run,
    read_url_text,
    restore_backup,
    select_release_asset,
    resolve_release_from_payload,
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


def test_select_release_asset_finds_pkg():
    release = {
        "tag_name": "v0.5.0",
        "assets": [
            {
                "name": "yulu-macos-arm64-v0.5.0.pkg",
                "browser_download_url": "https://example/yulu.pkg",
            },
        ],
    }

    selected = select_release_asset(release)

    assert selected == ReleaseAsset(
        tag="v0.5.0",
        asset_name="yulu-macos-arm64-v0.5.0.pkg",
        asset_url="https://example/yulu.pkg",
    )


def test_select_release_asset_errors_when_pkg_missing():
    with pytest.raises(InstallError, match="does not provide"):
        select_release_asset({"tag_name": "v0.5.0", "assets": []})


@pytest.mark.parametrize("url", [None, ""])
def test_select_release_asset_errors_when_pkg_url_missing_or_empty(url):
    release = {
        "tag_name": "v0.5.0",
        "assets": [
            {"name": "yulu-macos-arm64-v0.5.0.pkg", "browser_download_url": url},
        ],
    }

    with pytest.raises(InstallError, match="download URL"):
        select_release_asset(release)


def test_github_latest_release_url():
    assert github_release_api_url(ReleaseTarget(kind="latest")).endswith("/releases/latest")


def test_github_version_release_url():
    assert github_release_api_url(ReleaseTarget(kind="version", tag="v0.5.0")).endswith(
        "/releases/tags/v0.5.0"
    )


def test_github_release_url_rejects_dev_target():
    with pytest.raises(InstallError, match="not valid"):
        github_release_api_url(ReleaseTarget(kind="dev"))


def test_resolve_release_from_payload_returns_selected_asset():
    payload = {
        "tag_name": "v0.5.0",
        "assets": [
            {"name": "yulu-macos-arm64-v0.5.0.pkg", "browser_download_url": "https://example/yulu.pkg"},
        ],
    }
    asset = resolve_release_from_payload(payload)
    assert asset.tag == "v0.5.0"


def test_install_release_target_fetches_payload_and_installs_selected_asset(tmp_path, monkeypatch):
    payload = {
        "tag_name": "v0.5.0",
        "assets": [
            {"name": "yulu-macos-arm64-v0.5.0.pkg", "browser_download_url": "https://example/yulu.pkg"},
        ],
    }
    calls = []

    def fake_fetch_json(url):
        calls.append(("fetch", url))
        return payload

    def fake_install_release_pkg_from_url(**kwargs):
        calls.append(("install", kwargs))

    monkeypatch.setattr(release_installer, "fetch_json", fake_fetch_json)
    monkeypatch.setattr(release_installer, "install_release_pkg_from_url", fake_install_release_pkg_from_url)

    install_release_target(ReleaseTarget(kind="version", tag="v0.5.0"), tmp_path / "install", run_setup_flag=False)

    assert calls[0] == (
        "fetch",
        "https://api.github.com/repos/Nowhitestar/Yulu/releases/tags/v0.5.0",
    )
    assert calls[1][1] == {
        "tag": "v0.5.0",
        "asset_name": "yulu-macos-arm64-v0.5.0.pkg",
        "asset_url": "https://example/yulu.pkg",
        "install_dir": tmp_path / "install",
        "run_setup": False,
    }


def test_fetch_json_maps_github_404_to_install_error(monkeypatch):
    def raise_not_found(*args, **kwargs):
        raise urllib.error.HTTPError(
            "https://api.github.com/repos/Nowhitestar/Yulu/releases/tags/v0.0.0",
            404,
            "Not Found",
            {},
            None,
        )

    monkeypatch.setattr(release_installer.urllib.request, "urlopen", raise_not_found)

    with pytest.raises(InstallError, match="Release v0.0.0 was not found"):
        fetch_json("https://api.github.com/repos/Nowhitestar/Yulu/releases/tags/v0.0.0")


def test_fetch_json_wraps_url_errors(monkeypatch):
    def raise_url_error(*args, **kwargs):
        raise urllib.error.URLError("network down")

    monkeypatch.setattr(release_installer.urllib.request, "urlopen", raise_url_error)

    with pytest.raises(InstallError, match="Failed to fetch GitHub release metadata"):
        fetch_json("https://api.github.com/repos/Nowhitestar/Yulu/releases/latest")


def test_download_to_path_wraps_url_errors(tmp_path, monkeypatch):
    def raise_url_error(*args, **kwargs):
        raise urllib.error.URLError("network down")

    monkeypatch.setattr(release_installer.urllib.request, "urlopen", raise_url_error)

    with pytest.raises(InstallError, match="Failed to download"):
        download_to_path("https://example.invalid/yulu.zip", tmp_path / "yulu.zip")


def test_read_url_text_wraps_url_errors(monkeypatch):
    def raise_url_error(*args, **kwargs):
        raise urllib.error.URLError("network down")

    monkeypatch.setattr(release_installer.urllib.request, "urlopen", raise_url_error)

    with pytest.raises(InstallError, match="Failed to download"):
        read_url_text("https://example.invalid/checksums.txt")


def test_main_reports_asset_download_errors_cleanly(tmp_path, monkeypatch, capsys):
    payload = {
        "tag_name": "v0.5.0",
        "assets": [
            {
                "name": "yulu-macos-arm64-v0.5.0.pkg",
                "browser_download_url": "https://example.invalid/yulu.pkg",
            },
        ],
    }

    def raise_url_error(*args, **kwargs):
        raise urllib.error.URLError("network down")

    monkeypatch.setattr(release_installer, "fetch_json", lambda _url: payload)
    monkeypatch.setattr(release_installer.urllib.request, "urlopen", raise_url_error)

    exit_code = main(["install", "--latest", "--install-dir", str(tmp_path / "install"), "--no-setup"])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "Yulu install failed: Failed to download" in captured.err
    assert "Traceback" not in captured.err


def test_main_installs_release_target(tmp_path, monkeypatch):
    calls = []

    def fake_install_release_target(target, install_dir, run_setup_flag=True):
        calls.append((target, install_dir, run_setup_flag))

    monkeypatch.setattr(release_installer, "install_release_target", fake_install_release_target)

    exit_code = main(["install", "--version", "0.5.0", "--install-dir", str(tmp_path / "install"), "--no-setup"])

    assert exit_code == 0
    assert calls == [(ReleaseTarget(kind="version", tag="v0.5.0"), tmp_path / "install", False)]


def test_main_plan_json_does_not_install(tmp_path, monkeypatch, capsys):
    def fail_install_release_target(*args, **kwargs):
        raise AssertionError("plan mode must not install")

    monkeypatch.setattr(release_installer, "install_release_target", fail_install_release_target)

    exit_code = main([
        "install",
        "--version", "0.5.0",
        "--install-dir", str(tmp_path / "install"),
        "--plan",
        "--json",
    ])

    assert exit_code == 0
    data = json.loads(capsys.readouterr().out)
    assert data["dry_run"] is True
    assert data["target"] == {"kind": "version", "tag": "v0.5.0"}
    assert data["install_dir"] == str(tmp_path / "install")
    assert [action["name"] for action in data["actions"]] == [
        "resolve_github_release",
        "download_pkg_asset",
        "run_macos_installer",
        "validate_runtime_layout",
    ]


def test_main_success_json_reports_target(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(release_installer, "install_release_target", lambda *a, **k: None)

    exit_code = main([
        "update",
        "--latest",
        "--install-dir", str(tmp_path / "install"),
        "--json",
    ])

    assert exit_code == 0
    data = json.loads(capsys.readouterr().out)
    assert data["ok"] is True
    assert data["command"] == "update"
    assert data["target"] == {"kind": "latest", "tag": None}


def test_main_error_json_is_machine_readable(tmp_path, monkeypatch, capsys):
    def fail_install_release_target(*args, **kwargs):
        raise InstallError("no release")

    monkeypatch.setattr(release_installer, "install_release_target", fail_install_release_target)

    exit_code = main([
        "install",
        "--latest",
        "--install-dir", str(tmp_path / "install"),
        "--json",
    ])

    captured = capsys.readouterr()
    assert exit_code == 1
    data = json.loads(captured.out)
    assert data["ok"] is False
    assert data["error"] == "no release"
    assert captured.err == ""


def test_main_installs_dev_channel(tmp_path, monkeypatch):
    calls = []

    def fake_install_dev_channel(install_dir, run_setup_flag=True):
        calls.append((install_dir, run_setup_flag))

    monkeypatch.setattr(release_installer, "install_dev_channel", fake_install_dev_channel)

    exit_code = main(["update", "--dev", "--install-dir", str(tmp_path / "install")])

    assert exit_code == 0
    assert calls == [(tmp_path / "install", True)]


def test_main_returns_one_for_install_errors(tmp_path, monkeypatch, capsys):
    def fail_install_release_target(*args, **kwargs):
        raise InstallError("no release")

    monkeypatch.setattr(release_installer, "install_release_target", fail_install_release_target)

    exit_code = main(["install", "--latest", "--install-dir", str(tmp_path / "install")])

    assert exit_code == 1
    assert "Yulu install failed: no release" in capsys.readouterr().err


def test_main_rejects_empty_version_cleanly_without_resolving_latest(tmp_path, monkeypatch, capsys):
    def fail_install_release_target(*args, **kwargs):
        raise AssertionError("install_release_target should not be called")

    monkeypatch.setattr(release_installer, "install_release_target", fail_install_release_target)

    exit_code = main(["install", "--version", "", "--install-dir", str(tmp_path / "install")])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "Yulu install failed:" in captured.err
    assert "valid SemVer" in captured.err
    assert captured.out == ""


def test_main_rejects_invalid_version_cleanly_without_traceback(tmp_path, capsys):
    exit_code = main(["install", "--version", "banana", "--install-dir", str(tmp_path / "install")])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "Yulu install failed:" in captured.err
    assert "valid SemVer" in captured.err
    assert "Traceback" not in captured.err
    assert captured.out == ""


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


def test_install_dev_channel_updates_clean_existing_checkout(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    (install_dir / ".git").mkdir(parents=True)
    commands = []
    setup_calls = []

    def fake_run(cmd, cwd=None):
        commands.append((cmd, cwd))
        if cmd == ["git", "status", "--porcelain"]:
            return ""
        if cmd == ["git", "rev-parse", "HEAD"]:
            return "abc1234def5678abc1234def5678abc1234def56"
        if cmd == ["git", "rev-parse", "origin/main"]:
            return "abc1234def5678abc1234def5678abc1234def56"
        if cmd == ["git", "rev-parse", "--short", "HEAD"]:
            return "abc1234"
        return ""

    def fake_setup(path, upgrade):
        setup_calls.append((path, upgrade))

    monkeypatch.setattr(release_installer, "run", fake_run)
    monkeypatch.setattr(release_installer, "run_setup", fake_setup)

    install_dev_channel(install_dir)

    assert [cmd for cmd, _ in commands] == [
        ["git", "status", "--porcelain"],
        ["git", "fetch", "--quiet", "origin"],
        ["git", "checkout", "--quiet", "main"],
        ["git", "pull", "--ff-only", "origin", "main"],
        ["git", "rev-parse", "HEAD"],
        ["git", "rev-parse", "origin/main"],
        ["git", "rev-parse", "--short", "HEAD"],
    ]
    assert all(cwd == install_dir for _, cwd in commands)
    assert read_install_metadata(install_dir)["source"] == "dev"
    assert read_install_metadata(install_dir)["branch"] == "main"
    assert read_install_metadata(install_dir)["commit"] == "abc1234"
    assert setup_calls == [(install_dir, True)]


def test_install_dev_channel_rejects_dirty_existing_checkout_before_fetch(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    (install_dir / ".git").mkdir(parents=True)
    commands = []

    def fake_run(cmd, cwd=None):
        commands.append(cmd)
        if cmd == ["git", "status", "--porcelain"]:
            return " M yulu/scripts/release_installer.py"
        return ""

    monkeypatch.setattr(release_installer, "run", fake_run)

    with pytest.raises(InstallError, match="local changes"):
        install_dev_channel(install_dir)

    assert commands == [["git", "status", "--porcelain"]]


def test_install_dev_channel_rejects_full_sha_mismatch_even_with_same_short_prefix(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    (install_dir / ".git").mkdir(parents=True)
    commands = []
    setup_calls = []

    def fake_run(cmd, cwd=None):
        commands.append(cmd)
        if cmd == ["git", "status", "--porcelain"]:
            return ""
        if cmd == ["git", "rev-parse", "HEAD"]:
            return "abc12340000000000000000000000000000000000"
        if cmd == ["git", "rev-parse", "origin/main"]:
            return "abc1234fffffffffffffffffffffffffffffffff"
        return ""

    def fake_setup(path, upgrade):
        setup_calls.append((path, upgrade))

    monkeypatch.setattr(release_installer, "run", fake_run)
    monkeypatch.setattr(release_installer, "run_setup", fake_setup)

    with pytest.raises(InstallError, match="local main differs from origin/main"):
        install_dev_channel(install_dir)

    assert commands == [
        ["git", "status", "--porcelain"],
        ["git", "fetch", "--quiet", "origin"],
        ["git", "checkout", "--quiet", "main"],
        ["git", "pull", "--ff-only", "origin", "main"],
        ["git", "rev-parse", "HEAD"],
        ["git", "rev-parse", "origin/main"],
    ]
    assert read_install_metadata(install_dir) == {}
    assert setup_calls == []


def test_install_dev_channel_does_not_write_metadata_when_setup_fails(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    (install_dir / ".git").mkdir(parents=True)

    def fake_run(cmd, cwd=None):
        if cmd == ["git", "status", "--porcelain"]:
            return ""
        if cmd == ["git", "rev-parse", "HEAD"]:
            return "abc1234def5678abc1234def5678abc1234def56"
        if cmd == ["git", "rev-parse", "origin/main"]:
            return "abc1234def5678abc1234def5678abc1234def56"
        if cmd == ["git", "rev-parse", "--short", "HEAD"]:
            return "abc1234"
        return ""

    def fail_setup(path, upgrade):
        raise InstallError("setup failed")

    monkeypatch.setattr(release_installer, "run", fake_run)
    monkeypatch.setattr(release_installer, "run_setup", fail_setup)

    with pytest.raises(InstallError, match="setup failed"):
        install_dev_channel(install_dir)

    assert not (install_dir / ".yulu-install.json").exists()


def test_install_dev_channel_clones_missing_install_dir_with_fresh_setup(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    commands = []
    setup_calls = []

    def fake_run(cmd, cwd=None):
        commands.append((cmd, cwd))
        if cmd[:3] == ["git", "clone", "--branch"]:
            install_dir.mkdir()
            return ""
        if cmd == ["git", "rev-parse", "--short", "HEAD"]:
            return "def5678"
        return ""

    def fake_setup(path, upgrade):
        setup_calls.append((path, upgrade))

    monkeypatch.setattr(release_installer, "run", fake_run)
    monkeypatch.setattr(release_installer, "run_setup", fake_setup)

    install_dev_channel(install_dir)

    assert commands == [
        (["git", "clone", "--branch", "main", release_installer.REPO_URL, str(install_dir)], None),
        (["git", "rev-parse", "--short", "HEAD"], install_dir),
    ]
    assert read_install_metadata(install_dir)["source"] == "dev"
    assert read_install_metadata(install_dir)["branch"] == "main"
    assert read_install_metadata(install_dir)["commit"] == "def5678"
    assert setup_calls == [(install_dir, False)]


def test_install_dev_channel_replaces_release_runtime_with_checkout(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "VERSION").write_text("0.5.0\n", encoding="utf-8")
    (install_dir / ".yulu-install.json").write_text('{"source":"release"}\n', encoding="utf-8")
    commands = []
    setup_calls = []

    def fake_run(cmd, cwd=None):
        commands.append((cmd, cwd))
        if cmd[:3] == ["git", "clone", "--branch"]:
            assert not install_dir.exists()
            install_dir.mkdir()
            (install_dir / ".git").mkdir()
            return ""
        if cmd == ["git", "rev-parse", "--short", "HEAD"]:
            return "def5678"
        return ""

    def fake_setup(path, upgrade):
        setup_calls.append((path, upgrade))

    monkeypatch.setattr(release_installer, "run", fake_run)
    monkeypatch.setattr(release_installer, "run_setup", fake_setup)

    install_dev_channel(install_dir)

    backups = list(tmp_path.glob("install.backup-*"))
    assert len(backups) == 1
    assert (backups[0] / "VERSION").read_text(encoding="utf-8") == "0.5.0\n"
    assert (install_dir / ".git").is_dir()
    assert read_install_metadata(install_dir)["source"] == "dev"
    assert setup_calls == [(install_dir, True)]
    assert commands == [
        (["git", "clone", "--branch", "main", release_installer.REPO_URL, str(install_dir)], None),
        (["git", "rev-parse", "--short", "HEAD"], install_dir),
    ]


def test_install_dev_channel_rolls_back_release_runtime_when_setup_fails(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "VERSION").write_text("0.5.0\n", encoding="utf-8")
    (install_dir / ".yulu-install.json").write_text('{"source":"release"}\n', encoding="utf-8")

    def fake_run(cmd, cwd=None):
        if cmd[:3] == ["git", "clone", "--branch"]:
            install_dir.mkdir()
            (install_dir / ".git").mkdir()
            return ""
        if cmd == ["git", "rev-parse", "--short", "HEAD"]:
            return "def5678"
        return ""

    def fail_setup(path, upgrade):
        raise InstallError("setup failed")

    monkeypatch.setattr(release_installer, "run", fake_run)
    monkeypatch.setattr(release_installer, "run_setup", fail_setup)

    with pytest.raises(InstallError, match="setup failed"):
        install_dev_channel(install_dir)

    assert (install_dir / "VERSION").read_text(encoding="utf-8") == "0.5.0\n"
    assert not (install_dir / ".git").exists()
    assert read_install_metadata(install_dir)["source"] == "release"


def test_run_wraps_timeout_as_install_error(monkeypatch):
    def raise_timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd=args[0], timeout=kwargs.get("timeout"))

    monkeypatch.setattr("release_installer.subprocess.run", raise_timeout)

    with pytest.raises(InstallError, match="timed out"):
        run(["git", "status"], timeout=1)


def test_run_wraps_os_error_as_install_error(monkeypatch):
    def raise_os_error(*args, **kwargs):
        raise OSError("no such file")

    monkeypatch.setattr("release_installer.subprocess.run", raise_os_error)

    with pytest.raises(InstallError, match="git status failed"):
        run(["git", "status"])


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


def test_extract_release_zip_restores_executable_bits(tmp_path):
    """ZipFile.extractall() drops the Unix mode stored in external_attr, landing
    every file as 0644 — which makes the Mach-O binaries launchd spawns directly
    fail to launch. extract_release_zip must restore the recorded mode."""
    zip_path = tmp_path / "release.zip"
    dest = tmp_path / "extract"
    with zipfile.ZipFile(zip_path, "w") as archive:
        archive.writestr("yulu/VERSION", "0.5.0\n")
        archive.writestr("yulu/README.md", "doc")  # plain file: must stay non-exec
        exe = zipfile.ZipInfo("yulu/scripts/run.sh")
        exe.external_attr = 0o755 << 16
        archive.writestr(exe, "#!/bin/sh\necho hi\n")

    runtime = extract_release_zip(zip_path, dest)

    run_sh = runtime / "scripts" / "run.sh"
    assert run_sh.stat().st_mode & 0o111, "executable bit must survive extraction"
    assert run_sh.stat().st_mode & 0o777 == 0o755
    assert not (runtime / "README.md").stat().st_mode & 0o111, "plain file must not gain +x"
