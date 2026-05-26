import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";
export const handle = { breadcrumb: "Settings / Transcription", filters: null };
export function SettingsTranscription() {
  const { data } = trpc.config.get.useQuery();
  return <Placeholder phase="D" backendNote={`config.get loaded; final_engine = ${data?.transcription.final_engine ?? "?"}`} />;
}
