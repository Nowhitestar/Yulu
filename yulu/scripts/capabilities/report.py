"""HostCapabilityReport schema — the versioned, tri-state, provenance-labeled contract
every downstream consumer binds to (DETECT-01, D-01/D-08).

The report is a ``schema_version``-stamped dataclass. Each capability entry carries:

- ``provenance`` — WHERE the capability comes from: ``host-path`` (found on the host the
  daemon runs as), ``yulu-managed`` (provisioned/owned by Yulu), ``agent-config`` (configured
  by the host coding agent, e.g. its llm.command), or ``absent``.
- ``status`` — a TRI-STATE (``usable`` | ``present-but-unverified`` | ``absent``), **never a
  boolean**. A boolean must never drive a "skip install" decision (D-08); Phase 5 reuse gates
  on the three distinct states.
- ``resolved_path`` — the concrete path when known, ``""`` when absent.
- ``detail`` — free-form (a version string, or a short error first-line).

``to_dict()`` coerces both enums to their *string* values so the doctor ``--json`` output and
the Phase 4 tRPC payload read human strings, never enum reprs — and never a Python bool for
``status``. stdlib only; Phase 7 stamps ``schema_version``, Phase 4/5/8 read it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Provenance(str, Enum):
    """Where a capability comes from (D-01)."""

    HOST_PATH = "host-path"
    YULU_MANAGED = "yulu-managed"
    AGENT_CONFIG = "agent-config"
    ABSENT = "absent"


class Status(str, Enum):
    """Tri-state usability (D-01/D-08) — NEVER a boolean.

    ``usable``                 — verified the consumer (daemon) can actually use it.
    ``present-but-unverified`` — found, but full usability not confirmed.
    ``absent``                 — not present.
    """

    USABLE = "usable"
    PRESENT_BUT_UNVERIFIED = "present-but-unverified"
    ABSENT = "absent"


@dataclass
class Capability:
    """One detected capability — provenance + tri-state status + path + detail.

    The tri-state field is a :class:`Status` enum member (one of three string values),
    never a true/false flag: a missing tool is
    ``Capability(Provenance.ABSENT, Status.ABSENT, "", detail)`` (see :func:`absent`).
    """

    provenance: Provenance
    status: Status
    resolved_path: str = ""
    detail: str = ""


@dataclass
class HostCapabilityReport:
    """Versioned snapshot of what the daemon can use.

    ``schema_version`` is present on every serialized report (start at 1). ``capabilities``
    maps a capability name (``claude``, ``whisper-cli``, ``mlx-whisper``, ``llm.command``,
    ``models``, ``recording-dir``, …) to its :class:`Capability`.
    """

    schema_version: int = 1
    capabilities: dict[str, Capability] = field(default_factory=dict)

    def to_dict(self) -> dict:
        """JSON-safe dict: ``{schema_version, capabilities: {name: {...}}}``.

        Both enums are coerced to their ``.value`` strings here so ``json.dumps`` emits
        human-readable strings for the tri-state field (and never a true/false flag).
        """
        return {
            "schema_version": self.schema_version,
            "capabilities": {
                name: {
                    "provenance": cap.provenance.value,
                    "status": cap.status.value,
                    "resolved_path": cap.resolved_path,
                    "detail": cap.detail,
                }
                for name, cap in self.capabilities.items()
            },
        }


def absent(detail: str = "") -> Capability:
    """The common missing-tool entry: absent provenance + absent status + no path."""
    return Capability(Provenance.ABSENT, Status.ABSENT, "", detail)


__all__ = [
    "Provenance",
    "Status",
    "Capability",
    "HostCapabilityReport",
    "absent",
]
