// web/src/routes/knowledge/prompts.index.tsx
import { FileText } from "lucide-react";
import { EmptyState } from "../../components/EmptyState.js";

export function PromptsIndex() {
  return <EmptyState icon={<FileText size={32} strokeWidth={1.5} />} label="Select a prompt to edit." />;
}
