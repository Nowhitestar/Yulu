#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

const CURRENT_TAG = "v0.23.0-rc.7";
const LEGACY_TAG = "v0.22.2";
const LEGACY_COMMIT = "2d01fa2989c1a9ae1a95266438bb278c72fac8c3";
const FORMAL_NODE = "/Applications/Yulu.app/Contents/Resources/runtime/bin/node";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_BYTES = 1024 * 1024;
const LABELS = [
  "com.yulu.agentqueue",
  "com.yulu.audiodaemon",
  "com.yulu.calendar",
  "com.yulu.detector",
  "com.yulu.scheduler",
  "com.yulu.statusagent",
  "com.yulu.sttdaemon",
  "com.yulu.ui",
];
const DATABASES = ["prompts", "vocab", "search", "host"];
const MODES = new Set([
  "awaiting_approval",
  "committed",
  "committed_stable",
  "rolled_back",
  "rolled_back_stable",
  "retry_awaiting_approval",
]);

function fail(message) {
  process.stderr.write(`observe_upgrade.mjs: ${message}\n`);
  process.exit(1);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

const options = {
  policyTest: false,
  mode: "",
  releaseTag: "",
  before: "",
  currentPreflight: "",
  bundleEvidence: "",
  journal: "",
  home: "",
  applicationsRoot: "",
  systemBin: "",
  snapshotWitnessSha256: "",
  priorEvidence: "",
  externalDestinationNoRunMarkerConfirmed: false,
  smappserviceNotRegisteredConfirmed: false,
};
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  switch (argument) {
    case "--policy-test": options.policyTest = true; break;
    case "--mode": options.mode = process.argv[++index] ?? ""; break;
    case "--release-tag": options.releaseTag = process.argv[++index] ?? ""; break;
    case "--before": options.before = process.argv[++index] ?? ""; break;
    case "--current-preflight": options.currentPreflight = process.argv[++index] ?? ""; break;
    case "--bundle-evidence": options.bundleEvidence = process.argv[++index] ?? ""; break;
    case "--journal": options.journal = process.argv[++index] ?? ""; break;
    case "--home": options.home = process.argv[++index] ?? ""; break;
    case "--applications-root": options.applicationsRoot = process.argv[++index] ?? ""; break;
    case "--system-bin": options.systemBin = process.argv[++index] ?? ""; break;
    case "--snapshot-witness-sha256": options.snapshotWitnessSha256 = process.argv[++index] ?? ""; break;
    case "--prior-evidence": options.priorEvidence = process.argv[++index] ?? ""; break;
    case "--external-destination-no-run-marker-confirmed":
      options.externalDestinationNoRunMarkerConfirmed = true;
      break;
    case "--smappservice-not-registered-confirmed":
      options.smappserviceNotRegisteredConfirmed = true;
      break;
    default: fail("unknown argument");
  }
}

if (!MODES.has(options.mode)) fail("mode is invalid");
if (options.releaseTag !== CURRENT_TAG) fail("upgrade acceptance is pinned to v0.23.0-rc.7");
if (!isSha256(options.snapshotWitnessSha256)) fail("operator snapshot witness hash is invalid");
const needsPrior = new Set(["committed", "committed_stable", "rolled_back_stable", "retry_awaiting_approval"]);
if (needsPrior.has(options.mode) !== Boolean(options.priorEvidence)) {
  fail("mode has an invalid prior-evidence binding");
}
if ((options.mode === "committed") !== options.externalDestinationNoRunMarkerConfirmed) {
  fail("committed observation requires the external destination no-run-marker attestation");
}
if (new Set(["rolled_back", "rolled_back_stable"]).has(options.mode) !== options.smappserviceNotRegisteredConfirmed) {
  fail("rollback observation requires the App Components SMAppService attestation");
}

if (!options.policyTest) {
  let actualNode = "";
  try { actualNode = realpathSync(process.execPath); } catch { fail("installed Application Runtime Node identity is unreadable"); }
  if (actualNode !== FORMAL_NODE) fail("formal observer must use the installed Application Runtime Node");
  if (options.home || options.applicationsRoot || options.systemBin) fail("formal system paths cannot be overridden");
  options.home = process.env.HOME ?? "";
  options.applicationsRoot = "/Applications";
  options.systemBin = "/";
} else {
  if (![options.home, options.applicationsRoot, options.systemBin].every(isAbsolute)) {
    fail("policy-test requires absolute isolated system paths");
  }
}
if (!isAbsolute(options.home) || !isAbsolute(options.applicationsRoot)) fail("target paths are invalid");

