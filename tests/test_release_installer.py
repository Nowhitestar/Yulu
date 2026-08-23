import base64
import json
import os
import plistlib
import shutil
import subprocess
import sys
import urllib.error
import zipfile
from pathlib import Path

import pytest

import release_installer
from release_installer import (
    acquire_install_lock,
    build_runtime_manifest_from_zip,
    build_dev_metadata,
    cleanup_fresh_install_side_effects,
    ensure_release_architecture,
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
    prune_runtime_backups,
    run,
    read_url_text,
    restore_backup,
    select_release_asset,
    resolve_release_from_payload,
    sha256_file,
    validate_runtime_layout,
    verify_checksum,
    verify_release_bundle_security,
    verify_runtime_manifest,
    write_runtime_manifest,
    write_install_metadata,
)


ROOT = Path(__file__).resolve().parents[1]


def _write_executable(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(0o755)


def _bootstrap_env(tmp_path: Path) -> tuple[dict[str, str], Path, Path]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir(parents=True)
    curl_log = tmp_path / "curl.log"
    argv_log = tmp_path / "argv.log"
    downloaded_install = tmp_path / "downloaded-install.sh"
    downloaded_helper = tmp_path / "downloaded-helper.py"

    _write_executable(
        downloaded_install,
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        ": > \"$YULU_TEST_ARGV_LOG\"\n"
        "if (($#)); then printf '%s\\n' \"$@\" > \"$YULU_TEST_ARGV_LOG\"; fi\n"
        "mkdir -p \"$INSTALL_DIR\"\n"
        "printf '0.6.0\\n' > \"$INSTALL_DIR/VERSION\"\n",
    )
    downloaded_helper.write_text(
        "import os, pathlib, sys\n"
        "pathlib.Path(os.environ['YULU_TEST_ARGV_LOG']).write_text('\\n'.join(sys.argv[1:]) + '\\n')\n"
        "install_dir = pathlib.Path(sys.argv[sys.argv.index('--install-dir') + 1])\n"
        "install_dir.mkdir(parents=True, exist_ok=True)\n"
        "(install_dir / 'VERSION').write_text('dev\\n')\n"
        "scripts = install_dir / 'yulu' / 'scripts'\n"
        "scripts.mkdir(parents=True, exist_ok=True)\n"
        "(scripts / 'yulu').write_text('#!/usr/bin/env bash\\n')\n",
        encoding="utf-8",
    )
    _write_executable(
        fake_bin / "curl",
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "url=''\n"
        "out=''\n"
        "while (($#)); do\n"
        "  case \"$1\" in\n"
        "    -o) out=\"$2\"; shift 2 ;;\n"
        "    -*) shift ;;\n"
        "    *) url=\"$1\"; shift ;;\n"
        "  esac\n"
        "done\n"
        "printf '%s\\n' \"$url\" >> \"$YULU_TEST_CURL_LOG\"\n"
        "if [[ \"$url\" == */release_installer.py ]]; then\n"
        "  cp \"$YULU_TEST_HELPER\" \"$out\"\n"
        "else\n"
        "  cp \"$YULU_TEST_RELEASE_INSTALL\" \"$out\"\n"
        "fi\n",
    )
    _write_executable(fake_bin / "uname", "#!/usr/bin/env bash\n[[ ${1:-} == -s ]] && echo Darwin || echo arm64\n")
    _write_executable(fake_bin / "sw_vers", "#!/usr/bin/env bash\necho 13.6\n")
    _write_executable(fake_bin / "sysctl", "#!/usr/bin/env bash\necho 1\n")
    _write_executable(fake_bin / "xcode-select", "#!/usr/bin/env bash\necho /Applications/Xcode.app/Contents/Developer\n")
    _write_executable(fake_bin / "git", "#!/usr/bin/env bash\nexit 0\n")
    (fake_bin / "python3").symlink_to(sys.executable)

    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "YULU_TEST_CURL_LOG": str(curl_log),
            "YULU_TEST_ARGV_LOG": str(argv_log),
            "YULU_TEST_RELEASE_INSTALL": str(downloaded_install),
            "YULU_TEST_HELPER": str(downloaded_helper),
        }
    )
    return env, curl_log, argv_log


