from __future__ import annotations

import hashlib
import json
import subprocess
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator
from urllib.parse import quote

import pytest

from test_public_dmg_acceptance import _run_flow


ROOT = Path(__file__).resolve().parents[1]
OBSERVER = ROOT / "packaging" / "acceptance" / "observe_journey.mjs"
TAG = "v0.23.0-rc.9"
TRANSCRIPT = "private transcript bait"
SUMMARY = "private summary bait"
STEM = "private-title_20260831_120000"
TASK_ID = "11111111-1111-4111-8111-111111111111"
RECEIPT_URL = "https://private.example/receipt/pii"
DESTINATION = "private destination bait"
CONNECTION_ID = "private-connection-id"
CONNECTION_REVISION = "b" * 64
CONNECTION_UPDATED_AT = "2026-08-31T00:00:00Z"
TEST_ACTION_ID = "22222222-2222-4222-8222-222222222222"
PRODUCTION_ACTION_ID = "33333333-3333-4333-8333-333333333333"
TEST_RECEIPT_ID = "private-test-receipt-id"
PRODUCTION_RECEIPT_ID = "private-production-receipt-id"
LIST_INPUT = quote(json.dumps({"limit": 2}, separators=(",", ":")), safe="")
GET_INPUT = quote(json.dumps({"stem": STEM}, separators=(",", ":")), safe="")


def _sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _trpc(data: object) -> dict[str, object]:
    return {"result": {"data": data}}


def _responses(*, core: bool) -> dict[str, object]:
    health = {
        "status": "ok",
        "serviceOwner": "com.yulu.ui",
        "productVersion": "0.23.0-rc.9",
        "bundleVersion": "2304",
        "database": {"status": "ok", "schemaVersion": 1, "minimumReadableVersion": 1},
    }
    sharing = {
        "sensitiveHistoricalReceiptUrl": RECEIPT_URL,
        "destination": {"configured": True, "value": DESTINATION, "savedAt": "2026-08-31T00:00:00Z"},
        "sharingReadiness": {
            "status": "untested",
            "detail": "private sharing detail bait",
            "receipt": None,
            "actionId": None,
            "action": None,
            "duplicateWarningRequired": False,
        },
    }
    if not core:
        onboarding = {
            "version": "phase-13-v1",
            "entry": {"installationKind": "fresh", "shouldAutoEnter": True},
            "coreActivation": {"completed": False, "evidence": None},
        }
        activation = {"state": "unresolved", "evidence": None}
        recordings: list[dict[str, object]] = []
        tasks: list[dict[str, object]] = []
    else:
        evidence = {
            "recordingStem": STEM,
            "taskId": TASK_ID,
            "transcriptionProvider": "xai",
            "summaryProvider": "xai",
            "summaryModel": "grok-4.6",
            "artifacts": {
                "audio": {"sha256": "a" * 64, "bytes": 4096},
                "transcript": {"sha256": _sha(TRANSCRIPT), "bytes": len(TRANSCRIPT.encode())},
                "summary": {"sha256": _sha(SUMMARY), "bytes": len(SUMMARY.encode())},
            },
            "completedAt": "2026-08-31T00:01:00Z",
        }
        onboarding = {
            "version": "phase-13-v1",
            "entry": {"installationKind": "fresh", "shouldAutoEnter": False},
            "coreActivation": {"completed": True, "evidence": evidence},
        }
        activation = {
            "state": "activated",
            "evidence": evidence,
            "sourceArtifacts": {"audio": True, "transcript": True, "summary": True},
            "completedNoteAvailable": True,
            "completedNote": SUMMARY,
        }
        recordings = [{
            "stem": STEM,
            "title": "private title bait",
            "firstWords": TRANSCRIPT,
            "hasTranscript": True,
            "hasSummary": True,
        }]
        tasks = [{
            "id": TASK_ID,
            "state": "completed",
            "sendToNotion": False,
            "deliverySessionId": None,
            "audioPath": "/Users/private/Movies/Yulu/private.wav",
            "title": "private task title bait",
            "instructions": "private instructions bait",
            "error": "private error bait",
            "nativeSessionId": "private-native-session",
        }]
    result = {
        "/healthz": health,
        "/trpc/onboarding.status": _trpc(onboarding),
        "/trpc/activation.status": _trpc(activation),
        f"/trpc/recordings.list?input={LIST_INPUT}": _trpc(recordings),
        "/trpc/sharing.view": _trpc(sharing),
    }
    if core:
        result[f"/trpc/recordings.get?input={GET_INPUT}"] = _trpc({
            "stem": STEM,
            "title": "private title bait",
            "wavPath": "/Users/private/Movies/Yulu/private.wav",
            "audioFile": "private.wav",
            "sizeBytes": 4096,
            "transcript": TRANSCRIPT,
            "summary": SUMMARY,
            "summaryStale": False,
            "status": "idle",
            "agentTask": None,
            "recordingShare": {
                "status": "untested",
                "detail": "private recording share detail",
                "snapshot": {"summary": SUMMARY, "destination": DESTINATION},
                "latestAction": None,
                "actionCounts": {"total": 0, "verified": 0},
                "duplicateWarningRequired": False,
            },
            "notionDelivery": None,
        })
        result["/trpc/agentTasks.list"] = _trpc(tasks)
    return result


