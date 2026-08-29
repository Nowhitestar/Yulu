import { homedir } from "node:os";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();

export interface ApplicationDataPaths {
  durableDataDir: string;
  configFile: string;
  modelsDir: string;
  cacheDir: string;
  ipcDir: string;
  logsDir: string;
  mediaLibraryDir: string;
  legacyReadOnlyDataDir: string;
  legacyReadOnlyConfigFile: string;
  configReadFiles: readonly string[];
}

export interface ApplicationDataPathInput {
  homeDir?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  readConfigFile?: (path: string) => string | undefined;
  canonicalize?: (path: string) => string;
}

function defaultReadConfigFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function defaultCanonicalize(path: string): string {
  let existing = path;
  const missing: string[] = [];
  while (true) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  const resolved = realpathSync.native(existing);
  if (!statSync(resolved).isDirectory()) throw new Error("Yulu path ancestor is not a directory");
  return join(resolved, ...missing);
}

function parseAbsolutePath(raw: string | undefined, homeDir: string): string | null {
  const value = raw?.trim();
  if (!value || value.includes("\0")) return null;
  const expanded = value.startsWith("~/") ? join(homeDir, value.slice(2)) : value;
  return isAbsolute(expanded) ? normalize(expanded) : null;
}

function comparisonComponents(value: string): string[] {
  return normalize(value)
    .split("/")
    .filter(Boolean)
    .map((component) => component
      .normalize("NFC")
      .toLocaleLowerCase("en-US")
      .normalize("NFC"));
}

function hasComparisonRoot(path: string, root: string, strict: boolean): boolean {
  const pathComponents = comparisonComponents(path);
  const rootComponents = comparisonComponents(root);
  return pathComponents.length >= rootComponents.length + (strict ? 1 : 0)
    && rootComponents.every((component, index) => component === pathComponents[index]);
}

function isSameOrNested(path: string, root: string): boolean {
  return hasComparisonRoot(path, root, false);
}

function isStrictlyNested(path: string, root: string): boolean {
  return hasComparisonRoot(path, root, true);
}

function overlaps(left: string, right: string): boolean {
  return isSameOrNested(left, right) || isSameOrNested(right, left);
}

function configuredMediaPath(raw: string | undefined, homeDir: string): string | null {
  return parseAbsolutePath(raw, homeDir);
}

