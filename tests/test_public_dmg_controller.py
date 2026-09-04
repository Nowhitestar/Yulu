from __future__ import annotations

import json
import hashlib
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
ACCEPTANCE = ROOT / "packaging" / "acceptance"
CONTROLLER = ACCEPTANCE / "validate_returned_public_dmg.py"
TAG = "v0.23.0-rc.10"
_POLICY_MANIFESTS: dict[str, str] = {}


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _policy_manifest_sha(revision: str) -> str:
    if revision in _POLICY_MANIFESTS:
        return _POLICY_MANIFESTS[revision]
    with tempfile.TemporaryDirectory(prefix="yulu-controller-fixture.") as root:
        output = Path(root) / "harness"
        result = subprocess.run(
            [
                "/bin/bash", str(ACCEPTANCE / "build_public_dmg_harness.sh"),
                "--policy-test", "--source-revision", revision, "--output", str(output),
            ],
            text=True, capture_output=True, check=False,
        )
        assert result.returncode == 0, result.stderr
        value = _sha(output / "manifest.sha256")
    _POLICY_MANIFESTS[revision] = value
    return value


def _private_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, separators=(",", ":")) + "\n")
    path.chmod(0o600)


def _command(path: Path, body: str) -> None:
    path.write_text(f"#!/bin/bash\nset -euo pipefail\n{body}\n")
    path.chmod(0o755)


