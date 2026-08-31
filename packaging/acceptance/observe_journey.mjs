#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import http from "node:http";

const FORMAL_BASE_URL = "http://127.0.0.1:7777";
const FORMAL_NODE = "/Applications/Yulu.app/Contents/Resources/runtime/bin/node";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
// Match @trpc/client 11.17.0's default JSON transformer: query input is the
// procedure input itself, not a superjson-style `{ json: ... }` envelope.
const LIST_INPUT = encodeURIComponent(JSON.stringify({ limit: 2 }));

function fail(message) {
  process.stderr.write(`observe_journey.mjs: ${message}\n`);
  process.exit(1);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireRecord(value, message) {
  if (!isRecord(value)) fail(message);
  return value;
}

function requireString(value, message) {
  if (typeof value !== "string" || value.length === 0) fail(message);
  return value;
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function parsePositiveInteger(value, name, maximum) {
  if (!/^[0-9]+$/.test(value ?? "")) fail(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    fail(`${name} is outside the allowed range`);
  }
  return parsed;
}

let policyTest = false;
let mode = "";
let baseUrlText = "";
let releaseTag = "";
let timeoutMs = DEFAULT_TIMEOUT_MS;
let maxBytes = DEFAULT_MAX_BYTES;
let timeoutOverridden = false;
let maxBytesOverridden = false;
let bindingEvidencePath = "";
let externalDestinationNoRunMarkerConfirmed = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  switch (argument) {
    case "--policy-test":
      policyTest = true;
      break;
    case "--mode":
      mode = process.argv[++index] ?? "";
      break;
    case "--base-url":
      baseUrlText = process.argv[++index] ?? "";
      break;
    case "--release-tag":
      releaseTag = process.argv[++index] ?? "";
      break;
    case "--timeout-ms":
      timeoutOverridden = true;
      timeoutMs = parsePositiveInteger(process.argv[++index], "timeout-ms", 30_000);
      break;
    case "--max-bytes":
      maxBytesOverridden = true;
      maxBytes = parsePositiveInteger(process.argv[++index], "max-bytes", DEFAULT_MAX_BYTES);
      break;
    case "--binding-evidence":
      bindingEvidencePath = process.argv[++index] ?? "";
      break;
    case "--external-destination-no-run-marker-confirmed":
      externalDestinationNoRunMarkerConfirmed = true;
      break;
    default:
      fail("unknown argument");
  }
}

const MODES = new Set([
  "baseline",
  "core-activation",
  "pre-test-share",
  "test-share",
  "pre-production-share",
  "production-share-cancelled",
  "production-share",
  "upgrade-post",
]);
if (!MODES.has(mode)) fail("mode is invalid");
if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?$/.test(releaseTag)) fail("release tag is invalid");
if (!policyTest && (timeoutOverridden || maxBytesOverridden)) fail("formal network bounds cannot be overridden");
const requiresBindingEvidence = mode === "test-share" || mode === "production-share-cancelled" ||
  mode === "production-share" || mode === "upgrade-post";
if (requiresBindingEvidence !== Boolean(bindingEvidencePath)) {
  fail("binding evidence is required only for bound Share checkpoints");
}
if ((mode === "pre-test-share") !== externalDestinationNoRunMarkerConfirmed) {
  fail("pre-Test Share requires the operator's external destination no run marker confirmation");
}
if (!policyTest) {
  let actualNode = "";
  try {
    actualNode = realpathSync(process.execPath);
  } catch {
    fail("installed Application Runtime Node identity is unreadable");
  }
  if (actualNode !== FORMAL_NODE) fail("formal observer must use the installed Application Runtime Node");
}

let baseUrl;
try {
  baseUrl = new URL(baseUrlText || FORMAL_BASE_URL);
} catch {
  fail("base URL is invalid");
}
if (
  baseUrl.protocol !== "http:" || baseUrl.hostname !== "127.0.0.1" ||
  baseUrl.username !== "" || baseUrl.password !== "" ||
  baseUrl.pathname !== "/" || baseUrl.search !== "" || baseUrl.hash !== ""
) {
  fail("base URL must be an exact IPv4 loopback HTTP origin");
}
if (!policyTest && baseUrl.origin !== FORMAL_BASE_URL) fail("formal observer requires the fixed loopback service origin");
if (policyTest && (!baseUrl.port || Number(baseUrl.port) < 1 || Number(baseUrl.port) > 65_535)) {
  fail("policy-test requires an explicit loopback port");
}

