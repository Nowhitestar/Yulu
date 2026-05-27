import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { DaemonCard, type DaemonHealth } from "../../components/DaemonCard.js";
import "./daemons.css";

export const handle = { breadcrumb: "Daemons", filters: null };

export function HealthDaemons() {
  const { data } = trpc.daemons.health.useQuery(undefined, { refetchInterval: 5_000 });
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [["daemons", "health"]] });

  const restartMut = trpc.daemons.restart.useMutation({ onSuccess: invalidate });
  const stopMut    = trpc.daemons.stop.useMutation({ onSuccess: invalidate });

  const daemons = (data as DaemonHealth[] | undefined) ?? [];

  return (
    <div className="daemons-page">
      <div className="daemons-grid">
        {daemons.map((d) => (
          <DaemonCard
            key={d.name}
            daemon={d}
            onRestart={(n) => restartMut.mutateAsync({ name: n as never })}
            onStop={(n) => stopMut.mutateAsync({ name: n as never })}
            restartPending={restartMut.isPending}
            stopPending={stopMut.isPending}
          />
        ))}
      </div>
    </div>
  );
}
