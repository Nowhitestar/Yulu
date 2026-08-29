import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  armed: false,
  swapped: false,
  exposed: "" as string,
  swap: null as null | (() => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const maybeSwap = (path: unknown) => {
    if (!race.armed || race.swapped || typeof path !== "string" || !path.includes(".migration")) return;
    race.swapped = true;
    race.swap?.();
  };
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      maybeSwap(args[0]);
      return (actual.openSync as (...inner: typeof args) => number)(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      maybeSwap(args[0]);
      const result = (actual.writeFileSync as (...inner: typeof args) => void)(...args);
      if (race.swapped && typeof args[0] === "string" && args[0].includes(".migration")) {
        race.exposed = actual.readFileSync(args[0], "utf8");
      }
      return result;
    },
  };
});

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareHostDurableData } from "../src/hostDataMigration.js";
import { resolveHostPaths } from "../src/paths.js";

const roots: string[] = [];

afterEach(() => {
  race.armed = false;
  race.swapped = false;
  race.exposed = "";
  race.swap = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Host durable migration root identity", () => {
  it("does not expose copied bytes when the standard root is exchanged during staging", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-host-root-race-"));
    roots.push(root);
    const paths = resolveHostPaths({ homeDir: root, environment: {} });
    mkdirSync(paths.legacyReadOnlyDataDir, { recursive: true });
    const secretConfig = '{"llm":{"command":"never-expose-this"}}\n';
    writeFileSync(join(paths.legacyReadOnlyDataDir, "config.json"), secretConfig, { mode: 0o600 });
    const movedRoot = `${paths.durableDataDir}.moved`;
    const external = join(root, "external-standard-target");
    mkdirSync(external, { recursive: true });
    race.swap = () => {
      renameSync(paths.durableDataDir, movedRoot);
      symlinkSync(external, paths.durableDataDir, "dir");
    };
    race.armed = true;

    await expect(prepareHostDurableData(paths)).rejects.toThrow(/authority|unsafe/i);

    expect(race.swapped).toBe(true);
    expect(race.exposed).not.toContain("never-expose-this");
    expect(readdirSync(external)).toEqual([]);
    expect(readdirSync(dirname(paths.durableDataDir))).toContain("Yulu.moved");
  });
});
