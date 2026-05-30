"""Honest host-capability probes — the detection primitives behind HostCapabilityReport.

These functions answer "can the *daemon* actually use this?", not "is it on the dev's
interactive shell?". The two load-bearing honesty decisions:

- **Binaries resolve via the login-shell PATH** (``$SHELL -lc 'command -v X'``), NOT
  launchd's minimal PATH and NOT bare ``shutil.which`` (D-02). A binary on the login PATH
  but absent from launchd's PATH is still reported relative to the consumer.
- **Python importability is probed by the daemon's own interpreter** — the plist's
  ``__PYTHON__`` (``PYTHON_BIN`` env → ``which python3`` → ``/usr/bin/python3``, mirroring
  ``lib/common.sh:124``) run as ``[daemon_python, -c, import X]`` (D-03/D-04). A green
  ``usable`` mlx-whisper therefore means the daemon can import it — no silent
  first-recording failure.

Security invariants (Phase 3 threat register):

- ``probe_llm_command`` RESOLVES + stats the configured command's head token and NEVER
  executes it (T-03-01) — no ``subprocess.run(llm_command, input=...)`` anywhere here.
- All outer subprocess calls are **list-form** (never ``shell=True``); the interpolated
  binary name is a fixed Yulu-known token, not free user input (T-03-02).
- ``scan_models`` globs only fixed, well-known model roots — no ``..``, no user-supplied
  path segment (T-03-03).

Every Capability-returning probe NEVER raises — it degrades to ``absent(detail)`` on any
failure, mirroring the doctor "check functions never raise" contract (T-03-04). stdlib only.
"""

from __future__ import annotations

import glob
import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

from . import report
from .report import Capability, Provenance, Status

_SUBPROCESS_TIMEOUT = 5


# ── The canonical daemon interpreter (D-04 — mirrors lib/common.sh:124) ──


def daemon_python() -> str:
    """The ONE canonical daemon interpreter path (D-04, single source of truth).

    Mirrors ``lib/common.sh:124`` exactly:
    ``${PYTHON_BIN:-$(command -v python3 || echo /usr/bin/python3)}`` — the same value
    substituted into the plist's ``__PYTHON__``, so importability is probed against the
    interpreter the daemon actually runs as. Pure resolution; no probing here.
    """
    env = os.environ.get("PYTHON_BIN")
    if env:
        return env
    return shutil.which("python3") or "/usr/bin/python3"


# ── Login-shell PATH binary resolution (D-02) ──


