"""Agent-native Host capability probe contracts."""

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "yulu" / "scripts"))

from capabilities import probes  # noqa: E402
from capabilities.report import Provenance, Status  # noqa: E402


class _FakeCompleted:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_resolve_on_login_path_uses_login_shell_command_v(monkeypatch):
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return _FakeCompleted(stdout="/usr/local/bin/hermes\n")

    monkeypatch.setenv("SHELL", "/bin/zsh")
    monkeypatch.setattr(probes.shutil, "which", lambda *_a, **_k: None)
    monkeypatch.setattr(probes.subprocess, "run", fake_run)

    assert probes.resolve_on_login_path("hermes") == "/usr/local/bin/hermes"
    assert calls == [["/bin/zsh", "-lc", "command -v hermes"]]


def test_resolve_on_login_path_returns_none_when_missing(monkeypatch):
    monkeypatch.setattr(probes.shutil, "which", lambda *_a, **_k: None)
    monkeypatch.setattr(
        probes.subprocess,
        "run",
        lambda *a, **k: _FakeCompleted(returncode=1),
    )
    assert probes.resolve_on_login_path("missing-agent") is None


def test_resolve_on_login_path_never_raises(monkeypatch):
    monkeypatch.setattr(probes.shutil, "which", lambda *_a, **_k: None)
    def boom(*a, **k):
        raise subprocess.TimeoutExpired(cmd="x", timeout=5)

    monkeypatch.setattr(probes.subprocess, "run", boom)
    assert probes.resolve_on_login_path("hermes") is None


def test_probe_command_found_is_host_path_usable(monkeypatch):
    monkeypatch.setattr(probes, "resolve_on_login_path", lambda *_a, **_k: "/usr/local/bin/hermes")
    monkeypatch.setattr(
        probes.subprocess,
        "run",
        lambda *a, **k: _FakeCompleted(stdout="hermes 1.0\n"),
    )

    cap = probes.probe_command("hermes")

    assert cap.provenance is Provenance.HOST_PATH
    assert cap.status is Status.USABLE
    assert cap.resolved_path == "/usr/local/bin/hermes"


def test_probe_command_missing_returns_clean_absent(monkeypatch):
    monkeypatch.setattr(probes, "resolve_on_login_path", lambda *_a, **_k: None)
    cap = probes.probe_command("hermes")
    assert cap.provenance is Provenance.ABSENT
    assert cap.status is Status.ABSENT


def test_probe_llm_command_resolves_but_never_executes(monkeypatch, tmp_path):
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"llm": {"enabled": True, "command": ["hermes"]}}))
    issued = []

    def fake_run(argv, **kwargs):
        issued.append(argv)
        return _FakeCompleted(stdout="/usr/local/bin/hermes\n")

    monkeypatch.setenv("SHELL", "/bin/zsh")
    monkeypatch.setattr(probes.shutil, "which", lambda *_a, **_k: None)
    monkeypatch.setattr(probes.subprocess, "run", fake_run)

    cap = probes.probe_llm_command(config)

    assert cap.provenance is Provenance.AGENT_CONFIG
    assert cap.resolved_path == "/usr/local/bin/hermes"
    assert issued
    assert all("command -v" in " ".join(argv) for argv in issued)
    assert ["hermes"] not in issued


def test_null_command_uses_selected_hermes_agent(monkeypatch, tmp_path):
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"llm": {"agent": {"provider": "hermes"}}}))
    monkeypatch.setattr(
        probes,
        "resolve_on_login_path",
        lambda binary, shell=None: f"/usr/local/bin/{binary}" if binary == "hermes" else None,
    )

    cap = probes.probe_llm_command(config)

    assert cap.status is Status.USABLE
    assert cap.detail == "llm.command=hermes"


def test_disabled_agent_command_is_absent(tmp_path):
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"llm": {"enabled": False, "command": ["hermes"]}}))
    assert probes.probe_llm_command(config).status is Status.ABSENT


def test_probe_recording_dir_never_raises():
    cap = probes.probe_recording_dir()
    assert cap.status in {Status.USABLE, Status.PRESENT_BUT_UNVERIFIED, Status.ABSENT}


def test_resolve_on_login_path_uses_launchagent_fallback_before_shell(monkeypatch):
    calls = []

    def fake_which(binary, path=None):
        calls.append((binary, path))
        if path and "/opt/homebrew/bin" in path:
            return "/opt/homebrew/bin/ffmpeg"
        return None

    monkeypatch.setattr(probes.shutil, "which", fake_which)
    monkeypatch.setattr(
        probes.subprocess,
        "run",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("shell should not run")),
    )

    assert probes.resolve_on_login_path("ffmpeg") == "/opt/homebrew/bin/ffmpeg"
    assert len(calls) == 2


def test_login_shell_resolution_quotes_configured_command_name(monkeypatch):
    issued = []
    monkeypatch.setattr(probes.shutil, "which", lambda *_a, **_k: None)
    monkeypatch.setattr(
        probes.subprocess,
        "run",
        lambda argv, **_kwargs: issued.append(argv) or _FakeCompleted(returncode=1),
    )

    assert probes.resolve_on_login_path("missing;touch-not-allowed") is None
    assert issued[0][-1] == "command -v 'missing;touch-not-allowed'"
