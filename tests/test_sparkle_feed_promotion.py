import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / "packaging" / "scripts" / "validate_sparkle_feed_promotion.py"
SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle"


def write_feed(
    path: Path,
    *,
    build: str,
    url: str,
    length: str = "100",
    signature: str = "signed",
    version_on_enclosure: bool = False,
    enclosure_build: str | None = None,
) -> Path:
    item_version = "" if version_on_enclosure else f"<sparkle:version>{build}</sparkle:version>"
    effective_enclosure_build = build if version_on_enclosure else enclosure_build
    enclosure_version = (
        f' sparkle:version="{effective_enclosure_build}"'
        if effective_enclosure_build is not None
        else ""
    )
    path.write_text(
        f"""<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:sparkle="{SPARKLE_NS}" version="2.0">
  <channel>
    <item>
      <title>Yulu</title>
      {item_version}
      <enclosure url="{url}" length="{length}"
        type="application/octet-stream" sparkle:edSignature="{signature}"{enclosure_version} />
    </item>
  </channel>
</rss>
""",
        encoding="utf-8",
    )
    return path


def guard(previous: Path, candidate: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(GUARD), str(previous), str(candidate)],
        capture_output=True,
        text=True,
        check=False,
    )


def test_accepts_newer_item_level_sparkle_build(tmp_path: Path):
    previous = write_feed(
        tmp_path / "previous.xml",
        build="22",
        url="https://example.test/v0.23.0-rc.4.dmg",
    )
    candidate = write_feed(
        tmp_path / "candidate.xml",
        build="23",
        url="https://example.test/v0.23.0.dmg",
    )

    result = guard(previous, candidate)

    assert result.returncode == 0, result.stderr


def test_rejects_older_build_and_equal_build_enclosure_drift(tmp_path: Path):
    previous = write_feed(
        tmp_path / "previous.xml",
        build="23",
        url="https://example.test/v0.23.0.dmg",
        length="100",
        signature="first",
    )
    older = write_feed(
        tmp_path / "older.xml",
        build="22",
        url="https://example.test/v0.23.0-rc.4.dmg",
    )
    drifted = write_feed(
        tmp_path / "drifted.xml",
        build="23",
        url="https://example.test/v0.23.0.dmg",
        length="101",
        signature="second",
    )

    older_result = guard(previous, older)
    drifted_result = guard(previous, drifted)

    assert older_result.returncode != 0
    assert "older than the published channel" in older_result.stderr
    assert drifted_result.returncode != 0
    assert "equal Sparkle builds cannot change the channel enclosure" in drifted_result.stderr


def test_accepts_identical_equal_build_and_enclosure_version_fallback(tmp_path: Path):
    previous = write_feed(
        tmp_path / "previous.xml",
        build="23",
        url="https://example.test/v0.23.0.dmg",
        version_on_enclosure=True,
    )
    candidate = write_feed(
        tmp_path / "candidate.xml",
        build="23",
        url="https://example.test/v0.23.0.dmg",
        version_on_enclosure=True,
    )

    result = guard(previous, candidate)

    assert result.returncode == 0, result.stderr


def test_rejects_conflicting_item_and_enclosure_versions(tmp_path: Path):
    previous = write_feed(
        tmp_path / "previous.xml",
        build="100",
        url="https://example.test/v1.0.0.dmg",
    )
    candidate = write_feed(
        tmp_path / "candidate.xml",
        build="101",
        enclosure_build="99",
        url="https://example.test/v1.1.0.dmg",
    )

    result = guard(previous, candidate)

    assert result.returncode != 0
    assert "conflicting item and enclosure builds" in result.stderr