function safeJson(path, description) {
  if (!isAbsolute(path)) fail(`${description} path must be absolute`);
  let info;
  try { info = lstatSync(path); } catch { fail(`${description} is missing`); }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() ||
      info.size < 2 || info.size > MAX_JSON_BYTES || (info.mode & 0o777) !== 0o600) {
    fail(`${description} is unsafe`);
  }
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { fail(`${description} JSON is invalid`); }
}

function systemPath(path) {
  if (!options.policyTest) return path;
  return join(options.systemBin, path.split("/").at(-1));
}

function command(path, args, description, { allowFailure = false } = {}) {
  const executable = systemPath(path);
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: MAX_COMMAND_BYTES,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
  });
  if (result.error || (!allowFailure && result.status !== 0)) fail(`${description} failed`);
  if ((result.stdout?.length ?? 0) > MAX_COMMAND_BYTES || (result.stderr?.length ?? 0) > MAX_COMMAND_BYTES) {
    fail(`${description} exceeded the read limit`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function hashFile(path, description) {
  let before;
  try { before = lstatSync(path); } catch { fail(`${description} is missing`); }
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1) fail(`${description} is unsafe`);
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  }).catch(() => fail(`${description} could not be hashed`));
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    fail(`${description} changed while hashing`);
  }
  return digest.digest("hex");
}

const before = requireRecord(safeJson(options.before, "migration-before evidence"), "migration-before evidence is invalid");
const expectedBeforeClassification = options.policyTest
  ? "v0.22.2_representative_state_policy_test"
  : "formal_v0.22.2_representative_state_observation";
if (
  before.schema !== 1 || before.classification !== expectedBeforeClassification ||
  before.formalAcceptance !== false || before.status !== "migration_before_captured" ||
  before.tag !== LEGACY_TAG || before.sourceCommit !== LEGACY_COMMIT
) fail("migration-before evidence is cross-mode or malformed");
const beforeBinding = requireRecord(before.binding, "migration-before release binding is missing");
for (const key of ["checksumsSha256", "installerSha256", "archiveSha256", "installEvidenceSha256"]) {
  if (!isSha256(beforeBinding[key])) fail("migration-before release binding is malformed");
}
const beforeSha256 = await hashFile(options.before, "migration-before evidence");

