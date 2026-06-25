"""Wave-0 probe contracts for capabilities/probes.py (DETECT-02/03/04, T-03-01/02/03).

Fully mocked — runs on any OS. Locks the honest-detection invariants:

- ``resolve_on_login_path`` issues ``$SHELL -lc 'command -v X'`` (login-shell PATH), NOT
  ``shutil.which`` and NOT launchd's minimal PATH (D-02).
- ``probe_importable`` runs the DAEMON's interpreter as a subprocess ``[py, -c, import X]``
  (D-03/D-04) — a green ``usable`` means the daemon can import it.
- ``daemon_python`` mirrors lib/common.sh:124 exactly (PYTHON_BIN → which python3 → /usr/bin/python3).
- A missing binary degrades to a clean ``absent()`` Capability, never an exception.
- ``probe_llm_command`` RESOLVES + stats the configured command's head token; it NEVER
  executes the command (T-03-01) — the only subprocess argv it issues is ``command -v``.
"""

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


# ── daemon_python(): the canonical interpreter (D-04, mirrors lib/common.sh:124) ──


def test_daemon_python_prefers_pythonbin_env(monkeypatch):
    monkeypatch.setenv("PYTHON_BIN", "/custom/python3")
    assert probes.daemon_python() == "/custom/python3"


def test_daemon_python_falls_back_to_which(monkeypatch):
    monkeypatch.delenv("PYTHON_BIN", raising=False)
    monkeypatch.setattr(probes.shutil, "which", lambda name: "/opt/homebrew/bin/python3")
    assert probes.daemon_python() == "/opt/homebrew/bin/python3"


def test_daemon_python_final_fallback_is_usr_bin(monkeypatch):
    monkeypatch.delenv("PYTHON_BIN", raising=False)
    monkeypatch.setattr(probes.shutil, "which", lambda name: None)
    assert probes.daemon_python() == "/usr/bin/python3"


# ── resolve_on_login_path(): $SHELL -lc 'command -v X' (D-02) ──


def test_resolve_on_login_path_uses_login_shell_command_v(monkeypatch):
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return _FakeCompleted(returncode=0, stdout="/usr/local/bin/claude\n")

    monkeypatch.setenv("SHELL", "/bin/zsh")
    monkeypatch.setattr(probes.subprocess, "run", fake_run)

    path = probes.resolve_on_login_path("claude")
    assert path == "/usr/local/bin/claude"
    # It must use the login shell + -lc + command -v, NOT shutil.which.
    assert len(calls) == 1
    argv = calls[0]
    assert argv[0] == "/bin/zsh"
    assert "-lc" in argv
    assert any("command -v claude" in part for part in argv)


def test_resolve_on_login_path_returns_none_when_missing(monkeypatch):
    monkeypatch.setattr(
        probes.subprocess, "run", lambda *a, **k: _FakeCompleted(returncode=1, stdout="")
    )
    assert probes.resolve_on_login_path("nope-binary") is None


def test_resolve_on_login_path_never_raises_on_subprocess_error(monkeypatch):
    def boom(*a, **k):
        raise subprocess.TimeoutExpired(cmd="x", timeout=5)

    monkeypatch.setattr(probes.subprocess, "run", boom)
    assert probes.resolve_on_login_path("claude") is None


# ── probe_importable(): the DAEMON interpreter import probe (D-03/D-04) ──


def test_probe_importable_uses_daemon_interpreter_subprocess(monkeypatch):
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return _FakeCompleted(returncode=0, stdout="0.4.0\n")

    monkeypatch.setattr(probes.subprocess, "run", fake_run)
    monkeypatch.setattr(probes, "daemon_python", lambda: "/daemon/python3")

    ok, detail = probes.probe_importable("mlx_whisper")
    assert ok is True
    assert detail == "0.4.0"
    argv = calls[0]
    assert argv[0] == "/daemon/python3"
    assert "-c" in argv
    assert any("import mlx_whisper" in part for part in argv)


