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
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert mcp.ensure_token(path) == first
    rotated = mcp.ensure_token(path, rotate=True)
    assert rotated and rotated != first
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_install_agent_builds_agent_specific_argv(monkeypatch):
    calls = []
    monkeypatch.setattr(mcp, "set_launchctl_env", lambda _token: None)
    monkeypatch.setattr(mcp, "run", lambda argv, *, non_fatal, **_kwargs: calls.append((argv, non_fatal)) or True)

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


def test_hermes_resolution_uses_gui_fallback_path_for_detection_and_config(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.delenv("SHELL", raising=False)
    hermes = tmp_path / ".local" / "bin" / "hermes"
    hermes.parent.mkdir(parents=True)
    hermes.write_text("#!/bin/sh\nexit 0\n")
    hermes.chmod(0o755)

    assert mcp.resolve_executable("hermes") == str(hermes)
    assert mcp.detected("hermes") is True

    calls = []
    monkeypatch.setattr(mcp, "run", lambda argv, **_kwargs: calls.append(argv) or True)
    assert mcp.install_agent("hermes", "tok", mcp.ENDPOINT, non_fatal=False)
    assert ["hermes", "config", "set", "mcp_servers.yulu_artifact.url", mcp.ARTIFACT_ENDPOINT] in calls
    assert ["hermes", "config", "set", "mcp_servers.yulu_delivery.url", mcp.DELIVERY_ENDPOINT] in calls


def test_resolve_executable_includes_login_shell_path(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("SHELL", "/bin/zsh")
    hermes = tmp_path / "login-bin" / "hermes"
    hermes.parent.mkdir()
    hermes.write_text("#!/bin/sh\nexit 0\n")
    hermes.chmod(0o755)
    real_run = mcp.subprocess.run

    def fake_run(argv, **kwargs):
        if argv[:2] == ["/bin/zsh", "-lc"]:
            return Namespace(returncode=0, stdout=f"shell startup noise\n{mcp.LOGIN_PATH_MARKER}{hermes.parent}\n")
        return real_run(argv, **kwargs)

    monkeypatch.setattr(mcp.subprocess, "run", fake_run)
    assert mcp.resolve_executable("hermes") == str(hermes)


def test_run_executes_the_resolved_absolute_command(monkeypatch):
    calls = []
    monkeypatch.setattr(mcp, "resolve_executable", lambda _command: "/resolved/hermes")
    monkeypatch.setattr(
        mcp.subprocess,
        "run",
        lambda argv, **kwargs: calls.append((argv, kwargs)) or Namespace(returncode=0),
    )

    assert mcp.run(["hermes", "mcp", "list"], non_fatal=False)
    assert calls[0][0] == ["/resolved/hermes", "mcp", "list"]


def test_hermes_install_uses_noninteractive_atomic_config_commands(monkeypatch, tmp_path):
    calls: list[tuple[list[str], dict]] = []
    monkeypatch.setenv("HOME", str(tmp_path))
    config = tmp_path / ".hermes" / "config.yaml"
    config.parent.mkdir()
    config.write_text("model: test\nmcp_servers:\n  notion:\n    url: https://example.test/mcp\n")
    monkeypatch.setattr(mcp.shutil, "which", lambda name: f"/bin/{name}" if name == "hermes" else None)
    monkeypatch.setattr(mcp, "run", lambda argv, **kwargs: calls.append((argv, kwargs)) or True)

    assert mcp.install_agent("hermes", "tok", mcp.ENDPOINT, non_fatal=False)

    assert [argv for argv, _kwargs in calls] == [
        ["hermes", "mcp", "remove", "yulu"],
        ["hermes", "mcp", "remove", "yulu_pipeline"],
        ["hermes", "mcp", "remove", "yulu_artifact"],
        ["hermes", "mcp", "remove", "yulu_delivery"],
        ["hermes", "config", "set", "mcp_servers.yulu.url", mcp.ENDPOINT],
        ["hermes", "config", "set", "mcp_servers.yulu.headers.Authorization", "Bearer tok"],
        ["hermes", "config", "set", "mcp_servers.yulu.enabled", "true"],
        ["hermes", "config", "set", "mcp_servers.yulu.timeout", "120"],
        ["hermes", "config", "set", "mcp_servers.yulu.connect_timeout", "20"],
        ["hermes", "config", "set", "mcp_servers.yulu_artifact.url", mcp.ARTIFACT_ENDPOINT],
        ["hermes", "config", "set", "mcp_servers.yulu_artifact.headers.Authorization", "Bearer tok"],
        ["hermes", "config", "set", "mcp_servers.yulu_artifact.enabled", "true"],
        ["hermes", "config", "set", "mcp_servers.yulu_artifact.timeout", "120"],
        ["hermes", "config", "set", "mcp_servers.yulu_artifact.connect_timeout", "20"],
        ["hermes", "config", "set", "mcp_servers.yulu_delivery.url", mcp.DELIVERY_ENDPOINT],
        ["hermes", "config", "set", "mcp_servers.yulu_delivery.headers.Authorization", "Bearer tok"],
        ["hermes", "config", "set", "mcp_servers.yulu_delivery.enabled", "true"],
        ["hermes", "config", "set", "mcp_servers.yulu_delivery.timeout", "120"],
        ["hermes", "config", "set", "mcp_servers.yulu_delivery.connect_timeout", "20"],
    ]
    assert calls[0][1]["input_text"] == "y\n"
    assert calls[1][1]["input_text"] == "y\n"
    assert all(kwargs["quiet"] is True for _argv, kwargs in calls)
    backup = config.with_name("config.yaml.yulu-backup")
    assert backup.read_text() == config.read_text()
    assert stat.S_IMODE(backup.stat().st_mode) == 0o600


def test_hermes_install_restores_current_snapshot_after_partial_set_failure(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    config = tmp_path / ".hermes" / "config.yaml"
    config.parent.mkdir()
    original = b"model: old\ncustom: \xff\n"
    config.write_bytes(original)
    config.chmod(0o640)
    calls = []
    monkeypatch.setattr(mcp, "resolve_executable", lambda name: "/bin/hermes" if name == "hermes" else None)

    def fake_run(argv, **_kwargs):
        calls.append(argv)
        config.write_bytes(("mutated by " + " ".join(argv)).encode())
        # Prove rollback does not trust the fixed long-term audit backup.
        config.with_name("config.yaml.yulu-backup").write_bytes(b"stale audit backup\n")
        return argv[:4] != ["hermes", "config", "set", "mcp_servers.yulu.enabled"]

    monkeypatch.setattr(mcp, "run", fake_run)

    assert mcp.write_hermes_config(mcp.ENDPOINT, "tok", non_fatal=True) is False
    assert config.read_bytes() == original
    assert stat.S_IMODE(config.stat().st_mode) == 0o640
    assert calls[-1][:4] == ["hermes", "config", "set", "mcp_servers.yulu.enabled"]
    backup = config.with_name("config.yaml.yulu-backup")
    assert backup.read_bytes() == b"stale audit backup\n"
    assert stat.S_IMODE(backup.stat().st_mode) == 0o600
    assert not list(config.parent.glob(".config.yaml.yulu-transaction-*"))


def test_hermes_install_restores_absence_after_remove_failure(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    config = tmp_path / ".hermes" / "config.yaml"
    config.parent.mkdir()
    calls = []
    monkeypatch.setattr(mcp, "resolve_executable", lambda name: "/bin/hermes" if name == "hermes" else None)

    def fake_run(argv, **_kwargs):
        calls.append(argv)
        config.write_text("partially created\n", encoding="utf-8")
        return argv != ["hermes", "mcp", "remove", "yulu_pipeline"]

    monkeypatch.setattr(mcp, "run", fake_run)

    assert mcp.write_hermes_config(mcp.ENDPOINT, "tok", non_fatal=False) is False
    assert not config.exists()
    assert calls == [
        ["hermes", "mcp", "remove", "yulu"],
        ["hermes", "mcp", "remove", "yulu_pipeline"],
    ]
    assert not list(config.parent.glob(".config.yaml.yulu-transaction-*"))


def test_hermes_install_commits_success_and_removes_transaction_snapshot(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    config = tmp_path / ".hermes" / "config.yaml"
    config.parent.mkdir()
    original = b"model: old\n"
    config.write_bytes(original)
    config.chmod(0o640)
    snapshots_seen = []
    monkeypatch.setattr(mcp, "resolve_executable", lambda name: "/bin/hermes" if name == "hermes" else None)

    def fake_run(argv, **_kwargs):
        snapshots = list(config.parent.glob(".config.yaml.yulu-transaction-*"))
        assert len(snapshots) == 1
        snapshot = snapshots[0]
        snapshots_seen.append(snapshot)
        assert snapshot.read_bytes() == original
        assert stat.S_IMODE(snapshot.stat().st_mode) == 0o600
        config.write_bytes(("committed by " + " ".join(argv)).encode())
        return True

    monkeypatch.setattr(mcp, "run", fake_run)

    assert mcp.write_hermes_config(mcp.ENDPOINT, "tok", non_fatal=False) is True
    assert config.read_bytes().startswith(b"committed by hermes config set")
    assert stat.S_IMODE(config.stat().st_mode) == 0o600
    assert snapshots_seen
    assert not list(config.parent.glob(".config.yaml.yulu-transaction-*"))
    assert config.with_name("config.yaml.yulu-backup").read_bytes() == original


def test_hermes_remove_is_noninteractive(monkeypatch):
    calls = []
    monkeypatch.setattr(mcp.shutil, "which", lambda name: f"/bin/{name}" if name == "hermes" else None)
    monkeypatch.setattr(mcp, "run", lambda argv, **kwargs: calls.append((argv, kwargs)) or True)

    assert mcp.remove_agent("hermes", non_fatal=False)

    assert calls == [
        (["hermes", "mcp", "remove", "yulu"], {
            "non_fatal": False,
            "input_text": "y\n",
            "quiet": True,
        }),
        (["hermes", "mcp", "remove", "yulu_pipeline"], {
            "non_fatal": False,
            "input_text": "y\n",
            "quiet": True,
        }),
        (["hermes", "mcp", "remove", "yulu_artifact"], {
            "non_fatal": False,
            "input_text": "y\n",
            "quiet": True,
        }),
        (["hermes", "mcp", "remove", "yulu_delivery"], {
            "non_fatal": False,
            "input_text": "y\n",
            "quiet": True,
        }),
    ]


def test_recording_phase_endpoints_follow_custom_yulu_endpoint():
    assert mcp.recording_phase_endpoint("http://127.0.0.1:9000/custom/mcp/", "artifact") == (
        "http://127.0.0.1:9000/custom/mcp/recording-artifact"
    )
    assert mcp.recording_phase_endpoint(mcp.ENDPOINT, "delivery") == mcp.DELIVERY_ENDPOINT


def test_hermes_status_requires_general_and_phase_servers(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    config = tmp_path / ".hermes" / "config.yaml"
    config.parent.mkdir()
    config.write_text("mcp_servers:\n  yulu:\n    url: http://127.0.0.1:7777/mcp\n")
    assert mcp.configured("hermes") is False

    config.write_text(
        "mcp_servers:\n"
        "  yulu:\n    url: http://127.0.0.1:7777/mcp\n"
        "  yulu_artifact:\n    url: http://127.0.0.1:7777/mcp/recording-artifact\n"
        "  yulu_delivery:\n    url: http://127.0.0.1:7777/mcp/recording-delivery\n"
    )
    assert mcp.configured("hermes") is True
