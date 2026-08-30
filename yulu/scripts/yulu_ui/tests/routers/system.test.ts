import { describe, it, expect, beforeEach, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const ipcSendMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});
vi.mock("../../src/ipc.js", () => ({ ipcSend: ipcSendMock }));

import { systemRouter } from "../../src/routers/system.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

beforeEach(() => {
  spawnMock.mockReset();
  ipcSendMock.mockReset();
});

function mockSpawn(stdout: string, exitCode = 0, stderr = "") {
  spawnMock.mockImplementation(() => {
    const handlers = new Map<string, (arg: unknown) => void>();
    const proc = {
      stdout: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data") cb(Buffer.from(stdout)); } },
      stderr: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data" && stderr) cb(Buffer.from(stderr)); } },
      on: (e: string, cb: (arg: unknown) => void) => { handlers.set(e, cb); },
      kill: () => {},
    };
    setImmediate(() => handlers.get("close")?.(exitCode));
    return proc;
  });
}

describe("systemRouter", () => {
  it("version() returns the yulu_ui package version", async () => {
    const caller = createCaller(systemRouter, {} as AppContext);
    const v = await caller.version();
    expect(v.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.name).toBe("yulu-ui");
  });
});

describe("system.pickFile", () => {
  it("returns the chosen path for mode=folder", async () => {
    mockSpawn("/Users/me/Movies/Yulu\n");
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.pickFile({ mode: "folder" });
    expect(r.path).toBe("/Users/me/Movies/Yulu");
    expect(spawnMock.mock.calls[0]![0]).toBe("osascript");
  });

  it("returns the chosen path for mode=file with filter", async () => {
    mockSpawn("/x/y.bin\n");
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.pickFile({ mode: "file", filter: "bin" });
    expect(r.path).toBe("/x/y.bin");
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args.join(" ")).toContain('"bin"');
  });

  it("returns null on user-cancel (non-zero exit)", async () => {
    mockSpawn("", 1, "User canceled.");
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.pickFile({ mode: "folder" });
    expect(r.path).toBeNull();
  });
});

describe("system.openInFinder", () => {
  it("spawns `open <path>` when reveal=false", async () => {
    mockSpawn("");
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.openInFinder({ path: "/x/y" });
    expect(r.ok).toBe(true);
    expect(spawnMock.mock.calls[0]![0]).toBe("open");
    expect(spawnMock.mock.calls[0]![1]).toEqual(["/x/y"]);
  });

  it("spawns `open -R <path>` when reveal=true", async () => {
    mockSpawn("");
    const caller = createCaller(systemRouter, {} as AppContext);
    await caller.openInFinder({ path: "/x/y.txt", reveal: true });
    expect(spawnMock.mock.calls[0]![1]).toEqual(["-R", "/x/y.txt"]);
  });
});

describe("system.audioDevices", () => {
  it("returns CoreAudio devices reported by the native audio daemon", async () => {
    ipcSendMock.mockResolvedValue({
      input: [
        { name: "MacBook Pro Microphone", uid: "BuiltInMic" },
        { name: "BlackHole 2ch", uid: "BlackHole2ch" },
      ],
      output: [{ name: "MacBook Pro Speakers", uid: "BuiltInSpeaker" }],
    });
    const caller = createCaller(systemRouter, { paths: { audioDaemonSock: "/tmp/audio.sock" } } as AppContext);
    const r = (await caller.audioDevices()) as {
      input: Array<{ uid: string; name: string }>;
      output: Array<{ uid: string; name: string }>;
    };
    expect(r.input.map((d) => d.name)).toEqual(["MacBook Pro Microphone", "BlackHole 2ch"]);
    expect(r.output.map((d) => d.name)).toEqual(["MacBook Pro Speakers"]);
    expect(r.input[0]!.uid).toBe("BuiltInMic");
    expect(ipcSendMock).toHaveBeenCalledWith("/tmp/audio.sock", { action: "audio_devices" });
  });

  it("returns an explicit error on malformed daemon replies", async () => {
    ipcSendMock.mockResolvedValue({ input: [{ name: "Missing UID" }] });
    const caller = createCaller(systemRouter, { paths: { audioDaemonSock: "/tmp/audio.sock" } } as AppContext);
    const r = await caller.audioDevices();
    expect(r.input).toEqual([]);
    expect(r.output).toEqual([]);
    expect(r.error).toBeTruthy();
  });

  it("returns an explicit error when the audio daemon is unavailable", async () => {
    ipcSendMock.mockRejectedValue(new Error("connect ENOENT"));
    const caller = createCaller(systemRouter, { paths: { audioDaemonSock: "/tmp/audio.sock" } } as AppContext);
    const r = await caller.audioDevices();
    expect(r.input).toEqual([]);
    expect(r.output).toEqual([]);
    expect(r.error).toContain("ENOENT");
  });
});