def _share_responses(stage: str) -> dict[str, object]:
    responses = _responses(core=True)
    onboarding = responses["/trpc/onboarding.status"]["result"]["data"]
    sharing = responses["/trpc/sharing.view"]["result"]["data"]
    recording_share = responses[f"/trpc/recordings.get?input={GET_INPUT}"]["result"]["data"]["recordingShare"]
    sharing.update({
        "connections": [{"id": CONNECTION_ID, "adapter": "codex", "label": "private connection label"}],
        "selection": {"connectionId": CONNECTION_ID, "connector": "notion"},
        "connectorReadiness": {
            "status": "ready", "detail": "private connector probe detail", "remediation": "",
        },
        "destination": {"configured": True, "value": DESTINATION, "savedAt": "2026-08-31T00:00:00Z"},
    })
    snapshot_identity = {
        "recordingStem": STEM,
        "summary": SUMMARY,
        "summarySha256": _sha(SUMMARY),
        "connection": {
            "id": CONNECTION_ID,
            "adapter": "codex",
            "label": "private connection label",
            "updatedAt": CONNECTION_UPDATED_AT,
        },
        "connector": "notion",
        "destination": DESTINATION,
    }
    snapshot = {**snapshot_identity, "hash": _sha(json.dumps(snapshot_identity, separators=(",", ":")))}
    recording_share.update({
        "status": "ready",
        "snapshot": snapshot,
        "latestAction": None,
        "actionCounts": {"total": 0, "verified": 0},
        "duplicateWarningRequired": False,
    })
    optional_capabilities = [
        {
            "id": "conversation", "contractVersion": "conversation-v1",
            "outcome": {
                "onboardingVersion": "phase-13-v1", "capability": "conversation",
                "contractVersion": "conversation-v1", "outcome": "deferred",
            },
            "readiness": {"state": "not_tested", "detail": "private conversation detail"},
        },
        {
            "id": "calendar-source", "contractVersion": "calendar-source-v1",
            "outcome": {
                "onboardingVersion": "phase-13-v1", "capability": "calendar-source",
                "contractVersion": "calendar-source-v1", "outcome": "adopted",
            },
            "readiness": {"state": "ready", "detail": "private calendar detail"},
        },
        {
            "id": "agent-calendar-connector", "contractVersion": "agent-calendar-connector-v1",
            "outcome": {
                "onboardingVersion": "phase-13-v1", "capability": "agent-calendar-connector",
                "contractVersion": "agent-calendar-connector-v1", "outcome": "deferred",
            },
            "readiness": {"state": "not_tested", "detail": "private connector detail"},
        },
    ]
    if stage == "pre-test":
        onboarding["optionalCapabilities"] = [*optional_capabilities, {
            "id": "sharing", "contractVersion": "sharing-v1", "outcome": None,
            "readiness": {"state": "not_tested", "detail": "private detail bait"},
        }]
        onboarding["completion"] = {
            "completed": False, "currentVersionCompleted": False, "version": None, "completedAt": None,
        }
        return responses

    test_receipt_url = RECEIPT_URL + "/test"
    sharing.update({
        "sharingReadiness": {
            "status": "ready",
            "detail": "private verified detail bait",
            "remediation": "",
            "receipt": {"id": TEST_RECEIPT_ID, "url": test_receipt_url, "verifiedAt": "2026-08-31T00:02:00Z"},
            "actionId": TEST_ACTION_ID,
            "action": {"id": TEST_ACTION_ID, "receiptId": TEST_RECEIPT_ID, "receiptUrl": test_receipt_url},
            "duplicateWarningRequired": True,
        },
    })
    onboarding["optionalCapabilities"] = [*optional_capabilities, {
        "id": "sharing",
        "contractVersion": "sharing-v1",
        "outcome": {
            "onboardingVersion": "phase-13-v1",
            "capability": "sharing",
            "contractVersion": "sharing-v1",
            "outcome": "adopted",
            "evidence": {
                "kind": "sharing-test-share",
                "reference": f"sharing-test-share:{TEST_ACTION_ID}",
                "snapshot": {
                    "capability": "sharing",
                    "connectionId": CONNECTION_ID,
                    "adapter": "codex",
                    "connectionRevision": CONNECTION_REVISION,
                    "connector": "notion",
                    "destination": DESTINATION,
                    "destinationSavedAt": "2026-08-31T00:00:00Z",
                    "actionId": TEST_ACTION_ID,
                    "contentSha256": "c" * 64,
                    "receiptId": TEST_RECEIPT_ID,
                    "receiptUrl": test_receipt_url,
                    "verifiedAt": "2026-08-31T00:02:00Z",
                },
            },
        },
        "readiness": {"state": "ready", "detail": "private ready detail bait"},
    }]
    onboarding["completion"] = {
        "completed": True, "currentVersionCompleted": True,
        "version": "phase-13-v1", "completedAt": "2026-08-31T00:02:01Z",
    }
    if stage == "production":
        recording_share.update({
            "latestAction": {
                "id": PRODUCTION_ACTION_ID,
                "status": "verified",
                "receiptId": PRODUCTION_RECEIPT_ID,
                "receiptUrl": RECEIPT_URL + "/production",
                "detail": "private production receipt detail bait",
            },
            "actionCounts": {"total": 1, "verified": 1},
            "duplicateWarningRequired": True,
        })
    return responses