function migrationBaselineProjection() {
  const runtime = requireRecord(before.legacyRuntime, "migration-before runtime evidence is missing");
  const databases = requireRecord(before.databases, "migration-before database evidence is missing");
  const databaseItems = requireRecord(databases.items, "migration-before database items are missing");
  const wal = requireRecord(databases.wal, "migration-before WAL evidence is missing");
  const config = requireRecord(before.config, "migration-before config evidence is missing");
  const keychain = requireRecord(before.keychain, "migration-before Keychain evidence is missing");
  const audioPath = requireString(before.media?.audio?.path, "migration-before audio path is missing");
  const hostTargetPath = requireString(runtime.hostTargetPath, "migration-before Host target path is missing");
  const captureExecutablePath = requireString(runtime.captureExecutablePath, "migration-before Capture executable path is missing");
  const captureSocketPath = requireString(runtime.socketPath, "migration-before Capture socket path is missing");
  const legacyInstallDir = requireString(runtime.installDir, "migration-before install directory is missing");
  const expectedHostTargetPath = join(legacyInstallDir, "yulu/scripts/yulu_ui/dist/server.js");
  const expectedCaptureExecutablePath = join(legacyInstallDir, "yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon");
  const expectedCaptureSocketPath = join(options.home, ".config/yulu/audio_daemon.sock");
  if (
    runtime.hostRunning !== true || runtime.captureRunning !== true ||
    runtime.socketOwnedByCapture !== true || runtime.launchAgentOwnerCount !== LABELS.length ||
    !Number.isSafeInteger(runtime.hostPid) || runtime.hostPid < 1 ||
    !Number.isSafeInteger(runtime.capturePid) || runtime.capturePid < 1 || runtime.hostPid === runtime.capturePid ||
    databases.allQuickCheckOk !== true || databases.walPreExisting !== true ||
    !DATABASES.includes(wal.database) || wal.preExisting !== true ||
    !isSha256(wal.sha256) || !Number.isSafeInteger(wal.bytes) || wal.bytes < 1 ||
    config.autoSendNotion !== true || config.googleCalendarEnabled !== false ||
    config.keychainAccountMatchesGoogleCalendar !== true ||
    !isSha256(config.configSha256) || !isSha256(config.mcpTokenSha256) ||
    hostTargetPath !== expectedHostTargetPath || captureExecutablePath !== expectedCaptureExecutablePath ||
    captureSocketPath !== expectedCaptureSocketPath ||
    keychain.service !== "gogcli" || !isSha256(keychain.attributesSha256) ||
    !isSha256(keychain.persistentIdentitySha256)
  ) fail("migration-before representative baseline projection is incomplete");
  const stem = audioPath.split("/").at(-1)?.replace(/\.wav$/, "") ?? "";
  if (!stem || stem.includes("/") || stem.includes("\\")) fail("migration-before recording identity is invalid");
  const media = {};
  for (const kind of ["audio", "transcript", "summary"]) {
    const item = requireRecord(before.media?.[kind], `migration-before ${kind} evidence is missing`);
    if (!Number.isSafeInteger(item.device) || item.device < 0 || !Number.isSafeInteger(item.inode) || item.inode < 1 ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1 || !isSha256(item.sha256)) {
      fail(`migration-before ${kind} fingerprint is invalid`);
    }
    media[kind] = { device: item.device, inode: item.inode, bytes: item.bytes, sha256: item.sha256 };
  }
  const items = {};
  for (const name of DATABASES) {
    const item = requireRecord(databaseItems[name], `migration-before ${name} database evidence is missing`);
    if (item.quickCheck !== "ok" || !isSha256(item.schemaSha256) || !isSha256(item.sentinelSha256)) {
      fail(`migration-before ${name} database projection is invalid`);
    }
    items[name] = { quickCheck: "ok", schemaSha256: item.schemaSha256, sentinelSha256: item.sentinelSha256 };
  }
  return {
    sourceCommit: before.sourceCommit,
    recordingIdSha256: sha256Text(stem),
    runtime: {
      hostRunning: true,
      captureRunning: true,
      socketOwnedByCapture: true,
      launchAgentOwnerCount: LABELS.length,
      hostPidSha256: sha256Text(String(runtime.hostPid)),
      capturePidSha256: sha256Text(String(runtime.capturePid)),
      hostLabel: "com.yulu.ui",
      captureLabel: "com.yulu.audiodaemon",
      hostTargetPathSha256: sha256Text(hostTargetPath),
      captureExecutablePathSha256: sha256Text(captureExecutablePath),
      captureSocketPathSha256: sha256Text(captureSocketPath),
    },
    databases: {
      allQuickCheckOk: true,
      walPreExisting: true,
      wal: { database: wal.database, sha256: wal.sha256, bytes: wal.bytes, preExisting: true },
      items,
    },
    config: {
      configSha256: config.configSha256,
      autoSendNotion: true,
      googleCalendarEnabled: false,
      keychainAccountMatchesGoogleCalendar: true,
      mcpTokenSha256: config.mcpTokenSha256,
    },
    keychain: {
      service: "gogcli",
      attributesSha256: keychain.attributesSha256,
      persistentIdentitySha256: keychain.persistentIdentitySha256,
    },
    media,
  };
}

const migrationBaseline = migrationBaselineProjection();

const preflight = requireRecord(safeJson(options.currentPreflight, "current public-DMG preflight"), "current public-DMG preflight is invalid");
const expectedDmgUrl = `https://github.com/Nowhitestar/Yulu/releases/download/${CURRENT_TAG}/yulu-macos-arm64-${CURRENT_TAG}.dmg`;
const expectedChecksumsUrl = `https://github.com/Nowhitestar/Yulu/releases/download/${CURRENT_TAG}/checksums.txt`;
if (
  preflight.schema !== 1 || preflight.formalAcceptance !== false || preflight.status !== "passed" ||
  preflight.scenario !== "upgrade" || preflight.releaseTag !== CURRENT_TAG ||
  preflight.dmgUrl !== expectedDmgUrl || preflight.checksumsUrl !== expectedChecksumsUrl ||
  preflight.architecture !== "arm64" || preflight.hostDependenciesAbsent !== false ||
  preflight.browserProvenanceVerified !== true || !isSha256(preflight.dmgSha256) ||
  !isSha256(preflight.checksumsSha256) || !isSha256(preflight.harnessManifestSha256) ||
  !/^[0-9a-f]{40,64}$/.test(preflight.sourceRevision ?? "")
) fail("current public-DMG preflight is not bound to the upgrade scenario");

const bundle = requireRecord(safeJson(options.bundleEvidence, "installed App bundle evidence"), "installed App bundle evidence is invalid");
const expectedBundleClassification = options.policyTest ? "harness_policy_test" : "formal_bundle_observation";
if (
  bundle.schema !== 1 || bundle.classification !== expectedBundleClassification ||
  bundle.formalAcceptance !== false || bundle.status !== "matched" ||
  bundle.release?.shortVersion !== CURRENT_TAG.slice(1) || bundle.release?.releaseVersion !== CURRENT_TAG.slice(1) ||
  !isSha256(bundle.contents?.sha256) || !isSha256(bundle.runtimeInventory?.sha256)
) fail("installed App is not identical to the mounted public DMG App");

