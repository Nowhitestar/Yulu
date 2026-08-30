import json
import subprocess
from pathlib import Path

import yulu.scripts.dev_install as dev_install


def test_seed_prompt_defaults_uses_runtime_script_dir(monkeypatch, tmp_path):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0, stdout='{"inserted": 0}', stderr="")

    monkeypatch.setattr(dev_install.subprocess, "run", fake_run)

    dev_install._seed_prompt_defaults(tmp_path / "scripts", python_bin="/usr/bin/python3")

    assert calls[0][0] == ["/usr/bin/python3", "-m", "prompts.cli", "seed", "--from-current"]
    assert calls[0][1]["env"]["PYTHONPATH"] == str(tmp_path / "scripts")


def test_install_mcp_registration_uses_runtime_script_dir(monkeypatch, tmp_path):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(dev_install.subprocess, "run", fake_run)
    script_dir = tmp_path / "scripts"

    dev_install._install_mcp_registration(script_dir, python_bin="/usr/bin/python3")

    assert calls[0][0] == [
        "/usr/bin/python3", "-m", "provision.cli", "mcp", "install",
        "--agent", "hermes",
    ]
    assert calls[0][1]["env"]["PYTHONPATH"] == str(script_dir)
    assert calls[1][0] == [
        "/usr/bin/python3", "-m", "provision.cli", "mcp", "install",
        "--agent", "codex", "--agent", "claude", "--agent", "openclaw",
        "--detected-only", "--non-fatal",
    ]


def test_install_mcp_registration_fails_when_required_hermes_registration_fails(monkeypatch, tmp_path):
    def fake_run(cmd, **_kwargs):
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="Hermes missing")

    monkeypatch.setattr(dev_install.subprocess, "run", fake_run)

    try:
        dev_install._install_mcp_registration(tmp_path / "scripts", python_bin="/usr/bin/python3")
    except RuntimeError as exc:
        assert "Hermes missing" in str(exc)
    else:
        raise AssertionError("required Hermes registration failure must abort dev install")


def test_dev_install_manages_status_agent_plist():
    assert "com.yulu.statusagent.plist" in dev_install.LAUNCHAGENTS
    assert "VERSION" in dev_install.RUNTIME_ITEMS
    assert "assets/Yulu.icns" in dev_install.RUNTIME_ITEMS


def test_dev_install_recording_guard_uses_standard_capture_paths(monkeypatch, tmp_path):
    observed = {}

    def socket_status(path):
        observed["socket"] = path
        return {"recording": False}

    def state_recording(path):
        observed["state"] = path
        return False

    monkeypatch.setattr(dev_install, "_socket_status", socket_status)
    monkeypatch.setattr(dev_install, "_state_recording", state_recording)

    dev_install.plan(
        source_root=tmp_path / "source",
        runtime_root=tmp_path / "runtime",
        config_dir=dev_install.DEFAULT_CONFIG_DIR,
    )

    assert observed == {
        "socket": dev_install.DEFAULT_IPC_DIR,
        "state": dev_install.DEFAULT_APPLICATION_DATA_DIR,
    }


def test_dev_install_metadata_marks_runtime_as_dev(monkeypatch, tmp_path):
    source = tmp_path / "source"
    runtime = tmp_path / "runtime"
    source.mkdir()
    runtime.mkdir()

    def fake_run(cmd, **_kwargs):
        if cmd[-2:] == ["branch", "--show-current"]:
            stdout = "codex/test\n"
        elif cmd[-3:] == ["rev-parse", "--short", "HEAD"]:
            stdout = "abc1234\n"
        elif cmd[-2:] == ["status", "--porcelain"]:
            stdout = " M file\n"
        else:
            stdout = ""
        return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

    monkeypatch.setattr(dev_install, "_run", fake_run)

    dev_install._write_dev_install_metadata(source, runtime)

    metadata = json.loads((runtime / ".yulu-install.json").read_text())
    assert metadata == {
        "schema": 1,
        "source": "dev",
        "installed_at": metadata["installed_at"],
        "branch": "codex/test",
        "commit": "abc1234",
        "dirty": True,
    }


