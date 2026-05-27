import { trpc } from "../../trpc.js";
import { SettingsPage } from "../../components/SettingsPage.js";
import { InlineEditRow } from "../../components/InlineEditRow.js";
import { DbStatsRow } from "../../components/DbStatsRow.js";
import "./storage.css";

export const handle = { breadcrumb: "Storage", filters: null };

export function SettingsStorage() {
  const { data: cfg } = trpc.config.get.useQuery();
  const { data: dbStats } = trpc.system.dbStats.useQuery();
  const { data: logPaths } = trpc.system.logPaths.useQuery();
  const updateMut = trpc.config.update.useMutation();
  const reindexMut = trpc.search.reindex.useMutation();

  if (!cfg) return <SettingsPage>Loading config…</SettingsPage>;

  return (
    <SettingsPage>
      <InlineEditRow
        label="Output dir"
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
    </SettingsPage>
  );
}