def resolve_on_login_path(binary: str, shell: str | None = None) -> str | None:
    """Resolve ``binary`` via the user's LOGIN-shell PATH, not launchd's PATH.

    Runs ``$SHELL -lc 'command -v <binary>'`` (list-form — T-03-02) so the resolution sees
    the same PATH the user's interactive login shell exports (D-02), rather than launchd's
    minimal PATH or a bare :func:`shutil.which`. ``command -v`` is a shell builtin lookup —
    it does NOT execute the binary. ``binary`` is a fixed Yulu-known token (``claude`` /
    ``whisper-cli`` / the resolved ``llm.command`` head), never free-form user input.

    Returns the stripped path on success, ``None`` when not found or on any error.
    """
    sh = shell or os.environ.get("SHELL") or "/bin/zsh"
    try:
        result = subprocess.run(
            [sh, "-lc", "command -v " + binary],
            capture_output=True,
            text=True,
            timeout=_SUBPROCESS_TIMEOUT,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    path = (result.stdout or "").strip()
    return path or None


# ── Daemon-interpreter importability probe (D-03/D-04) ──


def probe_importable(module: str, python_bin: str | None = None) -> tuple[bool, str]:
    """Probe ``module`` importability using the DAEMON's interpreter (D-03/D-04).

    Runs ``[daemon_python(), -c, "import <module>; print(__version__ or '')"]`` (list-form)
    so a True result means the interpreter the daemon launches with can import it. Returns
    ``(True, version-or-"")`` on returncode 0, ``(False, stderr-first-line)`` otherwise.
    Never raises — on a subprocess failure returns ``(False, str(exc))``.
    """
    py = python_bin or daemon_python()
    code = "import %s; print(getattr(%s, '__version__', ''))" % (module, module)
    try:
        result = subprocess.run(
            [py, "-c", code],
            capture_output=True,
            text=True,
            timeout=_SUBPROCESS_TIMEOUT,
        )
    except Exception as exc:
        return False, str(exc)
    if result.returncode == 0:
        return True, (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    first_line = stderr.splitlines()[-1] if stderr else ""
    return False, first_line


# ── Capability-returning probes (each never raises) ──


def probe_command(binary: str, version_args: tuple[str, ...] = ("--version",)) -> Capability:
    """Probe a host CLI (``claude`` / ``whisper-cli``) via the login-shell PATH.

    Found → ``Capability(HOST_PATH, USABLE, path, version-or-"")``; not found → ``absent()``.
    Never raises. The version probe DOES run the binary with ``version_args`` (a benign
    ``--version``) only once resolved — this is distinct from ``probe_llm_command`` which
    must never run its configured command (T-03-01).
    """
    try:
        path = resolve_on_login_path(binary)
        if not path:
            return report.absent(f"{binary} not on login PATH")
        version = _safe_version(path, version_args)
        return Capability(Provenance.HOST_PATH, Status.USABLE, path, version)
    except Exception as exc:
        return report.absent(str(exc))


def probe_mlx_whisper() -> Capability:
    """Probe mlx-whisper importability against the daemon interpreter (D-03/D-04).

    Importable → ``Capability(HOST_PATH, USABLE, daemon_python(), "mlx_whisper <ver>")``;
    not → ``Capability(ABSENT, ABSENT, "", stderr)``. ``host-path`` provenance reflects
    "found on the host the daemon runs as." Never raises.
    """
    try:
        ok, detail = probe_importable("mlx_whisper")
        if ok:
            ver = detail or "?"
            return Capability(Provenance.HOST_PATH, Status.USABLE, daemon_python(), f"mlx_whisper {ver}")
        return Capability(Provenance.ABSENT, Status.ABSENT, "", detail)
    except Exception as exc:
        return report.absent(str(exc))


def probe_llm_command(config_path: Path | None = None) -> Capability:
    """Validate the configured ``llm.command`` — RESOLVE + STAT, NEVER EXECUTE (T-03-01).

    Reads ``llm.command`` from config.json using the same resolution as
    ``agent_queue_worker._load_llm_command`` (``enabled`` gate, list-or-str via
    ``shlex.split``, filter falsy). If disabled/empty → ``absent``. Else resolve the FIRST
    token (``llm_command[0]``) via the login-shell PATH and STAT it — the configured command
    is never executed (the only subprocess argv issued is ``command -v <head>``; no prompt is
    ever piped to it).

    Found → ``Capability(AGENT_CONFIG, USABLE, path, "llm.command=<head>")``; head not on
    PATH → ``absent``. Never raises.
    """
    try:
        llm_command = _load_llm_command(config_path)
        if not llm_command:
            return report.absent("llm.command not configured")
        head = llm_command[0]
        # T-03-01: resolve + stat the binary ONLY — the configured command is NEVER executed.
        path = resolve_on_login_path(head)
        if not path:
            return Capability(Provenance.ABSENT, Status.ABSENT, "", f"{head} not on PATH")
        return Capability(Provenance.AGENT_CONFIG, Status.USABLE, path, f"llm.command={head}")
    except Exception as exc:
        return report.absent(str(exc))


def scan_models() -> Capability:
    """Stat known whisper-model roots (path-bounded — T-03-03).

    Globs only the three fixed roots (see :func:`_model_roots`) — Yulu's own models dir,
    whisper.cpp's, and the HuggingFace hub cache. No ``..``, no user-supplied path segment,
    stat/size only (no read of model contents). ≥1 model → USABLE with count + total bytes;
    none → ``absent``. Provenance is ``yulu-managed`` when the first hit lives under
    ``~/.config/yulu``, else ``host-path``. Never raises.
    """
    try:
        seen: set[str] = set()  # dedupe: overlapping globs (*.bin and **/*.bin) can match the same file
        total = 0
        first_root: str | None = None
        for root in _model_roots():
            if not root.exists():
                continue
            for pattern in ("*.bin", "*.gguf", "*.safetensors", "**/*.bin", "**/*.gguf", "**/*.safetensors"):
                for hit in glob.glob(str(root / pattern), recursive=True):
                    p = Path(hit)
                    if not p.is_file():
                        continue
                    real = str(p.resolve())
                    if real in seen:
                        continue
                    seen.add(real)
                    try:
                        total += p.stat().st_size
                    except OSError:
                        pass
                    if first_root is None:
                        first_root = str(root)
        count = len(seen)
        if count == 0:
            return report.absent("no whisper models found")
        yulu_root = str(Path.home() / ".config" / "yulu")
        provenance = Provenance.YULU_MANAGED if (first_root or "").startswith(yulu_root) else Provenance.HOST_PATH
        noun = "model" if count == 1 else "models"
        return Capability(provenance, Status.USABLE, first_root or "", f"{count} {noun}, {total} bytes")
    except Exception as exc:
        return report.absent(str(exc))


def probe_recording_dir() -> Capability:
    """Recording-dir writability via the Phase 2 PathResolver (D-05).

    Reuses ``MacOSPathResolver().data_dir()`` (lazily + guardedly imported so this module
    imports on any OS); checks existence + ``os.W_OK`` and ``shutil.disk_usage``. Writable →
    ``Capability(YULU_MANAGED, USABLE, dir, "free=<bytes>")``; missing/not-writable →
    ``PRESENT_BUT_UNVERIFIED``. Off-Darwin or if the resolver raises → ``absent``. Never raises.
    """
    try:
        from yulu_platform.macos.path_resolver import MacOSPathResolver
    except Exception as exc:  # off-Darwin / import error — degrade cleanly
        return report.absent(f"path resolver unavailable: {exc}")
    try:
        data_dir = MacOSPathResolver().data_dir()
    except Exception as exc:  # MacOSPathResolver raises off-Darwin (D-08 gate)
        return report.absent(str(exc))
    try:
        d = Path(data_dir)
        if d.exists() and os.access(d, os.W_OK):
            free = shutil.disk_usage(d).free
            return Capability(Provenance.YULU_MANAGED, Status.USABLE, str(d), f"free={free}")
        return Capability(Provenance.YULU_MANAGED, Status.PRESENT_BUT_UNVERIFIED, str(d), "not writable")
    except Exception as exc:
        return report.absent(str(exc))


# ── Internal helpers ──


def _model_roots() -> list[Path]:
    """The three fixed, well-known model roots (T-03-03 — no traversal outside these)."""
    home = Path.home()
    return [
        home / ".config" / "yulu" / "models",
        home / "Library" / "Application Support" / "whisper.cpp",
        home / ".cache" / "huggingface" / "hub",
    ]


def _load_llm_command(config_path: Path | None = None) -> list[str]:
    """Mirror ``agent_queue_worker._load_llm_command`` resolution.

    ``enabled`` gate (default True), ``command`` is list-or-str (``shlex.split`` for str),
    falsy entries filtered. Returns ``[]`` when disabled, missing, or null.
    """
    if config_path is None:
        config_path = Path.home() / ".config" / "yulu" / "config.json"
    try:
        cfg = json.loads(Path(config_path).read_text(encoding="utf-8"))
    except Exception:
        return []
    llm_cfg = cfg.get("llm", {}) if isinstance(cfg, dict) else {}
    if not llm_cfg.get("enabled", True):
        return []
    cmd = llm_cfg.get("command") or []
    if isinstance(cmd, str):
        return shlex.split(cmd)
    if isinstance(cmd, list):
        return [str(x) for x in cmd if str(x)]
    return []


def _safe_version(path: str, version_args: tuple[str, ...]) -> str:
    """Best-effort ``<binary> --version`` first-line; "" on any failure. Never raises."""
    try:
        result = subprocess.run(
            [path, *version_args],
            capture_output=True,
            text=True,
            timeout=_SUBPROCESS_TIMEOUT,
        )
        out = (result.stdout or result.stderr or "").strip()
        return out.splitlines()[0] if out else ""
    except Exception:
        return ""
