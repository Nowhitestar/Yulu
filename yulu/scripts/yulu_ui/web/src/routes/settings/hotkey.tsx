import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";
export const handle = { breadcrumb: "Settings / Hotkey & UI", filters: null };
export function SettingsHotkey() {
  const { data } = trpc.config.get.useQuery();
  return <Placeholder phase="D" backendNote={`hotkey key = ${(data as any)?.status_agent?.hotkey?.key ?? "?"}`} />;
}
