import { trpc } from "../trpc.js";

export type DaemonHealthState = "ok" | "warn" | "crit" | "loading";

interface DaemonStatus {
  name: string;
  status: "running" | "idle" | "stopped" | "crashed" | "unknown" | string;
}

/**
 * Pure aggregation function — exported separately for unit testing without
 * needing to mock the tRPC client.
 *
 * - undefined or empty → loading
 * - any crashed → crit (overrides everything)
 * - any stopped or unknown → warn
 * - all running/idle → ok
 */
export function computeHealthState(
  daemons: ReadonlyArray<DaemonStatus> | undefined,
): DaemonHealthState {
  if (!daemons || daemons.length === 0) return "loading";
  if (daemons.some((d) => d.status === "crashed")) return "crit";
  if (daemons.some((d) => d.status !== "running" && d.status !== "idle")) return "warn";
  return "ok";
}

/**
 * React hook that polls daemons.health every 5s and returns the aggregated
 * single-state value.
 */
export function useDaemonHealthState(): DaemonHealthState {
  const { data } = trpc.daemons.health.useQuery(undefined, { refetchInterval: 5_000 });
  return computeHealthState(data);
}
