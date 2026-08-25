import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, Navigate } from "react-router";
import { useT } from "../i18n/LanguageProvider.js";
import { trpc } from "../trpc.js";
import { useWsChannel } from "../ws.js";
import "./activate.css";

export function ActivationEntry({ children }: { children: ReactNode }) {
  const activation = trpc.activation.status.useQuery();
  const acknowledge = trpc.activation.acknowledgeAutomaticEntry.useMutation();
  const started = useRef(false);
  const [target, setTarget] = useState<"activate" | "normal" | null>(null);
  const [completedStem, setCompletedStem] = useState<string | null>(null);
  const t = useT();

  useWsChannel("core-activation", (event) => {
    setCompletedStem(event.recordingStem);
    void activation.refetch();
  });

  useEffect(() => {
    if (activation.isPending || started.current) return;
    if (!activation.data) {
      started.current = true;
      setTarget("normal");
      return;
    }
    if (activation.data.state === "activated") {
      if (activation.data.evidenceCreated) {
        setCompletedStem(activation.data.evidence.recordingStem);
      }
      setTarget("normal");
      return;
    }
    if (
      activation.data.state === "recording" ||
      activation.data.state === "processing" ||
      !activation.data.journey.shouldAutoEnter
    ) {
      setTarget("normal");
      return;
    }
    started.current = true;
    void acknowledge.mutateAsync().then(
      (result) => setTarget(result.acknowledged ? "activate" : "normal"),
      () => setTarget("normal"),
    );
  }, [acknowledge, activation.data, activation.isPending]);

  if (target === "activate") return <Navigate to="/activate" replace />;
  if (target === "normal") return (
    <>
      {children}
      {completedStem ? (
        <div className="activation-notice" role="status" aria-live="polite">
          <span>{t("activation.notice.complete")}</span>
          <Link to={`/inbox/${encodeURIComponent(completedStem)}`}>
            {t("activation.notice.open")}
          </Link>
        </div>
      ) : null}
    </>
  );
  return <div role="status" aria-live="polite">{t("activation.loading")}</div>;
}
