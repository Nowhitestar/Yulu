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
  it("language is an Agent input and applies without daemon reload", () => {
    const def = defFor("transcription.language");
    expect(def?.type).toBe("select");
    for (const language of ["zh", "en", "ja", "auto"]) {
      expect(def?.validate.safeParse(language).success).toBe(true);
    }
    expect(def?.validate.safeParse("fr").success).toBe(false);
    expect(reloadFor("transcription.language")).toEqual({ kind: "none" });
  });
  it("local hybrid caption strategy applies without restarting capture", () => {
    const def = defFor("realtime_captions.strategy");
    expect(def?.validate.safeParse("local-hybrid").success).toBe(true);
    expect(def?.validate.safeParse("agent-only").success).toBe(true);
    expect(def?.validate.safeParse("cloud").success).toBe(false);
    expect(reloadFor("realtime_captions.strategy")).toEqual({ kind: "none" });
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
  it("does not register retired Yulu-owned transcription settings", () => {
    for (const path of [
      "transcription.mode",
      "transcription.post_recording_mode",
      "transcription.final_engine",
      "transcription.local_model_path",
      "transcription.mlx",
      "transcription.hermes",
      "transcription.realtime",
      "transcription.realtime_enabled",
      "transcription.whisper_cli",
      "transcription.cloud_command",
      "transcription.diarization",
    ]) {
      expect(defFor(path)).toBeUndefined();
    }
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
  it("does not register retired Yulu connector or output settings", () => {
    expect(defFor("connectors.telegram.send_summary")).toBeUndefined();
    expect(defFor("connectors.notion.send_summary")).toBeUndefined();
    expect(defFor("connectors.zulip.send_summary")).toBeUndefined();
    expect(defFor("output.telegram.chat_id")).toBeUndefined();
    expect(defFor("output.channel")).toBeUndefined();
  });
  it("Agent runtime, calendar, and pipeline controls remain hidden compatibility settings", () => {
    for (const p of [
      "llm.enabled",
      "llm.command",
      "llm.agent.provider",
      "calendars",
      "connectors.gog.read_calendar",
      "agent_pipeline.auto_send_notion",
    ]) {
      expect(defFor(p)?.hidden).toBe(true);
    }
  });
  it("未注册路径默认 none", () => {
    expect(reloadFor("nope.nope")).toEqual({ kind: "none" });
  });

  it("危险项标 danger:true(改了影响录音,commit 前要确认)", () => {
    for (const p of ["audio.output_dir", "audio.backend"]) {
      expect(defFor(p)?.danger).toBe(true);
    }
  });
  it("非危险项不带 danger 标记(确认对话不该拦正常编辑)", () => {
    for (const p of ["transcription.language", "llm.enabled", "meeting_detection.enabled", "agent_pipeline.auto_send_notion"]) {
      expect(defFor(p)?.danger).toBeFalsy();
    }
  });
  it("no reload action references the retired STT daemon", () => {
    expect(JSON.stringify(SETTINGS.map((setting) => setting.reload))).not.toContain("sttdaemon");
  });
});
