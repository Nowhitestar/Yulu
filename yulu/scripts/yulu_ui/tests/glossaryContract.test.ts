import { describe, expect, it } from "vitest";
import {
  applyGlossaryContract,
  buildGlossaryContract,
  loadGlossaryContract,
} from "../src/glossaryContract.js";

describe("glossary contract", () => {
  it("builds STT hints, deterministic aliases, and summary terminology rules", () => {
    const contract = buildGlossaryContract([
      { term: "阿尔法学院", canonical: "阿尔法学院", scope: "both" },
      { term: "阿法学院", canonical: "阿尔法学院", scope: "replace" },
      { term: "Agent King", canonical: "AgentKey", scope: "both" },
      { term: "OpenAI", canonical: "OpenAI", scope: "prompt" },
    ]);

    expect(contract.prompt).toContain("阿尔法学院");
    expect(contract.prompt).toContain("AgentKey");
    expect(contract.prompt).not.toContain("阿法学院");
    expect(applyGlossaryContract("阿法学院和 Agent King", contract))
      .toBe("阿尔法学院和 AgentKey");
    expect(contract.summaryInstruction).toContain("阿法学院 => 阿尔法学院");
    expect(contract.summaryInstruction).toContain("OpenAI");
  });
  it("scopes dictation terminology to aliases and canonical names in the current utterance", () => {
    const rows = [
      { term: "Agent King", canonical: "AgentKey", scope: "both" },
      { term: "阿法学院", canonical: "阿尔法学院", scope: "both" },
      { term: "OpenAI", canonical: "OpenAI", scope: "prompt" },
    ];
    const db = { prepare: () => ({ all: () => rows }) };
    const scoped = loadGlossaryContract(db, "请把 agent king 和阿法学院的名字核对一下");
    expect(scoped.summaryInstruction).toContain("AgentKey");
    expect(scoped.summaryInstruction).toContain("阿尔法学院");
    expect(scoped.summaryInstruction).not.toContain("OpenAI");
    expect(applyGlossaryContract("阿法学院", scoped)).toBe("阿尔法学院");
    expect(loadGlossaryContract(db, "AGENT KEY").summaryInstruction).toContain("AgentKey");
    expect(loadGlossaryContract(db, "明天见").summaryInstruction).toBe("");
    expect(loadGlossaryContract(db).summaryInstruction).toContain("OpenAI");
  });
});
