import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";
export const handle = { breadcrumb: "Settings / Storage", filters: null };
export function SettingsStorage() {
  const { data } = trpc.config.get.useQuery();
  return <Placeholder phase="D" backendNote={`output_dir = ${data?.audio.output_dir ?? "?"}`} />;
}