def test_node_runtime_policy_enforces_ui_toolchain_floor(monkeypatch):
    versions = {
        "/opt/node20-old": "20.17.0",
        "/opt/node20": "20.19.0",
        "/opt/node22-old": "22.11.0",
        "/opt/node22": "22.12.0",
        "/opt/node24": "24.0.0",
        "/opt/node26": "26.0.0",
        "/opt/broken": "not-a-version",
    }

    def fake_run(cmd, **_kwargs):
        return subprocess.CompletedProcess(cmd, 0, stdout=versions[cmd[0]], stderr="")

    monkeypatch.setattr(dev_install, "_run", fake_run)

    assert dev_install._compatible_node_version("/opt/node20-old") is False
    assert dev_install._compatible_node_version("/opt/node20") is True
    assert dev_install._compatible_node_version("/opt/node22-old") is False
    assert dev_install._compatible_node_version("/opt/node22") is True
    assert dev_install._compatible_node_version("/opt/node24") is True
    assert dev_install._compatible_node_version("/opt/node26") is False
    assert dev_install._compatible_node_version("/opt/broken") is False


def test_preferred_node_rejects_unsupported_version(monkeypatch, tmp_path):
    candidates = ["/opt/node26", "/opt/node24"]
    monkeypatch.setattr(dev_install, "_node_candidates", lambda: candidates)
    monkeypatch.setattr(
        dev_install,
        "_compatible_node_version",
        lambda candidate: candidate.endswith("24"),
    )
    monkeypatch.setattr(dev_install, "_node_can_load_ui_native_modules", lambda *_args: True)

    assert dev_install.preferred_node(tmp_path) == "/opt/node24"


def test_build_ui_uses_compatible_node_path_for_npm(monkeypatch, tmp_path):
    scripts = tmp_path / "yulu" / "scripts"
    ui_dir = scripts / "yulu_ui"
    ui_dir.mkdir(parents=True)
    (ui_dir / "package.json").write_text("{}", encoding="utf-8")
    calls = []
    monkeypatch.setattr(dev_install, "preferred_node", lambda _script_dir: "/opt/node24/bin/node")
    monkeypatch.setattr(dev_install.shutil, "which", lambda name, path=None: "/opt/homebrew/bin/npm" if name == "npm" else None)

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(dev_install, "_run", fake_run)

    dev_install._build_ui_dist(tmp_path)

    assert calls[0][0] == ["/opt/homebrew/bin/npm", "run", "build"]
    assert calls[0][1]["cwd"] == ui_dir
    assert calls[0][1]["env"]["PATH"].split(":")[0] == "/opt/node24/bin"


def test_launch_path_puts_selected_node_before_local_bin():
    parts = dev_install._launch_path("/opt/homebrew/opt/node@24/bin/node").split(":")
    assert parts[0] == "/opt/homebrew/opt/node@24/bin"
    assert parts.index(str(Path.home() / ".local/bin")) > 0


def test_dev_install_retires_legacy_stt_daemon():
    assert "com.yulu.sttdaemon.plist" not in dev_install.LAUNCHAGENTS
    assert "com.yulu.sttdaemon.plist" in dev_install.OBSOLETE_LAUNCHAGENTS


def test_retiring_obsolete_stt_jobs_keeps_legacy_rollback_tree_immutable(monkeypatch, tmp_path):
    paths = [
        tmp_path / "stt_daemon.sock",
        tmp_path / "stt_daemon.pid",
        tmp_path / "dictation" / "realtime.pid",
    ]
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("stale", encoding="utf-8")
    log = tmp_path / "logs" / "stt_daemon.log"
    log.parent.mkdir()
    log.write_text("audit", encoding="utf-8")
    launch_agents = tmp_path / "LaunchAgents"
    launch_agents.mkdir()

    def fake_run(cmd, **_kwargs):
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    before = {path.relative_to(tmp_path): path.read_bytes() for path in [*paths, log]}
    monkeypatch.setattr(dev_install, "_run", fake_run)
    dev_install._retire_obsolete_launchagents(tmp_path, launch_agents)

    after = {path.relative_to(tmp_path): path.read_bytes() for path in [*paths, log]}
    assert after == before


