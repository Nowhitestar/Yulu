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

it("isolates config while applying a timeout only when the activation caller requests one", async () => {
  const ctx = {
    paths: { scriptDir: "/source/yulu/scripts", configDir: "/isolated/.config/yulu" },
  } as unknown as AppContext;

  await expect(runRecordAudio(ctx, ["start", "Core Activation"], { timeoutMs: 30_000 }))
    .resolves.toMatchObject({ ok: true, stdout: "recording started\n" });
  expect(execFileMock).toHaveBeenCalledOnce();
  expect(execFileMock.mock.calls[0]![0]).toBe("python3");
  expect(execFileMock.mock.calls[0]![1]).toEqual([
    "/source/yulu/scripts/record_audio.py", "start", "Core Activation",
  ]);
  expect((execFileMock.mock.calls[0]![2] as { timeout?: number }).timeout).toBe(30_000);
  expect((execFileMock.mock.calls[0]![2] as { env?: NodeJS.ProcessEnv }).env?.YULU_CONFIG_DIR)
    .toBe("/isolated/.config/yulu");

  await runRecordAudio(ctx, ["stop"]);
  expect((execFileMock.mock.calls[1]![2] as { timeout?: number }).timeout).toBeUndefined();
});
