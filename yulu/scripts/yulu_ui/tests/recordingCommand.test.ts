import { beforeEach, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => {
  const mock = vi.fn();
  Object.defineProperty(mock, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) => {
      mock(...args);
      return Promise.resolve({ stdout: "recording started\n", stderr: "" });
    },
  });
  return mock;
});
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { runRecordAudio } from "../src/recordingCommand.js";
import type { AppContext } from "../src/trpc.js";

beforeEach(() => execFileMock.mockClear());

it("passes the standard path contract while applying a timeout only when requested", async () => {
  const ctx = {
    paths: {
      scriptDir: "/source/yulu/scripts",
      durableDataDir: "/isolated/Library/Application Support/Yulu",
      cacheDir: "/isolated/Library/Caches/Yulu",
      ipcDir: "/isolated/Library/Caches/Yulu/ipc",
      logsDir: "/isolated/Library/Logs/Yulu",
      mediaLibraryDir: "/isolated/Movies/Yulu",
      legacyReadOnlyDataDir: "/isolated/.config/yulu",
    },
  } as unknown as AppContext;

  await expect(runRecordAudio(ctx, ["start", "Core Activation"], { timeoutMs: 30_000 }))
    .resolves.toMatchObject({ ok: true, stdout: "recording started\n" });
  expect(execFileMock).toHaveBeenCalledOnce();
  expect(execFileMock.mock.calls[0]![0]).toBe("python3");
  expect(execFileMock.mock.calls[0]![1]).toEqual([
    "/source/yulu/scripts/record_audio.py", "start", "Core Activation",
  ]);
  expect((execFileMock.mock.calls[0]![2] as { timeout?: number }).timeout).toBe(30_000);
  const env = (execFileMock.mock.calls[0]![2] as { env?: NodeJS.ProcessEnv }).env!;
  expect(env.YULU_APPLICATION_SUPPORT_DIR).toBe("/isolated/Library/Application Support/Yulu");
  expect(env.YULU_CACHE_DIR).toBe("/isolated/Library/Caches/Yulu");
  expect(env.YULU_IPC_DIR).toBe("/isolated/Library/Caches/Yulu/ipc");
  expect(env.YULU_LOG_DIR).toBe("/isolated/Library/Logs/Yulu");
  expect(env.YULU_MEDIA_LIBRARY_DIR).toBe("/isolated/Movies/Yulu");
  expect(env.YULU_LEGACY_READ_ONLY_DATA_DIR).toBe("/isolated/.config/yulu");
  expect(env.YULU_CONFIG_DIR).toBeUndefined();

  await runRecordAudio(ctx, ["stop"]);
  expect((execFileMock.mock.calls[1]![2] as { timeout?: number }).timeout).toBeUndefined();
});
