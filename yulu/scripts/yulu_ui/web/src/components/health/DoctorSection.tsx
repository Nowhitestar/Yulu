import { trpc } from "../../trpc.js";
import { useT } from "../../i18n/LanguageProvider.js";
import "./ControlSections.css";

interface DoctorCheck {
  name?: string;
  ok?: boolean;
  path?: string;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function DoctorSection() {
  const t = useT();
  const { data, refetch, isPending } = trpc.doctor.run.useQuery(undefined, { refetchInterval: 30_000 });
  const report = asRecord(data?.report);
  const checks = Array.isArray(report.checks) ? report.checks as DoctorCheck[] : [];
  const searchReport = asRecord(data?.search?.report);

  return (
    <section className="control-section" data-testid="doctor-section">
      <div className="control-toolbar">
        <div className="control-toolbar-title">
          <h2>{t("health.doctor.heading")}</h2>
          <p>{t("health.doctor.sub")}</p>
        </div>
        <div className="control-actions">
          <button type="button" className="control-btn" onClick={() => refetch()}>{t("common.refresh")}</button>
        </div>
      </div>

      {isPending ? (
        <div className="control-empty">{t("common.loading")}</div>
      ) : (
        <div className="control-grid">
          <article className="control-card">
            <div className="control-card-head">
              <div>
                <div className="control-card-title">{t("health.doctor.runtime")}</div>
                <div className="control-card-sub">doctor.py --json</div>
              </div>
              <span className="control-pill" data-status={data?.ok ? "ok" : "failed"}>
                {data?.ok ? t("health.doctor.ok") : t("health.doctor.failed")}
              </span>
            </div>
            {data?.stderr && <pre className="control-pre">{data.stderr}</pre>}
          </article>

          {checks.map((check, idx) => (
            <article key={`${check.name ?? idx}-${idx}`} className="control-card">
              <div className="control-card-head">
                <div>
                  <div className="control-card-title">{check.name ?? t("health.doctor.check")}</div>
                  <div className="control-card-sub">{check.path ?? check.error ?? ""}</div>
                </div>
                <span className="control-pill" data-status={check.ok ? "ok" : "failed"}>
                  {check.ok ? t("health.doctor.ok") : t("health.doctor.failed")}
                </span>
              </div>
            </article>
          ))}

          <article className="control-card">
            <div className="control-card-head">
              <div>
                <div className="control-card-title">{t("health.doctor.search")}</div>
                <div className="control-card-sub">search.cli --doctor</div>
              </div>
              <span className="control-pill" data-status={data?.search?.ok ? "ok" : "failed"}>
                {data?.search?.ok ? t("health.doctor.ok") : t("health.doctor.failed")}
              </span>
            </div>
            <pre className="control-pre">{JSON.stringify(searchReport || data?.search?.stderr || {}, null, 2)}</pre>
          </article>
        </div>
      )}
    </section>
  );
}
