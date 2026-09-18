/** Presentation categories are independent of the persisted settings registry. */
export type SettingsCategoryId = "general" | "recording" | "meetings" | "voice" | "connections";

export interface CategoryMeta {
  id: SettingsCategoryId;
  labelKey: string;
  descKey: string;
}

export const CATEGORIES: CategoryMeta[] = ["general", "recording", "meetings", "voice", "connections"].map((id) => ({
  id: id as SettingsCategoryId,
  labelKey: `settings.category.${id}.label`,
  descKey: `settings.category.${id}.desc`,
}));

const LEGACY_CATEGORIES: Record<string, { id: SettingsCategoryId; hash: string }> = {
  audio: { id: "recording", hash: "#audio" },
  storage: { id: "recording", hash: "#storage" },
  transcription: { id: "recording", hash: "#transcription" },
  llm: { id: "connections", hash: "#ai-connections" },
  sharing: { id: "connections", hash: "#sharing" },
  integrations: { id: "meetings", hash: "#calendar-source" },
  automation: { id: "meetings", hash: "#automation" },
  hotkey: { id: "general", hash: "#hotkey" },
};

export function settingsTarget(category: string, hash = "", path = "") {
  // Preserve older remediation links to individual connections and connectors.
  if (category === "integrations" && hash === "#agent-calendar-connector") return { id: "connections", hash };
  if (path.startsWith("agent_pipeline.")) return { id: "recording", hash: "#recording-processing" };
  const legacy = LEGACY_CATEGORIES[category];
  return { id: legacy?.id ?? category, hash: hash || legacy?.hash || "" };
}

export const CATEGORY_ORDER = CATEGORIES.map((category) => category.id);

export function categoryMeta(id: string): CategoryMeta | undefined {
  return CATEGORIES.find((category) => category.id === settingsTarget(id).id);
}

export function categoryLabelKey(id: string): string {
  return categoryMeta(id)?.labelKey ?? id;
}

export function categoryDescKey(id: string): string {
  return categoryMeta(id)?.descKey ?? "";
}
