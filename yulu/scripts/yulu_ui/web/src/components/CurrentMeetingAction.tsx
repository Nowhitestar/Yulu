import { useEffect, useState } from "react";
import { Video } from "lucide-react";
import { trpc } from "../trpc.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./CurrentMeetingAction.css";

type PrimaryAction = "record" | "record_join";

export function CurrentMeetingAction() {
  const t = useT();
  const current = trpc.scheduler.current.useQuery(undefined, { refetchInterval: 30_000 });
  const save = trpc.scheduler.setPrimaryAction.useMutation();
  const start = trpc.scheduler.startMeeting.useMutation();
  const [action, setAction] = useState<PrimaryAction>("record");

  useEffect(() => {
    if (current.data?.primaryAction) setAction(current.data.primaryAction);
  }, [current.data?.primaryAction]);

  const meeting = current.data?.meeting;
  if (!meeting) return null;

  const canJoin = Boolean(meeting.link);
  const effectiveAction = canJoin ? action : "record";
  const label = effectiveAction === "record_join"
    ? t("meeting.current.recordJoin")
    : t("meeting.current.record");

  function onActionChange(next: PrimaryAction) {
    setAction(next);
    save.mutate({ action: next });
  }

  return (
    <div className="current-meeting-action" title={meeting.title}>
      <select
        className="current-meeting-select"
        value={effectiveAction}
        onChange={(event) => onActionChange(event.target.value as PrimaryAction)}
        aria-label={t("meeting.current.select.aria")}
      >
        <option value="record">{t("meeting.current.record")}</option>
        {canJoin && <option value="record_join">{t("meeting.current.recordJoin")}</option>}
      </select>
      <button
        className="current-meeting-button"
        type="button"
        disabled={start.isPending}
        onClick={() => start.mutate({ meetingId: meeting.id, action: effectiveAction })}
        aria-label={t("meeting.current.aria", { title: meeting.title })}
      >
        <Video size={13} strokeWidth={1.9} />
        <span>{start.isPending ? t("meeting.current.pending") : label}</span>
      </button>
    </div>
  );
}
