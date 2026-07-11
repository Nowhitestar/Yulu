"""Multi-Agent CapabilityProvider contracts without STT introspection."""

import importlib.util
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from capabilities import provider as provider_mod  # noqa: E402
from capabilities.provider import (  # noqa: E402
    CapabilityProvider,
    HermesProvider,
    ClaudeCodeProvider,
    CodexProvider,
    OpenClawProvider,
    default_providers,
)
from capabilities.report import Capability, Provenance, Status  # noqa: E402


PROVIDERS = [
    (HermesProvider, "hermes", "hermes", "hermes_cli"),
    (ClaudeCodeProvider, "claude-code", "claude", "claude_cli"),
    (CodexProvider, "codex", "codex", "codex_cli"),
    (OpenClawProvider, "openclaw", "openclaw", "openclaw_cli"),
]


@pytest.mark.parametrize("provider_cls,agent_name,binary,key", PROVIDERS)
def test_provider_is_drop_in_agent_cli_source(provider_cls, agent_name, binary, key, monkeypatch):
    monkeypatch.setattr(
        provider_mod,
        "probe_command",
        lambda name, *a, **k: Capability(
            Provenance.HOST_PATH,
            Status.USABLE,
            f"/usr/local/bin/{name}",
            f"{name} 1.0",
        ),
    )

    provider = provider_cls()
    caps = provider.capabilities()

    assert isinstance(provider, CapabilityProvider)
    assert provider.agent_name == agent_name
    assert set(caps) == {key}
    assert caps[key].provenance is Provenance.AGENT_CONFIG
    assert caps[key].resolved_path == f"/usr/local/bin/{binary}"


@pytest.mark.parametrize("provider_cls,agent_name,binary,key", PROVIDERS)
def test_missing_cli_degrades_to_absent(provider_cls, agent_name, binary, key, monkeypatch):
    monkeypatch.setattr(
        provider_mod,
        "probe_command",
        lambda *a, **k: provider_mod.report.absent(f"{binary} missing"),
    )
    cap = provider_cls().capabilities()[key]
    assert cap.provenance is Provenance.ABSENT
    assert cap.status is Status.ABSENT


def test_default_provider_registration_is_stable():
    providers = default_providers()
    assert [provider.agent_name for provider in providers] == ["hermes", "claude-code", "codex", "openclaw"]


def test_doctor_folds_all_registered_agent_cli_entries(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("doctor_multi_agent", SCRIPTS / "doctor.py")
    doctor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(doctor)
    monkeypatch.setattr(
        provider_mod,
        "probe_command",
        lambda name, *a, **k: Capability(Provenance.HOST_PATH, Status.USABLE, f"/bin/{name}", "1"),
    )

    report = doctor._host_capabilities(tmp_path, tmp_path)

    assert {"hermes_cli", "claude_cli", "codex_cli", "openclaw_cli"} <= set(report["capabilities"])
