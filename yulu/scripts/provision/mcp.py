#!/usr/bin/env python3
"""Yulu HTTP MCP registration.

Core install owns the local server; this module owns the per-agent pointer to it.
All subprocess calls are argv lists.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

ENDPOINT = "http://127.0.0.1:7777/mcp"
ARTIFACT_ENDPOINT = f"{ENDPOINT}/recording-artifact"
DELIVERY_ENDPOINT = f"{ENDPOINT}/recording-delivery"
ENV_NAME = "YULU_MCP_TOKEN"


def _default_token_paths() -> tuple[Path, Path]:
    if sys.platform == "darwin":
        from yulu_platform.macos.path_resolver import MacOSPathResolver

        paths = MacOSPathResolver().application_paths()
        return (
            paths.durable_data_dir / "mcp-token.json",
            paths.legacy_read_only_data_dir / "mcp-token.json",
        )
    home = Path.home()
    return (
        home / "Library/Application Support/Yulu/mcp-token.json",
        home / ".config/yulu/mcp-token.json",
    )


TOKEN_PATH, LEGACY_TOKEN_PATH = _default_token_paths()
AGENTS = ("codex", "claude", "openclaw", "hermes")
LOGIN_PATH_MARKER = "__YULU_LOGIN_PATH__"


def _fallback_executable_dirs() -> list[str]:
    home = Path.home()
    return [
        str(home / ".local" / "bin"),
        str(home / ".npm-global" / "bin"),
        str(home / ".nvm" / "current" / "bin"),
        "/opt/homebrew/opt/node/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]


def _deduplicated_path(entries: Iterable[str]) -> str:
    return os.pathsep.join(dict.fromkeys(entry for entry in entries if entry))


def _which(command: str, search_path: str | None = None) -> str | None:
    try:
        return shutil.which(command, path=search_path) if search_path is not None else shutil.which(command)
    except TypeError:
        # A few callers/tests replace shutil.which with the one-argument form.
        return None


def _login_shell_path() -> str:
    shell = os.environ.get("SHELL", "")
    if not shell or not Path(shell).is_file() or not os.access(shell, os.X_OK):
        return ""
    try:
        proc = subprocess.run(
            [shell, "-lc", f'printf "{LOGIN_PATH_MARKER}%s\\n" "$PATH"'],
            text=True,
            capture_output=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if proc.returncode != 0:
        return ""
    for line in reversed(proc.stdout.splitlines()):
        if line.startswith(LOGIN_PATH_MARKER):
            return line.removeprefix(LOGIN_PATH_MARKER)
    return ""


def executable_search_path() -> str:
    login_path = _login_shell_path()
    return _deduplicated_path([
        *(os.environ.get("PATH", "").split(os.pathsep)),
        *(login_path.split(os.pathsep) if login_path else []),
        *_fallback_executable_dirs(),
    ])


def resolve_executable(command: str) -> str | None:
    if os.path.dirname(command):
        path = Path(command).expanduser()
        return str(path) if path.is_file() and os.access(path, os.X_OK) else None
    current = _which(command)
    if current:
        return current

    # Check deterministic GUI/LaunchAgent fallbacks before starting a login
    # shell; Hermes commonly installs to ~/.local/bin.
    fallback_path = _deduplicated_path([
        *(os.environ.get("PATH", "").split(os.pathsep)),
        *_fallback_executable_dirs(),
    ])
    fallback = _which(command, fallback_path)
    if fallback:
        return fallback
    return _which(command, executable_search_path())


def _write_token(path: Path, token: str) -> None:
    parent_fd = _open_directory(path.parent, create=True)
    try:
        os.fchmod(parent_fd, 0o700)
        tmp_name = f".{path.name}.{os.getpid()}.{secrets.token_hex(16)}.tmp"
        fd = os.open(
            tmp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=parent_fd,
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({
                    "token": token,
                    "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                    "endpoint": ENDPOINT,
                }, handle, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(
                tmp_name,
                path.name,
                src_dir_fd=parent_fd,
                dst_dir_fd=parent_fd,
            )
            committed = os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISREG(committed.st_mode) or committed.st_mode & 0o077:
                raise OSError("MCP token authority is unsafe")
        finally:
            try:
                os.unlink(tmp_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
    finally:
        os.close(parent_fd)


def _open_directory(path: Path, *, create: bool) -> int:
    path = Path(path)
    if not path.is_absolute():
        raise ValueError("MCP token path must be absolute")
    current_fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:]:
            try:
                next_fd = os.open(
                    component,
                    os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=current_fd,
                )
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(component, 0o700, dir_fd=current_fd)
                next_fd = os.open(
                    component,
                    os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=current_fd,
                )
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except Exception:
        os.close(current_fd)
        raise


def _path_entry_exists(path: Path) -> bool:
    parent_fd: int | None = None
    try:
        parent_fd = _open_directory(path.parent, create=False)
        os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return True
    finally:
        if parent_fd is not None:
            os.close(parent_fd)


def _read_token_file(path: Path, *, repair_permissions: bool = False) -> str:
    parent_fd: int | None = None
    try:
        parent_fd = _open_directory(path.parent, create=False)
        before = os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode):
            return ""
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path.name, flags, dir_fd=parent_fd), "r", encoding="utf-8") as handle:
            opened = os.fstat(handle.fileno())
            if (
                not stat.S_ISREG(opened.st_mode)
                or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
            ):
                return ""
            if opened.st_mode & 0o077:
                if not repair_permissions:
                    return ""
                os.fchmod(handle.fileno(), 0o600)
            raw = json.load(handle)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return ""
    finally:
        if parent_fd is not None:
            os.close(parent_fd)
    token = raw.get("token") if isinstance(raw, dict) else None
    return token if isinstance(token, str) and token else ""


def ensure_token(path: Path | None = None, rotate: bool = False) -> str:
    use_default_paths = path is None
    path = TOKEN_PATH if path is None else path
    if not rotate:
        token = _read_token_file(path, repair_permissions=True)
        if token:
            return token
        if use_default_paths and not _path_entry_exists(path):
            token = _read_token_file(LEGACY_TOKEN_PATH)
            if token:
                _write_token(path, token)
                return token
    token = secrets.token_urlsafe(32)
    _write_token(path, token)
    return token


def read_token(path: Path | None = None) -> str:
    use_default_paths = path is None
    path = TOKEN_PATH if path is None else path
    token = _read_token_file(path)
    if token or not use_default_paths or _path_entry_exists(path):
        return token
    return _read_token_file(LEGACY_TOKEN_PATH)


def chmod_600(path: Path) -> None:
    try:
        path.chmod(0o600)
    except OSError:
        pass


def backup_hermes_config() -> None:
    path = Path.home() / ".hermes" / "config.yaml"
    if not path.is_file():
        return
    backup = path.with_name("config.yaml.yulu-backup")
    tmp = backup.with_suffix(f".{os.getpid()}.tmp")
    shutil.copyfile(path, tmp)
    chmod_600(tmp)
    os.replace(tmp, backup)
    chmod_600(backup)


def _snapshot_hermes_config(path: Path) -> tuple[Path, bool, int | None]:
    """Create a unique same-directory snapshot for one config transaction.

    The snapshot is always mode 0600, including the empty marker used when the
    config did not exist. The original mode is tracked separately so rollback
    can restore both bytes and permissions exactly.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    existed = path.exists()
    original_mode = (path.stat().st_mode & 0o7777) if existed else None
    fd, raw_snapshot = tempfile.mkstemp(
        prefix=f".{path.name}.yulu-transaction-",
        dir=str(path.parent),
    )
    snapshot = Path(raw_snapshot)
    try:
        with os.fdopen(fd, "wb") as destination:
            if existed:
                with path.open("rb") as source:
                    shutil.copyfileobj(source, destination)
            destination.flush()
            os.fsync(destination.fileno())
        snapshot.chmod(0o600)
        return snapshot, existed, original_mode
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        snapshot.unlink(missing_ok=True)
        raise


