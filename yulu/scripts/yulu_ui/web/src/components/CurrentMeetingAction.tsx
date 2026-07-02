import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Video } from "lucide-react";
import { trpc } from "../trpc.js";
import { useIsRecording } from "../hooks/useIsRecording.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./CurrentMeetingAction.css";

type PrimaryAction = "record" | "record_join";

export function CurrentMeetingAction({ fallback = null }: { fallback?: ReactNode }) {
  const t = useT();
  const current = trpc.scheduler.current.useQuery(undefined, { refetchInterval: 30_000 });
  const save = trpc.scheduler.setPrimaryAction.useMutation();
  const start = trpc.scheduler.startMeeting.useMutation();
  const isRecording = useIsRecording();
  const [action, setAction] = useState<PrimaryAction>("record");
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (current.data?.primaryAction) setAction(current.data.primaryAction);
  }, [current.data?.primaryAction]);

  const meeting = current.data?.meeting;
  if (!meeting || isRecording) return <>{fallback}</>;

  const canJoin = Boolean(meeting.link);
  const effectiveAction = canJoin ? action : "record";
  const alternateAction: PrimaryAction = effectiveAction === "record_join" ? "record" : "record_join";
  const label = effectiveAction === "record_join"
    ? t("meeting.current.recordJoin")
    : t("meeting.current.record");
  const alternateLabel = alternateAction === "record_join"
    ? t("meeting.current.recordJoin")
    : t("meeting.current.record");

  function onActionChange(next: PrimaryAction) {
    setAction(next);
    setMenuOpen(false);
    save.mutate({ action: next });
  }

  return (
    <div
      className="current-meeting-action"
      title={meeting.title}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false);
      }}
    >
      <button
        className="current-meeting-button"
        type="button"
        disabled={start.isPending}
        onClick={() => {
          setMenuOpen(false);
          start.mutate({ meetingId: meeting.id, action: effectiveAction });
        }}
        aria-label={t("meeting.current.aria", { title: meeting.title })}
      >
        <Video size={13} strokeWidth={1.9} />
        <span>{start.isPending ? t("meeting.current.pending") : label}</span>
      </button>
      {canJoin && (
        <>
          <button
            className="current-meeting-menu-button"
            type="button"
            disabled={start.isPending}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t("meeting.current.select.aria")}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <ChevronDown size={13} strokeWidth={2} />
          </button>
          {menuOpen && (
            <div className="current-meeting-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => onActionChange(alternateAction)}>
                {alternateLabel}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
