import { randomUUID } from "node:crypto";
import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defaultYuluConfig } from "./config.js";

interface HostDataPaths {
  durableDataDir: string;
  legacyReadOnlyDataDir: string;
  configFile: string;
  promptsDb: string;
  vocabDb: string;
  searchDb: string;
  hostDb: string;
  agentTasksDir: string;
  modelsDir: string;
  mcpTokenJson: string;
}

interface AuthorityRoot {
  path: string;
  canonical: string;
  label: string;
  anchorPath?: string;
  anchorFd?: number;
  anchorMissing?: boolean;
  ioBase?: string;
}

type EntryKind = "file" | "directory";
type SqliteKind = "prompts" | "vocab" | "search" | "host";

function unsafeAuthority(label: string): Error {
  return new Error(`${label} authority is unsafe`);
}

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Resolve through the nearest existing ancestor without requiring the leaf to exist. */
function canonicalNearest(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!lstatIfPresent(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw unsafeAuthority("path");
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync.native(cursor), ...missing);
}

function insideOrEqual(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function overlaps(left: string, right: string): boolean {
  return insideOrEqual(left, right) || insideOrEqual(right, left);
}

function expectedCanonical(root: AuthorityRoot, path: string): string {
  const rel = relative(resolve(root.path), resolve(path));
  if (rel.startsWith("..") || isAbsolute(rel)) throw unsafeAuthority(root.label);
  return resolve(root.canonical, rel);
}

function assertRootStable(root: AuthorityRoot): void {
  if (!root.anchorPath) return;
  const current = lstatIfPresent(root.anchorPath);
  if (root.anchorMissing) {
    if (current) throw unsafeAuthority(root.label);
    return;
  }
  if (!current || current.isSymbolicLink() || !current.isDirectory() || root.anchorFd === undefined) {
    throw unsafeAuthority(root.label);
  }
  const opened = openSync(
    root.anchorPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    assertStable(fstatSync(root.anchorFd), fstatSync(opened), root.label);
  } finally {
    closeSync(opened);
  }
}

function ioPath(root: AuthorityRoot, path: string): string {
  if (!root.ioBase) return path;
  const rel = relative(resolve(root.ioBase), resolve(path));
  if (rel.startsWith("..") || isAbsolute(rel)) throw unsafeAuthority(root.label);
  return rel || ".";
}

function assertEntry(
  path: string,
  root: AuthorityRoot,
  kind: EntryKind,
  label: string,
) {
  assertRootStable(root);
  const expected = expectedCanonical(root, path);
  if (canonicalNearest(path) !== expected) throw unsafeAuthority(label);
  const stat = lstatIfPresent(path);
  if (!stat) {
    assertRootStable(root);
    return null;
  }
  if (stat.isSymbolicLink()) throw unsafeAuthority(label);
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
    throw unsafeAuthority(label);
  }
  if (realpathSync.native(path) !== expected) throw unsafeAuthority(label);
  assertRootStable(root);
  return stat;
}

