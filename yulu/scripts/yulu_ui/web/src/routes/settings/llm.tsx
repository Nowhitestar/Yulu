import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";
export const handle = { breadcrumb: "Settings / LLM", filters: null };
export function SettingsLlm() {
  const { data } = trpc.config.get.useQuery();
  return <Placeholder phase="D" backendNote={`config.get loaded; llm.enabled = ${String((data as any)?.llm?.enabled ?? "?")}`} />;
}
