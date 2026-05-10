import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from version import format_version, read_version, validate_version, version_info


def test_version_file_is_valid_semver():
    version = read_version(ROOT / "VERSION")
    assert validate_version(version)


def test_version_info_uses_supplied_version_file(tmp_path):
    version_file = tmp_path / "VERSION"
    version_file.write_text("1.2.3-test\n", encoding="utf-8")

    info = version_info(repo_dir=tmp_path, version_path=version_file)

    assert info["version"] == "1.2.3-test"
    assert info["valid_semver"] is True
    assert info["git_commit"] is None


def test_format_version_short_and_long():
    info = {
        "version": "1.2.3",
        "valid_semver": True,
        "git_commit": "abc1234",
        "git_dirty": True,
        "git_tag": None,
    }

    assert format_version(info, short=True) == "1.2.3"
    assert format_version(info) == "Yulu 1.2.3 (abc1234, dirty)"
