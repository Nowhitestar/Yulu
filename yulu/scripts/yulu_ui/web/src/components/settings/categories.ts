// web/src/components/settings/categories.ts
// Shared category metadata for the settings UI. Single source of truth for the
// category list order and the i18n keys for each category's label + one-line
// description — consumed by both SettingsCategoryList (the master column) and
// SettingsCategory (detail). The actual display strings live in the i18n
// dictionary (web/src/i18n/messages.ts) under settings.category.<id>.* so they
// localize; resolve a key with the `t` from useT().
import type { SettingCategory } from "../../../../src/settingsRegistry.js";

export interface CategoryMeta {
  id: SettingCategory;
  labelKey: string; // i18n key → localized display name (no emoji — locked by brainstorm)
  descKey: string;  // i18n key → one-line summary shown under the label
}

// The full P1 category set, in display order. `automation` has no registered
// fields yet (meeting_detection lands in P2) but is listed with an empty state
// so the structure is stable.
export const CATEGORIES: CategoryMeta[] = [
  { id: "general",       labelKey: "settings.category.general.label",       descKey: "settings.category.general.desc" },
  { id: "audio",         labelKey: "settings.category.audio.label",         descKey: "settings.category.audio.desc" },
  { id: "transcription", labelKey: "settings.category.transcription.label", descKey: "settings.category.transcription.desc" },
  { id: "llm",           labelKey: "settings.category.llm.label",           descKey: "settings.category.llm.desc" },
  { id: "voice",         labelKey: "settings.category.voice.label",         descKey: "settings.category.voice.desc" },
  { id: "automation",    labelKey: "settings.category.automation.label",    descKey: "settings.category.automation.desc" },
];

export const CATEGORY_ORDER: SettingCategory[] = CATEGORIES.map((c) => c.id);

export function categoryMeta(id: string): CategoryMeta | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

/**
 * i18n key for a category's label; falls back to a generic key that resolves to
 * the raw id when unknown (translate() returns the key itself if missing, and we
 * special-case unknown ids by returning the id directly so a stray category
 * still shows *something* readable).
 */
export function categoryLabelKey(id: string): string {
  return categoryMeta(id)?.labelKey ?? id;
}

/** i18n key for a category's one-line description. */
export function categoryDescKey(id: string): string {
  return categoryMeta(id)?.descKey ?? "";
}