function ensureDirectory(path: string, root: AuthorityRoot, label: string): void {
  const before = assertEntry(path, root, "directory", label);
  if (!before) mkdirSync(ioPath(root, path), { recursive: true, mode: 0o700 });
  assertEntry(path, root, "directory", label);
  const fd = openSync(
    ioPath(root, path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!fstatSync(fd).isDirectory()) throw unsafeAuthority(label);
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

function ensureParent(
  path: string,
  expectedParent: string,
  label: string,
  root?: AuthorityRoot,
): void {
  const parent = dirname(path);
  if (canonicalNearest(parent) !== expectedParent) throw unsafeAuthority(label);
  const stat = lstatIfPresent(parent);
  if (!stat) mkdirSync(root ? ioPath(root, parent) : parent, { recursive: true, mode: 0o700 });
  const committed = lstatIfPresent(parent);
  if (!committed?.isDirectory() || committed.isSymbolicLink()) throw unsafeAuthority(label);
  if (realpathSync.native(parent) !== expectedParent) throw unsafeAuthority(label);
}

function establishAuthorities(paths: HostDataPaths): {
  durable: AuthorityRoot;
  legacy: AuthorityRoot;
  models: AuthorityRoot;
} {
  const durableCanonical = canonicalNearest(paths.durableDataDir);
  const legacyCanonical = canonicalNearest(paths.legacyReadOnlyDataDir);
  const modelsCanonical = canonicalNearest(paths.modelsDir);
  if (overlaps(durableCanonical, legacyCanonical) || overlaps(modelsCanonical, legacyCanonical)) {
    throw unsafeAuthority("standard and legacy roots");
  }
  if (!insideOrEqual(durableCanonical, modelsCanonical)) {
    throw unsafeAuthority("standard Models root");
  }

  const durable: AuthorityRoot = {
    path: resolve(paths.durableDataDir),
    canonical: durableCanonical,
    label: "standard data root",
  };
  const legacy: AuthorityRoot = {
    path: resolve(paths.legacyReadOnlyDataDir),
    canonical: legacyCanonical,
    label: "legacy data root",
  };
  const models: AuthorityRoot = {
    path: resolve(paths.modelsDir),
    canonical: modelsCanonical,
    label: "standard Models root",
  };

  const durableStat = lstatIfPresent(durable.path);
  if (durableStat?.isSymbolicLink() || (durableStat && !durableStat.isDirectory())) {
    throw unsafeAuthority(durable.label);
  }
  const legacyStat = lstatIfPresent(legacy.path);
  if (legacyStat?.isSymbolicLink() || (legacyStat && !legacyStat.isDirectory())) {
    throw unsafeAuthority(legacy.label);
  }
  ensureParent(durable.path, dirname(durable.canonical), durable.label);
  ensureDirectory(durable.path, durable, durable.label);
  const durableFd = openSync(
    durable.path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  durable.anchorPath = durable.path;
  durable.anchorFd = durableFd;
  durable.ioBase = durable.path;
  try {
    if (legacyStat) {
      legacy.anchorPath = legacy.path;
      legacy.anchorFd = openSync(
        legacy.path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } else {
      legacy.anchorPath = legacy.path;
      legacy.anchorMissing = true;
    }
  } catch (error) {
    closeSync(durableFd);
    throw error;
  }
  models.anchorPath = durable.path;
  models.anchorFd = durableFd;
  models.ioBase = durable.path;
  return { durable, legacy, models };
}

function stagingPath(destination: string): string {
  return join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomUUID()}.migration`,
  );
}

function assertStable(
  before: NonNullable<ReturnType<typeof lstatSync>>,
  after: NonNullable<ReturnType<typeof lstatSync>>,
  label: string,
): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode) {
    throw unsafeAuthority(label);
  }
}

function setPrivateFile(path: string, root: AuthorityRoot, label: string): void {
  setFileMode(path, root, 0o600, label);
}

function setFileMode(path: string, root: AuthorityRoot, mode: number, label: string): void {
  assertEntry(path, root, "file", label);
  const fd = openSync(ioPath(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw unsafeAuthority(label);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

function readRegularFile(path: string, root: AuthorityRoot, label: string): Buffer {
  const before = assertEntry(path, root, "file", label);
  if (!before) throw unsafeAuthority(label);
  const fd = openSync(ioPath(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw unsafeAuthority(label);
    assertStable(before, opened, label);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeRegularFileExclusive(
  path: string,
  content: Buffer,
  root: AuthorityRoot,
  mode: number,
  label: string,
): void {
  const fd = openSync(
    ioPath(root, path),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    assertRootStable(root);
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw unsafeAuthority(label);
    writeFileSync(fd, content);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

function copyPrivateFileIfMissing(
  source: string,
  destination: string,
  sourceRoot: AuthorityRoot,
  destinationRoot: AuthorityRoot,
  label: string,
): void {
  const sourceStat = assertEntry(source, sourceRoot, "file", `legacy ${label}`);
  const destinationStat = assertEntry(destination, destinationRoot, "file", `standard ${label}`);
  if (destinationStat || !sourceStat) return;
  ensureDirectory(dirname(destination), destinationRoot, `standard ${label} parent`);
  const staging = stagingPath(destination);
  try {
    const content = readRegularFile(source, sourceRoot, `legacy ${label}`);
    writeRegularFileExclusive(staging, content, destinationRoot, 0o600, `staged ${label}`);
    setPrivateFile(staging, destinationRoot, `staged ${label}`);
    assertEntry(source, sourceRoot, "file", `legacy ${label}`);
    if (assertEntry(destination, destinationRoot, "file", `standard ${label}`)) {
      throw unsafeAuthority(`standard ${label}`);
    }
    renameSync(ioPath(destinationRoot, staging), ioPath(destinationRoot, destination));
    setPrivateFile(destination, destinationRoot, `standard ${label}`);
  } finally {
    rmSync(ioPath(destinationRoot, staging), { force: true });
  }
}

function createDefaultConfigIfMissing(
  destination: string,
  destinationRoot: AuthorityRoot,
): void {
  if (assertEntry(destination, destinationRoot, "file", "standard configuration")) return;
  ensureDirectory(dirname(destination), destinationRoot, "standard configuration parent");
  const staging = stagingPath(destination);
  let destinationReady = false;
  try {
    const content = Buffer.from(`${JSON.stringify(defaultYuluConfig(), null, 2)}\n`, "utf8");
    writeRegularFileExclusive(
      staging,
      content,
      destinationRoot,
      0o600,
      "staged default configuration",
    );
    assertEntry(
      staging,
      destinationRoot,
      "file",
      "staged default configuration",
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // A hard link is one atomic create-if-absent operation. Unlike rename,
        // it cannot replace a configuration that appears after the first check.
        linkSync(ioPath(destinationRoot, staging), ioPath(destinationRoot, destination));
        destinationReady = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (assertEntry(destination, destinationRoot, "file", "standard configuration")) {
          destinationReady = true;
          return;
        }
      }
    }
    throw unsafeAuthority("standard configuration");
  } finally {
    try {
      rmSync(ioPath(destinationRoot, staging), { force: true });
    } catch (error) {
      if (!destinationReady) throw error;
    }
  }
}

function validateDirectoryTree(path: string, root: AuthorityRoot, label: string): void {
  assertEntry(path, root, "directory", label);
  for (const name of readdirSync(ioPath(root, path))) {
    const item = join(path, name);
    const stat = lstatIfPresent(item);
    if (!stat || stat.isSymbolicLink()) throw unsafeAuthority(label);
    if (stat.isDirectory()) {
      validateDirectoryTree(item, root, label);
      continue;
    }
    if (!stat.isFile()) throw unsafeAuthority(label);
    assertEntry(item, root, "file", label);
  }
}

function copyDirectoryContents(
  source: string,
  destination: string,
  sourceRoot: AuthorityRoot,
  destinationRoot: AuthorityRoot,
  label: string,
): void {
  ensureDirectory(destination, destinationRoot, label);
  for (const name of readdirSync(ioPath(sourceRoot, source))) {
    const sourceItem = join(source, name);
    const destinationItem = join(destination, name);
    const stat = lstatIfPresent(sourceItem);
    if (!stat || stat.isSymbolicLink()) throw unsafeAuthority(label);
    if (stat.isDirectory()) {
      assertEntry(sourceItem, sourceRoot, "directory", label);
      copyDirectoryContents(sourceItem, destinationItem, sourceRoot, destinationRoot, label);
      continue;
    }
    if (!stat.isFile()) throw unsafeAuthority(label);
    const content = readRegularFile(sourceItem, sourceRoot, label);
    writeRegularFileExclusive(destinationItem, content, destinationRoot, stat.mode & 0o777, label);
    setFileMode(destinationItem, destinationRoot, stat.mode & 0o777, label);
    assertEntry(destinationItem, destinationRoot, "file", label);
  }
}

function copyDirectoryIfMissing(
  source: string,
  destination: string,
  sourceRoot: AuthorityRoot,
  destinationOuterRoot: AuthorityRoot,
  label: string,
): void {
  const sourceStat = assertEntry(source, sourceRoot, "directory", `legacy ${label}`);
  const destinationStat = assertEntry(destination, destinationOuterRoot, "directory", `standard ${label}`);
  if (sourceStat) validateDirectoryTree(source, sourceRoot, `legacy ${label}`);
  if (destinationStat) {
    const destinationRoot: AuthorityRoot = {
      path: resolve(destination),
      canonical: realpathSync.native(destination),
      label: `standard ${label}`,
      anchorPath: destinationOuterRoot.anchorPath,
      anchorFd: destinationOuterRoot.anchorFd,
      anchorMissing: destinationOuterRoot.anchorMissing,
      ioBase: destinationOuterRoot.ioBase,
    };
    validateDirectoryTree(destination, destinationRoot, `standard ${label}`);
    return;
  }
  if (!sourceStat) return;

  const destinationCanonical = expectedCanonical(destinationOuterRoot, destination);
  ensureParent(
    destination,
    dirname(destinationCanonical),
    `standard ${label} parent`,
    destinationOuterRoot,
  );
  const staging = stagingPath(destination);
  const stagingParent: AuthorityRoot = {
    path: dirname(destination),
    canonical: dirname(destinationCanonical),
    label: `standard ${label} parent`,
    anchorPath: destinationOuterRoot.anchorPath,
    anchorFd: destinationOuterRoot.anchorFd,
    anchorMissing: destinationOuterRoot.anchorMissing,
    ioBase: destinationOuterRoot.ioBase,
  };
  try {
    ensureDirectory(staging, stagingParent, `staged ${label}`);
    const stagingRoot: AuthorityRoot = {
      path: resolve(staging),
      canonical: realpathSync.native(staging),
      label: `staged ${label}`,
      anchorPath: destinationOuterRoot.anchorPath,
      anchorFd: destinationOuterRoot.anchorFd,
      anchorMissing: destinationOuterRoot.anchorMissing,
      ioBase: destinationOuterRoot.ioBase,
    };
    copyDirectoryContents(source, staging, sourceRoot, stagingRoot, `staged ${label}`);
    validateDirectoryTree(source, sourceRoot, `legacy ${label}`);
    if (assertEntry(destination, destinationOuterRoot, "directory", `standard ${label}`)) {
      throw unsafeAuthority(`standard ${label}`);
    }
    renameSync(
      ioPath(destinationOuterRoot, staging),
      ioPath(destinationOuterRoot, destination),
    );
    const committedRoot: AuthorityRoot = {
      path: resolve(destination),
      canonical: realpathSync.native(destination),
      label: `standard ${label}`,
      anchorPath: destinationOuterRoot.anchorPath,
      anchorFd: destinationOuterRoot.anchorFd,
      anchorMissing: destinationOuterRoot.anchorMissing,
      ioBase: destinationOuterRoot.ioBase,
    };
    validateDirectoryTree(destination, committedRoot, `standard ${label}`);
  } finally {
    rmSync(ioPath(destinationOuterRoot, staging), { recursive: true, force: true });
  }
}

function validateSqliteSchema(db: SqliteDatabase, kind: SqliteKind): void {
  const tables = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
  ).pluck().all() as string[]);
  const recognized = kind === "prompts"
    ? tables.has("prompts")
    : kind === "vocab"
      ? tables.has("custom_words") || tables.has("vocab")
      : kind === "search"
        ? tables.has("docs") && tables.has("docs_meta")
        : tables.has("agent_tasks");
  if (!recognized) throw new Error("SQLite schema is not recognized");
  if (kind !== "host" && tables.has("meta")) {
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get();
    if (version !== undefined && version !== "1") throw new Error("SQLite schema version is unsupported");
  }
}

function validateSqliteSidecars(path: string, root: AuthorityRoot, label: string): boolean {
  let present = false;
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (assertEntry(`${path}${suffix}`, root, "file", `${label} sidecar`)) present = true;
  }
  return present;
}

function validateSqliteFile(
  path: string,
  kind: SqliteKind,
  root: AuthorityRoot,
  label: string,
  makePrivate: boolean,
  normalizeJournal = false,
): boolean {
  const sidecarsPresent = validateSqliteSidecars(path, root, label);
  const before = assertEntry(path, root, "file", label);
  if (!before) {
    if (sidecarsPresent) throw new Error(`${label} SQLite authority is invalid`);
    return false;
  }
  let db: SqliteDatabase | null = null;
  try {
    db = new Database(ioPath(root, path), { readonly: !normalizeJournal, fileMustExist: true });
    assertRootStable(root);
    if (db.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new Error("SQLite integrity check failed");
    }
    validateSqliteSchema(db, kind);
    if (normalizeJournal) db.pragma("journal_mode = DELETE");
  } catch {
    throw new Error(`${label} SQLite authority is invalid`);
  } finally {
    db?.close();
  }
  validateSqliteSidecars(path, root, label);
  const after = assertEntry(path, root, "file", label)!;
  assertStable(before, after, label);
  if (normalizeJournal) {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = `${path}${suffix}`;
      if (assertEntry(sidecar, root, "file", `${label} sidecar`)) {
        rmSync(ioPath(root, sidecar), { force: true });
      }
    }
  }
  if (makePrivate) setPrivateFile(path, root, label);
  return true;
}

async function backupSqliteIfMissing(
  source: string,
  destination: string,
  kind: SqliteKind,
  sourceRoot: AuthorityRoot,
  destinationRoot: AuthorityRoot,
): Promise<void> {
  const sourceExists = validateSqliteFile(source, kind, sourceRoot, `legacy ${kind}`, false);
  const destinationExists = validateSqliteFile(
    destination,
    kind,
    destinationRoot,
    `standard ${kind}`,
    true,
  );
  if (destinationExists || !sourceExists) return;
  ensureDirectory(dirname(destination), destinationRoot, `standard ${kind} parent`);
  const staging = stagingPath(destination);
  const before = assertEntry(source, sourceRoot, "file", `legacy ${kind}`)!;
  let sourceDb: SqliteDatabase | null = null;
  try {
    try {
      sourceDb = new Database(ioPath(sourceRoot, source), { readonly: true, fileMustExist: true });
      assertRootStable(sourceRoot);
      await sourceDb.backup(ioPath(destinationRoot, staging));
      assertRootStable(destinationRoot);
    } catch {
      throw new Error(`legacy ${kind} SQLite backup failed`);
    } finally {
      sourceDb?.close();
      sourceDb = null;
    }
    const after = assertEntry(source, sourceRoot, "file", `legacy ${kind}`)!;
    assertStable(before, after, `legacy ${kind}`);
    validateSqliteFile(staging, kind, destinationRoot, `staged ${kind}`, true, true);
    if (assertEntry(destination, destinationRoot, "file", `standard ${kind}`)) {
      throw unsafeAuthority(`standard ${kind}`);
    }
    renameSync(ioPath(destinationRoot, staging), ioPath(destinationRoot, destination));
    validateSqliteFile(destination, kind, destinationRoot, `standard ${kind}`, true);
  } finally {
    rmSync(ioPath(destinationRoot, staging), { force: true });
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = `${staging}${suffix}`;
      const stat = lstatIfPresent(sidecar);
      if (stat && !stat.isSymbolicLink() && stat.isFile()) {
        rmSync(ioPath(destinationRoot, sidecar), { force: true });
      }
    }
  }
}

/**
 * Prepare only the Host-owned durable subset. Capture/media/IPC/log ownership
 * remains on the explicit legacy paths until #163; the global transaction and
 * service takeover remain owned by ADR-0021 follow-up work.
 */
export async function prepareHostDurableData(paths: HostDataPaths): Promise<void> {
  if (resolve(paths.durableDataDir) === resolve(paths.legacyReadOnlyDataDir)) return;
  const authority = establishAuthorities(paths);
  const originalCwd = process.cwd();
  try {
    process.chdir(authority.durable.path);
    const cwdFd = openSync(".", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (authority.durable.anchorFd === undefined) throw unsafeAuthority(authority.durable.label);
      assertStable(fstatSync(authority.durable.anchorFd), fstatSync(cwdFd), authority.durable.label);
    } finally {
      closeSync(cwdFd);
    }
    const modelsOuterRoot = insideOrEqual(authority.durable.canonical, authority.models.canonical)
      ? authority.durable
      : authority.models;

    copyPrivateFileIfMissing(
      join(paths.legacyReadOnlyDataDir, "config.json"),
      paths.configFile,
      authority.legacy,
      authority.durable,
      "configuration",
    );
    copyPrivateFileIfMissing(
      join(paths.legacyReadOnlyDataDir, "agent-sessions.json"),
      join(paths.durableDataDir, "agent-sessions.json"),
      authority.legacy,
      authority.durable,
      "Agent sessions",
    );
    try {
      copyPrivateFileIfMissing(
        join(paths.legacyReadOnlyDataDir, "mcp-token.json"),
        paths.mcpTokenJson,
        authority.legacy,
        authority.durable,
        "MCP token",
      );
      if (assertEntry(paths.mcpTokenJson, authority.durable, "file", "standard MCP token")) {
        setPrivateFile(paths.mcpTokenJson, authority.durable, "standard MCP token");
      }
    } catch {
      throw new Error("MCP token migration failed");
    }

    await backupSqliteIfMissing(
      join(paths.legacyReadOnlyDataDir, "prompts.sqlite"),
      paths.promptsDb,
      "prompts",
      authority.legacy,
      authority.durable,
    );
    await backupSqliteIfMissing(
      join(paths.legacyReadOnlyDataDir, "vocab.sqlite"),
      paths.vocabDb,
      "vocab",
      authority.legacy,
      authority.durable,
    );
    await backupSqliteIfMissing(
      join(paths.legacyReadOnlyDataDir, "search.sqlite"),
      paths.searchDb,
      "search",
      authority.legacy,
      authority.durable,
    );
    await backupSqliteIfMissing(
      join(paths.legacyReadOnlyDataDir, "host.sqlite"),
      paths.hostDb,
      "host",
      authority.legacy,
      authority.durable,
    );

    copyDirectoryIfMissing(
      join(paths.legacyReadOnlyDataDir, "models"),
      paths.modelsDir,
      authority.legacy,
      modelsOuterRoot,
      "Models",
    );
    copyDirectoryIfMissing(
      join(paths.legacyReadOnlyDataDir, "agent-tasks"),
      paths.agentTasksDir,
      authority.legacy,
      authority.durable,
      "Agent tasks",
    );
    copyDirectoryIfMissing(
      join(paths.legacyReadOnlyDataDir, "local-caption"),
      join(paths.durableDataDir, "local-caption"),
      authority.legacy,
      authority.durable,
      "local caption runtime",
    );
    createDefaultConfigIfMissing(paths.configFile, authority.durable);
  } finally {
    try {
      process.chdir(originalCwd);
    } finally {
      const descriptors = new Set([
        authority.durable.anchorFd,
        authority.legacy.anchorFd,
      ].filter((fd): fd is number => fd !== undefined));
      for (const fd of descriptors) closeSync(fd);
    }
  }
}
