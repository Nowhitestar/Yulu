#!/usr/bin/env python3
"""Controller-side validation for a returned public-DMG acceptance ledger.

This file is intentionally excluded from the target harness.  The clean target
collects read-only evidence; a trusted release controller binds that evidence to
the local release tag, GitHub artifact attestation, and the repository's full
DMG verification before a human performs #170 review.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


TAG = "v0.23.0-rc.4"
TAG_COMMIT_SUFFIX = "^{commit}"
REPOSITORY = "Nowhitestar/Yulu"
SIGNER_WORKFLOW = "Nowhitestar/Yulu/.github/workflows/release-publish.yml"
TEAM_ID = "WMU9678ZQL"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
SECRET_KEYS = {
    "password", "secret", "apikey", "accesstoken", "refreshtoken",
    "authorization", "cookie", "privatekey", "clientsecret",
}
AUTHORITY_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"

COMMON = {
    "state", "preflight.json", "mount.json", "bundle-observation.json",
    "bundle-restart-login.json", "bundle-no-update.json",
    "post-commit-baseline.json", "post-commit-restart-login.json",
    "check-for-updates-no-update.json",
}
FRESH = COMMON | {
    "service-baseline.txt", "guidance-checkpoint.txt", "journey-baseline.json",
    "journey-core-activation.json", "pre-test-share.json", "test-share.json",
    "pre-production-share.json", "production-share-cancelled.json",
    "production-share.json", "journey-restart-login.json", "journey-no-update.json",
}
UPGRADE = COMMON | {
    "upgrade.state", "upgrade-awaiting-approval.json", "upgrade-committed.json",
    "upgrade-committed-restart-login.json", "upgrade-committed-no-update.json",
    "upgrade-journey.json", "upgrade-journey-restart-login.json",
    "upgrade-journey-no-update.json",
}
CANCEL_RETRY = {
    "upgrade-rolled-back.json", "upgrade-rolled-back-stable.json",
    "upgrade-retry-awaiting-approval.json",
}


class InvalidLedger(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise InvalidLedger(message)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def private_file(path: Path, description: str) -> None:
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), f"{description} is not a regular non-symlink file")
    require(stat.S_IMODE(info.st_mode) == 0o600, f"{description} mode is not 0600")
    require(info.st_uid == os.getuid(), f"{description} is not owned by the controller operator")
    require(0 < info.st_size <= 2 * 1024 * 1024, f"{description} is empty or exceeds the bounded evidence size")


def json_file(path: Path) -> dict[str, Any]:
    private_file(path, path.name)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise InvalidLedger(f"{path.name} is not valid bounded JSON") from error
    require(isinstance(value, dict), f"{path.name} must contain a JSON object")
    reject_secrets(value, path.name)
    require(value.get("formalAcceptance") is not True, f"{path.name} falsely claims formalAcceptance:true")
    return value


def reject_secrets(value: Any, location: str) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
            if normalized in SECRET_KEYS or (normalized.endswith("secret") and not normalized.endswith("secretsha256")):
                raise InvalidLedger(f"{location} contains forbidden secret field {key!r}")
            reject_secrets(child, location)
    elif isinstance(value, list):
        for child in value:
            reject_secrets(child, location)


def parse_state(path: Path, expected: set[str]) -> dict[str, str]:
    private_file(path, path.name)
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        require("=" in line, f"{path.name} contains a malformed state row")
        key, value = line.split("=", 1)
        require(key in expected and key not in result, f"{path.name} contains an unknown or duplicate field")
        result[key] = value
    require(set(result) == expected, f"{path.name} is incomplete")
    return result


def require_sha(value: Any, description: str) -> str:
    require(isinstance(value, str) and SHA256.fullmatch(value) is not None, f"{description} is not SHA-256")
    return value


def require_cdhash(value: Any, description: str) -> str:
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", value) is not None, f"{description} is invalid")
    return value


def require_record(value: Any, description: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{description} is missing or malformed")
    return value


def require_exact_keys(value: Any, keys: set[str], description: str) -> dict[str, Any]:
    record = require_record(value, description)
    require(set(record) == keys, f"{description} has an incomplete or unexpected field set")
    return record


def validate_fingerprint(value: Any, description: str, *, with_inode: bool = False) -> dict[str, Any]:
    record = require_record(value, description)
    require_sha(record.get("sha256"), f"{description} SHA")
    require(isinstance(record.get("bytes"), int) and record["bytes"] > 0, f"{description} byte count is invalid")
    if with_inode:
        require(isinstance(record.get("device"), int) and record["device"] >= 0, f"{description} device is invalid")
        require(isinstance(record.get("inode"), int) and record["inode"] > 0, f"{description} inode is invalid")
    return record


def validate_service_projection(value: dict[str, Any]) -> None:
    require(value.get("schema") == 1 and value.get("formalAcceptance") is False, "journey evidence is incomplete")
    require(value.get("releaseTag") == TAG, "journey release tag is wrong")
    health = require_record(value.get("health"), "journey health")
    require(health.get("status") == "ok" and health.get("serviceOwner") == "com.yulu.ui" and health.get("databaseStatus") == "ok", "Host health is incomplete")
    database = require_record(health.get("database"), "journey database health")
    require(isinstance(database.get("schemaVersion"), int) and isinstance(database.get("minimumReadableVersion"), int), "database schema evidence is missing")
    require(value.get("version", {}).get("product") == TAG.removeprefix("v"), "product version is wrong")
    require(value.get("ipc") == {"transport": "ipv4-loopback-http", "readOnly": True}, "IPC evidence is not the exact read-only loopback transport")


def validate_core_projection(value: dict[str, Any]) -> dict[str, Any]:
    validate_service_projection(value)
    activation = require_record(value.get("activation"), "Core Activation projection")
    provider = require_exact_keys(activation.get("provider"), {"transcription", "summary", "model"}, "Core Activation provider")
    require(all(isinstance(provider[name], str) and provider[name] for name in provider), "Core Activation provider identity is incomplete")
    artifacts = require_exact_keys(activation.get("artifacts"), {"audio", "transcript", "summary"}, "Core Activation artifacts")
    for name in ("audio", "transcript", "summary"):
        validate_fingerprint(artifacts[name], f"Core Activation {name}")
    require(activation.get("sourceArtifacts") == {"audio": True, "transcript": True, "summary": True}, "Core Activation source artifacts are incomplete")
    recording = require_exact_keys(value.get("recording"), {"opaqueIdSha256", "count", "transcriptCurrent", "summaryCurrent"}, "Core Activation recording")
    require_sha(recording.get("opaqueIdSha256"), "Core Activation recording identity")
    require(recording.get("count") == 1 and recording.get("transcriptCurrent") is True and recording.get("summaryCurrent") is True, "Core Activation recording projection is incomplete")
    task = require_exact_keys(value.get("task"), {"opaqueIdSha256", "state", "sendToNotion", "deliverySessionId"}, "Core Activation task")
    require_sha(task.get("opaqueIdSha256"), "Core Activation task identity")
    require(task.get("state") == "completed" and task.get("sendToNotion") is False and task.get("deliverySessionId") is None, "Core Activation task or zero-auto-share evidence is wrong")
    return {"activation": activation, "recording": recording, "task": task}


def validate_unshared(value: Any, description: str) -> None:
    require(value == {"status": "untested", "actionPresent": False, "receiptPresent": False}, f"{description} is not an exact unshared state")


def validate_production_binding(value: Any) -> dict[str, Any]:
    binding = require_exact_keys(
        value,
        {"snapshotSha256", "summarySha256", "recordingIdSha256", "connectionSha256", "destinationSha256", "connector"},
        "production Share binding",
    )
    for name in ("snapshotSha256", "summarySha256", "recordingIdSha256", "connectionSha256", "destinationSha256"):
        require_sha(binding.get(name), f"production Share {name}")
    require(isinstance(binding.get("connector"), str) and binding["connector"], "production Share connector is missing")
    return binding


def validate_test_share_projection(value: Any) -> dict[str, Any]:
    share = require_exact_keys(
        value,
        {"status", "adoption", "actionIdSha256", "receiptIdentitySha256", "connectionIdentitySha256", "destinationSha256", "connector", "contentSha256", "optionalOutcomes"},
        "Test Share projection",
    )
    require(share.get("status") == "verified" and share.get("adoption") == "adopted", "Test Share is not verified and adopted")
    for name in ("actionIdSha256", "receiptIdentitySha256", "connectionIdentitySha256", "destinationSha256", "contentSha256"):
        require_sha(share.get(name), f"Test Share {name}")
    require(isinstance(share.get("connector"), str) and share["connector"], "Test Share connector is missing")
    validate_optional_outcomes(share.get("optionalOutcomes"), sharing_pending=False)
    return share


def run_authority(command: list[str], description: str) -> None:
    environment = {**os.environ, "LC_ALL": "C", "PATH": AUTHORITY_PATH, "YULU_EXPECTED_TEAM_ID": TEAM_ID}
    result = subprocess.run(
        command, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        timeout=900, check=False, env=environment,
    )
    require(result.returncode == 0, f"{description} failed")


def artifact_binding(dmg: Path, checksums: Path, tag: str) -> tuple[str, str]:
    expected_name = f"yulu-macos-arm64-{tag}.dmg"
    require(dmg.is_absolute() and dmg.name == expected_name, "DMG path or filename is invalid")
    require(checksums.is_absolute() and checksums.name == "checksums.txt", "checksums path or filename is invalid")
    for path, description in ((dmg, "DMG"), (checksums, "checksums")):
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), f"{description} must be a regular non-symlink file")
    dmg_sha = digest(dmg)
    matches: list[str] = []
    for line in checksums.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == expected_name:
            matches.append(parts[0])
    require(matches == [dmg_sha], "checksums must contain exactly one correct public DMG row")
    return dmg_sha, digest(checksums)


def validate_rebuilt_harness(policy_test: bool, source_revision: str, expected_manifest_sha: str) -> None:
    repo = Path(__file__).resolve().parents[2]
    builder = repo / "packaging" / "acceptance" / "build_public_dmg_harness.sh"
    require(builder.is_file() and not builder.is_symlink(), "trusted harness builder is unavailable")
    with tempfile.TemporaryDirectory(prefix="yulu-controller-harness.") as temporary:
        output = Path(temporary) / "harness"
        command = ["/bin/bash", str(builder), "--output", str(output)]
        expected_mode = "formal"
        if policy_test:
            command.extend(["--policy-test", "--source-revision", source_revision])
            expected_mode = "policy-test"
        result = subprocess.run(
            command, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=120, check=False,
            env={**os.environ, "LC_ALL": "C", "PATH": AUTHORITY_PATH},
        )
        require(result.returncode == 0, "trusted harness rebuild failed")
        manifest = output / "manifest.sha256"
        mode_file = output / "build-mode.txt"
        require(digest(manifest) == expected_manifest_sha, "returned evidence does not use the clean rebuilt harness manifest")
        require(mode_file.read_text(encoding="utf-8") == f"{expected_mode}\n", "rebuilt harness mode is wrong")


def validate_bundle(bundle: dict[str, Any]) -> tuple[str, str, str]:
    require(bundle.get("schema") == 1 and bundle.get("formalAcceptance") is False and bundle.get("status") == "matched", "bundle observation is incomplete")
    require(bundle.get("release", {}).get("releaseVersion") == TAG.removeprefix("v"), "bundle release identity is wrong")
    contents = require_sha(bundle.get("contents", {}).get("sha256"), "bundle contents")
    inventory = require_sha(bundle.get("runtimeInventory", {}).get("sha256"), "runtime inventory")
    signatures = bundle.get("signatures")
    require(isinstance(signatures, dict) and set(signatures) == {"application", "host", "capture"}, "bundle signatures are incomplete")
    for name, identity in signatures.items():
        require(isinstance(identity, dict) and identity.get("teamIdentifier") == TEAM_ID, f"{name} Team ID is wrong")
        require_cdhash(identity.get("cdHash"), f"{name} CDHash")
        require(isinstance(identity.get("identifier"), str) and identity["identifier"], f"{name} signature identifier is missing")
    signature_sha = hashlib.sha256(json.dumps(signatures, separators=(",", ":")).encode()).hexdigest()
    return contents, inventory, signature_sha


def validate_journey(value: dict[str, Any], scenario: str) -> None:
    expected_shares = 1 if scenario == "fresh" else 0
    validate_service_projection(value)
    require(value.get("checkpoint") == ("production-share" if scenario == "fresh" else "upgrade-post"), "journey checkpoint is wrong")
    counts = value.get("productionShare", {}).get("actionCounts", {})
    require(counts == {"total": expected_shares, "verified": expected_shares}, "production Share count is wrong")
    if scenario == "fresh":
        outcomes = value.get("test_share", {}).get("optionalOutcomes")
        validate_optional_outcomes(outcomes, sharing_pending=False)
    else:
        require(value.get("onboarding") == {"installationKind": "returning", "sharingAdopted": False}, "upgrade created false onboarding adoption")
        validate_unshared(value.get("sharing"), "upgrade Sharing state")
        require_sha(value.get("migrationBeforeSha256"), "upgrade journey migration-before")
        recording = require_exact_keys(value.get("recording"), {"opaqueIdSha256"}, "upgrade journey recording")
        require_sha(recording.get("opaqueIdSha256"), "upgrade journey recording identity")


def validate_optional_outcomes(outcomes: Any, *, sharing_pending: bool) -> None:
    require(isinstance(outcomes, dict) and outcomes.get("onboardingVersion") == "phase-13-v1" and outcomes.get("currentCompleted") is (not sharing_pending), "fresh onboarding current completion is inconsistent")
    capabilities = outcomes.get("capabilities")
    require(isinstance(capabilities, list) and len(capabilities) == 4, "fresh optional outcomes are incomplete")
    expected = {
        "conversation": "conversation-v1",
        "calendar-source": "calendar-source-v1",
        "agent-calendar-connector": "agent-calendar-connector-v1",
        "sharing": "sharing-v1",
    }
    seen: set[str] = set()
    for outcome in capabilities:
        require(isinstance(outcome, dict), "fresh optional outcome is malformed")
        capability = outcome.get("id")
        require(capability in expected and capability not in seen and outcome.get("contractVersion") == expected[capability], "fresh optional manifest identity is wrong")
        allowed = {"pending-verified-test-share"} if capability == "sharing" and sharing_pending else {"adopted", "deferred"}
        if capability == "sharing" and not sharing_pending:
            allowed = {"adopted"}
        require(outcome.get("outcome") in allowed, "fresh optional outcome is unresolved")
        seen.add(capability)
    require(seen == set(expected), "fresh optional manifest is incomplete")


def validate_fresh_sequence(values: dict[str, dict[str, Any]]) -> None:
    checkpoints = {
        "journey-baseline.json": "baseline",
        "journey-core-activation.json": "core-activation",
        "pre-test-share.json": "pre-test-share",
        "test-share.json": "test-share",
        "pre-production-share.json": "pre-production-share",
        "production-share-cancelled.json": "production-share-cancelled",
        "production-share.json": "production-share",
        "journey-restart-login.json": "production-share",
        "journey-no-update.json": "production-share",
    }
    for name, checkpoint in checkpoints.items():
        value = values[name]
        require(value.get("schema") == 1 and value.get("formalAcceptance") is False and value.get("releaseTag") == TAG and value.get("checkpoint") == checkpoint, f"{name} checkpoint binding is invalid")
        validate_service_projection(value)
    baseline = values["journey-baseline.json"]
    require(baseline.get("onboarding") == {"installationKind": "fresh", "coreCompleted": False}, "fresh baseline onboarding is wrong")
    require(baseline.get("recordings") == {"count": 0}, "fresh baseline is not empty")
    validate_unshared(baseline.get("sharing"), "fresh baseline Sharing state")
    core_names = tuple(name for name in checkpoints if name != "journey-baseline.json")
    core_projection = validate_core_projection(values[core_names[0]])
    for name in core_names:
        require(values[name].get("onboarding") == {"installationKind": "fresh", "coreCompleted": True}, f"{name} Core Activation onboarding evidence is wrong")
        require(validate_core_projection(values[name]) == core_projection, f"{name} Core Activation identity drifted")
    validate_unshared(values["journey-core-activation.json"].get("sharing"), "Core Activation Sharing state")
    pre_optional = values["pre-test-share.json"].get("sharing", {}).get("optionalOutcomes", {})
    validate_optional_outcomes(pre_optional, sharing_pending=True)
    pre_sharing = require_exact_keys(
        values["pre-test-share.json"].get("sharing"),
        {"status", "connectorProbe", "binding", "optionalOutcomes"},
        "pre-Test Share projection",
    )
    require(pre_sharing.get("status") == "untested" and pre_sharing.get("connectorProbe") == "ready", "pre-Test Share destination is not ready and untested")
    pre_binding = require_exact_keys(pre_sharing.get("binding"), {"connectionIdentitySha256", "destinationSha256", "connector"}, "pre-Test Share binding")
    require_sha(pre_binding.get("connectionIdentitySha256"), "pre-Test Share connection identity")
    require_sha(pre_binding.get("destinationSha256"), "pre-Test Share destination identity")
    require(isinstance(pre_binding.get("connector"), str) and pre_binding["connector"], "pre-Test Share connector is missing")
    require(values["pre-test-share.json"].get("operatorAttestation") == {"externalDestinationNoRunMarkerConfirmed": True}, "pre-Test Share operator attestation is missing")
    test_names = ("test-share.json", "pre-production-share.json", "production-share-cancelled.json", "production-share.json", "journey-restart-login.json", "journey-no-update.json")
    test_projection = validate_test_share_projection(values[test_names[0]].get("test_share"))
    production_binding = validate_production_binding(values[test_names[0]].get("productionShare", {}).get("binding"))
    require(pre_binding["destinationSha256"] == test_projection["destinationSha256"] and pre_binding["connector"] == test_projection["connector"], "Test Share changed the selected destination or connector")
    for name in test_names:
        require(validate_test_share_projection(values[name].get("test_share")) == test_projection, f"{name} Test Share receipt identity drifted")
        require(validate_production_binding(values[name].get("productionShare", {}).get("binding")) == production_binding, f"{name} production Share binding drifted")
    for name in ("test-share.json", "pre-production-share.json", "production-share-cancelled.json", "production-share.json", "journey-restart-login.json", "journey-no-update.json"):
        validate_journey(values[name], "fresh") if name in {"production-share.json", "journey-restart-login.json", "journey-no-update.json"} else None
        optional = values[name].get("test_share", {}).get("optionalOutcomes", {})
        require(optional.get("currentCompleted") is True, f"{name} current onboarding completion is false")
    for name in ("journey-core-activation.json", "pre-test-share.json", "test-share.json", "pre-production-share.json", "production-share-cancelled.json"):
        counts = values[name].get("productionShare", {}).get("actionCounts", {})
        require(counts == {"total": 0, "verified": 0}, f"{name} contains an automatic production Share")
    latest = None
    for name in ("production-share.json", "journey-restart-login.json", "journey-no-update.json"):
        action = require_exact_keys(values[name].get("productionShare", {}).get("latestAction"), {"opaqueIdSha256", "status", "receiptIdentitySha256"}, f"{name} production Share receipt")
        require_sha(action.get("opaqueIdSha256"), "production Share action identity")
        require_sha(action.get("receiptIdentitySha256"), "production Share receipt identity")
        require(action.get("status") == "verified", "production Share receipt is not verified")
        if latest is None:
            latest = action
        else:
            require(action == latest, f"{name} production Share receipt changed after restart/update")


def validate_migration_baseline(value: Any) -> dict[str, Any]:
    baseline = require_exact_keys(value, {"sourceCommit", "recordingIdSha256", "runtime", "databases", "config", "keychain", "media"}, "migration baseline")
    require(baseline.get("sourceCommit") == "2d01fa2989c1a9ae1a95266438bb278c72fac8c3", "migration baseline source commit is wrong")
    require_sha(baseline.get("recordingIdSha256"), "migration baseline recording identity")
    runtime = require_exact_keys(
        baseline.get("runtime"),
        {
            "hostRunning", "captureRunning", "socketOwnedByCapture", "launchAgentOwnerCount",
            "hostPidSha256", "capturePidSha256", "hostLabel", "captureLabel",
            "hostTargetPathSha256", "captureExecutablePathSha256", "captureSocketPathSha256",
        },
        "migration baseline runtime",
    )
    require(runtime.get("hostRunning") is True and runtime.get("captureRunning") is True and runtime.get("socketOwnedByCapture") is True and runtime.get("launchAgentOwnerCount") == 8, "migration baseline runtime owners are incomplete")
    require_sha(runtime.get("hostPidSha256"), "migration baseline Host owner")
    require_sha(runtime.get("capturePidSha256"), "migration baseline Capture owner")
    require(runtime["hostPidSha256"] != runtime["capturePidSha256"], "migration baseline Host/Capture owner identities are not unique")
    require(runtime.get("hostLabel") == "com.yulu.ui" and runtime.get("captureLabel") == "com.yulu.audiodaemon", "migration baseline legacy owner labels are wrong")
    for field in ("hostTargetPathSha256", "captureExecutablePathSha256", "captureSocketPathSha256"):
        require_sha(runtime.get(field), f"migration baseline {field}")
    databases = require_exact_keys(baseline.get("databases"), {"allQuickCheckOk", "walPreExisting", "wal", "items"}, "migration baseline databases")
    require(databases.get("allQuickCheckOk") is True and databases.get("walPreExisting") is True, "migration baseline database/WAL precondition is missing")
    wal = require_exact_keys(databases.get("wal"), {"database", "sha256", "bytes", "preExisting"}, "migration baseline WAL")
    require(wal.get("database") in {"prompts", "vocab", "search", "host"} and wal.get("preExisting") is True, "migration baseline WAL identity is wrong")
    require_sha(wal.get("sha256"), "migration baseline WAL")
    require(isinstance(wal.get("bytes"), int) and wal["bytes"] > 0, "migration baseline WAL byte count is invalid")
    validate_upgrade_databases(databases.get("items"))
    config = require_exact_keys(baseline.get("config"), {"configSha256", "autoSendNotion", "googleCalendarEnabled", "keychainAccountMatchesGoogleCalendar", "mcpTokenSha256"}, "migration baseline config")
    require_sha(config.get("configSha256"), "migration baseline config")
    require_sha(config.get("mcpTokenSha256"), "migration baseline MCP token")
    require(config.get("autoSendNotion") is True and config.get("googleCalendarEnabled") is False and config.get("keychainAccountMatchesGoogleCalendar") is True, "migration baseline config semantics are wrong")
    keychain = require_exact_keys(baseline.get("keychain"), {"service", "attributesSha256", "persistentIdentitySha256"}, "migration baseline Keychain")
    require(keychain.get("service") == "gogcli", "migration baseline Keychain service is wrong")
    require_sha(keychain.get("attributesSha256"), "migration baseline Keychain attributes")
    require_sha(keychain.get("persistentIdentitySha256"), "migration baseline Keychain identity")
    validate_upgrade_media(baseline.get("media"))
    return baseline


def validate_upgrade_databases(value: Any) -> dict[str, Any]:
    databases = require_exact_keys(value, {"prompts", "vocab", "search", "host"}, "upgrade database projection")
    for name, item_value in databases.items():
        item = require_exact_keys(item_value, {"quickCheck", "schemaSha256", "sentinelSha256"}, f"upgrade {name} database")
        require(item.get("quickCheck") == "ok", f"upgrade {name} quick_check is not ok")
        require_sha(item.get("schemaSha256"), f"upgrade {name} schema")
        require_sha(item.get("sentinelSha256"), f"upgrade {name} representative row")
    return databases


def validate_upgrade_media(value: Any) -> dict[str, Any]:
    media = require_exact_keys(value, {"audio", "transcript", "summary"}, "upgrade Media projection")
    for name in media:
        validate_fingerprint(media[name], f"upgrade {name} Media", with_inode=True)
    return media


def validate_upgrade_observation(value: dict[str, Any], checkpoint: str, state: dict[str, str], *, completed: bool, rolled_back: bool = False) -> dict[str, Any]:
    require(value.get("schema") == 1 and value.get("formalAcceptance") is False and value.get("checkpoint") == checkpoint and value.get("releaseTag") == TAG, f"upgrade {checkpoint} observation is malformed")
    require(value.get("migrationBeforeSha256") == state["migration_before_sha256"], f"upgrade {checkpoint} migration-before binding drifted")
    baseline = validate_migration_baseline(value.get("migrationBaseline"))
    require(value.get("operatorSnapshotWitnessSha256") == state["operator_snapshot_witness_sha256"], f"upgrade {checkpoint} snapshot witness drifted")
    artifact = require_exact_keys(value.get("currentArtifact"), {"dmgSha256", "checksumsSha256", "bundleContentsSha256", "runtimeInventorySha256", "browserProvenanceVerified", "installedAppPathSha256"}, f"upgrade {checkpoint} artifact")
    for name in ("dmgSha256", "checksumsSha256", "bundleContentsSha256", "runtimeInventorySha256", "installedAppPathSha256"):
        require_sha(artifact.get(name), f"upgrade {checkpoint} artifact {name}")
    require(artifact.get("browserProvenanceVerified") is True, f"upgrade {checkpoint} browser provenance is false")
    transaction = require_exact_keys(value.get("transaction"), {"phase", "idSha256", "nonceSha256", "attemptNumber", "retryOfSha256", "retryRootSha256", "exactLegacySnapshot"}, f"upgrade {checkpoint} transaction")
    require_sha(transaction.get("idSha256"), f"upgrade {checkpoint} transaction")
    require_sha(transaction.get("nonceSha256"), f"upgrade {checkpoint} nonce")
    require(isinstance(transaction.get("attemptNumber"), int) and transaction["attemptNumber"] >= 1 and transaction.get("exactLegacySnapshot") is True, f"upgrade {checkpoint} attempt/snapshot is invalid")
    for field in ("retryOfSha256", "retryRootSha256"):
        require(transaction.get(field) is None or require_sha(transaction[field], f"upgrade {checkpoint} {field}"), f"upgrade {checkpoint} {field} is invalid")
    require_sha(value.get("journalSha256"), f"upgrade {checkpoint} journal")
    media = validate_upgrade_media(value.get("media"))
    require_sha(value.get("mcpTokenSha256"), f"upgrade {checkpoint} MCP token")
    require(value.get("mcpTokenSha256") == baseline["config"]["mcpTokenSha256"], f"upgrade {checkpoint} MCP token drifted from migration baseline")
    keychain = require_exact_keys(value.get("keychain"), {"service", "accountSha256", "attributesSha256", "persistentIdentitySha256"}, f"upgrade {checkpoint} Keychain")
    require(keychain.get("service") == "gogcli", f"upgrade {checkpoint} Keychain service is wrong")
    for field in ("accountSha256", "attributesSha256", "persistentIdentitySha256"):
        require_sha(keychain.get(field), f"upgrade {checkpoint} Keychain {field}")
    require(keychain["attributesSha256"] == baseline["keychain"]["attributesSha256"] and keychain["persistentIdentitySha256"] == baseline["keychain"]["persistentIdentitySha256"], f"upgrade {checkpoint} Keychain drifted from migration baseline")
    require(media == baseline["media"], f"upgrade {checkpoint} Media drifted from migration baseline")
    attestation = require_exact_keys(value.get("operatorAttestation"), {"smappserviceNotRegistered", "externalDestinationNoRunMarker"}, f"upgrade {checkpoint} operator attestation")
    if completed:
        databases = validate_upgrade_databases(value.get("databases"))
        require(databases == baseline["databases"]["items"], f"upgrade {checkpoint} database projections drifted from migration baseline")
        owners = require_record(value.get("owners"), f"upgrade {checkpoint} owners")
        require_sha(owners.get("hostPidSha256"), f"upgrade {checkpoint} Host owner")
        require_sha(owners.get("capturePidSha256"), f"upgrade {checkpoint} Capture owner")
        require(owners["hostPidSha256"] != owners["capturePidSha256"], f"upgrade {checkpoint} Host/Capture owners are not unique")
        if rolled_back:
            expected_fields = {
                "hostPidSha256", "capturePidSha256", "hostLabel", "captureLabel",
                "hostTargetPathSha256", "captureExecutablePathSha256", "captureSocketPathSha256",
                "captureSocketOwnerPidSha256",
            }
            require(set(owners) == expected_fields, f"upgrade {checkpoint} legacy owner projection is unexpected")
            require(
                owners.get("hostLabel") == baseline["runtime"]["hostLabel"] and
                owners.get("captureLabel") == baseline["runtime"]["captureLabel"] and
                owners.get("hostTargetPathSha256") == baseline["runtime"]["hostTargetPathSha256"] and
                owners.get("captureExecutablePathSha256") == baseline["runtime"]["captureExecutablePathSha256"] and
                owners.get("captureSocketPathSha256") == baseline["runtime"]["captureSocketPathSha256"],
                f"upgrade {checkpoint} legacy owner labels or paths were not restored",
            )
            require_sha(owners.get("captureSocketOwnerPidSha256"), f"upgrade {checkpoint} legacy Capture socket owner")
            require(owners["captureSocketOwnerPidSha256"] == owners["capturePidSha256"], f"upgrade {checkpoint} legacy Capture socket is not owned by Capture")
            require(
                owners["hostPidSha256"] != baseline["runtime"]["hostPidSha256"] and
                owners["capturePidSha256"] != baseline["runtime"]["capturePidSha256"],
                f"upgrade {checkpoint} rollback did not replace both quiesced legacy owner generations",
            )
            config = require_exact_keys(value.get("config"), {"sha256", "autoSendNotion"}, f"upgrade {checkpoint} rolled-back config")
            require_sha(config.get("sha256"), f"upgrade {checkpoint} rolled-back config")
            require(config.get("sha256") == baseline["config"]["configSha256"] and config.get("autoSendNotion") is True and attestation == {"smappserviceNotRegistered": True, "externalDestinationNoRunMarker": False}, f"upgrade {checkpoint} rollback/config attestation is wrong")
        else:
            require(set(owners) == {"hostPidSha256", "capturePidSha256", "signed"} and owners.get("signed") is True, f"upgrade {checkpoint} current owners are not signed")
            config = require_exact_keys(value.get("config"), {"retiredKeyAbsent", "archiveSha256"}, f"upgrade {checkpoint} committed config")
            require(config.get("retiredKeyAbsent") is True, f"upgrade {checkpoint} retired automatic-share key remains")
            require_sha(config.get("archiveSha256"), f"upgrade {checkpoint} automatic-share archive")
    else:
        require(value.get("databases") is None and value.get("owners") is None and value.get("config") is None, f"upgrade {checkpoint} approval checkpoint contains completed mutation evidence")
        databases = None
        config = None
        owners = None
        require(attestation == {"smappserviceNotRegistered": False, "externalDestinationNoRunMarker": False}, f"upgrade {checkpoint} has an unexpected operator attestation")
    return {"baseline": baseline, "artifact": artifact, "transaction": transaction, "journal": value["journalSha256"], "databases": databases, "media": media, "mcp": value["mcpTokenSha256"], "keychain": keychain, "config": config, "owners": owners}


def validate_upgrade_files(values: dict[str, dict[str, Any]], ledger: Path, journey: str, preflight_sha: str, bundle_sha: str) -> None:
    state = parse_state(
        ledger / "upgrade.state",
        {"schema", "journey", "release_tag", "migration_before_sha256", "current_preflight_sha256", "bundle_evidence_sha256", "operator_snapshot_witness_sha256", "phase"},
    )
    require(state["schema"] == "1" and state["journey"] == journey and state["release_tag"] == TAG and state["phase"] == "completed", "upgrade state is not completed")
    require(state["current_preflight_sha256"] == preflight_sha and state["bundle_evidence_sha256"] == bundle_sha, "upgrade state artifact binding drifted")
    require_sha(state["migration_before_sha256"], "upgrade migration-before binding")
    require_sha(state["operator_snapshot_witness_sha256"], "upgrade snapshot witness binding")
    awaiting = validate_upgrade_observation(values["upgrade-awaiting-approval.json"], "awaiting_approval", state, completed=False)
    require(awaiting["transaction"]["phase"] == "awaiting_approval" and awaiting["transaction"]["attemptNumber"] == 1 and awaiting["transaction"]["retryOfSha256"] is None and awaiting["transaction"]["retryRootSha256"] is None, "initial upgrade approval transaction is not a first attempt")
    committed_names = ["upgrade-committed.json", "upgrade-committed-restart-login.json", "upgrade-committed-no-update.json"]
    committed = [
        validate_upgrade_observation(values[name], "committed" if index == 0 else "committed_stable", state, completed=True)
        for index, name in enumerate(committed_names)
    ]
    for index, item in enumerate(committed):
        require(item["transaction"]["phase"] == "committed", "upgrade journal is not committed")
        artifact = item["artifact"]
        require(artifact["dmgSha256"] == values["preflight.json"]["dmgSha256"] and artifact["checksumsSha256"] == values["preflight.json"]["checksumsSha256"], "upgrade public artifact binding drifted")
        require(artifact["bundleContentsSha256"] == values["bundle-observation.json"].get("contents", {}).get("sha256") and artifact["runtimeInventorySha256"] == values["bundle-observation.json"].get("runtimeInventory", {}).get("sha256"), "upgrade bundle identity drifted")
        expected_attestation = {"smappserviceNotRegistered": False, "externalDestinationNoRunMarker": index == 0}
        require(values[committed_names[index]].get("operatorAttestation") == expected_attestation, "committed upgrade operator attestation is wrong")
    for field in ("baseline", "artifact", "transaction", "journal", "databases", "media", "mcp", "keychain", "config"):
        require(committed[0][field] == committed[1][field] == committed[2][field], f"committed upgrade {field} changed after restart/update")
    require(
        committed[0]["owners"]["hostPidSha256"] != committed[1]["owners"]["hostPidSha256"] and
        committed[0]["owners"]["capturePidSha256"] != committed[1]["owners"]["capturePidSha256"],
        "upgrade restart/login did not replace both service owner generations",
    )
    require(committed[1]["owners"] == committed[2]["owners"], "upgrade no-update check changed the restarted service owner generation")
    approval = awaiting
    if journey == "upgrade-cancel-retry":
        rolled = validate_upgrade_observation(values["upgrade-rolled-back.json"], "rolled_back", state, completed=True, rolled_back=True)
        stable = validate_upgrade_observation(values["upgrade-rolled-back-stable.json"], "rolled_back_stable", state, completed=True, rolled_back=True)
        retry = validate_upgrade_observation(values["upgrade-retry-awaiting-approval.json"], "retry_awaiting_approval", state, completed=False)
        require(rolled["transaction"] == {**awaiting["transaction"], "phase": "rolled_back"}, "rolled-back transaction does not bind the initial approval")
        for field in ("baseline", "artifact", "transaction", "journal", "databases", "media", "mcp", "keychain", "config", "owners"):
            require(rolled[field] == stable[field], f"ordinary relaunch changed rolled-back {field} or auto-retried migration")
        require(retry["transaction"]["phase"] == "awaiting_approval", "Retry is not awaiting approval")
        require(retry["transaction"]["attemptNumber"] == rolled["transaction"]["attemptNumber"] + 1, "Retry attempt number did not advance")
        require(retry["transaction"]["idSha256"] != rolled["transaction"]["idSha256"] and retry["transaction"]["nonceSha256"] != rolled["transaction"]["nonceSha256"], "Retry reused transaction identity or nonce")
        require(retry["transaction"]["retryOfSha256"] == rolled["transaction"]["idSha256"] and retry["transaction"]["retryRootSha256"] == rolled["transaction"]["idSha256"], "Retry lineage does not bind the rolled-back transaction")
        require(retry["baseline"] == rolled["baseline"] and retry["artifact"] == rolled["artifact"] and retry["media"] == rolled["media"] and retry["mcp"] == rolled["mcp"] and retry["keychain"] == rolled["keychain"], "Retry did not use a fresh snapshot of the same legacy source")
        approval = retry
    require(committed[0]["transaction"] == {**approval["transaction"], "phase": "committed"}, "committed transaction does not continue the approved attempt")

    journeys = [values[name] for name in ("upgrade-journey.json", "upgrade-journey-restart-login.json", "upgrade-journey-no-update.json")]
    for value in journeys:
        require(value.get("migrationBeforeSha256") == state["migration_before_sha256"], "upgrade journey migration-before binding drifted")
        require(value.get("recording", {}).get("opaqueIdSha256") == awaiting["baseline"]["recordingIdSha256"], "upgrade journey recording identity drifted")
    require(journeys[0] == journeys[1] == journeys[2], "upgrade journey evidence changed after restart/update")


def validate_post_commit(values: dict[str, dict[str, Any]], paths: dict[str, Path], scenario: str) -> None:
    names = ["post-commit-baseline.json", "post-commit-restart-login.json", "check-for-updates-no-update.json"]
    checkpoints = ["post-commit-baseline", "post-commit-restart-login", "check-for-updates-no-update"]
    bundles = ["bundle-observation.json", "bundle-restart-login.json", "bundle-no-update.json"]
    journeys = ["production-share.json", "journey-restart-login.json", "journey-no-update.json"] if scenario == "fresh" else ["upgrade-journey.json", "upgrade-journey-restart-login.json", "upgrade-journey-no-update.json"]
    post = [values[name] for name in names]
    for index, value in enumerate(post):
        require(value.get("schema") == 1 and value.get("formalAcceptance") is False and value.get("checkpoint") == checkpoints[index], "post-commit checkpoint is invalid")
        require(value.get("scenario") == scenario and value.get("releaseTag") == TAG, "post-commit scenario/release binding drifted")
        require(value.get("preflightSha256") == digest(paths["preflight.json"]), "post-commit preflight binding drifted")
        require(value.get("harnessManifestSha256") == values["preflight.json"].get("harnessManifestSha256"), "post-commit harness binding drifted")
        expected_revision_hash = hashlib.sha256(values["preflight.json"]["sourceRevision"].encode()).hexdigest()
        require(value.get("sourceRevisionSha256") == expected_revision_hash, "post-commit source binding drifted")
        require(value.get("bundleObservationSha256") == digest(paths[bundles[index]]), "post-commit bundle binding drifted")
        require(value.get("journeyObservationSha256") == digest(paths[journeys[index]]), "post-commit journey binding drifted")
        bundle = values[bundles[index]]
        require(value.get("bundleContentsSha256") == bundle.get("contents", {}).get("sha256") and value.get("runtimeInventorySha256") == bundle.get("runtimeInventory", {}).get("sha256"), "post-commit bundle identity drifted")
        expected_signature_hash = hashlib.sha256(json.dumps(bundle.get("signatures"), separators=(",", ":")).encode()).hexdigest()
        require(value.get("signatureIdentitySha256") == expected_signature_hash, "post-commit signature identity drifted")
        require(value.get("productionShare", {}).get("observedVerifiedActions") == (1 if scenario == "fresh" else 0), "post-commit Share evidence is wrong")
        if index > 0:
            require(value.get("productionShare", {}).get("automaticActionDelta") == 0, "post-commit automatic production Share occurred")
        owners = value.get("owners", {})
        for field in ("hostPidSha256", "capturePidSha256", "hostPathSha256", "capturePathSha256", "hostListenerOwnerPidSha256", "captureSocketOwnerPidSha256", "captureSocketPathSha256"):
            require_sha(owners.get(field), f"post-commit owner {field}")
        require(owners.get("signedTeamIdentifier") == TEAM_ID and owners.get("legacyCaptureSocketAbsent") is True, "signed owner or legacy Capture socket evidence is wrong")
        require(owners.get("hostListenerOwnerPidSha256") == owners.get("hostPidSha256") and owners.get("captureSocketOwnerPidSha256") == owners.get("capturePidSha256"), "listener/socket ownership is not bound to current service PIDs")
        update = value.get("applicationUpdate", {})
        require(update.get("applicationResidues") == 0, "application update residue exists")
        roots = value.get("roots", {})
        require(roots.get("standardRootsOnly") is True and roots.get("legacyWritableRuntimeOwner") is False, "standard-root evidence is missing")
        require_sha(roots.get("dataRootSha256"), "standard data root")
        if scenario == "upgrade":
            upgrade_name = ("upgrade-committed.json", "upgrade-committed-restart-login.json", "upgrade-committed-no-update.json")[index]
            require(value.get("upgrade") == {
                "journalSha256": values[upgrade_name].get("journalSha256"),
                "transactionIdSha256": values[upgrade_name].get("transaction", {}).get("idSha256"),
            }, "post-commit migration evidence is not bound to its checkpoint file")
    require(post[0]["owners"]["hostPidSha256"] != post[1]["owners"]["hostPidSha256"] and post[0]["owners"]["capturePidSha256"] != post[1]["owners"]["capturePidSha256"], "restart did not change service generation")
    require(post[0]["owners"]["hostPathSha256"] == post[1]["owners"]["hostPathSha256"] and post[0]["owners"]["capturePathSha256"] == post[1]["owners"]["capturePathSha256"], "restart changed App-rooted service paths")
    require(post[1]["owners"] == post[2]["owners"], "no-update check changed service identity")
    require(post[0]["installedAppPathSha256"] == post[1]["installedAppPathSha256"] == post[2]["installedAppPathSha256"], "canonical installed App identity changed")
    require(post[0]["roots"] == post[1]["roots"] == post[2]["roots"], "standard-root identity changed")
    require(post[0]["applicationUpdate"] == post[1]["applicationUpdate"] == post[2]["applicationUpdate"], "application update state changed")
    require(post[1].get("operatorAttestation", {}).get("restartLogin") is True, "restart/login operator checkpoint is missing")
    require(post[2].get("operatorAttestation", {}).get("noUpdateAvailableInProductUI") is True, "no-update UI operator checkpoint is missing")
    if scenario == "upgrade":
        require(post[0].get("upgrade") == post[1].get("upgrade") == post[2].get("upgrade"), "post-commit migration identity drifted")


def validate(args: argparse.Namespace) -> dict[str, Any]:
    require(args.tag == TAG, f"controller only validates {TAG}")
    require(args.scenario in {"fresh", "upgrade"}, "scenario must be fresh or upgrade")
    if args.scenario == "fresh":
        require(args.journey is None, "fresh scenario cannot select an upgrade journey")
        allowed = FRESH
    else:
        require(args.journey in {"upgrade-success", "upgrade-cancel-retry"}, "upgrade journey is invalid")
        allowed = UPGRADE | (CANCEL_RETRY if args.journey == "upgrade-cancel-retry" else set())

    ledger = args.ledger
    info = ledger.lstat()
    require(stat.S_ISDIR(info.st_mode) and not ledger.is_symlink(), "returned ledger must be a non-symlink directory")
    require(stat.S_IMODE(info.st_mode) == 0o700 and info.st_uid == os.getuid(), "returned ledger must be controller-owned 0700")
    actual = {entry.name for entry in ledger.iterdir()}
    require(actual == allowed, f"returned ledger exact allowlist mismatch; incomplete or unexpected files: {sorted(actual ^ allowed)}")
    paths = {name: ledger / name for name in allowed}
    for path in paths.values():
        private_file(path, path.name)

    dmg_sha, checksums_sha = artifact_binding(args.dmg, args.checksums, args.tag)
    preflight = json_file(ledger / "preflight.json")
    require(preflight.get("schema") == 1 and preflight.get("formalAcceptance") is False and preflight.get("status") == "passed", "preflight is incomplete")
    require(preflight.get("scenario") == args.scenario and preflight.get("releaseTag") == TAG, "preflight scenario/tag binding is wrong")
    require(preflight.get("dmgSha256") == dmg_sha and preflight.get("checksumsSha256") == checksums_sha, "preflight public artifact SHA binding is wrong")
    expected_name = args.dmg.name
    require(preflight.get("dmgUrl") == f"https://github.com/{REPOSITORY}/releases/download/{TAG}/{expected_name}", "preflight DMG source URL is wrong")
    require(preflight.get("checksumsUrl") == f"https://github.com/{REPOSITORY}/releases/download/{TAG}/checksums.txt", "preflight checksums source URL is wrong")
    version_match = re.fullmatch(r"([0-9]+)\.([0-9]+)(?:\.([0-9]+))?", str(preflight.get("macOSVersion", "")))
    require(version_match is not None and int(version_match.group(1)) >= 14, "preflight target is not macOS 14 or newer")
    require(preflight.get("architecture") == "arm64" and preflight.get("browserProvenanceVerified") is True, "preflight architecture/provenance is wrong")
    require(preflight.get("hostDependenciesAbsent") is (args.scenario == "fresh"), "preflight hidden host-dependency classification is wrong")
    harness_sha = require_sha(preflight.get("harnessManifestSha256"), "harness manifest binding")
    require(preflight.get("harnessBuildMode") == ("policy-test" if args.policy_test else "formal"), "preflight harness build mode is wrong")
    source_revision = preflight.get("sourceRevision")
    require(isinstance(source_revision, str) and REVISION.fullmatch(source_revision), "preflight source revision is invalid")

    state = parse_state(ledger / "state", {"schema", "tag", "dmg_sha256", "phase"})
    require(state["schema"] == "1" and state["tag"] == TAG and state["dmg_sha256"] == dmg_sha, "target state artifact binding drifted")
    require(state["phase"] == ("completed" if args.scenario == "fresh" else "awaiting_finder_drag"), "target state completion phase is invalid")

    values = {name: json_file(path) for name, path in paths.items() if name.endswith(".json")}
    expected_classifications: dict[str, str] = {}
    for name in ("bundle-observation.json", "bundle-restart-login.json", "bundle-no-update.json"):
        expected_classifications[name] = "harness_policy_test" if args.policy_test else "formal_bundle_observation"
    journey_files = {
        name for name in values
        if name.startswith("journey-") or name.startswith("pre-test-share") or
        name.startswith("test-share") or name.startswith("pre-production-share") or
        name.startswith("production-share") or name.startswith("upgrade-journey")
    }
    for name in journey_files:
        expected_classifications[name] = "journey_policy_test" if args.policy_test else "formal_journey_observation"
    for name in ("post-commit-baseline.json", "post-commit-restart-login.json", "check-for-updates-no-update.json"):
        expected_classifications[name] = "post_commit_policy_test" if args.policy_test else "formal_post_commit_observation"
    for name in values:
        if name.startswith("upgrade-") and name not in {"upgrade-journey.json", "upgrade-journey-restart-login.json", "upgrade-journey-no-update.json"}:
            expected_classifications[name] = "upgrade_migration_policy_test" if args.policy_test else "formal_upgrade_migration_observation"
    for name, classification in expected_classifications.items():
        require(values[name].get("classification") == classification, f"{name} classification does not match the harness build mode")
    require(values["mount.json"] == {"schema": 1, "readOnly": True, "noBrowse": True, "noAutoOpen": True, "volumeName": "Yulu"}, "mounted public DMG evidence is not exact")
    if args.scenario == "fresh":
        require((ledger / "service-baseline.txt").read_text(encoding="utf-8") == "all-known-yulu-launchagents=absent\n", "fresh service baseline is invalid")
        require((ledger / "guidance-checkpoint.txt").read_text(encoding="utf-8") == "confirmed-with-zero-service-mutation\n", "fresh guidance checkpoint is invalid")
    baseline_bundle = values["bundle-observation.json"]
    baseline_identity = validate_bundle(baseline_bundle)
    for name in ("bundle-restart-login.json", "bundle-no-update.json"):
        require(validate_bundle(values[name]) == baseline_identity and values[name].get("release") == baseline_bundle.get("release") and values[name].get("signatures") == baseline_bundle.get("signatures"), "bundle contents/inventory/signatures changed after commit")

    journey_names = ["production-share.json", "journey-restart-login.json", "journey-no-update.json"] if args.scenario == "fresh" else ["upgrade-journey.json", "upgrade-journey-restart-login.json", "upgrade-journey-no-update.json"]
    for name in journey_names:
        validate_journey(values[name], args.scenario)

    preflight_sha = digest(ledger / "preflight.json")
    bundle_sha = digest(ledger / "bundle-observation.json")
    if args.scenario == "fresh":
        validate_fresh_sequence(values)
    else:
        validate_upgrade_files(values, ledger, args.journey, preflight_sha, bundle_sha)
    validate_post_commit(values, paths, args.scenario)

    if args.policy_test:
        require(args.tool_bin is not None and args.tool_bin.is_absolute(), "policy-test requires an absolute isolated tool-bin")
        tools = {name: args.tool_bin / name for name in ("git", "gh", "verify_dmg.sh")}
        for name, path in tools.items():
            require(path.is_file() and os.access(path, os.X_OK) and not path.is_symlink(), f"policy {name} fake is unavailable")
        git_command = [str(tools["git"]), "-C", str(Path(__file__).resolve().parents[2]), "rev-parse", "--verify", f"refs/tags/{TAG}{TAG_COMMIT_SUFFIX}"]
        gh_command = [
            str(tools["gh"]), "attestation", "verify", str(args.dmg),
            "--repo", REPOSITORY, "--source-digest", source_revision,
            "--signer-workflow", SIGNER_WORKFLOW,
        ]
        verify_command = [str(tools["verify_dmg.sh"]), str(args.dmg)]
    else:
        require(args.tool_bin is None, "formal controller tool paths cannot be overridden")
        repo = Path(__file__).resolve().parents[2]
        git_command = ["/usr/bin/git", "-C", str(repo), "rev-parse", "--verify", f"refs/tags/{TAG}{TAG_COMMIT_SUFFIX}"]
        gh_candidates = [Path("/opt/homebrew/bin/gh"), Path("/usr/local/bin/gh"), Path("/usr/bin/gh")]
        gh = next((path for path in gh_candidates if path.is_file() and os.access(path, os.X_OK)), None)
        require(gh is not None, "formal controller requires a fixed trusted gh installation")
        verify_script = repo / "packaging" / "scripts" / "verify_dmg.sh"
        require(verify_script.is_file() and not verify_script.is_symlink(), "repository verify_dmg.sh is unavailable")
        gh_command = [
            str(gh), "attestation", "verify", str(args.dmg),
            "--repo", REPOSITORY, "--source-digest", source_revision,
            "--signer-workflow", SIGNER_WORKFLOW,
        ]
        verify_command = ["/bin/bash", str(verify_script), str(args.dmg)]

    tag_result = subprocess.run(
        git_command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=30, check=False,
        env={**os.environ, "LC_ALL": "C", "PATH": AUTHORITY_PATH, "YULU_EXPECTED_TEAM_ID": TEAM_ID},
    )
    require(tag_result.returncode == 0 and tag_result.stdout.strip() == source_revision, "local public release tag commit does not equal evidence sourceRevision")
    validate_rebuilt_harness(args.policy_test, source_revision, harness_sha)
    run_authority(gh_command, "gh attestation verify")
    run_authority(verify_command, "verify_dmg.sh")

    return {
        "schema": 1,
        "classification": "returned_ledger_policy_test" if args.policy_test else "controller_returned_ledger_validation",
        "formalAcceptance": False,
        "status": "validated",
        "scenario": args.scenario,
        "journey": args.journey,
        "releaseTag": TAG,
        "dmgSha256": dmg_sha,
        "checksumsSha256": checksums_sha,
        "harnessManifestSha256": harness_sha,
        "sourceRevision": source_revision,
    }


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy-test", action="store_true")
    parser.add_argument("--scenario", required=True, choices=("fresh", "upgrade"))
    parser.add_argument("--journey", choices=("upgrade-success", "upgrade-cancel-retry"))
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--dmg", type=Path, required=True)
    parser.add_argument("--checksums", type=Path, required=True)
    parser.add_argument("--tool-bin", type=Path)
    return parser.parse_args()


def main() -> int:
    try:
        result = validate(arguments())
    except (InvalidLedger, OSError, subprocess.TimeoutExpired) as error:
        print(f"validate_returned_public_dmg.py: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
