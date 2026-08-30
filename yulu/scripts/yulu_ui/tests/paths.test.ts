import { describe, it, expect } from "vitest";
import { resolveApplicationDataPaths, resolveHostPaths } from "../src/paths.js";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("paths", () => {
  it("moves Host writable authority to standard data while keeping legacy reads explicit", () => {
    const home = "/test/home";
    const resolved = resolveHostPaths({ homeDir: home, environment: {} });

    expect(resolved.durableDataDir).toBe(`${home}/Library/Application Support/Yulu`);
    expect(resolved.configDir).toBe(`${home}/Library/Application Support/Yulu`);
    expect(resolved.configFile).toBe(`${home}/Library/Application Support/Yulu/config.json`);
    expect(resolved.promptsDb).toBe(`${home}/Library/Application Support/Yulu/prompts.sqlite`);
    expect(resolved.vocabDb).toBe(`${home}/Library/Application Support/Yulu/vocab.sqlite`);
    expect(resolved.searchDb).toBe(`${home}/Library/Application Support/Yulu/search.sqlite`);
    expect(resolved.hostDb).toBe(`${home}/Library/Application Support/Yulu/host.sqlite`);
    expect(resolved.agentTasksDir).toBe(`${home}/Library/Application Support/Yulu/agent-tasks`);
    expect(resolved.recordingEventsDir).toBe(`${home}/Library/Application Support/Yulu/recording-events`);
    expect(resolved.agentQueueJson).toBe(`${home}/Library/Application Support/Yulu/agent-queue.json`);
    expect(resolved.legacyAgentQueueJson).toBe(`${home}/.config/yulu/agent-queue.json`);
    expect(resolved.mcpTokenJson).toBe(`${home}/Library/Application Support/Yulu/mcp-token.json`);
    expect(resolved.modelsDir).toBe(`${home}/Library/Application Support/Yulu/Models`);

    expect(resolved.legacyReadOnlyDataDir).toBe(`${home}/.config/yulu`);
    expect(resolved.audioDaemonSock).toBe(`${home}/Library/Caches/Yulu/audio_daemon.sock`);
    expect(resolved.statusAgentSock).toBe(`${home}/Library/Caches/Yulu/status_agent.sock`);
    expect(resolved.uiLog).toBe(`${home}/Library/Logs/Yulu/ui.log`);
    expect(resolved.uiPid).toBe(`${home}/Library/Caches/Yulu/yulu_ui.pid`);
    expect(resolved.moviesDir).toBe(`${home}/Movies/Yulu`);
  });

  it("resolves the standard Application Data Root contract from an injected home", () => {
    const homeDir = "/test/home";
    const resolved = resolveApplicationDataPaths({ homeDir, environment: {} });

    expect(resolved).toEqual({
      durableDataDir: "/test/home/Library/Application Support/Yulu",
      configFile: "/test/home/Library/Application Support/Yulu/config.json",
      modelsDir: "/test/home/Library/Application Support/Yulu/Models",
      cacheDir: "/test/home/Library/Caches/Yulu",
      ipcDir: "/test/home/Library/Caches/Yulu",
      logsDir: "/test/home/Library/Logs/Yulu",
      mediaLibraryDir: "/test/home/Movies/Yulu",
      legacyReadOnlyDataDir: "/test/home/.config/yulu",
      legacyReadOnlyConfigFile: "/test/home/.config/yulu/config.json",
      configReadFiles: [
        "/test/home/Library/Application Support/Yulu/config.json",
        "/test/home/.config/yulu/config.json",
      ],
    });
  });

  it("keeps an explicitly configured Media Library outside operational roots", () => {
    const resolved = resolveApplicationDataPaths({
      homeDir: "/test/home",
      environment: { YULU_MEDIA_LIBRARY_DIR: "/Volumes/Archive/Yulu" },
    });

    expect(resolved.mediaLibraryDir).toBe("/Volumes/Archive/Yulu");
    expect(resolved.mediaLibraryDir.startsWith(resolved.durableDataDir)).toBe(false);
    expect(resolved.mediaLibraryDir.startsWith(resolved.cacheDir)).toBe(false);
    expect(resolved.mediaLibraryDir.startsWith(resolved.logsDir)).toBe(false);
    expect(resolved.configReadFiles).toEqual([
      resolved.configFile,
      resolved.legacyReadOnlyConfigFile,
    ]);
    expect(resolveHostPaths({
      homeDir: "/test/home",
      environment: { YULU_MEDIA_LIBRARY_DIR: "/Volumes/Archive/Yulu" },
    }).moviesDir).toBe("/Volumes/Archive/Yulu");
  });

  it("uses one Media Library precedence across environment, standard config, legacy config, and default", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "yulu-path-contract-"));
    const canonicalHome = realpathSync.native(homeDir);
    const standardConfig = join(homeDir, "Library", "Application Support", "Yulu", "config.json");
    const legacyConfig = join(homeDir, ".config", "yulu", "config.json");
    mkdirSync(join(standardConfig, ".."), { recursive: true });
    mkdirSync(join(legacyConfig, ".."), { recursive: true });
    writeFileSync(legacyConfig, JSON.stringify({ audio: { output_dir: "~/Legacy Media/Yulu" } }));
    writeFileSync(standardConfig, JSON.stringify({ audio: { output_dir: "~/Standard Media/Yulu" } }));

    try {
      expect(resolveApplicationDataPaths({ homeDir, environment: {} }).mediaLibraryDir)
        .toBe(join(canonicalHome, "Standard Media", "Yulu"));

      unlinkSync(standardConfig);
      expect(resolveApplicationDataPaths({ homeDir, environment: {} }).mediaLibraryDir)
        .toBe(join(canonicalHome, "Legacy Media", "Yulu"));

      expect(resolveApplicationDataPaths({
        homeDir,
        environment: { YULU_MEDIA_LIBRARY_DIR: join(homeDir, "Environment Media", "Yulu") },
      }).mediaLibraryDir).toBe(join(canonicalHome, "Environment Media", "Yulu"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back safely from relative, traversing, colliding, and symlink-equivalent roots", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "yulu-path-validation-"));
    const canonicalHome = realpathSync.native(homeDir);
    const durable = join(homeDir, "Library", "Application Support", "Yulu");
    const cache = join(homeDir, "Library", "Caches", "Yulu");
    const legacy = join(homeDir, ".config", "yulu");
    const mediaAlias = join(homeDir, "media-alias");
    const legacyAlias = join(homeDir, "legacy-alias");
    mkdirSync(durable, { recursive: true });
    mkdirSync(cache, { recursive: true });
    symlinkSync(cache, mediaAlias);
    symlinkSync(durable, legacyAlias);

    try {
      const resolved = resolveApplicationDataPaths({
        homeDir,
        environment: {
          YULU_APPLICATION_SUPPORT_DIR: "../relative-data",
          YULU_MODELS_DIR: legacy,
          YULU_CACHE_DIR: join(cache, "..", "..", "Application Support", "Yulu"),
          YULU_IPC_DIR: join(homeDir, "outside-ipc"),
          YULU_LOG_DIR: durable,
          YULU_MEDIA_LIBRARY_DIR: mediaAlias,
          YULU_LEGACY_READ_ONLY_DATA_DIR: legacyAlias,
        },
      });

      expect(resolved.durableDataDir).toBe(realpathSync.native(durable));
      expect(resolved.modelsDir).toBe(join(realpathSync.native(durable), "Models"));
      expect(resolved.cacheDir).toBe(realpathSync.native(cache));
      expect(resolved.ipcDir).toBe(realpathSync.native(cache));
      expect(resolved.logsDir).toBe(join(canonicalHome, "Library", "Logs", "Yulu"));
      expect(resolved.mediaLibraryDir).toBe(join(canonicalHome, "Movies", "Yulu"));
      expect(resolved.legacyReadOnlyDataDir).toBe(join(canonicalHome, ".config", "yulu"));
      expect(resolved.configReadFiles).toEqual([
        join(realpathSync.native(durable), "config.json"),
        join(canonicalHome, ".config", "yulu", "config.json"),
      ]);

      const legacyMediaCollision = resolveApplicationDataPaths({
        homeDir,
        environment: {
          YULU_LEGACY_READ_ONLY_DATA_DIR: join(homeDir, "Movies", "Yulu"),
        },
      });
      expect(legacyMediaCollision.legacyReadOnlyDataDir).toBe(join(canonicalHome, ".config", "yulu"));
      expect(legacyMediaCollision.mediaLibraryDir).toBe(join(canonicalHome, "Movies", "Yulu"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("skips malformed and unusable Media candidates without breaking precedence", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "yulu-path-malformed-"));
    const canonicalHome = realpathSync.native(homeDir);
    const standardConfig = join(homeDir, "Library", "Application Support", "Yulu", "config.json");
    const legacyConfig = join(homeDir, ".config", "yulu", "config.json");
    const loop = join(homeDir, "media-loop");
    const dangling = join(homeDir, "media-dangling");
    const blocked = join(homeDir, "not-a-directory");
    const standardMedia = join(homeDir, "Standard Media", "Yulu");
    const legacyMedia = join(homeDir, "Legacy Media", "Yulu");
    mkdirSync(join(standardConfig, ".."), { recursive: true });
    mkdirSync(join(legacyConfig, ".."), { recursive: true });
    symlinkSync("media-loop", loop);
    symlinkSync(join(homeDir, "missing-target"), dangling);
    writeFileSync(blocked, "file");
    writeFileSync(standardConfig, JSON.stringify({ audio: { output_dir: standardMedia } }));
    writeFileSync(legacyConfig, JSON.stringify({ audio: { output_dir: legacyMedia } }));

    try {
      expect(resolveApplicationDataPaths({
        homeDir,
        environment: { YULU_MEDIA_LIBRARY_DIR: loop },
      }).mediaLibraryDir).toBe(join(canonicalHome, "Standard Media", "Yulu"));

      writeFileSync(standardConfig, JSON.stringify({ audio: { output_dir: `${homeDir}/bad\0path` } }));
      expect(resolveApplicationDataPaths({ homeDir, environment: {} }).mediaLibraryDir)
        .toBe(join(canonicalHome, "Legacy Media", "Yulu"));

      writeFileSync(standardConfig, JSON.stringify({ audio: { output_dir: dangling } }));
      writeFileSync(legacyConfig, JSON.stringify({ audio: { output_dir: join(blocked, "child") } }));
      expect(resolveApplicationDataPaths({ homeDir, environment: {} }).mediaLibraryDir)
        .toBe(join(canonicalHome, "Movies", "Yulu"));

      writeFileSync(standardConfig, JSON.stringify({ audio: { output_dir: standardMedia } }));
      expect(resolveApplicationDataPaths({
        homeDir,
        environment: { YULU_MEDIA_LIBRARY_DIR: join(homeDir, "realpath-error") },
        canonicalize: (path) => {
          if (path.endsWith("realpath-error")) throw new Error("injected canonicalization failure");
          return path.startsWith(canonicalHome) ? path : path.replace(homeDir, canonicalHome);
        },
      }).mediaLibraryDir).toBe(join(canonicalHome, "Standard Media", "Yulu"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("returns canonical targets that survive configured symlink replacement", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "yulu-path-stable-"));
    const durableTarget = join(homeDir, "targets", "durable");
    const mediaTarget = join(homeDir, "targets", "media");
    const durableAlias = join(homeDir, "durable-alias");
    const mediaAlias = join(homeDir, "media-alias");
    const legacy = join(homeDir, ".config", "yulu");
    mkdirSync(durableTarget, { recursive: true });
    mkdirSync(mediaTarget, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    symlinkSync(durableTarget, durableAlias);
    symlinkSync(mediaTarget, mediaAlias);

    try {
      const resolved = resolveApplicationDataPaths({
        homeDir,
        environment: {
          YULU_APPLICATION_SUPPORT_DIR: durableAlias,
          YULU_MEDIA_LIBRARY_DIR: mediaAlias,
        },
      });
      const canonicalDurable = realpathSync.native(durableTarget);
      const canonicalMedia = realpathSync.native(mediaTarget);

      expect(resolved.durableDataDir).toBe(canonicalDurable);
      expect(resolved.configFile).toBe(join(canonicalDurable, "config.json"));
      expect(resolved.modelsDir).toBe(join(canonicalDurable, "Models"));
      expect(resolved.mediaLibraryDir).toBe(canonicalMedia);

      unlinkSync(durableAlias);
      unlinkSync(mediaAlias);
      symlinkSync(legacy, durableAlias);
      symlinkSync(legacy, mediaAlias);

      expect(resolved.durableDataDir).toBe(canonicalDurable);
      expect(resolved.mediaLibraryDir).toBe(canonicalMedia);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects case-folded and canonically equivalent Media collisions", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "yulu-path-casefold-"));
    const canonicalHome = realpathSync.native(homeDir);
    const defaultMedia = join(canonicalHome, "Movies", "Yulu");

    try {
      const caseAlias = resolveApplicationDataPaths({
        homeDir,
        environment: {
          YULU_MEDIA_LIBRARY_DIR: join(homeDir, "Library", "Application Support", "yulu"),
        },
      });
      expect(caseAlias.mediaLibraryDir).toBe(defaultMedia);

      const caseEqualModels = resolveApplicationDataPaths({
        homeDir,
        environment: {
          YULU_MODELS_DIR: join(homeDir, "Library", "Application Support", "yulu"),
        },
      });
      expect(caseEqualModels.modelsDir).toBe(
        join(canonicalHome, "Library", "Application Support", "Yulu", "Models"),
      );

      const nestedCaseAlias = resolveApplicationDataPaths({
        homeDir,
        environment: {
          YULU_MEDIA_LIBRARY_DIR: join(homeDir, "Library", "Application Support", "yULU", "Recordings"),
        },
      });
      expect(nestedCaseAlias.mediaLibraryDir).toBe(defaultMedia);

      const composedDurable = join(homeDir, "Operational", "M\u00e9dia");
      const decomposedNestedMedia = join(homeDir, "operational", "ME\u0301DIA", "Recordings");
      const unicodeAlias = resolveApplicationDataPaths({
        homeDir,
        environment: {
          YULU_APPLICATION_SUPPORT_DIR: composedDurable,
          YULU_MEDIA_LIBRARY_DIR: decomposedNestedMedia,
        },
      });
      expect(unicodeAlias.durableDataDir).toBe(join(canonicalHome, "Operational", "M\u00e9dia"));
      expect(unicodeAlias.mediaLibraryDir).toBe(defaultMedia);

      const unicodeEqualModels = resolveApplicationDataPaths({
        homeDir,
        environment: {
          YULU_APPLICATION_SUPPORT_DIR: composedDurable,
          YULU_MODELS_DIR: join(homeDir, "operational", "ME\u0301DIA"),
        },
      });
      expect(unicodeEqualModels.modelsDir).toBe(
        join(canonicalHome, "Operational", "M\u00e9dia", "Models"),
      );
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
