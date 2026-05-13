#!/usr/bin/env python3
"""Sync the Yulu Hermes skill from this repo to local agent skill locations."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = SOURCE_ROOT / "skills/yulu/SKILL.md"
DEFAULT_HERMES = Path.home() / ".hermes/skills/leizi/yulu/SKILL.md"
DEFAULT_L_SKILLS = Path.home() / "Documents/Codebase/l-skills/skills/yulu/SKILL.md"


def copy_skill(source: Path, destinations: list[Path], dry_run: bool = False) -> list[dict]:
    if not source.exists():
        raise FileNotFoundError(f"skill source not found: {source}")
    results = []
    for dest in destinations:
        dest = dest.expanduser()
        existed = dest.exists()
        changed = True
        if existed:
            changed = dest.read_text(encoding="utf-8") != source.read_text(encoding="utf-8")
        if changed and not dry_run:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
        results.append({"dest": str(dest), "existed": existed, "changed": changed, "dry_run": dry_run})
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sync Yulu skill to Hermes and l-skills")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--hermes", type=Path, default=DEFAULT_HERMES)
    parser.add_argument("--l-skills", type=Path, default=DEFAULT_L_SKILLS)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    results = copy_skill(args.source, [args.hermes, args.l_skills], dry_run=args.dry_run)
    for result in results:
        marker = "would update" if result["dry_run"] and result["changed"] else "updated" if result["changed"] else "unchanged"
        print(f"{marker}: {result['dest']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
