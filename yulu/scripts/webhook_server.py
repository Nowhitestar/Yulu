#!/usr/bin/env python3
"""Retired compatibility entry point for the legacy Calendar webhook service."""

import sys


def main():
    print(
        "Yulu Calendar webhooks are retired; the signed polling service owns Calendar synchronization.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
