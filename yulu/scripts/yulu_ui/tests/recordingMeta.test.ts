import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeTags,
  readTitleSidecar,
  writeTitleSidecar,
  readTagsSidecar,
  writeTagsSidecar,
} from "../src/recordingMeta.js";

describe("normalizeTags", () => {
  it("trims, drops empties, and de-dupes case-insensitively (first spelling wins)", () => {
    expect(normalizeTags([" Work ", "work", "", "URGENT", "urgent", "client"]))
      .toEqual(["Work", "URGENT", "client"]);
  });

  it("caps tag length and total count", () => {
    const long = "x".repeat(200);
    expect(normalizeTags([long])[0]!.length).toBe(64);
    expect(normalizeTags(Array.from({ length: 100 }, (_, i) => `t${i}`)).length).toBe(50);
  });
});

describe("title sidecar round-trip", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "meta_")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes with a trailing newline and reads back trimmed", () => {
    const p = join(dir, "x.title");
    writeTitleSidecar(p, "  Hello World  ");
    expect(readFileSync(p, "utf8")).toBe("Hello World\n");
    expect(readTitleSidecar(p)).toBe("Hello World");
  });

  it("empty write removes the file; absent/empty read is null", () => {
    const p = join(dir, "x.title");
    writeTitleSidecar(p, "keep");
    writeTitleSidecar(p, "   ");
    expect(existsSync(p)).toBe(false);
    expect(readTitleSidecar(p)).toBeNull();
  });
});

describe("tags sidecar round-trip", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "meta_")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("persists normalized JSON and reads it back", () => {
    const p = join(dir, "x.tags.json");
    expect(writeTagsSidecar(p, ["a", "a", "b"])).toEqual(["a", "b"]);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(["a", "b"]);
    expect(readTagsSidecar(p)).toEqual(["a", "b"]);
  });

  it("empty write removes the file", () => {
    const p = join(dir, "x.tags.json");
    writeTagsSidecar(p, ["a"]);
    writeTagsSidecar(p, []);
    expect(existsSync(p)).toBe(false);
    expect(readTagsSidecar(p)).toEqual([]);
  });

  it("tolerates a malformed sidecar by returning []", () => {
    const p = join(dir, "x.tags.json");
    writeFileSync(p, "not json{");
    expect(readTagsSidecar(p)).toEqual([]);
    writeFileSync(p, '{"not":"an array"}');
    expect(readTagsSidecar(p)).toEqual([]);
  });
});
