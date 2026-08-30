"""Read-only probes for Agent and deterministic Host capabilities.

Yulu deliberately does not probe or provision transcription engines, speech
models, or diarization runtimes. Those belong to the selected Agent. The probes
here only resolve Agent CLIs, calendar tooling, the configured Agent command,
and the local recording directory.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

from application_paths import CONFIG_READ_PATHS

from . import report
from .report import Capability, Provenance, Status


_SUBPROCESS_TIMEOUT = 5


def _fallback_executable_path() -> str:
    home = Path.home()
    entries = [
        *(os.environ.get("PATH", "").split(os.pathsep)),
        str(home / ".local" / "bin"),
        str(home / ".npm-global" / "bin"),
        str(home / ".nvm" / "current" / "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    return os.pathsep.join(dict.fromkeys(entry for entry in entries if entry))


def resolve_on_login_path(binary: str, shell: str | None = None) -> str | None:
    """Resolve a CLI across terminal, LaunchAgent, and login-shell PATHs."""
    if os.path.dirname(binary):
        candidate = Path(binary).expanduser()
        return str(candidate) if candidate.is_file() and os.access(candidate, os.X_OK) else None
    direct = shutil.which(binary)
    if direct:
        return direct
    fallback = shutil.which(binary, path=_fallback_executable_path())
    if fallback:
        return fallback
    sh = shell or os.environ.get("SHELL") or "/bin/zsh"
    try:
        result = subprocess.run(
            [sh, "-lc", "command -v " + shlex.quote(binary)],
            capture_output=True,
            text=True,
            timeout=_SUBPROCESS_TIMEOUT,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    return lines[-1] if lines else None


def probe_command(binary: str, version_args: tuple[str, ...] = ("--version",)) -> Capability:
    """Resolve a known CLI and run only its benign version command."""
    try:
        path = resolve_on_login_path(binary)
        if not path:
            return report.absent(f"{binary} not on login PATH")
        return Capability(Provenance.HOST_PATH, Status.USABLE, path, _safe_version(path, version_args))
    except Exception as exc:
        return report.absent(str(exc))


def probe_llm_command(config_path: Path | None = None) -> Capability:
    """Resolve, but never execute, the configured Agent command."""
    try:
        command = _load_llm_command(config_path)
        if not command:
            return report.absent("Agent command not configured")
        head = command[0]
        path = resolve_on_login_path(head)
        if not path:
            return report.absent(f"{head} not on PATH")
        return Capability(Provenance.AGENT_CONFIG, Status.USABLE, path, f"llm.command={head}")
    except Exception as exc:
        return report.absent(str(exc))


def probe_recording_dir() -> Capability:
    """Report local recording-directory writability without creating files."""
    try:
        from yulu_platform.macos.path_resolver import MacOSPathResolver
    except Exception as exc:
        return report.absent(f"path resolver unavailable: {exc}")
    try:
        directory = MacOSPathResolver().application_paths().media_library_dir
        if directory.exists() and os.access(directory, os.W_OK):
            free = shutil.disk_usage(directory).free
            return Capability(Provenance.YULU_MANAGED, Status.USABLE, str(directory), f"free={free}")
        return Capability(
            Provenance.YULU_MANAGED,
            Status.PRESENT_BUT_UNVERIFIED,
            str(directory),
            "not writable",
        )
    except Exception as exc:
        return report.absent(str(exc))


def _load_llm_command(config_path: Path | None = None) -> list[str]:
    if config_path is None:
        config_path = next((path for path in CONFIG_READ_PATHS if path.exists()), CONFIG_READ_PATHS[0])
    try:
        cfg = json.loads(Path(config_path).read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(cfg, dict):
        return []
    llm_cfg = cfg.get("llm", {})
    if not isinstance(llm_cfg, dict) or not llm_cfg.get("enabled", True):
        return []
    command = llm_cfg.get("command")
    if isinstance(command, str):
        return _normalize_legacy_agent_command(shlex.split(command))
    if isinstance(command, list) and command:
        return _normalize_legacy_agent_command([str(item) for item in command if str(item)])

    agent_cfg = llm_cfg.get("agent", {})
    provider = str(
        agent_cfg.get("provider", "auto") if isinstance(agent_cfg, dict) else "auto"
    ).strip().lower()
    movies_dir = _recording_dir_from_config(cfg)
    candidates: list[tuple[set[str], str, list[str]]] = [
        ({"auto", "hermes"}, "hermes", ["hermes"]),
        ({"auto", "codex"}, "codex", ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check"]),
        ({"auto", "claude", "claude-code"}, "claude", ["claude", "--print", "--add-dir", str(movies_dir)]),
        ({"auto", "openclaw"}, "openclaw", ["openclaw"]),
    ]
    for supported, binary, argv in candidates:
        if provider in supported and resolve_on_login_path(binary):
            return argv
    return []


def _normalize_legacy_agent_command(command: list[str]) -> list[str]:
    if any(Path(part).name == "codex_llm.py" for part in command):
        return ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check"]
    return command


def _recording_dir_from_config(cfg: object) -> Path:
    if isinstance(cfg, dict):
        audio = cfg.get("audio", {})
        if isinstance(audio, dict):
            output_dir = audio.get("output_dir")
            if isinstance(output_dir, str) and output_dir.strip():
                return Path(output_dir).expanduser()
    return Path.home() / "Movies" / "Yulu"


def _safe_version(path: str, version_args: tuple[str, ...]) -> str:
    try:
        result = subprocess.run(
            [path, *version_args],
            capture_output=True,
            text=True,
            timeout=_SUBPROCESS_TIMEOUT,
        )
        output = (result.stdout or result.stderr or "").strip()
        return output.splitlines()[0] if output else ""
    except Exception:
        return ""
