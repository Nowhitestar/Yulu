#!/usr/bin/env python3
"""Yulu LLM command shim for Codex CLI.

Reads a prompt from stdin, runs `codex exec` non-interactively, and prints only
Codex's final answer to stdout so transcribe.py can write clean Markdown.
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


KNOWN_CODEX_PATHS = (
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
)


def _codex_works(path: str) -> bool:
    """Return True when the candidate can launch the real Codex binary."""
    if not path:
        return False
    try:
        result = subprocess.run(
            [path, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _candidate_paths() -> list[str]:
    candidates: list[str] = []
    override = os.environ.get("YULU_CODEX_BIN", "").strip()
    if override:
        candidates.append(override)

    found = shutil.which("codex")
    if found:
        candidates.append(found)

    candidates.extend(KNOWN_CODEX_PATHS)

    home = Path(os.environ.get("HOME", str(Path.home()))).expanduser()
    candidates.extend(str(p) for p in sorted(home.glob(".nvm/versions/node/*/bin/codex"), reverse=True))

    seen: set[str] = set()
    unique: list[str] = []
    for candidate in candidates:
        if candidate and candidate not in seen:
            seen.add(candidate)
            unique.append(candidate)
    return unique


def find_codex() -> str:
    """Find a working Codex entry point even when launchd has a stale PATH."""
    for candidate in _candidate_paths():
        if _codex_works(candidate):
            return candidate
    return "codex"


def main() -> int:
    prompt = sys.stdin.read()
    if not prompt.strip():
        print("empty prompt", file=sys.stderr)
        return 2

    codex = find_codex()
    model = os.environ.get("YULU_CODEX_MODEL", "").strip()

    with tempfile.TemporaryDirectory(prefix="yulu-codex-") as td:
        out_path = Path(td) / "final.md"
        cmd = [
            codex,
            "exec",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--ephemeral",
            "-o",
            str(out_path),
        ]
        if model:
            cmd.extend(["-m", model])
        cmd.append("-")

        result = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=int(os.environ.get("YULU_CODEX_TIMEOUT", "1800")),
        )
        if result.returncode != 0:
            if result.stderr.strip():
                print(result.stderr.strip(), file=sys.stderr)
            elif result.stdout.strip():
                print(result.stdout.strip(), file=sys.stderr)
            else:
                print(f"codex failed with exit code {result.returncode}", file=sys.stderr)
            return result.returncode

        if out_path.exists() and out_path.read_text(encoding="utf-8").strip():
            print(out_path.read_text(encoding="utf-8").strip())
            return 0

        # Fallback: older Codex may print the final answer to stdout.
        if result.stdout.strip():
            print(result.stdout.strip())
            return 0

        print("codex produced empty output", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