const journal = requireRecord(safeJson(options.journal, "application migration journal"), "application migration journal is invalid");
const expectedPhase = {
  awaiting_approval: "awaiting_approval",
  retry_awaiting_approval: "awaiting_approval",
  committed: "committed",
  committed_stable: "committed",
  rolled_back: "rolled_back",
  rolled_back_stable: "rolled_back",
}[options.mode];
if (
  journal.schemaVersion !== 1 || journal.phase !== expectedPhase ||
  !/^[0-9a-f]{32}$/.test(journal.transactionId ?? "") ||
  !/^[0-9a-f]{32}$/.test(journal.serviceNonce ?? "") ||
  !Number.isSafeInteger(journal.attemptNumber) || journal.attemptNumber < 1
) fail("application migration journal phase or transaction binding is invalid");
const expectedIntent = expectedPhase === "awaiting_approval"
  ? { action: "await-approval" }
  : expectedPhase === "committed"
    ? { action: "commit-complete" }
    : { action: "rollback-complete" };
if (JSON.stringify(journal.intent) !== JSON.stringify(expectedIntent)) {
  fail("application migration journal intent does not match its durable phase");
}
const bundleManifest = requireRecord(journal.bundleManifest, "journal installed-App manifest is missing");
const expectedBundleManifestNames = ["Info.plist", "audio_daemon", "node", "server.js", "yulu_app"];
if (
  Object.keys(bundleManifest).sort().join("\0") !== expectedBundleManifestNames.join("\0") ||
  Object.values(bundleManifest).some((value) => !isSha256(value))
) fail("journal installed-App manifest is malformed");
const journalSha256 = await hashFile(options.journal, "application migration journal");

let prior = null;
if (options.priorEvidence) {
  prior = requireRecord(safeJson(options.priorEvidence, "prior upgrade evidence"), "prior upgrade evidence is invalid");
  const expectedPriorClassification = options.policyTest
    ? "upgrade_migration_policy_test"
    : "formal_upgrade_migration_observation";
  if (
    prior.schema !== 1 || prior.classification !== expectedPriorClassification ||
    prior.formalAcceptance !== false || prior.releaseTag !== CURRENT_TAG ||
    prior.migrationBeforeSha256 !== beforeSha256 ||
    prior.currentArtifact?.dmgSha256 !== preflight.dmgSha256 ||
    prior.operatorSnapshotWitnessSha256 !== options.snapshotWitnessSha256
  ) fail("prior upgrade evidence binding drifted");
  requireRecord(prior.transaction, "prior upgrade transaction evidence is missing");
}

const jobs = requireRecord(journal.jobSnapshot, "journal legacy job snapshot is missing");
if (Object.keys(jobs).sort().join("\0") !== [...LABELS].sort().join("\0")) {
  fail("journal legacy job snapshot is not the exact migration allowlist");
}
const legacyRuntime = requireRecord(before.legacyRuntime, "migration-before runtime evidence is missing");
if (!Array.isArray(legacyRuntime.launchAgents) || legacyRuntime.launchAgents.length !== LABELS.length) {
  fail("migration-before LaunchAgent evidence is malformed");
}
const beforeJobs = new Map(legacyRuntime.launchAgents.map((entry) => [entry.label, entry]));
for (const label of LABELS) {
  const priorJob = requireRecord(beforeJobs.get(label), "migration-before LaunchAgent entry is missing");
  const snapshot = requireRecord(jobs[label], "journal LaunchAgent snapshot is malformed");
  const expectedMode = priorJob.plistMode === null ? null : Number.parseInt(priorJob.plistMode, 8);
  if (
    snapshot.loaded !== priorJob.loaded || snapshot.disabled !== priorJob.disabled ||
    snapshot.plistSHA256 !== priorJob.plistSha256 || snapshot.plistMode !== expectedMode ||
    (priorJob.present
      ? typeof snapshot.plistSnapshot !== "string" || !snapshot.plistSnapshot.startsWith(`rollback-snapshots/${journal.transactionId}/`)
      : snapshot.plistSnapshot !== null)
  ) fail("journal LaunchAgent snapshot does not match migration-before evidence");
}

