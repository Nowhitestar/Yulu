// web/src/routes/inbox/meetings.tsx
import { useMemo, useState } from "react";
import { NavLink, Outlet, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { useWsChannel } from "../../ws.js";
import { MasterDetail } from "../../components/MasterDetail.js";
import { FilterChips, type ChipDef } from "../../components/FilterChips.js";
import "./meetings.css";

export const handle = { breadcrumb: "Inbox / Meetings", filters: null };

const FILTER_CHIPS: ChipDef[] = [
  { id: "all", label: "All" },
  { id: "summarized", label: "Summarized" },
  { id: "last30d", label: "Last 30d" },
  { id: "has-realtime", label: "Has realtime" },
];

interface Row {
  stem: string;
  meetingTitle: string;
  recordedAt: string;
  firstWords: string | null;
  sizeBytes: number;
  mtimeMs: number;
  hasTranscript: boolean;
  hasSummary: boolean;
  hasRealtime: boolean;
  attendeeCount?: number;
}

export function Meetings() {
  const { data, isPending } = trpc.meetings.list.useQuery({});
  const qc = useQueryClient();
  useWsChannel("sidebar-counts", () => {
    qc.invalidateQueries({ queryKey: [["meetings", "list"]] });
  });
  const params = useParams();
  const activeStem = params.stem;

  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const rows = useMemo(() => {
    let out = ((data as Row[] | undefined) ?? []);
    if (activeFilters.includes("summarized")) out = out.filter((r) => r.hasSummary);
    if (activeFilters.includes("last30d")) {
      const cutoff = Date.now() - 30 * 86_400_000;
      out = out.filter((r) => r.mtimeMs >= cutoff);
    }
    if (activeFilters.includes("has-realtime")) out = out.filter((r) => r.hasRealtime);
    return out;
  }, [data, activeFilters]);

  const list = rows.length === 0
    ? null  // empty state handled in the index route
    : rows.map((r) => (
        <NavLink
          key={r.stem}
          to={r.stem}
          data-testid="meeting-row"
          className={({ isActive }) => "meeting-row" + (isActive ? " active" : "")}
        >
          <div className="meeting-row-title">{r.meetingTitle}</div>
          <div className="meeting-row-meta">
            <span>{formatDuration(r.sizeBytes)}</span>
            <span>·</span>
            <span>{formatRecordedAt(r.recordedAt)}</span>
            {r.attendeeCount !== undefined && (
              <span className="meeting-row-attendees">{r.attendeeCount}</span>
            )}
            {r.hasSummary && <span className="meeting-row-check">✓</span>}
          </div>
        </NavLink>
      ));

  return (
    <MasterDetail
      listPending={isPending}
      listSlot={
        <>
          <div className="meeting-filterbar">
            <FilterChips chips={FILTER_CHIPS} activeIds={activeFilters} onChange={setActiveFilters} />
          </div>
          <div className="meeting-list">{list}</div>
        </>
      }
      detailSlot={<Outlet />}
    />
  );
  // activeStem is read for future filter UX (e.g. scroll into view); not yet needed here
  void activeStem;
}

function formatDuration(bytes: number): string {
  // Rough: 16-bit 16kHz mono WAV ≈ 32_000 bytes/sec
  const sec = Math.max(1, Math.round(bytes / 32_000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function formatRecordedAt(iso: string): string {
  // iso is "YYYY-MM-DDTHH:MM:SS"
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}