@contextmanager
def _server(
    responses: dict[str, object] | object, *, delay_path: str | None = None,
) -> Iterator[tuple[str, list[tuple[str, str, dict[str, str], bytes]]]]:
    requests: list[tuple[str, str, dict[str, str], bytes]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            length = int(self.headers.get("content-length", "0"))
            body = self.rfile.read(length) if length else b""
            requests.append((self.command, self.path, dict(self.headers), body))
            if delay_path == self.path:
                time.sleep(0.35)
            value = responses(self.path) if callable(responses) else responses.get(self.path)
            if isinstance(value, tuple):
                status, headers, payload = value
            elif value is None:
                status, headers, payload = 404, {}, {"error": "missing fixture"}
            else:
                status, headers, payload = 200, {}, value
            encoded = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            for key, header_value in headers.items():
                self.send_header(key, header_value)
            self.end_headers()
            try:
                self.wfile.write(encoded)
            except BrokenPipeError:
                pass

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def _observe(
    mode: str,
    base_url: str,
    *,
    timeout_ms: int = 1000,
    max_bytes: int = 65536,
    binding_evidence: Path | None = None,
    external_destination_no_run_marker_confirmed: bool = False,
) -> subprocess.CompletedProcess[str]:
    args = [
        "node", str(OBSERVER), "--policy-test", "--mode", mode,
        "--base-url", base_url, "--release-tag", TAG,
        "--timeout-ms", str(timeout_ms), "--max-bytes", str(max_bytes),
    ]
    if binding_evidence is not None:
        args.extend(["--binding-evidence", str(binding_evidence)])
    if external_destination_no_run_marker_confirmed:
        args.append("--external-destination-no-run-marker-confirmed")
    return subprocess.run(
        args,
        text=True,
        capture_output=True,
        check=False,
        timeout=5,
    )


def _failed(result: subprocess.CompletedProcess[str], word: str) -> None:
    assert result.returncode != 0, result.stdout
    assert word.lower() in result.stderr.lower(), result.stderr


def test_baseline_uses_only_exact_read_only_gets_and_proves_fresh_zero_state() -> None:
    with _server(_responses(core=False)) as (base_url, requests):
        result = _observe("baseline", base_url)
    assert result.returncode == 0, result.stderr
    evidence = json.loads(result.stdout)
    assert evidence == {
        "schema": 1,
        "classification": "journey_policy_test",
        "formalAcceptance": False,
        "checkpoint": "baseline",
        "releaseTag": TAG,
        "health": {
            "status": "ok",
            "serviceOwner": "com.yulu.ui",
            "databaseStatus": "ok",
            "database": {"schemaVersion": 1, "minimumReadableVersion": 1},
        },
        "version": {"product": "0.23.0-rc.9", "bundle": "2304"},
        "ipc": {"transport": "ipv4-loopback-http", "readOnly": True},
        "onboarding": {"installationKind": "fresh", "coreCompleted": False},
        "recordings": {"count": 0},
        "sharing": {"status": "untested", "actionPresent": False, "receiptPresent": False},
    }
    assert [request[1] for request in requests] == [
        "/healthz",
        "/trpc/onboarding.status",
        "/trpc/activation.status",
        f"/trpc/recordings.list?input={LIST_INPUT}",
        "/trpc/sharing.view",
    ]
    assert all(method == "GET" and body == b"" for method, _path, _headers, body in requests)
    assert all(not any(key.lower() in {"authorization", "cookie"} for key in headers) for _, _, headers, _ in requests)


def test_core_activation_proves_exact_artifacts_completed_task_and_zero_share_without_pii() -> None:
    with _server(_responses(core=True)) as (base_url, requests):
        result = _observe("core-activation", base_url)
    assert result.returncode == 0, result.stderr
    evidence = json.loads(result.stdout)
    assert evidence["formalAcceptance"] is False
    assert evidence["checkpoint"] == "core-activation"
    assert evidence["recording"]["opaqueIdSha256"] == _sha(STEM)
    assert evidence["task"] == {
        "opaqueIdSha256": _sha(TASK_ID),
        "state": "completed",
        "sendToNotion": False,
        "deliverySessionId": None,
    }
    assert evidence["activation"]["provider"] == {"transcription": "xai", "summary": "xai", "model": "grok-4.6"}
    assert evidence["activation"]["artifacts"] == _responses(core=True)["/trpc/activation.status"]["result"]["data"]["evidence"]["artifacts"]
    combined = result.stdout + result.stderr
    for secret in (
        STEM, TRANSCRIPT, SUMMARY, "private title bait", "/Users/private", DESTINATION,
        RECEIPT_URL, "private instructions bait", "private-native-session", "private error bait",
    ):
        assert secret not in combined
    assert [request[1] for request in requests] == [
        "/healthz",
        "/trpc/onboarding.status",
        "/trpc/activation.status",
        f"/trpc/recordings.list?input={LIST_INPUT}",
        f"/trpc/recordings.get?input={GET_INPUT}",
        "/trpc/agentTasks.list",
        "/trpc/sharing.view",
    ]


def test_upgrade_post_proves_returning_onboarding_and_zero_share_without_pii(tmp_path: Path) -> None:
    before = tmp_path / "migration-before.json"
    before.write_text(json.dumps({
        "schema": 1,
        "classification": "v0.22.2_representative_state_policy_test",
        "formalAcceptance": False,
        "status": "migration_before_captured",
        "tag": "v0.22.2",
        "media": {"audio": {"path": f"/Users/private/Movies/Yulu/{STEM}.wav"}},
    }, separators=(",", ":")) + "\n")
    before.chmod(0o600)
    responses = _responses(core=True)
    onboarding = responses["/trpc/onboarding.status"]["result"]["data"]
    onboarding["entry"] = {"installationKind": "returning", "shouldAutoEnter": True}
    onboarding["optionalCapabilities"] = [{
        "id": "sharing",
        "contractVersion": "sharing-v1",
        "outcome": None,
        "readiness": {"state": "not_tested", "detail": "private readiness bait"},
    }]
    with _server(responses) as (base_url, requests):
        result = _observe("upgrade-post", base_url, binding_evidence=before)
    assert result.returncode == 0, result.stderr
    evidence = json.loads(result.stdout)
    assert evidence["onboarding"] == {"installationKind": "returning", "sharingAdopted": False}
    assert evidence["productionShare"]["actionCounts"] == {"total": 0, "verified": 0}
    assert evidence["migrationBeforeSha256"] == hashlib.sha256(before.read_bytes()).hexdigest()
    assert evidence["recording"]["opaqueIdSha256"] == _sha(STEM)
    assert [request[1] for request in requests] == [
        "/healthz",
        "/trpc/onboarding.status",
        "/trpc/sharing.view",
        f"/trpc/recordings.get?input={GET_INPUT}",
    ]
    combined = result.stdout + result.stderr
    for secret in (STEM, TRANSCRIPT, SUMMARY, DESTINATION, RECEIPT_URL, "/Users/private"):
        assert secret not in combined


def test_manual_sharing_modes_prove_cancel_then_exactly_one_bound_production_action(tmp_path: Path) -> None:
    with _server(_share_responses("pre-test")) as (base_url, _requests):
        pre_test = _observe(
            "pre-test-share",
            base_url,
            external_destination_no_run_marker_confirmed=True,
        )
    assert pre_test.returncode == 0, pre_test.stderr
    pre_test_evidence = json.loads(pre_test.stdout)
    assert pre_test_evidence["productionShare"]["actionCounts"] == {"total": 0, "verified": 0}
    assert pre_test_evidence["operatorAttestation"] == {
        "externalDestinationNoRunMarkerConfirmed": True,
    }
    assert set(pre_test_evidence["sharing"]["binding"]) == {
        "connectionIdentitySha256", "destinationSha256", "connector",
    }
    pre_test_path = tmp_path / "pre-test-share.json"
    pre_test_path.write_text(pre_test.stdout)
    pre_test_path.chmod(0o600)

    with _server(_share_responses("test-ready")) as (base_url, _requests):
        test_share = _observe("test-share", base_url, binding_evidence=pre_test_path)
        pre_production = _observe("pre-production-share", base_url)
    assert test_share.returncode == 0, test_share.stderr
    test_evidence = json.loads(test_share.stdout)
    assert test_evidence["test_share"]["status"] == "verified"
    assert test_evidence["test_share"]["adoption"] == "adopted"
    assert test_evidence["test_share"]["optionalOutcomes"] == {
        "onboardingVersion": "phase-13-v1",
        "currentCompleted": True,
        "capabilities": [
            {"id": "conversation", "contractVersion": "conversation-v1", "outcome": "deferred"},
            {"id": "calendar-source", "contractVersion": "calendar-source-v1", "outcome": "adopted"},
            {"id": "agent-calendar-connector", "contractVersion": "agent-calendar-connector-v1", "outcome": "deferred"},
            {"id": "sharing", "contractVersion": "sharing-v1", "outcome": "adopted"},
        ],
    }
    assert test_evidence["productionShare"]["actionCounts"] == {"total": 0, "verified": 0}
    assert pre_production.returncode == 0, pre_production.stderr
    binding_path = tmp_path / "pre-production-share.json"
    binding_path.write_text(pre_production.stdout)
    binding_path.chmod(0o600)
    binding = json.loads(pre_production.stdout)["productionShare"]["binding"]
    assert set(binding) == {
        "snapshotSha256", "summarySha256", "recordingIdSha256",
        "connectionSha256", "destinationSha256", "connector",
    }

    with _server(_share_responses("test-ready")) as (base_url, _requests):
        cancelled = _observe("production-share-cancelled", base_url, binding_evidence=binding_path)
    assert cancelled.returncode == 0, cancelled.stderr
    assert json.loads(cancelled.stdout)["productionShare"]["actionCounts"] == {"total": 0, "verified": 0}

    with _server(_share_responses("production")) as (base_url, _requests):
        production = _observe("production-share", base_url, binding_evidence=binding_path)
    assert production.returncode == 0, production.stderr
    production_evidence = json.loads(production.stdout)
    assert production_evidence["productionShare"]["actionCounts"] == {"total": 1, "verified": 1}
    assert production_evidence["productionShare"]["latestAction"] == {
        "opaqueIdSha256": _sha(PRODUCTION_ACTION_ID),
        "status": "verified",
        "receiptIdentitySha256": _sha(PRODUCTION_RECEIPT_ID + "\0" + RECEIPT_URL + "/production"),
    }
    assert production_evidence["productionShare"]["binding"] == binding
    combined = pre_test.stdout + test_share.stdout + pre_production.stdout + cancelled.stdout + production.stdout
    for secret in (
        STEM, TRANSCRIPT, SUMMARY, DESTINATION, CONNECTION_ID, "private connection label",
        TEST_ACTION_ID, PRODUCTION_ACTION_ID, TEST_RECEIPT_ID, PRODUCTION_RECEIPT_ID, RECEIPT_URL,
    ):
        assert secret not in combined


@pytest.mark.parametrize(
    ("stage", "mode", "mutation", "message"),
    [
        ("test-ready", "test-share", ("sharing", "status", "failed"), "test share"),
        ("test-ready", "test-share", ("sharing", "receiptId", "wrong"), "receipt"),
        ("test-ready", "test-share", ("onboarding", "outcome", None), "adoption"),
        ("test-ready", "production-share-cancelled", ("recording", "actionCounts", {"total": 1, "verified": 0}), "cancel"),
        ("production", "production-share", ("recording", "actionCounts", {"total": 2, "verified": 2}), "exactly one"),
        ("production", "production-share", ("recording", "actionCounts", {"total": 1, "verified": 0}), "verified"),
        ("production", "production-share", ("recording", "status", "failed"), "verified"),
        ("production", "production-share", ("recording", "status", "unknown"), "verified"),
        ("production", "production-share", ("recording", "status", "abandoned"), "verified"),
        ("production", "production-share", ("recording", "status", "pending"), "verified"),
        ("production", "production-share", ("recording", "destination", "stale private destination"), "binding"),
    ],
)
def test_manual_sharing_modes_fail_closed(
    tmp_path: Path,
    stage: str,
    mode: str,
    mutation: tuple[str, str, object],
    message: str,
) -> None:
    with _server(_share_responses("pre-test")) as (base_url, _requests):
        pre_test = _observe(
            "pre-test-share",
            base_url,
            external_destination_no_run_marker_confirmed=True,
        )
    assert pre_test.returncode == 0, pre_test.stderr
    pre_test_path = tmp_path / "pre-test.json"
    pre_test_path.write_text(pre_test.stdout)
    pre_test_path.chmod(0o600)

    baseline_responses = _share_responses("test-ready")
    with _server(baseline_responses) as (base_url, _requests):
        baseline = _observe("pre-production-share", base_url)
    assert baseline.returncode == 0, baseline.stderr
    binding_path = tmp_path / "binding.json"
    binding_path.write_text(baseline.stdout)
    binding_path.chmod(0o600)

    responses = _share_responses(stage)
    target, field, value = mutation
    if target == "sharing":
        readiness = responses["/trpc/sharing.view"]["result"]["data"]["sharingReadiness"]
        if field == "receiptId":
            readiness["action"]["receiptId"] = value
        else:
            readiness[field] = value
    elif target == "onboarding":
        responses["/trpc/onboarding.status"]["result"]["data"]["optionalCapabilities"][-1][field] = value
    else:
        recording_share = responses[f"/trpc/recordings.get?input={GET_INPUT}"]["result"]["data"]["recordingShare"]
        if field == "destination":
            recording_share["snapshot"][field] = value
        elif field == "status":
            recording_share["latestAction"][field] = value
        else:
            recording_share[field] = value
    with _server(responses) as (base_url, _requests):
        evidence = binding_path if mode in {"production-share-cancelled", "production-share"} else pre_test_path
        _failed(_observe(mode, base_url, binding_evidence=evidence), message)


def test_pre_test_share_requires_configured_clean_destination_and_binds_test_share(tmp_path: Path) -> None:
    for field, value, message in (
        ("selection", None, "selection"),
        ("destination", {"configured": False, "value": "", "savedAt": None}, "destination"),
        ("connectorReadiness", {"status": "untested"}, "probe"),
    ):
        responses = _share_responses("pre-test")
        responses["/trpc/sharing.view"]["result"]["data"][field] = value
        with _server(responses) as (base_url, _requests):
            _failed(_observe(
                "pre-test-share",
                base_url,
                external_destination_no_run_marker_confirmed=True,
            ), message)

    with _server(_share_responses("pre-test")) as (base_url, _requests):
        _failed(_observe("pre-test-share", base_url), "run marker")

    with _server(_share_responses("pre-test")) as (base_url, _requests):
        baseline = _observe(
            "pre-test-share",
            base_url,
            external_destination_no_run_marker_confirmed=True,
        )
    baseline_path = tmp_path / "pre-test.json"
    baseline_path.write_text(baseline.stdout)
    baseline_path.chmod(0o600)
    changed = _share_responses("test-ready")
    changed_destination = "changed private destination"
    changed["/trpc/sharing.view"]["result"]["data"]["destination"]["value"] = changed_destination
    changed["/trpc/onboarding.status"]["result"]["data"]["optionalCapabilities"][-1][
        "outcome"
    ]["evidence"]["snapshot"]["destination"] = changed_destination
    recording_snapshot = changed[f"/trpc/recordings.get?input={GET_INPUT}"]["result"]["data"][
        "recordingShare"
    ]["snapshot"]
    recording_snapshot["destination"] = changed_destination
    recording_snapshot["hash"] = _sha(json.dumps({
        key: value for key, value in recording_snapshot.items() if key != "hash"
    }, separators=(",", ":")))
    with _server(changed) as (base_url, _requests):
        _failed(_observe("test-share", base_url, binding_evidence=baseline_path), "binding")


def test_target_manual_journey_checkpoints_write_private_resumable_evidence(tmp_path: Path) -> None:
    baseline = _responses(core=False)
    core = _responses(core=True)
    configured = _share_responses("pre-test")
    test_ready = _share_responses("test-ready")
    production = _share_responses("production")
    phase = {"name": "baseline", "test_ready_sharing_reads": 0}

    def response(path: str) -> object:
        selected = {
            "baseline": baseline,
            "core": core,
            "configured": configured,
            "test-ready": test_ready,
            "production": production,
        }[phase["name"]]
        value = selected.get(path)
        if phase["name"] == "baseline" and path == "/trpc/sharing.view":
            phase["name"] = "core"
        elif phase["name"] == "core" and path == "/trpc/sharing.view":
            phase["name"] = "configured"
        elif phase["name"] == "configured" and path == "/trpc/sharing.view":
            phase["name"] = "test-ready"
        elif phase["name"] == "test-ready" and path == "/trpc/sharing.view":
            phase["test_ready_sharing_reads"] += 1
            if phase["test_ready_sharing_reads"] == 3:
                phase["name"] = "production"
        return value

    with _server(response) as (base_url, _requests):
        result, ledger = _run_flow(
            tmp_path,
            journey_base_url=base_url,
            interrupt_core_and_resume=True,
            interrupt_production_and_resume=True,
        )
    assert result.returncode == 0, result.stderr
    assert "ACTION_REQUIRED app-baseline" in result.stdout
    assert "ACTION_REQUIRED core-activation" in result.stdout
    assert result.stdout.count("ACTION_REQUIRED core-activation") == 2
    assert "Do not use Test Share or Share" in result.stdout
    assert "ACTION_REQUIRED test-share-configuration" in result.stdout
    assert "ACTION_REQUIRED test-share" in result.stdout
    assert "ACTION_REQUIRED production-share-cancel" in result.stdout
    assert "ACTION_REQUIRED production-share" in result.stdout
    assert result.stdout.count("ACTION_REQUIRED production-share token=") == 2
    assert "ACTION_REQUIRED post-commit-restart-login" in result.stdout
    assert "ACTION_REQUIRED check-for-updates-no-update" in result.stdout
    assert "phase=completed" in (ledger / "state").read_text()
    baseline_evidence = json.loads((ledger / "journey-baseline.json").read_text())
    core_evidence = json.loads((ledger / "journey-core-activation.json").read_text())
    assert baseline_evidence["checkpoint"] == "baseline"
    assert core_evidence["checkpoint"] == "core-activation"
    assert (ledger / "journey-baseline.json").stat().st_mode & 0o777 == 0o600
    assert (ledger / "journey-core-activation.json").stat().st_mode & 0o777 == 0o600
    sharing_evidence = [
        json.loads((ledger / name).read_text())
        for name in (
            "pre-test-share.json", "test-share.json", "pre-production-share.json",
            "production-share-cancelled.json", "production-share.json",
        )
    ]
    assert sharing_evidence[0]["operatorAttestation"] == {
        "externalDestinationNoRunMarkerConfirmed": True,
    }
    assert sharing_evidence[-1]["productionShare"]["actionCounts"] == {"total": 1, "verified": 1}
    assert all((ledger / name).stat().st_mode & 0o777 == 0o600 for name in (
        "pre-test-share.json", "test-share.json", "pre-production-share.json",
        "production-share-cancelled.json", "production-share.json",
    ))
    post_commit = [
        json.loads((ledger / name).read_text())
        for name in (
            "post-commit-baseline.json",
            "post-commit-restart-login.json",
            "check-for-updates-no-update.json",
        )
    ]
    assert [item["checkpoint"] for item in post_commit] == [
        "post-commit-baseline",
        "post-commit-restart-login",
        "check-for-updates-no-update",
    ]
    assert post_commit[-1]["operatorAttestation"]["noUpdateAvailableInProductUI"] is True
    assert post_commit[-1]["applicationUpdate"]["applicationResidues"] == 0
    combined = json.dumps([baseline_evidence, core_evidence, sharing_evidence])
    for secret in (STEM, TRANSCRIPT, SUMMARY, DESTINATION, "/Users/private"):
        assert secret not in combined


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (("/healthz", "serviceOwner", "wrong.owner"), "service owner"),
        (("/healthz", "productVersion", "0.23.0-rc.3"), "version"),
        (("/trpc/onboarding.status", "entry", {"installationKind": "returning"}), "fresh"),
        (("/trpc/activation.status", "sourceArtifacts", {"audio": True, "transcript": False, "summary": True}), "artifact"),
        (("/trpc/agentTasks.list", "state", "running"), "completed"),
        (("/trpc/agentTasks.list", "sendToNotion", True), "sendtonotion"),
        (("/trpc/agentTasks.list", "deliverySessionId", "private-delivery"), "deliverysessionid"),
        (("/trpc/sharing.view", "actionId", "share-action"), "share"),
        (("/trpc/recordings.get", "latestAction", {"id": "production-share"}), "share"),
        (("/trpc/recordings.get", "duplicateWarningRequired", True), "share"),
    ],
)
def test_core_activation_fails_closed_for_invalid_state(mutation: tuple[str, str, object], message: str) -> None:
    responses = _responses(core=True)
    route, field, value = mutation
    if route == "/healthz":
        responses[route][field] = value
    elif route == "/trpc/onboarding.status":
        responses[route]["result"]["data"][field] = value
    elif route == "/trpc/activation.status":
        responses[route]["result"]["data"][field] = value
    elif route == "/trpc/agentTasks.list":
        responses[route]["result"]["data"][0][field] = value
    elif route == "/trpc/sharing.view":
        responses[route]["result"]["data"]["sharingReadiness"][field] = value
    else:
        responses[f"{route}?input={GET_INPUT}"]["result"]["data"]["recordingShare"][field] = value
    with _server(responses) as (base_url, _requests):
        _failed(_observe("core-activation", base_url), message)


