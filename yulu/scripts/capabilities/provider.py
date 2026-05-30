"""The CapabilityProvider seam — how a host coding agent contributes capabilities (DETECT-05).

A **provider** answers one question for the report: *what has the host coding agent already
configured that Yulu can reuse?* The probes in :mod:`capabilities.probes` answer the lower
question "is this tool on the host the daemon runs as?" and return ``host-path`` provenance.
A provider takes those host findings and **reframes them to ``agent-config`` provenance** —
"the host coding agent provides this" — so the Phase 4 settings UI can label an entry
"reused from your agent" rather than "Yulu-managed". That relabel is the provider's whole
job; it adds NO new resolution or execution surface (it delegates to Plan 01's probes).

The seam is an ABC with a single abstract method (:meth:`CapabilityProvider.capabilities`)
and a plain ``agent_name`` attribute. The contract carries **no** vocabulary for any specific
agent, by design (D-06): Phase 8's Codex/OpenClaw arms are *pure addition* — a new subclass
plus one entry in :func:`default_providers`, with zero edits to ``report.py``, ``probes.py``,
or ``doctor.py``. :class:`ClaudeCodeProvider` is the reference implementation proving the
contract end-to-end against one real agent today. stdlib only (``abc`` + the Plan-01 imports).
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from . import report
from .probes import probe_command, probe_mlx_whisper
from .report import Capability, Provenance, Status


class CapabilityProvider(ABC):
    """A host-agent capability source — the seam every agent arm implements.

    Subclasses set :attr:`agent_name` to a short stable identifier and implement
    :meth:`capabilities`, returning the entries that source contributes, keyed by a
    capability name. The contract names no specific source, so adding another one is a
    drop-in subclass — the single design constraint of this seam.
    """

    #: Short, stable identifier for the source (set by each subclass). Kept a plain class
    #: attribute — neutral by contract; concrete subclasses fill it in.
    agent_name: str = ""

    @abstractmethod
    def capabilities(self) -> dict[str, Capability]:
        """Return this source's contributed capabilities, keyed by capability name.

        Implementations DELEGATE detection to :mod:`capabilities.probes` (no new resolution
        or execution surface) and reframe present host findings to ``agent-config``
        provenance. Must never raise — a missing tool is an ``absent`` entry, not an
        exception (mirroring the probes' and doctor's never-raise contract).
        """
        ...


def _as_agent_config(cap: Capability) -> Capability:
    """Reframe a host-found capability to ``agent-config`` provenance, preserving the rest.

    The probes hand back ``host-path`` provenance ("found on the host"); a provider answers
    "the host coding agent provides this", so present/usable entries are copied with
    ``provenance`` swapped to :attr:`Provenance.AGENT_CONFIG` while ``resolved_path`` and
    ``detail`` survive untouched. An ``absent`` finding is returned as-is — a missing tool is
    never dressed up as an agent-configured one.
    """
    if cap.provenance is Provenance.ABSENT or cap.status is Status.ABSENT:
        return cap
    return Capability(Provenance.AGENT_CONFIG, cap.status, cap.resolved_path, cap.detail)


class ClaudeCodeProvider(CapabilityProvider):
    """Reference provider for the Claude Code host agent.

    Contributes what *this* host agent has configured, by delegating to Plan 01's probes and
    reframing the host findings to ``agent-config`` provenance:

    - ``claude_cli`` — the host ``claude`` CLI resolved via the login-shell PATH
      (:func:`probe_command`). Present → an ``agent-config`` entry carrying the resolved path
      and ``--version`` detail; absent → ``report.absent("claude not on login PATH")``.
    - ``agent_mlx_whisper`` — the mlx-whisper the agent's interpreter can import
      (:func:`probe_mlx_whisper`), reframed to ``agent-config`` when present.

    The provider only relabels provenance; it issues no new subprocess of its own (T-03-05).
    """

    agent_name = "claude-code"

    def capabilities(self) -> dict[str, Capability]:
        caps: dict[str, Capability] = {}

        # Host `claude` CLI — resolve via the login-shell PATH (Plan 01), reframe to agent-config.
        claude = probe_command("claude", ("--version",))
        if claude.status is Status.ABSENT:
            caps["claude_cli"] = report.absent("claude not on login PATH")
        else:
            caps["claude_cli"] = _as_agent_config(claude)

        # The agent's whisper view — mlx-whisper importability, reframed agent-config when present.
        caps["agent_mlx_whisper"] = _as_agent_config(probe_mlx_whisper())

        return caps


def default_providers() -> list[CapabilityProvider]:
    """The registered providers Yulu queries today — the single Phase-8 extension point.

    Returns ``[ClaudeCodeProvider()]`` now. Adding the host's Codex/OpenClaw arms in Phase 8
    is *pure addition*: append a new subclass instance here, with no edits to ``report.py``,
    ``probes.py``, or ``doctor.py``. Plan 03's doctor wiring iterates this list to fold each
    provider's contributed entries into the ``host_capabilities`` section.
    """
    return [ClaudeCodeProvider()]


__all__ = [
    "CapabilityProvider",
    "ClaudeCodeProvider",
    "default_providers",
]
