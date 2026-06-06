// web/src/components/settings/categories.ts
// Shared category metadata for the settings UI. Single source of truth for the
// category list order, Chinese labels, and one-line descriptions — consumed by
// both SettingsCategoryList (the master column) and SettingsCategory (detail).
import type { SettingCategory } from "../../../../src/settingsRegistry.js";

export interface CategoryMeta {
  id: SettingCategory;
  label: string;       // Chinese display name (no emoji — locked by brainstorm)
  description: string; // one-line summary shown under the label
}

// The full P1 category set, in display order. `automation` has no registered
// fields yet (meeting_detection lands in P2) but is listed with an empty state
// so the structure is stable.
export const CATEGORIES: CategoryMeta[] = [
  { id: "general",       label: "通用",     description: "主题、主机能力与关于" },
  { id: "audio",         label: "音频与存储", description: "录音源、输出目录与数据库" },
  { id: "transcription", label: "转写",     description: "Whisper / MLX 引擎与模式" },
  { id: "llm",           label: "摘要 LLM",  description: "摘要生成方式" },
  { id: "automation",    label: "自动化",    description: "会议检测与自动录制" },
  { id: "integrations",  label: "集成",     description: "日历与外部服务" },
  { id: "advanced",      label: "高级",     description: "云转写命令等进阶项" },
];

export const CATEGORY_ORDER: SettingCategory[] = CATEGORIES.map((c) => c.id);

export function categoryMeta(id: string): CategoryMeta | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

/** Chinese label for a category id; falls back to the raw id if unknown. */
export function categoryLabel(id: string): string {
  return categoryMeta(id)?.label ?? id;
}
