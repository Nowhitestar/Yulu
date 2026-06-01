"""Wave 0 scaffold for ROADMAP success criterion 5 (platform ABCs).

Proves two load-bearing properties of the ``yulu_platform`` seam:

  1. The bare ABCs in ``yulu_platform.base`` are uninstantiable — declaring an
     abstract method without an override makes ``SomeABC()`` raise ``TypeError``.
  2. The ``linux``/``windows`` arms override every abstract method but each one
     raises ``NotImplementedError`` (D-15: signatures + raising stubs only, no
     working impl this phase). The arms instantiate fine; only the methods fail.
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "yulu" / "scripts"))


def test_base_is_abstract():
    from yulu_platform.base import DaemonManager

    with pytest.raises(TypeError):  # cannot instantiate an ABC with abstract methods
        DaemonManager()


def test_all_base_abcs_are_abstract():
    from yulu_platform.base import (
        DaemonManager,
        DependencyManager,
        PathResolver,
        PermissionModel,
    )

    for abc_cls in (DaemonManager, PathResolver, PermissionModel, DependencyManager):
        with pytest.raises(TypeError):
            abc_cls()


def test_linux_daemon_manager_is_stub():
    from yulu_platform.linux import LinuxDaemonManager

    with pytest.raises(NotImplementedError):
        LinuxDaemonManager().load("com.yulu.sttdaemon")


def test_linux_path_resolver_is_stub():
    from yulu_platform.linux import LinuxPathResolver

    with pytest.raises(NotImplementedError):
        LinuxPathResolver().config_dir()


def test_linux_permission_model_is_stub():
    from yulu_platform.linux import LinuxPermissionModel

    with pytest.raises(NotImplementedError):
        LinuxPermissionModel().check("microphone")


def test_linux_dependency_manager_is_stub():
    from yulu_platform.linux import LinuxDependencyManager

    with pytest.raises(NotImplementedError):
        LinuxDependencyManager().is_available("ffmpeg")


def test_windows_daemon_manager_is_stub():
    from yulu_platform.windows import WindowsDaemonManager

    with pytest.raises(NotImplementedError):
        WindowsDaemonManager().load("com.yulu.sttdaemon")


def test_service_spec_is_importable_and_frozen():
    from dataclasses import FrozenInstanceError

    from yulu_platform.base import ServiceSpec

    spec = ServiceSpec(name="com.yulu.sttdaemon", program=["python3", "-m", "stt_daemon"])
    assert spec.keep_alive is True
    with pytest.raises(FrozenInstanceError):
        spec.name = "mutated"  # frozen dataclass — assignment must fail
