"""Retire the v0.22 StatusAgent App, not just its `open -W` launchd waiter."""

import errno
import io
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
from types import SimpleNamespace

import pytest


@pytest.fixture
def migration(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "yulu/scripts"))
    import application_migration

    return application_migration


@pytest.fixture
def status_case(migration, tmp_path, monkeypatch):
    bundle = tmp_path / "old install/StatusAgent.app"
    executable = bundle / "Contents/MacOS/status_agent"
    payload = {"Label": "com.yulu.statusagent", "ProgramArguments": ["/usr/bin/open", "-W", str(bundle)]}
    snapshot = {"com.yulu.statusagent": {"loaded": True, "plistBytes": plistlib.dumps(payload).hex()}}
    status = {"ok": True, "state": "idle", "dictation_active": False, "voice_chat_window_visible": False}
    state = SimpleNamespace(alive=True, generation=(100, 200), peer=(123, os.geteuid()), executable=executable)
    events = []

    def kill(pid, sig):
        assert pid == 123
        assert sig in (0, signal.SIGTERM)
        if not state.alive:
            raise ProcessLookupError(errno.ESRCH, "gone")
        if sig == signal.SIGTERM:
            events.append("term")
            state.alive = False

    monkeypatch.setattr(migration, "_legacy_status_pids", lambda _executable: [123] if state.alive else [])
    monkeypatch.setattr(migration, "_process_executable", lambda _pid: state.executable)
    monkeypatch.setattr(migration, "_process_generation", lambda _pid: state.generation)
    monkeypatch.setattr(migration, "_peer_identity", lambda _client: state.peer)
    monkeypatch.setattr(migration, "_read_status_payload", lambda _client: dict(status))
    monkeypatch.setattr(migration.socket, "socket", lambda *_args: SimpleNamespace(
        settimeout=lambda _timeout: None, connect=lambda _path: None, close=lambda: None,
    ))
    monkeypatch.setattr(migration.os, "kill", kill)
    return SimpleNamespace(
        migration=migration, snapshot=snapshot, executable=executable, payload=payload,
        socket=tmp_path / "status_agent.sock", state=state, status=status, events=events,
        launchctl=lambda _args: SimpleNamespace(returncode=113),
    )


def retire(case):
    case.migration.retire_legacy_status_agent(case.snapshot, case.socket, launchctl=case.launchctl)


def test_idle_launchservices_orphan_is_stopped_once(status_case):
    case = status_case
    retire(case)
    retire(case)
    assert case.events == ["term"]
    assert not case.state.alive


@pytest.mark.parametrize("capture_code", [0, 77, 113])
def test_daemon_down_requires_committed_retirement_and_absent_capture_job(status_case, capture_code):
    case = status_case
    case.status["state"] = "daemonDown"
    with pytest.raises(case.migration.MigrationBlocked, match="active or unknown"):
        retire(case)

    def launchctl(args):
        return SimpleNamespace(returncode=capture_code if args[-1].endswith("/com.yulu.audiodaemon") else 113)

    if capture_code == 113:
        case.migration.retire_legacy_status_agent(
            case.snapshot, case.socket, launchctl=launchctl, capture_retired=True,
        )
        assert case.events == ["term"]
    else:
        with pytest.raises(case.migration.MigrationBlocked, match="Capture is not proven retired"):
            case.migration.retire_legacy_status_agent(
                case.snapshot, case.socket, launchctl=launchctl, capture_retired=True,
            )
        assert case.events == []


@pytest.mark.parametrize("changes", [
    {"state": "recording"}, {"state": "processing"}, {"state": None}, {"ok": False},
    {"dictation_active": True}, {"dictation_active": None},
    {"voice_chat_window_visible": True}, {"voice_chat_window_visible": None},
    {"launcher_pid": 456}, {"launcher_pids": [456]}, {"launcher_pids": None},
])
def test_active_or_unknown_native_work_is_never_signalled(status_case, changes):
    case = status_case
    case.status.update(changes)
    with pytest.raises(case.migration.MigrationBlocked, match="active or unknown"):
        retire(case)
    assert case.events == []
    assert case.state.alive


