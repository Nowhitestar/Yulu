#!/usr/bin/env python3
"""Validate release tags and derive the signed bundle identity."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


PRERELEASE_IDENTIFIER = r"(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    rf"(?:-{PRERELEASE_IDENTIFIER}(?:\.{PRERELEASE_IDENTIFIER})*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
ACCEPTED_RC_VERSION = "0.23.0-rc.8"
STABLE_PROMOTION_VERSION = "0.23.0"


@dataclass(frozen=True)
class ReleaseIdentity:
    releaseVersion: str
    bundleShortVersion: str
    buildNumber: str
    stablePromotion: bool


class ReleaseIdentityError(RuntimeError):
    pass


def git(repository: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "git failed"
        raise ReleaseIdentityError(detail)
    return result.stdout.strip()


def validate_tag(tag: str) -> str:
    if not tag.startswith("v") or not SEMVER.fullmatch(tag[1:]):
        raise ReleaseIdentityError(f"Invalid release tag: {tag}")
    return tag[1:]


def resolve_identity(
    *, tag: str, version: str, repository: Path, include_build_number: bool = True
) -> ReleaseIdentity:
    release_version = validate_tag(tag)
    version = version.strip()
    if not SEMVER.fullmatch(version):
        raise ReleaseIdentityError(f"VERSION is not valid SemVer: {version}")

    stable_promotion = False
    if tag != f"v{version}":
        if version != ACCEPTED_RC_VERSION or release_version != STABLE_PROMOTION_VERSION:
            raise ReleaseIdentityError(f"TAG ({tag}) must match VERSION (v{version}).")
        stable_promotion = True

    head = git(repository, "rev-parse", "HEAD^{commit}")
    requested = git(repository, "rev-parse", f"refs/tags/{tag}^{{commit}}")
    if requested != head:
        raise ReleaseIdentityError(f"Requested tag {tag} must resolve to the current release commit.")
    if stable_promotion:
        accepted_rc = git(repository, "rev-parse", f"refs/tags/v{ACCEPTED_RC_VERSION}^{{commit}}")
        if head != accepted_rc:
            raise ReleaseIdentityError(
                f"Stable v0.23.0 must use the same source commit as accepted v{ACCEPTED_RC_VERSION}."
            )

    build_number = "0"
    if include_build_number:
        count = git(repository, "rev-list", "--count", "HEAD")
        if not count.isdecimal() or int(count) < 1:
            raise ReleaseIdentityError("Unable to derive a positive release build number.")
        # Reserve odd build numbers for same-source stable promotions. The next
        # source commit receives the next even number, so Sparkle ordering stays
        # strictly increasing across RC -> stable -> subsequent release.
        build_number = str((int(count) * 2) + (1 if stable_promotion else 0))

    return ReleaseIdentity(
        releaseVersion=release_version,
        bundleShortVersion=release_version.split("-", 1)[0].split("+", 1)[0],
        buildNumber=build_number,
        stablePromotion=stable_promotion,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--version-file", type=Path, required=True)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--validate-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        version = args.version_file.read_text(encoding="utf-8").strip()
        identity = resolve_identity(
            tag=args.tag,
            version=version,
            repository=args.repository,
            include_build_number=not args.validate_only,
        )
    except (OSError, ReleaseIdentityError) as error:
        print(error, file=sys.stderr)
        return 1

    if args.validate_only:
        return 0
    if args.github_output:
        lines = (
            f"release_version={identity.releaseVersion}\n"
            f"bundle_short_version={identity.bundleShortVersion}\n"
            f"build_number={identity.buildNumber}\n"
            f"stable_promotion={'true' if identity.stablePromotion else 'false'}\n"
        )
        with args.github_output.open("a", encoding="utf-8") as output:
            output.write(lines)
    print(json.dumps(asdict(identity), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
