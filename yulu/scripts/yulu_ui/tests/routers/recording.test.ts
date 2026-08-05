import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingRouter } from "../../src/routers/recording.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { startFakeSocket, type FakeSocket } from "../helpers/fakeUnixSocket.js";

describe("recordingRouter", () => {
  let fake: FakeSocket | undefined;
  let tempDir: string | undefined;
  afterEach(async () => {
    if (fake) { await fake.stop(); fake = undefined; }
    if (tempDir) { await rm(tempDir, { recursive: true, force: true }); tempDir = undefined; }
  });

  it("state() round-trips status from status_agent.sock", async () => {
    fake = await startFakeSocket((req) => {
      expect(req).toEqual({ action: "status" });
      return { ok: true, state: "idle", hotkey: "⌘⇧V" };
    });
    const ctx = { paths: { statusAgentSock: fake.path } } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    const r = await caller.state();
    expect(r.state).toBe("idle");
    expect(r.hotkey).toBe("⌘⇧V");
    expect(r.dictationActive).toBe(false);
  });

  it("state() reports unknown when status_agent.sock is unavailable", async () => {
    const ctx = { paths: { statusAgentSock: "/tmp/yulu-missing-status-agent.sock" } } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    const r = await caller.state();
    expect(r).toEqual({
      state: "unknown",
      hotkey: "?",
      launcherPid: undefined,
      dictationActive: false,
      dictationIntent: undefined,
      voiceChatWindowVisible: false,
      voiceChatWindowUrl: undefined,
    });
  });

  it("toggle() returns state_before/state_after", async () => {
    const published: unknown[] = [];
    fake = await startFakeSocket((req) => {
      expect(req).toEqual({ action: "toggle" });
      return { ok: true, state_before: "idle", state_after: "recording" };
    });
    const ctx = {
      paths: { statusAgentSock: fake.path },
      pubsub: { publish: (_channel: string, payload: unknown) => published.push(payload) },
    } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    const r = await caller.toggle();
    expect(r.stateBefore).toBe("idle");
    expect(r.stateAfter).toBe("recording");
    expect(published).toEqual([{ state: "recording" }]);
  });

  it("toggle() does not publish an unrecognized recording state", async () => {
    const published: unknown[] = [];
    fake = await startFakeSocket(() => ({ ok: false, state_before: "recording", state_after: "unknown" }));
    const ctx = {
      paths: { statusAgentSock: fake.path },
      pubsub: { publish: (_channel: string, payload: unknown) => published.push(payload) },
    } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);

    expect(await caller.toggle()).toEqual({ stateBefore: "recording", stateAfter: "unknown" });
    expect(published).toEqual([]);
  });

  it("dictate() dispatches the dictation IPC action", async () => {
    fake = await startFakeSocket((req) => {
      expect(req).toEqual({ action: "dictate_toggle" });
      return { ok: true, state_before: "idle", state_after: "recording" };
    });
    const ctx = {
      paths: { statusAgentSock: fake.path },
      pubsub: { publish: () => {} },
    } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    const r = await caller.dictate();
    expect(r).toEqual({ stateBefore: "idle", stateAfter: "recording" });
  });

  it("translate() dispatches the translation dictation IPC action", async () => {
    fake = await startFakeSocket((req) => {
      expect(req).toEqual({ action: "dictate_translate", target_language: "Japanese" });
      return { ok: true, state_before: "idle", state_after: "recording" };
    });
    const ctx = {
      paths: { statusAgentSock: fake.path },
      pubsub: { publish: () => {} },
    } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    const r = await caller.translate({ targetLanguage: "Japanese" });
    expect(r).toEqual({ stateBefore: "idle", stateAfter: "recording" });
  });

  it("voiceChat() is the only new UI action that dispatches voice_chat", async () => {
    fake = await startFakeSocket((req) => {
      expect(req).toEqual({ action: "voice_chat" });
      return { ok: true, state_before: "idle", state_after: "recording" };
    });
    const ctx = {
      paths: { statusAgentSock: fake.path },
      pubsub: { publish: () => {} },
    } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    const r = await caller.voiceChat();
    expect(r).toEqual({ stateBefore: "idle", stateAfter: "recording" });
  });

  it("previewSound() dispatches the native feedback preview", async () => {
    fake = await startFakeSocket((req) => {
      expect(req).toEqual({ action: "preview_sound" });
      return { ok: true, enabled: true };
    });
    const ctx = { paths: { statusAgentSock: fake.path } } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    expect(await caller.previewSound()).toEqual({ ok: true, enabled: true });
  });

  it("history() returns dictation history newest first", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "yulu-recording-history-"));
    await mkdir(join(tempDir, "dictation"), { recursive: true });
    await writeFile(
      join(tempDir, "dictation", "history.jsonl"),
      [
        JSON.stringify({ id: "one", created_at: "2026-07-01T10:00:00", action: "dictate", text: "第一条", prompt_slug: "dictation-cleanup" }),
        JSON.stringify({ id: "two", created_at: "2026-07-01T10:01:00", action: "translate", text: "Second", target_language: "English", prompt_slug: "dictation-translate" }),
      ].join("\n"),
      "utf8",
    );
    const ctx = { paths: { configDir: tempDir } } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    const r = await caller.history();
    expect(r.map((item: { id: string }) => item.id)).toEqual(["two", "one"]);
    expect(r[0]).toMatchObject({
      action: "translate",
      text: "Second",
      targetLanguage: "English",
      promptSlug: "dictation-translate",
    });
  });

  it("history() backfills successful dictation stops from the launcher log", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "yulu-recording-history-"));
    await writeFile(
      join(tempDir, "status_agent_launcher.log"),
      [
        '{',
        '  "text": "/tmp/Dictation_20260701_120000.wav",',
        '  "action": "start",',
        '  "audio_path": "/tmp/Dictation_20260701_120000.wav"',
        '}',
        '{',
        '  "text": "hello from log",',
        '  "audio_path": "/tmp/Dictation_20260701_120000.wav",',
        '  "engine": "hermes",',
        '  "language": "zh",',
        '  "prompt_slug": "dictation-cleanup",',
        '  "target_language": "",',
        '  "action": "stop"',
        '}',
      ].join("\n"),
      "utf8",
    );
    const ctx = { paths: { configDir: tempDir } } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    const r = await caller.history();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      action: "dictate",
      text: "hello from log",
      createdAt: "2026-07-01T12:00:00",
    });
  });
});