@pytest.mark.parametrize("identity", ["peer-pid", "peer-uid", "executable", "generation"])
def test_process_identity_must_match_on_both_sides_of_status_probe(status_case, monkeypatch, identity):
    case = status_case
    if identity == "peer-pid":
        case.state.peer = (456, os.geteuid())
    elif identity == "peer-uid":
        case.state.peer = (123, os.geteuid() + 1)
    elif identity == "executable":
        case.state.executable = case.executable.parent / "unrelated"
    else:
        generations = iter([(100, 200), (101, 200)])
        monkeypatch.setattr(case.migration, "_process_generation", lambda _pid: next(generations))
    with pytest.raises(case.migration.MigrationBlocked, match="identity"):
        retire(case)
    assert case.events == []


def test_pid_reuse_after_probe_does_not_signal_replacement(status_case, monkeypatch):
    case = status_case
    generations = iter([(100, 200), (100, 200), (101, 200)])
    monkeypatch.setattr(case.migration, "_process_generation", lambda _pid: next(generations))
    retire(case)
    assert case.events == []


@pytest.mark.parametrize("returncode", [0, 77])
def test_launcher_must_be_proven_gone_before_term(status_case, returncode):
    case = status_case
    case.launchctl = lambda _args: SimpleNamespace(returncode=returncode)
    with pytest.raises(case.migration.MigrationBlocked, match="launcher is not proven stopped"):
        retire(case)
    assert case.events == []


def test_unmanaged_or_ambiguous_process_is_not_stopped(status_case, monkeypatch):
    case = status_case
    case.snapshot["com.yulu.statusagent"]["loaded"] = False
    with pytest.raises(case.migration.MigrationBlocked, match="outside its recorded job"):
        retire(case)
    case.snapshot["com.yulu.statusagent"]["loaded"] = True
    monkeypatch.setattr(case.migration, "_legacy_status_pids", lambda _exe: [123, 456])
    with pytest.raises(case.migration.MigrationBlocked, match="outside its recorded job"):
        retire(case)
    assert case.events == []


def test_timeout_does_not_escalate_to_sigkill(status_case, monkeypatch):
    case = status_case

    def ignore_term(pid, sig):
        assert pid == 123
        assert sig in (0, signal.SIGTERM)
        if sig:
            case.events.append(sig)

    monkeypatch.setattr(case.migration.os, "kill", ignore_term)
    monkeypatch.setattr(case.migration, "_LEGACY_JOB_TRANSITION_TIMEOUT_SECONDS", 0)
    with pytest.raises(case.migration.MigrationBlocked, match="did not stop"):
        retire(case)
    assert case.events == [signal.SIGTERM]


@pytest.mark.parametrize("failure", [OSError("socket unavailable"), ValueError("invalid JSON")])
def test_invalid_or_unavailable_status_is_not_idle(status_case, monkeypatch, failure):
    case = status_case

    def fail(_client):
        raise failure

    monkeypatch.setattr(case.migration, "_read_status_payload", fail)
    with pytest.raises(case.migration.MigrationBlocked, match="cannot prove"):
        retire(case)
    assert case.events == []


@pytest.mark.parametrize("arguments", [
    ["/usr/bin/open", "-W", "/tmp/Other.app"],
    ["/usr/bin/open", "-W", "StatusAgent.app"],
    ["/usr/bin/open", "-W", "/tmp/StatusAgent.app", "--args"],
    ["/tmp/status_agent"], ["/bin/sh", "-c", "anything"],
])
def test_only_recorded_statusagent_launch_forms_are_accepted(migration, arguments):
    snapshot = {"com.yulu.statusagent": {"plistBytes": plistlib.dumps({
        "Label": "com.yulu.statusagent", "ProgramArguments": arguments,
    }).hex()}}
    with pytest.raises(migration.MigrationBlocked, match="executable snapshot is invalid"):
        migration._legacy_status_executable(snapshot)