def _restore_hermes_config(
    path: Path,
    snapshot: Path,
    existed: bool,
    original_mode: int | None,
) -> None:
    """Atomically restore the config state captured for this transaction."""
    if existed:
        os.replace(snapshot, path)
        if original_mode is not None:
            path.chmod(original_mode)
    else:
        path.unlink(missing_ok=True)
        snapshot.unlink(missing_ok=True)


def normalize_agent(agent: str) -> str:
    key = agent.strip().lower().replace("_", "-")
    aliases = {
        "claude-code": "claude",
        "open-cloud": "openclaw",
        "openclaw": "openclaw",
        "codex": "codex",
        "claude": "claude",
        "hermes": "hermes",
    }
    if key not in aliases:
        raise ValueError(f"unknown agent: {agent} (valid: {', '.join(AGENTS)})")
    return aliases[key]


def wanted_agents(args: argparse.Namespace) -> list[str]:
    raw = args.agents or list(AGENTS)
    agents = []
    for item in raw:
        agent = normalize_agent(item)
        if agent not in agents:
            agents.append(agent)
    if getattr(args, "detected_only", False):
        agents = [agent for agent in agents if detected(agent)]
    return agents


def detected(agent: str) -> bool:
    if agent in {"codex", "claude"}:
        return resolve_executable(agent) is not None
    if agent == "hermes":
        return resolve_executable("hermes") is not None or (Path.home() / ".hermes" / "config.yaml").exists()
    if agent == "openclaw":
        return resolve_executable("openclaw") is not None or (Path.home() / ".openclaw" / "openclaw.json").exists()
    return False


