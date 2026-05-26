# Yulu UI · Phase A — Backend Daemon Shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `yulu_ui` Node LaunchAgent with all 11 tRPC routers + WebSocket multiplexer responding correctly to `curl` and integration tests. No React frontend yet — Phase B handles UI.

**Architecture:** New `yulu/scripts/yulu_ui/` Node 20+ TypeScript project. Hono HTTP server hosts tRPC v11 routers + a single `/ws` WebSocket endpoint that multiplexes channels (recording, daemons, logs, sidebar-counts). better-sqlite3 reads the three existing SQLite databases (prompts/vocab/search). `net.createConnection({path})` + `socket.end()` (SHUT_WR) talks to existing Unix sockets (audio_daemon, stt_daemon, status_agent). Mutates `config.json` with diff-based "needs restart" detection per spec §11. Spawned via new `com.yulu.ui` LaunchAgent on 127.0.0.1:7777.

**Tech Stack:** Node 20 LTS · TypeScript 5 · Hono 4 · @trpc/server 11 · zod 3 · better-sqlite3 11 · ws 8 · esbuild (single-file bundle) · vitest

**Spec reference:** `docs/superpowers/specs/2026-05-26-yulu-frontend-design.md` (§4 Architecture, §10 tRPC routers, §11 Config diff→restart map, §12.1 LaunchAgent, §13 acceptance #1)

**Out of scope (deferred to Phases B–G):** React frontend, theme system, sidebar/topbar UI, recording pill, page-level designs, install integration, doctor entry, release packaging.

**Path conventions:** Everything in this plan is rooted at the repo root. Paths like `yulu/scripts/yulu_ui/src/server.ts` are relative to the repo. Test paths like `yulu/scripts/yulu_ui/tests/...` likewise.

---

## File Structure

```
yulu/scripts/yulu_ui/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── esbuild.config.mjs
├── src/
│   ├── server.ts             # entry: Hono mount, tRPC adapter, /ws, /healthz
│   ├── trpc.ts               # tRPC init, AppContext, AppRouter export
│   ├── config.ts             # ConfigManager: read/write config.json + diff + restart map
│   ├── db.ts                 # SQLite connection factory (prompts/vocab/search)
│   ├── ipc.ts                # Unix socket SHUT_WR client
│   ├── launchctl.ts          # launchctl restart/stop/start/status wrapper
│   ├── ws.ts                 # WebSocket multiplexer (channels)
│   ├── pubsub.ts             # in-process event bus (recording/daemons/sidebar)
│   ├── paths.ts              # ~/.config/yulu, ~/Movies/Yulu canonical paths
│   └── routers/
│       ├── _app.ts           # mergeRouters({voicemails, meetings, ...})
│       ├── voicemails.ts
│       ├── meetings.ts
│       ├── search.ts
│       ├── config.ts
│       ├── prompts.ts
│       ├── glossary.ts
│       ├── daemons.ts
│       ├── logs.ts
│       ├── recording.ts
│       ├── sidebar.ts
│       └── system.ts
└── tests/
    ├── fixtures/             # sample config.json, sqlite, fake unix socket
    │   ├── config.json
    │   └── prompts.sqlite    # built by setup helper
    ├── helpers/
    │   ├── fakeUnixSocket.ts
    │   └── tmpDb.ts
    ├── config.test.ts
    ├── ipc.test.ts
    ├── db.test.ts
    ├── routers/
    │   ├── voicemails.test.ts
    │   ├── meetings.test.ts
    │   ├── search.test.ts
    │   ├── config.test.ts
    │   ├── prompts.test.ts
    │   ├── glossary.test.ts
    │   ├── daemons.test.ts
    │   ├── logs.test.ts
    │   ├── recording.test.ts
    │   ├── sidebar.test.ts
    │   └── system.test.ts
    └── ws.test.ts

yulu/scripts/com.yulu.ui.plist        # launchd template (placeholders for paths)
```

**Why these splits:** Each router file owns one domain (voicemails/config/...). Cross-cutting helpers (`ipc`, `db`, `config`, `launchctl`) are pure utilities. `pubsub` is the in-process event bus that decouples routers from the WebSocket layer. Tests live alongside in `tests/`, mirroring `src/`.

---

## Task A.1 — Project scaffolding

**Files:**
- Create: `yulu/scripts/yulu_ui/package.json`
- Create: `yulu/scripts/yulu_ui/tsconfig.json`
- Create: `yulu/scripts/yulu_ui/vitest.config.ts`
- Create: `yulu/scripts/yulu_ui/.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "yulu-ui",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "node esbuild.config.mjs",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@trpc/server": "^11.0.0",
    "better-sqlite3": "^11.5.0",
    "hono": "^4.6.0",
    "ws": "^8.18.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.13",
    "esbuild": "^0.24.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "rootDir": ".",
    "baseUrl": ".",
    "outDir": "dist"
  },
  "include": ["src/**/*", "tests/**/*", "esbuild.config.mjs"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 5_000,
    pool: "forks",         // better-sqlite3 + worker isolation
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 5: Install deps**

```bash
cd yulu/scripts/yulu_ui
npm install
```

Expected: completes without error. `node_modules/` exists.

- [ ] **Step 6: Verify typecheck passes on empty project**

```bash
cd yulu/scripts/yulu_ui
npm run typecheck
```

Expected: PASS (no files to check yet, but tsc validates config).

- [ ] **Step 7: Commit**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add yulu/scripts/yulu_ui/package.json yulu/scripts/yulu_ui/tsconfig.json \
        yulu/scripts/yulu_ui/vitest.config.ts yulu/scripts/yulu_ui/.gitignore
git commit -m "chore(yulu_ui): scaffold node + ts project"
```

---

## Task A.2 — Canonical paths

**Files:**
- Create: `yulu/scripts/yulu_ui/src/paths.ts`
- Create: `yulu/scripts/yulu_ui/tests/paths.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/paths.test.ts
import { describe, it, expect } from "vitest";
import { paths } from "../src/paths.js";
import { homedir } from "node:os";

describe("paths", () => {
  it("anchors all paths under ~/.config/yulu", () => {
    const home = homedir();
    expect(paths.configDir).toBe(`${home}/.config/yulu`);
    expect(paths.configFile).toBe(`${home}/.config/yulu/config.json`);
    expect(paths.promptsDb).toBe(`${home}/.config/yulu/prompts.sqlite`);
    expect(paths.vocabDb).toBe(`${home}/.config/yulu/vocab.sqlite`);
    expect(paths.searchDb).toBe(`${home}/.config/yulu/search.sqlite`);
    expect(paths.audioDaemonSock).toBe(`${home}/.config/yulu/audio_daemon.sock`);
    expect(paths.sttDaemonSock).toBe(`${home}/.config/yulu/stt_daemon.sock`);
    expect(paths.statusAgentSock).toBe(`${home}/.config/yulu/status_agent.sock`);
    expect(paths.moviesDir).toBe(`${home}/Movies/Yulu`);
    expect(paths.voicemailsDir).toBe(`${home}/Movies/Yulu/voicemails`);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
cd yulu/scripts/yulu_ui
npm test -- paths.test.ts
```

Expected: FAIL ("Cannot find module '../src/paths.js'").

- [ ] **Step 3: Implement**

```ts
// src/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CONFIG_DIR = join(HOME, ".config", "yulu");
const MOVIES_DIR = join(HOME, "Movies", "Yulu");

export const paths = {
  configDir:        CONFIG_DIR,
  configFile:       join(CONFIG_DIR, "config.json"),
  promptsDb:        join(CONFIG_DIR, "prompts.sqlite"),
  vocabDb:          join(CONFIG_DIR, "vocab.sqlite"),
  searchDb:         join(CONFIG_DIR, "search.sqlite"),
  audioDaemonSock:  join(CONFIG_DIR, "audio_daemon.sock"),
  sttDaemonSock:    join(CONFIG_DIR, "stt_daemon.sock"),
  statusAgentSock:  join(CONFIG_DIR, "status_agent.sock"),
  uiLog:            join(CONFIG_DIR, "ui.log"),
  uiPid:            join(CONFIG_DIR, "yulu_ui.pid"),
  moviesDir:        MOVIES_DIR,
  voicemailsDir:    join(MOVIES_DIR, "voicemails"),
} as const;
```

- [ ] **Step 4: Re-run, verify PASS**

```bash
npm test -- paths.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/paths.ts yulu/scripts/yulu_ui/tests/paths.test.ts
git commit -m "feat(yulu_ui): canonical paths module"
```

---

## Task A.3 — Unix socket SHUT_WR client

**Files:**
- Create: `yulu/scripts/yulu_ui/src/ipc.ts`
- Create: `yulu/scripts/yulu_ui/tests/helpers/fakeUnixSocket.ts`
- Create: `yulu/scripts/yulu_ui/tests/ipc.test.ts`

- [ ] **Step 1: Write fake-socket helper**

```ts
// tests/helpers/fakeUnixSocket.ts
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface FakeSocket {
  path: string;
  server: Server;
  stop: () => Promise<void>;
}

/**
 * Start a one-shot AF_UNIX echo server that:
 *   - reads everything until client SHUT_WR (server's read returns 0 = EOF)
 *   - parses request as JSON, runs handler(req) -> reply
 *   - writes reply JSON + closes
 *
 * Returns the socket path (always /tmp/yulu_test_<uuid>.sock to dodge
 * macOS's 104-byte AF_UNIX limit — pytest tmp_path is too long).
 */
export function startFakeSocket(
  handler: (req: unknown) => unknown
): Promise<FakeSocket> {
  return new Promise((resolve) => {
    const tmp = mkdtempSync(join(tmpdir(), "yulu_test_"));
    const path = join(tmp, "sock");
    const server = createServer((conn) => {
      const chunks: Buffer[] = [];
      conn.on("data", (b) => chunks.push(b));
      conn.on("end", () => {              // client SHUT_WR -> 'end'
        let req: unknown;
        try { req = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { conn.end('{"error":"bad json"}\n'); return; }
        const reply = handler(req);
        conn.end(JSON.stringify(reply) + "\n");
      });
    });
    server.listen(path, () => {
      resolve({
        path,
        server,
        stop: () => new Promise<void>((res) => {
          server.close(() => { rmSync(tmp, { recursive: true, force: true }); res(); });
        }),
      });
    });
  });
}
```

- [ ] **Step 2: Write failing test**

```ts
// tests/ipc.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { ipcSend } from "../src/ipc.js";
import { startFakeSocket, type FakeSocket } from "./helpers/fakeUnixSocket.js";

describe("ipcSend (SHUT_WR framing)", () => {
  let fake: FakeSocket | undefined;
  afterEach(async () => { if (fake) { await fake.stop(); fake = undefined; } });

  it("writes JSON, half-closes, parses reply", async () => {
    fake = await startFakeSocket((req) => ({ ok: true, echo: req }));
    const reply = await ipcSend(fake.path, { action: "status" });
    expect(reply).toEqual({ ok: true, echo: { action: "status" } });
  });

  it("rejects on socket missing", async () => {
    await expect(ipcSend("/tmp/nonexistent.sock", { action: "x" }))
      .rejects.toThrow(/ENOENT|ECONNREFUSED/);
  });

  it("times out after ipcTimeoutMs", async () => {
    fake = await startFakeSocket(async () => {
      await new Promise((r) => setTimeout(r, 5_000));
      return { never: true };
    });
    await expect(ipcSend(fake.path, { action: "x" }, { timeoutMs: 200 }))
      .rejects.toThrow(/timed out/i);
  });
});
```

- [ ] **Step 3: Run, verify FAIL**

```bash
npm test -- ipc.test.ts
```

Expected: FAIL (no `ipcSend`).

- [ ] **Step 4: Implement**

```ts
// src/ipc.ts
import { createConnection } from "node:net";

export interface IpcOptions { timeoutMs?: number; }

export async function ipcSend<T = unknown>(
  socketPath: string,
  payload: unknown,
  opts: IpcOptions = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 3_000;
  return new Promise<T>((resolve, reject) => {
    const sock = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err: Error | null, result?: T) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      err ? reject(err) : resolve(result as T);
    };
    const timer = setTimeout(() => finish(new Error(`ipcSend timed out after ${timeoutMs}ms (${socketPath})`)), timeoutMs);

    sock.once("connect", () => {
      sock.write(JSON.stringify(payload));
      sock.end();                         // SHUT_WR
    });
    sock.on("data", (b) => chunks.push(b));
    sock.once("end", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return finish(new Error(`ipcSend empty reply from ${socketPath}`));
      try { finish(null, JSON.parse(text) as T); }
      catch (e) { finish(new Error(`ipcSend malformed reply: ${text.slice(0, 80)}`)); }
    });
    sock.once("error", (e) => { clearTimeout(timer); finish(e); });
  });
}
```

- [ ] **Step 5: Re-run, verify PASS**

```bash
npm test -- ipc.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/src/ipc.ts yulu/scripts/yulu_ui/tests/ipc.test.ts \
        yulu/scripts/yulu_ui/tests/helpers/fakeUnixSocket.ts
git commit -m "feat(yulu_ui): ipcSend SHUT_WR client for unix sockets"
```

---

## Task A.4 — SQLite connection factory

**Files:**
- Create: `yulu/scripts/yulu_ui/src/db.ts`
- Create: `yulu/scripts/yulu_ui/tests/helpers/tmpDb.ts`
- Create: `yulu/scripts/yulu_ui/tests/db.test.ts`

- [ ] **Step 1: Write tmp-db helper**

```ts
// tests/helpers/tmpDb.ts
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function makeTmpDb(schema: string): { path: string; db: Database.Database } {
  const dir = mkdtempSync(join(tmpdir(), "yulu_db_"));
  const path = join(dir, "test.sqlite");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(schema);
  return { path, db };
}
```

- [ ] **Step 2: Write failing test**

```ts
// tests/db.test.ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { makeTmpDb } from "./helpers/tmpDb.js";

describe("openDb", () => {
  it("opens an existing sqlite in WAL mode", () => {
    const { path, db } = makeTmpDb("CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (42);");
    db.close();
    const conn = openDb(path);
    const row = conn.prepare("SELECT id FROM t LIMIT 1").get() as { id: number };
    expect(row.id).toBe(42);
    const journal = conn.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journal.journal_mode).toBe("wal");
    conn.close();
  });

  it("throws SQLITE_CANTOPEN when path missing", () => {
    expect(() => openDb("/tmp/does-not-exist.sqlite")).toThrow();
  });
});
```

- [ ] **Step 3: Run, verify FAIL**

```bash
npm test -- db.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement**

```ts
// src/db.ts
import Database, { type Database as DbType } from "better-sqlite3";

/**
 * Open an existing SQLite DB read-write in WAL mode.
 * Throws if the file doesn't exist (we never create DBs from the UI —
 * setup.sh + Python writers own DB creation).
 */
export function openDb(path: string): DbType {
  const db = new Database(path, { fileMustExist: true });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
```

- [ ] **Step 5: Re-run, verify PASS**

```bash
npm test -- db.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/src/db.ts yulu/scripts/yulu_ui/tests/db.test.ts \
        yulu/scripts/yulu_ui/tests/helpers/tmpDb.ts
git commit -m "feat(yulu_ui): openDb factory (WAL, read-write)"
```

---

## Task A.5 — ConfigManager: read + diff + restart map

**Files:**
- Create: `yulu/scripts/yulu_ui/src/config.ts`
- Create: `yulu/scripts/yulu_ui/tests/fixtures/config.json`
- Create: `yulu/scripts/yulu_ui/tests/config.test.ts`

- [ ] **Step 1: Create fixture**

```json
// tests/fixtures/config.json
{
  "audio": {
    "mic_device": ":0",
    "system_audio_device": ":1",
    "output_dir": "/Users/test/Movies/Yulu",
    "silence_threshold": 0.01,
    "silence_duration_sec": 300,
    "backend": "daemon"
  },
  "transcription": {
    "final_engine": "mlx",
    "language": "zh",
    "glossary": ["AgentKey", "OpenClaw"]
  },
  "llm": {
    "enabled": true,
    "command": ["claude", "--print"]
  },
  "status_agent": {
    "enabled": true,
    "hotkey": { "key": "V", "modifiers": ["cmd", "shift"] }
  },
  "calendars": []
}
```

- [ ] **Step 2: Write failing test**

```ts
// tests/config.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { ConfigManager } from "../src/config.js";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SRC = join(__dirname, "fixtures/config.json");

function makeCfg(): { path: string; mgr: ConfigManager; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "yulu_cfg_"));
  const path = join(dir, "config.json");
  cpSync(SRC, path);
  const mgr = new ConfigManager(path);
  return { path, mgr, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("ConfigManager", () => {
  it("reads + caches by mtime", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      const cfg = mgr.read();
      expect(cfg.audio.silence_threshold).toBe(0.01);
      // second read returns cached object
      expect(mgr.read()).toBe(cfg);
    } finally { cleanup(); }
  });

  it("update() writes + returns diff with restart targets", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      const result = mgr.update("audio.silence_threshold", 0.02);
      expect(result.daemonsNeedingRestart).toContain("audiodaemon");
      expect(result.daemonsNeedingSighup).toEqual([]);
      const cfg = mgr.read();
      expect(cfg.audio.silence_threshold).toBe(0.02);
    } finally { cleanup(); }
  });

  it("classifies SIGHUP-only changes (hotkey, glossary, llm.command)", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      const r1 = mgr.update("status_agent.hotkey", { key: "F19", modifiers: ["alt"] });
      expect(r1.daemonsNeedingSighup).toEqual(["statusagent"]);
      expect(r1.daemonsNeedingRestart).toEqual([]);

      const r2 = mgr.update("transcription.glossary", ["NewTerm"]);
      expect(r2.daemonsNeedingSighup).toEqual(["sttdaemon"]);

      const r3 = mgr.update("llm.command", ["codex"]);
      expect(r3.daemonsNeedingSighup).toEqual(["agentqueue"]);
    } finally { cleanup(); }
  });

  it("rejects updates when on-disk mtime advanced (external write)", () => {
    const { path, mgr, cleanup } = makeCfg();
    try {
      mgr.read();
      // simulate external write — touch the file mtime forward
      const { utimesSync, statSync } = require("node:fs");
      const future = new Date(statSync(path).mtimeMs + 2_000);
      utimesSync(path, future, future);
      expect(() => mgr.update("audio.silence_threshold", 0.05))
        .toThrow(/changed externally/);
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 3: Run, verify FAIL**

```bash
npm test -- config.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement**

```ts
// src/config.ts
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { z } from "zod";

const HotkeySchema = z.object({
  key: z.string(),
  modifiers: z.array(z.enum(["cmd", "shift", "alt", "ctrl"])),
});
const CalendarSchema = z.object({
  type: z.string(),
  enabled: z.boolean().optional(),
}).passthrough();

export const ConfigSchema = z.object({
  audio: z.object({
    mic_device: z.string().optional(),
    system_audio_device: z.string().nullable().optional(),
    output_dir: z.string(),
    silence_threshold: z.number(),
    silence_duration_sec: z.number(),
    backend: z.string().optional(),
  }),
  transcription: z.object({
    final_engine: z.enum(["mlx", "whisper-cli"]).optional(),
    language: z.string().optional(),
    glossary: z.array(z.string()).optional(),
    local_model_path: z.string().optional(),
    mlx: z.record(z.unknown()).optional(),
    command: z.array(z.string()).optional(),
  }).passthrough(),
  llm: z.object({
    enabled: z.boolean().optional(),
    command: z.array(z.string()).optional(),
  }).passthrough().optional(),
  status_agent: z.object({
    enabled: z.boolean(),
    hotkey: HotkeySchema,
  }).optional(),
  calendars: z.array(CalendarSchema).optional(),
}).passthrough();

export type YuluConfig = z.infer<typeof ConfigSchema>;

/**
 * Spec §11 — config key → daemon impact.
 * "restart" means launchctl unload+load; "sighup" means kill -HUP <pid>.
 * Anything not listed has no daemon impact.
 */
const RESTART_MAP: Record<string, "restart" | "sighup"> = {
  "audio.mic_device":                "restart:audiodaemon",
  "audio.system_audio_device":       "restart:audiodaemon",
  "audio.silence_threshold":         "restart:audiodaemon",
  "audio.silence_duration_sec":      "restart:audiodaemon",
  "audio.backend":                   "restart:audiodaemon",
  "audio.output_dir":                "none",
  "transcription.final_engine":      "restart:sttdaemon",
  "transcription.language":          "sighup:sttdaemon",
  "transcription.glossary":          "sighup:sttdaemon",
  "transcription.command":           "restart:sttdaemon",
  "transcription.local_model_path":  "restart:sttdaemon",
  "transcription.mlx":               "restart:sttdaemon",
  "llm.enabled":                     "sighup:agentqueue",
  "llm.command":                     "sighup:agentqueue",
  "calendars":                       "restart:calendar,scheduler",
  "status_agent.enabled":            "restart:statusagent",
  "status_agent.hotkey":             "sighup:statusagent",
} as unknown as Record<string, "restart" | "sighup">;

export interface UpdateResult {
  daemonsNeedingRestart: string[];
  daemonsNeedingSighup: string[];
}

export class ConfigManager {
  private cached: YuluConfig | null = null;
  private cachedMtime = 0;

  constructor(private readonly path: string) {}

  read(): YuluConfig {
    const mtime = statSync(this.path).mtimeMs;
    if (this.cached && this.cachedMtime === mtime) return this.cached;
    const raw = JSON.parse(readFileSync(this.path, "utf8"));
    this.cached = ConfigSchema.parse(raw);
    this.cachedMtime = mtime;
    return this.cached;
  }

  /**
   * Mutate one dotted key (e.g. "audio.silence_threshold"). Writes the
   * file atomically and returns which daemons need restart/sighup per
   * the spec §11 map. Throws if the file's mtime advanced since the
   * last read (someone else wrote to it).
   */
  update(dottedKey: string, value: unknown): UpdateResult {
    const onDiskMtime = statSync(this.path).mtimeMs;
    if (this.cached && onDiskMtime !== this.cachedMtime) {
      throw new Error(`Config file changed externally — reload before writing (${this.path})`);
    }
    const cfg = JSON.parse(readFileSync(this.path, "utf8"));
    setByDottedKey(cfg, dottedKey, value);
    ConfigSchema.parse(cfg);  // validate before write
    writeFileSync(this.path, JSON.stringify(cfg, null, 2) + "\n");
    this.cached = null;       // invalidate; next read() re-parses
    return classify(dottedKey);
  }
}

function setByDottedKey(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (cursor[p] === undefined || typeof cursor[p] !== "object" || cursor[p] === null) {
      cursor[p] = {};
    }
    cursor = cursor[p] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function classify(dottedKey: string): UpdateResult {
  // Find the longest matching prefix in RESTART_MAP.
  let best: string | null = null;
  for (const k of Object.keys(RESTART_MAP)) {
    if (dottedKey === k || dottedKey.startsWith(k + ".")) {
      if (!best || k.length > best.length) best = k;
    }
  }
  if (!best) return { daemonsNeedingRestart: [], daemonsNeedingSighup: [] };
  const tag = RESTART_MAP[best];
  if (tag === undefined || tag === ("none" as unknown as never)) {
    return { daemonsNeedingRestart: [], daemonsNeedingSighup: [] };
  }
  // tag looks like "restart:foo,bar" or "sighup:foo"
  const [kind, names] = (tag as unknown as string).split(":");
  const daemons = names!.split(",");
  return {
    daemonsNeedingRestart: kind === "restart" ? daemons : [],
    daemonsNeedingSighup:  kind === "sighup"  ? daemons : [],
  };
}
```

- [ ] **Step 5: Re-run, verify PASS**

```bash
npm test -- config.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/src/config.ts yulu/scripts/yulu_ui/tests/config.test.ts \
        yulu/scripts/yulu_ui/tests/fixtures/config.json
git commit -m "feat(yulu_ui): ConfigManager with diff→daemon restart classification"
```

---

## Task A.6 — launchctl wrapper

**Files:**
- Create: `yulu/scripts/yulu_ui/src/launchctl.ts`
- Create: `yulu/scripts/yulu_ui/tests/launchctl.test.ts`

- [ ] **Step 1: Write failing test (mock execFile)**

```ts
// tests/launchctl.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LaunchctlClient } from "../src/launchctl.js";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

beforeEach(() => execFileMock.mockReset());

function ok(stdout = "") {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, { stdout, stderr: "" }));
}
function fail(code: number, stderr: string) {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    const err = new Error("exit " + code) as Error & { code: number; stderr: string };
    err.code = code; err.stderr = stderr;
    cb(err, { stdout: "", stderr });
  });
}

