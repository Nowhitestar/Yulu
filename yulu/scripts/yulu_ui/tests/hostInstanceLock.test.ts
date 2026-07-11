import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireHostInstanceLock,
  HostInstanceAlreadyRunningError,
  hostInstanceLockPath,
} from "../src/hostInstanceLock.js";

const roots: string[] = [];

function tempConfigDir(): string {
  const root = mkdtempSync(join(tmpdir(), "yulu_host_lock_"));
  roots.push(root);
  return join(root, "config");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Host instance lock", () => {
  it("atomically rejects a second live owner and allows reacquisition after release", () => {
    const configDir = tempConfigDir();
    const first = acquireHostInstanceLock(configDir);

    expect(() => acquireHostInstanceLock(configDir)).toThrow(HostInstanceAlreadyRunningError);
    expect(readdirSync(configDir).filter((name) => name.includes(".staging-"))).toEqual([]);
    expect(first.release()).toBe(true);
    expect(first.release()).toBe(true);

    const second = acquireHostInstanceLock(configDir);
    expect(second.token).not.toBe(first.token);
    expect(second.release()).toBe(true);
  });

  it("reclaims a lock whose recorded PID is no longer alive", () => {
    const configDir = tempConfigDir();
    const lockPath = hostInstanceLockPath(configDir);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      token: "00000000-0000-4000-8000-000000000000",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));

    const lock = acquireHostInstanceLock(configDir);
    expect(lock.token).not.toBe("00000000-0000-4000-8000-000000000000");
    expect(lock.release()).toBe(true);
  });

  it.each(["missing", "malformed"])("reclaims a %s owner record instead of blocking forever", (kind) => {
    const configDir = tempConfigDir();
    const lockPath = hostInstanceLockPath(configDir);
    mkdirSync(lockPath, { recursive: true });
    if (kind === "malformed") writeFileSync(join(lockPath, "owner.json"), "not-json");

    const lock = acquireHostInstanceLock(configDir);
    expect(lock.path).toBe(lockPath);
    expect(lock.release()).toBe(true);
  });

  it("does not let an abandoned staging directory block acquisition", () => {
    const configDir = tempConfigDir();
    mkdirSync(`${hostInstanceLockPath(configDir)}.staging-abandoned`, { recursive: true });

    const lock = acquireHostInstanceLock(configDir);
    expect(lock.release()).toBe(true);
  });

  it("hardens an existing config directory to mode 0700", () => {
    const configDir = tempConfigDir();
    mkdirSync(configDir, { recursive: true });
    chmodSync(configDir, 0o755);

    const lock = acquireHostInstanceLock(configDir);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(lock.release()).toBe(true);
  });

  it("does not remove a lock when its ownership token has changed", () => {
    const configDir = tempConfigDir();
    const lock = acquireHostInstanceLock(configDir);
    writeFileSync(join(lock.path, "owner.json"), JSON.stringify({
      pid: process.pid,
      token: "11111111-1111-4111-8111-111111111111",
      createdAt: new Date().toISOString(),
    }));

    expect(lock.release()).toBe(false);
    expect(existsSync(lock.path)).toBe(true);
  });
});
