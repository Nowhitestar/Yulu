import Database from "better-sqlite3";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, type RunningServer } from "../src/server.js";
import { startFakeSocket, type FakeSocket } from "../tests/helpers/fakeUnixSocket.js";

const root = mkdtempSync(join(tmpdir(), "yulu-activation-e2e-"));
const configDir = join(root, "config");
const moviesDir = join(root, "Movies", "Yulu");
const scriptDir = join(root, "scripts");
const sourceScripts = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const recordingPath = join(moviesDir, "Core_Activation_20260825_141500.wav");
mkdirSync(configDir, { recursive: true });
mkdirSync(moviesDir, { recursive: true });
mkdirSync(join(scriptDir, "Yulu.app", "Contents", "MacOS"), { recursive: true });

for (const name of ["record_audio.py", "recording_lock.py", "state_store.py", "yulu_platform"]) {
  symlinkSync(join(sourceScripts, name), join(scriptDir, name));
}
const keychainHelper = join(scriptDir, "Yulu.app", "Contents", "MacOS", "xai_keychain");
writeFileSync(keychainHelper, `#!/bin/sh
if [ "$1" = "read" ] && [ "$2" = "direct.xai" ]; then
  printf '%s\\n' '{"version":1,"secret":"activation-e2e-placeholder"}'
  exit 0
fi
exit 44
`);
chmodSync(keychainHelper, 0o700);

writeFileSync(join(configDir, "config.json"), JSON.stringify({
  audio: {
    mic_device: "fixture-mic",
    output_dir: moviesDir,
    silence_threshold: 0.01,
    silence_duration_sec: 300,
    backend: "daemon",
  },
  transcription: { engine: "xai", language: "en" },
  intelligence: {
    summary: { provider: "xai", model: "grok-4.6" },
    conversation: { provider: "xai", model: "grok-4.6" },
  },
  agent_pipeline: {
    enabled: true,
    auto_process_recordings: true,
    auto_send_notion: false,
    notion_destination: "Yulu Meeting",
  },
  ui: { language: "en" },
}));
for (const name of ["prompts.sqlite", "vocab.sqlite", "search.sqlite"]) {
  new Database(join(configDir, name)).close();
}

function fixtureWav(): Buffer {
  const dataBytes = 64_000;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(64_000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let offset = 44; offset < wav.length; offset += 4) wav.writeInt16LE(1_000, offset);
  return wav;
}

let recording = false;
let fakeAudio: FakeSocket | null = null;
let server: RunningServer | null = null;
let closing = false;
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === "https://api.x.ai/v1/stt") {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return new Response(JSON.stringify({ text: "Deterministic activation fixture transcript.", language: "en" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url === "https://api.x.ai/v1/responses") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    await new Promise((resolve) => setTimeout(resolve, 200));
    return new Response(JSON.stringify({
      model: body.model ?? "grok-4.6",
      output: [{ content: [{ type: "output_text", text: "# Activation fixture summary\n\nVerified." }] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return await nativeFetch(input, init);
}) as typeof fetch;

async function shutdown(code: number) {
  if (closing) return;
  closing = true;
  try { await server?.close(); } catch { /* best effort */ }
  try { await fakeAudio?.stop(); } catch { /* best effort */ }
  rmSync(root, { recursive: true, force: true });
  process.exit(code);
}

try {
  fakeAudio = await startFakeSocket((request) => {
    const action = (request as { action?: string }).action;
    if (action === "status") return { recording, micReady: true, micError: "", file: recordingPath };
    if (action === "audio_devices") {
      return { input: [{ uid: "fixture-mic", name: "Deterministic input" }], output: [] };
    }
    if (action === "start") {
      recording = true;
      writeFileSync(recordingPath, fixtureWav());
      return { status: "recording", recording: true, file: recordingPath };
    }
    if (action === "stop") {
      recording = false;
      return { status: "stopped", recording: false, file: recordingPath, duration: 1 };
    }
    return { error: "unsupported fixture action" };
  });
  symlinkSync(fakeAudio.path, join(configDir, "audio_daemon.sock"));
  process.env.YULU_CONFIG_DIR = configDir;
  process.env.YULU_UI_PORT = "7778";
  server = await startServer({
    configDir,
    configFile: join(configDir, "config.json"),
    promptsDb: join(configDir, "prompts.sqlite"),
    vocabDb: join(configDir, "vocab.sqlite"),
    searchDb: join(configDir, "search.sqlite"),
    hostDb: join(configDir, "host.sqlite"),
    agentTasksDir: join(configDir, "agent-tasks"),
    recordingEventsDir: join(configDir, "recording-events"),
    audioDaemonSock: fakeAudio.path,
    moviesDir,
    scriptDir,
    agentQueueJson: join(configDir, "agent-queue.json"),
    mcpTokenJson: join(configDir, "mcp-token.json"),
  });
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  await new Promise<void>(() => {});
} catch (error) {
  console.error(error);
  await shutdown(1);
}