def test_prepare_log_directory_is_private_and_rejects_aliases(tmp_path):
    logs_dir = tmp_path / "Library" / "Logs" / "Yulu"
    logs_dir.mkdir(parents=True, mode=0o777)
    logs_dir.chmod(0o777)

    dev_install._prepare_log_directory(logs_dir)

    assert logs_dir.stat().st_mode & 0o777 == 0o700
    moved = tmp_path / "actual-logs"
    logs_dir.rename(moved)
    logs_dir.symlink_to(moved, target_is_directory=True)
    try:
        dev_install._prepare_log_directory(logs_dir)
    except RuntimeError as exc:
        assert "real directory" in str(exc)
    else:
        raise AssertionError("log directory aliases must fail closed")


def test_load_fails_when_launchctl_load_fails(monkeypatch, tmp_path):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 1 if cmd[:2] == ["launchctl", "load"] else 0, stdout="", stderr="load failed")

    monkeypatch.setattr(dev_install, "_run", fake_run)
    dev_install._load(tmp_path / "com.yulu.test.plist")

    assert calls[-1][1]["check"] is True


def test_retire_obsolete_launchagents_boots_out_by_label_without_plists(monkeypatch, tmp_path):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(dev_install, "_run", fake_run)
    config_dir = tmp_path / "config"
    launch_agents = tmp_path / "LaunchAgents"
    config_dir.mkdir()
    launch_agents.mkdir()

    dev_install._retire_obsolete_launchagents(config_dir, launch_agents)

    domain = f"gui/{dev_install.os.getuid()}"
    assert ["launchctl", "bootout", f"{domain}/com.yulu.sttdaemon"] in calls
    assert ["launchctl", "bootout", f"{domain}/com.yulu.agentqueue"] in calls
    assert ["pkill", "-f", "stt_daemon"] in calls
    assert ["pkill", "-f", "agent_queue_worker.py"] in calls
    assert ["launchctl", "list"] in calls
    assert not any(cmd[:2] == ["launchctl", "print"] for cmd in calls)


def test_retire_obsolete_launchagents_fails_closed_when_list_still_contains_label(monkeypatch, tmp_path):
    def fake_run(cmd, **kwargs):
        stdout = "-\t0\tcom.yulu.sttdaemon\n" if cmd == ["launchctl", "list"] else ""
        return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

    monkeypatch.setattr(dev_install, "_run", fake_run)
    config_dir = tmp_path / "config"
    launch_agents = tmp_path / "LaunchAgents"
    config_dir.mkdir()
    launch_agents.mkdir()

    try:
        dev_install._retire_obsolete_launchagents(config_dir, launch_agents)
    except RuntimeError as exc:
        assert "com.yulu.sttdaemon" in str(exc)
    else:
        raise AssertionError("a still-loaded retired LaunchAgent must stop installation")


def test_retire_obsolete_launchagents_fails_closed_when_list_fails(monkeypatch, tmp_path):
    def fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(
            cmd,
            1 if cmd == ["launchctl", "list"] else 0,
            stdout="",
            stderr="unavailable",
        )

    monkeypatch.setattr(dev_install, "_run", fake_run)
    config_dir = tmp_path / "config"
    launch_agents = tmp_path / "LaunchAgents"
    config_dir.mkdir()
    launch_agents.mkdir()

    try:
        dev_install._retire_obsolete_launchagents(config_dir, launch_agents)
    except RuntimeError as exc:
        assert "launchctl list" in str(exc)
    else:
        raise AssertionError("an unverifiable retired LaunchAgent state must stop installation")


def test_kill_legacy_processes_kills_status_agent_child(monkeypatch, tmp_path):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(dev_install, "_run", fake_run)

    dev_install._kill_legacy_processes(tmp_path / "missing-legacy-root")

    assert ["pkill", "-f", "StatusAgent.app/Contents/MacOS/status_agent"] in calls
