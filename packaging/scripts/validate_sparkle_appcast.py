#!/usr/bin/env python3
"""Validate release appcast metadata; signature verification remains with Sparkle."""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path


SPARKLE = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"


def validate(appcast: Path, tag: str, download_prefix: str, dmg: Path) -> str:
    root = ET.parse(appcast).getroot()
    items = list(root.iter("item"))
    if len(items) != 1:
        raise ValueError("Sparkle release feed must contain exactly one item")
    minimum = items[0].findall(f"{SPARKLE}minimumSystemVersion")
    if len(minimum) != 1 or minimum[0].text != "13.0.0":
        raise ValueError("Sparkle feed minimum macOS version must be 13.0.0")
    enclosures = list(root.iter("enclosure"))
    if len(enclosures) != 1:
        raise ValueError("Sparkle feed must contain exactly one full DMG enclosure")
    enclosure = enclosures[0]
    expected_name = f"yulu-macos-arm64-{tag}.dmg"
    if enclosure.get("url") != download_prefix + expected_name:
        raise ValueError("Sparkle feed does not reference the public release DMG")
    length = enclosure.get("length")
    expected_length = dmg.stat().st_size
    if length is None or not length.isdecimal() or int(length) != expected_length:
        raise ValueError("Sparkle feed enclosure length does not match the public release DMG")
    signature = enclosure.get(f"{SPARKLE}edSignature")
    if not signature:
        raise ValueError("Sparkle feed DMG enclosure is not EdDSA-signed")
    if list(root.iter(f"{SPARKLE}deltas")):
        raise ValueError("Yulu does not publish Sparkle delta payloads")
    if any(path.suffix == ".delta" for path in appcast.parent.iterdir()):
        raise ValueError("Yulu does not publish Sparkle delta artifacts")
    return signature


def main(argv: list[str]) -> int:
    if len(argv) != 5:
        print("usage: validate_sparkle_appcast.py APPCAST TAG DOWNLOAD_PREFIX DMG", file=sys.stderr)
        return 64
    try:
        signature = validate(Path(argv[1]), argv[2], argv[3], Path(argv[4]))
    except (OSError, ET.ParseError, ValueError) as error:
        print(f"validate_sparkle_appcast.py: {error}", file=sys.stderr)
        return 1
    print(signature)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