def test_probe_importable_false_on_nonzero_returncode(monkeypatch):
    monkeypatch.setattr(
        probes.subprocess,
        "run",
        lambda *a, **k: _FakeCompleted(returncode=1, stderr="ModuleNotFoundError: mlx_whisper\n"),
    )
    monkeypatch.setattr(probes, "daemon_python", lambda: "/daemon/python3")
    ok, detail = probes.probe_importable("mlx_whisper")
    assert ok is False
    assert "ModuleNotFoundError" in detail


def test_probe_importable_never_raises(monkeypatch):
    monkeypatch.setattr(
        probes.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("boom"))
    )
    monkeypatch.setattr(probes, "daemon_python", lambda: "/daemon/python3")
    ok, detail = probes.probe_importable("mlx_whisper")
    assert ok is False


# ── probe_command() / probe_mlx_whisper(): Capability shapes + clean absent ──


def test_probe_command_found_is_host_path_usable(monkeypatch):
    monkeypatch.setattr(probes, "resolve_on_login_path", lambda b, shell=None: "/usr/local/bin/whisper-cli")
    monkeypatch.setattr(
        probes.subprocess, "run", lambda *a, **k: _FakeCompleted(returncode=0, stdout="whisper 1.7\n")
    )
    cap = probes.probe_command("whisper-cli")
    assert cap.provenance == Provenance.HOST_PATH
    assert cap.status == Status.USABLE
    assert cap.resolved_path == "/usr/local/bin/whisper-cli"


def test_probe_command_missing_returns_clean_absent(monkeypatch):
    monkeypatch.setattr(probes, "resolve_on_login_path", lambda b, shell=None: None)
    cap = probes.probe_command("whisper-cli")
    assert cap.status == Status.ABSENT
    assert cap.provenance == Provenance.ABSENT
    assert cap.resolved_path == ""


def test_probe_mlx_whisper_present_is_unverified_without_deep_probe(monkeypatch):
    probes.probe_mlx_whisper.cache_clear()
    monkeypatch.delenv("YULU_DEEP_CAPABILITY_PROBES", raising=False)
    monkeypatch.setattr(probes, "probe_module_spec", lambda m, python_bin=None: (True, f"/site/{m}"))
    monkeypatch.setattr(probes, "daemon_python", lambda: "/daemon/python3")
    cap = probes.probe_mlx_whisper()
    assert cap.status == Status.PRESENT_BUT_UNVERIFIED
    assert cap.provenance == Provenance.HOST_PATH
    assert cap.resolved_path == "/daemon/python3"
    assert "runtime warm-up not run" in cap.detail


def test_probe_mlx_whisper_missing_is_absent(monkeypatch):
    probes.probe_mlx_whisper.cache_clear()
    monkeypatch.setattr(probes, "probe_module_spec", lambda m, python_bin=None: (False, "ModuleNotFoundError"))
    cap = probes.probe_mlx_whisper()
    assert cap.status == Status.ABSENT


def test_probe_mlx_whisper_deep_importable_is_usable(monkeypatch):
    probes.probe_mlx_whisper.cache_clear()
    monkeypatch.setenv("YULU_DEEP_CAPABILITY_PROBES", "1")
    monkeypatch.setattr(probes, "probe_module_spec", lambda m, python_bin=None: (True, f"/site/{m}"))
    monkeypatch.setattr(probes, "probe_importable", lambda m, python_bin=None: (True, "0.4.0"))
    monkeypatch.setattr(probes, "daemon_python", lambda: "/daemon/python3")
    cap = probes.probe_mlx_whisper()
    assert cap.status == Status.USABLE
    assert cap.provenance == Provenance.HOST_PATH
    assert cap.resolved_path == "/daemon/python3"
    assert "0.4.0" in cap.detail


# ── probe_llm_command(): RESOLVED-NOT-EXECUTED (T-03-01) ──


