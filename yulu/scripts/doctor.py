#!/usr/bin/env python3
"""Yulu development/runtime doctor.

Read-only checks for the repository, local runtime, launchd/process leftovers,
configuration, and required tools. This script must never mutate runtime state.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import socket
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote

from application_paths import (
    DURABLE_DATA_DIR,
    IPC_DIR,
    LEGACY_READ_ONLY_DATA_DIR,
    LOGS_DIR,
)

DEFAULT_SOURCE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUNTIME_ROOT = Path.home() / ".yulu"
DEFAULT_LEGACY_ROOT = Path.home() / ".openclaw/workspace/meeting-assistant/yulu"
DEFAULT_CONFIG_DIR = LEGACY_READ_ONLY_DATA_DIR
DEFAULT_APPLICATION_DATA_DIR = DURABLE_DATA_DIR
DEFAULT_IPC_DIR = IPC_DIR
DEFAULT_LOGS_DIR = LOGS_DIR


def check_host_tasks(config_dir: Path) -> dict[str, Any]:
    """Read-only summary of the durable Host Agent task store."""
    path = config_dir / "host.sqlite"
    report: dict[str, Any] = {"path": str(path), "present": path.exists(), "total": 0, "states": {}}
    if not path.exists():
        return report
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=1)
        try:
            rows = conn.execute("SELECT state, COUNT(*) FROM agent_tasks GROUP BY state").fetchall()
        finally:
            conn.close()
        report["states"] = {str(state): int(count) for state, count in rows}
        report["total"] = sum(report["states"].values())
    except Exception as exc:
        report["error"] = str(exc)
    return report


def check_agent_pipeline(
    config_dir: Path,
    checks: list[dict[str, Any]],
    ui_report: dict[str, Any],
    hermes_contract: dict[str, Any] | None = None,
    hermes_phase_registration: dict[str, Any] | None = None,
    token_path: Path | None = None,
    legacy_token_path: Path | None = None,
) -> dict[str, Any]:
    """Verify the dependencies required by the Agent-owned recording pipeline.

    An existing config follows the Host schema's enabled-by-default behavior;
    only ``agent_pipeline.enabled=false`` disables the gate. An absent/unreadable
    config remains a separate installation diagnosis rather than a pipeline failure.
    """
    config_path = Path(config_dir) / "config.json"
    config: dict[str, Any] = {}
    config_loaded = False
    config_error = ""
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            config = raw
            config_loaded = True
        else:
            config_error = "config root is not an object"
    except FileNotFoundError:
        config_error = "config missing"
    except Exception as exc:
        config_error = f"config unreadable: {exc}"

    pipeline_cfg = config.get("agent_pipeline")
    section_present = isinstance(pipeline_cfg, dict)
    if not section_present:
        pipeline_cfg = {}
    configured = config_loaded
    # Match the Host schema: an existing config defaults the pipeline to enabled
    # unless the operator explicitly disables it.
    enabled = configured and pipeline_cfg.get("enabled") is not False
    by_name = {str(item.get("name")): item for item in checks}
    hermes = by_name.get("hermes", {})
    ffmpeg = by_name.get("ffmpeg", {})

    standard_token_path = Path(token_path) if token_path is not None else Path(config_dir) / "mcp-token.json"
    selected_token_path = standard_token_path
    using_legacy_token = False
    try:
        standard_token_stat = standard_token_path.lstat()
    except FileNotFoundError:
        standard_token_stat = None
    except OSError:
        standard_token_stat = None
    if standard_token_stat is None and legacy_token_path is not None:
        selected_token_path = Path(legacy_token_path)
        using_legacy_token = True
    try:
        selected_token_stat = selected_token_path.lstat()
    except FileNotFoundError:
        selected_token_stat = None
    except OSError:
        selected_token_stat = None
    token_present = selected_token_stat is not None
    token_valid = False
    token_mode: str | None = None
    token_mode_secure = False
    token_error = ""
    if token_present:
        if selected_token_stat is None or not stat.S_ISREG(selected_token_stat.st_mode):
            token_error = "token file is not a regular file"
        else:
            try:
                token_doc = json.loads(selected_token_path.read_text(encoding="utf-8"))
                token = token_doc.get("token") if isinstance(token_doc, dict) else None
                mode = selected_token_stat.st_mode & 0o777
                token_mode = f"{mode:04o}"
                token_mode_secure = (mode & 0o077) == 0
                token_valid = isinstance(token, str) and len(token.strip()) >= 16 and token_mode_secure
                if not token_mode_secure:
                    token_error = "token permissions must be 0600"
                elif not isinstance(token, str) or len(token.strip()) < 16:
                    token_error = "token is missing or too short"
            except Exception:
                token_error = "token unreadable"

    components = {
        "hermes_cli": {
            "ok": bool(hermes.get("ok")),
            "path": hermes.get("path", ""),
            "version": hermes.get("version", ""),
        },
        "hermes_contract": hermes_contract or {
            "ok": True,
            "probed": False,
            "detail": "contract probe not requested",
        },
        "hermes_phase_mcp": hermes_phase_registration or {
            "ok": True,
            "probed": False,
            "detail": "phase MCP registration probe not requested",
        },
        "ffmpeg": {
            "ok": bool(ffmpeg.get("ok")),
            "path": ffmpeg.get("path", ""),
            "version": ffmpeg.get("version", ""),
        },
        "mcp_token": {
            "ok": token_valid,
            "present": token_present,
            "mode": token_mode,
            "mode_secure": token_mode_secure,
            "legacy_fallback": using_legacy_token,
            "error": token_error,
        },
        "ui_healthz": {
            "ok": bool(ui_report.get("healthz_ok")),
            "port": ui_report.get("port"),
            "error": ui_report.get("error"),
        },
    }
    reasons = [name for name, value in components.items() if not value["ok"]] if enabled else []
    return {
        "configured": configured,
        "section_present": section_present,
        "enabled": enabled,
        "ok": not enabled or not reasons,
        "config_path": str(config_path),
        "config_error": config_error,
        "components": components,
        "reasons": reasons,
    }


def _run(cmd: list[str], timeout: int = 5, cwd: Path | None = None) -> tuple[int, str, str]:
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=str(cwd) if cwd else None)
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except Exception as exc:
        return 999, "", str(exc)


def check_hermes_cli_contract(path: str | None) -> dict[str, Any]:
    """Feature-probe the Hermes CLI surfaces the Host actually depends on."""
    if not path:
        return {"ok": False, "probed": False, "missing": ["hermes executable"]}
    probes = {
        "serve": (["serve", "--help"], ["--port", "--host", "--skip-build"]),
        "sessions_export": (
            ["sessions", "export", "--help"],
            ["--session-id", "output"],
        ),
        "config_set": (["config", "set", "--help"], ["key", "value"]),
        "toolsets": (["--help"], ["--toolsets"]),
    }
    details: dict[str, Any] = {}
    missing: list[str] = []
    for name, (args, markers) in probes.items():
        code, stdout, stderr = _run([path, *args], timeout=5)
        output = f"{stdout}\n{stderr}"
        absent = [marker for marker in markers if marker not in output]
        ok = code == 0 and not absent
        details[name] = {"ok": ok, "missing_markers": absent, "exit_code": code}
        if not ok:
            missing.append(name)
    return {
        "ok": not missing,
        "probed": True,
        "path": path,
        "required": list(probes),
        "missing": missing,
        "probes": details,
    }


def check_hermes_phase_registration(path: str | None) -> dict[str, Any]:
    """Read-only check for the two phase-specific MCP capability names.

    ``hermes mcp list`` does not expose connector credentials. Parse only the
    first and final table columns, and never return the command's raw output.
    """
    required = {"yulu_artifact", "yulu_delivery"}
    if not path:
        return {"ok": False, "probed": False, "missing": sorted(required)}
    code, stdout, _stderr = _run([path, "mcp", "list"], timeout=5)
    enabled: set[str] = set()
    if code == 0:
        ansi = re.compile(r"\x1b\[[0-9;]*m")
        for raw_line in stdout.splitlines():
            parts = ansi.sub("", raw_line).strip().split()
            if len(parts) >= 2 and parts[0] in required and parts[-1] == "enabled":
                enabled.add(parts[0])
    missing = sorted(required - enabled)
    return {
        "ok": code == 0 and not missing,
        "probed": True,
        "required": sorted(required),
        "enabled": sorted(enabled),
        "missing": missing,
        "exit_code": code,
    }


def _git_info(root: Path) -> dict[str, Any]:
    if not (root / ".git").exists():
        return {"is_repo": False}
    branch = _run(["git", "branch", "--show-current"], cwd=root)[1]
    remote = _run(["git", "remote", "get-url", "origin"], cwd=root)[1]
    status = _run(["git", "status", "--short"], cwd=root)[1].splitlines()
    head = _run(["git", "rev-parse", "--short", "HEAD"], cwd=root)[1]
    return {
        "is_repo": True,
        "branch": branch,
        "remote": remote,
        "head": head,
        "dirty": bool(status),
        "status": status,
    }


def _install_info(root: Path) -> dict[str, Any]:
    install_path = root / ".yulu-install.json"
    info: dict[str, Any] = {"present": install_path.exists(), "path": str(install_path)}
    if not install_path.exists():
        return info
    try:
        data = json.loads(install_path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            info.update({
                "schema": data.get("schema"),
                "source": data.get("source"),
                "version": data.get("version"),
                "asset": data.get("asset"),
            })
    except Exception as exc:
        info["error"] = str(exc)
    return info


def _dependency_manager() -> Any:
    """Return a MacOSDependencyManager on Darwin, else None (guarded import).

    Routes brew-managed dependency *presence* reads through the PermissionModel/
    DependencyManager seams so the package-manager vocabulary lives behind the
    abstraction (PLAT-05). Import is lazy+guarded so doctor.py keeps working off
    Darwin or if the seam package is unavailable (it then falls back to which()).
    """
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from yulu_platform.macos import MacOSDependencyManager
        return MacOSDependencyManager()
    except Exception:
        return None


def _check_command(name: str, args: list[str] | None = None) -> dict[str, Any]:
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from capabilities.probes import resolve_on_login_path
        path = resolve_on_login_path(name)
    except Exception:
        path = shutil.which(name)
    # Presence read routes through the DependencyManager seam when available;
    # falls back to the which() result off Darwin / when the seam is absent.
    ok = bool(path)
    mgr = _dependency_manager()
    if mgr is not None:
        try:
            # Keep the dependency-manager read for platform abstraction, but a
            # command check is usable only when we resolved an executable path.
            mgr.is_available(name)
        except Exception:
            pass
    check = {"name": name, "ok": ok, "path": path or ""}
    if path and args:
        code, out, err = _run([path, *args])
        check.update({"returncode": code, "version": (out or err).splitlines()[0] if (out or err) else ""})
    return check


def _socket_status(sock_path: Path, timeout: float = 3.0) -> dict[str, Any]:
    info: dict[str, Any] = {"path": str(sock_path), "exists": sock_path.exists(), "ok": False}
    if not sock_path.exists():
        return info
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(str(sock_path))
            s.sendall(b'{"action":"status"}\n')
            s.shutdown(socket.SHUT_WR)
            data = s.recv(4096)
        response = data.decode("utf-8", errors="replace").strip()
        info["ok"] = True
        info["response"] = response
        try:
            parsed = json.loads(response)
            info["recording"] = bool(parsed.get("recording"))
            info["sysReady"] = parsed.get("sysReady")
            info["micReady"] = parsed.get("micReady")
            info["sysError"] = parsed.get("sysError", "")
            info["micError"] = parsed.get("micError", "")
        except Exception:
            pass
    except Exception as exc:
        info["error"] = str(exc)
    return info


def _yulu_processes() -> list[str]:
    code, out, _ = _run(["ps", "aux"], timeout=5)
    if code != 0:
        return []
    needles = ("yulu", "Yulu.app", "audio_daemon")
    return [line for line in out.splitlines() if any(n in line for n in needles) and "doctor.py" not in line]


def _safe_process_projection(
    processes: list[str],
    *,
    runtime_root: Path,
    legacy_root: Path,
) -> list[dict[str, Any]]:
    """Return process identity without command arguments or environment values."""
    projected: list[dict[str, Any]] = []
    for line in processes:
        parts = line.split(None, 10)
        if len(parts) < 11:
            continue
        try:
            pid = int(parts[1])
        except ValueError:
            continue
        command = parts[10].split(maxsplit=1)[0]
        scope = "other"
        if str(legacy_root) in line:
            scope = "legacy"
        elif str(runtime_root) in line:
            scope = "runtime"
        projected.append({
            "pid": pid,
            "executable": Path(command).name,
            "scope": scope,
        })
    return projected


_ADAPTERS = {"codex", "claude-code", "hermes", "openclaw", "direct-xai"}
_KINDS = {"supported-agent", "direct-provider", "legacy-custom"}
_LIFECYCLES = {"connected", "disconnected", "candidate", "legacy", "available"}
_CAPABILITIES = {"transcription", "summary", "conversation"}
_READINESS_STATUSES = {"ready", "failed", "untested"}
_READINESS_REASONS = {"invalid_model", "readiness_failed", "unknown_outcome"}
_CREDENTIAL_SOURCES = {"runtime-oauth", "oauth", "api-key"}
_AUTHORIZATION_CLASSES = {"chatgpt", "claude-subscription", "api-key", "amazon-bedrock", "unknown"}
_VERSION_SOURCES = {"live-runtime", "readiness-history", "not-applicable", "unverified"}
_LABELS = {
    "codex": "Codex",
    "claude-code": "Claude Code",
    "hermes": "Hermes",
    "openclaw": "OpenClaw",
    "direct-xai": "xAI",
}


def _enum(value: Any, allowed: set[str]) -> str | None:
    return value if isinstance(value, str) and value in allowed else None


def _structured_text(value: Any, pattern: str, *, limit: int) -> str | None:
    """Accept only the grammar of a named diagnostic field, never arbitrary text."""
    if not isinstance(value, str) or not value or len(value) > limit:
        return None
    return value if re.fullmatch(pattern, value) else None


def _connection_id(value: Any) -> str | None:
    return _structured_text(value, r"[A-Za-z0-9][A-Za-z0-9._-]*", limit=200)


def _model(value: Any) -> str | None:
    return _structured_text(value, r"[A-Za-z0-9][A-Za-z0-9._:/+@-]*", limit=128)


def _version(value: Any) -> str | None:
    return _structured_text(value, r"[A-Za-z0-9][A-Za-z0-9._:+-]*", limit=128)


def _feature(value: Any) -> str | None:
    return _structured_text(value, r"[A-Za-z0-9][A-Za-z0-9._:/+-]*", limit=100)


def _readiness_projection(value: Any) -> dict[str, Any]:
    item = value if isinstance(value, dict) else {}
    return {
        "status": _enum(item.get("status"), _READINESS_STATUSES),
        "model": _model(item.get("model")),
        "tested_at": _structured_text(
            item.get("testedAt"), r"[0-9TZ:.,+-]+", limit=64,
        ),
        "credential_source": _enum(item.get("credentialSource"), _CREDENTIAL_SOURCES),
        "reason": _enum(item.get("reason"), _READINESS_REASONS),
    }


def _runtime_evidence_projection(value: Any) -> dict[str, Any]:
    item = value if isinstance(value, dict) else {}
    text_fields = {
        "adapter": "adapter",
        "transport": "transport",
        "runtime_version": "runtimeVersion",
        "requested_provider": "requestedProvider",
        "requested_model": "requestedModel",
        "actual_provider": "actualProvider",
        "actual_model": "actualModel",
        "terminal_status": "terminalStatus",
    }
    projected = {}
    for output, source in text_fields.items():
        raw = item.get(source)
        if output in {"runtime_version"}:
            projected[output] = _version(raw)
        elif output in {"requested_model", "actual_model"}:
            projected[output] = _model(raw)
        elif output == "terminal_status":
            projected[output] = _enum(raw, {"ready", "failed", "unknown"})
        else:
            projected[output] = _structured_text(
                raw, r"[A-Za-z0-9][A-Za-z0-9._:/+-]*", limit=128,
            )
    projected.update({
        **({"authorization_class": authorization_class}
           if (authorization_class := _enum(item.get("authorizationClass"), _AUTHORIZATION_CLASSES))
           else {}),
        "fallback_occurred": item.get("fallbackOccurred")
        if isinstance(item.get("fallbackOccurred"), bool) else None,
        "tools_enabled": item.get("toolsEnabled")
        if isinstance(item.get("toolsEnabled"), bool) else None,
        "cancellation_requested": item.get("cancellationRequested")
        if isinstance(item.get("cancellationRequested"), bool) else None,
        "cancellation_confirmed": item.get("cancellationConfirmed")
        if isinstance(item.get("cancellationConfirmed"), bool) else None,
    })
    return projected


def _history_projection(value: Any) -> list[dict[str, Any]]:
    rows = value if isinstance(value, list) else []
    projected: list[dict[str, Any]] = []
    for raw in rows[:10]:
        item = raw if isinstance(raw, dict) else {}
        current = _readiness_projection(item)
        current["runtime_evidence"] = _runtime_evidence_projection(item.get("runtimeEvidence"))
        projected.append(current)
    return projected


def _connection_projection(value: Any) -> dict[str, Any]:
    item = value if isinstance(value, dict) else {}
    authorization = item.get("authorization") if isinstance(item.get("authorization"), dict) else {}
    features = authorization.get("features") if isinstance(authorization.get("features"), list) else []
    capabilities = item.get("capabilities") if isinstance(item.get("capabilities"), list) else []
    connection_id = _connection_id(item.get("id"))
    adapter = _enum(item.get("adapter"), _ADAPTERS)
    projected_capabilities: list[dict[str, Any]] = []
    for raw in capabilities[:10]:
        capability = raw if isinstance(raw, dict) else {}
        capability_name = _enum(capability.get("capability"), _CAPABILITIES)
        needs_remediation = isinstance(capability.get("remediation"), dict)
        projected_capabilities.append({
            "capability": capability_name,
            "declared": capability.get("declared") is True,
            "selected": capability.get("selected") is True,
            "current_readiness": _readiness_projection(capability.get("currentReadiness")),
            "readiness_history": _history_projection(capability.get("readinessHistory")),
            "remediation": (
                f"/settings/llm?connection={quote(connection_id)}&capability={capability_name}"
                if needs_remediation and connection_id and capability_name else None
            ),
        })
    needs_remediation = bool(authorization.get("remediation")) or authorization.get("connected") is not True
    if authorization.get("supported") is False:
        needs_remediation = True
    remediation = (
        f"/settings/llm?connection={quote(connection_id)}"
        if needs_remediation and connection_id else "/settings/llm" if needs_remediation else None
    )
    return {
        "id": connection_id,
        "kind": _enum(item.get("kind"), _KINDS),
        "adapter": adapter,
        "label": _LABELS.get(adapter, "Agent Connection"),
        "lifecycle": _enum(item.get("lifecycle"), _LIFECYCLES),
        "authorization": {
            "connected": authorization.get("connected") is True,
            "credential_source": _enum(authorization.get("credentialSource"), _CREDENTIAL_SOURCES),
            **({"authorization_class": authorization_class}
               if (authorization_class := _enum(
                   authorization.get("authorizationClass"), _AUTHORIZATION_CLASSES,
               )) else {}),
        },
        "compatibility": {
            "runtime_version": _version(authorization.get("runtimeVersion")),
            "minimum_version": _version(authorization.get("minimumVersion")),
            "target_version": _version(authorization.get("compatibilityTarget")),
            "version_source": _enum(authorization.get("versionSource"), _VERSION_SOURCES),
            "supported": authorization.get("supported")
            if isinstance(authorization.get("supported"), bool) else None,
            "features": [
                safe for feature in features[:100] if (safe := _feature(feature))
            ],
        },
        "capabilities": projected_capabilities,
        "remediation": remediation,
    }


def _simple_connection_projection(value: Any) -> dict[str, Any]:
    item = value if isinstance(value, dict) else {}
    capabilities = item.get("capabilities") if isinstance(item.get("capabilities"), list) else []
    adapter = _enum(item.get("adapter"), _ADAPTERS)
    connection_id = _connection_id(item.get("id"))
    lifecycle = _enum(item.get("lifecycle"), _LIFECYCLES)
    remediation_key = "candidate" if lifecycle == "candidate" else "legacy"
    return {
        "id": connection_id,
        "adapter": adapter,
        "label": _LABELS.get(adapter, "Agent Connection"),
        "lifecycle": lifecycle,
        "capabilities": [
            safe for capability in capabilities[:10]
            if (safe := _enum(capability, _CAPABILITIES))
        ],
        "remediation": (
            f"/settings/llm?{remediation_key}={quote(connection_id)}"
            if connection_id else "/settings/llm"
        ),
    }


def _agent_connections_unavailable() -> dict[str, Any]:
    return {
        "ok": False,
        "source": "host-public-projection",
        "connections": [],
        "candidates": [],
        "legacy_connections": [],
        "error": "Agent Connection diagnostics are unavailable from the local Host",
        "remediation": "/settings/llm",
    }


def check_agent_connections(timeout: float = 30.0) -> dict[str, Any]:
    """Read and whitelist the Host's public, quota-free Agent Connection view."""
    try:
        import urllib.request

        with urllib.request.urlopen(
            "http://127.0.0.1:7777/trpc/agentConnections.view",
            timeout=timeout,
        ) as response:
            body = response.read(2_000_001)
            if response.status != 200 or len(body) > 2_000_000:
                return _agent_connections_unavailable()
        envelope = json.loads(body.decode("utf-8"))
        data = envelope.get("result", {}).get("data", {})
        if not isinstance(data, dict):
            return _agent_connections_unavailable()
        connections = data.get("connections")
        candidates = data.get("candidates")
        legacy = data.get("legacyConnections")
        if not all(isinstance(items, list) for items in (connections, candidates, legacy)):
            return _agent_connections_unavailable()
        return {
            "ok": True,
            "source": "host-public-projection",
            "connections": [_connection_projection(item) for item in connections[:100]],
            "candidates": [_simple_connection_projection(item) for item in candidates[:100]],
            "legacy_connections": [_simple_connection_projection(item) for item in legacy[:100]],
            "error": None,
            "remediation": None,
        }
    except Exception:
        return _agent_connections_unavailable()


