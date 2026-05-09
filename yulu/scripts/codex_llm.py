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


def find_codex() -> str:
    """Find Codex even when launchd starts us with a minimal PATH."""
    override = os.environ.get("YULU_CODEX_BIN", "").strip()
    if override:
        return override
    found = shutil.which("codex")
    if found:
        return found
    home = Path(os.environ.get("HOME", str(Path.home()))).expanduser()
    candidates = sorted(home.glob(".nvm/versions/node/*/bin/codex"), reverse=True)
    for candidate in candidates:
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
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