if (options.mode === "retry_awaiting_approval") {
  if (
    prior.checkpoint !== "rolled_back_stable" ||
    sha256Text(journal.retryOf ?? "") !== prior.transaction.idSha256 ||
    journal.attemptNumber !== prior.transaction.attemptNumber + 1 ||
    sha256Text(journal.transactionId) === prior.transaction.idSha256 ||
    sha256Text(journal.serviceNonce) === prior.transaction.nonceSha256 ||
    journal.retryPreflightOnly !== undefined
  ) fail("explicit Retry did not create a complete new transaction lineage and snapshot");
}
if (options.mode === "committed") {
  if (
    !new Set(["awaiting_approval", "retry_awaiting_approval"]).has(prior.checkpoint) ||
    sha256Text(journal.transactionId) !== prior.transaction.idSha256 ||
    sha256Text(journal.serviceNonce) !== prior.transaction.nonceSha256 ||
    journal.attemptNumber !== prior.transaction.attemptNumber ||
    (journal.retryOf ? sha256Text(journal.retryOf) : null) !== prior.transaction.retryOfSha256
  ) fail("committed journal does not continue the operator-approved transaction");
}
if (options.mode === "committed_stable") {
  if (
    !new Set(["committed", "committed_stable"]).has(prior.checkpoint) ||
    sha256Text(journal.transactionId) !== prior.transaction.idSha256 ||
    sha256Text(journal.serviceNonce) !== prior.transaction.nonceSha256 ||
    journal.attemptNumber !== prior.transaction.attemptNumber ||
    (journal.retryOf ? sha256Text(journal.retryOf) : null) !== prior.transaction.retryOfSha256 ||
    prior.journalSha256 !== journalSha256
  ) fail("post-commit restart/login changed the committed journal transaction identity");
}

function launchState(label) {
  const result = command("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], "launchd owner observation", { allowFailure: true });
  if (result.status === 113) return { loaded: false, pid: null, output: "" };
  if (result.status !== 0) fail("launchd owner observation returned an ambiguous status");
  const match = result.stdout.match(/\bpid\s*=\s*([1-9][0-9]*)\b/);
  return { loaded: true, pid: match ? Number(match[1]) : null, output: result.stdout };
}

function disabledLabels() {
  const result = command("/bin/launchctl", ["print-disabled", `gui/${process.getuid()}`], "launchd disabled-state observation");
  return new Set(LABELS.filter((label) => result.stdout.includes(`"${label}" => true`)));
}

function regularFile(path, description) {
  let info;
  try { info = lstatSync(path); } catch { fail(`${description} is missing`); }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() ||
      info.size < 1 || (info.mode & 0o077) !== 0) fail(`${description} is unsafe`);
  return info;
}

const legacyConfigRoot = join(options.home, ".config/yulu");
const standardRoot = join(options.home, "Library/Application Support/Yulu");
const launchAgentsRoot = join(options.home, "Library/LaunchAgents");
const installedApp = join(options.applicationsRoot, "Yulu.app");
if (realpathSync(installedApp) !== installedApp) fail("installed App path is not canonical");
const installedManifestPaths = {
  "Info.plist": join(installedApp, "Contents/Info.plist"),
  yulu_app: join(installedApp, "Contents/MacOS/yulu_app"),
  node: join(installedApp, "Contents/Resources/runtime/bin/node"),
  "server.js": join(installedApp, "Contents/Resources/Host/server.js"),
  audio_daemon: join(installedApp, "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon"),
};
for (const [name, path] of Object.entries(installedManifestPaths)) {
  if (await hashFile(path, `installed App ${name}`) !== bundleManifest[name]) {
    fail("journal installed-App manifest does not match the public installed App");
  }
}

function sqliteQuery(path, sql, description) {
  const result = command("/usr/bin/sqlite3", ["-readonly", "-cmd", "PRAGMA query_only=ON;", path, sql], description);
  return result.stdout.trimEnd();
}

function sqlQuote(value) { return value.replaceAll("'", "''"); }

