import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useT } from "../i18n/LanguageProvider.js";
import { trpc } from "../trpc.js";

export function ActivationEntry({ children }: { children: ReactNode }) {
  const activation = trpc.activation.status.useQuery();
  const acknowledge = trpc.activation.acknowledgeAutomaticEntry.useMutation();
  const started = useRef(false);
  const [target, setTarget] = useState<"activate" | "normal" | null>(null);
  const t = useT();

  useEffect(() => {
    if (activation.isPending || started.current) return;
    if (!activation.data) {
      started.current = true;
      setTarget("normal");
      return;
    }
    if (activation.data.state === "activated" || !activation.data.journey.shouldAutoEnter) {
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
  if (target === "normal") return children;
  return <div role="status" aria-live="polite">{t("activation.loading")}</div>;
}