def _returned_fixture(tmp_path: Path, scenario: str, journey: str | None) -> tuple[Path, Path, Path, Path]:
    revision = "a" * 40
    dmg = tmp_path / f"yulu-macos-arm64-{TAG}.dmg"
    checksums = tmp_path / "checksums.txt"
    dmg.write_bytes(b"public rc10 fixture")
    checksums.write_text(f"{_sha(dmg)}  {dmg.name}\n")
    ledger = tmp_path / "ledger"
    ledger.mkdir(mode=0o700)
    ledger.chmod(0o700)
    tools = tmp_path / "tools"
    tools.mkdir()
    calls = tmp_path / "authority-calls"
    _command(tools / "git", f"printf '%s\\n' {revision}")
    _command(tools / "gh", f"printf 'gh %s\\n' \"$*\" >> {calls!s}")
    _command(tools / "verify_dmg.sh", f"printf 'verify %s\\n' \"$*\" >> {calls!s}")

    harness_sha = _policy_manifest_sha(revision)
    preflight = {
        "schema": 1, "formalAcceptance": False, "status": "passed", "scenario": scenario,
        "releaseTag": TAG, "dmgSha256": _sha(dmg), "checksumsSha256": _sha(checksums),
        "dmgUrl": f"https://github.com/Nowhitestar/Yulu/releases/download/{TAG}/{dmg.name}",
        "checksumsUrl": f"https://github.com/Nowhitestar/Yulu/releases/download/{TAG}/checksums.txt",
        "architecture": "arm64", "macOSVersion": "14.7", "browserProvenanceVerified": True,
        "hostDependenciesAbsent": scenario == "fresh", "harnessBuildMode": "policy-test", "harnessManifestSha256": harness_sha,
        "sourceRevision": revision,
    }
    _private_json(ledger / "preflight.json", preflight)
    _private_json(ledger / "mount.json", {"schema": 1, "readOnly": True, "noBrowse": True, "noAutoOpen": True, "volumeName": "Yulu"})
    signatures = {
        name: {"teamIdentifier": "WMU9678ZQL", "cdHash": char * 64, "identifier": f"com.yulu.{name}"}
        for name, char in (("application", "1"), ("host", "2"), ("capture", "3"))
    }
    bundle = {
        "schema": 1, "classification": "harness_policy_test", "formalAcceptance": False,
        "status": "matched", "release": {"bundleIdentifier": "com.yulu.app", "shortVersion": "0.23.0",
        "releaseVersion": "0.23.0-rc.10", "buildVersion": "23"},
        "node": {"version": "v22.19.0", "architecture": "arm64", "executableSha256": "4" * 64},
        "runtimeInventory": {"sha256": "5" * 64, "files": 10, "bytes": 100},
        "contents": {"sha256": "6" * 64, "entries": 20, "bytes": 200}, "signatures": signatures,
    }
    for name in ("bundle-observation.json", "bundle-restart-login.json", "bundle-no-update.json"):
        _private_json(ledger / name, bundle)

    optional = {
        "onboardingVersion": "phase-13-v1", "currentCompleted": True,
        "capabilities": [
            {"id": "conversation", "contractVersion": "conversation-v1", "outcome": "deferred"},
            {"id": "calendar-source", "contractVersion": "calendar-source-v1", "outcome": "adopted"},
            {"id": "agent-calendar-connector", "contractVersion": "agent-calendar-connector-v1", "outcome": "deferred"},
            {"id": "sharing", "contractVersion": "sharing-v1", "outcome": "adopted"},
        ],
    }
    health = {"status": "ok", "serviceOwner": "com.yulu.ui", "databaseStatus": "ok", "database": {"schemaVersion": 13, "minimumReadableVersion": 12}}
    common_journey = {
        "schema": 1, "classification": "journey_policy_test", "formalAcceptance": False,
        "releaseTag": TAG, "health": health, "version": {"product": "0.23.0-rc.10"},
        "ipc": {"transport": "ipv4-loopback-http", "readOnly": True},
    }
    core = {
        "activation": {
            "provider": {"transcription": "xai", "summary": "xai", "model": "grok-4.6"},
            "artifacts": {
                "audio": {"sha256": "1" * 64, "bytes": 101},
                "transcript": {"sha256": "2" * 64, "bytes": 202},
                "summary": {"sha256": "3" * 64, "bytes": 303},
            },
            "sourceArtifacts": {"audio": True, "transcript": True, "summary": True},
        },
        "recording": {
            "opaqueIdSha256": "4" * 64, "count": 1,
            "transcriptCurrent": True, "summaryCurrent": True,
        },
        "task": {
            "opaqueIdSha256": "5" * 64, "state": "completed",
            "sendToNotion": False, "deliverySessionId": None,
        },
        "onboarding": {"installationKind": "fresh", "coreCompleted": True},
    }
    unshared = {"status": "untested", "actionPresent": False, "receiptPresent": False}
    post_upgrade_id = "d" * 64
    post_upgrade_journal = "e" * 64
    if scenario == "fresh":
        (ledger / "service-baseline.txt").write_text("all-known-yulu-launchagents=absent\n")
        (ledger / "guidance-checkpoint.txt").write_text("confirmed-with-zero-service-mutation\n")
        (ledger / "service-baseline.txt").chmod(0o600)
        (ledger / "guidance-checkpoint.txt").chmod(0o600)
        _private_json(ledger / "journey-baseline.json", {
            **common_journey, "checkpoint": "baseline",
            "onboarding": {"installationKind": "fresh", "coreCompleted": False},
            "recordings": {"count": 0}, "sharing": unshared,
        })
        zero = {"actionCounts": {"total": 0, "verified": 0}}
        _private_json(ledger / "journey-core-activation.json", {
            **common_journey, **core, "checkpoint": "core-activation",
            "sharing": unshared, "productionShare": zero,
        })
        pending = {**optional, "currentCompleted": False, "capabilities": [*optional["capabilities"][:-1], {"id": "sharing", "contractVersion": "sharing-v1", "outcome": "pending-verified-test-share"}]}
        pre_binding = {"connectionIdentitySha256": "6" * 64, "destinationSha256": "7" * 64, "connector": "notion"}
        _private_json(ledger / "pre-test-share.json", {
            **common_journey, **core, "checkpoint": "pre-test-share",
            "sharing": {"status": "untested", "connectorProbe": "ready", "binding": pre_binding, "optionalOutcomes": pending},
            "operatorAttestation": {"externalDestinationNoRunMarkerConfirmed": True},
            "productionShare": zero,
        })
        binding = {
            "snapshotSha256": "8" * 64, "summarySha256": "9" * 64,
            "recordingIdSha256": "a" * 64, "connectionSha256": "b" * 64,
            "destinationSha256": "7" * 64, "connector": "notion",
        }
        test_share = {
            "status": "verified", "adoption": "adopted",
            "actionIdSha256": "c" * 64, "receiptIdentitySha256": "d" * 64,
            "connectionIdentitySha256": "e" * 64, "destinationSha256": "7" * 64,
            "connector": "notion", "contentSha256": "f" * 64,
            "optionalOutcomes": optional,
        }
        for name, checkpoint in (("test-share.json", "test-share"), ("pre-production-share.json", "pre-production-share"), ("production-share-cancelled.json", "production-share-cancelled")):
            _private_json(ledger / name, {**common_journey, **core, "checkpoint": checkpoint, "test_share": test_share, "productionShare": {"actionCounts": {"total": 0, "verified": 0}, "binding": binding}})
        final = {
            **common_journey, **core, "checkpoint": "production-share", "test_share": test_share,
            "productionShare": {
                "actionCounts": {"total": 1, "verified": 1}, "binding": binding,
                "latestAction": {"opaqueIdSha256": "1" * 64, "status": "verified", "receiptIdentitySha256": "2" * 64},
            },
        }
        for name in ("production-share.json", "journey-restart-login.json", "journey-no-update.json"):
            _private_json(ledger / name, final)
        (ledger / "state").write_text(f"schema=1\ntag={TAG}\ndmg_sha256={_sha(dmg)}\nphase=completed\n")
    else:
        assert journey is not None
        migration_sha = "9" * 64
        (ledger / "state").write_text(f"schema=1\ntag={TAG}\ndmg_sha256={_sha(dmg)}\nphase=awaiting_finder_drag\n")
        (ledger / "upgrade.state").write_text(
            f"schema=1\njourney={journey}\nrelease_tag={TAG}\nmigration_before_sha256={migration_sha}\n"
            f"current_preflight_sha256={_sha(ledger / 'preflight.json')}\nbundle_evidence_sha256={_sha(ledger / 'bundle-observation.json')}\n"
            f"operator_snapshot_witness_sha256={'a' * 64}\nphase=completed\n"
        )
        baseline = {
            "sourceCommit": "2d01fa2989c1a9ae1a95266438bb278c72fac8c3",
            "recordingIdSha256": "3" * 64,
            "runtime": {
                "hostRunning": True, "captureRunning": True, "socketOwnedByCapture": True,
                "launchAgentOwnerCount": 8, "hostPidSha256": "e" * 64, "capturePidSha256": "f" * 64,
                "hostLabel": "com.yulu.ui", "captureLabel": "com.yulu.audiodaemon",
                "hostTargetPathSha256": "5" * 64, "captureExecutablePathSha256": "6" * 64,
                "captureSocketPathSha256": "7" * 64,
            },
            "databases": {
                "allQuickCheckOk": True, "walPreExisting": True,
                "wal": {"database": "host", "sha256": "4" * 64, "bytes": 4096, "preExisting": True},
                "items": {
                    name: {"quickCheck": "ok", "schemaSha256": char * 64, "sentinelSha256": str(index + 1) * 64}
                    for index, (name, char) in enumerate((("prompts", "d"), ("vocab", "e"), ("search", "f"), ("host", "a")))
                },
            },
            "config": {
                "configSha256": "5" * 64, "autoSendNotion": True,
                "googleCalendarEnabled": False, "keychainAccountMatchesGoogleCalendar": True,
                "mcpTokenSha256": "6" * 64,
            },
            "keychain": {"service": "gogcli", "attributesSha256": "7" * 64, "persistentIdentitySha256": "8" * 64},
            "media": {
                name: {"device": index + 1, "inode": index + 11, "bytes": (index + 1) * 100, "sha256": char * 64}
                for index, (name, char) in enumerate((("audio", "a"), ("transcript", "b"), ("summary", "c")))
            },
        }
        upgrade_journey = {
            **common_journey, "checkpoint": "upgrade-post", "migrationBeforeSha256": migration_sha,
            "productionShare": {"actionCounts": {"total": 0, "verified": 0}},
            "onboarding": {"installationKind": "returning", "sharingAdopted": False},
            "recording": {"opaqueIdSha256": baseline["recordingIdSha256"]}, "sharing": unshared,
        }
        for name in ("upgrade-journey.json", "upgrade-journey-restart-login.json", "upgrade-journey-no-update.json"):
            _private_json(ledger / name, upgrade_journey)
        artifact = {
            "dmgSha256": _sha(dmg), "checksumsSha256": _sha(checksums),
            "bundleContentsSha256": "6" * 64, "runtimeInventorySha256": "5" * 64,
            "browserProvenanceVerified": True, "installedAppPathSha256": "9" * 64,
        }
        media = {
            name: {"device": index + 1, "inode": index + 11, "bytes": (index + 1) * 100, "sha256": char * 64}
            for index, (name, char) in enumerate((("audio", "a"), ("transcript", "b"), ("summary", "c")))
        }
        databases = {
            name: {"quickCheck": "ok", "schemaSha256": char * 64, "sentinelSha256": str(index + 1) * 64}
            for index, (name, char) in enumerate((("prompts", "d"), ("vocab", "e"), ("search", "f"), ("host", "a")))
        }
        keychain = {"service": "gogcli", "accountSha256": "b" * 64, "attributesSha256": "7" * 64, "persistentIdentitySha256": "8" * 64}
        current_owners = {"hostPidSha256": "c" * 64, "capturePidSha256": "d" * 64, "signed": True}
        restarted_owners = {"hostPidSha256": "1" * 64, "capturePidSha256": "2" * 64, "signed": True}
        legacy_owners = {
            "hostPidSha256": "8" * 64, "capturePidSha256": "9" * 64,
            "hostLabel": "com.yulu.ui", "captureLabel": "com.yulu.audiodaemon",
            "hostTargetPathSha256": "5" * 64, "captureExecutablePathSha256": "6" * 64,
            "captureSocketPathSha256": "7" * 64, "captureSocketOwnerPidSha256": "9" * 64,
        }
        initial_id = "c" * 64 if journey == "upgrade-cancel-retry" else post_upgrade_id
        initial = {
            "phase": "awaiting_approval", "idSha256": initial_id, "nonceSha256": "1" * 64,
            "attemptNumber": 1, "retryOfSha256": None, "retryRootSha256": None,
            "exactLegacySnapshot": True,
        }

        def upgrade_observation(
            checkpoint: str,
            transaction: dict[str, object],
            journal_sha: str,
            completed_kind: str | None,
            attestation: dict[str, bool],
        ) -> dict[str, object]:
            value: dict[str, object] = {
                "schema": 1, "classification": "upgrade_migration_policy_test",
                "formalAcceptance": False, "checkpoint": checkpoint, "releaseTag": TAG,
                "migrationBeforeSha256": migration_sha, "migrationBaseline": baseline,
                "currentArtifact": artifact, "operatorSnapshotWitnessSha256": "a" * 64,
                "transaction": transaction, "journalSha256": journal_sha,
                "media": media, "mcpTokenSha256": "6" * 64, "keychain": keychain,
                "operatorAttestation": attestation,
            }
            if completed_kind == "committed":
                value.update({
                    "databases": databases, "owners": current_owners,
                    "config": {"retiredKeyAbsent": True, "archiveSha256": "9" * 64},
                })
            elif completed_kind == "rolled_back":
                value.update({
                    "databases": databases, "owners": legacy_owners,
                    "config": {"sha256": "5" * 64, "autoSendNotion": True},
                })
            else:
                value.update({"databases": None, "owners": None, "config": None})
            return value

        _private_json(ledger / "upgrade-awaiting-approval.json", upgrade_observation(
            "awaiting_approval", initial, "f" * 64, None,
            {"smappserviceNotRegistered": False, "externalDestinationNoRunMarker": False},
        ))
        approval = initial
        if journey == "upgrade-cancel-retry":
            rolled = {**initial, "phase": "rolled_back"}
            rolled_attestation = {"smappserviceNotRegistered": True, "externalDestinationNoRunMarker": False}
            _private_json(ledger / "upgrade-rolled-back.json", upgrade_observation("rolled_back", rolled, "f" * 64, "rolled_back", rolled_attestation))
            _private_json(ledger / "upgrade-rolled-back-stable.json", upgrade_observation("rolled_back_stable", rolled, "f" * 64, "rolled_back", rolled_attestation))
            approval = {
                "phase": "awaiting_approval", "idSha256": post_upgrade_id, "nonceSha256": "2" * 64,
                "attemptNumber": 2, "retryOfSha256": initial_id, "retryRootSha256": initial_id,
                "exactLegacySnapshot": True,
            }
            _private_json(ledger / "upgrade-retry-awaiting-approval.json", upgrade_observation(
                "retry_awaiting_approval", approval, "a" * 64, None,
                {"smappserviceNotRegistered": False, "externalDestinationNoRunMarker": False},
            ))
        committed_transaction = {**approval, "phase": "committed"}
        for index, (name, checkpoint) in enumerate((("upgrade-committed.json", "committed"), ("upgrade-committed-restart-login.json", "committed_stable"), ("upgrade-committed-no-update.json", "committed_stable"))):
            observation = upgrade_observation(
                checkpoint, committed_transaction, post_upgrade_journal, "committed",
                {"smappserviceNotRegistered": False, "externalDestinationNoRunMarker": index == 0},
            )
            if index > 0:
                observation["owners"] = restarted_owners
            _private_json(ledger / name, observation)
    (ledger / "state").chmod(0o600)
    if (ledger / "upgrade.state").exists():
        (ledger / "upgrade.state").chmod(0o600)

    journey_files = ("production-share.json", "journey-restart-login.json", "journey-no-update.json") if scenario == "fresh" else ("upgrade-journey.json", "upgrade-journey-restart-login.json", "upgrade-journey-no-update.json")
    owner_generations = (("1", "2"), ("3", "4"), ("3", "4"))
    signature_sha = hashlib.sha256(json.dumps(signatures, separators=(",", ":")).encode()).hexdigest()
    update = {"journalPresent": False, "journalSha256": None, "applicationResidues": 0}
    for index, (name, checkpoint) in enumerate((("post-commit-baseline.json", "post-commit-baseline"), ("post-commit-restart-login.json", "post-commit-restart-login"), ("check-for-updates-no-update.json", "check-for-updates-no-update"))):
        host, capture = owner_generations[index]
        owners = {"hostPidSha256": host * 64, "capturePidSha256": capture * 64, "hostPathSha256": "5" * 64, "capturePathSha256": "6" * 64, "signedTeamIdentifier": "WMU9678ZQL", "hostListenerOwnerPidSha256": host * 64, "captureSocketOwnerPidSha256": capture * 64, "captureSocketPathSha256": "7" * 64, "legacyCaptureSocketAbsent": True}
        post = {
            "schema": 1, "classification": "post_commit_policy_test",
            "formalAcceptance": False, "checkpoint": checkpoint, "scenario": scenario,
            "releaseTag": TAG, "preflightSha256": _sha(ledger / "preflight.json"), "harnessManifestSha256": harness_sha,
            "sourceRevisionSha256": hashlib.sha256(revision.encode()).hexdigest(),
            "bundleObservationSha256": _sha(ledger / ("bundle-observation.json" if index == 0 else "bundle-restart-login.json" if index == 1 else "bundle-no-update.json")),
            "bundleContentsSha256": "6" * 64, "runtimeInventorySha256": "5" * 64, "signatureIdentitySha256": signature_sha,
            "journeyObservationSha256": _sha(ledger / journey_files[index]),
            "productionShare": {"observedVerifiedActions": 1 if scenario == "fresh" else 0, "automaticActionDelta": None if index == 0 else 0},
            "installedAppPathSha256": "8" * 64, "owners": owners,
            "roots": {"standardRootsOnly": True, "dataRootSha256": "9" * 64, "legacyWritableRuntimeOwner": False},
            "applicationUpdate": update,
            "upgrade": {"journalSha256": post_upgrade_journal, "transactionIdSha256": post_upgrade_id} if scenario == "upgrade" else None,
            "operatorAttestation": {"restartLogin": index == 1, "noUpdateAvailableInProductUI": index == 2},
        }
        _private_json(ledger / name, post)
    return ledger, dmg, checksums, tools