async function validateDatabases(root, committed) {
  const beforeItems = requireRecord(before.databases?.items, "migration-before database evidence is missing");
  const audioPath = requireString(before.media?.audio?.path, "migration-before audio path is missing");
  const transcriptPath = requireString(before.media?.transcript?.path, "migration-before transcript path is missing");
  const stem = audioPath.split("/").at(-1).replace(/\.wav$/, "");
  const queries = {
    prompts: "SELECT slug || '|' || category || '|' || is_auto_run FROM prompts ORDER BY slug LIMIT 1;",
    vocab: "SELECT term || '|' || canonical || '|' || enabled FROM custom_words ORDER BY term LIMIT 1;",
    search: `SELECT source_path || '|' || sha256 FROM docs_meta WHERE source_path='${sqlQuote(transcriptPath)}' LIMIT 1;`,
    host: `SELECT id || '|' || recording_stem || '|' || state || '|' || send_to_notion FROM agent_tasks WHERE recording_stem='${sqlQuote(stem)}' ORDER BY created_at DESC LIMIT 1;`,
  };
  const output = {};
  const dataManifest = committed ? requireRecord(journal.dataManifest, "committed data manifest is missing") : null;
  for (const name of DATABASES) {
    const path = join(root, `${name}.sqlite`);
    regularFile(path, `${name} database`);
    if (sqliteQuery(path, "PRAGMA quick_check;", `${name} quick_check`) !== "ok") fail(`${name} database quick_check failed`);
    const schema = sqliteQuery(path, "SELECT type || '|' || name || '|' || IFNULL(sql,'') FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name;", `${name} schema observation`);
    const sentinel = sqliteQuery(path, queries[name], `${name} representative row observation`);
    if (!schema || !sentinel || sha256Text(schema) !== beforeItems[name]?.schemaSha256 || sha256Text(sentinel) !== beforeItems[name]?.sentinelSha256) {
      fail(`${name} database schema or representative row changed across migration`);
    }
    if (committed) {
      const item = requireRecord(dataManifest[`${name}.sqlite`], "committed SQLite manifest is missing");
      if (
        !isSha256(item.sourceSchemaSHA256) || item.sourceSchemaSHA256 !== item.destinationSchemaSHA256 ||
        !isSha256(item.sourceContentSHA256) || item.sourceContentSHA256 !== item.destinationContentSHA256
      ) fail("committed SQLite checkpoint manifest is not source-equivalent");
    }
    output[name] = { quickCheck: "ok", schemaSha256: sha256Text(schema), sentinelSha256: sha256Text(sentinel) };
  }
  return output;
}

async function validateMedia() {
  const result = {};
  for (const kind of ["audio", "transcript", "summary"]) {
    const expected = requireRecord(before.media?.[kind], "migration-before Media evidence is missing");
    const info = regularFile(requireString(expected.path, "migration-before Media path is missing"), `${kind} Media artifact`);
    const digest = await hashFile(expected.path, `${kind} Media artifact`);
    if (info.dev !== expected.device || info.ino !== expected.inode || info.size !== expected.bytes || digest !== expected.sha256) {
      fail(`${kind} Media artifact was copied or changed`);
    }
    result[kind] = { device: info.dev, inode: info.ino, bytes: info.size, sha256: digest };
  }
  return result;
}

function keychainEvidence() {
  const expected = requireRecord(before.keychain, "migration-before Keychain evidence is missing");
  const account = requireString(expected.account, "migration-before Keychain account is missing");
  const result = command("/usr/bin/security", ["find-generic-password", "-s", "gogcli", "-a", account], "gogcli Keychain metadata observation");
  if (result.stdout.includes("password:") || result.stderr.includes("password:")) fail("Keychain command returned secret material");
  const attributes = result.stdout.trimEnd();
  if (!attributes.includes('"acct"') || !attributes.includes('"svce"') || !attributes.includes(account) || !attributes.includes("gogcli")) {
    fail("gogcli Keychain metadata is incomplete");
  }
  const attributesSha256 = sha256Text(attributes);
  const persistentIdentitySha256 = sha256Text(`gogcli\n${account}`);
  if (attributesSha256 !== expected.attributesSha256 || persistentIdentitySha256 !== expected.persistentIdentitySha256) {
    fail("gogcli Keychain identity or attributes changed");
  }
  return { service: "gogcli", accountSha256: sha256Text(account), attributesSha256, persistentIdentitySha256 };
}

function validateJobRestore() {
  const disabled = disabledLabels();
  for (const label of LABELS) {
    const expected = beforeJobs.get(label);
    const path = join(launchAgentsRoot, `${label}.plist`);
    let present = false;
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) fail("restored legacy LaunchAgent plist is unsafe");
      present = true;
      const digest = command("/usr/bin/shasum", ["-a", "256", path], "restored plist digest").stdout.split(/\s+/)[0];
      if (digest !== expected.plistSha256 || (info.mode & 0o777).toString(8) !== expected.plistMode) {
        fail("restored legacy LaunchAgent plist changed");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const state = launchState(label);
    if (present !== expected.present || state.loaded !== expected.loaded || disabled.has(label) !== expected.disabled) {
      fail("legacy LaunchAgent state was not restored exactly");
    }
  }
}

