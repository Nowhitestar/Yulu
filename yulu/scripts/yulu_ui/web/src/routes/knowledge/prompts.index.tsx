// web/src/routes/knowledge/prompts.index.tsx
import { FileText } from "lucide-react";
import { EmptyState } from "../../components/EmptyState.js";
import { useT } from "../../i18n/LanguageProvider.js";

export function PromptsIndex() {
  const t = useT();
  return <EmptyState icon={<FileText size={28} strokeWidth={1.4} />} label={t("prompts.selectHint")} />;
}
