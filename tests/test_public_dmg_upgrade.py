from __future__ import annotations

import json
import hashlib
import os
import subprocess
from pathlib import Path

from test_public_v0_22_2_state import CONFIRMATION, _representative_fixture
from test_public_dmg_harness import REVISION, _build


ROOT = Path(__file__).resolve().parents[1]
ACCEPTANCE = ROOT / "packaging" / "acceptance"
OBSERVER = ACCEPTANCE / "observe_upgrade.mjs"
DRIVER = ACCEPTANCE / "public_dmg_upgrade_target.sh"


def test_upgrade_harness_has_two_manual_resumable_journeys_and_no_mutation_surface() -> None:
    observer = OBSERVER.read_text()
    driver = DRIVER.read_text()

    for journey in ("upgrade-success", "upgrade-cancel-retry"):
        assert journey in driver
    for checkpoint in (
        "awaiting_approval",
        "committed",
        "rolled_back",
        "rolled_back_stable",
        "retry_awaiting_approval",
        "committed_stable",
    ):
        assert checkpoint in observer

    assert "ACTION_REQUIRED" in driver
    assert "Cancel Service Migration" in driver
    assert "Retry Service Migration" in driver
    assert "operatorSnapshotWitnessSha256" in driver
    assert "post-commit-restart-login" in driver
    assert "check-for-updates-no-update" in driver
    assert "formalAcceptance\":false" in driver

    combined = observer + driver
    for forbidden in (
        "application_migration.py",
        "--request-retry",
        "launchctl bootstrap",
        "launchctl bootout",
        "security -w",
        "security -g",
        "sharing.testShare",
        "shareRecording",
        "osascript",
    ):
        assert forbidden not in combined
    for secret_flag in ('"-g"', '"-w"', '"-A"', '"-T"'):
        assert secret_flag not in observer
    assert '"find-generic-password", "-s", "gogcli", "-a"' in observer
    assert '["-readonly", "-cmd", "PRAGMA query_only=ON;"' in observer


def test_upgrade_observer_rejects_non_installed_node_outside_policy_mode() -> None:
    result = subprocess.run(
        [
            "node",
            str(OBSERVER),
            "--mode",
            "awaiting_approval",
            "--release-tag",
            "v0.23.0-rc.8",
            "--snapshot-witness-sha256",
            "a" * 64,
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert "installed Application Runtime Node" in result.stderr


def test_upgrade_delivery_contract_includes_observer_and_driver() -> None:
    builder = (ACCEPTANCE / "build_public_dmg_harness.sh").read_text()
    launcher = (ACCEPTANCE / "launch_public_dmg_acceptance.sh").read_text()
    for name in ("observe_upgrade.mjs", "public_dmg_upgrade_target.sh"):
        assert name in builder
        assert name in launcher
    assert "--run-upgrade" in launcher


def test_upgrade_policy_output_can_never_be_formal() -> None:
    # Static fail-closed contract: every harness-authored result is explicitly
    # non-formal. Real acceptance is an operator-reviewed evidence ledger.
    for path in (OBSERVER, DRIVER):
        source = path.read_text()
        assert "formalAcceptance" in source
        assert "formalAcceptance: true" not in source
        assert 'formalAcceptance\":true' not in source


def test_retry_pre_begin_and_post_begin_snapshots_remain_two_fresh_reads() -> None:
    source = (ROOT / "yulu" / "scripts" / "application_migration.py").read_text()
    migration = source.split("def run_migration_step(", 1)[1].split("\ndef ", 1)[0]
    # Deliberate duplication is a TOCTOU defense: Retry preflight and the
    # post-begin transaction must independently re-read the legacy job state.
    assert migration.count("snapshot_legacy_jobs(") == 2
    begin = migration.index("authority.begin_retry(")
    assert migration.index("snapshot_legacy_jobs(") < begin
    assert migration.rindex("snapshot_legacy_jobs(") > begin


def _write_command(path: Path, body: str) -> None:
    path.write_text(f"#!/bin/bash\nset -euo pipefail\n{body}\n")
    path.chmod(0o755)


def _private_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, separators=(",", ":")) + "\n")
    path.chmod(0o600)