describe("LaunchctlClient", () => {
  it("restart() runs unload then load", async () => {
    ok();
    const c = new LaunchctlClient("/Users/x/Library/LaunchAgents");
    await c.restart("com.yulu.audiodaemon");
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0]![1]).toEqual(["unload", "/Users/x/Library/LaunchAgents/com.yulu.audiodaemon.plist"]);
    expect(execFileMock.mock.calls[1]![1]).toEqual(["load", "/Users/x/Library/LaunchAgents/com.yulu.audiodaemon.plist"]);
  });

  it("status() parses 'pid 0 label' format", async () => {
    ok("12345\t0\tcom.yulu.audiodaemon\n");
    const c = new LaunchctlClient("/Users/x/Library/LaunchAgents");
    const s = await c.status("com.yulu.audiodaemon");
    expect(s).toEqual({ pid: 12345, exitStatus: 0, label: "com.yulu.audiodaemon" });
  });

  it("status() returns null when not loaded", async () => {
    fail(3, "Could not find service");
    const c = new LaunchctlClient("/Users/x/Library/LaunchAgents");
    expect(await c.status("com.yulu.missing")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- launchctl.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/launchctl.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execFile) as (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>;

export interface DaemonStatus {
  pid: number;
  exitStatus: number;
  label: string;
}

export class LaunchctlClient {
  constructor(private readonly launchAgentsDir: string) {}

  private plist(label: string): string {
    return join(this.launchAgentsDir, label + ".plist");
  }

  async restart(label: string): Promise<void> {
    await exec("launchctl", ["unload", this.plist(label)]).catch(() => undefined);
    await exec("launchctl", ["load", this.plist(label)]);
  }

  async stop(label: string): Promise<void> {
    await exec("launchctl", ["unload", this.plist(label)]);
  }

  async start(label: string): Promise<void> {
    await exec("launchctl", ["load", this.plist(label)]);
  }

  /**
   * Parse `launchctl list <label>` output (single line: PID\tEXIT\tLABEL).
   * Returns null when service is not loaded.
   */
  async status(label: string): Promise<DaemonStatus | null> {
    try {
      const { stdout } = await exec("launchctl", ["list", label]);
      const line = stdout.trim().split("\n")[0] ?? "";
      const [pidStr, exitStr, lbl] = line.split("\t");
      if (!pidStr || !exitStr || !lbl) return null;
      return { pid: Number(pidStr) || 0, exitStatus: Number(exitStr) || 0, label: lbl };
    } catch {
      return null;
    }
  }

  async sighup(label: string): Promise<void> {
    const s = await this.status(label);
    if (!s || s.pid === 0) throw new Error(`Cannot sighup — ${label} not running`);
    process.kill(s.pid, "SIGHUP");
  }
}
```

- [ ] **Step 4: Re-run, verify PASS**

```bash
npm test -- launchctl.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/launchctl.ts yulu/scripts/yulu_ui/tests/launchctl.test.ts
git commit -m "feat(yulu_ui): LaunchctlClient (restart/stop/start/status/sighup)"
```

---

## Task A.7 — In-process pub/sub

**Files:**
- Create: `yulu/scripts/yulu_ui/src/pubsub.ts`
- Create: `yulu/scripts/yulu_ui/tests/pubsub.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/pubsub.test.ts
import { describe, it, expect } from "vitest";
import { PubSub } from "../src/pubsub.js";

describe("PubSub", () => {
  it("publishes to subscribers of the same channel only", () => {
    const ps = new PubSub<{ recording: { state: string }; daemons: { name: string } }>();
    const recv: string[] = [];
    const unsub = ps.subscribe("recording", (msg) => recv.push(msg.state));
    ps.publish("recording", { state: "recording" });
    ps.publish("daemons", { name: "audiodaemon" });
    expect(recv).toEqual(["recording"]);
    unsub();
    ps.publish("recording", { state: "idle" });
    expect(recv).toEqual(["recording"]);
  });

  it("unsubscribe is idempotent + safe to call twice", () => {
    const ps = new PubSub<{ x: number }>();
    const unsub = ps.subscribe("x", () => {});
    unsub(); unsub();
    expect(ps.subscriberCount("x")).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- pubsub.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/pubsub.ts
export type Listener<T> = (msg: T) => void;

/**
 * Tiny typed pub/sub for cross-cutting events (recording state, daemon
 * status changes, sidebar count invalidation). Routers publish; the
 * WebSocket multiplexer subscribes.
 */
export class PubSub<Channels extends Record<string, unknown>> {
  private subs = new Map<string, Set<Listener<unknown>>>();

  subscribe<K extends keyof Channels & string>(
    channel: K,
    fn: Listener<Channels[K]>
  ): () => void {
    let set = this.subs.get(channel);
    if (!set) { set = new Set(); this.subs.set(channel, set); }
    set.add(fn as Listener<unknown>);
    return () => { set!.delete(fn as Listener<unknown>); };
  }

  publish<K extends keyof Channels & string>(channel: K, msg: Channels[K]): void {
    const set = this.subs.get(channel);
    if (!set) return;
    for (const fn of set) (fn as Listener<Channels[K]>)(msg);
  }

  subscriberCount(channel: string): number {
    return this.subs.get(channel)?.size ?? 0;
  }
}

export interface AppChannels {
  "recording":       { state: "idle" | "recording" | "processing" | "meetingBusy" | "daemonDown"; file?: string; elapsedSec?: number; level?: number; };
  "daemons":         { name: string; status: "running" | "stopped" | "crashed"; pid: number; lastLog?: string; };
  "sidebar-counts":  { voicemails: number; meetings: number; prompts: number; glossary: number; };
  "logs":            { name: string; line: string; ts: number; };
}

export const appPubSub = new PubSub<AppChannels>();
```

- [ ] **Step 4: Re-run, verify PASS**

```bash
npm test -- pubsub.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/pubsub.ts yulu/scripts/yulu_ui/tests/pubsub.test.ts
git commit -m "feat(yulu_ui): typed PubSub for cross-cutting events"
```

---

## Task A.8 — tRPC init + AppContext

**Files:**
- Create: `yulu/scripts/yulu_ui/src/trpc.ts`
- Create: `yulu/scripts/yulu_ui/tests/trpc.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/trpc.test.ts
import { describe, it, expect } from "vitest";
import { initTRPC } from "@trpc/server";
import { router, publicProcedure, createCaller, type AppContext } from "../src/trpc.js";

describe("tRPC scaffolding", () => {
  it("exports router + publicProcedure + createCaller", () => {
    const r = router({
      ping: publicProcedure.query(() => "pong"),
    });
    const caller = createCaller(r, {} as AppContext);
    expect(caller.ping()).resolves.toBe("pong");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- trpc.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/trpc.ts
import { initTRPC } from "@trpc/server";
import type { ConfigManager } from "./config.js";
import type { LaunchctlClient } from "./launchctl.js";
import type { PubSub, AppChannels } from "./pubsub.js";
import type { Database as DbType } from "better-sqlite3";

export interface AppContext {
  config: ConfigManager;
  launchctl: LaunchctlClient;
  pubsub: PubSub<AppChannels>;
  db: {
    prompts: DbType;
    vocab: DbType;
    search: DbType;
  };
}

const t = initTRPC.context<AppContext>().create();
export const router = t.router;
export const publicProcedure = t.procedure;
export const mergeRouters = t.mergeRouters;

// Convenience for tests + unit calls
export function createCaller<R extends ReturnType<typeof router>>(r: R, ctx: AppContext) {
  return t.createCallerFactory(r)(ctx);
}
```

- [ ] **Step 4: Re-run, verify PASS**

```bash
npm test -- trpc.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/trpc.ts yulu/scripts/yulu_ui/tests/trpc.test.ts
git commit -m "feat(yulu_ui): tRPC init with AppContext"
```

---

## Tasks A.9–A.19 — The 11 routers

Each router follows the same shape: define procedures (`query` for reads, `mutation` for writes) with zod schemas, write tests using `createCaller`, commit. **Code conventions:**

- Always validate input via `.input(z.object(...))`.
- Reads of SQLite: prepared statements cached on `ctx.db.*`.
- Mutations of config: go through `ctx.config.update(...)`.
- Mutations that trigger daemon restart: do NOT auto-restart — return the `daemonsNeedingRestart` list and let the client call `daemons.restart` explicitly. Auto-SIGHUP IS allowed (it's hot-reload, not a restart).
- Procedures that talk to external sockets: use `ctx` for testability (inject a fake `ipcSend` via context if needed — but for now pass through to `src/ipc.ts`).

### Task A.9 — voicemails router

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/voicemails.ts`
- Create: `yulu/scripts/yulu_ui/tests/routers/voicemails.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/routers/voicemails.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { voicemailsRouter } from "../../src/routers/voicemails.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

function makeCtx(): { ctx: AppContext; voicemailsDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "yulu_vm_"));
  const voicemailsDir = join(dir, "voicemails");
  mkdirSync(voicemailsDir);
  // 3 fixture voicemails
  writeFileSync(join(voicemailsDir, "voicemail_20260526_100000.wav"), Buffer.alloc(1024));
  writeFileSync(join(voicemailsDir, "voicemail_20260526_100000.transcript.txt"), "hello world");
  writeFileSync(join(voicemailsDir, "voicemail_20260526_110000.wav"), Buffer.alloc(2048));
  writeFileSync(join(voicemailsDir, "voicemail_20260526_120000.wav"), Buffer.alloc(512));
  writeFileSync(join(voicemailsDir, "voicemail_20260526_120000.transcript.txt"), "second message");
  writeFileSync(join(voicemailsDir, "voicemail_20260526_120000.summary.md"), "## summary\nbullet");
  const ctx = { paths: { voicemailsDir } } as unknown as AppContext;
  return { ctx, voicemailsDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("voicemailsRouter", () => {
  it("list() returns newest-first with transcript+summary presence flags", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(voicemailsRouter, ctx);
      const rows = await caller.list({});
      expect(rows.map((r) => r.stem)).toEqual([
        "voicemail_20260526_120000",
        "voicemail_20260526_110000",
        "voicemail_20260526_100000",
      ]);
      expect(rows[0]!.hasTranscript).toBe(true);
      expect(rows[0]!.hasSummary).toBe(true);
      expect(rows[1]!.hasTranscript).toBe(false);
    } finally { cleanup(); }
  });

  it("get() returns transcript + summary content", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(voicemailsRouter, ctx);
      const r = await caller.get({ stem: "voicemail_20260526_120000" });
      expect(r.transcript).toBe("second message");
      expect(r.summary).toContain("bullet");
    } finally { cleanup(); }
  });

  it("delete() removes wav + sidecars", async () => {
    const { ctx, voicemailsDir, cleanup } = makeCtx();
    try {
      const caller = createCaller(voicemailsRouter, ctx);
      await caller.delete({ stem: "voicemail_20260526_100000" });
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(voicemailsDir, "voicemail_20260526_100000.wav"))).toBe(false);
      expect(existsSync(join(voicemailsDir, "voicemail_20260526_100000.transcript.txt"))).toBe(false);
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- routers/voicemails.test.ts
```

- [ ] **Step 3: Extend AppContext with `paths` (also update src/trpc.ts)**

Edit `src/trpc.ts` — add to `AppContext`:

```ts
import { paths as defaultPaths } from "./paths.js";
// ... add to AppContext interface:
//   paths: typeof defaultPaths;
```

Final AppContext shape:

```ts
export interface AppContext {
  config: ConfigManager;
  launchctl: LaunchctlClient;
  pubsub: PubSub<AppChannels>;
  paths: typeof import("./paths.js")["paths"];
  db: {
    prompts: DbType;
    vocab: DbType;
    search: DbType;
  };
}
```

- [ ] **Step 4: Implement voicemails router**

```ts
// src/routers/voicemails.ts
import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

const STEM_RE = /^(voicemail_\d{8}_\d{6})\.wav$/;

function listFromDir(dir: string) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const rows = [];
  for (const f of entries) {
    const m = f.match(STEM_RE);
    if (!m) continue;
    const stem = m[1]!;
    const wavPath = join(dir, f);
    const stat = statSync(wavPath);
    rows.push({
      stem,
      wavPath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      hasTranscript: existsSync(join(dir, `${stem}.transcript.txt`)),
      hasSummary:    existsSync(join(dir, `${stem}.summary.md`)),
    });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows;
}

export const voicemailsRouter = router({
  list: publicProcedure
    .input(z.object({
      limit: z.number().int().positive().max(500).optional(),
      since: z.number().int().nonnegative().optional(),  // unix ms
    }))
    .query(({ ctx, input }) => {
      let rows = listFromDir(ctx.paths.voicemailsDir);
      if (input.since !== undefined) rows = rows.filter((r) => r.mtimeMs >= input.since!);
      if (input.limit !== undefined) rows = rows.slice(0, input.limit);
      return rows;
    }),

  get: publicProcedure
    .input(z.object({ stem: z.string().regex(/^voicemail_\d{8}_\d{6}$/) }))
    .query(({ ctx, input }) => {
      const dir = ctx.paths.voicemailsDir;
      const wav = join(dir, `${input.stem}.wav`);
      if (!existsSync(wav)) throw new Error(`voicemail not found: ${input.stem}`);
      const transcriptPath = join(dir, `${input.stem}.transcript.txt`);
      const summaryPath = join(dir, `${input.stem}.summary.md`);
      return {
        stem: input.stem,
        wavPath: wav,
        sizeBytes: statSync(wav).size,
        mtimeMs: statSync(wav).mtimeMs,
        transcript: existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : null,
        summary:    existsSync(summaryPath)    ? readFileSync(summaryPath, "utf8")    : null,
      };
    }),

  audioUrl: publicProcedure
    .input(z.object({ stem: z.string() }))
    .query(({ input }) => `/files/voicemails/${input.stem}.wav`),

  delete: publicProcedure
    .input(z.object({ stem: z.string().regex(/^voicemail_\d{8}_\d{6}$/) }))
    .mutation(({ ctx, input }) => {
      const dir = ctx.paths.voicemailsDir;
      const candidates = [`${input.stem}.wav`, `${input.stem}.transcript.txt`,
                          `${input.stem}.raw.transcript.txt`, `${input.stem}.summary.md`,
                          `${input.stem}.summary.html`, `${input.stem}.title`];
      let removed = 0;
      for (const c of candidates) {
        const p = join(dir, c);
        if (existsSync(p)) { unlinkSync(p); removed++; }
      }
      ctx.pubsub.publish("sidebar-counts", { voicemails: -1, meetings: 0, prompts: 0, glossary: 0 });
      return { removed };
    }),
});
```

- [ ] **Step 5: Re-run, verify PASS**

```bash
npm test -- routers/voicemails.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/voicemails.ts \
        yulu/scripts/yulu_ui/tests/routers/voicemails.test.ts \
        yulu/scripts/yulu_ui/src/trpc.ts
git commit -m "feat(yulu_ui): voicemails router (list/get/audioUrl/delete)"
```

### Task A.10 — meetings router

Same pattern as A.9, scoped to `ctx.paths.moviesDir` (NOT the voicemails subdir). Meetings have `<title>_<YYYYMMDD>_<HHMMSS>.wav` filenames where title is anything except "voicemail".

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/meetings.ts`
- Create: `yulu/scripts/yulu_ui/tests/routers/meetings.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/routers/meetings.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { meetingsRouter } from "../../src/routers/meetings.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "yulu_meet_"));
  mkdirSync(join(dir, "voicemails"));     // ignored by meetings router
  writeFileSync(join(dir, "voicemails/voicemail_20260526_100000.wav"), Buffer.alloc(0));
  writeFileSync(join(dir, "WeeklyStandup_20260520_100000.wav"), Buffer.alloc(0));
  writeFileSync(join(dir, "WeeklyStandup_20260520_100000.transcript.txt"), "agenda");
  writeFileSync(join(dir, "WeeklyStandup_20260520_100000.realtime.transcript.txt"), "noisy live");
  writeFileSync(join(dir, "1on1_20260521_140000.wav"), Buffer.alloc(0));
  const ctx = { paths: { moviesDir: dir, voicemailsDir: join(dir, "voicemails") } } as unknown as AppContext;
  return { ctx, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("meetingsRouter", () => {
  it("list() excludes voicemails subdir and matches <title>_DATE_TIME stems", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(meetingsRouter, ctx);
      const rows = await caller.list({});
      const titles = rows.map((r) => r.meetingTitle).sort();
      expect(titles).toEqual(["1on1", "WeeklyStandup"]);
    } finally { cleanup(); }
  });

  it("get() includes realtime transcript when present", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(meetingsRouter, ctx);
      const r = await caller.get({ stem: "WeeklyStandup_20260520_100000" });
      expect(r.transcript).toBe("agenda");
      expect(r.realtime).toBe("noisy live");
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- routers/meetings.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/routers/meetings.ts
import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

const STEM_RE = /^(.+?)_(\d{8})_(\d{6})\.wav$/;

function parseStem(filename: string): { stem: string; title: string; isoTs: string } | null {
  const m = filename.match(STEM_RE);
  if (!m) return null;
  const [, title, date, time] = m;
  if (title === "voicemail") return null;
  const iso = `${date!.slice(0,4)}-${date!.slice(4,6)}-${date!.slice(6,8)}T${time!.slice(0,2)}:${time!.slice(2,4)}:${time!.slice(4,6)}`;
  return { stem: filename.slice(0, -4), title: title!, isoTs: iso };
}

export const meetingsRouter = router({
  list: publicProcedure
    .input(z.object({
      limit: z.number().int().positive().max(500).optional(),
      since: z.number().int().nonnegative().optional(),
    }))
    .query(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      if (!existsSync(dir)) return [];
      const rows = [];
      for (const f of readdirSync(dir)) {
        const parsed = parseStem(f);
        if (!parsed) continue;
        const wavPath = join(dir, f);
        const stat = statSync(wavPath);
        rows.push({
          stem: parsed.stem,
          meetingTitle: parsed.title,
          recordedAt: parsed.isoTs,
          wavPath,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          hasTranscript: existsSync(join(dir, `${parsed.stem}.transcript.txt`)),
          hasSummary:    existsSync(join(dir, `${parsed.stem}.summary.md`)),
          hasRealtime:   existsSync(join(dir, `${parsed.stem}.realtime.transcript.txt`)),
        });
      }
      rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
      let out = rows;
      if (input.since !== undefined) out = out.filter((r) => r.mtimeMs >= input.since!);
      if (input.limit !== undefined) out = out.slice(0, input.limit);
      return out;
    }),

  get: publicProcedure
    .input(z.object({ stem: z.string() }))
    .query(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      const wav = join(dir, `${input.stem}.wav`);
      if (!existsSync(wav)) throw new Error(`meeting not found: ${input.stem}`);
      const read = (suffix: string) => {
        const p = join(dir, `${input.stem}${suffix}`);
        return existsSync(p) ? readFileSync(p, "utf8") : null;
      };
      return {
        stem: input.stem,
        wavPath: wav,
        sizeBytes: statSync(wav).size,
        mtimeMs: statSync(wav).mtimeMs,
        transcript: read(".transcript.txt"),
        summary:    read(".summary.md"),
        realtime:   read(".realtime.transcript.txt"),
      };
    }),

  audioUrl: publicProcedure
    .input(z.object({ stem: z.string() }))
    .query(({ input }) => `/files/meetings/${input.stem}.wav`),

  delete: publicProcedure
    .input(z.object({ stem: z.string() }))
    .mutation(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      const candidates = [".wav", ".transcript.txt", ".raw.transcript.txt", ".summary.md",
                          ".summary.html", ".realtime.transcript.txt", ".realtime.json"]
                          .map((s) => `${input.stem}${s}`);
      let removed = 0;
      for (const c of candidates) {
        const p = join(dir, c);
        if (existsSync(p)) { unlinkSync(p); removed++; }
      }
      ctx.pubsub.publish("sidebar-counts", { voicemails: 0, meetings: -1, prompts: 0, glossary: 0 });
      return { removed };
    }),
});
```

- [ ] **Step 4: Re-run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/meetings.ts \
        yulu/scripts/yulu_ui/tests/routers/meetings.test.ts
git commit -m "feat(yulu_ui): meetings router (excludes voicemails dir)"
```

### Task A.11 — search router (shells out to Python)

The UI does NOT re-implement FTS5 in Node. It spawns `python3 -m search.cli --json` (Phase 6 already provides this). Keeps logic in one place.

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/search.ts`
- Create: `yulu/scripts/yulu_ui/tests/routers/search.test.ts`

- [ ] **Step 1: Write failing test (mock execFile)**

```ts
// tests/routers/search.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { searchRouter } from "../../src/routers/search.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

beforeEach(() => execFileMock.mockReset());

const FAKE_HITS = {
  hits: [
    { kind: "voicemail_summary", stem: "voicemail_20260526_100000",
      meetingTitle: "voicemail", recordedAt: "2026-05-26T10:00:00",
      sourcePath: "/x/y.md", score: 1.2, snippet: "[hit]OKR[/hit] meeting" }
  ],
  telemetry: { sweepMs: 12, queryMs: 4, fallbackUsed: false, hitCount: 1 }
};

describe("searchRouter", () => {
  it("run() spawns python search.cli with --json and returns parsed hits", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(null, { stdout: JSON.stringify(FAKE_HITS), stderr: "" }));
    const ctx = {} as AppContext;
    const caller = createCaller(searchRouter, ctx);
    const r = await caller.run({ query: "OKR" });
    expect(r.hits.length).toBe(1);
    expect(r.telemetry.fallbackUsed).toBe(false);
    expect(execFileMock.mock.calls[0]![0]).toBe("python3");
    expect(execFileMock.mock.calls[0]![1]).toContain("search.cli");
    expect(execFileMock.mock.calls[0]![1]).toContain("--json");
    expect(execFileMock.mock.calls[0]![1]).toContain("OKR");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/routers/search.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

const exec = promisify(execFile) as (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>;

const ALLOWED_KINDS = ["meeting_summary", "meeting_transcript", "voicemail_summary", "voicemail_transcript"] as const;

export const searchRouter = router({
  run: publicProcedure
    .input(z.object({
      query: z.string().min(1).max(200),
      since: z.string().optional(),               // e.g. "7d"
      kinds: z.array(z.enum(ALLOWED_KINDS)).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }))
    .query(async ({ input }) => {
      const args = ["-m", "search.cli", "--json", input.query];
      if (input.since) args.push("--since", input.since);
      if (input.kinds && input.kinds.length === 1) {
        // single-kind shortcut maps to --type {voicemail|meeting} + --in {summary|transcript}
        const [kindOnly] = input.kinds;
        const [t, layer] = kindOnly!.split("_");
        args.push("--type", t!, "--in", layer!);
      }
      if (input.limit !== undefined) args.push("--limit", String(input.limit));
      const { stdout } = await exec("python3", args, {
        env: { ...process.env, PYTHONPATH: process.env.YULU_SCRIPT_DIR ?? "/Users/liaoyuxing/.yulu/yulu/scripts" },
        cwd: process.env.HOME,
      });
      return JSON.parse(stdout) as { hits: unknown[]; telemetry: Record<string, unknown> };
    }),

  reindex: publicProcedure.mutation(async () => {
    await exec("python3", ["-m", "search.cli", "--reindex"], {
      env: { ...process.env, PYTHONPATH: process.env.YULU_SCRIPT_DIR ?? "/Users/liaoyuxing/.yulu/yulu/scripts" },
    });
    return { ok: true };
  }),

  doctor: publicProcedure.query(async () => {
    const { stdout } = await exec("python3", ["-m", "search.cli", "--doctor"], {
      env: { ...process.env, PYTHONPATH: process.env.YULU_SCRIPT_DIR ?? "/Users/liaoyuxing/.yulu/yulu/scripts" },
    });
    return JSON.parse(stdout);
  }),
});
```

- [ ] **Step 4: Re-run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/search.ts \
        yulu/scripts/yulu_ui/tests/routers/search.test.ts
git commit -m "feat(yulu_ui): search router shells out to python search.cli"
```

### Task A.12 — config router

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/config.ts`
- Create: `yulu/scripts/yulu_ui/tests/routers/config.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/routers/config.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigManager } from "../../src/config.js";
import { configRouter } from "../../src/routers/config.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "yulu_cfgrouter_"));
  const path = join(dir, "config.json");
  cpSync(join(__dirname, "../fixtures/config.json"), path);
  const ctx = { config: new ConfigManager(path) } as unknown as AppContext;
  return { ctx, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("configRouter", () => {
  it("get() returns parsed config", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const cfg = await caller.get();
      expect(cfg.audio.silence_threshold).toBe(0.01);
    } finally { cleanup(); }
  });

  it("update() returns restart targets", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const r = await caller.update({ key: "audio.silence_threshold", value: 0.02 });
      expect(r.daemonsNeedingRestart).toContain("audiodaemon");
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/routers/config.ts
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

export const configRouter = router({
  get: publicProcedure.query(({ ctx }) => ctx.config.read()),

  update: publicProcedure
    .input(z.object({
      key: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/i),
      value: z.unknown(),
    }))
    .mutation(({ ctx, input }) => ctx.config.update(input.key, input.value)),
});
```

- [ ] **Step 4: Re-run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/config.ts \
        yulu/scripts/yulu_ui/tests/routers/config.test.ts
git commit -m "feat(yulu_ui): config router (get/update)"
```

### Task A.13 — prompts router (SQLite write + SIGHUP)

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/prompts.ts`
- Create: `yulu/scripts/yulu_ui/tests/routers/prompts.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/routers/prompts.test.ts
import { describe, it, expect, vi } from "vitest";
import { makeTmpDb } from "../helpers/tmpDb.js";
import { promptsRouter } from "../../src/routers/prompts.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const PROMPTS_SCHEMA = `
CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('summary','cleanup','voicemail')),
  content TEXT NOT NULL,
  is_auto_run INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  sort_order INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO prompts VALUES
 ('id-1','default','Default Summary','summary','Summarize the meeting.',1,'seed',0,NULL,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
 ('id-2','cleanup','Cleanup','cleanup','Clean noise.',0,'seed',1,NULL,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
`;

function makeCtx() {
  const { db } = makeTmpDb(PROMPTS_SCHEMA);
  const sighup = vi.fn();
  const ctx = {
    db: { prompts: db, vocab: null, search: null },
    launchctl: { sighup },
  } as unknown as AppContext;
  return { ctx, sighup, cleanup: () => db.close() };
}

describe("promptsRouter", () => {
  it("list() returns sorted by sort_order then name", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(promptsRouter, ctx);
      const rows = await caller.list({});
      expect(rows.map((r) => r.slug)).toEqual(["default", "cleanup"]);
    } finally { cleanup(); }
  });

  it("update() writes + SIGHUPs agentqueue", async () => {
    const { ctx, sighup, cleanup } = makeCtx();
    try {
      const caller = createCaller(promptsRouter, ctx);
      await caller.update({ id: "id-1", content: "New body." });
      const row = ctx.db.prompts.prepare("SELECT content FROM prompts WHERE id=?").get("id-1") as { content: string };
      expect(row.content).toBe("New body.");
      expect(sighup).toHaveBeenCalledWith("com.yulu.agentqueue");
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/routers/prompts.ts
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

const CATEGORY = z.enum(["summary", "cleanup", "voicemail"]);

export const promptsRouter = router({
  list: publicProcedure
    .input(z.object({ category: CATEGORY.optional() }))
    .query(({ ctx, input }) => {
      const sql = input.category
        ? "SELECT * FROM prompts WHERE category = ? ORDER BY sort_order, name"
        : "SELECT * FROM prompts ORDER BY sort_order, name";
      return ctx.db.prompts.prepare(sql).all(...(input.category ? [input.category] : []));
    }),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) =>
      ctx.db.prompts.prepare("SELECT * FROM prompts WHERE id = ?").get(input.id) ?? null
    ),

  create: publicProcedure
    .input(z.object({
      slug: z.string().regex(/^[a-z][a-z0-9-]{0,62}[a-z0-9]?$/),
      name: z.string().min(1),
      category: CATEGORY,
      content: z.string().min(1),
      isAutoRun: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      const id = `id-${Date.now().toString(36)}`;
      ctx.db.prompts.prepare(
        `INSERT INTO prompts (id, slug, name, category, content, is_auto_run, source, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'manual', 0, ?, ?)`
      ).run(id, input.slug, input.name, input.category, input.content,
            input.isAutoRun ? 1 : 0, now, now);
      await tryHup(ctx);
      return { id };
    }),

  update: publicProcedure
    .input(z.object({
      id: z.string(),
      name: z.string().optional(),
      category: CATEGORY.optional(),
      content: z.string().optional(),
      isAutoRun: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const fields: string[] = [];
      const values: unknown[] = [];
      if (input.name !== undefined)      { fields.push("name = ?");        values.push(input.name); }
      if (input.category !== undefined)  { fields.push("category = ?");    values.push(input.category); }
      if (input.content !== undefined)   { fields.push("content = ?");     values.push(input.content); }
      if (input.isAutoRun !== undefined) { fields.push("is_auto_run = ?"); values.push(input.isAutoRun ? 1 : 0); }
      if (fields.length === 0) return { updated: 0 };
      fields.push("updated_at = ?"); values.push(new Date().toISOString().replace(/\.\d+Z$/, "Z"));
      values.push(input.id);
      const r = ctx.db.prompts.prepare(`UPDATE prompts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      await tryHup(ctx);
      return { updated: r.changes };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const r = ctx.db.prompts.prepare("DELETE FROM prompts WHERE id = ?").run(input.id);
      await tryHup(ctx);
      return { deleted: r.changes };
    }),
});

async function tryHup(ctx: { launchctl: { sighup: (l: string) => Promise<void> } }): Promise<void> {
  try { await ctx.launchctl.sighup("com.yulu.agentqueue"); }
  catch { /* worker may be down; the change is persisted */ }
}
```

- [ ] **Step 4: Re-run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/prompts.ts \
        yulu/scripts/yulu_ui/tests/routers/prompts.test.ts
git commit -m "feat(yulu_ui): prompts router (CRUD + auto-SIGHUP agentqueue)"
```

### Task A.14 — glossary router

Same shape as prompts. Vocab table schema TBD by Phase 1; in tests assume:

```sql
CREATE TABLE vocab (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE,
  pinyin TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/glossary.ts`
- Create: `yulu/scripts/yulu_ui/tests/routers/glossary.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/routers/glossary.test.ts
import { describe, it, expect, vi } from "vitest";
import { makeTmpDb } from "../helpers/tmpDb.js";
import { glossaryRouter } from "../../src/routers/glossary.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const VOCAB_SCHEMA = `
CREATE TABLE vocab (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE,
  pinyin TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO vocab (term, pinyin, notes, created_at, updated_at) VALUES
 ('AgentKey', NULL, 'product', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('OpenClaw', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
`;

function makeCtx() {
  const { db } = makeTmpDb(VOCAB_SCHEMA);
  const sighup = vi.fn();
  const ctx = {
    db: { vocab: db, prompts: null, search: null },
    launchctl: { sighup },
  } as unknown as AppContext;
  return { ctx, sighup, cleanup: () => db.close() };
}

describe("glossaryRouter", () => {
  it("list() returns rows ordered by term", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(glossaryRouter, ctx);
      const r = await caller.list();
      expect(r.map((x) => x.term)).toEqual(["AgentKey", "OpenClaw"]);
    } finally { cleanup(); }
  });

  it("add() inserts + SIGHUPs sttdaemon", async () => {
    const { ctx, sighup, cleanup } = makeCtx();
    try {
      const caller = createCaller(glossaryRouter, ctx);
      await caller.add({ term: "NewTerm" });
      const r = ctx.db.vocab.prepare("SELECT COUNT(*) AS n FROM vocab").get() as { n: number };
      expect(r.n).toBe(3);
      expect(sighup).toHaveBeenCalledWith("com.yulu.sttdaemon");
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/routers/glossary.ts
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

export const glossaryRouter = router({
  list: publicProcedure.query(({ ctx }) =>
    ctx.db.vocab.prepare("SELECT * FROM vocab ORDER BY term").all()
  ),

  add: publicProcedure
    .input(z.object({ term: z.string().min(1).max(200), pinyin: z.string().optional(), notes: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      ctx.db.vocab.prepare(
        "INSERT INTO vocab (term, pinyin, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run(input.term, input.pinyin ?? null, input.notes ?? null, now, now);
      await hupStt(ctx);
      return { ok: true };
    }),

  update: publicProcedure
    .input(z.object({ id: z.number().int(), term: z.string().optional(),
                      pinyin: z.string().nullable().optional(), notes: z.string().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const fields: string[] = []; const values: unknown[] = [];
      if (input.term !== undefined)   { fields.push("term = ?");   values.push(input.term); }
      if (input.pinyin !== undefined) { fields.push("pinyin = ?"); values.push(input.pinyin); }
      if (input.notes !== undefined)  { fields.push("notes = ?");  values.push(input.notes); }
      if (fields.length === 0) return { updated: 0 };
      fields.push("updated_at = ?"); values.push(new Date().toISOString().replace(/\.\d+Z$/, "Z"));
      values.push(input.id);
      const r = ctx.db.vocab.prepare(`UPDATE vocab SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      await hupStt(ctx);
      return { updated: r.changes };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const r = ctx.db.vocab.prepare("DELETE FROM vocab WHERE id = ?").run(input.id);
      await hupStt(ctx);
      return { deleted: r.changes };
    }),
});

async function hupStt(ctx: { launchctl: { sighup: (l: string) => Promise<void> } }): Promise<void> {
  try { await ctx.launchctl.sighup("com.yulu.sttdaemon"); } catch { /* daemon may be down */ }
}
```

- [ ] **Step 4: Re-run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/glossary.ts \
        yulu/scripts/yulu_ui/tests/routers/glossary.test.ts
git commit -m "feat(yulu_ui): glossary router (CRUD + auto-SIGHUP sttdaemon)"
```

### Task A.15 — daemons router

Static list of the 7 known yulu LaunchAgents + the new `com.yulu.ui` itself. `health()` queries `launchctl status` for each + reads last log line.

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/daemons.ts`
- Create: `yulu/scripts/yulu_ui/tests/routers/daemons.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/routers/daemons.test.ts
import { describe, it, expect, vi } from "vitest";
import { daemonsRouter, YULU_DAEMONS } from "../../src/routers/daemons.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

function makeCtx() {
  return {
    launchctl: {
      status: vi.fn(async (label: string) =>
        label === "com.yulu.audiodaemon"
          ? { pid: 1001, exitStatus: 0, label }
          : null),
      restart: vi.fn(async () => undefined),
      stop:    vi.fn(async () => undefined),
      start:   vi.fn(async () => undefined),
    },
    paths: { configDir: "/tmp" },
  } as unknown as AppContext;
}

describe("daemonsRouter", () => {
  it("knows the 8 yulu daemons (7 existing + yulu_ui)", () => {
    expect(YULU_DAEMONS).toHaveLength(8);
    expect(YULU_DAEMONS).toContain("com.yulu.ui");
  });

  it("health() reports running vs stopped per launchctl", async () => {
    const caller = createCaller(daemonsRouter, makeCtx());
    const r = await caller.health();
    const audio = r.find((d) => d.name === "com.yulu.audiodaemon")!;
    const stt   = r.find((d) => d.name === "com.yulu.sttdaemon")!;
    expect(audio.status).toBe("running");
    expect(audio.pid).toBe(1001);
    expect(stt.status).toBe("stopped");
  });

  it("restart() calls launchctl + publishes daemons event", async () => {
    const ctx = makeCtx();
    const pub = vi.fn();
    (ctx as unknown as { pubsub: { publish: typeof pub } }).pubsub = { publish: pub } as never;
    const caller = createCaller(daemonsRouter, ctx);
    await caller.restart({ name: "com.yulu.audiodaemon" });
    expect((ctx.launchctl as unknown as { restart: ReturnType<typeof vi.fn> }).restart)
      .toHaveBeenCalledWith("com.yulu.audiodaemon");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/routers/daemons.ts
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

export const YULU_DAEMONS = [
  "com.yulu.audiodaemon",
  "com.yulu.sttdaemon",
  "com.yulu.agentqueue",
  "com.yulu.statusagent",
  "com.yulu.scheduler",
  "com.yulu.detector",
  "com.yulu.calendar",
  "com.yulu.ui",
] as const;

type YuluDaemon = typeof YULU_DAEMONS[number];
const DaemonName = z.enum(YULU_DAEMONS);

// Map label → log file path (mirrors what setup.sh wires up)
function logPath(name: YuluDaemon, configDir: string): string {
  const short = name.replace(/^com\.yulu\./, "");
  return join(configDir, `${short === "ui" ? "ui" : short}.log`);
}

export const daemonsRouter = router({
  health: publicProcedure.query(async ({ ctx }) => {
    const out = [];
    for (const name of YULU_DAEMONS) {
      const s = await ctx.launchctl.status(name);
      const log = logPath(name, ctx.paths.configDir);
      let lastLog = "";
      if (existsSync(log)) {
        const stat = statSync(log);
        if (stat.size > 0) {
          const buf = readFileSync(log, "utf8");
          lastLog = buf.split("\n").filter(Boolean).slice(-1)[0] ?? "";
        }
      }
      out.push({
        name,
        status: !s || s.pid === 0 ? "stopped" : s.exitStatus !== 0 ? "crashed" : "running",
        pid: s?.pid ?? 0,
        exitStatus: s?.exitStatus ?? 0,
        lastLog,
      });
    }
    return out;
  }),

  restart: publicProcedure
    .input(z.object({ name: DaemonName }))
    .mutation(async ({ ctx, input }) => {
      await ctx.launchctl.restart(input.name);
      ctx.pubsub.publish("daemons", { name: input.name, status: "running", pid: 0 });
      return { ok: true };
    }),

  stop: publicProcedure
    .input(z.object({ name: DaemonName }))
    .mutation(async ({ ctx, input }) => {
      await ctx.launchctl.stop(input.name);
      ctx.pubsub.publish("daemons", { name: input.name, status: "stopped", pid: 0 });
      return { ok: true };
    }),

  start: publicProcedure
    .input(z.object({ name: DaemonName }))
    .mutation(async ({ ctx, input }) => {
      await ctx.launchctl.start(input.name);
      ctx.pubsub.publish("daemons", { name: input.name, status: "running", pid: 0 });
      return { ok: true };
    }),
});
```

- [ ] **Step 4: Re-run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/daemons.ts \
        yulu/scripts/yulu_ui/tests/routers/daemons.test.ts
git commit -m "feat(yulu_ui): daemons router (health/restart/stop/start)"
```

### Task A.16 — logs router

Tail-N for the immediate read; live tailing handled by the WebSocket multiplexer in Task A.20 via `pubsub.publish("logs", ...)`.

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/logs.ts`
- Create: `yulu/scripts/yulu_ui/tests/routers/logs.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/routers/logs.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logsRouter } from "../../src/routers/logs.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "yulu_logs_"));
  writeFileSync(join(dir, "audiodaemon.log"),
    Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  return {
    ctx: { paths: { configDir: dir } } as unknown as AppContext,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("logsRouter", () => {
  it("tail() returns last N lines", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(logsRouter, ctx);
      const r = await caller.tail({ name: "com.yulu.audiodaemon", limit: 5 });
      expect(r.lines).toEqual(["line 16", "line 17", "line 18", "line 19", "line 20"]);
    } finally { cleanup(); }
  });

  it("tail() returns empty when log missing", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(logsRouter, ctx);
      const r = await caller.tail({ name: "com.yulu.sttdaemon", limit: 5 });
      expect(r.lines).toEqual([]);
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/routers/logs.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { YULU_DAEMONS } from "./daemons.js";

const DaemonName = z.enum(YULU_DAEMONS);

export const logsRouter = router({
  tail: publicProcedure
    .input(z.object({ name: DaemonName, limit: z.number().int().positive().max(2_000).default(200) }))
    .query(({ ctx, input }) => {
      const short = input.name.replace(/^com\.yulu\./, "");
      const path = join(ctx.paths.configDir, `${short}.log`);
      if (!existsSync(path)) return { lines: [] as string[], path };
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n").filter(Boolean);
      return { lines: lines.slice(-input.limit), path };
    }),
});
```

- [ ] **Step 4: Re-run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/logs.ts \
        yulu/scripts/yulu_ui/tests/routers/logs.test.ts
git commit -m "feat(yulu_ui): logs router (tail-N)"
```

### Task A.17 — recording router (talks to status_agent.sock)

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/recording.ts`
- Create: `yulu/scripts/yulu_ui/tests/routers/recording.test.ts`

- [ ] **Step 1: Write failing test (uses fake socket)**

```ts
// tests/routers/recording.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { recordingRouter } from "../../src/routers/recording.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { startFakeSocket, type FakeSocket } from "../helpers/fakeUnixSocket.js";

describe("recordingRouter", () => {
  let fake: FakeSocket | undefined;
  afterEach(async () => { if (fake) { await fake.stop(); fake = undefined; } });

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
  });

  it("toggle() returns state_before/state_after", async () => {
    fake = await startFakeSocket((req) => {
      expect(req).toEqual({ action: "toggle" });
      return { ok: true, state_before: "idle", state_after: "recording" };
    });
    const ctx = { paths: { statusAgentSock: fake.path } } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    const r = await caller.toggle();
    expect(r.stateBefore).toBe("idle");
    expect(r.stateAfter).toBe("recording");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/routers/recording.ts
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { ipcSend } from "../ipc.js";

interface StatusReply { ok: boolean; state?: string; hotkey?: string; launcher_pid?: number; }
interface ToggleReply { ok: boolean; state_before?: string; state_after?: string; }

export const recordingRouter = router({
  state: publicProcedure.query(async ({ ctx }) => {
    const r = await ipcSend<StatusReply>(ctx.paths.statusAgentSock, { action: "status" });
    return { state: r.state ?? "unknown", hotkey: r.hotkey ?? "?", launcherPid: r.launcher_pid };
  }),

  toggle: publicProcedure.mutation(async ({ ctx }) => {
    const r = await ipcSend<ToggleReply>(ctx.paths.statusAgentSock, { action: "toggle" });
    return { stateBefore: r.state_before ?? "?", stateAfter: r.state_after ?? "?" };
  }),

  openInbox: publicProcedure.mutation(async ({ ctx }) => {
    await ipcSend(ctx.paths.statusAgentSock, { action: "open_inbox" });
    return { ok: true };
  }),
});
```

- [ ] **Step 4: Re-run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/recording.ts \
        yulu/scripts/yulu_ui/tests/routers/recording.test.ts
git commit -m "feat(yulu_ui): recording router (state/toggle/open_inbox via status_agent.sock)"
```

### Task A.18 — sidebar counts router

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/sidebar.ts`
- Create: `yulu/scripts/yulu_ui/tests/routers/sidebar.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/routers/sidebar.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeTmpDb } from "../helpers/tmpDb.js";
import { sidebarRouter } from "../../src/routers/sidebar.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const PROMPTS = "CREATE TABLE prompts (id TEXT PRIMARY KEY); INSERT INTO prompts VALUES ('a'), ('b');";
const VOCAB   = "CREATE TABLE vocab (id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL UNIQUE); INSERT INTO vocab(term) VALUES ('AgentKey'), ('OpenClaw'), ('Yulu');";

function makeCtx() {
  const moviesDir = mkdtempSync(join(tmpdir(), "yulu_side_"));
  mkdirSync(join(moviesDir, "voicemails"));
  writeFileSync(join(moviesDir, "Standup_20260520_100000.wav"), Buffer.alloc(0));
  writeFileSync(join(moviesDir, "Standup_20260521_100000.wav"), Buffer.alloc(0));
  writeFileSync(join(moviesDir, "voicemails/voicemail_20260526_100000.wav"), Buffer.alloc(0));
  const { db: prompts } = makeTmpDb(PROMPTS);
  const { db: vocab } = makeTmpDb(VOCAB);
  const ctx = {
    paths: { moviesDir, voicemailsDir: join(moviesDir, "voicemails") },
    db: { prompts, vocab, search: null },
  } as unknown as AppContext;
  return { ctx, cleanup: () => { prompts.close(); vocab.close(); rmSync(moviesDir, { recursive: true, force: true }); } };
}

describe("sidebarRouter", () => {
  it("counts() returns the 4 sidebar counts", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(sidebarRouter, ctx);
      expect(await caller.counts()).toEqual({ voicemails: 1, meetings: 2, prompts: 2, glossary: 3 });
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/routers/sidebar.ts
import { readdirSync, existsSync } from "node:fs";
import { router, publicProcedure } from "../trpc.js";

const MEETING_STEM_RE = /^(?!voicemail_)(.+?)_\d{8}_\d{6}\.wav$/;
const VOICEMAIL_STEM_RE = /^voicemail_\d{8}_\d{6}\.wav$/;

export const sidebarRouter = router({
  counts: publicProcedure.query(({ ctx }) => {
    const meetings = existsSync(ctx.paths.moviesDir)
      ? readdirSync(ctx.paths.moviesDir).filter((f) => MEETING_STEM_RE.test(f)).length
      : 0;
    const voicemails = existsSync(ctx.paths.voicemailsDir)
      ? readdirSync(ctx.paths.voicemailsDir).filter((f) => VOICEMAIL_STEM_RE.test(f)).length
      : 0;
    const prompts = (ctx.db.prompts.prepare("SELECT COUNT(*) AS n FROM prompts").get() as { n: number }).n;
    const glossary = (ctx.db.vocab.prepare("SELECT COUNT(*) AS n FROM vocab").get() as { n: number }).n;
    return { voicemails, meetings, prompts, glossary };
  }),
});
```

- [ ] **Step 4: Re-run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/sidebar.ts \
        yulu/scripts/yulu_ui/tests/routers/sidebar.test.ts
git commit -m "feat(yulu_ui): sidebar.counts (voicemails/meetings/prompts/glossary)"
```

### Task A.19 — system router (version + doctor proxy)

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/system.ts`
- Create: `yulu/scripts/yulu_ui/tests/routers/system.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/routers/system.test.ts
import { describe, it, expect } from "vitest";
import { systemRouter } from "../../src/routers/system.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

describe("systemRouter", () => {
  it("version() returns the yulu_ui package version", async () => {
    const caller = createCaller(systemRouter, {} as AppContext);
    const v = await caller.version();
    expect(v.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.name).toBe("yulu-ui");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/routers/system.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { router, publicProcedure } from "../trpc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { name: string; version: string };

export const systemRouter = router({
  version: publicProcedure.query(() => ({
    name: PKG.name,
    version: PKG.version,
    node: process.version,
    uptimeSec: Math.floor(process.uptime()),
  })),
});
```

- [ ] **Step 4: Re-run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/system.ts \
        yulu/scripts/yulu_ui/tests/routers/system.test.ts
git commit -m "feat(yulu_ui): system router (version + uptime)"
```

---

## Task A.20 — Root router (mergeRouters)

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/_app.ts`

- [ ] **Step 1: Implement (no test — pure composition)**

```ts
// src/routers/_app.ts
import { router } from "../trpc.js";
import { voicemailsRouter } from "./voicemails.js";
import { meetingsRouter }   from "./meetings.js";
import { searchRouter }     from "./search.js";
import { configRouter }     from "./config.js";
import { promptsRouter }    from "./prompts.js";
import { glossaryRouter }   from "./glossary.js";
import { daemonsRouter }    from "./daemons.js";
import { logsRouter }       from "./logs.js";
import { recordingRouter }  from "./recording.js";
import { sidebarRouter }    from "./sidebar.js";
import { systemRouter }     from "./system.js";

export const appRouter = router({
  voicemails: voicemailsRouter,
  meetings:   meetingsRouter,
  search:     searchRouter,
  config:     configRouter,
  prompts:    promptsRouter,
  glossary:   glossaryRouter,
  daemons:    daemonsRouter,
  logs:       logsRouter,
  recording:  recordingRouter,
  sidebar:    sidebarRouter,
  system:     systemRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 2: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/_app.ts
git commit -m "feat(yulu_ui): merge 11 routers into appRouter"
```

---

## Task A.21 — WebSocket multiplexer

**Files:**
- Create: `yulu/scripts/yulu_ui/src/ws.ts`
- Create: `yulu/scripts/yulu_ui/tests/ws.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/ws.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { mountWsMultiplexer } from "../src/ws.js";
import { PubSub, type AppChannels } from "../src/pubsub.js";

describe("WS multiplexer", () => {
  let server: ReturnType<typeof createServer> | undefined;
  afterEach(() => server?.close());

  it("subscribes to a channel and receives published messages", async () => {
    server = createServer();
    const pubsub = new PubSub<AppChannels>();
    mountWsMultiplexer(server, pubsub);
    await new Promise<void>((res) => server!.listen(0, "127.0.0.1", res));
    const port = (server!.address() as { port: number }).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received: unknown[] = [];
    ws.on("message", (b) => received.push(JSON.parse(b.toString())));
    await new Promise((r) => ws.once("open", r));

    ws.send(JSON.stringify({ type: "subscribe", channel: "recording" }));
    await new Promise((r) => setTimeout(r, 30));
    pubsub.publish("recording", { state: "recording" });
    pubsub.publish("daemons",   { name: "x", status: "running", pid: 1 });
    await new Promise((r) => setTimeout(r, 30));

    expect(received.filter((m) => (m as { channel: string }).channel === "recording")).toHaveLength(1);
    expect(received.filter((m) => (m as { channel: string }).channel === "daemons")).toHaveLength(0);
    ws.close();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/ws.ts
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { PubSub, AppChannels } from "./pubsub.js";

/**
 * Single /ws endpoint. Clients send:
 *   {"type":"subscribe","channel":"recording"}
 *   {"type":"unsubscribe","channel":"recording"}
 * Server pushes:
 *   {"channel":"recording","payload":{...}}
 */
export function mountWsMultiplexer(http: HttpServer, pubsub: PubSub<AppChannels>): void {
  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 64 * 1024 });

  wss.on("connection", (ws: WebSocket) => {
    const unsubs = new Map<string, () => void>();
    ws.on("message", (raw) => {
      let msg: { type: string; channel: keyof AppChannels & string };
      try { msg = JSON.parse(raw.toString()); }
      catch { ws.send(JSON.stringify({ error: "bad json" })); return; }
      if (msg.type === "subscribe" && msg.channel) {
        if (unsubs.has(msg.channel)) return;
        const off = pubsub.subscribe(msg.channel, (payload) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ channel: msg.channel, payload }));
        });
        unsubs.set(msg.channel, off);
      } else if (msg.type === "unsubscribe" && msg.channel) {
        unsubs.get(msg.channel)?.();
        unsubs.delete(msg.channel);
      }
    });
    ws.on("close", () => {
      for (const off of unsubs.values()) off();
      unsubs.clear();
    });
  });
}
```

- [ ] **Step 4: Re-run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/ws.ts yulu/scripts/yulu_ui/tests/ws.test.ts
git commit -m "feat(yulu_ui): WS multiplexer (single /ws + channel subscribe)"
```

---

## Task A.22 — Server entry + static file routes

Wires everything: Hono mounted on raw HTTP server, tRPC adapter at `/trpc/*`, `/healthz`, `/files/voicemails/*` + `/files/meetings/*` for audio streaming with Range support, WS at `/ws`. 127.0.0.1 only.

**Files:**
- Create: `yulu/scripts/yulu_ui/src/server.ts`
- Create: `yulu/scripts/yulu_ui/tests/server.test.ts`

- [ ] **Step 1: Write failing integration test**

```ts
// tests/server.test.ts
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeTmpDb } from "./helpers/tmpDb.js";
import { startServer, type RunningServer } from "../src/server.js";

const PROMPTS = "CREATE TABLE prompts (id TEXT PRIMARY KEY); INSERT INTO prompts VALUES ('a');";
const VOCAB   = "CREATE TABLE vocab (id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL UNIQUE); INSERT INTO vocab(term) VALUES ('AgentKey');";
const SEARCH  = "CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='trigram');";

let env: { root: string; cleanup: () => void; server: RunningServer; baseUrl: string };

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "yulu_srv_"));
  const configDir = join(root, ".config", "yulu");
  mkdirSync(configDir, { recursive: true });
  cpSync(join(__dirname, "fixtures/config.json"), join(configDir, "config.json"));
  const { db: p } = makeTmpDb(PROMPTS); p.close();
  cpSync((p as unknown as { name: string }).name ?? join(__dirname, "fixtures/config.json"), join(configDir, "prompts.sqlite"));
  // (simpler: just rely on routers' own fixtures; for healthz only we don't need real DBs)
  const moviesDir = join(root, "Movies", "Yulu");
  mkdirSync(join(moviesDir, "voicemails"), { recursive: true });
  process.env.HOME = root;
  process.env.YULU_UI_PORT = "0";   // pick a free port
  const server = await startServer();
  const port = (server.address as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  env = { root, cleanup: () => rmSync(root, { recursive: true, force: true }), server, baseUrl };
});

afterAll(async () => { await env.server.close(); env.cleanup(); });

describe("server", () => {
  it("/healthz returns ok", async () => {
    const r = await fetch(`${env.baseUrl}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "ok" });
  });

  it("/trpc/system.version returns version", async () => {
    const r = await fetch(`${env.baseUrl}/trpc/system.version?input=%7B%7D`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result: { data: { name: string } } };
    expect(body.result.data.name).toBe("yulu-ui");
  });

  it("rejects non-localhost via Host header guard", async () => {
    const r = await fetch(`${env.baseUrl}/healthz`, { headers: { Host: "evil.com:7777" } });
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/server.ts
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Hono } from "hono";
import { serveStatic } from "hono/serve-static";
import { createReadStream, statSync } from "node:fs";
import { join, basename } from "node:path";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./routers/_app.js";
import { ConfigManager } from "./config.js";
import { LaunchctlClient } from "./launchctl.js";
import { openDb } from "./db.js";
import { appPubSub } from "./pubsub.js";
import { paths } from "./paths.js";
import { mountWsMultiplexer } from "./ws.js";
import { homedir } from "node:os";
import type { AppContext } from "./trpc.js";

export interface RunningServer { http: HttpServer; address: { port: number }; close: () => Promise<void>; }

export async function startServer(): Promise<RunningServer> {
  const port = Number(process.env.YULU_UI_PORT ?? 7777);
  const host = "127.0.0.1";

  const launchAgents = join(homedir(), "Library", "LaunchAgents");

  // Lazily open DBs — let healthz work even if some are missing.
  const ctx: AppContext = {
    config:    new ConfigManager(paths.configFile),
    launchctl: new LaunchctlClient(launchAgents),
    pubsub:    appPubSub,
    paths,
    db: {
      get prompts() { return openDb(paths.promptsDb); },
      get vocab()   { return openDb(paths.vocabDb); },
      get search()  { return openDb(paths.searchDb); },
    } as AppContext["db"],
  };

  const app = new Hono();

  // Host header guard — even though we listen on 127.0.0.1 only, browsers
  // can rebind via DNS. Refuse anything but localhost/127.0.0.1.
  app.use("*", async (c, next) => {
    const h = c.req.header("host") ?? "";
    const hostname = h.split(":")[0] ?? "";
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return c.text("forbidden", 403);
    await next();
  });

  app.get("/healthz", (c) => c.json({ status: "ok", uptime: process.uptime() }));

  app.all("/trpc/*", (c) => fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: () => ctx,
    onError: ({ error, path }) => console.error(`[trpc] ${path}: ${error.message}`),
  }));

  // /files/voicemails/<stem>.wav + /files/meetings/<stem>.wav with Range support
  app.get("/files/voicemails/*", (c) => streamAudio(c, paths.voicemailsDir));
  app.get("/files/meetings/*",   (c) => streamAudio(c, paths.moviesDir));

  // Mount Hono on raw HTTP so we can attach WS to the same server
  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const r = await app.fetch(new Request(url.toString(), { method: req.method, headers: req.headers as Record<string, string>, body: undefined as unknown as BodyInit }));
      res.statusCode = r.status;
      r.headers.forEach((v, k) => res.setHeader(k, v));
      const text = await r.text();
      res.end(text);
    } catch (e) { res.statusCode = 500; res.end((e as Error).message); }
  });
  mountWsMultiplexer(http, appPubSub);

  await new Promise<void>((res) => http.listen(port, host, res));
  const addr = http.address() as { port: number };
  return {
    http,
    address: addr,
    close: () => new Promise<void>((res) => http.close(() => res())),
  };
}

function streamAudio(c: { req: { raw: Request; param: () => unknown }; body: (b: BodyInit, status?: number, headers?: Record<string, string>) => Response }, baseDir: string) {
  const url = new URL(c.req.raw.url);
  const file = basename(url.pathname);
  const path = join(baseDir, file);
  const stat = statSync(path);
  const range = c.req.raw.headers.get("range");
  if (!range) {
    return c.body(createReadStream(path) as unknown as BodyInit, 200, {
      "Content-Length": String(stat.size),
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes",
    });
  }
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  const start = m ? Number(m[1]) : 0;
  const end   = m && m[2] ? Number(m[2]) : stat.size - 1;
  return c.body(createReadStream(path, { start, end }) as unknown as BodyInit, 206, {
    "Content-Range":  `bytes ${start}-${end}/${stat.size}`,
    "Accept-Ranges":  "bytes",
    "Content-Length": String(end - start + 1),
    "Content-Type":   "audio/wav",
  });
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then((s) => console.log(`[yulu_ui] listening on http://127.0.0.1:${s.address.port}`));
}
```

- [ ] **Step 4: Re-run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/server.ts yulu/scripts/yulu_ui/tests/server.test.ts
git commit -m "feat(yulu_ui): server entry (Hono + tRPC + WS + audio file Range)"
```

---

## Task A.23 — esbuild bundle

**Files:**
- Create: `yulu/scripts/yulu_ui/esbuild.config.mjs`

- [ ] **Step 1: Implement**

```js
// esbuild.config.mjs
import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  // Externalize native modules — they don't bundle cleanly; npm ci provides them.
  external: ["better-sqlite3", "bufferutil", "utf-8-validate"],
  logLevel: "info",
  sourcemap: true,
  minify: false,
});
```

- [ ] **Step 2: Build + verify output**

```bash
cd yulu/scripts/yulu_ui
npm run build
ls -lh dist/server.js
```

Expected: `dist/server.js` exists, ~200-500 KB.

- [ ] **Step 3: Start the built bundle + curl healthz**

```bash
cd yulu/scripts/yulu_ui
YULU_UI_PORT=17777 node dist/server.js &
sleep 1
curl -s http://127.0.0.1:17777/healthz
kill %1
```

Expected: `{"status":"ok","uptime":...}`.

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/yulu_ui/esbuild.config.mjs
git commit -m "feat(yulu_ui): esbuild single-file ESM bundle"
```

---

## Task A.24 — LaunchAgent plist template

**Files:**
- Create: `yulu/scripts/com.yulu.ui.plist`

- [ ] **Step 1: Implement**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yulu.ui</string>

    <key>ProgramArguments</key>
    <array>
        <string>__NODE_BIN__</string>
        <string>__SCRIPT_DIR__/yulu_ui/dist/server.js</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>YULU_UI_PORT</key>
        <string>7777</string>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>YULU_SCRIPT_DIR</key>
        <string>__SCRIPT_DIR__</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>__HOME__/.config/yulu/ui.log</string>

    <key>StandardErrorPath</key>
    <string>__HOME__/.config/yulu/ui.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Validate XML**

```bash
plutil -lint yulu/scripts/com.yulu.ui.plist
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add yulu/scripts/com.yulu.ui.plist
git commit -m "feat(yulu_ui): launchd plist template (com.yulu.ui)"
```

---

## Task A.25 — Real-machine smoke + final commit

**Files:**
- Modify: nothing
- Run: end-to-end on the developer's actual machine

- [ ] **Step 1: Build production bundle**

```bash
cd yulu/scripts/yulu_ui
npm ci
npm run build
```

- [ ] **Step 2: Install plist with placeholders rendered**

```bash
NODE_BIN="$(command -v node)"
SCRIPT_DIR="/Users/liaoyuxing/.yulu/yulu/scripts"
PLIST=~/Library/LaunchAgents/com.yulu.ui.plist
sed -e "s#__NODE_BIN__#${NODE_BIN}#g" \
    -e "s#__SCRIPT_DIR__#${SCRIPT_DIR}#g" \
    -e "s#__HOME__#${HOME}#g" \
    yulu/scripts/com.yulu.ui.plist > "$PLIST"
plutil -lint "$PLIST"
launchctl load "$PLIST"
```

- [ ] **Step 3: Verify health endpoint**

```bash
sleep 2
curl -s http://127.0.0.1:7777/healthz
launchctl list | grep com.yulu.ui
tail -5 ~/.config/yulu/ui.log
```

Expected: `{"status":"ok",...}`, daemon listed, log shows `[yulu_ui] listening on http://127.0.0.1:7777`.

- [ ] **Step 4: Smoke each tRPC router via curl**

```bash
for proc in system.version sidebar.counts daemons.health recording.state config.get; do
  echo "=== $proc ==="
  curl -s "http://127.0.0.1:7777/trpc/${proc}?input=%7B%7D" | head -c 200
  echo
done
```

Expected: each returns JSON shaped `{"result":{"data":...}}`.

- [ ] **Step 5: Smoke search via curl (Phase 6 must already be installed)**

```bash
curl -s 'http://127.0.0.1:7777/trpc/search.run?input=%7B%22query%22%3A%22%E8%BF%9B%E5%BA%A6%22%7D'
```

Expected: JSON with `result.data.hits` (the Chinese `进度` query — 2-char, LIKE fallback expected).

- [ ] **Step 6: Smoke WebSocket**

```bash
npx wscat -c ws://127.0.0.1:7777/ws
> {"type":"subscribe","channel":"recording"}
# in another terminal: yulu status-agent toggle  → expect a push
> ^C
```

Expected: one or more push messages with `{"channel":"recording","payload":...}`.

- [ ] **Step 7: Final commit (no code; reflects readiness)**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git log --oneline -25
# all task commits should be present and pushed
git push -u origin claude/yulu-frontend-spec  # or whatever branch this is on
```

---

## Self-review (run before declaring Phase A done)

Skim the spec § references for each task. Verify:

- [ ] Spec §10 lists 11 tRPC routers — A.9 through A.19 implement all 11. ✓
- [ ] Spec §11 config diff map — A.5 RESTART_MAP covers every key listed. ✓
- [ ] Spec §13 acceptance #1 (server starts + /healthz) — A.22 + A.25 verify. ✓
- [ ] Spec §13 acceptance #6 (search round-trip) — A.11 + A.25 step 5. ✓
- [ ] Spec §13 acceptance #11 (daemons reflect launchctl) — A.15 health() reads real launchctl. ✓
- [ ] Spec §13 acceptance #16 (WS reconnect) — server-side support; client retry deferred to Phase B.
- [ ] Spec §13 acceptance #17 (127.0.0.1 only) — A.22 Host header guard. ✓
- [ ] No `TBD` / `TODO` / "Add appropriate error handling" anywhere.
- [ ] Every file path is concrete (no `<placeholder>`).
- [ ] Type consistency: `AppContext` shape declared in A.8, used in A.9 onward; `ipcSend` signature stable from A.3 onward; `LaunchctlClient` methods stable from A.6 onward.

---

## What's NOT in Phase A (deferred to Phases B–G)

| Phase | Scope | Why deferred |
|---|---|---|
| B | React + Vite + Ayu theme scaffold + sidebar + topbar + floating pill | Frontend is large enough to deserve its own plan; backend must be live to develop against |
| C | Inbox pages (Voicemails / Meetings / Search) | Depends on B's shell |
| D | Settings pages + inline-edit + restart banner | Depends on B + needs config router (done in A) and daemons router (done in A) |
| E | Knowledge pages (Prompts + Glossary editing) | Depends on B + relevant routers (done in A) |
| F | Health pages (Daemons grid + Logs tail) | Depends on B + relevant routers (done in A) |
| G | setup.sh integration, yulu doctor, release packaging | Depends on all of above being shippable |

Each subsequent phase will get its own spec-derived plan written via the same brainstorming → writing-plans cycle.
