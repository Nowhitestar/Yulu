"""Search content-root registry.

The registry defaults to the existing Yulu data dir only. External roots are a
future explicit opt-in; runtime/state roots are rejected so SQLite DBs, sockets,
and caches cannot become searchable corpus content.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional


DEFAULT_ROOT_ID = "yulu-data-dir"


@dataclass(frozen=True)
class SearchRoot:
    id: str
    path: str
    read_only: bool
    source: str

    def as_path(self) -> Path:
        return Path(self.path).expanduser()

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class SearchRootRegistry:
    roots: tuple[SearchRoot, ...]
    rejected_roots: tuple[dict, ...]

    def paths(self) -> list[Path]:
        return [root.as_path() for root in self.roots]

    def to_dict(self) -> dict:
        return {
            "schema_version": 1,
            "roots": [root.to_dict() for root in self.roots],
            "rejected_roots": list(self.rejected_roots),
        }


def _resolve_data_dir() -> Path:
    try:
        from yulu_platform.macos.path_resolver import MacOSPathResolver

        return MacOSPathResolver().data_dir()
    except Exception:
        return Path.home() / "Movies" / "Yulu"


def _resolve_runtime_dir() -> Path:
    try:
        from yulu_platform.macos.path_resolver import MacOSPathResolver

        return MacOSPathResolver().runtime_dir()
    except Exception:
        return Path.home() / ".config" / "yulu"


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _resolved(path: Path) -> Path:
    return Path(path).expanduser().resolve(strict=False)


def is_runtime_content_root(path: Path, runtime_dir: Optional[Path] = None) -> bool:
    candidate = _resolved(path)
    runtime = _resolved(runtime_dir or _resolve_runtime_dir())
    return (
        candidate == runtime
        or _is_relative_to(candidate, runtime)
        or _is_relative_to(runtime, candidate)
    )


def build_registry(
    *,
    fallback_root: Optional[Path] = None,
    runtime_dir: Optional[Path] = None,
) -> SearchRootRegistry:
    root_path = (
        Path(fallback_root).expanduser()
        if fallback_root is not None
        else _resolve_data_dir()
    )
    if is_runtime_content_root(root_path, runtime_dir=runtime_dir):
        return SearchRootRegistry(
            roots=(),
            rejected_roots=(
                {
                    "id": DEFAULT_ROOT_ID,
                    "path": str(root_path),
                    "reason": "runtime roots are not searchable content roots",
                },
            ),
        )

    return SearchRootRegistry(
        roots=(
            SearchRoot(
                id=DEFAULT_ROOT_ID,
                path=str(root_path),
                read_only=True,
                source="default-data-dir",
            ),
        ),
        rejected_roots=(),
    )


def content_roots(
    *,
    fallback_root: Optional[Path] = None,
    runtime_dir: Optional[Path] = None,
) -> list[Path]:
    return build_registry(fallback_root=fallback_root, runtime_dir=runtime_dir).paths()


def root_registry_report(
    *,
    fallback_root: Optional[Path] = None,
    runtime_dir: Optional[Path] = None,
) -> dict:
    return build_registry(fallback_root=fallback_root, runtime_dir=runtime_dir).to_dict()
