// web/src/routes/inbox/voicemails.index.tsx
import { Voicemail } from "lucide-react";
import { EmptyState } from "../../components/EmptyState.js";

export function VoicemailsIndex() {
  return <EmptyState icon={<Voicemail size={32} strokeWidth={1.5} />} label="Select a voicemail to view." />;
}