@pytest.mark.parametrize("args", [(), ("--latest",)])
def test_raw_stable_bootstrap_fetches_release_owned_latest_installer(tmp_path, args):
    env, curl_log, argv_log = _bootstrap_env(tmp_path)
    env["INSTALL_DIR"] = str(tmp_path / "install")

    result = subprocess.run(
        ["bash", str(ROOT / "install.sh"), *args],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert curl_log.read_text(encoding="utf-8").splitlines() == [
        "https://github.com/Nowhitestar/Yulu/releases/latest/download/install.sh"
    ]
    assert "/main/yulu/scripts/release_installer.py" not in curl_log.read_text(encoding="utf-8")
    assert argv_log.read_text(encoding="utf-8").splitlines() == list(args)


def test_raw_version_bootstrap_normalizes_tag_before_release_url(tmp_path):
    env, curl_log, argv_log = _bootstrap_env(tmp_path)
    env["INSTALL_DIR"] = str(tmp_path / "install")

    result = subprocess.run(
        ["bash", str(ROOT / "install.sh"), "--version", "0.6.0"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert curl_log.read_text(encoding="utf-8").splitlines() == [
        "https://github.com/Nowhitestar/Yulu/releases/download/v0.6.0/install.sh"
    ]
    assert argv_log.read_text(encoding="utf-8").splitlines() == ["--version", "v0.6.0"]


def test_raw_bootstrap_rejects_version_metacharacters_before_download(tmp_path):
    marker = tmp_path / "injected"
    env, curl_log, _ = _bootstrap_env(tmp_path)
    env["INSTALL_DIR"] = str(tmp_path / "install")

    result = subprocess.run(
        ["bash", str(ROOT / "install.sh"), "--version", f"0.6.0;touch {marker}"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 2
    assert "valid SemVer" in result.stderr
    assert not curl_log.exists()
    assert not marker.exists()


def test_raw_dev_bootstrap_is_only_path_using_main_helper(tmp_path):
    env, curl_log, argv_log = _bootstrap_env(tmp_path)
    env["INSTALL_DIR"] = str(tmp_path / "install")

    result = subprocess.run(
        ["bash", str(ROOT / "install.sh"), "--dev"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert curl_log.read_text(encoding="utf-8").splitlines() == [
        "https://raw.githubusercontent.com/Nowhitestar/Yulu/main/yulu/scripts/release_installer.py"
    ]
    assert argv_log.read_text(encoding="utf-8").splitlines()[-1] == "--dev"


def test_packaged_installer_pins_default_latest_and_rejects_conflicting_tag(tmp_path):
    project = tmp_path / "project"
    scripts = project / "packaging" / "scripts"
    helper = project / "yulu" / "scripts" / "release_installer.py"
    scripts.mkdir(parents=True)
    helper.parent.mkdir(parents=True)
    shutil.copy2(ROOT / "install.sh", project / "install.sh")
    shutil.copy2(ROOT / "packaging" / "scripts" / "package.sh", scripts / "package.sh")
    helper.write_text(
        "import os, pathlib, sys\n"
        "pathlib.Path(os.environ['YULU_TEST_ARGV_LOG']).write_text('\\n'.join(sys.argv[1:]) + '\\n')\n"
        "install_dir = pathlib.Path(sys.argv[sys.argv.index('--install-dir') + 1])\n"
        "install_dir.mkdir(parents=True, exist_ok=True)\n"
        "(install_dir / 'VERSION').write_text('0.6.0\\n')\n"
        "scripts = install_dir / 'yulu' / 'scripts'\n"
        "scripts.mkdir(parents=True, exist_ok=True)\n"
        "(scripts / 'yulu').write_text('#!/usr/bin/env bash\\n')\n",
        encoding="utf-8",
    )
    (project / "VERSION").write_text("0.6.0\n", encoding="utf-8")
    dist = tmp_path / "dist"

    packaged = subprocess.run(
        ["bash", str(scripts / "package.sh"), "v0.6.0", "--dist", str(dist), "--skip-build"],
        cwd=project,
        capture_output=True,
        text=True,
        check=False,
    )

    assert packaged.returncode == 0, packaged.stderr + packaged.stdout
    text = (dist / "install.sh").read_text(encoding="utf-8")
    assert 'PACKAGED_RELEASE_TAG="v0.6.0"' in text
    assert "__YULU_EMBEDDED_RELEASE_INSTALLER_BASE64__" not in text
    assert "__YULU_PACKAGED_RELEASE_TAG__" not in text
    payload_line = next(line for line in text.splitlines() if line.startswith('EMBEDDED_HELPER_BASE64="'))
    payload = payload_line.split('"', 2)[1]
    assert base64.b64decode(payload).decode("utf-8") == helper.read_text(encoding="utf-8")

    for args in ((), ("--latest",), ("--version", "0.6.0")):
        run_dir = tmp_path / ("run-" + ("-".join(args) if args else "default"))
        env, curl_log, argv_log = _bootstrap_env(run_dir)
        env["INSTALL_DIR"] = str(run_dir / "install")
        result = subprocess.run(
            ["bash", str(dist / "install.sh"), *args],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr + result.stdout
        assert argv_log.read_text(encoding="utf-8").splitlines()[-2:] == ["--version", "v0.6.0"]
        assert not curl_log.exists()

    dev_dir = tmp_path / "run-dev"
    env, curl_log, argv_log = _bootstrap_env(dev_dir)
    env["INSTALL_DIR"] = str(dev_dir / "install")
    dev = subprocess.run(
        ["bash", str(dist / "install.sh"), "--dev"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert dev.returncode == 0, dev.stderr + dev.stdout
    assert argv_log.read_text(encoding="utf-8").splitlines()[-1] == "--dev"
    assert not curl_log.exists()

    conflict_dir = tmp_path / "conflict"
    env, _, argv_log = _bootstrap_env(conflict_dir)
    env["INSTALL_DIR"] = str(conflict_dir / "install")
    conflict = subprocess.run(
        ["bash", str(dist / "install.sh"), "--version", "v0.6.1"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert conflict.returncode == 2
    assert "does not match packaged release v0.6.0" in conflict.stderr
    assert not argv_log.exists()


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
            {
                "name": "yulu-macos-arm64-v0.5.0.zip",
                "browser_download_url": "https://example/yulu.zip",
            },
            {"name": "checksums.txt", "browser_download_url": "https://example/checksums.txt"},
        ],
    }

    selected = select_release_asset(release)

    assert selected == ReleaseAsset(
        tag="v0.5.0",
        asset_name="yulu-macos-arm64-v0.5.0.zip",
        asset_url="https://example/yulu.zip",
        checksums_url="https://example/checksums.txt",
    )


def test_select_release_asset_errors_when_zip_or_checksums_missing():
    with pytest.raises(InstallError, match="does not provide"):
        select_release_asset({"tag_name": "v0.5.0", "assets": []})


@pytest.mark.parametrize("url", [None, ""])
def test_select_release_asset_errors_when_zip_url_missing_or_empty(url):
    release = {
        "tag_name": "v0.5.0",
        "assets": [
            {"name": "yulu-macos-arm64-v0.5.0.zip", "browser_download_url": url},
            {"name": "checksums.txt", "browser_download_url": "https://example/checksums.txt"},
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
            {"name": "yulu-macos-arm64-v0.5.0.zip", "browser_download_url": "https://example/yulu.zip"},
            {"name": "checksums.txt", "browser_download_url": "https://example/checksums.txt"},
        ],
    }
    asset = resolve_release_from_payload(payload)
    assert asset.tag == "v0.5.0"


def test_install_release_target_fetches_payload_and_installs_selected_asset(tmp_path, monkeypatch):
    payload = {
        "tag_name": "v0.5.0",
        "assets": [
            {"name": "yulu-macos-arm64-v0.5.0.zip", "browser_download_url": "https://example/yulu.zip"},
            {"name": "checksums.txt", "browser_download_url": "https://example/checksums.txt"},
        ],
    }
    calls = []

    def fake_fetch_json(url):
        calls.append(("fetch", url))
        return payload

    def fake_install_release_from_urls(**kwargs):
        calls.append(("install", kwargs))

    monkeypatch.setattr(release_installer, "fetch_json", fake_fetch_json)
    monkeypatch.setattr(release_installer, "install_release_from_urls", fake_install_release_from_urls)

    install_release_target(ReleaseTarget(kind="version", tag="v0.5.0"), tmp_path / "install", run_setup_flag=False)

    assert calls[0] == (
        "fetch",
        "https://api.github.com/repos/Nowhitestar/Yulu/releases/tags/v0.5.0",
    )
    assert calls[1][1] == {
        "tag": "v0.5.0",
        "asset_name": "yulu-macos-arm64-v0.5.0.zip",
        "asset_url": "https://example/yulu.zip",
        "checksums_url": "https://example/checksums.txt",
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
                "name": "yulu-macos-arm64-v0.5.0.zip",
                "browser_download_url": "https://example.invalid/yulu.zip",
            },
            {"name": "checksums.txt", "browser_download_url": "https://example.invalid/checksums.txt"},
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
        "acquire_install_lock",
        "assert_recording_idle",
        "resolve_github_release",
        "download_release_zip",
        "verify_sha256_checksums",
        "validate_runtime_layout",
        "verify_release_bundle_signatures",
        "verify_signed_runtime_manifest",
        "replace_runtime_with_backup",
        "run_setup",
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
    keychain_helper = runtime / "yulu" / "scripts" / "Yulu.app" / "Contents" / "MacOS" / "xai_keychain"
    keychain_helper.parent.mkdir(parents=True)
    keychain_helper.write_text("binary\n", encoding="utf-8")
    (runtime / "VERSION").write_text(version + "\n", encoding="utf-8")
    (runtime / "yulu" / "scripts" / "setup.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    (runtime / "yulu" / "scripts" / "yulu").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    (runtime / "yulu" / "scripts" / "version.py").write_text(
        "import sys\nsys.exit(0)\n",
        encoding="utf-8",
    )
    return runtime


def write_recording_guard(runtime: Path, active: bool) -> Path:
    guard = runtime / "yulu" / "scripts" / "migrate" / "guard.py"
    guard.parent.mkdir(parents=True, exist_ok=True)
    guard.write_text(
        f"def recording_active():\n    return {active!r}\n",
        encoding="utf-8",
    )
    return guard


@pytest.mark.parametrize("target", [("--latest",), ("--dev",)])
def test_main_refuses_active_recording_before_channel_dispatch(tmp_path, monkeypatch, capsys, target):
    install_dir = tmp_path / "install"
    write_recording_guard(install_dir, True)
    calls = []
    monkeypatch.setattr(
        release_installer,
        "install_release_target",
        lambda *args, **kwargs: calls.append(("release", args, kwargs)),
    )
    monkeypatch.setattr(
        release_installer,
        "install_dev_channel",
        lambda *args, **kwargs: calls.append(("dev", args, kwargs)),
    )

    exit_code = main(["update", *target, "--install-dir", str(install_dir)])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "recording is in progress" in captured.err
    assert "Stop the recording, then retry" in captured.err
    assert "Traceback" not in captured.err
    assert calls == []


def test_recording_guard_loader_uses_exact_runtime_and_restores_import_state(tmp_path):
    idle_scripts = tmp_path / "idle" / "yulu" / "scripts"
    active_scripts = tmp_path / "active" / "yulu" / "scripts"
    for scripts, active in ((idle_scripts, False), (active_scripts, True)):
        guard = scripts / "migrate" / "guard.py"
        guard.parent.mkdir(parents=True)
        guard.write_text(
            "def recording_active():\n"
            "    from record_audio import ACTIVE\n"
            "    return ACTIVE\n",
            encoding="utf-8",
        )
        (scripts / "record_audio.py").write_text(f"ACTIVE = {active!r}\n", encoding="utf-8")
    original_path = sys.path.copy()
    original_record_audio = sys.modules.get("record_audio")

    release_installer.assert_recording_idle(idle_scripts)
    with pytest.raises(release_installer.RecordingActiveInstallError):
        release_installer.assert_recording_idle(active_scripts)

    assert sys.path == original_path
    assert sys.modules.get("record_audio") is original_record_audio


def test_existing_dev_without_guard_fails_closed_before_git(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    (install_dir / ".git").mkdir(parents=True)
    commands = []

    def fail_run(*args, **kwargs):
        commands.append(args)
        pytest.fail("missing guard must refuse before any git command")

    monkeypatch.setattr(release_installer, "run", fail_run)

    with pytest.raises(InstallError, match="recording safety guard"):
        install_dev_channel(install_dir, config_path=tmp_path / "config.json")

    assert commands == []


def test_fresh_dev_install_does_not_require_recording_guard(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    commands = []

    def fake_run(cmd, cwd=None):
        commands.append(cmd)
        if cmd[:3] == ["git", "clone", "--branch"]:
            install_dir.mkdir()
            return ""
        if cmd == ["git", "rev-parse", "--short", "HEAD"]:
            return "abc1234"
        return ""

    monkeypatch.setattr(release_installer, "run", fake_run)
    monkeypatch.setattr(release_installer, "run_setup", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        release_installer,
        "assert_recording_idle",
        lambda _scripts: pytest.fail("fresh install must not require an in-runtime guard"),
    )

    install_dev_channel(install_dir, run_setup_flag=False, config_path=tmp_path / "config.json")

    assert commands[0][:3] == ["git", "clone", "--branch"]


def test_late_dev_recording_refusal_rolls_back_without_setup_or_service_repair(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "old.txt").write_text("old", encoding="utf-8")
    checks = iter([None, release_installer.RecordingActiveInstallError("recording")])
    setup_calls = []
    repair_calls = []

    def fake_run(cmd, cwd=None):
        if cmd[:3] == ["git", "clone", "--branch"]:
            install_dir.mkdir()
            (install_dir / ".git").mkdir()
            (install_dir / "new.txt").write_text("new", encoding="utf-8")
            return ""
        if cmd == ["git", "rev-parse", "--short", "HEAD"]:
            return "abc1234"
        return ""

    def guard(_scripts):
        result = next(checks)
        if result is not None:
            raise result

    monkeypatch.setattr(release_installer, "run", fake_run)
    monkeypatch.setattr(release_installer, "assert_recording_idle", guard)
    monkeypatch.setattr(release_installer, "run_setup", lambda *args: setup_calls.append(args))
    monkeypatch.setattr(release_installer, "repair_restored_runtime", lambda *args: repair_calls.append(args))

    with pytest.raises(release_installer.RecordingActiveInstallError):
        install_dev_channel(install_dir, config_path=tmp_path / "config.json")

    assert (install_dir / "old.txt").read_text(encoding="utf-8") == "old"
    assert not (install_dir / "new.txt").exists()
    assert setup_calls == []
    assert repair_calls == []


def test_legacy_release_uses_verified_staged_guard_before_swap(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "old.txt").write_text("old", encoding="utf-8")
    staged_runtime = make_runtime(tmp_path / "candidate", "0.6.0")
    write_recording_guard(staged_runtime, True)
    events = []

    monkeypatch.setattr(release_installer, "download_to_path", lambda _url, path: path.write_bytes(b"zip"))
    monkeypatch.setattr(release_installer, "read_url_text", lambda _url: f"{'a' * 64}  yulu.zip\n")
    monkeypatch.setattr(release_installer, "verify_checksum", lambda *_args: events.append("checksum"))
    monkeypatch.setattr(release_installer, "extract_release_zip", lambda *_args: staged_runtime)
    monkeypatch.setattr(release_installer, "validate_runtime_layout", lambda *_args: events.append("layout"))
    monkeypatch.setattr(release_installer, "verify_release_bundle_security", lambda *_args: events.append("signature"))
    monkeypatch.setattr(release_installer, "verify_runtime_manifest", lambda *_args: events.append("manifest"))
    monkeypatch.setattr(
        release_installer,
        "replace_runtime_with_backup",
        lambda *_args: pytest.fail("active staged guard must refuse before swap"),
    )

    with pytest.raises(release_installer.RecordingActiveInstallError):
        release_installer.install_release_from_urls(
            tag="v0.6.0",
            asset_name="yulu.zip",
            asset_url="https://example/yulu.zip",
            checksums_url="https://example/checksums.txt",
            install_dir=install_dir,
            run_setup=False,
            config_path=tmp_path / "config.json",
        )

    assert events == ["checksum", "layout", "signature", "manifest"]
    assert (install_dir / "old.txt").read_text(encoding="utf-8") == "old"


def test_late_release_recording_refusal_rolls_back_without_service_repair(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "old.txt").write_text("old", encoding="utf-8")
    staged_runtime = make_runtime(tmp_path / "candidate", "0.6.0")
    (staged_runtime / "new.txt").write_text("new", encoding="utf-8")
    checks = iter([None, release_installer.RecordingActiveInstallError("recording")])
    repair_calls = []

    monkeypatch.setattr(release_installer, "download_to_path", lambda _url, path: path.write_bytes(b"zip"))
    monkeypatch.setattr(release_installer, "read_url_text", lambda _url: f"{'a' * 64}  yulu.zip\n")
    monkeypatch.setattr(release_installer, "verify_checksum", lambda *_args: None)
    monkeypatch.setattr(release_installer, "extract_release_zip", lambda *_args: staged_runtime)
    monkeypatch.setattr(release_installer, "validate_runtime_layout", lambda *_args: None)
    monkeypatch.setattr(release_installer, "verify_release_bundle_security", lambda *_args: None)
    monkeypatch.setattr(release_installer, "verify_runtime_manifest", lambda *_args: None)

    def guard(_scripts):
        result = next(checks)
        if result is not None:
            raise result

    monkeypatch.setattr(release_installer, "assert_recording_idle", guard)
    monkeypatch.setattr(
        release_installer,
        "_run_setup_script",
        lambda *_args, **_kwargs: pytest.fail("setup must not run after active recheck"),
    )
    monkeypatch.setattr(
        release_installer,
        "repair_restored_runtime",
        lambda *args, **kwargs: repair_calls.append((args, kwargs)),
    )

    with pytest.raises(release_installer.RecordingActiveInstallError):
        release_installer.install_release_from_urls(
            tag="v0.6.0",
            asset_name="yulu.zip",
            asset_url="https://example/yulu.zip",
            checksums_url="https://example/checksums.txt",
            install_dir=install_dir,
            config_path=tmp_path / "config.json",
        )

    assert (install_dir / "old.txt").read_text(encoding="utf-8") == "old"
    assert not (install_dir / "new.txt").exists()
    assert repair_calls == []


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


def test_validate_runtime_layout_never_executes_untrusted_version_script(tmp_path):
    runtime = make_runtime(tmp_path, "0.5.0")
    marker = tmp_path / "executed"
    (runtime / "yulu" / "scripts" / "version.py").write_text(
        f"from pathlib import Path\nPath({str(marker)!r}).write_text('executed')\n",
        encoding="utf-8",
    )

    validate_runtime_layout(runtime, "v0.5.0")

    assert not marker.exists()


def make_manifest_runtime(tmp_path: Path) -> tuple[Path, Path]:
    runtime = make_runtime(tmp_path / "source", "0.5.0")
    scripts = runtime / "yulu" / "scripts"
    (scripts / "setup.sh").chmod(0o755)
    (scripts / "yulu").chmod(0o755)
    (scripts / "Yulu.app" / "Contents" / "Resources").mkdir(parents=True)
    (scripts / "Yulu.app" / "Contents" / "MacOS").mkdir(parents=True, exist_ok=True)
    (scripts / "Yulu.app" / "Contents" / "MacOS" / "audio_daemon").write_bytes(b"signed app")
    (scripts / "StatusAgent.app" / "Contents" / "MacOS").mkdir(parents=True)
    (scripts / "StatusAgent.app" / "Contents" / "MacOS" / "status_agent").write_bytes(b"signed app")
    archive_path = tmp_path / "runtime.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        for path in runtime.rglob("*"):
            if path.is_file():
                archive.write(path, Path("yulu") / path.relative_to(runtime))
    manifest = build_runtime_manifest_from_zip(archive_path)
    write_runtime_manifest(runtime / release_installer.RUNTIME_MANIFEST_RELATIVE_PATH, manifest)
    return runtime, archive_path


def test_signed_runtime_manifest_verifies_every_non_bundle_file(tmp_path):
    runtime, _archive = make_manifest_runtime(tmp_path)

    verify_runtime_manifest(runtime)


def test_signed_runtime_manifest_rejects_extra_file(tmp_path):
    runtime, _archive = make_manifest_runtime(tmp_path)
    (runtime / "unexpected.py").write_text("print('extra')\n", encoding="utf-8")

    with pytest.raises(InstallError, match="extra=.*unexpected.py"):
        verify_runtime_manifest(runtime)


def test_signed_runtime_manifest_rejects_modified_or_repermissioned_file(tmp_path):
    runtime, _archive = make_manifest_runtime(tmp_path)
    setup = runtime / "yulu" / "scripts" / "setup.sh"
    setup.write_text("#!/usr/bin/env bash\necho tampered\n", encoding="utf-8")

    with pytest.raises(InstallError, match="(size|checksum) mismatch"):
        verify_runtime_manifest(runtime)

    runtime, _archive = make_manifest_runtime(tmp_path / "mode")
    setup = runtime / "yulu" / "scripts" / "setup.sh"
    setup.chmod(0o644)
    with pytest.raises(InstallError, match="executable-bit mismatch"):
        verify_runtime_manifest(runtime)


def test_release_bundle_security_requires_developer_id_and_expected_team(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    for name in ("Yulu.app", "StatusAgent.app"):
        (runtime / "yulu" / "scripts" / name).mkdir(parents=True)
    calls = []

    def fake_which(name):
        return "/usr/bin/codesign" if name == "codesign" else None

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if "-dv" in cmd:
            return subprocess.CompletedProcess(
                cmd,
                0,
                "",
                "Authority=Developer ID Application: Test (WMU9678ZQL)\n"
                "TeamIdentifier=WMU9678ZQL\n",
            )
        return subprocess.CompletedProcess(cmd, 0, "", "valid on disk\n")

    monkeypatch.setattr(release_installer.shutil, "which", fake_which)
    monkeypatch.setattr(release_installer.subprocess, "run", fake_run)

    verify_release_bundle_security(runtime)

    assert len(calls) == 4
    assert all("--deep" in call for call in calls if "--verify" in call)
    assert {Path(call[-1]).name for call in calls} == {"Yulu.app", "StatusAgent.app"}


def test_release_bundle_security_rejects_wrong_team(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    for name in ("Yulu.app", "StatusAgent.app"):
        (runtime / "yulu" / "scripts" / name).mkdir(parents=True)

    monkeypatch.setattr(
        release_installer.shutil,
        "which",
        lambda name: "/usr/bin/codesign" if name == "codesign" else None,
    )

    def fake_run(cmd, **kwargs):
        detail = (
            "Authority=Developer ID Application: Attacker (EVILTEAM01)\n"
            "TeamIdentifier=EVILTEAM01\n"
        )
        return subprocess.CompletedProcess(cmd, 0, "", detail)

    monkeypatch.setattr(release_installer.subprocess, "run", fake_run)

    with pytest.raises(InstallError, match="expected Team ID"):
        verify_release_bundle_security(runtime)


def test_release_bundle_security_validates_staple_when_available(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    for name in ("Yulu.app", "StatusAgent.app"):
        (runtime / "yulu" / "scripts" / name).mkdir(parents=True)
    calls = []

    monkeypatch.setattr(
        release_installer.shutil,
        "which",
        lambda name: f"/usr/bin/{name}" if name in {"codesign", "xcrun"} else None,
    )

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        detail = (
            "Authority=Developer ID Application: Test (WMU9678ZQL)\n"
            "TeamIdentifier=WMU9678ZQL\n"
        )
        return subprocess.CompletedProcess(cmd, 0, "", detail)

    monkeypatch.setattr(release_installer.subprocess, "run", fake_run)

    verify_release_bundle_security(runtime)

    staple_calls = [call for call in calls if "stapler" in call and "validate" in call]
    assert len(staple_calls) == 2


def test_stapler_failure_is_best_effort_for_offline_install_but_mandatory_in_release_ci(
    tmp_path, monkeypatch, capsys
):
    runtime = tmp_path / "runtime"
    for name in ("Yulu.app", "StatusAgent.app"):
        (runtime / "yulu" / "scripts" / name).mkdir(parents=True)

    monkeypatch.setattr(
        release_installer.shutil,
        "which",
        lambda name: f"/usr/bin/{name}" if name in {"codesign", "xcrun"} else None,
    )

    def fake_run(cmd, **kwargs):
        if "stapler" in cmd and "validate" in cmd:
            return subprocess.CompletedProcess(cmd, 65, "", "ticket service unavailable")
        detail = (
            "Authority=Developer ID Application: Test (WMU9678ZQL)\n"
            "TeamIdentifier=WMU9678ZQL\n"
        )
        return subprocess.CompletedProcess(cmd, 0, "", detail)

    monkeypatch.setattr(release_installer.subprocess, "run", fake_run)

    verify_release_bundle_security(runtime)
    assert "ticket service unavailable" in capsys.readouterr().err

    with pytest.raises(InstallError, match="Notarization ticket validation failed"):
        verify_release_bundle_security(runtime, require_staple=True)


def test_release_architecture_rejects_intel_only_macos(monkeypatch):
    monkeypatch.setattr(release_installer.sys, "platform", "darwin")
    monkeypatch.setattr(release_installer.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(release_installer.shutil, "which", lambda _name: None)

    with pytest.raises(InstallError, match="Apple Silicon"):
        ensure_release_architecture()


def test_release_architecture_accepts_rosetta_on_apple_silicon(monkeypatch):
    monkeypatch.setattr(release_installer.sys, "platform", "darwin")
    monkeypatch.setattr(release_installer.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(
        release_installer.shutil,
        "which",
        lambda name: "/usr/sbin/sysctl" if name == "sysctl" else None,
    )
    monkeypatch.setattr(
        release_installer,
        "_run_verification",
        lambda cmd: subprocess.CompletedProcess(cmd, 0, "1\n", ""),
    )

    ensure_release_architecture()


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
    (install_dir / ".yulu-install.json").write_text('{"source":"dev"}\n', encoding="utf-8")
    commands = []
    setup_calls = []

    def fake_run(cmd, cwd=None):
        commands.append((cmd, cwd))
        if cmd == ["git", "status", "--porcelain"]:
            return "?? .yulu-install.json"
        if cmd == ["git", "rev-parse", "--show-toplevel"]:
            return str(install_dir)
        if cmd == ["git", "rev-parse", "HEAD"]:
            return "abc1234def5678abc1234def5678abc1234def56"
        if cmd == ["git", "branch", "--show-current"]:
            return "main"
        if cmd == ["git", "rev-parse", "origin/main"]:
            return "abc1234def5678abc1234def5678abc1234def56"
        if cmd == ["git", "rev-parse", "--short", "HEAD"]:
            return "abc1234"
        return ""

    def fake_setup(path, upgrade):
        setup_calls.append((path, upgrade))

    monkeypatch.setattr(release_installer, "run", fake_run)
    monkeypatch.setattr(release_installer, "run_setup", fake_setup)
    monkeypatch.setattr(release_installer, "assert_recording_idle", lambda _scripts: None)

    install_dev_channel(install_dir, config_path=tmp_path / "config.json")

    assert [cmd for cmd, _ in commands] == [
        ["git", "status", "--porcelain"],
        ["git", "rev-parse", "--show-toplevel"],
        ["git", "rev-parse", "HEAD"],
        ["git", "branch", "--show-current"],
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
    monkeypatch.setattr(release_installer, "assert_recording_idle", lambda _scripts: None)

    with pytest.raises(InstallError, match="local changes"):
        install_dev_channel(install_dir, config_path=tmp_path / "config.json")

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
        if cmd == ["git", "rev-parse", "--show-toplevel"]:
            return str(install_dir)
        if cmd == ["git", "rev-parse", "HEAD"]:
            return "abc12340000000000000000000000000000000000"
        if cmd == ["git", "branch", "--show-current"]:
            return "main"
        if cmd == ["git", "rev-parse", "origin/main"]:
            return "abc1234fffffffffffffffffffffffffffffffff"
        return ""

    def fake_setup(path, upgrade):
        setup_calls.append((path, upgrade))

    monkeypatch.setattr(release_installer, "run", fake_run)
    monkeypatch.setattr(release_installer, "run_setup", fake_setup)
    monkeypatch.setattr(release_installer, "assert_recording_idle", lambda _scripts: None)

    with pytest.raises(InstallError, match="local main differs from origin/main"):
        install_dev_channel(install_dir, config_path=tmp_path / "config.json")

    assert commands[:9] == [
        ["git", "status", "--porcelain"],
        ["git", "rev-parse", "--show-toplevel"],
        ["git", "rev-parse", "HEAD"],
        ["git", "branch", "--show-current"],
        ["git", "fetch", "--quiet", "origin"],
        ["git", "checkout", "--quiet", "main"],
        ["git", "pull", "--ff-only", "origin", "main"],
        ["git", "rev-parse", "HEAD"],
        ["git", "rev-parse", "origin/main"],
    ]
    assert ["git", "reset", "--hard", "abc12340000000000000000000000000000000000"] in commands
    assert read_install_metadata(install_dir) == {}
    assert setup_calls == []


def test_install_dev_channel_does_not_write_metadata_when_setup_fails(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    (install_dir / ".git").mkdir(parents=True)

    def fake_run(cmd, cwd=None):
        if cmd == ["git", "status", "--porcelain"]:
            return ""
        if cmd == ["git", "rev-parse", "--show-toplevel"]:
            return str(install_dir)
        if cmd == ["git", "rev-parse", "HEAD"]:
            return "abc1234def5678abc1234def5678abc1234def56"
        if cmd == ["git", "branch", "--show-current"]:
            return "main"
        if cmd == ["git", "rev-parse", "origin/main"]:
            return "abc1234def5678abc1234def5678abc1234def56"
        if cmd == ["git", "rev-parse", "--short", "HEAD"]:
            return "abc1234"
        return ""

    def fail_setup(path, upgrade):
        raise InstallError("setup failed")

    monkeypatch.setattr(release_installer, "run", fake_run)
    monkeypatch.setattr(release_installer, "run_setup", fail_setup)
    monkeypatch.setattr(release_installer, "assert_recording_idle", lambda _scripts: None)

    with pytest.raises(InstallError, match="setup failed"):
        install_dev_channel(install_dir, config_path=tmp_path / "config.json")

    assert not (install_dir / ".yulu-install.json").exists()


def test_in_place_dev_failure_restores_head_ref_worktree_config_and_services(tmp_path, monkeypatch):
    install_dir = tmp_path / "install"
    (install_dir / ".git").mkdir(parents=True)
    config_path = tmp_path / "config" / "config.json"
    config_path.parent.mkdir()
    config_path.write_text('{"schema":"old"}\n', encoding="utf-8")
    old_head = "a" * 40
    new_head = "b" * 40
    state = {"head": old_head, "branch": "feature", "worktree": "old"}
    commands = []
    repair_calls = []

    def fake_run(cmd, cwd=None):
        commands.append(cmd)
        if cmd == ["git", "status", "--porcelain"]:
            return "" if state["worktree"] == "old" else " M tracked-runtime-file"
        if cmd == ["git", "rev-parse", "--show-toplevel"]:
            return str(install_dir)
        if cmd == ["git", "rev-parse", "HEAD"]:
            return state["head"]
        if cmd == ["git", "branch", "--show-current"]:
            return state["branch"]
        if cmd == ["git", "checkout", "--quiet", "main"]:
            state["branch"] = "main"
        if cmd == ["git", "pull", "--ff-only", "origin", "main"]:
            state.update(head=new_head, worktree="new")
        if cmd == ["git", "rev-parse", "origin/main"]:
            return new_head
        if cmd == ["git", "rev-parse", "--short", "HEAD"]:
            return state["head"][:7]
        if cmd[:4] == ["git", "checkout", "--quiet", "--force"]:
            if cmd[4] == "--detach":
                state.update(branch="", head=cmd[5])
            else:
                state["branch"] = cmd[4]
        if cmd[:3] == ["git", "reset", "--hard"]:
            state.update(head=cmd[3], worktree="old")
        return ""

    def fail_setup(path, upgrade):
        assert upgrade is True
        config_path.write_text('{"schema":"migrated"}\n', encoding="utf-8")
        state["worktree"] = "setup-mutated"
        raise InstallError("setup failed")

    def repair_services(path):
        repair_calls.append(path)
        assert state == {"head": old_head, "branch": "feature", "worktree": "old"}
        assert config_path.read_text(encoding="utf-8") == '{"schema":"old"}\n'
        state["worktree"] = "repair-mutated"

    monkeypatch.setattr(release_installer, "run", fake_run)
    monkeypatch.setattr(release_installer, "run_setup", fail_setup)
    monkeypatch.setattr(release_installer, "repair_restored_runtime", repair_services)
    monkeypatch.setattr(release_installer, "assert_recording_idle", lambda _scripts: None)

    with pytest.raises(InstallError, match="setup failed"):
        install_dev_channel(install_dir, config_path=config_path)

    assert state == {"head": old_head, "branch": "feature", "worktree": "old"}
    assert config_path.read_text(encoding="utf-8") == '{"schema":"old"}\n'
    assert config_path.stat().st_mode & 0o777 == 0o600
    assert repair_calls == [install_dir]
    assert commands.count(["git", "reset", "--hard", old_head]) == 2
    assert not list(config_path.parent.glob(".config.json.yulu-install-snapshot-*"))


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

    install_dev_channel(install_dir, config_path=tmp_path / "config.json")

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
    monkeypatch.setattr(release_installer, "assert_recording_idle", lambda _scripts: None)

    install_dev_channel(install_dir, config_path=tmp_path / "config.json")

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
    monkeypatch.setattr(release_installer, "assert_recording_idle", lambda _scripts: None)

    with pytest.raises(InstallError, match="setup failed"):
        install_dev_channel(install_dir, config_path=tmp_path / "config.json")

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


def test_setup_interrupt_terminates_process_group(monkeypatch, tmp_path):
    kill_calls = []

    class InterruptedProcess:
        pid = 43210

        def __init__(self):
            self.wait_calls = 0

        def wait(self, timeout=None):
            self.wait_calls += 1
            if self.wait_calls == 1:
                raise KeyboardInterrupt
            return 0

        def poll(self):
            return None

    process = InterruptedProcess()
    monkeypatch.setattr(release_installer.subprocess, "Popen", lambda *args, **kwargs: process)
    monkeypatch.setattr(release_installer.os, "killpg", lambda pid, sig: kill_calls.append((pid, sig)))

    with pytest.raises(InstallError, match="interrupted"):
        release_installer._run_setup_script(tmp_path, upgrade=True)

    assert kill_calls == [(process.pid, release_installer.signal.SIGTERM)]


def test_fresh_install_cleanup_removes_only_state_pointing_to_failed_runtime(tmp_path, monkeypatch):
    home = tmp_path / "home"
    install_dir = home / ".yulu"
    scripts = install_dir / "yulu" / "scripts"
    scripts.mkdir(parents=True)
    launch_agents = home / "Library" / "LaunchAgents"
    launch_agents.mkdir(parents=True)
    matching = launch_agents / "com.yulu.ui.plist"
    matching.write_bytes(
        plistlib.dumps(
            {
                "Label": "com.yulu.ui",
                "ProgramArguments": ["/usr/bin/node", str(scripts / "yulu_ui/dist/server.js")],
            }
        )
    )
    unrelated = launch_agents / "com.yulu.other.plist"
    unrelated.write_bytes(
        plistlib.dumps(
            {
                "Label": "com.yulu.other",
                "ProgramArguments": ["/usr/bin/python3", "/opt/other-yulu/service.py"],
            }
        )
    )
    local_bin = home / ".local" / "bin"
    local_bin.mkdir(parents=True)
    cli = local_bin / "yulu"
    cli.symlink_to(scripts / "yulu")
    monkeypatch.setattr(release_installer.shutil, "which", lambda _name: None)

    cleanup_fresh_install_side_effects(install_dir, home=home)

    assert not matching.exists()
    assert unrelated.exists()
    assert not cli.exists()


def test_install_lock_rejects_second_transaction_and_releases_after_exit(tmp_path):
    install_dir = tmp_path / "install"

    with acquire_install_lock(install_dir):
        with pytest.raises(InstallError, match="already running"):
            with acquire_install_lock(install_dir):
                pass

    with acquire_install_lock(install_dir) as lock_path:
        assert lock_path.is_file()
        assert lock_path.stat().st_mode & 0o777 == 0o600


def test_backup_pruning_keeps_latest_runtime_and_ignores_untrusted_matches(tmp_path):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    keep = tmp_path / "install.backup-current"
    old = tmp_path / "install.backup-old"
    unrelated = tmp_path / "install.backup-not-a-runtime"
    for runtime in (keep, old):
        (runtime / "yulu" / "scripts").mkdir(parents=True)
        (runtime / "VERSION").write_text("0.5.0\n", encoding="utf-8")
    unrelated.mkdir()
    (unrelated / "note.txt").write_text("user data\n", encoding="utf-8")

    prune_runtime_backups(install_dir, keep=keep)

    assert keep.exists()
    assert not old.exists()
    assert unrelated.exists()


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
    real_replace = release_installer.os.replace
    move_calls = []

    def fail_second_move(src, dst, *args, **kwargs):
        move_calls.append((src, dst))
        if len(move_calls) == 2:
            raise OSError("staged move failed")
        return real_replace(src, dst, *args, **kwargs)

    monkeypatch.setattr(release_installer.os, "replace", fail_second_move)

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