def test_probe_llm_command_disabled_returns_absent(monkeypatch, tmp_path):
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"llm": {"enabled": False, "command": ["claude", "--print"]}}))
    cap = probes.probe_llm_command(config_path=cfg)
    assert cap.status == Status.ABSENT
    assert "not configured" in cap.detail.lower() or "disabled" in cap.detail.lower()


def test_probe_llm_command_null_command_returns_absent(monkeypatch, tmp_path):
    # Default Yulu config: llm.command = null (agent-queue mode).
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"llm": {"enabled": True, "command": None}}))
    cap = probes.probe_llm_command(config_path=cfg)
    assert cap.status == Status.ABSENT


def test_probe_llm_command_resolves_but_never_executes(monkeypatch, tmp_path):
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"llm": {"enabled": True, "command": ["claude", "--print"]}}))

    issued = []

    def fake_run(argv, **kwargs):
        issued.append(argv)
        # Simulate `command -v claude` succeeding on the login PATH.
        return _FakeCompleted(returncode=0, stdout="/usr/local/bin/claude\n")

    monkeypatch.setenv("SHELL", "/bin/zsh")
    monkeypatch.setattr(probes.subprocess, "run", fake_run)

    cap = probes.probe_llm_command(config_path=cfg)
    assert cap.provenance == Provenance.AGENT_CONFIG
    assert cap.status == Status.USABLE
    assert cap.resolved_path == "/usr/local/bin/claude"

    # The DEFINING security assertion: every subprocess argv is a `command -v` lookup;
    # the bare llm command (["claude", "--print"]) is NEVER executed (T-03-01).
    assert issued, "expected at least one resolution subprocess"
    for argv in issued:
        joined = " ".join(argv)
        assert "command -v" in joined, f"unexpected argv (not a resolution): {argv!r}"
        assert argv != ["claude", "--print"], "llm.command must NEVER be executed"


def test_probe_llm_command_upgrades_legacy_codex_shim(monkeypatch, tmp_path):
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"llm": {"enabled": True, "command": ["python3", "codex_llm.py"]}}))
    monkeypatch.setattr(probes, "resolve_on_login_path", lambda b, shell=None: f"/usr/local/bin/{b}")

    cap = probes.probe_llm_command(config_path=cfg)

    assert cap.provenance == Provenance.AGENT_CONFIG
    assert cap.status == Status.USABLE
    assert cap.resolved_path == "/usr/local/bin/codex"
    assert cap.detail == "llm.command=codex"


def test_probe_llm_command_head_not_on_path_is_absent(monkeypatch, tmp_path):
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"llm": {"enabled": True, "command": ["nope-binary"]}}))
    monkeypatch.setattr(probes, "resolve_on_login_path", lambda b, shell=None: None)
    cap = probes.probe_llm_command(config_path=cfg)
    assert cap.status == Status.ABSENT


# ── scan_models() / probe_recording_dir(): never raise, bounded ──


def test_scan_models_no_models_returns_absent(monkeypatch, tmp_path):
    # Point all model roots at empty dirs.
    monkeypatch.setattr(probes, "_model_roots", lambda: [tmp_path / "empty"])
    cap = probes.scan_models()
    assert cap.status == Status.ABSENT


def test_scan_models_finds_models(monkeypatch, tmp_path):
    yulu_models = tmp_path / ".config" / "yulu" / "models"
    yulu_models.mkdir(parents=True)
    (yulu_models / "ggml-large-v3.bin").write_bytes(b"x" * 1024)
    monkeypatch.setattr(probes, "_model_roots", lambda: [yulu_models])
    cap = probes.scan_models()
    assert cap.status == Status.USABLE
    assert "1024" in cap.detail or "1 model" in cap.detail


def test_probe_recording_dir_never_raises_off_darwin(monkeypatch):
    # If MacOSPathResolver raises (non-Darwin), the probe degrades to absent — never raises.
    cap = probes.probe_recording_dir()
    assert cap is not None
    assert cap.status in (Status.USABLE, Status.PRESENT_BUT_UNVERIFIED, Status.ABSENT)
