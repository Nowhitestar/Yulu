import os
import shutil
import socket
import tempfile
from pathlib import Path

import pytest


MAX_UNIX_SOCKET_PATH = 100


def socket_base_dir() -> Path:
    base = Path(os.environ.get("YULU_TEST_SOCKET_DIR") or "/private/tmp/yulu-test-sockets")
    base.mkdir(parents=True, exist_ok=True)
    return base


def short_socket_dir(*, require_bind: bool = True) -> Path:
    path = Path(tempfile.mkdtemp(prefix="ys", dir=str(socket_base_dir())))
    if len(str(path / "s.sock")) > MAX_UNIX_SOCKET_PATH:
        shutil.rmtree(path, ignore_errors=True)
        raise RuntimeError(f"test socket path is too long under {path}")
    if require_bind and not can_bind_unix_socket(path / ".probe.sock"):
        shutil.rmtree(path, ignore_errors=True)
        pytest.skip("AF_UNIX socket bind is not permitted in this sandbox")
    return path


def short_socket_path(name: str = "s.sock", *, require_bind: bool = True) -> Path:
    path = short_socket_dir(require_bind=require_bind) / name
    if len(str(path)) > MAX_UNIX_SOCKET_PATH:
        raise RuntimeError(f"test socket path is too long: {path}")
    if require_bind and not can_bind_unix_socket(path):
        cleanup_socket_path(path)
        pytest.skip("AF_UNIX socket bind is not permitted in this sandbox")
    return path


def cleanup_socket_path(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass
    try:
        path.parent.rmdir()
    except OSError:
        pass


def can_bind_unix_socket(path: Path | None = None) -> bool:
    probe = path or (socket_base_dir() / ".probe.sock")
    try:
        probe.parent.mkdir(parents=True, exist_ok=True)
        try:
            probe.unlink()
        except OSError:
            pass
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.bind(str(probe))
        return True
    except OSError:
        return False
    finally:
        try:
            probe.unlink()
        except OSError:
            pass