function readJson(path, trpc = false) {
  const url = new URL(path, `${baseUrl.origin}/`);
  if (url.origin !== baseUrl.origin) return Promise.reject(new Error("request escaped the loopback origin"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = http.get(url, (response) => {
      const status = response.statusCode ?? 0;
      if (status !== 200) {
        response.resume();
        rejectOnce(new Error(`read-only GET returned status ${status}`));
        return;
      }
      const contentType = response.headers["content-type"] ?? "";
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        response.resume();
        rejectOnce(new Error("read-only GET response schema has a non-JSON content type"));
        return;
      }
      const declared = Number(response.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        rejectOnce(new Error("read-only GET response is too large"));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy();
          rejectOnce(new Error("read-only GET response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", rejectOnce);
      response.on("end", () => {
        if (settled) return;
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          rejectOnce(new Error("read-only GET response schema is invalid JSON"));
          return;
        }
        if (trpc) {
          if (!exactKeys(parsed, ["result"]) || !exactKeys(parsed.result, ["data"])) {
            rejectOnce(new Error("tRPC response schema is invalid"));
            return;
          }
          parsed = parsed.result.data;
          if (parsed === null || parsed === undefined) {
            rejectOnce(new Error("tRPC response schema has no data"));
            return;
          }
        }
        settled = true;
        resolve(parsed);
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      rejectOnce(new Error("read-only GET response timeout"));
    });
    request.on("error", rejectOnce);
  });
}

function validateHealth(value) {
  const health = requireRecord(value, "health response schema is invalid");
  if (health.status !== "ok") fail("health status is not ok");
  if (health.serviceOwner !== "com.yulu.ui") fail("health service owner is not com.yulu.ui");
  const database = requireRecord(health.database, "health database schema is invalid");
  if (database.status !== "ok") fail("health database status is not ok");
  if (!Number.isSafeInteger(database.schemaVersion) || !Number.isSafeInteger(database.minimumReadableVersion)) {
    fail("health database schema version is invalid");
  }
  const productVersion = requireString(health.productVersion, "health product version is missing");
  if (productVersion !== releaseTag.slice(1)) fail("health product version does not match the release tag");
  const bundleVersion = requireString(health.bundleVersion, "health bundle version is missing");
  return {
    health: {
      status: "ok",
      serviceOwner: "com.yulu.ui",
      databaseStatus: "ok",
      database: {
        schemaVersion: database.schemaVersion,
        minimumReadableVersion: database.minimumReadableVersion,
      },
    },
    version: { product: productVersion, bundle: bundleVersion },
    ipc: { transport: "ipv4-loopback-http", readOnly: true },
  };
}

function validateFreshOnboarding(value, expectedCompleted) {
  const onboarding = requireRecord(value, "onboarding response schema is invalid");
  const entry = requireRecord(onboarding.entry, "onboarding entry schema is invalid");
  if (entry.installationKind !== "fresh") fail("onboarding entry is not fresh");
  const core = requireRecord(onboarding.coreActivation, "onboarding core activation schema is invalid");
  if (core.completed !== expectedCompleted) fail("onboarding core activation completion is inconsistent");
  if (!expectedCompleted && core.evidence !== null) fail("fresh baseline unexpectedly contains Core Activation Evidence");
  if (expectedCompleted && !isRecord(core.evidence)) fail("Core Activation Evidence is missing");
  return core.evidence;
}

function validateSharing(value) {
  const sharing = requireRecord(value, "sharing view schema is invalid");
  const readiness = requireRecord(sharing.sharingReadiness, "sharing readiness schema is invalid");
  if (
    readiness.status !== "untested" || readiness.actionId !== null || readiness.action !== null ||
    readiness.receipt !== null || readiness.duplicateWarningRequired !== false
  ) {
    fail("Test Share or Share action evidence already exists");
  }
  return { status: "untested", actionPresent: false, receiptPresent: false };
}

function fingerprint(value, kind) {
  const record = requireRecord(value, `${kind} artifact schema is invalid`);
  if (!/^[0-9a-f]{64}$/.test(record.sha256 ?? "")) fail(`${kind} artifact SHA-256 is invalid`);
  if (!Number.isSafeInteger(record.bytes) || record.bytes < 1) fail(`${kind} artifact bytes are invalid`);
  return { sha256: record.sha256, bytes: record.bytes };
}

function coreEvidence(value) {
  const evidence = requireRecord(value, "Core Activation Evidence schema is invalid");
  const recordingStem = requireString(evidence.recordingStem, "Core Activation Evidence recording identity is missing");
  if (recordingStem.includes("/") || recordingStem.includes("\\")) fail("Core Activation Evidence recording identity is invalid");
  const taskId = requireString(evidence.taskId, "Core Activation Evidence task identity is missing");
  const transcriptionProvider = requireString(evidence.transcriptionProvider, "transcription provider evidence is missing");
  const summaryProvider = requireString(evidence.summaryProvider, "summary provider evidence is missing");
  const summaryModel = requireString(evidence.summaryModel, "summary model evidence is missing");
  const artifacts = requireRecord(evidence.artifacts, "Core Activation Evidence artifacts are missing");
  return {
    recordingStem,
    taskId,
    transcriptionProvider,
    summaryProvider,
    summaryModel,
    artifacts: {
      audio: fingerprint(artifacts.audio, "audio"),
      transcript: fingerprint(artifacts.transcript, "transcript"),
      summary: fingerprint(artifacts.summary, "summary"),
    },
  };
}

function sameFingerprint(left, right) {
  return left.sha256 === right.sha256 && left.bytes === right.bytes;
}

async function observeBaseline() {
  const healthEvidence = validateHealth(await readJson("/healthz"));
  const onboarding = await readJson("/trpc/onboarding.status", true);
  validateFreshOnboarding(onboarding, false);
  const activation = requireRecord(
    await readJson("/trpc/activation.status", true),
    "activation response schema is invalid",
  );
  if (activation.state !== "unresolved" || activation.evidence !== null) {
    fail("fresh baseline unexpectedly contains activation evidence");
  }
  const recordings = await readJson(`/trpc/recordings.list?input=${LIST_INPUT}`, true);
  if (!Array.isArray(recordings) || recordings.length !== 0) fail("fresh baseline recordings are not empty");
  const sharing = validateSharing(await readJson("/trpc/sharing.view", true));
  return {
    schema: 1,
    classification: policyTest ? "journey_policy_test" : "formal_journey_observation",
    formalAcceptance: false,
    checkpoint: "baseline",
    releaseTag,
    ...healthEvidence,
    onboarding: { installationKind: "fresh", coreCompleted: false },
    recordings: { count: 0 },
    sharing,
  };
}

async function readCoreActivation() {
  const healthEvidence = validateHealth(await readJson("/healthz"));
  const onboarding = await readJson("/trpc/onboarding.status", true);
  const onboardingEvidence = coreEvidence(validateFreshOnboarding(onboarding, true));
  const activation = requireRecord(
    await readJson("/trpc/activation.status", true),
    "activation response schema is invalid",
  );
  if (activation.state !== "activated") fail("Core Activation is not activated");
  const evidence = coreEvidence(activation.evidence);
  if (
    onboardingEvidence.recordingStem !== evidence.recordingStem ||
    onboardingEvidence.taskId !== evidence.taskId ||
    !sameFingerprint(onboardingEvidence.artifacts.audio, evidence.artifacts.audio) ||
    !sameFingerprint(onboardingEvidence.artifacts.transcript, evidence.artifacts.transcript) ||
    !sameFingerprint(onboardingEvidence.artifacts.summary, evidence.artifacts.summary)
  ) {
    fail("Core Activation Evidence projections disagree");
  }
  const sourceArtifacts = requireRecord(activation.sourceArtifacts, "Core Activation source artifact schema is invalid");
  if (sourceArtifacts.audio !== true || sourceArtifacts.transcript !== true || sourceArtifacts.summary !== true) {
    fail("Core Activation source artifacts are incomplete");
  }

  const recordings = await readJson(`/trpc/recordings.list?input=${LIST_INPUT}`, true);
  if (!Array.isArray(recordings) || recordings.length !== 1) fail("Core Activation must add exactly one recording");
  const row = requireRecord(recordings[0], "recording list schema is invalid");
  if (row.stem !== evidence.recordingStem || row.hasTranscript !== true || row.hasSummary !== true) {
    fail("Core Activation recording list evidence is incomplete");
  }
  const recordingInput = encodeURIComponent(JSON.stringify({ stem: evidence.recordingStem }));
  const recording = requireRecord(
    await readJson(`/trpc/recordings.get?input=${recordingInput}`, true),
    "recording detail schema is invalid",
  );
  if (recording.stem !== evidence.recordingStem) fail("recording identity does not match Core Activation Evidence");
  if (!Number.isSafeInteger(recording.sizeBytes) || recording.sizeBytes !== evidence.artifacts.audio.bytes) {
    fail("recording audio bytes do not match Core Activation Evidence");
  }
  const transcript = requireString(recording.transcript, "recording transcript is empty");
  const summary = requireString(recording.summary, "recording summary is empty");
  const observedTranscript = { sha256: sha256Text(transcript), bytes: utf8Bytes(transcript) };
  const observedSummary = { sha256: sha256Text(summary), bytes: utf8Bytes(summary) };
  if (!sameFingerprint(observedTranscript, evidence.artifacts.transcript)) {
    fail("recording transcript is not current Core Activation evidence");
  }
  if (!sameFingerprint(observedSummary, evidence.artifacts.summary) || recording.summaryStale !== false) {
    fail("recording summary is not current Core Activation evidence");
  }
  if (recording.agentTask !== null || recording.notionDelivery !== null) {
    fail("recording still has active processing or delivery state");
  }
  const recordingShare = requireRecord(recording.recordingShare, "recording Share view is missing");

  const tasks = await readJson("/trpc/agentTasks.list", true);
  if (!Array.isArray(tasks)) fail("agent task list schema is invalid");
  const matches = tasks.filter((task) => isRecord(task) && task.id === evidence.taskId);
  if (matches.length !== 1) fail("Core Activation Evidence must match exactly one agent task");
  const task = matches[0];
  if (task.state !== "completed") fail("Core Activation agent task is not completed");
  if (task.sendToNotion !== false) fail("Core Activation task sendToNotion is not false");
  if (task.deliverySessionId !== null) fail("Core Activation task deliverySessionId is not null");
  if (task.summaryProvider !== undefined && task.summaryProvider !== evidence.summaryProvider) {
    fail("Core Activation task summary provider disagrees with evidence");
  }
  if (task.summaryModel !== undefined && task.summaryModel !== evidence.summaryModel) {
    fail("Core Activation task summary model disagrees with evidence");
  }

  return {
    internal: { onboarding, evidence, recording, recordingShare },
    output: {
    schema: 1,
    classification: policyTest ? "journey_policy_test" : "formal_journey_observation",
    formalAcceptance: false,
    releaseTag,
    ...healthEvidence,
    onboarding: { installationKind: "fresh", coreCompleted: true },
    activation: {
      provider: {
        transcription: evidence.transcriptionProvider,
        summary: evidence.summaryProvider,
        model: evidence.summaryModel,
      },
      artifacts: evidence.artifacts,
      sourceArtifacts: { audio: true, transcript: true, summary: true },
    },
    recording: {
      opaqueIdSha256: sha256Text(evidence.recordingStem),
      count: 1,
      transcriptCurrent: true,
      summaryCurrent: true,
    },
    task: {
      opaqueIdSha256: sha256Text(evidence.taskId),
      state: "completed",
      sendToNotion: false,
      deliverySessionId: null,
    },
    },
  };
}

function validateNoProductionShare(recordingShare, checkpoint) {
  const counts = requireRecord(recordingShare.actionCounts, "production Share action count schema is invalid");
  if (
    counts.total !== 0 || counts.verified !== 0 || recordingShare.latestAction !== null ||
    recordingShare.duplicateWarningRequired !== false
  ) {
    fail(checkpoint === "production-share-cancelled"
      ? "cancelled production Share changed action or receipt counts"
      : "production Share action evidence already exists");
  }
  return { total: 0, verified: 0 };
}

function sharingCapability(onboarding) {
  if (!Array.isArray(onboarding.optionalCapabilities)) fail("onboarding optional capability schema is invalid");
  const matches = onboarding.optionalCapabilities.filter((capability) => isRecord(capability) && capability.id === "sharing");
  if (matches.length !== 1) fail("onboarding Sharing capability projection is not unique");
  return matches[0];
}

const FRESH_OPTIONAL_MANIFEST = new Map([
  ["conversation", "conversation-v1"],
  ["calendar-source", "calendar-source-v1"],
  ["agent-calendar-connector", "agent-calendar-connector-v1"],
  ["sharing", "sharing-v1"],
]);

function validateFreshOptionalOutcomes(onboarding, sharingAdopted) {
  if (!Array.isArray(onboarding.optionalCapabilities) ||
      onboarding.optionalCapabilities.length !== FRESH_OPTIONAL_MANIFEST.size) {
    fail("fresh onboarding optional capability manifest is incomplete");
  }
  const observed = [];
  for (const [id, contractVersion] of FRESH_OPTIONAL_MANIFEST) {
    const matches = onboarding.optionalCapabilities.filter((capability) =>
      isRecord(capability) && capability.id === id && capability.contractVersion === contractVersion
    );
    if (matches.length !== 1) fail("fresh onboarding capability projection is not exact and unique");
    const outcome = matches[0].outcome;
    if (id === "sharing" && !sharingAdopted) {
      if (outcome !== null) fail("fresh onboarding Sharing outcome exists before verified Test Share");
      observed.push({ id, contractVersion, outcome: "pending-verified-test-share" });
      continue;
    }
    const value = requireRecord(outcome, `fresh onboarding ${id} adoption/defer outcome is missing`);
    const allowed = id === "sharing" ? new Set(["adopted"]) : new Set(["adopted", "deferred"]);
    if (
      value.onboardingVersion !== "phase-13-v1" || value.capability !== id ||
      value.contractVersion !== contractVersion || !allowed.has(value.outcome)
    ) fail(`fresh onboarding ${id} outcome is invalid`);
    observed.push({ id, contractVersion, outcome: value.outcome });
  }
  const completion = requireRecord(onboarding.completion, "fresh onboarding completion projection is missing");
  if (
    completion.currentVersionCompleted !== sharingAdopted || completion.completed !== sharingAdopted ||
    (sharingAdopted && completion.version !== "phase-13-v1")
  ) fail("fresh onboarding current completion is inconsistent with exact optional outcomes");
  return {
    onboardingVersion: "phase-13-v1",
    currentCompleted: sharingAdopted,
    capabilities: observed,
  };
}

function validateNoSharingAdoption(onboarding) {
  const capability = sharingCapability(onboarding);
  if (capability.outcome !== null) fail("state already has Sharing adoption evidence");
}

function preTestBinding(value) {
  return {
    connectionIdentitySha256: sha256Text(`${value.connectionId}\0${value.adapter}\0${value.connector}`),
    destinationSha256: sha256Text(value.destination),
    connector: value.connector,
  };
}

function validatePreTestShare(sharingValue, onboarding) {
  const sharing = requireRecord(sharingValue, "sharing view schema is invalid");
  const selection = requireRecord(sharing.selection, "dedicated acceptance destination selection is missing");
  const destination = requireRecord(sharing.destination, "dedicated acceptance destination schema is invalid");
  if (destination.configured !== true) fail("dedicated acceptance destination is not configured");
  const destinationValue = requireString(destination.value, "dedicated acceptance destination is missing");
  requireString(destination.savedAt, "dedicated acceptance destination timestamp is missing");
  const connectionId = requireString(selection.connectionId, "dedicated acceptance connection selection is missing");
  const connector = requireString(selection.connector, "dedicated acceptance connector selection is missing");
  if (!Array.isArray(sharing.connections)) fail("dedicated acceptance connection list schema is invalid");
  const matches = sharing.connections.filter((connection) => isRecord(connection) && connection.id === connectionId);
  if (matches.length !== 1) fail("dedicated acceptance connection selection is not unique");
  const adapter = requireString(matches[0].adapter, "dedicated acceptance connection adapter is missing");
  const connectorReadiness = requireRecord(
    sharing.connectorReadiness,
    "dedicated acceptance connector probe schema is invalid",
  );
  if (connectorReadiness.status !== "ready") fail("dedicated acceptance connector probe is not ready");
  const readiness = requireRecord(sharing.sharingReadiness, "sharing readiness schema is invalid");
  if (
    readiness.status !== "untested" || readiness.actionId !== null || readiness.action !== null ||
    readiness.receipt !== null || readiness.duplicateWarningRequired !== false
  ) {
    fail("pre-Test Share destination already has Test Share evidence");
  }
  const optionalOutcomes = validateFreshOptionalOutcomes(onboarding, false);
  const internal = { connectionId, adapter, connector, destination: destinationValue };
  return {
    internal,
    output: {
      status: "untested",
      connectorProbe: "ready",
      binding: preTestBinding(internal),
      optionalOutcomes,
    },
  };
}

function validateTestShare(sharingValue, onboarding) {
  const sharing = requireRecord(sharingValue, "sharing view schema is invalid");
  const selection = requireRecord(sharing.selection, "verified Test Share selection is missing");
  const destination = requireRecord(sharing.destination, "verified Test Share destination schema is invalid");
  if (destination.configured !== true) fail("verified Test Share destination is not configured");
  const destinationValue = requireString(destination.value, "verified Test Share destination is missing");
  const destinationSavedAt = requireString(destination.savedAt, "verified Test Share destination timestamp is missing");
  const connectionId = requireString(selection.connectionId, "verified Test Share connection is missing");
  const connector = requireString(selection.connector, "verified Test Share connector is missing");
  if (!Array.isArray(sharing.connections)) fail("verified Test Share connection list schema is invalid");
  const connections = sharing.connections.filter((connection) => isRecord(connection) && connection.id === connectionId);
  if (connections.length !== 1) fail("verified Test Share connection projection is not unique");
  const connection = connections[0];
  const adapter = requireString(connection.adapter, "verified Test Share adapter is missing");

  const readiness = requireRecord(sharing.sharingReadiness, "sharing readiness schema is invalid");
  const actionId = requireString(readiness.actionId, "verified Test Share action is missing");
  const action = requireRecord(readiness.action, "verified Test Share action schema is invalid");
  const receipt = requireRecord(readiness.receipt, "verified Test Share receipt is missing");
  const receiptId = typeof receipt.id === "string" ? receipt.id : "";
  const receiptUrl = typeof receipt.url === "string" ? receipt.url : "";
  const verifiedAt = requireString(receipt.verifiedAt, "verified Test Share receipt timestamp is missing");
  if (
    readiness.status !== "ready" || readiness.duplicateWarningRequired !== true ||
    action.id !== actionId || action.receiptId !== receiptId || action.receiptUrl !== receiptUrl ||
    (!receiptId && !receiptUrl)
  ) {
    fail("Test Share receipt is not exactly verified");
  }

  const optionalOutcomes = validateFreshOptionalOutcomes(onboarding, true);
  const capability = sharingCapability(onboarding);
  const readinessProjection = requireRecord(capability.readiness, "onboarding Sharing readiness schema is invalid");
  const outcome = requireRecord(capability.outcome, "onboarding Sharing adoption evidence is missing");
  const adoptionEvidence = requireRecord(outcome.evidence, "onboarding Sharing adoption proof is missing");
  const snapshot = requireRecord(adoptionEvidence.snapshot, "onboarding Sharing adoption snapshot is missing");
  const connectionRevision = requireString(snapshot.connectionRevision, "Sharing adoption connection revision is missing");
  const contentSha256 = requireString(snapshot.contentSha256, "Sharing adoption content fingerprint is missing");
  if (
    capability.contractVersion !== "sharing-v1" || readinessProjection.state !== "ready" ||
    outcome.capability !== "sharing" || outcome.contractVersion !== "sharing-v1" || outcome.outcome !== "adopted" ||
    adoptionEvidence.kind !== "sharing-test-share" || adoptionEvidence.reference !== `sharing-test-share:${actionId}` ||
    snapshot.capability !== "sharing" || snapshot.connectionId !== connectionId || snapshot.adapter !== adapter ||
    snapshot.connector !== connector || snapshot.destination !== destinationValue ||
    snapshot.destinationSavedAt !== destinationSavedAt || snapshot.actionId !== actionId ||
    snapshot.receiptId !== receiptId || snapshot.receiptUrl !== receiptUrl || snapshot.verifiedAt !== verifiedAt ||
    !/^[0-9a-f]{64}$/.test(connectionRevision) || !/^[0-9a-f]{64}$/.test(contentSha256)
  ) {
    fail("Test Share onboarding adoption does not match the verified receipt");
  }
  return {
    internal: { connectionId, connectionRevision, adapter, connector, destination: destinationValue },
    output: {
      status: "verified",
      adoption: "adopted",
      actionIdSha256: sha256Text(actionId),
      receiptIdentitySha256: sha256Text(`${receiptId}\0${receiptUrl}`),
      connectionIdentitySha256: sha256Text(`${connectionId}\0${connectionRevision}`),
      destinationSha256: sha256Text(destinationValue),
      connector,
      contentSha256,
      optionalOutcomes,
    },
  };
}

function productionBinding(core, verifiedTest) {
  const snapshot = requireRecord(core.recordingShare.snapshot, "production Share snapshot is missing");
  const connection = requireRecord(snapshot.connection, "production Share connection snapshot is missing");
  const summarySha256 = sha256Text(core.recording.summary);
  if (
    snapshot.recordingStem !== core.evidence.recordingStem || snapshot.summary !== core.recording.summary ||
    snapshot.summarySha256 !== summarySha256 || snapshot.connection?.id !== verifiedTest.connectionId ||
    snapshot.connection?.adapter !== verifiedTest.adapter || snapshot.connector !== verifiedTest.connector ||
    snapshot.destination !== verifiedTest.destination
  ) {
    fail("production Share binding does not match Core Activation and verified Test Share");
  }
  const connectionUpdatedAt = requireString(connection.updatedAt, "production Share connection timestamp is missing");
  const connectionLabel = requireString(connection.label, "production Share connection label is missing");
  const identity = {
    recordingStem: snapshot.recordingStem,
    summary: snapshot.summary,
    summarySha256,
    connection: {
      id: connection.id,
      adapter: connection.adapter,
      label: connectionLabel,
      updatedAt: connectionUpdatedAt,
    },
    connector: snapshot.connector,
    destination: snapshot.destination,
  };
  const snapshotSha256 = sha256Text(JSON.stringify(identity));
  if (snapshot.hash !== snapshotSha256) fail("production Share snapshot fingerprint is invalid");
  return {
    snapshotSha256,
    summarySha256,
    recordingIdSha256: sha256Text(core.evidence.recordingStem),
    connectionSha256: sha256Text(JSON.stringify(identity.connection)),
    destinationSha256: sha256Text(snapshot.destination),
    connector: snapshot.connector,
  };
}

function readExpectedBinding(expectedCheckpoint) {
  if (!isAbsolute(bindingEvidencePath)) fail("binding evidence path must be absolute");
  let stat;
  try {
    stat = lstatSync(bindingEvidencePath);
  } catch {
    fail("binding evidence is unreadable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 64 * 1024 || (stat.mode & 0o777) !== 0o600) {
    fail("binding evidence file is unsafe");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(bindingEvidencePath, "utf8"));
  } catch {
    fail("binding evidence schema is invalid");
  }
  const evidence = requireRecord(parsed, "binding evidence schema is invalid");
  if (evidence.formalAcceptance !== false || evidence.checkpoint !== expectedCheckpoint) {
    fail("binding evidence checkpoint is invalid");
  }
  let binding;
  let keys;
  if (expectedCheckpoint === "pre-test-share") {
    const attestation = requireRecord(evidence.operatorAttestation, "binding evidence operator attestation is missing");
    if (attestation.externalDestinationNoRunMarkerConfirmed !== true) {
      fail("binding evidence lacks the external destination no run marker confirmation");
    }
    const sharing = requireRecord(evidence.sharing, "binding evidence Sharing schema is invalid");
    binding = requireRecord(sharing.binding, "binding evidence fingerprint set is missing");
    keys = ["connectionIdentitySha256", "destinationSha256", "connector"];
  } else {
    const productionShare = requireRecord(evidence.productionShare, "binding evidence production Share schema is invalid");
    binding = requireRecord(productionShare.binding, "binding evidence fingerprint set is missing");
    keys = [
      "snapshotSha256", "summarySha256", "recordingIdSha256",
      "connectionSha256", "destinationSha256", "connector",
    ];
  }
  if (!exactKeys(binding, keys)) fail("binding evidence fingerprint set is invalid");
  for (const key of keys.filter((key) => key !== "connector")) {
    if (!/^[0-9a-f]{64}$/.test(binding[key] ?? "")) fail("binding evidence fingerprint is invalid");
  }
  requireString(binding.connector, "binding evidence connector is missing");
  return binding;
}

function requireSameBinding(actual, expected) {
  if (Object.keys(expected).some((key) => actual[key] !== expected[key])) {
    fail("Share binding changed after its read-only baseline checkpoint");
  }
}

function readUpgradeBefore() {
  if (!isAbsolute(bindingEvidencePath)) fail("migration-before evidence path must be absolute");
  let stat;
  try {
    stat = lstatSync(bindingEvidencePath);
  } catch {
    fail("migration-before evidence is unreadable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 256 * 1024 || (stat.mode & 0o777) !== 0o600) {
    fail("migration-before evidence file is unsafe");
  }
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(bindingEvidencePath, "utf8"));
  } catch {
    fail("migration-before evidence schema is invalid");
  }
  const expectedClassification = policyTest
    ? "v0.22.2_representative_state_policy_test"
    : "formal_v0.22.2_representative_state_observation";
  if (
    !isRecord(evidence) || evidence.schema !== 1 || evidence.formalAcceptance !== false ||
    evidence.classification !== expectedClassification || evidence.status !== "migration_before_captured" ||
    evidence.tag !== "v0.22.2"
  ) fail("migration-before evidence is cross-mode or malformed");
  const audio = requireRecord(evidence.media?.audio, "migration-before recording evidence is missing");
  const audioPath = requireString(audio.path, "migration-before recording path is missing");
  const filename = audioPath.split("/").at(-1) ?? "";
  if (!filename.endsWith(".wav") || filename.includes("\\")) fail("migration-before recording identity is invalid");
  return { stem: filename.slice(0, -4), evidenceSha256: sha256Text(readFileSync(bindingEvidencePath, "utf8")) };
}

function validateProductionResult(recordingShare, expected) {
  const counts = requireRecord(recordingShare.actionCounts, "production Share action count schema is invalid");
  const latest = requireRecord(recordingShare.latestAction, "production Share verified action is missing");
  const receiptId = typeof latest.receiptId === "string" ? latest.receiptId : "";
  const receiptUrl = typeof latest.receiptUrl === "string" ? latest.receiptUrl : "";
  if (
    counts.total !== 1 || counts.verified !== 1 || latest.status !== "verified" ||
    !requireString(latest.id, "production Share action identity is missing") ||
    (!receiptId && !receiptUrl) || recordingShare.duplicateWarningRequired !== true
  ) {
    fail(counts.total !== 1 ? "production Share did not create exactly one action" : "production Share receipt is not verified");
  }
  return {
    actionCounts: { total: 1, verified: 1 },
    binding: expected,
    latestAction: {
      opaqueIdSha256: sha256Text(latest.id),
      status: "verified",
      receiptIdentitySha256: sha256Text(`${receiptId}\0${receiptUrl}`),
    },
  };
}

async function observeCoreActivation() {
  const core = await readCoreActivation();
  const sharing = validateSharing(await readJson("/trpc/sharing.view", true));
  const counts = validateNoProductionShare(core.internal.recordingShare, "core-activation");
  return {
    ...core.output,
    checkpoint: "core-activation",
    sharing,
    productionShare: { actionCounts: counts },
  };
}

async function observeSharingCheckpoint() {
  const core = await readCoreActivation();
  const sharingValue = await readJson("/trpc/sharing.view", true);
  if (mode === "pre-test-share") {
    const sharing = validatePreTestShare(sharingValue, core.internal.onboarding);
    const counts = validateNoProductionShare(core.internal.recordingShare, mode);
    return {
      ...core.output,
      checkpoint: mode,
      sharing: sharing.output,
      operatorAttestation: { externalDestinationNoRunMarkerConfirmed: true },
      productionShare: { actionCounts: counts },
    };
  }

  const verifiedTest = validateTestShare(sharingValue, core.internal.onboarding);
  const binding = productionBinding(core.internal, verifiedTest.internal);
  if (mode === "test-share") {
    requireSameBinding(preTestBinding(verifiedTest.internal), readExpectedBinding("pre-test-share"));
    const counts = validateNoProductionShare(core.internal.recordingShare, mode);
    return {
      ...core.output,
      checkpoint: mode,
      test_share: verifiedTest.output,
      productionShare: { actionCounts: counts, binding },
    };
  }
  if (mode === "pre-production-share") {
    const counts = validateNoProductionShare(core.internal.recordingShare, mode);
    return {
      ...core.output,
      checkpoint: mode,
      test_share: verifiedTest.output,
      productionShare: { actionCounts: counts, binding },
    };
  }

  const expected = readExpectedBinding("pre-production-share");
  requireSameBinding(binding, expected);
  if (mode === "production-share-cancelled") {
    const counts = validateNoProductionShare(core.internal.recordingShare, mode);
    return {
      ...core.output,
      checkpoint: mode,
      test_share: verifiedTest.output,
      productionShare: { actionCounts: counts, binding },
    };
  }
  return {
    ...core.output,
    checkpoint: mode,
    test_share: verifiedTest.output,
    productionShare: validateProductionResult(core.internal.recordingShare, binding),
  };
}

async function observeUpgradePost() {
  const migrationBefore = readUpgradeBefore();
  const healthEvidence = validateHealth(await readJson("/healthz"));
  const onboarding = requireRecord(
    await readJson("/trpc/onboarding.status", true),
    "returning onboarding response schema is invalid",
  );
  const entry = requireRecord(onboarding.entry, "returning onboarding entry is missing");
  if (entry.installationKind !== "returning") fail("migrated installation was incorrectly classified as fresh");
  validateNoSharingAdoption(onboarding);
  const sharing = validateSharing(await readJson("/trpc/sharing.view", true));
  const input = encodeURIComponent(JSON.stringify({ stem: migrationBefore.stem }));
  const recording = requireRecord(
    await readJson(`/trpc/recordings.get?input=${input}`, true),
    "migrated recording detail is missing",
  );
  if (recording.stem !== migrationBefore.stem) fail("migrated recording identity does not match migration-before evidence");
  const recordingShare = requireRecord(recording.recordingShare, "migrated recording Share view is missing");
  const counts = validateNoProductionShare(recordingShare, "upgrade-post");
  return {
    schema: 1,
    classification: policyTest ? "journey_policy_test" : "formal_journey_observation",
    formalAcceptance: false,
    checkpoint: "upgrade-post",
    releaseTag,
    ...healthEvidence,
    migrationBeforeSha256: migrationBefore.evidenceSha256,
    onboarding: { installationKind: "returning", sharingAdopted: false },
    recording: { opaqueIdSha256: sha256Text(migrationBefore.stem) },
    sharing,
    productionShare: { actionCounts: counts },
  };
}

try {
  const evidence = mode === "baseline"
    ? await observeBaseline()
    : mode === "core-activation"
      ? await observeCoreActivation()
      : mode === "upgrade-post"
        ? await observeUpgradePost()
        : await observeSharingCheckpoint();
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : "read-only journey observation failed");
}
