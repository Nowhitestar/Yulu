import { afterEach, describe, expect, it, vi } from "vitest";
import { accessSync } from "node:fs";
import { discoverAgentConnectionCandidates } from "../src/agentConnectionDiscovery.js";

vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(),
  accessSync: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

describe("Agent runtime discovery", () => {
  it("offers an installed desktop Codex alongside PATH without executing or selecting either", () => {
    const available = new Set([
      "/runtime/bin/codex", "/Applications/ChatGPT.app/Contents/Resources/codex",
    ]);
    vi.mocked(accessSync).mockImplementation(path => {
      if (!available.has(String(path))) throw new Error("not installed");
    });
    expect(discoverAgentConnectionCandidates({PATH:"/runtime/bin"}, "darwin")).toEqual([
      {adapter:"codex",label:"Codex",path:"/runtime/bin/codex"},
      {candidateId:"candidate:codex:desktop:chatgpt",adapter:"codex",label:"Codex (ChatGPT desktop)",path:"/Applications/ChatGPT.app/Contents/Resources/codex"},
    ]);
  });

  it("keeps desktop Apps optional and does not scan macOS App paths on other platforms", () => {
    vi.mocked(accessSync).mockImplementation(() => { throw new Error("not installed"); });
    expect(discoverAgentConnectionCandidates({PATH:"/runtime/bin"}, "linux")).toEqual([]);
    expect(vi.mocked(accessSync).mock.calls.some(([path]) => String(path).startsWith("/Applications/"))).toBe(false);
  });
});
