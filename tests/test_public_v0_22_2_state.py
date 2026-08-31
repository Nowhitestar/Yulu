from __future__ import annotations

import hashlib
import json
import os
import plistlib
import shutil
import socket
import sqlite3
import subprocess
import tempfile
from pathlib import Path

from test_public_v0_22_2_baseline import COMMIT, TAG, _run as _prepare_baseline


CONFIRMATION = "I-PREPARED-V022-REPRESENTATIVE-STATE"
LABELS = (
    "com.yulu.agentqueue",
    "com.yulu.audiodaemon",
    "com.yulu.calendar",
    "com.yulu.detector",
    "com.yulu.scheduler",
    "com.yulu.statusagent",
    "com.yulu.sttdaemon",
    "com.yulu.ui",
)
PRESENT_LABELS = {
    "com.yulu.audiodaemon",
    "com.yulu.detector",
    "com.yulu.scheduler",
    "com.yulu.statusagent",
    "com.yulu.ui",
}


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_command(path: Path, source: str) -> None:
    path.write_text(f"#!/bin/bash\nset -euo pipefail\n{source}\n")
    path.chmod(0o755)


def _create_db(path: Path, schema: str, insert: str, *, wal: bool = False) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    if wal:
        connection.execute("PRAGMA journal_mode=WAL")
    connection.executescript(schema)
    connection.executescript(insert)
    connection.commit()
    return connection


