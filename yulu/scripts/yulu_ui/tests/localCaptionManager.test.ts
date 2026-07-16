import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalCaptionManager } from "../src/localCaptionManager.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  strategy: "local-hybrid" | "agent-only" | (() => "local-hybrid" | "agent-only") = "local-hybrid",
) {
  const root = mkdtempSync(join(tmpdir(), "yulu-caption-manager-"));
  roots.push(root);
  const scriptDir = join(root, "scripts");
  const configDir = join(root, "config");
  const modelDir = join(configDir, "models/sherpa-onnx-streaming-paraformer-bilingual-zh-en");
  const binDir = join(configDir, "local-caption/venv/bin");
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(modelDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const python = existsSync("/opt/homebrew/bin/python3")
    ? "/opt/homebrew/bin/python3"
    : execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
  symlinkSync(python, join(binDir, "python"));
  for (const name of ["tokens.txt", "encoder.int8.onnx", "decoder.int8.onnx"]) {
    writeFileSync(join(modelDir, name), name);
  }
  const workerPath = join(scriptDir, "sherpa_caption_worker.py");
  writeFileSync(workerPath, [
    "#!/usr/bin/env python3",
    "import json, sys",
    "for line in sys.stdin:",
    "  req=json.loads(line); action=req['action']",
    "  result={'ready': True} if action == 'ping' else ({'updates': {}} if action in ('finish','feed') else {})",
    "  print(json.dumps({'id': req['id'], 'ok': True, 'result': result}), flush=True)",
    "  if action == 'shutdown': break",
  ].join("\n"));
  chmodSync(workerPath, 0o755);
  return new LocalCaptionManager({
    scriptDir,
    configDir,
    strategy: typeof strategy === "function" ? strategy : () => strategy,
  });
}

describe("LocalCaptionManager", () => {
  it("reports a complete runtime and runs a warm self-test", async () => {
    const manager = fixture();
    expect(manager.status()).toMatchObject({
      installed: true,
      ready: true,
      strategy: "local-hybrid",
      operation: "idle",
    });

    await expect(manager.test()).resolves.toMatchObject({ ok: true, provider: "sherpa-onnx-paraformer-int8" });
    expect(manager.status().message).toMatch(/测试通过/);
    await manager.close();
  });

  it("keeps the compatibility strategy from starting the local model", async () => {
    const manager = fixture("agent-only");
    await expect(manager.start("zh")).rejects.toThrow("未启用");
    await expect(manager.test()).resolves.toMatchObject({ ok: true });
    expect(manager.status().sessionActive).toBe(false);
    await manager.close();
  });

  it("falls back instead of using the Mandarin-English model for Japanese", async () => {
    const manager = fixture();
    await expect(manager.start("ja")).rejects.toThrow("仅支持中英文");
    expect(manager.status().sessionActive).toBe(false);
    await manager.close();
  });

  it("can install while compatibility mode is selected without treating disabled warmup as a failure", async () => {
    const manager = fixture("agent-only");
    vi.spyOn(
      manager as unknown as { runInstaller(action: "install" | "uninstall"): Promise<void> },
      "runInstaller",
    ).mockResolvedValue();

    await expect(manager.install()).resolves.toMatchObject({
      installed: true,
      strategy: "agent-only",
      operation: "idle",
    });
    await manager.close();
  });

  it("releases the resident worker when compatibility mode is selected while idle", async () => {
    let strategy: "local-hybrid" | "agent-only" = "local-hybrid";
    const manager = fixture(() => strategy);
    await manager.test();
    expect((manager as unknown as { engine: unknown }).engine).not.toBeNull();

    strategy = "agent-only";
    await manager.syncStrategy();

    expect((manager as unknown as { engine: unknown }).engine).toBeNull();
    await manager.close();
  });

  it("reports a worker warmup failure instead of claiming the model is ready", async () => {
    const manager = fixture();
    const slot = manager as unknown as { engine: { warm(): Promise<void>; close(): Promise<void> } | null };
    slot.engine = {
      warm: vi.fn().mockRejectedValue(new Error("model load failed")),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await expect(manager.warm()).rejects.toThrow("model load failed");
    expect(manager.status()).toMatchObject({ ready: false, error: "model load failed" });
    await manager.close();
  });
});
