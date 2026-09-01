#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

const RELEASE_TAG = "v0.23.0-rc.6";
const FORMAL_APP = "/Applications/Yulu.app";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_BYTES = 1024 * 1024;
const LEGACY_LABELS = [
  "com.yulu.agentqueue",
  "com.yulu.calendar",
  "com.yulu.detector",
  "com.yulu.scheduler",
  "com.yulu.statusagent",
  "com.yulu.sttdaemon",
];

function fail(message) {
  process.stderr.write(`observe_post_commit.mjs: ${message}\n`);
  process.exit(1);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const options = {
  policyTest: false,
  checkpoint: "",
  scenario: "",
  releaseTag: "",
  preflight: "",
  bundle: "",
  journey: "",
  upgradeEvidence: "",
  priorEvidence: "",
  installedApp: "",
  home: "",
  applicationsRoot: "",
  systemBin: "",
  operatorRestartLoginConfirmed: false,
  operatorNoUpdateConfirmed: false,
};
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  switch (argument) {
    case "--policy-test": options.policyTest = true; break;
    case "--checkpoint": options.checkpoint = process.argv[++index] ?? ""; break;
    case "--scenario": options.scenario = process.argv[++index] ?? ""; break;
    case "--release-tag": options.releaseTag = process.argv[++index] ?? ""; break;
    case "--preflight": options.preflight = process.argv[++index] ?? ""; break;
    case "--bundle": options.bundle = process.argv[++index] ?? ""; break;
    case "--journey": options.journey = process.argv[++index] ?? ""; break;
    case "--upgrade-evidence": options.upgradeEvidence = process.argv[++index] ?? ""; break;
    case "--prior-evidence": options.priorEvidence = process.argv[++index] ?? ""; break;
    case "--installed-app": options.installedApp = process.argv[++index] ?? ""; break;
    case "--home": options.home = process.argv[++index] ?? ""; break;
    case "--applications-root": options.applicationsRoot = process.argv[++index] ?? ""; break;
    case "--system-bin": options.systemBin = process.argv[++index] ?? ""; break;
    case "--operator-restart-login-confirmed": options.operatorRestartLoginConfirmed = true; break;
    case "--operator-no-update-confirmed": options.operatorNoUpdateConfirmed = true; break;
    default: fail("unknown argument");
  }
}

const CHECKPOINTS = new Set([
  "post-commit-baseline",
  "post-commit-restart-login",
  "check-for-updates-no-update",
]);
if (!CHECKPOINTS.has(options.checkpoint)) fail("checkpoint is invalid");
if (!new Set(["fresh", "upgrade"]).has(options.scenario)) fail("scenario is invalid");
if (options.releaseTag !== RELEASE_TAG) fail("post-commit acceptance is pinned to v0.23.0-rc.6");
const needsPrior = options.checkpoint !== "post-commit-baseline";
if (needsPrior !== Boolean(options.priorEvidence)) fail("checkpoint prior-evidence binding is invalid");
if ((options.checkpoint === "post-commit-restart-login") !== options.operatorRestartLoginConfirmed) {
  fail("restart/login checkpoint requires the operator attestation");
}
if ((options.checkpoint === "check-for-updates-no-update") !== options.operatorNoUpdateConfirmed) {
  fail("no-update checkpoint requires the operator UI attestation");
}
if ((options.scenario === "upgrade") !== Boolean(options.upgradeEvidence)) {
  fail("upgrade scenario evidence binding is invalid");
}

if (!options.policyTest) {
  if (options.installedApp || options.home || options.applicationsRoot || options.systemBin) {
    fail("formal target paths cannot be overridden");
  }
  options.installedApp = FORMAL_APP;
  options.home = process.env.HOME ?? "";
  options.applicationsRoot = "/Applications";
  options.systemBin = "/";
  let actualNode = "";
  try { actualNode = realpathSync(process.execPath); } catch { fail("installed Application Runtime Node is unreadable"); }
  if (actualNode !== join(FORMAL_APP, "Contents/Resources/runtime/bin/node")) {
    fail("formal observer must use the installed Application Runtime Node");
  }
} else if (![options.installedApp, options.home, options.applicationsRoot, options.systemBin].every(isAbsolute)) {
  fail("policy-test requires absolute isolated target paths");
}

