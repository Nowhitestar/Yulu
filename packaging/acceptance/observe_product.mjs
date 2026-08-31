#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const HASH_CHUNK_BYTES = 1024 * 1024;
const FIXED_INVENTORY_FILES = [
  "Contents/MacOS/yulu_app",
  "Contents/Library/LaunchAgents/com.yulu.ui.plist",
  "Contents/Library/LaunchAgents/com.yulu.audiodaemon.plist",
  "Contents/MacOS/xai_keychain",
  "Contents/MacOS/calendar_probe",
  "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
  "Contents/Resources/Sparkle-LICENSE.txt",
];
const INVENTORY_ROOTS = [
  "Contents/Resources/runtime",
  "Contents/Resources/Host",
  "Contents/Frameworks",
];

function fail(message) {
  process.stderr.write(`observe_product.mjs: ${message}\n`);
  process.exit(1);
}

const options = { policyTest: false, mounted: "", installed: "", codesign: "", baselineEvidence: "" };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--policy-test") {
    options.policyTest = true;
  } else if (argument === "--mounted" || argument === "--installed" || argument === "--codesign" || argument === "--baseline-evidence") {
    const value = process.argv[index + 1] ?? "";
    const key = {
      "--mounted": "mounted",
      "--installed": "installed",
      "--codesign": "codesign",
      "--baseline-evidence": "baselineEvidence",
    }[argument];
    options[key] = value;
    index += 1;
  } else {
    fail(`unknown argument: ${argument}`);
  }
}

if (options.codesign && !isAbsolute(options.codesign)) fail("codesign tool must be absolute");
if (options.baselineEvidence && !isAbsolute(options.baselineEvidence)) fail("baseline-evidence must be absolute");

for (const [name, value] of [["mounted", options.mounted], ["installed", options.installed]]) {
  if (!isAbsolute(value) || !value.endsWith(".app")) fail(`${name} App must be an absolute .app path`);
}

const expectedNode = join(options.installed, "Contents", "Resources", "runtime", "bin", "node");
if (!options.policyTest && realpathSync(process.execPath) !== realpathSync(expectedNode)) {
  fail("observer must run with the installed Application Runtime Node");
}
if (!options.policyTest && process.arch !== "arm64") fail("installed Application Runtime Node is not arm64");

function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(path) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const descriptor = openSync(path, "r");
  try {
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function collectInventoryFiles(app) {
  const actual = new Set(FIXED_INVENTORY_FILES);
  function walk(path) {
    if (!existsSync(path)) return;
    for (const name of readdirSync(path).sort(bytewise)) {
      const candidate = join(path, name);
      const stat = lstatSync(candidate);
      if (stat.isDirectory()) walk(candidate);
      else if (stat.isFile() || stat.isSymbolicLink()) {
        actual.add(relative(app, candidate).split(sep).join("/"));
      } else {
        fail(`unsupported inventory entry type: ${relative(app, candidate)}`);
      }
    }
  }
  for (const root of INVENTORY_ROOTS) walk(join(app, root));
  return actual;
}

function validateInventory(app) {
  const inventoryPath = join(app, "Contents", "Resources", "application-runtime.json");
  const raw = readFileSync(inventoryPath);
  const inventory = JSON.parse(raw.toString("utf8"));
  const versions = inventory?.versions;
  if (
    inventory?.schema !== 1 || inventory?.architecture !== "arm64" ||
    !versions || !["node", "python", "ffmpeg", "sparkle"].every(
      (name) => typeof versions[name] === "string" && versions[name].length > 0,
    ) || !Array.isArray(inventory?.files)
  ) {
    fail("invalid application-runtime.json header or versions");
  }
  const declared = new Set(inventory.files.map((entry) => entry?.path));
  if (declared.size !== inventory.files.length || declared.has(undefined)) {
    fail("application-runtime.json contains duplicate or invalid paths");
  }
  const actual = collectInventoryFiles(app);
  const missing = [...declared].filter((path) => !actual.has(path)).sort(bytewise);
  const extra = [...actual].filter((path) => !declared.has(path)).sort(bytewise);
  if (missing.length || extra.length) {
    fail(`inventory file set mismatch; missing=${missing.length}, extra=${extra.length}`);
  }
  for (const entry of inventory.files) {
    if (typeof entry.path !== "string" || !entry.path.startsWith("Contents/")) {
      fail("invalid application-runtime.json path");
    }
    const candidate = resolve(app, entry.path);
    const appRoot = `${resolve(app)}${sep}`;
    if (!candidate.startsWith(appRoot)) fail("application-runtime.json path escapes the App");
    const stat = lstatSync(candidate);
    if ((stat.mode & 0o7777) !== entry.mode) fail(`application-runtime.json mode mismatch: ${entry.path}`);
    if (entry.type === "symlink") {
      if (!stat.isSymbolicLink() || readlinkSync(candidate) !== entry.target) {
        fail(`application-runtime.json symlink mismatch: ${entry.path}`);
      }
      const resolved = realpathSync(candidate);
      if (resolved !== resolve(app) && !resolved.startsWith(appRoot)) {
        fail(`application-runtime.json symlink escapes the App: ${entry.path}`);
      }
    } else if (entry.type === "outer-signed-main") {
      if (!stat.isFile() || entry.path !== "Contents/MacOS/yulu_app") {
        fail("invalid outer-signed-main inventory entry");
      }
    } else if (entry.type !== "file" || !stat.isFile() || hashFile(candidate) !== entry.sha256) {
      fail(`application-runtime.json hash mismatch: ${entry.path}`);
    }
  }
  return { sha256: sha256(raw), files: inventory.files.length, versions };
}

function contentsDigest(app) {
  const contents = join(app, "Contents");
  const entries = [];
  let bytes = 0;
  function walk(path) {
    for (const name of readdirSync(path).sort(bytewise)) {
      const candidate = join(path, name);
      const stat = lstatSync(candidate);
      const canonicalPath = relative(app, candidate).split(sep).join("/");
      const mode = stat.mode & 0o7777;
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(candidate);
        entries.push({ path: canonicalPath, type: "symlink", mode, bytes: Buffer.byteLength(target), sha256: sha256(target) });
      } else if (stat.isDirectory()) {
        entries.push({ path: canonicalPath, type: "directory", mode, bytes: 0, sha256: null });
        walk(candidate);
      } else if (stat.isFile()) {
        bytes += stat.size;
        entries.push({ path: canonicalPath, type: "file", mode, bytes: stat.size, sha256: hashFile(candidate) });
      } else {
        fail(`unsupported bundle entry type: ${canonicalPath}`);
      }
    }
  }
  walk(contents);
  return { sha256: sha256(JSON.stringify(entries)), entries: entries.length, bytes };
}

