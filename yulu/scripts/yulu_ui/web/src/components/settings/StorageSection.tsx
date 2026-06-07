import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { DbStatsRow } from "../DbStatsRow.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import { useT } from "../../i18n/LanguageProvider.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface StorageSectionProps {
  tracker: SettingsRestartTracker;
}

export function StorageSection({ tracker }: StorageSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { data: dbStats } = trpc.system.dbStats.useQuery();
  const { data: logPaths } = trpc.system.logPaths.useQuery();
  const { commit, isBlocked } = useConfigField(tracker);
  const reindexMut = trpc.search.reindex.useMutation();
  const t = useT();

  if (!cfg) return null;

  return (
    <section id="storage" className="settings-section">
      <h2 className="settings-section-h">{t("settings.storage.heading")}</h2>
      <p className="settings-section-sub">{t("settings.storage.sub")}</p>
      <InlineEditRow
        label={t("settings.audio.outputDir.label")}
        type="path"
        mode="folder"
        value={cfg.audio.output_dir}
        onCommit={commit("audio.output_dir") as (v: string) => void}
        disabled={isBlocked("audio.output_dir")}
      />

      <div className="storage-section">{t("settings.storage.databases")}</div>
      {(dbStats ?? []).map((d) => (
        <DbStatsRow
          key={d.name}
          name={d.name}
          path={d.path}
          size={d.size}
          rows={d.rows}
          actionLabel={d.name === "search" ? t("settings.storage.reindex") : undefined}
          onAction={d.name === "search" ? () => { reindexMut.mutateAsync(); } : undefined}
          actionDisabled={d.name === "search" && reindexMut.isPending}
        />
      ))}

      <div className="storage-section">{t("settings.storage.logs")}</div>
      {(logPaths ?? []).map((lp) => (
        <InlineEditRow key={lp.name} label={lp.name} type="readonly" value={lp.path} revealInFinder />
      ))}
    </section>
  );
}