def test_upgrade_observer_binds_migration_before_and_requires_real_retry_lineage(tmp_path: Path) -> None:
    legacy_args, legacy_env, ledger, connections, audio_socket, home = _representative_fixture(tmp_path)
    try:
        captured = subprocess.run(
            legacy_args,
            cwd=tmp_path,
            env=legacy_env,
            input=f"{CONFIRMATION}\n",
            text=True,
            capture_output=True,
            check=False,
        )
        assert captured.returncode == 0, captured.stderr
        before_path = ledger / "v0.22.2-representative-state.json"
        before = json.loads(before_path.read_text())

        current_preflight = tmp_path / "current-preflight.json"
        _private_json(current_preflight, {
            "schema": 1,
            "formalAcceptance": False,
            "status": "passed",
            "scenario": "upgrade",
            "releaseTag": "v0.23.0-rc.8",
            "dmgUrl": "https://github.com/Nowhitestar/Yulu/releases/download/v0.23.0-rc.8/yulu-macos-arm64-v0.23.0-rc.8.dmg",
            "checksumsUrl": "https://github.com/Nowhitestar/Yulu/releases/download/v0.23.0-rc.8/checksums.txt",
            "architecture": "arm64",
            "hostDependenciesAbsent": False,
            "browserProvenanceVerified": True,
            "dmgSha256": "1" * 64,
            "checksumsSha256": "2" * 64,
            "harnessManifestSha256": "3" * 64,
            "sourceRevision": "4" * 40,
        })
        bundle_evidence = tmp_path / "bundle-evidence.json"
        _private_json(bundle_evidence, {
            "schema": 1,
            "classification": "harness_policy_test",
            "formalAcceptance": False,
            "status": "matched",
            "release": {"shortVersion": "0.23.0-rc.8", "releaseVersion": "0.23.0-rc.8"},
            "contents": {"sha256": "5" * 64},
            "runtimeInventory": {"sha256": "6" * 64},
        })
        applications = tmp_path / "Applications"
        fixture_app = applications / "Yulu.app"
        installed_files = {
            "Info.plist": fixture_app / "Contents/Info.plist",
            "audio_daemon": fixture_app / "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
            "node": fixture_app / "Contents/Resources/runtime/bin/node",
            "server.js": fixture_app / "Contents/Resources/Host/server.js",
            "yulu_app": fixture_app / "Contents/MacOS/yulu_app",
        }
        for name, path in installed_files.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"{name} fixture\n")
        system_bin = tmp_path / "upgrade-system"
        system_bin.mkdir()
        _write_command(system_bin / "security", '''
printf 'keychain: "/Users/operator/Library/Keychains/login.keychain-db"\n'
printf 'class: "genp"\nattributes:\n    "acct"<blob>="token:default:operator@example.com"\n    "svce"<blob>="gogcli"\n'
''')

        jobs = {}
        for item in before["legacyRuntime"]["launchAgents"]:
            jobs[item["label"]] = {
                "loaded": item["loaded"],
                "disabled": item["disabled"],
                "launchAgentsDevice": 1,
                "launchAgentsInode": 2,
                "plistSHA256": item["plistSha256"],
                "plistMode": None if item["plistMode"] is None else int(item["plistMode"], 8),
                "plistSnapshot": None if not item["present"] else f"rollback-snapshots/{'a' * 32}/{item['label']}.plist",
            }
        journal_path = tmp_path / "journal.json"
        first_id = "a" * 32
        first_nonce = "b" * 32
        first_journal = {
            "schemaVersion": 1,
            "transactionId": first_id,
            "phase": "awaiting_approval",
            "intent": {"action": "await-approval"},
            "serviceNonce": first_nonce,
            "attemptNumber": 1,
            "bundleManifest": {
                name: hashlib.sha256(path.read_bytes()).hexdigest()
                for name, path in installed_files.items()
            },
            "jobSnapshot": jobs,
        }
        _private_json(journal_path, first_journal)

        base_args = [
            "node", str(OBSERVER), "--policy-test",
            "--release-tag", "v0.23.0-rc.8",
            "--before", str(before_path),
            "--current-preflight", str(current_preflight),
            "--bundle-evidence", str(bundle_evidence),
            "--journal", str(journal_path),
            "--home", str(home),
            "--applications-root", str(applications),
            "--system-bin", str(system_bin),
            "--snapshot-witness-sha256", "7" * 64,
        ]
        awaiting = subprocess.run(
            [*base_args, "--mode", "awaiting_approval"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        assert awaiting.returncode == 0, awaiting.stderr
        awaiting_evidence = json.loads(awaiting.stdout)
        assert awaiting_evidence["classification"] == "upgrade_migration_policy_test"
        assert awaiting_evidence["formalAcceptance"] is False
        assert awaiting_evidence["migrationBeforeSha256"] == hashlib.sha256(before_path.read_bytes()).hexdigest()
        assert awaiting_evidence["transaction"]["idSha256"] == hashlib.sha256(first_id.encode()).hexdigest()
        assert "operator@example.com" not in awaiting.stdout
        assert "private transcript bait" not in awaiting.stdout

        prior = tmp_path / "rolled-stable.json"
        prior_value = {
            **awaiting_evidence,
            "checkpoint": "rolled_back_stable",
            "journalSha256": "8" * 64,
        }
        _private_json(prior, prior_value)
        retry_id = "c" * 32
        retry_nonce = "d" * 32
        retry_jobs = json.loads(json.dumps(jobs))
        for item in retry_jobs.values():
            if item["plistSnapshot"] is not None:
                item["plistSnapshot"] = f"rollback-snapshots/{retry_id}/snapshot.plist"
        retry_journal = {
            **first_journal,
            "transactionId": retry_id,
            "serviceNonce": retry_nonce,
            "attemptNumber": 2,
            "retryOf": first_id,
            "retryRoot": first_id,
            "jobSnapshot": retry_jobs,
        }
        _private_json(journal_path, retry_journal)
        retry = subprocess.run(
            [*base_args, "--mode", "retry_awaiting_approval", "--prior-evidence", str(prior)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        assert retry.returncode == 0, retry.stderr
        retry_evidence = json.loads(retry.stdout)
        assert retry_evidence["transaction"]["attemptNumber"] == 2
        assert retry_evidence["transaction"]["retryOfSha256"] == hashlib.sha256(first_id.encode()).hexdigest()

        retry_journal["retryOf"] = "e" * 32
        _private_json(journal_path, retry_journal)
        stale = subprocess.run(
            [*base_args, "--mode", "retry_awaiting_approval", "--prior-evidence", str(prior)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        assert stale.returncode != 0
        assert "lineage" in stale.stderr
    finally:
        audio_socket.close()
        for connection in connections:
            connection.close()


def _run_driver(tmp_path: Path, journey: str, operator_input: str) -> tuple[subprocess.CompletedProcess[str], Path]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    delivery = tmp_path / "delivery"
    if not delivery.exists():
        built = _build(delivery)
        assert built.returncode == 0, built.stderr
    manifest_sha = hashlib.sha256((delivery / "manifest.sha256").read_bytes()).hexdigest()
    before = tmp_path / "migration-before.json"
    preflight = tmp_path / "preflight.json"
    bundle = tmp_path / "bundle.json"
    journal = tmp_path / "journal.json"
    _private_json(before, {"formalAcceptance": False, "private": "before bait"})
    _private_json(preflight, {
        "harnessManifestSha256": manifest_sha,
        "sourceRevision": REVISION,
        "formalAcceptance": False,
    })
    _private_json(bundle, {"formalAcceptance": False, "status": "matched"})
    _private_json(journal, {"phase": "policy-fixture"})
    home = tmp_path / "home"
    applications = tmp_path / "Applications"
    system_bin = tmp_path / "system-bin"
    for path in (home, applications, system_bin):
        path.mkdir(exist_ok=True)
    mounted_app = tmp_path / "mounted" / "Yulu.app"
    installed_app = applications / "Yulu.app"
    mounted_app.mkdir(parents=True, exist_ok=True)
    installed_app.mkdir(exist_ok=True)
    codesign = system_bin / "codesign"
    _write_command(codesign, "exit 0")
    installed_node = tmp_path / "installed-node"
    _write_command(installed_node, '''
mode=""
for ((index=1; index<=$#; index++)); do
  if [[ "${!index}" == "--mode" ]]; then next=$((index + 1)); mode="${!next}"; fi
done
printf '{"schema":1,"classification":"policy-fake-observer","formalAcceptance":false,"checkpoint":"%s"}\n' "$mode"
''')
    result = subprocess.run(
        [
            "/bin/bash", str(delivery / "launch_public_dmg_acceptance.sh"),
            "--run-upgrade", "--policy-test",
            "--journey", journey,
            "--run-id", f"{journey}-policy",
            "--release-tag", "v0.23.0-rc.8",
            "--migration-before", str(before),
            "--current-preflight", str(preflight),
            "--bundle-evidence", str(bundle),
            "--evidence-dir", str(tmp_path / "evidence"),
            "--installed-node", str(installed_node),
            "--journal", str(journal),
            "--home", str(home),
            "--applications-root", str(applications),
            "--system-bin", str(system_bin),
            "--journey-base-url", "http://127.0.0.1:47123",
            "--mounted-app", str(mounted_app),
            "--codesign", str(codesign),
        ],
        cwd=tmp_path,
        env={
            **os.environ,
            "PATH": "/usr/bin:/bin",
            "YULU_DURABLE_SYNC_POLICY_LOG": str(tmp_path / "sync.log"),
        },
        input=operator_input,
        text=True,
        capture_output=True,
        check=False,
    )
    return result, tmp_path / "evidence" / f"{journey}-policy"


def test_upgrade_driver_runs_success_and_cancel_retry_only_through_manual_checkpoints(tmp_path: Path) -> None:
    success_input = "\n".join([
        "vm-snapshot-private-bait",
        "I-BOUND-V022-SNAPSHOT",
        "I-SAW-MIGRATION-AWAITING-APPROVAL",
        "I-APPROVED-AND-SAW-MIGRATION-COMMIT",
        "I-QUIT-LOGGED-IN-AND-RELAUNCHED-YULU",
        "I-SAW-NO-UPDATE-AVAILABLE-IN-YULU",
        "",
    ])
    success, success_ledger = _run_driver(tmp_path / "success", "upgrade-success", success_input)
    assert success.returncode == 0, success.stderr
    assert "ACTION_REQUIRED upgrade-awaiting-approval" in success.stdout
    assert "ACTION_REQUIRED upgrade-approve-and-commit" in success.stdout
    assert "ACTION_REQUIRED post-commit-restart-login" in success.stdout
    assert "ACTION_REQUIRED check-for-updates-no-update" in success.stdout
    assert "vm-snapshot-private-bait" not in success.stdout + success.stderr
    assert json.loads(success.stdout.splitlines()[-1])["formalAcceptance"] is False
    assert "phase=completed" in (success_ledger / "upgrade.state").read_text()
    sync_calls = (tmp_path / "success" / "sync.log").read_text().splitlines()
    assert any(call.startswith(str(success_ledger / ".upgrade.state.")) for call in sync_calls)
    assert len(sync_calls) % 2 == 0
    assert all(call.startswith(str(success_ledger / ".")) for call in sync_calls[::2])
    assert sync_calls[1::2] == [str(success_ledger)] * (len(sync_calls) // 2)

    cancel_input = "\n".join([
        "apfs-snapshot-private-bait",
        "I-BOUND-V022-SNAPSHOT",
        "I-SAW-MIGRATION-AWAITING-APPROVAL",
        "I-CANCELLED-MIGRATION-IN-APP",
        "I-RELAUNCHED-WITHOUT-AUTO-RETRY",
        "I-USED-VISIBLE-RETRY",
        "I-APPROVED-AND-SAW-MIGRATION-COMMIT",
        "I-QUIT-LOGGED-IN-AND-RELAUNCHED-YULU",
        "I-SAW-NO-UPDATE-AVAILABLE-IN-YULU",
        "",
    ])
    cancelled, cancel_ledger = _run_driver(tmp_path / "cancel", "upgrade-cancel-retry", cancel_input)
    assert cancelled.returncode == 0, cancelled.stderr
    for checkpoint in (
        "upgrade-cancel",
        "upgrade-no-auto-retry",
        "upgrade-explicit-retry",
        "upgrade-approve-and-commit",
    ):
        assert f"ACTION_REQUIRED {checkpoint}" in cancelled.stdout
    assert "apfs-snapshot-private-bait" not in cancelled.stdout + cancelled.stderr
    assert "phase=completed" in (cancel_ledger / "upgrade.state").read_text()
    for name in (
        "upgrade-rolled-back.json",
        "upgrade-rolled-back-stable.json",
        "upgrade-retry-awaiting-approval.json",
        "upgrade-committed.json",
        "post-commit-baseline.json",
        "post-commit-restart-login.json",
        "check-for-updates-no-update.json",
    ):
        assert (cancel_ledger / name).stat().st_mode & 0o777 == 0o600

    resumed, _ = _run_driver(tmp_path / "cancel", "upgrade-cancel-retry", "")
    assert resumed.returncode == 0, resumed.stderr
    assert "ACTION_REQUIRED" not in resumed.stdout
