import pytest

from release_installer import (
    InstallError,
    ReleaseAsset,
    ReleaseTarget,
    normalize_version_tag,
    parse_checksums,
    parse_target_args,
    select_release_asset,
    sha256_file,
    verify_checksum,
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