function decodeXml(value) {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function releaseIdentity(app) {
  const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
  const value = (key) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = plist.match(new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<string>([^<]+)</string>`));
    return match ? decodeXml(match[1].trim()) : "";
  };
  const identity = {
    bundleIdentifier: value("CFBundleIdentifier"),
    shortVersion: value("CFBundleShortVersionString"),
    releaseVersion: value("YuluReleaseVersion"),
    buildVersion: value("CFBundleVersion"),
  };
  if (!identity.bundleIdentifier || !identity.shortVersion || !identity.releaseVersion || !/^[1-9][0-9]*$/.test(identity.buildVersion)) {
    fail("installed App release identity is invalid");
  }
  return identity;
}

function signatureIdentity(candidate, description) {
  if (!options.codesign) return null;
  const verified = spawnSync(options.codesign, ["--verify", "--strict", candidate], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
  });
  if (verified.error || verified.status !== 0) fail(`${description} signature verification failed`);
  const displayed = spawnSync(options.codesign, ["--display", "--verbose=4", candidate], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
  });
  if (displayed.error || displayed.status !== 0) fail(`${description} signature identity is unreadable`);
  const details = `${displayed.stdout ?? ""}\n${displayed.stderr ?? ""}`;
  const teamIdentifier = details.match(/\bTeamIdentifier=([A-Z0-9]{10})\b/)?.[1] ?? "";
  const cdHash = details.match(/\bCDHash=([0-9a-fA-F]{40}|[0-9a-fA-F]{64})\b/)?.[1]?.toLowerCase() ?? "";
  const identifier = details.match(/\bIdentifier=([^\s]+)/)?.[1] ?? "";
  if (teamIdentifier !== "WMU9678ZQL" || !cdHash || !identifier) {
    fail(`${description} signature TeamIdentifier or CDHash is invalid`);
  }
  return { teamIdentifier, cdHash, identifier };
}

const mountedInventory = validateInventory(options.mounted);
const installedInventory = validateInventory(options.installed);
const mountedContents = contentsDigest(options.mounted);
const installedContents = contentsDigest(options.installed);
const mountedRelease = releaseIdentity(options.mounted);
const installedRelease = releaseIdentity(options.installed);
if (
  mountedInventory.sha256 !== installedInventory.sha256 ||
  mountedContents.sha256 !== installedContents.sha256 ||
  JSON.stringify(mountedRelease) !== JSON.stringify(installedRelease)
) {
  fail("mounted and installed App bundle digest mismatch");
}

const signatures = options.codesign ? {
  application: signatureIdentity(options.installed, "installed App"),
  host: signatureIdentity(expectedNode, "installed Host"),
  capture: signatureIdentity(
    join(options.installed, "Contents", "Helpers", "YuluCapture.app", "Contents", "MacOS", "audio_daemon"),
    "installed Capture",
  ),
} : null;

const evidence = {
  schema: 1,
  classification: options.policyTest ? "harness_policy_test" : "formal_bundle_observation",
  formalAcceptance: false,
  status: "matched",
  release: installedRelease,
  node: {
    version: process.version,
    architecture: process.arch,
    executableSha256: hashFile(expectedNode),
  },
  runtimeInventory: mountedInventory,
  contents: mountedContents,
  signatures,
};

if (options.baselineEvidence) {
  let baseline;
  try {
    const stat = lstatSync(options.baselineEvidence);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 2 * 1024 * 1024 || (stat.mode & 0o777) !== 0o600) {
      fail("baseline-evidence file is unsafe");
    }
    baseline = JSON.parse(readFileSync(options.baselineEvidence, "utf8"));
  } catch {
    fail("baseline-evidence is unreadable");
  }
  if (
    baseline?.schema !== 1 || baseline?.formalAcceptance !== false || baseline?.status !== "matched" ||
    baseline?.contents?.sha256 !== evidence.contents.sha256 ||
    baseline?.runtimeInventory?.sha256 !== evidence.runtimeInventory.sha256 ||
    JSON.stringify(baseline?.release) !== JSON.stringify(evidence.release) ||
    JSON.stringify(baseline?.signatures) !== JSON.stringify(evidence.signatures)
  ) fail("installed App contents, inventory, release, or signatures changed from baseline-evidence");
}

process.stdout.write(`${JSON.stringify(evidence)}\n`);