def _representative_fixture(tmp_path: Path) -> tuple[list[str], dict[str, str], Path, list[sqlite3.Connection], socket.socket, Path]:
    prepared, install_dir, ledger, env = _prepare_baseline(tmp_path)
    assert prepared.returncode == 0, prepared.stderr
    delivery = Path(prepared.args[1]).parent
    home = Path(tempfile.mkdtemp(prefix="yv022-state-", dir="/private/tmp"))
    config_dir = home / ".config" / "yulu"
    media_dir = home / "Movies" / "Yulu"
    launch_agents = home / "Library" / "LaunchAgents"
    for path in (config_dir, media_dir, launch_agents):
        path.mkdir(parents=True, exist_ok=True)

    recording = media_dir / "Representative_20260831_120000.wav"
    transcript = media_dir / "Representative_20260831_120000.transcript.txt"
    summary = media_dir / "Representative_20260831_120000.summary.md"
    recording.write_bytes(b"RIFF representative audio bytes")
    transcript.write_text("private transcript bait")
    summary.write_text("private summary bait")

    config_dir.joinpath("config.json").write_text(json.dumps({
        "calendars": [
            {"type": "macos", "enabled": True, "watch_calendars": []},
            {"type": "google", "enabled": False, "gog_account": "operator@example.com", "watch_calendars": ["primary"]},
        ],
        "audio": {"output_dir": str(media_dir)},
        "agent_pipeline": {"auto_send_notion": True, "notion_destination": "private destination bait"},
    }))
    config_dir.joinpath("mcp-token.json").write_text('{"token":"mcp-secret-bait"}\n')
    for path in (recording, transcript, summary, config_dir / "config.json", config_dir / "mcp-token.json"):
        path.chmod(0o600)

    connections = [
        _create_db(
            config_dir / "prompts.sqlite",
            "CREATE TABLE prompts(slug TEXT, category TEXT, is_auto_run INTEGER);",
            "INSERT INTO prompts VALUES('summary-default','summary',1);",
        ),
        _create_db(
            config_dir / "vocab.sqlite",
            "CREATE TABLE custom_words(term TEXT, canonical TEXT, enabled INTEGER);",
            "INSERT INTO custom_words VALUES('AgentKey','AgentKey',1);",
        ),
        _create_db(
            config_dir / "search.sqlite",
            "CREATE TABLE docs_meta(source_path TEXT, sha256 TEXT);",
            f"INSERT INTO docs_meta VALUES('{transcript}','{'1' * 64}');",
        ),
        _create_db(
            config_dir / "host.sqlite",
            "CREATE TABLE agent_tasks(id TEXT, recording_stem TEXT, state TEXT, send_to_notion INTEGER, created_at TEXT);",
            "INSERT INTO agent_tasks VALUES('task-private-bait','Representative_20260831_120000','completed',1,'2026-08-31T12:00:00Z');",
            wal=True,
        ),
    ]
    # Keep the real SQLite writers open so at least one pre-existing WAL remains.
    connections[-1].execute("INSERT INTO agent_tasks VALUES('wal-row','other','completed',0,'2026-08-31T12:00:01Z')")
    connections[-1].commit()
    for name in ("prompts", "vocab", "search", "host"):
        (config_dir / f"{name}.sqlite").chmod(0o600)
        wal = config_dir / f"{name}.sqlite-wal"
        if wal.exists():
            wal.chmod(0o600)

    for label in PRESENT_LABELS:
        if label == "com.yulu.audiodaemon":
            arguments = [str(install_dir / "yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon")]
            environment = None
        elif label == "com.yulu.statusagent":
            arguments = ["/usr/bin/open", "-W", str(install_dir / "yulu/scripts/StatusAgent.app")]
            environment = None
        elif label == "com.yulu.ui":
            arguments = ["/opt/homebrew/bin/node", str(install_dir / "yulu/scripts/yulu_ui/dist/server.js")]
            environment = {"PATH": "/opt/homebrew/bin:/usr/bin:/bin"}
        else:
            script_name = "scheduler_daemon.py" if label == "com.yulu.scheduler" else "meeting_detector.py"
            arguments = ["/opt/homebrew/bin/python3", str(install_dir / f"yulu/scripts/{script_name}")]
            if label == "com.yulu.detector":
                arguments.append("daemon")
            environment = {"PATH": "/opt/homebrew/bin:/usr/bin:/bin"}
        plist = {
            "Label": label,
            "ProgramArguments": arguments,
        }
        if environment is not None:
            plist["EnvironmentVariables"] = environment
        path = launch_agents / f"{label}.plist"
        path.write_bytes(plistlib.dumps(plist))
        path.chmod(0o600)

    audio_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    audio_socket.bind(str(config_dir / "audio_daemon.sock"))

    fake_bin = tmp_path / "state-system"
    fake_bin.mkdir()
    command_log = tmp_path / "state-commands.log"
    _write_command(fake_bin / "launchctl", r'''
printf 'launchctl|%s\n' "$*" >> "$YULU_V022_STATE_COMMAND_LOG"
if [[ "$1" == "print-disabled" ]]; then
  printf 'disabled services = {\n  "com.yulu.calendar" => true\n}\n'
  exit 0
fi
label="${2##*/}"
case "$label" in
  com.yulu.agentqueue|com.yulu.calendar|com.yulu.sttdaemon) exit 1 ;;
esac
case "$label" in
  com.yulu.ui) pid=4200 ;;
  com.yulu.audiodaemon) pid=4201 ;;
  *) pid=4300 ;;
esac
printf 'service = {\n pid = %s\n state = running\n}\n' "$pid"
''')
    _write_command(fake_bin / "ps", r'''
printf 'ps|%s\n' "$*" >> "$YULU_V022_STATE_COMMAND_LOG"
pid="$2"
if [[ "$pid" == "4201" ]]; then
  printf '%s/yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon\n' "$YULU_V022_STATE_INSTALL_DIR"
else
  printf '/opt/homebrew/bin/node %s/yulu/scripts/yulu_ui/dist/server.js\n' "$YULU_V022_STATE_INSTALL_DIR"
fi
''')
    _write_command(fake_bin / "lsof", r'''
printf 'lsof|%s\n' "$*" >> "$YULU_V022_STATE_COMMAND_LOG"
printf '4201\n'
''')
    _write_command(fake_bin / "security", r'''
printf 'security|%s\n' "$*" >> "$YULU_V022_STATE_COMMAND_LOG"
printf 'keychain: "/Users/operator/Library/Keychains/login.keychain-db"\n'
printf 'class: "genp"\nattributes:\n    "acct"<blob>="token:default:operator@example.com"\n    "svce"<blob>="gogcli"\n'
''')

    observer_env = dict(env)
    observer_env.update({
        "YULU_V022_STATE_TEST_BIN": str(fake_bin),
        "YULU_V022_STATE_TEST_HOME": str(home),
        "YULU_V022_STATE_TEST_APPLICATIONS": env["YULU_V022_BASELINE_TEST_APPLICATIONS"],
        "YULU_V022_STATE_COMMAND_LOG": str(command_log),
        "YULU_V022_STATE_INSTALL_DIR": str(install_dir),
        "YULU_DURABLE_SYNC_POLICY_LOG": str(tmp_path / "state-sync.log"),
    })
    args = [
        "/bin/bash", str(delivery / "launch_public_dmg_acceptance.sh"),
        "--observe-v0.22.2-state", "--policy-test",
        "--run-id", "v022-policy",
        "--evidence-dir", str(ledger.parent),
        "--install-dir", str(install_dir),
        "--recording", str(recording),
        "--keychain-account", "token:default:operator@example.com",
    ]
    return args, observer_env, ledger, connections, audio_socket, home


