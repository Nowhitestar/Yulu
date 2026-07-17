import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  resolveLocalCaptionRuntime,
  SherpaCaptionEngine,
  type CaptionSource,
  type StreamingCaptionEngine,
  type StreamingCaptionUpdate,
} from "./localCaptionEngine.js";

export interface LocalCaptionStatus {
  installed: boolean;
  ready: boolean;
  provider: string;
  model: string;
  runtimeBytes: number;
  modelBytes: number;
  operation: "idle" | "installing" | "uninstalling" | "testing";
  phase: string | null;
  percent: number | null;
  message: string | null;
  error: string | null;
  sessionActive: boolean;
}

const MODEL_NAME = "sherpa-onnx-streaming-paraformer-bilingual-zh-en";

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop()!;
    try {
      for (const name of readdirSync(current)) {
        const item = join(current, name);
        try {
          const stat = statSync(item);
          if (stat.isDirectory()) stack.push(item);
          else if (stat.isFile()) total += stat.size;
        } catch { /* an uninstall may remove a file while status is being read */ }
      }
    } catch { /* an uninstall may remove a directory while status is being read */ }
  }
  return total;
}

function bootstrapPython(): string {
  const configured = process.env.YULU_PYTHON?.trim();
  if (configured && existsSync(configured)) return configured;
  for (const candidate of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "python3";
}

export class LocalCaptionManager implements StreamingCaptionEngine {
  private engine: SherpaCaptionEngine | null = null;
  private active = false;
  private operation: LocalCaptionStatus["operation"] = "idle";
  private phase: string | null = null;
  private percent: number | null = null;
  private message: string | null = null;
  private error: string | null = null;

  constructor(private readonly options: {
    scriptDir: string;
    configDir: string;
    selected: () => boolean;
  }) {}

  get provider(): string {
    return "sherpa-onnx-paraformer-int8";
  }

  status(): LocalCaptionStatus {
    const runtime = resolveLocalCaptionRuntime({
      scriptDir: this.options.scriptDir,
      configDir: this.options.configDir,
    });
    return {
      installed: runtime !== null,
      ready: runtime !== null && this.error === null,
      provider: this.provider,
      model: MODEL_NAME,
      runtimeBytes: directoryBytes(join(this.options.configDir, "local-caption")),
      modelBytes: directoryBytes(join(this.options.configDir, "models", MODEL_NAME)),
      operation: this.operation,
      phase: this.phase,
      percent: this.percent,
      message: this.message,
      error: this.error,
      sessionActive: this.active,
    };
  }

  async install(): Promise<LocalCaptionStatus> {
    if (this.operation !== "idle") throw new Error("本地模型已有操作正在进行");
    this.setOperation("installing", "runtime", "正在准备本地识别运行时");
    try {
      await this.runInstaller("install");
      this.error = null;
      this.message = "本地实时转录模型已安装";
      if (this.options.selected()) await this.warm();
    } catch (error) {
      this.error = (error as Error).message;
      throw error;
    } finally {
      this.operation = "idle";
      this.phase = null;
      this.percent = null;
    }
    return this.status();
  }

  async uninstall(): Promise<LocalCaptionStatus> {
    if (this.active) throw new Error("录音进行中，不能卸载实时转录模型");
    if (this.operation !== "idle") throw new Error("本地模型已有操作正在进行");
    this.setOperation("uninstalling", "cleanup", "正在移除本地模型");
    try {
      await this.engine?.close();
      this.engine = null;
      await this.runInstaller("uninstall");
      this.error = null;
      this.message = "本地模型已移除；重新安装前，本地音频引擎不可用";
    } catch (error) {
      this.error = (error as Error).message;
      throw error;
    } finally {
      this.operation = "idle";
      this.phase = null;
      this.percent = null;
    }
    return this.status();
  }

  async test(): Promise<{ ok: true; provider: string; loadMs: number }> {
    if (this.operation !== "idle") throw new Error("本地模型已有操作正在进行");
    this.setOperation("testing", "warmup", "正在加载并测试本地模型");
    const started = performance.now();
    try {
      await this.ensureEngine().warm();
      const loadMs = Math.round((performance.now() - started) * 100) / 100;
      this.error = null;
      this.message = `本地模型测试通过（${loadMs} ms）`;
      return { ok: true, provider: this.provider, loadMs };
    } catch (error) {
      this.error = (error as Error).message;
      throw error;
    } finally {
      this.operation = "idle";
      this.phase = null;
      this.percent = null;
    }
  }

  async syncSelection(): Promise<void> {
    if (!this.options.selected()) {
      if (!this.active) {
        await this.engine?.close();
        this.engine = null;
      }
      return;
    }
    const runtime = resolveLocalCaptionRuntime({
      scriptDir: this.options.scriptDir,
      configDir: this.options.configDir,
    });
    if (runtime) await this.warm();
  }

  async warm(): Promise<void> {
    if (!this.options.selected()) throw new Error("当前未选择本地音频引擎");
    try {
      await this.ensureEngine().warm();
      this.error = null;
    } catch (error) {
      this.error = (error as Error).message;
      throw error;
    }
  }

  async start(language: "zh" | "en" | "ja" | "auto"): Promise<void> {
    if (!this.options.selected()) throw new Error("当前未选择本地音频引擎");
    if (language === "ja") throw new Error("本地 Paraformer 仅支持中英文；如需日语，请在设置中明确选择 xAI 云端");
    try {
      await this.ensureEngine().start(language);
      this.error = null;
      this.active = true;
    } catch (error) {
      this.error = (error as Error).message;
      throw error;
    }
  }

  async feed(chunks: Partial<Record<CaptionSource, Buffer>>): Promise<StreamingCaptionUpdate> {
    if (!this.active) throw new Error("本地实时转录会话未启动");
    try { return await this.ensureEngine().feed(chunks); }
    catch (error) {
      this.error = (error as Error).message;
      throw error;
    }
  }

  async finish(): Promise<StreamingCaptionUpdate> {
    if (!this.active) return { updates: {} };
    try { return await this.ensureEngine().finish(); }
    catch (error) {
      this.error = (error as Error).message;
      throw error;
    }
    finally {
      this.active = false;
      if (!this.options.selected()) {
        try { await this.engine?.close(); } catch { /* the recording already ended */ }
        this.engine = null;
      }
    }
  }

  async abort(): Promise<void> {
    try { await this.engine?.abort(); }
    finally {
      this.active = false;
      if (!this.options.selected()) {
        try { await this.engine?.close(); } catch { /* preserve the abort result */ }
        this.engine = null;
      }
    }
  }

  async close(): Promise<void> {
    this.active = false;
    await this.engine?.close();
    this.engine = null;
  }

  private ensureEngine(): SherpaCaptionEngine {
    if (this.engine) return this.engine;
    const runtime = resolveLocalCaptionRuntime({
      scriptDir: this.options.scriptDir,
      configDir: this.options.configDir,
    });
    if (!runtime) throw new Error("本地 sherpa-onnx 模型尚未安装");
    this.engine = new SherpaCaptionEngine(runtime);
    return this.engine;
  }

  private setOperation(operation: LocalCaptionStatus["operation"], phase: string, message: string): void {
    this.operation = operation;
    this.phase = phase;
    this.percent = null;
    this.message = message;
    this.error = null;
  }

  private runInstaller(action: "install" | "uninstall"): Promise<void> {
    const script = join(this.options.scriptDir, "local_caption_runtime.py");
    return new Promise((resolve, reject) => {
      const child = spawn(bootstrapPython(), [script, action, "--config-dir", this.options.configDir], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let stderr = "";
      let finalError = "";
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.event === "progress") {
            this.phase = typeof event.phase === "string" ? event.phase : this.phase;
            this.message = typeof event.message === "string" ? event.message : this.message;
            this.percent = typeof event.percent === "number" ? event.percent : null;
          }
          if (event.event === "result" && event.ok === false) finalError = String(event.error ?? "安装失败");
        } catch { /* ignore non-protocol output */ }
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000); });
      child.once("error", reject);
      child.once("exit", (code) => {
        lines.close();
        if (code === 0) resolve();
        else reject(new Error(finalError || stderr.trim() || `本地模型管理进程退出（${code}）`));
      });
    });
  }
}