function validateLegacyOwners() {
  const host = launchState("com.yulu.ui");
  const capture = launchState("com.yulu.audiodaemon");
  if (!host.loaded || !capture.loaded || !host.pid || !capture.pid || host.pid === capture.pid) fail("legacy Host/Capture owners are not unique");
  const hostCommand = command("/bin/ps", ["-p", String(host.pid), "-o", "command="], "legacy Host process observation").stdout.trim();
  const captureCommand = command("/bin/ps", ["-p", String(capture.pid), "-o", "command="], "legacy Capture process observation").stdout.trim();
  const legacyInstallDir = requireString(before.legacyRuntime?.installDir, "migration-before install directory is missing");
  const hostTargetPath = join(legacyInstallDir, "yulu/scripts/yulu_ui/dist/server.js");
  const captureExecutablePath = join(legacyInstallDir, "yulu/scripts/Yulu.app/Contents/MacOS/audio_daemon");
  if (!hostCommand.includes(hostTargetPath) || !captureCommand.startsWith(captureExecutablePath)) {
    fail("legacy Host/Capture process ownership was not restored");
  }
  const socketPath = join(legacyConfigRoot, "audio_daemon.sock");
  let socketInfo;
  try { socketInfo = lstatSync(socketPath); } catch { fail("legacy Capture socket was not restored"); }
  if (!socketInfo.isSocket() || socketInfo.isSymbolicLink()) fail("legacy Capture socket is unsafe");
  const socketOwners = command("/usr/sbin/lsof", ["-t", socketPath], "legacy Capture socket owner observation").stdout
    .trim().split(/\s+/).filter(Boolean);
  if (socketOwners.length !== 1 || socketOwners[0] !== String(capture.pid)) fail("legacy Capture socket owner is not unique");
  return {
    hostPidSha256: sha256Text(String(host.pid)),
    capturePidSha256: sha256Text(String(capture.pid)),
    hostLabel: "com.yulu.ui",
    captureLabel: "com.yulu.audiodaemon",
    hostTargetPathSha256: sha256Text(hostTargetPath),
    captureExecutablePathSha256: sha256Text(captureExecutablePath),
    captureSocketPathSha256: sha256Text(socketPath),
    captureSocketOwnerPidSha256: sha256Text(String(capture.pid)),
  };
}

function validateCurrentOwners() {
  const host = launchState("com.yulu.ui");
  const capture = launchState("com.yulu.audiodaemon");
  if (!host.loaded || !capture.loaded || !host.pid || !capture.pid || host.pid === capture.pid) fail("current Host/Capture owners are not unique");
  const hostExecutable = join(installedApp, "Contents/Resources/runtime/bin/node");
  const hostTarget = join(installedApp, "Contents/Resources/Host/server.js");
  const captureExecutable = join(installedApp, "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon");
  const hostCommand = command("/bin/ps", ["-p", String(host.pid), "-o", "command="], "current Host process observation").stdout.trim();
  const captureCommand = command("/bin/ps", ["-p", String(capture.pid), "-o", "command="], "current Capture process observation").stdout.trim();
  if (!hostCommand.startsWith(`${hostExecutable} ${hostTarget}`) || captureCommand !== captureExecutable) {
    fail("current Host/Capture process is not rooted in the installed App");
  }
  for (const executable of [hostExecutable, captureExecutable]) {
    command("/usr/bin/codesign", ["--verify", "--strict", executable], "current owner signature verification");
    const display = command("/usr/bin/codesign", ["--display", "--verbose=4", executable], "current owner signature identity");
    const combined = `${display.stdout}\n${display.stderr}`;
    if (!combined.includes("TeamIdentifier=WMU9678ZQL")) fail("current owner has the wrong signing Team ID");
  }
  for (const label of LABELS.filter((value) => value !== "com.yulu.ui" && value !== "com.yulu.audiodaemon")) {
    if (launchState(label).loaded) fail("a non-current legacy job remains loaded after commit");
  }
  return { hostPidSha256: sha256Text(String(host.pid)), capturePidSha256: sha256Text(String(capture.pid)), signed: true };
}

async function validateMcpToken(root) {
  const path = join(root, "mcp-token.json");
  regularFile(path, "MCP token file");
  const digest = await hashFile(path, "MCP token file");
  if (digest !== before.config?.mcpTokenSha256) fail("MCP token did not preserve exact bytes");
  return digest;
}

async function validateCommittedConfig() {
  const path = join(standardRoot, "config.json");
  regularFile(path, "current config");
  let current;
  try { current = JSON.parse(readFileSync(path, "utf8")); } catch { fail("current config JSON is invalid"); }
  if (Object.hasOwn(current?.agent_pipeline ?? {}, "auto_send_notion")) fail("retired auto_send_notion remains in current config");
  const archives = readdirSync(standardRoot).filter((name) => /^config\.legacy-automatic-share\.[0-9TZ]+\.json$/.test(name));
  if (archives.length !== 1) fail("retired automatic-sharing authorization archive is not unique");
  const archivePath = join(standardRoot, archives[0]);
  regularFile(archivePath, "automatic-sharing authorization archive");
  let archive;
  try { archive = JSON.parse(readFileSync(archivePath, "utf8")); } catch { fail("automatic-sharing authorization archive is invalid"); }
  if (archive.version !== 1 || archive.sourcePath !== path || archive.agent_pipeline?.auto_send_notion !== true) {
    fail("automatic-sharing authorization archive does not preserve the retired legacy value");
  }
  return { retiredKeyAbsent: true, archiveSha256: await hashFile(archivePath, "automatic-sharing authorization archive") };
}

