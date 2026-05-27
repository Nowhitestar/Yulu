import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { DbStatsRow } from "../DbStatsRow.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface StorageSectionProps {
  tracker: SettingsRestartTracker;
}

export function StorageSection({ tracker: _tracker }: StorageSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { data: dbStats } = trpc.system.dbStats.useQuery();
  const { data: logPaths } = trpc.system.logPaths.useQuery();
  const updateMut = trpc.config.update.useMutation();
  const reindexMut = trpc.search.reindex.useMutation();

  if (!cfg) return null;

  return (
    <section id="storage" className="settings-section">
      <h2 className="settings-section-h">Storage</h2>
      <p className="settings-section-sub">Database statistics and log paths</p>
      <InlineEditRow
        label="Output directory"
        type="path"
        mode="folder"
        value={cfg.audio.output_dir}
        onCommit={(v) => updateMut.mutateAsync({ key: "audio.output_dir", value: v })}
      />

      <div className="storage-section">Databases</div>
      {(dbStats ?? []).map((d) => (
        <DbStatsRow
          key={d.name}
          name={d.name}
          path={d.path}
          size={d.size}
          rows={d.rows}
          actionLabel={d.name === "search" ? "Reindex" : undefined}
          onAction={d.name === "search" ? () => { reindexMut.mutateAsync(); } : undefined}
          actionDisabled={d.name === "search" && reindexMut.isPending}
        />
      ))}

      <div className="storage-section">Logs</div>
      {(logPaths ?? []).map((lp) => (
        <InlineEditRow key={lp.name} label={lp.name} type="readonly" value={lp.path} revealInFinder />
      ))}
    </section>
  );
}
