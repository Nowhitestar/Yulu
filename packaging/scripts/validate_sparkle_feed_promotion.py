#!/usr/bin/env python3
"""Reject stale or identity-changing updates to Yulu's signed Sparkle channel."""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


SPARKLE = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"


@dataclass(frozen=True)
class FeedIdentity:
    build: int
    enclosure: tuple[tuple[str, str], ...]


def read_identity(path: Path) -> FeedIdentity:
    items = list(ET.parse(path).getroot().iter("item"))
    if len(items) != 1:
        raise ValueError("Sparkle channel feeds must contain exactly one item")
    enclosures = list(items[0].findall("enclosure"))
    if len(enclosures) != 1:
        raise ValueError("Sparkle channel feeds must contain exactly one enclosure")

    enclosure = enclosures[0]
    version_element = items[0].find(f"{SPARKLE}version")
    item_build = (version_element.text or "").strip() if version_element is not None else ""
    enclosure_build = enclosure.get(f"{SPARKLE}version", "").strip()
    if item_build and enclosure_build and item_build != enclosure_build:
        raise ValueError("conflicting item and enclosure builds")
    build = enclosure_build or item_build

    url = urlsplit(enclosure.get("url", ""))
    length = enclosure.get("length", "")
    signature = enclosure.get(f"{SPARKLE}edSignature", "")
    if not build.isdecimal() or int(build) <= 0:
        raise ValueError("Sparkle channel build is invalid")
    if url.scheme.lower() != "https" or not url.hostname or url.username or url.password:
        raise ValueError("Sparkle channel enclosure URL is invalid")
    if not length.isdecimal() or int(length) <= 0 or not signature:
        raise ValueError("Sparkle channel enclosure identity is invalid")

    return FeedIdentity(int(build), tuple(sorted(enclosure.attrib.items())))


def validate_promotion(previous: Path, candidate: Path) -> None:
    old = read_identity(previous)
    new = read_identity(candidate)
    if new.build < old.build:
        raise ValueError("candidate Sparkle build is older than the published channel")
    if new.build == old.build and new.enclosure != old.enclosure:
        raise ValueError("equal Sparkle builds cannot change the channel enclosure")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: validate_sparkle_feed_promotion.py PREVIOUS CANDIDATE", file=sys.stderr)
        return 64
    try:
        validate_promotion(Path(argv[1]), Path(argv[2]))
    except (OSError, ET.ParseError, ValueError) as error:
        print(f"validate_sparkle_feed_promotion.py: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
