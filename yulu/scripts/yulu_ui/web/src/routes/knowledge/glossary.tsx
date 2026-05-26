import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Knowledge / Glossary", filters: null };

export function Glossary() {
  const { data } = trpc.glossary.list.useQuery();
  return <Placeholder phase="E" backendNote={`glossary.list returned ${data?.length ?? "…"} rows`} />;
}
