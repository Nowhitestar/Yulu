import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Inbox / Meetings", filters: null };

export function Meetings() {
  const { data } = trpc.meetings.list.useQuery({});
  return <Placeholder phase="C" backendNote={`meetings.list returned ${data?.length ?? "…"} rows`} />;
}