def check_search_index(config_dir: Path) -> dict[str, Any]:
    """Phase 6 health check: open search.sqlite via search.reader.doctor()
    and return a uniform dict. Always returns a dict — never raises —
    so doctor.py can render it inline even if FTS5 or the module is
    unavailable."""
    db_path = config_dir / "search.sqlite"
    report: dict[str, Any] = {
        "db_path": str(db_path),
        "present": db_path.exists(),
        "ok": False,
    }
    if not db_path.exists():
        report["error"] = "search.sqlite not initialized (run setup.sh or `yulu search --reindex`)"
        return report
    try:
        # Lazy import so doctor.py keeps working even if search.indexer
        # has a typo / unreadable schema.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from search.reader import doctor as _doctor
        from search.indexer import SEARCH_DB_PATH as _DEFAULT_DB
        # Use the requested db_path explicitly so a non-standard config_dir
        # still produces a meaningful report (tests rely on this).
        if db_path == _DEFAULT_DB:
            health = _doctor()
        else:
            health = _doctor(db_path=db_path)
        report.update(health)
        report["ok"] = bool(health.get("integrity_ok"))
    except Exception as exc:
        report["error"] = f"search doctor failed: {exc}"
    return report


def _host_capabilities(config_dir: Path, runtime_root: Path) -> dict[str, Any]:
    """Report Agent CLIs, calendar support, and local recording readiness.

    Transcription engines and models are intentionally absent: the selected
    Agent owns those capabilities. The whole body remains read-only and
    never-raise so ``yulu doctor`` is safe on partially configured hosts.
    """
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from capabilities.probes import (
            probe_command,
            probe_llm_command,
            probe_recording_dir,
        )
        from capabilities.provider import default_providers
        from capabilities.report import HostCapabilityReport

        report = HostCapabilityReport()
        # Agent and deterministic Host capabilities only.
        report.capabilities["hermes"] = probe_command("hermes", ("--version",))
        report.capabilities["claude"] = probe_command("claude", ("--version",))
        report.capabilities["llm_command"] = probe_llm_command(config_dir / "config.json")
        report.capabilities["recording_dir"] = probe_recording_dir()
        # gog (Google Calendar CLI from steipete/tap/gogcli) — a host CLI with host-path
        # provenance, NOT an agent-config reframe (D-06 provider neutrality stays intact).
        # setup_deps.sh can gate `brew install steipete/tap/gogcli` on its tri-state.
        # probe_command resolves on the login PATH and reports USABLE even if `--version`
        # yields nothing (resolution, not version, drives usability).
        report.capabilities["gog"] = probe_command("gog", ("--version",))

        # Merge every registered provider's agent-config entries (DETECT-05). default_providers()
        # is the single Phase-8 extension point — a new provider arm flows in here with no edit.
        for provider in default_providers():
            try:
                for name, cap in provider.capabilities().items():
                    report.capabilities[name] = cap
            except Exception:
                # A misbehaving provider must not break the section (never-raise contract).
                continue

        return report.to_dict()
    except Exception as exc:
        # Degrade cleanly — same shape (schema_version + capabilities) plus an error marker.
        return {"error": str(exc), "schema_version": 1, "capabilities": {}}