function safeJson(path, description) {
  if (!isAbsolute(path)) fail(`${description} path must be absolute`);
  let info;
  try { info = lstatSync(path); } catch { fail(`${description} is missing`); }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() ||
      info.size < 2 || info.size > MAX_JSON_BYTES || (info.mode & 0o777) !== 0o600) {
    fail(`${description} is unsafe`);
  }
  const raw = readFileSync(path, "utf8");
  let value;
  try { value = JSON.parse(raw); } catch { fail(`${description} JSON is invalid`); }
  return { value, sha256: sha256Text(raw) };
}

function systemPath(path) {
  return options.policyTest ? join(options.systemBin, path.split("/").at(-1)) : path;
}

function command(path, args, description, { allowFailure = false } = {}) {
  const result = spawnSync(systemPath(path), args, {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: MAX_COMMAND_BYTES,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
  });
  if (result.error || (!allowFailure && result.status !== 0)) fail(`${description} failed`);
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function launchOwner(label) {
  const result = command("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], `${label} launchd observation`, { allowFailure: true });
  if (result.status === 113) return null;
  if (result.status !== 0) fail(`${label} launchd observation was ambiguous`);
  const pid = Number(result.stdout.match(/\bpid\s*=\s*([1-9][0-9]*)\b/)?.[1] ?? 0);
  if (!Number.isSafeInteger(pid) || pid < 1) fail(`${label} has no unique PID generation`);
  return pid;
}

function appIdentity() {
  let info;
  try { info = lstatSync(options.installedApp); } catch { fail("installed App is missing"); }
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(options.installedApp) !== options.installedApp) {
    fail("installed App is not the canonical non-symlink /Applications/Yulu.app");
  }
  if (options.installedApp !== join(options.applicationsRoot, "Yulu.app")) fail("installed App path is not canonical");
  return sha256Text(options.installedApp);
}

function currentOwners(signatures) {
  const hostPid = launchOwner("com.yulu.ui");
  const capturePid = launchOwner("com.yulu.audiodaemon");
  if (!hostPid || !capturePid || hostPid === capturePid) fail("current Host and Capture owners are not unique");
  for (const label of LEGACY_LABELS) {
    if (launchOwner(label) !== null) fail("an old LaunchAgent owner revived after commit");
  }
  const hostExecutable = join(options.installedApp, "Contents/Resources/runtime/bin/node");
  const hostTarget = join(options.installedApp, "Contents/Resources/Host/server.js");
  const captureExecutable = join(options.installedApp, "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon");
  const hostCommand = command("/bin/ps", ["-p", String(hostPid), "-o", "command="], "Host process observation").stdout.trim();
  const captureCommand = command("/bin/ps", ["-p", String(capturePid), "-o", "command="], "Capture process observation").stdout.trim();
  if (!hostCommand.startsWith(`${hostExecutable} ${hostTarget}`) || captureCommand !== captureExecutable) {
    fail("current Host or Capture owner is not rooted in the installed App");
  }
  if (hostCommand.includes("/.yulu/") || captureCommand.includes("/.yulu/") ||
      hostCommand.includes("/.git/") || captureCommand.includes("/.git/")) {
    fail("a checkout or legacy writable runtime owns a current service");
  }
  if (!isRecord(signatures?.host) || !isRecord(signatures?.capture) ||
      signatures.host.teamIdentifier !== "WMU9678ZQL" || signatures.capture.teamIdentifier !== "WMU9678ZQL" ||
      !signatures.host.cdHash || !signatures.capture.cdHash) {
    fail("current Host or Capture signature binding is missing");
  }
  const ownerPids = (result, description) => {
    const values = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0])) fail(`${description} is not uniquely owned`);
    return Number(values[0]);
  };
  const listenerPid = ownerPids(
    command(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-iTCP@127.0.0.1:7777", "-sTCP:LISTEN", "-t"],
      "Host IPv4 loopback listener observation",
    ),
    "Host IPv4 loopback listener",
  );
  if (listenerPid !== hostPid) fail("127.0.0.1:7777 listener is not owned by the current Host PID");
  const captureSocket = join(options.home, "Library/Caches/Yulu/audio_daemon.sock");
  let socketInfo;
  try { socketInfo = lstatSync(captureSocket); } catch { fail("canonical current Capture socket is missing"); }
  if (!socketInfo.isSocket() || socketInfo.isSymbolicLink() || socketInfo.uid !== process.getuid()) {
    fail("canonical current Capture socket is unsafe");
  }
  const socketPid = ownerPids(
    command("/usr/sbin/lsof", ["-nP", "-t", captureSocket], "Capture socket owner observation"),
    "canonical current Capture socket",
  );
  if (socketPid !== capturePid) fail("canonical current Capture socket is not owned by the current Capture PID");
  const legacySocket = join(options.home, ".config/yulu/audio_daemon.sock");
  try { lstatSync(legacySocket); fail("legacy Capture socket revived after takeover"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  return {
    hostPidSha256: sha256Text(String(hostPid)),
    capturePidSha256: sha256Text(String(capturePid)),
    hostPathSha256: sha256Text(hostCommand),
    capturePathSha256: sha256Text(captureCommand),
    signedTeamIdentifier: "WMU9678ZQL",
    hostListenerOwnerPidSha256: sha256Text(String(listenerPid)),
    captureSocketOwnerPidSha256: sha256Text(String(socketPid)),
    captureSocketPathSha256: sha256Text(captureSocket),
    legacyCaptureSocketAbsent: true,
  };
}

function rootEvidence() {
  const standardRoot = join(options.home, "Library/Application Support/Yulu");
  let info;
  try { info = lstatSync(standardRoot); } catch { fail("standard Yulu data root is missing"); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || realpathSync(standardRoot) !== standardRoot) {
    fail("standard Yulu data root is unsafe");
  }
  const launchAgents = join(options.home, "Library/LaunchAgents");
  try {
    if (readdirSync(launchAgents).some((name) => /^com\.yulu\..+\.plist$/.test(name))) {
      fail("an old Yulu LaunchAgent plist revived after commit");
    }
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return { standardRootsOnly: true, dataRootSha256: sha256Text(standardRoot), legacyWritableRuntimeOwner: false };
}

function updateState() {
  const journalPath = join(options.home, "Library/Application Support/Yulu/application-update/journal.json");
  let journalSha256 = null;
  try {
    lstatSync(journalPath);
  } catch (error) {
    if (error?.code !== "ENOENT") fail("application update journal state is unreadable");
  }
  try {
    lstatSync(journalPath);
    journalSha256 = safeJson(journalPath, "application update journal").sha256;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const residues = readdirSync(options.applicationsRoot).filter(
    (name) => name.startsWith(".Yulu.rollback.") || name.startsWith(".Yulu.failed.") ||
      name.startsWith(".Yulu.staging.") || name.startsWith(".Yulu.update."),
  );
  if (residues.length !== 0) fail("Applications contains update staging, failed, or rollback residue");
  return { journalPresent: journalSha256 !== null, journalSha256, applicationResidues: 0 };
}

const preflight = safeJson(options.preflight, "public-DMG preflight");
if (preflight.value?.schema !== 1 || preflight.value?.formalAcceptance !== false ||
    preflight.value?.status !== "passed" || preflight.value?.scenario !== options.scenario ||
    preflight.value?.releaseTag !== RELEASE_TAG || !isSha256(preflight.value?.harnessManifestSha256) ||
    !/^[0-9a-f]{40,64}$/.test(preflight.value?.sourceRevision ?? "")) {
  fail("public-DMG preflight binding is invalid");
}
const bundle = safeJson(options.bundle, "bundle observation");
if (bundle.value?.schema !== 1 || bundle.value?.formalAcceptance !== false || bundle.value?.status !== "matched" ||
    bundle.value?.release?.releaseVersion !== RELEASE_TAG.slice(1) || !isSha256(bundle.value?.contents?.sha256) ||
    !isSha256(bundle.value?.runtimeInventory?.sha256) || !isRecord(bundle.value?.signatures)) {
  fail("bundle contents, inventory, release, or signature binding is invalid");
}
const journey = safeJson(options.journey, "journey observation");
const expectedJourneyCheckpoint = options.scenario === "fresh" ? "production-share" : "upgrade-post";
const expectedShares = options.scenario === "fresh" ? 1 : 0;
if (journey.value?.schema !== 1 || journey.value?.formalAcceptance !== false ||
    journey.value?.checkpoint !== expectedJourneyCheckpoint || journey.value?.releaseTag !== RELEASE_TAG ||
    journey.value?.health?.status !== "ok" || journey.value?.health?.serviceOwner !== "com.yulu.ui" ||
    journey.value?.health?.databaseStatus !== "ok" || !Number.isSafeInteger(journey.value?.health?.database?.schemaVersion) ||
    !Number.isSafeInteger(journey.value?.health?.database?.minimumReadableVersion) ||
    journey.value?.version?.product !== RELEASE_TAG.slice(1) || journey.value?.ipc?.readOnly !== true ||
    journey.value?.productionShare?.actionCounts?.total !== expectedShares ||
    journey.value?.productionShare?.actionCounts?.verified !== expectedShares) {
  fail("Host health, product version, IPC, database schema, or Share evidence is invalid");
}

let upgrade = null;
if (options.upgradeEvidence) {
  upgrade = safeJson(options.upgradeEvidence, "upgrade evidence");
  if (upgrade.value?.schema !== 1 || upgrade.value?.formalAcceptance !== false ||
      !new Set(["committed", "committed_stable"]).has(upgrade.value?.checkpoint) ||
      upgrade.value?.releaseTag !== RELEASE_TAG || upgrade.value?.transaction?.phase !== "committed" ||
      !isSha256(upgrade.value?.journalSha256) || !isSha256(upgrade.value?.transaction?.idSha256)) {
    fail("committed upgrade journal binding is invalid");
  }
}

const installedAppPathSha256 = appIdentity();
const owners = currentOwners(bundle.value.signatures);
const roots = rootEvidence();
const applicationUpdate = updateState();
let prior = null;
if (options.priorEvidence) {
  prior = safeJson(options.priorEvidence, "prior post-commit evidence").value;
  if (prior?.schema !== 1 || prior?.formalAcceptance !== false || prior?.releaseTag !== RELEASE_TAG ||
      prior?.scenario !== options.scenario || prior?.preflightSha256 !== preflight.sha256 ||
      prior?.bundleContentsSha256 !== bundle.value.contents.sha256 ||
      prior?.runtimeInventorySha256 !== bundle.value.runtimeInventory.sha256 ||
      prior?.bundleObservationSha256 !== bundle.sha256 || prior?.journeyObservationSha256 !== journey.sha256 ||
      prior?.installedAppPathSha256 !== installedAppPathSha256 ||
      JSON.stringify(prior?.applicationUpdate) !== JSON.stringify(applicationUpdate)) {
    fail("post-commit release, source, preflight, bundle, journey, or update binding drifted");
  }
  if (options.scenario === "upgrade" && (
    prior?.upgrade?.journalSha256 !== upgrade.value.journalSha256 ||
    prior?.upgrade?.transactionIdSha256 !== upgrade.value.transaction.idSha256
  )) fail("committed upgrade journal or transaction identity drifted");
  const sameGeneration = prior.owners?.hostPidSha256 === owners.hostPidSha256 &&
    prior.owners?.capturePidSha256 === owners.capturePidSha256;
  if (options.checkpoint === "post-commit-restart-login" && sameGeneration) {
    fail("operator quit/relaunch/login did not create a new Host and Capture PID generation");
  }
  if (options.checkpoint === "check-for-updates-no-update" && !sameGeneration) {
    fail("no-update check changed the Host or Capture service identity");
  }
}

const evidence = {
  schema: 1,
  classification: options.policyTest ? "post_commit_policy_test" : "formal_post_commit_observation",
  formalAcceptance: false,
  checkpoint: options.checkpoint,
  scenario: options.scenario,
  releaseTag: RELEASE_TAG,
  preflightSha256: preflight.sha256,
  harnessManifestSha256: preflight.value.harnessManifestSha256,
  sourceRevisionSha256: sha256Text(preflight.value.sourceRevision),
  bundleObservationSha256: bundle.sha256,
  bundleContentsSha256: bundle.value.contents.sha256,
  runtimeInventorySha256: bundle.value.runtimeInventory.sha256,
  signatureIdentitySha256: sha256Text(JSON.stringify(bundle.value.signatures)),
  journeyObservationSha256: journey.sha256,
  productionShare: {
    observedVerifiedActions: expectedShares,
    automaticActionDelta: prior ? 0 : null,
  },
  installedAppPathSha256,
  owners,
  roots,
  applicationUpdate,
  upgrade: upgrade ? {
    journalSha256: upgrade.value.journalSha256,
    transactionIdSha256: upgrade.value.transaction.idSha256,
  } : null,
  operatorAttestation: {
    restartLogin: options.operatorRestartLoginConfirmed,
    noUpdateAvailableInProductUI: options.operatorNoUpdateConfirmed,
  },
  limitation: options.checkpoint === "check-for-updates-no-update"
    ? "The App exposes no reliable read-only API for the Sparkle UI outcome; the operator token is bound to before/after machine evidence."
    : null,
};
process.stdout.write(`${JSON.stringify(evidence)}\n`);