@pytest.mark.parametrize("duplicate", [False, True])
def test_core_activation_requires_one_exact_evidence_task(duplicate: bool) -> None:
    responses = _responses(core=True)
    tasks = responses["/trpc/agentTasks.list"]["result"]["data"]
    if duplicate:
        tasks.append(dict(tasks[0]))
    else:
        tasks[0]["id"] = "22222222-2222-4222-8222-222222222222"
    with _server(responses) as (base_url, _requests):
        _failed(_observe("core-activation", base_url), "exactly one")


def test_core_activation_rejects_transcript_or_summary_not_matching_evidence() -> None:
    for field in ("transcript", "summary"):
        responses = _responses(core=True)
        responses[f"/trpc/recordings.get?input={GET_INPUT}"]["result"]["data"][field] = "changed private bait"
        with _server(responses) as (base_url, _requests):
            _failed(_observe("core-activation", base_url), "current")


def test_observer_rejects_nonloopback_redirect_oversize_timeout_and_bad_envelope() -> None:
    _failed(_observe("baseline", "http://localhost:7777"), "loopback")
    _failed(_observe("baseline", "https://127.0.0.1:7777"), "loopback")

    for name, response, message, timeout, maximum in (
        ("redirect", (302, {"Location": "http://127.0.0.1:1/healthz"}, {}), "status", 1000, 65536),
        ("oversize", b"{" + b"x" * 1024, "large", 1000, 128),
        ("envelope", {"result": {"data": None}, "extra": True}, "schema", 1000, 65536),
    ):
        responses = _responses(core=False)
        responses["/healthz" if name != "envelope" else "/trpc/onboarding.status"] = response
        with _server(responses) as (base_url, _requests):
            _failed(_observe("baseline", base_url, timeout_ms=timeout, max_bytes=maximum), message)

    with _server(_responses(core=False), delay_path="/healthz") as (base_url, _requests):
        _failed(_observe("baseline", base_url, timeout_ms=50), "timeout")


