import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { useT } from "../../i18n/LanguageProvider.js";
import "./ControlSections.css";

interface QueueEntry {
  id: string;
  type: string;
  ts: string;
  title: string;
  status: string;
  promptSlug: string;
  promptName: string;
  transcriptPath: string;
  summaryPath: string;
  error: string;
  processingBy: string;
  processingAt: string;
  processedAt: string;
  stale: boolean;
  promptContentSnapshot: string;
}

export function AgentQueueSection() {
  const t = useT();
  const qc = useQueryClient();
  const { data, refetch, isPending } = trpc.queue.list.useQuery(undefined, { refetchInterval: 5_000 });
  const invalidate = () => qc.invalidateQueries({ queryKey: [["queue", "list"]] });
  const retryMut = trpc.queue.retry.useMutation({ onSuccess: invalidate });
  const cancelMut = trpc.queue.cancel.useMutation({ onSuccess: invalidate });
  const clearStaleMut = trpc.queue.clearStale.useMutation({ onSuccess: invalidate });
  const entries = (data?.entries ?? []) as QueueEntry[];
  const stats = (data?.stats ?? {}) as Record<string, number>;

  return (
    <section className="control-section" data-testid="agent-queue-section">
      <div className="control-toolbar">
        <div className="control-toolbar-title">
          <h2>{t("health.queue.heading")}</h2>
          <p>{data?.path ?? t("health.queue.loading")}</p>
        </div>
        <div className="control-actions">
          <button type="button" className="control-btn" onClick={() => refetch()}>{t("common.refresh")}</button>
          <button
            type="button"
            className="control-btn"
            disabled={clearStaleMut.isPending}
            onClick={() => clearStaleMut.mutate()}
          >
            {t("health.queue.clearStale")}
          </button>
        </div>
      </div>

      <div className="control-stats">
        <span className="control-pill">{t("health.queue.total", { n: data?.total ?? 0 })}</span>
        {Object.entries(stats).map(([status, count]) => (
          <span key={status} className="control-pill" data-status={status}>{status}: {count}</span>
        ))}
      </div>

      {isPending ? (
        <div className="control-empty">{t("common.loading")}</div>
      ) : entries.length === 0 ? (
        <div className="control-empty">{t("health.queue.empty")}</div>
      ) : (
        <div className="control-grid">
          {entries.map((entry) => (
            <article key={entry.id} className="control-card">
              <div className="control-card-head">
                <div>
                  <div className="control-card-title">{entry.title || entry.id}</div>
                  <div className="control-card-sub">{entry.promptName || entry.promptSlug || entry.type} · {entry.ts}</div>
                </div>
                <span className="control-pill" data-status={entry.stale ? "warn" : entry.status}>
                  {entry.stale ? t("health.queue.stale") : entry.status}
                </span>
              </div>
              <div className="control-meta">
                {entry.summaryPath && <div>{t("health.queue.summary")}: <code>{entry.summaryPath}</code></div>}
                {entry.processingBy && <div>{t("health.queue.processing")}: {entry.processingBy} {entry.processingAt}</div>}
                {entry.processedAt && <div>{t("health.queue.processed")}: {entry.processedAt}</div>}
                {entry.error && <div>{t("health.queue.error")}: {entry.error}</div>}
              </div>
              {entry.promptContentSnapshot && (
                <details>
                  <summary>{t("health.queue.prompt")}</summary>
                  <pre className="control-pre">{entry.promptContentSnapshot}</pre>
                </details>
              )}
              <div className="control-actions">
                <button
                  type="button"
                  className="control-btn"
                  disabled={retryMut.isPending || entry.status === "processing"}
                  onClick={() => retryMut.mutate({ id: entry.id })}
                >
                  {t("health.queue.retry")}
                </button>
                <button
                  type="button"
                  className="control-btn"
                  disabled={cancelMut.isPending || entry.status === "done"}
                  onClick={() => cancelMut.mutate({ id: entry.id })}
                >
                  {t("health.queue.cancel")}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
