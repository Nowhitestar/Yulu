import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Health / Daemons", filters: null };

export function HealthDaemons() {
  const { data } = trpc.daemons.health.useQuery(undefined, { refetchInterval: 5_000 });
  const running = data?.filter((d) => d.status === "running").length ?? 0;
  return <Placeholder phase="F" backendNote={`daemons.health returned ${data?.length ?? "…"} daemons; ${running} running`} />;
}