def run(
    argv: list[str],
    *,
    non_fatal: bool,
    input_text: str | None = None,
    quiet: bool = False,
) -> bool:
    executable = resolve_executable(argv[0])
    if executable is None:
        print(f"skip: {argv[0]} not found")
        return non_fatal
    proc = subprocess.run(
        [executable, *argv[1:]],
        text=True,
        input=input_text,
        stdout=subprocess.DEVNULL if quiet else None,
        stderr=subprocess.DEVNULL if quiet else None,
    )
    if proc.returncode == 0:
        return True
    print(f"warn: {' '.join(argv[:4])} failed with {proc.returncode}", file=sys.stderr)
    return non_fatal


def set_launchctl_env(token: str) -> None:
    launchctl = resolve_executable("launchctl")
    if launchctl is None:
        return
    subprocess.run([launchctl, "setenv", ENV_NAME, token], text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def recording_phase_endpoint(endpoint: str, phase: str) -> str:
    if phase not in {"artifact", "delivery"}:
        raise ValueError(f"unknown recording phase: {phase}")
    return f"{endpoint.rstrip('/')}/recording-{phase}"


def install_agent(agent: str, token: str, endpoint: str, *, non_fatal: bool) -> bool:
    if agent == "codex":
        set_launchctl_env(token)
        run(["codex", "mcp", "remove", "yulu"], non_fatal=True)
        return run(["codex", "mcp", "add", "yulu", "--url", endpoint, "--bearer-token-env-var", ENV_NAME], non_fatal=non_fatal)
    if agent == "claude":
        run(["claude", "mcp", "remove", "yulu", "--scope", "user"], non_fatal=True)
        return run(["claude", "mcp", "add", "--scope", "user", "--transport", "http", "yulu", endpoint, "--header", f"Authorization: Bearer {token}"], non_fatal=non_fatal)
    if agent == "openclaw":
        payload = json.dumps({"url": endpoint, "transport": "streamable-http", "headers": {"Authorization": f"Bearer {token}"}}, separators=(",", ":"))
        if resolve_executable("openclaw"):
            return run(["openclaw", "mcp", "set", "yulu", payload], non_fatal=non_fatal)
        write_openclaw_config(payload)
        return True
    if agent == "hermes":
        return write_hermes_config(endpoint, token, non_fatal=non_fatal)
    raise ValueError(agent)


def remove_agent(agent: str, *, non_fatal: bool) -> bool:
    if agent == "codex":
        return run(["codex", "mcp", "remove", "yulu"], non_fatal=non_fatal)
    if agent == "claude":
        return run(["claude", "mcp", "remove", "yulu", "--scope", "user"], non_fatal=non_fatal)
    if agent == "openclaw":
        if resolve_executable("openclaw"):
            return run(["openclaw", "mcp", "unset", "yulu"], non_fatal=non_fatal)
        unset_openclaw_config()
        return True
    if agent == "hermes":
        return unset_hermes_config(non_fatal=non_fatal)
    raise ValueError(agent)


def write_openclaw_config(payload_json: str) -> None:
    path = Path.home() / ".openclaw" / "openclaw.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    data.setdefault("mcp", {}).setdefault("servers", {})["yulu"] = json.loads(payload_json)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    chmod_600(path)


def unset_openclaw_config() -> None:
    path = Path.home() / ".openclaw" / "openclaw.json"
    if not path.exists():
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    servers = data.get("mcp", {}).get("servers", {})
    if isinstance(servers, dict):
        servers.pop("yulu", None)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    chmod_600(path)


def write_hermes_config(endpoint: str, token: str, *, non_fatal: bool) -> bool:
    """Register Yulu without parsing or rewriting Hermes-owned YAML.

    ``hermes mcp add`` is intentionally interactive (auth, connection probe,
    and tool selection), so it is not suitable for a package postinstall.
    Hermes' own ``config set`` command preserves unrelated config and writes
    atomically. Remove the previous Yulu entry first so stale stdio/tool-filter
    fields cannot survive a transport change.
    """
    if resolve_executable("hermes") is None:
        print("skip: hermes not found")
        return non_fatal

    config_path = Path.home() / ".hermes" / "config.yaml"
    try:
        snapshot, existed, original_mode = _snapshot_hermes_config(config_path)
    except OSError as exc:
        print(f"warn: could not snapshot Hermes config: {exc}", file=sys.stderr)
        return False

    committed = False
    values = []
    for name, url in (
        ("yulu", endpoint),
        ("yulu_artifact", recording_phase_endpoint(endpoint, "artifact")),
        ("yulu_delivery", recording_phase_endpoint(endpoint, "delivery")),
    ):
        values.extend((
            (f"mcp_servers.{name}.url", url),
            (f"mcp_servers.{name}.headers.Authorization", f"Bearer {token}"),
            (f"mcp_servers.{name}.enabled", "true"),
            (f"mcp_servers.{name}.timeout", "120"),
            (f"mcp_servers.{name}.connect_timeout", "20"),
        ))
    try:
        # Keep the fixed audit backup for operator inspection, but rollback
        # below always uses this invocation's unique transaction snapshot.
        backup_hermes_config()
        for name in ("yulu", "yulu_pipeline", "yulu_artifact", "yulu_delivery"):
            if not run(
                ["hermes", "mcp", "remove", name],
                non_fatal=False,
                input_text="y\n",
                quiet=True,
            ):
                return False
        for key, value in values:
            if not run(
                ["hermes", "config", "set", key, value],
                non_fatal=False,
                quiet=True,
            ):
                return False
        chmod_600(config_path)
        committed = True
        return True
    finally:
        if committed:
            snapshot.unlink(missing_ok=True)
        else:
            _restore_hermes_config(config_path, snapshot, existed, original_mode)


def unset_hermes_config(*, non_fatal: bool) -> bool:
    if resolve_executable("hermes") is None:
        print("skip: hermes not found")
        return non_fatal
    backup_hermes_config()
    ok = True
    for name in ("yulu", "yulu_pipeline", "yulu_artifact", "yulu_delivery"):
        ok = run(
            ["hermes", "mcp", "remove", name],
            non_fatal=non_fatal,
            input_text="y\n",
            quiet=True,
        ) and ok
    chmod_600(Path.home() / ".hermes" / "config.yaml")
    return ok


def cmd_install(args: argparse.Namespace) -> int:
    token = ensure_token(rotate=False)
    agents = wanted_agents(args)
    if not agents:
        print("No requested agents detected; MCP registration skipped.")
        return 0
    ok = True
    for agent in agents:
        print(f"Installing Yulu MCP for {agent}...")
        ok = install_agent(agent, token, args.endpoint, non_fatal=args.non_fatal) and ok
    return 0 if ok or args.non_fatal else 1


def cmd_remove(args: argparse.Namespace) -> int:
    agents = wanted_agents(args)
    if not agents:
        print("No requested agents detected; MCP cleanup skipped.")
        return 0
    ok = True
    for agent in agents:
        print(f"Removing Yulu MCP from {agent}...")
        ok = remove_agent(agent, non_fatal=args.non_fatal) and ok
    return 0 if ok or args.non_fatal else 1


def cmd_rotate(args: argparse.Namespace) -> int:
    ensure_token(rotate=True)
    print("MCP token rotated.")
    return cmd_install(args)


def cmd_status(args: argparse.Namespace) -> int:
    print(json.dumps({
        "endpoint": args.endpoint,
        "tokenPresent": bool(read_token()),
        "agents": {agent: {"detected": detected(agent), "configured": configured(agent)} for agent in AGENTS},
    }, indent=2))
    return 0


def configured(agent: str) -> Optional[bool]:
    if agent == "codex":
        path = Path.home() / ".codex" / "config.toml"
        return path.exists() and "[mcp_servers.yulu]" in path.read_text(encoding="utf-8", errors="ignore")
    if agent == "openclaw":
        path = Path.home() / ".openclaw" / "openclaw.json"
        try:
            return "yulu" in json.loads(path.read_text(encoding="utf-8")).get("mcp", {}).get("servers", {})
        except Exception:
            return False
    if agent == "hermes":
        path = Path.home() / ".hermes" / "config.yaml"
        text = "\n" + path.read_text(encoding="utf-8", errors="ignore") if path.exists() else ""
        return (
            "\n  yulu:" in text
            and "\n  yulu_artifact:" in text
            and "\n  yulu_delivery:" in text
        )
    return None


def cmd_test(args: argparse.Namespace) -> int:
    token = read_token()
    if not token:
        print("token missing", file=sys.stderr)
        return 1
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "yulu-mcp-test", "version": "1.0"}},
    }).encode("utf-8")
    req = urllib.request.Request(
        args.endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            print(f"ok: HTTP {resp.status}")
            return 0
    except urllib.error.HTTPError as exc:
        print(f"failed: HTTP {exc.code}", file=sys.stderr)
    except Exception:
        print("failed: request error", file=sys.stderr)
    return 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="yulu mcp")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("install", "remove"):
        sp = sub.add_parser(name)
        common_args(sp)
    rotate = sub.add_parser("rotate-token")
    common_args(rotate)
    status = sub.add_parser("status")
    status.add_argument("--endpoint", default=ENDPOINT)
    test = sub.add_parser("test")
    test.add_argument("--endpoint", default=ENDPOINT)
    return p


def common_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--agent", action="append", dest="agents", help="target agent; repeatable")
    p.add_argument("--detected-only", action="store_true", help="skip agents not detected on this machine")
    p.add_argument("--non-fatal", action="store_true", help="return success after registration warnings")
    p.add_argument("--endpoint", default=ENDPOINT)


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        if args.cmd == "install":
            return cmd_install(args)
        if args.cmd == "remove":
            return cmd_remove(args)
        if args.cmd == "rotate-token":
            return cmd_rotate(args)
        if args.cmd == "status":
            return cmd_status(args)
        if args.cmd == "test":
            return cmd_test(args)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
