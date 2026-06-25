"""Linux platform arm — Phase 1 ships signatures only; impls deferred to v2 (XPLAT-01).

Each concrete subclass overrides EVERY abstract method to raise
``NotImplementedError``. Because all abstract methods are overridden, these
classes ARE instantiable (only the bare ABC raises ``TypeError``) — construction
succeeds, but every call fails loud. That asymmetry is what the stub tests assert.
"""

from __future__ import annotations

from yulu_platform.base import (
    AudioCaptureController,
    DaemonManager,
    DependencyManager,
    PathResolver,
    PermissionModel,
    ServiceSpec,
)

_MSG = "Linux {seam} not implemented (v2 XPLAT-01)"


class LinuxDaemonManager(DaemonManager):
    def install(self, spec: ServiceSpec) -> None:
        raise NotImplementedError(_MSG.format(seam="daemon management"))

    def load(self, name: str) -> None:
        raise NotImplementedError(_MSG.format(seam="daemon management"))

    def unload(self, name: str) -> None:
        raise NotImplementedError(_MSG.format(seam="daemon management"))

    def status(self, name: str) -> str:
        raise NotImplementedError(_MSG.format(seam="daemon management"))


class LinuxAudioCaptureController(AudioCaptureController):
    def start(self, payload: dict) -> dict | None:
        raise NotImplementedError(_MSG.format(seam="audio capture"))

    def stop(self) -> dict | None:
        raise NotImplementedError(_MSG.format(seam="audio capture"))

    def status(self) -> dict | None:
        raise NotImplementedError(_MSG.format(seam="audio capture"))

    def windows(self) -> dict | None:
        raise NotImplementedError(_MSG.format(seam="audio capture"))


class LinuxPathResolver(PathResolver):
    def config_dir(self) -> "Path":
        raise NotImplementedError(_MSG.format(seam="path resolution"))

    def data_dir(self) -> "Path":
        raise NotImplementedError(_MSG.format(seam="path resolution"))

    def runtime_dir(self) -> "Path":
        raise NotImplementedError(_MSG.format(seam="path resolution"))


class LinuxPermissionModel(PermissionModel):
    def check(self, capability: str) -> str:
        raise NotImplementedError(_MSG.format(seam="permission model"))


class LinuxDependencyManager(DependencyManager):
    def is_available(self, name: str) -> bool:
        raise NotImplementedError(_MSG.format(seam="dependency management"))

    def install(self, name: str) -> None:
        raise NotImplementedError(_MSG.format(seam="dependency management"))