def test_observer_source_has_no_mutation_token_auth_or_dynamic_path_surface() -> None:
    source = OBSERVER.read_text()
    for forbidden in (
        "fetch(", "method: \"POST\"", "method: 'POST'", "/api/ui-token", "Authorization",
        "Cookie", ".mutation", "testShare", "shareRecording",
    ):
        assert forbidden not in source
    for required in (
        "/healthz", "/trpc/onboarding.status", "/trpc/activation.status",
        "/trpc/recordings.list", "/trpc/recordings.get", "/trpc/agentTasks.list",
        "/trpc/sharing.view",
    ):
        assert required in source


def test_fresh_optional_outcome_contract_uses_exact_current_manifest_and_manual_checkpoint() -> None:
    source = OBSERVER.read_text()
    driver = (ROOT / "packaging" / "acceptance" / "public_dmg_target.sh").read_text()
    for capability, contract in (
        ("conversation", "conversation-v1"),
        ("calendar-source", "calendar-source-v1"),
        ("agent-calendar-connector", "agent-calendar-connector-v1"),
        ("sharing", "sharing-v1"),
    ):
        assert capability in source
        assert contract in source
    assert "currentVersionCompleted" in source
    assert "I-ADOPTED-OR-DEFERRED-FRESH-OPTIONAL-CAPABILITIES" in driver
    assert "awaiting_optional_outcomes" in driver


@pytest.mark.parametrize("mutation", ["duplicate", "contract", "outcome", "completion"])
def test_fresh_optional_outcomes_fail_closed_for_nonexact_or_incomplete_projection(mutation: str) -> None:
    responses = _share_responses("test-ready")
    onboarding = responses["/trpc/onboarding.status"]["result"]["data"]
    capabilities = onboarding["optionalCapabilities"]
    if mutation == "duplicate":
        capabilities.append(dict(capabilities[0]))
    elif mutation == "contract":
        capabilities[0]["contractVersion"] = "conversation-v0"
    elif mutation == "outcome":
        capabilities[0]["outcome"]["outcome"] = "pending"
    else:
        onboarding["completion"]["currentVersionCompleted"] = False
    with _server(responses) as (base_url, _requests):
        result = _observe("pre-production-share", base_url)
    assert result.returncode != 0
    assert "optional" in result.stderr.lower() or "onboarding" in result.stderr.lower()