def test_representative_state_observer_binds_read_only_legacy_baseline_and_resumes(tmp_path: Path) -> None:
    args, env, ledger, connections, audio_socket, home = _representative_fixture(tmp_path)
    try:
        result = subprocess.run(
            args, cwd=tmp_path, env=env, input=f"{CONFIRMATION}\n",
            text=True, capture_output=True, check=False,
        )
        assert result.returncode == 0, result.stderr
        evidence = json.loads(result.stdout)
        assert evidence["formalAcceptance"] is False
        assert evidence["classification"] == "v0.22.2_representative_state_policy_test"
        assert evidence["tag"] == TAG
        assert evidence["sourceCommit"] == COMMIT
        assert evidence["status"] == "migration_before_captured"
        assert evidence["legacyRuntime"]["hostRunning"] is True
        assert evidence["legacyRuntime"]["captureRunning"] is True
        assert evidence["legacyRuntime"]["launchAgentOwnerCount"] == 8
        assert evidence["legacyRuntime"]["presentLaunchAgentCount"] == 5
        assert [job["label"] for job in evidence["legacyRuntime"]["launchAgents"]] == list(LABELS)
        assert {job["label"] for job in evidence["legacyRuntime"]["launchAgents"] if job["present"]} == PRESENT_LABELS
        assert evidence["config"]["autoSendNotion"] is True
        assert evidence["config"]["googleCalendarEnabled"] is False
        assert evidence["config"]["keychainAccountMatchesGoogleCalendar"] is True
        assert evidence["databases"]["allQuickCheckOk"] is True
        assert evidence["databases"]["walPreExisting"] is True
        assert evidence["media"]["audio"]["sha256"] == _sha(Path(evidence["media"]["audio"]["path"]))
        assert evidence["keychain"]["service"] == "gogcli"
        assert evidence["keychain"]["account"] == "token:default:operator@example.com"
        assert evidence["keychain"]["persistentIdentitySha256"]
        assert evidence["binding"]["installEvidenceSha256"] == _sha(ledger / "v0.22.2-baseline.json")

        combined = result.stdout + result.stderr + (ledger / "v0.22.2-representative-state.json").read_text()
        for secret in ("mcp-secret-bait", "private transcript bait", "private summary bait", "private destination bait", "task-private-bait"):
            assert secret not in combined
        assert (ledger.stat().st_mode & 0o777) == 0o700
        assert all((path.stat().st_mode & 0o777) == 0o600 for path in ledger.iterdir())
        sync_calls = (tmp_path / "state-sync.log").read_text().splitlines()
        assert any(call.startswith(str(ledger / ".v0.22.2-representative-state.state.")) for call in sync_calls)
        assert any(call.startswith(str(ledger / ".v0.22.2-representative-state.json.")) for call in sync_calls)
        assert len(sync_calls) % 2 == 0
        assert all(call.startswith(str(ledger / ".")) for call in sync_calls[::2])
        assert sync_calls[1::2] == [str(ledger)] * (len(sync_calls) // 2)

        resumed = subprocess.run(
            args, cwd=tmp_path, env=env, input="",
            text=True, capture_output=True, check=False,
        )
        assert resumed.returncode == 0, resumed.stderr
        assert json.loads(resumed.stdout) == evidence

        commands = Path(env["YULU_V022_STATE_COMMAND_LOG"]).read_text().splitlines()
        security_calls = [line for line in commands if line.startswith("security|")]
        assert security_calls == [
            "security|find-generic-password -s gogcli -a token:default:operator@example.com",
            "security|find-generic-password -s gogcli -a token:default:operator@example.com",
        ]
        assert all(flag not in " ".join(security_calls) for flag in (" -g", " -w", " -A", " -T"))
        assert all(
            line.startswith(("launchctl|print ", "launchctl|print-disabled ", "ps|", "lsof|", "security|find-generic-password "))
            for line in commands
        )
    finally:
        audio_socket.close()
        for connection in connections:
            connection.close()
        shutil.rmtree(home)


def test_representative_state_observer_fails_closed_for_nonrepresentative_state(tmp_path: Path) -> None:
    cases = ("auto-send", "launch-agents", "wal", "current-root", "keychain-secret")
    for case in cases:
        root = tmp_path / case
        root.mkdir()
        args, env, _ledger, connections, audio_socket, home = _representative_fixture(root)
        try:
            config_dir = home / ".config" / "yulu"
            if case == "auto-send":
                config = json.loads((config_dir / "config.json").read_text())
                config["agent_pipeline"]["auto_send_notion"] = False
                (config_dir / "config.json").write_text(json.dumps(config))
                (config_dir / "config.json").chmod(0o600)
            elif case == "launch-agents":
                extra = home / "Library/LaunchAgents/com.yulu.unowned.plist"
                extra.write_bytes(plistlib.dumps({"Label": "com.yulu.unowned", "ProgramArguments": ["/bin/false"]}))
                extra.chmod(0o600)
            elif case == "wal":
                for connection in connections:
                    connection.close()
                connections.clear()
                assert not any(config_dir.glob("*.sqlite-wal"))
            elif case == "current-root":
                (home / "Library/Application Support/Yulu").mkdir(parents=True)
            else:
                fake_security = Path(env["YULU_V022_STATE_TEST_BIN"]) / "security"
                _write_command(fake_security, "printf '%s\\n' 'password: keychain-secret-bait'")
            result = subprocess.run(
                args, cwd=root, env=env, input=f"{CONFIRMATION}\n",
                text=True, capture_output=True, check=False,
            )
            assert result.returncode != 0, case
            assert any(
                phrase in result.stderr.lower()
                for phrase in ("auto_send_notion", "allowlist", "wal sidecar", "current standard", "keychain attributes")
            ), (case, result.stderr)
            assert not (Path(args[args.index("--evidence-dir") + 1]) / "v022-policy/v0.22.2-representative-state.json").exists()
            assert "keychain-secret-bait" not in result.stdout + result.stderr
        finally:
            audio_socket.close()
            for connection in connections:
                connection.close()
            shutil.rmtree(home)


def test_completed_representative_state_rejects_media_or_baseline_binding_drift(tmp_path: Path) -> None:
    for case in ("media", "baseline"):
        root = tmp_path / case
        root.mkdir()
        args, env, ledger, connections, audio_socket, home = _representative_fixture(root)
        try:
            first = subprocess.run(
                args, cwd=root, env=env, input=f"{CONFIRMATION}\n",
                text=True, capture_output=True, check=False,
            )
            assert first.returncode == 0, first.stderr
            if case == "media":
                Path(args[args.index("--recording") + 1]).with_suffix(".transcript.txt").write_text("changed private transcript")
                Path(args[args.index("--recording") + 1]).with_suffix(".transcript.txt").chmod(0o600)
            else:
                baseline = ledger / "v0.22.2-baseline.json"
                baseline.write_text(baseline.read_text().replace('"status":"installed"', '"status":"installed" '))
                baseline.chmod(0o600)
            resumed = subprocess.run(
                args, cwd=root, env=env, input="", text=True,
                capture_output=True, check=False,
            )
            assert resumed.returncode != 0, case
            assert "drift" in resumed.stderr.lower() or "malformed" in resumed.stderr.lower()
        finally:
            audio_socket.close()
            for connection in connections:
                connection.close()
            shutil.rmtree(home)


def test_policy_observer_rejects_cross_mode_baseline_evidence(tmp_path: Path) -> None:
    args, env, ledger, connections, audio_socket, home = _representative_fixture(tmp_path)
    try:
        baseline = ledger / "v0.22.2-baseline.json"
        evidence = json.loads(baseline.read_text())
        evidence["classification"] = "formal_v0.22.2_baseline_observation"
        evidence["publicAssetVerified"] = True
        baseline.write_text(json.dumps(evidence, separators=(",", ":")))
        baseline.chmod(0o600)
        result = subprocess.run(
            args, cwd=tmp_path, env=env, input=f"{CONFIRMATION}\n",
            text=True, capture_output=True, check=False,
        )
        assert result.returncode != 0
        assert "cross-mode" in result.stderr.lower()
        assert not (ledger / "v0.22.2-representative-state.json").exists()
    finally:
        audio_socket.close()
        for connection in connections:
            connection.close()
        shutil.rmtree(home)


def test_representative_state_source_is_read_only_and_never_exports_keychain_secrets() -> None:
    source = (Path(__file__).resolve().parents[1] / "packaging/acceptance/observe_v0_22_2_state.sh").read_text()
    assert "find-generic-password -s gogcli -a" in source
    security_line = next(line for line in source.splitlines() if "find-generic-password" in line and "KEYCHAIN_ATTRIBUTES=" in line)
    assert all(flag not in security_line for flag in (" -g", " -w", " -A", " -T"))
    assert "-readonly" in source
    assert "PRAGMA query_only=ON" in source
    for forbidden in (
        "PRAGMA journal_mode", "wal_checkpoint", "INSERT INTO", "UPDATE ", "DELETE FROM",
        "launchctl load", "launchctl unload", " bootstrap ", " bootout ", " kickstart ",
        "/bin/touch", "/usr/bin/touch", "/bin/cp", "curl", "wget", "osascript",
        "sharing.testShare", "shareRecording", "/api/ui-token",
    ):
        assert forbidden not in source
