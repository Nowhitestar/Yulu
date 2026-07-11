import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { useT } from "../../i18n/LanguageProvider.js";
import "./ControlSections.css";

interface AgentTaskEntry {
  id: string;
  recordingStem: string;
  title: string;
  state: string;
  phase: string;
  agentProvider: string;
  attempt: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const RETRYABLE_STATES = new Set(["failed", "awaiting_agent"]);
const ACTIVE_STATES = new Set([
  "queued",
  "awaiting_agent",
  "awaiting_policy",
  "running",
  "artifacts_committed",
  "sending",
  "delivery_reported",
  "delivery_unverified",
]);

export function AgentQueueSection() {
  const t = useT();
  const qc = useQueryClient();
  const { data, refetch, isPending } = trpc.agentTasks.list.useQuery({ limit: 100 }, { refetchInterval: 5_000 });
  const { data: pipelineHealth } = trpc.agentTasks.transcriptionHealth.useQuery(undefined, { refetchInterval: 5_000 });
  const invalidate = () => qc.invalidateQueries({ queryKey: [["agentTasks", "list"]] });
  const retryMut = trpc.agentTasks.retry.useMutation({ onSuccess: invalidate });
  const confirmMut = trpc.agentTasks.confirmNotionDelivery.useMutation({ onSuccess: invalidate });
  const abandonMut = trpc.agentTasks.abandonNotionDelivery.useMutation({ onSuccess: invalidate });
  const entries = (data ?? []) as AgentTaskEntry[];
  const stats = entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.state] = (counts[entry.state] ?? 0) + 1;
    return counts;
  }, {});

  return (
    <section className="control-section" data-testid="agent-queue-section">
      <div className="control-toolbar">
        <div className="control-toolbar-title">
          <h2>{t("health.queue.heading")}</h2>
          <p>{isPending ? t("health.queue.loading") : t("health.queue.durable")}</p>
          {pipelineHealth?.paused && <p>{pipelineHealth.policyReason}</p>}
        </div>
        <div className="control-actions">
          <button type="button" className="control-btn" onClick={() => refetch()}>{t("common.refresh")}</button>
        </div>
      </div>

      <div className="control-stats">
        <span className="control-pill">{t("health.queue.total", { n: entries.length })}</span>
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
                  <div className="control-card-sub">{entry.recordingStem} · {entry.createdAt}</div>
                </div>
                <span className="control-pill" data-status={entry.state}>
                  {entry.state}
                </span>
              </div>
              <div className="control-meta">
                <div>{t("health.queue.phase")}: {entry.phase}</div>
                <div>{t("health.queue.provider")}: {entry.agentProvider}</div>
                <div>{t("health.queue.attempt")}: {entry.attempt}</div>
                <div>{t("health.queue.updated")}: {entry.updatedAt}</div>
                {entry.state === "delivery_unverified" && <div>{t("health.queue.deliveryUnverified")}</div>}
                {entry.error && <div>{t("health.queue.error")}: {entry.error}</div>}
              </div>
              {RETRYABLE_STATES.has(entry.state) && !entries.some((other) => (
                other.id !== entry.id &&
                other.recordingStem === entry.recordingStem &&
                ACTIVE_STATES.has(other.state)
              )) && <div className="control-actions">
                <button
                  type="button"
                  className="control-btn"
                  disabled={retryMut.isPending}
                  onClick={() => retryMut.mutate({ id: entry.id })}
                >
                  {t("health.queue.retry")}
                </button>
              </div>}
              {entry.state === "delivery_unverified" && <div className="control-actions">
                <button
                  type="button"
                  className="control-btn"
                  disabled={confirmMut.isPending || abandonMut.isPending}
                  onClick={() => {
                    const url = window.prompt(t("health.queue.confirmPrompt"), "");
                    if (url === null) return;
                    confirmMut.mutate({ id: entry.id, url: url.trim() || undefined });
                  }}
                >
                  {t("health.queue.confirmDelivered")}
                </button>
                <button
                  type="button"
                  className="control-btn"
                  disabled={confirmMut.isPending || abandonMut.isPending}
                  onClick={() => {
                    if (window.confirm(t("health.queue.abandonConfirm"))) {
                      abandonMut.mutate({ id: entry.id });
                    }
                  }}
                >
                  {t("health.queue.abandonDelivery")}
                </button>
              </div>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