def _privacy_opt_in(config_dir: Path) -> dict[str, Any]:
    """Report local-first defaults and explicit cloud/external-service opt-ins."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from privacy_opt_in import load_config, privacy_opt_in_report

        return privacy_opt_in_report(load_config(config_dir / "config.json"))
    except Exception as exc:
        return {"schema_version": 1, "ok": False, "error": str(exc)}


def check_yulu_ui(
    script_dir: Path,
    config_dir: Path,
    timeout: float = 2.0,
) -> dict[str, Any]:
    """Verify the required durable Host build, LaunchAgent, and /healthz.

    ``agent_pipeline`` consumes this report and makes an enabled pipeline fail
    overall health when the Host is absent or unreachable.
    """
    script_dir = Path(script_dir).expanduser()
    config_dir = Path(config_dir).expanduser()

    ui_dir = script_dir / "yulu_ui"
    dist_server = ui_dir / "dist" / "server.js"
    dist_index = ui_dir / "dist" / "web" / "index.html"
    plist_path = Path.home() / "Library" / "LaunchAgents" / "com.yulu.ui.plist"
    log_path = config_dir / "ui.log"

    report: dict[str, Any] = {
        "dist_server_present": dist_server.is_file() and dist_server.stat().st_size > 0,
        "dist_web_present": dist_index.is_file() and dist_index.stat().st_size > 0,
        "plist_installed": plist_path.is_file(),
        "launchctl_loaded": False,
        "port": 7777,
        "healthz_ok": False,
        "healthz_response": None,
        "log_path": str(log_path),
        "log_present": log_path.is_file(),
        "log_size_bytes": log_path.stat().st_size if log_path.is_file() else None,
        "error": None,
    }

    # launchctl loaded?
    code, out, _ = _run(["launchctl", "list"], timeout=3)
    if code == 0 and any("com.yulu.ui" in line for line in out.splitlines()):
        report["launchctl_loaded"] = True

    # A healthy process on the fixed localhost port is not evidence for an
    # arbitrary --runtime-root.  Refuse to attribute that process to this
    # runtime unless the runtime itself contains the shipped Host artifacts.
    if report["dist_server_present"] and report["dist_web_present"]:
        try:
            import urllib.request
            with urllib.request.urlopen(
                f"http://127.0.0.1:{report['port']}/healthz", timeout=timeout
            ) as resp:
                body = resp.read().decode("utf-8", errors="replace")[:200]
                report["healthz_response"] = body
                if resp.status == 200 and '"status":"ok"' in body:
                    report["healthz_ok"] = True
        except Exception as exc:
            report["error"] = f"healthz fetch failed: {exc}"

    # Categorize the most actionable single error message
    if not report["dist_server_present"] or not report["dist_web_present"]:
        report["error"] = "build artifacts missing — run setup.sh --upgrade"
    elif report["plist_installed"] and not report["launchctl_loaded"]:
        report["error"] = "plist installed but service not loaded — run yulu start"

    return report


def collect_report(
    source_root: Path = DEFAULT_SOURCE_ROOT,
    runtime_root: Path = DEFAULT_RUNTIME_ROOT,
    legacy_root: Path = DEFAULT_LEGACY_ROOT,
    config_dir: Path = DEFAULT_CONFIG_DIR,
    application_data_dir: Path | None = None,
) -> dict[str, Any]:
    source_root = Path(source_root).expanduser().resolve()
    runtime_root = Path(runtime_root).expanduser()
    legacy_root = Path(legacy_root).expanduser()
    config_dir = Path(config_dir).expanduser()
    if application_data_dir is None:
        application_data_dir = (
            DEFAULT_APPLICATION_DATA_DIR
            if config_dir == DEFAULT_CONFIG_DIR
            else config_dir
        )
    application_data_dir = Path(application_data_dir).expanduser()

    processes = _safe_process_projection(
        _yulu_processes(),
        runtime_root=runtime_root,
        legacy_root=legacy_root,
    )
    legacy_processes = [p for p in processes if p.get("scope") == "legacy"]
    runtime_processes = [p for p in processes if p.get("scope") == "runtime"]

    checks = [
        _check_command("python3", ["--version"]),
        _check_command("ffmpeg", ["-version"]),
        _check_command("ffprobe", ["-version"]),
        _check_command("swiftc"),
        _check_command("hermes", ["--version"]),
        _check_command("codex", ["--version"]),
        _check_command("gh", ["--version"]),
    ]

    config_path = config_dir / "config.json"
    uses_standard_contract = config_dir == DEFAULT_CONFIG_DIR
    ui_report = check_yulu_ui(
        runtime_root / "yulu" / "scripts",
        DEFAULT_LOGS_DIR if uses_standard_contract else config_dir,
    )
    agent_connections = (
        check_agent_connections()
        if ui_report.get("healthz_ok")
        else _agent_connections_unavailable()
    )
    hermes_check = next((item for item in checks if item.get("name") == "hermes"), {})
    hermes_contract = check_hermes_cli_contract(
        str(hermes_check.get("path") or "") if hermes_check.get("ok") else None
    )
    hermes_phase_registration = check_hermes_phase_registration(
        str(hermes_check.get("path") or "") if hermes_check.get("ok") else None
    )
    agent_pipeline = check_agent_pipeline(
        config_dir,
        checks,
        ui_report,
        hermes_contract=hermes_contract,
        hermes_phase_registration=hermes_phase_registration,
        token_path=application_data_dir / "mcp-token.json",
        legacy_token_path=config_dir / "mcp-token.json",
    )

    return {
        "source_root": str(source_root),
        "source_git": _git_info(source_root),
        "source_install": _install_info(source_root),
        "runtime_root": str(runtime_root),
        "runtime_exists": runtime_root.exists(),
        "legacy_root": str(legacy_root),
        "legacy_root_exists": legacy_root.exists(),
        "config_dir": str(config_dir),
        "config_exists": config_dir.exists(),
        "config_path_exists": config_path.exists(),
        "host_tasks": check_host_tasks(config_dir),
        "socket": _socket_status(
            (DEFAULT_IPC_DIR if uses_standard_contract else config_dir)
            / "audio_daemon.sock"
        ),
        "search_index": check_search_index(application_data_dir),
        # §5d fix (CONCERNS §5d, D-07): the UI check must look at the RUNTIME install, not the
        # source checkout — a production install (source_root != runtime_root) now reports the
        # installed UI dist honestly. When source_root == runtime_root (dev), behavior is unchanged.
        "yulu_ui": ui_report,
        "agent_connections": agent_connections,
        "agent_pipeline": agent_pipeline,
        "host_capabilities": _host_capabilities(config_dir, runtime_root),
        "privacy_opt_in": _privacy_opt_in(config_dir),
        "processes": processes,
        "legacy_processes": legacy_processes,
        "runtime_processes": runtime_processes,
        "checks": checks,
    }


def _overall_ok(report: dict[str, Any]) -> bool:
    required = ["python3"]
    checks = {c["name"]: c for c in report.get("checks", [])}
    if any(not checks.get(name, {}).get("ok") for name in required):
        return False
    if report.get("legacy_processes"):
        return False
    if not report.get("source_git", {}).get("is_repo") and not report.get("source_install", {}).get("present"):
        return False
    pipeline = report.get("agent_pipeline", {})
    if pipeline.get("enabled") and not pipeline.get("ok"):
        return False
    connections = report.get("agent_connections")
    if connections is not None:
        if not connections.get("ok"):
            return False
        if any(
            connection.get("compatibility", {}).get("supported") is not True
            for connection in connections.get("connections", [])
        ):
            return False
    return True


def print_human(report: dict[str, Any]) -> None:
    def mark(ok: bool) -> str:
        return "✓" if ok else "!"

    git = report["source_git"]
    install = report.get("source_install", {})
    print("Yulu doctor")
    print(f"{mark(git.get('is_repo', False) or install.get('present', False))} source: {report['source_root']}")
    if git.get("is_repo"):
        dirty = "dirty" if git.get("dirty") else "clean"
        print(f"  branch={git.get('branch')} head={git.get('head')} {dirty}")
        print(f"  remote={git.get('remote')}")
    elif install.get("present"):
        version = install.get("version") or "unknown"
        source = install.get("source") or "unknown"
        asset = install.get("asset") or "unknown"
        print(f"  install={source} version={version} asset={asset}")
        if install.get("error"):
            print(f"  install metadata error: {install['error']}")
    print(f"{mark(report['runtime_exists'])} runtime: {report['runtime_root']}")
    print(f"{mark(not report['legacy_processes'])} legacy root: {report['legacy_root']} exists={report['legacy_root_exists']} legacy_processes={len(report['legacy_processes'])}")
    host_tasks = report.get("host_tasks", {})
    print(f"{mark(report['config_exists'])} config: {report['config_dir']} host_tasks={host_tasks.get('total', 0)}")
    if host_tasks.get("error"):
        print(f"  host task store error: {host_tasks['error']}")
    elif host_tasks.get("states"):
        print("  task states: " + " ".join(f"{state}={count}" for state, count in sorted(host_tasks["states"].items())))
    sock = report["socket"]
    print(f"{mark(sock.get('ok', False))} audio daemon socket: {sock.get('path')} exists={sock.get('exists')}")
    if sock.get("ok") and (sock.get("sysReady") is not None or sock.get("micReady") is not None):
        sys_part = f"sysReady={sock.get('sysReady')}"
        mic_part = f"micReady={sock.get('micReady')}"
        err_part = ""
        if sock.get("sysError"):
            err_part += f" sysError={sock.get('sysError')}"
        if sock.get("micError"):
            err_part += f" micError={sock.get('micError')}"
        print(f"  {sys_part} {mic_part}{err_part}")
        if sock.get("sysReady") is False:
            print("  repair: yulu repair-permissions --reset")
    si = report.get("search_index", {})
    if si:
        print(f"{mark(si.get('ok', False))} search index: {si.get('db_path')} present={si.get('present')}")
        if si.get("ok"):
            per_kind = si.get("per_kind", {}) or {}
            kinds_str = " ".join(f"{k}={v}" for k, v in sorted(per_kind.items())) or "(empty)"
            print(f"  total_docs={si.get('total_docs')} schema=v{si.get('schema_version')} "
                  f"last_sweep={si.get('last_full_sweep_at') or 'never'}")
            print(f"  per_kind: {kinds_str}")
        elif si.get("error"):
            print(f"  error: {si['error']}")
    ui = report.get("yulu_ui", {})
    if ui:
        ok_state = ui.get("healthz_ok", False) and ui.get("dist_server_present", False)
        size_kb = (ui.get("log_size_bytes") or 0) / 1024
        print(f"{mark(ok_state)} yulu_ui: port={ui.get('port')} "
              f"dist={ui.get('dist_server_present')} loaded={ui.get('launchctl_loaded')} "
              f"healthz={'ok' if ui.get('healthz_ok') else 'fail'}")
        if ui.get("log_present"):
            print(f"  log: {ui['log_path']} ({size_kb:.1f} KB)")
        if ui.get("error"):
            print(f"  error: {ui['error']}")
    pipeline = report.get("agent_pipeline", {})
    if pipeline:
        enabled = bool(pipeline.get("enabled"))
        print(
            f"{mark(bool(pipeline.get('ok')))} agent pipeline: "
            f"enabled={enabled} ok={pipeline.get('ok')}"
        )
        if enabled and pipeline.get("reasons"):
            print("  unavailable: " + ", ".join(str(item) for item in pipeline["reasons"]))
    agent_connections = report.get("agent_connections", {})
    if agent_connections:
        print(
            f"{mark(bool(agent_connections.get('ok')))} agent connections: "
            f"configured={len(agent_connections.get('connections', []))} "
            f"candidates={len(agent_connections.get('candidates', []))}"
        )
        for connection in agent_connections.get("connections", []):
            compatibility = connection.get("compatibility", {})
            runtime_version = compatibility.get("runtime_version") or "n/a"
            version_source = compatibility.get("version_source") or "unverified"
            target_version = compatibility.get("target_version") or "n/a"
            supported = compatibility.get("supported")
            print(
                f"  {connection.get('label') or connection.get('adapter')}: "
                f"adapter={connection.get('adapter')} actual={runtime_version} "
                f"target={target_version} version_source={version_source} "
                f"supported={supported} lifecycle={connection.get('lifecycle')}"
            )
            features = compatibility.get("features", [])
            if features:
                print("    features: " + ", ".join(str(item) for item in features))
            for capability in connection.get("capabilities", []):
                current = capability.get("current_readiness", {})
                history = capability.get("readiness_history", [])
                print(
                    f"    {capability.get('capability')}: declared={capability.get('declared')} "
                    f"selected={capability.get('selected')} current={current.get('status')} "
                    f"history={len(history)}"
                )
                if capability.get("remediation"):
                    print(f"      repair: {capability['remediation']}")
            if connection.get("remediation"):
                print(f"    repair: {connection['remediation']}")
        if agent_connections.get("error"):
            print(f"  error: {agent_connections['error']}")
            print(f"  repair: {agent_connections.get('remediation')}")
    hc = report.get("host_capabilities", {})
    if hc:
        caps = hc.get("capabilities", {}) or {}
        usable = sum(1 for c in caps.values() if c.get("status") == "usable")
        print(f"  host capabilities: schema=v{hc.get('schema_version')} "
              f"usable={usable}/{len(caps)}")
        if hc.get("error"):
            print(f"  host_capabilities error: {hc['error']}")
    for check in report["checks"]:
        print(f"{mark(check['ok'])} {check['name']}: {check.get('path') or 'missing'}")
    if report["legacy_processes"]:
        print("\nLegacy Yulu processes detected:")
        for line in report["legacy_processes"]:
            print(f"  {line}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only Yulu development/runtime doctor")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    parser.add_argument("--source-root", type=Path, default=DEFAULT_SOURCE_ROOT)
    parser.add_argument("--runtime-root", type=Path, default=DEFAULT_RUNTIME_ROOT)
    parser.add_argument("--legacy-root", type=Path, default=DEFAULT_LEGACY_ROOT)
    parser.add_argument("--config-dir", type=Path, default=DEFAULT_CONFIG_DIR)
    parser.add_argument("--application-data-dir", type=Path, default=DEFAULT_APPLICATION_DATA_DIR)
    args = parser.parse_args(argv)

    report = collect_report(
        args.source_root,
        args.runtime_root,
        args.legacy_root,
        args.config_dir,
        args.application_data_dir,
    )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_human(report)
    return 0 if _overall_ok(report) else 1


if __name__ == "__main__":
    raise SystemExit(main())