function readMediaPath(path: string, homeDir: string, readConfigFile: (path: string) => string | undefined): string | null {
  try {
    const parsed = JSON.parse(readConfigFile(path) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const audio = (parsed as { audio?: unknown }).audio;
    if (!audio || typeof audio !== "object") return null;
    const outputDir = (audio as { output_dir?: unknown }).output_dir;
    return typeof outputDir === "string" ? configuredMediaPath(outputDir, homeDir) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the standard mutable-data contract without reading the real user home.
 *
 * Existing callers keep their legacy fields below until #162/#163 migrate them.
 * The legacy root is exposed only as an ordered compatibility read candidate;
 * every write-authoritative path in this contract points at a standard location.
 */
export function resolveApplicationDataPaths(
  input: ApplicationDataPathInput = {},
): ApplicationDataPaths {
  const homeDir = input.homeDir ?? homedir();
  const environment = input.environment ?? process.env;
  if (!isAbsolute(homeDir)) throw new Error("Yulu application path home must be absolute");
  const canonicalize = input.canonicalize ?? defaultCanonicalize;
  const canonical = (path: string): string | null => {
    try {
      const resolved = normalize(canonicalize(normalize(path)));
      return isAbsolute(resolved) && !resolved.includes("\0") ? resolved : null;
    } catch {
      return null;
    }
  };
  const requiredCanonical = (path: string, name: string): string => {
    const resolved = canonical(path);
    if (!resolved) throw new Error(`unsafe Yulu standard path: ${name}`);
    return resolved;
  };
  const defaultDurable = join(homeDir, "Library", "Application Support", "Yulu");
  const defaultCache = join(homeDir, "Library", "Caches", "Yulu");
  const defaultLogs = join(homeDir, "Library", "Logs", "Yulu");
  const defaultMedia = join(homeDir, "Movies", "Yulu");
  const defaultLegacy = join(homeDir, ".config", "yulu");
  const choose = (
    name: string,
    fallback: string,
    safe: (canonicalPath: string) => boolean,
  ): string => {
    const configured = parseAbsolutePath(environment[name], homeDir);
    const candidate = configured ? canonical(configured) : null;
    if (candidate && safe(candidate)) return candidate;
    const resolvedFallback = requiredCanonical(fallback, name);
    if (!safe(resolvedFallback)) throw new Error(`unsafe Yulu standard path: ${name}`);
    return resolvedFallback;
  };

  const defaultLegacyCanonical = requiredCanonical(defaultLegacy, "YULU_LEGACY_READ_ONLY_DATA_DIR");
  const defaultMediaCanonical = requiredCanonical(defaultMedia, "YULU_MEDIA_LIBRARY_DIR");
  const durableDataDir = choose(
    "YULU_APPLICATION_SUPPORT_DIR",
    defaultDurable,
    (candidate) => !overlaps(candidate, defaultLegacyCanonical) && !overlaps(candidate, defaultMediaCanonical),
  );
  const durableCanonical = durableDataDir;
  const configFile = join(durableDataDir, "config.json");
  const cacheDir = choose(
    "YULU_CACHE_DIR",
    defaultCache,
    (candidate) => !overlaps(candidate, durableCanonical)
      && !overlaps(candidate, defaultLegacyCanonical)
      && !overlaps(candidate, defaultMediaCanonical),
  );
  const cacheCanonical = cacheDir;
  const logsDir = choose(
    "YULU_LOG_DIR",
    defaultLogs,
    (candidate) => !overlaps(candidate, durableCanonical)
      && !overlaps(candidate, cacheCanonical)
      && !overlaps(candidate, defaultLegacyCanonical)
      && !overlaps(candidate, defaultMediaCanonical),
  );
  const logsCanonical = logsDir;
  const modelsDir = choose(
    "YULU_MODELS_DIR",
    join(durableDataDir, "Models"),
    (candidate) => isStrictlyNested(candidate, durableCanonical),
  );
  const ipcDir = choose(
    "YULU_IPC_DIR",
    cacheDir,
    (candidate) => isSameOrNested(candidate, cacheCanonical),
  );
  const legacyReadOnlyDataDir = choose(
    "YULU_LEGACY_READ_ONLY_DATA_DIR",
    defaultLegacy,
    (candidate) => !overlaps(candidate, durableCanonical)
      && !overlaps(candidate, cacheCanonical)
      && !overlaps(candidate, logsCanonical)
      && !overlaps(candidate, defaultMediaCanonical),
  );
  const legacyCanonical = legacyReadOnlyDataDir;
  const legacyReadOnlyConfigFile = join(legacyReadOnlyDataDir, "config.json");
  const configReadFiles = [configFile, legacyReadOnlyConfigFile];
  const readConfigFile = input.readConfigFile ?? defaultReadConfigFile;
  const mediaCandidates = [
    configuredMediaPath(environment.YULU_MEDIA_LIBRARY_DIR, homeDir),
    ...configReadFiles.map((path) => readMediaPath(path, homeDir, readConfigFile)),
    defaultMedia,
  ];
  let mediaLibraryDir: string | null = null;
  for (const candidate of mediaCandidates) {
    const resolved = candidate ? canonical(candidate) : null;
    if (resolved
      && !overlaps(resolved, durableCanonical)
      && !overlaps(resolved, cacheCanonical)
      && !overlaps(resolved, logsCanonical)
      && !overlaps(resolved, legacyCanonical)) {
      mediaLibraryDir = resolved;
      break;
    }
  }
  if (!mediaLibraryDir) throw new Error("no safe Yulu Media Library path");

  return {
    durableDataDir,
    configFile,
    modelsDir,
    cacheDir,
    ipcDir,
    logsDir,
    mediaLibraryDir,
    legacyReadOnlyDataDir,
    legacyReadOnlyConfigFile,
    configReadFiles,
  };
}

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

/** Resolve Host/Web paths while #163 still owns Capture, IPC, logs, and media. */
export function resolveHostPaths(input: ApplicationDataPathInput = {}) {
  const application = resolveApplicationDataPaths(input);
  const homeDir = input.homeDir ?? homedir();
  const legacyDir = application.legacyReadOnlyDataDir;
  const durableDir = application.durableDataDir;
  return {
    ...application,
    configDir:          legacyDir,
    configFile:         application.configFile,
    promptsDb:          join(durableDir, "prompts.sqlite"),
    vocabDb:            join(durableDir, "vocab.sqlite"),
    searchDb:           join(durableDir, "search.sqlite"),
    hostDb:             join(durableDir, "host.sqlite"),
    agentTasksDir:      join(durableDir, "agent-tasks"),
    recordingEventsDir: join(legacyDir, "recording-events"),
    agentQueueJson:     join(legacyDir, "agent-queue.json"),
    mcpTokenJson:       join(durableDir, "mcp-token.json"),
    audioDaemonSock:    join(legacyDir, "audio_daemon.sock"),
    statusAgentSock:    join(legacyDir, "status_agent.sock"),
    uiLog:              join(legacyDir, "ui.log"),
    uiPid:              join(legacyDir, "yulu_ui.pid"),
    moviesDir:          join(homeDir, "Movies", "Yulu"),
    launchAgentsDir:    join(homeDir, "Library", "LaunchAgents"),
    scriptDir:          SCRIPT_DIR,
    versionFile:        join(REPO_ROOT, "VERSION"),
    installJson:        join(REPO_ROOT, ".yulu-install.json"),
  };
}

export const paths = resolveHostPaths({ homeDir: HOME });
