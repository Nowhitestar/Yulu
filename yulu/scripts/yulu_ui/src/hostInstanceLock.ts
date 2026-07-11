import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const LOCK_DIR_NAME = "host-instance.lock";
const OWNER_FILE_NAME = "owner.json";

interface LockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

interface LockSnapshot {
  owner: LockOwner | null;
  identity: string;
}

export interface HostInstanceLock {
  path: string;
  token: string;
  release: () => boolean;
}

export class HostInstanceAlreadyRunningError extends Error {
  readonly code = "YULU_HOST_ALREADY_RUNNING";

  constructor(path: string, pid?: number) {
    super(pid
      ? `Yulu Host is already running (pid ${pid}; lock ${path})`
      : `Yulu Host instance lock is already held (${path})`);
    this.name = "HostInstanceAlreadyRunningError";
  }
}

export function hostInstanceLockPath(configDir: string): string {
  return join(configDir, LOCK_DIR_NAME);
}

function ownerPath(lockPath: string): string {
  return join(lockPath, OWNER_FILE_NAME);
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(ownerPath(lockPath), "utf8")) as Partial<LockOwner>;
    if (!Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0) return null;
    if (typeof value.token !== "string" || !/^[A-Za-z0-9-]{16,}$/.test(value.token)) return null;
    if (typeof value.createdAt !== "string") return null;
    return value as LockOwner;
  } catch {
    return null;
  }
}

function readLockSnapshot(lockPath: string): LockSnapshot | null {
  try {
    const before = statSync(lockPath);
    const owner = readOwner(lockPath);
    const after = statSync(lockPath);
    if (before.dev !== after.dev || before.ino !== after.ino) return null;
    return {
      owner,
      identity: owner
        ? `owner-${owner.token}`
        : `inode-${after.dev.toString(36)}-${after.ino.toString(36)}`,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isRenameConflict(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "");
}

/**
 * Acquire the per-config-directory Host lock.
 *
 * The owner record is fully written in a token-specific staging directory,
 * then that directory is atomically renamed into place. This ensures the main
 * lock path is never published without its owner metadata. A stale or malformed
 * lock is renamed to an identity-specific tombstone before retrying; leaving the
 * tombstone in place prevents a delayed stale contender from moving a successor.
 */
export function acquireHostInstanceLock(configDir: string): HostInstanceLock {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  const lockPath = hostInstanceLockPath(configDir);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = randomUUID();
    const stagingPath = `${lockPath}.staging-${token}`;
    const owner: LockOwner = {
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
    };
    try {
      mkdirSync(stagingPath, { mode: 0o700 });
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw error;
    }

    try {
      writeFileSync(ownerPath(stagingPath), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      rmSync(stagingPath, { recursive: true, force: true });
      throw error;
    }

    try {
      renameSync(stagingPath, lockPath);
    } catch (error) {
      rmSync(stagingPath, { recursive: true, force: true });
      if (!isRenameConflict(error)) throw error;

      const snapshot = readLockSnapshot(lockPath);
      if (!snapshot) continue;
      if (snapshot.owner && isProcessAlive(snapshot.owner.pid)) {
        throw new HostInstanceAlreadyRunningError(lockPath, snapshot.owner.pid);
      }

      const tombstone = `${lockPath}.stale-${snapshot.identity}`;
      try {
        // Confirm the same directory still occupies the main path immediately
        // before moving it. The shared tombstone name also prevents ABA races.
        if (readLockSnapshot(lockPath)?.identity !== snapshot.identity) continue;
        renameSync(lockPath, tombstone);
      } catch (renameError) {
        const code = (renameError as NodeJS.ErrnoException).code;
        if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(code ?? "")) continue;
        throw renameError;
      }
      continue;
    }

    let released = false;
    return {
      path: lockPath,
      token,
      release: () => {
        if (released) return true;
        if (readOwner(lockPath)?.token !== token) return false;

        const releasedPath = `${lockPath}.released-${token}`;
        try {
          renameSync(lockPath, releasedPath);
          rmSync(releasedPath, { recursive: true, force: true });
          released = true;
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      },
    };
  }

  throw new HostInstanceAlreadyRunningError(lockPath);
}
