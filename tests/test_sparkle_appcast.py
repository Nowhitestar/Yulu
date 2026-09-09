import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
VALIDATE = ROOT / "packaging/scripts/validate_sparkle_appcast.py"
SPARKLE = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"
TAG = "v0.23.0-rc.15"
PREFIX = f"https://github.com/Nowhitestar/Yulu/releases/download/{TAG}/"


@pytest.fixture
def appcast(tmp_path: Path):
    dmg = tmp_path / f"yulu-macos-arm64-{TAG}.dmg"
    dmg.write_bytes(b"public-dmg-fixture")
    feed = tmp_path / "appcast.xml"
    root = ET.Element("rss")
    item = ET.SubElement(ET.SubElement(root, "channel"), "item")
    minimum = ET.SubElement(item, f"{SPARKLE}minimumSystemVersion")
    minimum.text = "13.0.0"
    ET.SubElement(item, "enclosure", {
        "url": PREFIX + dmg.name,
        "length": str(dmg.stat().st_size),
        f"{SPARKLE}edSignature": "signature-verified-separately",
    })
    return root, item, feed, dmg


def validate_feed(root: ET.Element, feed: Path, dmg: Path):
    ET.ElementTree(root).write(feed, encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(VALIDATE), str(feed), TAG, PREFIX, str(dmg)],
        capture_output=True, text=True, check=False,
    )


def test_release_appcast_requires_the_macos_13_floor(appcast):
    root, item, feed, dmg = appcast
    minimum = item.find(f"{SPARKLE}minimumSystemVersion")

    for value in ("13.0.0", "10.13", "12.0.0", "14.0.0", None):
        minimum.text = value
        result = validate_feed(root, feed, dmg)
        if value == "13.0.0":
            assert result.returncode == 0, result.stderr
            assert result.stdout.strip() == "signature-verified-separately"
        else:
            assert result.returncode != 0
            assert "minimum macOS version must be 13.0.0" in result.stderr


@pytest.mark.parametrize(("mutation", "error"), [
    ("url", "does not reference the public release DMG"),
    ("length", "length does not match"),
    ("signature", "not EdDSA-signed"),
    ("enclosure", "exactly one full DMG enclosure"),
    ("item", "exactly one item"),
    ("missing-minimum", "minimum macOS version must be 13.0.0"),
    ("duplicate-minimum", "minimum macOS version must be 13.0.0"),
    ("delta-payload", "does not publish Sparkle delta payloads"),
    ("delta-file", "does not publish Sparkle delta artifacts"),
])
def test_release_appcast_preserves_identity_and_full_update_guards(appcast, mutation, error):
    root, item, feed, dmg = appcast
    enclosure = item.find("enclosure")
    if mutation == "url":
        enclosure.set("url", "https://example.invalid/other.dmg")
    elif mutation == "length":
        enclosure.set("length", "1")
    elif mutation == "signature":
        enclosure.attrib.pop(f"{SPARKLE}edSignature")
    elif mutation == "enclosure":
        ET.SubElement(item, "enclosure")
    elif mutation == "item":
        ET.SubElement(root.find("channel"), "item")
    elif mutation == "missing-minimum":
        item.remove(item.find(f"{SPARKLE}minimumSystemVersion"))
    elif mutation == "duplicate-minimum":
        ET.SubElement(item, f"{SPARKLE}minimumSystemVersion").text = "10.13"
    elif mutation == "delta-payload":
        ET.SubElement(item, f"{SPARKLE}deltas")
    elif mutation == "delta-file":
        (feed.parent / "update.delta").write_bytes(b"unexpected delta")
    result = validate_feed(root, feed, dmg)
    assert result.returncode != 0
    assert error in result.stderr
