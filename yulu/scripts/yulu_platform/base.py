"""Platform-seam abstract interfaces — Phase 1 ships signatures only (D-15..D-18).

These ABCs define the cross-platform seam every macOS-coupled subsystem will be
re-architected behind. Phase 1 declares the *interfaces* only: abstract method
signatures plus the platform-neutral ``ServiceSpec`` value object. No working
implementation ships this phase (D-15). The macOS arm is Phase 2 (D-17); the
``linux``/``windows`` arms raise ``NotImplementedError`` until v2 (XPLAT-01).

D-18 is a hard constraint on every signature here: the method contracts carry NO
leaked macOS vocabulary — no launchd property-list keys, no capture-config struct
names, no consent-database scope strings. A reviewer must be able to imagine a
systemd / Linux arm implementing the exact same methods. This is a Python-only
package (D-17): the Swift capture-backend seam is NOT here.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ServiceSpec:
    """Platform-neutral daemon description (NO launchd keys — D-18).

    Describes a long-running service in OS-agnostic terms. A ``DaemonManager``
    arm translates this into its platform's native form (a launchd property list
    on macOS, a systemd unit on Linux, …) — but the spec itself names none of them.
    """

    name: str
    program: list[str]
    keep_alive: bool = True
    working_dir: Path | None = None
    environment: dict[str, str] | None = None


class DaemonManager(ABC):
    """Install and supervise platform services (PLAT-03).

    The seam that replaces direct launchd/service-manager manipulation. ``status``
    returns a platform-neutral string, not an OS-specific code.
    """

    @abstractmethod
    def install(self, spec: ServiceSpec) -> None: ...

    @abstractmethod
    def load(self, name: str) -> None: ...

    @abstractmethod
    def unload(self, name: str) -> None: ...

    @abstractmethod
    def status(self, name: str) -> str: ...


class PathResolver(ABC):
    """Resolve platform-appropriate base directories (PLAT-04).

    Replaces hardcoded paths such as ``~/Movies/Yulu`` and ``~/.config/yulu``
    with a seam each OS arm fills with its own conventions.
    """

    @abstractmethod
    def config_dir(self) -> Path: ...

    @abstractmethod
    def data_dir(self) -> Path: ...

    @abstractmethod
    def runtime_dir(self) -> Path: ...


class PermissionModel(ABC):
    """Query OS capability/permission state (no TCC vocabulary — D-18).

    ``capability`` is an abstract token (e.g. ``"microphone"``), never a TCC
    scope string; the return is a platform-neutral status.
    """

    @abstractmethod
    def check(self, capability: str) -> str: ...


class DependencyManager(ABC):
    """Detect and provision external dependencies (PLAT-05).

    The seam over Homebrew (macOS) / apt / … — named only by the dependency, not
    by any package manager.
    """

    @abstractmethod
    def is_available(self, name: str) -> bool: ...

    @abstractmethod
    def install(self, name: str) -> None: ...
