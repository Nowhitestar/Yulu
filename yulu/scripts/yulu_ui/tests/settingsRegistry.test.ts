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
  it("output 6 项改完无需动作(agent_queue_worker 每 tick 读)", () => {
    for (const p of ["output.channel", "output.zulip.stream", "output.zulip.topic", "output.notion.database_id", "output.notion.api_key_env", "output.telegram.chat_id"]) {
      expect(reloadFor(p)).toEqual({ kind: "none" });
    }
  });
  it("output.notion.api_key_env 是 env-name 类型(只填变量名,不存密钥)", () => {
    expect(defFor("output.notion.api_key_env")?.type).toBe("env-name");
  });
  it("未注册路径默认 none", () => {
    expect(reloadFor("nope.nope")).toEqual({ kind: "none" });
  });

  it("危险项标 danger:true(改了影响录音/转写,commit 前要确认)", () => {
    for (const p of ["audio.output_dir", "audio.backend", "transcription.local_model_path", "transcription.mlx"]) {
      expect(defFor(p)?.danger).toBe(true);
    }
  });
  it("非危险项不带 danger 标记(确认对话不该拦正常编辑)", () => {
    for (const p of ["transcription.language", "llm.enabled", "meeting_detection.enabled", "output.channel"]) {
      expect(defFor(p)?.danger).toBeFalsy();
    }
  });
  it("danger 子字段经最长前缀继承(transcription.mlx.model → danger)", () => {
    expect(defFor("transcription.mlx.model")?.danger).toBe(true);
  });
});