async function validateLegacyConfig() {
  const path = join(legacyConfigRoot, "config.json");
  regularFile(path, "legacy config");
  const digest = await hashFile(path, "legacy config");
  if (digest !== before.config?.configSha256) fail("legacy config changed during rollback");
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { fail("legacy config JSON is invalid"); }
  if (value?.agent_pipeline?.auto_send_notion !== true) fail("legacy automatic-sharing state was not restored");
  return { sha256: digest, autoSendNotion: true };
}

function validateTransactionOutputsRemoved() {
  const forbidden = ["config.json", "agent-sessions.json", "mcp-token.json", "Models", "agent-tasks", "local-caption",
    "prompts.sqlite", "vocab.sqlite", "search.sqlite", "host.sqlite"];
  for (const name of forbidden) {
    try { lstatSync(join(standardRoot, name)); fail("rolled-back transaction output remains in the standard data root"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const residue = readdirSync(standardRoot).filter((name) => name !== "application-migration");
  if (residue.length !== 0) fail("rolled-back standard data root contains transaction residue");
}

let databases;
let media;
let mcpTokenSha256;
let owners;
let configEvidence = null;
const keychain = keychainEvidence();
if (new Set(["committed", "committed_stable"]).has(options.mode)) {
  databases = await validateDatabases(standardRoot, true);
  media = await validateMedia();
  mcpTokenSha256 = await validateMcpToken(standardRoot);
  owners = validateCurrentOwners();
  configEvidence = await validateCommittedConfig();
  for (const label of LABELS) {
    try { lstatSync(join(launchAgentsRoot, `${label}.plist`)); fail("committed migration left a legacy LaunchAgent plist"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
} else if (new Set(["rolled_back", "rolled_back_stable"]).has(options.mode)) {
  validateTransactionOutputsRemoved();
  databases = await validateDatabases(legacyConfigRoot, false);
  media = await validateMedia();
  mcpTokenSha256 = await validateMcpToken(legacyConfigRoot);
  configEvidence = await validateLegacyConfig();
  validateJobRestore();
  owners = validateLegacyOwners();
  if (options.mode === "rolled_back_stable" && prior.journalSha256 !== journalSha256) {
    fail("ordinary quit/relaunch/login changed the rolled-back journal or auto-retried migration");
  }
} else {
  // At approval checkpoints, mutation is intentionally incomplete. The
  // journal and exact preflight snapshot are the read-only authority.
  databases = null;
  media = await validateMedia();
  mcpTokenSha256 = before.config?.mcpTokenSha256;
  owners = null;
}

const evidence = {
  schema: 1,
  classification: options.policyTest ? "upgrade_migration_policy_test" : "formal_upgrade_migration_observation",
  formalAcceptance: false,
  checkpoint: options.mode,
  releaseTag: CURRENT_TAG,
  migrationBeforeSha256: beforeSha256,
  migrationBaseline,
  currentArtifact: {
    dmgSha256: preflight.dmgSha256,
    checksumsSha256: preflight.checksumsSha256,
    bundleContentsSha256: bundle.contents.sha256,
    runtimeInventorySha256: bundle.runtimeInventory.sha256,
    browserProvenanceVerified: true,
    installedAppPathSha256: sha256Text(installedApp),
  },
  operatorSnapshotWitnessSha256: options.snapshotWitnessSha256,
  transaction: {
    phase: journal.phase,
    idSha256: sha256Text(journal.transactionId),
    nonceSha256: sha256Text(journal.serviceNonce),
    attemptNumber: journal.attemptNumber,
    retryOfSha256: journal.retryOf ? sha256Text(journal.retryOf) : null,
    retryRootSha256: journal.retryRoot ? sha256Text(journal.retryRoot) : null,
    exactLegacySnapshot: true,
  },
  journalSha256,
  databases,
  media,
  mcpTokenSha256,
  keychain,
  owners,
  config: configEvidence,
  operatorAttestation: {
    smappserviceNotRegistered: options.smappserviceNotRegisteredConfirmed,
    externalDestinationNoRunMarker: options.externalDestinationNoRunMarkerConfirmed,
  },
};
process.stdout.write(`${JSON.stringify(evidence)}\n`);
