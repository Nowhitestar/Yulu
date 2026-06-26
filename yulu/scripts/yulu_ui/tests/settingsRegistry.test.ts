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
  it("status_agent.enabled 保存后由 config router 直接 start/stop,不走重启横幅", () => {
    expect(reloadFor("status_agent.enabled")).toEqual({ kind: "none" });
  });
  it("silence_duration_sec 默认 300 秒在可配置范围内", () => {
    const def = defFor("audio.silence_duration_sec");
    expect(def?.validate.safeParse(300).success).toBe(true);
    expect(def?.validate.safeParse(3601).success).toBe(false);
  });
  it("post_recording_mode 是 select,枚举校验,reload none(transcribe.py 每次读)", () => {
    const def = defFor("transcription.post_recording_mode");
    expect(def?.type).toBe("select");
    expect(reloadFor("transcription.post_recording_mode")).toEqual({ kind: "none" });
    expect(def?.validate.safeParse("fast_summary").success).toBe(true);
    expect(def?.validate.safeParse("full_transcribe").success).toBe(true);
    expect(def?.validate.safeParse("nonsense").success).toBe(false);
  });
  it("diarization 设置映射到 sttdaemon restart,且 num_speakers 支持 auto(null)", () => {
    expect(reloadFor("transcription.diarization.enabled")).toEqual({ kind: "restart", daemons: ["sttdaemon"] });
    expect(reloadFor("transcription.diarization.provider")).toEqual({ kind: "restart", daemons: ["sttdaemon"] });
    expect(defFor("transcription.diarization.provider")?.validate.safeParse("sherpa-onnx").success).toBe(true);
    expect(defFor("transcription.diarization.provider")?.validate.safeParse("other").success).toBe(false);
    const count = defFor("transcription.diarization.num_speakers");
    expect(count?.validate.safeParse(null).success).toBe(true);
    expect(count?.validate.safeParse(3).success).toBe(true);
    expect(count?.validate.safeParse(0).success).toBe(false);
    expect(count?.validate.safeParse(9).success).toBe(false);
    const threshold = defFor("transcription.diarization.threshold");
    expect(threshold?.validate.safeParse(0.5).success).toBe(true);
    expect(threshold?.validate.safeParse(2).success).toBe(false);
  });
  it("meeting_detection 4 项改完都要 restart detector", () => {
    for (const p of ["meeting_detection.enabled", "meeting_detection.interval_sec", "meeting_detection.stable_sec", "meeting_detection.prompt_cooldown_sec"]) {
      expect(reloadFor(p)).toEqual({ kind: "restart", daemons: ["detector"] });
    }
  });
  it("meeting_detection 5 个大数组是 command 类型、restart detector、标 advanced(P3-2)", () => {
    for (const p of ["meeting_detection.window_keywords", "meeting_detection.app_name_hints", "meeting_detection.target_app_names", "meeting_detection.dedicated_meeting_apps", "meeting_detection.ignore_window_keywords"]) {
      const def = defFor(p);
      expect(def?.type).toBe("command");
      expect(def?.advanced).toBe(true);
      expect(reloadFor(p)).toEqual({ kind: "restart", daemons: ["detector"] });
      expect(def?.validate.safeParse(["Zoom", "Meet"]).success).toBe(true);
      expect(def?.validate.safeParse("not-an-array").success).toBe(false);
    }
  });
  it("output 9 项改完无需动作(agent_queue_worker 每 tick 读)", () => {
    for (const p of [
      "output.channel",
      "output.notion.destination_id",
      "output.notion.destination_type",
      "output.notion.destination_label",
      "output.zulip.stream_id",
      "output.zulip.stream",
      "output.zulip.topic",
      "output.notion.database_id",
      "output.notion.api_key_env",
    ]) {
      expect(reloadFor(p)).toEqual({ kind: "none" });
    }
  });
  it("does not register Telegram output settings", () => {
    expect(defFor("connectors.telegram.send_summary")).toBeUndefined();
    expect(defFor("output.telegram.chat_id")).toBeUndefined();
    expect(defFor("output.channel")?.validate.safeParse("telegram").success).toBe(false);
  });
  it("output.notion.api_key_env 是 env-name 类型(只填变量名,不存密钥)", () => {
    expect(defFor("output.notion.api_key_env")?.type).toBe("env-name");
  });
  it("Agent Console 迁移后,旧 AI runtime/LLM/output/calendar 设置仅保留为隐藏兼容项", () => {
    for (const p of [
      "llm.enabled",
      "llm.command",
      "llm.agent.provider",
      "calendars",
      "connectors.notion.send_summary",
      "connectors.zulip.send_summary",
      "connectors.gog.read_calendar",
      "output.channel",
      "output.notion.destination_id",
      "output.zulip.stream",
    ]) {
      expect(defFor(p)?.hidden).toBe(true);
    }
  });
  it("未注册路径默认 none", () => {
    expect(reloadFor("nope.nope")).toEqual({ kind: "none" });
  });

  it("危险项标 danger:true(改了影响录音/转写,commit 前要确认)", () => {
    for (const p of ["audio.output_dir", "audio.backend", "transcription.local_model_path", "transcription.mlx", "transcription.diarization.seg_model", "transcription.diarization.emb_model"]) {
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
