"""Wave-0 contract lock for the multi-agent providers — Codex + OpenClaw (AGENT-01/02).

This is the FINAL milestone phase and is **pure addition**: Phase 3 designed
``capabilities/provider.py`` so a second/third agent is a drop-in subclass + one
``default_providers()`` entry, with ZERO edits to ``report.py``, ``probes.py``, or
``doctor.py``. These tests prove that design holds for two REAL agents.

Two groups (all runnable on ANY OS — the probes are monkeypatched, never exec'd here):

**Group A — the two new providers** (mirrors ``tests/test_capability_provider.py`` for
each of ``CodexProvider`` and ``OpenClawProvider``): ABC conformance + instantiation,
``agent_name``, a present (mocked) ``probe_command`` relabeled to ``agent-config``/usable
with ``resolved_path`` + ``detail`` preserved, an absent ``probe_command`` degraded to
``absent``/``absent`` without raising, the NAMESPACED mlx-whisper key
(``codex_mlx_whisper`` / ``openclaw_mlx_whisper``), never-raise on the real probes, and
delegation-only (the providers own no subprocess of their own — D-05).

**Group B — three-agent aggregation** (mirrors the doctor load in
``tests/test_doctor_host_capabilities.py``): ``default_providers()`` returns exactly three
providers; ``collect_report()`` folds all three into ``host_capabilities`` with the
``schema_version`` unchanged (still ``1``) and NO key collision — all three distinct
``*_mlx_whisper`` keys and all three ``*_cli`` keys survive the last-writer-wins fold at
``doctor.py:271-272`` (T-08-01). In-process; no live agent install required — the contract
is asserted, not a real CLI.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

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

DOCTOR = ROOT / "yulu" / "scripts" / "doctor.py"


def load_doctor():
    """Load the real doctor.py source via spec_from_file_location (mirrors test_doctor.py)."""
    spec = importlib.util.spec_from_file_location("doctor", DOCTOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Each new provider, parametrized by its class, agent_name, CLI key, and namespaced mlx key.
_PROVIDERS = [
    pytest.param(CodexProvider, "codex", "codex_cli", "codex_mlx_whisper", id="codex"),
    pytest.param(OpenClawProvider, "openclaw", "openclaw_cli", "openclaw_mlx_whisper", id="openclaw"),
]


# ── Group A.1: ABC conformance + agent_name (both new providers) ──


@pytest.mark.parametrize("cls, agent_name, cli_key, mlx_key", _PROVIDERS)
def test_new_provider_subclasses_the_abc(cls, agent_name, cli_key, mlx_key):
    assert issubclass(cls, CapabilityProvider)


@pytest.mark.parametrize("cls, agent_name, cli_key, mlx_key", _PROVIDERS)
def test_new_provider_instantiates_no_typeerror(cls, agent_name, cli_key, mlx_key):
    # If any @abstractmethod were unimplemented, abc would raise TypeError here.
    p = cls()
    assert isinstance(p, CapabilityProvider)


@pytest.mark.parametrize("cls, agent_name, cli_key, mlx_key", _PROVIDERS)
def test_new_provider_exposes_its_agent_name(cls, agent_name, cli_key, mlx_key):
    assert cls().agent_name == agent_name


# ── Group A.2: present → agent-config relabel (the provider's defining responsibility) ──


@pytest.mark.parametrize("cls, agent_name, cli_key, mlx_key", _PROVIDERS)
def test_present_cli_is_relabeled_agent_config(cls, agent_name, cli_key, mlx_key, monkeypatch):
    # Probe returns HOST_PATH (that's what probes do); the provider must reframe it.
    usable = Capability(
        Provenance.HOST_PATH, Status.USABLE, f"/usr/local/bin/{agent_name}", f"{agent_name} 1.2.3"
    )
    monkeypatch.setattr(provider_mod, "probe_command", lambda *a, **k: usable)

    caps = cls().capabilities()

    assert isinstance(caps, dict)
    assert cli_key in caps
    cli = caps[cli_key]
    assert isinstance(cli, Capability)
    # Relabel: provenance flips host-path -> agent-config, but the resolved path/detail survive.
    assert cli.provenance is Provenance.AGENT_CONFIG
    assert cli.status is Status.USABLE
    assert cli.resolved_path == f"/usr/local/bin/{agent_name}"
    assert cli.detail == f"{agent_name} 1.2.3"


@pytest.mark.parametrize("cls, agent_name, cli_key, mlx_key", _PROVIDERS)
def test_present_probe_command_called_with_the_right_binary(cls, agent_name, cli_key, mlx_key, monkeypatch):
    # The provider must probe ITS OWN binary name (codex / openclaw), not claude.
    seen = {}

    def _spy_probe_command(binary, version_args=("--version",)):
        seen["binary"] = binary
        seen["version_args"] = tuple(version_args)
        return Capability(Provenance.HOST_PATH, Status.USABLE, "/x", "v")

    monkeypatch.setattr(provider_mod, "probe_command", _spy_probe_command)

    cls().capabilities()

    assert seen["binary"] == agent_name
    assert seen["version_args"] == ("--version",)


@pytest.mark.parametrize("cls, agent_name, cli_key, mlx_key", _PROVIDERS)
def test_namespaced_mlx_key_and_all_values_are_capabilities(cls, agent_name, cli_key, mlx_key, monkeypatch):
    monkeypatch.setattr(
        provider_mod, "probe_command", lambda *a, **k: Capability(Provenance.HOST_PATH, Status.USABLE, "/x", "v1")
    )
    monkeypatch.setattr(
        provider_mod,
        "probe_mlx_whisper",
        lambda *a, **k: Capability(Provenance.HOST_PATH, Status.USABLE, "/py", "mlx_whisper 1"),
    )

    caps = cls().capabilities()

    # The mlx-whisper key is NAMESPACED by agent_name (NOT the bare `agent_mlx_whisper`),
    # so three providers' entries never collide in the doctor fold (T-08-01).
    assert mlx_key in caps
    assert "agent_mlx_whisper" not in caps, "new providers must NOT emit the bare agent_mlx_whisper key"
    assert caps[mlx_key].provenance is Provenance.AGENT_CONFIG
    assert caps  # contributes >1 real entry
    assert all(isinstance(c, Capability) for c in caps.values())


# ── Group A.3: absent → degrade (never raise) ──


@pytest.mark.parametrize("cls, agent_name, cli_key, mlx_key", _PROVIDERS)
def test_absent_cli_degrades_not_crashes(cls, agent_name, cli_key, mlx_key, monkeypatch):
    # CLI not on the login PATH -> probe returns absent; provider must not crash and must
    # surface an ABSENT-provenance entry (no fake agent-config for a missing tool).
    monkeypatch.setattr(
        provider_mod, "probe_command", lambda *a, **k: provider_mod.report.absent(f"{agent_name} not on login PATH")
    )
    monkeypatch.setattr(
        provider_mod,
        "probe_mlx_whisper",
        lambda *a, **k: provider_mod.report.absent("mlx_whisper missing"),
    )

    caps = cls().capabilities()

    assert cli_key in caps
    assert caps[cli_key].provenance is Provenance.ABSENT
    assert caps[cli_key].status is Status.ABSENT
    # The namespaced mlx key is still present (absent), never collapsed away.
    assert caps[mlx_key].provenance is Provenance.ABSENT


@pytest.mark.parametrize("cls, agent_name, cli_key, mlx_key", _PROVIDERS)
def test_capabilities_never_raises_on_real_probes(cls, agent_name, cli_key, mlx_key):
    # No monkeypatch: runs the real (subprocess-backed) probes. Whether or not the agent CLI
    # is installed on this machine, capabilities() must return a dict and never raise.
    caps = cls().capabilities()
    assert isinstance(caps, dict)
    for c in caps.values():
        assert isinstance(c, Capability)
        # present tools are agent-config; missing tools are absent — never a stray host-path.
        assert c.provenance in (Provenance.AGENT_CONFIG, Provenance.ABSENT)


# ── Group A.4: delegation-only (the providers own NO subprocess of their own — D-05) ──


@pytest.mark.parametrize("cls, agent_name, cli_key, mlx_key", _PROVIDERS)
def test_provider_returns_purely_from_the_two_probes(cls, agent_name, cli_key, mlx_key, monkeypatch):
    # Monkeypatch BOTH probes to constant sentinels and confirm capabilities() is built
    # purely from them — the provider issues no detection of its own (T-08-04 / T-03-05).
    cli_sentinel = Capability(Provenance.HOST_PATH, Status.USABLE, "/sentinel/cli", "cli-sentinel")
    mlx_sentinel = Capability(Provenance.HOST_PATH, Status.USABLE, "/sentinel/py", "mlx-sentinel")
    monkeypatch.setattr(provider_mod, "probe_command", lambda *a, **k: cli_sentinel)
    monkeypatch.setattr(provider_mod, "probe_mlx_whisper", lambda *a, **k: mlx_sentinel)

    caps = cls().capabilities()

    # Both entries trace back to the sentinels (relabeled to agent-config), proving no
    # independent resolution/execution path inside the provider.
    assert caps[cli_key].resolved_path == "/sentinel/cli"
    assert caps[cli_key].detail == "cli-sentinel"
    assert caps[mlx_key].resolved_path == "/sentinel/py"
    assert caps[mlx_key].detail == "mlx-sentinel"
    # Exactly the two delegated entries — no surprise third capability from a hidden probe.
    assert set(caps) == {cli_key, mlx_key}


def test_provider_module_has_no_new_exec_surface():
    """Static guard (T-08-04): provider.py issues no process of its own. The two new providers
    delegate to probe_command / probe_mlx_whisper; the module must not IMPORT or CALL any
    exec primitive (subprocess / os.system / shutil.which / Popen).

    Asserted over the parsed AST (imports + call targets), NOT raw text, so a benign prose
    mention in a docstring (e.g. "issues no new subprocess of its own") is never a false
    positive — only a real import or call trips the gate."""
    import ast

    src = (ROOT / "yulu" / "scripts" / "capabilities" / "provider.py").read_text(encoding="utf-8")
    tree = ast.parse(src)

    forbidden_modules = {"subprocess"}
    forbidden_callables = {"system", "which", "Popen", "run", "call", "check_output", "check_call", "getoutput"}

    def _dotted(node):
        # Reconstruct a dotted attribute chain (e.g. subprocess.run -> "subprocess.run").
        parts = []
        while isinstance(node, ast.Attribute):
            parts.append(node.attr)
            node = node.value
        if isinstance(node, ast.Name):
            parts.append(node.id)
        return ".".join(reversed(parts))

    offenders = []
    for n in ast.walk(tree):
        # No `import subprocess` / `from subprocess import ...`.
        if isinstance(n, ast.Import):
            for alias in n.names:
                if alias.name.split(".")[0] in forbidden_modules:
                    offenders.append(f"import {alias.name}")
        elif isinstance(n, ast.ImportFrom):
            if (n.module or "").split(".")[0] in forbidden_modules:
                offenders.append(f"from {n.module} import ...")
        # No exec-primitive CALL: subprocess.*(), os.system(), shutil.which(), Popen().
        elif isinstance(n, ast.Call):
            dotted = _dotted(n.func)
            head = dotted.split(".")[0] if dotted else ""
            tail = dotted.split(".")[-1] if dotted else ""
            if head in forbidden_modules:
                offenders.append(f"call {dotted}()")
            elif dotted in ("os.system", "shutil.which") or (head in ("os", "shutil") and tail in forbidden_callables):
                offenders.append(f"call {dotted}()")
            elif tail == "Popen":
                offenders.append(f"call {dotted}()")

    assert not offenders, f"new exec surface in provider.py: {offenders}"


# ── Group B: collision-free three-agent doctor aggregation (SC3, D-03) ──


def test_default_providers_returns_exactly_three_agents():
    providers = default_providers()
    assert isinstance(providers, list)
    assert len(providers) == 3, f"expected 3 providers, got {[p.agent_name for p in providers]}"
    # One each of ClaudeCode / Codex / OpenClaw, every element a CapabilityProvider.
    assert sum(isinstance(p, ClaudeCodeProvider) for p in providers) == 1
    assert sum(isinstance(p, CodexProvider) for p in providers) == 1
    assert sum(isinstance(p, OpenClawProvider) for p in providers) == 1
    assert all(isinstance(p, CapabilityProvider) for p in providers)
    # agent_name set is exactly the three expected stable identifiers.
    assert {p.agent_name for p in providers} == {"claude-code", "codex", "openclaw"}


def test_doctor_aggregates_three_agents_without_collision_or_schema_break(tmp_path):
    """With all three providers registered, collect_report() folds each agent's stack into
    one report: schema_version unchanged (1), all three *_cli + all three *_mlx_whisper keys
    survive the last-writer-wins fold (no clobber — T-08-01)."""
    doctor = load_doctor()
    report = doctor.collect_report(
        source_root=ROOT,
        runtime_root=tmp_path,
        legacy_root=tmp_path / "missing-legacy",
        config_dir=tmp_path / "cfg",
    )
    assert "host_capabilities" in report
    hc = report["host_capabilities"]
    # SC3: no schema break — still the integer 1.
    assert hc.get("schema_version") == 1
    caps = hc.get("capabilities")
    assert isinstance(caps, dict)
    # The section degraded to a real dict (never an error-only degrade).
    assert "error" not in hc

    # No key collision: all three distinct CLI keys survive the fold.
    for cli_key in ("claude_cli", "codex_cli", "openclaw_cli"):
        assert cli_key in caps, f"missing {cli_key} — provider entry was clobbered in the fold"
    # No key collision: all three distinct mlx-whisper keys survive (the real T-08-01 fix —
    # three bare `agent_mlx_whisper` would have collapsed to one).
    for mlx_key in ("agent_mlx_whisper", "codex_mlx_whisper", "openclaw_mlx_whisper"):
        assert mlx_key in caps, f"missing {mlx_key} — mlx-whisper key collided in the fold"
