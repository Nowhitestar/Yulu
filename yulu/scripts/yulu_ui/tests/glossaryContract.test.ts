import { describe, expect, it } from "vitest";
import {
  applyGlossaryContract,
  buildGlossaryContract,
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
});
