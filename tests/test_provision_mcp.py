import json
import stat
import sys
from argparse import Namespace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import provision.mcp as mcp  # noqa: E402


def test_token_file_created_0600_reused_and_rotated(tmp_path):
    path = tmp_path / "mcp-token.json"
    first = mcp.ensure_token(path)
    assert first
    raw = json.loads(path.read_text())
    assert raw["token"] == first
    assert raw["created_at"].endswith("Z")
    assert raw["endpoint"] == mcp.ENDPOINT
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert mcp.ensure_token(path) == first
    rotated = mcp.ensure_token(path, rotate=True)
    assert rotated and rotated != first
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_install_agent_builds_agent_specific_argv(monkeypatch):
    calls = []
    monkeypatch.setattr(mcp, "set_launchctl_env", lambda _token: None)
    monkeypatch.setattr(mcp, "run", lambda argv, *, non_fatal: calls.append((argv, non_fatal)) or True)

    assert mcp.install_agent("codex", "tok", mcp.ENDPOINT, non_fatal=False)
    assert mcp.install_agent("claude", "tok", mcp.ENDPOINT, non_fatal=True)

    assert calls[0][0] == ["codex", "mcp", "remove", "yulu"]
    assert calls[1][0] == ["codex", "mcp", "add", "yulu", "--url", mcp.ENDPOINT, "--bearer-token-env-var", mcp.ENV_NAME]
    assert calls[2][0] == ["claude", "mcp", "remove", "yulu", "--scope", "user"]
    assert calls[3][0] == [
        "claude", "mcp", "add", "--scope", "user", "--transport", "http", "yulu", mcp.ENDPOINT,
        "--header", "Authorization: Bearer tok",
    ]
    assert calls[3][1] is True


def test_detected_only_skips_missing_agents(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(mcp, "TOKEN_PATH", tmp_path / "mcp-token.json")
    monkeypatch.setattr(mcp, "detected", lambda _agent: False)
    monkeypatch.setattr(mcp, "install_agent", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("should skip")))

    rc = mcp.cmd_install(Namespace(agents=None, detected_only=True, non_fatal=True, endpoint=mcp.ENDPOINT))

    assert rc == 0
    assert "skipped" in capsys.readouterr().out


def test_non_fatal_registration_failure_returns_success(monkeypatch, tmp_path):
    monkeypatch.setattr(mcp, "TOKEN_PATH", tmp_path / "mcp-token.json")
    monkeypatch.setattr(mcp, "detected", lambda agent: agent == "codex")
    monkeypatch.setattr(mcp, "install_agent", lambda *_a, **_k: False)

    rc = mcp.cmd_install(Namespace(agents=["codex"], detected_only=True, non_fatal=True, endpoint=mcp.ENDPOINT))

    assert rc == 0


def test_openclaw_json_config_merge(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(mcp.shutil, "which", lambda _name: None)

    assert mcp.install_agent("openclaw", "tok", mcp.ENDPOINT, non_fatal=False)

    data = json.loads((tmp_path / ".openclaw" / "openclaw.json").read_text())
    server = data["mcp"]["servers"]["yulu"]
    assert server["url"] == mcp.ENDPOINT
    assert server["transport"] == "streamable-http"
    assert server["headers"]["Authorization"] == "Bearer tok"


def test_hermes_yaml_set_and_unset(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    cfg = tmp_path / ".hermes" / "config.yaml"
    cfg.parent.mkdir()
    cfg.write_text("model: test\nmcp_servers:\n  other:\n    url: http://example.test/mcp\nnext: value\n")

    mcp.write_hermes_config(mcp.ENDPOINT, "tok")
    text = cfg.read_text()
    assert "  yulu:\n" in text
    assert "Authorization: Bearer tok" in text
    assert "  other:\n" in text
    assert "next: value" in text

    mcp.unset_hermes_config()
    text = cfg.read_text()
    assert "  yulu:\n" not in text
    assert "  other:\n" in text


def test_hermes_install_uses_cli_then_writes_header(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(mcp.shutil, "which", lambda name: f"/bin/{name}" if name == "hermes" else None)
    monkeypatch.setattr(mcp, "run", lambda argv, *, non_fatal: calls.append(argv) or True)

    assert mcp.install_agent("hermes", "tok", mcp.ENDPOINT, non_fatal=False)

    assert calls == [
        ["hermes", "mcp", "remove", "yulu"],
        ["hermes", "mcp", "add", "yulu", "--url", mcp.ENDPOINT, "--auth", "header"],
    ]
    assert "Authorization: Bearer tok" in (tmp_path / ".hermes" / "config.yaml").read_text()
