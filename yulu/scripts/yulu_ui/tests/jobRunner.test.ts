import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { JobRegistry } from "../src/jobStatus.js";
import { PubSub, type AppChannels } from "../src/pubsub.js";
import { runTranscribe, runSummarize, __setSpawnForTesting } from "../src/jobRunner.js";

function fakeSpawn(exitCode: number, stderr = "", stdout = ""): EventEmitter & {
  stderr: EventEmitter;
  stdout: EventEmitter;
  stdin: { write: (chunk: string | Buffer) => void; end: () => void };
} {
  const ee = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdout: EventEmitter;
    stdin: { write: (chunk: string | Buffer) => void; end: () => void };
  };
  ee.stderr = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.stdin = { write: () => {}, end: () => {} };
  setTimeout(() => {
    if (stdout) ee.stdout.emit("data", Buffer.from(stdout));
    if (stderr) ee.stderr.emit("data", Buffer.from(stderr));
    ee.emit("exit", exitCode);
  }, 5);
  return ee;
}

describe("jobRunner.runTranscribe", () => {
  let root: string;
  let registry: JobRegistry;
  let pubsub: PubSub<AppChannels>;
  let events: AppChannels["jobs"][];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jr_"));
    registry = new JobRegistry();
    pubsub = new PubSub<AppChannels>();
    events = [];
    pubsub.subscribe("jobs", (m) => events.push(m));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); __setSpawnForTesting(undefined); });

  it("sets registry to 'transcribing' immediately and publishes start event", async () => {
    __setSpawnForTesting(() => fakeSpawn(0) as never);
    const wavPath = join(root, "memo_test.wav");
    writeFileSync(wavPath, "");
    const promise = runTranscribe({ stem: "memo_test", wavPath, transcribePy: "/fake", registry, pubsub });
    expect(registry.get("memo_test")?.state).toBe("transcribing");
    expect(events[0]?.state).toBe("transcribing");
    await promise;
  });

  it("clears registry and publishes 'done' on exit code 0", async () => {
    __setSpawnForTesting(() => fakeSpawn(0) as never);
    const wavPath = join(root, "memo_test.wav");
    writeFileSync(wavPath, "");
    await runTranscribe({ stem: "memo_test", wavPath, transcribePy: "/fake", registry, pubsub });
    expect(registry.get("memo_test")).toBeUndefined();
    const last = events[events.length - 1];
    expect(last?.state).toBe("done");
  });

  it("marks registry 'failed' with stderr on non-zero exit", async () => {
    __setSpawnForTesting(() => fakeSpawn(2, "MLX OOM") as never);
    const wavPath = join(root, "memo_test.wav");
    writeFileSync(wavPath, "");
    await runTranscribe({ stem: "memo_test", wavPath, transcribePy: "/fake", registry, pubsub });
    const rec = registry.get("memo_test");
    expect(rec?.state).toBe("failed");
    expect(rec?.error).toContain("MLX OOM");
    const last = events[events.length - 1];
    expect(last?.state).toBe("failed");
    expect(last?.error).toContain("MLX OOM");
  });

  it("returns a jobId string", async () => {
    __setSpawnForTesting(() => fakeSpawn(0) as never);
    const wavPath = join(root, "memo_test.wav");
    writeFileSync(wavPath, "");
    const result = await runTranscribe({ stem: "memo_test", wavPath, transcribePy: "/fake", registry, pubsub });
    expect(typeof result.jobId).toBe("string");
    expect(result.jobId.length).toBeGreaterThan(0);
  });
});

describe("jobRunner.runSummarize (queue mode)", () => {
  let root: string;
  let registry: JobRegistry;
  let pubsub: PubSub<AppChannels>;
  let events: AppChannels["jobs"][];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jrs_"));
    registry = new JobRegistry();
    pubsub = new PubSub<AppChannels>();
    events = [];
    pubsub.subscribe("jobs", (m) => events.push(m));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("appends an entry to agent-queue.json in queue mode", async () => {
    const queuePath = join(root, "agent-queue.json");
    writeFileSync(queuePath, "[]");
    const transcriptPath = join(root, "memo_test.transcript.txt");
    writeFileSync(transcriptPath, "hello world");
    const result = await runSummarize({
      stem: "memo_test", transcriptPath, summaryPath: join(root, "memo_test.summary.md"),
      llmCommand: null, agentQueueJson: queuePath, registry, pubsub,
    });
    expect(result.mode).toBe("queue");
    const queue = JSON.parse(readFileSync(queuePath, "utf8"));
    expect(queue.length).toBe(1);
    expect(queue[0].type).toBe("summary_request");
    expect(queue[0].stem).toBe("memo_test");
  });

  it("returns mode='queue' and sets registry summarizing", async () => {
    const queuePath = join(root, "agent-queue.json");
    writeFileSync(queuePath, "[]");
    const transcriptPath = join(root, "memo_test.transcript.txt");
    writeFileSync(transcriptPath, "hello world");
    const result = await runSummarize({
      stem: "memo_test", transcriptPath, summaryPath: join(root, "memo_test.summary.md"),
      llmCommand: null, agentQueueJson: queuePath, registry, pubsub,
    });
    expect(result.mode).toBe("queue");
    expect(registry.get("memo_test")?.state).toBe("summarizing");
  });
});

describe("jobRunner.runSummarize (direct mode)", () => {
  let root: string;
  let registry: JobRegistry;
  let pubsub: PubSub<AppChannels>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jrs_direct_"));
    registry = new JobRegistry();
    pubsub = new PubSub<AppChannels>();
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); __setSpawnForTesting(undefined); });

  it("resolves bundled codex_llm.py before spawning", async () => {
    const scriptDir = join(root, "scripts");
    mkdirSync(scriptDir);
    writeFileSync(join(scriptDir, "codex_llm.py"), "#!/usr/bin/env python3\n");
    const transcriptPath = join(root, "memo_test.transcript.txt");
    const summaryPath = join(root, "memo_test.summary.md");
    writeFileSync(transcriptPath, "hello world");

    let seen: { cmd: string; args: string[] } | undefined;
    __setSpawnForTesting((cmd, args) => {
      seen = { cmd, args };
      return fakeSpawn(0, "", "summary ok") as never;
    });

    const result = await runSummarize({
      stem: "memo_test",
      transcriptPath,
      summaryPath,
      llmCommand: ["python3", "codex_llm.py"],
      agentQueueJson: join(root, "agent-queue.json"),
      scriptDir,
      registry,
      pubsub,
    });

    expect(result.mode).toBe("direct");
    expect(seen).toEqual({ cmd: "python3", args: [join(scriptDir, "codex_llm.py")] });
    expect(readFileSync(summaryPath, "utf8")).toBe("summary ok");
  });

  it("wraps the transcript in a summary instruction before sending it to the LLM", async () => {
    const transcriptPath = join(root, "memo_test.transcript.txt");
    const summaryPath = join(root, "memo_test.summary.md");
    writeFileSync(transcriptPath, "hello world");

    let stdin = "";
    __setSpawnForTesting(() => {
      const proc = fakeSpawn(0, "", "summary ok");
      proc.stdin.write = (chunk: string | Buffer) => { stdin += chunk.toString(); };
      return proc as never;
    });

    await runSummarize({
      stem: "memo_test",
      transcriptPath,
      summaryPath,
      llmCommand: ["codex"],
      agentQueueJson: join(root, "agent-queue.json"),
      registry,
      pubsub,
    });

    expect(stdin).toContain("请根据下面的会议转录生成中文会议摘要");
    expect(stdin).toContain("会议转录：");
    expect(stdin).toContain("hello world");
  });
});
