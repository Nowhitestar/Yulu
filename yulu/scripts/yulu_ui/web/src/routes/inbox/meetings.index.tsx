// web/src/routes/inbox/meetings.index.tsx
import { Users } from "lucide-react";
import { EmptyState } from "../../components/EmptyState.js";

export function MeetingsIndex() {
  return <EmptyState icon={<Users size={32} strokeWidth={1.5} />} label="Select a meeting to view." />;
}
