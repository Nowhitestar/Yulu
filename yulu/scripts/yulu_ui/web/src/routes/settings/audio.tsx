import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";
export const handle = { breadcrumb: "Settings / Audio", filters: null };
export function SettingsAudio() {
  const { data } = trpc.config.get.useQuery();
  return <Placeholder phase="D" backendNote={`config.get loaded; audio backend = ${data?.audio.backend ?? "?"}`} />;
}
