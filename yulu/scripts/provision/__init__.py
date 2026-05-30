"""Provision package — the named, idempotent step registry (PROV-01, D-06).

Wraps the six Phase-1 ``setup_*.sh`` concern scripts 1:1 behind a Python
``check()`` / ``apply()`` / ``StepResult`` contract (it does NOT port their bash
logic). The state ledger (``state.py``, 06-02), the attestation gate
(``attest.py``, 06-03), and the CLI (``cli.py``, 06-04) are sibling modules that
compose against the names exported here.
"""

from . import attest, skill, state
from .registry import REGISTRY, ScriptStep, Step, StepResult, step_by_name

__all__ = [
    "Step",
    "StepResult",
    "ScriptStep",
    "REGISTRY",
    "step_by_name",
    "state",
    "attest",
    "skill",
]
