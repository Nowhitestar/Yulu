// web/src/hooks/useSettingsSchema.ts
import { trpc } from "../trpc.js";
import type { SettingMeta } from "../../../src/routers/config.js";

export type { SettingMeta };

/**
 * The settings registry metadata, served by the `config.schema` tRPC query.
 * This is the SPA's single source of truth for which settings exist, their
 * category, label, help text, input type, and reload behaviour — the UI never
 * re-declares the schema. Returns `SettingMeta[]` (or `undefined` while loading).
 */
export function useSettingsSchema() {
  return trpc.config.schema.useQuery(undefined, {
    // The registry is static for a server lifetime; no need to refetch.
    staleTime: Infinity,
  });
}
