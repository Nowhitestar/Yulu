import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const CONFIG_DIR = join(HOME, ".config", "yulu");
const MOVIES_DIR = join(HOME, "Movies", "Yulu");

/**
 * Locate yulu/scripts/ at runtime.
 *
 * 1. YULU_SCRIPT_DIR env var (set by the LaunchAgent installer).
 * 2. Walk up from this file's URL: paths.ts → src → yulu_ui → scripts.
 *
 * Result is the directory containing the native capture scripts and daemon plists.
 */
function locateScriptDir(): string {
  if (process.env.YULU_SCRIPT_DIR) return process.env.YULU_SCRIPT_DIR;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..");
  } catch {
    return resolve(process.cwd(), "..", "..");
  }
}

const SCRIPT_DIR = locateScriptDir();
// Repo root holds the single-source-of-truth VERSION file and (on a release
// install) .yulu-install.json. scriptDir is yulu/scripts, so the root is two
// levels up — the same anchor version.py uses (REPO_DIR = parents[2]).
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");

export const paths = {
  configDir:        CONFIG_DIR,
  configFile:       join(CONFIG_DIR, "config.json"),
  promptsDb:        join(CONFIG_DIR, "prompts.sqlite"),
  vocabDb:          join(CONFIG_DIR, "vocab.sqlite"),
  searchDb:         join(CONFIG_DIR, "search.sqlite"),
  hostDb:           join(CONFIG_DIR, "host.sqlite"),
  agentTasksDir:    join(CONFIG_DIR, "agent-tasks"),
  recordingEventsDir: join(CONFIG_DIR, "recording-events"),
  audioDaemonSock:  join(CONFIG_DIR, "audio_daemon.sock"),
  statusAgentSock:  join(CONFIG_DIR, "status_agent.sock"),
  uiLog:            join(CONFIG_DIR, "ui.log"),
  uiPid:            join(CONFIG_DIR, "yulu_ui.pid"),
  moviesDir:        MOVIES_DIR,
  scriptDir:        SCRIPT_DIR,
  agentQueueJson:   join(CONFIG_DIR, "agent-queue.json"),
  mcpTokenJson:     join(CONFIG_DIR, "mcp-token.json"),
  versionFile:      join(REPO_ROOT, "VERSION"),
  installJson:      join(REPO_ROOT, ".yulu-install.json"),
} as const;
