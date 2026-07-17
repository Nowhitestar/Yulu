import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveLocalCaptionRuntime,
  SherpaCaptionEngine,
} from "../src/localCaptionEngine.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("local caption runtime discovery", () => {
  it("requires the worker, Python runtime, and complete INT8 model", () => {
    const root = tempRoot("yulu-local-caption-runtime-");
    const scriptDir = join(root, "scripts");
    const configDir = join(root, "config");
    const python = join(configDir, "local-caption/venv/bin/python");
    const modelDir = join(configDir, "models/sherpa-onnx-streaming-paraformer-bilingual-zh-en");
    mkdirSync(join(configDir, "local-caption/venv/bin"), { recursive: true });
    mkdirSync(modelDir, { recursive: true });
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(python, "");
    writeFileSync(join(scriptDir, "sherpa_caption_worker.py"), "");
    writeFileSync(join(modelDir, "tokens.txt"), "tokens");
    writeFileSync(join(modelDir, "encoder.int8.onnx"), "encoder");

    expect(resolveLocalCaptionRuntime({ scriptDir, configDir })).toBeNull();

    writeFileSync(join(modelDir, "decoder.int8.onnx"), "decoder");
    expect(resolveLocalCaptionRuntime({ scriptDir, configDir })).toEqual({
      python,
      workerPath: join(scriptDir, "sherpa_caption_worker.py"),
      modelDir,
    });
  });
});

describe("SherpaCaptionEngine", () => {
  it("keeps one worker alive across warm, feed, finish, and shutdown", async () => {
    const root = tempRoot("yulu-local-caption-ipc-");
    const workerPath = join(root, "fake_worker.py");
    writeFileSync(workerPath, [
      "#!/usr/bin/env python3",
      "import json, sys",
      "for line in sys.stdin:",
      "    req = json.loads(line)",
      "    action = req['action']",
      "    result = {'ready': True} if action == 'ping' else {}",
      "    if action == 'feed':",
      "        result = {'updates': {'mic': {'partial': '实时字幕', 'stable': [], 'audioMs': 640}}}",
      "    if action == 'finish':",
      "        result = {'updates': {'mic': {'partial': '', 'stable': [{'text': '实时字幕', 'endMs': 640}], 'audioMs': 640}}}",
      "    print(json.dumps({'id': req['id'], 'ok': True, 'result': result}), flush=True)",
      "    if action == 'shutdown': break",
      "",
    ].join("\n"));
    chmodSync(workerPath, 0o755);
    const engine = new SherpaCaptionEngine({
      python: "/usr/bin/python3",
      workerPath,
      modelDir: root,
    });

    await engine.warm();
    await engine.start("zh");
    await expect(engine.feed({ mic: Buffer.from([1, 0, 2, 0]) })).resolves.toMatchObject({
      updates: { mic: { partial: "实时字幕", audioMs: 640 } },
    });
    await expect(engine.finish()).resolves.toMatchObject({
      updates: { mic: { partial: "", stable: [{ text: "实时字幕", endMs: 640 }] } },
    });
    await engine.close();
  });

  it("ignores a delayed exit from a previously closed worker", async () => {
    const root = tempRoot("yulu-local-caption-worker-restart-");
    const workerPath = join(root, "fake_worker.py");
    writeFileSync(workerPath, [
      "#!/usr/bin/env python3",
      "import json, signal, sys, time",
      "signal.signal(signal.SIGTERM, lambda *_: None)",
      "for line in sys.stdin:",
      "    req = json.loads(line)",
      "    action = req['action']",
      "    result = {'updates': {}} if action == 'feed' else {'ready': True}",
      "    print(json.dumps({'id': req['id'], 'ok': True, 'result': result}), flush=True)",
      "    if action == 'shutdown':",
      "        time.sleep(0.15)",
      "        break",
      "",
    ].join("\n"));
    chmodSync(workerPath, 0o755);
    const engine = new SherpaCaptionEngine({
      python: "/usr/bin/python3",
      workerPath,
      modelDir: root,
    });

    await engine.warm();
    await engine.close();
    await engine.warm();
    await delay(250);
    await expect(engine.feed({ mic: Buffer.from([1, 0]) })).resolves.toEqual({ updates: {} });
    await engine.close();
  });
});