@pytest.mark.parametrize("scenario,journey", [("fresh", None), ("upgrade", "upgrade-success"), ("upgrade", "upgrade-cancel-retry")])
def test_controller_policy_validates_complete_fresh_and_both_upgrade_ledgers(tmp_path: Path, scenario: str, journey: str | None) -> None:
    ledger, dmg, checksums, tools = _returned_fixture(tmp_path, scenario, journey)
    command = ["python3", str(CONTROLLER), "--policy-test", "--scenario", scenario, "--ledger", str(ledger), "--tag", TAG, "--dmg", str(dmg), "--checksums", str(checksums), "--tool-bin", str(tools)]
    if journey:
        command += ["--journey", journey]
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    assert output["status"] == "validated"
    assert output["formalAcceptance"] is False
    assert output["sourceRevision"] == "a" * 40
    calls = (tmp_path / "authority-calls").read_text()
    assert "attestation verify" in calls
    assert str(dmg) in calls
    assert f"--source-digest {'a' * 40}" in calls
    assert "--signer-workflow Nowhitestar/Yulu/.github/workflows/release-publish.yml" in calls
    assert "verify " in calls


def test_controller_validator_is_controller_only_and_binds_public_release_authorities() -> None:
    source = CONTROLLER.read_text()
    builder = (ACCEPTANCE / "build_public_dmg_harness.sh").read_text()
    launcher = (ACCEPTANCE / "launch_public_dmg_acceptance.sh").read_text()

    assert CONTROLLER.name not in builder
    assert CONTROLLER.name not in launcher
    for required in (
        "gh", "attestation", "verify_dmg.sh", "refs/tags/", "^{commit}",
        "--source-digest", "--signer-workflow", "release-publish.yml",
        "checksumsSha256", "harnessManifestSha256", "sourceRevision",
        "post-commit-restart-login", "check-for-updates-no-update",
        "upgrade-cancel-retry", "formalAcceptance",
    ):
        assert required in source
    for forbidden in ("requests", "urllib.request", "curl", "formalAcceptance\": true"):
        assert forbidden not in source


