"""Capabilities package — the versioned HostCapabilityReport schema + honest probes."""

from .report import HostCapabilityReport, Capability, Provenance, Status

__all__ = ["HostCapabilityReport", "Capability", "Provenance", "Status"]
