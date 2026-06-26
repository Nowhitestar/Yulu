"""Capabilities package — the versioned HostCapabilityReport schema, honest probes, and
the CapabilityProvider seam (Phase 8 generalizes the provider to Codex/OpenClaw)."""

from .report import HostCapabilityReport, Capability, Provenance, Status
from .provider import CapabilityProvider, ClaudeCodeProvider, CodexProvider, OpenClawProvider, default_providers

__all__ = [
    "HostCapabilityReport",
    "Capability",
    "Provenance",
    "Status",
    "CapabilityProvider",
    "ClaudeCodeProvider",
    "CodexProvider",
    "OpenClawProvider",
    "default_providers",
]
