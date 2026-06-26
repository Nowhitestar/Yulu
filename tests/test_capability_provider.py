"""Wave-0 contract lock for the CapabilityProvider seam (DETECT-05, D-06).

Three things this asserts, all runnable on ANY OS (probes are monkeypatched, never
exec'd here):

1. **ABC conformance** — ``ClaudeCodeProvider`` implements every ``@abstractmethod`` on
   ``CapabilityProvider``; instantiating it raises no ``TypeError``.
2. **agent-config relabel** — the provider reframes its agent's host tools to
   ``Provenance.AGENT_CONFIG`` (probes return ``host-path``; a provider answers "the host
   coding agent provides this"). When the tool is absent, entries degrade to
   ``Provenance.ABSENT`` — never a crash.
3. **Pure addition / Phase 8 readiness** — a throwaway second provider defined INSIDE the
   test instantiates with only ``agent_name`` + ``capabilities()``, proving the ABC carries
   no ClaudeCode-specifics and Codex/OpenClaw subclass it with zero edits to report.py /
   probes.py / doctor.py. ``default_providers()`` is the single registration point.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "yulu" / "scripts"))

from capabilities import provider as provider_mod  # noqa: E402
from capabilities.provider import (  # noqa: E402
    CapabilityProvider,
    ClaudeCodeProvider,
    CodexProvider,
    OpenClawProvider,
    default_providers,
)
from capabilities.report import (  # noqa: E402
    Capability,
    Provenance,
    Status,
)


# ── 1. ABC conformance: ClaudeCodeProvider implements the full contract ──


def test_claude_code_provider_subclasses_the_abc():
    assert issubclass(ClaudeCodeProvider, CapabilityProvider)


def test_claude_code_provider_instantiates_no_typeerror():
    # If any @abstractmethod were unimplemented, abc would raise TypeError here.
    p = ClaudeCodeProvider()
    assert isinstance(p, CapabilityProvider)


def test_abc_cannot_be_instantiated_directly():
    # The seam is abstract — a bare CapabilityProvider() must be rejected by abc.
    import pytest

    with pytest.raises(TypeError):
        CapabilityProvider()  # type: ignore[abstract]


def test_capability_provider_exposes_an_agent_name():
    assert ClaudeCodeProvider().agent_name == "claude-code"


# ── 2. agent-config relabel (the provider's defining responsibility) ──


def test_present_claude_is_relabeled_agent_config(monkeypatch):
    # Probe returns HOST_PATH (that's what probes do); the provider must reframe it.
    usable = Capability(
        Provenance.HOST_PATH, Status.USABLE, "/usr/local/bin/claude", "claude 1.2.3"
    )
    monkeypatch.setattr(provider_mod, "probe_command", lambda *a, **k: usable)

    caps = ClaudeCodeProvider().capabilities()

    assert isinstance(caps, dict)
    assert "claude_cli" in caps
    claude = caps["claude_cli"]
    assert isinstance(claude, Capability)
    # Relabel: provenance flips host-path -> agent-config, but the resolved path/detail survive.
    assert claude.provenance is Provenance.AGENT_CONFIG
    assert claude.status is Status.USABLE
    assert claude.resolved_path == "/usr/local/bin/claude"
    assert claude.detail == "claude 1.2.3"


def test_all_contributed_values_are_capabilities(monkeypatch):
    usable = Capability(Provenance.HOST_PATH, Status.USABLE, "/x/claude", "v1")
    monkeypatch.setattr(provider_mod, "probe_command", lambda *a, **k: usable)
    monkeypatch.setattr(
        provider_mod,
        "probe_mlx_whisper",
        lambda *a, **k: Capability(Provenance.HOST_PATH, Status.USABLE, "/py", "mlx_whisper 1"),
    )

    caps = ClaudeCodeProvider().capabilities()

    assert caps  # contributes >1 real entry
    assert all(isinstance(c, Capability) for c in caps.values())


def test_absent_claude_degrades_not_crashes(monkeypatch):
    # claude not on the login PATH -> probe returns absent; provider must not crash and
    # must surface an ABSENT-provenance entry (no fake agent-config for a missing tool).
    monkeypatch.setattr(
        provider_mod, "probe_command", lambda *a, **k: provider_mod.report.absent("claude not on login PATH")
    )
    monkeypatch.setattr(
        provider_mod,
        "probe_mlx_whisper",
        lambda *a, **k: provider_mod.report.absent("mlx_whisper missing"),
    )

    caps = ClaudeCodeProvider().capabilities()

    assert "claude_cli" in caps
    assert caps["claude_cli"].provenance is Provenance.ABSENT
    assert caps["claude_cli"].status is Status.ABSENT


def test_capabilities_never_raises_on_real_probes():
    # No monkeypatch: runs the real (subprocess-backed) probes. Whether or not `claude`
    # is installed on this machine, capabilities() must return a dict and never raise.
    caps = ClaudeCodeProvider().capabilities()
    assert isinstance(caps, dict)
    for c in caps.values():
        assert isinstance(c, Capability)
        # present tools are agent-config; missing tools are absent — never a stray host-path.
        assert c.provenance in (Provenance.AGENT_CONFIG, Provenance.ABSENT)


# ── 3. Pure addition / Phase 8 readiness ──


def test_second_provider_is_pure_addition():
    # A throwaway provider needing ONLY agent_name + capabilities() proves the ABC has no
    # ClaudeCode-specifics: Phase 8's Codex/OpenClaw arms are a drop-in subclass.
    class _StubProvider(CapabilityProvider):
        agent_name = "stub"

        def capabilities(self):
            return {}

    stub = _StubProvider()  # must NOT raise — every abstractmethod satisfied
    assert isinstance(stub, CapabilityProvider)
    assert stub.agent_name == "stub"
    assert stub.capabilities() == {}


def test_default_providers_includes_claude_code():
    providers = default_providers()
    assert isinstance(providers, list)
    assert any(isinstance(p, ClaudeCodeProvider) for p in providers)
    # Every registered entry is a provider (so doctor can iterate uniformly in Plan 03).
    assert all(isinstance(p, CapabilityProvider) for p in providers)


def test_default_providers_cover_v1_agent_targets():
    providers = default_providers()
    names = {p.agent_name for p in providers}
    assert {"claude-code", "codex", "openclaw"} <= names
    assert any(isinstance(p, CodexProvider) for p in providers)
    assert any(isinstance(p, OpenClawProvider) for p in providers)


def test_codex_and_openclaw_providers_relabel_without_key_collision(monkeypatch):
    def fake_probe_command(name, *args, **kwargs):
        return Capability(Provenance.HOST_PATH, Status.USABLE, f"/usr/local/bin/{name}", f"{name} 1.2.3")

    monkeypatch.setattr(provider_mod, "probe_command", fake_probe_command)
    monkeypatch.setattr(
        provider_mod,
        "probe_mlx_whisper",
        lambda *a, **k: Capability(Provenance.HOST_PATH, Status.USABLE, "/py", "mlx_whisper 1"),
    )

    codex_caps = CodexProvider().capabilities()
    openclaw_caps = OpenClawProvider().capabilities()

    assert codex_caps["codex_cli"].provenance is Provenance.AGENT_CONFIG
    assert codex_caps["codex_cli"].resolved_path == "/usr/local/bin/codex"
    assert codex_caps["codex_mlx_whisper"].provenance is Provenance.AGENT_CONFIG

    assert openclaw_caps["openclaw_cli"].provenance is Provenance.AGENT_CONFIG
    assert openclaw_caps["openclaw_cli"].resolved_path == "/usr/local/bin/openclaw"
    assert openclaw_caps["openclaw_mlx_whisper"].provenance is Provenance.AGENT_CONFIG

    combined_keys = set(codex_caps) | set(openclaw_caps)
    assert {"codex_mlx_whisper", "openclaw_mlx_whisper"} <= combined_keys
    assert "agent_mlx_whisper" not in combined_keys


def test_codex_provider_absent_cli_degrades_not_crashes(monkeypatch):
    monkeypatch.setattr(provider_mod, "probe_command", lambda *a, **k: provider_mod.report.absent("codex missing"))
    monkeypatch.setattr(
        provider_mod,
        "probe_mlx_whisper",
        lambda *a, **k: provider_mod.report.absent("mlx_whisper missing"),
    )

    caps = CodexProvider().capabilities()

    assert caps["codex_cli"].provenance is Provenance.ABSENT
    assert caps["codex_cli"].status is Status.ABSENT
    assert caps["codex_mlx_whisper"].provenance is Provenance.ABSENT
