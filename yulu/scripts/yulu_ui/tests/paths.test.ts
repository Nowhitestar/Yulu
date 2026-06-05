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
  });
});
