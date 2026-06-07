// tests/routers/system.version.test.ts
// P3-1: the read-only "About" block reads Yulu's product version (the repo-root
// VERSION file — NOT the yulu_ui package version) plus the install source from
// .yulu-install.json. This query never writes and never throws: a missing or
// unreadable VERSION degrades to "unknown", and a missing install file → null.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { systemRouter } from "../../src/routers/system.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

function ctxWith(versionFile: string, installJson: string): AppContext {
  return { paths: { versionFile, installJson } } as unknown as AppContext;
}

describe("system.yuluVersion (P3-1 About block)", () => {
  it("returns the trimmed VERSION string and a release install source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yulu_ver_"));
    const versionFile = join(dir, "VERSION");
    const installJson = join(dir, ".yulu-install.json");
    writeFileSync(versionFile, "0.8.0\n");
    writeFileSync(installJson, JSON.stringify({ source: "release", version: "v0.8.0" }));
    try {
      const caller = createCaller(systemRouter, ctxWith(versionFile, installJson));
      const r = await caller.yuluVersion();
      expect(r.version).toBe("0.8.0");
      expect(r.installSource).toBe("release v0.8.0");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("formats a dev install source from branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yulu_ver_"));
    const versionFile = join(dir, "VERSION");
    const installJson = join(dir, ".yulu-install.json");
    writeFileSync(versionFile, "0.8.0");
    writeFileSync(installJson, JSON.stringify({ source: "dev", branch: "main" }));
    try {
      const caller = createCaller(systemRouter, ctxWith(versionFile, installJson));
      const r = await caller.yuluVersion();
      expect(r.installSource).toBe("dev main");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("install source is null when .yulu-install.json is absent (a dev checkout)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yulu_ver_"));
    const versionFile = join(dir, "VERSION");
    writeFileSync(versionFile, "0.8.0");
    try {
      const caller = createCaller(systemRouter, ctxWith(versionFile, join(dir, ".yulu-install.json")));
      const r = await caller.yuluVersion();
      expect(r.version).toBe("0.8.0");
      expect(r.installSource).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("degrades to version='unknown' when VERSION is missing (never throws)", async () => {
    const caller = createCaller(systemRouter, ctxWith("/no/such/VERSION", "/no/such/.yulu-install.json"));
    const r = await caller.yuluVersion();
    expect(r.version).toBe("unknown");
    expect(r.installSource).toBeNull();
  });

  it("ignores a malformed install json (null source), still returns the version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yulu_ver_"));
    const versionFile = join(dir, "VERSION");
    const installJson = join(dir, ".yulu-install.json");
    writeFileSync(versionFile, "1.2.3");
    writeFileSync(installJson, "{ not valid json");
    try {
      const caller = createCaller(systemRouter, ctxWith(versionFile, installJson));
      const r = await caller.yuluVersion();
      expect(r.version).toBe("1.2.3");
      expect(r.installSource).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
