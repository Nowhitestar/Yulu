import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Knowledge / Prompts", filters: null };

export function Prompts() {
  const { data } = trpc.prompts.list.useQuery({});
  return <Placeholder phase="E" backendNote={`prompts.list returned ${data?.length ?? "…"} rows`} />;
}
