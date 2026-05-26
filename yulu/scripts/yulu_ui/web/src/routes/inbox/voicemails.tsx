import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Inbox / Voicemails", filters: null };

export function Voicemails() {
  const { data } = trpc.voicemails.list.useQuery({});
  return <Placeholder phase="C" backendNote={`voicemails.list returned ${data?.length ?? "…"} rows`} />;
}