def test_direct_statusagent_binary_launch_is_supported(status_case):
    case = status_case
    case.payload["ProgramArguments"] = [str(case.executable)]
    case.snapshot["com.yulu.statusagent"]["plistBytes"] = plistlib.dumps(case.payload).hex()
    assert case.migration._legacy_status_executable(case.snapshot) == case.executable


def test_process_discovery_uses_kernel_executable_not_process_name(migration, tmp_path, monkeypatch):
    executable = tmp_path / "StatusAgent.app/Contents/MacOS/status_agent"
    monkeypatch.setattr(migration.subprocess, "run", lambda args, **kwargs: SimpleNamespace(
        returncode=0, stdout=f"123 {executable}\n456 /another/status_agent\n789 /bin/other\n",
    ))
    queried = []

    def process_executable(pid):
        queried.append(pid)
        return executable if pid == 123 else tmp_path / "foreign/status_agent"

    monkeypatch.setattr(migration, "_process_executable", process_executable)
    assert migration._legacy_status_pids(executable) == [123]
    assert queried == [123, 456]


@pytest.mark.parametrize("failure", [OSError("unavailable"), subprocess.TimeoutExpired("ps", 5), None])
def test_process_discovery_failures_are_not_treated_as_no_process(migration, monkeypatch, failure):
    def run(*_args, **_kwargs):
        if failure is not None:
            raise failure
        return SimpleNamespace(returncode=1, stdout="")

    monkeypatch.setattr(migration.subprocess, "run", run)
    with pytest.raises(migration.MigrationBlocked, match="cannot inspect"):
        migration._legacy_status_pids(Path("/tmp/StatusAgent.app/Contents/MacOS/status_agent"))


@pytest.fixture
def transaction_case(status_case, tmp_path):
    case = status_case
    case.agents = tmp_path / "LaunchAgents"
    case.agents.mkdir(mode=0o755)
    case.originals = {
        "com.yulu.statusagent": plistlib.dumps(case.payload),
        "com.yulu.ui": plistlib.dumps({"Label": "com.yulu.ui", "ProgramArguments": ["/old/node"]}),
    }
    for label, raw in case.originals.items():
        (case.agents / f"{label}.plist").write_bytes(raw)
    case.loaded = set(case.originals)

    def launchctl(arguments):
        action = arguments[0]
        label = arguments[-1].rsplit("/", 1)[-1]
        if action == "print-disabled":
            return SimpleNamespace(returncode=0, stdout="{}")
        if action == "print":
            return SimpleNamespace(returncode=0 if label in case.loaded else 113, stdout="")
        case.events.append(f"{action}:{label}")
        if action == "bootout":
            case.loaded.remove(label)
        elif action == "bootstrap":
            case.loaded.add(Path(arguments[-1]).stem)
        return SimpleNamespace(returncode=0, stdout="")

    case.launchctl = launchctl
    case.legacy = tmp_path / "legacy"
    case.legacy.mkdir(mode=0o700)
    (case.legacy / "config.json").write_bytes(b"{}\n")
    case.paths = case.migration.MigrationPaths(tmp_path / "durable", tmp_path / "cache")
    case.archive = tmp_path / "archive"
    snapshot = case.migration.snapshot_legacy_jobs(case.agents, launchctl=launchctl)
    with case.migration.ApplicationMigration(case.paths) as authority:
        authority.begin()
        case.snapshot = authority.record_job_snapshot(snapshot)
    assert "plistBytes" not in case.snapshot["com.yulu.statusagent"]
    case.common = dict(
        paths=case.paths, home_dir=tmp_path, legacy_root=case.legacy,
        launch_agents_dir=case.agents, archive_dir=case.archive,
        legacy_capture_socket=case.legacy / "audio_daemon.sock",
        node_executable=tmp_path / "unused-node", server_js=tmp_path / "unused-server",
        launchctl=launchctl,
    )
    return case