def test_formal_harness_builder_runs_under_system_bash(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    subprocess.run(
        ["git", "clone", "--quiet", "--no-hardlinks", str(ROOT), str(repo)],
        check=True,
    )
    shutil.copytree(
        ACCEPTANCE,
        repo / "packaging" / "acceptance",
        dirs_exist_ok=True,
    )
    subprocess.run(
        ["git", "-C", str(repo), "add", "packaging/acceptance"],
        check=True,
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "-c",
            "user.name=Yulu Test",
            "-c",
            "user.email=yulu-test@example.invalid",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "formal harness fixture",
        ],
        check=True,
    )
    delivery = tmp_path / "delivery"
    delivery.mkdir()
    output = delivery / "harness"

    result = subprocess.run(
        [
            "/bin/bash",
            str(repo / "packaging" / "acceptance" / "build_public_dmg_harness.sh"),
            "--output",
            str(output),
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["buildMode"] == "formal"


def test_controller_cli_rejects_incomplete_or_unsafe_returned_ledger(tmp_path: Path) -> None:
    ledger = tmp_path / "ledger"
    ledger.mkdir(mode=0o700)
    (ledger / "state").write_text("schema=1\nphase=completed\n")
    (ledger / "state").chmod(0o600)
    dmg = tmp_path / f"yulu-macos-arm64-{TAG}.dmg"
    checksums = tmp_path / "checksums.txt"
    dmg.write_bytes(b"fixture")
    checksums.write_text("0" * 64 + f"  {dmg.name}\n")
    tools = tmp_path / "tools"
    tools.mkdir()
    result = subprocess.run(
        [
            "python3", str(CONTROLLER), "--policy-test", "--scenario", "fresh",
            "--ledger", str(ledger), "--tag", TAG, "--dmg", str(dmg),
            "--checksums", str(checksums), "--tool-bin", str(tools),
        ],
        text=True, capture_output=True, check=False,
    )
    assert result.returncode != 0
    assert "allowlist" in result.stderr.lower() or "incomplete" in result.stderr.lower()
    assert '"formalAcceptance":true' not in result.stdout.replace(" ", "")


@pytest.mark.parametrize("mutation", ["mode", "extra", "artifact", "secret", "formal-claim", "owner-drift", "semantic-core", "share-receipt"])
def test_controller_rejects_unsafe_or_cross_binding_drift(tmp_path: Path, mutation: str) -> None:
    ledger, dmg, checksums, tools = _returned_fixture(tmp_path, "fresh", None)
    if mutation == "mode":
        (ledger / "state").chmod(0o644)
    elif mutation == "extra":
        (ledger / "unexpected.txt").write_text("unexpected\n")
        (ledger / "unexpected.txt").chmod(0o600)
    elif mutation == "artifact":
        dmg.write_bytes(b"replacement bytes")
    else:
        path = ledger / (
            "production-share.json" if mutation in {"secret", "formal-claim", "share-receipt"}
            else "journey-core-activation.json" if mutation == "semantic-core"
            else "check-for-updates-no-update.json"
        )
        value = json.loads(path.read_text())
        if mutation == "secret":
            value["password"] = "private bait"
        elif mutation == "formal-claim":
            value["formalAcceptance"] = True
        elif mutation == "owner-drift":
            value["owners"]["hostPidSha256"] = "f" * 64
            value["owners"]["hostListenerOwnerPidSha256"] = "f" * 64
        elif mutation == "semantic-core":
            value.pop("activation")
        else:
            value["productionShare"]["latestAction"]["receiptIdentitySha256"] = "not-a-receipt"
        _private_json(path, value)
    result = subprocess.run(
        ["python3", str(CONTROLLER), "--policy-test", "--scenario", "fresh", "--ledger", str(ledger),
         "--tag", TAG, "--dmg", str(dmg), "--checksums", str(checksums), "--tool-bin", str(tools)],
        text=True, capture_output=True, check=False,
    )
    assert result.returncode != 0
    assert '"formalAcceptance":true' not in result.stdout.replace(" ", "")


@pytest.mark.parametrize(
    "mutation",
    [
        "wal", "retry-nonce", "mcp", "database", "macos13", "host-dependency",
        "rollback-pid-reuse", "rollback-path", "rollback-socket-owner",
    ],
)
def test_controller_rejects_incomplete_upgrade_semantics(tmp_path: Path, mutation: str) -> None:
    ledger, dmg, checksums, tools = _returned_fixture(tmp_path, "upgrade", "upgrade-cancel-retry")
    if mutation == "wal":
        path = ledger / "upgrade-awaiting-approval.json"
        value = json.loads(path.read_text())
        value["migrationBaseline"]["databases"]["walPreExisting"] = False
    elif mutation == "retry-nonce":
        path = ledger / "upgrade-retry-awaiting-approval.json"
        value = json.loads(path.read_text())
        value["transaction"]["nonceSha256"] = "1" * 64
    elif mutation == "mcp":
        path = ledger / "upgrade-committed.json"
        value = json.loads(path.read_text())
        value["mcpTokenSha256"] = "invalid"
    elif mutation == "database":
        path = ledger / "upgrade-committed-no-update.json"
        value = json.loads(path.read_text())
        value["databases"]["host"]["quickCheck"] = "corrupt"
    elif mutation.startswith("rollback-"):
        path = ledger / "upgrade-rolled-back.json"
        value = json.loads(path.read_text())
        if mutation == "rollback-pid-reuse":
            value["owners"]["hostPidSha256"] = value["migrationBaseline"]["runtime"]["hostPidSha256"]
        elif mutation == "rollback-path":
            value["owners"]["hostTargetPathSha256"] = "1" * 64
        else:
            value["owners"]["captureSocketOwnerPidSha256"] = "1" * 64
    else:
        path = ledger / "preflight.json"
        value = json.loads(path.read_text())
        if mutation == "macos13":
            value["macOSVersion"] = "13.6.9"
        else:
            value["hostDependenciesAbsent"] = True
    _private_json(path, value)
    result = subprocess.run(
        ["python3", str(CONTROLLER), "--policy-test", "--scenario", "upgrade", "--journey", "upgrade-cancel-retry",
         "--ledger", str(ledger), "--tag", TAG, "--dmg", str(dmg), "--checksums", str(checksums), "--tool-bin", str(tools)],
        text=True, capture_output=True, check=False,
    )
    assert result.returncode != 0


def test_controller_rejects_upgrade_final_journal_drift_and_policy_ledger_in_formal_mode(tmp_path: Path) -> None:
    ledger, dmg, checksums, tools = _returned_fixture(tmp_path, "upgrade", "upgrade-success")
    no_update = json.loads((ledger / "upgrade-committed-no-update.json").read_text())
    no_update["journalSha256"] = "1" * 64
    _private_json(ledger / "upgrade-committed-no-update.json", no_update)
    base = ["python3", str(CONTROLLER), "--scenario", "upgrade", "--journey", "upgrade-success",
            "--ledger", str(ledger), "--tag", TAG, "--dmg", str(dmg), "--checksums", str(checksums),
            "--tool-bin", str(tools)]
    drift = subprocess.run([base[0], base[1], "--policy-test", *base[2:]], text=True, capture_output=True, check=False)
    assert drift.returncode != 0
    assert "journal" in drift.stderr.lower()

    _private_json(ledger / "upgrade-committed-no-update.json", {**no_update, "journalSha256": "e" * 64})
    override = subprocess.run(base, text=True, capture_output=True, check=False)
    assert override.returncode != 0
    assert "build mode" in override.stderr.lower()


def test_public_acceptance_make_ci_and_docs_keep_policy_and_formal_authority_separate() -> None:
    makefile = (ROOT / "Makefile").read_text()
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    release = (ROOT / "docs" / "RELEASE.md").read_text()
    operations = (ROOT / "docs" / "operations.md").read_text()
    readmes = (ROOT / "README.md").read_text() + (ROOT / "README.zh-CN.md").read_text()

    assert "public-dmg-acceptance-policy" in makefile
    assert "make public-dmg-acceptance-policy" in ci
    assert "formal acceptance" in ci.lower()
    for required in (
        "controller", "0700", "0600", "gh attestation verify", "verify_dmg.sh",
        "clean target", "#170", "#171",
    ):
        assert required.lower() in release.lower()
    for required in ("Cancel Service Migration", "Retry Service Migration", "public-DMG"):
        assert required.lower() in (operations + readmes).lower()


def test_all_shell_evidence_writers_sync_file_before_rename_and_directory_after() -> None:
    for name in (
        "public_dmg_target.sh",
        "public_dmg_upgrade_target.sh",
        "prepare_v0_22_2_baseline.sh",
        "observe_v0_22_2_state.sh",
    ):
        source = (ACCEPTANCE / name).read_text()
        assert '"$DURABLE_SYNC" "$temporary"' in source or '"$DURABLE_SYNC" "$TEMPORARY"' in source
        assert "/bin/mv" in source
        assert '"$DURABLE_SYNC" "$LEDGER"' in source
