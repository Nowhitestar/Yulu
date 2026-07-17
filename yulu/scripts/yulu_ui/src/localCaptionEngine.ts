import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

export type CaptionSource = "mic" | "system";

export interface StableCaptionSegment {
  text: string;
  endMs: number;
}

export interface CaptionSourceUpdate {
  partial: string;
  stable: StableCaptionSegment[];
  audioMs: number;
}

export interface StreamingCaptionUpdate {
  updates: Partial<Record<CaptionSource, CaptionSourceUpdate>>;
}

export interface StreamingCaptionEngine {
  readonly provider: string;
  warm(): Promise<void>;
  start(language: "zh" | "en" | "ja" | "auto"): Promise<void>;
  feed(chunks: Partial<Record<CaptionSource, Buffer>>): Promise<StreamingCaptionUpdate>;
  finish(): Promise<StreamingCaptionUpdate>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface LocalCaptionRuntime {
  python: string;
  workerPath: string;
  modelDir: string;
}

const MODEL_NAME = "sherpa-onnx-streaming-paraformer-bilingual-zh-en";
const REQUIRED_MODEL_FILES = ["tokens.txt", "encoder.int8.onnx", "decoder.int8.onnx"] as const;

function usableRuntime(runtime: LocalCaptionRuntime): boolean {
  return existsSync(runtime.python) && existsSync(runtime.workerPath) &&
    REQUIRED_MODEL_FILES.every((name) => existsSync(join(runtime.modelDir, name)));
}

export function resolveLocalCaptionRuntime(input: {
  scriptDir: string;
  configDir: string;
  env?: NodeJS.ProcessEnv;
}): LocalCaptionRuntime | null {
  const env = input.env ?? process.env;
  const configured = {
    python: env.YULU_LOCAL_CAPTION_PYTHON?.trim() || "",
    modelDir: env.YULU_LOCAL_CAPTION_MODEL_DIR?.trim() || "",
  };
  const runtime: LocalCaptionRuntime = {
    python: configured.python || join(input.configDir, "local-caption", "venv", "bin", "python"),
    workerPath: join(input.scriptDir, "sherpa_caption_worker.py"),
    modelDir: configured.modelDir || join(input.configDir, "models", MODEL_NAME),
  };
  return usableRuntime(runtime) ? runtime : null;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SherpaCaptionEngine implements StreamingCaptionEngine {
  readonly provider = "sherpa-onnx-paraformer-int8";
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadlineInterface | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderr = "";

  constructor(
    private readonly runtime: LocalCaptionRuntime,
    private readonly options: { threads?: number; requestTimeoutMs?: number } = {},
  ) {}

  async warm(): Promise<void> {
    await this.request("ping", {}, 20_000);
  }

  async start(language: "zh" | "en" | "ja" | "auto"): Promise<void> {
    await this.request("start", { language });
  }

  async feed(chunks: Partial<Record<CaptionSource, Buffer>>): Promise<StreamingCaptionUpdate> {
    const encoded = Object.fromEntries(
      Object.entries(chunks)
        .filter((entry): entry is [CaptionSource, Buffer] => Boolean(entry[1]?.length))
        .map(([source, pcm]) => [source, pcm.toString("base64")]),
    );
    if (Object.keys(encoded).length === 0) return { updates: {} };
    return await this.request("feed", { chunks: encoded }) as StreamingCaptionUpdate;
  }

  async finish(): Promise<StreamingCaptionUpdate> {
    return await this.request("finish", {}) as StreamingCaptionUpdate;
  }

  async abort(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try { await this.request("abort", {}, 2_000); }
    catch { this.stopChild(child, new Error("local caption worker aborted")); }
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try { await this.request("shutdown", {}, 2_000); } catch { /* kill below */ }
    this.stopChild(child, new Error("local caption worker closed"));
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const child = spawn(this.runtime.python, [
      this.runtime.workerPath,
      "--model-dir", this.runtime.modelDir,
      "--threads", String(this.options.threads ?? 4),
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    this.child = child;
    this.stderr = "";
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(child, line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4_000);
    });
    child.once("error", (error) => this.stopChild(child, error));
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      this.stopChild(child, new Error(
        `local caption worker exited (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`,
      ));
    });
    return child;
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    let response: WorkerResponse;
    try { response = JSON.parse(line) as WorkerResponse; }
    catch {
      this.stopChild(child, new Error(`local caption worker returned invalid JSON: ${line.slice(0, 200)}`));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.result ?? {});
    else pending.reject(new Error(response.error || "local caption worker request failed"));
  }

  private request(action: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`local caption worker ${action} timed out`));
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 5_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, action, ...payload })}\n`, (error) => {
        if (!error) return;
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(request.timer);
        reject(error);
      });
    });
  }

  private stopChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