def test_quiesce_retires_app_before_host_and_rollback_restores_jobs(transaction_case):
    case = transaction_case
    with case.migration.ApplicationMigration(case.paths) as authority:
        authority.quiesce_legacy_jobs(
            case.snapshot, launch_agents_dir=case.agents, archive_dir=case.archive,
            launchctl=case.launchctl, legacy_status_socket=case.socket,
            final_capture_idle=lambda: case.events.append("capture-idle"),
        )
        assert case.events[:4] == ["capture-idle", "bootout:com.yulu.statusagent", "term", "bootout:com.yulu.ui"]
        assert not case.state.alive
        assert not case.loaded
        authority.rollback_legacy_jobs(
            case.snapshot, launch_agents_dir=case.agents, archive_dir=case.archive,
            launchctl=case.launchctl,
        )
        assert authority._journal["phase"] == "rolled_back"
    assert case.loaded == set(case.originals)
    for label, raw in case.originals.items():
        assert (case.agents / f"{label}.plist").read_bytes() == raw


@pytest.mark.parametrize("guard", ["status", "capture"])
def test_busy_guard_precedes_any_job_stop_or_archive(transaction_case, guard):
    case = transaction_case

    def capture_idle():
        if guard == "capture":
            raise case.migration.MigrationBlocked("legacy Capture recording is active")

    if guard == "status":
        case.status["dictation_active"] = True
    with case.migration.ApplicationMigration(case.paths) as authority:
        with pytest.raises(case.migration.MigrationBlocked):
            authority.quiesce_legacy_jobs(
                case.snapshot, launch_agents_dir=case.agents, archive_dir=case.archive,
                launchctl=case.launchctl, legacy_status_socket=case.socket,
                final_capture_idle=capture_idle,
            )
    assert case.events == []
    assert case.loaded == set(case.originals)
    assert not case.archive.exists()


@pytest.mark.parametrize("busy", [False, True])
def test_committed_cleanup_never_replays_or_rolls_back_data(transaction_case, monkeypatch, busy):
    case = transaction_case
    with case.migration.ApplicationMigration(case.paths) as authority:
        authority.transition("data_published", intent={"action": "fixture"})
        authority.request_registration()
        authority.transition("committed", intent={"action": "fixture"})
    case.loaded.clear()
    journal = case.paths.journal_path.read_bytes()
    marker = case.paths.durable_root / "recording.wav"
    marker.write_bytes(b"user recording after commit")
    case.status["state"] = "daemonDown"
    if busy:
        case.status["voice_chat_window_visible"] = True

    def unexpected(*_args, **_kwargs):
        pytest.fail("committed cleanup must not publish, roll back, or unregister services")

    monkeypatch.setattr(case.migration.ApplicationMigration, "publish_standard_data", unexpected)
    monkeypatch.setattr(case.migration.ApplicationMigration, "rollback_legacy_jobs", unexpected)
    # A failed cleanup must not enter cancel/retry even if no mutation results.
    inspect = case.migration.inspect_legacy_status_agent
    inspections = []

    def checked(*args, **kwargs):
        inspections.append(True)
        assert args[1] == case.legacy / "status_agent.sock"
        return inspect(*args, **kwargs)

    monkeypatch.setattr(case.migration, "inspect_legacy_status_agent", checked)
    output = io.BytesIO()
    result = case.migration.run_migration_session(
        **case.common, input_stream=io.BytesIO(), output_stream=output,
        service_adapter=unexpected,
    )
    assert result == (75 if busy else 0)
    assert json.loads(output.getvalue())["action"] == ("blocked" if busy else "committed")
    assert len(inspections) == 1
    assert case.events == ([] if busy else ["term"])
    assert case.paths.journal_path.read_bytes() == journal
    assert marker.read_bytes() == b"user recording after commit"
    assert not case.loaded