import { mkdtempSync, mkdirSync, writeFileSync as _writeFileSync } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { join as _join } from "node:path";
import Database from "better-sqlite3";

describe("system.dbStats", () => {
  it("returns size + row count for prompts/vocab/search SQLite files", async () => {
    const dir = mkdtempSync(_join(_tmpdir(), "yulu_dbst_"));
    const promptsPath = _join(dir, "prompts.sqlite");
    const vocabPath = _join(dir, "vocab.sqlite");
    const searchPath = _join(dir, "search.sqlite");
    const p = new Database(promptsPath); p.exec("CREATE TABLE prompts (id TEXT); INSERT INTO prompts VALUES ('a');"); p.close();
    const v = new Database(vocabPath); v.exec("CREATE TABLE custom_words (id TEXT PRIMARY KEY); INSERT INTO custom_words VALUES ('1'),('2');"); v.close();
    const s = new Database(searchPath); s.exec("CREATE VIRTUAL TABLE docs USING fts5(body);"); s.close();
    const ctx = { paths: { promptsDb: promptsPath, vocabDb: vocabPath, searchDb: searchPath } } as unknown as AppContext;
    const caller = createCaller(systemRouter, ctx);
    const r = await caller.dbStats();
    expect(r.find((d: { name: string }) => d.name === "prompts")!.rows).toBe(1);
    expect(r.find((d: { name: string }) => d.name === "vocab")!.rows).toBe(2);
    expect(r.find((d: { name: string }) => d.name === "search")!.rows).toBe(0);
    expect(r.every((d: { size: number }) => d.size > 0)).toBe(true);
  });

  it("returns rows=null + size=0 when DB file missing", async () => {
    const ctx = { paths: { promptsDb: "/no/such/p.sqlite", vocabDb: "/no/such/v.sqlite", searchDb: "/no/such/s.sqlite" } } as unknown as AppContext;
    const caller = createCaller(systemRouter, ctx);
    const r = await caller.dbStats();
    expect(r.every((d: { rows: number | null; size: number }) => d.rows === null && d.size === 0)).toBe(true);
  });
});

describe("system.logPaths", () => {
  it("returns the current yulu daemon log paths under logsDir", async () => {
    const ctx = { paths: { configDir: "/wrong/durable-root", logsDir: "/x/Library/Logs/Yulu" } } as unknown as AppContext;
    const caller = createCaller(systemRouter, ctx);
    const r = await caller.logPaths();
    expect(r).toHaveLength(6);
    expect(r.map((p: { name: string }) => p.name).sort()).toEqual(
      ["audiodaemon","calendar","detector","scheduler","statusagent","ui"]
    );
    expect(r).toEqual([
      { name: "audiodaemon", path: "/x/Library/Logs/Yulu/audio_daemon.log" },
      { name: "statusagent", path: "/x/Library/Logs/Yulu/status_agent.log" },
      { name: "scheduler", path: "/x/Library/Logs/Yulu/scheduler.log" },
      { name: "detector", path: "/x/Library/Logs/Yulu/detector.log" },
      { name: "calendar", path: "/x/Library/Logs/Yulu/calendar_services.log" },
      { name: "ui", path: "/x/Library/Logs/Yulu/ui.log" },
    ]);
  });
});
