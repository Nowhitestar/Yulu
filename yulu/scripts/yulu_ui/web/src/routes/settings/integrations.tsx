import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";
export const handle = { breadcrumb: "Settings / Integrations", filters: null };
export function SettingsIntegrations() {
  const { data } = trpc.config.get.useQuery();
  return <Placeholder phase="D" backendNote={`calendars count = ${(data as any)?.calendars?.length ?? 0}`} />;
}
