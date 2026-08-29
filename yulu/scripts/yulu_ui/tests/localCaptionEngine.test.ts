import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const hostilePython = join(root, "hostile-caption-python");
    const runtimePack = join(configDir, "local-caption/YuluLocalCaptionRuntime.bundle");
    const pythonPath = join(runtimePack, "Contents/Resources/site-packages");
    const modelDir = join(configDir, "models/sherpa-onnx-streaming-paraformer-bilingual-zh-en");
    mkdirSync(join(configDir, "local-caption/venv/bin"), { recursive: true });
    mkdirSync(pythonPath, { recursive: true });
    mkdirSync(modelDir, { recursive: true });
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(python, "");
    writeFileSync(hostilePython, "");
    writeFileSync(join(scriptDir, "sherpa_caption_worker.py"), "");
    writeFileSync(join(modelDir, "tokens.txt"), "tokens");
    writeFileSync(join(modelDir, "encoder.int8.onnx"), "encoder");

    const env = {
      YULU_PYTHON: python,
      YULU_LOCAL_CAPTION_PYTHON: hostilePython,
    };
    expect(resolveLocalCaptionRuntime({ scriptDir, configDir, env })).toBeNull();

    writeFileSync(join(modelDir, "decoder.int8.onnx"), "decoder");
    expect(resolveLocalCaptionRuntime({ scriptDir, configDir, env })).toEqual({
      python,
      pythonPath,
      runtimePack,
      workerPath: join(scriptDir, "sherpa_caption_worker.py"),
      modelDir,
    });
  });

  it("prefers standard Models and falls back to the explicit legacy runtime", () => {
    const root = tempRoot("yulu-local-caption-standard-models-");
    const scriptDir = join(root, "scripts");
    const standardDataDir = join(root, "Library/Application Support/Yulu");
    const standardModelsDir = join(standardDataDir, "Models");
    const legacyDataDir = join(root, ".config/yulu");
    const legacyModelsDir = join(legacyDataDir, "models");
    const python = join(root, "python");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "sherpa_caption_worker.py"), "");
    writeFileSync(python, "");

    const makeComplete = (dataDir: string, modelsDir: string) => {
      const runtimePack = join(dataDir, "local-caption/YuluLocalCaptionRuntime.bundle");
      mkdirSync(join(runtimePack, "Contents/Resources/site-packages"), { recursive: true });
      const modelDir = join(modelsDir, "sherpa-onnx-streaming-paraformer-bilingual-zh-en");
      mkdirSync(modelDir, { recursive: true });
      for (const name of ["tokens.txt", "encoder.int8.onnx", "decoder.int8.onnx"]) {
        writeFileSync(join(modelDir, name), name);
      }
      return { runtimePack, modelDir };
    };
    const legacy = makeComplete(legacyDataDir, legacyModelsDir);
    const input = {
      scriptDir,
      configDir: standardDataDir,
      modelsDir: standardModelsDir,
      legacyConfigDir: legacyDataDir,
      legacyModelsDir,
      env: { YULU_PYTHON: python },
    };

    expect(resolveLocalCaptionRuntime(input)).toMatchObject({
      runtimePack: legacy.runtimePack,
      modelDir: legacy.modelDir,
    });

    const standard = makeComplete(standardDataDir, standardModelsDir);
    expect(resolveLocalCaptionRuntime(input)).toMatchObject({
      runtimePack: standard.runtimePack,
      modelDir: standard.modelDir,
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
      pythonPath: root,
      runtimePack: root,
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
      pythonPath: root,
      runtimePack: root,
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

  it("passes only the verified runtime-pack site-packages to bundled Python", async () => {
    const root = tempRoot("yulu-local-caption-python-path-");
    const pythonPath = join(root, "site-packages");
    const workerPath = join(root, "fake_worker.py");
    const sitecustomizeMarker = join(root, "sitecustomize-ran");
    mkdirSync(pythonPath, { recursive: true });
    writeFileSync(join(pythonPath, "pack_probe.py"), "READY = True\n");
    writeFileSync(join(pythonPath, "sitecustomize.py"), [
      "from pathlib import Path",
      `Path(${JSON.stringify(sitecustomizeMarker)}).write_text('unsafe')`,
      "raise RuntimeError('pack code ran before verification')",
      "",
    ].join("\n"));
    writeFileSync(workerPath, [
      "#!/usr/bin/env python3",
      "import json, os, sys",
      "runtime_pack = sys.argv[sys.argv.index('--runtime-pack') + 1]",
      "sys.path.insert(0, os.path.join(runtime_pack, 'site-packages'))",
      "import pack_probe",
      "for line in sys.stdin:",
      "    req = json.loads(line)",
      "    print(json.dumps({'id': req['id'], 'ok': pack_probe.READY, 'result': {'ready': True}}), flush=True)",
      "    if req['action'] == 'shutdown': break",
      "",
    ].join("\n"));
    chmodSync(workerPath, 0o755);
    const engine = new SherpaCaptionEngine({
      python: "/usr/bin/python3",
      pythonPath,
      runtimePack: root,
      workerPath,
      modelDir: root,
    });

    await expect(engine.warm()).resolves.toBeUndefined();
    expect(existsSync(sitecustomizeMarker)).toBe(false);
    await engine.close();
  });
});
