// tests/settingsRegistry.test.ts
import { describe, it, expect } from "vitest";
import { SETTINGS, defFor, reloadFor } from "../src/settingsRegistry.js";

describe("settingsRegistry", () => {
  it("每个条目都有 path/category/validate/reload", () => {
    for (const d of SETTINGS) {
      expect(d.path).toBeTruthy();
      expect(d.category).toBeTruthy();
      expect(d.validate).toBeDefined();
      expect(d.reload).toBeDefined();
    }
  });
  it("最长前缀匹配:transcription.mlx.model 命中 transcription.mlx", () => {
    expect(defFor("transcription.mlx.model")?.path).toBe("transcription.mlx");
  });
  it("language 改完要重启 sttdaemon(修正旧 sighup 错映射)", () => {
    expect(reloadFor("transcription.language")).toEqual({ kind: "restart", daemons: ["sttdaemon"] });
  });
  it("llm.command 改完无需动作(读取即生效)", () => {
    expect(reloadFor("llm.command")).toEqual({ kind: "none" });
  });
  it("post_recording_mode 是 select,枚举校验,reload none(transcribe.py 每次读)", () => {
    const def = defFor("transcription.post_recording_mode");
    expect(def?.type).toBe("select");
    expect(reloadFor("transcription.post_recording_mode")).toEqual({ kind: "none" });
    expect(def?.validate.safeParse("fast_summary").success).toBe(true);
    expect(def?.validate.safeParse("full_transcribe").success).toBe(true);
    expect(def?.validate.safeParse("nonsense").success).toBe(false);
  });
  it("meeting_detection 4 项改完都要 restart detector", () => {
    for (const p of ["meeting_detection.enabled", "meeting_detection.interval_sec", "meeting_detection.stable_sec", "meeting_detection.prompt_cooldown_sec"]) {
      expect(reloadFor(p)).toEqual({ kind: "restart", daemons: ["detector"] });
    }
  });
  it("未注册路径默认 none", () => {
    expect(reloadFor("nope.nope")).toEqual({ kind: "none" });
  });
});
