import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Health / Logs", filters: null };

export function HealthLogs() {
  const { data } = trpc.logs.tail.useQuery({ name: "com.yulu.audiodaemon", limit: 1 });
  return <Placeholder phase="F" backendNote={`logs.tail returned ${data?.lines.length ?? "…"} line(s)`} />;
}
